// UI feature self-test: serial params, signals, host-side timer, buffer stats, auto-reply debounce.
// Uses jsdom + a local fake Host (no real DSH required).
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { JSDOM, VirtualConsole } from 'jsdom'

const UI_HTML = readFileSync(new URL('../lib/ui.html', import.meta.url), 'utf8')
const TOKEN = 'test-token'

/* ── fake Host ── */
const calls = { timer: [], auto: [], serial: [], open: [], write: [] }
const state = {
  links: new Map(),
  rules: [],
  enabled: false,
  debounceMs: 300,
  timer: null,
  saved: null,
}

const linkOf = () => ({
  id: 'tcpServer:127.0.0.1:8080',
  type: 'tcpServer',
  label: 'TCP 服务 127.0.0.1:8080',
  config: { host: '127.0.0.1', port: 8080 },
  open: true,
  peers: [],
  rx: 0,
  tx: 0,
  backlog: 2,
  backlogBytes: 1234,
  dropped: 3,
  droppedBytes: 99,
  timer: state.timer,
})

const serialLinkOf = () => ({
  id: 'serial:COM3',
  type: 'serial',
  label: '串口 COM3 @ 9600',
  config: { path: 'COM3', baudRate: 9600, dataBits: 7, parity: 'even', stopBits: 2, flowControl: 'none', dtr: true, rts: false },
  open: true,
  peers: [],
  rx: 0,
  tx: 0,
  backlog: 0,
  backlogBytes: 0,
  dropped: 0,
  droppedBytes: 0,
  timer: state.timer,
  serial: {
    signals: { dtr: true, rts: false },
    port: 'COM3',
    portInfo: { path: 'COM3', name: 'CH340', vid: '1A86', pid: '7523', serial: 'X' },
    flowControl: 'none',
    autoReconnect: true,
    reconnecting: false,
    reconnectAttempts: 0,
  },
})

