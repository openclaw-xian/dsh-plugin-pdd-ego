# install.ps1 —— 一键安装 dsh-plugin-pdd-ego（装完需重启 DeepSeek Harness）
# 做三件事：
#   1) 复制插件包到 D:/plugins\dsh-plugin-pdd-ego 与 profile 的 node_modules
#   2) profile package.json：加 file: 依赖 + dsh.profile.bundles 条目
#   3) profile cordis.patch.yml：加 insert 条目（兜底）+ config 覆盖
$ErrorActionPreference = 'Stop'

# ⚠️ 2026-11-16 事故后补：profile 的 package.json / cordis.patch.yml 是 JSON/YAML，**不能带 UTF-8 BOM**
#   （DSH 启动时 JSON.parse 读到 BOM 会直接 fatal）。PowerShell 5.1 的 Set-Content -Encoding UTF8 会加 BOM
#   → 统一改用 Write-TextNoBom，并在写后 Assert-NoBom + JSON.parse 复验。
function Write-TextNoBom([string]$path, [string]$text) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $text, $enc)
}

function Assert-NoBom([string]$path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $rest = $bytes[3..($bytes.Length - 1)]
    [System.IO.File]::WriteAllBytes($path, $rest)
    Write-Host "[!] $path 曾有 BOM，已自动剥离"
    return $false
  }
  return $true
}

$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$profile = Join-Path $dshHome 'profiles\desktop'
$pluginLib = 'D:/plugins\dsh-plugin-pdd-ego'
$nmDst = Join-Path $profile 'node_modules\dsh-plugin-pdd-ego'

if (-not (Test-Path $profile)) { throw "找不到 DSH profile：$profile" }

function Copy-Plugin([string]$dst) {
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  foreach ($item in @('lib', 'skill', 'scripts')) {
    Copy-Item (Join-Path $src $item) $dst -Recurse -Force
  }
  foreach ($f in @('package.json', 'cordis.patch.yml', 'README.md')) {
    Copy-Item (Join-Path $src $f) $dst -Force
  }
}

$srcFull = [System.IO.Path]::GetFullPath($src).TrimEnd('\')
$libFull = [System.IO.Path]::GetFullPath($pluginLib).TrimEnd('\')
if ($srcFull -eq $libFull) { Write-Host "[i] 源目录就是 $pluginLib，跳过自身复制" } else { Copy-Plugin $pluginLib }
Copy-Plugin $nmDst
Write-Host "[ok] 插件已复制到 $pluginLib 和 $nmDst"

# ---- profile package.json ----
$pkgPath = Join-Path $profile 'package.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $pkgPath "$pkgPath.bak-ego-$stamp" -Force
Assert-NoBom $pkgPath | Out-Null
$pkg = [System.IO.File]::ReadAllText($pkgPath) | ConvertFrom-Json
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
$pkg.dependencies | Add-Member -NotePropertyName 'dsh-plugin-pdd-ego' -NotePropertyValue 'file:D:/plugins/dsh-plugin-pdd-ego' -Force
if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $pkg.dsh.profile.bundles) { $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force }
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-plugin-pdd-ego') { $bundles += 'dsh-plugin-pdd-ego' }
$pkg.dsh.profile.bundles = $bundles
Write-TextNoBom $pkgPath (($pkg | ConvertTo-Json -Depth 12) + "`r`n")
Assert-NoBom $pkgPath | Out-Null
$jsonCheck = & node -e "const fs=require('fs');const t=fs.readFileSync(process.argv[1],'utf8');JSON.parse(t);console.log('ok')" $pkgPath 2>&1
if ("$jsonCheck".Trim() -ne 'ok') { throw "profile package.json 写坏了（JSON.parse 失败）：$jsonCheck" }
Write-Host "[ok] package.json 已加依赖与 bundles 条目"

# ---- profile cordis.patch.yml ----
$patchPath = Join-Path $profile 'cordis.patch.yml'
Copy-Item $patchPath "$patchPath.bak-ego-$stamp" -Force
Assert-NoBom $patchPath | Out-Null
$txt = [System.IO.File]::ReadAllText($patchPath)
if ($txt -notmatch 'pdd-ego-listing') {
  $add = "`r`n# local ego plugin`r`n- insert:`r`n    - id: pdd-ego-listing`r`n      name: `"dsh-plugin-pdd-ego`"`r`n- id: pdd-ego-listing`r`n  config:`r`n    verbose: false`r`n    allowSubmit: false`r`n"
  Write-TextNoBom $patchPath ($txt.TrimEnd() + $add)
Assert-NoBom $patchPath | Out-Null
  Write-Host "[ok] cordis.patch.yml 已插入 pdd-ego-listing"
} else {
  Write-Host "[i] cordis.patch.yml 已有 pdd-ego-listing，跳过"
}

Write-Host ''
Write-Host '[done] 请重启 DeepSeek Harness。重启后应有：'
Write-Host '  - 技能 pdd-ego-listing'
Write-Host '  - 工具 pdd_ego_spaces / pdd_ego_freight_templates / pdd_ego_set_freight_template / pdd_ego_probe_shop / pdd_ego_run_listing / pdd_ego_build_product / pdd_ego_read_excel'
Write-Host ''
Write-Host '排障：设置环境变量 PDD_EGO_DEBUG=1 后重启；日志默认写系统临时目录（PDD_EGO_LOG 可覆盖）'
