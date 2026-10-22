// Checks the dedicated auto-reply session behavior (default for plan A):
//   - first no-rules message creates + renames one dedicated session
//   - later messages reuse it (no create), batches still coalesce
//   - the dedicated session id persists in comm-settings.json across restarts
//   - explicit aiReplySession still wins; aiReplyDedicatedSession=false keeps old behavior
//   - create failure falls back to the most recent session, with a system log
// Run: node test/ai-dedicated.mjs
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, losslessJson } from '../lib/index.js'

const TOKEN = 'ai-dedicated-token'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}
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

class FakeSessions {
  constructor() {
    this.sessions = []
    this.prompts = []
    this.creates = 0
    this.renames = []
    this.failCreate = false
    this.nextId = 1
  }
  add(session) { this.sessions.push(session) }
  async list() { return { items: this.sessions.map((session) => ({ ...session })) } }
  async create() {
    this.creates += 1
    if (this.failCreate) throw new Error('create blocked by test')
    const id = `sess-${this.nextId}`
    this.nextId += 1
    this.sessions.push({ sessionId: id, blank: true, updatedAt: Date.now() })
    return { sessionId: id }
  }
  async rename(request) {
    this.renames.push({ ...request })
    const session = this.sessions.find((item) => item.sessionId === request.sessionId)
    if (session) session.title = request.title
    return { title: request.title, seq: 1 }
  }
  async prompt(request) {
    this.prompts.push(request)
    return { accepted: true }
  }
}

