'use strict';

window.OctoPetTravelView = (() => {
  function create({ api, bubble, close, provider }) {
    const wander = document.getElementById('sl-wander');
    const status = document.getElementById('sl-travel-status');
    let state = null;

    function update(next) {
      if (next) state = next;
      const snapshot = state || {};
      const active = snapshot.active;
      const growth = snapshot.growth || {};
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
        if (state && state.active) {
          await api.cancelTravel();
          bubble('⏹ 正在取消旅行…', 2400, true);
          return;
        }
        const result = await api.startWander('在公开网络上寻找一个值得开发者今天了解的新工具、方法或趋势', provider);
        update(result);
        bubble('🐾 出门闲逛啦，回来会带明信片！', 3600, true);
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

  return { create };
})();
