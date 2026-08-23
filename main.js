'use strict';

// LLMPET — Electron main process.
//
// Boot order: core (session state) → metering (cost) → permissions → HTTP
// server → install Claude Code hooks (using the bound port) → start watcher.
// Wiring: core/permission activity → adapter → pet:event / pet:stats pushed to
// the renderer over the preload IPC contract.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, shell, dialog, systemPreferences, clipboard } = require('electron');

// Give the dev app the public LLMPET identity so it isn't shown as a generic
// "Electron" window and can never be confused with the abandoned "Claude小章鱼" build.
try { app.setName('LLMPET'); } catch {}
try { app.setAppUserModelId('com.octopus.pet'); } catch {}

const config = require('./backend/config');
const { log, LOG_PATH } = require('./backend/log');
const { createCore } = require('./backend/core');
const { createMetering } = require('./backend/metering');
const { createPricingSync } = require('./backend/pricing-sync');
const { createPermissions } = require('./backend/permission');
const { createServer } = require('./backend/server');
const adapter = require('./backend/adapter');
const hooks = require('./backend/hooks');
const { focusSession } = require('./backend/focus');
const { launchClaude, launchCodex, launchDsh, ensureDshWeb, launchExecutable, findCli } = require('./backend/launch');
const { createAgentStartup } = require('./backend/agent-startup');
const { createCodexWatch } = require('./backend/codex-watch');
const { createDshWatch } = require('./backend/dsh-watch');
const { createCodexMetering } = require('./backend/codex-metering');
const { createSessionTakeover } = require('./backend/session-handoff');
const { createSessionArchive } = require('./backend/session-archive');
const { createProgramRegistry } = require('./backend/program-registry');
const { createProgramSkillManager } = require('./backend/program-skill');
const { createRuntimeMonitor } = require('./backend/runtime-monitor');
const transport = require('./backend/transport');
const i18n = require('./shared/i18n');

const t = i18n.t;
// Main-process strings (tray, dialogs, adapter-built labels) are localized at
// build time, so the language must be live before the first menu or event.
i18n.setLang(config.get().lang);

const PRELOAD = path.join(__dirname, 'preload.js');
const APP_DIR = __dirname;
const BASE_W = 320, BASE_H = 340, TALL_H = 560, BIG_W = 440, BIG_H = 600;
// `dsh web` 的默认落点（apps/web 的 webserver 行：127.0.0.1:3080）。
// 用户改过端口就用 LLMPET_DSH_WEB 覆盖。
const DSH_WEB_URL = process.env.LLMPET_DSH_WEB || 'http://127.0.0.1:3080';

const S = { petWin: null, panelWin: null, archiveWin: null, panelH: 0 };
let tray = null;
let core = null;
let metering = null;
let pricingSync = null;
let permissions = null;
let server = null;
let stopWatcher = null;
let codexWatch = null;  // Codex rollout 只读监听器
let codexMetering = null; // Codex rollout 累计 token 台账（与状态 watcher 解耦）
let dshWatch = null;    // DeepSeek Harness 会话日志只读监听器
let sessionTakeover = null;
let sessionArchive = null;
let programRegistry = null;
let programSkillManager = null;
let runtimeMonitor = null;
let agentStartup = null;
// 每个宠物窗口自己的交互状态（webContents.id → 状态）。双宠模式下气泡定高、
// 命中穿透、visualRect、「用户交互中」都是各管各的，混用会互相打架。
const petState = new Map(); // id → { agent, win, customSize, visualRect, uiBusy }
const petStates = () => [...petState.values()].filter((s) => s.win && !s.win.isDestroyed());
const stateOfSender = (sender) => petState.get(sender.id) || null;
const primaryPetState = () => (S.petWin && !S.petWin.isDestroyed() ? petState.get(S.petWin.webContents.id) : null);
const anyUiBusy = () => petStates().some((s) => s.uiBusy);
const primaryVisualRect = () => { const st = primaryPetState(); return st ? st.visualRect : null; };

let statsTimer = null;

// ── frontend config shape ─────────────────────────────────────────────────────
function frontendConfig() {
  const c = config.get();
  return {
    mode: c.mode,
    skin: c.skin,
    petPosition: c.petPosition,
    muted: c.muted,
    permHook: c.permHook,
    lang: c.lang,
    pinnedSessions: c.pinnedSessions,
    archivedSessions: c.archivedSessions,
    sessionArchive: c.sessionArchive,
  };
}

// ── window geometry ───────────────────────────────────────────────────────────
// customSize is set by the renderer to fit an open popup exactly (dynamic
// height), so a 1-row session list doesn't blow the window up to a fixed 600px.
function targetSize(st) {
  const cs = st && st.customSize;
  if (cs) {
    return { w: Math.min(900, Math.max(BASE_W, cs.w)), h: Math.max(BASE_H, cs.h) };
  }
  return { w: BASE_W, h: BASE_H };
}

function validPetAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return null;
  const numeric = ['screenX', 'screenY', 'width', 'height', 'xOffset', 'yOffset'];
  if (!numeric.every((key) => Number.isFinite(anchor[key]))) return null;
  if (!(anchor.width > 0) || !(anchor.height > 0)) return null;
  if (!['left', 'center', 'right'].includes(anchor.xAlign)) return null;
  if (!['top', 'bottom'].includes(anchor.yAlign)) return null;
  return anchor;
}

