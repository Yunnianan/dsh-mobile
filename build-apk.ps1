# Build a signed release APK for the DSH mobile shell WITHOUT Gradle.
#
# Uses only the Android SDK command-line tools plus a JDK:
#   aapt2 compile/link -> javac -> d8 -> zipalign -> apksigner
#
# This script is written to run from inside a git checkout of the plugin repo,
# where the Android client source sits in `android/` and the vendored decoder in
# `libs/`, while the heavy toolchain (SDK, JDK) is supplied from outside the
# repository. Every path is therefore a parameter with a sensible default:
#
#   repo layout (default):
#     <repo>/android/{src,res,assets,AndroidManifest.xml}   client source
#     <repo>/libs/zxing-core-*.jar                          vendored QR decoder
#     <repo>/out/                                           build output
#     <repo>/keystore/dshmobile.jks                         signing key (NOT in git)
#
# The SDK and JDK are located in `../` by default, which is how this project is
# laid out on a development machine (`dsh-mobile/sdk`, `dsh-mobile/jdk` next to
# `dsh-mobile/repo`). Pass -Sdk/-Jdk to point somewhere else.
#
# Usage:
#   pwsh -File build-apk.ps1 -VersionName 16.9.1 -VersionCode 140
#
# IMPORTANT — the version must be set in TWO places, because aapt2's
# --version-code/--version-name only inject a value when the manifest does NOT
# already declare one. `apk/AndroidManifest.xml` always declares them, so the
# manifest literal wins and a stale one is silently shipped:
#   1. android/AndroidManifest.xml   android:versionCode / android:versionName
#   2. the -VersionCode / -VersionName parameters below (used for the filename)
param(
    # Directory that holds the Android client source (src/res/assets/manifest).
    [string]$Proj,
    # Repository root: where libs/ lives and where out/ and build/ are written.
    [string]$Repo,
    # Android SDK root (must contain platforms/android-36 and build-tools/<v>).
    [string]$Sdk,
    # JDK root (must contain bin/javac.exe).
    [string]$Jdk,
    # Parsed into the APK and used in the output filename. See the note above:
    # the manifest literal also has to be updated by hand.
    [string]$VersionName = "1.1",
    [int]$VersionCode = 2,
    [string]$BuildToolsVersion = "34.0.0",
    [string]$AndroidApiLevel = "36",
    [switch]$Debug
)

# Not 'Stop': these JVM/SDK tools print informational chatter (e.g. "Picked up
# JAVA_TOOL_OPTIONS") to stderr, which PowerShell would otherwise turn into a
# terminating error before we can read the real exit code. Failures are caught
# explicitly via $LASTEXITCODE after every tool call.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# Default layout: this script sits at the repository root.
if (-not $Repo)      { $Repo = $PSScriptRoot }
if (-not $Proj)      { $Proj = Join-Path $Repo 'android' }
if (-not $Sdk)       { $Sdk  = Join-Path (Split-Path $Repo -Parent) 'sdk' }
if (-not $Jdk)       { $Jdk  = Join-Path (Split-Path $Repo -Parent) 'jdk' }

$bt      = Join-Path $Sdk "build-tools\$BuildToolsVersion"
$androidJar = Join-Path $Sdk "platforms\android-$AndroidApiLevel\android.jar"
$out     = Join-Path $Repo 'out'
$build   = Join-Path $Repo 'build'
$libsDir = Join-Path $Repo 'libs'

$javac   = Join-Path $Jdk 'bin\javac.exe'
$keytool = Join-Path $Jdk 'bin\keytool.exe'
$aapt2   = Join-Path $bt  'aapt2.exe'
$d8      = Join-Path $bt  'd8.bat'
$zipalign= Join-Path $bt  'zipalign.exe'
$apksigner = Join-Path $bt 'apksigner.bat'

# d8.bat and apksigner.bat locate a JVM through JAVA_HOME (d8 refuses to run
# without it), and a machine may have no system-wide Java, so point it at the
# supplied JDK for the duration of the build.
$env:JAVA_HOME = $Jdk

# Android 16 (API 36) is the current target level. minSdk 24 keeps older phones
# installable; the app is pure DEX, so 64-bit support follows the device's own
# WebView rather than anything declared here.
$minSdk    = 24
$targetSdk = 36
$pkg       = 'com.dshmobile.app'

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Require($path, $what) {
    if (-not (Test-Path $path)) { throw "$what not found: $path" }
}

foreach ($p in @($javac, $keytool, $aapt2, $d8, $zipalign, $apksigner, $androidJar)) {
    Require $p 'required toolchain component'
}
Require (Join-Path $Proj 'AndroidManifest.xml') 'Android client manifest'

# Fresh build tree
foreach ($d in @($build, $out)) {
    if (Test-Path $d) { Remove-Item $d -Recurse -Force }
}
New-Item -ItemType Directory -Force -Path $build, $out | Out-Null
$compiledRes = Join-Path $build 'compiled'
$genDir      = Join-Path $build 'gen'
$classesDir  = Join-Path $build 'classes'
$dexDir      = Join-Path $build 'dex'
New-Item -ItemType Directory -Force -Path $compiledRes, $genDir, $classesDir, $dexDir | Out-Null

