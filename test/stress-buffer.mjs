// Buffer / throughput stress test for dsh-comm (no serial hardware needed).
//   - TCP loopback ingest throughput + byte accounting (no loss between socket and Host)
//   - bounded buffer: memory cap holds, drop counters match
//   - read path integrity: every stored byte round-trips base64 -> exact SHA-256
//   - writeAndWait latency distribution (single round-trip request/response)
// Run: node test/stress-buffer.mjs
import net from 'node:net'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommManager } from '../lib/index.js'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-comm-stress-'))

const MB = 1024 * 1024
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}
async function waitFor(fn, timeout = 30000, label = 'condition') {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await fn()
    if (value) return value
    await sleep(20)
  }
  throw new Error('waitFor timeout: ' + label)
}
const fmtRate = (bytes, ms) => `${(bytes / MB / (ms / 1000)).toFixed(1)} MB/s`

async function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)) })
  })
}

async function openServerLink(manager) {
  const port = await freePort()
  const link = await manager.open('tcpServer', { host: '127.0.0.1', port })
  const client = net.connect({ host: '127.0.0.1', port })
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject) })
  // 模拟设备回显：收到 PING 回 PONG（用于 writeAndWait 延迟测试）
  client.on('data', (data) => { if (data.includes(Buffer.from('PING'))) client.write('PONG-OK') })
  return { link, client }
}

const manager = new CommManager({ maxLogEntries: 2000, maxLogBytes: 4 * MB, maxReadEntries: 200000 })
const { link, client } = await openServerLink(manager)

/* 1. 20 MB ingest with a 4 MB buffer cap: accounting vs drops */
const total1 = 20 * MB
const chunk1 = Buffer.alloc(32 * 1024)
for (let i = 0; i < chunk1.length; i += 1) chunk1[i] = i % 251
const started1 = Date.now()
for (let sent = 0; sent < total1; sent += chunk1.length) {
  if (!client.write(chunk1)) await new Promise((resolve) => client.once('drain', resolve))
}
await waitFor(() => manager.linkOrThrow(link.id).rx >= total1, 60000, 'rx counter reaches 20MB')
const elapsed1 = Date.now() - started1
const snap1 = manager.snapshot(manager.linkOrThrow(link.id))
assert(snap1.rx === total1, `rx accounting exact: ${snap1.rx}`)
assert(snap1.backlogBytes <= manager.maxLogBytes, `backlog bounded: ${snap1.backlogBytes}`)
assert(snap1.dropped > 0 && snap1.droppedBytes > 0, 'drops counted')
console.log(`[1] TCP ingest 20 MB: ${elapsed1} ms (${fmtRate(total1, elapsed1)}), rx=${snap1.rx} B, backlog=${snap1.backlogBytes} B / cap ${manager.maxLogBytes} B, dropped=${snap1.dropped} entries / ${snap1.droppedBytes} B`)

/* 2. read-path integrity: 8 MB through a large buffer, SHA-256 of stored bytes == sent */
const total2 = 8 * MB
const chunk2 = Buffer.alloc(16 * 1024)
for (let i = 0; i < chunk2.length; i += 1) chunk2[i] = (i * 7) % 256
await manager.close(link.id)
const bigManager = new CommManager({ maxLogEntries: 200000, maxLogBytes: 64 * MB, maxReadEntries: 200000 })
const big = await openServerLink(bigManager)
bigManager.clear(big.link.id)
const before2 = bigManager.q
const started2 = Date.now()
const sentHash = createHash('sha256')
for (let sent = 0; sent < total2; sent += chunk2.length) {
  sentHash.update(chunk2)
  if (!big.client.write(chunk2)) await new Promise((resolve) => big.client.once('drain', resolve))
}
await waitFor(() => bigManager.linkOrThrow(big.link.id).rx >= total2, 60000, 'rx 8MB')
const elapsed2 = Date.now() - started2
const read = bigManager.read(big.link.id, { since: before2, limit: 200000 })
const readHash = createHash('sha256')
let readBytes = 0
for (const entry of read.entries) {
  if (entry.dir !== 'rx') continue
  const buf = Buffer.from(entry.hex, 'hex')
  readBytes += buf.length
  readHash.update(buf)
}
assert(readBytes === total2, `read returns all bytes: ${readBytes}`)
assert(readHash.digest('hex') === sentHash.digest('hex'), 'SHA-256 of read bytes matches sent stream (no corruption)')
console.log(`[2] read path 8 MB: ${elapsed2} ms (${fmtRate(total2, elapsed2)}), ${read.entries.length} entries, SHA-256 match, backlog=${bigManager.linkOrThrow(big.link.id).backlogBytes} B`)

