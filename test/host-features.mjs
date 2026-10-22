// Host-side feature checks for dsh-comm, no real serial hardware required:
//   - serial params / flow control / DTR-RTS / pulse / configure
//   - auto reconnect after unplug (including COM number change matched by serial number)
//   - Host timers: periodic + sequence, persistence
//   - bounded log buffer with drop counters
//   - writeAndWait (one tool round trip request/response)
//   - auto-reply coalescing (debounce) for the no-rules AI fallback
// Run: node test/host-features.mjs
import net from 'node:net'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommManager } from '../lib/index.js'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-comm-host-'))

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, timeout = 4000, label = 'condition') {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await fn()
    if (value) return value
    await sleep(10)
  }
  throw new Error('waitFor timeout: ' + label)
}

/* ── fake serial bridge ── */
class FakeBridge {
  constructor(config, options = {}) {
    this.config = config
    this.options = options
    this.listeners = {}
    this.written = []
    this.pulses = []
    this.reconfigures = []
    this.signalsValue = { dtr: config.dtr !== false, rts: config.rts !== false }
    this.closed = false
    this.failOpen = options.failOpen === true
    FakeBridge.instances.push(this)
  }
  on(event, fn) { this.listeners[event] = fn }
  async open() { if (this.failOpen) throw new Error('fake open failed'); this.opened = true }
  async write(buf) { this.written.push(Buffer.from(buf)) }
  async close() { this.closed = true; this.opened = false; this.listeners.close?.('fake bridge closed') }
  async ping() { return this.opened !== false && this.unplugged !== true }
  async signals() { return { ...this.signalsValue } }
  async setSignals(next) {
    this.signalsValue = { ...this.signalsValue, ...next }
    return { ...this.signalsValue }
  }
  async pulse(line, ms, level) {
    this.pulses.push({ line, ms, level })
    const target = level === undefined ? !this.signalsValue[line] : Boolean(level)
    return { ...this.signalsValue, [line]: target }
  }
  async reconfigure(options) { this.reconfigures.push(options) }
  emitData(bytes) { this.listeners.data?.(Buffer.from(bytes)) }
  unplug(reason = 'USB unplugged') {
    this.unplugged = true
    this.opened = false
    this.listeners.close?.(reason)
  }
}
FakeBridge.instances = []

const portsState = {
  ports: [{ path: 'COM1', name: 'USB-SERIAL CH340 (COM1)', vid: '1A86', pid: '7523', serial: 'SER-1' }],
}
const manager = new CommManager({ maxLogEntries: 200, maxLogBytes: 256 * 1024, aiReplyDebounceMs: 40 })
manager.serialBridgeFactory = (config) => new FakeBridge(config)
manager.serialPortsProvider = async () => ({ available: true, error: null, ports: portsState.ports.map((port) => ({ ...port })) })
manager.reconnectDelayMs = 20
manager.healthCheckMs = 100000

/* 1. open serial with full params */
const opened = await manager.open('serial', {
  path: 'COM1', baudRate: 9600, dataBits: 7, parity: 'even', stopBits: 2,
  flowControl: 'rtscts', dtr: false, rts: false, autoReconnect: true,
})
const linkId = opened.id
const link = manager.linkOrThrow(linkId)
assert(link.config.dataBits === 7, 'dataBits 7')
assert(link.config.parity === 'even', 'parity even')
assert(link.config.stopBits === 2, 'stopBits 2')
assert(link.config.flowControl === 'rtscts', 'flowControl rtscts')
assert(link.config.dtr === false && link.config.rts === false, 'dtr/rts initial levels')
assert(FakeBridge.instances.length === 1, 'one bridge created')
assert(FakeBridge.instances[0].config.path === 'COM1', 'bridge got path')
assert(FakeBridge.instances[0].config.flowControl === 'rtscts', 'bridge got flowControl')
assert(opened.serial.signals.dtr === false, 'snapshot signals')
console.log('serial open with 7E2 + RTS/CTS + DTR/RTS levels: OK')

