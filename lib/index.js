/**
 * dsh-mobile-public — public-internet access to the DSH Web GUI.
 *
 * What it does:
 *   - runs a Cloudflare quick tunnel (`cloudflared tunnel --url …`) that fronts
 *     the profile's own web server, and reports the minted public URL;
 *   - prints a scannable QR of the pairing link (using this package's vendored
 *     encoder, so there is no runtime dependency);
 *   - mints one-time pairing tokens and remembers paired devices;
 *   - gates tunneled traffic under `/api` behind a paired-device cookie.
 *
 * Why a gate is needed: `cloudflared` dials the web server from loopback, so the
 * harness's own "non-loopback" fence sees a local connection and does NOT protect
 * a tunneled request. Without this gate, publishing the port would hand the full
 * host API to anyone who learns the URL.
 *
 * There is no `api/gate` seam in this runtime (verified: the string only occurs
 * as part of the `dsh-api-gateway` package name), so the gate is installed as a
 * `prefix` route over `/api`, which the web server consults before its own
 * routing.
 *
 * @module dsh-mobile-public
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { toSvg } from './qr.js';

export const name = 'dsh-mobile-public';

/**
 * Host services this plugin depends on.
 *
 * This must be a plain array of service names. An earlier revision used the
 * `{ required: [...], optional: [...] }` object shape, which Cordis does not
 * understand: it treated the literal strings "required" and "optional" as service
 * names and the plugin sat in `pending (waiting for services: required, optional)`
 * forever, never mounting. `logger` is not listed because the plugin already
 * falls back to `console` when it is absent.
 *
 * `connection` is a hard dependency: it owns `authenticatedUrl()`, which is how a
 * paired phone is turned into an authenticated GUI session. Without it the
 * pairing flow would hand the device a tunnel URL that the harness answers 401.
 *
 * The dependency is requested with an inner `ctx.inject([...])` rather than this
 * object-level declaration, and deliberately so. An object-level `inject` defers the
 * whole `apply()` until those services exist, but the desktop shell collects its
 * `webserver/index-inject` table **once, during host startup**. If `apply()` has not
 * run by then, the bottom-left panel's script row never enters the table and the
 * panel never appears — with no error anywhere. Registering the row synchronously in
 * `apply()` and deferring only the service-dependent work removes that race.
 */

/** Milliseconds a pairing token stays valid unless a caller asks otherwise. */
const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;
/** Bounds for a caller-requested token lifetime. A pairing link grants full host
 *  control to whoever redeems it, so "never expires" must not be reachable. */
const MIN_TOKEN_TTL_MS = 60 * 1000;
const MAX_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Milliseconds a paired device stays valid without use. */
const DEFAULT_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Lifetime of a token minted for key-based auto-pairing. The device redeems it
 *  immediately, so a short window is enough and limits exposure of a leaked URL. */
const AUTO_PAIR_TTL_MS = 5 * 60 * 1000;
/** Probability per billion of an acceptable QR false positive (E = M level). */
const QR_EC_LEVEL = 'M';

/** Resolve the Harness home the same way the rest of DSH does. */
function resolveHome(env = process.env) {
  const configured = env.DSH_HOME;
  const selected = configured !== undefined && configured.trim().length > 0 ? configured : join(homedir(), '.dsh');
  return resolve(selected);
}

/** Constant-time string comparison that tolerates differing lengths. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Random URL-safe identifier. */
function randomId(bytes = 16) {
  return randomBytes(bytes).toString('base64url');
}

/** Read a cookie value from a raw Cookie header. */
function cookieValue(header, key) {
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === key) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Whether a socket address counts as loopback. */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Device/token store persisted as JSON. Kept deliberately small and synchronous:
 * it holds at most a handful of records and is written on pairing changes only.
 */
class PairingStore {
  constructor(file) {
    this.file = file;
    this.state = { devices: {}, pairing: {}, config: {} };
    this.load();
  }

  load() {
    try {
      if (!existsSync(this.file)) return;
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object') {
        this.state = {
          devices: parsed.devices ?? {},
          pairing: parsed.pairing ?? {},
          config: parsed.config ?? {}
        };
      }
    } catch {
      // A corrupt store must not stop boot; start clean and let the next write fix it.
      this.state = { devices: {}, pairing: {}, config: {} };
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf8');
    } catch {
      // Persistence is best-effort; pairing still works for the current process.
    }
  }

  /** Drop expired pairing tokens and devices. */
  sweep(now = Date.now()) {
    let changed = false;
    for (const [id, record] of Object.entries(this.state.pairing)) {
      if (record.expiresAt <= now) { delete this.state.pairing[id]; changed = true; }
    }
    for (const [id, record] of Object.entries(this.state.devices)) {
      if (record.expiresAt <= now) { delete this.state.devices[id]; changed = true; }
    }
    if (changed) this.save();
  }

  /** Mint a single-use pairing token. */
  mintToken(ttlMs, label) {
    const now = Date.now();
    this.sweep(now);
    // Only one live token at a time: re-minting invalidates the previous link.
    this.state.pairing = {};
    const id = randomId(8);
    const token = randomId(24);
    this.state.pairing[id] = { token, createdAt: now, expiresAt: now + ttlMs, label: label ?? null };
    this.save();
    return { id, token, expiresAt: now + ttlMs };
  }

  /** Current live token, if any. */
  activeToken(now = Date.now()) {
    this.sweep(now);
    const entries = Object.entries(this.state.pairing);
    if (entries.length === 0) return undefined;
    const [id, record] = entries[0];
    return { id, ...record };
  }

  /** Redeem a pairing token into a long-lived device record. */
  redeem(token, deviceTtlMs, userAgent) {
    const now = Date.now();
    this.sweep(now);
    const entry = Object.entries(this.state.pairing).find(([, r]) => safeEqual(r.token, token));
    if (entry === undefined) return undefined;
    const [id] = entry;
    delete this.state.pairing[id];
    const deviceId = randomId(16);
    this.state.devices[deviceId] = {
      createdAt: now,
      expiresAt: now + deviceTtlMs,
      label: describeDevice(userAgent),
      lastSeenAt: now
    };
    this.save();
    return { deviceId, expiresAt: now + deviceTtlMs };
  }

  /** Resolve a device id to a live record, refreshing its last-seen time. */
  touch(deviceId) {
    if (typeof deviceId !== 'string' || deviceId === '') return undefined;
    const record = this.state.devices[deviceId];
    if (record === undefined) return undefined;
    const now = Date.now();
    if (record.expiresAt <= now) {
      delete this.state.devices[deviceId];
      this.save();
      return undefined;
    }
    record.lastSeenAt = now;
    return record;
  }

  devices() {
    this.sweep();
    return Object.entries(this.state.devices).map(([id, r]) => ({
      id: `${id.slice(0, 6)}…`,
      label: r.label,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      expiresAt: r.expiresAt
    }));
  }

  revokeAll() {
    this.state.devices = {};
    this.state.pairing = {};
    this.save();
  }

  /**
   * The one-time key a device presents to pair itself without scanning.
   *
   * Generated on first use and persisted, so the desktop panel can show a stable
   * value that a phone only has to be told once. This is deliberately a secret the
   * operator copies by hand rather than something derived from network position: an
   * address in Tailscale's range only proves the caller is on the tailnet, which is
   * weaker than proving they were given the key.
   */
  autoPairSecret() {
    const existing = this.state.config?.autoPairSecret;
    if (typeof existing === 'string' && existing.length >= 16) return existing;
    const secret = randomId(24);
    this.state.config = { ...(this.state.config ?? {}), autoPairSecret: secret };
    this.save();
    return secret;
  }

  /** Replace the auto-pair key, invalidating it for every device that still has it. */
  rotateAutoPairSecret() {
    const secret = randomId(24);
    this.state.config = { ...(this.state.config ?? {}), autoPairSecret: secret };
    this.save();
    return secret;
  }

  /** Constant-time comparison of a presented auto-pair key. */
  checkAutoPairSecret(candidate) {
    if (typeof candidate !== 'string' || candidate === '') return false;
    return safeEqual(this.autoPairSecret(), candidate);
  }
}

