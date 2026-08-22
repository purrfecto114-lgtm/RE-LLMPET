'use strict';

/**
 * Compatibility bridge for the Tauri rewrite.
 *
 * It preserves the stable `window.pet` renderer contract so
 * the existing renderer, CSS, HTML and image resources can move unchanged.
 * Privileged work is implemented by named Rust commands; no raw Tauri handle is
 * re-exported through this compatibility object.
 */

// Tauri 2 exposes the current window through getCurrentWindow(). Keep a
// Tauri 1 fallback only for compatibility with older development shells.
// Feature files use this accessor rather than retaining raw global handles.
function getCurrentTauriWindow() {
  var api = (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.window) || null;
  if (!api) return null;
  // Tauri 2: getCurrentWindow() is a function export.
  if (typeof api.getCurrentWindow === 'function') return api.getCurrentWindow();
  // Tauri 1 fallback: Window.getCurrent() class method (shouldn't be needed
  // in Tauri 2, but kept for safety).
  if (api.Window && typeof api.Window.getCurrent === 'function') return api.Window.getCurrent();
  return null;
}

function currentPetAgent() {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('agent');
    if (fromQuery === 'codex') return 'codex';
    if (fromQuery === 'claude') return 'claude';
    const current = getCurrentTauriWindow();
    if (current && current.label === 'pet-codex') return 'codex';
  } catch (_) {}
  return 'claude';
}

