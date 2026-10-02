'use strict';

(function installPetAgentView(global) {
  // Config-driven default for the aggregate pet window (label 'pet'). The
  // bridge exposes the first enabled provider; fall back to a neutral default
  // only when the bridge/config is not yet available.
  function defaultAgent() {
    try {
      if (global.pet && typeof global.pet.defaultAgent === 'function') {
        const resolved = global.pet.defaultAgent();
        if (resolved) return resolved;
      }
    } catch (_) {}
    return 'aggregate'; // window bucket, not a fabricated provider identity
  }

  // R58-IMPL-C: the second pet's pairing provider (config.duoProvider).
  // Snapshotted from pet:config pushes by pet.js (setDuoProvider below);
  // missing field keeps the 0.6.6 hardcoded 'codex' behavior.
  let duoProviderValue = 'codex';

  function setDuoProvider(value) {
    if (typeof value === 'string' && value) duoProviderValue = value;
  }

  function duoProvider() {
    return duoProviderValue;
  }

  function currentAgent() {
    try {
      // Derive from the window label (authoritative, synchronous).
      // R58-IMPL-C: the second pet window's identity is its LABEL
      // ('pet-codex') — an infrastructure identity that never changes —
      // while its semantic provider (session partition, wander target) is
      // resolved from config.duoProvider. Identity ≠ provider.
      const api = global.__TAURI__ && global.__TAURI__.window;
      const current = api && typeof api.getCurrentWindow === 'function' ? api.getCurrentWindow() : null;
      if (current && current.label === 'pet-codex') return 'pet-codex';
      if (current && current.label === 'pet') return defaultAgent();
      // No window API (tests / non-Tauri shells): the URL query is the
      // identity source; the legacy ?agent=codex deep link still maps to the
      // second pet.
      const fromQuery = new URLSearchParams(global.location.search).get('agent');
      if (fromQuery === 'codex') return 'pet-codex';
      if (fromQuery && fromQuery !== 'codex') return fromQuery;
    } catch (_) {}
    return defaultAgent();
  }

  function eventBelongs(event, petMode, agent) {
    if (!event || typeof event !== 'object') return false;
    // R58-IMPL-C: travel lifecycle events carry the trip's OWNER (initiating
    // window label). Routing by owner keeps completed/failed/cancelled
    // feedback on the initiator even when the backend degraded the trip's
    // provider to the OTHER pet's pairing (research defect B).
    if (petMode === 'duo' && event.trip && typeof event.trip.owner === 'string') {
      const ownOwner = agent === 'pet-codex' ? 'pet-codex' : 'pet';
      return event.trip.owner === ownOwner;
    }
    const provider = event.provider || (event.trip && event.trip.provider);
    if (petMode !== 'duo') return true;
    if (!provider) return true;
    // P4-1 fix (R1): in duo mode, the primary pet is the AGGREGATE bucket —
    // it owns every event that is NOT the second pet's paired provider. The
    // second pet (window identity 'pet-codex') owns only its paired
    // provider's events. R58-IMPL-C: the split is config-driven
    // (config.duoProvider) instead of the hardcoded codex literal.
    const duo = duoProvider();
    if (agent === 'pet-codex') return provider === duo;
    return provider !== duo;
  }

  function filterStats(snapshot, petMode, agent) {
    if (!snapshot || petMode !== 'duo') return snapshot;
    // P4-1 fix (R1): partition sessions the same way as eventBelongs —
    // R58-IMPL-C: the paired provider (config.duoProvider) decides the split.
    const duo = duoProvider();
    const sessions = (snapshot.sessions || []).filter((row) => {
      const pid = row.providerId || 'claude';
      if (agent === 'pet-codex') return pid === duo;
      return pid !== duo;
    });
    const count = (state) => sessions.filter((row) => row.state === state).length;
    // 后端已经按状态优先级与活跃度排序；双宠只做 provider 投影，不重排。
    const latest = sessions[0] || null;
    const todoSession = sessions.find((row) => Array.isArray(row.todos) && row.todos.length) || null;
    // P4-12 fix (R1): compute idleMs as the MOST RECENT activity across the
    // filtered set (min idle), not the first sorted session's idle. This
    // matches the backend's aggregate semantics and prevents the pet from
    // sleeping when a stale high-priority session sorts above an active one.
    const idleMs = sessions.length
      ? Math.min(...sessions.map((row) => Number(row.idleMs) || Infinity))
      : null;
    // P4-4 fix (R1): re-derive today/window5h cost from the filtered sessions
    // so each pet shows only ITS slice, not the aggregate total. The backend
    // exposes per-session usage via row.today (tokens/cost/messages) and
    // row.window5h when available; fall back to the aggregate if a session
    // lacks the breakdown (older stats payloads).
    let todayCost = 0;
    let windowCost = 0;
    let todayTokens = 0;
    let windowTokens = 0;
    for (const row of sessions) {
      const t = row.today || {};
      const w = row.window5h || {};
      todayCost += Number(t.cost) || 0;
      windowCost += Number(w.cost) || 0;
      todayTokens += Number(t.tokens) || 0;
      windowTokens += Number(w.tokens) || 0;
    }
    const today = snapshot.today
      ? { ...snapshot.today, cost: todayCost, tokens: todayTokens }
      : { cost: todayCost, tokens: todayTokens };
    const window5h = snapshot.window5h
      ? { ...snapshot.window5h, cost: windowCost, tokens: windowTokens }
      : { cost: windowCost, tokens: windowTokens };
    // P4-10 fix (R1): strip codex-specific rollout fields from the primary
    // pet (and vice-versa) so each pet shows only its own usage/limits.
    // R58-IMPL-C: the window identity decides — only the second pet window
    // keeps the codex rollout surfaces (they exist when the pairing IS
    // codex; other pairings simply have no such sessions).
    const result = {
      ...snapshot,
      sessions,
      active: latest ? {
        sessionId: latest.sessionId,
        project: latest.project,
        state: latest.state,
        model: latest.model,
        providerId: latest.providerId || 'claude',
        todos: latest.todos || [],
      } : null,
      waitingCount: count('waiting'),
      needsinputCount: count('needsinput') + count('notification'),
      workingCount: count('working'),
      jugglingCount: count('juggling'),
      sweepingCount: count('sweeping'),
      thinkingCount: count('thinking'),
      loafingCount: count('loafing'),
      errorCount: count('error'),
      attentionCount: count('attention'), // fix: 漏覆盖会让 duo 双宠继承全局 attentionCount，跨 agent 状态污染
      todos: todoSession ? todoSession.todos : [],
      todosProject: todoSession ? todoSession.project : '',
      idleMs: idleMs === Infinity ? null : idleMs,
      today,
      window5h,
    };
    if (agent !== 'pet-codex') {
      delete result.codexUsage;
      delete result.codexLimits;
    } else {
      // second pet: clear the aggregate usage fields that belong to the
      // primary pet (they were already overridden above with its slice, but
      // be explicit)
    }
    return result;
  }

  global.OctoPetAgentView = Object.freeze({ currentAgent, eventBelongs, filterStats, setDuoProvider, duoProvider });
})(window);
