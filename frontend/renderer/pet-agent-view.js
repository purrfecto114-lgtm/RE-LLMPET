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
    const provider = event && (event.provider || (event.trip && event.trip.provider));
    return petMode !== 'duo' || !provider || provider === agent;
  }

  function filterStats(snapshot, petMode, agent) {
    if (!snapshot || petMode !== 'duo') return snapshot;
    const sessions = (snapshot.sessions || [])
      .filter((row) => (row.providerId || 'claude') === agent);
    const count = (state) => sessions.filter((row) => row.state === state).length;
    // 后端已经按状态优先级与活跃度排序；双宠只做 provider 投影，不重排。
    const latest = sessions[0] || null;
    const todoSession = sessions.find((row) => Array.isArray(row.todos) && row.todos.length) || null;
    return {
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
      todos: todoSession ? todoSession.todos : [],
      todosProject: todoSession ? todoSession.project : '',
      idleMs: latest ? latest.idleMs : null,
    };
  }

  global.OctoPetAgentView = Object.freeze({ currentAgent, eventBelongs, filterStats });
})(window);
