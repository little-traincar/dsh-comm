# 从 DSH Desktop 的 desktop profile 卸载 dsh-comm。
#
# 用法（建议先退出 Desktop）：
#   powershell -ExecutionPolicy Bypass -File uninstall-desktop.ps1
#   powershell -ExecutionPolicy Bypass -File uninstall-desktop.ps1 -DshHome D:\path\to\.dsh

param(
  [string]$DshHome = (Join-Path $env:USERPROFILE ".dsh"),
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$profile = Join-Path $DshHome "profiles\desktop"
$packagePath = Join-Path $profile "package.json"
if (-not (Test-Path -LiteralPath $packagePath)) { throw "找不到 desktop profile：$packagePath" }

$running = Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue
if ($running -and -not $Force) {
  Write-Host "检测到 DSH Desktop 正在运行；建议退出后卸载，确认继续请加 -Force。" -ForegroundColor Yellow
  exit 2
}

$stamp = Get-Date -Format "yyyyMMddHHmmss"
Copy-Item -LiteralPath $packagePath -Destination "$packagePath.bak-dshcomm-remove-$stamp" -Force

$node = (Get-Command node -ErrorAction Stop).Source
& $node -e @"
const fs = require('fs')
const file = process.argv[1]
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
if (pkg.dependencies) delete pkg.dependencies['dsh-comm']
const bundles = pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles
if (Array.isArray(bundles)) pkg.dsh.profile.bundles = bundles.filter((name) => name !== 'dsh-comm')
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log('package.json updated')
"@ $packagePath

$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue)
if ($pnpm) {
  & $pnpm.Source --dir $profile install
} else {
  & npx -y pnpm@11 --dir $profile install
}
if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败；可用备份恢复" }

Write-Host "已从 desktop profile 移除 dsh-comm。请重启 DSH Desktop。" -ForegroundColor Green
