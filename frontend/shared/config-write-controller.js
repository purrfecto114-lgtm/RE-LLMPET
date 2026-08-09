'use strict';

// Serializes optimistic configuration writes per setting key.
//
// Each key owns one LatestValue controller, so rapid changes collapse to the
// newest requested value instead of racing independent Tauri invokes. When the
// current value cannot be persisted, reconciliation waits for every key to
// become idle before reloading authoritative config. Any request arriving while
// that reload is in flight invalidates the full snapshot and schedules a fresh
// pass, preventing one failed key from reverting another key's newer UI state.
(function (root, factory) {
  const api = factory(root && root.OctoLatestValue);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.OctoConfigWrites = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (latestValueApi) {
  function createConfigWriteController(options) {
    const latest = (options && options.latestValueApi) || latestValueApi;
    if (!latest || typeof latest.createLatestValueController !== 'function') {
      throw new TypeError('OctoLatestValue.createLatestValueController is required');
    }
    const reload = options && options.reload;
    const applySnapshot = options && options.applySnapshot;
    const reportError = (options && options.reportError) || function () {};
    if (typeof reload !== 'function') throw new TypeError('reload must be a function');
    if (typeof applySnapshot !== 'function') throw new TypeError('applySnapshot must be a function');

    const entries = new Map();
    let disposed = false;
    let requestRevision = 0;
    let reconcileNeeded = false;
    let reconciling = false;

    async function waitForAllIdle() {
      const waits = Array.from(entries.values(), (entry) => entry.controller.waitUntilIdle());
      await Promise.all(waits);
    }

    async function reconcileAuthoritativeState() {
      if (reconciling || disposed) return;
      reconciling = true;
      try {
        while (reconcileNeeded && !disposed) {
          reconcileNeeded = false;
          const revision = requestRevision;
          await waitForAllIdle();
          if (disposed) break;
          if (revision !== requestRevision) {
            reconcileNeeded = true;
            continue;
          }

          let snapshot;
          try {
            snapshot = await reload();
          } catch (error) {
            try { reportError('config:reload', error); } catch (_) {}
            break;
          }
          if (disposed) break;
          if (revision !== requestRevision) {
            reconcileNeeded = true;
            continue;
          }
          if (snapshot) {
            try {
              applySnapshot(snapshot);
            } catch (error) {
              try { reportError('config:apply', error); } catch (_) {}
              break;
            }
          }
        }
      } finally {
        reconciling = false;
        if (reconcileNeeded && !disposed) void reconcileAuthoritativeState();
      }
    }

    function scheduleReconciliation() {
      reconcileNeeded = true;
      void reconcileAuthoritativeState();
    }

    function createEntry(key, persist) {
      const entry = { persist, controller: null };
      entry.controller = latest.createLatestValueController({
        apply(value) {
          return entry.persist(value);
        },
        onExhausted(error, value) {
          try { reportError(key, error, value); } catch (_) {}
          scheduleReconciliation();
        },
      });
      entries.set(key, entry);
      return entry;
    }

    function request(key, value, persist) {
      if (disposed) return Promise.resolve();
      if (typeof key !== 'string' || !key) throw new TypeError('key must be a non-empty string');
      if (typeof persist !== 'function') throw new TypeError('persist must be a function');
      requestRevision += 1;
      const entry = entries.get(key) || createEntry(key, persist);
      entry.persist = persist;
      return entry.controller.request(value);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      reconcileNeeded = false;
      for (const entry of entries.values()) entry.controller.dispose();
      entries.clear();
    }

    function state(key) {
      const entry = entries.get(key);
      return entry ? entry.controller.state() : null;
    }

    return Object.freeze({ request, dispose, state });
  }

  return Object.freeze({ createConfigWriteController });
});
