// dsh-comm — Host 半边
//
// 职责：
//   1. 链路管理：串口 / TCP 服务端 / TCP 客户端 / UDP
//   2. 模型工具：comm_list / comm_open / comm_close / comm_read / comm_write / comm_peers / comm_tail
//   3. 内嵌 UI：在 webServer 上挂 /comm 前缀（页面 + 轮询 API），并向 DSH index 注入
//      window.__DSH_COMM__ = { base, token }，供 Client 半边的 iframe 使用。
//
// 依赖方向：浏览器只拿 HTTP 轮询，不直接碰 socket；链路状态全部在 Host。

import { defineTool as defineToolRaw } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import net from 'node:net'
import dgram from 'node:dgram'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import iconv from 'iconv-lite'
import { listSerialPorts, openSerialBridge, serialSupported } from './serial-windows.js'

/* ───────────────────────── 工具输出收敛 ───────────────────────── */

// DSH 会校验工具返回值能否无损 JSON 往返：只要出现 undefined 属性、NaN/Infinity、
// BigInt、Date、Map/Set 或函数，整条结果就会变成
// "tool ... returned invalid output: value is not lossless JSON"。
// comm_list 就是因为串口列表里的 undefined 字段整条挂掉的，所以统一在注册层收敛一次，
// 而不是指望每个工具各自记得清洗。
export function losslessJson(value, seen = new WeakSet(), depth = 0) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'bigint') return value.toString()
  if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined
  if (depth > 12) return '[depth]'
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (value instanceof Error) return { name: value.name, message: String(value.message || '') }
  if (Array.isArray(value)) {
    return value.map((item) => {
      const next = losslessJson(item, seen, depth + 1)
      return next === undefined ? null : next
    })
  }
  if (value instanceof Map) return losslessJson(Object.fromEntries(value), seen, depth + 1)
  if (value instanceof Set) return losslessJson(Array.from(value), seen, depth + 1)
  if (type === 'object') {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const next = losslessJson(item, seen, depth + 1)
      if (next !== undefined) out[key] = next
    }
    seen.delete(value)
    return out
  }
  return undefined
}

// 所有工具都经这里注册：execute 的返回值先过 losslessJson 再交给 DSH 校验。
const defineTool = (spec) => defineToolRaw({
  ...spec,
  execute: async (args, exec) => losslessJson(await spec.execute(args, exec)),
})

export const name = 'dsh-comm'
export const inject = ['tools']

export const Config = Schema.object({
  maxLogEntries: Schema.number().default(2000),
  maxReadEntries: Schema.number().default(200),
  // 每条链路日志的字节上限（保留原文，不含 base64 膨胀）。超过后丢最旧的条目，
  // 丢弃量计入 link.dropped / droppedBytes，可从 comm_list 读到。
  maxLogBytes: Schema.number().default(4 * 1024 * 1024),
  uiToken: Schema.string().default(''),
  // 无规则时的智能回复（仅方案 A）：把消息转给指定会话，由模型用 comm_write 回复；
  // 留空表示用/自动创建 dsh-comm 专用会话（见 aiReplyDedicatedSession）。
  aiReplySession: Schema.string().default(''),
  // true（默认）：自动创建并复用专用会话「dsh-comm 自动回复」，不往当前主对话里注入；
  // false：退回旧行为，取最近活跃的根会话。
  aiReplyDedicatedSession: Schema.boolean().default(true),
  // 自动回复无规则时，把窗口内收到的多条消息合并成一次会话注入，默认 300ms。
  aiReplyDebounceMs: Schema.number().default(300),
  // 防回环：自己发出的数据在这个窗口内原样回来，视为回显，不触发自动回复。
  aiReplyEchoSuppressMs: Schema.number().default(300),
  // 两次自动转发之间的最小间隔（毫秒）。
  aiReplyCooldownMs: Schema.number().default(500),
  // 60 秒内最多自动转发多少次；超过则暂停 30 秒并记日志（防止设备回显造成自激）。
  aiReplyMaxPerMinute: Schema.number().default(30),
  // 会话 list/create/rename/prompt 的超时（毫秒），避免 DSH 会话服务异常时自动回复永久挂住。
  aiReplyTimeoutMs: Schema.number().default(15000),
  // 转发后多久仍没有任何发送，判为"那个会话没在跑"；连续两次即解除绑定，
  // 下条消息自动重建专用会话（会话被删 / 换了进程 / agent 已死都能自愈）。
  aiReplyLivenessMs: Schema.number().default(30000),
})

const UI_HTML = readFileSync(new URL('./ui.html', import.meta.url), 'utf8')
const MAX_BODY = 1 << 20

/* ───────────────────────── 持久化（Host 侧） ───────────────────────── */

// 规则、启用开关、串口参数、定时器都按链路 id / 端口路径保存，
// 写在 DSH home 下，重启后可恢复。
const SETTINGS_VERSION = 2

function settingsPath() {
  const home = String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  return join(home, 'comm-settings.json')
}

function readSettings() {
  const empty = {
    version: SETTINGS_VERSION,
    auto: {},
    rules: {},
    autoOpts: {},
    serialDefaults: {},
    timers: {},
    // 自动创建的专用会话 id；配置了 aiReplySession 时不使用。
    aiReplySessionId: '',
  }
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
      return {
        version: SETTINGS_VERSION,
        // v1 文件只有 auto / rules，其余字段给空对象即完成迁移。
        auto: object(parsed.auto),
        rules: object(parsed.rules),
        autoOpts: object(parsed.autoOpts),
        serialDefaults: object(parsed.serialDefaults),
        timers: object(parsed.timers),
        aiReplySessionId: typeof parsed.aiReplySessionId === 'string' ? parsed.aiReplySessionId : '',
      }
    }
  } catch { /* 首次运行或文件损坏：用空设置 */ }
  return empty
}

function writeSettings(settings) {
  try {
    const file = settingsPath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
  } catch { /* 磁盘只读等情况忽略：内存里仍然生效 */ }
}


/* ───────────────────────── 编码 ───────────────────────── */

const ENCODING_ALIASES = {
  utf8: 'utf-8',
  'utf-8': 'utf-8',
  gbk: 'gbk',
  gb2312: 'gbk',
  gb18030: 'gb18030',
  big5: 'big5',
  'shift-jis': 'shift_jis',
  shift_jis: 'shift_jis',
  'euc-kr': 'euc-kr',
  euckr: 'euc-kr',
  'windows-1252': 'windows-1252',
  latin1: 'windows-1252',
}

function normalizeEncoding(value) {
  const key = String(value || 'utf-8').trim().toLowerCase()
  const mapped = ENCODING_ALIASES[key] || key
  return mapped === 'utf-8' ? 'utf-8' : (iconv.encodingExists(mapped) ? mapped : 'utf-8')
}

function decodeBytes(buf, encoding) {
  const enc = normalizeEncoding(encoding)
  if (enc === 'utf-8') return buf.toString('utf8')
  try { return iconv.decode(buf, enc) } catch { return buf.toString('utf8') }
}

function encodeText(text, encoding) {
  const enc = normalizeEncoding(encoding)
  if (enc === 'utf-8') return Buffer.from(text, 'utf8')
  try { return iconv.encode(text, enc) } catch { return Buffer.from(text, 'utf8') }
}

function parseHex(input) {
  const s = String(input || '').trim()
  if (!s) return { error: '空输入' }
  const tokens = s.split(/[\s,;:_-]+/).filter(Boolean)
  const out = []
  for (const token of tokens) {
    const t = token.replace(/^0x/i, '')
    if (!/^[0-9a-fA-F]+$/.test(t)) return { error: `非法十六进制：${token}` }
    if (t.length % 2 !== 0) return { error: `奇数个十六进制字符：${token}` }
    for (let i = 0; i < t.length; i += 2) out.push(parseInt(t.slice(i, i + 2), 16))
  }
  return { bytes: Buffer.from(out) }
}

/* ───────────────────────── 串口参数 / 定时器参数 ───────────────────────── */

const SERIAL_PARITIES = ['none', 'odd', 'even', 'mark', 'space']
const SERIAL_FLOWS = ['none', 'rtscts', 'xonxoff']

function toInt(value, fallback) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? n : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

// 串口参数归一化：显式传入 > 该端口的持久化默认值 > 内置默认值。
function normalizeSerialParams(input, fallback) {
  const source = input || {}
  const base = fallback || {}
  const pick = (key, def) => {
    const value = source[key] !== undefined && source[key] !== '' ? source[key]
      : (base[key] !== undefined && base[key] !== '' ? base[key] : def)
    return value
  }
  const baudRate = Math.max(1, toInt(pick('baudRate', 115200), 115200) || 115200)
  const dataBitsRaw = toInt(pick('dataBits', 8), 8)
  const dataBits = [5, 6, 7, 8].includes(dataBitsRaw) ? dataBitsRaw : 8
  const parityRaw = String(pick('parity', 'none')).toLowerCase()
  const parity = SERIAL_PARITIES.includes(parityRaw) ? parityRaw : 'none'
  const stopRaw = Number(pick('stopBits', 1))
  const stopBits = [1, 1.5, 2].includes(stopRaw) ? stopRaw : 1
  const flowRaw = String(pick('flowControl', 'none')).toLowerCase()
  const flowControl = SERIAL_FLOWS.includes(flowRaw) ? flowRaw : 'none'
  return {
    baudRate,
    dataBits,
    parity,
    stopBits,
    flowControl,
    dtr: pick('dtr', true) !== false,
    rts: pick('rts', true) !== false,
    autoReconnect: pick('autoReconnect', true) !== false,
  }
}

function serialFrameText(params) {
  const parityLetter = { none: 'N', odd: 'O', even: 'E', mark: 'M', space: 'S' }[params.parity] || 'N'
  const flow = params.flowControl === 'rtscts' ? ' RTS/CTS' : params.flowControl === 'xonxoff' ? ' XON/XOFF' : ''
  return `${params.dataBits}${parityLetter}${params.stopBits}${flow}`
}

function serialLabel(path, params) {
  return `串口 ${path} @ ${params.baudRate} ${serialFrameText(params)}`
}

// 定时器载荷：{text, encoding} 或 {hex}。返回可复用字节 + 可持久化描述。
function normalizeTimerPayload(raw) {
  const payload = raw || {}
  if (payload.hex !== undefined && String(payload.hex).trim() !== '') {
    const parsed = parseHex(payload.hex)
    if (parsed.error) throw new Error(`HEX 非法：${parsed.error}`)
    return { bytes: parsed.bytes, spec: { hex: String(payload.hex) } }
  }
  const text = String(payload.text ?? '')
  const encoding = normalizeEncoding(payload.encoding)
  return { bytes: encodeText(text, encoding), spec: { text, encoding } }
}

function normalizeRepeat(value) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 0) return 0
  return clamp(n, 0, 1000000)
}

function normalizeTimerSpec(raw) {
  const spec = raw || {}
  if (spec.kind === 'sequence') {
    const list = Array.isArray(spec.steps) ? spec.steps : []
    const steps = list.map((step) => {
      const payload = normalizeTimerPayload(step?.payload || step)
      return {
        delayMs: clamp(toInt(step?.delayMs, 0), 0, 600000),
        bytes: payload.bytes,
        spec: payload.spec,
      }
    })
    if (!steps.length) throw new Error('序列至少需要一个步骤')
    return {
      kind: 'sequence',
      loop: spec.loop !== false,
      repeat: normalizeRepeat(spec.repeat),
      steps,
    }
  }
  const payload = normalizeTimerPayload(spec.payload || spec)
  const intervalMs = clamp(toInt(spec.intervalMs, 1000), 10, 600000)
  return {
    kind: 'periodic',
    intervalMs,
    repeat: normalizeRepeat(spec.repeat),
    bytes: payload.bytes,
    spec: payload.spec,
  }
}

