/**
 * DSH Mobile pairing panel — the bottom-left widget in the DSH Web GUI.
 *
 * Served by dsh-mobile-public at /m/widget.js and injected into the page by the
 * host, so it deliberately has no build step and no imports: it creates its own
 * DOM, styles itself, and talks only to the plugin's own routes.
 *
 * Behaviour: shows the pairing QR code on load, minting one if none is live. The
 * code is a single-use credential for full host control, so the panel states its
 * lifetime plainly and warns that refreshing invalidates the previous code.
 */
(function () {
  'use strict';

  if (window.__dshMobilePanel) return;
  window.__dshMobilePanel = true;

  // ---------------------------------------------------------------- geometry
  /**
   * The panel's own view of where it is, for measuring.
   *
   * Exposed because this geometry was reasoned about three times and was wrong three times: the
   * DOM offsets only show the result, and the values that decide it live in here. Read it from a
   * console (`window.__dshMobilePanelState`) or from geometry-probe.cjs.
   */
  function publishState() {
    try {
      window.__dshMobilePanelState = {
        collapsed: state.collapsed,
        parked: state.edgeHidden === 1,
        revealed: state.edgeRevealed,
        panel: state.panel,
        strip: state.strip,
        homeLeft: state.homeLeft,
        homeBottom: state.homeBottom,
        atHome: state.atHome,
        viewport: window.innerWidth + 'x' + window.innerHeight
      };
    } catch (error) {
      /* not worth failing over */
    }
  }

  var POLL_MS = 1000;

  // ---------------------------------------------------------------- styles
  //
  // Colours are declared as custom properties, defaulted for the dark case and overridden
  // under `prefers-color-scheme: light`. Before this the panel was a hard-coded dark square,
  // which is exactly what made it look pasted on over a light page.
  //
  // The QR code area is deliberately NOT themed: a QR needs its quiet zone and a black code
  // on white, or scanners fail. It stays white in both schemes.
  var CSS =
    // --- theme -----------------------------------------------------------------
    '.dshm{--dshm-bg:rgba(24,24,28,.92);--dshm-fg:#e8e8ea;' +
    '--dshm-border:rgba(255,255,255,.14);--dshm-shadow:rgba(0,0,0,.45);' +
    '--dshm-field:rgba(255,255,255,.07);--dshm-field-fg:#cfcfd6;' +
    '--dshm-btn-border:rgba(255,255,255,.16);--dshm-hover:rgba(255,255,255,.06);' +
    '--dshm-hover-strong:rgba(255,255,255,.16);--dshm-active:rgba(255,255,255,.24);' +
    '--dshm-dim:#a9a9b2;--dshm-dim-2:#8e8e98;--dshm-accent:#4d6bfe;--dshm-accent-hover:#5f79ff;' +
    '--dshm-on:#3ddc84;--dshm-warn:#e8b93d;--dshm-err:#e8534a;--dshm-err-fg:#ff8a80}' +
    '@media (prefers-color-scheme: light){.dshm{' +
    '--dshm-bg:rgba(255,255,255,.96);--dshm-fg:#1f1f24;' +
    '--dshm-border:rgba(0,0,0,.14);--dshm-shadow:rgba(0,0,0,.22);' +
    '--dshm-field:rgba(0,0,0,.05);--dshm-field-fg:#3a3a42;' +
    '--dshm-btn-border:rgba(0,0,0,.16);--dshm-hover:rgba(0,0,0,.05);' +
    '--dshm-hover-strong:rgba(0,0,0,.09);--dshm-active:rgba(0,0,0,.14);' +
    '--dshm-dim:#5c5c66;--dshm-dim-2:#6e6e78;--dshm-accent:#4d6bfe;--dshm-accent-hover:#3d5bf0;' +
    '--dshm-on:#1f9d55;--dshm-warn:#a97400;--dshm-err:#c0392b;--dshm-err-fg:#b3261e}}' +
    // --- panel -----------------------------------------------------------------
    // Everything about the panel's placement comes from custom properties, because it has to
    // fit phones it was never tested on: narrow ones, large ones, landscape, and screens with
    // a notch or a gesture bar. The safe-area insets are what stop it from sitting under the
    // rounded corners or the home indicator, where it cannot be tapped.
    '.dshm{position:fixed;' +
    '--dshm-inset-left:env(safe-area-inset-left,0px);' +
    '--dshm-inset-bottom:env(safe-area-inset-bottom,0px);' +
    // The top inset matters even though the panel is anchored at the bottom: it is what keeps
    // a tall panel from running under a notch when the screen is short.
    '--dshm-inset-top:env(safe-area-inset-top,0px);' +
    '--dshm-home-left:calc(14px + var(--dshm-inset-left));' +
    '--dshm-home-bottom:calc(14px + var(--dshm-inset-bottom));' +
    // Room for the panel is whatever is left after both insets *and* the corner margin it is
    // anchored by. Leaving the margin out is what let a short screen clamp the panel to a height
    // that could not then sit above the gesture bar: the clamp and the anchor were each
    // reasonable on their own and disagreed with each other.
    '--dshm-room:calc(100vh - var(--dshm-inset-top) - var(--dshm-inset-bottom)' +
    ' - var(--dshm-home-bottom) - 8px);' +
    // A panel wider than the screen cannot be used at all, so the width is capped by the
    // viewport rather than trusting the 248px design width on a small or split screen.
    '--dshm-width:248px;' +
    'left:var(--dshm-home-left);bottom:var(--dshm-home-bottom);z-index:2147483000;' +
    'font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;' +
    'color:var(--dshm-fg);background:var(--dshm-bg);border:1px solid var(--dshm-border);' +
    'border-radius:12px;box-shadow:0 10px 30px var(--dshm-shadow);' +
    'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);' +
    'width:min(var(--dshm-width),calc(100vw - 24px));overflow:hidden;user-select:none}' +
    '.dshm.dshm-collapsed{width:auto}' +
    // --- edge hiding ---------------------------------------------------------
    // The panel slides towards whichever side it is nearer, leaving a thin rail. Moving is
    // done with transform, so it never fights the drag code (which owns left/top) and the
    // browser can animate it without a layout pass.
    '.dshm{transition:transform .24s cubic-bezier(.22,.61,.36,1)}' +
    '.dshm.dshm-dragging{transition:none}' +
    // While parked the rail is transparent, so what shows at the screen edge is the page
    // behind it rather than a stray strip of panel.
    //
    // The exception is a *collapsed* panel: its whole job while parked is to be the handle
    // you tap, so it keeps its dot and caret. Hiding everything left an empty sliver with
    // nothing to aim at, which is indistinguishable from a panel that failed to load.
    '.dshm.dshm-edge .dshm-head{background:transparent}' +
    '.dshm.dshm-edge .dshm-head:hover{background:transparent}' +
    '.dshm.dshm-edge:not(.dshm-collapsed) .dshm-dot,' +
    '.dshm.dshm-edge:not(.dshm-collapsed) .dshm-title,' +
    '.dshm.dshm-edge:not(.dshm-collapsed) .dshm-caret{opacity:0}' +
    '.dshm.dshm-edge .dshm-body{opacity:0;pointer-events:none}' +
    // Hovering the rail brings it back, so the panel can be read without any click.
    '.dshm.dshm-edge.dshm-peek .dshm-head{background:var(--dshm-hover)}' +
    '.dshm.dshm-edge.dshm-peek .dshm-dot,.dshm.dshm-edge.dshm-peek .dshm-title,' +
    '.dshm.dshm-edge.dshm-peek .dshm-caret{opacity:1}' +
    // --- the resting shape ---------------------------------------------------
    // A small tab on the edge: dot and direction only. It is deliberately the smallest thing
    // that still reads as something to press.
    '.dshm.dshm-collapsed{left:var(--dshm-inset-left);width:auto;border-radius:0 11px 11px 0;' +
    'box-shadow:0 4px 14px var(--dshm-shadow)}' +
    '.dshm.dshm-collapsed .dshm-head{padding:9px 7px 9px 5px;gap:5px}' +
    '.dshm.dshm-collapsed .dshm-title,.dshm.dshm-collapsed .dshm-pin{display:none}' +
    '.dshm.dshm-collapsed .dshm-dot{width:7px;height:7px}' +
    '.dshm.dshm-collapsed .dshm-caret{font-size:12px;opacity:.8}' +
    // --- fitting a short screen -------------------------------------------------
    // A landscape phone or a small screen can be shorter than the open panel, which would put
    // the QR code off-screen and make it unscannable — the one thing the panel exists for. The
    // panel is capped to the viewport, and the body scrolls, so the content stays reachable
    // instead of being cut off.
    '.dshm{max-height:var(--dshm-room)}' +
    '.dshm .dshm-body{max-height:calc(var(--dshm-room) - 46px);overflow-y:auto;' +
    '-webkit-overflow-scrolling:touch}' +
    '.dshm-pin{flex:none;opacity:.55;font-size:11px;cursor:pointer;padding:0 2px;' +
    'line-height:1}' +
    '.dshm-pin:hover{opacity:1}' +
    '.dshm-head{display:flex;align-items:center;gap:8px;padding:9px 11px;cursor:grab;' +
    // touch-action none keeps a touch-drag from scrolling the page underneath.
    'touch-action:none}' +
    '.dshm-head:hover{background:var(--dshm-hover)}' +
    '.dshm.dshm-dragging .dshm-head{cursor:grabbing}' +
    '.dshm.dshm-dragging{opacity:.92}' +
    '.dshm-dot{width:8px;height:8px;border-radius:50%;background:var(--dshm-dim);flex:none}' +
    '.dshm-dot.dshm-on{background:var(--dshm-on);box-shadow:0 0 6px var(--dshm-on)}' +
    '.dshm-dot.dshm-wait{background:var(--dshm-warn)}' +
    '.dshm-dot.dshm-err{background:var(--dshm-err)}' +
    '.dshm-title{flex:1;font-weight:600;font-size:12.5px;letter-spacing:.2px;white-space:nowrap}' +
    '.dshm-caret{opacity:.6;font-size:11px;flex:none}' +
    '.dshm-body{padding:0 11px 11px}' +
    // The QR keeps a white plate in both schemes: a code needs its quiet zone, and inverting
    // it would break scanning on some readers.
    '.dshm-qr{display:block;width:100%;aspect-ratio:1/1;border-radius:8px;background:#fff}' +
    '.dshm-qrwrap{position:relative;border-radius:8px;overflow:hidden;background:#fff}' +
    '.dshm-qrwrap.dshm-loading::after{content:"生成中…";position:absolute;inset:0;display:flex;' +
    'align-items:center;justify-content:center;color:#555;background:#fff;font-size:12px}' +
    '.dshm-meta{margin-top:8px;font-size:11px;color:var(--dshm-dim);display:flex;justify-content:space-between;gap:8px}' +
    '.dshm-link{margin-top:7px;padding:6px 7px;border-radius:6px;background:var(--dshm-field);' +
    'font-size:10.5px;font-family:ui-monospace,Consolas,monospace;word-break:break-all;' +
    'max-height:46px;overflow:auto;user-select:text;color:var(--dshm-field-fg)}' +
    '.dshm-row{display:flex;gap:6px;margin-top:8px}' +
    '.dshm-btn{flex:1;padding:7px 8px;border-radius:7px;border:1px solid var(--dshm-btn-border);' +
    'background:var(--dshm-field);color:var(--dshm-fg);font-size:12px;cursor:pointer;' +
    'font-family:inherit;transition:background .12s}' +
    '.dshm-btn:hover{background:var(--dshm-hover-strong)}' +
    '.dshm-btn:active{background:var(--dshm-active)}' +
    '.dshm-btn.dshm-primary{background:var(--dshm-accent);border-color:var(--dshm-accent);' +
    'color:#fff;font-weight:600}' +
    '.dshm-btn.dshm-primary:hover{background:var(--dshm-accent-hover)}' +
    '.dshm-btn[disabled]{opacity:.5;cursor:default}' +
    '.dshm-hint{margin-top:7px;font-size:10.5px;color:var(--dshm-dim-2);line-height:1.4}' +
    '.dshm-warn{color:var(--dshm-warn)}' +
    '.dshm-err{margin-top:7px;font-size:11px;color:var(--dshm-err-fg);line-height:1.4;word-break:break-word}';

  function injectStyle() {
    if (document.getElementById('dshm-style')) return;
    var style = document.createElement('style');
    style.id = 'dshm-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------------------------------------------------------------- state
  //
  // Three states, and only three:
  //   collapsed + parked  — the resting state. A small strip at the nearest edge, out of the
  //                         way but discoverable. This is what a fresh load shows.
  //   expanded + visible  — a tap opened it, and the QR code is on screen.
  //   collapsed + peeked  — the pointer reached the rail of a parked panel.
  //
  // Collapsing and parking move together, because a collapsed panel that stays in the corner
  // is still a panel in the way, and an expanded one must never be off screen — that is the
  // combination that made the QR code unscannable. Nothing here is persisted: the resting
  // state is small enough to leave alone, so there is no preference worth keeping.
  var state = {
    collapsed: true,
    ttlMs: 0,
    expiresAt: 0,
    link: '',
    secret: '',
    /** Where the **open** panel sits; null means the home corner. Persisted when dragged. */
    panel: null,
    /** Where the **collapsed strip** sits. Derived, never persisted. */
    strip: null,
    /** Distance from the screen's bottom edge to the panel's home corner. */
    homeBottom: null,
    /** The home corner's left. */
    homeLeft: null,
    /** Whether the panel has been opened at least once in this session. */
    wasOpened: false,
    /**
     * True while the panel sits at its home corner rather than somewhere the user dragged it.
     *
     * A dragged position belongs to the user and must survive a size change; the home corner has
     * to be re-derived whenever the height changes, or the panel ends up past the screen edge.
     */
    atHome: true,
    /** True while the panel belongs at an edge; the resting state sets this. */
    edgeHide: true,
    /** Fraction of the panel width currently slid off-screen: 0 shown, 1 parked. */
    edgeHidden: 1,
    /** True while the pointer is on the rail, which brings the panel out. */
    edgeRevealed: false,
    /**
     * True while a pointer is inside the panel.
     *
     * Without it the panel would park the moment the pointer left the rail, which happens
     * continuously while someone is reading it or aiming at a button.
     */
    hovered: false,
    /** True while a drag is in progress, so the rail logic stays out of the way. */
    dragActive: false,
    busy: false,
    error: ''
  };

  var el = {};

  /**
   * How much of the panel stays on screen while parked at an edge.
   *
   * Enough to act as a grab rail and to hint that something is there; not enough to read,
   * which is the point — a parked panel should not sit on top of the page.
   */
  var PEEK_PX = 16;   // enough to hit with a finger on a phone
  /**
   * Fallbacks for the CSS layout properties.
   *
   * The values live in CSS because that is where `env(safe-area-inset-*)` resolves and where
   * the panel's own width is decided; these are only used if the computed style cannot be
   * read, which in practice means the stub in the tests.
   */
  /** Kept so the observer can be disconnected if the widget is ever torn down. */
  var resizeObserver = null;
  var METRIC_FALLBACKS = {
    homeLeft: 14,
    homeBottom: 14,
    panelWidth: 248
  };

  /**
   * Read the panel's layout values from its computed style.
   *
   * A 248px panel is fine on the developer's phone and unusable on a narrow one, and hardcoded
   * corner offsets put it under the rounded corner or the gesture bar on a modern device. All
   * of that is resolved by the browser through CSS (`min()` against the viewport, and
   * `env(safe-area-inset-*)`), so the arithmetic here reads the result instead of repeating it.
   */
  function layoutMetrics(root) {
    var metrics = {
      homeLeft: METRIC_FALLBACKS.homeLeft,
      homeBottom: METRIC_FALLBACKS.homeBottom,
      panelWidth: METRIC_FALLBACKS.panelWidth,
      insetTop: 0,
      insetBottom: 0
    };
    try {
      var computed = window.getComputedStyle(root);
      if (!computed || typeof computed.getPropertyValue !== 'function') return metrics;
      var read = function (name, fallback) {
        var raw = computed.getPropertyValue(name);
        var value = parseFloat(raw);
        return isFinite(value) ? value : fallback;
      };
      metrics.homeLeft = read('--dshm-home-left', metrics.homeLeft);
      metrics.homeBottom = read('--dshm-home-bottom', metrics.homeBottom);
      metrics.panelWidth = read('--dshm-width', metrics.panelWidth);
      metrics.insetTop = read('--dshm-inset-top', 0);
      metrics.insetBottom = read('--dshm-inset-bottom', 0);
    } catch (error) {
      /* no computed style available: the fallbacks are the documented defaults */
    }
    return metrics;
  }

  /**
   * The tallest the panel can be on this screen, mirroring the CSS `--dshm-room`.
   *
   * The CSS already caps the panel; this exists because the *position* depends on the height, and
   * a position computed from the design height puts the panel off the bottom of a short screen.
   * Waiting for the layout to settle and the observer to fire leaves a frame where it is wrong, so
   * the same arithmetic is available here.
   */
  function roomFor(metrics) {
    return Math.max(120, window.innerHeight - metrics.insetTop - metrics.insetBottom
      - metrics.homeBottom - 8);
  }

  function h(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function build() {
    var root = h('div', 'dshm');
    root.id = 'dshm-panel';

    // Apply the starting collapsed state here rather than only on click, so the
    // first paint already matches it (no flash of an expanded panel).
    root.classList.toggle('dshm-collapsed', state.collapsed);
    root.classList.toggle('dshm-parked', state.edgeHidden === 1);
    root.classList.toggle('dshm-edge', state.edgeHidden === 1);
    applySavedPosition(root);
    // The resting state is collapsed and parked; the transform itself is applied once the
    // panel is in the document, when it has a measured width.
    captureHome(root);

    var head = h('div', 'dshm-head');
    el.dot = h('span', 'dshm-dot');
    el.title = h('span', 'dshm-title', 'DSH 手机端');
    el.caret = h('span', 'dshm-caret', state.collapsed ? '▸' : '▾');
    // The rail is barely visible while collapsed, so the same toggle also lives on the open
    // panel: tapping it puts the panel back out of the way without hunting for the edge.
    el.pin = h('span', 'dshm-pin', '⇥');
    el.pin.title = '收起并贴靠 / 展开';
    el.pin.addEventListener('pointerdown', function (event) {
      // Keep the tap from starting a drag or a collapse on the header underneath.
      event.stopPropagation();
    });
    el.pin.addEventListener('click', function (event) {
      event.stopPropagation();
      setCollapsed(root, !state.collapsed);
    });
    head.appendChild(el.dot);
    head.appendChild(el.title);
    head.appendChild(el.pin);
    head.appendChild(el.caret);
    el.head = head;
    makeDraggable(root, head);
    makeEdgeAware(root);

    var body = h('div', 'dshm-body');
    el.body = body;
    if (state.collapsed) body.style.display = 'none';

    var qrWrap = h('div', 'dshm-qrwrap dshm-loading');
    el.qrWrap = qrWrap;
    el.qr = h('img', 'dshm-qr');
    el.qr.alt = '配对二维码';
    qrWrap.appendChild(el.qr);
    body.appendChild(qrWrap);

    var meta = h('div', 'dshm-meta');
    el.addr = h('span', null, '—');
    el.ttl = h('span', null, '');
    meta.appendChild(el.addr);
    meta.appendChild(el.ttl);
    body.appendChild(meta);

    el.link = h('div', 'dshm-link', '尚未生成');
    body.appendChild(el.link);

    var row = h('div', 'dshm-row');
    el.copy = h('button', 'dshm-btn', '复制链接');
    el.refresh = h('button', 'dshm-btn dshm-primary', '刷新二维码');
    row.appendChild(el.copy);
    row.appendChild(el.refresh);
    body.appendChild(row);

    // The one-time key a phone needs so it can pair itself instead of scanning. It is
    // refreshed together with the code, so one button means "everything new".
    var keyLabel = h('div', 'dshm-hint', '一次性配对密钥（手机端填一次，随二维码一起刷新）');
    keyLabel.style.marginTop = '9px';
    body.appendChild(keyLabel);
    var keyRow = h('div', 'dshm-row');
    el.secret = h('div', 'dshm-link', '—');
    el.secret.style.marginTop = '0';
    el.secret.style.flex = '1';
    el.copySecret = h('button', 'dshm-btn', '复制');
    el.copySecret.style.flex = 'none';
    el.copySecret.style.padding = '6px 10px';
    keyRow.appendChild(el.secret);
    keyRow.appendChild(el.copySecret);
    body.appendChild(keyRow);

    el.hint = h('div', 'dshm-hint');
    body.appendChild(el.hint);

    el.err = h('div', 'dshm-err');
    el.err.style.display = 'none';
    body.appendChild(el.err);

    el.copy.addEventListener('click', onCopy);
    el.copySecret.addEventListener('click', onCopySecret);
    el.refresh.addEventListener('click', function () { mint(true); });

    root.appendChild(head);
    root.appendChild(body);
    return root;
  }

  // ---------------------------------------------------------------- helpers
  function setStatus(kind, text) {
    el.dot.className = 'dshm-dot' + (kind ? ' dshm-' + kind : '');
    if (text) el.title.textContent = text;
  }

  /** Collapse/expand, used by a header tap that was not a drag. */
  function toggleCollapsed(root) {
    // No re-save here: tapping neither moves the panel nor should rewrite where it was left.
    // Re-saving clamped the position for the new shape's height and destroyed it permanently —
    // a strip left at 672 became a remembered 229 the first time it was opened.
    setCollapsed(root, !state.collapsed);
  }

  /**
   * Remember where the panel was put.
   *
   * Stored in localStorage rather than left as an in-memory value: the panel is
   * re-created on every page load, and a position that resets is worse than no
   * dragging at all. The position is clamped to the viewport on restore and on
   * resize so a smaller window can never strand the panel off-screen.
   */
  function positionKey() {
    return 'dshm-pos-v1';
  }

  /**
   * Keep the panel inside the viewport, clear of the device's own insets.
   *
   * The limit depends on which shape is on screen: the strip is 37px tall and the open panel is
   * capped by `--dshm-room`. Clamping both with the open height pulled the strip 443px up its first
   * time — the panel appeared to jump on opening — so the height used is the one the *current*
   * state reaches.
   */
  function clampPosition(root, left, top) {
    var metrics = layoutMetrics(root);
    var marginLeft = metrics.homeLeft;
    var maxLeft = Math.max(marginLeft, window.innerWidth - root.offsetWidth - marginLeft);
    var height = state.collapsed
      ? root.offsetHeight
      : Math.min(root.offsetHeight, roomFor(metrics));
    var maxTop = Math.max(0, window.innerHeight - height - metrics.homeBottom);
    return {
      left: Math.min(Math.max(marginLeft, left), maxLeft),
      // The vertical floor is zero: the top inset is already accounted for by the height cap in
      // `roomFor`. Using the horizontal inset here pinned the panel 44px down on a landscape
      // screen, because that device's left inset happened to be 44.
      top: Math.min(Math.max(0, top), maxTop)
    };
  }

  /** Switch from the default bottom-left anchor to explicit coordinates. */
  function placeAt(root, left, top) {
    // Any explicit placement is the user's own, so the home anchor no longer applies.
    state.atHome = false;
    var clamped = clampPosition(root, left, top);
    root.style.left = clamped.left + 'px';
    root.style.top = clamped.top + 'px';
    root.style.bottom = 'auto';
    root.style.right = 'auto';
    return clamped;
  }

  /**
   * Record where the panel has been put.
   *
   * One coordinate for both shapes, because they share their top-left corner: whatever the strip
   * was dragged to is where the panel opens. The value is clamped against the panel's own width and
   * the height it can reach, so a strip moved towards the bottom edge cannot push the open panel
   * off the screen.
   */
  function savePosition(root) {
    var clamped = clampPosition(root, root.offsetLeft, root.offsetTop);
    state.panel = clamped;
    state.strip = { left: clamped.left, top: clamped.top };
    try {
      window.localStorage.setItem(positionKey(), JSON.stringify(clamped));
    } catch (error) {
      /* private mode or storage disabled: dragging still works for this session */
    }
  }

  function applySavedPosition(root) {
    var raw = null;
    try {
      raw = window.localStorage.getItem(positionKey());
    } catch (error) {
      return;
    }
    if (!raw) return;
    try {
      var parsed = JSON.parse(raw);
      if (typeof parsed.left !== 'number' || typeof parsed.top !== 'number') return;
      // A dragged position from an earlier session is deliberately not restored: the resting
      // strip belongs at home, and honouring the old coordinates made the panel reappear
      // wherever it had been dragged to, which is not where the user left the strip.
      void parsed;
      goHome(root);
    } catch (error) {
      /* ignore a malformed entry */
    }
  }

  // ---------------------------------------------------------------- edge hiding
  /**
   * Move the panel to the nearest screen edge, leaving a rail to grab.
   *
   * Only the collapsed panel is ever moved: a small strip at the edge is the resting state,
   * and an expanded panel — the one showing a QR code — is always fully on screen. Which way
   * it slides is decided from its untranslated layout position, so the answer does not change
   * as it moves; the transform leaves `left`/`top` (owned by the drag code) alone, so dragging
   * and parking cannot fight each other.
   */
  function applyEdgeHide(root) {
    var parked = state.edgeHidden === 1;
    var revealed = parked && state.edgeRevealed;
    root.classList.toggle('dshm-edge', parked);
    root.classList.toggle('dshm-peek', revealed);

    var hidden = parked && !revealed ? Math.max(0, root.offsetWidth - PEEK_PX) : 0;
    var centre = root.offsetLeft + root.offsetWidth / 2;
    var goLeft = centre <= window.innerWidth / 2;
    root.style.transform = hidden ? 'translateX(' + (goLeft ? -hidden : hidden) + 'px)' : '';
    publishState();
  }

  /**
   * Collapse to the resting strip, or open the panel.
   *
   * One remembered top for both shapes: the panel opens from the strip's own top, and collapsing
   * returns the strip to that same place. Anchoring by the bottom edge instead made the panel's top
   * move by the height difference on every open — a 37px strip at y=672 became a 480px panel at
   * y=229, which is the "it jumps to the top" report.
   *
   * A 480px panel cannot sit at a strip's 672 without running past the bottom of the screen, so
   * what is *displayed* is clamped into the viewport. The remembered value is deliberately left
   * alone: it is the user's choice, and rewriting it moved the strip permanently the first time the
   * panel was opened.
   */
  function setCollapsed(root, collapsed) {
    // One remembered top for both shapes: the panel opens exactly where the strip was put. The
    // stored value is never rewritten here — it is the user's choice, and re-clamping it for the
    // other shape's height moved it permanently (a strip at 672 became a remembered 229 the first
    // time the panel was opened). Only what goes on screen is clamped.
    if (!state.panel) {
      state.panel = { left: state.homeLeft, top: homeTopFor(root) };
    }

    state.collapsed = collapsed;
    state.edgeHide = true;
    state.edgeHidden = collapsed ? 1 : 0;
    state.edgeRevealed = false;
    root.classList.toggle('dshm-parked', collapsed);
    root.classList.toggle('dshm-collapsed', collapsed);
    var body = root.querySelector('.dshm-body');
    if (body) body.style.display = collapsed ? 'none' : '';
    var caret = root.querySelector('.dshm-caret');
    if (caret) caret.textContent = collapsed ? '▸' : '▾';

    // After the class change, so the clamp uses the height of the shape now on screen.
    state.strip = placeAt(root, state.panel.left, state.panel.top);
    state.wasOpened = true;
    applyEdgeHide(root);
  }

  /**
   * Record the home corner.
   *
   * Stored as the *distance from the bottom edge* rather than a `top` value, because the panel is
   * two different heights and a single top would be right for only one of them. That was the bug:
   * the corner was captured while the panel was collapsed, so "home" became the strip's position
   * and the open panel inherited it.
   */
  function captureHome(root) {
    state.homeLeft = layoutMetrics(root).homeLeft;
    state.homeBottom = layoutMetrics(root).homeBottom;
  }

  /**
   * The height the panel actually occupies: its own height, or the cap when the screen is short.
   *
   * Everything that reasons about the panel's geometry goes through this. Using `offsetHeight`
   * directly was wrong in two places at once — the home corner and the bounds check — and both
   * allowed a position with the bottom edge past the safe area on a landscape screen.
   */
  function effectiveHeight(root) {
    return Math.min(root.offsetHeight, roomFor(layoutMetrics(root)));
  }

  /** The top the panel sits at when it is at its home corner. */
  function homeTopFor(root) {
    var metrics = layoutMetrics(root);
    return window.innerHeight - effectiveHeight(root) - metrics.homeBottom;
  }

  /**
   * Put the panel back at the home corner and forget any stored position.
   *
   * Clears `panel` (there is no user-chosen position any more) and records where the strip landed,
   * so the two shapes stay consistent with each other.
   */
  function goHome(root) {
    state.atHome = true;
    state.panel = null;
    state.strip = placeAt(root, state.homeLeft, homeTopFor(root));
    try {
      window.localStorage.removeItem(positionKey());
    } catch (error) {
      /* private mode: the session still behaves */
    }
  }

  /**
   * Reveal the panel when the pointer reaches the rail, and park it again afterwards.
   *
   * Listening on the window rather than on the panel is deliberate: while parked, most of
   * the panel is off-screen and its remaining sliver is a poor hit target for its own
   * events on some platforms.
   */
  function makeEdgeAware(root) {
    /* Hover reveals a parked panel — but a phone has no hover, so the sliver is also a
     * direct tap target. Without this, parking on a touch device is a one-way trip: the
     * panel is off-screen and nothing the user can do brings it back. */
    var REVEAL_ZONE_PX = 28;
    root.addEventListener('pointerdown', function () {
      if (state.edgeHidden === 1 && !state.edgeRevealed) {
        state.edgeRevealed = true;
        applyEdgeHide(root);
      }
    });

    window.addEventListener('pointermove', function (event) {
      if (state.edgeHidden !== 1 || state.dragActive) return;
      if (state.hovered) return;
      var need = PEEK_PX + 8;
      var onLeftRail = event.clientX <= Math.max(need, REVEAL_ZONE_PX);
      var onRightRail = event.clientX >= window.innerWidth - Math.max(need, REVEAL_ZONE_PX);
      var shouldReveal = state.edgeHide && (onLeftRail || onRightRail);
      if (shouldReveal !== state.edgeRevealed) {
        state.edgeRevealed = shouldReveal;
        applyEdgeHide(root);
      }
    }, { passive: true });

    root.addEventListener('pointerenter', function () {
      state.hovered = true;
      if (state.edgeHidden === 1) {
        state.edgeRevealed = true;
        applyEdgeHide(root);
      }
    });
    root.addEventListener('pointerleave', function () {
      state.hovered = false;
      if (state.edgeHidden === 1) {
        state.edgeRevealed = false;
        applyEdgeHide(root);
      }
    });
  }

  /**
   * Drag the panel by its header.
   *
   * A press that moves less than a few pixels is treated as a tap and toggles the
   * body, so dragging does not break collapsing. Pointer capture keeps the gesture
   * alive when the pointer leaves the header, and `touch-action: none` (set in CSS)
   * stops the page from scrolling instead.
   */
  function makeDraggable(root, handle) {
    var DRAG_SLOP = 4;
    var startX = 0;
    var startY = 0;
    var originLeft = 0;
    var originTop = 0;
    var dragging = false;
    var pointerId = null;

    handle.addEventListener('pointerdown', function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      // Dragging a parked panel must work: bring it out first, or the gesture would be
      // grabbing a rail that is nearly off-screen.
      state.dragActive = true;
      if (state.edgeHidden === 1) {
        state.edgeRevealed = true;
        applyEdgeHide(root);
      }
      var rect = root.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      dragging = false;
      // Prepare explicit coordinates now so the first move is not one frame behind.
      placeAt(root, originLeft, originTop);
      try {
        handle.setPointerCapture(pointerId);
      } catch (error) {
        /* capture is a nicety; window listeners below still work */
      }
    });

    function onMove(event) {
      if (pointerId === null || event.pointerId !== pointerId) return;
      var dx = event.clientX - startX;
      var dy = event.clientY - startY;
      if (!dragging && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return;
      if (!dragging) {
        dragging = true;
        root.classList.add('dshm-dragging');
        // Drop the parking offset before the drag takes over. Otherwise the panel's
        // layout position and its visually shifted position drift apart, and every
        // measurement below would be off by however far it had been slid.
        root.style.transform = '';
      }
      event.preventDefault();
      placeAt(root, originLeft + dx, originTop + dy);
    }

    function onUp(event) {
      if (pointerId === null || (event.pointerId !== undefined && event.pointerId !== pointerId)) return;
      try {
        handle.releasePointerCapture(pointerId);
      } catch (error) {
        /* already released */
      }
      pointerId = null;
      root.classList.remove('dshm-dragging');
      state.dragActive = false;
      if (dragging) {
        savePosition(root);
        dragging = false;
        // Re-park against the new position, which may now be nearer the other edge.
        applyEdgeHide(root);
        return;
      }
      toggleCollapsed(root);
    }

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);

    // Keep the panel reachable if the window shrinks after it was moved.
    window.addEventListener('resize', function () {
      // A collapsed strip is pinned to the bottom edge, so a viewport change has to re-derive
      // its coordinate — otherwise a rotation or an on-screen keyboard leaves it floating
      // somewhere unrelated to the edge it is supposed to sit on.
      if (state.collapsed) {
        goHome(root);
      } else if (state.panel) {
        savePosition(root);
      }
      // Whether it parks left or right depends on the viewport width, so the choice is
      // re-made whenever the window changes size.
      applyEdgeHide(root);
    });

    /**
     * Keep the panel inside the screen when its own size changes.
     *
     * The height is capped by `--dshm-room`, so on a short screen the panel is *shorter* than its
     * design height and a position computed from the old height leaves it past the bottom edge.
     * The QR image arriving after the panel is on screen is the other case.
     *
     * What this must **not** do is re-anchor on every size change: expanding changes the height
     * from 37 to 480, and treating that as a resize teleported the panel to the open panel's home
     * top — the bug this now guards against. It only corrects the anchor, and only when the panel
     * is at home with nothing to preserve: if the home top is no longer reachable, or the panel is
     * off the screen, it is put back.
     */
    if (typeof window.ResizeObserver === 'function') {
      resizeObserver = new window.ResizeObserver(function () {
        if (state.dragActive || state.collapsed || !state.atHome) return;
        var metrics = layoutMetrics(root);
        var home = homeTopFor(root);
        var height = effectiveHeight(root);
        var beyondBottom = root.offsetTop + height > window.innerHeight - metrics.homeBottom;
        // `placeAt` clamps, so comparing against the clamped value is what keeps this from
        // fighting the clamp: it only acts when the panel genuinely cannot stay where it is.
        var target = clampPosition(root, root.offsetLeft, home).top;
        if (beyondBottom || Math.abs(root.offsetTop - target) > 4) {
          goHome(root);
          applyEdgeHide(root);
        }
      });
      resizeObserver.observe(root);
    }
  }

  function setError(message) {
    state.error = message || '';
    el.err.textContent = state.error;
    el.err.style.display = state.error ? '' : 'none';
    setStatus(state.error ? 'err' : 'on', state.error ? 'DSH 手机端（出错）' : 'DSH 手机端');
  }

  function fmtRemaining(ms) {
    if (ms <= 0) return '已过期';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + ' 秒';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' 分钟';
    return (m / 60).toFixed(1) + ' 小时';
  }

  function renderTtl() {
    if (!state.expiresAt) { el.ttl.textContent = ''; return; }
    var left = state.expiresAt - Date.now();
    el.ttl.textContent = left > 0 ? '有效 ' + fmtRemaining(left) : '已过期';
    el.ttl.className = left < 120000 ? 'dshm-warn' : '';
  }

  // ---------------------------------------------------------------- network
  function getJson(url, options) {
    return fetch(url, Object.assign({ credentials: 'same-origin' }, options || {}))
      .then(function (response) {
        if (!response.ok) {
          return response.text().then(function (text) {
            throw new Error('HTTP ' + response.status + (text ? ': ' + text.slice(0, 160) : ''));
          });
        }
        return response.json();
      });
  }

  function applyResult(data) {
    if (data.expiresAt) state.expiresAt = data.expiresAt;
    if (data.pairingUrl) {
      state.link = data.pairingUrl;
      el.link.textContent = data.pairingUrl;
      el.qr.src = '/m/api/qr.svg?rev=' + String(Date.now());
      el.qrWrap.classList.remove('dshm-loading');
    }
    var scope = data.scope === 'tailscale'
      ? 'Tailscale（快速，任何网络可用）'
      : data.scope === 'lan'
        ? '内网（最快，需同一 WiFi）'
        : data.scope === 'tunnel'
          ? '公网隧道（慢，任何网络可用）'
          : '';
    el.addr.textContent = data.host || '—';
    if (data.autoPairSecret) {
      state.secret = data.autoPairSecret;
      el.secret.textContent = data.autoPairSecret;
    }
    el.hint.textContent = scope
      ? '扫描后即在手机浏览器打开。' + scope + '。'
      : '扫描后即在手机浏览器打开。';
    renderTtl();
  }

  /** Mint a fresh token. Refresh is destructive: only one pairing token is live. */
  function mint(refresh) {
    if (state.busy) return;
    state.busy = true;
    el.refresh.disabled = true;
    el.qrWrap.classList.add('dshm-loading');
    setStatus('wait', 'DSH 手机端（生成中）');
    setError('');
    getJson('/m/api/get-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh: refresh === true })
    })
      .then(function (data) {
        applyResult(data);
        setStatus('on', 'DSH 手机端');
      })
      .catch(function (error) {
        setError('生成失败：' + error.message);
        el.link.textContent = state.link || '尚未生成';
        if (!state.link) el.qrWrap.classList.add('dshm-loading');
      })
      .then(function () {
        state.busy = false;
        el.refresh.disabled = false;
      });
  }

  /** Copy a value and flash the button, without duplicating clipboard handling. */
  function copyWithFeedback(value, button, label) {
    if (!value) return;
    var done = function () {
      var was = button.textContent;
      button.textContent = label;
      setTimeout(function () { button.textContent = was; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done, function () { fallbackCopy(value, done); });
    } else {
      fallbackCopy(value, done);
    }
  }

  function onCopy() {
    copyWithFeedback(state.link, el.copy, '已复制');
  }

  function onCopySecret() {
    copyWithFeedback(state.secret, el.copySecret, '已复制');
  }

  function fallbackCopy(value, done) {
    try {
      var area = document.createElement('textarea');
      area.value = value;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
      done();
    } catch (error) {
      /* clipboard unavailable; the value is on screen and selectable anyway */
    }
  }

  // ---------------------------------------------------------------- start
  function start() {
    injectStyle();
    var root = build();
    (document.body || document.documentElement).appendChild(root);
    // Only now does the panel have a measured width, which is what decides how far it has
    // to travel to hide.
    applyEdgeHide(root);
    setInterval(renderTtl, POLL_MS);
    // Show a code immediately; the route only mints when nothing is live.
    mint(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
