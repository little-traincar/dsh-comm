// End-to-end check: the real v2 Host half serving the real UI page in jsdom.
// No DSH process needed. Covers serial form -> open options, DTR/RTS container,
// host timers (quick + modal), auto-reply debounce, buffer stats, TCP data flow.
// Run: node test/ui-host.mjs
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM, VirtualConsole } from 'jsdom'
import { apply } from '../lib/index.js'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-comm-ui-'))
const TOKEN = 'ui-host-token'

const routes = []
const fakeCtx = {
  inject(_names, callback) {
    callback({
      webServer: {
        register(route) { routes.push(route); return () => {} },
        tapIndex() { return () => {} },
        getOrigin() { return 'http://127.0.0.1:1' },
      },
      effect(fn) { return fn() },
    })
  },
  tools: { register() {} },
  effect(fn) { return fn() },
}
apply(fakeCtx, { uiToken: TOKEN, aiReplyDebounceMs: 300 })

const server = http.createServer(routes[0].handler)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
server.unref()
const BASE = `http://127.0.0.1:${server.address().port}`

const jsdomErrors = []
const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', (error) => jsdomErrors.push(error))
virtualConsole.on('error', (...args) => jsdomErrors.push(new Error(args.join(' '))))

const dom = await JSDOM.fromURL(`${BASE}/comm/ui?token=${TOKEN}`, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.fetch = (input, init) => fetch(new URL(input, BASE), init)
    window.TextDecoder = TextDecoder
    window.TextEncoder = TextEncoder
  },
})
const doc = dom.window.document

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, timeout = 12000, label = 'condition') {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const value = await fn()
      if (value) return value
    } catch { /* retry */ }
    await sleep(50)
  }
  throw new Error('waitFor timeout: ' + label)
}
function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)) })
  })
}
const hostApi = async (path, method = 'GET', body) => {
  const res = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}token=${TOKEN}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

