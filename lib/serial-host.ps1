# dsh-comm serial bridge (Windows / PowerShell 5.1+)
#
# Long-lived process speaking a JSON-lines protocol over stdin/stdout:
#   in : {"id":1,"op":"open","port":"COM21","baud":115200,"dataBits":8,
#         "parity":"None","stopBits":"One","handshake":"None","dtr":true,"rts":true}
#        {"id":2,"op":"write","b64":"..."}
#        {"id":3,"op":"signals"}                    -> {dtr,rts}
#        {"id":4,"op":"set","dtr":false,"rts":true}
#        {"id":5,"op":"pulse","line":"dtr","ms":100,"level":false}
#        {"id":6,"op":"configure","baud":9600,...}  (close + reopen in place)
#        {"id":7,"op":"ping"}
#        {"id":8,"op":"close"}
#   out: {"id":1,"ok":true}
#        {"ev":"data","b64":"..."}
#        {"ev":"error","msg":"..."}
#        {"ev":"closed","msg":"..."}   <- unplug / IO error, Node side reconnects
#
# Design notes:
#   1. Receiving uses SerialPort.Read(byte[]) directly, never string encoding, so
#      binary frames and GBK payloads are never mangled.
#   2. No DataReceived event: it is cross-thread and the old script polled it every
#      15 ms, which loses bytes at high baud rates. The main loop checks BytesToRead
#      every 5 ms and drains it; 921600 baud is comfortably handled.
#   3. DTR/RTS support set + pulse. A pulse restores the old level from the main
#      loop after the requested delay, so it never blocks RX/TX.
#   4. After a USB-serial adapter is unplugged, IsOpen flips false or Read throws.
#      We emit ev=closed and exit; Node reopens (and re-resolves the COM number by
#      VID/PID/serial number).
# NOTE: keep this file pure ASCII (PowerShell 5.1 reads BOM-less .ps1 as ANSI).

$ErrorActionPreference = 'Stop'
try {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = $utf8
  $OutputEncoding = $utf8
} catch { }

