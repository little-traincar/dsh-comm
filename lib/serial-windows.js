// Windows 串口桥：常驻 PowerShell 持有 [System.IO.Ports.SerialPort]，
// Node 侧用 JSON 行协议收发。零原生模块依赖，避免 serialport 的 ABI/构建问题。

import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SCRIPT_URL = new URL('./serial-host.ps1', import.meta.url)
let cachedScriptPath = null

function bridgeScriptPath() {
  if (cachedScriptPath) return cachedScriptPath
  const dir = join(process.env.LOCALAPPDATA || tmpdir(), 'dsh-comm')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'serial-host.ps1')
  copyFileSync(SCRIPT_URL, target)
  cachedScriptPath = target
  return target
}

export function serialSupported() {
  return process.platform === 'win32'
}

function runPowerShell(command, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { windowsHide: true })
    let out = ''
    let err = ''
    let settled = false
    // 没有超时的话，PowerShell 一旦卡住（COM/串口栈异常、机器繁忙），
    // 这个 Promise 永不 settle，调用方（comm_list / /comm/api/ports）会永久挂起。
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* ignore */ }
      reject(new Error(`PowerShell 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    const finish = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8') })
    child.on('error', (error) => finish(() => reject(error)))
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve(out)
        else reject(new Error(err.trim() || `powershell exited with ${code}`))
      })
    })
  })
}

// 一次 PowerShell 调用同时拿端口名 + PnP 信息。PnP 查询失败时至少保留端口名，
// 这样即使 WMI 服务异常，串口功能也不会整体不可用。
const LIST_PORTS_COMMAND = `
$ErrorActionPreference = 'SilentlyContinue'
$names = @([System.IO.Ports.SerialPort]::GetPortNames())
$devices = @()
try { $devices = @(Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue) } catch { $devices = @() }
$rows = @()
foreach ($n in $names) {
  $escaped = [regex]::Escape($n) + '\\b'
  $dev = $null
  foreach ($d in $devices) { if ($d.Name -match $escaped) { $dev = $d; break } }
  $name = $null; $vid = $null; $pid = $null; $serial = $null
  if ($null -ne $dev) {
    $name = [string]$dev.Name
    $pnp = [string]$dev.PNPDeviceID
    if ($pnp -match 'VID_([0-9A-Fa-f]{4})') { $vid = $matches[1].ToUpper() }
    if ($pnp -match 'PID_([0-9A-Fa-f]{4})') { $pid = $matches[1].ToUpper() }
    if ($pnp.Contains('\\')) { $serial = $pnp.Split('\\')[-1] }
  }
  $rows += [pscustomobject]@{ path = $n; name = $name; vid = $vid; pid = $pid; serial = $serial }
}
ConvertTo-Json -InputObject @($rows) -Compress -Depth 4
`.trim()

/**
 * 枚举串口（Windows）。返回 { available, error, ports: [{path,name,vid,pid,serial}] }。
 * PnP 信息用于 USB 转串口拔插后端口号变化时按 VID/PID/序列号找回设备。
 */
export async function listSerialPorts() {
  if (!serialSupported()) {
    return { available: false, error: 'v1 的串口桥只支持 Windows（PowerShell 5.1+）', ports: [] }
  }
  try {
    const out = await runPowerShell(LIST_PORTS_COMMAND, 6000)
    const trimmed = out.trim()
    let parsed = []
    if (trimmed) {
      const value = JSON.parse(trimmed)
      parsed = Array.isArray(value) ? value : [value]
    }
    const ports = parsed
      .filter((row) => row && row.path)
      .map((row) => ({
        path: String(row.path),
        name: row.name ? String(row.name) : undefined,
        vid: row.vid ? String(row.vid) : undefined,
        pid: row.pid ? String(row.pid) : undefined,
        serial: row.serial ? String(row.serial) : undefined,
      }))
    return { available: true, error: null, ports }
  } catch (error) {
    return { available: false, error: String(error.message || error), ports: [] }
  }
}

function parityName(value) {
  const raw = String(value || 'none').toLowerCase()
  if (raw === 'odd') return 'Odd'
  if (raw === 'even') return 'Even'
  if (raw === 'mark') return 'Mark'
  if (raw === 'space') return 'Space'
  return 'None'
}

function stopBitsName(value) {
  const n = Number(value)
  if (n === 2) return 'Two'
  if (n === 1.5) return 'OnePointFive'
  return 'One'
}

function handshakeName(value) {
  const raw = String(value || 'none').toLowerCase()
  if (raw === 'rtscts' || raw === 'rts-cts' || raw === 'requesttosend') return 'RequestToSend'
  if (raw === 'xonxoff' || raw === 'xon-xoff') return 'XOnXOff'
  if (raw === 'both') return 'RequestToSendXOnXOff'
  return 'None'
}

/**
 * 打开一个 Windows 串口桥。
 * @param {{path:string, baudRate:number, dataBits?:number, parity?:string, stopBits?:number,
 *          flowControl?:'none'|'rtscts'|'xonxoff', dtr?:boolean, rts?:boolean}} options
 * @returns {{
 *   open:()=>Promise<void>, write:(buf:Buffer)=>Promise<void>, close:()=>Promise<void>,
 *   reconfigure:(options:object)=>Promise<void>, signals:()=>Promise<{dtr:boolean,rts:boolean}>,
 *   setSignals:(signals:{dtr?:boolean,rts?:boolean})=>Promise<{dtr:boolean,rts:boolean}>,
 *   pulse:(line:'dtr'|'rts', ms?:number, level?:boolean)=>Promise<object>,
 *   ping:()=>Promise<boolean>, on:(event:string, fn:Function)=>void, closed:boolean
 * }}
 */
export function openSerialBridge(options) {
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bridgeScriptPath(),
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })

  const listeners = { data: null, error: null, close: null }
  const pending = new Map()
  let nextId = 1
  let closed = false
  let closeNotified = false

  const notifyClose = (reason) => {
    if (closeNotified) return
    closeNotified = true
    closed = true
    try { listeners.close?.(reason) } catch (error) { listeners.error?.(error) }
  }

  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.ev === 'data' && msg.b64) {
      try { listeners.data?.(Buffer.from(msg.b64, 'base64')) } catch (error) { listeners.error?.(error) }
      return
    }
    if (msg.ev === 'closed') {
      for (const waiter of pending.values()) waiter.reject(new Error('串口已断开'))
      pending.clear()
      notifyClose(String(msg.msg || '串口已断开'))
      return
    }
    if (msg.ev === 'error') {
      listeners.error?.(new Error(String(msg.msg || 'serial error')))
      return
    }
    if (msg.id && pending.has(msg.id)) {
      const waiter = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.ok) waiter.resolve(msg)
      else waiter.reject(new Error(String(msg.error || 'serial operation failed')))
    }
  })
  child.stderr.on('data', (chunk) => {
    const text = String(chunk || '').trim()
    if (text) listeners.error?.(new Error(text))
  })
  child.on('error', (error) => {
    notifyClose(String(error?.message || error))
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  })
  child.on('exit', (code) => {
    notifyClose(`串口桥进程退出（${code}）`)
    for (const waiter of pending.values()) waiter.reject(new Error(`serial bridge exited with ${code}`))
    pending.clear()
  })

  function request(op, payload, timeoutMs) {
    if (closed) return Promise.reject(new Error('串口桥已关闭'))
    const id = nextId
    nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('串口桥操作超时'))
      }, timeoutMs || 6000)
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      try {
        child.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n')
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      }
    })
  }

  const openPayload = (opts) => ({
    port: opts.path,
    baud: opts.baudRate,
    dataBits: opts.dataBits || 8,
    parity: parityName(opts.parity),
    stopBits: stopBitsName(opts.stopBits),
    handshake: handshakeName(opts.flowControl),
    dtr: opts.dtr !== false,
    rts: opts.rts !== false,
  })

  return {
    async open() {
      await request('open', openPayload(options), 12000)
    },
    write(buf) {
      return request('write', { b64: Buffer.from(buf).toString('base64') }, 8000)
    },
    async close() {
      try { await request('close', {}, 2000) } catch { /* ignore */ }
      try { child.kill() } catch { /* ignore */ }
    },
    async reconfigure(opts) {
      await request('configure', openPayload({ ...options, ...opts }), 12000)
    },
    async signals() {
      const reply = await request('signals', {}, 3000)
      return { dtr: Boolean(reply.dtr), rts: Boolean(reply.rts) }
    },
    async setSignals(signals) {
      const reply = await request('set', { dtr: signals?.dtr, rts: signals?.rts }, 3000)
      return { dtr: Boolean(reply.dtr), rts: Boolean(reply.rts) }
    },
    async pulse(line, ms, level) {
      return request('pulse', { line, ms, level }, 5000)
    },
    async ping() {
      const reply = await request('ping', {}, 2000)
      return Boolean(reply.open)
    },
    on(event, fn) { listeners[event] = fn },
    get closed() { return closed },
  }
}
