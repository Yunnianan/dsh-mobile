/**
 * Behaviour self-test for dsh-mobile-public.
 *
 * Covers the two pieces with real logic: the pairing store (single-use tokens,
 * device expiry, revocation) and the tunnel manager (URL discovery, lifecycle).
 * The tunnel is driven through an injected fake child process, so this runs with
 * no network and no cloudflared binary.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PairingStore, TunnelManager, describeDevice, isLoopbackAddress, safeEqual } from '../lib/index.js';

let failures = 0;
const check = (label, condition) => {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}`);
  }
};

// ---------------------------------------------------------------- pairing store
console.log('pairing store');
const dir = mkdtempSync(join(tmpdir(), 'dsh-mp-'));
const storeFile = join(dir, 'state.json');
{
  const store = new PairingStore(storeFile);
  const minted = store.mintToken(60_000, 'test');
  check('mint returns a token', typeof minted.token === 'string' && minted.token.length > 20);
  check('mint records an expiry in the future', minted.expiresAt > Date.now());
  check('activeToken reflects the mint', store.activeToken()?.token === minted.token);

  const second = store.mintToken(60_000);
  check('re-minting invalidates the previous token', store.redeem(minted.token, 60_000, 'ua') === undefined);
  check('the newer token still redeems', store.redeem(second.token, 60_000, 'ua') !== undefined);
  check('a token is single use', store.redeem(second.token, 60_000, 'ua') === undefined);

  const before = store.devices().length;
  const third = store.mintToken(60_000);
  const device = store.redeem(third.token, 60_000, 'Mozilla/5.0 (Linux; Android 14; Pixel) DSHMobile/1.0');
  check('redeem yields a device id', typeof device?.deviceId === 'string' && device.deviceId.length > 10);
  check('touch resolves the device', store.touch(device.deviceId) !== undefined);
  check('touch rejects an unknown device', store.touch('nope') === undefined);
  check('a redeem adds exactly one device', store.devices().length === before + 1);
  const labels = store.devices().map((d) => d.label);
  check('the Android device is labelled', labels.includes('Android · DSH Mobile'));
  check('raw ids are not exposed in full', store.devices().every((d) => d.id.includes('…')));
  check('user agent strings are not exposed', !JSON.stringify(store.devices()).includes('Mozilla/'));

  const expiring = store.mintToken(60_000);
  const shortLived = store.redeem(expiring.token, -1, 'ua');
  check('an already-expired device does not resolve', store.touch(shortLived.deviceId) === undefined);

  store.revokeAll();
  check('revokeAll clears devices', store.devices().length === 0);

  // Persistence round-trip
  const again = store.mintToken(60_000);
  const revived = store.redeem(again.token, 60_000, 'ua');
  const reloaded = new PairingStore(storeFile);
  check('devices survive a reload', reloaded.touch(revived.deviceId) !== undefined);
}
rmSync(dir, { recursive: true, force: true });

// ------------------------------------------------------------------- tunnel mgr
console.log('tunnel manager (cloudflared)');
{
  const children = [];
  const spawnFn = (binary, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; child.emit('exit', 0, null); };
    children.push({ binary, args, child });
    return child;
  };

  const manager = new TunnelManager({
    provider: 'cloudflared',
    binary: import.meta.filename, // any existing file: the fake spawn ignores it
    port: 19387,
    spawnFn
  });

  check('starts in the stopped state', manager.status().state === 'stopped');
  check('reports its provider', manager.status().provider === 'cloudflared');
  manager.start();
  check('start reports starting', manager.status().state === 'starting');
  check('spawn receives the tunnel arguments',
    children[0].args.join(' ') === 'tunnel --no-autoupdate --url http://127.0.0.1:19387');
  check('starting advertises a readiness hint', typeof manager.status().readyHint === 'string');

  children[0].child.stderr.emit('data', 'INF |  https://happy-words-1234.trycloudflare.com  |\n');
  check('URL is discovered from cloudflared output',
    manager.status().url === 'https://happy-words-1234.trycloudflare.com');
  check('state becomes running', manager.status().state === 'running');
  // status() returns a fresh object each call, so compare content, not reference.
  check('start is idempotent while running',
    JSON.stringify(manager.start()) === JSON.stringify(manager.status()) && children.length === 1);

  manager.stop();
  check('stop clears the URL', manager.status().url === undefined);
  check('stop returns to stopped', manager.status().state === 'stopped');
  check('stop kills the child', children[0].child.killed === true);

  // A non-zero exit is a failure, not a clean stop.
  manager.start();
  children[1].child.emit('exit', 1, null);
  check('non-zero exit becomes failed', manager.status().state === 'failed');
  check('failure carries a reason', typeof manager.status().error === 'string');

  // A missing binary fails fast with a clear message.
  const missing = new TunnelManager({ provider: 'cloudflared', binary: join(tmpdir(), 'definitely-not-here.exe'), port: 1, spawnFn });
  missing.start();
  check('missing binary fails without spawning', missing.status().state === 'failed' && children.length === 2);
  check('missing binary message names the path', /not found/.test(missing.status().error));
}

// The SSH provider is the fallback that needs no downloaded binary, so its
// argument construction and URL parsing are worth asserting on their own.
console.log('tunnel manager (ssh relay)');
{
  const children = [];
  const spawnFn = (binary, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; child.emit('exit', 0, null); };
    children.push({ binary, args, child });
    return child;
  };
  const manager = new TunnelManager({
    provider: 'ssh',
    binary: import.meta.filename,
    port: 19387,
    spawnFn
  });
  check('reports the ssh provider', manager.status().provider === 'ssh');
  manager.start();
  const args = children[0].args;
  check('forwards the port in reverse', args.includes('-R') && args.includes('80:127.0.0.1:19387'));
  check('uses a non-interactive host-key policy',
    args.includes('StrictHostKeyChecking=no') && args.includes('UserKnownHostsFile=NUL'));
  check('targets the relay host', args.some((a) => a.endsWith('@localhost.run')));

  // localhost.run announces its hostname on stderr after the SSH banner.
  children[0].child.stderr.emit('data', 'Warning: Permanently added the ED25519 host key.\n');
  check('banner noise does not end the starting state', manager.status().state === 'starting');
  children[0].child.stderr.emit('data', 'abc123def456.lhr.life tunneled with tls termination, https://abc123def456.lhr.life\n');
  check('URL is discovered from relay output', manager.status().url === 'https://abc123def456.lhr.life');
  check('state becomes running', manager.status().state === 'running');
  manager.stop();
}

// ------------------------------------------------------------------ small utils
console.log('helpers');
check('loopback v4', isLoopbackAddress('127.0.0.1'));
check('loopback v6', isLoopbackAddress('::1'));
check('loopback mapped', isLoopbackAddress('::ffff:127.0.0.1'));
check('lan is not loopback', !isLoopbackAddress('192.168.31.56'));
check('safeEqual matches', safeEqual('abc', 'abc'));
check('safeEqual rejects', !safeEqual('abc', 'abd'));
check('safeEqual handles length mismatch', !safeEqual('abc', 'abcd'));
check('iPhone label', describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1') === 'iOS · Safari');

console.log('');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
