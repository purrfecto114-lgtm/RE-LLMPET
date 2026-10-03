'use strict';

// R59: custom pet expression overrides (expression studio) — renderer side.
//
// Contract:
// * The backend owns the table (`expressions:changed` snapshots:
//   { enabled, states: { <state>: { file, ext, sizeBytes } } }) and serves
//   each override as a `data:` URL (read_custom_expression). The CSP
//   already allows `img-src data:`, so overrides render through the SAME
//   fadeSwapImg path as bundled assets.
// * Overrides are GLOBAL (not per-skin) and land ON TOP of the active
//   skin's asset for the state: resolve() answers "should this state use
//   an override?" and the caller keeps its own fallback.
// * Fetched data URLs are cached per state; a change event invalidates
//   only the affected states and re-applies to the CURRENT state so the
//   pet visibly updates while the studio is open.
// * The pixel skin is CSS/SVG (no <img> target), so overrides are skipped
//   there — the studio's upload UI notes it too.
(function (root) {
  const overrideCache = new Map(); // state -> data: URL
  let snapshot = { enabled: false, states: {} };
  let configured = false;
  let log = () => {};

  function statesWithOverrides() {
    return snapshot && snapshot.states && typeof snapshot.states === 'object'
      ? snapshot.states
      : {};
  }

  function invalidate(states) {
    if (Array.isArray(states)) {
      for (const state of states) overrideCache.delete(state);
    } else {
      overrideCache.clear();
    }
  }

  // Re-render hook: pet.js registers a callback that re-applies the CURRENT
  // state so a studio save shows up immediately on the pet.
  let rerender = null;

  function configure(options) {
    const opts = options || {};
    log = typeof opts.log === 'function' ? opts.log : log;
    rerender = typeof opts.rerender === 'function' ? opts.rerender : rerender;
    const api = opts.api || (root && root.pet);
    if (!api || typeof api.getCustomExpressions !== 'function') return;
    if (configured) return;
    configured = true;
    api.getCustomExpressions().then((next) => {
      if (next && typeof next === 'object') {
        snapshot = next;
        // The pet may have rendered its boot state before the snapshot
        // arrived — re-apply so an override for the CURRENT state shows up
        // without waiting for the next state change.
        if (rerender) {
          try { rerender(); } catch (_) {}
        }
      }
    }).catch((error) => {
      log('expressions', 'boot snapshot failed: ' + String(error && (error.message || error) || 'unknown'));
    });
    if (typeof api.onExpressionsChanged === 'function') {
      api.onExpressionsChanged((next) => {
        if (!next || typeof next !== 'object') return;
        const before = statesWithOverrides();
        const changed = [];
        const nextStates = next.states && typeof next.states === 'object' ? next.states : {};
        const allStates = new Set([...Object.keys(before), ...Object.keys(nextStates)]);
        for (const state of allStates) {
          const wasThere = Object.prototype.hasOwnProperty.call(before, state);
          const isThere = Object.prototype.hasOwnProperty.call(nextStates, state);
          const sameFile = wasThere && isThere && before[state].file === nextStates[state].file;
          if (wasThere !== isThere || !sameFile) changed.push(state);
        }
        snapshot = next;
        invalidate(changed);
        if (rerender) {
          try { rerender(); } catch (_) {}
        }
      });
    }
  }

  function enabled() {
    return !!(snapshot && snapshot.enabled);
  }

  function hasOverride(state) {
    return enabled() && Object.prototype.hasOwnProperty.call(statesWithOverrides(), state);
  }

  // Returns a Promise<dataURL|null>. Cached after the first fetch; failures
  // resolve null (the pet falls back to the skin asset) and are logged once.
  function resolve(state) {
    if (!hasOverride(state)) return Promise.resolve(null);
    const cached = overrideCache.get(state);
    if (cached) return Promise.resolve(cached);
    const api = root && root.pet;
    if (!api || typeof api.readCustomExpression !== 'function') return Promise.resolve(null);
    return api.readCustomExpression(state).then((url) => {
      if (typeof url === 'string' && url.startsWith('data:')) {
        overrideCache.set(state, url);
        return url;
      }
      return null;
    }).catch(() => null);
  }

  // Synchronous cached lookup — lets the caller avoid a pack-asset flash
  // before the async fetch lands (see pet.js expressionAwareSwap).
  function peek(state) {
    return hasOverride(state) ? (overrideCache.get(state) || null) : null;
  }

  root.OctoPetExpressions = Object.freeze({
    configure,
    enabled,
    hasOverride,
    resolve,
    peek,
    // test surface
    _reset: () => { overrideCache.clear(); snapshot = { enabled: false, states: {} }; configured = false; rerender = null; log = () => {}; },
    _snapshot: () => snapshot,
  });
})(typeof window !== 'undefined' ? window : globalThis);
