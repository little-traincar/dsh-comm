// dsh-comm 本地冒烟测试：不依赖 DSH，模拟 Host ctx 并走真实 HTTP/TCP/UDP。
// 运行：node test/smoke.mjs
import http from 'node:http'
import net from 'node:net'
import dgram from 'node:dgram'
import { apply } from '../lib/index.js'

const TOKEN = 'smoke-token'
const routes = []
const taps = []
const tools = []
const disposers = []

const fakeCtx = {
  inject(names, callback) {
    const scope = {
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
        tapIndex(fn) {
          taps.push(fn)
          return () => {}
        },
      },
      effect(fn) {
        const dispose = fn()
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      },
    }
    callback(scope)
  },
  tools: {
    register(definition) {
      tools.push(definition)
    },
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
}

apply(fakeCtx, { maxLogEntries: 500, maxReadEntries: 100, uiToken: TOKEN })

if (!routes.length) throw new Error('no /comm route registered')
if (taps.length !== 1) throw new Error('expected one index tap')
const tapped = taps[0]('<html><head></head><body></body></html>')
if (!tapped.includes('window.__DSH_COMM__')) throw new Error('index tap must inject window.__DSH_COMM__')
console.log('index tap OK')
const handler = routes[0].handler
const server = http.createServer(handler)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/comm`

let tcpClientSocket = null
let echoServer = null
let echoSocket = null
let udpPeer = null

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}
async function api(path, method = 'GET', body) {
  const url = base + path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error('API ' + path + ' -> ' + res.status + ' ' + JSON.stringify(data))
  return data
}
async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
}
async function waitFor(fn, timeout = 4000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await fn()
    if (value) return value
    await new Promise((r) => setTimeout(r, 40))
  }
  throw new Error('waitFor timeout')
}
async function pollUntil(predicate, since = 0, timeout = 4000) {
  const start = Date.now()
  let cursor = since
  while (Date.now() - start < timeout) {
    const data = await api('/api/poll?since=' + cursor)
    cursor = data.cursor
    const hit = predicate(data.entries || [])
    if (hit) return { data, entries: data.entries, cursor }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('pollUntil timeout')
}

try {
  // 1) state + ports
  const state = await api('/api/state')
  assert(Array.isArray(state.links), 'state.links')
  const ports = await api('/api/ports')
  assert(Array.isArray(ports.ports), 'ports list')
  console.log('state/ports OK, serial available:', ports.available, ports.error || '')

  // 2) TCP server
  const serverPort = await freePort()
  const openServer = await api('/api/open', 'POST', { type: 'tcpServer', options: { host: '127.0.0.1', port: serverPort } })
  const serverLink = openServer.link.id
  const client = net.connect({ host: '127.0.0.1', port: serverPort })
  tcpClientSocket = client
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject) })
  client.write('hello-server')
  const rx = await pollUntil((entries) => entries.some((e) => Buffer.from(e.b, 'base64').toString() === 'hello-server'))
  assert(rx.entries.length > 0, 'tcpServer rx')
  let clientGot = ''
  client.on('data', (chunk) => { clientGot += chunk.toString() })
  await api('/api/write', 'POST', { link: serverLink, text: 'world', encoding: 'utf-8' })
  await waitFor(() => clientGot.includes('world'))
  console.log('tcpServer OK, got:', clientGot)

  // 3) TCP client
  const echoPort = await freePort()
  let echoSocket = null
  echoServer = net.createServer((socket) => {
    echoSocket = socket
    socket.write('from-server')
  })
  await new Promise((resolve) => echoServer.listen(echoPort, '127.0.0.1', resolve))
  const openClient = await api('/api/open', 'POST', { type: 'tcpClient', options: { host: '127.0.0.1', port: echoPort } })
  const clientLink = openClient.link.id
  await pollUntil((entries) => entries.some((e) => Buffer.from(e.b, 'base64').toString() === 'from-server'))
  let echoGot = ''
  echoSocket.on('data', (chunk) => { echoGot += chunk.toString() })
  await api('/api/write', 'POST', { link: clientLink, text: 'from-client', encoding: 'utf-8' })
  await waitFor(() => echoGot.includes('from-client'))
  console.log('tcpClient OK, echo got:', echoGot)

  // 4) UDP
  const udpLocal = await freePort()
  const udpRemote = await freePort()
  const openUdp = await api('/api/open', 'POST', {
    type: 'udp',
    options: { localPort: udpLocal, remoteHost: '127.0.0.1', remotePort: udpRemote },
  })
  const udpLink = openUdp.link.id
  udpPeer = dgram.createSocket('udp4')
  await new Promise((resolve) => udpPeer.bind(udpRemote, '127.0.0.1', resolve))
  udpPeer.send('ping-udp', udpLocal, '127.0.0.1')
  await pollUntil((entries) => entries.some((e) => Buffer.from(e.b, 'base64').toString() === 'ping-udp'))
  let udpGot = ''
  udpPeer.on('message', (msg) => { udpGot += msg.toString() })
  await api('/api/write', 'POST', { link: udpLink, text: 'pong-udp', encoding: 'utf-8' })
  await waitFor(() => udpGot.includes('pong-udp'))
  console.log('udp OK, peer got:', udpGot)

  // 5) tools
  const listTool = tools.find((t) => t.name === 'comm_list')
  assert(listTool, 'comm_list registered')
  const listResult = await listTool.execute({}, { signal: new AbortController().signal })
  assert(listResult && Array.isArray(listResult.links), 'comm_list execute')

  const readTool = tools.find((t) => t.name === 'comm_read')
  const readResult = await readTool.execute({ link: serverLink, limit: 10 }, { signal: new AbortController().signal })
  assert(readResult && Array.isArray(readResult.entries), 'comm_read execute')

  const serialOpen = await api('/api/open', 'POST', { type: 'serial', options: { path: 'COM_DOES_NOT_EXIST' } }).then(
    () => { throw new Error('serial open should fail') },
    (error) => String(error.message),
  )
  console.log('serial open error OK:', serialOpen.slice(0, 80))

  // 6) close all
  await api('/api/close', 'POST', { link: serverLink })
  await api('/api/close', 'POST', { link: clientLink })
  await api('/api/close', 'POST', { link: udpLink })
  const after = await api('/api/state')
  assert(after.links.length === 0, 'all links closed')
  console.log('close OK')

  console.log('\nSMOKE TEST PASSED')
} finally {
  for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } }
  try { tcpClientSocket?.destroy() } catch { /* ignore */ }
  try { echoSocket?.destroy() } catch { /* ignore */ }
  try { echoServer?.close() } catch { /* ignore */ }
  try { udpPeer?.close() } catch { /* ignore */ }
  try { server.closeAllConnections?.() } catch { /* ignore */ }
  await new Promise((resolve) => server.close(resolve))
}
