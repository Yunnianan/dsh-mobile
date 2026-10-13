/**
 * Which addresses does the plugin advertise as "the LAN", and in what order?
 *
 * The bug this covers: `lanUrl()` used to be "the first non-internal IPv4 that is not Tailscale".
 * On a machine with another VPN installed that returned the VPN's address — the report had Radmin
 * VPN enumerated first, holding `26.244.162.123`, a *public* address — so the pairing panel
 * advertised something no phone could reach while the real `192.168.31.36` was never examined.
 * The symptom is indistinguishable from "the LAN does not work".
 *
 * The rule now avoids interface names entirely. Names are localised (this machine's adapters are
 * `WLAN` and `以太网`), every VPN vendor invents its own, and a false positive silently discards the
 * one address that works — so an earlier name blacklist was removed. What decides instead:
 *
 *   1. the OS's own default route (`Get-NetRoute`), naming the interface the machine really uses;
 *   2. RFC1918 address space, which rejects Radmin's public address outright;
 *   3. the reserved `198.18.0.0/15` block, where Clash and sing-box put their tunnel by default.
 *
 * Ordering is a preference, not a verdict: the client receives the whole list and probes it, so a
 * wrong entry costs one probe rather than a failed pairing. These tests therefore assert the full
 * ordered list rather than a single winner.
 *
 * Known residual limitation, stated rather than hidden: a VPN that is *not* the default route and
 * that uses an ordinary private range (a WireGuard tunnel on `10.0.0.0/24`, say) still appears in
 * the list. It is ranked after the default-route interface, so the phone tries the real LAN first
 * and only falls through if that fails. Detecting it would mean consulting interface properties
 * again — the thing this rule exists to avoid.
 *
 * How it is checked: the plugin reads addresses through `os.networkInterfaces()` and the route
 * through `child_process.execFileSync`, so this test copies `lib/` to a temporary directory,
 * replaces both, imports the plugin for real, and reads what its route reports. Stubbing the OS
 * boundaries rather than the plugin's internals means the assertions exercise shipped code.
 *
 * Run: node test/lan-address-test.cjs
 */

'use strict';

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

const loopback = { family: 'IPv4', internal: true, address: '127.0.0.1' };
const v4 = (address) => ({ family: 'IPv4', internal: false, address });

/**
 * Each case: the interfaces the plugin will see, the names the stubbed route query reports as
 * carrying the default route, and the exact list expected back.
 */
const CASES = [
  {
    label: '报告的机器：Radmin VPN 枚举在前，WLAN 承载默认路由',
    interfaces: {
      'Radmin VPN': [v4('26.244.162.123')],
      'WLAN': [v4('192.168.31.36')],
      'Loopback Pseudo-Interface 1': [loopback]
    },
    defaultRoutes: ['WLAN'],
    expected: ['http://192.168.31.36:19387']
  },
  {
    label: 'TAP 网卡的私网地址保留，但排在默认路由之后',
    interfaces: {
      'SoGame-VPN': [v4('10.10.10.88')],
      'WLAN': [v4('192.168.31.36')],
      'Tailscale': [v4('100.82.206.124')],
      'Loopback Pseudo-Interface 1': [loopback]
    },
    defaultRoutes: ['WLAN'],
    // Both are private, so both are offered. Dropping the TAP address by name was the old
    // behaviour and exactly the brittleness being removed; keeping it costs one failed probe.
    expected: ['http://192.168.31.36:19387', 'http://10.10.10.88:19387']
  },
  {
    label: '普通机器：Tailscale + WiFi',
    interfaces: {
      'Tailscale': [v4('100.82.206.124')],
      'WLAN 2': [v4('192.168.31.56')],
      'Loopback Pseudo-Interface 1': [loopback]
    },
    defaultRoutes: ['WLAN 2'],
    expected: ['http://192.168.31.56:19387']
  },
  {
    label: '只有链路本地地址：没有可用内网',
    interfaces: {
      'WLAN 4': [v4('169.254.117.97')],
      'Loopback Pseudo-Interface 1': [loopback]
    },
    defaultRoutes: [],
    expected: []
  },
  {
    label: '隧道用 198.18/15 预留段：仅在别无选择时给出',
    interfaces: {
      'Some Tunnel': [v4('198.18.0.1')],
      'Loopback Pseudo-Interface 1': [loopback]
    },
    defaultRoutes: ['Some Tunnel'],
    expected: ['http://198.18.0.1:19387']
  },
  {
    label: '真内网地址优先于 198.18/15 预留段',
    interfaces: {
      'Some Tunnel': [v4('198.18.0.1')],
      'WLAN': [v4('192.168.31.36')],
      'Loopback Pseudo-Interface 1': [loopback]
    },
    defaultRoutes: ['Some Tunnel', 'WLAN'],
    expected: ['http://192.168.31.36:19387']
  },
  {
    label: '顺序由默认路由决定，而不是枚举顺序',
    interfaces: {
      'Ethernet': [v4('192.168.1.20')],
      'WLAN': [v4('192.168.31.36')]
    },
    defaultRoutes: ['WLAN'],
    // WLAN is enumerated second but carries the default route, so it leads.
    expected: ['http://192.168.31.36:19387', 'http://192.168.1.20:19387']
  },
  {
    label: '没有默认路由信息时退化为纯地址过滤（仍排除公网段）',
    interfaces: {
      'Radmin VPN': [v4('26.244.162.123')],
      'WLAN': [v4('192.168.31.36')]
    },
    defaultRoutes: [],
    expected: ['http://192.168.31.36:19387']
  }
];