/* 2. serial defaults persisted, and used when reopening without params */
const settingsFile = join(process.env.DSH_HOME, 'comm-settings.json')
const savedSettings = JSON.parse(readFileSync(settingsFile, 'utf8'))
assert(savedSettings.version === 2, 'settings version 2')
assert(savedSettings.serialDefaults.COM1?.parity === 'even', 'serial defaults persisted')
const manager2 = new CommManager({ uiToken: 'x' })
manager2.serialPortsProvider = async () => ({ available: true, error: null, ports: [{ path: 'COM1' }] })
const ports = await manager2.ports(true)
assert(ports.ports[0].defaults.parity === 'even', 'ports defaults reflect saved params')
assert(ports.ports[0].defaults.baudRate === 9600, 'ports defaults baud')
console.log('serial defaults persisted and exposed by /ports: OK')

/* 3. signals / pulse / configure */
await manager.serialAction(linkId, 'set', { dtr: true })
assert(FakeBridge.instances[0].signalsValue.dtr === true, 'set dtr')
const pulsed = await manager.serialAction(linkId, 'pulse', { line: 'dtr', ms: 50 })
assert(FakeBridge.instances[0].pulses.at(-1).ms === 50, 'pulse recorded')
assert(pulsed.pulseMs === 50, 'pulse reply')
await manager.serialAction(linkId, 'configure', { baudRate: 57600, flowControl: 'none' })
assert(link.config.baudRate === 57600, 'configure updates config')
assert(FakeBridge.instances[0].reconfigures.at(-1).baudRate === 57600, 'reconfigure passed to bridge')
assert(FakeBridge.instances[0].reconfigures.at(-1).flowControl === 'none', 'reconfigure flowControl')
console.log('signals / DTR pulse / configure: OK')

/* 4. auto reconnect, with COM number change matched by USB serial number */
portsState.ports = [{ path: 'COM7', name: 'USB-SERIAL CH340 (COM7)', vid: '1A86', pid: '7523', serial: 'SER-1' }]
FakeBridge.instances[0].unplug('USB unplugged')
assert(link.open === false, 'link closed after unplug')
assert(link.reconnect.active === true, 'reconnect scheduled')
await waitFor(() => link.open && link.config.path === 'COM7', 5000, 'serial reconnect to COM7')
assert(FakeBridge.instances.length >= 2, 'second bridge created')
assert(FakeBridge.instances.at(-1).config.path === 'COM7', 'bridge reopened on new COM number')
assert(manager.snapshot(link).serial.reconnecting === false, 'reconnect flag cleared')
console.log('auto reconnect after unplug (COM1 -> COM7 by serial number): OK')

/* 5. bounded log buffer + drop counters */
const received = 400
for (let i = 0; i < received; i += 1) FakeBridge.instances.at(-1).emitData(Buffer.alloc(1024, i % 255))
const snap = manager.snapshot(link)
assert(snap.rx === received * 1024, 'rx counter counts all bytes')
assert(snap.backlog <= manager.maxLogEntries, `backlog entry cap (${snap.backlog})`)
assert(snap.backlogBytes <= manager.maxLogBytes, `backlog bounded (${snap.backlogBytes})`)
assert(snap.dropped > 0, 'drop counter increments')
assert(snap.droppedBytes > 0, 'droppedBytes increments')
console.log(`bounded buffer: backlog=${snap.backlog}/${manager.maxLogEntries}, backlogBytes=${snap.backlogBytes}, dropped=${snap.dropped}, rx=${snap.rx}: OK`)

/* 6. host timer: periodic + persistence */
const writtenBefore = FakeBridge.instances.at(-1).written.length
const timer = manager.startTimer(linkId, { kind: 'periodic', intervalMs: 15, payload: { text: 'ping' }, repeat: 3 })
assert(timer.running === true, 'periodic timer running')
await waitFor(() => manager.timerState(linkId) === null, 5000, 'periodic timer finishes')
const writtenAfter = FakeBridge.instances.at(-1).written.length
assert(writtenAfter - writtenBefore === 3, `periodic sent 3 times (got ${writtenAfter - writtenBefore})`)
const savedTimer = manager.savedTimer(linkId)
assert(savedTimer?.spec?.kind === 'periodic' && savedTimer.spec.intervalMs === 15, 'timer spec persisted')
console.log('host periodic timer (3 sends) + persistence: OK')

