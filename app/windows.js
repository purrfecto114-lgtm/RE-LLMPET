'use strict';
// 窗口生命周期：桌宠 / 面板 / 档案馆的创建、显示与加固（R3 自 main.js 抽出）。
// S = 共享窗口状态对象（main.js 持有同一引用，供 IPC/tray 层读写）。
module.exports = function createWindows(deps) {
  const {
    BrowserWindow, screen, nativeImage, app,
    config, log, path, PRELOAD, APP_DIR, BASE_W, BASE_H,
    petState, core, metering, sessionArchive,
    frontendConfig, statsHub,
    sendWin, sendPanel,
  } = deps;
  const S = deps.S;

  // Block any navigation / new-window to external content (hardening).
  function hardenWindow(win) {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('file://')) e.preventDefault();
    });
  }

  function createPetWindows() {
    S.petWin = makePetWindow('all');
    log('main', 'pet windows: all');
  }

  function makePetWindow(agent) {
    const c = config.get();
    const saved = c.petPosition;
    let x, y;
    if (saved) { x = saved.x; y = saved.y; }
    else {
      try {
        const wa = screen.getPrimaryDisplay().workArea;
        x = wa.x + wa.width - BASE_W - 24;
        y = wa.y + wa.height - BASE_H - 24;
      } catch {}
    }

    const win = new BrowserWindow({
      width: BASE_W,
      height: BASE_H,
      x, y,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    win.setAlwaysOnTop(true, 'floating');
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
    hardenWindow(win);
    // ?agent= 告诉渲染端自己盯谁（名牌/图标/唤起按钮/开场白都按它分流）
    win.loadFile(path.join(APP_DIR, 'renderer', 'pet.html'), { query: { agent } });

    // mouseIgnoring=true：透明窗启动即穿透，renderer 命中测试后再接管（pet.js 同款默认）
    const st = { agent, win, customSize: null, visualRect: null, uiBusy: false, mouseIgnoring: true };
    // 'closed' 之后绝不能再碰 win.webContents（抛 "Object has been destroyed"，主进程
    // 未捕获直接崩）——id 在创建时取好。
    const wcId = win.webContents.id;
    petState.set(wcId, st);
    win.on('closed', () => {
      petState.delete(wcId);
      if (S.petWin === win) S.petWin = null;
    });

    win.on('moved', () => {
      if (st.customSize) return; // only persist the resting position
      if (win.isDestroyed()) return;
      const b = win.getBounds();
      config.save({ petPosition: { x: b.x, y: b.y } });
    });
    win.webContents.on('did-finish-load', () => {
      sendWin(win, 'pet:config', frontendConfig());
      if (core()) sendWin(win, 'pet:stats', statsHub.petStats());
    });
    return win;
  }

  function openPanel() {
    if (S.panelWin && !S.panelWin.isDestroyed()) { S.panelWin.show(); S.panelWin.focus(); return; }
    S.panelH = 0; // 每次开面板重置自适应高度基准
    S.panelWin = new BrowserWindow({
      width: 560,
      height: 720,
      frame: false,
      transparent: false,
      resizable: true,
      skipTaskbar: false,
      show: false, // 先隐藏，首帧按内容定高后再显示，避免闪一下大窗口
      backgroundColor: '#2c1f1a',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    hardenWindow(S.panelWin);
    S.panelWin.loadFile(path.join(APP_DIR, 'renderer', 'panel.html'));
    S.panelWin.webContents.on('did-finish-load', () => {
      sendPanel('panel:config', frontendConfig());
      if (statsHub.lastStats) sendPanel('panel:stats', statsHub.lastStats);
      if (metering()) sendPanel('panel:price', metering().priceInfo());
      // 首帧渲染 + setPanelHeight 已到位后再显示
      setTimeout(() => { try { if (S.panelWin && !S.panelWin.isDestroyed()) S.panelWin.show(); } catch {} }, 90);
    });
    S.panelWin.on('closed', () => { S.panelWin = null; });
  }

  function closePanel() {
    if (S.panelWin && !S.panelWin.isDestroyed()) S.panelWin.close();
    S.panelWin = null;
  }

  // The archive renderer is now LLMPET's unified desktop workbench. Its session
  // manager keeps the archive contract; the other pages share live stats and the
  // local generated-program registry.
  function openArchive() {
    if (process.platform === 'darwin' && app.dock) {
      app.dock.show();
      const dockIcon = nativeImage.createFromPath(path.join(APP_DIR, 'assets', 'icon.icns'));
      if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
    }
    if (S.archiveWin && !S.archiveWin.isDestroyed()) {
      S.archiveWin.show();
      S.archiveWin.focus();
      if (sessionArchive()) sessionArchive().refresh().catch((e) => log('archive', 'refresh failed:', e.message));
      return;
    }
    S.archiveWin = new BrowserWindow({
      width: 1220,
      height: 790,
      minWidth: 920,
      minHeight: 620,
      frame: false,
      transparent: false,
      resizable: true,
      skipTaskbar: false,
      show: false,
      backgroundColor: '#18171d',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    hardenWindow(S.archiveWin);
    S.archiveWin.loadFile(path.join(APP_DIR, 'renderer', 'archive.html'));
    S.archiveWin.webContents.on('did-finish-load', () => {
      sendWin(S.archiveWin, 'archive:config', frontendConfig());
      // Usage ledgers scan independently from the activity core. Always build a
      // fresh payload when the workbench opens; a cached startup snapshot may
      // still contain Codex 0 while rollout scanning has already advanced.
      if (core()) sendWin(S.archiveWin, 'workbench:stats', statsHub.buildStats());
      if (metering()) sendWin(S.archiveWin, 'workbench:price', metering().priceInfo());
      setTimeout(() => {
        try { if (S.archiveWin && !S.archiveWin.isDestroyed()) { S.archiveWin.show(); S.archiveWin.focus(); } } catch {}
      }, 50);
      if (sessionArchive()) sessionArchive().refresh().catch((e) => log('archive', 'refresh failed:', e.message));
    });
    S.archiveWin.on('closed', () => { S.archiveWin = null; });
  }

  function closeArchive() {
    if (S.archiveWin && !S.archiveWin.isDestroyed()) S.archiveWin.close();
    S.archiveWin = null;
  }

  // ── window geometry ────────────────────────────────────────────────────────
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

  return {
    hardenWindow, createPetWindows, openPanel, closePanel, openArchive, closeArchive,
    applyPetSize,
  };
};
