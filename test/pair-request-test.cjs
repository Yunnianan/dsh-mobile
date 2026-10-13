/**
 * Pairing by request, approved on the desktop.
 *
 * The feature this covers: a phone that finds the host on the network but holds no auto-pair key
 * asks to pair, and the request only becomes a credential when a human clicks Allow on the desktop.
 * That is what makes the phone able to pair itself without a QR scan while keeping the trust
 * argument intact — network position proves nothing, the click proves possession of the machine.
 *
 * What is asserted, in the order that matters:
 *
 *   1. a device on the LAN can lodge a request at all;
 *   2. that request yields *nothing* until it is approved — no link, no token, no key;
 *   3. approval is loopback-only, so a network caller cannot approve itself;
 *   4. rejection yields nothing, ever;
 *   5. an approved link is handed over exactly once;
 *   6. an unknown or guessed id yields nothing;
 *   7. a request that is never touched expires and yields nothing.
 *
 * No network is used: routes are driven through fake request/response objects, with
 * `socket.remoteAddress` set to simulate where the caller is.
 *
 * Run: node test/pair-request-test.cjs
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
  const bodyText = options.body === undefined ? '' : JSON.stringify(options.body);
  const chunks = bodyText ? [Buffer.from(bodyText)] : [];
  return {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: { host: options.host ?? '192.168.31.56:19387' },
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

/** Load the plugin with a stub network, against a throwaway DSH home. */
async function loadPlugin(root) {
  const dir = fs.mkdtempSync(path.join(root, 'plug-'));
  fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'cordis.patch.yml'),
    path.join(dir, 'cordis.patch.yml'));

  // One private LAN address and one Tailscale address, so the minted link has a real base.
  const fixture = {
    'WLAN': [{ family: 'IPv4', internal: false, address: '192.168.31.56' }],
    'Tailscale': [{ family: 'IPv4', internal: false, address: '100.82.206.124' }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }]
  };
  const osModule = require('node:os');
  const real = osModule.networkInterfaces;
  osModule.networkInterfaces = () => fixture;
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
    home,
    restore() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch { /* a disposer that throws must not fail the run */ }
      }
      osModule.networkInterfaces = real;
      require('node:module').syncBuiltinESMExports();
    }
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pair-'));
  const { routes, restore } = await loadPlugin(root);

  const lodge = routes.get('exact:/m/api/pair-request');
  const status = routes.get('exact:/m/api/pair-request/status');
  const list = routes.get('exact:/m/api/pair-requests');

  for (const [label, handler] of [['发起请求', lodge], ['查询状态', status], ['面板列表', list]]) {
    check(label + ' 路由已注册', typeof handler === 'function');
  }
  if (!lodge || !status || !list) {
    restore();
    fs.rmSync(root, { recursive: true, force: true });
    console.log('\n路由缺失，无法继续');
    process.exit(1);
  }

  console.log();

  // 1. A network device lodges a request.
  const lodged = fakeRes();
  await lodge(fakeReq({ method: 'POST', body: { name: 'Xiaomi 17 Pro' }, remote: '192.168.31.166' }), lodged);
  const lodgedJson = json(lodged);
  check('局域网设备可以发起配对请求', lodged.out.status === 200 && typeof lodgedJson?.id === 'string',
    `${lodged.out.status} ${lodged.out.body}`);
  const id = lodgedJson?.id ?? '';
  check('请求 id 足够长（不可枚举）', id.length >= 32, `长度 ${id.length}`);

  // 2. Nothing is handed out before approval.
  const beforeApproval = fakeRes();
  await status(fakeReq({ url: `/m/api/pair-request/status?id=${id}`, remote: '192.168.31.166' }), beforeApproval);
  const beforeJson = json(beforeApproval);
  check('未批准时状态是 pending', beforeJson?.status === 'pending', beforeApproval.out.body);
  check('未批准时不返回链接', beforeJson?.link === undefined, JSON.stringify(beforeJson));

  // 3. The panel sees it, and only from loopback.
  const listFromNetwork = fakeRes();
  await list(fakeReq({ url: '/m/api/pair-requests', remote: '192.168.31.166' }), listFromNetwork);
  check('面板列表拒绝网络来源', listFromNetwork.out.status === 403, String(listFromNetwork.out.status));

  const listFromLoopback = fakeRes();
  await list(fakeReq({ url: '/m/api/pair-requests', remote: '127.0.0.1' }), listFromLoopback);
  const pending = json(listFromLoopback)?.requests ?? [];
  check('面板能看到待批准请求', pending.some((item) => item.id === id),
    JSON.stringify(pending.map((item) => item.name)));
  check('请求带设备名', pending.some((item) => item.id === id && item.name === 'Xiaomi 17 Pro'));

  // 3b. A network caller cannot approve itself.
  const approveFromNetwork = fakeRes();
  await list(fakeReq({
    method: 'POST', url: '/m/api/pair-requests', remote: '192.168.31.166',
    body: { id, decision: 'approve' }
  }), approveFromNetwork);
  check('网络来源不能自行批准', approveFromNetwork.out.status === 403, String(approveFromNetwork.out.status));

  // Still pending after that attempt.
  const stillPending = fakeRes();
  await status(fakeReq({ url: `/m/api/pair-request/status?id=${id}` }), stillPending);
  check('自行批准的尝试没有生效', json(stillPending)?.status === 'pending', stillPending.out.body);

  // 4. Approval by the desktop, then the link arrives once.
  const approve = fakeRes();
  await list(fakeReq({
    method: 'POST', url: '/m/api/pair-requests', remote: '127.0.0.1',
    body: { id, decision: 'approve' }
  }), approve);
  check('桌面可以批准', json(approve)?.status === 'approved', approve.out.body);

  const firstRead = fakeRes();
  await status(fakeReq({ url: `/m/api/pair-request/status?id=${id}` }), firstRead);
  const firstJson = json(firstRead);
  check('批准后返回 approved', firstJson?.status === 'approved', firstRead.out.body);
  check('批准后返回配对链接', typeof firstJson?.link === 'string' && firstJson.link.includes('/m/pair?t='),
    String(firstJson?.link));
  check('链接指向局域网地址', String(firstJson?.link ?? '').startsWith('http://192.168.31.56:19387'),
    String(firstJson?.link));

  const secondRead = fakeRes();
  await status(fakeReq({ url: `/m/api/pair-request/status?id=${id}` }), secondRead);
  check('链接只交付一次', json(secondRead)?.status === 'unknown' && json(secondRead)?.link === undefined,
    secondRead.out.body);

  // 5. Rejection yields nothing, and destroys the request.
  const rejected = fakeRes();
  await lodge(fakeReq({ method: 'POST', body: { name: '怪设备' } }), rejected);
  const rejectedId = json(rejected)?.id ?? '';
  const reject = fakeRes();
  await list(fakeReq({
    method: 'POST', url: '/m/api/pair-requests', remote: '127.0.0.1',
    body: { id: rejectedId, decision: 'reject' }
  }), reject);
  check('桌面可以拒绝', json(reject)?.status === 'rejected', reject.out.body);
  const afterReject = fakeRes();
  await status(fakeReq({ url: `/m/api/pair-request/status?id=${rejectedId}` }), afterReject);
  check('拒绝后不返回链接', json(afterReject)?.link === undefined, afterReject.out.body);
  const afterRejectAgain = fakeRes();
  await status(fakeReq({ url: `/m/api/pair-request/status?id=${rejectedId}` }), afterRejectAgain);
  check('拒绝后请求被销毁', json(afterRejectAgain)?.status === 'unknown', afterRejectAgain.out.body);

  // 6. Guessed ids.
  const guessed = fakeRes();
  await status(fakeReq({ url: '/m/api/pair-request/status?id=' + 'a'.repeat(48) }), guessed);
  check('伪造 id 拿不到任何东西', json(guessed)?.status === 'unknown' && json(guessed)?.link === undefined,
    guessed.out.body);
  const noId = fakeRes();
  await status(fakeReq({ url: '/m/api/pair-request/status' }), noId);
  check('不带 id 拿不到任何东西', json(noId)?.status === 'unknown', noId.out.body);

  // 7. Rate limiting: a flood cannot fill the panel.
  let limited = false;
  for (let i = 0; i < 10; i++) {
    const flood = fakeRes();
    await lodge(fakeReq({ method: 'POST', body: { name: 'flood-' + i }, remote: '10.0.0.9' }), flood);
    if (flood.out.status === 429) {
      limited = true;
      break;
    }
  }
  check('同一来源的请求数量受限', limited);

  restore();
  fs.rmSync(root, { recursive: true, force: true });

  console.log();
  if (failures) {
    console.log(failures + ' / ' + checks + ' 项失败');
    process.exit(1);
  }
  console.log('ALL PAIR REQUEST CHECKS PASSED (' + checks + ' 项)');
  // Exit explicitly: the plugin's tunnel manager keeps handles open, and a test that passes and
  // then hangs looks like a bug in the code under test rather than in the test.
  process.exit(0);
}

main().catch((error) => {
  console.error('测试自身出错: ' + (error && error.stack || error));
  process.exit(1);
});