function anchoredPetOrigin(anchor, width, height) {
  let localX;
  if (anchor.xAlign === 'left') localX = anchor.xOffset;
  else if (anchor.xAlign === 'right') localX = width - anchor.xOffset - anchor.width;
  else localX = width / 2 + anchor.xOffset - anchor.width / 2;

  const localY = anchor.yAlign === 'top'
    ? anchor.yOffset
    : height - anchor.yOffset - anchor.height;
  return {
    x: Math.round(anchor.screenX - localX),
    y: Math.round(anchor.screenY - localY),
  };
}

function applyPetSize(st, requestedAnchor) {
  if (!st || !st.win || st.win.isDestroyed()) return;
  const win = st.win;
  const { w } = targetSize(st);
  let { h } = targetSize(st);
  const b = win.getBounds();
  // Cap the window to the screen's work area so a tall popup can NEVER push the
  // pet / footer buttons off-screen — the popup scrolls internally instead.
  try {
    const wa = screen.getDisplayMatching(b).workArea;
    const width = Math.min(w, wa.width);
    h = Math.min(h, wa.height);
    const anchor = validPetAnchor(requestedAnchor);
    const anchored = anchor ? anchoredPetOrigin(anchor, width, h) : null;
    const cx = b.x + b.width / 2;
    const bottom = b.y + b.height;
    let x = anchored ? anchored.x : Math.round(cx - width / 2);
    let y = anchored ? anchored.y : Math.round(bottom - h);
    x = Math.min(Math.max(x, wa.x), wa.x + wa.width - width);
    y = Math.min(Math.max(y, wa.y), wa.y + wa.height - h);
    win.setBounds({ x, y, width, height: h });
  } catch {
    const anchor = validPetAnchor(requestedAnchor);
    const anchored = anchor ? anchoredPetOrigin(anchor, w, h) : null;
    const bottom = b.y + b.height;
    win.setBounds({ x: anchored ? anchored.x : b.x, y: anchored ? anchored.y : Math.round(bottom - h), width: w, height: h });
  }
}

