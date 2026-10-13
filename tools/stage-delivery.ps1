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
#   1. Delete before copying, and copy from an explicit file list. `Copy-Item -Recurse` *merges* into
#      an existing directory, and on this host it also left a nested source file one revision behind
#      — the staged `MainActivity.java` was missing 123 lines of the newest changes while every other
#      file matched. Copying file by file from a walk of the source tree removes both problems.
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
        # A mojibake twin from an older run. Drop the ones that do not look like real names.
        $keep = $hit | Where-Object { $_.Name -notmatch '\uFFFD' -and $_.Name -notmatch '\u9351|\u5a11|\u6dec' } | Select-Object -First 1
        if (-not $keep) { $keep = $hit[0] }
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

$utf8 = New-Object System.Text.UTF8Encoding($false)

# Copy one tree over another, file by file, after clearing the destination.
# Skipping anything that still contains an unexpected nested copy is deliberate: a bad mirror should
# fail loudly rather than ship a package whose contents nobody can account for.
function Mirror-Tree($from, $to) {
    if (Test-Path $to) { Remove-Item $to -Recurse -Force }
    New-Item -ItemType Directory -Path $to -Force | Out-Null
    $files = Get-ChildItem $from -Recurse -File -Force
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($from.Length).TrimStart('\')
        $dest = Join-Path $to $rel
        $dir = Split-Path $dest -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Copy-Item $f.FullName $dest -Force
    }
    return $files.Count
}

# --- 1. The slim package: plugin + notes -----------------------------------------------------
if (Test-Path (Join-Path $stage 'plugin')) { Remove-Item (Join-Path $stage 'plugin') -Recurse -Force }
foreach ($dir in 'lib', 'test', 'features', 'tools') {
    $from = Join-Path $repo $dir
    if (Test-Path $from) { Mirror-Tree $from (Join-Path $stage "plugin\$dir") | Out-Null }
}
foreach ($file in 'README.md', 'cordis.patch.yml', 'package.json', 'install.mjs', 'LICENSE') {
    $from = Join-Path $repo $file
    if (Test-Path $from) { Copy-Item $from (Join-Path $stage "plugin\$file") -Force }
}

# --- 2. The APK source tree ------------------------------------------------------------------
Mirror-Tree (Join-Path $root 'apk') (Join-Path $stageSource 'apk') | Out-Null

# A second source tree is worse than none: the reader cannot tell which was built.
foreach ($stale in 'res', 'github-repo', 'apk\src\src') {
    $path = Join-Path $stageSource $stale
    if (Test-Path $path) {
        Remove-Item $path -Recurse -Force
        Write-Output ("removed stale {0}" -f $stale)
    }
}

# --- 3. The build inputs, so the reader can rebuild it ---------------------------------------
foreach ($item in 'build-apk.ps1', 'keystore', 'libs') {
    $from = Join-Path $root $item
    if (Test-Path $from) { Mirror-Tree $from (Join-Path $stageSource $item) | Out-Null }
}

# --- 3b. The built APK, from `out` -----------------------------------------------------------
# Here rather than staged by hand: staging it before the mirror put the file in a folder the mirror
# then reset, producing a product folder with no product and nothing reporting the loss.
if (Test-Path $stageProduct) { Remove-Item $stageProduct -Recurse -Force }
New-Item -ItemType Directory -Path $stageProduct -Force | Out-Null
$newest = Get-ChildItem (Join-Path $root 'out') -Filter 'dsh-mobile-*.apk' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($newest) {
    Copy-Item $newest.FullName $stageProduct -Force
    Write-Output ("product {0}" -f $newest.Name)
} else {
    Write-Output 'WARNING: no APK in out\ - the product folder is empty'
}

# --- 4. The plugin, mirrored whole ------------------------------------------------------------
$plugTo = Join-Path $stagePlugin 'dsh-mobile-public'
Mirror-Tree $repo $plugTo | Out-Null
foreach ($drop in '.git', 'dist') {
    $path = Join-Path $plugTo $drop
    if (Test-Path $path) { Remove-Item $path -Recurse -Force }
}
Mirror-Tree (Join-Path $repo 'lib') (Join-Path $stagePlugin 'lib') | Out-Null

