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
const { hardenWindow, createPetWindows, openPanel, closePanel, openArchive, closeArchive, applyPetSize } = windows;

const trayMod = require('./app/tray')({
  Menu, Tray, nativeImage, path, APP_DIR,
  config, i18n, log, t, shell, LOG_PATH, hooks,
  getStopWatcher: () => stopWatcher, setStopWatcher: (v) => { stopWatcher = v; },
  getAgentStartup: () => agentStartup,
  petStates, S,
  makePetWindow,
  openPanel, openArchive,
  broadcastConfig, emitStats,
  launchClaude, launchCodex, launchDsh,
});
const { buildTray, refreshTrayMenu, applyMode, applySkin, applyLang, ensurePetWindows, setAgentStartup, runAgentStartup } = trayMod;

const ipc = require('./app/ipc')({
  ipcMain, screen, shell, clipboard, fs,
  config, i18n, log, DSH_WEB_URL,
  BASE_W, TALL_H, BIG_W, BIG_H,
  S, stateOfSender, primaryPetState, applyPetSize, sendArchive, broadcastConfig,
  frontendConfig, statsHub,
  applyMode, applySkin, refreshTrayMenu,
  openPanel, closePanel, openArchive, closeArchive,
  ensureDshWeb, focusSession, launchClaude, launchCodex, launchDsh,
  getCore: () => core,
  getPermissions: () => permissions,
  getSessionArchive: () => sessionArchive,
  getSessionTakeover: () => sessionTakeover,
  getProgramRegistry: () => programRegistry,
  getProgramSkillManager: () => programSkillManager,
});
const { registerIpc } = ipc;




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
