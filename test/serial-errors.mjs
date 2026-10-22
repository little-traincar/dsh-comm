// Serial write error surfacing: PowerShell Write() failures (timeout / unplugged /
// empty payload) must produce a friendly hint, a system log, and trigger reconnect
// when the port is gone — never a bare "Exception calling Write with 3 arguments".
// Run: node test/serial-errors.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommManager } from '../lib/index.js'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-comm-serial-errors-'))

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, timeout = 5000, label = 'condition') {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await fn()
    if (value) return value
    await sleep(15)
  }
  throw new Error('waitFor timeout: ' + label)
}

class FakeBridge {
  constructor(config) {
    this.config = config
    this.listeners = {}
    this.writes = 0
    this.writeError = null
    this.unplugOnWrite = false
    FakeBridge.instances.push(this)
  }
  on(event, fn) { this.listeners[event] = fn }
  async open() {}
  async write() {
    this.writes += 1
    if (this.writeError) {
      const error = this.writeError
      this.writeError = null
      if (this.unplugOnWrite) {
        this.unplugOnWrite = false
        setTimeout(() => this.listeners.close?.('USB unplugged'), 5)
      }
      throw error
    }
  }
  async close() { this.listeners.close?.('closed') }
  async signals() { return { dtr: true, rts: true } }
  async ping() { return true }
}
FakeBridge.instances = []

const manager = new CommManager({ uiToken: 'x' })
manager.serialBridgeFactory = (config) => new FakeBridge(config)
manager.serialPortsProvider = async () => ({ available: true, error: null, ports: [{ path: 'COM1', serial: 'S1' }] })
manager.reconnectDelayMs = 20
manager.healthCheckMs = 100000

const opened = await manager.open('serial', { path: 'COM1', flowControl: 'rtscts' })
const linkId = opened.id
const link = manager.linkOrThrow(linkId)
const sysTexts = () => manager.read(linkId, { since: 0 }).entries
  .filter((entry) => entry.dir === 'sys')
  .map((entry) => entry.text)

/* 1. WriteTimeout -> friendly hint mentions the flow-control setting, link stays open */
const timeoutError = Object.assign(new Error('The operation has timed out.'), { code: 'Timeout' })
FakeBridge.instances[0].writeError = timeoutError
let timedOut = ''
try {
  await manager.write(linkId, Buffer.from('AA 55', 'hex'))
} catch (error) {
  timedOut = String(error.message)
}
assert(timedOut.includes('写超时'), 'timeout message surfaced: ' + timedOut)
assert(timedOut.includes('flowControl'), 'timeout hint mentions flowControl: ' + timedOut)
assert(link.open === true, 'timeout must not close the link')
assert(sysTexts().some((text) => text.includes('串口发送失败')), 'write failure logged')
console.log('WriteTimeout: friendly hint + sys log, link stays open: OK')

/* 1b. driver "parameter is incorrect" (virtual serial port misconfiguration) */
const paramError = Object.assign(new Error('The parameter is incorrect.'), { code: 'IOException' })
FakeBridge.instances[0].writeError = paramError
let paramMessage = ''
try {
  await manager.write(linkId, Buffer.from('BB'))
} catch (error) {
  paramMessage = String(error.message)
}
assert(paramMessage.includes('参数错误'), 'driver parameter error surfaced: ' + paramMessage)
assert(paramMessage.includes('虚拟串口'), 'parameter error hint mentions virtual serial port: ' + paramMessage)
assert(sysTexts().some((text) => text.includes('串口发送失败')), 'parameter error logged')
console.log('driver "parameter is incorrect": actionable virtual-port hint: OK')

/* 2. empty payload is rejected before touching the bridge */
const writesBefore = FakeBridge.instances[0].writes
let emptyMessage = ''
try {
  await manager.write(linkId, Buffer.alloc(0))
} catch (error) {
  emptyMessage = String(error.message)
}
assert(emptyMessage.includes('发送内容为空'), 'empty payload rejected: ' + emptyMessage)
assert(FakeBridge.instances[0].writes === writesBefore, 'empty payload never reached the bridge')
console.log('empty payload rejected early: OK')

/* 3. repeated failures are throttled: one sys log per second, not one per write */
const logCountBefore = sysTexts().filter((text) => text.includes('串口发送失败')).length
for (let i = 0; i < 3; i += 1) {
  FakeBridge.instances[0].writeError = Object.assign(new Error('The operation has timed out.'), { code: 'Timeout' })
  await manager.write(linkId, Buffer.from('01')).catch(() => {})
}
const logCountAfter = sysTexts().filter((text) => text.includes('串口发送失败')).length
assert(logCountAfter - logCountBefore <= 1, `write failures logged once (got ${logCountAfter - logCountBefore})`)
console.log('repeated write failures logged once per second: OK')

/* 4. disconnected write -> bridge close -> auto reconnect to a fresh bridge */
const firstBridge = FakeBridge.instances[0]
firstBridge.writeError = Object.assign(new Error('The device does not recognize the command.'), { code: 'Disconnected' })
firstBridge.unplugOnWrite = true
let disconnectedMessage = ''
try {
  await manager.write(linkId, Buffer.from('02'))
} catch (error) {
  disconnectedMessage = String(error.message)
}
assert(disconnectedMessage.includes('串口已断开'), 'disconnect message surfaced: ' + disconnectedMessage)
await waitFor(() => link.open === true && FakeBridge.instances.length >= 2, 5000, 'auto reconnect after write disconnect')
assert(FakeBridge.instances.length === 2, 'exactly one reconnect bridge created')
await waitFor(() => sysTexts().some((text) => text.includes('已重新连接')), 3000, 'reconnect logged')
console.log('write IO error -> close -> auto reconnect: OK')

/* 5. write works again on the reconnected bridge */
await manager.write(linkId, Buffer.from('03'))
assert(FakeBridge.instances[1].writes === 1, 'write works after reconnect')
console.log('write after reconnect: OK')

await manager.closeAll()
console.log('\nSERIAL WRITE ERROR TEST PASSED')