(function installOctopusBridge(global) {
  const tauri = global.__TAURI__;
  const invoke = tauri && tauri.core && tauri.core.invoke;
  const listen = tauri && tauri.event && tauri.event.listen;

  // Tauri listeners live outside the page's JavaScript scope and therefore
  // must be explicitly detached when a WebView reloads. Keep ownership in the
  // bridge instead of making every renderer remember a growing list of
  // unlisten callbacks. The disposed flag also closes the async race where
  // `listen()` resolves after `beforeunload` has already run.
  const subscriptionDisposers = new Set();
  let bridgeDisposed = false;

  function trackDisposer(dispose) {
    let active = true;
    const tracked = () => {
      if (!active) return;
      active = false;
      subscriptionDisposers.delete(tracked);
      try { dispose(); } catch (_) {}
    };
    if (bridgeDisposed) tracked();
    else subscriptionDisposers.add(tracked);
    return tracked;
  }

  function disposeSubscriptions() {
    if (bridgeDisposed) return;
    bridgeDisposed = true;
    for (const dispose of Array.from(subscriptionDisposers)) dispose();
    subscriptionDisposers.clear();
  }

  if (global && typeof global.addEventListener === 'function') {
    global.addEventListener('beforeunload', disposeSubscriptions, { once: true });
  }

  function call(command, args) {
    if (typeof invoke !== 'function') {
      return Promise.reject(new Error(`Tauri bridge unavailable: ${command}`));
    }
    return invoke(command, args || {});
  }

  // R30 (2026-07-31): send() is fire-and-forget for non-critical operations
  // (telemetry, logging, UI state). For state-changing or security-critical
  // operations, callers MUST use call() and await the result.
  // send() now emits a 'bridge:error' event that the panel/pet can listen
  // to for displaying user-visible error toasts, instead of silently
  // logging to console only.
  function send(command, args) {
    void call(command, args).catch((err) => {
      const msg = String(err && (err.message || err) || 'unknown');
      try { console.error(`[octopus] ${command} failed:`, msg); } catch (_) {}
      // Emit a global error event so the UI can show a toast
      try { window.dispatchEvent(new CustomEvent('re-llmpet:bridge-error', { detail: { command, message: msg } })); } catch (_) {}
    });
  }

  function subscribe(channel, cb) {
    if (typeof cb !== 'function' || typeof listen !== 'function' || bridgeDisposed) return () => {};
    let active = true;
    let unlisten = null;
    const dispose = trackDisposer(() => {
      active = false;
      if (typeof unlisten === 'function') {
        const off = unlisten;
        unlisten = null;
        off();
      }
    });
    let registration;
    try {
      registration = listen(channel, (event) => {
        // R1-A#7 fix: wrap cb() in try/catch so a single throwing listener
        // (e.g. applyStats on a malformed payload) does not propagate out of
        // Tauri's event dispatch and silently degrade every subsequent event.
        // The error is surfaced via console + the bridge-error CustomEvent
        // so a toast can be shown without freezing the UI.
        if (!active || bridgeDisposed) return;
        try {
          cb(event ? event.payload : undefined);
        } catch (err) {
          try { console.error(`[octopus] listener ${channel} threw:`, err); } catch (_) {}
          try {
            global.dispatchEvent(new CustomEvent('re-llmpet:bridge-error', {
              detail: { command: 'listener:' + channel, message: String(err && (err.message || err) || 'unknown') }
            }));
          } catch (_) {}
        }
      });
    } catch (err) {
      dispose();
      try { console.error(`[octopus] listen ${channel} failed`, err); } catch (_) {}
      return dispose;
    }
    Promise.resolve(registration).then((off) => {
      if (typeof off !== 'function') {
        dispose();
        return;
      }
      if (!active || bridgeDisposed) off();
      else unlisten = off;
    }).catch((err) => {
      dispose();
      try { console.error(`[octopus] listen ${channel} failed`, err); } catch (_) {}
    });
    return dispose;
  }

  global.pet = Object.freeze({
    onEvent: (cb) => subscribe('pet:event', cb),
    onStats: (cb) => subscribe('pet:stats', cb),
    onPanelStats: (cb) => subscribe('panel:stats', cb),
    onConfig: (cb) => {
      const offPet = subscribe('pet:config', cb);
      const offPanel = subscribe('panel:config', cb);
      return () => { offPet(); offPanel(); };
    },
    onPrice: (cb) => subscribe('panel:price', cb),
    onDiagnosticProgress: (cb) => subscribe('panel:diagnostic-progress', cb),
    onTravel: (cb) => subscribe('pet:travel', cb),
    onWindowBlur: (cb) => subscribe('pet:window-blur', cb),
    onPanelShown: (cb) => subscribe('panel:shown', cb),
    onPanelHidden: (cb) => subscribe('panel:hidden', cb),

    getConfig: () => call('get_config'),
    getStats: () => call('get_stats'),
    getPriceInfo: () => call('get_price_info'),
    refreshModelPrices: () => call('refresh_model_prices'),
    setPriceAutoUpdate: (enabled, refreshHours) => call('set_price_auto_update', { enabled, refreshHours }),
    rebuildUsageCosts: () => call('rebuild_usage_costs'),
    setLanguage: (lang) => call('set_language', { lang }),
    openPanel: () => send('open_panel'),
    // R38.1: upgraded to call() — the 0.5.16 full audit (P0-4) flagged
    // that send() (fire-and-forget) meant hide failures were invisible.
    // Now the caller can await and know if the hide succeeded.
    closePanel: () => call('close_panel'),
    setMode: (mode) => call('set_mode', { mode }),
    setPetMode: (petMode) => call('set_pet_mode', { petMode }),
    setSkin: (skin) => call('set_skin', { skin, agent: currentPetAgent() }),
    setBudget: (value) => call('set_budget', { value }),
    setCurrency: (currency) => call('set_currency', { currency }),
    // R19 (2026-07-30): persist session list pin/archive prefs.
    // R32 (2026-07-31): upgraded to call() — session prefs persist user intent
    // (pin/archive), so silent loss on IPC failure is unacceptable.
    setSessionPrefs: (pinned, archived) => call('set_session_prefs', { pinned, archived }),
    setSessionPref: (sessionId, pinned, archived) => call('set_session_pref', { sessionId, pinned, archived }),
    toggleMute: () => send('toggle_mute'),
    // R32 (2026-07-31): upgraded to call() — provider list is a security-
    // relevant state (controls which CLIs get hooks installed). Caller MUST
    // await so failures can revert UI and surface a toast.
    setProviders: (ids) => call('set_providers', { ids }),
    territoryRunNow: () => call('territory_run_now'),
    territoryToggleAuto: () => call('territory_toggle_auto'),
    getTravel: () => call('get_travel'),
    startTravel: (sessionId, mission) => call('start_travel', { sessionId, mission }),
    startWander: (mission, provider) => call('start_wander', { mission, provider }),
    setWanderMissions: (missions) => call('set_wander_missions', { missions }),
    cancelTravel: () => call('cancel_travel'),
    quit: () => send('quit_app'),
    getWinPos: () => call('get_win_pos', { agent: currentPetAgent() }).then((pos) => {
      if (Array.isArray(pos)) return pos;
      return [Number(pos && pos.x) || 0, Number(pos && pos.y) || 0];
    }),
    setWinPos: (x, y) => call('set_win_pos', { x, y, agent: currentPetAgent() }),
    commitWinPos: () => call('commit_win_pos', { agent: currentPetAgent() }),
    launchClaude: () => send('launch_agent', { provider: 'claude' }),
    launchCodeWhale: () => send('launch_agent', { provider: 'codewhale' }),
    launchCodex: () => send('launch_agent', { provider: 'codex' }),
    launchDsh: () => send('launch_agent', { provider: 'dsh' }),
    launchOpenCode: () => send('launch_agent', { provider: 'opencode' }),
    diagnoseAgent: (provider) => call('diagnose_agent', { provider }),
    // R35.2 (2026-07-31): cancel_diagnostic — kills the currently-running
    // diagnostic process tree (taskkill /F /T on Windows, kill on Unix).
    // The 0.5.12 carpet audit P0-4 flagged that the old "cancel" only
    // dropped the frontend result; the Rust Child kept running.
    cancelDiagnostic: () => call('cancel_diagnostic'),
    launchAgent: (provider) => send('launch_agent', { provider }),
    launchAgentChecked: (provider) => call('launch_agent', { provider }),
    launchAgentGui: (provider) => send('launch_agent_gui', { provider }),
    // R32 (2026-07-31): upgraded to call() — permission decisions are the
    // SECURITY-CRITICAL path. The previous send() (fire-and-forget) meant
    // an IPC failure left the user thinking they had allowed/denied, while
    // the agent kept waiting and the choice card was already removed.
    // Now callers can await and only remove the card on actual success.
    decidePermission: (permId, behavior) => call('decide_permission', { permId, behavior }),
    decideCwPermission: (permId, behavior) => call('decide_permission', { permId, behavior }),
    decideCwPermissionBatch: (permId, mode) => call('decide_permission_batch', { permId, mode }),
    focusSession: (sessionId) => send('focus_session', { sessionId }),
    primaryAction: () => send('primary_action'),
    setIgnoreMouse: (ignore) => call('set_ignore_mouse', { ignore, agent: currentPetAgent() }),
    setPetTall: (tall) => send('set_pet_tall', { tall, agent: currentPetAgent() }),
    setPetBig: (on) => send('set_pet_big', { on, agent: currentPetAgent() }),
    setPetSize: (width, height) => call('set_pet_size', { width, height, agent: currentPetAgent() }),
    // Geometry state is acknowledged: callers commit their local cache only
    // after Rust returns the actual clamped size.
    setPanelHeight: (height) => call('set_panel_height', { height }),
    focusPet: () => send('focus_pet', { agent: currentPetAgent() }),
    blurPet: () => send('blur_pet'),
    openLog: () => send('open_log'),
    petLog: (tag, message) => send('pet_log', { tag, message }),
    uiBusy: (on) => call('ui_busy', { on }),
    petVisualBounds: (rect) => send('pet_visual_bounds', { rect, agent: currentPetAgent() }),
    // R44 0.5.40 (Roadmap v6 P0-01): config recovery closure. These three
    // commands are registered in panel capability ONLY (not pet) because
    // they are privileged operations that should not be reachable from
    // the always-on pet window. The panel UI uses them to:
    //   1. Query config quarantine state on startup → if quarantined,
    //      show recovery page instead of normal settings.
    //   2. Offer "backup and reset" button → calls backup_and_reset_config.
    //   3. Display install receipts for diagnostics.
    getConfigState: () => call('get_config_state'),
    backupAndResetConfig: () => call('backup_and_reset_config'),
    getInstallReceipts: () => call('get_install_receipts'),
  });
})(window);