# --- 5. Prove it, by comparing every file rather than counting ---------------------------------
function Compare-Tree($a, $b, $label) {
    $ta = @{}; $tb = @{}
    foreach ($f in Get-ChildItem $a -Recurse -File -Force) {
        $ta[$f.FullName.Substring($a.Length).TrimStart('\')] = $f.FullName
    }
    foreach ($f in Get-ChildItem $b -Recurse -File -Force) {
        $tb[$f.FullName.Substring($b.Length).TrimStart('\')] = $f.FullName
    }
    $missing = @($ta.Keys | Where-Object { -not $tb.ContainsKey($_) })
    $extra   = @($tb.Keys | Where-Object { -not $ta.ContainsKey($_) })
    $diff = @()
    foreach ($k in $ta.Keys) {
        if ($tb.ContainsKey($k)) {
            $ha = (Get-FileHash $ta[$k] -Algorithm SHA256).Hash
            $hb = (Get-FileHash $tb[$k] -Algorithm SHA256).Hash
            if ($ha -ne $hb) { $diff += $k }
        }
    }
    $ok = ($missing.Count -eq 0 -and $extra.Count -eq 0 -and $diff.Count -eq 0)
    Write-Output ("{0,-10} {1}  {2} files  missing={3} extra={4} differing={5}" -f `
        $label, $(if ($ok) { 'OK  ' } else { 'FAIL' }), $ta.Count, $missing.Count, $extra.Count, $diff.Count)
    foreach ($k in $diff) { Write-Output ("           differs: {0}" -f $k) }
    return $ok
}

$all = $true
$all = (Compare-Tree (Join-Path $root 'apk') (Join-Path $stageSource 'apk') 'source') -and $all
$all = (Compare-Tree (Join-Path $repo 'lib') (Join-Path $stagePlugin 'lib') 'plugin') -and $all
$all = (Compare-Tree (Join-Path $repo 'test') (Join-Path $stage 'plugin\test') 'tests') -and $all
if (-not $all) { throw 'staging left the packages inconsistent with the tree' }
Write-Output 'staging consistent'

# --- 6. Zip, in the same run as the mirror ---------------------------------------------------
# Zipping is done here, not by a separate command, because a separate step read files the mirror had
# already replaced in one place and not another: `Compress-Archive` in a later call captured a staged
# `MainActivity.java` that was a revision behind while the comparison in this script — run moments
# earlier — reported every hash matching. One run, one order, no window between them.
$out = Join-Path $root 'out'
$version = 'unknown'
if ($newest) { $version = [System.IO.Path]::GetFileNameWithoutExtension($newest.Name) -replace '^dsh-mobile-', '' }
Get-ChildItem $out -Filter 'dsh-mobile-*.zip' -ErrorAction SilentlyContinue | Remove-Item -Force
$slimZip = Join-Path $out "dsh-mobile-$version-plugin-and-apk.zip"
$fullZip = Join-Path $out "dsh-mobile-$version-full.zip"
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $slimZip -CompressionLevel Optimal
Compress-Archive -Path (Join-Path $full '*') -DestinationPath $fullZip -CompressionLevel Optimal

# Verify the archives against the tree, reading them back rather than trusting the staging folder.
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Compare-ZipEntry($zipPath, $entrySuffix, $sourceFile, $label) {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        $entry = $zip.Entries | Where-Object { $_.FullName.Replace('/', '\').EndsWith($entrySuffix) } | Select-Object -First 1
        if (-not $entry) { Write-Output ("{0,-8} MISSING {1}" -f $label, $entrySuffix); return $false }
        $stream = $entry.Open()
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $zipHash = [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')
        $stream.Close()
        $fileHash = (Get-FileHash $sourceFile -Algorithm SHA256).Hash
        $ok = ($zipHash -eq $fileHash)
        Write-Output ("{0,-8} {1} {2}" -f $label, $(if ($ok) { 'OK  ' } else { 'FAIL' }), $entrySuffix)
        return $ok
    } finally { $zip.Dispose() }
}
$zipOk = $true
$zipOk = (Compare-ZipEntry $fullZip 'apk\src\com\dshmobile\app\MainActivity.java' (Join-Path $root 'apk\src\com\dshmobile\app\MainActivity.java') 'full') -and $zipOk
$zipOk = (Compare-ZipEntry $fullZip 'apk\AndroidManifest.xml' (Join-Path $root 'apk\AndroidManifest.xml') 'full') -and $zipOk
$zipOk = (Compare-ZipEntry $slimZip 'plugin\lib\index.js' (Join-Path $repo 'lib\index.js') 'slim') -and $zipOk
if (-not $zipOk) { throw 'an archive does not match the tree it was built from' }

Write-Output ("slim {0}  {1:N0} bytes" -f (Split-Path $slimZip -Leaf), (Get-Item $slimZip).Length)
Write-Output ("full {0}  {1:N0} bytes" -f (Split-Path $fullZip -Leaf), (Get-Item $fullZip).Length)