/* 3. writeAndWait latency: one tool round trip instead of write + read */
const samples = []
for (let i = 0; i < 200; i += 1) {
  const result = await bigManager.writeAndWait(big.link.id, Buffer.from('PING'), { expect: 'PONG', expectTimeoutMs: 2000 })
  if (!result.matched) throw new Error('writeAndWait missed an echo')
  samples.push(result.waitedMs)
}
samples.sort((a, b) => a - b)
const pick = (p) => samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * p))]
const avg = (samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(2)
console.log(`[3] writeAndWait round trip (TCP loopback echo, n=200): avg=${avg} ms, p50=${pick(0.5)} ms, p95=${pick(0.95)} ms, max=${pick(1)} ms`)
console.log('    (串口实际延迟还要加设备响应时间；关键是「发+等回应」只占一次工具往返，而不是两次 2–5s 的模型往返)')

/* 4. tiny buffer: caps hold, counters stay consistent */
const tinyManager = new CommManager({ maxLogEntries: 200, maxLogBytes: 256 * 1024, maxReadEntries: 200 })
const tiny = await openServerLink(tinyManager)
const total4 = 4 * MB
const started4 = Date.now()
for (let sent = 0; sent < total4; sent += chunk1.length) {
  if (!tiny.client.write(chunk1)) await new Promise((resolve) => tiny.client.once('drain', resolve))
}
await waitFor(() => tinyManager.linkOrThrow(tiny.link.id).rx >= total4, 60000, 'tiny rx 4MB')
const elapsed4 = Date.now() - started4
const snap4 = tinyManager.snapshot(tinyManager.linkOrThrow(tiny.link.id))
assert(snap4.rx === total4, 'tiny rx exact')
assert(snap4.backlogBytes <= tinyManager.maxLogBytes, `tiny backlog bounded ${snap4.backlogBytes}`)
assert(snap4.dropped > 0, 'tiny drops counted')
console.log(`[4] small-buffer stress 4 MB: ${elapsed4} ms (${fmtRate(total4, elapsed4)}), backlog=${snap4.backlog}/${tinyManager.maxLogEntries} entries (${snap4.backlogBytes} B), dropped=${snap4.dropped} entries / ${snap4.droppedBytes} B`)

/* 5. serial fake bridge: 8 MB through the same log pipeline */
class FakeBridge {
  constructor() { this.listeners = {} }
  on(event, fn) { this.listeners[event] = fn }
  async open() {}
  async write() {}
  async close() { this.listeners.close?.('closed') }
  async signals() { return { dtr: true, rts: true } }
  async ping() { return true }
  emitData(bytes) { this.listeners.data?.(Buffer.from(bytes)) }
}
const serialManager = new CommManager({ maxLogEntries: 2000, maxLogBytes: 4 * MB, maxReadEntries: 200000 })
let fake = null
serialManager.serialBridgeFactory = () => { fake = new FakeBridge(); return fake }
serialManager.serialPortsProvider = async () => ({ available: true, error: null, ports: [{ path: 'COM1' }] })
const serialLink = await serialManager.open('serial', { path: 'COM1' })
const total5 = 8 * MB
const started5 = Date.now()
for (let sent = 0; sent < total5; sent += chunk2.length) fake.emitData(chunk2)
const elapsed5 = Date.now() - started5
const snap5 = serialManager.snapshot(serialManager.linkOrThrow(serialLink.id))
assert(snap5.rx === total5, 'serial fake rx exact')
assert(snap5.backlogBytes <= serialManager.maxLogBytes, 'serial backlog bounded')
console.log(`[5] fake serial ingest 8 MB: ${elapsed5} ms (${fmtRate(total5, elapsed5)}), dropped=${snap5.dropped} entries / ${snap5.droppedBytes} B`)

await manager.closeAll()
await bigManager.closeAll()
await tinyManager.closeAll()
await serialManager.closeAll()
for (const item of [client, big.client, tiny.client]) item.destroy()
console.log('\nSTRESS TEST PASSED')