// 把运行态 spec 还原成可写进 settings 的纯 JSON。
function timerPersistSpec(spec) {
  if (spec.kind === 'sequence') {
    return {
      kind: 'sequence',
      loop: spec.loop,
      repeat: spec.repeat,
      steps: spec.steps.map((step) => ({ delayMs: step.delayMs, payload: step.spec })),
    }
  }
  return { kind: 'periodic', intervalMs: spec.intervalMs, repeat: spec.repeat, payload: spec.spec }
}

function decodeEntry(entry, encoding) {
  return decodeBytes(Buffer.from(entry.b, 'base64'), encoding)
}

function patternMatcher(expect, mode) {
  if (!expect) return null
  if (mode === 'regex') {
    let regex
    try { regex = new RegExp(expect) } catch (error) {
      throw new Error(`expect 正则非法：${error.message}`)
    }
    return (text) => regex.test(text)
  }
  return (text) => text.includes(expect)
}

/* ───────────────────────── 串口桥（Windows PowerShell） ───────────────────────── */

/* ───────────────────────── LinkManager ───────────────────────── */

export class CommManager {
  constructor(config) {
    this.config = config || {}
    this.maxLogEntries = Math.max(100, Number(config?.maxLogEntries) || 2000)
    this.maxReadEntries = Math.max(1, Number(config?.maxReadEntries) || 200)
    this.maxLogBytes = Math.max(64 * 1024, Number(config?.maxLogBytes) || 4 * 1024 * 1024)
    this.aiReplyDebounceMs = clamp(Number(config?.aiReplyDebounceMs) || 300, 0, 5000)
    // 自动回复防回环：自己发出的数据在 echoSuppressMs 内又原样收到时，视为回显/回环，不触发自动回复；
    // 每次真正转发后至少间隔 cooldownMs；60s 内超过 maxPerMinute 次直接暂停，避免无限自激。
    this.aiReplyEchoSuppressMs = clamp(Number(config?.aiReplyEchoSuppressMs) || 300, 0, 5000)
    this.aiReplyCooldownMs = clamp(Number(config?.aiReplyCooldownMs) || 500, 0, 60000)
    this.aiReplyMaxPerMinute = clamp(Number(config?.aiReplyMaxPerMinute) || 30, 1, 600)
    this.links = new Map()
    this.q = 0
    // writeAndWait 的等待者：有新日志条目时立即唤醒，避免轮询带来的额外延迟。
    this.entryWaiters = new Set()
    this.serialInfo = { available: false, error: null, checked: false }
    this.portsCache = { at: 0, value: null }
    // 串口桥与端口枚举都可注入，测试里用假桥验证自动重连/信号/参数，不需要真实串口。
    this.serialBridgeFactory = openSerialBridge
    this.serialPortsProvider = listSerialPorts
    this.reconnectDelayMs = 2000
    this.healthCheckMs = 3000
    // 自动回复：按链路保存的开关、规则、去抖窗口，持久化在 DSH home。
    this.settings = readSettings()
  }

  newLink(type, id, label, linkConfig) {
    const existing = this.links.get(id)
    if (existing && existing.open) throw new Error(`链路已存在：${id}`)
    if (existing) this.disposeLinkRuntime(existing)
    const link = {
      id,
      type,
      label,
      config: linkConfig || {},
      open: false,
      peers: new Map(),
      log: [],
      rx: 0,
      tx: 0,
      backlogBytes: 0,
      dropped: 0,
      droppedBytes: 0,
      error: null,
      handle: null,
      createdAt: Date.now(),
      closing: false,
      portInfo: null,
      reconnect: { active: false, attempts: 0, timer: null, generation: 0 },
      healthTimer: null,
      timer: null,
      // 最近一次发送（用于识别设备回显，避免自动回复自激）
      txMark: null,
      ai: { pending: [], timer: null, busy: false, lastNoSessionAt: 0, lastForwardAt: 0, forwards: [], pausedUntil: 0, lastEchoAt: 0, probe: null, probeTimer: null, silent: 0 },
    }
    this.links.set(id, link)
    return link
  }

  push(link, direction, peer, buf) {
    this.q += 1
    const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
    const entry = {
      q: this.q,
      t: Date.now(),
      l: link.id,
      d: direction,
      p: peer || '',
      b: bytes.toString('base64'),
    }
    link.log.push(entry)
    link.backlogBytes += bytes.length
    // 双上限：条数（防止大量小包）与字节（防止高速采集把内存打爆）。
    // 丢最旧的，丢弃量保留在计数器里，comm_list 能看到。
    while (link.log.length > 1 && (link.log.length > this.maxLogEntries || link.backlogBytes > this.maxLogBytes)) {
      const removed = link.log.shift()
      if (!removed) break
      const size = Buffer.byteLength(removed.b, 'base64')
      link.backlogBytes -= size
      link.dropped += 1
      link.droppedBytes += size
    }
    if (direction === 'rx') {
      link.rx += bytes.length
      this.autoReply(link, bytes, peer)
    } else if (direction === 'tx') {
      link.tx += bytes.length
      // 只保留最近一包，用于回显识别；拷贝一份避免调用方复用 Buffer。
      link.txMark = { t: entry.t, bytes: Buffer.from(bytes) }
      // 有发送说明自动回复的会话确实在工作：清掉无响应探针和计数。
      if (link.ai) {
        link.ai.silent = 0
        link.ai.probe = null
        if (link.ai.probeTimer) {
          clearTimeout(link.ai.probeTimer)
          link.ai.probeTimer = null
        }
      }
    }
    if (this.entryWaiters.size) {
      for (const waiter of Array.from(this.entryWaiters)) {
        if (waiter.linkId !== link.id) continue
        try { waiter.onEntry(entry) } catch { /* ignore */ }
      }
    }
    return entry
  }

  sys(link, text) {
    return this.push(link, 'sys', '', Buffer.from(text, 'utf8'))
  }

  linkOrThrow(id) {
    const link = this.links.get(String(id))
    if (!link) throw new Error(`链路不存在：${id}`)
    return link
  }

  timerSummary(link) {
    const timer = link.timer
    if (!timer || !timer.running) return null
    const summary = {
      running: true,
      kind: timer.spec.kind,
      sent: timer.sent,
      repeat: timer.spec.repeat,
      startedAt: timer.startedAt,
      nextAt: timer.nextAt || null,
      lastError: timer.lastError || null,
    }
    if (timer.spec.kind === 'periodic') summary.intervalMs = timer.spec.intervalMs
    else {
      summary.steps = timer.spec.steps.length
      summary.loop = timer.spec.loop
      summary.round = timer.round
    }
    return summary
  }

  serialSnapshot(link) {
    if (link.type !== 'serial') return null
    const config = link.config || {}
    return {
      signals: link.signals || { dtr: config.dtr !== false, rts: config.rts !== false },
      port: config.path,
      portInfo: link.portInfo || null,
      flowControl: config.flowControl || 'none',
      autoReconnect: config.autoReconnect !== false,
      reconnecting: Boolean(link.reconnect?.active),
      reconnectAttempts: link.reconnect?.attempts || 0,
    }
  }

  snapshot(link) {
    return {
      id: link.id,
      type: link.type,
      label: link.label,
      config: link.config,
      open: link.open,
      error: link.error,
      peers: Array.from(link.peers.keys()),
      rx: link.rx,
      tx: link.tx,
      backlog: link.log.length,
      backlogBytes: link.backlogBytes,
      dropped: link.dropped,
      droppedBytes: link.droppedBytes,
      timer: this.timerSummary(link),
      serial: this.serialSnapshot(link),
      createdAt: link.createdAt,
    }
  }

  state() {
    return {
      links: Array.from(this.links.values()).map((link) => this.snapshot(link)),
      serial: this.serialInfo,
      // 自动回复当前绑定的会话（null = 没有绑定，下条消息会新建/重选）。
      // 会话被删后这里会变成 null，便于排查"到底投给了谁"。
      aiReplySessionId: String(this.settings.aiReplySessionId || '').trim() || null,
    }
  }

  async ports(force) {
    // 枚举串口要 spawn 一次 PowerShell（约 1s），短时缓存，避免轮询/列表把 CPU 拖满。
    const now = Date.now()
    if (!force && this.portsCache.value && now - this.portsCache.at < 30000) {
      return this.withPortDefaults(this.portsCache.value)
    }
    const result = await this.serialPortsProvider()
    this.serialInfo = { available: result.available, error: result.error || null, checked: true }
    this.portsCache = { at: now, value: { ...result } }
    return this.withPortDefaults(result)
  }

  withPortDefaults(result) {
    const ports = Array.isArray(result?.ports) ? result.ports : []
    return {
      ...result,
      ports: ports.map((port) => ({
        ...port,
        defaults: { ...normalizeSerialParams({}, this.settings.serialDefaults[port.path] || {}) },
      })),
    }
  }

  serialDefaults(path) {
    return normalizeSerialParams({}, this.settings.serialDefaults[path] || {})
  }

  saveSerialDefaults(path, config) {
    if (!path) return
    this.settings.serialDefaults[path] = { ...config }
    writeSettings(this.settings)
  }

  findPortInfo(path, ports) {
    const list = Array.isArray(ports) ? ports : this.portsCache.value?.ports || []
    return list.find((port) => port.path === path) || null
  }

  async open(type, opts) {
    const options = opts || {}
    if (type === 'serial') return this.openSerial(options)
    if (type === 'tcpServer') return this.openTcpServer(options)
    if (type === 'tcpClient') return this.openTcpClient(options)
    if (type === 'udp') return this.openUdp(options)
    throw new Error(`不支持的链路类型：${type}`)
  }

  attachSerialBridge(link, bridge) {
    link.handle = bridge
    bridge.on('data', (data) => {
      if (!link.open || link.closing) return
      this.push(link, 'rx', '', data)
    })
    bridge.on('error', (error) => {
      // 桥错误多数是断开前兆。这里只记录，真正断开由 close 事件/健康检查处理，
      // 避免同一故障刷多条系统日志。
      link.error = String(error?.message || error)
    })
    bridge.on('close', (reason) => {
      this.handleSerialClose(link, String(reason || '串口连接已关闭'))
    })
  }

  startSerialHealth(link) {
    this.stopSerialHealth(link)
    link.healthTimer = setInterval(() => {
      if (!link.open || link.closing || link.reconnect.active || !link.handle) return
      if (typeof link.handle.ping !== 'function') return
      void link.handle.ping().then((healthy) => {
        if (!healthy) this.handleSerialClose(link, '串口无响应（ping 失败）')
      }).catch((error) => {
        this.handleSerialClose(link, `串口无响应：${error?.message || error}`)
      })
    }, this.healthCheckMs)
    link.healthTimer.unref?.()
  }

  stopSerialHealth(link) {
    if (link.healthTimer) { clearInterval(link.healthTimer); link.healthTimer = null }
  }

  // 串口断开：记录一次系统日志，按配置进入自动重连循环。
  handleSerialClose(link, reason) {
    if (!link.open || link.closing) return
    link.open = false
    this.stopSerialHealth(link)
    const bridge = link.handle
    link.handle = null
    if (bridge && typeof bridge.close === 'function') {
      // 拔掉设备后旧桥进程可能已经退出；这里 best-effort 清理，避免残留 PowerShell。
      Promise.resolve().then(() => bridge.close()).catch(() => {})
    }
    this.stopTimer(link.id, { quiet: true })
    this.sys(link, `串口断开：${reason}`)
    if (link.config.autoReconnect === false) {
      link.reconnect.active = false
      return
    }
    link.reconnect.active = true
    link.reconnect.attempts = 0
    if (link.ai?.timer) { clearTimeout(link.ai.timer); link.ai.timer = null }
    if (link.ai) link.ai.pending = []
    this.scheduleReconnect(link)
  }

