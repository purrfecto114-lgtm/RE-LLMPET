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
  // Wander needs a provider whose CLI can execute a headless web mission.
  // The Rust side currently implements claude / codex / codewhale runners;
  // opencode and aider are launched differently and are rejected there.
  // When the pet resolves to one of those (or the neutral 'aggregate'
  // bucket), degrade to the first ENABLED supported provider instead of
  // failing the click.
  const WANDER_SUPPORTED = ['claude', 'codex', 'codewhale'];

  function ownerKeyFor(agent) {
    return agent === 'codex' ? 'pet-codex' : 'pet';
  }

  function create({ api, bubble, close, provider, agent, enabledProviders }) {
    const wander = document.getElementById('sl-wander');
    const status = document.getElementById('sl-travel-status');
    let state = null;

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
      if (wander) wander.textContent = active ? '⏹ 取消旅行' : '🐾 闲逛';
      if (!status) return;
      const badges = `${'🌿'.repeat(Number(growth.leaves) || 0)}${'⭐'.repeat(Number(growth.stars) || 0)}${'🌙'.repeat(Number(growth.moons) || 0)}${Number(growth.days) ? `☀️×${growth.days}` : ''}`;
      status.textContent = active
        ? `🧳 ${active.project || active.mode} · ${Math.max(0, Math.floor((Date.now() - active.startedAt) / 60000))} min`
        : badges
          ? `成长 ${badges} · ${(Number(growth.totalTokens) || 0).toLocaleString()} tokens`
          : '每 10k 旅行 token 长出一片叶子';
    }

    async function toggle() {
      try {
        if (activeTripForPet(state)) {
          await api.cancelTravel();
          bubble('⏹ 正在取消旅行…', 2400, true);
          return;
        }
        let target = typeof provider === 'function' ? provider() : provider;
        // R50: degrade unsupported/neutral resolutions to the first
        // supported enabled provider instead of erroring out.
        if (!target || !WANDER_SUPPORTED.includes(target)) {
          const enabled = (typeof enabledProviders === 'function' ? enabledProviders() : null) || [];
          target = WANDER_SUPPORTED.find((id) => enabled.includes(id)) || null;
        }
        if (!target) throw new Error('no wander-capable provider enabled (claude/codex/codewhale)');
        const result = await api.startWander('在公开网络上寻找一个值得开发者今天了解的新工具、方法或趋势', target);
        update(result);
        bubble(`🐾 出门闲逛啦（${target}），回来会带明信片！`, 3600, true);
        close();
      } catch (error) {
        bubble(`⚠️ 闲逛失败：${String(error && (error.message || error) || 'unknown')}`, 5000, true);
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
