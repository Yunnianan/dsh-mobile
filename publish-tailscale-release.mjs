#!/usr/bin/env node
/**
 * Publish the Tailscale Android APK as a GitHub Release asset.
 *
 * Why a release and not a file in the repository: the official universal APK is 100.6 MB, and
 * GitHub refuses files over 100 MB in a repository. The same file is fine as a release asset, whose
 * limit is 2 GB. There is no arm64-only build to fall back on — `pkgs.tailscale.com/stable/` ships
 * one universal APK containing four architectures, of which a phone uses one.
 *
 * Why attach it at all, when the official URL works: the official host is reachable from mainland
 * China, but Google Play is not, and the phone needs something it can actually download and tap.
 * A release asset is also version-pinned, so the file a user installs today is the file this
 * repository documented — `tailscale-latest.apk` is a moving target.
 *
 * The token is read from the environment and never from a file or a command line: it must not end up
 * in a transcript, in a shell history, or in the process list of the machine it runs on.
 *
 * Usage:
 *   NODE_OPTIONS=--use-system-ca GITHUB_TOKEN=gho_… node publish-tailscale-release.mjs \
 *       --apk <path> [--tag tailscale-android-1.104.1] [--repo Yunnianan/dsh-mobile] [--dry-run]
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback = undefined) => {
  const at = args.indexOf('--' + name)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}
const flag = (name) => args.includes('--' + name)

const apkPath = arg('apk')
const repo = arg('repo', 'Yunnianan/dsh-mobile')
const dryRun = flag('dry-run')
const token = process.env.GITHUB_TOKEN || ''

if (apkPath === undefined) {
  console.error('usage: node publish-tailscale-release.mjs --apk <path> [--tag …] [--repo …] [--dry-run]')
  process.exit(2)
}
if (!existsSync(apkPath)) {
  console.error('APK not found: ' + apkPath)
  process.exit(2)
}
if (!dryRun && token === '') {
  console.error('GITHUB_TOKEN is not set. Export it for this command only; do not write it to a file.')
  process.exit(2)
}

const bytes = readFileSync(apkPath)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const sizeMb = bytes.length / 1024 / 1024
const assetName = basename(apkPath)

// e.g. tailscale-android-1.104.1.apk → tailscale-android-1.104.1
const versionMatch = /-(\d+\.\d+\.\d+)\.apk$/.exec(assetName)
const version = versionMatch ? versionMatch[1] : 'unknown'
const tag = arg('tag', 'tailscale-android-' + version)

console.log('  asset   : ' + assetName)
console.log('  size    : ' + sizeMb.toFixed(1) + ' MB')
console.log('  sha256  : ' + sha256.toUpperCase())
console.log('  repo    : ' + repo)
console.log('  tag     : ' + tag)
console.log()

if (sizeMb > 2000) {
  console.error('Over the 2 GB release-asset limit; this should never happen for this file.')
  process.exit(2)
}

/**
 * One GitHub request. `url` in the API branch is a path like `/repos/…`; the uploads host is a
 * different origin (`uploads.github.com`), so the whole URL is accepted there instead.
 */
const request = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.auth === false ? {} : { authorization: 'Bearer ' + token }),
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-mobile-release',
      ...(options.headers || {})
    }
  })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!response.ok) {
    const detail = body && body.message ? body.message : String(text).slice(0, 200)
    const error = new Error('HTTP ' + response.status + ': ' + detail)
    error.status = response.status
    error.body = body
    throw error
  }
  return body
}
const api = (path, options = {}) => request('https://api.github.com' + path, options)

if (dryRun) {
  console.log('  --dry-run: nothing was uploaded.')
  process.exit(0)
}

const notes = [
  'Tailscale for Android, mirrored for users who cannot reach Google Play.',
  '',
  '* Source: <https://pkgs.tailscale.com/stable/' + assetName + '>',
  '* Version: ' + version,
  '* Size: ' + sizeMb.toFixed(1) + ' MB',
  '* SHA-256: `' + sha256.toUpperCase() + '`',
  '',
  'This is the official universal build, unmodified. Tailscale is a third-party application; it is',
  'licensed by Tailscale Inc. and is redistributed here only because the plugin setup guide needs a',
  'download that works from mainland China. Installing it is not required to use DSH on the same',
  'Wi-Fi — it is what makes remote access possible.'
].join('\n')

let release
try {
  release = await api('/repos/' + repo + '/releases', {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, name: 'Tailscale Android ' + version, body: notes, draft: false })
  })
  console.log('  release created: ' + release.html_url)
} catch (error) {
  if (error.status !== 422) throw error
  // 422 is what GitHub answers when the tag already has a release; reuse it.
  const existing = await api('/repos/' + repo + '/releases/tags/' + encodeURIComponent(tag))
  release = existing
  console.log('  release already exists: ' + release.html_url)
}

// Uploading twice would attach a duplicate, so replace an asset of the same name.
for (const asset of release.assets || []) {
  if (asset.name === assetName) {
    console.log('  replacing existing asset ' + asset.name)
    await api('/repos/' + repo + '/releases/assets/' + asset.id, { method: 'DELETE' })
  }
}

const uploadUrl = 'https://uploads.github.com/repos/' + repo
  + '/releases/' + release.id + '/assets?name=' + encodeURIComponent(assetName)
const uploaded = await request(uploadUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/vnd.android.package-archive' },
  body: bytes
})

console.log('  uploaded: ' + uploaded.browser_download_url)
console.log('  state   : ' + uploaded.state + '  (' + (uploaded.size / 1024 / 1024).toFixed(1) + ' MB)')
console.log()
console.log('  Share this link with the phone:')
console.log('    ' + uploaded.browser_download_url)
