/**
 * Which address does the plugin advertise as "the LAN"?
 *
 * Why this test exists: `lanUrl()` used to be "the first non-internal IPv4 that is not Tailscale",
 * and on a machine with another VPN installed that rule returned the VPN's address. The reported
 * case: Radmin VPN enumerated first and held `26.244.162.123` — a public address — so the pairing
 * panel advertised `http://26.244.162.123:19387`, which no phone on the Wi-Fi can reach, while the
 * real `192.168.31.36` was never examined. The symptom is indistinguishable from "the LAN does not
 * work", and it cost a debugging session on a second machine to find.
 *
 * How it is checked: the plugin reads addresses through `os.networkInterfaces()`, so this test
 * copies `lib/` to a temporary directory, replaces that one function with a fixture, imports the
 * plugin for real, and reads what its routes report. Mocking the OS boundary rather than the
 * plugin's internals means the assertions exercise the shipped code path.
 *
 * No network is used: every route is driven through the same fake request/response the other
 * route tests use.
 *
 * Run: node test/lan-address-test.cjs
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks++;
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '  → ' + detail : ''));
  }
}

/** A fixture shaped exactly like `os.networkInterfaces()`, in enumeration order. */
const FIXTURES = {
  'the reported machine: Radmin VPN enumerated first': {
    'Radmin VPN': [{ family: 'IPv4', internal: false, address: '26.244.162.123', netmask: '255.0.0.0' }],
    'WLAN': [{ family: 'IPv4', internal: false, address: '192.168.31.36', netmask: '255.255.255.0' }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
  },
  'a TAP adapter that carries a private address': {
    'SoGame-VPN': [{ family: 'IPv4', internal: false, address: '10.10.10.88' }],
    'WLAN': [{ family: 'IPv4', internal: false, address: '192.168.31.36' }],
    'Tailscale': [{ family: 'IPv4', internal: false, address: '100.82.206.124' }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
  },
  'a plain machine with Tailscale and Wi-Fi': {
    'Tailscale': [{ family: 'IPv4', internal: false, address: '100.82.206.124' }],
    'WLAN 2': [{ family: 'IPv4', internal: false, address: '192.168.31.56' }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
  },
  'link-local only: nothing usable': {
    'WLAN 4': [{ family: 'IPv4', internal: false, address: '169.254.117.97' }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
  },
  'Wi-Fi and Ethernet both present: wired wins': {
    'WLAN': [{ family: 'IPv4', internal: false, address: '192.168.31.36' }],
    'Ethernet': [{ family: 'IPv4', internal: false, address: '192.168.1.20' }],
  },
};

const EXPECTED = {
  'the reported machine: Radmin VPN enumerated first': ['http://192.168.31.36:19387'],
  'a TAP adapter that carries a private address': ['http://192.168.31.36:19387'],
  'a plain machine with Tailscale and Wi-Fi': ['http://192.168.31.56:19387'],
  'link-local only: nothing usable': [],
  'Wi-Fi and Ethernet both present: wired wins': ['http://192.168.1.20:19387', 'http://192.168.31.36:19387'],
};

function fakeReq(host, method = 'POST', body = '{}') {
  const chunks = [Buffer.from(body)];
  return {
    method,
    url: '/m/api/get-code',
    headers: { host },
    socket: { remoteAddress: '127.0.0.1', encrypted: false },
    on(event, handler) {
      if (event === 'data') chunks.forEach((chunk) => handler(chunk));
      if (event === 'end') handler();
      return this;
    },
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

function fakeRes() {
  const out = { status: 0, body: '', headers: {} };
  return {
    out,
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers || {};
    },
    end(chunk) {
      if (chunk) out.body += chunk.toString();
    },
  };
}

/** Load the plugin with `networkInterfaces` replaced by one fixture. */
async function loadWith(fixture, tempRoot) {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'lan-'));
  fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'cordis.patch.yml'),
    path.join(dir, 'cordis.patch.yml'));
  // A cache-busting query keeps each import a fresh module, so the fixture applies per case.
  const url = pathToFileURL(path.join(dir, 'lib', 'index.js')).href + '?t=' + Date.now();
  return import(url);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lan-'));
  console.log('临时目录: ' + tempRoot);
  console.log();

  for (const [label, fixture] of Object.entries(FIXTURES)) {
    console.log('用例: ' + label);
    let plugin;
    try {
      plugin = await loadWith(fixture, tempRoot);
    } catch (error) {
      check(label + ' — 插件可加载', false, error.message);
      continue;
    }
    // Capture the routes by asking the plugin to apply against a recording web server.
    const routes = new Map();
    const disposers = [];
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
        // Collect the disposers rather than discarding them. `apply()` starts a tunnel manager
        // whose polling keeps the event loop alive, so the first version of this test printed a
        // clean pass and then never exited — which looks exactly like a hung test.
        if (typeof dispose === 'function') disposers.push(dispose);
        return () => {};
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      on(event, handler) {
        if (event === 'webserver/index-inject') handler([]);
        return () => {};
      },
      inject(names, callback) {
        callback(ctx);
      }
    };
    let temporaryHome;
    // The stub has to stay installed until the routes are *called*, not just until the module is
    // imported: the plugin resolves `networkInterfaces()` at call time, so restoring it after
    // `import()` left every case answering with the first case's fixture.
    //
    // `syncBuiltinESMExports()` is required as well. `node:os` has two views in Node — the CommonJS
    // export and the ESM module namespace — and assigning to one does not update the other. Without
    // the sync the plugin's ESM import kept calling the real `networkInterfaces()`, so every case
    // reported the machine this test runs on (192.168.31.56) instead of its fixture.
    const osModule = require('node:os');
    const realNetworkInterfaces = osModule.networkInterfaces;
    osModule.networkInterfaces = () => fixture;
    require('node:module').syncBuiltinESMExports();
    try {
      // DSH_HOME must point somewhere temporary. Without it the plugin reads and writes the
      // operator's real pairing state — including rotating the live auto-pair key, which would
      // invalidate every already-paired phone (a mistake this repository has already made once).
      temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'));
      process.env.DSH_HOME = temporaryHome;
      await plugin.apply(ctx, {
        tunnelUrl: 'https://test-tunnel.example',
        stateFile: path.join(temporaryHome, 'state.json')
      });
    } catch (error) {
      check(label + ' — 插件可注册', false, error.message);
      osModule.networkInterfaces = realNetworkInterfaces;
    require('node:module').syncBuiltinESMExports();
      fs.rmSync(temporaryHome, { recursive: true, force: true });
      continue;
    }

    const handler = routes.get('exact:/m/api/get-code');
    if (!handler) {
      check(label + ' — get-code 路由存在', false);
      osModule.networkInterfaces = realNetworkInterfaces;
    require('node:module').syncBuiltinESMExports();
      fs.rmSync(temporaryHome, { recursive: true, force: true });
      continue;
    }
    const res = fakeRes();
    await handler(fakeReq('127.0.0.1:19387'), res);
    let payload = null;
    try {
      payload = JSON.parse(res.out.body);
    } catch { /* reported below */ }
    const got = payload && Array.isArray(payload.lanUrls) ? payload.lanUrls : (payload && payload.lanUrl ? [payload.lanUrl] : []);
    const want = EXPECTED[label];
    check('  lanUrl 正确', JSON.stringify(got) === JSON.stringify(want),
      '得到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want));
    // A VPN or non-private address must never be what the panel advertises.
    if (payload && payload.lanUrl) {
      check('  不是 VPN / 非私网地址',
        !/26\.244\.|10\.10\.10\.|100\.82\.|169\.254\./.test(payload.lanUrl),
        payload.lanUrl);
    }
    // Release everything apply() started, then restore the real os view.
    for (const dispose of disposers.splice(0)) {
      try { dispose(); } catch { /* a disposer that throws must not fail the run */ }
    }
    fs.rmSync(temporaryHome, { recursive: true, force: true });
    osModule.networkInterfaces = realNetworkInterfaces;
    require('node:module').syncBuiltinESMExports();
    console.log();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log();
  if (failures) {
    console.log(failures + ' / ' + checks + ' 项失败');
    process.exit(1);
  }
  console.log('ALL LAN ADDRESS CHECKS PASSED (' + checks + ' 项)');
  // Exit explicitly. Even with the disposers released, a stray handle would otherwise keep the
  // process alive after a clean pass, and a test that hangs after passing is worse than one that
  // fails: it looks like a bug in the code under test.
  process.exit(0);
}

main().catch((error) => {
  console.error('测试自身出错: ' + (error && error.stack || error));
  process.exit(1);
});
