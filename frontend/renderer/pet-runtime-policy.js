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
      if (!row || row.headless || row.state === 'sleeping') continue;
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

  function aggregateState(stats, options) {
    const s = stats || {};
    const rows = projectVisibleSessions(s.sessions);
    const count = (name) => {
      const reported = Number(s[`${name}Count`]);
      return Number.isFinite(reported) ? reported : rows.filter((row) => row.state === name).length;
    };
    if (count('waiting') > 0) return 'waiting';
    if (count('needsinput') > 0) return 'needsinput';
    const freshError = rows.some((row) =>
      row.state === 'error' && (Number(row.idleMs) || 0) <= ((options && options.errorLeaseMs) || ERROR_VISUAL_LEASE_MS));
    if (freshError || (Number(s.errorCount) > 0 && !(s.sessions || []).length)) return 'error';
    for (const name of PRIORITY) {
      const field = `${name}Count`;
      if (Number.isFinite(Number(s[field])) ? Number(s[field]) > 0 : rows.some((row) => row.state === name)) return name;
    }
    if (s.idleMs == null || s.idleMs > ((options && options.sleepMs) || 6 * 60 * 1000)) return 'sleeping';
    return 'idle';
  }

  global.OctoPetRuntimePolicy = Object.freeze({
    ERROR_VISUAL_LEASE_MS, resolveProvider, projectVisibleSessions, toolAction, aggregateState, patchSessionDots,
  });
})(window);
