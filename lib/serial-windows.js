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

export async function listSerialPorts() {
  if (!serialSupported()) {
    return { available: false, error: 'v1 的串口桥只支持 Windows（PowerShell 5.1+）', ports: [] }
  }
  try {
    const out = await runPowerShell('[System.IO.Ports.SerialPort]::GetPortNames() | ConvertTo-Json -Compress')
    const trimmed = out.trim()
    let names = []
    if (trimmed) {
      const parsed = JSON.parse(trimmed)
      names = Array.isArray(parsed) ? parsed : [parsed]
    }
    return {
      available: true,
      error: null,
      ports: names.filter(Boolean).map((path) => ({ path: String(path) })),
    }
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

function stopBitsNumber(value) {
  const n = Number(value)
  if (n === 2) return 2
  if (n === 1.5) return 1.5
  return 1
}

/**
 * 打开一个 Windows 串口桥。
 * @param {{path:string, baudRate:number, dataBits?:number, parity?:string, stopBits?:number}} options
 * @returns {{open:()=>Promise<void>, write:(buf:Buffer)=>Promise<void>, close:()=>Promise<void>, on:(event:string, fn:Function)=>void}}
 */
export function openSerialBridge(options) {
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bridgeScriptPath(),
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })

  const listeners = { data: null, error: null, close: null }
  const pending = new Map()
  let nextId = 1
  let closed = false

  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.ev === 'data' && msg.b64) {
      try { listeners.data?.(Buffer.from(msg.b64, 'base64')) } catch (error) { listeners.error?.(error) }
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
    closed = true
    listeners.error?.(error)
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  })
  child.on('exit', (code) => {
    closed = true
    listeners.close?.(code)
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
      child.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n')
    })
  }

  return {
    async open() {
      await request('open', {
        port: options.path,
        baud: options.baudRate,
        dataBits: options.dataBits || 8,
        parity: parityName(options.parity),
        stopBits: stopBitsNumber(options.stopBits),
      }, 8000)
    },
    write(buf) {
      return request('write', { b64: Buffer.from(buf).toString('base64') }, 8000)
    },
    async close() {
      try { await request('close', {}, 2000) } catch { /* ignore */ }
      try { child.kill() } catch { /* ignore */ }
    },
    on(event, fn) { listeners[event] = fn },
    get closed() { return closed },
  }
}