// ── push helpers ──────────────────────────────────────────────────────────────
function sendWin(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
// 任一存活的宠物窗口：主宠被单独收起后，授权卡等重要消息兜底投递到还活着的那只
function firstAlivePetWin() {
  return S.petWin && !S.petWin.isDestroyed() ? S.petWin : null;
}
// sendPet = 发给主宠；主宠不在则兜底
function sendPet(channel, payload) { sendWin(firstAlivePetWin(), channel, payload); }
function sendPanel(channel, payload) { sendWin(S.panelWin, channel, payload); }
function sendArchive(channel, payload) { sendWin(S.archiveWin, channel, payload); }

function sendPetEvent(ev) {
  sendPet('pet:event', ev);
}

const statsHub = require('./app/stats')({
  adapter,
  getCore: () => core,
  getMetering: () => metering,
  getCodexMetering: () => codexMetering,
  getPermissions: () => permissions,
  getRuntimeMonitor: () => runtimeMonitor,
  sendPet, sendPanel, sendArchive,
});
const { filterSnapshot, buildStats, petStats, recordOp, emitStats, scheduleEmit } = statsHub;

const windows = require('./app/windows')({
  BrowserWindow, screen, nativeImage, app,
  config, log, path, PRELOAD, APP_DIR, BASE_W, BASE_H,
  petState,
  core: () => core, metering: () => metering, sessionArchive: () => sessionArchive,
  frontendConfig, statsHub,
  sendWin, sendPanel,
  S,
});
const { hardenWindow, createPetWindows, openPanel, closePanel, openArchive, closeArchive } = windows;


function broadcastConfig() {
  sendPet('pet:config', frontendConfig());
  sendPanel('panel:config', frontendConfig());
}

// ── backend wiring ────────────────────────────────────────────────────────────
function bootBackend() {
  core = createCore({
    onActivity: (act) => {
      for (const ev of adapter.activityToEvents(act)) { recordOp(ev); sendPetEvent(ev); }
    },
    onDirty: scheduleEmit,
  });
  core.startStaleCleanup();
  sessionTakeover = createSessionTakeover();
  sessionArchive = createSessionArchive({
    getSettings: () => config.get().sessionArchive,
    onChange: (event) => sendArchive('archive:changed', event),
    // Keep archive discovery on the same injected root as the live watcher in
    // development/E2E; production still defaults to $DSH_HOME|~/.dsh/sessions.
    dshRoot: process.env.LLMPET_DSH_DIR || undefined,
  });
  sessionArchive.start().catch((e) => log('archive', 'startup scan failed:', e.message));
  // Read-only until the user grants one provider from the Launcher page.
  // Starting LLMPET must never silently write into an agent's user skill tree.
  programSkillManager = createProgramSkillManager();
  programRegistry = createProgramRegistry({
    statePath: process.env.LLMPET_PROGRAM_REGISTRY || undefined,
    onChange: (event) => sendArchive('programs:changed', event),
    openPath: (target) => shell.openPath(target),
    revealPath: (target) => shell.showItemInFolder(target),
    launchCommand: (record) => launchExecutable(record.launch.command, {
      cwd: record.cwd,
      args: record.launch.args,
      keepOpen: true,
      terminalTitle: `LLMPET · ${record.name}`,
    }),
  });
  programRegistry.start();
  runtimeMonitor = createRuntimeMonitor({
    selfPid: process.pid,
    onChange: () => scheduleEmit(),
  });
  runtimeMonitor.start();

  // Codex 后端：只读监听 ~/.codex/sessions 的 rollout（无钩子、零侵入）。
  // LLMPET_NO_CODEX=1 关闭（比如只想盯 Claude 的机器）。
  if (process.env.LLMPET_NO_CODEX === '1') {
    log('main', 'LLMPET_NO_CODEX=1 — Codex watcher disabled');
  } else {
    codexMetering = createCodexMetering({
      sessionsDir: process.env.LLMPET_CODEX_DIR || undefined,
      onChange: scheduleEmit,
    });
    codexMetering.start(30000);
    codexWatch = createCodexWatch({
      core,
      // 开发/E2E 可用 LLMPET_CODEX_DIR 指到假目录，不碰真实 ~/.codex
      sessionsDir: process.env.LLMPET_CODEX_DIR || undefined,
    });
    codexWatch.start();
  }

  // DeepSeek Harness 后端：只读监听 $DSH_HOME|~/.dsh/sessions 的会话日志
  // （同样无钩子、零侵入；不装 dsh 的机器上 watcher 只是空转）。
  // LLMPET_NO_DSH=1 关闭；LLMPET_DSH_DIR 可指到假目录做开发/E2E。
  if (process.env.LLMPET_NO_DSH === '1') {
    log('main', 'LLMPET_NO_DSH=1 — dsh watcher disabled');
  } else {
    dshWatch = createDshWatch({
      core,
      sessionsDir: process.env.LLMPET_DSH_DIR || undefined,
    });
    dshWatch.start();
  }

  metering = createMetering();
  metering.start(30000);

  // Pricing sync: fetches LiteLLM's open pricing JSON once on boot + every 24h.
  // metering.loadPricing() now reads ~/.octopus/pricing-cache.json beneath the
  // user override. Public-data only — no credentials, no API calls.
  // On a fresh sync: reload the in-memory price table (so new prices apply this
  // run, not next restart) and push the updated source line to the panel.
  // OCTOPUS_NO_NET=1 keeps the app fully offline (the pricing fetch is the ONLY
  // outbound request LLMPET ever makes) — falls back to the built-in price table.
  if (process.env.OCTOPUS_NO_NET === '1') {
    log('main', 'OCTOPUS_NO_NET=1 — pricing sync disabled (fully offline)');
  } else {
    pricingSync = createPricingSync({
      onUpdate: () => {
        if (metering) { try { metering.reloadPricing(); } catch {} }
        // Codex reprices from its own per-model token ledger — without this the
        // Codex half of the panel would keep the boot-time (built-in) rates.
        if (codexMetering) { try { codexMetering.reloadPricing(); } catch {} }
        if (metering) {
          const priceInfo = metering.priceInfo();
          sendPanel('panel:price', priceInfo);
          sendArchive('workbench:price', priceInfo);
        }
        scheduleEmit();
      },
    });
    pricingSync.start();
  }

  permissions = createPermissions({
    // muted only silences sound (renderer-side); it is NOT do-not-disturb.
    // Travel requests intentionally remain here: their dedicated conversation
    // is a normal pet card and renders a stable "travel letter" approval.
    shouldDrop: () => false,
    onAdded: (entry) => {
      let lite = (() => { const s = core.getSession(entry.sessionId); return s ? toEntryLite(s) : null; })();
      let choice, kind, reason;
      if (entry.isElicitation) {
        choice = adapter.buildElicitationChoice(
          { id: entry.id, sessionId: entry.sessionId, questions: entry.questions }, lite);
        kind = 'needsinput'; reason = 'reply';
      } else if (entry.toolName === 'ExitPlanMode') {
        choice = adapter.buildPlanChoice(
          { id: entry.id, sessionId: entry.sessionId, toolInput: entry.toolInput }, lite);
        kind = 'needsinput'; reason = 'plan';
      } else {
        choice = adapter.buildPermChoice(
          {
            id: entry.id,
            sessionId: entry.sessionId,
            toolName: entry.toolName,
            toolInput: entry.toolInput,
            suggestions: entry.suggestions,
          },
          lite,
        );
        kind = 'waiting'; reason = 'perm';
      }
      // A parked permission needs the user's eyes. In menubar mode (or if the pet
      // was hidden) the ask panel would render into an invisible window and CC
      // would hang until the park times out — so surface the pet window first.
      try { const w = firstAlivePetWin(); if (w && !w.isVisible()) w.show(); } catch {}
      sendPetEvent({ kind, project: choice.project, reason, sessionId: entry.sessionId, choice, agent: 'claude', ts: Date.now() });
      scheduleEmit();
    },
    onChange: scheduleEmit,
  });

  server = createServer({
    core,
    permissions,
    shouldDropForDnd: () => false,
  });
  server.start();

  // Install hooks once the server has a port (defer so listen wins the race).
  // OCTOPUS_NO_HOOKS=1 skips touching ~/.claude/settings.json (dev/verify mode).
  setTimeout(() => {
    if (process.env.OCTOPUS_NO_HOOKS === '1') {
      log('main', 'OCTOPUS_NO_HOOKS=1 — skipping Claude Code hook install');
      return;
    }
    const port = server.getPort();
    if (port) {
      hooks.install(port, server.getToken());
      stopWatcher = hooks.startWatcher(() => ({ port: server.getPort(), token: server.getToken() }));
    } else {
      log('main', 'server has no port — hooks not installed (ports busy?)');
    }
  }, 400);

  // Periodic refresh so idle→sleeping transitions + cost updates reach the UI.
  statsTimer = setInterval(emitStats, 4000);
  if (statsTimer.unref) statsTimer.unref();
}

// minimal entry shape for adapter.projectName()
function toEntryLite(s) {
  return {
    id: s.id,
    cwd: s.cwd,
    sessionTitle: s.sessionTitle,
    agentId: s.agentId,
    sessionRole: s.sessionRole,
    travelAgent: s.travelAgent,
  };
}

// ── IPC ───────────────────────────────────────────────────────────────────────
// 宠物窗口的 IPC 都按「发送方是哪个窗口」定位（双宠模式两只宠各管各的窗口）；
// 面板等非宠物发送方回落到主宠。
function registerIpc() {
  const senderAgent = (e) => { const st = stateOfSender(e.sender); return st ? st.agent : 'all'; };
  const senderPetWin = (e) => {
    const st = stateOfSender(e.sender);
    if (st && st.win && !st.win.isDestroyed()) return st.win;
    return S.petWin && !S.petWin.isDestroyed() ? S.petWin : null;
  };

  ipcMain.handle('get-config', (e) => frontendConfig());
  ipcMain.handle('get-stats', () => buildStats());
  ipcMain.handle('get-win-pos', (e) => {
    const win = senderPetWin(e);
    if (!win) return [0, 0];
    const b = win.getBounds();
    return [b.x, b.y];
  });
  ipcMain.handle('get-window-metrics', (e) => {
    const win = senderPetWin(e);
    if (!win) return null;
    const windowBounds = win.getBounds();
    let workArea = null;
    try { workArea = screen.getDisplayMatching(windowBounds).workArea; } catch {}
    return { window: windowBounds, workArea };
  });

  ipcMain.on('set-win-pos', (e, x, y) => {
    const win = senderPetWin(e);
    if (win && Number.isFinite(x) && Number.isFinite(y)) {
      const b = win.getBounds();
      win.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height });
    }
  });

  ipcMain.on('open-panel', openPanel);
  ipcMain.on('close-panel', closePanel);
  ipcMain.on('open-session-archive', openArchive);
  ipcMain.on('close-session-archive', closeArchive);
  ipcMain.handle('session-archive-list', async (_e, query) => {
    if (!sessionArchive) return { sessions: [], total: 0, page: 1, pageSize: 100, summary: null };
    const archiveSummary = sessionArchive.summary();
    if (!archiveSummary.lastScanAt || Date.now() - archiveSummary.lastScanAt > 30000) {
      await sessionArchive.refresh();
    }
    const activeIds = core ? [...core.sessions.keys()] : [];
    return sessionArchive.list({ ...(query || {}), activeIds });
  });
  ipcMain.handle('session-archive-settings', async (_e, partial) => {
    const current = config.get().sessionArchive || {};
    const next = {
      backupEnabled: partial && partial.backupEnabled !== undefined
        ? partial.backupEnabled === true : current.backupEnabled === true,
      backupIntervalHours: partial && partial.backupIntervalHours !== undefined
        ? Number(partial.backupIntervalHours) : current.backupIntervalHours,
    };
    config.save({ sessionArchive: next });
    if (sessionArchive) {
      if (next.backupEnabled && !current.backupEnabled) {
        sessionArchive.backupNow()
          .catch((e) => log('archive', 'initial backup failed:', e.message))
          .finally(() => sessionArchive.schedule());
      } else sessionArchive.schedule();
    }
    return config.get().sessionArchive;
  });
  ipcMain.handle('session-archive-backup-now', async () => {
    if (!sessionArchive) return { ok: false, code: 'not-ready' };
    return sessionArchive.backupNow();
  });
  ipcMain.handle('session-archive-resume', async (_e, key, targetAgent) => {
    if (!sessionArchive || !sessionTakeover) return { ok: false, code: 'not-ready' };
    const archived = sessionArchive.get(key);
    const target = targetAgent === 'codex' ? 'codex' : targetAgent === 'claude' ? 'claude' : '';
    if (!archived || !archived.sourceAvailable) return { ok: false, code: 'source-missing' };
    if (!target) return { ok: false, code: 'invalid-provider' };
    const session = {
      id: archived.id,
      agentId: archived.provider,
      cwd: archived.cwd,
      transcriptPath: archived.sourcePath,
      sessionTitle: archived.title,
      state: 'idle',
      sourcePid: null,
      headless: false,
    };
    const result = await sessionTakeover.takeOver(session, target, { locale: i18n.getLang() });
    log('archive', `resume ${archived.key} → ${target} ok=${!!result.ok} code=${result.code || '-'}`);
    return result;
  });
  ipcMain.handle('session-archive-restore', async (_e, key) => {
    if (!sessionArchive) return { ok: false, code: 'not-ready' };
    const result = await sessionArchive.restore(key);
    log('archive', `restore ${String(key || '')} ok=${!!result.ok} code=${result.code || '-'}`);
    return result;
  });
  ipcMain.handle('session-archive-reveal', async (_e, key) => {
    if (!sessionArchive) return false;
    const archived = sessionArchive.get(key);
    const target = archived && (archived.sourceAvailable ? archived.sourcePath : archived.backupPath);
    if (!target) return false;
    shell.showItemInFolder(target);
    return true;
  });
  ipcMain.on('session-archive-open-backup', () => {
    if (!sessionArchive) return;
    try { fs.mkdirSync(sessionArchive.backupRoot, { recursive: true, mode: 0o700 }); }
    catch (e) { log('archive', 'create backup folder failed:', e.message); return; }
    shell.openPath(sessionArchive.backupRoot)
      .then((error) => { if (error) log('archive', 'open backup folder failed:', error); });
  });
  ipcMain.handle('generated-programs-list', () => programRegistry ? programRegistry.list() : []);
  ipcMain.handle('generated-program-launch', async (_e, id) => {
    const result = programRegistry ? await programRegistry.launch(id) : { ok: false, code: 'not-ready' };
    log('programs', `launch ${String(id || '')} ok=${!!result.ok} code=${result.code || '-'}`);
    return result;
  });
  ipcMain.handle('generated-program-reveal', (_e, id) => programRegistry ? programRegistry.reveal(id) : false);
  ipcMain.handle('generated-program-remove', (_e, id) => programRegistry ? programRegistry.remove(id) : false);
  ipcMain.handle('program-skills-status', () => programSkillManager ? programSkillManager.status() : []);
  ipcMain.handle('program-skill-install', (_e, provider) => {
    try {
      const result = programSkillManager ? programSkillManager.install(provider) : { ok: false, code: 'not-ready' };
      log('programs', `skill install provider=${String(provider || '')} ok=${!!result.ok} code=${result.code || '-'}`);
      sendArchive('program-skills:changed', programSkillManager ? programSkillManager.status() : []);
      return result;
    } catch (error) {
      log('programs', `skill install provider=${String(provider || '')} failed:`, error.message);
      return { ok: false, code: 'install-failed', message: error.message };
    }
  });
  ipcMain.handle('program-skill-remove', (_e, provider) => {
    try {
      const result = programSkillManager ? programSkillManager.remove(provider) : { ok: false, code: 'not-ready' };
      log('programs', `skill remove provider=${String(provider || '')} ok=${!!result.ok} code=${result.code || '-'}`);
      sendArchive('program-skills:changed', programSkillManager ? programSkillManager.status() : []);
      return result;
    } catch (error) {
      log('programs', `skill remove provider=${String(provider || '')} failed:`, error.message);
      return { ok: false, code: 'remove-failed', message: error.message };
    }
  });

  // 详情面板按内容高度自适应：clamp 到屏幕工作区，阈值防抖避免每次 stats 都抖
  ipcMain.on('set-panel-height', (_e, h) => {
    if (!S.panelWin || S.panelWin.isDestroyed() || !Number.isFinite(h)) return;
    const b = S.panelWin.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const clamped = Math.max(320, Math.min(Math.round(h), wa.height - 24));
    if (Math.abs(clamped - S.panelH) < 6) return;
    S.panelH = clamped;
    S.panelWin.setBounds({ x: b.x, y: b.y, width: b.width, height: clamped });
  });

  ipcMain.on('set-mode', (_e, mode) => applyMode(mode));
  ipcMain.on('set-skin', (_e, skin) => { applySkin(skin); });
  ipcMain.on('toggle-mute', () => { config.save({ muted: !config.get().muted }); broadcastConfig(); refreshTrayMenu(); });
  ipcMain.on('set-session-prefs', (_e, pinnedSessions, archivedSessions) => {
    config.save({ pinnedSessions, archivedSessions });
    broadcastConfig();
  });

  ipcMain.on('quit-app', () => app.quit());

  ipcMain.on('launch-claude', () => {
    launchClaude({}).then((r) => {
      if (!r.ok) log('main', 'launch claude failed:', r.message);
    }).catch((e) => log('main', 'launch claude error:', e.message));
  });
  ipcMain.on('launch-codex', () => {
    launchCodex({}).then((r) => {
      if (!r.ok) log('main', 'launch codex failed:', r.message);
    }).catch((e) => log('main', 'launch codex error:', e.message));
  });
  // dsh 起的是本地 web 界面（默认 127.0.0.1:3080），终端窗口留着看日志
  ipcMain.on('launch-dsh', () => {
    launchDsh({}).then((r) => {
      if (!r.ok) log('main', 'launch dsh failed:', r.message);
    }).catch((e) => log('main', 'launch dsh error:', e.message));
  });

  ipcMain.on('permission-decide', (_e, permId, behavior) => {
    permissions.decide(permId, behavior);
  });
  ipcMain.on('focus-session', (_e, sessionId) => {
    const session = core.getSession(sessionId);
    // Codex rollout 没有终端 pid；Desktop 会话必须通过官方
    // codex:// thread deep link 定位。否则“去 Codex 选择”按钮只会
    // 调用一个注定失败的 pid focus，看起来完全没反应。
    if (session && session.agentId === 'codex') {
      shell.openExternal(`codex://threads/${encodeURIComponent(session.id)}`)
        .catch((err) => log('main', 'open Codex thread failed:', err.message));
      return;
    }
    // dsh 同样没有可依赖的终端 pid。这里只能打开通用 Web 界面，不能精确
    // focus 某条历史会话；而 headless/TUI 进程也不等于 Web 已启动，所以先
    // 确认/补开 `dsh web` 并等 HTTP 就绪，再交给系统浏览器。
    if (session && session.agentId === 'dsh') {
      ensureDshWeb({ url: DSH_WEB_URL, terminalTitle: 'LLMPET · dsh' }).then((result) => {
        if (!result.ok) {
          log('main', `open dsh web failed: ${result.status || '-'} ${result.message || ''}`);
          return;
        }
        shell.openExternal(DSH_WEB_URL)
          .catch((err) => log('main', 'open dsh web failed:', err.message));
      }).catch((err) => log('main', 'ensure dsh web failed:', err.message));
      return;
    }
    focusSession(session);
  });
  // 面板复制会话 id（跨 session 协作：把 id 贴给另一个 agent 去 resume）。
  // 桌宠列表会在 watcher 释放后短暂保留掠夺/最近会话，所以不再强制要求
  // core.getSession() 当下仍然存在；只允许安全的 session-id 字符集。
  ipcMain.handle('copy-session-id', (_e, sessionId) => {
    const id = String(sessionId || '').trim();
    if (id.length < 8 || id.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(id)) return false;
    clipboard.writeText(id);
    return true;
  });
  ipcMain.handle('session-takeover', async (_e, sessionId, targetAgent) => {
    const id = typeof sessionId === 'string' ? sessionId : '';
    const target = targetAgent === 'codex' ? 'codex' : targetAgent === 'claude' ? 'claude' : '';
    const session = id && core ? core.getSession(id) : null;
    if (!sessionTakeover || !session || session.headless || session.sessionRole === 'travel') {
      return { ok: false, code: 'invalid-target' };
    }
    if (!target) return { ok: false, code: 'invalid-provider' };
    const result = await sessionTakeover.takeOver(session, target, { locale: i18n.getLang() });
    log(
      'takeover',
      `${String(session.id).slice(-8)} ${adapter.agentOf(session)}→${target} ` +
        `ok=${!!result.ok} mode=${result.mode || '-'} code=${result.code || '-'}`,
    );
    return result;
  });

  // Left-click primary action for the NON-pending case (pending is decided in
  // the renderer, which tracks what the user already answered). Backend owns
  // this because only it knows pid liveness / headless / platform:
  //   • a focusable session exists  → focus the most relevant one
  //   • sessions exist but none focusable (no pid / closed / non-mac) → open panel
  //   • no sessions at all → launch a fresh CLI
  ipcMain.on('primary-action', async () => {
    const all = core ? [...core.sessions.values()] : [];
    // 空场时唤起 Claude
    if (!all.length) {
      launchClaude({}).catch(() => {});
      return;
    }
    const focusables = all
      .filter((s) => !s.headless && s.sourcePid)
      .sort((a, b) => {
        const sa = a.state === 'sleeping' ? 1 : 0;
        const sb = b.state === 'sleeping' ? 1 : 0;
        if (sa !== sb) return sa - sb;            // awake sessions first
        return (b.updatedAt || 0) - (a.updatedAt || 0); // then most recent
      });
    for (const s of focusables) {
      // eslint-disable-next-line no-await-in-loop
      if (await focusSession(s)) return;          // focused a real window → done
    }
    openPanel();                                  // have sessions but can't focus → panel
  });

  // Dynamic sizing: renderer measures the open popup and asks for an exact fit.
  // w/h <= 0 resets to the base pet size.
  ipcMain.on('set-pet-size', (e, w, h, anchor) => {
    const st = stateOfSender(e.sender) || primaryPetState();
    if (!st) return;
    st.customSize = (Number(w) > 0 && Number(h) > 0) ? { w: Number(w), h: Number(h) } : null;
    applyPetSize(st, anchor);
  });
  // Back-compat coarse toggles (renderer now prefers set-pet-size).
  ipcMain.on('pet-tall', (e, on) => {
    const st = stateOfSender(e.sender) || primaryPetState();
    if (!st) return;
    st.customSize = on ? { w: BASE_W, h: TALL_H } : null;
    applyPetSize(st);
  });
  ipcMain.on('pet-big', (e, on) => {
    const st = stateOfSender(e.sender) || primaryPetState();
    if (!st) return;
    st.customSize = on ? { w: BIG_W, h: BIG_H } : null;
    applyPetSize(st);
  });
  ipcMain.on('pet-focus', (e) => { const w = senderPetWin(e); if (w) { w.setFocusable(true); w.focus(); } });
  ipcMain.on('pet-blur', (e) => { const w = senderPetWin(e); if (w) { w.blur(); } });

  // Click-through: the renderer hit-tests the cursor and toggles this so the
  // transparent parts of the pet window let clicks reach apps behind it.
  // forward:true keeps mousemove flowing to the renderer while ignoring, so it
  // can re-enable clicks the moment the cursor returns to the pet/content.
  ipcMain.on('set-ignore-mouse', (e, ignore) => {
    const st = stateOfSender(e.sender);
    const w = st && st.win && !st.win.isDestroyed() ? st.win : null;
    if (!w) return;
    st.mouseIgnoring = !!ignore; // 记录 renderer 期望的穿透状态
    try { w.setIgnoreMouseEvents(!!ignore, { forward: true }); } catch {}
  });

  // 渲染端上报「用户正在交互」(领地模式据此避战/撤退,别的场景以后也能用)
  ipcMain.on('ui-busy', (e, on) => {
    const st = stateOfSender(e.sender);
    if (st) st.uiBusy = !!on;
  });
  ipcMain.on('pet-visual-bounds', (e, rect) => {
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return;
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    const st = stateOfSender(e.sender);
    if (!st) return;
    st.visualRect = {
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
    };
  });

  ipcMain.on('open-log', () => { shell.openPath(LOG_PATH); });
  ipcMain.on('pet-log', (_e, tag, msg) => { log('ui:' + String(tag || ''), String(msg || '')); });
}