  scheduleReconnect(link) {
    if (link.closing || !link.reconnect.active || link.reconnect.timer || link.open) return
    link.reconnect.timer = setTimeout(() => {
      link.reconnect.timer = null
      void this.tryReconnect(link).catch(() => {})
    }, this.reconnectDelayMs)
    link.reconnect.timer.unref?.()
  }

  reconnectNotice(link) {
    const attempts = link.reconnect.attempts
    if (attempts === 1) this.sys(link, '串口已断开，正在自动重连…（拔插后端口号变化也能按 VID/PID 找回）')
    else if (attempts % 15 === 0) this.sys(link, `自动重连中（第 ${attempts} 次，约 ${Math.round((attempts * this.reconnectDelayMs) / 1000)}s）…`)
    this.scheduleReconnect(link)
  }

  async tryReconnect(link) {
    if (link.closing || !link.reconnect.active || link.open) return
    link.reconnect.attempts += 1
    let bridge = null
    try {
      let ports = []
      try { ports = (await this.ports(true)).ports || [] } catch { ports = [] }
      let path = link.config.path
      let matched = ports.some((port) => port.path === path)
      if (!matched) {
        const info = link.portInfo || {}
        const candidate = ports.find((port) => {
          if (info.serial && port.serial && port.serial === info.serial) return true
          return Boolean(info.vid && info.pid && port.vid === info.vid && port.pid === info.pid)
        })
        if (candidate) { path = candidate.path; matched = true }
      }
      if (!matched) { this.reconnectNotice(link); return }

      const config = { ...link.config, path }
      bridge = this.serialBridgeFactory(config)
      link.handle = bridge
      this.attachSerialBridge(link, bridge)
      await bridge.open()
      if (link.closing) { try { await bridge.close() } catch { /* ignore */ } return }
      link.config.path = path
      link.label = serialLabel(path, config)
      link.portInfo = this.findPortInfo(path, ports)
      link.open = true
      link.error = null
      link.reconnect.active = false
      link.reconnect.attempts = 0
      try { link.signals = await bridge.signals() } catch { /* ignore */ }
      this.startSerialHealth(link)
      this.sys(link, `已重新连接 ${path}（${serialFrameText(config)}）`)
      this.maybeAutostartTimer(link)
    } catch (error) {
      link.handle = null
      if (bridge && typeof bridge.close === 'function') {
        Promise.resolve().then(() => bridge.close()).catch(() => {})
      }
      link.error = String(error?.message || error)
      this.reconnectNotice(link)
    }
  }

  async openSerial(options) {
    const path = String(options.path || '').trim()
    if (!path) throw new Error('缺少串口路径（path）')
    if (!serialSupported()) throw new Error('串口桥只支持 Windows（PowerShell 5.1+）')
    const saved = this.settings.serialDefaults[path] || {}
    const config = { path, ...normalizeSerialParams(options, saved) }
    const id = `serial:${path}`
    const link = this.newLink('serial', id, serialLabel(path, config), config)
    link.signals = { dtr: config.dtr, rts: config.rts }
    // 记录 PnP（VID/PID/序列号），拔插后端口号变了也能找回；枚举失败不阻塞打开。
    try {
      const ports = (await this.ports()).ports || []
      link.portInfo = this.findPortInfo(path, ports)
    } catch { link.portInfo = null }

    const bridge = this.serialBridgeFactory(config)
    this.attachSerialBridge(link, bridge)
    try {
      await bridge.open()
    } catch (error) {
      this.links.delete(id)
      this.disposeLinkRuntime(link)
      try { await bridge.close() } catch { /* ignore */ }
      throw error
    }
    link.open = true
    try { link.signals = await bridge.signals() } catch { /* ignore */ }
    this.saveSerialDefaults(path, {
      baudRate: config.baudRate,
      dataBits: config.dataBits,
      parity: config.parity,
      stopBits: config.stopBits,
      flowControl: config.flowControl,
      dtr: config.dtr,
      rts: config.rts,
      autoReconnect: config.autoReconnect,
    })
    this.startSerialHealth(link)
    this.sys(link, `已打开 ${path} @ ${config.baudRate} ${serialFrameText(config)}`)
    this.maybeAutostartTimer(link)
    return this.snapshot(link)
  }

  currentSignals(link) {
    if (link.signals) return { ...link.signals }
    return { dtr: link.config?.dtr !== false, rts: link.config?.rts !== false }
  }

  // 串口运行时控制：信号 / 脉冲 / 重新配置 / 手动重连。
  async serialAction(id, action, body) {
    const link = this.linkOrThrow(id)
    if (link.type !== 'serial') throw new Error('只有串口链路支持信号控制')
    const act = String(action || 'signals')
    const input = body || {}
    if (act === 'signals') return { link: this.snapshot(link), signals: this.currentSignals(link) }
    if (act === 'configure') {
      const next = normalizeSerialParams(input, link.config)
      if (link.open && link.handle && typeof link.handle.reconfigure === 'function') {
        await link.handle.reconfigure({ path: link.config.path, ...next })
        link.signals = await link.handle.signals().catch(() => link.signals)
      }
      link.config = { ...link.config, ...next }
      link.label = serialLabel(link.config.path, link.config)
      this.saveSerialDefaults(link.config.path, next)
      if (link.open) this.sys(link, `串口参数已更新：${serialFrameText(link.config)}`)
      return { link: this.snapshot(link), signals: this.currentSignals(link) }
    }
    if (!link.open) throw new Error(`串口未打开：${id}`)
    if (act === 'set') {
      const signals = await link.handle.setSignals({ dtr: input.dtr, rts: input.rts })
      link.signals = signals
      if (input.dtr !== undefined) link.config.dtr = Boolean(input.dtr)
      if (input.rts !== undefined) link.config.rts = Boolean(input.rts)
      this.saveSerialDefaults(link.config.path, link.config)
      return { link: this.snapshot(link), signals }
    }
    if (act === 'pulse') {
      const line = input.line === 'rts' ? 'rts' : 'dtr'
      const ms = clamp(toInt(input.ms, 100), 1, 5000)
      try {
        const reply = await link.handle.pulse(line, ms, input.level)
        const signals = { dtr: Boolean(reply.dtr), rts: Boolean(reply.rts) }
        return { link: this.snapshot(link), signals, pulseMs: ms }
      } catch (error) {
        throw new Error(`脉冲失败：${error?.message || error}`)
      }
    }
    if (act === 'reconnect') {
      const oldBridge = link.handle
      link.closing = false
      link.open = false
      link.handle = null
      this.stopSerialHealth(link)
      try { await oldBridge?.close?.() } catch { /* ignore */ }
      this.sys(link, '手动触发重连…')
      link.reconnect.active = true
      link.reconnect.attempts = 0
      if (link.reconnect.timer) { clearTimeout(link.reconnect.timer); link.reconnect.timer = null }
      void this.tryReconnect(link).catch(() => {})
      return { link: this.snapshot(link) }
    }
    throw new Error(`不支持的串口动作：${act}`)
  }

