'use strict';

// R50 (2026-08-30): dual pets must not share one wander trip. The backend
// snapshot exposes `active` as an owner-keyed map ({"pet": …, "pet-codex": …})
// plus the legacy `activeTrip` (first trip of ANY owner). The previous code
// read only `activeTrip`, so after either pet started a trip BOTH pets'
// HUDs showed "⏹ 取消旅行" and the same status line — wander looked
// identical on both pets. Resolve the trip for THIS pet's owner window first
// and only fall back to `activeTrip` when the owner map is absent (older
// backend payload).
window.OctoPetTravelView = (() => {
  // R59: this list is now a STALE-PAYLOAD FALLBACK only. The authoritative
  // wander-capable set travels with the backend config snapshot
  // (cfg.wanderSupported — model.rs injects travel.rs's single source, which
  // gained opencode + aider runners in R59); pet.js passes it in as
  // supported(). The mirror exists so an old-backend payload (no field)
  // still degrades sensibly. Cross-checked by the R59 smoke test.
  const WANDER_SUPPORTED = ['claude', 'codex', 'codewhale', 'opencode', 'aider'];

  function ownerKeyFor(agent) {
    // R58-IMPL-C: window-identity aware — the second pet is 'pet-codex'
    // (label semantics); the legacy 'codex' bucket value still maps to the
    // second window for pre-R58 callers.
    return agent === 'codex' || agent === 'pet-codex' ? 'pet-codex' : 'pet';
  }

  function create({ api, bubble, close, provider, agent, enabledProviders, supported }) {
    const wander = document.getElementById('sl-wander');
    const status = document.getElementById('sl-travel-status');
    let state = null;

    // R59: shared/i18n.js is loaded by pet.html before this module; the
    // travel UI texts were zh-only literals (RV-8 P1 residue).
    const t = (key, vars) =>
      (window.OctoI18n && window.OctoI18n.t(key, vars)) || key;
    const supportedList = () => {
      const fromConfig = typeof supported === 'function' ? supported() : null;
      return Array.isArray(fromConfig) && fromConfig.length ? fromConfig : WANDER_SUPPORTED;
    };

    function activeTripForPet(snapshot) {
      const ownerMap = snapshot && snapshot.active;
      if (ownerMap && typeof ownerMap === 'object') {
        const own = ownerMap[ownerKeyFor(agent)];
        if (own) return own;
        // Owner map present but this pet has no trip — do NOT borrow another
        // pet's trip; report "no active trip" for this window.
        return null;
      }
      return (snapshot && snapshot.activeTrip) || null;
    }

    function update(next) {
      if (next) state = next;
      const snapshot = state || {};
      const active = activeTripForPet(snapshot);
      const growth = snapshot.growth || {};
      // P5-3 fix (R2): if a terminal event (completed/failed/cancelled)
      // arrives for a trip whose id doesn't match the currently-active
      // trip, ignore it. This prevents stale cancel events from a
      // fast cancel→new-start race from showing a cancel bubble over an
      // active trip. The `tripId` field was added in R2 to the Rust
      // pet:travel emit alongside the existing `trip` object.
      const eventTripId = snapshot.tripId;
      const activeId = active && active.id;
      if (eventTripId && activeId && eventTripId !== activeId) return;
      if (wander) wander.textContent = active ? t('sess.cancelTravel') : t('sess.wander');
      if (!status) return;
      const badges = `${'🌿'.repeat(Number(growth.leaves) || 0)}${'⭐'.repeat(Number(growth.stars) || 0)}${'🌙'.repeat(Number(growth.moons) || 0)}${Number(growth.days) ? `☀️×${growth.days}` : ''}`;
      status.textContent = active
        ? t('sess.travelStatusActive', { project: active.project || active.mode, minutes: Math.max(0, Math.floor((Date.now() - active.startedAt) / 60000)) })
        : badges
          ? t('sess.travelStatusGrowth', { badges, tokens: (Number(growth.totalTokens) || 0).toLocaleString() })
          : t('sess.travelStatusIdle');
    }

    async function toggle() {
      try {
        if (activeTripForPet(state)) {
          await api.cancelTravel();
          bubble(t('bubble.wanderCanceling'), 2400, true);
          return;
        }
        // R58-IMPL-C: provider() resolves this pet's own provider (the
        // second pet resolves to config.duoProvider via
        // runtime-policy.resolveProvider in pet.js); the bridge attaches the
        // initiating window label as the trip owner, so degraded trips stay
        // on THIS window.
        //
        // R59 ("闲逛还是不可用" root cause 1): the old frontend gate threw a
        // hard error unless one of the supported providers was also ENABLED in config — stricter than the backend,
        // which degrades across every INSTALLED runner (enabled or not) and
        // pre-checks CLI existence. opencode/aider-only users could never
        // reach the backend fallback. Now the frontend only forwards the
        // pet's own provider when it has a runner, and otherwise passes null
        // so pick_wander_provider() decides with the full candidate ladder
        // (requester → enabled → installed). The backend also re-checks the
        // set from its single source, so the stale mirror above can never
        // widen the real capability.
        let target = typeof provider === 'function' ? provider() : provider;
        if (!target || !supportedList().includes(target)) target = null;
        // R59: mission=null lets the backend pick a RANDOM trilingual
        // mission (the fixed Chinese mission made every wander identical
        // and left the backend picker as dead code).
        const result = await api.startWander(null, target);
        update(result);
        const own = activeTripForPet(result);
        const used = (own && own.provider) || target || '';
        bubble(t('bubble.wanderStartWith', { provider: used }), 3600, true);
        close();
      } catch (error) {
        const message = String(error && (error.message || error) || 'unknown');
        bubble(t('bubble.wanderFailDetail', { error: message }), 5000, true);
      }
    }

    if (wander) wander.addEventListener('click', (event) => {
      event.stopPropagation();
      void toggle();
    });
    return { update };
  }

  return { create, ownerKeyFor, WANDER_SUPPORTED };
})();
