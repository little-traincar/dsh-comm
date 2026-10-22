// v2 HTTP API checks: boot the real Host half with a fake Cordis ctx, serve it on
// a real HTTP port, and exercise the routes the UI / model use.
// Run: node test/api-v2.mjs
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-comm-api-'))
const TOKEN = 'api-v2-token'

function boot() {
  const routes = []
  const ctx = {
    inject(names, callback) {
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
  apply(ctx, { uiToken: TOKEN, aiReplyDebounceMs: 50 })
  return routes[0].handler
}

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, timeout = 5000, label = 'condition') {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await fn()
    if (value) return value
    await sleep(20)
  }
  throw new Error('waitFor timeout: ' + label)
}
function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)) })
  })
}

const server = http.createServer(boot())
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
server.unref()
const base = `http://127.0.0.1:${server.address().port}`
const api = async (path, method = 'GET', body) => {
  const url = base + path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(data)}`)
  return data
}

/* bootstrap + ui page */
try {
  const res = await fetch(`${base}/comm/bootstrap`)
  const bootstrap = await res.json()
  assert(bootstrap.base === '/comm' && bootstrap.token === TOKEN, 'bootstrap returns base/token')
  const ui = await fetch(`${base}/comm/ui?token=${TOKEN}`)
  assert(ui.status === 200, 'ui page 200')
  const html = await ui.text()
  assert(html.includes('通信调试台') && html.includes('/comm/api/poll'), 'ui page served')
  console.log('bootstrap + /comm/ui: OK')
} catch (error) {
  console.error('bootstrap failed:', error.message)
  throw error
}

/* open tcpServer via /open, check v2 snapshot fields */
const port = await freePort()
const opened = await api('/comm/api/open', 'POST', { type: 'tcpServer', options: { host: '127.0.0.1', port } })
const linkId = opened.link.id
assert(typeof opened.link.backlog === 'number' && opened.link.backlog >= 1, 'snapshot backlog fields')
assert(typeof opened.link.backlogBytes === 'number' && opened.link.backlogBytes > 0, 'snapshot backlogBytes fields')
assert(opened.link.dropped === 0 && opened.link.droppedBytes === 0, 'snapshot dropped fields')
assert(opened.link.timer === null, 'snapshot timer null')
assert(opened.link.serial === null, 'snapshot serial null for tcp')
console.log('open + v2 snapshot fields: OK')

/* /serial on a non-serial link is a 400 */
let serialErr = ''
try {
  await api('/comm/api/serial?link=' + encodeURIComponent(linkId))
} catch (error) {
  serialErr = String(error.message)
}
assert(serialErr.includes('400'), '/serial rejects non-serial link')
let serialPostErr = ''
try {
  await api('/comm/api/serial', 'POST', { link: linkId, action: 'signals' })
} catch (error) {
  serialPostErr = String(error.message)
}
assert(serialPostErr.includes('只有串口链路'), '/serial POST rejects non-serial link')
console.log('/serial guards: OK')

/* /timer save + status + start periodic */
const spec = { kind: 'periodic', intervalMs: 20, payload: { text: 'tick' }, repeat: 3 }
const savedTimer = await api('/comm/api/timer', 'POST', { link: linkId, action: 'save', spec, autostart: true })
assert(savedTimer.saved?.spec?.intervalMs === 20, 'timer saved')
const timerInfo = await api('/comm/api/timer?link=' + encodeURIComponent(linkId))
assert(timerInfo.saved?.autostart === true, 'timer autostart persisted')
const client = net.connect({ host: '127.0.0.1', port })
await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject) })
let received = ''
client.on('data', (chunk) => { received += chunk.toString() })
await api('/comm/api/timer', 'POST', { link: linkId, action: 'start', spec: { kind: 'periodic', intervalMs: 20, payload: { text: 'T3' }, repeat: 3 } })
await waitFor(() => (received.match(/T3/g) || []).length >= 3, 5000, '3 periodic sends')
await waitFor(async () => (await api('/comm/api/timer?link=' + encodeURIComponent(linkId))).timer === null, 5000, 'timer stops')
const poll = await api('/comm/api/poll?since=0')
assert(poll.links[0].timer === null && Array.isArray(poll.entries), 'poll v2 links')
assert(poll.entries.some((entry) => entry.d === 'tx'), 'poll has tx entries from timer')
console.log('timer save/start/stop via HTTP (3 sends): OK')

/* sequence timer */
received = ''
await api('/comm/api/timer', 'POST', {
  link: linkId, action: 'start', autostart: false,
  spec: { kind: 'sequence', loop: false, steps: [{ delayMs: 0, text: 'S1' }, { delayMs: 30, text: 'S2' }] },
})
await waitFor(() => received.includes('S1') && received.includes('S2'), 5000, 'sequence A then B')
await waitFor(async () => (await api('/comm/api/timer?link=' + encodeURIComponent(linkId))).timer === null, 5000, 'sequence stops')
console.log('sequence timer via HTTP: OK')

/* write + expect (client echoes PONG when it sees PING) */
client.removeAllListeners('data')
client.on('data', (chunk) => { if (chunk.toString().includes('PING')) client.write('PONG-42') })
const writeResult = await api('/comm/api/write', 'POST', {
  link: linkId, text: 'PING', encoding: 'utf-8', expect: 'PONG', expectTimeoutMs: 2000,
})
assert(writeResult.matched === true, 'write+expect matched')
assert(writeResult.entries.some((entry) => entry.hex.includes('504F4E47') || entry.text.includes('PONG')), 'write+expect entries')
assert(typeof writeResult.waitedMs === 'number', 'waitedMs present')
console.log(`write+expect via HTTP: matched, waitedMs=${writeResult.waitedMs}: OK`)

/* write + expect timeout */
const missed = await api('/comm/api/write', 'POST', {
  link: linkId, text: 'PING', encoding: 'utf-8', expect: 'NEVER-COMES', expectTimeoutMs: 120,
})
assert(missed.matched === false && missed.timedOut === true, 'write+expect timeout shape')
console.log('write+expect timeout: OK')

/* auto-reply debounce persistence via HTTP (tcp link just stores settings) */
const autoSaved = await api('/comm/api/auto', 'POST', { link: linkId, enabled: true, debounceMs: 80 })
assert(autoSaved.enabled === true && autoSaved.debounceMs === 80, 'auto debounce saved')
const rules = await api('/comm/api/rules?link=' + encodeURIComponent(linkId))
assert(rules.enabled === true && rules.debounceMs === 80, 'rules returns debounceMs')
assert(typeof rules.aiSession === 'boolean' && typeof rules.aiSessionId === 'string', 'rules aiSession fields')
await api('/comm/api/auto', 'POST', { link: linkId, enabled: false })
console.log('auto-reply debounce via HTTP: OK')

/* buffer counters via HTTP after clear */
await api('/comm/api/clear', 'POST', { link: linkId })
const cleared = await api('/comm/api/state')
const clearedLink = cleared.links.find((item) => item.id === linkId)
assert(clearedLink.backlog === 0 && clearedLink.backlogBytes === 0, 'clear resets backlog')
console.log('clear resets backlog: OK')

client.destroy()
await api('/comm/api/close', 'POST', { link: linkId })
server.closeAllConnections?.()
await new Promise((resolve) => server.close(resolve))
console.log('\nAPI V2 TEST PASSED')
