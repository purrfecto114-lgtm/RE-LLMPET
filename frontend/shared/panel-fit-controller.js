'use strict';

// Latest-request controller for panel auto-fit.
//
// The renderer can issue a new content-height request before the previous
// Tauri IPC resolves. Keeping the sequencing in this small testable module
// prevents stale successes/failures from corrupting the dedupe cache or
// causing a programmatic resize to be misclassified as a user drag.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.OctoPanelFit = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  function appliedHeightFrom(result, fallback) {
    if (Array.isArray(result) && Number.isFinite(Number(result[1]))) return Number(result[1]);
    if (result && Number.isFinite(Number(result.height))) return Number(result.height);
    return fallback;
  }

  function createPanelFitController(options) {
    const applyHeight = options && options.applyHeight;
    if (typeof applyHeight !== 'function') throw new TypeError('applyHeight must be a function');

    const tolerance = Math.max(0, Number(options.tolerance) || 2);
    const settleMs = Math.max(100, Number(options.settleMs) || 1200);
    const setTimer = (options && options.setTimer) || setTimeout;
    const clearTimer = (options && options.clearTimer) || clearTimeout;
    const onManualResize = (options && options.onManualResize) || function () {};

    let disposed = false;
    let revision = 0;
    let active = null;
    let lastCommittedRequest = null;
    let lastAppliedHeight = null;

    function clearActive(expectedRevision) {
      if (!active || (expectedRevision != null && active.revision !== expectedRevision)) return;
      if (active.timer != null) clearTimer(active.timer);
      active = null;
    }

    function reset() {
      revision += 1;
      clearActive();
      lastCommittedRequest = null;
      lastAppliedHeight = null;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      reset();
    }

    function request(rawHeight) {
      const height = Math.ceil(Number(rawHeight));
      if (!Number.isFinite(height) || height <= 0) {
        return Promise.reject(new TypeError('height must be a positive finite number'));
      }
      if (disposed) return Promise.resolve({ status: 'disposed' });
      if (active && active.requestedHeight === height) return active.promise;
      if (!active && lastCommittedRequest === height) {
        return Promise.resolve({
          status: 'deduped',
          requestedHeight: height,
          appliedHeight: lastAppliedHeight,
        });
      }

      const myRevision = ++revision;
      clearActive();
      const entry = {
        revision: myRevision,
        requestedHeight: height,
        phase: 'pending',
        observedHeight: null,
        appliedHeight: null,
        timer: null,
        promise: null,
      };
      active = entry;

      entry.promise = Promise.resolve()
        .then(() => applyHeight(height))
        .then((result) => {
          if (disposed || !active || active.revision !== myRevision) {
            return { status: 'stale', requestedHeight: height };
          }
          const appliedHeight = appliedHeightFrom(result, height);
          lastCommittedRequest = height;
          lastAppliedHeight = appliedHeight;
          entry.appliedHeight = appliedHeight;
          entry.phase = 'applied';

          const observed = entry.observedHeight;
          if (Number.isFinite(observed)
              && Math.abs(observed - appliedHeight) <= tolerance) {
            clearActive(myRevision);
          } else {
            entry.timer = setTimer(() => {
              if (!active || active.revision !== myRevision) return;
              const pendingObserved = active.observedHeight;
              clearActive(myRevision);
              if (Number.isFinite(pendingObserved)) {
                try { onManualResize(pendingObserved); } catch (_) {}
              }
            }, settleMs);
          }
          return { status: 'applied', requestedHeight: height, appliedHeight };
        })
        .catch((error) => {
          if (active && active.revision === myRevision) clearActive(myRevision);
          throw error;
        });

      return entry.promise;
    }

    // Returns true only when the resize should be treated as a manual user
    // resize. While IPC is pending, classification is deferred because the
    // OS resize event can race the command response. Once the actual clamped
    // height is known, a matching event is consumed; a non-matching pending
    // event is reported through onManualResize after the settle window.
    function isManualResize(rawActualHeight) {
      const actualHeight = Number(rawActualHeight);
      if (disposed || !active) return true;
      if (active.phase === 'pending') {
        if (Number.isFinite(actualHeight)) active.observedHeight = actualHeight;
        return false;
      }
      if (active.phase === 'applied'
          && Number.isFinite(actualHeight)
          && Math.abs(actualHeight - active.appliedHeight) <= tolerance) {
        clearActive(active.revision);
        return false;
      }
      clearActive(active.revision);
      return true;
    }

    function state() {
      return {
        disposed,
        revision,
        activeRevision: active ? active.revision : null,
        activePhase: active ? active.phase : null,
        lastCommittedRequest,
        lastAppliedHeight,
      };
    }

    return Object.freeze({ request, isManualResize, reset, dispose, state });
  }

  return Object.freeze({ createPanelFitController });
});