  async openTcpServer(options) {
    // 默认只监听本机；要对局域网开放请显式传 host=0.0.0.0。
    const host = String(options.host || '127.0.0.1')
    const port = Number(options.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 的整数')
    const id = `tcpServer:${host}:${port}`
    const link = this.newLink('tcpServer', id, `TCP 服务 ${host}:${port}`, { host, port })
    const server = net.createServer((socket) => {
      const peer = `${socket.remoteAddress || '?'}:${socket.remotePort || 0}`
      link.peers.set(peer, socket)
      this.sys(link, `客户端 ${peer} 接入`)
      socket.on('data', (data) => this.push(link, 'rx', peer, Buffer.from(data)))
      socket.on('close', () => {
        if (!link.peers.has(peer)) return
        link.peers.delete(peer)
        this.sys(link, `客户端 ${peer} 断开`)
      })
      socket.on('error', () => { /* close 会处理 */ })
    })
    link.handle = server
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListening); reject(error) }
        const onListening = () => { server.off('error', onError); resolve() }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })
    } catch (error) {
      this.links.delete(id)
      throw error
    }
    link.open = true
    server.on('error', (error) => {
      link.error = String(error?.message || error)
      this.sys(link, `服务端错误：${link.error}`)
    })
    this.sys(link, `监听 ${host}:${port}`)
    return this.snapshot(link)
  }

  async openTcpClient(options) {
    const host = String(options.host || '').trim()
    const port = Number(options.port)
    if (!host) throw new Error('缺少远程地址（host）')
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 的整数')
    const id = `tcpClient:${host}:${port}`
    const link = this.newLink('tcpClient', id, `TCP 客户端 ${host}:${port}`, { host, port })
    const socket = net.connect({ host, port })
    link.handle = socket
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接超时')), 8000)
      const onConnect = () => {
        clearTimeout(timer)
        socket.off('error', onError)
        resolve()
      }
      const onError = (error) => {
        clearTimeout(timer)
        socket.off('connect', onConnect)
        reject(error)
      }
      socket.once('connect', onConnect)
      socket.once('error', onError)
    }).catch((error) => {
      socket.destroy()
      this.links.delete(id)
      throw error
    })
    link.open = true
    socket.on('data', (data) => this.push(link, 'rx', '', Buffer.from(data)))
    socket.on('close', () => {
      if (!link.open) return
      link.open = false
      this.sys(link, '连接已断开')
    })
    socket.on('error', (error) => {
      link.error = String(error?.message || error)
      this.sys(link, `错误：${link.error}`)
    })
    this.sys(link, `已连接 ${host}:${port}`)
    return this.snapshot(link)
  }

  async openUdp(options) {
    const localPort = Number(options.localPort)
    const localHost = String(options.localHost || '0.0.0.0').trim() || '0.0.0.0'
    const remoteHost = String(options.remoteHost || '127.0.0.1').trim() || '127.0.0.1'
    const remotePort = Number(options.remotePort)
    if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) throw new Error('本地端口必须是 0–65535 的整数')
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new Error('远程端口必须是 1–65535 的整数')
    const id = `udp:${localHost}:${localPort}`
    const link = this.newLink('udp', id, `UDP ${localHost}:${localPort} → ${remoteHost}:${remotePort}`, {
      localHost,
      localPort,
      remoteHost,
      remotePort,
    })
    const socket = dgram.createSocket('udp4')
    link.handle = socket
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('绑定超时')), 5000)
      socket.once('error', (error) => { clearTimeout(timer); reject(error) })
      socket.bind(localPort, localHost, () => { clearTimeout(timer); resolve() })
    }).catch((error) => {
      try { socket.close() } catch { /* ignore */ }
      this.links.delete(id)
      throw error
    })
    link.open = true
    socket.on('message', (msg, rinfo) => this.push(link, 'rx', `${rinfo.address}:${rinfo.port}`, Buffer.from(msg)))
    socket.on('error', (error) => {
      link.error = String(error?.message || error)
      this.sys(link, `UDP 错误：${link.error}`)
    })
    this.sys(link, `UDP 已绑定 ${localHost}:${localPort} → ${remoteHost}:${remotePort}`)
    return this.snapshot(link)
  }

  disposeLinkRuntime(link) {
    this.stopSerialHealth(link)
    if (link.reconnect?.timer) { clearTimeout(link.reconnect.timer); link.reconnect.timer = null }
    link.reconnect = { active: false, attempts: 0, timer: null, generation: 0 }
    this.stopTimer(link.id, { quiet: true })
    if (link.ai?.timer) { clearTimeout(link.ai.timer); link.ai.timer = null }
    if (link.ai) { link.ai.pending = []; link.ai.busy = false }
  }

  async close(id) {
    const link = this.linkOrThrow(id)
    const handle = link.handle
    link.closing = true
    link.reconnect.active = false
    if (link.reconnect.timer) { clearTimeout(link.reconnect.timer); link.reconnect.timer = null }
    this.stopSerialHealth(link)
    // 关闭链路时停掉定时器；持久化定义和「自动开始」设置保留，下次打开可恢复。
    this.stopTimer(id, { quiet: true })
    if (link.ai?.timer) { clearTimeout(link.ai.timer); link.ai.timer = null }
    link.ai.pending = []
    try {
      if (link.type === 'serial') {
        await handle?.close?.()
      } else if (link.type === 'tcpServer') {
        for (const socket of link.peers.values()) {
          try { socket.destroy() } catch { /* ignore */ }
        }
        link.peers.clear()
        await new Promise((resolve) => {
          if (!handle) return resolve()
          handle.close(() => resolve())
        })
      } else if (link.type === 'tcpClient') {
        try { handle?.destroy() } catch { /* ignore */ }
      } else if (link.type === 'udp') {
        await new Promise((resolve) => {
          if (!handle) return resolve()
          try { handle.close(() => resolve()) } catch { resolve() }
        })
      }
    } catch (error) {
      link.error = String(error?.message || error)
    }
    link.open = false
    this.links.delete(id)
    return this.state()
  }

  async closeAll() {
    for (const id of Array.from(this.links.keys())) {
      try { await this.close(id) } catch { /* ignore */ }
    }
    for (const link of this.links.values()) this.disposeLinkRuntime(link)
  }

  async write(id, bytes, peer, meta) {
    const link = this.linkOrThrow(id)
    if (!link.open) {
      if (link.type === 'serial' && link.reconnect?.active) {
        throw new Error(`串口正在自动重连，暂时无法发送：${id}`)
      }
      throw new Error(`链路未打开：${id}`)
    }
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    if (buf.length === 0) throw new Error('发送内容为空')
    const mark = (entry) => {
      if (entry && meta?.hex) entry.x = 1
      return entry
    }
    if (link.type === 'serial') {
      try {
        await link.handle.write(buf)
      } catch (error) {
        const code = String(error?.code || '')
        const detail = String(error?.message || error)
        let hint = ''
        if (code === 'Timeout') {
          hint = link.config.flowControl && link.config.flowControl !== 'none'
            ? `写超时：设备 2s 内没有接收数据。当前流控是 ${link.config.flowControl}，如果对端没有正确接 CTS/XON 线，请把串口参数 flowControl 改成 none 再试。`
            : '写超时：设备 2s 内没有接收数据。检查 USB 转串口驱动、接线，或降低波特率/缩短数据后再试。'
        } else if (code === 'Disconnected') {
          hint = '串口已断开，插件会自动重连；也可以在面板里点「重连」。'
        } else if (code === 'EmptyPayload') {
          hint = '发送内容为空。'
        } else if (code === 'BufferOverflow') {
          hint = '串口发送缓冲溢出：降一点发送频率或波特率。'
        } else if (/参数错误|parameter is incorrect|invalid parameter/i.test(detail)) {
          hint = '“参数错误”是串口驱动返回的，不是插件协议问题。最常见于虚拟串口只建了单端或对端程序没打开：请把虚拟串口配置成一对本地桥接端口，并在另一个串口工具里打开对端；或换真实 USB 转串口设备再试。'
        }
        const now = Date.now()
        if (now - (link.lastWriteErrorAt || 0) > 1000) {
          link.lastWriteErrorAt = now
          this.sys(link, `串口发送失败：${detail}${hint ? `（${hint}）` : ''}`)
        }
        const wrapped = new Error(hint ? `${detail}\n${hint}` : detail)
        wrapped.code = code
        throw wrapped
      }
      mark(this.push(link, 'tx', '', buf))
      return { written: buf.length }
    }
    if (link.type === 'tcpServer') {
      if (link.peers.size === 0) throw new Error('没有已连接的客户端')
      const targets = peer && link.peers.has(peer) ? [[peer, link.peers.get(peer)]] : Array.from(link.peers.entries())
      for (const [key, socket] of targets) {
        socket.write(buf)
        mark(this.push(link, 'tx', key, buf))
      }
      return { written: buf.length, targets: targets.map(([key]) => key) }
    }
    if (link.type === 'tcpClient') {
      link.handle.write(buf)
      mark(this.push(link, 'tx', '', buf))
      return { written: buf.length }
    }
    if (link.type === 'udp') {
      const remote = link.config
      link.handle.send(buf, remote.remotePort, remote.remoteHost)
      mark(this.push(link, 'tx', `${remote.remoteHost}:${remote.remotePort}`, buf))
      return { written: buf.length }
    }
    throw new Error(`不支持的链路类型：${link.type}`)
  }

  // 写 + 等响应：一次工具往返完成「发指令→看反应」，不用再补一次 comm_read。
  // 等待用 push() 里的 entryWaiters 立即唤醒，不用轮询，回环延迟通常是亚毫秒级。
  async writeAndWait(id, bytes, options) {
    const opts = options || {}
    const link = this.linkOrThrow(id)
    const startQ = this.q
    const expect = opts.expect === undefined || opts.expect === null ? '' : String(opts.expect)
    const mode = opts.expectMode === 'regex' ? 'regex' : 'contains'
    const timeoutMs = clamp(toInt(opts.expectTimeoutMs ?? opts.timeoutMs, 2000), 1, 60000)
    const encoding = opts.encoding || 'utf-8'
    const matcher = patternMatcher(expect, mode)
    const entryLimit = Math.max(1, clamp(toInt(opts.entryLimit, 50), 1, 500))
    const collect = () => link.log
      .filter((entry) => entry.q > startQ)
      .slice(-entryLimit)
      .map((entry) => {
        const buf = Buffer.from(entry.b, 'base64')
        return { q: entry.q, t: entry.t, dir: entry.d, peer: entry.p, text: decodeBytes(buf, encoding), hex: buf.toString('hex').toUpperCase() }
      })

    if (!matcher) {
      const plain = await this.write(id, bytes, opts.peer, opts)
      return { ...plain, matched: false, waitedMs: 0, entries: [] }
    }

    let resolveHit = null
    const hitPromise = new Promise((resolve) => { resolveHit = resolve })
    const waiter = {
      linkId: link.id,
      onEntry: (entry) => {
        if (entry.q <= startQ) return
        const text = decodeEntry(entry, encoding)
        const hex = Buffer.from(entry.b, 'base64').toString('hex').toUpperCase()
        if (matcher(text) || matcher(hex)) resolveHit(entry)
      },
    }
    this.entryWaiters.add(waiter)
    const startedAt = Date.now()
    const timer = setTimeout(() => resolveHit(null), timeoutMs)
    // 先挂等待者再写，避免设备回复比 write() 返回还快时漏掉。
    let result
    try {
      result = await this.write(id, bytes, opts.peer, opts)
      // 极端情况下（同步 echo）条目可能在 await 之前就已到达，补查一次。
      const existing = link.log.find((entry) => {
        if (entry.q <= startQ) return false
        const text = decodeEntry(entry, encoding)
        const hex = Buffer.from(entry.b, 'base64').toString('hex').toUpperCase()
        return matcher(text) || matcher(hex)
      })
      if (existing) resolveHit(existing)
      const hit = await hitPromise
      const waitedMs = Date.now() - startedAt
      return hit
        ? { ...result, matched: true, waitedMs, matcher: { expect, mode }, entries: collect() }
        : { ...result, matched: false, timedOut: true, waitedMs, matcher: { expect, mode }, entries: collect() }
    } finally {
      clearTimeout(timer)
      this.entryWaiters.delete(waiter)
    }
  }

  read(id, options) {
    const link = this.linkOrThrow(id)
    const since = Number(options?.since) || 0
    const limit = Math.min(Number(options?.limit) || this.maxReadEntries, this.maxReadEntries)
    const format = options?.format === 'hex' ? 'hex' : 'text'
    const encoding = options?.encoding || 'utf-8'
    const entries = link.log
      .filter((entry) => entry.q > since)
      .slice(0, limit)
      .map((entry) => {
        const buf = Buffer.from(entry.b, 'base64')
        return {
          q: entry.q,
          t: entry.t,
          dir: entry.d,
          peer: entry.p,
          hex: buf.toString('hex').toUpperCase(),
          text: decodeBytes(buf, encoding),
        }
      })
    return {
      link: this.snapshot(link),
      format,
      entries,
      cursor: entries.length ? entries[entries.length - 1].q : since,
    }
  }

  peers(id) {
    const link = this.linkOrThrow(id)
    return { link: this.snapshot(link), peers: Array.from(link.peers.keys()) }
  }

  clear(id) {
    if (id) {
      const link = this.linkOrThrow(id)
      link.log.length = 0
      link.backlogBytes = 0
    } else {
      for (const link of this.links.values()) {
        link.log.length = 0
        link.backlogBytes = 0
      }
    }
    return this.state()
  }

  /* ── 定时 / 序列发送（Host 侧：面板关掉也继续，重启后可按 autostart 恢复） ── */

  timerState(id) {
    const link = this.links.get(String(id))
    return link ? this.timerSummary(link) : null
  }

  savedTimer(id) {
    const saved = this.settings.timers[String(id)]
    if (!saved || !saved.spec) return null
    return { spec: saved.spec, autostart: Boolean(saved.autostart) }
  }

  saveTimerSpec(id, spec, autostart) {
    const key = String(id || '')
    if (!key) throw new Error('缺少 link（定时器按链路保存）')
    if (spec) this.settings.timers[key] = { spec, autostart: Boolean(autostart) }
    else if (this.settings.timers[key] && autostart !== undefined) this.settings.timers[key].autostart = Boolean(autostart)
    writeSettings(this.settings)
    return this.savedTimer(key)
  }

  timerWrite(link, timer, bytes) {
    if (!link.open) {
      timer.lastError = '链路已关闭'
      this.stopTimer(link.id, { quiet: true })
      this.sys(link, '定时发送已停止：链路已关闭')
      return false
    }
    try {
      void this.write(link.id, bytes, undefined, {}).catch((error) => {
        timer.lastError = String(error?.message || error)
        timer.errors += 1
        if (timer.errors >= 3 && timer.running) {
          this.stopTimer(link.id, { quiet: true })
          this.sys(link, `定时发送已停止：连续发送失败（${timer.lastError}）`)
        }
      })
      timer.sent += 1
      return true
    } catch (error) {
      timer.lastError = String(error?.message || error)
      timer.errors += 1
      return false
    }
  }

  // 定时器回调里永远不能抛出：Node 的 setTimeout 回调抛异常 = 未捕获异常，
  // 可能直接带走 Host 进程。所有异常统一停表 + 记一条系统日志。
  timerCrash(link, timer, label, error) {
    try {
      timer.lastError = String(error?.message || error)
      this.stopTimer(link.id, { quiet: true })
      this.sys(link, `${label}异常已停止：${timer.lastError}`)
    } catch { /* 这里绝不能再抛 */ }
  }

  periodicTick(link, timer) {
    try {
      if (!timer.running || link.timer !== timer) return
      const spec = timer.spec
      if (spec.repeat > 0 && timer.sent >= spec.repeat) {
        this.stopTimer(link.id, { quiet: true })
        this.sys(link, `定时发送完成：共 ${timer.sent} 次`)
        return
      }
      this.timerWrite(link, timer, spec.bytes)
      timer.nextAt = Date.now() + spec.intervalMs
      timer.timerId = setTimeout(() => this.periodicTick(link, timer), spec.intervalMs)
      timer.timerId.unref?.()
    } catch (error) {
      this.timerCrash(link, timer, '周期定时发送', error)
    }
  }

  sequenceTick(link, timer) {
    try {
      if (!timer.running || link.timer !== timer) return
      const spec = timer.spec
      const step = spec.steps[timer.stepIndex]
      if (!step) { this.stopTimer(link.id, { quiet: true }); return }
      this.timerWrite(link, timer, step.bytes)
      timer.stepIndex += 1
      let wait = 0
      if (timer.stepIndex >= spec.steps.length) {
        timer.stepIndex = 0
        timer.round += 1
        if (!spec.loop) {
          this.stopTimer(link.id, { quiet: true })
          this.sys(link, `序列发送完成：共 ${timer.sent} 条 / ${timer.round} 轮`)
          return
        }
        if (spec.repeat > 0 && timer.round >= spec.repeat) {
          this.stopTimer(link.id, { quiet: true })
          this.sys(link, `序列发送完成：共 ${timer.sent} 条 / ${timer.round} 轮`)
          return
        }
        wait = spec.steps[0].delayMs
      } else {
        wait = spec.steps[timer.stepIndex].delayMs
      }
      timer.nextAt = Date.now() + wait
      timer.timerId = setTimeout(() => this.sequenceTick(link, timer), wait)
      timer.timerId.unref?.()
    } catch (error) {
      this.timerCrash(link, timer, '序列发送', error)
    }
  }

  startTimer(id, rawSpec, options) {
    const opts = options || {}
    const link = this.linkOrThrow(id)
    if (!link.open) throw new Error(`链路未打开，无法启动定时发送：${id}`)
    const spec = normalizeTimerSpec(rawSpec)
    this.stopTimer(id, { quiet: true })
    const timer = {
      spec,
      running: true,
      sent: 0,
      errors: 0,
      round: 0,
      stepIndex: 0,
      startedAt: Date.now(),
      nextAt: null,
      lastError: null,
      timerId: null,
    }
    link.timer = timer
    if (opts.persist !== false) {
      const existing = this.settings.timers[String(id)]
      const autostart = opts.autostart !== undefined ? Boolean(opts.autostart) : Boolean(existing?.autostart)
      this.saveTimerSpec(id, timerPersistSpec(spec), autostart)
    }
    if (spec.kind === 'periodic') this.periodicTick(link, timer)
    else {
      // 序列第一步也遵守自己的 delayMs（0 表示立即发）。
      const wait = spec.steps[0]?.delayMs || 0
      timer.nextAt = Date.now() + wait
      timer.timerId = setTimeout(() => this.sequenceTick(link, timer), wait)
      timer.timerId.unref?.()
    }
    return this.timerSummary(link)
  }

  stopTimer(id, options) {
    const opts = options || {}
    const key = String(id || '')
    const link = this.links.get(key)
    if (!link) return null
    const timer = link.timer
    link.timer = null
    if (!timer) return null
    timer.running = false
    if (timer.timerId) { clearTimeout(timer.timerId); timer.timerId = null }
    if (!opts.quiet) this.sys(link, `定时发送已停止（已发 ${timer.sent} 次）`)
    return { sent: timer.sent, round: timer.round }
  }

  maybeAutostartTimer(link) {
    const saved = this.savedTimer(link.id)
    if (!saved || !saved.autostart) return
    try {
      this.startTimer(link.id, saved.spec, { persist: false })
      this.sys(link, '已按保存的设置自动开始定时发送')
    } catch (error) {
      this.sys(link, `自动开始定时发送失败：${error?.message || error}`)
    }
  }

  async timerAction(id, action, body) {
    const link = this.linkOrThrow(id)
    const act = String(action || 'status')
    if (act === 'status') return { link: this.snapshot(link), timer: this.timerState(id), saved: this.savedTimer(id) }
    if (act === 'stop') {
      this.stopTimer(id, { quiet: false })
      return { link: this.snapshot(link), timer: this.timerState(id), saved: this.savedTimer(id) }
    }
    if (act === 'start') {
      const timer = this.startTimer(id, body?.spec, { autostart: body?.autostart })
      return { link: this.snapshot(link), timer, saved: this.savedTimer(id) }
    }
    if (act === 'save') {
      const spec = normalizeTimerSpec(body?.spec)
      const saved = this.saveTimerSpec(id, timerPersistSpec(spec), body?.autostart)
      return { link: this.snapshot(link), timer: this.timerState(id), saved }
    }
    if (act === 'delete') {
      this.stopTimer(id, { quiet: true })
      delete this.settings.timers[String(id)]
      writeSettings(this.settings)
      return { link: this.snapshot(link), timer: null, saved: null }
    }
    throw new Error(`不支持的定时器动作：${act}`)
  }

  getTimer(id) {
    const link = this.linkOrThrow(id)
    return { link: this.snapshot(link), timer: this.timerState(id), saved: this.savedTimer(id) }
  }

  /* ── 自动回复 ── */

  rulesOf(id) {
    const list = this.settings.rules[String(id)]
    return Array.isArray(list) ? list.map((rule) => ({ ...rule })) : []
  }

  autoEnabled(id) {
    return Boolean(this.settings.auto[String(id)])
  }

  autoDebounceOf(id) {
    const opts = this.settings.autoOpts[String(id)]
    const value = Number(opts?.debounceMs)
    return Number.isFinite(value) ? clamp(value, 0, 5000) : this.aiReplyDebounceMs
  }

  setAuto(id, enabled, debounceMs) {
    const key = String(id || '')
    if (!key) throw new Error('缺少 link（自动回复按链路保存）')
    if (enabled) this.settings.auto[key] = true
    else delete this.settings.auto[key]
    if (debounceMs !== undefined && debounceMs !== null && debounceMs !== '') {
      const opts = this.settings.autoOpts[key] || {}
      this.settings.autoOpts[key] = { ...opts, debounceMs: clamp(toInt(debounceMs, this.aiReplyDebounceMs), 0, 5000) }
    }
    writeSettings(this.settings)
    return { enabled: this.autoEnabled(key), debounceMs: this.autoDebounceOf(key) }
  }

  setRules(id, list) {
    const key = String(id || '')
    if (!key) throw new Error('缺少 link（自动回复按链路保存）')
    const rules = (Array.isArray(list) ? list : []).map((rule, index) => ({
      id: String(rule?.id || `r${index + 1}`),
      enabled: rule?.enabled !== false,
      mode: ['contains', 'regex', 'hex'].includes(rule?.mode) ? rule.mode : 'contains',
      match: String(rule?.match ?? ''),
      reply: String(rule?.reply ?? ''),
      encoding: normalizeEncoding(rule?.encoding || 'utf-8'),
      delayMs: Math.max(0, Math.min(60000, Math.floor(Number(rule?.delayMs) || 0))),
      target: rule?.target === 'all' ? 'all' : 'sender',
    }))
    if (rules.length) this.settings.rules[key] = rules
    else delete this.settings.rules[key]
    writeSettings(this.settings)
    return this.rulesOf(key)
  }

  // 识别「自己刚发出的数据又被原样收回来」：串口本地回显、TCP 回环、设备 echo 命令等。
  // 自动回复若对这种回显再回复，就会形成无限自激；所以先过滤掉。
  isLikelyEcho(link, bytes) {
    const mark = link.txMark
    if (!mark || !mark.bytes?.length || !bytes?.length) return false
    const age = Date.now() - mark.t
    if (age < 0 || age > this.aiReplyEchoSuppressMs) return false
    if (bytes.equals(mark.bytes)) return true
    // 分片回显：短包完整出现在长包（或反过来）里也当作回显。
    if (mark.bytes.length >= bytes.length && mark.bytes.includes(bytes)) return true
    return bytes.length >= mark.bytes.length && bytes.includes(mark.bytes)
  }

  autoReply(link, bytes, peer) {
    if (!link.open || !this.autoEnabled(link.id)) return
    if (this.isLikelyEcho(link, bytes)) {
      const now = Date.now()
      if (now - (link.ai.lastEchoAt || 0) > 10000) {
        link.ai.lastEchoAt = now
        this.sys(link, '已忽略疑似回显/回环数据，未触发自动回复')
      }
      return
    }
    const rules = this.rulesOf(link.id)
    if (rules.length === 0) {
      // 已启用但无规则：方案 A，把消息合并后转给 DSH 会话（由模型用 comm_write 回复）。
      this.queueAiFallback(link, bytes, peer)
      return
    }
    const hex = bytes.toString('hex').toUpperCase()
    for (const rule of rules) {
      if (rule.enabled === false || !rule.match) continue
      let hit = false
      if (rule.mode === 'hex') {
        hit = hex.replace(/\s+/g, '').includes(String(rule.match).replace(/\s+/g, '').toUpperCase())
      } else {
        const text = decodeBytes(bytes, rule.encoding)
        if (rule.mode === 'regex') {
          try { hit = new RegExp(rule.match).test(text) } catch { hit = false }
        } else {
          hit = text.includes(rule.match)
        }
      }
      if (!hit) continue
      const send = () => {
        if (!link.open) return
        const target = rule.target === 'all' ? undefined : (peer || undefined)
        this.write(link.id, encodeText(rule.reply, rule.encoding), target, {}).catch(() => {})
      }
      if (rule.delayMs > 0) setTimeout(send, rule.delayMs)
      else send()
    }
  }

  // 没有规则时的 AI 转发：在去抖窗口内合并多条消息，只注入一次会话，
  // 避免高频串口数据把主对话刷成大量「注入式提示」。
  queueAiFallback(link, bytes, peer) {
    if (typeof this.aiFallback !== 'function') {
      const now = Date.now()
      if (now - (link.ai.lastNoSessionAt || 0) > 10000) {
        link.ai.lastNoSessionAt = now
        this.sys(link, '没有可用 DSH 会话，未自动回复')
      }
      return
    }
    const ai = link.ai
    ai.pending.push({ bytes: Buffer.from(bytes), peer: peer || '' })
    if (ai.pending.length > 50) ai.pending.splice(0, ai.pending.length - 50)
    if (ai.timer) clearTimeout(ai.timer)
    ai.timer = setTimeout(() => {
      ai.timer = null
      void this.flushAiFallback(link).catch(() => {})
    }, this.autoDebounceOf(link.id))
    ai.timer.unref?.()
  }

  async flushAiFallback(link) {
    const ai = link.ai
    if (ai.busy || !ai.pending.length || !link.open) return
    const now = Date.now()
    if (now < ai.pausedUntil) { ai.pending = []; return }
    // 两次转发之间留冷却时间，把设备回显造成的自激从「无限快」压到最多 cooldown 一次。
    const wait = ai.lastForwardAt + this.aiReplyCooldownMs - now
    if (wait > 0) {
      if (ai.timer) clearTimeout(ai.timer)
      ai.timer = setTimeout(() => {
        ai.timer = null
        void this.flushAiFallback(link).catch(() => {})
      }, wait)
      ai.timer.unref?.()
      return
    }
    ai.forwards = ai.forwards.filter((time) => now - time < 60000)
    if (ai.forwards.length >= this.aiReplyMaxPerMinute) {
      ai.pausedUntil = now + 30000
      ai.pending = []
      this.sys(link, `自动回复频率异常（60s 内 ${ai.forwards.length} 次），暂停 30s 防回环`)
      return
    }
    const batch = ai.pending.splice(0, ai.pending.length)
    ai.busy = true
    try {
      await this.aiFallback(link, batch)
      ai.lastForwardAt = Date.now()
      ai.forwards.push(ai.lastForwardAt)
    } catch (error) {
      link.ai.lastNoSessionAt = Date.now()
      this.sys(link, `转给 DSH 会话失败：${error?.message || error}`)
    } finally {
      ai.busy = false
      if (ai.pending.length && link.open) {
        if (ai.timer) clearTimeout(ai.timer)
        ai.timer = setTimeout(() => {
          ai.timer = null
          void this.flushAiFallback(link).catch(() => {})
        }, Math.max(50, this.autoDebounceOf(link.id)))
        ai.timer.unref?.()
      }
    }
  }

  poll(since, limit) {
    const from = Number(since) || 0
    const max = Math.min(Number(limit) || 500, 2000)
    const entries = []
    for (const link of this.links.values()) {
      for (const entry of link.log) {
        if (entry.q > from) entries.push(entry)
      }
    }
    entries.sort((a, b) => a.q - b.q)
    const cut = entries.slice(0, max)
    return {
      entries: cut,
      cursor: cut.length ? cut[cut.length - 1].q : from,
      links: Array.from(this.links.values()).map((link) => this.snapshot(link)),
      serial: this.serialInfo,
    }
  }

  async tail(id, pattern, timeoutMs, encoding, signal) {
    const link = this.linkOrThrow(id)
    const start = this.q
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 30000)
    const needle = String(pattern || '')
    if (!needle) throw new Error('缺少 pattern')
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('已取消')
      const matched = []
      for (const entry of link.log) {
        if (entry.q <= start) continue
        const text = decodeBytes(Buffer.from(entry.b, 'base64'), encoding)
        if (text.includes(needle)) matched.push({ q: entry.q, t: entry.t, dir: entry.d, peer: entry.p, text })
      }
      if (matched.length) return { matched: true, entries: matched }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return { matched: false, timeout: true, pattern: needle }
  }
}

