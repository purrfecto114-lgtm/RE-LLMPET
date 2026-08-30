'use strict';

(function installPetRuntimePolicy(global) {
  const ERROR_VISUAL_LEASE_MS = 45_000;
  const PRIORITY = ['sweeping', 'attention', 'juggling', 'working', 'thinking', 'loafing'];
  const TOOL_ACTIONS = Object.freeze({
    edit: 'type', multiedit: 'type', write: 'type', notebookedit: 'type',
    read: 'read', bash: 'crank', grep: 'search', glob: 'search',
    websearch: 'web', webfetch: 'web', task: 'summon', agent: 'summon',
    todowrite: 'check',
  });

  function providerId(row) {
    return row && (row.providerId || row.provider) || null;
  }

  function resolveProvider(sessions, enabled, bucket) {
    if (bucket === 'codex') return 'codex';
    const live = (sessions || [])
      .filter((row) => !row.headless && providerId(row) !== 'codex')
      .reduce((best, row) => !best || (Number(row.idleMs) || Infinity) < (Number(best.idleMs) || Infinity) ? row : best, null);
    if (live) return providerId(live) || 'claude';
    return (enabled || []).find((id) => id && id !== 'codex') || null;
  }

  function projectVisibleSessions(sessions) {
    const best = new Map();
    for (const row of sessions || []) {
      if (!row || row.state === 'sleeping') continue;
      // R50: headless children are invisible UNLESS they are blocked — a
      // waiting/needsinput child is a real blockage the user must see.
      const blocked = row.state === 'waiting' || row.state === 'needsinput' || row.state === 'notification';
      if (row.headless && !blocked) continue;
      const key = `${providerId(row) || 'unknown'}:${String(row.sessionId || row.project || '')}`;
      const previous = best.get(key);
      if (!previous || (Number(row.idleMs) || Infinity) < (Number(previous.idleMs) || Infinity)) best.set(key, row);
    }
    return Array.from(best.values());
  }

  function toolAction(toolName) {
    return TOOL_ACTIONS[String(toolName || '').replace(/[._-]/g, '').toLowerCase()] || 'work';
  }

  function patchSessionDots(container, rows, decorate) {
    const existing = new Map(Array.from(container.children).map((node) => [node.dataset.sessionId, node]));
    for (const row of rows) {
      const key = `${providerId(row) || 'unknown'}:${String(row.sessionId || row.project || '')}`;
      let node = existing.get(key);
      if (!node) {
        node = document.createElement('div');
        node.dataset.sessionId = key;
      }
      decorate(node, row);
      container.appendChild(node);
      existing.delete(key);
    }
    for (const stale of existing.values()) stale.remove();
  }

  // R50 (2026-08-30): STATES.md §3 defines oneshot states that must decay
  // when the owning session goes quiet: attention/carrying 15s, sweeping 20s,
  // error 45s. notification is the documented exception (it means "waiting
  // for the user" and must persist until the user acts). Only error had a
  // lease before, so an OpenCode session parked in `attention` (session.idle)
  // or a CodeWhale session parked in `sweeping` kept the pet stuck on that
  // expression forever and masked fresher states from other sessions.
  const ONE_SHOT_LEASE_MS = Object.freeze({
    attention: 15_000,
    carrying: 15_000,
    sweeping: 20_000,
    error: ERROR_VISUAL_LEASE_MS,
  });

  function rowStillActive(row) {
    const lease = ONE_SHOT_LEASE_MS[row.state];
    if (lease == null) return true; // sustained state (working/thinking/…) — no decay
    return (Number(row.idleMs) || 0) <= lease;
  }

  function aggregateState(stats, options) {
    const s = stats || {};
    const rows = projectVisibleSessions(s.sessions);
    const count = (name) => {
      const reported = Number(s[`${name}Count`]);
      return Number.isFinite(reported) ? reported : rows.filter((row) => row.state === name).length;
    };
    if (count('waiting') > 0) return 'waiting';
    // needsinput covers both the reply-waiting state and the `notification`
    // synonym the backend counts together; neither decays (user action required).
    if (count('needsinput') > 0
      || rows.some((row) => row.state === 'notification' && rowStillActive(row))) return 'needsinput';
    const freshError = rows.some((row) =>
      row.state === 'error' && (Number(row.idleMs) || 0) <= ((options && options.errorLeaseMs) || ERROR_VISUAL_LEASE_MS));
    if (freshError || (Number(s.errorCount) > 0 && !(s.sessions || []).length)) return 'error';
    for (const name of PRIORITY) {
      const field = `${name}Count`;
      const fromRows = rows.some((row) => row.state === name && rowStillActive(row));
      if (Number.isFinite(Number(s[field])) ? Number(s[field]) > 0 : fromRows) {
        // Counted fields may include sessions the frontend cannot see (e.g.
        // headless workers). For oneshot states the count alone would defeat
        // the lease, so require at least one still-active visible row —
        // unless no sessions are visible at all, where the count is all we have.
        if (ONE_SHOT_LEASE_MS[name] != null && rows.length && !fromRows) continue;
        return name;
      }
    }
    if (s.idleMs == null || s.idleMs > ((options && options.sleepMs) || 6 * 60 * 1000)) return 'sleeping';
    return 'idle';
  }

  global.OctoPetRuntimePolicy = Object.freeze({
    ERROR_VISUAL_LEASE_MS, resolveProvider, projectVisibleSessions, toolAction, aggregateState, patchSessionDots,
  });
})(window);
