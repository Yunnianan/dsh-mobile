/**
 * Upload one or more files as GitHub release assets.
 *
 * Why this exists next to `publish-tailscale-release.mjs`: that one is about the Tailscale APK mirror,
 * with its own tag convention and notes. This one is for handing a build to someone — the delivery
 * packages are small enough to attach, and a release asset gives a permanent direct link that needs no
 * account and no email client. Measured reason: this machine has no mail client and no SMTP credentials,
 * so "send it by email" was not possible from here at all.
 *
 * Usage:
 *   NODE_OPTIONS=--use-system-ca GITHUB_TOKEN=gho_… \
 *     node upload-release-assets.mjs --tag dsh-mobile-16.9 \
 *       --name "DSH 手机端 16.9" --file out/a.zip --file out/b.zip [--notes "…"] [--repo …]
 *
 * The same rules as the other publish script:
 *   - the token comes from the environment and is never written to disk;
 *   - an asset of the same name is replaced rather than duplicated (GitHub would otherwise keep both,
 *     and the older download URL would serve the stale file);
 *   - `--dry-run` prints what it would do.
 */

import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { request as httpsRequest } from 'node:https'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf('--' + name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const argAll = (name) => {
  const out = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--' + name && args[i + 1] !== undefined) out.push(args[i + 1])
  }
  return out
}

const token = process.env.GITHUB_TOKEN || ''
const repo = arg('repo', 'Yunnianan/dsh-mobile')
const tag = arg('tag', '')
const title = arg('name', tag)
const notes = arg('notes', '')
const files = argAll('file')
const dryRun = args.includes('--dry-run')

if (token === '') {
  console.error('GITHUB_TOKEN is not set. Export it for this command only; do not write it to a file.')
  process.exit(2)
}
if (tag === '' || files.length === 0) {
  console.error('usage: node upload-release-assets.mjs --tag <tag> --file <path> [--file <path>] …')
  process.exit(2)
}
for (const file of files) {
  try {
    statSync(file)
  } catch {
    console.error('no such file: ' + file)
    process.exit(2)
  }
}

/** One HTTPS request; `host` is overridable because uploads go to a different origin. */
function request(url, options = {}) {
  const target = new URL(url)
  const body = options.body
  const headers = Object.assign({
    'user-agent': 'dsh-mobile-release-upload',
    accept: 'application/vnd.github+json',
    authorization: 'Bearer ' + token
  }, options.headers || {})
  if (body !== undefined && headers['content-length'] === undefined) {
    headers['content-length'] = String(Buffer.byteLength(body))
  }
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      method: options.method || 'GET',
      hostname: target.hostname,
      path: target.pathname + target.search,
      headers
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed
        try { parsed = JSON.parse(text) } catch { parsed = text }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const api = (path, options = {}) => request('https://api.github.com' + path, options)

async function main() {
  console.log('  repo    : ' + repo)
  console.log('  tag     : ' + tag)
  console.log('  files   : ' + files.map((f) => basename(f)).join(', '))
  if (dryRun) {
    console.log('  dry run : nothing uploaded')
    return
  }

  // Reuse the release when the tag already has one: a 422 here means exactly that.
  let release
  const created = await api('/repos/' + repo + '/releases', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: title, body: notes, draft: false })
  })
  if (created.status === 201) {
    release = created.body
    console.log('  release : created')
  } else if (created.status === 422) {
    const existing = await api('/repos/' + repo + '/releases/tags/' + encodeURIComponent(tag))
    if (existing.status !== 200) {
      console.error('  release : cannot create or find — ' + created.status + ' / ' + existing.status)
      process.exit(1)
    }
    release = existing.body
    console.log('  release : reused ' + release.html_url)
  } else {
    console.error('  release : failed ' + created.status + ' ' + JSON.stringify(created.body).slice(0, 300))
    process.exit(1)
  }

  for (const file of files) {
    const assetName = basename(file)
    const existing = (release.assets || []).find((asset) => asset.name === assetName)
    if (existing) {
      // Replaced, not duplicated: GitHub allows two assets with the same name, and the old download URL
      // would then keep serving the previous build.
      const removed = await api('/repos/' + repo + '/releases/assets/' + existing.id, { method: 'DELETE' })
      console.log('  replaced: ' + assetName + ' (delete ' + removed.status + ')')
    }
    const data = readFileSync(file)
    const uploaded = await request(
      'https://uploads.github.com/repos/' + repo + '/releases/' + release.id
        + '/assets?name=' + encodeURIComponent(assetName),
      {
        method: 'POST',
        headers: { 'content-type': 'application/zip', 'content-length': String(data.length) },
        body: data
      }
    )
    if (uploaded.status !== 201) {
      console.error('  asset   : ' + assetName + ' failed ' + uploaded.status
        + ' ' + JSON.stringify(uploaded.body).slice(0, 300))
      process.exit(1)
    }
    console.log('  asset   : ' + assetName + '  ' + Math.round(uploaded.body.size / 1024) + ' KB')
    console.log('            ' + uploaded.body.browser_download_url)
  }
  console.log('  page    : ' + release.html_url)
}

main().catch((error) => {
  console.error('  failed: ' + (error && error.message ? error.message : String(error)))
  process.exit(1)
})