/* ───────────────────────── HTTP 服务 ───────────────────────── */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function tokenOf(req, url) {
  return req.headers['x-comm-token'] || url.searchParams.get('token') || ''
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let out = 0
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return out === 0
}

/* ───────────────────────── 插件入口 ───────────────────────── */

export function apply(ctx, config) {
  const manager = new CommManager(config)
  const token = String(config?.uiToken || '').trim() || randomBytes(16).toString('hex')

  // 无规则且已启用时的智能回复（方案 A）：
  //   把收到的消息转给一个 DSH 会话，由模型用 comm_write 回复；
  //   默认自动创建/复用专用会话「dsh-comm 自动回复」，不往当前主对话里注入。
  //   没有可用会话 / agent 忙 / 超时就不回复，只记一条系统日志。
  const AI_SESSION_TITLE = 'dsh-comm 自动回复'
  const aiConfig = {
    sessionId: String(config?.aiReplySession || '').trim(),
    dedicated: config?.aiReplyDedicatedSession !== false,
    // 会话服务（list/create/rename/prompt）超时；测试里可调小，避免假服务把自动回复永久挂住。
    timeoutMs: clamp(Number(config?.aiReplyTimeoutMs) || 15000, 500, 60000),
    // 转发后多久没任何发送算一次"无响应"（见 aiReplyLivenessMs）。
    livenessMs: clamp(Number(config?.aiReplyLivenessMs) || 30000, 2000, 600000),
  }
  let sessionController = null
  ctx.inject(['sessionController'], (scope) => {
    try { sessionController = scope.sessionController || null } catch { sessionController = null }
  })

  // 给可能卡死的 DSH 会话调用加超时；超时时触发 onTimeout（如 abort prompt），
  // 保证 ai.busy 一定能在有限时间内释放，后续消息还能继续处理。
  const withTimeout = (promise, ms, label, onTimeout) => new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { onTimeout?.() } catch { /* ignore */ }
      reject(new Error(`${label}超时（${ms}ms）`))
    }, ms)
    timer.unref?.()
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })

  const guessEncoding = (bytes) => (bytes.toString('utf8').includes('\uFFFD') ? 'gbk' : 'utf-8')

  const listSessions = async () => {
    if (!sessionController || typeof sessionController.list !== 'function') return []
    const result = await withTimeout(
      sessionController.list({}, new AbortController().signal),
      aiConfig.timeoutMs,
      '列出 DSH 会话',
    )
    return Array.isArray(result?.items) ? result.items : []
  }

  // 旧行为：取最近活跃的根会话（aiReplyDedicatedSession=false 或专用会话创建失败时兜底）。
  const pickSessionId = async () => {
    if (!sessionController || typeof sessionController.list !== 'function') return ''
    if (aiConfig.sessionId) return aiConfig.sessionId
    const items = await listSessions()
    const roots = items.filter((item) => item && item.blank !== true
      && item.parentSessionId === undefined && item.origin !== 'subagent')
    const pool = roots.length ? roots : items.filter(Boolean)
    return pool.length ? String(pool[0].sessionId) : ''
  }

  // 判断某个会话 id 在当前进程里是否还活着。
  //   alive  = 列表里在，且没有被删除/归档；
  //   missing= 列表能取到、但里面没有它（被删 / 换了进程 / id 过期）；
  //   unknown= 列表调用本身失败或超时，无法下结论——此时不要贸然新建，避免重复建会话。
  const probeSession = async (id) => {
    const target = String(id || '').trim()
    if (!target) return 'missing'
    if (!(sessionController && typeof sessionController.list === 'function')) return 'unknown'
    let items
    try {
      items = await listSessions()
    } catch {
      return 'unknown'
    }
    const hit = items.find((item) => item && String(item.sessionId) === target)
    if (!hit) return 'missing'
    if (hit.deleted === true || hit.archived === true || hit.removed === true) return 'missing'
    return 'alive'
  }

  // 专用会话该建在哪个目录：取最近活跃的普通会话所在目录（有个像样的 workspace 归属）。
  // 拿不到就返回空，让 create 用默认目录。
  const pickSessionCwd = async () => {
    if (!(sessionController && typeof sessionController.list === 'function')) return ''
    try {
      const items = await listSessions()
      const rows = items
        .filter((item) => item && item.blank !== true && item.parentSessionId === undefined && item.origin !== 'subagent')
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      for (const row of rows) {
        const cwd = row?.projections?.values?.workingDirectory || row?.cwd
        if (typeof cwd === 'string' && cwd.trim()) return cwd.trim()
      }
    } catch { /* 列不出来就用默认目录 */ }
    return ''
  }

  let dedicatedSessionPromise = null
  // 自动创建/复用专用会话：
  //   1. 配置了 aiReplySession → 先确认它还在，不在就回报 customMissing 让调用方决定；
  //   2. settings 里保存过且该会话仍存在 → 复用；已不存在 → 清掉旧绑定后重建；
  //   3. 否则 sessionController.create({}) 新建一个并 rename 成「dsh-comm 自动回复」。
  // 串行化并发调用，避免两条链路同时触发时建出两个专用会话。
  const ensureDedicatedSession = async (options = {}) => {
    if (aiConfig.sessionId && !options.ignoreCustom) {
      const state = await probeSession(aiConfig.sessionId)
      if (state === 'alive' || state === 'unknown') {
        return { id: aiConfig.sessionId, mode: 'custom', created: false, probed: state }
      }
      // 配置写死的会话已经没了：退回自动专用会话，并让调用方记一条系统日志。
      return { id: '', mode: 'custom', created: false, probed: state, customMissing: true }
    }
    if (!aiConfig.dedicated) return null
    if (!(sessionController && typeof sessionController.create === 'function')) return null
    if (dedicatedSessionPromise) return dedicatedSessionPromise
    dedicatedSessionPromise = (async () => {
      const saved = String(manager.settings.aiReplySessionId || '').trim()
      if (saved) {
        const state = await probeSession(saved)
        if (state !== 'missing') return { id: saved, mode: 'dedicated', created: false, probed: state }
        // 保存的专用会话已经不存在：清掉旧绑定再重建，不然会一直往一个死 id 投递。
        manager.settings.aiReplySessionId = ''
        writeSettings(manager.settings)
      }
      // 专用会话建在用户最近工作的目录里，而不是 Host 进程的启动目录：
      // 否则它会落进 desktop profile 的 workspace，用户侧看不到，也更容易被一起归档。
      const cwd = await pickSessionCwd()
      const createWith = (options) => withTimeout(
        sessionController.create(options),
        aiConfig.timeoutMs,
        '创建专用会话',
      )
      let created
      try {
        created = await createWith(cwd ? { cwd } : {})
      } catch (error) {
        if (!cwd) throw error
        // 老版本 create 不认 cwd：退回无参创建，别让专用会话建不出来。
        created = await createWith({})
      }
      const id = String(created?.sessionId || '')
      if (!id) throw new Error('sessionController.create 未返回 sessionId')
      manager.settings.aiReplySessionId = id
      writeSettings(manager.settings)
      try {
        await withTimeout(
          sessionController.rename({ sessionId: id, title: AI_SESSION_TITLE }),
          aiConfig.timeoutMs,
          '重命名专用会话',
        )
      } catch { /* 标题改不了不影响使用 */ }
      return { id, mode: 'dedicated', created: true }
    })()
    try {
      return await dedicatedSessionPromise
    } finally {
      dedicatedSessionPromise = null
    }
  }

  // 方案 A：无规则时把消息转给 DSH 会话，由模型用 comm_write 回复。
  // 注意：DSH 的 session prompt 只能以 user 消息形式入队，所以这里尽量把
  // 去抖窗口内的多条消息合并成一条，避免每条串口数据都往对话里注入一条提示。
  const decodeBatch = (batch) => {
    const lines = []
    const seen = new Map()
    let gbk = false
    for (const item of batch) {
      const encoding = guessEncoding(item.bytes)
      if (encoding === 'gbk') gbk = true
      const raw = decodeBytes(item.bytes, encoding).trim()
      if (!raw) continue
      const text = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw
      seen.set(text, (seen.get(text) || 0) + 1)
      lines.push({ text, peer: item.peer || '' })
    }
    return { lines, gbk }
  }

  // 投递时报"会话不存在"这类错误：说明绑定已经过期，值得重建后重试一次。
  const isMissingSessionError = (error) => {
    const message = String(error?.message || error || '')
    if (!/session|会话/i.test(message)) return false
    return /(not found|not exist|不存在|missing|unknown|invalid|expired|deleted|已删除|已失效)/i.test(message)
  }

  // 会话当前是真的在跑，还是只是"还在列表里"。
  // 被归档/已删除的会话仍会出现在列表里，prompt 也照样受理，只是每轮立刻以
  // blocked 收口、不发模型请求——从外面看就是"日志写已转给，但永远没回复"。
  const sessionRunningState = async (id) => {
    try {
      const items = await listSessions()
      const hit = items.find((item) => item && String(item.sessionId) === String(id))
      if (!hit) return 'missing'
      return hit.running === true ? 'running' : 'idle'
    } catch {
      return 'unknown'
    }
  }

  const unbindSession = (link, sessionId, reason) => {
    const bound = String(manager.settings.aiReplySessionId || '').trim()
    if (bound && bound === sessionId) {
      manager.settings.aiReplySessionId = ''
      writeSettings(manager.settings)
      manager.sys(link, `专用会话 ${sessionId} ${reason}，已解除绑定；下条消息将重建新会话`)
    } else {
      manager.sys(link, `会话 ${sessionId} ${reason}；下条消息将重新选择会话`)
    }
  }

  // 投递成功 ≠ 有模型在跑。两段判定：
  //   快判（≤3s）：一次发送都没有、列表里也不在 running → 会话已死（归档/删除/换进程），
  //                立刻解除绑定，下条消息重建——这就是"会话没了却还一直投"的兜底。
  //   慢判（livenessMs）：确实在 running 但始终没有任何发送，记一次无响应；
  //                连续两次才解除绑定，避免误伤只是回答慢的会话。
  const runLivenessProbe = async (link) => {
    link.ai.probeTimer = null
    const probe = link.ai.probe
    if (!probe || !link.open) return
    if (link.tx !== probe.txAt) {
      link.ai.probe = null
      link.ai.silent = 0
      return
    }
    if (probe.phase === 'fast') {
      const state = await sessionRunningState(probe.sessionId)
      if (link.tx !== probe.txAt) {
        link.ai.probe = null
        link.ai.silent = 0
        return
      }
      if (state === 'running') {
        probe.phase = 'slow'
        link.ai.probeTimer = setTimeout(() => { void runLivenessProbe(link).catch(() => {}) }, aiConfig.livenessMs)
        link.ai.probeTimer.unref?.()
        return
      }
      link.ai.probe = null
      if (state === 'unknown') {
        // 列表都读不到，退化成慢判定，不要凭猜测拆绑定。
        link.ai.silent = (link.ai.silent || 0) + 1
        if (link.ai.silent < 2) {
          manager.sys(link, `会话 ${probe.sessionId} 状态未知且没有回复；再一次无响应就重建`)
          return
        }
        link.ai.silent = 0
        unbindSession(link, probe.sessionId, '连续无响应')
        return
      }
      link.ai.silent = 0
      unbindSession(link, probe.sessionId, state === 'missing' ? '已不存在' : '没有真正运行（可能已归档或被删除）')
      return
    }
    link.ai.probe = null
    link.ai.silent = (link.ai.silent || 0) + 1
    if (link.ai.silent < 2) {
      manager.sys(link, `会话 ${probe.sessionId} 在 ${Math.round(aiConfig.livenessMs / 1000)}s 内没有回复；再一次无响应就重建`)
      return
    }
    link.ai.silent = 0
    unbindSession(link, probe.sessionId, '连续无响应')
  }

  const armLivenessProbe = (link, sessionId) => {
    if (link.ai.probeTimer) clearTimeout(link.ai.probeTimer)
    link.ai.probe = { sessionId, txAt: link.tx, at: Date.now(), phase: 'fast' }
    link.ai.probeTimer = setTimeout(
      () => { void runLivenessProbe(link).catch(() => {}) },
      Math.min(3000, aiConfig.livenessMs),
    )
    link.ai.probeTimer.unref?.()
  }

  manager.aiFallback = async (link, batch) => {
    const { lines, gbk } = decodeBatch(batch)
    if (!lines.length) return
    const peers = Array.from(new Set(lines.map((line) => line.peer).filter(Boolean)))
    const peerText = peers.length ? peers.join(', ') : '对端'
    const unique = []
    const counts = new Map()
    for (const line of lines) {
      if (counts.has(line.text)) { counts.set(line.text, counts.get(line.text) + 1); continue }
      unique.push(line)
      counts.set(line.text, 1)
    }
    const body = unique.map((line, index) => {
      const count = counts.get(line.text)
      const suffix = count > 1 ? `（重复 ${count} 次）` : ''
      return `${index + 1}. ${line.text}${suffix}`
    }).join('\n')
    const tip = `请直接用 comm_write 工具回复（link=${link.id}${peers.length === 1 ? `，peer=${peers[0]}` : ''}${gbk ? '，对端为 GBK 编码，请传 encoding=gbk' : ''}）。只回复数据，不要解释过程。`
    const text = `[dsh-comm] 链路「${link.label}」收到来自 ${peerText} 的 ${lines.length} 条新数据：\n${body}\n\n${tip}`
    if (!(sessionController && typeof sessionController.prompt === 'function')) {
      const now = Date.now()
      if (now - (link.ai.lastNoSessionAt || 0) > 10000) {
        link.ai.lastNoSessionAt = now
        manager.sys(link, '没有可用 DSH 会话，未自动回复')
      }
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), aiConfig.timeoutMs + 1000)
    try {
      let target = null
      try {
        target = await ensureDedicatedSession()
      } catch (error) {
        manager.sys(link, `创建专用会话失败：${error?.message || error}；退回最近会话`)
        target = null
      }
      if (target && target.customMissing) {
        manager.sys(link, `指定的会话 ${aiConfig.sessionId} 已不存在，改用自动专用会话`)
        try {
          target = await ensureDedicatedSession({ ignoreCustom: true })
        } catch (error) {
          manager.sys(link, `创建专用会话失败：${error?.message || error}；退回最近会话`)
          target = null
        }
      }
      let sessionId = target ? target.id : await pickSessionId()
      if (!sessionId) {
        const now = Date.now()
        if (now - (link.ai.lastNoSessionAt || 0) > 10000) {
          link.ai.lastNoSessionAt = now
          manager.sys(link, '没有可用 DSH 会话，未自动回复')
        }
        return
      }
      const send = (id) => withTimeout(
        sessionController.prompt({
          requestId: randomBytes(12).toString('hex'),
          sessionId: id,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }, controller.signal),
        aiConfig.timeoutMs,
        '等待 DSH 会话接收',
        () => controller.abort(),
      )
      try {
        await send(sessionId)
      } catch (error) {
        // 专用会话在投递瞬间失效（被删 / 换了进程）：清掉绑定、重建，再重试一次。
        if (!(target && target.mode === 'dedicated') || !isMissingSessionError(error)) throw error
        manager.settings.aiReplySessionId = ''
        writeSettings(manager.settings)
        manager.sys(link, `专用会话 ${sessionId} 已失效（${error?.message || error}），重建后重试`)
        target = await ensureDedicatedSession()
        sessionId = target ? target.id : ''
        if (!sessionId) throw error
        await send(sessionId)
      }
      let targetLabel = ` DSH 会话 ${sessionId}`
      if (target && target.mode === 'dedicated') {
        targetLabel = `专用会话「${AI_SESSION_TITLE}」${target.created ? '（新建）' : ''} ${sessionId}`
      } else if (target && target.mode === 'custom') {
        targetLabel = `指定会话 ${sessionId}`
      }
      manager.sys(link, `已把 ${lines.length} 条消息合并转给${targetLabel}`)
      armLivenessProbe(link, sessionId)
    } catch (error) {
      manager.sys(link, `转给 DSH 会话失败：${error?.message || error}`)
    } finally {
      clearTimeout(timer)
    }
  }

  // 1) Web UI + API（可选：headless 组合没有 webServer 时跳过）
  ctx.inject(['webServer'], (scope) => {
    const web = scope.webServer
    if (!web) return

    // origin 用于 Electron dsh-app:// 等非 http(s) 页面兜底：Client 会用
    // origin + base 拼出 iframe 的绝对地址。
    const origin = (() => {
      try { return String(web.getOrigin?.() || '') } catch { return '' }
    })()

    const isLoopback = (addr) => {
      const s = String(addr || '')
      return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1' || s.startsWith('127.')
    }

    const handler = async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://comm.local')
        const path = url.pathname

        // 同源兜底：桌面端首页可能不经过 tapIndex（或 CSP 禁 inline script），
        // Client 半边拿不到 window.__DSH_COMM__ 时就到这里取 base + token。
        // 只允许本机回环访问，避免把控制 token 暴露给局域网。
        if (path === '/comm/bootstrap') {
          if (!isLoopback(req.socket?.remoteAddress)) {
            json(res, 403, { error: 'loopback only' })
            return
          }
          json(res, 200, { base: '/comm', origin, token })
          return
        }

        if (path === '/comm/ui') {
          if (!safeEqual(tokenOf(req, url), token)) {
            res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('dsh-comm: invalid token')
            return
          }
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(UI_HTML)
          return
        }

        if (!path.startsWith('/comm/api/')) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }

        if (!safeEqual(tokenOf(req, url), token)) {
          json(res, 401, { error: 'invalid token' })
          return
        }

        if (path === '/comm/api/state' && req.method === 'GET') {
          json(res, 200, manager.state())
          return
        }
        if (path === '/comm/api/ports' && req.method === 'GET') {
          json(res, 200, await manager.ports(url.searchParams.get('force') === '1'))
          return
        }
        if (path === '/comm/api/poll' && req.method === 'GET') {
          json(res, 200, manager.poll(url.searchParams.get('since'), url.searchParams.get('limit')))
          return
        }
        if (path === '/comm/api/serial' && req.method === 'GET') {
          const link = String(url.searchParams.get('link') || '')
          const info = manager.linkOrThrow(link)
          if (info.type !== 'serial') throw new Error('只有串口链路支持信号控制')
          json(res, 200, {
            link: manager.snapshot(info),
            config: info.config,
            signals: manager.currentSignals(info),
            portInfo: info.portInfo || null,
            defaults: manager.serialDefaults(info.config?.path),
          })
          return
        }
        if (path === '/comm/api/timer' && req.method === 'GET') {
          json(res, 200, manager.getTimer(String(url.searchParams.get('link') || '')))
          return
        }
        if (path === '/comm/api/rules' && req.method === 'GET') {
          const link = String(url.searchParams.get('link') || '')
          json(res, 200, {
            link,
            enabled: manager.autoEnabled(link),
            rules: manager.rulesOf(link),
            debounceMs: manager.autoDebounceOf(link),
            aiSession: Boolean(sessionController && typeof sessionController.prompt === 'function'),
            aiSessionId: aiConfig.sessionId || String(manager.settings.aiReplySessionId || ''),
            aiDedicated: aiConfig.dedicated,
            aiSessionTitle: AI_SESSION_TITLE,
          })
          return
        }

        if (req.method !== 'POST') {
          json(res, 405, { error: 'method not allowed' })
          return
        }
        const body = JSON.parse(await readBody(req) || '{}')
        if (path === '/comm/api/open') {
          const type = String(body.type || '')
          const opts = body.options || body
          json(res, 200, { ok: true, link: await manager.open(type, opts), state: manager.state() })
          return
        }
        if (path === '/comm/api/close') {
          const state = await manager.close(String(body.link || ''))
          json(res, 200, { ok: true, state })
          return
        }
        if (path === '/comm/api/clear') {
          // 真正清 Host 侧日志：不清的话重进面板会把历史重新拉回来。
          const state = manager.clear(body.link ? String(body.link) : '')
          json(res, 200, { ok: true, state })
          return
        }
        if (path === '/comm/api/rules') {
          const rules = manager.setRules(String(body.link || ''), body.rules)
          json(res, 200, { ok: true, rules })
          return
        }
        if (path === '/comm/api/auto') {
          const saved = manager.setAuto(String(body.link || ''), Boolean(body.enabled), body.debounceMs)
          json(res, 200, { ok: true, enabled: saved.enabled, debounceMs: saved.debounceMs })
          return
        }
        if (path === '/comm/api/serial') {
          const result = await manager.serialAction(String(body.link || ''), body.action, body)
          json(res, 200, { ok: true, ...result })
          return
        }
        if (path === '/comm/api/timer') {
          const result = await manager.timerAction(String(body.link || ''), body.action, body)
          json(res, 200, { ok: true, ...result })
          return
        }
        if (path === '/comm/api/write') {
          let bytes
          if (body.hex !== undefined && body.hex !== '') {
            const parsed = parseHex(body.hex)
            if (parsed.error) { json(res, 400, { error: parsed.error }); return }
            bytes = parsed.bytes
          } else {
            bytes = encodeText(String(body.text ?? ''), body.encoding)
          }
          const wantWait = body.expect !== undefined && body.expect !== null && String(body.expect) !== ''
          const written = wantWait
            ? await manager.writeAndWait(String(body.link || ''), bytes, {
              peer: body.peer,
              hex: Boolean(body.hex),
              expect: body.expect,
              expectMode: body.expectMode,
              expectTimeoutMs: body.expectTimeoutMs,
              encoding: body.encoding,
            })
            : await manager.write(String(body.link || ''), bytes, body.peer, { hex: Boolean(body.hex) })
          json(res, 200, { ok: true, ...written })
          return
        }
        if (path === '/comm/api/read') {
          json(res, 200, manager.read(String(body.link || ''), body))
          return
        }
        json(res, 404, { error: 'not found' })
      } catch (error) {
        json(res, 400, { error: String(error?.message || error) })
      }
    }

    const offRoute = web.register({ kind: 'prefix', path: '/comm', handler })

    // 2) 向 DSH index 注入本次进程的 base + token，供 Client 半边读取。
    //    这只是快路径；拿不到时 Client 会退回 /comm/bootstrap。
    const payload = JSON.stringify({ base: '/comm', origin, token })
    const snippet = `<script>window.__DSH_COMM__=${payload};</script>`
    const offTap = typeof web.tapIndex === 'function'
      ? web.tapIndex((html) => {
          if (typeof html !== 'string' || !html) return html
          if (html.includes('window.__DSH_COMM__')) return html
          return html.includes('</head>') ? html.replace('</head>', `${snippet}</head>`) : `${snippet}${html}`
        })
      : () => {}

    scope.effect(() => () => {
      try { offRoute?.() } catch { /* ignore */ }
      try { offTap?.() } catch { /* ignore */ }
    }, 'dsh-comm: web routes')
  })

  // 3) 模型工具
  const okRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  ctx.tools.register(defineTool({
    name: 'comm_list',
    description: 'List communication links (serial/TCP/UDP) managed by dsh-comm, including open state, peers, and RX/TX byte counts.',
    parameters: {},
    output: { schema: { type: 'json' }, render: okRender },
    timeoutMs: 10000,
    async execute() {
      return { ...manager.state(), serial: await manager.ports() }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'comm_open',
    description: 'Open a communication link. type=serial(path,baudRate,dataBits,parity,stopBits,flowControl,dtr,rts,autoReconnect) | tcpServer(host,port) | tcpClient(host,port) | udp(localHost,localPort,remoteHost,remotePort). Serial defaults are persisted per port; omitted serial parameters reuse last-used values.',
    parameters: {
      type: { type: 'string', required: true, enum: ['serial', 'tcpServer', 'tcpClient', 'udp'], description: 'Link type' },
      path: { type: 'string', description: 'Serial port path, e.g. COM21 or /dev/ttyUSB0' },
      baudRate: { type: 'integer', description: 'Serial baud rate, default 115200' },
      dataBits: { type: 'integer', enum: [5, 6, 7, 8], description: 'Serial data bits, default 8' },
      parity: { type: 'string', enum: ['none', 'even', 'odd', 'mark', 'space'], description: 'Serial parity, default none (8N1 = none)' },
      stopBits: { type: 'number', enum: [1, 1.5, 2], description: 'Serial stop bits, default 1' },
      flowControl: { type: 'string', enum: ['none', 'rtscts', 'xonxoff'], description: 'Serial flow control, default none. rtscts = RTS/CTS hardware handshake.' },
      dtr: { type: 'boolean', description: 'Initial DTR level, default true (many USB modules need DTR high to open)' },
      rts: { type: 'boolean', description: 'Initial RTS level, default true (ignored with rtscts handshake)' },
      autoReconnect: { type: 'boolean', description: 'Auto reopen on unplug/replug, default true' },
      host: { type: 'string', description: 'Bind host for tcpServer, remote host for tcpClient' },
      port: { type: 'integer', description: 'TCP port' },
      localHost: { type: 'string', description: 'UDP local bind address, default 0.0.0.0' },
      localPort: { type: 'integer', description: 'UDP local port' },
      remoteHost: { type: 'string', description: 'UDP remote host' },
      remotePort: { type: 'integer', description: 'UDP remote port' },
    },
    output: { schema: { type: 'json' }, render: okRender },
    timeoutMs: 20000,
    async execute(args) {
      return { ok: true, link: await manager.open(args.type, args), state: manager.state() }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'comm_serial',
    description: 'Control a serial link at runtime: read or set DTR/RTS, pulse a line (e.g. reset a board via DTR), reconfigure baud/dataBits/parity/stopBits/flowControl, or force a reconnect. action=signals|set|pulse|configure|reconnect.',
    parameters: {
      link: { type: 'string', required: true, description: 'Serial link id from comm_list' },
      action: { type: 'string', required: true, enum: ['signals', 'set', 'pulse', 'configure', 'reconnect'], description: 'What to do' },
      dtr: { type: 'boolean', description: 'set: target DTR level' },
      rts: { type: 'boolean', description: 'set: target RTS level' },
      line: { type: 'string', enum: ['dtr', 'rts'], description: 'pulse: which line to pulse, default dtr' },
      ms: { type: 'integer', description: 'pulse: duration in ms, default 100, max 5000' },
      level: { type: 'boolean', description: 'pulse: level during the pulse (omitted = invert current, then restore)' },
      baudRate: { type: 'integer', description: 'configure: new baud rate' },
      dataBits: { type: 'integer', enum: [5, 6, 7, 8], description: 'configure: new data bits' },
      parity: { type: 'string', enum: ['none', 'even', 'odd', 'mark', 'space'], description: 'configure: new parity' },
      stopBits: { type: 'number', enum: [1, 1.5, 2], description: 'configure: new stop bits' },
      flowControl: { type: 'string', enum: ['none', 'rtscts', 'xonxoff'], description: 'configure: new flow control' },
      autoReconnect: { type: 'boolean', description: 'configure: toggle auto reconnect' },
    },
    output: { schema: { type: 'json' }, render: okRender },
    timeoutMs: 20000,
    async execute(args) {
      return { ok: true, ...await manager.serialAction(args.link, args.action, args) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'comm_timer',
    description: 'Host-side timed/sequence sending that keeps running while the panel is closed. action=start|stop|save|status. Periodic: {kind:"periodic", intervalMs, payload:{text,encoding} or {hex}, repeat:0=forever}. Sequence: {kind:"sequence", steps:[{delayMs,payload:{text|hex,encoding}}], loop:true, repeat:0=forever}.',
    parameters: {
      link: { type: 'string', required: true, description: 'Link id from comm_list' },
      action: { type: 'string', required: true, enum: ['start', 'stop', 'save', 'status'], description: 'start = save + run, stop = stop runtime (definition kept), save = persist only, status = read' },
      kind: { type: 'string', enum: ['periodic', 'sequence'], description: 'periodic (default) or sequence' },
      intervalMs: { type: 'integer', description: 'periodic: interval in ms (min 10)' },
      text: { type: 'string', description: 'periodic payload as text (appended with encoding)' },
      hex: { type: 'string', description: 'periodic payload as hex bytes' },
      encoding: { type: 'string', description: 'Text encoding for text payloads, default utf-8' },
      repeat: { type: 'integer', description: '0 = forever (default); N = stop after N sends/passes' },
      steps: {
        type: 'array',
        description: 'sequence: ordered steps. Each step waits delayMs then sends its payload.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            delayMs: { type: 'integer', description: 'Wait before sending this step, default 0' },
            text: { type: 'string', description: 'Text payload' },
            hex: { type: 'string', description: 'Hex payload (takes precedence over text)' },
            encoding: { type: 'string', description: 'Text encoding, default utf-8' },
          },
        },
      },
      loop: { type: 'boolean', description: 'sequence: loop the whole sequence (default true)' },
      autostart: { type: 'boolean', description: 'Run again automatically when the link opens next time' },
    },
    output: { schema: { type: 'json' }, render: okRender },
    timeoutMs: 15000,
    async execute(args) {
      let spec
      if (args.action === 'start' || args.action === 'save') {
        if (args.kind === 'sequence') {
          spec = { kind: 'sequence', steps: Array.isArray(args.steps) ? args.steps : [], loop: args.loop !== false, repeat: args.repeat }
        } else {
          spec = {
            kind: 'periodic',
            intervalMs: args.intervalMs,
            repeat: args.repeat,
            payload: args.hex ? { hex: args.hex } : { text: String(args.text ?? ''), encoding: args.encoding },
          }
        }
      }
      return { ok: true, ...await manager.timerAction(args.link, args.action, { spec, autostart: args.autostart }) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'comm_close',
    description: 'Close one communication link by id.',
    parameters: { link: { type: 'string', required: true, description: 'Link id from comm_list' } },
    output: { schema: { type: 'json' }, render: okRender },
    timeoutMs: 15000,
    async execute(args) {
      return { ok: true, state: await manager.close(args.link) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'comm_peers',
    description: 'List connected clients of a TCP server link.',
    parameters: { link: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: okRender },
    timeoutMs: 10000,
    async execute(args) {
      return manager.peers(args.link)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'comm_read',
    description: 'Read buffered bytes from a link after a cursor. Returns both decoded text and uppercase hex for each entry.',
    parameters: {
      link: { type: 'string', required: true, description: 'Link id' },
      since: { type: 'integer', description: 'Only entries with q greater than this cursor' },
      limit: { type: 'integer', description: 'Max entries, default 200' },
      encoding: { type: 'string', description: 'Text encoding, default utf-8' },
      format: { type: 'string', enum: ['text', 'hex'], description: 'Preferred format' },
    },
    output: { schema: { type: 'json' }, render: okRender },
    timeoutMs: 10000,
    async execute(args) {
      return manager.read(args.link, args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'comm_write',
    description: 'Send bytes to a link. Provide either text (+encoding) or hex. For a TCP server, peer selects one client; omit it to broadcast. Pass expect to also wait for a response match in the same round trip (low-latency request/response, e.g. read a register right after writing it); returns matched/waitedMs/entries.',
    parameters: {
      link: { type: 'string', required: true, description: 'Link id' },
      text: { type: 'string', description: 'Text to send' },
      hex: { type: 'string', description: 'Hex bytes to send, e.g. AA 55 01' },
      encoding: { type: 'string', description: 'Encoding for text, default utf-8' },
      peer: { type: 'string', description: 'Optional TCP server client, e.g. 192.168.1.5:52341' },
      expect: { type: 'string', description: 'Wait until a received entry contains this text (or matches expectMode=regex) before returning' },
      expectMode: { type: 'string', enum: ['contains', 'regex'], description: 'Matching mode for expect, default contains' },
      expectTimeoutMs: { type: 'integer', description: 'Max wait for expect, default 2000, max 60000' },
    },
    output: { schema: { type: 'json' }, render: okRender },
    timeoutMs: 15000,
    async execute(args) {
      let bytes
      if (args.hex) {
        const parsed = parseHex(args.hex)
        if (parsed.error) throw new Error(parsed.error)
        bytes = parsed.bytes
      } else {
        bytes = encodeText(String(args.text ?? ''), args.encoding)
      }
      if (args.expect !== undefined && args.expect !== null && String(args.expect) !== '') {
        return { ok: true, ...await manager.writeAndWait(args.link, bytes, { ...args, hex: Boolean(args.hex) }) }
      }
      return { ok: true, ...await manager.write(args.link, bytes, args.peer, { hex: Boolean(args.hex) }) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'comm_tail',
    description: 'Wait until a link receives a line containing pattern (or timeout). Useful before analyzing device output.',
    parameters: {
      link: { type: 'string', required: true },
      pattern: { type: 'string', required: true, description: 'Substring to wait for' },
      timeoutMs: { type: 'integer', description: 'Default 30000' },
      encoding: { type: 'string', description: 'Text encoding, default utf-8' },
    },
    output: { schema: { type: 'json' }, render: okRender },
    timeoutMs: 60000,
    async execute(args, exec) {
      return manager.tail(args.link, args.pattern, args.timeoutMs, args.encoding, exec.signal)
    },
  }))

  ctx.effect(() => () => {
    void manager.closeAll()
  }, 'dsh-comm: dispose links')
}
