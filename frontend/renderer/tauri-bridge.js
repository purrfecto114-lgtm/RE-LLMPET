'use strict';

/**
 * Compatibility bridge for the Tauri rewrite.
 *
 * It preserves the stable `window.pet` renderer contract so
 * the existing renderer, CSS, HTML and image resources can move unchanged.
 * Privileged work is implemented by named Rust commands; no raw Tauri handle is
 * re-exported through this compatibility object.
 */
(function installOctopusBridge(global) {
  const tauri = global.__TAURI__;
  const invoke = tauri && tauri.core && tauri.core.invoke;
  const listen = tauri && tauri.event && tauri.event.listen;

  function call(command, args) {
    if (typeof invoke !== 'function') {
      return Promise.reject(new Error(`Tauri bridge unavailable: ${command}`));
    }
    return invoke(command, args || {});
  }

  function send(command, args) {
    void call(command, args).catch((err) => {
      try { console.error(`[octopus] ${command} failed`, err); } catch (_) {}
    });
  }

  function subscribe(channel, cb) {
    if (typeof cb !== 'function' || typeof listen !== 'function') return () => {};
    let active = true;
    let unlisten = null;
    const pending = listen(channel, (event) => {
      if (active) cb(event ? event.payload : undefined);
    }).then((off) => {
      if (!active) off();
      else unlisten = off;
    }).catch((err) => {
      try { console.error(`[octopus] listen ${channel} failed`, err); } catch (_) {}
    });
    return () => {
      active = false;
      if (typeof unlisten === 'function') unlisten();
      else void pending;
    };
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

    getConfig: () => call('get_config'),
    getStats: () => call('get_stats'),
    getPriceInfo: () => call('get_price_info'),
    refreshModelPrices: () => call('refresh_model_prices'),
    setPriceAutoUpdate: (enabled, refreshHours) => send('set_price_auto_update', { enabled, refreshHours }),
    openPanel: () => send('open_panel'),
    closePanel: () => send('close_panel'),
    setMode: (mode) => send('set_mode', { mode }),
    setSkin: (skin) => send('set_skin', { skin }),
    setBudget: (value) => send('set_budget', { value }),
    setCurrency: (currency) => send('set_currency', { currency }),
    toggleMute: () => send('toggle_mute'),
    setProviders: (ids) => send('set_providers', { ids }),
    territoryRunNow: () => send('territory_run_now'),
    territoryToggleAuto: () => send('territory_toggle_auto'),
    quit: () => send('quit_app'),
    getWinPos: () => call('get_win_pos').then((pos) => {
      if (Array.isArray(pos)) return pos;
      return [Number(pos && pos.x) || 0, Number(pos && pos.y) || 0];
    }),
    setWinPos: (x, y) => send('set_win_pos', { x, y }),
    launchClaude: () => send('launch_agent', { provider: 'claude' }),
    launchCodeWhale: () => send('launch_agent', { provider: 'codewhale' }),
    decidePermission: (permId, behavior) => send('decide_permission', { permId, behavior }),
    decideCwPermission: (permId, behavior) => send('decide_permission', { permId, behavior }),
    decideCwPermissionBatch: (permId, mode) => send('decide_permission_batch', { permId, mode }),
    focusSession: (sessionId) => send('focus_session', { sessionId }),
    primaryAction: () => send('primary_action'),
    setIgnoreMouse: (ignore) => send('set_ignore_mouse', { ignore }),
    setPetTall: (tall) => send('set_pet_tall', { tall }),
    setPetBig: (on) => send('set_pet_big', { on }),
    setPetSize: (width, height) => send('set_pet_size', { width, height }),
    setPanelHeight: (height) => send('set_panel_height', { height }),
    focusPet: () => send('focus_pet'),
    blurPet: () => send('blur_pet'),
    openLog: () => send('open_log'),
    petLog: (tag, message) => send('pet_log', { tag, message }),
    uiBusy: (on) => send('ui_busy', { on }),
    petVisualBounds: (rect) => send('pet_visual_bounds', { rect }),
  });
})(window);