/* 7. host timer: sequence (A, wait 20ms, B) */
const seqBefore = FakeBridge.instances.at(-1).written.length
manager.startTimer(linkId, {
  kind: 'sequence',
  loop: false,
  steps: [{ delayMs: 0, payload: { text: 'A' } }, { delayMs: 20, payload: { text: 'B' } }],
})
await waitFor(() => manager.timerState(linkId) === null, 5000, 'sequence finishes')
const seqWritten = FakeBridge.instances.at(-1).written.slice(seqBefore).map((buf) => buf.toString())
assert(seqWritten.length === 2 && seqWritten[0] === 'A' && seqWritten[1] === 'B', 'sequence order ' + JSON.stringify(seqWritten))
console.log('host sequence timer (A -> 20ms -> B): OK')

/* 8. autostart on reopen (timer settings are keyed by link id) */
manager.saveTimerSpec(linkId, { kind: 'periodic', intervalMs: 1000, payload: { text: 'auto' } }, true)
await manager.close(linkId)
const reopened = await manager.open('serial', { path: 'COM1' })
assert(manager.timerState(reopened.id)?.running === true, 'autostart timer running after reopen')
manager.stopTimer(reopened.id, { quiet: true })
console.log('timer autostart after reopen: OK')

/* 9. writeAndWait over a real TCP loopback (one round trip request/response) */
const server = net.createServer((socket) => {
  socket.on('data', (data) => {
    if (data.toString().includes('PING')) socket.write('PONG-OK')
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const echoPort = server.address().port
const tcpLink = await manager.open('tcpClient', { host: '127.0.0.1', port: echoPort })
const result = await manager.writeAndWait(tcpLink.id, Buffer.from('PING'), { expect: 'PONG', expectTimeoutMs: 2000 })
assert(result.matched === true, 'writeAndWait matched response')
assert(result.waitedMs < 2000, 'writeAndWait returned promptly')
assert(result.entries.some((entry) => entry.text.includes('PONG-OK')), 'writeAndWait returns response entries')
console.log(`writeAndWait round trip: matched=${result.matched}, waitedMs=${result.waitedMs}: OK`)
await manager.close(tcpLink.id)
server.close()

/* 10. auto-reply coalescing: no rules + enabled = one batched AI call */
const batches = []
manager.aiFallback = async (_link, batch) => { batches.push(batch) }
manager.setAuto(linkId, true, 40)
assert(manager.autoDebounceOf(linkId) === 40, 'per-link debounce persisted')
const live = manager.linkOrThrow(reopened.id)
for (let i = 0; i < 5; i += 1) manager.push(live, 'rx', '', Buffer.from(`msg-${i}`))
await waitFor(() => batches.length === 1, 2000, 'one coalesced batch')
assert(batches[0].length === 5, `coalesced 5 messages (got ${batches[0].length})`)
await sleep(150)
assert(batches.length === 1, 'no extra batch after flush')
console.log('auto-reply debounce coalesces 5 messages into 1 injection: OK')

/* tools registration */
const tools = []
const routes = []
const fakeCtx = {
  inject(_names, callback) {
    callback({
      webServer: {
        register(route) { routes.push(route); return () => {} },
        tapIndex() { return () => {} },
        getOrigin() { return '' },
      },
      effect(fn) { return fn() },
    })
  },
  tools: { register(definition) { tools.push(definition) } },
  effect(fn) { return fn() },
}
const { apply } = await import('../lib/index.js')
apply(fakeCtx, { uiToken: 'host-features' })
const names = tools.map((tool) => tool.name)
for (const name of ['comm_list', 'comm_open', 'comm_serial', 'comm_timer', 'comm_write', 'comm_read']) {
  assert(names.includes(name), `tool registered: ${name}`)
}
const openTool = tools.find((tool) => tool.name === 'comm_open')
assert(openTool.parameters.properties.parity?.enum?.includes('even'), 'comm_open exposes parity')
assert(openTool.parameters.properties.flowControl?.enum?.includes('rtscts'), 'comm_open exposes flowControl')
const serialTool = tools.find((tool) => tool.name === 'comm_serial')
assert(serialTool.parameters.properties.action.enum.includes('pulse'), 'comm_serial supports pulse')
const timerTool = tools.find((tool) => tool.name === 'comm_timer')
assert(timerTool.parameters.properties.steps?.type === 'array', 'comm_timer accepts steps array')
console.log('tools (comm_serial / comm_timer / extended comm_open): OK')

await manager.closeAll()
await waitFor(() => FakeBridge.instances.every((bridge) => bridge.closed), 3000, 'bridges closed')
console.log('\nHOST FEATURES TEST PASSED')
