// Ad-hoc UI check: the auto-reply panel exists, toggles, and renders its empty state.
import { JSDOM, VirtualConsole } from 'jsdom'

const BASE = 'http://127.0.0.1:3999'
const TOKEN = process.argv[2]
if (!TOKEN) throw new Error('usage: node auto-ui-test.mjs <token>')

const errors = []
const vc = new VirtualConsole()
vc.on('jsdomError', (e) => errors.push(e))
vc.on('error', (...a) => errors.push(new Error(a.join(' '))))

const dom = await JSDOM.fromURL(`${BASE}/comm/ui?token=${TOKEN}`, {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(window) {
    window.fetch = (input, init) => fetch(new URL(input, BASE), init)
    window.TextDecoder = TextDecoder
    window.TextEncoder = TextEncoder
  },
})
const doc = dom.window.document
const wait = async (fn, ms = 5000, label = 'condition') => {
  const end = Date.now() + ms
  while (Date.now() < end) { try { if (await fn()) return } catch { /* retry */ } await new Promise((r) => setTimeout(r, 50)) }
  throw new Error('timeout: ' + label)
}

await wait(() => doc.querySelector('#autoBtn'), 6000, 'autoBtn')
const panel = doc.querySelector('#autoPanel')
if (!panel) throw new Error('autoPanel missing')
if (!panel.hidden) throw new Error('autoPanel should start hidden')

doc.querySelector('#autoBtn').click()
await wait(() => panel.hidden === false, 4000, 'panel opens')
const text = doc.querySelector('#autoList').textContent
if (!/链路/.test(text)) throw new Error('empty state not rendered: ' + JSON.stringify(text))
console.log('panel opens, empty state:', JSON.stringify(text.trim()))

doc.querySelector('#autoAdd').click()
await new Promise((r) => setTimeout(r, 200))
if (doc.querySelectorAll('#autoList .auto-row').length !== 0) throw new Error('rule row added without a link')

doc.querySelector('#autoBtn').click()
await wait(() => panel.hidden === true, 3000, 'panel closes')
console.log('panel closes')

if (errors.length) { console.error(errors.map((e) => String(e && e.message || e))); throw new Error('jsdom errors') }
console.log('AUTO-REPLY UI TEST PASSED')
dom.window.close()
