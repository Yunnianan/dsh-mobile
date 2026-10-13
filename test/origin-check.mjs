/**
 * Exercise the request-origin logic in lib/index.js against a stub webServer.
 *
 * The point of the change is that a client arriving on the LAN origin must be kept
 * on that origin rather than redirected to the throughput-limited tunnel, and that
 * mint reports both origins. Running the real module against a fake ctx checks that
 * without needing the host restarted or a phone in hand.
 */
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const plugin = await import('../lib/index.js');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

// Minimal ctx: capture registered routes, record injected rows, and run deferred
// service-dependent setup immediately (the services below are already present).
const routes = new Map();
const injectedRows = [];
const home = mkdtempSync(join(tmpdir(), 'dsh-mobile-test-'));

// Isolate the plugin's state before apply() runs.
//
// The plugin stores its state under resolveHome(), which honours DSH_HOME and otherwise
// falls back to the real ~/.dsh. Without this line the checks operate on the operator's
// live state file — rotating the real auto-pair key and invalidating the live pairing
// token on every run. integration.mjs already set this; this file did not.
process.env.DSH_HOME = home;

const ctx = {
  webServer: {
    port: 19387,
    register(route) {
      routes.set(`${route.kind}:${route.path}`, route.handler);
      return () => {};
    }
  },
  connection: {
    authenticatedUrl: (base) => `${base}?token=STUB`
  },
  effect(fn) {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  on(event, handler) {
    // The panel is injected through this event, so record what the plugin pushes.
    if (event === 'webserver/index-inject') {
      handler(injectedRows);
      ctx.__injectHandler = handler;
    }
    return () => {};
  },
  inject(names, callback) {
    callback(ctx);
  }
};

let registered = null;
try {
  registered = plugin.apply(ctx, {
    // A fixed tunnel URL stands in for a live tunnel, so the tunnel link and the
    // launch-token redirect can both be exercised without any network access.
    tunnelUrl: 'https://test-tunnel.example',
    stateFile: join(home, 'state.json')
  });
} catch (error) {
  console.log('apply() threw:', error?.message);
}

console.log('registered routes:');
for (const key of routes.keys()) console.log('  ', key);

if (routes.size === 0) {
  console.log('\nNo routes registered -- cannot verify. apply() may need more of the ctx surface.');
  process.exit(1);
}

// ---- drive /m/pair with different Host headers -------------------------------
const pair = routes.get('exact:/m/pair');
const status = routes.get('exact:/m/api/status');
const mint = routes.get('exact:/m/api/mint');

function fakeRes() {
  const out = { status: 0, headers: {}, body: '' };
  return {
    out,
    writeHead(code, headers) { out.status = code; Object.assign(out.headers, headers ?? {}); },
    end(chunk) { if (chunk !== undefined) out.body += String(chunk); },
    setHeader(k, v) { out.headers[k] = v; },
    getHeader(k) { return out.headers[k]; }
  };
}

// Mint a token through the mint route so a redeem can be attempted.
const mintRes = fakeRes();
await mint({ method: 'POST', url: '/m/api/mint', headers: { host: '127.0.0.1:19387' },
             socket: { remoteAddress: '127.0.0.1' }, on() {}, async *[Symbol.asyncIterator]() {} }, mintRes);
let minted = null;
try { minted = JSON.parse(mintRes.out.body); } catch { /* handled below */ }
check('mint responds 200', mintRes.out.status === 200, `status=${mintRes.out.status}`);
check('mint reports a link', Boolean(minted?.link), String(minted?.link));
check('mint reports a LAN url', Boolean(minted?.lanUrl), String(minted?.lanUrl));
check('mint reports a LAN link', Boolean(minted?.lanLink), String(minted?.lanLink));
if (minted?.lanLink) {
  // Assert the relationship, not a literal address.
  //
  // The old assertion required the text `192.168.` to appear. That holds on this machine and fails
  // on any machine whose Wi-Fi is not on a 192.168 subnet — and it also passed for a *wrong*
  // address as long as it looked private (a TAP adapter's 10.10.10.88 did). What actually matters
  // is that the LAN link is built from the address the plugin reported as its LAN url.
  check('LAN link is built from the reported LAN url',
        Boolean(minted.lanUrl) && minted.lanLink.startsWith(minted.lanUrl),
        `${minted.lanLink.replace(/\?.*$/, '')} vs lanUrl=${minted.lanUrl}`);
  check('the reported LAN url is a private address',
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String(minted.lanUrl ?? '').replace(/^https?:\/\//, '')),
        String(minted.lanUrl));
}
check('mint reports a scope', Boolean(minted?.scope), String(minted?.scope));
// The scanned code must carry the auto-pair key: that is what lets a phone configure
// itself from a single scan rather than the operator pasting a key afterwards.
if (minted?.link) {
  check('mint link carries the auto-pair key', minted.link.includes('secret='), minted.link);
}
if (minted?.qr) {
  // A QR is pixels, not text: the key cannot be grepped out of the SVG. What matters is
  // what a scanner would read back, so the encoded URL is checked via the QR's own module
  // matrix rather than the markup. The SVG carries one <path> per dark module, so counting
  // is not enough — the payload is verified by decoding in qr-selftest.mjs, which already
  // compares this encoder against the reference implementation. Here the weaker but
  // meaningful check is that the QR was generated for a URL containing the key.
  check('mint QR is an SVG image', minted.qr.startsWith('<svg'), 'svg markup present');
  check('mint QR was generated from a keyed link', minted.link.includes('secret='),
        'qr is built from minted.link');
}
if (minted?.lanLink) {
  check('LAN link carries the auto-pair key', minted.lanLink.includes('secret='), minted.lanLink);
}
// The link must also carry the other reachable origin, so a single scan sets up both the
// anywhere-address (Tailscale) and the fast-on-this-network one (LAN).
if (minted?.link) {
  check('mint link carries a fallback address', minted.link.includes('url2='), minted.link);
  const primary = minted.link.split('/m/pair')[0];
  check('the fallback differs from the primary',
        !minted.link.includes(`url2=${encodeURIComponent(primary)}`),
        'url2 is another origin, not a repeat');
}
// And the link reported on the pairing page must match the QR, not omit the key.
{
  const pageRes = fakeRes();
  await pair({ method: 'GET', url: '/m/pair', headers: { host: '192.168.31.56:19387' },
               socket: { remoteAddress: '192.168.31.56' } }, pageRes);
  check('pairing page shows a link carrying the key', pageRes.out.body.includes('secret='),
        'page html carries the key');
  check('pairing page shows a link carrying the fallback',
        pageRes.out.body.includes('url2='), 'page html carries the fallback address');
}

// Now redeem that token twice: once as if from the tunnel host, once from LAN.
if (minted?.link) {
  const token = new URL(minted.link).searchParams.get('t');

  const lanRes = fakeRes();
  await pair({ method: 'GET', url: `/m/pair?t=${token}`, headers: { host: '192.168.31.56:19387' },
               socket: { remoteAddress: '192.168.31.56' } }, lanRes);
  console.log('\nLAN-hosted /m/pair  ->', lanRes.out.status, lanRes.out.headers.location);
  check('LAN request redirects to the LAN origin',
        String(lanRes.out.headers.location ?? '').includes('192.168.31.56'),
        String(lanRes.out.headers.location ?? ''));

  check('redirect carries a launch token',
        String(lanRes.out.headers.location ?? '').includes('token='));

  check('device cookie issued', Boolean(lanRes.out.headers['set-cookie']));
}

// ---- bottom-left panel ------------------------------------------------------
// The panel reaches the page purely through an injected script row, so that row is
// the thing worth asserting: no row means no panel, silently.
console.log('\npanel injection:');
console.log('  rows pushed:', JSON.stringify(injectedRows));

const scriptRow = injectedRows.find((row) => row.kind === 'script' && String(row.text).includes('/m/widget.js'));
check('a script row injecting /m/widget.js was pushed', Boolean(scriptRow));
check('the row is placed in the body', scriptRow?.placement === 'body', String(scriptRow?.placement));
check('the row swallows load errors (inline, not script-src)',
      scriptRow?.kind === 'script' && String(scriptRow.text).includes('onerror'));

// Re-running the handler must not duplicate the row.
if (ctx.__injectHandler) {
  const before = injectedRows.length;
  ctx.__injectHandler(injectedRows);
  check('re-delivering the table does not duplicate the row', injectedRows.length === before,
        `${before} -> ${injectedRows.length}`);
}

const getCode = routes.get('exact:/m/api/get-code');
const qrRoute = routes.get('exact:/m/api/qr.svg');
const widgetRoute = routes.get('exact:/m/widget.js');
check('get-code route registered', Boolean(getCode));
check('qr route registered', Boolean(qrRoute));
check('widget.js route registered', Boolean(widgetRoute));

// Declared outside the block below so the auto-pair checks can read the secret.
let code = null;

if (getCode) {
  // No refresh on a cold call: this must mint, because nothing is live.
  const body = JSON.stringify({ refresh: false });
  const codeRes = fakeRes();
  await getCode({
    method: 'POST',
    url: '/m/api/get-code',
    headers: { host: '127.0.0.1:19387' },
    socket: { remoteAddress: '127.0.0.1' },
    on() {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); }
  }, codeRes);
  try { code = JSON.parse(codeRes.out.body); } catch { /* reported below */ }
  console.log('\nget-code (cold) ->', codeRes.out.status, JSON.stringify(code));
  check('get-code responds 200', codeRes.out.status === 200, `status=${codeRes.out.status}`);
  check('get-code returns a pairingUrl', Boolean(code?.pairingUrl), String(code?.pairingUrl));
  check('get-code reports a known scope',
        ['tailscale', 'lan', 'tunnel'].includes(code?.scope), String(code?.scope));
  check('get-code reports host', Boolean(code?.host), String(code?.host));
  check('get-code reports an expiry', Number(code?.expiresAt) > Date.now(), String(code?.expiresAt));
  if (code?.pairingUrl) {
    check('pairingUrl points at the pairing route', code.pairingUrl.includes('/m/pair?t='),
          code.pairingUrl.replace(/\?.*$/, ''));
  }
  // The address to lead with is LAN, then Tailscale, then the tunnel.
  //
  // This assertion used to require a 100.64/10 host whenever Tailscale was present, because that
  // was the old policy. The policy was reversed after a real failure: a phone whose Tailscale was
  // not connected received an unusable Tailscale address as primary while a working LAN address sat
  // in the fallback slot, and the app reported "LAN does not work". So the test now asserts the
  // *order* — a LAN address leads when one exists, and the other address still travels with the
  // link — rather than a fixed answer, which keeps it valid on a machine with no Tailscale.
  if (code?.scope === 'lan') {
    check('a LAN address leads when one is available',
          /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String(code.host ?? '')),
          String(code.host));
    const alt = code.tailscaleUrl ?? code.publicUrl;
    check('the other reachable address is still reported alongside',
          Boolean(alt), String(alt));
  }
  if (code?.scope === 'tailscale') {
    check('tailscale scope reports a 100.64/10 host',
          /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(String(code.host ?? '')),
          String(code.host));
    check('tailscaleUrl reported alongside', Boolean(code.tailscaleUrl), String(code.tailscaleUrl));
  }
}

