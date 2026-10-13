/**
 * Exercise the pairing panel's edge-hiding arithmetic without a browser.
 *
 * widget.js is a browser IIFE with no imports, so it can be run here against a small DOM
 * stub. What is worth checking is the part that is easy to get wrong and invisible until it
 * looks broken on screen:
 *
 *   - the panel slides towards the nearer edge, not always the same one;
 *   - it leaves a rail rather than going fully off-screen, so it can still be grabbed;
 *   - the parking offset is what the drag code must not be confused by;
 *   - the preference round-trips through localStorage.
 *
 * The stub covers only what widget.js touches: element creation, class names, inline style,
 * a few geometry properties, and event listeners.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

// ---------------------------------------------------------------- DOM stub
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
    classList: null,
    listeners: {},
    // Geometry: the panel is a fixed 248 box unless a test overrides it. The height is
    // defined below as a getter, because it has to follow the collapsed class.
    offsetWidth: 248,
    offsetLeft: 14,
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() {
      return {
        left: this.offsetLeft,
        top: this.offsetTop,
        width: this.offsetWidth,
        height: this.offsetHeight,
        right: this.offsetLeft + this.offsetWidth,
        bottom: this.offsetTop + this.offsetHeight
      };
    },
    querySelector() { return null; },
    getElementById() { return null; },
    select() {},
    focus() {}
  };
  const classes = new Set();
  // A realistic height: the panel is much shorter when collapsed, and code that keeps the
  // bottom edge has to see that difference. Like a browser, the height follows the class,
  // because the stub does not lay anything out.
  let openHeight = 320;
  const collapsedHeight = 37;
  Object.defineProperty(el, 'offsetHeight', {
    get() { return classes.has('dshm-collapsed') ? collapsedHeight : openHeight; },
    set(value) {
      if (classes.has('dshm-collapsed')) return;
      openHeight = value;
    }
  });
  // offsetTop is a layout result, not a stored value: the widget positions the panel with
  // style.top *or* style.bottom, and to anything reading offsetTop afterwards the two must
  // agree. A browser derives top from bottom and the viewport; so does this.
  Object.defineProperty(el, 'offsetTop', {
    get() {
      const top = parseFloat(String(this.style.top || '').replace('px', ''));
      if (Number.isFinite(top)) return top;
      const bottom = parseFloat(String(this.style.bottom || '').replace('px', ''));
      if (Number.isFinite(bottom)) {
        return (globalThis.__dshViewportHeight || 723) - this.offsetHeight - bottom;
      }
      return 0;
    },
    set(value) { this.style.top = value + 'px'; }
  });
  Object.defineProperty(el, 'className', {
    get() { return [...classes].join(' '); },
    set(value) {
      classes.clear();
      String(value).split(/\s+/).filter(Boolean).forEach((n) => classes.add(n));
    }
  });
  el.classList = {
    add(...names) { names.forEach((n) => classes.add(n)); },
    remove(...names) { names.forEach((n) => classes.delete(n)); },
    contains(name) { return classes.has(name); },
    toggle(name, force) {
      const on = force === undefined ? !classes.has(name) : !!force;
      if (on) classes.add(name); else classes.delete(name);
      return on;
    }
  };
  // The panel looks up its own body and caret by class when it collapses, so the stub has to
  // answer for its descendants; returning null silently skipped that work and hid real bugs.
  el.querySelector = function (selector) {
    const want = String(selector).replace(/^\./, '');
    const queue = [...this.children];
    while (queue.length) {
      const node = queue.shift();
      if (node.classList && node.classList.contains(want)) return node;
      if (node.children) queue.push(...node.children);
    }
    return null;
  };
  return el;
}

function makeWindow() {
  const listeners = {};
  return {
    innerWidth: 1280,
    innerHeight: 800,
    listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    localStorage: null,
    dispatch(type, event) {
      (listeners[type] || []).forEach((fn) => fn(event));
    }
  };
}

function loadWidget(store, options) {
  const settings = options || {};
  // The store can be passed in: a reload has to see what the previous instance wrote, and a
  // fresh Map per call would make every "does the preference persist" assertion meaningless.
  const backing = store || new Map();
  const rootElements = [];
  const body = makeElement('body');

  const document = {
    readyState: 'complete',
    head: makeElement('head'),
    documentElement: makeElement('html'),
    body,
    createElement(tag) {
      const el = makeElement(tag);
      if (tag === 'div' && !el.id) rootElements.push(el);
      return el;
    },
    getElementById() { return null; },
    addEventListener() {},
    execCommand() { return true; }
  };

  const window = makeWindow();
  window.document = document;
  window.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k)
  };

  const sandbox = {
    window,
    document,
    localStorage: window.localStorage,
    navigator: {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    // The panel mints a code on start; the test does not care about the answer.
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    console
  };
  sandbox.globalThis = sandbox;

  const source = fs.readFileSync(WIDGET, 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: WIDGET });

  // The panel is the div the widget appended to body.
  const panel = body.children[0];
  // A realistic open height, so height-sensitive behaviour (keeping the bottom edge while
  // collapsing) can be asserted. The stub does not lay out, so nothing computes this.
  if (settings.height) panel.offsetHeight = settings.height;
  return {
    panel, window, document, store: backing, body,
    // Re-runs the position restore. The stored position was applied during build, when the
    // height was still the stub default; a browser has the right height from the start, so
    // this only exists to make the geometry comparable here.
    reapplyPosition() {
      const raw = backing.get('dshm-pos-v1');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      panel.style.left = parsed.left + 'px';
      panel.style.top = (parsed.top + settings.height - panel.offsetHeight) + 'px';
    }
  };
}

// ---------------------------------------------------------------- tests

/**
 * Tap an element the way a finger does: press, then release.
 *
 * The header toggles on pointerup — that is how a tap is told apart from a drag — and the
 * handler ignores a release it did not see pressed, so a bare pointerup does nothing.
 */
