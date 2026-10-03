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

  // R59 (regression fix): the second-pet window aligns its OWN URL query with
  // config.duoProvider. The query is a secondary identity source (the window
  // label is authoritative — see currentAgent); the old Rust-side
  // `window.eval(location.replace(...))` ran during the startup setup before
  // the pet-codex webview finished loading its initial document, so the
  // navigation could be dropped and its process-global guard meant it was
  // never retried (transparency flash / "window doesn't appear" frames — the
  // second half of the 0.6.7 "secondary pet swallowed" regression). Running
  // the check from inside the page means the document is loaded by
  // construction; it is a no-op whenever the query already matches.
  // R60 P1-2: the replacement boot used to replay every one-shot boot
  // artifact (pet-appear entrance animation, online bubble, greet sound).
  // sessionStorage survives location.replace in the same tab, so we set a
  // pending flag the replacement document consumes exactly once to suppress
  // those artifacts (pet.js boot reads it).
  function syncDuoQuery(cfg) {
    const agent = currentAgent();
    if (agent !== 'pet-codex') return;
    const desired = cfg && typeof cfg.duoProvider === 'string' && cfg.duoProvider ? cfg.duoProvider : 'codex';
    const current = new URLSearchParams(global.location.search).get('agent') || 'codex';
    if (current !== desired) {
      try { global.sessionStorage.setItem('octo-duo-replace-pending', '1'); } catch (_) {}
      const query = desired === 'codex' ? '' : `?agent=${encodeURIComponent(desired)}`;
      global.location.replace(`/renderer/pet.html${query}`);
    }
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
    const eventOwner = event.owner || (event.trip && event.trip.owner);
    if (petMode === 'duo' && typeof eventOwner === 'string') {
      const ownOwner = agent === 'pet-codex' ? 'pet-codex' : 'pet';
      return eventOwner === ownOwner;
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
    let haveBreakdown = false;
    for (const row of sessions) {
      const t = row.today || {};
      const w = row.window5h || {};
      if (row.today || row.window5h) haveBreakdown = true;
      todayCost += Number(t.cost) || 0;
      windowCost += Number(w.cost) || 0;
      todayTokens += Number(t.tokens) || 0;
      windowTokens += Number(w.tokens) || 0;
    }
    // R58-RV-9 P2: the backend never emits per-session today/window5h
    // breakdowns (row.today/row.window5h have no producer since 0.6.0), so
    // `haveBreakdown` is false and the per-pet cost chips would ALWAYS show
    // $0.00 in duo mode. When no row carries a breakdown, keep the
    // aggregate cost/tokens instead of overwriting them with the sum of
    // nothing — the slice is the aggregate until the backend grows the
    // per-session breakdown.
    const today = snapshot.today
      ? { ...snapshot.today, cost: haveBreakdown ? todayCost : (Number(snapshot.today.cost) || 0), tokens: haveBreakdown ? todayTokens : (Number(snapshot.today.tokens) || 0) }
      : { cost: todayCost, tokens: todayTokens };
    const window5h = snapshot.window5h
      ? { ...snapshot.window5h, cost: haveBreakdown ? windowCost : (Number(snapshot.window5h.cost) || 0), tokens: haveBreakdown ? windowTokens : (Number(snapshot.window5h.tokens) || 0) }
      : { cost: windowCost, tokens: windowTokens };
    // P4-10 fix (R1): strip codex-specific rollout fields from the primary
    // pet (and vice-versa) so each pet shows only its own usage/limits.
    // R58-IMPL-C: the window identity decides — only the second pet window
    // keeps the codex rollout surfaces (they exist when the pairing IS
    // codex; other pairings simply have no such sessions).
    const result = {
      ...snapshot,
      sessions,
      // RV-I P1-2 (R60 review): pendingChoices were inherited unsliced via
      // the spread — a claude permission card (provider: Null upstream,
      // filled only for the waiting EVENT arm by R60-b F10) rendered on BOTH
      // pet windows in duo mode. Claude cards (provider null/'claude')
      // belong to the window that owns claude sessions: the paired window
      // when duoProvider === 'claude', else the aggregate window.
      pendingChoices: (snapshot.pendingChoices || []).filter((choice) => {
        if (petMode !== 'duo') return true;
        const cp = choice && choice.provider;
        const isClaude = cp == null || cp === 'claude';
        if (agent === 'pet-codex') return isClaude ? duo === 'claude' : cp === duo;
        return isClaude ? duo !== 'claude' : cp !== duo;
      }),
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

  global.OctoPetAgentView = Object.freeze({ currentAgent, eventBelongs, filterStats, setDuoProvider, duoProvider, syncDuoQuery });
})(window);