// ── settings actions (shared by tray menu + panel IPC) ─────────────────────────
function applyMode(mode) {
  config.save({ mode });
  if (mode === 'panel') openPanel();
  else if (mode === 'pet') { for (const st of petStates()) st.win.show(); }
  else if (mode === 'menubar') { for (const st of petStates()) st.win.hide(); }
  broadcastConfig();
  refreshTrayMenu();
}
function applySkin(skin) {
  config.save({ skin });
  broadcastConfig();
  refreshTrayMenu();
}

// 补齐当前设置应有的窗口（被收起的宠从托盘找回来）
function ensurePetWindows() {
  if (!S.petWin || S.petWin.isDestroyed()) S.petWin = makePetWindow('all');
}
// Language switch (tray → Settings → Language). Main-process copy is baked into
// the strings the adapter already pushed, so a plain re-broadcast would leave
// stale labels on screen until the next session event — force a fresh stats
// emit so every list, badge and bubble re-renders in the new language at once.
function applyLang(lang) {
  if (config.get().lang === lang) return;
  config.save({ lang });
  i18n.setLang(lang);
  broadcastConfig();
  emitStats();
  refreshTrayMenu();
  log('main', `lang → ${lang}`);
}

// ── tray ──────────────────────────────────────────────────────────────────────
function buildTray() {
  let img;
  try {
    img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
    if (process.platform === 'darwin') img.setTemplateImage(true);
  } catch {}
  tray = new Tray(img || nativeImage.createEmpty());
  tray.setToolTip(t('tray.tooltip'));
  refreshTrayMenu();
  tray.on('click', () => { ensurePetWindows(); for (const st of petStates()) st.win.show(); });
}

