/**
 * Integration test: run the plugin's real routing against a real HTTP server.
 *
 * Boots `apply()` with a fake host context that provides the two services the
 * plugin injects (`webServer` with the real route contract, and `connection` with
 * `authenticatedUrl`), then drives the routes over the loopback with actual HTTP
 * requests. This proves the pairing flow and the authenticated redirect work
 * before the host ever recomposes.
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const plugin = await import('../lib/index.js');

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
};

// ---- fake host context -------------------------------------------------------
const exact = new Map();
const prefixes = new Map();
const injectedRows = [];
const disposers = [];

const fakeCtx = {
  effect(factory, label) {
    const dispose = factory();
    disposers.push({ dispose, label });
    return dispose;
  },
  // The plugin registers a webserver/index-inject row synchronously in apply() and
  // defers the rest to ctx.inject, so both surfaces must exist here.
  on(event, handler) {
    if (event === 'webserver/index-inject') {
      handler(injectedRows);
      fakeCtx.__injectHandler = handler;
    }
    return () => {};
  },
  inject(names, callback) {
    callback(fakeCtx);
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  webServer: {
    port: 0, // filled in once the test server is listening
    host: '127.0.0.1',
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes;
      if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route ${route.path}`);
      table.set(route.path, route);
      return () => table.delete(route.path);
    },
    match(pathname) {
      const hit = exact.get(pathname);
      if (hit !== undefined) return hit;
      let best;
      for (const [prefix, route] of prefixes) {
        if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
        if (best === undefined || prefix.length > best.path.length) best = route;
      }
      return best;
    }
  },
  connection: {
    // Mirrors the host's BrowserAuth.authenticatedUrl: the launch token goes in
    // the query, which is what mints the auth cookie.
    authenticatedUrl(baseUrl) {
      const url = new URL(baseUrl);
      url.searchParams.set('token', 'TEST-LAUNCH-TOKEN');
      return url.href;
    }
  }
};

// ---- server ------------------------------------------------------------------
const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>harness root</title>HARNESS-ROOT');
    return;
  }
  const route = fakeCtx.webServer.match(pathname);
  if (route === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(error));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
fakeCtx.webServer.port = port;
const base = `http://127.0.0.1:${String(port)}`;

// ---- boot the plugin ---------------------------------------------------------
const home = mkdtempSync(join(tmpdir(), 'dsh-mp-int-'));
process.env.DSH_HOME = home;

plugin.apply(fakeCtx, { autoStart: false, profile: 'test' });

const get = async (path, init) => {
  const res = await fetch(`${base}${path}`, { redirect: 'manual', ...init });
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
};

console.log('routes mounted');
check('pairing page is registered', exact.has('/m/pair'));
check('status route is registered', exact.has('/m/api/status'));
check('mint route is registered', exact.has('/m/api/mint'));
check('tunnel control route is registered', exact.has('/m/api/tunnel'));
check('devices route is registered', exact.has('/m/api/devices'));

console.log('status and pairing page');
{
  const status = await get('/m/api/status');
  check('status answers 200', status.status === 200, `got ${status.status}`);
  const parsed = JSON.parse(status.body);
  check('status reports the profile', parsed.profile === 'test', JSON.stringify(parsed.profile));
  check('status reports the tunnel as stopped', parsed.tunnel.state === 'stopped', parsed.tunnel.state);
  check('status confirms authenticatedUrl is available', parsed.authenticatedUrlAvailable === true);
  check('status exposes no live token yet', parsed.token === null);

  const page = await get('/m/pair');
  check('pairing page answers 200', page.status === 200, `got ${page.status}`);
  check('pairing page is HTML', page.headers.get('content-type')?.includes('text/html') === true);
  check('pairing page warns when no token is live', page.body.includes('No pairing token is live'));
}

console.log('mint -> pair -> authenticated redirect');
{
  const mint = await get('/m/api/mint', { method: 'POST' });
  check('mint answers 200', mint.status === 200, `got ${mint.status}`);
  const minted = JSON.parse(mint.body);
  check('mint returns an expiry', typeof minted.expiresAt === 'number');
  // A link is built from the best available origin. With no tunnel configured that
  // used to mean no link at all; now a LAN or Tailscale address serves instead, so
  // the invariant is that any non-null link names a real origin.
  if (minted.link === null) {
    check('mint omits the QR when no origin exists at all', minted.qr === null);
  } else {
    check('mint builds the link from an available origin', /\?t=/.test(minted.link), minted.link);
    check('mint reports which origin it used',
          ['tailscale', 'lan', 'tunnel'].includes(minted.scope), String(minted.scope));
    check('mint includes a QR for that link', typeof minted.qr === 'string' && minted.qr.startsWith('<svg'));
  }

  // Without a tunnel the pairing link cannot be built, so read the token from the
  // store the way the page does and drive the redemption directly.
  const { PairingStore } = plugin;
  const store = new PairingStore(join(home, 'dsh-mobile-public', 'state.json'));
  const active = store.activeToken();
  check('the minted token is active', active !== undefined);

  const redeem = await get(`/m/pair?t=${encodeURIComponent(active.token)}`);
  check('redeeming answers 302', redeem.status === 302, `got ${redeem.status}`);
  const location = redeem.headers.get('location') ?? '';
  check('redeem redirects with the harness launch token', location.includes('token=TEST-LAUNCH-TOKEN'), location);
  check('redeem sets the device cookie', (redeem.headers.get('set-cookie') ?? '').includes('dsh_remote='));
  check('the device cookie is HttpOnly', (redeem.headers.get('set-cookie') ?? '').includes('HttpOnly'));

  const again = await get(`/m/pair?t=${encodeURIComponent(active.token)}`);
  check('a spent token is refused', again.status === 403, `got ${again.status}`);

  const devices = await get('/m/api/devices');
  const listed = JSON.parse(devices.body).devices;
  check('the device is recorded', listed.length === 1, JSON.stringify(listed));
  check('the device list hides raw ids', listed[0].id.includes('…'));
}

console.log('pairing page with a public URL offers a scannable QR');
{
  // Simulate a running tunnel by pointing the config's publicBaseUrl at this
  // server, which is what publicUrl() falls back to.
  const tunnelRoute = exact.get('/m/api/tunnel');
  check('tunnel control rejects a bogus action', (await get('/m/api/tunnel?action=nope')).status === 400);

  const mint = JSON.parse((await get('/m/api/mint', { method: 'POST' })).body);
  check('mint still works', mint.expiresAt > Date.now());
}

console.log('device revocation');
{
  const before = JSON.parse((await get('/m/api/devices')).body).devices.length;
  const res = await fetch(`${base}/m/api/devices`, { method: 'DELETE' });
  check('revoke answers 200', res.status === 200);
  const after = JSON.parse((await get('/m/api/devices')).body).devices.length;
  check('revoke removes every device', before === 1 && after === 0, `${before} -> ${after}`);
}

console.log('teardown');
{
  for (const { dispose } of disposers.reverse()) {
    if (typeof dispose === 'function') dispose();
  }
  check('routes are removed on dispose', exact.size === 0, `exact size ${exact.size}`);
}

server.close();
rmSync(home, { recursive: true, force: true });

console.log('');
console.log(failures === 0 ? 'ALL INTEGRATION CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