function Send-Comm($obj) {
  $json = $obj | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Resolve-Enum($type, $value, $fallback) {
  if ($null -eq $value -or [string]::IsNullOrEmpty([string]$value)) { return $fallback }
  try { return [System.Enum]::Parse($type, [string]$value, $true) } catch { return $fallback }
}

$port = $null
$settings = $null
$running = $true
$closedNotified = $false
$pulse = $null   # @{ line='dtr'|'rts'; until=<DateTime>; restore=<bool> }

function Close-Port() {
  if ($null -ne $port) {
    try { if ($port.IsOpen) { $port.Close() } } catch { }
    try { $port.Dispose() } catch { }
  }
  $port = $null
}

function Open-Port($cfg) {
  Close-Port
  $parity = Resolve-Enum ([System.IO.Ports.Parity]) $cfg.parity ([System.IO.Ports.Parity]::None)
  $stopBits = Resolve-Enum ([System.IO.Ports.StopBits]) $cfg.stopBits ([System.IO.Ports.StopBits]::One)
  $handshake = Resolve-Enum ([System.IO.Ports.Handshake]) $cfg.handshake ([System.IO.Ports.Handshake]::None)
  $dataBits = 8
  if ($null -ne $cfg.dataBits) { $dataBits = [int]$cfg.dataBits }
  $baud = 115200
  if ($null -ne $cfg.baud) { $baud = [int]$cfg.baud }

  $script:port = New-Object System.IO.Ports.SerialPort([string]$cfg.port, $baud, $parity, $dataBits, $stopBits)
  $script:port.Encoding = [System.Text.Encoding]::GetEncoding(28591)
  $script:port.ReadTimeout = 500
  $script:port.WriteTimeout = 2000
  try { $script:port.ReadBufferSize = 16384 } catch { }
  $script:port.Handshake = $handshake
  if ($null -ne $cfg.dtr) { $script:port.DtrEnable = [bool]$cfg.dtr }
  # With RTS/CTS handshake the driver owns RTS; setting it manually makes some
  # drivers throw, so only touch RtsEnable for None / XOnXOff.
  if ($handshake -eq [System.IO.Ports.Handshake]::None -or $handshake -eq [System.IO.Ports.Handshake]::XOnXOff) {
    if ($null -ne $cfg.rts) { $script:port.RtsEnable = [bool]$cfg.rts }
  }
  try { $script:port.Open() } catch {
    Close-Port
    throw
  }
  $script:settings = $cfg
  $script:closedNotified = $false
  $script:pulse = $null
}

function Copy-Settings($base) {
  $next = @{}
  foreach ($key in @('port', 'baud', 'dataBits', 'parity', 'stopBits', 'handshake', 'dtr', 'rts')) {
    if ($null -ne $base -and $base.ContainsKey($key)) { $next[$key] = $base[$key] }
  }
  return $next
}

function Notify-Closed($reason) {
  if ($script:closedNotified) { return }
  $script:closedNotified = $true
  try { Send-Comm @{ ev = 'closed'; msg = [string]$reason } } catch { }
}

$readTask = [Console]::In.ReadLineAsync()

while ($running) {
  # 1) drain every stdin message that has arrived
  while ($readTask.IsCompleted) {
    $line = $null
    try { $line = $readTask.Result } catch { $line = $null }
    if ($null -eq $line) { $running = $false; break }

    $msg = $null
    try { $msg = $line | ConvertFrom-Json } catch {
      Send-Comm @{ id = 0; ok = $false; error = 'invalid json' }
      $readTask = [Console]::In.ReadLineAsync()
      continue
    }

    try {
      switch ([string]$msg.op) {
        'open' {
          Open-Port @{
            port = [string]$msg.port
            baud = $msg.baud
            dataBits = $msg.dataBits
            parity = $msg.parity
            stopBits = $msg.stopBits
            handshake = $msg.handshake
            dtr = $msg.dtr
            rts = $msg.rts
          }
          Send-Comm @{ id = $msg.id; ok = $true }
        }
        'configure' {
          if ($null -eq $port) { throw 'serial port is not open' }
          $next = Copy-Settings $script:settings
          foreach ($key in @('baud', 'dataBits', 'parity', 'stopBits', 'handshake', 'dtr', 'rts')) {
            $value = $msg.$key
            if ($null -ne $value) { $next[$key] = $value }
          }
          Open-Port $next
          Send-Comm @{ id = $msg.id; ok = $true }
        }
        'write' {
          if ($null -eq $port -or -not $port.IsOpen) { throw 'serial port is not open' }
          $bytes = [Convert]::FromBase64String([string]$msg.b64)
          $port.Write($bytes, 0, $bytes.Length)
          Send-Comm @{ id = $msg.id; ok = $true }
        }
        'signals' {
          if ($null -eq $port) { throw 'serial port is not open' }
          Send-Comm @{ id = $msg.id; ok = $true; dtr = [bool]$port.DtrEnable; rts = [bool]$port.RtsEnable }
        }
        'set' {
          if ($null -eq $port) { throw 'serial port is not open' }
          if ($null -ne $msg.dtr) { $port.DtrEnable = [bool]$msg.dtr }
          if ($null -ne $msg.rts -and $port.Handshake -ne [System.IO.Ports.Handshake]::RequestToSend -and $port.Handshake -ne [System.IO.Ports.Handshake]::RequestToSendXOnXOff) {
            $port.RtsEnable = [bool]$msg.rts
          }
          Send-Comm @{ id = $msg.id; ok = $true; dtr = [bool]$port.DtrEnable; rts = [bool]$port.RtsEnable }
        }
        'pulse' {
          if ($null -eq $port) { throw 'serial port is not open' }
          $lineName = [string]$msg.line
          if ($lineName -ne 'dtr' -and $lineName -ne 'rts') { throw 'pulse line must be dtr or rts' }
          if ($lineName -eq 'rts' -and ($port.Handshake -eq [System.IO.Ports.Handshake]::RequestToSend -or $port.Handshake -eq [System.IO.Ports.Handshake]::RequestToSendXOnXOff)) {
            throw 'RTS is owned by the RTS/CTS handshake'
          }
          $ms = 100
          if ($null -ne $msg.ms) { $ms = [int]$msg.ms }
          if ($ms -lt 1) { $ms = 1 }
          if ($ms -gt 5000) { $ms = 5000 }
          if ($lineName -eq 'dtr') { $current = [bool]$port.DtrEnable } else { $current = [bool]$port.RtsEnable }
          $target = -not $current
          if ($null -ne $msg.level) { $target = [bool]$msg.level }
          if ($lineName -eq 'dtr') { $port.DtrEnable = $target } else { $port.RtsEnable = $target }
          $script:pulse = @{ line = $lineName; until = (Get-Date).AddMilliseconds($ms); restore = $current }
          $reply = @{ id = $msg.id; ok = $true; pulseMs = $ms }
          if ($lineName -eq 'dtr') { $reply.dtr = $target; $reply.rts = [bool]$port.RtsEnable } else { $reply.dtr = [bool]$port.DtrEnable; $reply.rts = $target }
          Send-Comm $reply
        }
        'ping' {
          $isOpen = $false
          if ($null -ne $port) { try { $isOpen = $port.IsOpen } catch { $isOpen = $false } }
          Send-Comm @{ id = $msg.id; ok = $true; open = $isOpen }
        }
        'close' {
          Close-Port
          Send-Comm @{ id = $msg.id; ok = $true }
          $running = $false
        }
        default {
          Send-Comm @{ id = $msg.id; ok = $false; error = 'unknown op' }
        }
      }
    } catch {
      Send-Comm @{ id = $msg.id; ok = $false; error = $_.Exception.Message }
    }

    if (-not $running) { break }
    $readTask = [Console]::In.ReadLineAsync()
  }
  if (-not $running) { break }

  # 2) restore a pending pulse level when its delay elapsed
  if ($null -ne $script:pulse -and $null -ne $port) {
    if ((Get-Date) -ge $script:pulse.until) {
      try {
        if ($script:pulse.line -eq 'dtr') { $port.DtrEnable = [bool]$script:pulse.restore }
        elseif ($port.Handshake -ne [System.IO.Ports.Handshake]::RequestToSend -and $port.Handshake -ne [System.IO.Ports.Handshake]::RequestToSendXOnXOff) {
          $port.RtsEnable = [bool]$script:pulse.restore
        }
      } catch { }
      $script:pulse = $null
    }
  }

  # 3) drain RX bytes; on unplug (IsOpen=false / Read throws) emit closed and exit
  if ($null -ne $port) {
    $isOpen = $false
    try { $isOpen = $port.IsOpen } catch { $isOpen = $false }
    if (-not $isOpen) {
      Notify-Closed 'serial port is no longer open'
      Close-Port
      $running = $false
      break
    }
    try {
      $available = $port.BytesToRead
      if ($available -gt 0) {
        $buffer = New-Object byte[] $available
        $read = $port.Read($buffer, 0, $available)
        if ($read -gt 0) {
          if ($read -ne $available) {
            $trimmed = New-Object byte[] $read
            [Array]::Copy($buffer, $trimmed, $read)
            $buffer = $trimmed
          }
          Send-Comm @{ ev = 'data'; b64 = [Convert]::ToBase64String($buffer) }
        }
      }
    } catch {
      Notify-Closed $_.Exception.Message
      Close-Port
      $running = $false
      break
    }
  }

  Start-Sleep -Milliseconds 5
}

Close-Port
