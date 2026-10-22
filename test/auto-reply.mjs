// Checks for auto-reply: per-link enable flag, rule matching, and Host-side persistence.
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

// 隔离持久化目录，避免写到真实的 ~/.dsh（settings 在 apply 时才读取）
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-comm-settings-'))

const TOKEN = 'auto-token'

function boot() {
  const routes = []
  const fakeCtx = {
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
  apply(fakeCtx, { uiToken: TOKEN })
  return routes[0].handler
}

async function serve(handler) {
  const server = http.createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/comm/api`
  const api = async (path, method = 'GET', body) => {
    const res = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}token=${TOKEN}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json()
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(data)}`)
    return data
  }
  return { server, api }
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})

const { server, api } = await serve(boot())
const port = await freePort()
const opened = await api('/open', 'POST', { type: 'tcpServer', options: { host: '127.0.0.1', port } })
const link = opened.link.id

// 先存规则但不启用：不应回复
await api('/rules', 'POST', {
  link,
  rules: [
    { mode: 'contains', match: 'ping', reply: 'pong', encoding: 'utf-8' },
    { mode: 'hex', match: 'AA 55', reply: 'HEX-OK', encoding: 'utf-8' },
    { mode: 'regex', match: '^num:\\d+$', reply: 'GOT-NUMBER', encoding: 'utf-8' },
    { mode: 'contains', match: 'never', reply: 'x', enabled: false },
  ],
})

const client = net.connect({ host: '127.0.0.1', port })
await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject) })
client.setEncoding('utf8')
let received = ''
client.on('data', (chunk) => { received += chunk })

const waitFor = async (expected, ms = 4000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (received.includes(expected)) return true
    await new Promise((r) => setTimeout(r, 30))
  }
  return false
}

client.write('ping')
await new Promise((r) => setTimeout(r, 500))
if (received !== '') throw new Error('rules replied while auto-reply was disabled')
console.log('disabled link: no reply (ok)')

// 启用后规则生效
const enabled = await api('/auto', 'POST', { link, enabled: true })
if (enabled.enabled !== true) throw new Error('auto enable not saved')
await new Promise((r) => setTimeout(r, 100))

received = ''
client.write('ping')
if (!(await waitFor('pong'))) throw new Error('contains rule did not reply')
console.log('contains: got pong')

received = ''
client.write(Buffer.from([0xAA, 0x55, 0x01]))
if (!(await waitFor('HEX-OK'))) throw new Error('hex rule did not reply')
console.log('hex: got HEX-OK')

received = ''
client.write('num:42')
if (!(await waitFor('GOT-NUMBER'))) throw new Error('regex rule did not reply')
console.log('regex: got GOT-NUMBER')

// 持久化：规则与开关都写进了 settings 文件
const settingsFile = join(process.env.DSH_HOME, 'comm-settings.json')
const saved = JSON.parse(readFileSync(settingsFile, 'utf8'))
if (saved.auto?.[link] !== true) throw new Error('auto flag not persisted')
if (!Array.isArray(saved.rules?.[link]) || saved.rules[link].length !== 4) throw new Error('rules not persisted')
console.log('persisted to', settingsFile)

// 模拟重启：新的 manager 从同一个文件恢复
const second = await serve(boot())
const restored = await second.api('/rules?link=' + encodeURIComponent(link))
if (restored.enabled !== true) throw new Error('auto flag not restored')
if (restored.rules.length !== 4) throw new Error('rules not restored')
console.log('restored after restart: enabled=true, rules=4')
second.server.close()

// 无规则 + 已启用（方案 A 无可用会话）：不回复，只记系统日志
await api('/rules', 'POST', { link, rules: [] })
received = ''
client.write('ping-without-rules')
await new Promise((r) => setTimeout(r, 900))
if (received !== '') throw new Error('replied without rules or session')
const log = await api('/poll?since=0')
const sysTexts = (log.entries || [])
  .filter((entry) => entry.l === link && entry.d === 'sys')
  .map((entry) => Buffer.from(entry.b, 'base64').toString('utf8'))
if (!sysTexts.some((text) => text.includes('没有可用 DSH 会话'))) {
  throw new Error('missing no-session log: ' + JSON.stringify(sysTexts))
}
console.log('no rules + no session: no reply, sys logged')

client.destroy()
await api('/close', 'POST', { link })
server.close()
console.log('\nAUTO-REPLY TEST PASSED')