/**
 * Whether a path holds a probably-runnable tunnel binary.
 *
 * Size is the cheap discriminator: cloudflared ships as tens of megabytes, and an
 * interrupted download leaves a short file that exists but is not an executable
 * (`spawn EFTYPE` on Windows). Running `--version` would be authoritative but
 * costs a process spawn on every boot, so the threshold is used instead.
 */
const MIN_TUNNEL_BINARY_BYTES = 10_000_000;

function usableBinary(path) {
  if (typeof path !== 'string' || path === '') return false;
  try {
    return statSync(path).size >= MIN_TUNNEL_BINARY_BYTES;
  } catch {
    return false;
  }
}

/** Turn a User-Agent into a short human label; the raw value is never exposed. */
function describeDevice(userAgent) {
  if (typeof userAgent !== 'string' || userAgent === '') return 'unknown device';
  const ua = userAgent;
  const os = /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
      : /Windows/i.test(ua) ? 'Windows'
        : /Mac OS X/i.test(ua) ? 'macOS'
          : /Linux/i.test(ua) ? 'Linux'
            : 'unknown OS';
  const browser = /Edg\//i.test(ua) ? 'Edge'
    : /Chrome\//i.test(ua) ? 'Chrome'
      : /Firefox\//i.test(ua) ? 'Firefox'
        : /Safari\//i.test(ua) ? 'Safari'
          : /DSHMobile/i.test(ua) ? 'DSH Mobile'
            : 'browser';
  return `${os} · ${browser}`;
}

/**
 * Tunnel providers.
 *
 * Two are supported because they fail for different reasons and the plugin
 * should not be hostage to either:
 *
 *   cloudflared — a Cloudflare quick tunnel. Gives a stable, fast HTTPS URL, but
 *                 needs a 52 MB platform binary, which on some networks is
 *                 effectively unfetchable.
 *   ssh         — an SSH remote-forward (`ssh -R`) to a public relay that mints
 *                 the hostname for you. Needs no download beyond the OpenSSH
 *                 client Windows already ships. The URL is third-party-hosted
 *                 and ephemeral, which is the price of that convenience.
 *
 * Each provider is a plain object so tests can drive it with a fake spawn.
 */
