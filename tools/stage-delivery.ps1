# Mirror the working tree into the delivery packages.
#
# Written because every packaging bug in this project came from copying the tree in pieces: a test
# file missing from one package (its suite reported 10/11 while the repo reported 12/12), a `src`
# copied *into* an existing `src` (`4-*/apk/src/src/...`), a styles file added today and absent from
# every package built since. None of it is visible by looking at the source tree, which is where the
# mistake was made.
#
# Two rules, both learned the hard way:
#
#   1. Delete before copying. `Copy-Item -Recurse` *merges* into an existing directory, so stale
#      files and stale nesting survive every run. Removing first is what makes this a mirror.
#   2. No non-ASCII literals. This file is read as ANSI when it loses its BOM — which any editor that
#      rewrites it will do — and PowerShell then reads `4-源码` as `4-婧愮爜` and creates a *second*
#      package tree under a mojibake name. The stage folders are therefore found by their ASCII
#      prefix numbers at runtime. Keep it that way: a Chinese path in this file is a latent bug.

$ErrorActionPreference = 'Stop'

$root  = 'D:\DSHcode\dsh-mobile'
$stage = "$root\_zipstage"
$full  = 'D:\DSHcode\dsh-mobile-full-stage'
$repo  = "$root\repo"

# Resolve a stage folder by its leading number, so no non-ASCII literal is needed here.
function Get-Stage($number) {
    $hit = Get-ChildItem $full -Directory | Where-Object { $_.Name -like "$number-*" }
    if ($hit.Count -eq 0) { throw "no stage folder for '$number-' under $full" }
    if ($hit.Count -gt 1) {
        # A mojibake twin from an older run. Keep the one whose name is valid, drop the other.
        $keep = $hit | Where-Object { $_.Name -notmatch '[\uFFFD]' } | Select-Object -First 1
        $keep = if ($keep) { $keep } else { $hit[0] }
        foreach ($extra in ($hit | Where-Object { $_.FullName -ne $keep.FullName })) {
            Remove-Item $extra.FullName -Recurse -Force
            Write-Output ("removed duplicate stage {0}" -f $extra.Name)
        }
        return $keep
    }
    return $hit[0]
}

$stageProduct = Get-Stage 1
$stagePlugin  = Get-Stage 2
$stageSource  = Get-Stage 4

function Reset-Dir($path) {
    if (Test-Path $path) { Remove-Item $path -Recurse -Force }
    New-Item -ItemType Directory -Path $path -Force | Out-Null
}

# --- 1. The slim package: APK + plugin + notes ----------------------------------------------
Reset-Dir (Join-Path $stage 'plugin') | Out-Null
foreach ($dir in 'lib', 'test', 'features', 'tools') {
    $from = Join-Path $repo $dir
    if (Test-Path $from) { Copy-Item $from (Join-Path $stage "plugin\$dir") -Recurse -Force }
}
foreach ($file in 'README.md', 'cordis.patch.yml', 'package.json', 'install.mjs', 'LICENSE') {
    $from = Join-Path $repo $file
    if (Test-Path $from) { Copy-Item $from (Join-Path $stage "plugin\$file") -Force }
}

# --- 2. The APK source tree, mirrored whole ------------------------------------------------
$apkFrom = Join-Path $root 'apk'
$apkTo   = Join-Path $stageSource 'apk'
Reset-Dir $apkTo | Out-Null
Copy-Item (Join-Path $apkFrom '*') $apkTo -Recurse -Force

# Removed layouts that put a second source tree in the package: two copies is worse than none,
# because the reader cannot tell which one was built.
foreach ($stale in 'res', 'github-repo', 'apk\src\src') {
    $path = Join-Path $stageSource $stale
    if (Test-Path $path) {
        Remove-Item $path -Recurse -Force
        Write-Output ("removed stale {0}" -f $stale)
    }
}

# --- 3. The build inputs the reader needs to rebuild it ------------------------------------
foreach ($item in 'build-apk.ps1', 'keystore', 'libs') {
    $from = Join-Path $root $item
    if (Test-Path $from) {
        $to = Join-Path $stageSource $item
        Reset-Dir $to | Out-Null
        Copy-Item (Join-Path $from '*') $to -Recurse -Force
    }
}

# --- 4. The plugin, mirrored whole ---------------------------------------------------------
$plugTo = Join-Path $stagePlugin 'dsh-mobile-public'
Reset-Dir $plugTo | Out-Null
Copy-Item (Join-Path $repo '*') $plugTo -Recurse -Force
foreach ($drop in '.git', 'dist') {
    $path = Join-Path $plugTo $drop
    if (Test-Path $path) { Remove-Item $path -Recurse -Force }
}
$libTo = Join-Path $stagePlugin 'lib'
Reset-Dir $libTo | Out-Null
Copy-Item (Join-Path $repo 'lib\*') $libTo -Recurse -Force

# --- 5. Prove what happened ----------------------------------------------------------------
function Count-Of($path, $pattern) {
    if (-not (Test-Path $path)) { return 0 }
    (Get-ChildItem $path -Recurse -File -Filter $pattern -ErrorAction SilentlyContinue).Count
}
Write-Output ("source  java={0} (expected {1})" -f (Count-Of (Join-Path $stageSource 'apk') '*.java'), (Count-Of $apkFrom '*.java'))
Write-Output ("slim    test={0} lib/index.js={1}" -f (Count-Of (Join-Path $stage 'plugin\test') '*.*'), (Test-Path (Join-Path $stage 'plugin\lib\index.js')))
Write-Output ("full    test={0}" -f (Count-Of (Join-Path $plugTo 'test') '*.*'))
Write-Output ("stage folders: {0}, {1}, {2}" -f $stageProduct.Name, $stagePlugin.Name, $stageSource.Name)
