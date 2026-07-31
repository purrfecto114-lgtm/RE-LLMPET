'use strict';

/**
 * R32 (2026-07-31) — Shared toast helper for visible bridge errors.
 *
 * Before R32, `tauri-bridge.js` `send()` only `console.error`-ed failures.
 * The R30 partial-fix added a `octopus:bridge-error` CustomEvent, but the
 * panel listener still only `console.warn`-ed with a TODO. This helper turns
 * that event into a real user-visible toast that auto-dismisses after 4s,
 * can be dismissed early by click, and is announced to screen readers via
 * `role="alert"` + `aria-live="assertive"` on the host element.
 *
 * Both panel.js and pet.js install this listener on script load. The host
 * element (`#octopus-toast`) is added to both panel.html and pet.html.
 */
(function installOctopusToast(global) {
  function getToastEl() {
    return document.getElementById('octopus-toast');
  }

  function showToast(message, opts) {
    const el = getToastEl();
    if (!el) return;
    const timeout = (opts && opts.timeout) || 4000;
    const cmd = (opts && opts.command) || '';
    el.innerHTML = '';
    if (cmd) {
      const tag = document.createElement('span');
      tag.className = 'octopus-toast-tag';
      tag.textContent = cmd;
      el.appendChild(tag);
    }
    const text = document.createElement('span');
    text.className = 'octopus-toast-msg';
    text.textContent = String(message || '');
    el.appendChild(text);
    el.hidden = false;
    el.classList.add('show');
    // Clear any prior auto-hide timer
    if (el._octopusToastTimer) {
      clearTimeout(el._octopusToastTimer);
    }
    el._octopusToastTimer = setTimeout(() => {
      el.classList.remove('show');
      // Keep `hidden` attribute in sync after the fade-out animation
      setTimeout(() => { if (!el.classList.contains('show')) el.hidden = true; }, 250);
    }, timeout);
  }

  // Click anywhere on the toast to dismiss early
  function bindClickToDismiss() {
    const el = getToastEl();
    if (!el || el._octopusToastBound) return;
    el._octopusToastBound = true;
    el.addEventListener('click', () => {
      el.classList.remove('show');
      if (el._octopusToastTimer) clearTimeout(el._octopusToastTimer);
      setTimeout(() => { if (!el.classList.contains('show')) el.hidden = true; }, 250);
    });
  }

  function install() {
    if (global._octopusToastInstalled) return;
    global._octopusToastInstalled = true;
    global.addEventListener('octopus:bridge-error', (e) => {
      const detail = (e && e.detail) || {};
      const message = detail.message || 'unknown error';
      const command = detail.command || '';
      showToast(message, { command, timeout: 4500 });
    });
    // Defer click-binding until DOMContentLoaded so #octopus-toast exists
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bindClickToDismiss);
    } else {
      bindClickToDismiss();
    }
  }

  // Expose for tests / programmatic use
  global.octopusToast = { show: showToast, install };
  install();
})(window);
