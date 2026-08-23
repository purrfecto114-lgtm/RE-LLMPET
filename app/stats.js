'use strict';
// 统计聚合中枢：快照过滤 → adapter 组装 → 节流推送（R3 自 main.js 抽出）。
// deps 全部用 getter 注入：core 等管理器在 boot 阶段才赋值。
module.exports = function createStats(deps) {
  const {
    adapter,
    getCore, getMetering, getCodexMetering, getPermissions, getRuntimeMonitor,
    sendPet, sendPanel, sendArchive,
  } = deps;

  const recentOps = []; // ring for the panel "操作流"; newest first, capped
  let lastStats = null;
  let emitDebounce = null;

  function filterSnapshot(snap, agent) {
    if (agent === 'all') return snap;
    const sessions = (snap.sessions || []).filter((e) => adapter.agentOf(e) === agent);
    let active = null;
    for (const e of sessions) {
      if (e.headless) continue;
      if (!active || e.updatedAt > active.updatedAt) active = e;
    }
    return {
      sessions,
      active: active
        ? { sessionId: active.id, project: active.cwd, model: active.model, lastActivity: active.updatedAt }
        : null,
      idleMs: active ? active.idleMs : null,
      lastActivityTs: active ? active.updatedAt : 0,
      ts: snap.ts,
    };
  }

  function buildStats(snapshot = null) {
    const core = getCore();
    const rawSnapshot = snapshot || core.buildSnapshot();
    const snap = filterSnapshot(rawSnapshot, 'all');
    const metering = getMetering();
    const codexMetering = getCodexMetering();
    const permissions = getPermissions();
    const runtimeMonitor = getRuntimeMonitor();
    const meter = metering ? metering.getStats() : null;
    const codexUsage = codexMetering ? codexMetering.getStats() : null;
    const pending = permissions.getPending();
    const ops = recentOps.slice(0, 30);
    const stats = adapter.buildPetStats(snap, pending, meter, {
      lastOps: ops,
      codexUsage,
      // Shared pet/panel/archive must combine both ledgers. Mapping `all` to
      // `claude` made the headline omit Codex while the Codex detail card still
      // showed its own cost, producing contradictory totals in the real UI.
      usageProvider: 'all',
      runtime: runtimeMonitor ? runtimeMonitor.snapshot() : null,
    });
    return stats;
  }

  function petStats() {
    return buildStats(getCore().buildSnapshot());
  }

  // Record operation/say events into the ring the panel renders as the op stream.
  function recordOp(ev) {
    if (ev.kind === 'operation') {
      recentOps.unshift({ tool: ev.tool, icon: ev.icon, detail: ev.detail, file: ev.file || '', project: ev.project || '', agent: ev.agent || 'claude', ts: ev.ts });
    } else if (ev.kind === 'say') {
      recentOps.unshift({ tool: 'say', icon: '💬', detail: ev.text, file: '', project: ev.project || '', agent: ev.agent || 'claude', ts: ev.ts });
    } else return;
    if (recentOps.length > 50) recentOps.length = 50;
  }

  function emitStats() {
    const core = getCore();
    if (!core) return;
    lastStats = buildStats(core.buildSnapshot());
    sendPet('pet:stats', lastStats);
    sendPanel('panel:stats', lastStats);
    sendArchive('workbench:stats', lastStats);
  }

  function scheduleEmit() {
    if (emitDebounce) return;
    emitDebounce = setTimeout(() => { emitDebounce = null; emitStats(); }, 150);
  }

  return {
    filterSnapshot, buildStats, petStats, recordOp, emitStats, scheduleEmit,
    get lastStats() { return lastStats; },
    recentOps,
  };
};
