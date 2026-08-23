'use strict';
// IPC 注册表：宠物/面板/档案馆全部通道 —— R3 自 main.js 抽出。
// get* 为惰性取值器：core/permissions 等管理器在 boot 阶段才赋值。
module.exports = function createIpc(deps) {
  const {
    ipcMain, screen, shell, clipboard, fs,
    config, i18n, log, DSH_WEB_URL,
    BASE_W, TALL_H, BIG_W, BIG_H,
    S, stateOfSender, primaryPetState, applyPetSize, sendArchive, broadcastConfig,
    frontendConfig, statsHub,
    applyMode, applySkin, refreshTrayMenu,
    openPanel, closePanel, openArchive, closeArchive,
    ensureDshWeb, focusSession, launchClaude, launchCodex, launchDsh,
    getCore, getPermissions, getSessionArchive, getSessionTakeover,
    getProgramRegistry, getProgramSkillManager,
  } = deps;

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
    if (!getSessionArchive()) return { sessions: [], total: 0, page: 1, pageSize: 100, summary: null };
    const archiveSummary = getSessionArchive().summary();
    if (!archiveSummary.lastScanAt || Date.now() - archiveSummary.lastScanAt > 30000) {
      await getSessionArchive().refresh();
    }
    const activeIds = getCore() ? [...getCore().sessions.keys()] : [];
    return getSessionArchive().list({ ...(query || {}), activeIds });
  });
  ipcMain.handle('session-archive-settings', async (_e, partial) => {
    const current = config.get().getSessionArchive() || {};
    const next = {
      backupEnabled: partial && partial.backupEnabled !== undefined
        ? partial.backupEnabled === true : current.backupEnabled === true,
      backupIntervalHours: partial && partial.backupIntervalHours !== undefined
        ? Number(partial.backupIntervalHours) : current.backupIntervalHours,
    };
    config.save({ sessionArchive: next });
    if (getSessionArchive()) {
      if (next.backupEnabled && !current.backupEnabled) {
        getSessionArchive().backupNow()
          .catch((e) => log('archive', 'initial backup failed:', e.message))
          .finally(() => getSessionArchive().schedule());
      } else getSessionArchive().schedule();
    }
    return config.get().getSessionArchive();
  });
  ipcMain.handle('session-archive-backup-now', async () => {
    if (!getSessionArchive()) return { ok: false, code: 'not-ready' };
    return getSessionArchive().backupNow();
  });
  ipcMain.handle('session-archive-resume', async (_e, key, targetAgent) => {
    if (!getSessionArchive() || !getSessionTakeover()) return { ok: false, code: 'not-ready' };
    const archived = getSessionArchive().get(key);
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
    const result = await getSessionTakeover().takeOver(session, target, { locale: i18n.getLang() });
    log('archive', `resume ${archived.key} → ${target} ok=${!!result.ok} code=${result.code || '-'}`);
    return result;
  });
  ipcMain.handle('session-archive-restore', async (_e, key) => {
    if (!getSessionArchive()) return { ok: false, code: 'not-ready' };
    const result = await getSessionArchive().restore(key);
    log('archive', `restore ${String(key || '')} ok=${!!result.ok} code=${result.code || '-'}`);
    return result;
  });
  ipcMain.handle('session-archive-reveal', async (_e, key) => {
    if (!getSessionArchive()) return false;
    const archived = getSessionArchive().get(key);
    const target = archived && (archived.sourceAvailable ? archived.sourcePath : archived.backupPath);
    if (!target) return false;
    shell.showItemInFolder(target);
    return true;
  });
  ipcMain.on('session-archive-open-backup', () => {
    if (!getSessionArchive()) return;
    try { fs.mkdirSync(getSessionArchive().backupRoot, { recursive: true, mode: 0o700 }); }
    catch (e) { log('archive', 'create backup folder failed:', e.message); return; }
    shell.openPath(getSessionArchive().backupRoot)
      .then((error) => { if (error) log('archive', 'open backup folder failed:', error); });
  });
  ipcMain.handle('generated-programs-list', () => getProgramRegistry() ? getProgramRegistry().list() : []);
  ipcMain.handle('generated-program-launch', async (_e, id) => {
    const result = getProgramRegistry() ? await getProgramRegistry().launch(id) : { ok: false, code: 'not-ready' };
    log('programs', `launch ${String(id || '')} ok=${!!result.ok} code=${result.code || '-'}`);
    return result;
  });
  ipcMain.handle('generated-program-reveal', (_e, id) => getProgramRegistry() ? getProgramRegistry().reveal(id) : false);
  ipcMain.handle('generated-program-remove', (_e, id) => getProgramRegistry() ? getProgramRegistry().remove(id) : false);
  ipcMain.handle('program-skills-status', () => getProgramSkillManager() ? getProgramSkillManager().status() : []);
  ipcMain.handle('program-skill-install', (_e, provider) => {
    try {
      const result = getProgramSkillManager() ? getProgramSkillManager().install(provider) : { ok: false, code: 'not-ready' };
      log('programs', `skill install provider=${String(provider || '')} ok=${!!result.ok} code=${result.code || '-'}`);
      sendArchive('program-skills:changed', getProgramSkillManager() ? getProgramSkillManager().status() : []);
      return result;
    } catch (error) {
      log('programs', `skill install provider=${String(provider || '')} failed:`, error.message);
      return { ok: false, code: 'install-failed', message: error.message };
    }
  });
  ipcMain.handle('program-skill-remove', (_e, provider) => {
    try {
      const result = getProgramSkillManager() ? getProgramSkillManager().remove(provider) : { ok: false, code: 'not-ready' };
      log('programs', `skill remove provider=${String(provider || '')} ok=${!!result.ok} code=${result.code || '-'}`);
      sendArchive('program-skills:changed', getProgramSkillManager() ? getProgramSkillManager().status() : []);
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
    getPermissions().decide(permId, behavior);
  });
  ipcMain.on('focus-session', (_e, sessionId) => {
    const session = getCore().getSession(sessionId);
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
  // getCore().getSession() 当下仍然存在；只允许安全的 session-id 字符集。
  ipcMain.handle('copy-session-id', (_e, sessionId) => {
    const id = String(sessionId || '').trim();
    if (id.length < 8 || id.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(id)) return false;
    clipboard.writeText(id);
    return true;
  });
  ipcMain.handle('session-takeover', async (_e, sessionId, targetAgent) => {
    const id = typeof sessionId === 'string' ? sessionId : '';
    const target = targetAgent === 'codex' ? 'codex' : targetAgent === 'claude' ? 'claude' : '';
    const session = id && getCore() ? getCore().getSession(id) : null;
    if (!getSessionTakeover() || !session || session.headless || session.sessionRole === 'travel') {
      return { ok: false, code: 'invalid-target' };
    }
    if (!target) return { ok: false, code: 'invalid-provider' };
    const result = await getSessionTakeover().takeOver(session, target, { locale: i18n.getLang() });
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
    const all = getCore() ? [...getCore().sessions.values()] : [];
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

  return { registerIpc };
};
