'use strict';

(function installPetAgentView(global) {
  function currentAgent() {
    try {
      return new URLSearchParams(global.location.search).get('agent') === 'codex'
        ? 'codex'
        : 'claude';
    } catch (_) {
      return 'claude';
    }
  }

  function eventBelongs(event, petMode, agent) {
    if (!event || typeof event !== 'object') return false;
    const provider = event.provider || (event.trip && event.trip.provider);
    if (petMode !== 'duo') return true;
    if (!provider) return true;
    // P4-1 fix (R1): in duo mode, the 'claude' pet is the AGGREGATE bucket —
    // it owns every event that is NOT codex (claude, codewhale, opencode,
    // and any future provider). The 'codex' pet owns only codex
    // events. Previously codewhale/opencode events matched neither pet
    // and were silently dropped in duo mode, making those providers appear
    // "dead" until the user switched back to single mode.
    if (agent === 'codex') return provider === 'codex';
    return provider !== 'codex';
  }

  function filterStats(snapshot, petMode, agent) {
    if (!snapshot || petMode !== 'duo') return snapshot;
    // P4-1 fix (R1): partition sessions the same way as eventBelongs —
    // claude pet gets every non-codex session, codex pet gets only codex.
    const sessions = (snapshot.sessions || []).filter((row) => {
      const pid = row.providerId || 'claude';
      if (agent === 'codex') return pid === 'codex';
      return pid !== 'codex';
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
    // P4-10 fix (R1): strip codex-specific rollout fields from the claude pet
    // (and vice-versa) so each pet shows only its own usage/limits.
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
      // v0.5.71: transcript-detected flags (ESC interrupt + API error)
      interruptedCount: sessions.filter((s) => s.interrupted).length,
      apiErrorCount: sessions.filter((s) => s.api_error).length,
      todos: todoSession ? todoSession.todos : [],
      todosProject: todoSession ? todoSession.project : '',
      idleMs: idleMs === Infinity ? null : idleMs,
      today,
      window5h,
    };
    if (agent !== 'codex') {
      delete result.codexUsage;
      delete result.codexLimits;
    } else {
      // codex pet: clear the aggregate usage fields that belong to claude pet
      // (they were already overridden above with the codex slice, but be explicit)
    }
    return result;
  }

  global.OctoPetAgentView = Object.freeze({ currentAgent, eventBelongs, filterStats });
})(window);