# Keystore (created once, reused for every build so upgrades install over the old app).
#
# Deliberately NOT committed to the repository: holding this key means being able
# to sign an APK that Android accepts as an upgrade over the published one. A
# checkout without it builds fine, but the result is signed by a *different*
# certificate and therefore cannot be installed over a release build — see
# android/README.md.
$ks = Join-Path $Repo 'keystore\dshmobile.jks'
$ksPass = 'dshmobile'
if (-not (Test-Path $ks)) {
    Step "creating signing keystore"
    Write-Host "    no keystore at $ks - generating a fresh self-signed one."
    Write-Host "    This build will NOT be able to upgrade an APK signed with another key."
    New-Item -ItemType Directory -Force -Path (Split-Path $ks) | Out-Null
    & $keytool -genkeypair -v -keystore $ks -storepass $ksPass -keypass $ksPass `
        -alias dshmobile -keyalg RSA -keysize 2048 -validity 10950 `
        -dname "CN=DSH Mobile, OU=Self-signed, O=Local, C=CN" | Out-Null
}

# 1) compile resources
Step "aapt2 compile"
& $aapt2 compile --dir (Join-Path $Proj 'res') -o $compiledRes
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed ($LASTEXITCODE)" }

# 2) link resources + manifest, emitting R.java
Step "aapt2 link"
$unsigned = Join-Path $out 'app-unsigned.apk'
& $aapt2 link `
    -o $unsigned `
    -I $androidJar `
    --manifest (Join-Path $Proj 'AndroidManifest.xml') `
    --java $genDir `
    --min-sdk-version $minSdk `
    --target-sdk-version $targetSdk `
    --version-code $VersionCode --version-name $VersionName `
    --auto-add-overlay `
    -A (Join-Path $Proj 'assets') `
    (Get-ChildItem $compiledRes -Filter *.flat | ForEach-Object { $_.FullName })
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed ($LASTEXITCODE)" }

# 3) compile java (sources + generated R.java)
Step "javac"
# Write-Output keeps each path a separate array element: `$a += (Get-ChildItem ...)`
# collapses multiple matches into one space-joined string, which javac then reads
# as a single bogus filename.
$sources = @()
$sources += Write-Output (Get-ChildItem (Join-Path $Proj 'src') -Recurse -Filter *.java | ForEach-Object { $_.FullName })
$sources += Write-Output (Get-ChildItem $genDir -Recurse -Filter *.java | ForEach-Object { $_.FullName })
if ($sources.Count -lt 2) { throw "expected MainActivity.java and R.java, got: $($sources -join ', ')" }
# Vendored runtime libraries that must be compiled against AND packed into the dex.
# zxing-core provides the QR decoder used by ScanActivity.
$libJars = @(Get-ChildItem $libsDir -Filter *.jar -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName })
$classpath = @($androidJar) + $libJars
if ($libJars.Count -gt 0) { Write-Host "    libs: $(($libJars | ForEach-Object { Split-Path $_ -Leaf }) -join ', ')" }

# android.jar goes on -classpath, NOT -bootclasspath: as a bootclasspath it also
# shadows the JDK's own java.lang.invoke.LambdaMetafactory, and every lambda then
# fails with "cannot find symbol metafactory". D8 desugars lambdas for the device.
& $javac -source 8 -target 8 -encoding UTF-8 `
    -classpath ($classpath -join ';') -d $classesDir $sources 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) { throw "javac failed ($LASTEXITCODE)" }

# 4) dex
Step "d8"
$classFiles = Get-ChildItem $classesDir -Recurse -Filter *.class | ForEach-Object { $_.FullName }
# Library jars go in as additional program inputs so their classes are dexed into
# the APK; putting them only on javac's classpath would compile fine and then fail
# at runtime with NoClassDefFoundError.
$dexInputs = @($classFiles) + $libJars
& $d8 --release --min-api $minSdk --lib $androidJar --output $dexDir $dexInputs 2>&1 | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) { throw "d8 failed ($LASTEXITCODE)" }

# 5) add classes.dex into the APK
Step "packaging classes.dex"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($unsigned, 'Update')
try {
    $dexFile = Join-Path $dexDir 'classes.dex'
    if (-not (Test-Path $dexFile)) { throw "classes.dex missing at $dexFile" }
    $existing = $zip.Entries | Where-Object { $_.FullName -eq 'classes.dex' }
    foreach ($e in $existing) { $zip.Entries.Remove($e) | Out-Null }
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $dexFile, 'classes.dex') | Out-Null
} finally { $zip.Dispose() }

# 6) align then sign
$aligned = Join-Path $out 'app-aligned.apk'
Step "zipalign"
& $zipalign -f -p 4 $unsigned $aligned
if ($LASTEXITCODE -ne 0) { throw "zipalign failed ($LASTEXITCODE)" }

$final = Join-Path $out "dsh-mobile-$VersionName.apk"
Step "apksigner"
& $apksigner sign --ks $ks --ks-pass "pass:$ksPass" --key-pass "pass:$ksPass" `
    --ks-key-alias dshmobile --out $final $aligned
if ($LASTEXITCODE -ne 0) { throw "apksigner sign failed ($LASTEXITCODE)" }

Step "verifying signature"
& $apksigner verify --print-certs $final
if ($LASTEXITCODE -ne 0) { throw "apksigner verify failed ($LASTEXITCODE)" }

$size = [math]::Round((Get-Item $final).Length / 1KB, 1)
Write-Host ""
Write-Host "APK: $final ($size KB)" -ForegroundColor Green
