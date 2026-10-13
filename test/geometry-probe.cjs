/**
 * Measure the pairing panel's geometry instead of reasoning about it.
 *
 * This exists because the geometry was reasoned about three times and was wrong three times.
 * It prints what the widget actually computes against the shared DOM stub, so a change can be
 * judged from numbers rather than from a mental model.
 *
 * Usage:
 *   node geometry-probe.cjs              # one default device, every state
 *   node geometry-probe.cjs --matrix     # a range of devices, key measurements only
 *
 * The matrix is the point of the `--matrix` mode: the panel has to fit phones it was never
 * tested on — narrow ones, large ones, landscape, and screens with a notch or gesture bar.
 */

const { loadWidget, tap, drag } = require('./widget-stub.cjs');

const OPEN_HEIGHT = 480;

/**
 * Representative devices.
 *
 * `homeLeft`/`homeBottom` are where the browser resolves the home anchor to, i.e. the 14px
 * design inset plus whatever safe-area inset applies. `room` is the height the CSS leaves the
 * panel: the viewport minus both insets and the 8px clearance (`--dshm-room`).
 */
const DEVICES = [
  { label: 'small phone 320x568', viewportWidth: 320, viewportHeight: 568, homeLeft: 14, homeBottom: 14, insetTop: 0, panelWidth: 248 },
  { label: 'phone 375x667', viewportWidth: 375, viewportHeight: 667, homeLeft: 14, homeBottom: 14, insetTop: 0, panelWidth: 248 },
  { label: 'phone 375x723 (tested)', viewportWidth: 375, viewportHeight: 723, homeLeft: 14, homeBottom: 14, insetTop: 0, panelWidth: 248 },
  { label: 'large 430x932', viewportWidth: 430, viewportHeight: 932, homeLeft: 14, homeBottom: 34, insetTop: 0, panelWidth: 248 },
  { label: 'landscape 812x375', viewportWidth: 812, viewportHeight: 375, homeLeft: 44, homeBottom: 21, insetTop: 0, panelWidth: 248 },
  { label: 'notched 390x844', viewportWidth: 390, viewportHeight: 844, homeLeft: 14, homeBottom: 34, insetTop: 47, panelWidth: 248 },
  { label: 'tiny 280x480', viewportWidth: 280, viewportHeight: 480, homeLeft: 14, homeBottom: 14, insetTop: 0, panelWidth: 248 }
];

/** The height the panel is allowed: viewport minus both insets and the 8px clearance. */
function roomFor(device) {
  const insetBottom = device.homeBottom - 14;
  return device.viewportHeight - (device.insetTop || 0) - insetBottom - device.homeBottom - 8;
}

// Printed rather than inferred: the first version of this table silently disagreed with the
// code, and the disagreement cost more time than the table itself does.
if (process.argv.includes('--rooms')) {
  DEVICES.forEach((device) => {
    const insetBottom = device.homeBottom - 14;
    console.log(device.label.padEnd(24)
      + ' vh=' + String(device.viewportHeight).padStart(4)
      + ' insetTop=' + String(device.insetTop || 0).padStart(3)
      + ' homeBottom=' + String(device.homeBottom).padStart(3)
      + ' insetBottom=' + String(insetBottom).padStart(3)
      + ' room=' + String(roomFor(device)).padStart(4));
  });
  process.exit(0);
}

function headOf(panel) {
  return panel.children.find((c) => c.classList.contains('dshm-head'));
}

/** Load a panel with settled layout, the way the /m/widget.js page does. */
function open(device) {
  const loaded = loadWidget(undefined, {
    height: OPEN_HEIGHT, maxHeight: roomFor(device), metrics: device
  });
  loaded.window.dispatch('resize', {});
  return loaded;
}

function show(label, panel) {
  console.log(
    label.padEnd(32)
    + ' top=' + String(panel.offsetTop).padStart(4)
    + ' left=' + String(panel.offsetLeft).padStart(4)
    + ' w=' + String(panel.offsetWidth).padStart(4)
    + ' h=' + String(panel.offsetHeight).padStart(4)
    + ' style.top=' + JSON.stringify(panel.style.top ?? null)
    + ' classes=' + panel.className
  );
}

/** The values the widget computed, which the DOM offsets only reflect indirectly. */
function showState(label, win) {
  const state = win && win.__dshMobilePanelState;
  if (!state) {
    console.log(label.padEnd(32) + ' (widget state not published)');
    return;
  }
  console.log(label.padEnd(32)
    + ' panel=' + JSON.stringify(state.panel)
    + ' strip=' + JSON.stringify(state.strip)
    + ' homeLeft=' + state.homeLeft
    + ' homeBottom=' + state.homeBottom);
}

function singleDevice() {
  const device = DEVICES[2];
  console.log('device: ' + device.label + '  (open height ' + OPEN_HEIGHT + 'px)');
  console.log();

  const { panel, window: win } = open(device);
  const head = headOf(panel);
  show('resting (collapsed)', panel);
  showState('  widget state', win);

  tap(head);
  show('after tap (open)', panel);
  showState('  widget state', win);

  const placed = drag(head, 74, 300);
  show('after drag (asked 74,300)', panel);
  showState('  widget state', win);

  tap(head);
  show('after tap (collapsed)', panel);
  showState('  widget state', win);
  tap(head);
  show('after tap (open again)', panel);
  showState('  widget state', win);

  console.log();
  console.log('style keys: ' + JSON.stringify(Object.keys(panel.style)));
  console.log('viewport   : ' + win.innerWidth + 'x' + win.innerHeight);
}

function matrix() {
  console.log('device'.padEnd(24)
    + 'viewport'.padEnd(10)
    + 'room'.padStart(6)
    + 'openH'.padStart(7)
    + 'stripTop'.padStart(9)
    + 'openTop'.padStart(8)
    + 'openBottom'.padStart(11)
    + 'stripFits'.padStart(10)
    + 'openFits'.padStart(9));
  let bad = 0;

  DEVICES.forEach((device) => {
    const { panel } = open(device);
    const head = headOf(panel);

    // A settled resting strip, then the open panel at home.
    const stripTop = panel.offsetTop;
    const stripBottom = stripTop + panel.offsetHeight;
    const stripFits = stripBottom <= device.viewportHeight
      && panel.offsetLeft >= 0
      && panel.offsetLeft + 30 <= device.viewportWidth;

    tap(head);
    const openTop = panel.offsetTop;
    // The real height, which on a short screen is the max-height rather than the design height.
    const openBottom = openTop + panel.offsetHeight;
    const openWidth = Math.min(device.panelWidth, device.viewportWidth - 24);
    const openFits = openTop >= 0
      && openBottom <= device.viewportHeight
      && openWidth + panel.offsetLeft <= device.viewportWidth;

    if (!stripFits || !openFits) bad++;

    console.log(
      device.label.padEnd(24)
      + String(device.viewportWidth + 'x' + device.viewportHeight).padEnd(10)
      + String(roomFor(device)).padStart(6)
      + String(panel.offsetHeight).padStart(7)
      + String(stripTop).padStart(9)
      + String(openTop).padStart(8)
      + String(openBottom).padStart(11)
      + String(stripFits ? 'yes' : 'NO').padStart(10)
      + String(openFits ? 'yes' : 'NO').padStart(9)
    );
  });

  console.log();
  console.log(bad === 0
    ? 'every device fits the resting strip and the open panel'
    : bad + ' device(s) do NOT fit — see the NO columns');
  process.exitCode = bad === 0 ? 0 : 1;
}

if (process.argv.includes('--matrix')) matrix();
else singleDevice();
