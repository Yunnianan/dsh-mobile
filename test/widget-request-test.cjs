/**
 * The panel's pairing-request prompt.
 *
 * The plugin side of "pair by request" is covered by pair-request-test.cjs; this covers the part
 * the operator actually touches — that a pending request becomes visible in the panel, and that
 * pressing the buttons sends the decision the plugin expects.
 *
 * The reason it is worth its own test: the buttons are the security boundary. If "拒绝" ever sent
 * `approve`, or if a click sent no decision at all, the plugin would either hand out a credential
 * that was refused or silently do nothing — and neither would show up in the plugin's own tests.
 *
 * The DOM is a stub (element creation, class names, inline style, children, listeners) because the
 * widget is written against the desktop page and there is no browser here.
 *
 * Run: node test/widget-request-test.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WIDGET = path.join(__dirname, '..', 'lib', 'widget.js');

let failures = 0;
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label);
  if (!ok) {
    console.log('         expected: ' + expected);
    console.log('         actual  : ' + actual);
  }
}

/**
 * Assert a boolean without repeating `, true`.
 *
 * The first version of this file wrote `check('有请求区域', Boolean(x))` and forgot the expected
 * value, so four passing conditions were reported as failures — the comparison was `true` vs
 * `undefined`. Worth a helper rather than a comment.
 */
function checkTrue(label, condition, detail) {
  if (condition) {
    failures += 0;
    console.log('  ok   ' + label);
  } else {
    failures++;
    console.log('  FAIL ' + label + (detail ? '  → ' + detail : ''));
  }
}

function makeElement(tag) {
  const el = {
    tagName: tag,
    className: '',
    id: '',
    title: '',
    alt: '',
    src: '',
    textContent: '',
    disabled: false,
    children: [],
    style: {},
    listeners: {},
    offsetWidth: 248,
    offsetLeft: 14,
    offsetHeight: 300,
    offsetTop: 40,
    clientWidth: 248,
    clientHeight: 300,
    classList: null,
    parentNode: null
  };
  el.classList = {
    _set: new Set(),
    add(name) { this._set.add(name); },
    remove(name) { this._set.delete(name); },
    toggle(name, on) { if (on) this._set.add(name); else this._set.delete(name); },
    contains(name) { return this._set.has(name); }
  };
  el.appendChild = (child) => {
    el.children.push(child);
    child.parentNode = el;
    return child;
  };
  el.removeChild = (child) => {
    const at = el.children.indexOf(child);
    if (at >= 0) el.children.splice(at, 1);
    child.parentNode = null;
    return child;
  };
  el.insertBefore = (child, ref) => {
    const at = ref ? el.children.indexOf(ref) : -1;
    if (at < 0) el.children.push(child);
    else el.children.splice(at, 0, child);
    child.parentNode = el;
    return child;
  };
  el.addEventListener = (type, handler) => {
    (el.listeners[type] = el.listeners[type] || []).push(handler);
  };
  el.removeEventListener = () => {};
  el.setAttribute = () => {};
  el.getBoundingClientRect = () => ({
    left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight,
    right: el.offsetLeft + el.offsetWidth, bottom: el.offsetTop + el.offsetHeight
  });
  el.querySelector = () => null;
  el.fire = (type, event) => {
    (el.listeners[type] || []).forEach((handler) => handler(event || {}));
  };
  Object.defineProperty(el, 'childNodes', { get: () => el.children });
  Object.defineProperty(el, 'firstChild', { get: () => el.children[0] ?? null });
  return el;
}

/** Walk a tree and collect every element whose className contains `token`. */
function findAll(root, token) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.className === 'string' && node.className.split(/\s+/).includes(token)) {
      found.push(node);
    }
    (node.children || []).forEach(walk);
  };
  walk(root);
  return found;
}

/** All text under an element, concatenated. */
function textOf(node) {
  let text = typeof node.textContent === 'string' ? node.textContent : '';
  (node.children || []).forEach((child) => { text += textOf(child); });
  return text;
}