function boot(hostHome, options = {}) {
  const routes = []
  const fakeCtx = {
    inject(_names, callback) {
      callback({
        sessionController: options.sessions || null,
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
  process.env.DSH_HOME = hostHome
  apply(fakeCtx, {
    uiToken: TOKEN,
    aiReplyDebounceMs: 30,
    ...options.config,
  })
  return routes[0].handler
}

async function serve(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const api = async (path, method = 'GET', body) => {
    const res = await fetch(`${base}/comm/api${path}${path.includes('?') ? '&' : '?'}token=${TOKEN}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(data)}`)
    return data
  }
  return { server, api }
}

async function openLink(api) {
  const port = await freePort()
  const opened = await api('/open', 'POST', { type: 'tcpServer', options: { host: '127.0.0.1', port } })
  const client = net.connect({ host: '127.0.0.1', port })
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject) })
  await api('/auto', 'POST', { link: opened.link.id, enabled: true, debounceMs: 30 })
  return { linkId: opened.link.id, client }
}

async function sysLogs(api, linkId) {
  const poll = await api('/poll?since=0')
  return (poll.entries || [])
    .filter((entry) => entry.l === linkId && entry.d === 'sys')
    .map((entry) => Buffer.from(entry.b, 'base64').toString('utf8'))
}

const home = mkdtempSync(join(tmpdir(), 'dsh-comm-ai-'))
const sessions = new FakeSessions()

/* 1. first message creates + renames one dedicated session */
let host = await serve(boot(home, { sessions }))
let link = await openLink(host.api)
link.client.write('hello-1')
await waitFor(() => sessions.prompts.length === 1, 5000, 'first prompt')
assert(sessions.creates === 1, `created once (got ${sessions.creates})`)
assert(sessions.renames.length === 1, 'renamed once')
assert(sessions.renames[0].title === 'dsh-comm 自动回复', 'renamed to dedicated title')
assert(String(sessions.prompts[0].sessionId) === 'sess-1', 'prompt goes to created session')
const rules = await host.api('/rules?link=' + encodeURIComponent(link.linkId))
assert(rules.aiSessionId === 'sess-1', 'rules expose dedicated session id')
assert(rules.aiDedicated === true, 'rules expose aiDedicated')
assert(rules.aiSessionTitle === 'dsh-comm 自动回复', 'rules expose title')
const logs = await sysLogs(host.api, link.linkId)
assert(logs.some((text) => text.includes('专用会话') && text.includes('sess-1')), 'sys log mentions dedicated session: ' + JSON.stringify(logs))
const settingsFile = join(home, 'comm-settings.json')
assert(JSON.parse(readFileSync(settingsFile, 'utf8')).aiReplySessionId === 'sess-1', 'session id persisted')
console.log('dedicated session created + renamed + persisted: OK')

/* 2. second burst reuses it, no extra create, still coalesced */
await host.api('/auto', 'POST', { link: link.linkId, enabled: true, debounceMs: 120 })
link.client.write('burst-a')
await sleep(30)
link.client.write('burst-b')
await waitFor(() => sessions.prompts.length === 2, 5000, 'second prompt')
assert(sessions.creates === 1, 'no second create')
assert(String(sessions.prompts[1].sessionId) === 'sess-1', 'reuses dedicated session')
const secondText = sessions.prompts[1].content[0].text
assert(secondText.includes('2 条'), 'burst coalesced into one prompt: ' + secondText.slice(0, 120))
console.log('dedicated session reused, burst coalesced: OK')
link.client.destroy()
await host.api('/close', 'POST', { link: link.linkId })
await new Promise((resolve) => host.server.close(resolve))

/* 3. restart reuses the persisted session without creating a new one */
host = await serve(boot(home, { sessions }))
link = await openLink(host.api)
link.client.write('after-restart')
await waitFor(() => sessions.prompts.length === 3, 5000, 'prompt after restart')
assert(sessions.creates === 1, 'no create after restart')
assert(String(sessions.prompts[2].sessionId) === 'sess-1', 'persisted session reused after restart')
console.log('persisted dedicated session reused after restart: OK')
link.client.destroy()
await host.api('/close', 'POST', { link: link.linkId })
await new Promise((resolve) => host.server.close(resolve))

/* 4. explicit aiReplySession wins over dedicated creation */
const explicitSessions = new FakeSessions()
explicitSessions.add({ sessionId: 'explicit-1', blank: false, updatedAt: Date.now() })
host = await serve(boot(home, { sessions: explicitSessions, config: { aiReplySession: 'explicit-1' } }))
link = await openLink(host.api)
link.client.write('explicit message')
await waitFor(() => explicitSessions.prompts.length === 1, 5000, 'explicit prompt')
assert(explicitSessions.creates === 0, 'explicit session does not create')
assert(String(explicitSessions.prompts[0].sessionId) === 'explicit-1', 'prompt goes to explicit session')
const explicitRules = await host.api('/rules?link=' + encodeURIComponent(link.linkId))
assert(explicitRules.aiSessionId === 'explicit-1', 'rules expose explicit session id')
console.log('explicit aiReplySession wins: OK')
link.client.destroy()
await host.api('/close', 'POST', { link: link.linkId })
await new Promise((resolve) => host.server.close(resolve))

/* 5. aiReplyDedicatedSession=false keeps the old "most recent session" behavior */
const legacySessions = new FakeSessions()
legacySessions.add({ sessionId: 'root-1', blank: false, updatedAt: Date.now() })
host = await serve(boot(home, { sessions: legacySessions, config: { aiReplyDedicatedSession: false } }))
link = await openLink(host.api)
link.client.write('legacy message')
await waitFor(() => legacySessions.prompts.length === 1, 5000, 'legacy prompt')
assert(legacySessions.creates === 0, 'legacy mode does not create')
assert(String(legacySessions.prompts[0].sessionId) === 'root-1', 'legacy mode uses recent root session')
console.log('aiReplyDedicatedSession=false -> recent session: OK')
link.client.destroy()
await host.api('/close', 'POST', { link: link.linkId })
await new Promise((resolve) => host.server.close(resolve))

/* 6. create failure falls back to the most recent session and logs it */
const failingSessions = new FakeSessions()
failingSessions.failCreate = true
failingSessions.add({ sessionId: 'root-2', blank: false, updatedAt: Date.now() })
host = await serve(boot(home, { sessions: failingSessions }))
link = await openLink(host.api)
link.client.write('fallback message')
await waitFor(() => failingSessions.prompts.length === 1, 5000, 'fallback prompt')
assert(String(failingSessions.prompts[0].sessionId) === 'root-2', 'fallback prompt to recent session')
const fallbackLogs = await sysLogs(host.api, link.linkId)
assert(fallbackLogs.some((text) => text.includes('创建专用会话失败')), 'fallback logged: ' + JSON.stringify(fallbackLogs))
console.log('create failure -> recent-session fallback + sys log: OK')
link.client.destroy()
await host.api('/close', 'POST', { link: link.linkId })
await new Promise((resolve) => host.server.close(resolve))

/* 7. create failure with no sessions: no reply, only a system log */
const emptySessions = new FakeSessions()
emptySessions.failCreate = true
host = await serve(boot(home, { sessions: emptySessions }))
link = await openLink(host.api)
link.client.write('no session message')
await waitFor(async () => (await sysLogs(host.api, link.linkId)).some((text) => text.includes('没有可用 DSH 会话')), 5000, 'no-session log')
assert(emptySessions.prompts.length === 0, 'no prompt without any session')
console.log('create failure + no session -> no reply, sys log: OK')
link.client.destroy()
await host.api('/close', 'POST', { link: link.linkId })
await new Promise((resolve) => host.server.close(resolve))

/* 8. saved dedicated session vanished -> rebuilt automatically (no endless dead-id sends) */
const ghostHome = mkdtempSync(join(tmpdir(), 'dsh-comm-ai-ghost-'))
writeFileSync(join(ghostHome, 'comm-settings.json'), JSON.stringify({ version: 2, aiReplySessionId: 'ghost-1' }))
const ghostSessions = new FakeSessions()
host = await serve(boot(ghostHome, { sessions: ghostSessions }))
link = await openLink(host.api)
link.client.write('ghost message')
await waitFor(() => ghostSessions.prompts.length === 1, 5000, 'ghost prompt')
assert(ghostSessions.creates === 1, `rebuilt a new dedicated session (got ${ghostSessions.creates})`)
assert(String(ghostSessions.prompts[0].sessionId) === 'sess-1', 'prompt goes to rebuilt session')
assert(JSON.parse(readFileSync(join(ghostHome, 'comm-settings.json'), 'utf8')).aiReplySessionId === 'sess-1', 'rebuilt id persisted')
console.log('saved session vanished -> rebuilt: OK')
link.client.destroy()
await host.api('/close', 'POST', { link: link.linkId })
await new Promise((resolve) => host.server.close(resolve))

/* 9a. session still listed but idle (archived/deleted): fast probe unbinds on the first miss */
const idleHome = mkdtempSync(join(tmpdir(), 'dsh-comm-ai-idle-'))
writeFileSync(join(idleHome, 'comm-settings.json'), JSON.stringify({ version: 2, aiReplySessionId: 'stale-9' }))
const idleSessions = new FakeSessions()
idleSessions.add({ sessionId: 'stale-9', blank: false, updatedAt: Date.now(), running: false })
host = await serve(boot(idleHome, { sessions: idleSessions, config: { aiReplyLivenessMs: 2000 } }))
link = await openLink(host.api)
link.client.write('idle-1')
await waitFor(() => idleSessions.prompts.length === 1, 5000, 'idle prompt 1')
assert(String(idleSessions.prompts[0].sessionId) === 'stale-9', 'first send still targets the saved session')
await waitFor(
  async () => (await sysLogs(host.api, link.linkId)).some((text) => text.includes('已解除绑定')),
  5000,
  'fast unbind log',
)
const idleLogs = await sysLogs(host.api, link.linkId)
assert(idleLogs.some((text) => text.includes('没有真正运行')), 'idle session reason logged: ' + JSON.stringify(idleLogs))
assert(JSON.parse(readFileSync(join(idleHome, 'comm-settings.json'), 'utf8')).aiReplySessionId === '', 'idle binding cleared from settings')
link.client.write('idle-2')
await waitFor(() => idleSessions.prompts.length === 2, 5000, 'idle prompt 2')
assert(idleSessions.creates === 1, `rebuilt once after idle unbind (got ${idleSessions.creates})`)
assert(String(idleSessions.prompts[1].sessionId) === 'sess-1', 'next send goes to the rebuilt session')
console.log('idle (archived) dedicated session -> unbound on first probe + rebuilt: OK')
link.client.destroy()
await host.api('/close', 'POST', { link: link.linkId })
await new Promise((resolve) => host.server.close(resolve))

/* 9b. session really runs but never sends: two slow liveness misses before unbinding */
const busyHome = mkdtempSync(join(tmpdir(), 'dsh-comm-ai-busy-'))
writeFileSync(join(busyHome, 'comm-settings.json'), JSON.stringify({ version: 2, aiReplySessionId: 'busy-9' }))
const busySessions = new FakeSessions()
busySessions.add({ sessionId: 'busy-9', blank: false, updatedAt: Date.now(), running: true })
host = await serve(boot(busyHome, { sessions: busySessions, config: { aiReplyLivenessMs: 1500 } }))
link = await openLink(host.api)
link.client.write('busy-1')
await waitFor(() => busySessions.prompts.length === 1, 5000, 'busy prompt 1')
await waitFor(
  async () => (await sysLogs(host.api, link.linkId)).some((text) => text.includes('没有回复')),
  8000,
  'first slow miss',
)
assert(String(JSON.parse(readFileSync(join(busyHome, 'comm-settings.json'), 'utf8')).aiReplySessionId) === 'busy-9', 'one miss keeps the binding')
link.client.write('busy-2')
await waitFor(() => busySessions.prompts.length === 2, 5000, 'busy prompt 2')
await waitFor(
  async () => (await sysLogs(host.api, link.linkId)).some((text) => text.includes('已解除绑定')),
  8000,
  'second slow miss unbinds',
)
assert(JSON.parse(readFileSync(join(busyHome, 'comm-settings.json'), 'utf8')).aiReplySessionId === '', 'binding cleared after two slow misses')
console.log('running but silent session -> two misses then unbind: OK')
link.client.destroy()
await host.api('/close', 'POST', { link: link.linkId })
await new Promise((resolve) => host.server.close(resolve))

/* 10. tool output sanitizer: undefined / NaN / Date / Buffer must survive the lossless check */
const sanitized = losslessJson({ a: undefined, b: Number.NaN, c: new Date(0), d: Buffer.from('hi'), e: [undefined, 1] })
assert(!('a' in sanitized), 'undefined property dropped')
assert(sanitized.b === null, 'NaN -> null')
assert(sanitized.c === '1970-01-01T00:00:00.000Z', 'Date -> ISO string')
assert(sanitized.d === 'aGk=', 'Buffer -> base64')
assert(Array.isArray(sanitized.e) && sanitized.e[0] === null && sanitized.e[1] === 1, 'array holes -> null')
assert(JSON.stringify(JSON.parse(JSON.stringify(sanitized))) === JSON.stringify(sanitized), 'round-trips losslessly')
console.log('lossless JSON sanitizer: OK')

console.log('\nAI DEDICATED SESSION TEST PASSED')