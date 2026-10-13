/**
 * Walk the exact flow a user performs, printing the position after every step.
 *
 * `geometry-probe.cjs` measures states; this measures a *sequence*, because the bug being chased
 * only appears during the transitions — and only sometimes, which is what made it hard to see
 * from single-state numbers.
 *
 * Usage: node flow-probe.cjs [deviceLabelFragment]
 */

const { loadWidget, tap, drag, VIEWPORT_HEIGHT } = require('./widget-stub.cjs');

const OPEN_HEIGHT = 480;

const DEVICE = {
  label: 'phone 375x723',
  viewportWidth: 375,
  viewportHeight: 723,
  homeLeft: 14,
  homeBottom: 14,
  insetTop: 0,
  panelWidth: 248
};

function headOf(panel) {
  return panel.children.find((c) => c.classList.contains('dshm-head'));
}

function report(step, panel, win) {
  const state = win.__dshMobilePanelState || {};
  console.log(
    step.padEnd(30)
    + ' rect=' + String(panel.offsetTop).padStart(5) + ',' + String(panel.offsetLeft).padStart(4)
    + ' h=' + String(panel.offsetHeight).padStart(4)
    + ' state.top=' + String(state.top).padStart(5)
    + ' atHome=' + String(state.atHome).padStart(5)
    + ' parked=' + String(state.parked).padStart(5)
    + ' transform=' + JSON.stringify(panel.style.transform || '')
  );
}

function main() {
  const loaded = loadWidget(undefined, { height: OPEN_HEIGHT, metrics: DEVICE });
  const { panel, window: win } = loaded;
  const head = headOf(panel);
  const settle = () => win.fireResize();

  console.log('flow: as a user performs it (viewport ' + DEVICE.viewportWidth + 'x'
    + DEVICE.viewportHeight + ')');
  console.log();

  win.dispatch('resize', {});
  settle();
  report('1. just loaded', panel, win);

  // The case the user described: drag the *collapsed* strip to 210, then open it. The strip's top
  // and the open panel's top are different coordinates, so this is where a naive implementation
  // puts the open panel off the bottom of the screen.
  drag(head, 14, 210);
  report('2. strip dragged', panel, win);
  settle();
  report('3. after settled', panel, win);

  tap(head);
  report('4. tapped (open)', panel, win);
  settle();
  report('5. after settled', panel, win);

  tap(head);
  report('6. tapped (collapsed)', panel, win);
  settle();
  report('7. after settled', panel, win);

  tap(head);
  report('8. tapped (open again)', panel, win);

  console.log();
  console.log('expected: the strip rests where it was put, the open panel stays on screen, and');
  console.log('repeating the round trip moves neither of them.');
  console.log('  open panel bottom = ' + (panel.offsetTop + panel.offsetHeight)
    + ', viewport = ' + VIEWPORT_HEIGHT);

  // A second round trip from rest, printing every step: drift between rounds is what sent the
  // panel to the wrong place after a couple of taps.
  console.log();
  console.log('round trips from rest (no drag):');
  const fresh = loadWidget(undefined, { height: OPEN_HEIGHT, metrics: DEVICE });
  const freshHead = headOf(fresh.panel);
  fresh.window.__dshMobileTrace = [];
  fresh.window.dispatch('resize', {});
  fresh.window.fireResize();
  report('  rest', fresh.panel, fresh.window);
  for (let i = 1; i <= 2; i++) {
    tap(freshHead);
    report('  open ' + i, fresh.panel, fresh.window);
    tap(freshHead);
    report('  collapse ' + i, fresh.panel, fresh.window);
  }
  console.log('  trace:');
  (fresh.window.__dshMobileTrace || []).forEach((line) => console.log('    ' + line));
}

main();