async function main() {
  const root = makeElement('div');
  root.id = 'root';
  const body = makeElement('body');

  const calls = [];
  /** What the next GET /m/api/pair-requests should report. */
  let pending = [];

  const fetchStub = (url, options) => {
    calls.push({ url: String(url), options: options || {} });
    if (String(url) === '/m/api/pair-requests') {
      const method = (options && options.method) || 'GET';
      if (method === 'POST') {
        const body = JSON.parse(options.body || '{}');
        // The plugin drops the request once decided, so the next poll must not show it again.
        pending = pending.filter((item) => item.id !== body.id);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ status: body.decision === 'approve' ? 'approved' : 'rejected' })
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ requests: pending }) });
    }
    if (String(url) === '/m/api/get-code') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          pairingUrl: 'http://192.168.31.56:19387/m/pair?t=TOKEN',
          host: '192.168.31.56:19387',
          scope: 'lan',
          expiresAt: Date.now() + 600000,
          autoPairSecret: 'SECRET'
        })
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  };

  const timers = [];
  const sandbox = {
    console,
    document: {
      readyState: 'complete',
      body,
      documentElement: body,
      createElement: makeElement,
      addEventListener: () => {},
      getElementById: () => null
    },
    window: {},
    localStorage: {
      _data: {},
      getItem(key) { return Object.prototype.hasOwnProperty.call(this._data, key) ? this._data[key] : null; },
      setItem(key, value) { this._data[key] = String(value); },
      removeItem(key) { delete this._data[key]; }
    },
    fetch: fetchStub,
    // Intervals are collected rather than run: the widget polls forever by design.
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: () => {},
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    requestAnimationFrame: (fn) => { fn(); return 0; },
    cancelAnimationFrame: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    ResizeObserver: function ResizeObserver() { this.observe = () => {}; this.disconnect = () => {}; },
    navigator: { clipboard: null, userAgent: 'test' },
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1
  };
  sandbox.globalThis = sandbox;
  // The widget hangs drag listeners on `window` (pointermove/pointerup), so the sandbox has to
  // provide them; the drag behaviour itself is covered by widget-edge-test.cjs.
  sandbox.window = Object.assign(sandbox, {
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1
  });

  const context = vm.createContext(sandbox);
  const source = fs.readFileSync(WIDGET, 'utf8');
  vm.runInContext(source, context, { filename: 'widget.js' });
  // Let the widget's first poll and mint settle.
  await new Promise((resolve) => setTimeout(resolve, 30));

  const requestsBar = findAll(body, 'dshm-requests')[0];
  checkTrue('面板里有请求区域', Boolean(requestsBar));

  // No requests yet: the bar must stay hidden rather than showing an empty box.
  check('没有请求时区域是隐藏的', requestsBar && requestsBar.style.display, 'none');

  // A request arrives on the next poll.
  pending = [{ id: 'req-1', name: 'Xiaomi 17 Pro', source: '192.168.31.166', status: 'pending', waitingMs: 100 }];
  const poller = timers.find((timer) => timer.ms === 2000);
  checkTrue('每 2 秒轮询一次请求', Boolean(poller));
  if (poller) poller.fn();
  await new Promise((resolve) => setTimeout(resolve, 30));

  check('有请求时区域显示出来', requestsBar && requestsBar.style.display, '');
  const barText = textOf(requestsBar);
  checkTrue('显示请求的设备名', barText.includes('Xiaomi 17 Pro'), barText);
  checkTrue('文案说明要点允许', barText.includes('允许'), barText);

  const buttons = findAll(requestsBar, 'dshm-btn');
  const allow = buttons.find((button) => button.textContent === '允许');
  const deny = buttons.find((button) => button.textContent === '拒绝');
  checkTrue('有「允许」按钮', Boolean(allow));
  checkTrue('有「拒绝」按钮', Boolean(deny));

  // Pressing 拒绝 must send reject — not approve.
  const before = calls.length;
  if (deny) deny.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const decisionCalls = calls.slice(before).filter((call) => call.options.method === 'POST');
  check('点「拒绝」发出一次 POST', decisionCalls.length, 1);
  if (decisionCalls[0]) {
    const sent = JSON.parse(decisionCalls[0].options.body || '{}');
    check('「拒绝」发送的是 reject', sent.decision, 'reject');
    check('决定里带上了请求 id', sent.id, 'req-1');
  }
  check('决定后那一行被移除', findAll(requestsBar, 'dshm-request').length, 0);

  // And the same for 允许.
  pending = [{ id: 'req-2', name: 'vivo', source: '192.168.31.178', status: 'pending', waitingMs: 50 }];
  if (poller) poller.fn();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const rows = findAll(requestsBar, 'dshm-request');
  check('第二个请求出现在面板上', rows.length, 1);
  const allow2 = findAll(requestsBar, 'dshm-btn').find((button) => button.textContent === '允许');
  const before2 = calls.length;
  if (allow2) allow2.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const decisionCalls2 = calls.slice(before2).filter((call) => call.options.method === 'POST');
  check('点「允许」发出一次 POST', decisionCalls2.length, 1);
  if (decisionCalls2[0]) {
    const sent = JSON.parse(decisionCalls2[0].options.body || '{}');
    check('「允许」发送的是 approve', sent.decision, 'approve');
    check('决定里带上了请求 id', sent.id, 'req-2');
  }

  console.log();
  if (failures) {
    console.log(failures + ' 项失败');
    process.exit(1);
  }
  console.log('ALL WIDGET REQUEST CHECKS PASSED');
  process.exit(0);
}

main().catch((error) => {
  console.error('测试自身出错: ' + (error && error.stack || error));
  process.exit(1);
});