function refreshTrayMenu() {
  if (!tray) return;
  const cfg = config.get();
  const muted = cfg.muted;
  const skin = cfg.skin || 'mascot';
  const mode = cfg.mode || 'pet';
  const lang = cfg.lang || 'zh';
  tray.setToolTip(t('tray.tooltip'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('tray.panel'), click: openPanel },
    { label: t('tray.archive'), click: openArchive },
    { label: t('tray.showPet'), click: () => { ensurePetWindows(); for (const st of petStates()) st.win.show(); } },
    { type: 'separator' },
    { label: t('tray.settings'), enabled: false },
    { label: t('tray.language'), submenu: i18n.LANGS.map((code) => ({
      label: t('lang.' + code), type: 'radio', checked: lang === code, click: () => applyLang(code),
    })) },
    { label: t('tray.agentStartup'), submenu: [
      { label: t('tray.agentStartupClaude'), type: 'checkbox', checked: cfg.agentStartup.claude === true,
        click: () => setAgentStartup('claude', config.get().agentStartup.claude !== true) },
      { label: t('tray.agentStartupCodex'), type: 'checkbox', checked: cfg.agentStartup.codex === true,
        click: () => setAgentStartup('codex', config.get().agentStartup.codex !== true) },
      { label: t('tray.agentStartupDsh'), type: 'checkbox', checked: cfg.agentStartup.dsh === true,
        click: () => setAgentStartup('dsh', config.get().agentStartup.dsh !== true) },
      { type: 'separator' },
      { label: t('tray.agentStartupNow'), click: () => runAgentStartup() },
    ] },
    { label: t('tray.skin'), submenu: [
      { label: t('skin.mascot'), type: 'radio', checked: skin === 'mascot', click: () => applySkin('mascot') },
      { label: t('skin.pixel'), type: 'radio', checked: skin === 'pixel', click: () => applySkin('pixel') },
      { label: t('skin.cat'), type: 'radio', checked: skin === 'cat', click: () => applySkin('cat') },
      { label: t('skin.whale'), type: 'radio', checked: skin === 'whale', click: () => applySkin('whale') },
    ] },
    { label: t('tray.shape'), submenu: [
      { label: t('shape.pet'), type: 'radio', checked: mode === 'pet', click: () => applyMode('pet') },
      { label: t('shape.panel'), type: 'radio', checked: mode === 'panel', click: () => applyMode('panel') },
      { label: t('shape.menubar'), type: 'radio', checked: mode === 'menubar', click: () => applyMode('menubar') },
    ] },
    { label: muted ? t('tray.unmute') : t('tray.mute'), click: () => { config.save({ muted: !muted }); broadcastConfig(); refreshTrayMenu(); } },
    { type: 'separator' },
    { label: t('tray.launchClaude'), click: () => launchClaude({}).catch(() => {}) },
    { label: t('tray.launchCodex'), click: () => launchCodex({}).catch(() => {}) },
    { label: t('tray.launchDsh'), click: () => launchDsh({}).catch(() => {}) },
    { label: t('tray.openLog'), click: () => shell.openPath(LOG_PATH) },
    { type: 'separator' },
    { label: t('tray.uninstallHook'), click: () => {
      // Stop the settings watcher first — otherwise it sees our hooks vanish and
      // re-registers them within 800ms, silently undoing this uninstall.
      try { if (stopWatcher) { stopWatcher(); stopWatcher = null; } } catch {}
      hooks.uninstall();
    } },
    { label: t('tray.quit'), click: () => app.quit() },
  ]));
}