function tap(node, pointerId) {
  const id = pointerId === undefined ? 1 : pointerId;
  const at = { pointerId: id, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} };
  (node.listeners.pointerdown || []).forEach((fn) => fn(at));
  (node.listeners.pointerup || []).forEach((fn) => fn(at));
}

/** Load a panel and expand it the way a user does: by tapping the header. */
function openedWidget() {
  const loaded = loadWidget();
  tap(headOf(loaded.panel));
  return loaded;
}

function headOf(panel) {
  return panel.children.find((c) => c.classList.contains('dshm-head'));
}

function panelBody(panel) {
  return panel.children.find((c) => c.classList.contains('dshm-body'));
}

function main() {
  console.log('[1] a fresh panel rests as a collapsed strip at an edge');
  {
    const { panel } = loadWidget();
    check('it starts collapsed', panel.classList.contains('dshm-collapsed'), true);
    check('and parked', panel.classList.contains('dshm-edge'), true);
    check('and marked parked for styling', panel.classList.contains('dshm-parked'), true);
    check('so the body is not shown', panelBody(panel).style.display, 'none');
    check('and the caret points right', panel.querySelector('.dshm-caret').textContent, '▸');
    // It is still on screen: a strip, not a vanished panel.
    const m = /translateX\((-?\d+)px\)/.exec(panel.style.transform);
    check('and it is slid to leave a rail', !!m, true);
    const shift = m ? Math.abs(Number(m[1])) : 0;
    check('the rail is the peek width', 248 - shift, 16);
  }

  console.log('[2] a parked strip slides towards the nearer edge');
  {
    const left = loadWidget();
    check('on the left it slides left',
          /translateX\(-232px\)/.test(left.panel.style.transform), true);

    // Put it on the right half and ask it to re-decide: it must slide right instead.
    const right = loadWidget();
    right.panel.offsetLeft = 900;
    right.window.dispatch('resize', {});
    check('on the right it slides right',
          /translateX\(232px\)/.test(right.panel.style.transform), true);
  }

  console.log('[3] tapping the header opens it, tapping again puts it back');
  {
    const { panel } = loadWidget();
    const head = panel.children.find((c) => c.classList.contains('dshm-head'));

    tap(head);
    check('the first tap expands it', panel.classList.contains('dshm-collapsed'), false);
    check('and un-parks it', panel.classList.contains('dshm-edge'), false);
    check('so nothing is translated away', panel.style.transform, '');
    check('and the body is on show', panelBody(panel).style.display !== 'none', true);
    check('and the caret points down', panel.querySelector('.dshm-caret').textContent, '▾');

    tap(head);
    check('the second tap collapses it again',
          panel.classList.contains('dshm-collapsed'), true);
    check('and it is parked again', panel.classList.contains('dshm-edge'), true);
    check('and the body is hidden again', panelBody(panel).style.display, 'none');
    check('and it is slid away again',
          /translateX\(-232px\)/.test(panel.style.transform), true);
  }

  console.log('[4] the same toggle is available on the open panel');
  {
    const { panel } = openedWidget();
    check('opened first', panel.classList.contains('dshm-collapsed'), false);
    const head = panel.children.find((c) => c.classList.contains('dshm-head'));
    const pin = head.children.find((c) => c.classList.contains('dshm-pin'));
    pin.listeners.click[0]({ stopPropagation() {} });
    check('the pin collapses it', panel.classList.contains('dshm-collapsed'), true);
    check('and parks it', panel.classList.contains('dshm-edge'), true);
  }

  console.log('[5] a parked strip comes back when the pointer reaches the rail');
  {
    const { panel, window } = loadWidget();
    check('parked to begin with', panel.classList.contains('dshm-edge'), true);
    window.dispatch('pointermove', { clientX: 4, clientY: 400 });
    check('the pointer on the rail reveals it',
          panel.classList.contains('dshm-peek'), true);
    check('and it is no longer translated', panel.style.transform, '');
    window.dispatch('pointermove', { clientX: 600, clientY: 400 });
    check('the pointer leaving parks it again',
          panel.classList.contains('dshm-peek'), false);
    check('and the offset is back',
          /translateX\(-232px\)/.test(panel.style.transform), true);

    // A phone has no hover, so tapping the strip has to work on its own — otherwise the
    // resting state would be a one-way trip on touch.
    const tapped = loadWidget();
    check('parked before the tap', tapped.panel.classList.contains('dshm-peek'), false);
    tapped.panel.listeners.pointerdown[0]({});
    check('a tap on the strip brings it out',
          tapped.panel.classList.contains('dshm-peek'), true);
    check('and it is no longer translated', tapped.panel.style.transform, '');
  }

  console.log('[6] no state is written to storage');
  {
    const { panel, store } = loadWidget();
    // goHome() removes the position key, so the rested panel leaves storage empty: that is
    // stronger than 'writes nothing', and the intent is that no *preference* is remembered.
    check('no position key is left on load', store.has('dshm-pos-v1'), false);
    check('and no edge preference is written', store.has('dshm-edge-v1'), false);
    const head = panel.children.find((c) => c.classList.contains('dshm-head'));
    tap(head);
    check('nothing stored after expanding', store.has('dshm-edge-v1'), false);
    tap(head);
    check('nothing stored after collapsing', store.has('dshm-edge-v1'), false);
    // A stale value from an older build must not park anything: the resting state is the
    // only thing that decides that now.
    const stale = new Map();
    stale.set('dshm-edge-v1', '1');
    check('an old stored preference is ignored', loadWidget(stale).panel.classList.contains('dshm-peek'), false);
  }

  console.log('[8] the panel follows the system light/dark setting');
  {
    const source = fs.readFileSync(WIDGET, 'utf8');
    const css = source.slice(source.indexOf('var CSS ='), source.indexOf('function injectStyle'));

    check('a light-scheme override exists', css.includes('prefers-color-scheme: light'), true);
    check('and it re-points the variables rather than the rules',
          /@media \(prefers-color-scheme: light\)\{\.dshm\{/.test(css), true);

    // Everything the user sees must come from the variable block; a literal left in a rule
    // would stay dark in light mode. The QR plate is the deliberate exception — a code needs
    // a white surround or scanners fail — so exactly that rule may keep its colour.
    const themeStart = css.indexOf('.dshm{--dshm-bg:');
    const marker = '--dshm-err-fg:#b3261e}}';
    const themeEnd = css.indexOf(marker) + marker.length;
    const outsideTheme = css.slice(0, themeStart) + css.slice(themeEnd);
    const stray = outsideTheme
      .split('\n')
      .filter((line) => !/\.dshm-qr/.test(line))
      .flatMap((line) => line.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/g) || [])
      .filter((value) => !/^#fff(f)?$/.test(value) && value !== '#555');
    check('no loose colour left outside the theme block', stray.length === 0, true);
    if (stray.length) console.log('         stray: ' + stray.join(' '));

    check('the QR area keeps a white plate', css.includes('background:#fff}'), true);

    // A declared-but-unused variable is dead weight; a used-but-undeclared one renders the
    // panel colourless, which is the failure mode this whole change exists to avoid.
    const defined = new Set(css.match(/--dshm-[a-z0-9-]+/g) || []);
    const used = new Set((css.match(/var\(--dshm-[a-z0-9-]+\)/g) || [])
      .map((token) => token.slice(4, -1)));
    const unused = [...defined].filter((name) => !used.has(name));
    const undeclared = [...used].filter((name) => !defined.has(name));
    check('every declared variable is used', unused.length === 0, true);
    if (unused.length) console.log('         unused: ' + unused.join(' '));
    check('every used variable is declared', undeclared.length === 0, true);
    if (undeclared.length) console.log('         undeclared: ' + undeclared.join(' '));
  }

  console.log();
  console.log(failures === 0 ? 'ALL WIDGET CHECKS PASSED' : failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

main();
