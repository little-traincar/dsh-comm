// dsh-comm — Host 半边
//
// 职责：
//   1. 链路管理：串口 / TCP 服务端 / TCP 客户端 / UDP
//   2. 模型工具：comm_list / comm_open / comm_close / comm_read / comm_write / comm_peers / comm_tail
//   3. 内嵌 UI：在 webServer 上挂 /comm 前缀（页面 + 轮询 API），并向 DSH index 注入
//      window.__DSH_COMM__ = { base, token }，供 Client 半边的 iframe 使用。
//
// 依赖方向：浏览器只拿 HTTP 轮询，不直接碰 socket；链路状态全部在 Host。

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import net from 'node:net'
import dgram from 'node:dgram'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import iconv from 'iconv-lite'
import { listSerialPorts, openSerialBridge, serialSupported } from './serial-windows.js'

export const name = 'dsh-comm'
export const inject = ['tools']

export const Config = Schema.object({
  maxLogEntries: Schema.number().default(2000),
  maxReadEntries: Schema.number().default(200),
  uiToken: Schema.string().default(''),
})

const UI_HTML = readFileSync(new URL('./ui.html', import.meta.url), 'utf8')
const MAX_BODY = 1 << 20

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

/* ───────────────────────── 串口桥（Windows PowerShell） ───────────────────────── */

/* ───────────────────────── LinkManager ───────────────────────── */

class CommManager {
  constructor(config) {
    this.config = config || {}
    this.maxLogEntries = Math.max(100, Number(config?.maxLogEntries) || 2000)
    this.maxReadEntries = Math.max(1, Number(config?.maxReadEntries) || 200)
    this.links = new Map()
    this.q = 0
    this.serialInfo = { available: false, error: null, checked: false }
    this.portsCache = { at: 0, value: null }
  }

  newLink(type, id, label, linkConfig) {
    const existing = this.links.get(id)
    if (existing && existing.open) throw new Error(`链路已存在：${id}`)
    if (existing) this.links.delete(id)
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
      error: null,
      handle: null,
      createdAt: Date.now(),
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
    if (link.log.length > this.maxLogEntries) link.log.splice(0, link.log.length - this.maxLogEntries)
    if (direction === 'rx') link.rx += bytes.length
    else if (direction === 'tx') link.tx += bytes.length
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
      createdAt: link.createdAt,
    }
  }

  state() {
    return {
      links: Array.from(this.links.values()).map((link) => this.snapshot(link)),
      serial: this.serialInfo,
    }
  }

  async ports(force) {
    // 枚举串口要 spawn 一次 PowerShell（约 1s），短时缓存，避免轮询/列表把 CPU 拖满。
    const now = Date.now()
    if (!force && this.portsCache.value && now - this.portsCache.at < 30000) return this.portsCache.value
    const result = await listSerialPorts()
    this.serialInfo = { available: result.available, error: result.error || null, checked: true }
    this.portsCache = { at: now, value: { ...result } }
    return { ...result }
  }

  async open(type, opts) {
    const options = opts || {}
    if (type === 'serial') return this.openSerial(options)
    if (type === 'tcpServer') return this.openTcpServer(options)
    if (type === 'tcpClient') return this.openTcpClient(options)
    if (type === 'udp') return this.openUdp(options)
    throw new Error(`不支持的链路类型：${type}`)
  }

  async openSerial(options) {
    const path = String(options.path || '').trim()
    if (!path) throw new Error('缺少串口路径（path）')
    if (!serialSupported()) throw new Error('v1 的串口桥只支持 Windows（PowerShell 5.1+）')
    const baudRate = Number(options.baudRate) || 115200
    const id = `serial:${path}`
    const link = this.newLink('serial', id, `串口 ${path}`, {
      path,
      baudRate,
      dataBits: Number(options.dataBits) || 8,
      stopBits: Number(options.stopBits) || 1,
      parity: options.parity || 'none',
    })
    const bridge = openSerialBridge({
      path,
      baudRate,
      dataBits: Number(options.dataBits) || 8,
      stopBits: Number(options.stopBits) || 1,
      parity: options.parity || 'none',
    })
    link.handle = bridge
    bridge.on('data', (data) => this.push(link, 'rx', '', data))
    bridge.on('error', (error) => {
      link.error = String(error?.message || error)
      this.sys(link, `错误：${link.error}`)
    })
    bridge.on('close', () => {
      if (!link.open) return
      link.open = false
      this.sys(link, '串口已关闭')
    })
    try {
      await bridge.open()
    } catch (error) {
      this.links.delete(id)
      try { await bridge.close() } catch { /* ignore */ }
      throw error
    }
    link.open = true
    this.sys(link, `已打开 ${path} @ ${baudRate} 8N1`)
    return this.snapshot(link)
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

  async close(id) {
    const link = this.linkOrThrow(id)
    const handle = link.handle
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
  }

  async write(id, bytes, peer, meta) {
    const link = this.linkOrThrow(id)
    if (!link.open) throw new Error(`链路未打开：${id}`)
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    const mark = (entry) => {
      if (entry && meta?.hex) entry.x = 1
      return entry
    }
    if (link.type === 'serial') {
      await link.handle.write(buf)
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
      this.linkOrThrow(id).log.length = 0
    } else {
      for (const link of this.links.values()) link.log.length = 0
    }
    return this.state()
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
          json(res, 200, await manager.ports())
          return
        }
        if (path === '/comm/api/poll' && req.method === 'GET') {
          json(res, 200, manager.poll(url.searchParams.get('since'), url.searchParams.get('limit')))
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
        if (path === '/comm/api/write') {
          let bytes
          if (body.hex !== undefined && body.hex !== '') {
            const parsed = parseHex(body.hex)
            if (parsed.error) { json(res, 400, { error: parsed.error }); return }
            bytes = parsed.bytes
          } else {
            bytes = encodeText(String(body.text ?? ''), body.encoding)
          }
          json(res, 200, { ok: true, ...await manager.write(String(body.link || ''), bytes, body.peer, { hex: Boolean(body.hex) }) })
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
    description: 'Open a communication link. type=serial(path,baudRate) | tcpServer(host,port) | tcpClient(host,port) | udp(localHost,localPort,remoteHost,remotePort).',
    parameters: {
      type: { type: 'string', required: true, enum: ['serial', 'tcpServer', 'tcpClient', 'udp'], description: 'Link type' },
      path: { type: 'string', description: 'Serial port path, e.g. COM21 or /dev/ttyUSB0' },
      baudRate: { type: 'integer', description: 'Serial baud rate, default 115200' },
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
    description: 'Send bytes to a link. Provide either text (+encoding) or hex. For a TCP server, peer selects one client; omit it to broadcast.',
    parameters: {
      link: { type: 'string', required: true, description: 'Link id' },
      text: { type: 'string', description: 'Text to send' },
      hex: { type: 'string', description: 'Hex bytes to send, e.g. AA 55 01' },
      encoding: { type: 'string', description: 'Encoding for text, default utf-8' },
      peer: { type: 'string', description: 'Optional TCP server client, e.g. 192.168.1.5:52341' },
    },
    output: { schema: { type: 'json' }, render: okRender },
    timeoutMs: 10000,
    async execute(args) {
      let bytes
      if (args.hex) {
        const parsed = parseHex(args.hex)
        if (parsed.error) throw new Error(parsed.error)
        bytes = parsed.bytes
      } else {
        bytes = encodeText(String(args.text ?? ''), args.encoding)
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