function fakeReq() {
  const chunks = [Buffer.from('{}')];
  return {
    method: 'POST',
    url: '/m/api/get-code',
    headers: { host: '127.0.0.1:19387' },
    socket: { remoteAddress: '127.0.0.1', encrypted: false },
    on(event, handler) {
      if (event === 'data') chunks.forEach((chunk) => handler(chunk));
      if (event === 'end') handler();
      return this;
    },
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    }
  };
}

function fakeRes() {
  const out = { status: 0, body: '' };
  return {
    out,
    writeHead(status) { out.status = status; },
    end(chunk) { if (chunk) out.body += chunk.toString(); }
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lan-'));
  console.log('临时目录: ' + root);
  console.log();

  for (const testCase of CASES) {
    console.log('用例: ' + testCase.label);

    // Copy the real lib so the plugin under test is the shipped code.
    const dir = fs.mkdtempSync(path.join(root, 'plug-'));
    fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(dir, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'cordis.patch.yml'),
      path.join(dir, 'cordis.patch.yml'));

    // Stub both OS boundaries. They must stay stubbed until the routes are *called* — the plugin
    // resolves them at call time — and `syncBuiltinESMExports()` is required because `node:os` and
    // `node:child_process` have separate CommonJS and ESM views: assigning to one does not update
    // the other, which silently left every case using real data.
    const osModule = require('node:os');
    const cpModule = require('node:child_process');
    const realInterfaces = osModule.networkInterfaces;
    const realExec = cpModule.execFileSync;
    osModule.networkInterfaces = () => testCase.interfaces;
    cpModule.execFileSync = () => testCase.defaultRoutes.join('\n');
    require('node:module').syncBuiltinESMExports();

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
      connection: { authenticatedUrl: (base) => `${base}?token=STUB` },
      effect(fn) {
        const dispose = fn();
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

    const home = fs.mkdtempSync(path.join(root, 'home-'));
    process.env.DSH_HOME = home;

    let got = null;
    try {
      const url = pathToFileURL(path.join(dir, 'lib', 'index.js')).href + '?t=' + Date.now();
      const plugin = await import(url);
      await plugin.apply(ctx, {
        tunnelUrl: 'https://test-tunnel.example',
        stateFile: path.join(home, 'state.json')
      });
      const handler = routes.get('exact:/m/api/get-code');
      if (!handler) throw new Error('get-code 路由未注册');
      const res = fakeRes();
      await handler(fakeReq(), res);
      const payload = JSON.parse(res.out.body);
      got = Array.isArray(payload.lanUrls) ? payload.lanUrls : (payload.lanUrl ? [payload.lanUrl] : []);
    } catch (error) {
      check('  插件可加载并应答', false, error.message);
      got = null;
    } finally {
      for (const dispose of disposers.splice(0)) {
        try { dispose(); } catch { /* must not fail the run */ }
      }
      osModule.networkInterfaces = realInterfaces;
      cpModule.execFileSync = realExec;
      require('node:module').syncBuiltinESMExports();
      fs.rmSync(home, { recursive: true, force: true });
    }

    if (got !== null) {
      check('  地址列表与顺序正确',
        JSON.stringify(got) === JSON.stringify(testCase.expected),
        '得到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(testCase.expected));
      if (got.length > 0) {
        check('  没有公网段地址（如 Radmin 的 26.x）',
          !got.some((url) => /^http:\/\/26\./.test(url)), JSON.stringify(got));
      }
    }
    console.log();
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log();
  if (failures) {
    console.log(failures + ' / ' + checks + ' 项失败');
    process.exit(1);
  }
  console.log('ALL LAN ADDRESS CHECKS PASSED (' + checks + ' 项)');
  // Exit explicitly: the plugin's tunnel manager keeps handles open, and a test that passes and
  // then hangs looks like a bug in the code under test rather than in the test.
  process.exit(0);
}

main().catch((error) => {
  console.error('测试自身出错: ' + (error && error.stack || error));
  process.exit(1);
});
