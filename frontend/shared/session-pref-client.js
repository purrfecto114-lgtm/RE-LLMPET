(function initSessionPrefClient(global) {
  'use strict';

  function save(api, sessionId, action, enabled, pinned, archived) {
    if (api && typeof api.setSessionPref === 'function') {
      return api.setSessionPref(
        sessionId,
        action === 'pin' ? enabled : null,
        action === 'archive' ? enabled : null,
      );
    }
    if (api && typeof api.setSessionPrefs === 'function') {
      return api.setSessionPrefs(Array.from(pinned), Array.from(archived));
    }
    return Promise.reject(new Error('session preference bridge is unavailable'));
  }

  global.OctoSessionPrefs = Object.freeze({ save });
})(window);
