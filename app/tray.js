'use strict';
// 托盘与设置动作（模式/皮肤/语言/自启动）—— R3 自 main.js 抽出。
module.exports = function createTray(deps) {
  const {
    Menu, Tray, nativeImage, path, APP_DIR,
    config, i18n, log, t, shell, LOG_PATH, hooks,
    getStopWatcher, setStopWatcher, getAgentStartup,
    petStates, S, makePetWindow,
    openPanel, openArchive,
    broadcastConfig, emitStats,
    launchClaude, launchCodex, launchDsh,
  } = deps;

  let tray = null;

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

  function buildTray() {
    let img;
    try {
      img = nativeImage.createFromPath(path.join(APP_DIR, 'assets', 'tray.png'));
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
        try { if (getStopWatcher()) { getStopWatcher()(); setStopWatcher(null); } } catch {}
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
    if (!getAgentStartup()) return Promise.resolve([]);
    return getAgentStartup().run(options).catch((error) => {
      log('startup', 'unified agent startup failed:', error.message);
      return [];
    });
  }

  return { buildTray, refreshTrayMenu, applyMode, applySkin, applyLang, ensurePetWindows, setAgentStartup, runAgentStartup };
};
