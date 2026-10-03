'use strict';

// Coalesces state-setting IPC calls behind one small state machine.
// At most one native call is in flight, intermediate desired values collapse
// to the newest value, and transient failures can be retried with bounded
// backoff. A value is considered applied only after IPC success.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.OctoLatestValue = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  function defaultEquals(a, b) {
    return Object.is(a, b);
  }

  function normalizeRetryDelays(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((value) => Math.max(0, Number(value) || 0))
      .filter((value) => Number.isFinite(value));
  }

  function createLatestValueController(options) {
    const apply = options && options.apply;
    if (typeof apply !== 'function') throw new TypeError('apply must be a function');

    const equals = (options && options.equals) || defaultEquals;
    const onError = (options && options.onError) || function () {};
    const onExhausted = (options && options.onExhausted) || function () {};
    const retryDelays = normalizeRetryDelays(options && options.retryDelays);
    const setTimer = (options && options.setTimer) || setTimeout;
    const clearTimer = (options && options.clearTimer) || clearTimeout;

    let disposed = false;
    let running = false;
    let desiredSet = false;
    let desiredValue;
    let desiredRevision = 0;
    let appliedSet = false;
    let appliedValue;
    let retryIndex = 0;
    let retryTimer = null;
    const idleWaiters = new Set();

    function isIdle() {
      return !running && !desiredSet && retryTimer == null;
    }

    function settleIdleWaiters() {
      if (!isIdle()) return;
      for (const resolve of Array.from(idleWaiters)) resolve();
      idleWaiters.clear();
    }

    function waitUntilIdle() {
      if (disposed || isIdle()) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.add(resolve));
    }

    function cancelRetry() {
      if (retryTimer == null) return;
      clearTimer(retryTimer);
      retryTimer = null;
    }

    function scheduleRetry(revision) {
      if (disposed || revision !== desiredRevision || retryIndex >= retryDelays.length) {
        return false;
      }
      const delay = retryDelays[retryIndex++];
      retryTimer = setTimer(() => {
        retryTimer = null;
        if (!disposed && desiredSet && revision === desiredRevision) void drain();
        else settleIdleWaiters();
      }, delay);
      return true;
    }

    async function drain() {
      if (running || disposed || retryTimer != null) return;
      running = true;
      try {
        while (!disposed && desiredSet) {
          if (appliedSet && equals(desiredValue, appliedValue)) {
            desiredSet = false;
            retryIndex = 0;
            continue;
          }

          const value = desiredValue;
          const revision = desiredRevision;
          try {
            await apply(value);
            // The native side may now hold this value even if a newer request
            // arrived while the call was in flight. Record it, then continue
            // toward the latest desired value.
            appliedValue = value;
            appliedSet = true;
            if (desiredSet && revision === desiredRevision) {
              desiredSet = false;
              retryIndex = 0;
            }
          } catch (error) {
            try { onError(error, value); } catch (_) {}
            if (disposed) break;
            if (revision !== desiredRevision) {
              // A newer request superseded the failed value. Do not spend its
              // retry budget on stale work; continue immediately.
              retryIndex = 0;
              continue;
            }
            if (scheduleRetry(revision)) break;
            // Only the current revision may reconcile UI state. Stale failures
            // are skipped above and immediately drain toward the newest value.
            try { onExhausted(error, value); } catch (_) {}
            // Retries exhausted. Keep applied state unchanged so an identical
            // future request can start a fresh attempt.
            desiredSet = false;
            retryIndex = 0;
            break;
          }
        }
      } finally {
        running = false;
        if (!disposed && desiredSet && retryTimer == null) void drain();
        settleIdleWaiters();
      }
    }

    function request(value) {
      if (disposed) return Promise.resolve();
      if (desiredSet && equals(desiredValue, value)) return waitUntilIdle();
      if (!desiredSet && appliedSet && equals(appliedValue, value)) return Promise.resolve();

      cancelRetry();
      desiredValue = value;
      desiredSet = true;
      desiredRevision += 1;
      retryIndex = 0;
      void drain();
      return waitUntilIdle();
    }

    function resetApplied() {
      appliedSet = false;
      appliedValue = undefined;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      desiredSet = false;
      cancelRetry();
      for (const resolve of Array.from(idleWaiters)) resolve();
      idleWaiters.clear();
    }

    function state() {
      return {
        disposed,
        running,
        desiredSet,
        desiredValue,
        desiredRevision,
        appliedSet,
        appliedValue,
        retryIndex,
        retryScheduled: retryTimer != null,
      };
    }

    return Object.freeze({ request, waitUntilIdle, resetApplied, dispose, state });
  }

  return Object.freeze({ createLatestValueController });
});
