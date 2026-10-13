/**
 * The DOM stub the widget tests run against, extracted so it can be shared.
 *
 * It was extracted because the geometry was reasoned about instead of measured, and each
 * round of reasoning produced a different wrong answer. A probe that prints the numbers has
 * to use the very same stub the assertions use, or it measures a different world.
 *
 * It covers only what widget.js touches: element creation, class names, inline style, a few
 * geometry properties, and event listeners.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WIDGET = path.join(__dirname, '..', 'lib', 'widget.js');

/** The viewport the stub reports for geometry derived from `bottom`. */
const VIEWPORT_HEIGHT = 723;

/** Documented defaults for the CSS layout properties, when a device is not specified. */
const DEFAULT_METRICS = { homeLeft: 14, homeBottom: 14, panelWidth: 248 };

function makeElement(tag, layout) {
  const geometry = layout || {};
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
  // A realistic height: the resting strip is much shorter than the open panel, and code that
  // anchors by the bottom edge has to see that difference. Like a browser, the height follows
  // the class, because the stub does not lay anything out.
  const COLLAPSED_HEIGHT = 37;
  let openHeight = 320;
  /** The panel's CSS max-height, when a device is short enough to need it. */
  const maxHeight = geometry.maxHeight || 0;
  Object.defineProperty(el, 'offsetHeight', {
    get() {
      const raw = classes.has('dshm-collapsed') ? COLLAPSED_HEIGHT : openHeight;
      // A browser clamps a box to its max-height, and the panel sets one so it cannot be taller
      // than the screen. Modelling that is what lets the device matrix see a short viewport
      // shrink the panel rather than claim a height it cannot have.
      return maxHeight > 0 ? Math.min(raw, maxHeight) : raw;
    },
    // Assignment always sets the open height. It used to ignore writes while collapsed, which
    // silently discarded a test's own `height:` option and made every height-sensitive
    // assertion measure the default instead.
    set(value) { openHeight = value; }
  });
  // offsetTop and offsetLeft are layout results, not stored values: the widget positions the panel
  // with style.top/left, and to anything reading the offsets afterwards those must agree. A browser
  // reports the layout position, *excluding* a transform — which matters here because the resting
  // strip is parked with one, and including it made every drag start from the wrong origin.
  Object.defineProperty(el, 'offsetTop', {
    get() {
      const top = parseFloat(String(this.style.top || '').replace('px', ''));
      if (Number.isFinite(top)) return top;
      const bottom = parseFloat(String(this.style.bottom || '').replace('px', ''));
      if (Number.isFinite(bottom)) {
        return (this.viewportHeight || VIEWPORT_HEIGHT) - this.offsetHeight - bottom;
      }
      return 0;
    },
    set(value) { this.style.top = value + 'px'; }
  });
  Object.defineProperty(el, 'offsetLeft', {
    get() {
      const left = parseFloat(String(this.style.left || '').replace('px', ''));
      return Number.isFinite(left) ? left : (geometry.homeLeft || 0);
    },
    set(value) { this.style.left = value + 'px'; }
  });
  // className and classList must be the same thing: widget.js sets classes both ways, and a
  // stub where they disagree reports "class missing" for classes that really are there.
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

function makeWindow(metrics) {
  const listeners = {};
  const layout = Object.assign({}, DEFAULT_METRICS, metrics || {});
  /** Observers the widget created, so a test can fire them deliberately. */
  const observers = [];
  return {
    innerWidth: layout.viewportWidth || 375,
    innerHeight: layout.viewportHeight || VIEWPORT_HEIGHT,
    listeners,
    observers,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    localStorage: null,
    /**
     * A ResizeObserver stand-in that records its callbacks instead of firing them.
     *
     * The widget re-anchors the panel when its own size changes, which is how a height capped by
     * `--dshm-room` still lands on screen. Without this the widget would take its "unsupported"
     * path in the tests and that branch would run nowhere at all.
     */
    ResizeObserver: function ResizeObserver(callback) {
      this.callback = callback;
      this.targets = [];
      this.observe = (target) => {
        this.targets.push(target);
        observers.push(this);
      };
      this.disconnect = () => {};
    },
    /** Fire every observer, as a browser would after a layout change. */
    fireResize() {
      observers.forEach((observer) => observer.callback([], observer));
    },
    /**
     * The layout custom properties, as the browser would resolve them.
     *
     * A browser resolves `env(safe-area-inset-*)` and the viewport clamp in CSS; the stub is
     * told the result. That is what makes "does this fit another device" testable at all —
     * the widget reads these values rather than assuming 14px and 248px.
     */
    getComputedStyle() {
      return {
        getPropertyValue(name) {
          if (name === '--dshm-home-left') return layout.homeLeft + 'px';
          if (name === '--dshm-home-bottom') return layout.homeBottom + 'px';
          if (name === '--dshm-width') return layout.panelWidth + 'px';
          return '';
        }
      };
    },
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
  const body = makeElement('body');

  const document = {
    readyState: 'complete',
    head: makeElement('head'),
    documentElement: makeElement('html'),
    body,
    createElement(tag) { return makeElement(tag, { maxHeight: settings.maxHeight }); },
    getElementById() { return null; },
    addEventListener() {},
    execCommand() { return true; }
  };

  // `metrics` describes the device: its viewport and the resolved safe-area insets. A browser
  // resolves those in CSS; here they are stated, which is what lets one test cover a small
  // phone, a large one, landscape, and a device with a notch.
  const window = makeWindow(settings.metrics);
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
    // The panel mints a code on start; the tests do not care about the answer.
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    // widget.js reads the layout metrics through this; the window owns it, as in a browser.
    getComputedStyle: window.getComputedStyle,
    console
  };
  sandbox.globalThis = sandbox;

  const source = fs.readFileSync(WIDGET, 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: WIDGET });

  // The panel is the div the widget appended to body.
  const panel = body.children[0];
  // Layout facts the panel needs to report like a browser would: how tall its viewport is, and
  // how tall it is itself. The stub lays nothing out, so both have to be stated.
  panel.viewportHeight = window.innerHeight;
  if (settings.height) panel.offsetHeight = settings.height;
  return { panel, window, document, store: backing, body };
}