function setAgentStartup(agent, enabled) {
  if (!['claude', 'codex', 'dsh'].includes(agent)) return;
  const current = config.get().agentStartup;
  config.save({ agentStartup: { ...current, [agent]: enabled === true } });
  broadcastConfig();
  refreshTrayMenu();
  log('startup', `${agent} auto-start → ${enabled === true}`);
}

function runAgentStartup(options = {}) {
  if (!agentStartup) return Promise.resolve([]);
  return agentStartup.run(options).catch((error) => {
    log('startup', 'unified agent startup failed:', error.message);
    return [];
  });
}

// Historical compatibility namespace: move the oldest ~/.llmpet data into
// ~/.octopus. The public brand is LLMPET, but this path stays stable so upgrades
// preserve usage history, config, installed hooks and permissions.
function migrateState() {
  try {
    const oct = path.join(os.homedir(), '.octopus');
    const old = path.join(os.homedir(), '.llmpet');
    if (!fs.existsSync(oct) && fs.existsSync(old)) {
      fs.renameSync(old, oct);
      log('main', 'migrated ~/.llmpet → ~/.octopus');
    }
  } catch (e) { log('main', 'state migrate skipped:', e.message); }
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
// 多实例防护（对齐 clawd-on-desk 的处理）：
//  1) Electron 实例锁：同一份 app 重复启动 → 新实例静默退出；
//  2) 启动探测：候选端口上已有同身份 server 在跑（多为另一份代码副本）→ 提示并退出；
//  3) server.js 里的 runtime 守护：存活期间 runtime.json 被别的副本覆盖 → 抢回。
// 开发需要多开时用 OCTOPUS_ALLOW_MULTI=1 跳过 1/2。
const allowMulti = process.env.OCTOPUS_ALLOW_MULTI === '1';

// 并行探测所有候选端口，找到任一存活的同身份 server 就返回其端口
function findRivalInstance() {
  if (allowMulti) return Promise.resolve(null);
  return new Promise((resolve) => {
    let pending = transport.PORTS.length;
    let found = null;
    for (const p of transport.PORTS) {
      transport.probe(p, 600, (ok) => {
        if (ok && found === null) found = p;
        if (--pending === 0) resolve(found);
      });
    }
  });
}

const gotTheLock = allowMulti ? true : app.requestSingleInstanceLock();
if (!gotTheLock) {
  log('main', 'another instance holds the lock — quitting');
  app.quit();
} else {
  app.on('second-instance', () => {
    try { for (const st of petStates()) st.win.show(); } catch {}
    openArchive();
  });
  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock) {
      const dockIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.icns'));
      if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
      await app.dock.show();
    }
    const rival = await findRivalInstance();
    if (rival) {
      log('main', `another LLMPET server is live on 127.0.0.1:${rival} — quitting (OCTOPUS_ALLOW_MULTI=1 to bypass)`);
      dialog.showErrorBox(
        t('dlg.dupTitle'),
        t('dlg.dupBody', { port: rival }) + t('dlg.dupHint')
      );
      app.quit();
      return;
    }
    migrateState();
    registerIpc();
    bootBackend();
    agentStartup = createAgentStartup({
      getSettings: () => config.get().agentStartup,
      onResult: (result) => log('startup', `${result.agent}: ${result.status}${result.message ? ` (${result.message})` : ''}`),
    });
    createPetWindows();
    try { buildTray(); } catch (e) { log('main', 'tray unavailable:', e.message); }
    // Let the pet and tray become responsive first; startup failures are
    // isolated and never block LLMPET's own ready path.
    setTimeout(() => runAgentStartup(), 700).unref?.();
    // LLMPET now has a real desktop library. The initial launch remains pet-only,
    // while a later Dock click always opens or focuses the archive window.
    app.on('activate', openArchive);
    log('main', 'LLMPET ready');
  });
}

app.on('window-all-closed', () => { /* tray app: stay alive */ });

app.on('before-quit', () => {
  try { if (sessionArchive) sessionArchive.stop(); } catch {}
  try { if (programRegistry) programRegistry.stop(); } catch {}
  try { if (runtimeMonitor) runtimeMonitor.stop(); } catch {}
  try { if (codexWatch) codexWatch.stop(); } catch {}
  try { if (dshWatch) dshWatch.stop(); } catch {}
  try { if (stopWatcher) stopWatcher(); } catch {}
  try { if (permissions) permissions.cleanup(); } catch {}
  try { if (server) server.stop(); } catch {}
  try { if (metering) metering.stop(); } catch {}
  try { if (codexMetering) codexMetering.stop(); } catch {}
  try { if (pricingSync) pricingSync.stop(); } catch {}
  try { if (core) core.stopStaleCleanup(); } catch {}
  log('main', 'LLMPET quit');
});
