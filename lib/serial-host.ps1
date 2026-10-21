# dsh-comm 串口桥（Windows / PowerShell 5.1+）
#
# 常驻进程，stdin/stdout 走 JSON 行协议：
#   入：{"id":1,"op":"open","port":"COM21","baud":115200,"dataBits":8,"parity":"None","stopBits":1}
#       {"id":2,"op":"write","b64":"..."}
#       {"id":3,"op":"close"}
#   出：{"id":1,"ok":true}
#       {"ev":"data","b64":"..."}
#       {"ev":"error","msg":"..."}
#
# 关键点：用 28591（Latin-1）作为 SerialPort.Encoding，把 0–255 的字节
# 一一映射成字符，再转回 byte[]，避免二进制数据被 UTF-8 解码破坏。

$ErrorActionPreference = 'Stop'
try {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = $utf8
  $OutputEncoding = $utf8
} catch { }

$port = $null
$subscription = $null
$running = $true

function Send-Comm($obj) {
  $json = $obj | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

$readTask = [Console]::In.ReadLineAsync()

while ($running) {
  while ($readTask.IsCompleted) {
    $line = $null
    try { $line = $readTask.Result } catch { $line = $null }
    if ($null -eq $line) { $running = $false; break }

    $msg = $null
    try {
      $msg = $line | ConvertFrom-Json
    } catch {
      Send-Comm @{ id = 0; ok = $false; error = 'invalid json' }
      $readTask = [Console]::In.ReadLineAsync()
      continue
    }

    try {
      switch ([string]$msg.op) {
        'open' {
          if ($null -ne $port) {
            try { $port.Close() } catch { }
            try { $port.Dispose() } catch { }
            $port = $null
          }
          if ($null -ne $subscription) {
            try { Unregister-Event -SourceIdentifier 'dshcomm.serial' -ErrorAction SilentlyContinue } catch { }
            $subscription = $null
          }
          $parity = [System.Enum]::Parse([System.IO.Ports.Parity], [string]$msg.parity, $true)
          $stopBits = [System.Enum]::Parse([System.IO.Ports.StopBits], [string]$msg.stopBits, $true)
          $port = New-Object System.IO.Ports.SerialPort([string]$msg.port, [int]$msg.baud, $parity, [int]$msg.dataBits, $stopBits)
          $port.Encoding = [System.Text.Encoding]::GetEncoding(28591)
          $port.ReadTimeout = 500
          $port.WriteTimeout = 2000
          $port.Open()
          $subscription = Register-ObjectEvent -InputObject $port -EventName DataReceived -SourceIdentifier 'dshcomm.serial'
          Send-Comm @{ id = $msg.id; ok = $true }
        }
        'write' {
          if ($null -eq $port -or -not $port.IsOpen) { throw 'serial port is not open' }
          $bytes = [Convert]::FromBase64String([string]$msg.b64)
          $port.Write($bytes, 0, $bytes.Length)
          Send-Comm @{ id = $msg.id; ok = $true }
        }
        'close' {
          if ($null -ne $subscription) {
            try { Unregister-Event -SourceIdentifier 'dshcomm.serial' -ErrorAction SilentlyContinue } catch { }
            $subscription = $null
          }
          if ($null -ne $port) {
            try { $port.Close() } catch { }
            try { $port.Dispose() } catch { }
            $port = $null
          }
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

    $readTask = [Console]::In.ReadLineAsync()
  }

  if ($null -ne $port -and $port.IsOpen) {
    $events = Get-Event -SourceIdentifier 'dshcomm.serial' -ErrorAction SilentlyContinue
    if ($null -ne $events) {
      foreach ($ev in $events) {
        try {
          $data = $ev.SourceEventArgs.Data
          if ($null -ne $data -and $data.Length -gt 0) {
            $bytes = [System.Text.Encoding]::GetEncoding(28591).GetBytes($data)
            Send-Comm @{ ev = 'data'; b64 = [Convert]::ToBase64String($bytes) }
          }
        } catch {
          Send-Comm @{ ev = 'error'; msg = $_.Exception.Message }
        }
        Remove-Event -EventIdentifier $ev.EventIdentifier -ErrorAction SilentlyContinue
      }
    }
  }

  Start-Sleep -Milliseconds 15
}