/** Tap an element the way a finger does: press, then release. */
function tap(node, pointerId) {
  const id = pointerId === undefined ? 1 : pointerId;
  const at = { pointerId: id, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} };
  (node.listeners.pointerdown || []).forEach((fn) => fn(at));
  (node.listeners.pointerup || []).forEach((fn) => fn(at));
}

/**
 * Simulate a pointer drag on a panel's handle, and report where the panel ended up.
 *
 * The end point is passed explicitly because the stub lays nothing out: it cannot turn a pointer
 * delta into a new offset, so the drag's *result* is stated. It is written between the move and
 * the release, because the widget reads the position on release — writing it afterwards would
 * model a drag the widget never saw.
 *
 * The coordinate is applied to the **panel**, not to the handle that received the events: a real
 * drag moves the panel while the pointer is over the handle, and the widget positions the panel.
 * Returns the position the widget ended up with, which is what an assertion should compare
 * against — asking for an exact `top` would be asking the stub to have done layout.
 */
function drag(handle, left, top, pointerId) {
  const panel = handle.parentElement || handle;
  const id = pointerId === undefined ? 7 : pointerId;
  const at = (x, y) => ({
    pointerId: id, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {}
  });
  (handle.listeners.pointerdown || []).forEach((fn) => fn(at(0, 0)));
  // The move has to exceed DRAG_SLOP, or the widget reads the gesture as a tap and collapses
  // instead of dragging — which is what a stub using (0,0) as the delta was doing.
  const origin = { left: panel.offsetLeft, top: panel.offsetTop };
  const dx = left - origin.left;
  const dy = top - origin.top;
  (handle.listeners.pointermove || []).forEach((fn) => fn(at(dx, dy)));
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
  // The release is fired at the *origin* coordinate, not the delta. A real pointerup carries the
  // pointer's position; sending the delta again made the widget apply the movement twice, which
  // is how the panel ended up 14px from where the test asked for it.
  (handle.listeners.pointerup || []).forEach((fn) => fn(at(dx, dy)));
  return { left: panel.offsetLeft, top: panel.offsetTop };
}

module.exports = { loadWidget, tap, drag, makeElement, VIEWPORT_HEIGHT, WIDGET };
