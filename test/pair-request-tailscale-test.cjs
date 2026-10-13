/**
 * Pairing from outside the house, approved by Tailscale identity.
 *
 * The gap this covers: the three LAN pairing paths all require something that exists only on the
 * desktop — the QR code, the auto-pair key, or a click on the panel. A user away from home has none
 * of them, so before this the phone could not pair at all. Tailscale supplies the missing proof: the
 * host asks its own tailnet who an address belongs to, and a device in the operator's tailnet has
 * already been authenticated by Tailscale. That is a stronger statement than "it is on this subnet",
 * which is forgeable and this is not.
 *
 * What must hold, and is asserted here:
 *
 *   1. a request from this tailnet's own user is approved without a click;
 *   2. a node in the netmap but belonging to a *different* user is NOT approved;
 *   3. an address Tailscale does not know is NOT approved;
 *   4. a plain LAN address is NOT approved — the LAN path still needs the operator's click;
 *   5. no Tailscale at all (no CLI, not running) means no shortcut, never "trust everyone";
 *   6. the approval still hands over exactly one link, and appears nowhere in the panel's
 *      pending list (a button there could only come back 404, which reads as a failure).
 *
 * The CLI is stubbed. Testing against the real one would make the result depend on the machine
 * running the tests having Tailscale installed and a tailnet containing the right nodes — the kind
 * of test that passes on one developer's laptop and fails on the next.
 *
 * Run: node test/pair-request-tailscale-test.cjs
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

function fakeReq(options = {}) {
  const bodyText = options.body === undefined ? '{}' : JSON.stringify(options.body);
  const chunks = [Buffer.from(bodyText)];
  return {
    method: options.method ?? 'POST',
    url: options.url ?? '/m/api/pair-request',
    headers: { host: options.host ?? '100.82.206.124:19387' },
    socket: { remoteAddress: options.remote ?? '192.168.31.166', encrypted: false },
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
  const out = { status: 0, headers: {}, body: '' };
  return {
    out,
    writeHead(status, headers) {
      out.status = status;
      Object.assign(out.headers, headers ?? {});
    },
    end(chunk) {
      if (chunk !== undefined) out.body += chunk.toString();
    }
  };
}

const json = (res) => {
  try {
    return JSON.parse(res.out.body);
  } catch {
    return null;
  }
};

const SELF_USER = '6374190055757848';
const OTHER_USER = '9999999999999999';

/**
 * Boot the plugin with a scripted Tailscale CLI.
 *
 * @param tailscale  {selfUserId, whois} — `null` for "no Tailscale installed at all".
 */
async function boot(root, tailscale) {
  const dir = fs.mkdtempSync(path.join(root, 'plug-'));
  fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'cordis.patch.yml'),
    path.join(dir, 'cordis.patch.yml'));

  const osModule = require('node:os');
  const cpModule = require('node:child_process');
  const realInterfaces = osModule.networkInterfaces;
  const realExec = cpModule.execFileSync;
  osModule.networkInterfaces = () => ({
    'WLAN': [{ family: 'IPv4', internal: false, address: '192.168.31.56' }],
    'Tailscale': [{ family: 'IPv4', internal: false, address: '100.82.206.124' }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }]
  });
  cpModule.execFileSync = (file, args) => {
    if (file !== 'tailscale') throw new Error('the CLI must not be reached in this test');
    if (tailscale === null) throw new Error('tailscale is not installed');
    if (args[0] === 'status') {
      if (tailscale.selfUserId === null) throw new Error('tailscale is not running');
      return JSON.stringify({ Self: { UserID: tailscale.selfUserId } });
    }
    if (args[0] === 'whois') {
      const address = args[args.length - 1];
      const node = (tailscale.whois ?? {})[address];
      if (node === undefined) throw new Error('peer not found');
      return JSON.stringify({ Node: node });
    }
    throw new Error('unexpected invocation: ' + args.join(' '));
  };
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
  const url = pathToFileURL(path.join(dir, 'lib', 'index.js')).href + '?t=' + Date.now();
  const plugin = await import(url);
  await plugin.apply(ctx, {
    tunnelUrl: 'https://test-tunnel.example',
    stateFile: path.join(home, 'state.json')
  });

  return {
    routes,
    stop() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch { /* must not fail the run */ }
      }
      osModule.networkInterfaces = realInterfaces;
      cpModule.execFileSync = realExec;
      require('node:module').syncBuiltinESMExports();
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

