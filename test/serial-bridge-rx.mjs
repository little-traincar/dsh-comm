// Regression test for the serial bridge RX path (the "can send but never receive" bug):
// spawn the real serial-host.ps1 bridge on one COM port, write bytes into the paired
// port from a separate PowerShell process, and require the bridge to deliver data.
//
// Needs a real or virtual serial port pair:
//   set DSH_COMM_RX_PORT=COM0
//   set DSH_COMM_TX_PORT=COM10
// Without both variables the test skips (exit 0) so the normal suite still works
// on machines without a serial pair.
//
// Run: node test/serial-bridge-rx.mjs
import { spawn } from 'node:child_process'
import { openSerialBridge } from '../lib/serial-windows.js'

const rxPort = String(process.env.DSH_COMM_RX_PORT || '').trim()
const txPort = String(process.env.DSH_COMM_TX_PORT || '').trim()
if (!rxPort || !txPort) {
  console.log('SKIP serial-bridge-rx: set DSH_COMM_RX_PORT and DSH_COMM_TX_PORT to a serial pair (e.g. COM0/COM10)')
  process.exit(0)
}
if (process.platform !== 'win32') {
  console.log('SKIP serial-bridge-rx: Windows only')
  process.exit(0)
}

const bridge = openSerialBridge({
  path: rxPort, baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1,
  flowControl: 'none', dtr: true, rts: true,
})
const chunks = []
bridge.on('data', (buf) => chunks.push(buf))
const bridgeErrors = []
bridge.on('error', (error) => bridgeErrors.push(String(error?.message || error)))
await bridge.open()
console.log('bridge open on', rxPort)

const marker = `RX-REGRESSION-${Date.now()}`
const writerScript = [
  `$p = New-Object System.IO.Ports.SerialPort('${txPort}', 115200, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)`,
  '$p.DtrEnable = $true; $p.RtsEnable = $true',
  '$p.Open()',
  `$b = [System.Text.Encoding]::ASCII.GetBytes('${marker}')`,
  '$p.Write($b, 0, $b.Length)',
  'Start-Sleep -Milliseconds 200',
  '$p.Close(); $p.Dispose()',
].join('; ')
const encoded = Buffer.from(writerScript, 'utf16le').toString('base64')

const writer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true })
let writerOutput = ''
writer.stdout.on('data', (data) => { writerOutput += data.toString() })
writer.stderr.on('data', (data) => { writerOutput += data.toString() })

const deadline = Date.now() + 6000
while (Date.now() < deadline) {
  const text = Buffer.concat(chunks).toString('latin1')
  if (text.includes(marker)) break
  await new Promise((resolve) => setTimeout(resolve, 20))
}
const received = Buffer.concat(chunks).toString('latin1')
try { await bridge.close() } catch { /* ignore */ }
try { writer.kill() } catch { /* ignore */ }

if (!received.includes(marker)) {
  console.error('writer output:', writerOutput.slice(0, 400))
  console.error('bridge errors:', bridgeErrors)
  console.error('received bytes:', Buffer.concat(chunks).length)
  throw new Error(`serial bridge did not receive ${marker} from ${txPort} on ${rxPort}`)
}
console.log(`serial bridge RX OK: ${marker} (${Buffer.concat(chunks).length} bytes)`)
