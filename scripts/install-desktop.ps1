# 把 dsh-comm 安装进 DSH Desktop 的 desktop profile。
#
# 为什么需要脚本：Desktop profile 由 Electron 独占，`dsh plugin --profile desktop add`
# 会被 CLI 拒绝；Desktop 的插件窗口通常也只接受 npm 包名。这里直接走 profile 的
# package.json + pnpm，效果等价于手动安装一个第三方 bundle。
#
# 用法（建议先退出 Desktop）：
#   powershell -ExecutionPolicy Bypass -File install-desktop.ps1
#   powershell -ExecutionPolicy Bypass -File install-desktop.ps1 -DshHome D:\path\to\.dsh
#
# 安装后重新启动 DSH Desktop，右栏引导页会出现「通信」。

param(
  [string]$Tarball = (Join-Path $PSScriptRoot "..\dsh-comm-0.1.0.tgz"),
  [string]$DshHome = (Join-Path $env:USERPROFILE ".dsh"),
  [switch]$Force
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Tarball)) {
  throw "找不到插件包：$Tarball（先在插件目录执行 npm pack）"
}
$Tarball = (Resolve-Path -LiteralPath $Tarball).Path

$profile = Join-Path $DshHome "profiles\desktop"
$packagePath = Join-Path $profile "package.json"
if (-not (Test-Path -LiteralPath $packagePath)) {
  throw "找不到 desktop profile：$packagePath"
}

$running = Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue
if ($running -and -not $Force) {
  Write-Host "检测到 DSH Desktop 正在运行。建议先退出应用再安装，避免 node_modules 被占用。" -ForegroundColor Yellow
  Write-Host "确认要继续请加 -Force；或退出应用后重跑本脚本。" -ForegroundColor Yellow
  exit 2
}

$vendorDir = Join-Path $profile "vendor"
New-Item -ItemType Directory -Force $vendorDir | Out-Null
$targetTarball = Join-Path $vendorDir "dsh-comm-0.1.0.tgz"
Copy-Item -LiteralPath $Tarball -Destination $targetTarball -Force

$stamp = Get-Date -Format "yyyyMMddHHmmss"
Copy-Item -LiteralPath $packagePath -Destination "$packagePath.bak-dshcomm-$stamp" -Force
$lockPath = Join-Path $profile "pnpm-lock.yaml"
if (Test-Path -LiteralPath $lockPath) {
  Copy-Item -LiteralPath $lockPath -Destination "$lockPath.bak-dshcomm-$stamp" -Force
}

$node = (Get-Command node -ErrorAction Stop).Source
& $node -e @"
const fs = require('fs')
const file = process.argv[1]
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.dependencies = pkg.dependencies || {}
pkg.dependencies['dsh-comm'] = 'file:./vendor/dsh-comm-0.1.0.tgz'
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
const bundles = pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []
if (!bundles.includes('dsh-comm')) bundles.push('dsh-comm')
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log('package.json updated')
"@ $packagePath

Write-Host "正在安装依赖（pnpm）…" -ForegroundColor Cyan
$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue)
if ($pnpm) {
  & $pnpm.Source --dir $profile install
} else {
  & npx -y pnpm@11 --dir $profile install
}
if ($LASTEXITCODE -ne 0) {
  throw "pnpm install 失败，profile 未完成安装；可用备份 package.json.bak-dshcomm-$stamp 回滚"
}

Write-Host ""
Write-Host "安装完成。" -ForegroundColor Green
Write-Host "请完全退出并重新启动 DSH Desktop（不是只关窗口）。"
Write-Host "启动后：右侧边栏 → 引导页 →「通信」。"
Write-Host "备份：$packagePath.bak-dshcomm-$stamp"
