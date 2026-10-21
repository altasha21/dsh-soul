# dsh-soul 安装脚本（Windows PowerShell 5.1+）
# 用法：右键“使用 PowerShell 运行”，或在解压目录执行：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop
param([string]$Profile = "desktop")

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dshHome = Join-Path $env:USERPROFILE ".dsh"
if ($env:DSH_HOME) { $dshHome = $env:DSH_HOME }
$profilesDir = Join-Path $dshHome "profiles"

if (-not (Test-Path -LiteralPath $profilesDir)) {
  throw "找不到 DSH profiles 目录：$profilesDir（DSH 装了吗？）"
}

$profileDir = Join-Path $profilesDir $Profile
if (-not (Test-Path -LiteralPath $profileDir)) {
  $names = (Get-ChildItem -LiteralPath $profilesDir -Directory | Select-Object -ExpandProperty Name) -join ", "
  throw "profile '$Profile' 不存在。可用：$names"
}

$pkgPath = Join-Path $profileDir "package.json"
if (-not (Test-Path -LiteralPath $pkgPath)) { throw "找不到 $pkgPath" }

$backup = "$pkgPath.bak-soul"
if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $pkgPath -Destination $backup }

$pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json

if ($null -eq $pkg.dependencies) {
  $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
$pkg.dependencies | Add-Member -NotePropertyName "dsh-soul" -NotePropertyValue ("file:" + ($here -replace '\\','/')) -Force

if ($null -eq $pkg.dsh) {
  $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{})
}
if ($null -eq $pkg.dsh.profile) {
  $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{})
}
if ($null -eq $pkg.dsh.profile.bundles) {
  $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @()
}
if ($pkg.dsh.profile.bundles -notcontains "dsh-soul") {
  $pkg.dsh.profile.bundles += "dsh-soul"
}

$json = $pkg | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))

$link = Join-Path $profileDir "node_modules\dsh-soul"
if (-not (Test-Path -LiteralPath $link)) {
  $nm = Split-Path -Parent $link
  if (-not (Test-Path -LiteralPath $nm)) { New-Item -ItemType Directory -Path $nm -Force | Out-Null }
  New-Item -ItemType Junction -Path $link -Target $here | Out-Null
}

Write-Host ""
Write-Host "安装完成：" -ForegroundColor Green
Write-Host "  插件目录：$here"
Write-Host "  已写入：$pkgPath（备份 $backup）"
Write-Host "  链接：$link"
Write-Host ""
Write-Host "现在重启 DSH，然后新建一个会话测试。" -ForegroundColor Yellow
