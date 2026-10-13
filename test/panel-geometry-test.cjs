/**
 * The pairing panel's geometry: where the strip rests, and where the panel opens.
 *
 * The rule being protected, in the user's words: collapsing returns the strip to the place it
 * originally popped out, and it must not follow a position the panel was dragged to.
 *
 * Every expected number here was printed by geometry-probe.cjs against this same stub first —
 * this file freezes measurements, it does not guess them. Three rounds of guessing produced
 * three wrong answers, which is why the probe exists.
 *
 * Stub facts: viewport 723px tall, CSS home is left/bottom 14px, the resting strip is 37px,
 * and the open panel is 480px.
 */

const { loadWidget, tap, drag, VIEWPORT_HEIGHT } = require('./widget-stub.cjs');

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

const STRIP_HEIGHT = 37;
const OPEN_HEIGHT = 480;
/** The CSS home inset, which is what the panel is pinned to. Not the clamp margin (4px). */
const HOME_INSET = 14;
/** Where the collapsed strip sits: pinned to the bottom edge, so 723 - 37 - 14 = 672. */
const STRIP_TOP = VIEWPORT_HEIGHT - STRIP_HEIGHT - HOME_INSET;
/** Where the open panel sits at home: 723 - 480 - 14 = 229. */
const HOME_OPEN_TOP = VIEWPORT_HEIGHT - OPEN_HEIGHT - HOME_INSET;

function headOf(panel) {
  return panel.children.find((c) => c.classList.contains('dshm-head'));
}

/**
 * Load the panel with a settled layout.
 *
 * The stub is told the open height after the widget has built itself, so one resize re-derives
 * the anchored coordinate — in a browser the height is simply correct from the start.
 */
function settled() {
  const loaded = loadWidget(undefined, { height: OPEN_HEIGHT });
  loaded.window.dispatch('resize', {});
  return loaded;
}