try {
  await waitFor(() => doc.querySelector('#headText') && doc.querySelector('#headText').textContent.includes('串口'), 10000, 'UI boot')
  console.log('UI boot: OK')

  /* serial parameter form + frame label */
  const setSelect = (id, value) => {
    const el = doc.querySelector('#' + id)
    el.value = value
    el.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  }
  setSelect('serialDataBits', '7')
  setSelect('serialParity', 'even')
  setSelect('serialStopBits', '2')
  setSelect('serialFlow', 'rtscts')
  await waitFor(() => doc.querySelector('#serialFrame').textContent.includes('7E2'), 3000, 'serial frame 7E2')
  assert(doc.querySelector('#serialFrame').textContent.includes('CTS'), 'frame shows CTS flow control')
  assert(doc.querySelector('#serialSignals').hidden === true, 'serial signals hidden without serial link')
  console.log('serial parameter form + frame:', doc.querySelector('#serialFrame').textContent.trim(), ': OK')

  /* open a TCP server through the UI, stream data, verify log + buffer text */
  const port = await freePort()
  doc.querySelector('#modeTabs button[data-mode="tcpServer"]').click()
  await waitFor(() => doc.querySelector('#cfgTcpServer').classList.contains('active'), 3000, 'tcpServer tab')
  doc.querySelector('#tsPort').value = String(port)
  doc.querySelector('#tsBtn').click()
  await waitFor(async () => {
    const state = await hostApi('/comm/api/state')
    return state.links.some((link) => link.type === 'tcpServer' && link.open)
  }, 8000, 'tcpServer open')
  assert(doc.querySelector('#serialSignals').hidden === true, 'serial signals hidden for tcp link')
  const socket = net.connect({ host: '127.0.0.1', port })
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  socket.write('hello-from-peer')
  await waitFor(() => doc.querySelector('#log').textContent.includes('hello-from-peer'), 8000, 'log shows peer data')
  await waitFor(() => doc.querySelector('#bufPct').textContent.includes('缓冲'), 3000, 'buffer stats text')
  assert(doc.querySelector('#bufPct').textContent.includes('丢弃'), 'buffer stats includes drop counter')
  console.log('tcp open + log + buffer stats:', doc.querySelector('#bufPct').textContent.trim(), ': OK')

  /* quick periodic timer via #periodic (Host side) */
  let received = ''
  socket.on('data', (chunk) => { received += chunk.toString() })
  doc.querySelector('#sendInput').value = 'QUICK-'
  doc.querySelector('#periodMs').value = '40'
  const periodicBox = doc.querySelector('#periodic')
  periodicBox.checked = true
  periodicBox.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await waitFor(() => (received.match(/QUICK-/g) || []).length >= 3, 8000, 'quick periodic sends')
  const hostTimer = await hostApi('/comm/api/timer?link=' + encodeURIComponent('tcpServer:127.0.0.1:' + port))
  assert(hostTimer.timer && hostTimer.timer.running, 'host timer running')
  assert(hostTimer.timer.intervalMs === 40, 'host timer intervalMs exposed')
  periodicBox.checked = false
  periodicBox.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await waitFor(async () => {
    const info = await hostApi('/comm/api/timer?link=' + encodeURIComponent('tcpServer:127.0.0.1:' + port))
    return info.timer === null
  }, 5000, 'quick periodic stopped')
  await sleep(150)
  const countAfterStop = (received.match(/QUICK-/g) || []).length
  await sleep(150)
  assert((received.match(/QUICK-/g) || []).length === countAfterStop, 'quick periodic really stopped')
  console.log('quick periodic timer start/stop via UI -> Host: OK')

  /* timer modal: periodic with custom payload */
  received = ''
  doc.querySelector('#timerCfg').click()
  await waitFor(() => doc.querySelector('#timerBackdrop').classList.contains('show'), 5000, 'timer modal opens')
  doc.querySelector('#timerKindPeriodic').checked = true
  doc.querySelector('#timerKindPeriodic').dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  doc.querySelector('#timerInterval').value = '30'
  doc.querySelector('#timerPayload').value = 'MODAL-'
  doc.querySelector('#timerPayloadMode').value = 'text'
  doc.querySelector('#timerRepeat').value = '3'
  doc.querySelector('#timerStart').click()
  await waitFor(() => (received.match(/MODAL-/g) || []).length >= 3, 8000, 'modal periodic sends')
  await waitFor(() => doc.querySelector('#timerStat').textContent.includes('已发'), 5000, 'timerStat running text')
  await waitFor(async () => {
    const info = await hostApi('/comm/api/timer?link=' + encodeURIComponent('tcpServer:127.0.0.1:' + port))
    return info.timer === null
  }, 5000, 'modal periodic finished (repeat=3)')
  console.log('timer modal periodic (repeat=3) via UI -> Host: OK')

  /* timer modal: sequence */
  received = ''
  doc.querySelector('#timerCfg').click()
  await waitFor(() => doc.querySelector('#timerBackdrop').classList.contains('show'), 5000, 'timer modal reopens')
  doc.querySelector('#timerKindSequence').checked = true
  doc.querySelector('#timerKindSequence').dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  doc.querySelector('#timerStepAdd').click()
  doc.querySelector('#timerStepAdd').click()
  const rows = doc.querySelectorAll('#timerSteps .tstep')
  assert(rows.length >= 2, 'two sequence step rows')
  const setInput = (el, value) => {
    el.value = value
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  }
  const rowA = rows[0].querySelectorAll('input')
  setInput(rowA[0], '0')
  setInput(rowA[1], 'SEQ-A')
  const rowB = rows[1].querySelectorAll('input')
  setInput(rowB[0], '40')
  setInput(rowB[1], 'SEQ-B')
  doc.querySelector('#timerLoop').checked = false
  doc.querySelector('#timerStart').click()
  await waitFor(() => received.includes('SEQ-A') && received.includes('SEQ-B'), 8000, 'sequence sends A/B')
  console.log('timer modal sequence via UI -> Host: OK')

  /* auto-reply panel: debounce + enable persisted through real Host */
  doc.querySelector('#autoBtn').click()
  await waitFor(() => doc.querySelector('#autoPanel').hidden === false, 5000, 'auto panel opens')
  const debounce = doc.querySelector('#autoDebounce')
  assert(Boolean(debounce), 'autoDebounce exists')
  debounce.value = '450'
  debounce.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  const aiState = doc.querySelector('#autoAiState')
  await waitFor(() => aiState.textContent.trim().length > 0, 5000, 'autoAiState rendered')
  assert(aiState.textContent.includes('会话'), 'autoAiState mentions session: ' + aiState.textContent)
  await waitFor(async () => {
    const info = await hostApi('/comm/api/rules?link=' + encodeURIComponent('tcpServer:127.0.0.1:' + port))
    return info.debounceMs === 450
  }, 5000, 'debounce persisted to host')
  console.log('auto-reply debounce UI -> Host: OK')

  /* close the link via UI */
  doc.querySelector('#tsBtn').click()
  await waitFor(async () => {
    const state = await hostApi('/comm/api/state')
    return state.links.length === 0
  }, 8000, 'link closed')
  socket.destroy()
  console.log('UI close link: OK')

  assert(jsdomErrors.length === 0, 'jsdom errors: ' + jsdomErrors.map((error) => String(error && error.message || error)).join(' | '))
  console.log('\nUI HOST E2E TEST PASSED')
} finally {
  try { dom.window.close() } catch { /* ignore */ }
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}