function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const path = url.pathname
  const body = req.method === 'POST' ? await readBody(req) : {}

  if (path === '/comm/ui') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(UI_HTML)
    return
  }
  if (!path.startsWith('/comm/api/')) { res.writeHead(404); res.end('not found'); return }
  if (url.searchParams.get('token') !== TOKEN) { json(res, 401, { error: 'invalid token' }); return }

  if (path === '/comm/api/poll') {
    json(res, 200, {
      entries: [],
      cursor: 0,
      links: Array.from(state.links.values()).map((link) => ({ ...link, timer: state.timer })),
      serial: { available: true, error: null, ports: [] },
    })
    return
  }
  if (path === '/comm/api/ports') {
    json(res, 200, {
      available: true,
      error: null,
      ports: [{
        path: 'COM3',
        name: 'USB-SERIAL CH340 (COM3)',
        vid: '1A86',
        pid: '7523',
        serial: 'CH340',
        defaults: { baudRate: 9600, dataBits: 7, parity: 'even', stopBits: 2, flowControl: 'none', dtr: true, rts: false, autoReconnect: true },
      }],
    })
    return
  }
  if (path === '/comm/api/serial' && req.method === 'GET') {
    const serial = state.links.get('serial:COM3') || serialLinkOf()
    json(res, 200, { link: serial, config: serial.config, signals: { dtr: true, rts: false }, portInfo: serial.serial.portInfo, defaults: null })
    return
  }
  if (path === '/comm/api/serial') {
    calls.serial.push(body)
    json(res, 200, { ok: true, signals: { dtr: true, rts: Boolean(body.rts) } })
    return
  }
  if (path === '/comm/api/timer' && req.method === 'GET') {
    const active = state.links.get(url.searchParams.get('link') || '') || linkOf()
    json(res, 200, { link: active, timer: state.timer, saved: state.saved })
    return
  }
  if (path === '/comm/api/timer') {
    calls.timer.push(body)
    if (body.action === 'start') state.timer = { running: true, kind: body.spec && body.spec.kind, sent: 0, startedAt: 1, nextAt: 2, lastError: null }
    if (body.action === 'stop') state.timer = null
    if (body.action === 'save') state.saved = { spec: body.spec, autostart: Boolean(body.autostart) }
    if (body.action === 'delete') state.saved = null
    json(res, 200, { ok: true, timer: state.timer, saved: state.saved })
    return
  }
  if (path === '/comm/api/rules' && req.method === 'GET') {
    json(res, 200, {
      link: url.searchParams.get('link') || '',
      enabled: state.enabled,
      rules: state.rules,
      debounceMs: state.debounceMs,
      aiSession: true,
      aiSessionId: 'session-x',
      aiDedicated: true,
      aiSessionTitle: 'dsh-comm 自动回复',
    })
    return
  }
  if (path === '/comm/api/rules') {
    state.rules = Array.isArray(body.rules) ? body.rules : []
    json(res, 200, { ok: true, rules: state.rules })
    return
  }
  if (path === '/comm/api/auto') {
    calls.auto.push(body)
    if (typeof body.enabled === 'boolean') state.enabled = body.enabled
    if (Number.isFinite(Number(body.debounceMs))) state.debounceMs = Number(body.debounceMs)
    json(res, 200, { ok: true, enabled: state.enabled, debounceMs: state.debounceMs })
    return
  }
  if (path === '/comm/api/open') {
    calls.open.push(body)
    const link = body.type === 'serial' ? serialLinkOf() : linkOf()
    state.links.set(link.id, link)
    json(res, 200, { ok: true, link, state: {} })
    return
  }
  if (path === '/comm/api/close') {
    state.links.delete(String(body.link || ''))
    json(res, 200, { ok: true, state: {} })
    return
  }
  if (path === '/comm/api/write') {
    calls.write.push(body)
    json(res, 200, { ok: true })
    return
  }
  if (path === '/comm/api/clear') { json(res, 200, { ok: true, state: {} }); return }
  json(res, 404, { error: 'not found: ' + path })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${server.address().port}`

/* ── jsdom page ── */
const errors = []
const vc = new VirtualConsole()
vc.on('jsdomError', (e) => errors.push(e))
vc.on('error', (...args) => errors.push(new Error(args.join(' '))))
vc.on('log', (...args) => console.log('PAGE:', ...args))

const dom = await JSDOM.fromURL(`${BASE}/comm/ui?token=${TOKEN}`, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.fetch = (input, init) => fetch(new URL(input, BASE), init)
    window.TextDecoder = TextDecoder
    window.TextEncoder = TextEncoder
  },
})
const doc = dom.window.document
const $ = (id) => doc.getElementById(id)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const wait = async (fn, ms, label) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await fn()) return true } catch { /* retry */ }
    await sleep(40)
  }
  throw new Error('timeout: ' + label)
}
const change = (el) => el.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
const assert = (cond, message) => { if (!cond) throw new Error('assert failed: ' + message) }

await wait(() => $('headText') && $('headText').textContent.length > 0, 8000, 'page boot')
console.log('boot OK:', $('headText').textContent)

/* A. 串口参数 + 帧格式 */
for (const id of ['serialDataBits', 'serialParity', 'serialStopBits', 'serialFlow', 'serialDtr', 'serialRts', 'serialAutoReconnect', 'serialFrame']) {
  assert($(id), 'missing #' + id)
}
assert($('serialFrame').textContent === '8N1', 'serialFrame default 8N1, got ' + $('serialFrame').textContent)
$('serialDataBits').value = '7'; change($('serialDataBits'))
$('serialParity').value = 'even'; change($('serialParity'))
$('serialStopBits').value = '1'; change($('serialStopBits'))
assert($('serialFrame').textContent === '7E1', 'serialFrame 7E1, got ' + $('serialFrame').textContent)
$('serialFlow').value = 'rtscts'; change($('serialFlow'))
assert($('serialFrame').textContent === '7E1+CTS', 'serialFrame 7E1+CTS, got ' + $('serialFrame').textContent)
console.log('A serial frame:', $('serialFrame').textContent, '| dataBits', $('serialDataBits').value,
  'parity', $('serialParity').value, 'stop', $('serialStopBits').value, 'flow', $('serialFlow').value,
  'dtr', $('serialDtr').checked, 'rts', $('serialRts').checked, 'autoReconnect', $('serialAutoReconnect').checked)

/* A2. 串口链路：端口默认值预填 → open 带全参数 → 信号按钮可见并可切换 */
await wait(() => $('serialPort').value === 'COM3', 5000, 'ports loaded')
$('serialPort').value = 'COM3'
change($('serialPort'))
assert($('serialFrame').textContent === '7E2', 'port defaults prefill 7E2, got ' + $('serialFrame').textContent)
click($('serialBtn'))
await wait(() => calls.open.some((c) => c.type === 'serial'), 5000, 'serial open')
const serialOpen = calls.open.find((c) => c.type === 'serial')
const serialOpts = serialOpen.options
assert(serialOpts.path === 'COM3', 'serial path')
assert(serialOpts.baudRate === 9600, 'baudRate from defaults, got ' + serialOpts.baudRate)
assert(serialOpts.dataBits === 7 && serialOpts.parity === 'even' && serialOpts.stopBits === 2, 'frame from defaults')
assert(serialOpts.flowControl === 'none' && serialOpts.dtr === true && serialOpts.rts === false && serialOpts.autoReconnect === true, 'flow/dtr/rts/autoReconnect fields')
await wait(() => $('serialSignals').hidden === false, 5000, 'serialSignals visible on serial link')
assert($('sigDtr').classList.contains('active') === true, 'DTR active from host signals')
assert($('sigRts').classList.contains('active') === false, 'RTS inactive from host signals')
click($('sigDtr'))
await wait(() => calls.serial.some((c) => c.action === 'set' && c.dtr === false), 4000, 'DTR set POST')
console.log('A2 serial link: options =', JSON.stringify(serialOpts), '| signals visible, DTR set posted')
await wait(() => { try { return Boolean(dom.window.localStorage.getItem('dsh-comm.settings.v1')) } catch { return false } }, 4000, 'ui settings saved')
const savedSettings = JSON.parse(dom.window.localStorage.getItem('dsh-comm.settings.v1'))
assert(savedSettings.cfg.serial.dataBits === '7' && savedSettings.cfg.serial.parity === 'even', 'serial params persisted')
assert(savedSettings.cfg.serial.dtr === true && savedSettings.cfg.serial.autoReconnect === true, 'serial flags persisted')

/* B. 非串口链路 → #serialSignals hidden */
click(doc.querySelector('#modeTabs button[data-mode="tcpServer"]'))
await wait(() => $('serialSignals').hidden === true, 4000, 'serialSignals hidden when active link is not serial')
assert($('cfgTcpServer').classList.contains('active'), 'tcpServer cfg active')
click($('tsBtn'))
await wait(() => calls.open.some((c) => c.type === 'tcpServer') && $('headText').textContent.indexOf('已打开') !== -1, 5000, 'open tcpServer link')
assert(calls.open.filter((c) => c.type === 'tcpServer').length === 1, 'open body should be tcpServer')
assert($('serialSignals').hidden === true, 'serialSignals hidden on tcpServer link')
console.log('B non-serial link:', $('headText').textContent, '| serialSignals hidden =', $('serialSignals').hidden)

/* D. 缓冲 / 丢弃统计 */
await wait(() => $('bufPct').textContent.indexOf('缓冲') !== -1, 4000, 'bufPct text')
assert($('bufPct').textContent.indexOf('丢弃') !== -1, 'bufPct should contain 丢弃')
assert($('bufPct').title.indexOf('待读队列') !== -1, 'bufPct title detail')
console.log('D bufPct:', JSON.stringify($('bufPct').textContent), '| title:', JSON.stringify($('bufPct').title))

/* C. 定时模态：周期 100ms + 载荷 → start POST */
click($('timerCfg'))
await wait(() => $('timerBackdrop').classList.contains('show'), 4000, 'timer modal opens')
assert($('timerKindPeriodic').checked, 'periodic kind default')
$('timerInterval').value = '100'
$('timerPayload').value = 'hello'
change($('timerPayloadMode'))
click($('timerStart'))
await wait(() => calls.timer.length > 0, 4000, 'timer start POST')
const startCall = calls.timer[calls.timer.length - 1]
assert(startCall.action === 'start', 'action start, got ' + startCall.action)
assert(startCall.spec.kind === 'periodic', 'kind periodic')
assert(startCall.spec.intervalMs === 100, 'intervalMs 100, got ' + startCall.spec.intervalMs)
assert(startCall.spec.payload.text === 'hello', 'payload text hello')
assert(startCall.spec.payload.encoding === 'gbk', 'payload encoding gbk, got ' + startCall.spec.payload.encoding)
await wait(() => !$('timerBackdrop').classList.contains('show'), 3000, 'modal closes after start')
console.log('C timer modal start:', JSON.stringify(startCall))

/* C. 发送栏「定时」→ Host start，取消 → stop */
$('sendInput').value = 'PING'
$('periodMs').value = '250'
change($('periodMs'))
$('periodic').checked = true
change($('periodic'))
await wait(() => calls.timer.some((c) => c.action === 'start' && c.spec && c.spec.intervalMs === 250), 4000, 'periodic start with 250ms')
const periodicStart = calls.timer.filter((c) => c.action === 'start').pop()
assert(periodicStart.spec.payload.text === 'PING\r\n', 'eol appended, got ' + JSON.stringify(periodicStart.spec.payload.text))
$('periodic').checked = false
change($('periodic'))
await wait(() => calls.timer.some((c) => c.action === 'stop'), 4000, 'periodic stop')
console.log('C periodic toggle: start intervalMs=', periodicStart.spec.intervalMs,
  'payload=', JSON.stringify(periodicStart.spec.payload.text), '| stop posted =', calls.timer.some((c) => c.action === 'stop'))

/* E. 自动回复防抖 */
click($('autoBtn'))
await wait(() => $('autoPanel').hidden === false, 4000, 'auto panel opens')
// 等 loadAutoRules 真正完成（aiState 文案由它写入），避免它随后覆盖我们填的值
await wait(() => $('autoAiState').textContent.length > 0, 4000, 'auto rules loaded')
assert($('autoDebounce').value === '300', 'debounce loaded from host, got ' + $('autoDebounce').value)
assert($('autoDebounce').min === '0' && $('autoDebounce').max === '5000', 'debounce range')
$('autoDebounce').value = '500'
change($('autoDebounce'))
await wait(() => calls.auto.some((c) => Number(c.debounceMs) === 500), 4000, 'debounce POST')
assert($('autoDebounce').value === '500', 'debounce input kept 500, got ' + $('autoDebounce').value)
$('autoEnable').checked = true
change($('autoEnable'))
await wait(() => calls.auto.some((c) => c.enabled === true && Number(c.debounceMs) === 500), 4000, 'enable POST with debounce')
click($('autoAdd'))
click($('autoSave'))
await wait(() => calls.auto.filter((c) => Number(c.debounceMs) === 500).length >= 3, 4000, 'save POST with debounce')
console.log('E auto debounce: posts =', JSON.stringify(calls.auto))
assert($('autoAiState').textContent.indexOf('专用会话') !== -1, 'aiState hint mentions dedicated session')
assert($('autoAiState').textContent.indexOf('session-x') !== -1, 'aiState hint shows session id')

/* 收尾 */
if (errors.length) {
  console.error('jsdom errors:', errors.map((e) => String((e && e.message) || e)))
  throw new Error('jsdom reported errors')
}
console.log('\nUI FEATURES TEST PASSED')
dom.window.close()
server.close()
