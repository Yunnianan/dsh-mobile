/* In-page diagnostic for the DSH shell.
 *
 * Read by MainActivity and evaluated in the WebView, then reported line by line to logcat.
 *
 * It lives in a file rather than a Java string literal on purpose, and it ends with an
 * explicit JSON.stringify: as a literal, one missing character made the whole script
 * unparseable and evaluateJavascript silently returned null. Returning a JSON string makes
 * both the syntax and the "did it produce a value" question checkable outside a device —
 * see diag-selfcheck.cjs, which runs this file and asserts it returns something.
 *
 * Keep it dependency-free. Its only lasting effect is a capture-phase pointer counter that
 * records whether the page receives pointer events at all.
 */
(function () {
  var out = [];

  function push(label, value) {
    out.push(label + '=' + String(value));
  }

  try {
    push('url', location.href);
    push('readyState', document.readyState);
    push('moduleLoader', typeof window.__ModuleLoader__);

    var ml = window.__ModuleLoader__;
    if (ml) {
      push('loaderKeys', Object.keys(ml).join(','));
      var queue = ml.pendingQueue;
      push('pendingQueue', queue ? queue.length : 'n/a');
      if (queue && queue.length) {
        for (var i = 0; i < queue.length && i < 3; i++) {
          push('queued' + i, queue[i] && queue[i].id ? queue[i].id : typeof queue[i]);
        }
      }
    }

    var globals = ['__dshThemeRuntime', '__dshTheme', '__dshSlots', '__dshModules', '__dshBoot'];
    for (var g = 0; g < globals.length; g++) {
      push(globals[g], typeof window[globals[g]]);
    }

    var body = document.body;
    push('bodyLen', body ? body.innerHTML.length : 0);
    if (body) {
      push('bodyText', String(body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400));
    }

    var styles = document.querySelectorAll('style,link[rel=stylesheet]');
    var styleIds = [];
    for (var s = 0; s < styles.length; s++) {
      if (styles[s].id) styleIds.push(styles[s].id);
    }
    push('styles', styles.length + ' ids=' + styleIds.join(','));

    /* Does the page receive input at all? Both a pointer and a touch counter, because they
     * answer different questions: no pointerdown means the event never arrived, while a
     * pointerdown without a following touchstart means something cancelled the sequence. */
    if (!window.__dshTap) {
      window.__dshTap = { n: 0, tag: '', touches: 0, lastTouch: '', moves: 0 };
      document.addEventListener('pointerdown', function (event) {
        window.__dshTap.n += 1;
        window.__dshTap.tag = event.target && event.target.tagName ? event.target.tagName : '?';
      }, true);
      document.addEventListener('touchstart', function (event) {
        window.__dshTap.touches += 1;
        window.__dshTap.lastTouch = event.target && event.target.tagName
          ? event.target.tagName : '?';
      }, true);
      document.addEventListener('touchmove', function () {
        window.__dshTap.moves += 1;
      }, { capture: true, passive: true });
    }
    push('tapCount', window.__dshTap.n + ' lastTag=' + window.__dshTap.tag);
    push('touchCount', window.__dshTap.touches + ' lastTouch=' + window.__dshTap.lastTouch
      + ' moves=' + window.__dshTap.moves);
    push('scrollY', Math.round(window.scrollY || 0));

    /* Who is on top at the points a user would actually press? */
    var width = window.innerWidth;
    var height = window.innerHeight;
    push('viewport', width + 'x' + height);

    function at(x, y) {
      var el = document.elementFromPoint(x, y);
      if (!el) return 'none';
      var cls = (el.className && typeof el.className === 'string')
        ? '.' + el.className.split(' ')[0]
        : '';
      var pe = '';
      try {
        pe = getComputedStyle(el).pointerEvents;
      } catch (ignored) {
        pe = '?';
      }
      return el.tagName + cls + ' pe=' + pe;
    }

    push('atUpper', at(width / 2, Math.round(height * 0.3)));
    push('atCentre', at(width / 2, Math.round(height / 2)));
    push('atBottom', at(width / 2, height - 80));

    /* Anything that covers most of the screen is a candidate for swallowing taps. */
    var all = document.querySelectorAll('body *');
    var covers = [];
    for (var k = 0; k < all.length && covers.length < 6; k++) {
      var node = all[k];
      var rect = node.getBoundingClientRect();
      if (rect.width >= width * 0.8 && rect.height >= height * 0.8) {
        var cs = getComputedStyle(node);
        covers.push(node.tagName + '.' + String(node.className).split(' ')[0]
          + '(z=' + cs.zIndex + ',pe=' + cs.pointerEvents
          + ',pos=' + cs.position + ',bg=' + cs.backgroundColor + ')');
      }
    }
    push('coversViewport', covers.length ? covers.join(' ; ') : 'none');

    /* A masked layer was sitting on top of the buttons. Name its ancestry and geometry so it
     * can be traced to the component that rendered it, rather than guessed at. */
    var mask = document.querySelector('[class*=mask]');
    if (mask) {
      var mr = mask.getBoundingClientRect();
      var mcs = getComputedStyle(mask);
      push('mask.class', mask.className);
      push('mask.geom', Math.round(mr.width) + 'x' + Math.round(mr.height)
        + ' at ' + Math.round(mr.left) + ',' + Math.round(mr.top));
      push('mask.style', 'pos=' + mcs.position + ' z=' + mcs.zIndex
        + ' bg=' + mcs.backgroundColor + ' op=' + mcs.opacity);
      push('mask.children', mask.children.length);

      /* The mask and the dialog are siblings inside the dialog's root, so what matters is
       * the whole subtree: a mask with no dialog next to it is a half-rendered modal that
       * swallows every tap. */
      var root = mask.parentElement;
      if (root) {
        push('root.class', root.className);
        push('root.children', root.children.length);
        var names = [];
        for (var c = 0; c < root.children.length && c < 8; c++) {
          var kid = root.children[c];
          var kr = kid.getBoundingClientRect();
          names.push(String(kid.className).split('_')[1] + ':' + kr.width + 'x' + kr.height);
        }
        push('root.kids', names.join(' ; '));
        push('root.text', String(root.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160));
      }
      push('mask.chain', (function () {
        var out2 = [];
        var node = mask;
        for (var up = 0; up < 5 && node; up++) {
          out2.push(node.tagName + ':' + String(node.className).split(' ')[0]);
          node = node.parentElement;
        }
        return out2.join(' < ');
      })());
    } else {
      push('mask', 'none');
    }

    /* The pairing panel parks itself at an edge, so "it is not visible" needs measuring
     * rather than eyeballing: position, size, transform and what covers it. Wrapped, because
     * one optional check must not cost the rest of the report — that failure mode is exactly
     * what hid a broken diagnostic before. */
    try {
      var panel = document.getElementById ? document.getElementById('dshm-panel') : null;
      if (panel) {
        var pr = panel.getBoundingClientRect();
        var pcs = getComputedStyle(panel);
        push('panel.rect', Math.round(pr.left) + ',' + Math.round(pr.top)
          + ' ' + Math.round(pr.width) + 'x' + Math.round(pr.height));
        push('panel.transform', pcs.transform);
        push('panel.classes', String(panel.className));
        push('panel.style', 'pos=' + pcs.position + ' z=' + pcs.zIndex
          + ' op=' + pcs.opacity + ' vis=' + pcs.visibility + ' display=' + pcs.display);
        push('panel.offsets', 'offsetLeft=' + panel.offsetLeft
          + ' offsetWidth=' + panel.offsetWidth + ' offsetHeight=' + panel.offsetHeight);
        var panelBody = panel.querySelector('[class*=body]');
        push('panel.bodyDisplay', panelBody ? getComputedStyle(panelBody).display : 'n/a');
        // The bottom edge is what must not move when the panel collapses or expands; a fresh
        // measurement is the only way to see that, because offsetHeight lags the resize.
        push('panel.bottom', Math.round(panel.offsetTop + panel.offsetHeight)
          + ' (top=' + panel.offsetTop + ' h=' + panel.offsetHeight + ')');
        var probeX = Math.max(1, Math.min(window.innerWidth - 2, Math.round(pr.left + 4)));
        var probeY = Math.max(1, Math.min(window.innerHeight - 2, Math.round(pr.top + 20)));
        push('panel.hitAtSelf', at(probeX, probeY));
        // Where the document is scrolled to, and whether the panel is actually inside the visual
        // viewport. "It jumped to the top" is a visual complaint, and neither is visible in the
        // panel's own coordinates when the page itself has moved.
        push('viewport.scroll', 'x=' + Math.round(window.scrollX || 0)
          + ' y=' + Math.round(window.scrollY || 0)
          + ' docH=' + (document.documentElement ? document.documentElement.scrollHeight : '?')
          + ' visualH=' + (window.visualViewport ? Math.round(window.visualViewport.height) : 'n/a'));
        push('panel.onScreen', (pr.left < window.innerWidth && pr.right > 0
          && pr.top < window.innerHeight && pr.bottom > 0) ? 'yes' : 'no');
        push('panel.rectFull', Math.round(pr.left) + ',' + Math.round(pr.top)
          + ' ' + Math.round(pr.right) + ',' + Math.round(pr.bottom));
      } else {
        push('panel', document.getElementById ? 'not in the DOM' : 'getElementById unavailable');
      }
    } catch (panelError) {
      push('panel', 'check threw: '
        + (panelError && panelError.message ? panelError.message : panelError));
    }

    /* Programmatic click, so "the page responds" can be told apart from "touches never
     * arrive". Nothing about it pretends to be a finger: it is the page's own handler. */
    try {
      var target = null;
      var nodes = document.querySelectorAll('button,[role=button]');
      for (var n = 0; n < nodes.length; n++) {
        var label = String(nodes[n].innerText || '').trim();
        if (label === '继续' || label.indexOf('继续') === 0) {
          target = nodes[n];
          break;
        }
      }
      if (!target) {
        target = nodes.length ? nodes[nodes.length - 1] : null;
      }
      if (target) {
        var before = document.querySelectorAll('[class*=mask]').length;
        target.click();
        push('clicked', String(target.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24));
        push('maskAfterClick', document.querySelectorAll('[class*=mask]').length
          + ' (was ' + before + ')');
      } else {
        push('clicked', 'no button found');
      }
    } catch (clickError) {
      push('clicked', 'threw: ' + (clickError && clickError.message ? clickError.message : clickError));
    }

    return JSON.stringify(out.join(' | '));
  } catch (e) {
    return JSON.stringify('diag threw: ' + (e && e.message ? e.message : String(e)));
  }
})();