const nodeFor = (user, name) => ({ Name: `${name}.tail951e59.ts.net.`, StableID: name + 'ID', User: user });

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ts-'));
  const cases = [
    {
      label: '本 tailnet 自己账号的设备 → 自动批准',
      tailscale: { selfUserId: SELF_USER, whois: { '100.88.174.96': nodeFor(SELF_USER, 'xiaomi-17-pro') } },
      remote: '100.88.174.96',
      expectApproved: true
    },
    {
      label: 'netmap 里但属于别的账号 → 不批准',
      tailscale: { selfUserId: SELF_USER, whois: { '100.5.5.5': nodeFor(OTHER_USER, 'stranger') } },
      remote: '100.5.5.5',
      expectApproved: false
    },
    {
      label: 'Tailscale 不认识的 100.x 地址 → 不批准',
      tailscale: { selfUserId: SELF_USER, whois: {} },
      remote: '100.99.99.99',
      expectApproved: false
    },
    {
      label: '局域网地址 → 不批准（仍需点「允许」）',
      tailscale: { selfUserId: SELF_USER, whois: { '192.168.31.166': nodeFor(SELF_USER, 'x') } },
      remote: '192.168.31.166',
      expectApproved: false
    },
    {
      label: '公网地址 → 不批准',
      tailscale: { selfUserId: SELF_USER, whois: { '8.8.8.8': nodeFor(SELF_USER, 'x') } },
      remote: '8.8.8.8',
      expectApproved: false
    },
    {
      label: '完全没装 Tailscale → 不批准（绝不等于信任所有人）',
      tailscale: null,
      remote: '100.88.174.96',
      expectApproved: false
    },
    {
      label: 'Tailscale 装了但没运行 → 不批准',
      tailscale: { selfUserId: null, whois: { '100.88.174.96': nodeFor(SELF_USER, 'x') } },
      remote: '100.88.174.96',
      expectApproved: false
    }
  ];

  for (const testCase of cases) {
    console.log('用例: ' + testCase.label);
    const app = await boot(root, testCase.tailscale);
    const lodge = app.routes.get('exact:/m/api/pair-request');
    const status = app.routes.get('exact:/m/api/pair-request/status');
    const list = app.routes.get('exact:/m/api/pair-requests');

    const res = fakeRes();
    await lodge(fakeReq({ remote: testCase.remote, body: { name: 'Test Phone' } }), res);
    const lodged = json(res);
    check('  请求被接受', res.out.status === 200 && typeof lodged?.id === 'string',
      `${res.out.status} ${res.out.body}`);
    check('  批准状态符合预期', lodged?.approved === testCase.expectApproved,
      `approved=${lodged?.approved}`);
    check('  来源标注正确',
      lodged?.via === (testCase.expectApproved ? 'tailscale' : 'lan'), String(lodged?.via));

    // The panel must not offer a button for a request that is already settled.
    const listRes = fakeRes();
    await list(fakeReq({ method: 'GET', url: '/m/api/pair-requests', remote: '127.0.0.1' }), listRes);
    const pending = (json(listRes)?.requests ?? []).map((item) => item.id);
    if (testCase.expectApproved) {
      check('  自动批准的请求不出现在待批准列表', !pending.includes(lodged?.id),
        JSON.stringify(pending.length));
    } else {
      check('  未批准的请求出现在待批准列表', pending.includes(lodged?.id));
    }

    // Approved or not, exactly one link is handed over if one is handed over at all.
    const id = lodged?.id ?? '';
    const first = fakeRes();
    await status(fakeReq({ method: 'GET', url: `/m/api/pair-request/status?id=${id}`, remote: testCase.remote }), first);
    const firstJson = json(first);
    if (testCase.expectApproved) {
      check('  批准后立刻能取到链接',
        firstJson?.status === 'approved' && String(firstJson?.link ?? '').includes('/m/pair?t='),
        first.out.body);
    } else {
      check('  未批准时只回 pending 且没有链接',
        firstJson?.status === 'pending' && firstJson?.link === undefined, first.out.body);
    }

    const second = fakeRes();
    await status(fakeReq({ method: 'GET', url: `/m/api/pair-request/status?id=${id}`, remote: testCase.remote }), second);
    check('  第二次读取拿不到任何东西',
      json(second)?.status === 'unknown' || json(second)?.status === 'pending', second.out.body);

    app.stop();
    console.log();
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log();
  if (failures) {
    console.log(failures + ' / ' + checks + ' 项失败');
    process.exit(1);
  }
  console.log('ALL TAILSCALE PAIRING CHECKS PASSED (' + checks + ' 项)');
  process.exit(0);
}

main().catch((error) => {
  console.error('测试自身出错: ' + (error && error.stack || error));
  process.exit(1);
});
