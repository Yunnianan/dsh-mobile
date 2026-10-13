# Tailscale APK mirror

The Android APK is published as a **release asset**, not committed to this repository.

## Why

* Google Play is unreachable from mainland China, and Tailscale's download page sends Android
  visitors there. Without a mirror, a user in China cannot install the one thing that makes the
  plugin useful from outside the house.
* The official universal APK is **100.6 MB**, and a repository refuses any file over 100 MB.
  A release asset allows 2 GB, so the same file fits there.
* There is no smaller official build to use instead: `pkgs.tailscale.com/stable/` ships a single
  universal APK containing four architectures (`arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`). A phone
  uses one of them; the other three are 72 MB of dead weight, but they cannot be removed without
  re-signing, which would make the app un-upgradable over an existing Tailscale install.

## Where

| Item | Value |
|---|---|
| Release | <https://github.com/Yunnianan/dsh-mobile/releases/tag/tailscale-android-1.104.1> |
| Asset | <https://github.com/Yunnianan/dsh-mobile/releases/download/tailscale-android-1.104.1/tailscale-android-universal-1.104.1.apk> |
| Source | <https://pkgs.tailscale.com/stable/tailscale-android-universal-1.104.1.apk> |
| Version | 1.104.1 (universal) |
| Size | 100.6 MB |
| SHA-256 | `B3A1A81B52D1437769E5570C89A95F5824518A6B376D10C39EB64AF213A625B6` |

The mirrored file is the official build, unmodified. Verify it if you like:

```powershell
# Windows
Get-FileHash tailscale-android-universal-1.104.1.apk -Algorithm SHA256
```

```
# Android (Termux) or any shell
sha256sum tailscale-android-universal-1.104.1.apk
```

## How the app uses it

The Tailscale install guide's download button opens the release asset directly
(`TAILSCALE_APK_MIRROR` in `MainActivity.java`), falling back to the official host if no browser can
take the URL. The mirror is tried first because it is **version-pinned**: the bytes a user installs
are the bytes whose SHA-256 is written above, whereas `tailscale-latest.apk` is a moving target.

## Releasing a new version

```powershell
# 1. Download the current APK (the directory listing names it)
Invoke-WebRequest https://pkgs.tailscale.com/stable/ -OutFile listing.html
#    …read the tailscale-android-universal-X.Y.Z.apk name from listing.html
Invoke-WebRequest https://pkgs.tailscale.com/stable/tailscale-android-universal-X.Y.Z.apk `
  -OutFile out\tailscale-android-universal-X.Y.Z.apk

# 2. Publish it as a release asset
$env:GITHUB_TOKEN = '<a token with repo scope>'
$env:NODE_OPTIONS = '--use-system-ca'
node publish-tailscale-release.mjs --apk out\tailscale-android-universal-X.Y.Z.apk

# 3. Update TAILSCALE_APK_MIRROR / TAILSCALE_APK_OFFICIAL in the Android source and rebuild.
```

`publish-tailscale-release.mjs` reads the token from the environment only — never from a file or a
command line, so it cannot leak into a shell history or a transcript. It prints the SHA-256 and the
asset size before uploading, and replaces an asset of the same name rather than attaching a second
copy.

## Licence

Tailscale is a third-party application, licensed by Tailscale Inc. It is redistributed here
unmodified, and only because the setup flow needs a download that works from China. Installing it is
**not** required to use DSH on the same Wi-Fi — it is what makes remote access possible.
