'use strict';

// R44 0.5.45: i18n-aware travel view. Uses OctoI18n.t() for all user-visible strings.
window.OctoPetTravelView = (() => {
  function create({ api, bubble, close }) {
    const wander = document.getElementById('sl-wander');
    const status = document.getElementById('sl-travel-status');
    let state = null;

    function update(next) {
      if (next) state = next;
      const snapshot = state || {};
      const active = snapshot.active;
      const growth = snapshot.growth || {};
      const t = window.OctoI18n ? window.OctoI18n.t : (k) => k;
      if (wander) wander.textContent = active ? t('travel.cancel') : t('travel.wander');
      if (!status) return;
      const badges = `${'🌿'.repeat(Number(growth.leaves) || 0)}${'⭐'.repeat(Number(growth.stars) || 0)}${'🌙'.repeat(Number(growth.moons) || 0)}${Number(growth.days) ? `☀️×${growth.days}` : ''}`;
      if (active) {
        const min = Math.max(0, Math.floor((Date.now() - active.startedAt) / 60000));
        status.textContent = t('travel.active', { project: active.project || active.mode || '', min });
      } else if (badges) {
        status.textContent = t('travel.growthBadges', { badges, tokens: (Number(growth.totalTokens) || 0).toLocaleString() });
      } else {
        status.textContent = t('travel.hintLeaf');
      }
    }

    async function toggle() {
      const t = window.OctoI18n ? window.OctoI18n.t : (k) => k;
      try {
        if (state && state.active) {
          await api.cancelTravel();
          bubble(t('travel.cancelling'), 2400, true);
          return;
        }
        const result = await api.startWander(t('travel.wanderMission'));
        update(result);
        bubble(t('travel.wanderStart'), 3600, true);
        close();
      } catch (error) {
        const msg = String(error && (error.message || error) || 'unknown');
        bubble(t('travel.wanderFailed', { error: msg }), 5000, true);
      }
    }

    if (wander) wander.addEventListener('click', (event) => {
      event.stopPropagation();
      void toggle();
    });
    return { update };
  }

  return { create };
})();