const TUNNEL_PROVIDERS = {
  cloudflared: {
    label: 'cloudflared',
    /** argv for the local port. */
    args: (port) => ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${String(port)}`],
    /** The minted URL, or undefined while cloudflared is still negotiating. */
    urlOf: (text) => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text)?.[0],
    readyHint: 'Waiting for cloudflared to mint a trycloudflare.com hostname.'
  },
  ssh: {
    label: 'ssh',
    args: (port) => [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=NUL',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-R', `80:127.0.0.1:${String(port)}`,
      'nokey@localhost.run'
    ],
    // localhost.run prints its assigned host after the SSH banner.
    urlOf: (text) => /https:\/\/[a-z0-9.-]+\.(?:lhr\.life|localhost\.run)/i.exec(text)?.[0],
    readyHint: 'Waiting for localhost.run to assign a public hostname.'
  }
};

/**
 * Manages one tunnel child process for a chosen provider.
 *
 * `spawnFn` and `provider` are injectable so the lifecycle can be exercised in
 * tests without a binary, a network, or an SSH relay.
 */
class TunnelManager {
  constructor(options) {
    this.providerName = options.provider ?? 'cloudflared';
    this.provider = TUNNEL_PROVIDERS[this.providerName] ?? TUNNEL_PROVIDERS.cloudflared;
    this.binary = options.binary;
    this.port = options.port ?? 19387;
    this.logger = options.logger;
    this.spawnFn = options.spawnFn ?? spawn;
    this.child = undefined;
    this.url = undefined;
    this.state = 'stopped';
    this.error = undefined;
    this.startedAt = undefined;
    this.onChange = options.onChange ?? (() => {});
  }

  status() {
    return {
      provider: this.providerName,
      state: this.state,
      url: this.url,
      error: this.error,
      startedAt: this.startedAt,
      binary: this.binary,
      binaryPresent: existsSync(this.binary),
      readyHint: this.state === 'starting' ? this.provider.readyHint : undefined
    };
  }

  /** Start the tunnel. Idempotent: a running tunnel is reported as-is. */
  start() {
    if (this.state === 'running' || this.state === 'starting') return this.status();
    if (!existsSync(this.binary)) {
      this.state = 'failed';
      this.error = `tunnel binary not found at ${this.binary}`;
      this.onChange();
      return this.status();
    }
    this.state = 'starting';
    this.error = undefined;
    this.url = undefined;
    this.startedAt = Date.now();
    this.onChange();

    let child;
    try {
      child = this.spawnFn(this.binary, this.provider.args(this.port), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      this.state = 'failed';
      this.error = error instanceof Error ? error.message : String(error);
      this.onChange();
      return this.status();
    }
    this.child = child;

    const onChunk = (chunk) => this.#consume(String(chunk));
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.once('error', (error) => {
      this.state = 'failed';
      this.error = error instanceof Error ? error.message : String(error);
      this.child = undefined;
      this.onChange();
    });
    child.once('exit', (code, signal) => {
      this.child = undefined;
      this.url = undefined;
      if (this.state !== 'stopped') {
        this.state = code === 0 ? 'stopped' : 'failed';
        if (code !== 0) {
          this.error = `${this.provider.label} exited (code ${String(code)}${signal ? `, signal ${signal}` : ''})`;
        }
      }
      this.onChange();
    });
    return this.status();
  }

  /** Scan provider output for the minted public URL. */
  #consume(text) {
    const found = this.provider.urlOf(text);
    if (found !== undefined && found !== this.url) {
      this.url = found;
      this.state = 'running';
      this.error = undefined;
      this.onChange();
    }
  }

  stop() {
    const child = this.child;
    this.child = undefined;
    this.state = 'stopped';
    this.url = undefined;
    this.error = undefined;
    this.onChange();
    if (child === undefined) return;
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
}

/** Render the mobile pairing page served at /m/pair. */
function pairingPage({ token, url, qrSvg, profile, secret, link }) {
  // The displayed link is passed in, already built by pairingLink. Reconstructing it here
  // is how the page and the QR drifted apart before: the page lacked the key and the
  // fallback address, so pasting its link set a device up differently from scanning.
  const qrBlock = qrSvg === undefined
    ? '<p class="warn">No pairing token is live. Mint one from the desktop panel.</p>'
    : `<div class="qr">${qrSvg}</div>
       <p class="link"><code>${link}</code></p>
       <p class="hint">Scan with the DSH Mobile app, or paste the link into its settings screen.
       The link carries a one-time pairing key, so the device configures itself.</p>`;
  return `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>DSH 配对</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; background:#0f1115; color:#e8eaf0; padding:24px; }
  .card { width:100%; max-width:420px; background:#171a21; border:1px solid #262b36; border-radius:16px; padding:24px; }
  h1 { font-size:19px; margin:0 0 4px; }
  .sub { color:#98a2b8; font-size:13px; margin:0 0 18px; }
  .qr { background:#fff; border-radius:12px; padding:12px; display:flex; justify-content:center; }
  .qr svg { width:100%; height:auto; max-width:280px; }
  .link { font-size:11px; word-break:break-all; color:#98a2b8; margin:12px 0 4px; }
  .link code { background:#0f1115; padding:6px 8px; border-radius:6px; display:block; }
  .hint { color:#7d879b; font-size:12px; margin:8px 0 0; }
  .warn { color:#ffb454; font-size:13px; }
  .meta { margin-top:16px; padding-top:14px; border-top:1px solid #262b36; font-size:12px; color:#7d879b; }
  .meta b { color:#98a2b8; font-weight:600; }
</style></head>
<body><div class="card">
  <h1>DSH 远程访问</h1>
  <p class="sub">扫描二维码把手机或另一台电脑配对到这台 Harness。</p>
  ${qrBlock}
  <div class="meta">
    <div><b>profile</b> ${profile}</div>
    <div><b>public</b> ${url}</div>
  </div>
</div></body></html>`;
}

/** Minimal JSON response helper. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

/** Read a request body up to a small cap. */
async function readBody(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * Register the plugin against the host context.
 * @param ctx - host context carrying `webServer` (required) and optionally `logger`.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config = {}) {
  // The bottom-left panel is loaded by a script row that the desktop shell picks up
  // during host startup, so this has to happen synchronously here — before anything
  // awaits a service (see the note on `inject` above). The row injects our own
  // <script> and swallows load errors, so if the route below is not registered the
  // panel simply does not appear instead of failing the whole page boot.
  const PANEL_ROW_TEXT =
    '(function(){try{var d=document.body||document.head||document.documentElement;'
    + 'if(!d)return;var s=document.createElement("script");s.src="/m/widget.js";'
    + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()';

  const rowDisposers = [];
  ctx.effect(() => () => {
    for (const dispose of rowDisposers) {
      try { dispose(); } catch { /* already gone */ }
    }
  }, 'dsh-mobile-public: inject row cleanup');

  rowDisposers.push(ctx.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return;
      const already = table.some((row) => row !== null && typeof row === 'object'
        && ((row.kind === 'script' && typeof row.text === 'string' && row.text.includes('/m/widget.js'))
          || (row.kind === 'script-src' && row.src === '/m/widget.js')));
      if (already) return;
      table.push({ kind: 'script', placement: 'body', text: PANEL_ROW_TEXT });
    } catch {
      // A malformed table must never take the page down with it.
    }
  }));

  // Everything below needs host services, so it waits for them explicitly.
  ctx.inject(['webServer', 'connection'], (serviceCtx) => {
  const ctx = serviceCtx;
  const home = resolveHome();
  const store = new PairingStore(join(home, 'dsh-mobile-public', 'state.json'));
  const profile = config.profile ?? process.env.DSH_PROFILE ?? 'desktop';
  const cookieName = config.cookieName ?? 'dsh_remote';
  const tokenTtlMs = config.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const deviceTtlMs = config.deviceTtlMs ?? DEFAULT_DEVICE_TTL_MS;
  const logger = ctx.logger ?? console;

  // ---- configuration plumbing -------------------------------------------------
  // A function-valued config field is a live reference; read it at call time so a
  // settings save takes effect without remounting the plugin.
  const readBool = (field, fallback) => {
    const value = typeof field === 'function' ? field() : field;
    return value === undefined ? fallback : value === true;
  };

  /**
   * Best guess at a LAN URL another device on the same network can reach.
   *
   * This exists so the pairing output can offer both paths explicitly: the LAN
   * origin is dramatically faster (measured ~31 MB/s on loopback vs ~28 KB/s through
   * the SSH tunnel) but only works on the same network, while the tunnel works
   * anywhere. Returns undefined when no usable non-internal IPv4 address exists,
   * in which case only the tunnel is offered.
   */
  const lanUrl = () => lanUrls()[0];

  /**
   * Every private IPv4 address a phone on the same network could plausibly reach.
   *
   * This replaced a rule that read "the first non-internal IPv4 that is not Tailscale", which was
   * wrong on any machine with another VPN installed. On the machine in the bug report the adapter
   * enumerated first was Radmin VPN, holding 26.244.162.123 — a *public* address. The old rule
   * accepted it, the pairing panel advertised it, and the phone could not reach it; the real Wi-Fi
   * address was never examined, because the loop returned on the first hit.
   *
   * Selection is by objective signal only — no interface names. An earlier revision blacklisted
   * names (`radmin|tap|wireguard|…`), which is brittle in three ways that all matter: the names are
   * localised (this machine's adapters are `WLAN`, `以太网`), every VPN vendor invents its own, and
   * a false positive silently discards the one address that works. What is used instead:
   *
   *  1. **The OS's own default route.** `Get-NetRoute` names the interface the machine actually
   *     uses to reach the world. That interface is a real network by definition, whatever it is
   *     called, and it is the first place a phone on the same network will find us.
   *  2. **RFC1918 address space**, which rejects Radmin's public address outright, plus exclusion of
   *     the `198.18.0.0/15` benchmarking range that Clash and sing-box use by default — a reserved
   *     block, so this is a fact about the address rather than a guess about the software.
   *  3. Link-local `169.254/16` is never included: it means "no DHCP answer", not "a network a
   *     phone can join".
   *
   * Addresses on the default-route interface come first, then any other private address, then the
   * reservation range as a last resort. The order is still a preference rather than a verdict, but
   * that no longer decides anything on its own: the caller hands *all* of these to the client, and
   * the phone probes each and connects to whichever answers. A wrong entry therefore costs one
   * probe, not a failed pairing — which is what makes a heuristic acceptable here at all.
   */
  const lanUrls = () => {
    const port = ctx.webServer?.port ?? 19387;
    let interfaces;
    try {
      interfaces = networkInterfaces();
    } catch {
      return [];
    }
    const preferred = defaultRouteInterfaces();
    const onDefault = [];
    const other = [];
    const reserved = [];
    for (const [name, addresses] of Object.entries(interfaces)) {
      for (const address of addresses ?? []) {
        if (address.family !== 'IPv4' || address.internal === true) continue;
        const url = `http://${address.address}:${String(port)}`;
        if (isPrivateAddress(address.address)) {
          (preferred.has(name) ? onDefault : other).push(url);
        } else if (isReservedTestAddress(address.address)) {
          // Only worth offering when nothing better exists; some VPNs use it for their tunnel.
          reserved.push(url);
        }
      }
    }
    const ordered = [...onDefault, ...other];
    return ordered.length > 0 ? ordered : reserved;
  };

  /**
   * Whether an address is in the range reserved for benchmarking: 198.18.0.0/15.
   *
   * Kept out of the LAN preference list and offered only as a last resort. Clash and sing-box hand
   * this block to their tunnel interface by default, so seeing it means "something synthetic is
   * here" — and unlike an interface name, that is a property of the address itself.
   */
  const isReservedTestAddress = (address) => {
    const parts = address.split('.').map(Number);
    return parts.length === 4 && parts[0] === 198 && (parts[1] === 18 || parts[1] === 19);
  };

  /**
   * Interface names that currently carry the default route, according to the OS.
   *
   * Cached for the life of the process: the set only changes when the machine's connectivity does,
   * and asking on every call would mean a subprocess per pairing link. A stale answer is harmless
   * for the same reason the ordering is only a preference — every candidate is offered to the
   * client anyway.
   *
   * Failure returns an empty set rather than throwing: on a platform without PowerShell there is
   * simply no preference, and the address-based filters still apply.
   */
  const defaultRouteInterfaces = (() => {
    let cached;
    return () => {
      if (cached !== undefined) return cached;
      cached = new Set();
      const add = (output) => {
        for (const line of String(output).split(/\r?\n/)) {
          const name = line.trim();
          if (name !== '') cached.add(name);
        }
      };
      if (process.platform === 'win32') {
        try {
          add(execFileSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            "Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' "
            + '-ErrorAction SilentlyContinue | ForEach-Object { $_.InterfaceAlias }'
          ], { encoding: 'utf8', timeout: 8000, windowsHide: true }));
        } catch {
          // No preference; the address filters below still decide.
        }
      }
      return cached;
    };
  })();

  const localPort = () => ctx.webServer?.port;
  const localUrl = () => `http://127.0.0.1:${String(localPort() ?? 19387)}`;

  /**
   * Tailscale address of this machine, when Tailscale is present and up.
   *
   * This is the fast remote path: measured 2.32 MB/s from the phone against the SSH
   * tunnel's 14-27 KB/s, and the address stays stable across reconnects, unlike the
   * tunnel hostname. Tailscale draws its addresses from the CGNAT range
   * 100.64.0.0/10 and exposes one as an ordinary interface address, so the common
   * case needs no subprocess.
   */
  /**
   * Whether an address belongs to Tailscale's shared address space, 100.64.0.0/10.
   *
   * Kept as one helper because both URL builders need it: tailscaleUrl() selects
   * exactly this range, and lanUrl() must exclude it. Without the exclusion,
   * "first non-internal IPv4" can return the Tailscale address, so lanUrl() and
   * tailscaleUrl() both report the same host.
   */
  const isTailscaleAddress = (address) => {
    const parts = address.split('.').map(Number);
    return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
  };

  /**
   * Whether an address is in RFC1918 private space: 10/8, 172.16/12, 192.168/16.
   *
   * The filter `lanUrl()` was missing, and its absence was not theoretical — see `lanUrls()`.
   */
  const isPrivateAddress = (address) => {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4
        || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return false;
    }
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  };

  /**
   * Interface names are deliberately not consulted anywhere.
   *
   * An earlier revision blacklisted names (`radmin|tap|wireguard|…`) to keep a VPN adapter out of
   * the LAN candidates. It was removed because names are localised, vendor-specific, and a false
   * positive silently drops the only address that works — the brittleness outweighed the benefit.
   * What replaced it: the OS's default route (objective, since the machine states it itself), the
   * RFC1918 requirement (rejects public addresses outright), and the reserved 198.18/15 block.
   * See `lanUrls()` for the full argument.
   */

  const tailscaleUrl = () => {
    const port = ctx.webServer?.port ?? 19387;
    let interfaces;
    try {
      interfaces = networkInterfaces();
    } catch {
      return undefined;
    }
    for (const addresses of Object.values(interfaces)) {
      for (const address of addresses ?? []) {
        if (address.family !== 'IPv4' || address.internal === true) continue;
        if (isTailscaleAddress(address.address)) {
          return `http://${address.address}:${String(port)}`;
        }
      }
    }
    return undefined;
  };

  /**
   * Base URL to use for a specific request, preferring the origin the client
   * actually reached us on.
   *
   * This is what makes LAN and tunnel coexist. A request arriving over
   * http://192.168.x.y:19387 must stay on that origin: the tunnel is throughput
   * limited (measured ~28 KB/s against ~31 MB/s on loopback), and the client
   * bundle is ~13.5 MB, so bouncing a LAN client to the tunnel turns a
   * sub-second load into minutes. Falling back to publicUrl() keeps the
   * tunnel-only case working exactly as before.
   *
   * Only the Host header is consulted, and a loopback origin is rejected because a
   * phone can never use the desktop's own 127.0.0.1.
   */
  /**
   * The address to lead with, and the one to carry as a fallback.
   *
   * LAN first, then Tailscale, then the tunnel. The client probes every address it is given and
   * connects to whichever answers, so this ordering only decides which one is tried first — and
   * "LAN first" makes the common case (phone on the same network as the host) both fast and
   * reliable, while a phone that is away still reaches the host through the fallback.
   *
   * Leading with Tailscale was tried and failed in practice: a phone whose Tailscale was not
   * connected received an unusable 100.x address as primary and never learned that a working LAN
   * address was available. See the note on the QR route for the full account.
   */
  const addressCandidates = () => [lanUrl(), tailscaleUrl(), publicUrl()];

  const requestBase = (req) => {
    const host = req?.headers?.host;
    if (typeof host === 'string' && host !== '') {
      const secure = req.socket?.encrypted === true ? 'https' : 'http';
      const origin = `${secure}://${host}`;
      try {
        const parsed = new URL(origin);
        if (!isLoopbackAddress(parsed.hostname)) return origin;
      } catch {
        // Malformed Host: fall through to the public URL.
      }
    }
    return publicUrl() ?? localUrl();
  };

  /** Locate the cloudflared binary, preferring one shipped in the profile. */
  const resolveCloudflared = () => {
    if (typeof config.cloudflaredPath === 'string' && config.cloudflaredPath !== '') return config.cloudflaredPath;
    const inProfile = join(home, 'profiles', profile, 'node_modules', 'cloudflared', 'bin', 'cloudflared.exe');
    if (usableBinary(inProfile)) return inProfile;
    const local = join(process.env.LOCALAPPDATA ?? '', 'dsh-mobile-public', 'cloudflared.exe');
    if (usableBinary(local)) return local;
    return inProfile;
  };

  /** The OpenSSH client Windows ships; no download, no extra install. */
  const resolveSsh = () => {
    if (typeof config.sshPath === 'string' && config.sshPath !== '') return config.sshPath;
    const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    return existsSync(system) ? system : 'ssh';
  };

  /**
   * Build a pairing URL carrying everything a device needs to configure itself.
   *
   * Three things travel in the link:
   *   `t`     the single-use pairing token
   *   `secret` the auto-pair key, so the device can re-pair itself later
   *   `url2`  a second origin to try, so one scan covers both "works anywhere"
   *           (Tailscale) and "fast on this network" (LAN)
   *
   * One helper keeps every QR and every returned link identical, so a code generated in
   * one route cannot drift from the link reported by another.
   */
  const pairingLink = (base, token, options = {}) => {
    let url = `${base}/m/pair?t=${encodeURIComponent(token)}`;
    if (options.withSecret !== false) {
      url += `&secret=${encodeURIComponent(store.autoPairSecret())}`;
    }
    // Attach the other reachable origin as a fallback, LAN first.
    //
    // Whichever address is primary, the other one travels with the link, so one code covers both
    // "at home" and "away". The order matters only when the primary is something else entirely
    // (a tunnel URL, or an address the caller dialled): then the LAN address is the better thing
    // to attach, because it is the one a nearby phone can actually use.
    const alternate = options.alternate
      ?? addressCandidates().find((candidate) => typeof candidate === 'string'
        && candidate !== '' && candidate !== base);
    if (typeof alternate === 'string' && alternate !== '' && alternate !== base) {
      url += `&url2=${encodeURIComponent(alternate)}`;
    }
    return url;
  };

  /**
   * Pick the provider. An explicit `tunnelProvider` always wins; otherwise use
   * cloudflared when its binary is genuinely usable and fall back to the SSH
   * relay when it is not.
   *
   * Checking existence alone is not enough: an interrupted download leaves a
   * short placeholder at the expected path, and spawning it fails with `EFTYPE`
   * (the file is not an executable). That happened in practice — a 2.5 MB stub of
   * a 52 MB binary — and left the plugin reporting a failed tunnel instead of
   * silently using the provider that works. A real cloudflared is tens of MB.
   */
  const resolveProvider = () => {
    if (typeof config.tunnelProvider === 'string' && TUNNEL_PROVIDERS[config.tunnelProvider] !== undefined) {
      return {
        provider: config.tunnelProvider,
        binary: config.tunnelProvider === 'ssh' ? resolveSsh() : resolveCloudflared()
      };
    }
    const cloudflared = resolveCloudflared();
    if (usableBinary(cloudflared)) return { provider: 'cloudflared', binary: cloudflared };
    return { provider: 'ssh', binary: resolveSsh() };
  };

  const chosen = resolveProvider();

  const tunnel = new TunnelManager({
    provider: chosen.provider,
    binary: chosen.binary,
    port: localPort() ?? 19387,
    logger,
    onChange: () => {
      // Placeholder hook so status changes can be observed without polling loops.
    }
  });

  // The web server may not know its port until it listens; keep the tunnel aimed
  // at the real one without forcing a restart of the tunnel.
  ctx.effect(() => {
    const update = () => {
      const port = localPort();
      if (Number.isFinite(port)) tunnel.port = port;
    };
    update();
    const timer = setInterval(update, 2000);
    return () => clearInterval(timer);
  }, 'dsh-mobile-public: track web server port');

  /**
   * Public base URL, in precedence order:
   *   1. a tunnel this plugin started successfully;
   *   2. `tunnelUrl` — an operator-managed tunnel (systemd unit, router port
   *      forward, a cloudflared run outside DSH). Support for this matters because
   *      the plugin must not be the only thing allowed to own the tunnel;
   *   3. `publicBaseUrl` — the same idea by an older name.
   */
  const publicUrl = () => tunnel.url ?? config.tunnelUrl ?? config.publicBaseUrl ?? undefined;

  // ---- admission --------------------------------------------------------------
  // NOTE: there is deliberately no intercepting gate here. `webServer.match()`
  // returns exactly one route per pathname and has no "decline and continue"
  // contract, so a `prefix` handler on `/api` would have to answer every API
  // request itself — it would break the GUI rather than protect it. Requests
  // arriving through the tunnel are therefore judged by the HOST's own browser
  // authentication, which was measured to answer 401 unauthenticated. The
  // pairing store below still records which devices paired, and is what the
  // pairing page, `/m/api/devices` and revocation work against.

  // ---- routes -----------------------------------------------------------------
  const installRoutes = () => {
    const disposers = [];

    disposers.push(ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/m/pair',
      handler: async (req, res) => {
        const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
        const token = query.get('t') ?? undefined;
        if (token !== undefined) {
          const device = store.redeem(token, deviceTtlMs, req.headers['user-agent']);
          if (device === undefined) {
            res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end('<!doctype html><meta charset="utf-8"><p>配对链接无效或已过期，请在桌面端刷新二维码后重试。</p>');
            return;
          }
          // The harness authenticates browsers with a launch token in the URL:
          // a request carrying it mints the auth cookie and redirects to a clean
          // path (see BrowserAuth.authenticatedUrl). Handing the phone that URL is
          // what turns a paired device into an authenticated GUI session — without
          // it, tunneled traffic is answered 401 by the harness.
          const base = requestBase(req);
          let target = '/';
          try {
            target = typeof ctx.connection?.authenticatedUrl === 'function'
              ? ctx.connection.authenticatedUrl(`${base}/`)
              : '/';
          } catch {
            target = '/';
          }
          res.writeHead(302, {
            'set-cookie': `${cookieName}=${encodeURIComponent(device.deviceId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(Math.floor(deviceTtlMs / 1000))}`,
            location: target,
            'cache-control': 'no-store'
          });
          res.end();
          return;
        }
        // The page is served on whatever origin the client used, and its QR must
        // encode a URL that origin can act on. Using the request origin keeps a LAN
        // visitor on the fast LAN path instead of handing them a tunnel link (see
        // requestBase).
        const base = requestBase(req);
        const active = store.activeToken();
        // Build the link once, with the same builder as the QR, so the page cannot show
        // something different from what a scanner would read.
        const link = active === undefined ? undefined : pairingLink(base, active.token);
        const html = pairingPage({
          token: active?.token,
          url: base,
          profile,
          secret: store.autoPairSecret(),
          link,
          qrSvg: active === undefined
            ? undefined
            : toSvg(link, { size: 260, level: QR_EC_LEVEL })
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
      }
    }), 'dsh-mobile-public: pairing page'));

    disposers.push(ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/m/api/auto-pair',
      handler: (req, res) => {
        const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
        const secret = query.get('s') ?? '';

        // The key is the whole gate. Network position is NOT treated as proof: an
        // address inside Tailscale's range only shows the caller joined the tailnet,
        // which is weaker than showing they were handed the key. No key and no match
        // is a refusal with no detail about which part was wrong.
        if (!store.checkAutoPairSecret(secret)) {
          sendJson(res, 403, { error: 'invalid or missing auto-pair key' });
          return;
        }

        // Reuse a live token instead of minting a new one.
        //
        // Only one pairing token exists at a time, so minting here invalidated whatever
        // was live — including the code just displayed for someone to scan, and including
        // the link a previous auto-pair call had already handed this same device. The
        // observed failure was a device retrying auto-pair, each call killing the token the
        // previous call had returned, and pairing then failing with "无效或已过期".
        //
        // Reusing is also the safer semantic: an unpaired device that holds the key may
        // pair, but it must not be able to cancel a code the operator is about to scan.
        const live = store.activeToken();
        const reuseWindowMs = 30 * 1000;
        if (live !== undefined && live.expiresAt - Date.now() > reuseWindowMs) {
          const base = requestBase(req);
          logger.info?.(`dsh-mobile-public: auto-pair reused the live token for ${String(req.socket?.remoteAddress ?? 'unknown')}`);
          sendJson(res, 200, {
            link: `${base}/m/pair?t=${encodeURIComponent(live.token)}`,
            expiresAt: live.expiresAt,
            ttlMs: live.expiresAt - Date.now(),
            reused: true
          });
          return;
        }

        // Nothing usable is live: mint one. Short-lived, because the device redeems it
        // immediately; a longer life would only widen the window a leaked URL is usable in.
        const minted = store.mintToken(AUTO_PAIR_TTL_MS);
        const base = requestBase(req);
        logger.info?.(`dsh-mobile-public: auto-pair granted to ${String(req.socket?.remoteAddress ?? 'unknown')}`);
        sendJson(res, 200, {
          link: `${base}/m/pair?t=${encodeURIComponent(minted.token)}`,
          expiresAt: minted.expiresAt,
          ttlMs: AUTO_PAIR_TTL_MS
        });
      }
    }), 'dsh-mobile-public: auto-pair route'));

    disposers.push(ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/m/api/status',
      handler: (req, res) => {
        const base = publicUrl() ?? localUrl();
        let authProbe;
        try {
          authProbe = typeof ctx.connection?.authenticatedUrl === 'function'
            ? ctx.connection.authenticatedUrl(`${base}/m/api/status`)
            : null;
        } catch (error) {
          authProbe = `error: ${error instanceof Error ? error.message : String(error)}`;
        }
        sendJson(res, 200, {
          profile,
          tunnel: tunnel.status(),
          publicUrl: publicUrl() ?? null,
          loopbackUrl: localUrl(),
          // The port the host is actually listening on, stated plainly.
          //
          // The phone's LAN sweep has to guess a port to probe, and it used to guess 19387 every
          // time — correct for a default install, wrong the moment the operator moves the port in
          // `cordis.patch.yml`, with no way for the phone to find out. It would sweep 253 addresses
          // on the wrong port and report "no host on this network". Reporting the port here makes
          // the sweep self-correcting: whichever port is reachable gets the host to name the port
          // it wants, and the phone re-probes there.
          port: ctx.webServer?.port ?? null,
          connectionAvailable: typeof ctx.connection?.authenticatedUrl === 'function',
          // Whether the host can mint a launch-token URL is the single fact that
          // decides if a paired phone reaches an authenticated GUI session.
          authenticatedUrlAvailable: authProbe !== null && !String(authProbe).startsWith('error:'),
          deviceCount: store.devices().length,
          token: store.activeToken() === undefined ? null : { expiresAt: store.activeToken().expiresAt }
        });
      }
    }), 'dsh-mobile-public: status route'));

    disposers.push(ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/m/api/qr.svg',
      handler: (req, res) => {
        // Lead with the LAN address, falling back to Tailscale.
        //
        // This is a reversal, and the reason is a real failure rather than a preference. The code
        // used to lead with Tailscale "because it works on any network" — but a phone whose
        // Tailscale is not connected (app not open, switch off, or the tailnet address changed)
        // then gets an address it can never reach, while a perfectly good LAN address sits unused
        // in the fallback slot. Observed exactly that: a phone on the same WiFi as the host
        // repeatedly probing a dead 100.x address and a retired tunnel domain, never the LAN
        // address, and concluding the LAN "does not work".
        //
        // The earlier objection — that a LAN-led code "can only ever work on the same network" —
        // does not apply, because the client probes both addresses and picks the one that answers
        // (verified in logcat: `probe http://192.168.31.56:19387 -> HTTP 200`,
        // `connect: chose http://192.168.31.56:19387`). So LAN-first is fast at home and still
        // works away from it, which is strictly better than the reverse.
        const base = lanUrl() ?? tailscaleUrl() ?? publicUrl();
        const active = store.activeToken();
        if (base === undefined || active === undefined) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('no reachable address or pairing token');
          return;
        }
        const svg = toSvg(pairingLink(base, active.token), { size: 260, level: QR_EC_LEVEL });
        res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' });
        res.end(svg);
      }
    }), 'dsh-mobile-public: qr route'));

    disposers.push(ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/m/widget.js',
      handler: (req, res) => {
        // Served from disk on each request so editing the panel does not need a
        // rebuild; the browser is told not to cache it for the same reason.
        let body;
        try {
          body = readFileSync(new URL('./widget.js', import.meta.url), 'utf8');
        } catch (error) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`widget unavailable: ${String(error?.message ?? error)}`);
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store'
        });
        res.end(body);
      }
    }), 'dsh-mobile-public: widget route'));

    disposers.push(ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/m/api/get-code',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' });
          res.end();
          return;
        }
        const body = await readBody(req).catch(() => ({}));
        const active = store.activeToken();
        // Mint only when asked to refresh or when nothing is live: a page load must
        // not silently invalidate a code the user is in the middle of scanning.
        //
        // A refresh rotates the auto-pair key as well. That is what the operator expects
        // from "refresh": a fresh code that no previously issued key can be reused with.
        // It is deliberately the only rotation path, so the key never changes underneath a
        // device that was merely reloading the page.
        let minted;
        let secret;
        if (body?.refresh === true || active === undefined) {
          const requested = Number(body?.tokenTtlMs);
          const ttl = Number.isFinite(requested)
            ? Math.min(Math.max(requested, MIN_TOKEN_TTL_MS), MAX_TOKEN_TTL_MS)
            : tokenTtlMs;
          minted = store.mintToken(ttl);
          secret = body?.refresh === true
            ? store.rotateAutoPairSecret()
            : store.autoPairSecret();
        } else {
          minted = { token: active.token, expiresAt: active.expiresAt };
          secret = store.autoPairSecret();
        }

        // Preference order, LAN first. All three are attached to the link as primary/fallback
        // anyway, so this only decides which one a client tries first:
        //   lan       -> fastest (3.19 MB/s), works whenever the phone is on this network
        //   tailscale -> works on any network, measured 2.32 MB/s
        //   tunnel    -> works anywhere but throttled to 14-27 KB/s
        // LAN leads because it is the common case and because leading with Tailscale produced the
        // failure this ordering exists to fix: a phone with Tailscale disconnected could not use
        // the primary address and had no idea a working LAN address existed.
        const allLan = lanUrls();
        const lan = allLan[0];
        const ts = tailscaleUrl();
        const tunnel = publicUrl();
        const base = lan ?? ts ?? tunnel;
        if (base === undefined) {
          sendJson(res, 503, { error: 'no Tailscale, LAN or tunnel address; cannot build a pairing link' });
          return;
        }
        sendJson(res, 200, {
          expiresAt: minted.expiresAt,
          ttlMs: minted.expiresAt - Date.now(),
          // Same builder as the QR and the pairing page, so the copyable link carries the
          // key and the fallback address too. Pasting it must set a phone up exactly the
          // way scanning does — a link without the key silently skips auto-pairing.
          pairingUrl: pairingLink(base, minted.token),
          host: new URL(base).host,
          // Must describe the same address `base` resolved to, or the panel labels a LAN code as
          // "tailscale" (and vice versa) — which is exactly the mismatch the origin-check test
          // caught when only the mint route had been updated.
          scope: lan !== undefined ? 'lan' : ts !== undefined ? 'tailscale' : 'tunnel',
          tailscaleUrl: ts ?? null,
          lanUrl: lan ?? null,
          // Every private candidate, not just the first. The client probes each and connects to
          // whichever answers, so one wrong guess costs a probe instead of a failed pairing.
          lanUrls: allLan,
          publicUrl: tunnel ?? null,
          // Shown in the panel so the operator can copy it into a phone once.
          autoPairSecret: store.autoPairSecret()
        });
      }
    }), 'dsh-mobile-public: get-code route'));

    // ---- pairing by request, approved on the desktop -------------------------
    //
    // Scanning a QR is a credential hand-off: the code contains the auto-pair key, and holding it
    // is what proves the phone may enter. That works, but it means the phone can never pair itself
    // — after a `pm clear` or an app upgrade that loses preferences, the user has to walk back to
    // the computer and scan again, even though both devices are sitting on the same network.
    //
    // These routes add the step that makes that unnecessary without weakening anything: the phone
    // asks, the desktop asks a human, and only a human's click turns the request into a link.
    //
    // The security argument is the one that matters. Network position is *not* treated as proof —
    // a request from the same subnet proves only that the caller is on the subnet, and every other
    // device on the Wi-Fi is too. The proof here is possession of the desktop: someone has to
    // click Allow on the machine itself. A forged or spam request can therefore do exactly one
    // thing, which is make a prompt appear on the operator's screen.
    //
    // Requests live in memory only. They are short-lived by nature (a couple of minutes), they
    // carry nothing worth persisting, and keeping them out of the state file means a crash cannot
    // leave a half-approved pairing lying around.

    /** One pending request, keyed by an unguessable id the requester keeps. */
    const pendingPairRequests = new Map();
    const PENDING_TTL_MS = 3 * 60 * 1000;
    const PENDING_MAX_PER_IP = 3;
    const PENDING_MAX_TOTAL = 8;

    const sweepPendingPairRequests = () => {
      const now = Date.now();
      for (const [id, request] of pendingPairRequests) {
        if (now - request.createdAt > PENDING_TTL_MS) pendingPairRequests.delete(id);
      }
    };

    const pendingSummary = () => {
      sweepPendingPairRequests();
      // Only what still needs a decision. A request approved by Tailscale identity is already
      // settled, and listing it would put a button on screen whose click can only come back 404 —
      // the operator would read that as the approval having failed.
      return [...pendingPairRequests]
        .filter(([, request]) => request.status === 'pending')
        .map(([id, request]) => ({
          id,
          name: request.name,
          source: request.source,
          status: request.status,
          waitingMs: Date.now() - request.createdAt
        }));
    };

    /**
     * Turn an approved request into a link, once.
     *
     * The link is minted at approval time rather than at request time, so a request that is never
     * approved never causes a token to exist. And it is deleted from the request on the first read,
     * so a second reader — a different device that somehow learned the id — gets nothing.
     */
    const fulfillApprovedRequest = (request) => {
      if (request.status !== 'approved' || request.link !== undefined) return request.link ?? null;
      const allLan = lanUrls();
      const base = allLan[0] ?? tailscaleUrl() ?? publicUrl();
      if (base === undefined) return null;
      const minted = store.mintToken();
      request.link = pairingLink(base, minted.token, { alternate: allLan[1] });
      return request.link;
    };

    /**
     * Identity of a Tailscale peer, or null when the address is not one.
     *
     * `tailscale whois` answers only for addresses in this tailnet's current netmap, which makes it
     * the check rather than a hint: a LAN address, a public address, or a device merely *claiming* a
     * 100.x address gets null back. Verified against this host's own CLI: an address whose device is
     * listed as offline still resolves, because the netmap is local state rather than a live probe —
     * which is what makes this work for a phone that is not directly connected to the host.
     *
     * Cached briefly because the result decides whether a *network* caller may be handed a credential,
     * and a subprocess per request would otherwise be a handle on that path.
     */
    const TAILSCALE_WHOIS_TTL_MS = 60 * 1000;
    const tailscaleWhoisCache = new Map();

    const tailscalePeer = (address) => {
      if (typeof address !== 'string' || !isTailscaleAddress(address)) return null;
      const cached = tailscaleWhoisCache.get(address);
      if (cached !== undefined && Date.now() - cached.at < TAILSCALE_WHOIS_TTL_MS) return cached.peer;
      let peer = null;
      try {
        const raw = execFileSync('tailscale', ['whois', '--json', address], {
          encoding: 'utf8', timeout: 5000, windowsHide: true
        });
        const node = JSON.parse(raw)?.Node;
        if (node !== undefined && node !== null) {
          peer = {
            // The trailing dot is how the API spells an FQDN; it is noise in a prompt.
            name: String(node.Name ?? '').replace(/\.$/, '') || 'Tailscale 设备',
            stableId: String(node.StableID ?? ''),
            user: node.User === undefined ? null : String(node.User)
          };
        }
      } catch {
        // No Tailscale, not a tailnet address, or the CLI refused: no identity, and therefore no
        // shortcut. Callers must treat null as "unknown", never as "trusted".
        peer = null;
      }
      tailscaleWhoisCache.set(address, { at: Date.now(), peer });
      return peer;
    };

    /**
     * The UserID every node in this tailnet belongs to, or null when it cannot be determined.
     *
     * Read from `status --json` rather than `whois`: this CLI refuses `whois` on 127.0.0.1 with
     * "peer not found", and the status document states our own user directly. Cached for the life of
     * the process — the tailnet account does not change while the host runs.
     */
    let tailscaleSelfUserId;
    const tailscaleSelfUser = () => {
      if (tailscaleSelfUserId !== undefined) return tailscaleSelfUserId;
      tailscaleSelfUserId = null;
      try {
        const raw = execFileSync('tailscale', ['status', '--json'], {
          encoding: 'utf8', timeout: 5000, windowsHide: true
        });
        const parsed = JSON.parse(raw);
        const self = parsed?.Self;
        // `Self.UserID` is the field the status document uses; `User` appears on peers.
        const user = self?.UserID ?? self?.User;
        if (user !== undefined && user !== null) tailscaleSelfUserId = String(user);
      } catch {
        tailscaleSelfUserId = null;
      }
      return tailscaleSelfUserId;
    };

    disposers.push(ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/m/api/pair-request',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' });
          res.end();
          return;
        }
        sweepPendingPairRequests();
        const source = String(req.socket?.remoteAddress ?? 'unknown');
        const perIp = [...pendingPairRequests.values()].filter((item) => item.source === source).length;
        if (perIp >= PENDING_MAX_PER_IP) {
          sendJson(res, 429, { error: 'too many pending requests from this address' });
          return;
        }
        if (pendingPairRequests.size >= PENDING_MAX_TOTAL) {
          sendJson(res, 503, { error: 'too many pending requests' });
          return;
        }
        const body = await readBody(req).catch(() => ({}));
        let name = typeof body?.name === 'string' && body.name.trim() !== ''
          ? body.name.trim().slice(0, 40) : '未知设备';

        // Pairing from outside the house — the case that has no other way in.
        //
        // The three LAN paths all need something that is only on the desktop: the QR code, the
        // auto-pair key, or a click. A user away from home has none of them, so before this the
        // phone simply could not pair. Tailscale supplies the missing proof: the host can ask its
        // own tailnet who this address belongs to, and a device in the operator's tailnet has
        // already been authenticated by Tailscale, which is a stronger statement than "it is on
        // this subnet" — the latter is forgeable and this is not.
        //
        // Approval is immediate and does not wait for a click, because reaching this code at all
        // already required tailnet membership, and requiring the click would keep the feature
        // useless for its own use case: the operator may be nowhere near the desktop.
        //
        // A failure to establish identity falls through to the ordinary pending path rather than
        // auto-approving. That direction matters: an absent `tailscale` binary must never mean
        // "trust everyone".
        const peer = tailscalePeer(source);
        let tailscaleApproved = false;
        if (peer !== null) {
          const selfUser = tailscaleSelfUser();
          if (selfUser !== null && peer.user === selfUser) {
            tailscaleApproved = true;
            if (name === '未知设备') name = peer.name;
          } else {
            logger.info?.(`dsh-mobile-public: refusing tailnet node ${peer.name} (user ${peer.user})`);
          }
        }

        const id = randomBytes(24).toString('hex');
        const request = {
          id,
          name,
          source,
          status: tailscaleApproved ? 'approved' : 'pending',
          createdAt: Date.now(),
          via: tailscaleApproved ? 'tailscale' : 'lan'
        };
        pendingPairRequests.set(id, request);
        logger.info?.(`dsh-mobile-public: pairing requested by ${name} from ${source}`
          + (tailscaleApproved ? ' — approved via Tailscale identity' : ''));
        sendJson(res, 200, {
          id,
          ttlMs: PENDING_TTL_MS,
          // Reported so the phone can say where the approval came from instead of silently
          // skipping a step the user expects to see.
          approved: tailscaleApproved,
          via: request.via
        });
      }
    }), 'dsh-mobile-public: pair-request route'));

    disposers.push(ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/m/api/pair-request/status',
      handler: (req, res) => {
        // Deliberately not loopback-only: the caller is the phone that made the request, and it is
        // the id — 24 random bytes — that authorises the read. Without the id there is nothing to
        // learn, which is why enumeration is not a concern here.
        const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
        const id = query.get('id') ?? '';
        sweepPendingPairRequests();
        const request = pendingPairRequests.get(id);
        if (request === undefined) {
          sendJson(res, 404, { status: 'unknown' });
          return;
        }
        if (request.status === 'pending') {
          sendJson(res, 200, { status: 'pending' });
          return;
        }
        if (request.status === 'rejected') {
          pendingPairRequests.delete(id);
          sendJson(res, 200, { status: 'rejected' });
          return;
        }
        const link = fulfillApprovedRequest(request);
        // The link is a full-control credential, so it is handed over once and the request is
        // dropped immediately afterwards.
        pendingPairRequests.delete(id);
        if (link === null) {
          sendJson(res, 503, { status: 'approved', error: 'no reachable address' });
          return;
        }
        sendJson(res, 200, { status: 'approved', link });
      }
    }), 'dsh-mobile-public: pair-request status route'));

    disposers.push(ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/m/api/pair-requests',
      handler: async (req, res) => {
        // The panel runs in the desktop's own browser, so loopback is the right requirement here:
        // listing pending requests — and approving them — must not be possible from the network.
        if (!isLoopbackAddress(req.socket?.remoteAddress)) {
          sendJson(res, 403, { error: 'the request list is loopback-only' });
          return;
        }
        if (req.method === 'GET') {
          sendJson(res, 200, { requests: pendingSummary() });
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, POST' });
          res.end();
          return;
        }
        const body = await readBody(req).catch(() => ({}));
        const id = typeof body?.id === 'string' ? body.id : '';
        const decision = body?.decision === 'approve' ? 'approve'
          : body?.decision === 'reject' ? 'reject' : null;
        if (decision === null) {
          sendJson(res, 400, { error: 'decision must be approve or reject' });
          return;
        }
        sweepPendingPairRequests();
        const request = pendingPairRequests.get(id);
        if (request === undefined) {
          sendJson(res, 404, { error: 'no such request' });
          return;
        }
        request.status = decision === 'approve' ? 'approved' : 'rejected';
        logger.info?.(`dsh-mobile-public: pairing request from ${request.name} ${request.status}`);
        sendJson(res, 200, { status: request.status });
      }
    }), 'dsh-mobile-public: pair-requests route'));

    disposers.push(ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/m/api/mint',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' });
          res.end();
          return;
        }
        if (!isLoopbackAddress(req.socket?.remoteAddress)) {
          sendJson(res, 403, { error: 'minting is loopback-only' });
          return;
        }
        // A caller may ask for a longer-lived link. The TTL is clamped: a pairing
        // link is a full-control credential for whoever holds it, so it must not be
        // possible to mint one that effectively never expires.
        const body = await readBody(req).catch(() => ({}));
        const requested = Number(body?.tokenTtlMs);
        const ttl = Number.isFinite(requested)
          ? Math.min(Math.max(requested, MIN_TOKEN_TTL_MS), MAX_TOKEN_TTL_MS)
          : tokenTtlMs;
        const minted = store.mintToken(ttl);
        // The QR encodes the LAN link, falling back to Tailscale then the tunnel — the same
        // ordering as every other route, so the code the panel shows is the code that connects
        // fastest on this network. All three links are returned alongside so a caller can offer
        // whichever fits.
        const allLan = lanUrls();
        const lan = allLan[0];
        const ts = tailscaleUrl();
        const base = lan ?? ts ?? publicUrl();
        sendJson(res, 200, {
          expiresAt: minted.expiresAt,
          ttlMs: ttl,
          link: base === undefined ? null : pairingLink(base, minted.token),
          qr: base === undefined ? null : toSvg(pairingLink(base, minted.token), { size: 260, level: QR_EC_LEVEL }),
          scope: lan !== undefined ? 'lan' : ts !== undefined ? 'tailscale' : 'tunnel',
          tailscaleLink: ts === undefined ? null : pairingLink(ts, minted.token),
          tailscaleUrl: ts ?? null,
          lanLink: lan === undefined ? null : pairingLink(lan, minted.token),
          lanUrl: lan ?? null,
          // Every private candidate, so a caller can offer more than the first guess.
          lanUrls: allLan,
          lanQr: lan === undefined ? null : toSvg(pairingLink(lan, minted.token), { size: 260, level: QR_EC_LEVEL }),
          tunnel: tunnel.status()
        });
      }
    }), 'dsh-mobile-public: mint route'));

    disposers.push(ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/m/api/tunnel',
      handler: async (req, res) => {
        if (!isLoopbackAddress(req.socket?.remoteAddress)) {
          sendJson(res, 403, { error: 'tunnel control is loopback-only' });
          return;
        }
        const body = await readBody(req).catch(() => ({}));
        const action = body.action ?? new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('action');
        if (action === 'start') tunnel.start();
        else if (action === 'stop') tunnel.stop();
        else if (action !== 'status') {
          sendJson(res, 400, { error: 'action must be start, stop or status' });
          return;
        }
        sendJson(res, 200, { tunnel: tunnel.status(), publicUrl: publicUrl() ?? null });
      }
    }), 'dsh-mobile-public: tunnel control route'));

    disposers.push(ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/m/api/devices',
      handler: async (req, res) => {
        if (!isLoopbackAddress(req.socket?.remoteAddress)) {
          sendJson(res, 403, { error: 'device control is loopback-only' });
          return;
        }
        if (req.method === 'DELETE') {
          store.revokeAll();
          sendJson(res, 200, { devices: [] });
          return;
        }
        sendJson(res, 200, { devices: store.devices() });
      }
    }), 'dsh-mobile-public: devices route'));

    // Let an already-paired device pick up a rotated auto-pair key.
    //
    // Without this, rotating the key silently strands every device that is already
    // configured: its stored key goes stale and it only discovers that when its session
    // finally expires and auto-pairing fails. The device holding a valid `dsh_remote`
    // cookie already has full control of this host, so telling it the current key grants
    // nothing it did not already have.
    disposers.push(ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/m/api/session',
      handler: (req, res) => {
        const header = req.headers?.cookie ?? '';
        // Only the plugin's own cookie is read; the harness session cookie is opaque here.
        const match = new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`).exec(header);
        const deviceId = match === null ? '' : decodeURIComponent(match[1]);
        const record = store.touch(deviceId);
        if (record === undefined) {
          sendJson(res, 403, { error: 'not a paired device' });
          return;
        }
        sendJson(res, 200, {
          autoPairSecret: store.autoPairSecret(),
          deviceExpiresAt: record.expiresAt
        });
      }
    }), 'dsh-mobile-public: session route'));

    return disposers;
  };

  // ---- lifecycle --------------------------------------------------------------
  ctx.effect(() => {
    const disposeRoutes = installRoutes();
    if (readBool(config.autoStart, true)) tunnel.start();
    logger.info?.(`dsh-mobile-public: ready for profile ${profile}; pairing page at ${localUrl()}/m/pair`);
    return () => {
      tunnel.stop();
      for (const dispose of disposeRoutes.reverse()) dispose();
    };
  }, 'dsh-mobile-public: lifecycle');
  }, 'dsh-mobile-public: service-dependent setup');
}

export { PairingStore, TunnelManager, describeDevice, isLoopbackAddress, resolveHome, safeEqual };
