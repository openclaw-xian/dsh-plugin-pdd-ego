# install.ps1 —— 一键安装 dsh-plugin-pdd-ego（装完需重启 DeepSeek Harness）
# 做三件事：
#   1) 复制插件包到 D:/plugins\dsh-plugin-pdd-ego 与 profile 的 node_modules
#   2) profile package.json：加 file: 依赖 + dsh.profile.bundles 条目
#   3) profile cordis.patch.yml：加 insert 条目（兜底）+ config 覆盖
$ErrorActionPreference = 'Stop'

$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$profile = Join-Path $dshHome 'profiles\desktop'
$pluginLib = 'D:/plugins\dsh-plugin-pdd-ego'
$nmDst = Join-Path $profile 'node_modules\dsh-plugin-pdd-ego'

if (-not (Test-Path $profile)) { throw "找不到 DSH profile：$profile" }

function Copy-Plugin([string]$dst) {
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  foreach ($item in @('lib', 'skill')) {
    Copy-Item (Join-Path $src $item) $dst -Recurse -Force
  }
  foreach ($f in @('package.json', 'cordis.patch.yml', 'README.md')) {
    Copy-Item (Join-Path $src $f) $dst -Force
  }
}

Copy-Plugin $pluginLib
Copy-Plugin $nmDst
Write-Host "[ok] 插件已复制到 $pluginLib 和 $nmDst"

# ---- profile package.json ----
$pkgPath = Join-Path $profile 'package.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $pkgPath "$pkgPath.bak-ego-$stamp" -Force
$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
$pkg.dependencies | Add-Member -NotePropertyName 'dsh-plugin-pdd-ego' -NotePropertyValue 'file:D:/plugins/dsh-plugin-pdd-ego' -Force
if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $pkg.dsh.profile.bundles) { $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force }
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-plugin-pdd-ego') { $bundles += 'dsh-plugin-pdd-ego' }
$pkg.dsh.profile.bundles = $bundles
($pkg | ConvertTo-Json -Depth 12) | Set-Content $pkgPath -Encoding UTF8
Write-Host "[ok] package.json 已加依赖与 bundles 条目"

# ---- profile cordis.patch.yml ----
$patchPath = Join-Path $profile 'cordis.patch.yml'
Copy-Item $patchPath "$patchPath.bak-ego-$stamp" -Force
$txt = Get-Content $patchPath -Raw -Encoding UTF8
if ($txt -notmatch 'pdd-ego-listing') {
  $add = "`r`n# local ego plugin`r`n- insert:`r`n    - id: pdd-ego-listing`r`n      name: `"dsh-plugin-pdd-ego`"`r`n- id: pdd-ego-listing`r`n  config:`r`n    verbose: false`r`n"
  Set-Content $patchPath ($txt.TrimEnd() + $add) -Encoding UTF8
  Write-Host "[ok] cordis.patch.yml 已插入 pdd-ego-listing"
} else {
  Write-Host "[i] cordis.patch.yml 已有 pdd-ego-listing，跳过"
}

Write-Host ''
Write-Host '[done] 请重启 DeepSeek Harness。重启后应有：'
Write-Host '  - 技能 pdd-ego-listing'
Write-Host '  - 工具 pdd_ego_spaces / pdd_ego_freight_templates / pdd_ego_set_freight_template / pdd_ego_probe_shop / pdd_ego_run_listing / pdd_ego_build_product / pdd_ego_read_excel'
Write-Host ''
Write-Host '排障：设置环境变量 PDD_EGO_DEBUG=1 后重启，插件会写 D:/egoscripts\pdd-ego-plugin.log'
