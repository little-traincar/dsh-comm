// Stability / anti-loop guards for auto-reply and timers, plus "Host stays responsive
// when the DSH session service misbehaves" checks.
// Run: node test/resilience.mjs
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, CommManager } from '../lib/index.js'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-comm-resilience-'))
const TOKEN = 'resilience-token'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}
async function waitFor(fn, timeout = 6000, label = 'condition') {
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
class FakeBridge {
  constructor(config) { this.config = config; this.listeners = {}; this.written = [] }
  on(event, fn) { this.listeners[event] = fn }
  async open() {}
  async write(buf) { this.written.push(Buffer.from(buf)) }
  async close() { this.listeners.close?.('closed') }
  async signals() { return { dtr: true, rts: true } }
  async ping() { return true }
  emitData(bytes) { this.listeners.data?.(Buffer.from(bytes)) }
}

/* ── A. manager-level guards ── */

/* A1. echo suppression: TX followed by the same bytes does not trigger a forward */
const manager = new CommManager({
  uiToken: 'x',
  aiReplyDebounceMs: 10,
  aiReplyEchoSuppressMs: 300,
  aiReplyCooldownMs: 0,
  maxLogBytes: 1024 * 1024,
})
let fake = null
manager.serialBridgeFactory = (config) => { fake = new FakeBridge(config); return fake }
manager.serialPortsProvider = async () => ({ available: true, error: null, ports: [{ path: 'COM1' }] })
const forwarded = []
manager.aiFallback = async (_link, batch) => { forwarded.push(batch.map((item) => item.bytes.toString())) }
const link = await manager.open('serial', { path: 'COM1' })
manager.setAuto(link.id, true, 10)
manager.push(manager.linkOrThrow(link.id), 'tx', '', Buffer.from('PING'))
manager.push(manager.linkOrThrow(link.id), 'rx', '', Buffer.from('PING'))
manager.push(manager.linkOrThrow(link.id), 'rx', '', Buffer.from('PING-EXTRA')) // 包含短包 => 也算回显
await sleep(160)
assert(forwarded.length === 0, 'echo data must not trigger auto-reply: ' + JSON.stringify(forwarded))
manager.push(manager.linkOrThrow(link.id), 'rx', '', Buffer.from('PONG'))
await waitFor(() => forwarded.length === 1, 3000, 'real response forwarded')
assert(forwarded[0].join('').includes('PONG'), 'real response forwarded')
const echoLogs = manager.read(link.id, { since: 0 }).entries
  .filter((entry) => entry.dir === 'sys')
  .map((entry) => entry.text)
assert(echoLogs.some((text) => text.includes('回显')), 'echo suppression logged')
console.log('echo suppression (identical + split chunks): OK')

/* A2. cooldown between forwards */
forwarded.length = 0
const cooldownManager = new CommManager({
  uiToken: 'x', aiReplyDebounceMs: 5, aiReplyEchoSuppressMs: 0, aiReplyCooldownMs: 150,
})
cooldownManager.serialBridgeFactory = (config) => new FakeBridge(config)
cooldownManager.serialPortsProvider = async () => ({ available: true, error: null, ports: [{ path: 'COM2' }] })
const forwardTimes = []
cooldownManager.aiFallback = async () => { forwardTimes.push(Date.now()) }
const cooldownLink = await cooldownManager.open('serial', { path: 'COM2' })
cooldownManager.setAuto(cooldownLink.id, true, 5)
cooldownManager.push(cooldownManager.linkOrThrow(cooldownLink.id), 'rx', '', Buffer.from('one'))
await waitFor(() => forwardTimes.length === 1, 3000, 'first cooldown forward')
cooldownManager.push(cooldownManager.linkOrThrow(cooldownLink.id), 'rx', '', Buffer.from('two'))
await waitFor(() => forwardTimes.length === 2, 3000, 'second cooldown forward')
assert(forwardTimes[1] - forwardTimes[0] >= 120, `cooldown respected (${forwardTimes[1] - forwardTimes[0]}ms)`)
console.log(`cooldown between forwards: ${forwardTimes[1] - forwardTimes[0]}ms >= 150ms: OK`)

/* A3. rate limit pauses forwarding and logs */
const rateManager = new CommManager({
  uiToken: 'x', aiReplyDebounceMs: 5, aiReplyEchoSuppressMs: 0, aiReplyCooldownMs: 10, aiReplyMaxPerMinute: 2,
})
rateManager.serialBridgeFactory = (config) => new FakeBridge(config)
rateManager.serialPortsProvider = async () => ({ available: true, error: null, ports: [{ path: 'COM3' }] })
let rateForwards = 0
rateManager.aiFallback = async () => { rateForwards += 1 }
const rateLink = await rateManager.open('serial', { path: 'COM3' })
rateManager.setAuto(rateLink.id, true, 5)
for (let i = 0; i < 4; i += 1) {
  rateManager.push(rateManager.linkOrThrow(rateLink.id), 'rx', '', Buffer.from(`rate-${i}`))
  await sleep(60)
}
await sleep(200)
assert(rateForwards === 2, `rate limit stops at 2 forwards (got ${rateForwards})`)
const rateLogs = rateManager.read(rateLink.id, { since: 0 }).entries
  .filter((entry) => entry.dir === 'sys').map((entry) => entry.text)
assert(rateLogs.some((text) => text.includes('防回环')), 'rate-limit pause logged')
console.log('rate limit (2 forwards, then 30s pause + log): OK')

/* A4. timer callback exceptions are contained (never escape the setTimeout) */
const timerManager = new CommManager({ uiToken: 'x' })
timerManager.serialBridgeFactory = (config) => new FakeBridge(config)
timerManager.serialPortsProvider = async () => ({ available: true, error: null, ports: [{ path: 'COM4' }] })
const timerLinkSnap = await timerManager.open('serial', { path: 'COM4' })
const timerLink = timerManager.linkOrThrow(timerLinkSnap.id)
timerManager.startTimer(timerLinkSnap.id, { kind: 'periodic', intervalMs: 100000, payload: { text: 'x' } })
const timer = timerLink.timer
timer.spec = null // 模拟内部状态损坏
let threw = false
try { timerManager.periodicTick(timerLink, timer) } catch { threw = true }
assert(!threw, 'periodicTick must not throw')
assert(timerLink.timer === null, 'broken timer stopped')
const timerLogs = timerManager.read(timerLinkSnap.id, { since: 0 }).entries
  .filter((entry) => entry.dir === 'sys').map((entry) => entry.text)
assert(timerLogs.some((text) => text.includes('异常已停止')), 'timer crash logged: ' + JSON.stringify(timerLogs.slice(-3)))
console.log('timer callback exception contained + logged: OK')

/* A5. writeAndWait timeout cleans its waiter (no leak) */
const waiterManager = new CommManager({ uiToken: 'x' })
waiterManager.serialBridgeFactory = (config) => new FakeBridge(config)
waiterManager.serialPortsProvider = async () => ({ available: true, error: null, ports: [{ path: 'COM5' }] })
const waiterLink = await waiterManager.open('serial', { path: 'COM5' })
const miss = await waiterManager.writeAndWait(waiterLink.id, Buffer.from('PING'), { expect: 'NOPE', expectTimeoutMs: 60 })
assert(miss.matched === false && miss.timedOut === true, 'writeAndWait timeout shape')
assert(waiterManager.entryWaiters.size === 0, 'writeAndWait waiter cleaned up')
console.log('writeAndWait timeout leaves no waiter: OK')

/* ── B. Host stays responsive with a hostile DSH session service ── */
function bootWithSession(sessionController, config = {}) {
  const routes = []
  const ctx = {
    inject(_names, callback) {
      callback({
        sessionController,
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
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-comm-resilience-web-'))
  apply(ctx, { uiToken: TOKEN, aiReplyDebounceMs: 20, aiReplyTimeoutMs: 300, ...config })
  return routes[0].handler
}

const hangingSessions = {
  sessions: [{ sessionId: 'root-1', blank: false, updatedAt: Date.now() }],
  prompts: [],
  creates: 0,
  async list() { return { items: this.sessions.map((session) => ({ ...session })) } },
  create() { this.creates += 1; return new Promise(() => {}) }, // never resolves
  async rename() { return { title: 'x', seq: 1 } },
  prompt() { this.prompts.push(Date.now()); return new Promise(() => {}) }, // never resolves
}
const server = http.createServer(bootWithSession(hangingSessions))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
server.unref()
const BASE = `http://127.0.0.1:${server.address().port}`
const hostApi = async (path, method = 'GET', body) => {
  const started = Date.now()
  const res = await fetch(`${BASE}/comm/api${path}${path.includes('?') ? '&' : '?'}token=${TOKEN}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data, ms: Date.now() - started }
}
const port = await freePort()
const opened = await hostApi('/open', 'POST', { type: 'tcpServer', options: { host: '127.0.0.1', port } })
const hostileLink = opened.data.link.id
await hostApi('/auto', 'POST', { link: hostileLink, enabled: true, debounceMs: 20 })
const client = net.connect({ host: '127.0.0.1', port })
await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject) })
client.write('hostile-1')
// create() hangs -> timeout -> fallback to root-1 -> prompt() hangs -> timeout; all within ~1s
await waitFor(() => hangingSessions.prompts.length >= 1, 5000, 'prompt attempted')
await sleep(800)
const state = await hostApi('/state')
assert(state.status === 200 && state.ms < 500, `Host /state still responsive (${state.ms}ms)`)
const poll = await hostApi('/poll?since=0')
const sys = (poll.data.entries || []).filter((entry) => entry.l === hostileLink && entry.d === 'sys')
  .map((entry) => Buffer.from(entry.b, 'base64').toString('utf8'))
assert(sys.some((text) => text.includes('创建专用会话失败')), 'create-timeout logged: ' + JSON.stringify(sys))
assert(sys.some((text) => text.includes('超时')), 'prompt-timeout logged')
// second message still processed, no wedge
client.write('hostile-2')
await waitFor(() => hangingSessions.prompts.length >= 2, 5000, 'second prompt attempted')
// other API routes work fine while the session service hangs
const write = await hostApi('/write', 'POST', { link: hostileLink, text: 'OK' })
assert(write.status === 200 && write.data.written === 2, 'write still works while session service hangs')
const timerResult = await hostApi('/timer', 'POST', { link: hostileLink, action: 'start', spec: { kind: 'periodic', intervalMs: 20, payload: { text: 'T' }, repeat: 2 } })
assert(timerResult.status === 200, 'timer still works while session service hangs')
await sleep(200)
const after = await hostApi('/state')
assert(after.status === 200 && after.ms < 500, `Host still responsive after hostile session calls (${after.ms}ms)`)
client.destroy()
await hostApi('/close', 'POST', { link: hostileLink })
await new Promise((resolve) => server.close(resolve))
console.log('hostile session service: Host APIs stay responsive, timeouts logged, other features work: OK')

console.log('\nRESILIENCE TEST PASSED')