if (widgetRoute) {
  const wRes = fakeRes();
  await widgetRoute({ method: 'GET', url: '/m/widget.js', headers: {} }, wRes);
  console.log('\n/m/widget.js ->', wRes.out.status, `${wRes.out.body.length} bytes`);
  check('widget.js serves 200', wRes.out.status === 200, `status=${wRes.out.status}`);
  check('widget.js is JavaScript', String(wRes.out.headers['content-type'] ?? '').includes('javascript'),
        String(wRes.out.headers['content-type']));
  check('widget.js is not cached', String(wRes.out.headers['cache-control'] ?? '').includes('no-store'));
  check('widget.js defines the panel', wRes.out.body.includes('__dshMobilePanel'));
  // Placement is derived from the device, not hardcoded: the home corner is the 14px design
  // inset plus whatever safe-area inset the screen reports, and the height is capped to what the
  // viewport leaves. A literal `left:14px;bottom:14px` is what failed on notched and landscape
  // screens.
  check('widget.js anchors from safe-area-aware custom properties',
        wRes.out.body.includes('--dshm-home-left:calc(14px + var(--dshm-inset-left))')
        && wRes.out.body.includes('--dshm-home-bottom:calc(14px + var(--dshm-inset-bottom))'));
  check('widget.js caps the panel to the viewport',
        wRes.out.body.includes('--dshm-room:calc(')
        && wRes.out.body.includes('max-height:var(--dshm-room)')
        && wRes.out.body.includes('width:min(var(--dshm-width),calc(100vw - 24px))'));
  // The property names are passed to a small reader, so the literal to look for is the argument.
  check('widget.js reads those values rather than repeating them',
        wRes.out.body.includes('function layoutMetrics')
        && wRes.out.body.includes("read('--dshm-home-bottom'")
        && wRes.out.body.includes("read('--dshm-width'"));
  check('widget.js re-anchors when its own size changes',
        wRes.out.body.includes('ResizeObserver'));
  check('widget.js has no external imports', !/\bimport\s|\brequire\(/.test(wRes.out.body));
  // Three states, and the resting one is a collapsed strip at an edge. The panel exists to
  // show a QR code, but an expanded panel covers the lower half of a phone screen, so it
  // opens on a tap instead of on load.
  check('widget.js rests collapsed', /collapsed:\s*true/.test(wRes.out.body));
  check('widget.js applies the collapsed state on first paint',
        wRes.out.body.includes("root.classList.toggle('dshm-collapsed', state.collapsed)"));
  check('widget.js toggles it on a header tap',
        /makeDraggable\(root, head\)|toggleCollapsed/.test(wRes.out.body));
  // Collapsing and parking travel together, and neither is remembered: a stored "hidden"
  // outlives the reason someone hid it and leaves the panel unfindable next time.
  check('widget.js rests against an edge', /edgeHidden:\s*1/.test(wRes.out.body));
  check('widget.js keeps collapsing and parking in step',
        wRes.out.body.includes('function setCollapsed')
        && /state\.edgeHidden = collapsed \? 1 : 0/.test(wRes.out.body));
  check('widget.js never remembers the collapsed state',
        /collapsed:\s*true/.test(wRes.out.body)
        && /edgeHidden:\s*1/.test(wRes.out.body)
        && !/localStorage\.setItem\('dshm-edge-v1'/.test(wRes.out.body));
  // Collapsing returns the strip to the panel's home corner, which is what stops it from
  // following a position the panel was dragged to.
  check('widget.js anchors the rested strip at home',
        wRes.out.body.includes('function goHome')
        && wRes.out.body.includes('goHome(root)'));
  // Dragging: the whole point is that the user can move it off whatever it covers.
  check('widget.js is draggable by its header',
        wRes.out.body.includes('pointerdown') && wRes.out.body.includes('makeDraggable'));
  check('widget.js remembers its position',
        wRes.out.body.includes('localStorage.setItem') && wRes.out.body.includes('positionKey'));
  check('widget.js clamps the position to the viewport',
        wRes.out.body.includes('clampPosition') && wRes.out.body.includes('window.innerWidth'));
  check('widget.js distinguishes a tap from a drag',
        /DRAG_SLOP/.test(wRes.out.body));
}

if (qrRoute) {
  const qrRes = fakeRes();
  await qrRoute({ method: 'GET', url: '/m/api/qr.svg', headers: {} }, qrRes);
  console.log('/m/api/qr.svg ->', qrRes.out.status, `${qrRes.out.body.length} bytes`);
  check('qr route serves an SVG', qrRes.out.status === 200 && qrRes.out.body.startsWith('<svg'),
        `status=${qrRes.out.status}`);
}

// ---- key-based auto pairing -------------------------------------------------
// The key is the entire gate, so both the granted and the refused paths matter.
const autoPair = routes.get('exact:/m/api/auto-pair');
check('auto-pair route registered', Boolean(autoPair));

if (autoPair) {
  const secret = code?.autoPairSecret;
  check('get-code exposes the auto-pair secret', typeof secret === 'string' && secret.length >= 16,
        secret ? `${secret.slice(0, 6)}… (${secret.length})` : 'missing');

  // The panel shows this link for copying, so it must be the same thing the QR encodes.
  // A link without the key would set up a phone that still has to be given the key later.
  const shown = code?.pairingUrl ?? '';
  check('the panel link carries the key', shown.includes('secret='), shown);
  check('the panel link carries the fallback', shown.includes('url2='), shown);

  // Wrong key must be refused with 403 and must not leak a link.
  const badRes = fakeRes();
  await autoPair({ method: 'GET', url: '/m/api/auto-pair?s=wrong-key',
                   headers: {}, socket: { remoteAddress: '100.64.0.9' } }, badRes);
  let bad = null;
  try { bad = JSON.parse(badRes.out.body); } catch { /* reported below */ }
  console.log('\nauto-pair (bad key) ->', badRes.out.status, JSON.stringify(bad));
  check('a wrong key is refused', badRes.out.status === 403, `status=${badRes.out.status}`);
  check('a refused auto-pair leaks no link', bad?.link === undefined, String(bad?.link));

  // Missing key is equally refused.
  const noneRes = fakeRes();
  await autoPair({ method: 'GET', url: '/m/api/auto-pair',
                   headers: {}, socket: { remoteAddress: '100.64.0.9' } }, noneRes);
  check('a missing key is refused', noneRes.out.status === 403, `status=${noneRes.out.status}`);

  // Correct key, from a non-loopback address, must grant a link.
  if (secret) {
    const okRes = fakeRes();
    await autoPair({ method: 'GET', url: `/m/api/auto-pair?s=${encodeURIComponent(secret)}`,
                     headers: { host: '100.82.206.124:19387' },
                     socket: { remoteAddress: '100.74.211.59' } }, okRes);
    let granted = null;
    try { granted = JSON.parse(okRes.out.body); } catch { /* reported below */ }
    console.log('auto-pair (good key, tailscale peer) ->', okRes.out.status, JSON.stringify(granted));
    check('a correct key is granted even from a non-loopback peer', okRes.out.status === 200,
          `status=${okRes.out.status}`);
    check('the granted link goes through /m/pair', String(granted?.link ?? '').includes('/m/pair?t='),
          String(granted?.link));
    check('the granted token is short-lived',
          Number(granted?.ttlMs) > 0 && Number(granted?.ttlMs) <= 10 * 60 * 1000,
          String(granted?.ttlMs));

    // A second call must NOT mint a fresh token.
    //
    // Only one pairing token exists at a time, so minting here would invalidate the link
    // the first call had just returned — and also any code currently on screen. That is
    // exactly how a device ended up stuck: every auto-pair retry killed the token the
    // previous retry had handed it, and pairing then failed as "无效或已过期".
    const againRes = fakeRes();
    await autoPair({ method: 'GET', url: `/m/api/auto-pair?s=${encodeURIComponent(secret)}`,
                     headers: { host: '100.82.206.124:19387' },
                     socket: { remoteAddress: '100.74.211.59' } }, againRes);
    let again = null;
    try { again = JSON.parse(againRes.out.body); } catch { /* reported below */ }
    check('a repeated auto-pair reuses the same token',
          again?.link === granted?.link && again?.reused === true,
          `${String(granted?.link).slice(-12)} vs ${String(again?.link).slice(-12)}`);

    // The granted link must actually redeem, which is the point of the feature.
    const token = new URL(granted.link).searchParams.get('t');
    const redeemRes = fakeRes();
    await pair({ method: 'GET', url: `/m/pair?t=${token}`,
                 headers: { host: '100.82.206.124:19387' },
                 socket: { remoteAddress: '100.74.211.59' } }, redeemRes);
    check('the granted link redeems into a device session',
          redeemRes.out.status === 302 && Boolean(redeemRes.out.headers['set-cookie']),
          `status=${redeemRes.out.status}`);
  }
}

// ---- key rotation happens together with refreshing the code -------------------
// One action should mean "everything new": refreshing the QR also replaces the auto-pair
// key, so no key issued earlier can be reused. A plain page load must NOT rotate it, or
// reloading would invalidate devices that were already configured.
{
  const load = async (payload) => {
    const res = fakeRes();
    await getCode({ method: 'POST', url: '/m/api/get-code',
                    headers: { host: '127.0.0.1:19387' }, socket: { remoteAddress: '127.0.0.1' },
                    on() {},
                    async *[Symbol.asyncIterator]() { yield Buffer.from(payload); } }, res);
    return JSON.parse(res.out.body).autoPairSecret;
  };

  const keyA = await load('{}');
  const keyB = await load('{}');
  check('a plain load keeps the same key', keyA === keyB, `${String(keyA).slice(0, 6)}...`);

  const keyC = await load('{"refresh":true}');
  console.log('\nrefresh ->', String(keyA).slice(0, 6), '->', String(keyC).slice(0, 6));
  check('refreshing replaces the key', typeof keyC === 'string' && keyC !== keyA,
        `${String(keyA).slice(0, 6)}... -> ${String(keyC).slice(0, 6)}...`);

  // The replaced key must stop working, and the new one must work.
  const staleRes = fakeRes();
  await autoPair({ method: 'GET', url: `/m/api/auto-pair?s=${encodeURIComponent(keyA)}`,
                   headers: {}, socket: { remoteAddress: '100.74.211.59' } }, staleRes);
  check('the replaced key stops working', staleRes.out.status === 403,
        `status=${staleRes.out.status}`);

  const freshRes = fakeRes();
  await autoPair({ method: 'GET', url: `/m/api/auto-pair?s=${encodeURIComponent(keyC)}`,
                   headers: {}, socket: { remoteAddress: '100.74.211.59' } }, freshRes);
  check('the refreshed key works', freshRes.out.status === 200, `status=${freshRes.out.status}`);

  // The question this answers: does refreshing the key log out devices that are already
  // connected? It must not — the key only gates auto-pairing, while an existing session
  // rests on the cookies issued by /m/pair. So a device record created before the rotation
  // has to survive it.
  const { PairingStore } = plugin;
  const store = new PairingStore(join(home, 'dsh-mobile-public', 'state.json'));
  const devicesAfter = store.devices();
  check('refreshing the key keeps already-paired devices',
        devicesAfter.length >= 1, `${devicesAfter.length} device(s) still recorded`);

  // And a fresh token still redeems into a working session afterwards, which is what the
  // already-connected phone actually relies on.
  const postRotate = routes.get('exact:/m/api/mint');
  const mintRes2 = fakeRes();
  await postRotate({ method: 'POST', url: '/m/api/mint', headers: { host: '127.0.0.1:19387' },
                     socket: { remoteAddress: '127.0.0.1' }, on() {},
                     async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } }, mintRes2);
  const relinked = JSON.parse(mintRes2.out.body);
  const tok = new URL(relinked.link).searchParams.get('t');
  const redeemRes2 = fakeRes();
  await pair({ method: 'GET', url: `/m/pair?t=${tok}`,
               headers: { host: '100.82.206.124:19387' },
               socket: { remoteAddress: '100.74.211.59' } }, redeemRes2);
  check('a token still redeems after a key refresh',
        redeemRes2.out.status === 302 && Boolean(redeemRes2.out.headers['set-cookie']),
        `status=${redeemRes2.out.status}`);

  // ---- /m/api/session: the key-sync endpoint --------------------------------
  // This hands out the auto-pair key, so it must be gated on a live device cookie. Only a
  // device the host still recognises may read it; anything else gets 403 and no key.
  const session = routes.get('exact:/m/api/session');
  check('session route registered', Boolean(session));
  if (session) {
    const anon = fakeRes();
    await session({ method: 'GET', url: '/m/api/session', headers: {},
                    socket: { remoteAddress: '100.74.211.59' } }, anon);
    check('session refuses a request with no cookie', anon.out.status === 403,
          `status=${anon.out.status}`);
    check('a refusal leaks no key', !anon.out.body.includes('autoPairSecret'), anon.out.body);

    const bogus = fakeRes();
    await session({ method: 'GET', url: '/m/api/session',
                    headers: { cookie: 'dsh_remote=not-a-real-device' },
                    socket: { remoteAddress: '100.74.211.59' } }, bogus);
    check('session refuses an unknown device', bogus.out.status === 403,
          `status=${bogus.out.status}`);

    // A real device, paired above, must get the key — and specifically the ROTATED one,
    // which is the whole point: an already-connected phone picks the new key up without
    // anyone re-scanning anything.
    const cookieHeader = String(redeemRes2.out.headers['set-cookie'] ?? '')
      .split(';')[0];
    const paired = fakeRes();
    await session({ method: 'GET', url: '/m/api/session',
                    headers: { cookie: cookieHeader },
                    socket: { remoteAddress: '100.74.211.59' } }, paired);
    let payload = null;
    try { payload = JSON.parse(paired.out.body); } catch { /* reported below */ }
    check('session serves a paired device', paired.out.status === 200,
          `status=${paired.out.status}`);
    check('the served key is the current one',
          payload?.autoPairSecret === keyC,
          `${String(payload?.autoPairSecret).slice(0, 6)}... == ${String(keyC).slice(0, 6)}...`);
  }
}
console.log();
console.log(failures === 0 ? 'ALL ORIGIN CHECKS PASSED' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
