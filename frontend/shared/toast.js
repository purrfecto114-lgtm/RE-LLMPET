'use strict';

/**
 * R32 (2026-07-31) — Shared toast helper for visible bridge errors.
 *
 * Before R32, `tauri-bridge.js` `send()` only `console.error`-ed failures.
 * The R30 partial-fix added a `re-llmpet:bridge-error` CustomEvent, but the
 * panel listener still only `console.warn`-ed with a TODO. This helper turns
 * that event into a real user-visible toast that auto-dismisses after 4s,
 * can be dismissed early by click, and is announced to screen readers via
 * `role="alert"` + `aria-live="assertive"` on the host element.
 *
 * Both panel.js and pet.js install this listener on script load. The host
 * element (`#re-llmpet-toast`) is added to both panel.html and pet.html.
 */
(function installReLlmpetToast(global) {
  function getToastEl() {
    return document.getElementById('re-llmpet-toast');
  }

  // R39 (2026-08-01): persistent error log. Critical errors (config write
  // failure, hook install failure, launch failure) should NOT auto-dismiss.
  // They stay visible until the user explicitly closes them, and they
  // accumulate in a small log so the user can review multiple errors.
  // The 0.5.16 full audit (§9.3) flagged that 4.5s auto-dismiss toasts
  // are insufficient for persistent failures.
  const errorLog = [];
  const MAX_ERRORS = 10;

  function showToast(message, opts) {
    const el = getToastEl();
    if (!el) return;
    const persistent = (opts && opts.persistent) || false;
    const timeout = persistent ? 0 : ((opts && opts.timeout) || 4000);
    const cmd = (opts && opts.command) || '';

    // R39: add to error log if persistent
    if (persistent) {
      errorLog.unshift({ message: String(message || ''), command: cmd, ts: Date.now() });
      if (errorLog.length > MAX_ERRORS) errorLog.pop();
    }

    el.innerHTML = '';
    if (cmd) {
      const tag = document.createElement('span');
      tag.className = 're-llmpet-toast-tag';
      tag.textContent = cmd;
      el.appendChild(tag);
    }
    const text = document.createElement('span');
    text.className = 're-llmpet-toast-msg';
    text.textContent = String(message || '');
    el.appendChild(text);

    // R39: add close button for persistent errors
    if (persistent) {
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.className = 're-llmpet-toast-close';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        el.classList.remove('show');
        el.hidden = true;
        // R22: notify the pet window to recompute visual bounds after the
        // toast is hidden, so the click-through region shrinks back to the
        // pet anchor.
        notifyVisualBoundsChanged();
      });
      el.appendChild(closeBtn);
    }

    el.hidden = false;
    el.classList.add('show');
    // R22: notify the pet window to expand the click-through region to
    // include the now-visible toast. requestAnimationFrame ensures the
    // layout has settled before we measure getBoundingClientRect.
    notifyVisualBoundsChanged();
    // Clear any prior auto-hide timer
    if (el._reLlmpetToastTimer) {
      clearTimeout(el._reLlmpetToastTimer);
    }
    if (timeout > 0) {
      el._reLlmpetToastTimer = setTimeout(() => {
        el.classList.remove('show');
        // Keep `hidden` attribute in sync after the fade-out animation
        setTimeout(() => {
          if (!el.classList.contains('show')) el.hidden = true;
          notifyVisualBoundsChanged();
        }, 250);
      }, timeout);
    }
  }

  // R22: tell the pet window (if present) to recompute its visual bounds.
  // The pet window's native click-through guard (cursor_hit_decision in
  // platform.rs) uses petVisualBounds to decide whether to ignore cursor
  // events. When a toast appears or disappears, the interactive rect
  // changes and must be re-reported.
  function notifyVisualBoundsChanged() {
    if (typeof global.requestAnimationFrame === 'function') {
      global.requestAnimationFrame(() => {
        if (global.pet && typeof global.pet.petVisualBounds === 'function') {
          // Delegate to pet.js's reportPetVisualBounds if available, which
          // recomputes the union of all INTERACTIVE_HIT_SEL elements.
          if (typeof global.reportPetVisualBounds === 'function') {
            global.reportPetVisualBounds();
          }
        }
      });
    }
  }

  // Click anywhere on the toast to dismiss early
  function bindClickToDismiss() {
    const el = getToastEl();
    if (!el || el._reLlmpetToastBound) return;
    el._reLlmpetToastBound = true;
    el.addEventListener('click', () => {
      el.classList.remove('show');
      if (el._reLlmpetToastTimer) clearTimeout(el._reLlmpetToastTimer);
      setTimeout(() => { if (!el.classList.contains('show')) el.hidden = true; }, 250);
    });
  }

  function install() {
    if (global._reLlmpetToastInstalled) return;
    global._reLlmpetToastInstalled = true;
    global.addEventListener('re-llmpet:bridge-error', (e) => {
      const detail = (e && e.detail) || {};
      const message = detail.message || 'unknown error';
      const command = detail.command || '';
      // R39: critical commands use persistent toast (no auto-dismiss).
      // Non-critical commands use the standard 4.5s auto-dismiss.
      const criticalCommands = ['set_providers', 'set_session_prefs', 'set_session_pref', 'close_panel', 'launch_agent'];
      const persistent = criticalCommands.indexOf(command) >= 0;
      showToast(message, { command, timeout: persistent ? 0 : 4500, persistent });
    });
    // Defer click-binding until DOMContentLoaded so #re-llmpet-toast exists
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bindClickToDismiss);
    } else {
      bindClickToDismiss();
    }
  }

  // Expose for tests / programmatic use
  global.reLlmpetToast = { show: showToast, install };
  install();
})(window);
