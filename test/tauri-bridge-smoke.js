'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const calls = [];
const listeners = new Map();
const windowHandlers = new Map();
const deferredListeners = new Map();
const nativeUnlistenCalls = [];
const throwChannels = new Set();
const loggedErrors = [];
const context = {
  console: { ...console, error: (...args) => loggedErrors.push(args) },
  Promise,
  setTimeout,
  clearTimeout,
  window: {
    addEventListener(type, handler) {
      if (!windowHandlers.has(type)) windowHandlers.set(type, []);
      windowHandlers.get(type).push(handler);
    },
    dispatchEvent() {},
    __TAURI__: {
      core: {
        invoke(command, args) {
          calls.push({ command, args: args || {} });
          if (command === 'get_config') return Promise.resolve({ mode: 'pet' });
          if (command === 'get_stats') return Promise.resolve({ sessions: [] });
          if (command === 'get_price_info') return Promise.resolve({ autoUpdate: true, refreshHours: 24 });
          if (command === 'get_win_pos') return Promise.resolve({ x: 1, y: 2 });
          if (command === 'commit_win_pos') return Promise.resolve([11, 22]);
          return Promise.resolve(null);
        },
      },
      event: {
        listen(channel, callback) {
          if (throwChannels.has(channel)) throw new Error('synchronous listen failure');
          listeners.set(channel, callback);
          if (deferredListeners.has(channel)) return deferredListeners.get(channel).promise;
          return Promise.resolve(() => {
            nativeUnlistenCalls.push(channel);
            listeners.delete(channel);
          });
        },
      },
    },
  },
};
context.globalThis = context.window;
vm.createContext(context);
const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'renderer', 'tauri-bridge.js'), 'utf8');
vm.runInContext(source, context, { filename: 'tauri-bridge.js' });

const api = context.window.pet;
const expected = [
  'onEvent', 'onStats', 'onPanelStats', 'onConfig', 'onPrice', 'onTravel', 'onWindowBlur', 'onPanelShown', 'onPanelHidden',
  'getConfig', 'getStats', 'getPriceInfo', 'getTravel', 'refreshModelPrices', 'setPriceAutoUpdate', 'rebuildUsageCosts', 'setLanguage', 'openPanel', 'closePanel', 'setMode', 'setPetMode', 'setSkin', 'onDiagnosticProgress',
  'setBudget', 'setCurrency', 'setSessionPrefs', 'setSessionPref', 'toggleMute', 'setProviders', 'territoryRunNow',
  'territoryToggleAuto', 'startTravel', 'startWander', 'setWanderMissions', 'cancelTravel', 'quit', 'getWinPos', 'setWinPos', 'commitWinPos', 'launchClaude',
  'launchCodeWhale', 'launchCodex', 'launchOpenCode', 'launchDsh', 'diagnoseAgent', 'cancelDiagnostic', 'launchAgent', 'launchAgentChecked', 'launchAgentGui',
  'decidePermission', 'decideCwPermission',
  'decideCwPermissionBatch', 'focusSession', 'primaryAction', 'setIgnoreMouse',
  'setPetTall', 'setPetBig', 'setPetSize', 'setPanelHeight', 'focusPet',
  'blurPet', 'openLog', 'petLog', 'uiBusy', 'petVisualBounds',
  // R44 0.5.40 (Roadmap v6 P0-01): config recovery closure.
  'getConfigState', 'backupAndResetConfig', 'getInstallReceipts',
].sort();
assert(api && typeof api === 'object');
assert(Object.isFrozen(api), 'compatibility API must be frozen');
assert.deepStrictEqual(Object.keys(api).sort(), expected, 'bridge API drifted from preload contract');
assert(Object.values(api).every((value) => typeof value === 'function'));

(async () => {
  assert.deepStrictEqual(await api.getConfig(), { mode: 'pet' });
  assert.deepStrictEqual(await api.getStats(), { sessions: [] });
  assert.deepStrictEqual(await api.getPriceInfo(), { autoUpdate: true, refreshHours: 24 });
  assert.deepStrictEqual(Array.from(await api.getWinPos()), [1, 2]);

  api.setLanguage('ja');
  api.setMode('panel');
  api.setWinPos(11, 22);
  assert.deepStrictEqual(Array.from(await api.commitWinPos()), [11, 22]);
  api.decidePermission('perm-1', 'deny');
  api.launchCodeWhale();
  await api.launchAgentChecked('codex');
  await api.refreshModelPrices();
  api.setPriceAutoUpdate(false, 48);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert(calls.some((call) => call.command === 'set_language' && call.args.lang === 'ja'));
  assert(calls.some((call) => call.command === 'set_mode' && call.args.mode === 'panel'));
  assert(calls.some((call) => call.command === 'set_win_pos' && call.args.x === 11 && call.args.y === 22));
  assert(calls.some((call) => call.command === 'commit_win_pos'));
  assert(calls.some((call) => call.command === 'decide_permission' && call.args.permId === 'perm-1' && call.args.behavior === 'deny'));
  assert(calls.some((call) => call.command === 'launch_agent' && call.args.provider === 'codewhale'));
  assert(calls.some((call) => call.command === 'launch_agent' && call.args.provider === 'codex'));
  assert(calls.some((call) => call.command === 'refresh_model_prices'));
  assert(calls.some((call) => call.command === 'set_price_auto_update' && call.args.enabled === false && call.args.refreshHours === 48));

  // A malformed/unavailable native event layer may throw before returning a
  // Promise. Subscribing must remain a no-op instead of escaping into UI code.
  throwChannels.add('panel:hidden');
  const offFailed = api.onPanelHidden(() => {});
  assert.strictEqual(typeof offFailed, 'function');
  offFailed();
  throwChannels.delete('panel:hidden');
  assert(loggedErrors.some((args) => String(args[0]).includes('listen panel:hidden failed')),
    'synchronous listen failure must be contained and logged');

  let payload = null;
  const off = api.onStats((value) => { payload = value; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  listeners.get('pet:stats')({ payload: { sessions: [{ sessionId: 's1' }] } });
  assert.strictEqual(payload.sessions[0].sessionId, 's1');
  off();
  assert(!listeners.has('pet:stats'), 'unsubscribe must detach Tauri event listener');

  // All bridge-owned listeners must detach on WebView teardown. Tauri's
  // listen() resolves asynchronously, so also cover the race where the native
  // unlisten handle arrives after beforeunload has already fired.
  let resolveLate;
  deferredListeners.set('panel:shown', {
    promise: new Promise((resolve) => { resolveLate = resolve; }),
  });
  api.onPrice(() => {});
  api.onPanelShown(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const beforeUnload = (windowHandlers.get('beforeunload') || [])[0];
  assert.strictEqual(typeof beforeUnload, 'function', 'bridge must own beforeunload cleanup');
  beforeUnload();
  let lateDetached = false;
  resolveLate(() => {
    lateDetached = true;
    listeners.delete('panel:shown');
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(lateDetached, 'late listen resolution must immediately unlisten after teardown');
  assert(!listeners.has('panel:price'), 'beforeunload must detach active subscriptions');
  assert(!listeners.has('panel:shown'), 'beforeunload must detach late subscriptions');

  console.log('tauri-bridge-smoke: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