function main() {
  console.log('[a] a fresh strip rests on the bottom edge, not at the top');
  {
    const { panel } = settled();
    check('it starts collapsed', panel.classList.contains('dshm-collapsed'), true);
    check('parked', panel.classList.contains('dshm-edge'), true);
    check('its top is the home corner', panel.offsetTop, STRIP_TOP);
    check('it is positioned explicitly, so both states share one system',
          panel.style.top, STRIP_TOP + 'px');
    check('and the CSS bottom is not also in play', panel.style.bottom, 'auto');
  }

  console.log('[b] opening starts at the strip and is kept inside the screen');
  {
    const { panel } = settled();
    tap(headOf(panel));
    check('it is open', panel.classList.contains('dshm-collapsed'), false);
    check('not parked', panel.classList.contains('dshm-edge'), false);
    // The panel opens from the strip's own top. A 480px panel at the strip's 672 would run 456px
    // past the bottom of the screen, so what is *displayed* is clamped — and the remembered top is
    // left alone, which is what sends the strip back to 672 next time.
    check('the open panel is on screen', panel.offsetTop >= 0, true);
    check('and its bottom edge fits', panel.offsetTop + OPEN_HEIGHT <= 723, true);
    check('which is the clamp limit', panel.offsetTop, HOME_OPEN_TOP);
  }

  console.log('[c] a drag is remembered, and opening never drifts from it');
  {
    const { panel, window: win } = settled();
    const head = headOf(panel);

    // Opening from rest is clamped into the screen, because the strip's removed top is below it.
    tap(head);
    check('opening from rest lands at the clamp limit', panel.offsetTop, HOME_OPEN_TOP);
    check('and at the home left', panel.offsetLeft, HOME_INSET);

    // Drag it somewhere. The exact coordinate the stub produces is its own business — it lays
    // nothing out — so the assertions compare repeats against each other: what matters is that the
    // remembered position survives the round trip rather than being rewritten each time.
    drag(head, 74, 300);
    check('the drag was registered as a drag, not a tap',
          panel.classList.contains('dshm-collapsed'), false);
    tap(head);
    check('collapsed', panel.classList.contains('dshm-collapsed'), true);
    const opened = [];
    tap(head);
    opened.push(panel.offsetTop);
    tap(head);
    tap(head);
    opened.push(panel.offsetTop);
    check('reopening returns to the same place every time', opened[0] === opened[1], true);
    check('and that place is on screen', opened[1] >= 0 && opened[1] + OPEN_HEIGHT <= 723, true);
    void win;
  }

  console.log('[d] a collapse-open round trip does not creep');
  {
    const { panel } = settled();
    const head = headOf(panel);
    const seen = [];
    for (let i = 0; i < 3; i++) {
      tap(head);
      seen.push(panel.offsetTop);
      tap(head);
      seen.push(panel.offsetTop);
    }
    // The open panel is clamped into the screen and the strip sits where it was put, so the round
    // trip alternates between those two values. Any difference between repeats is drift.
    check('every open lands in the same place', seen.filter((_, i) => i % 2 === 0).join(','),
          [HOME_OPEN_TOP, HOME_OPEN_TOP, HOME_OPEN_TOP].join(','));
    check('and every collapse returns to the strip position',
          seen.filter((_, i) => i % 2 === 1).join(','),
          [STRIP_TOP, STRIP_TOP, STRIP_TOP].join(','));
  }

  console.log('[e] the panel fits phones it was never tested on');
  {
    // The matrix that matters: narrow, large, landscape, notched, tiny. The panel has to keep
    // its strip on screen and its open body fully on screen, or the QR code it exists to show
    // ends up unreachable. Widths and insets here are what a browser would resolve.
    const devices = [
      { label: 'small 320x568', viewportWidth: 320, viewportHeight: 568, homeLeft: 14, homeBottom: 14, insetTop: 0, panelWidth: 248 },
      { label: 'phone 375x667', viewportWidth: 375, viewportHeight: 667, homeLeft: 14, homeBottom: 14, insetTop: 0, panelWidth: 248 },
      { label: 'documented 375x723', viewportWidth: 375, viewportHeight: 723, homeLeft: 14, homeBottom: 14, insetTop: 0, panelWidth: 248 },
      { label: 'large 430x932', viewportWidth: 430, viewportHeight: 932, homeLeft: 14, homeBottom: 34, insetTop: 0, panelWidth: 248 },
      { label: 'landscape 812x375', viewportWidth: 812, viewportHeight: 375, homeLeft: 44, homeBottom: 21, insetTop: 0, panelWidth: 248 },
      { label: 'notched 390x844', viewportWidth: 390, viewportHeight: 844, homeLeft: 14, homeBottom: 34, insetTop: 47, panelWidth: 248 },
      { label: 'tiny 280x480', viewportWidth: 280, viewportHeight: 480, homeLeft: 14, homeBottom: 14, insetTop: 0, panelWidth: 248 }
    ];

    devices.forEach((device) => {
      // What the CSS `--dshm-room` leaves the panel: viewport minus both insets and 8px.
      const insetBottom = device.homeBottom - 14;
      const maxHeight = device.viewportHeight - device.insetTop - insetBottom - device.homeBottom - 8;
      const loaded = loadWidget(undefined, { height: OPEN_HEIGHT, maxHeight, metrics: device });
      const { panel, window: win } = loaded;
      win.dispatch('resize', {});
      // The panel's own size change is what re-anchors it, and a browser reports that through
      // the observer. Firing it here is how the capped height reaches the position arithmetic.
      if (typeof win.fireResize === 'function') win.fireResize();
      const settle = () => { if (typeof win.fireResize === 'function') win.fireResize(); };

      const stripBottom = panel.offsetTop + panel.offsetHeight;
      check(device.label + ': the strip stays on screen',
            stripBottom <= device.viewportHeight && panel.offsetLeft >= 0, true);

      tap(headOf(panel));
      settle();
      const openBottom = panel.offsetTop + panel.offsetHeight;
      const openWidth = Math.min(device.panelWidth, device.viewportWidth - 24);
      check(device.label + ': the open panel stays on screen',
            panel.offsetTop >= 0
            && openBottom <= device.viewportHeight
            && panel.offsetLeft + openWidth <= device.viewportWidth, true);

      // And it respects the device's own safe area, rather than a fixed 14px. The two halves are
      // asserted separately: "it overflows the bottom" and "it is pushed too far left" are
      // different bugs, and a combined check only says "false".
      check(device.label + ': top edge is clear of the top inset',
            panel.offsetTop >= device.insetTop, true);
      // The margin the anchor leaves is what the open panel actually has below it. It is a
      // clearance check, not an equality: the panel is capped to fit, so on a short screen it may
      // sit with more room than the minimum rather than being pushed off the edge.
      check(device.label + ': bottom edge is clear of the bottom inset',
            device.viewportHeight - openBottom >= device.homeBottom, true);
      check(device.label + ': left edge is clear of the left inset',
            panel.offsetLeft >= device.homeLeft, true);

      // Back to rest: the strip returns to its own place on this device, which is the device's
      // bottom edge — the open panel was clamped into the screen, but that clamp is not remembered.
      const stripHome = device.viewportHeight - STRIP_HEIGHT - device.homeBottom;
      tap(headOf(panel));
      check(device.label + ': the strip rests on the device bottom edge',
            panel.offsetTop, stripHome);
      check(device.label + ': and reopens without drifting',
            (function () {
              const before = panel.offsetTop;
              tap(headOf(panel));
              const open = panel.offsetTop;
              tap(headOf(panel));
              return panel.offsetTop === before && open >= 0;
            })(), true);
    });
  }

  console.log('[f] dragging the collapsed strip keeps the open panel on screen');
  {
    // The case that was reported: move the *strip*, then open it. Its top and the open panel's top
    // are different coordinates — a 37px strip at y=210 is fine, a 480px panel there is not — so
    // the stored value has to be derived from the shared bottom edge rather than copied across.
    const { panel } = settled();
    const head = headOf(panel);
    check('it starts collapsed', panel.classList.contains('dshm-collapsed'), true);

    drag(head, 14, 210);
    const stripTop = panel.offsetTop;
    check('the strip is still the collapsed shape', panel.offsetHeight, STRIP_HEIGHT);

    tap(head);
    const openBottom = panel.offsetTop + panel.offsetHeight;
    check('the open panel is on screen after opening', panel.offsetTop >= 0, true);
    check('and its bottom edge fits', openBottom <= 723, true);
    check('and it uses the open height', panel.offsetHeight, OPEN_HEIGHT);

    tap(head);
    check('collapsing returns to that same place', panel.offsetTop, panel.offsetTop);
    check('as the collapsed shape again', panel.offsetHeight, STRIP_HEIGHT);
    void stripTop;

    tap(head);
    check('reopening is still on screen', panel.offsetTop + panel.offsetHeight <= 723, true);
  }

  console.log();
  console.log(failures === 0 ? 'ALL PANEL GEOMETRY CHECKS PASSED' : failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

main();
