// 用 jsdom 驱动真实 DSH 实例里的内嵌 UI，验证：
//   - 页面能启动、轮询 Host API
//   - 切到 TCP 服务端 -> 监听 -> 客户端接入 -> 日志出现
//   - 从 UI 发送 -> 对端收到
// 前置：dsh web 跑在 127.0.0.1:3999，且 dsh-comm 已安装（token 通过参数传入）。
import { JSDOM, VirtualConsole } from 'jsdom'
import net from 'node:net'

const BASE = 'http://127.0.0.1:3999'
const TOKEN = process.argv[2]
if (!TOKEN) throw new Error('usage: node test/ui-live.mjs <plugin-token>')

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}
async function waitFor(fn, timeout = 6000, label = 'condition') {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const value = await fn()
      if (value) return value
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('timeout waiting for ' + label)
}
async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

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
const { window } = dom
const doc = window.document

try {
  await waitFor(() => doc.querySelector('#headText') && doc.querySelector('#headText').textContent.includes('串口'), 5000, 'UI boot')
  assert(doc.querySelectorAll('#modeTabs button').length === 4, 'four mode tabs')
  console.log('UI boot OK')

  // 主题跟随：Client 会 postMessage，UI 应切到 light
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'dsh-comm:theme', dark: false } }))
  assert(doc.documentElement.dataset.theme === 'light', 'theme message applied')
  console.log('theme switch OK')

  const port = await freePort()
  doc.querySelector('#modeTabs button[data-mode="tcpServer"]').click()
  assert(doc.querySelector('#cfgTcpServer').classList.contains('active'), 'tcpServer config visible')
  doc.querySelector('#tsPort').value = String(port)
  doc.querySelector('#tsBtn').click()

  await waitFor(async () => {
    const state = await (await fetch(`${BASE}/comm/api/state?token=${TOKEN}`)).json()
    return state.links.some((link) => link.type === 'tcpServer' && link.open)
  }, 6000, 'tcpServer open')
  console.log('tcpServer open via UI OK')

  const socket = net.connect({ host: '127.0.0.1', port })
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  socket.write('hello-ui')
  await waitFor(() => doc.querySelector('#log').textContent.includes('hello-ui'), 6000, 'UI log hello-ui')
  console.log('UI received log OK')

  let peerGot = ''
  socket.on('data', (chunk) => { peerGot += chunk.toString('utf8') })
  doc.querySelector('#sendInput').value = 'world'
  doc.querySelector('#sendBtn').click()
  await waitFor(() => peerGot.includes('world'), 6000, 'peer got world')
  console.log('UI send OK, peer got:', peerGot)

  // 清空日志：界面和 Host 两侧都要清掉，重进面板不能又回来
  doc.querySelector('#clearBtn').click()
  await waitFor(() => !doc.querySelector('#log').textContent.includes('hello-ui'), 6000, 'UI log cleared')
  await waitFor(async () => {
    const poll = await (await fetch(`${BASE}/comm/api/poll?since=0&token=${TOKEN}`)).json()
    return Array.isArray(poll.entries) && poll.entries.length === 0
  }, 6000, 'Host log cleared')
  console.log('UI clear log OK')

  doc.querySelector('#tsBtn').click()
  await waitFor(async () => {
    const state = await (await fetch(`${BASE}/comm/api/state?token=${TOKEN}`)).json()
    return state.links.length === 0
  }, 6000, 'tcpServer close')
  console.log('UI close OK')

  if (jsdomErrors.length) {
    console.error('jsdom errors:', jsdomErrors.map((e) => String(e && e.message || e)))
    throw new Error('jsdom reported errors')
  }
  console.log('\nUI LIVE TEST PASSED')
} finally {
  try { dom.window.close() } catch { /* ignore */ }
}
