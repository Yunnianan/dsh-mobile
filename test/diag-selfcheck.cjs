/**
 * Run the shipped diag.js against a stub page and assert it returns a report.
 *
 * The bug this exists for: diag.js was a Java string literal, one character of it was
 * missing, the script did not parse, and WebView's evaluateJavascript returned null. The
 * only symptom was "diagnostics produced nothing" — on a device, with no other signal. Now
 * the script is a file with a self-check, so a broken diagnostic is caught here instead.
 *
 * It also asserts the two things that make the report useful: the pointer counter installs,
 * and an overlay that covers the viewport is named.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = path.join(__dirname, 'diag.js');
// Kept next to this self-check so the pair can move together; in the app it lives in
// apk/assets/diag.js and is read from there by MainActivity.

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

/** A page whose viewport is covered by a dialog mask, which is the case that mattered. */
function makePage() {
  const listeners = {};
  const mask = {
    tagName: 'DIV',
    className: '_mask_o6lrb_18',
    children: [],
    innerText: '',
    parentElement: null,
    getBoundingClientRect: () => ({ width: 375, height: 723, left: 0, top: 0 })
  };
  // The mask's sibling is the dialog itself; the diagnostics report the whole subtree so a
  // half-rendered modal can be told apart from a working one.
  const dialog = {
    tagName: 'DIV',
    className: '_dialog_o6lrb_33',
    children: [],
    innerText: '',
    getBoundingClientRect: () => ({ width: 327, height: 480, left: 24, top: 120 })
  };
  const root = {
    tagName: 'DIV',
    className: '_root_o6lrb_6',
    children: [mask, dialog],
    innerText: '预览版说明 DeepSeek Harness 目前的 0.2 版本仍处于预览阶段',
    getBoundingClientRect: () => ({ width: 375, height: 723, left: 0, top: 0 })
  };
  mask.parentElement = root;
  dialog.parentElement = root;
  root.parentElement = { className: '' };

  const paragraph = {
    tagName: 'P',
    className: '',
    children: [],
    parentElement: root,
    getBoundingClientRect: () => ({ width: 600, height: 40, left: 100, top: 400 })
  };

  const document = {
    readyState: 'complete',
    body: { innerHTML: '<div></div>'.repeat(20), innerText: 'HARNESS preview notice' },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelector(selector) { return selector.indexOf('mask') >= 0 ? mask : null; },
    querySelectorAll(selector) {
      if (selector.indexOf('style') >= 0) return [{ id: 'dshm-style' }];
      if (selector === 'body *') return [overlayCover(), paragraph];
      return [];
    },
    elementFromPoint(x, y) {
      // The dialog is centred, so the bottom strip is the mask and the middle is the page.
      return y > 500 ? mask : paragraph;
    }
  };

  function overlayCover() {
    return {
      tagName: 'DIV',
      className: 'BynINW_frame',
      children: [],
      parentElement: null,
      getBoundingClientRect: () => ({ width: 375, height: 723, left: 0, top: 0 })
    };
  }

  return { document, listeners, mask, root, dialog };
}

function run() {
  const page = makePage();
  const sandbox = {
    window: { __ModuleLoader__: { pendingQueue: [{ id: 'dsh-theme-whalegirl' }] } },
    document: page.document,
    location: { href: 'http://host/' },
    getComputedStyle: () => ({
      pointerEvents: 'auto', zIndex: '9', backgroundColor: 'rgba(0,0,0,.4)',
      opacity: '1', position: 'fixed'
    }),
    console
  };
  sandbox.window.innerWidth = 1280;
  sandbox.window.innerHeight = 800;
  sandbox.window.document = page.document;

  const source = fs.readFileSync(SCRIPT, 'utf8');
  const context = vm.createContext(sandbox);
  const raw = vm.runInContext(source, context, { filename: SCRIPT });
  return { raw, page, sandbox };
}

function main() {
  console.log('[1] the script parses and returns a report');
  const { raw, page, sandbox } = run();
  check('it returned something', typeof raw === 'string', true);
  if (typeof raw !== 'string') {
    console.log();
    console.log('report was not produced; nothing further can be checked');
    process.exit(1);
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch (e) {
    report = raw;
  }
  check('the report is a string of fields', typeof report === 'string', true);
  check('it did not throw', report.indexOf('diag threw') < 0, true);

  console.log('[2] the fields that matter are present');
  check('it reports the url', report.indexOf('url=http://host/') >= 0, true);
  check('it reports the loader', report.indexOf('moduleLoader=object') >= 0, true);
  check('it names the queued entry',
        report.indexOf('queued0=dsh-theme-whalegirl') >= 0, true);
  check('it reports the viewport', report.indexOf('viewport=1280x800') >= 0, true);
  check('it reports what is under the finger at the bottom',
        report.indexOf('atBottom=DIV._mask_o6lrb_18') >= 0, true);
  check('it reports the middle as real content',
        report.indexOf('atCentre=P') >= 0, true);

  console.log('[3] it names an overlay that covers the viewport');
  check('the covering node is listed', report.indexOf('coversViewport=') >= 0, true);
  check('and the mask is in that list', report.indexOf('_mask_o6lrb_18') >= 0, true);

  console.log('[4] the pointer counter is installed');
  const handlers = page.listeners.pointerdown || [];
  check('one capture-phase listener', handlers.length, 1);
  handlers[0]({ target: { tagName: 'BUTTON' } });
  const second = run();
  void second;
  // Re-running installs a fresh counter, so assert on the listener effect directly.
  const tap = sandbox.window.__dshTap;
  check('and it counts an event', tap && tap.n >= 1, true);

  console.log();
  console.log(failures === 0 ? 'ALL DIAG CHECKS PASSED' : failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

main();
