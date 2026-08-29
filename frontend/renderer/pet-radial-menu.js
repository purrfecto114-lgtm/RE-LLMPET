'use strict';

window.OctoPetRadialMenu = (() => {
  function claimRightPointer(event, owner) {
    if (event.button !== 2) return false;
    event.preventDefault();
    event.stopPropagation();
    owner.claimInput();
    return true;
  }

  function toggleRadialContext(event, owner) {
    event.preventDefault();
    event.stopPropagation();
    owner.toggle();
    return true;
  }

  function create(owner) {
    const menu = [
      { ic: 'chart', key: 'menu.panel', act: () => window.pet.openPanel() },
      { ic: 'mask', key: 'menu.skin', act: owner.toggleSkin },
      { ic: 'hand', key: 'menu.pending', badge: true, act: () => window.pet.openPanel() },
      { ic: 'zombie', key: 'menu.background', badgeBg: true, act: () => window.pet.openPanel() },
      { ic: 'doc', key: 'menu.log', act: () => window.pet.openLog() },
      { ic: 'search', key: 'menu.patrol', when: owner.territorySupported, act: () => window.pet.territoryRunNow() },
      { ic: 'bell', key: 'menu.mute', act: () => window.pet.toggleMute() },
      { ic: 'coins', key: 'currency', act: owner.toggleCurrency },
      { ic: 'power', key: 'menu.quit', act: () => window.pet.quit() },
    ];

    function visibleItems() {
      return menu.filter((item) => !item.when || item.when());
    }

    function build() {
      const radial = owner.radial;
      radial.innerHTML = '';
      const anchor = document.getElementById('pet-anchor');
      const element = anchor || owner.currentSkin();
      const sr = owner.stage.getBoundingClientRect();
      const er = element.getBoundingClientRect();
      const cx = er.left - sr.left + er.width / 2;
      const cy = er.top - sr.top + er.height / 2;
      const items = visibleItems();
      const radius = 78;
      const startA = 192;
      const endA = 348;
      items.forEach((item, index) => {
        const angle = ((startA + (endA - startA) * (items.length === 1 ? 0.5 : index / (items.length - 1))) * Math.PI) / 180;
        const x = cx + radius * Math.cos(angle);
        const y = cy + radius * Math.sin(angle);
        const button = document.createElement('div');
        button.className = 'radial-item';
        button.style.left = Math.max(23, Math.min(sr.width - 23, x)) + 'px';
        button.style.top = Math.max(23, Math.min(sr.height - 23, y)) + 'px';
        button.style.transitionDelay = index * 0.03 + 's';
        const label = item.key === 'currency' ? owner.currencyLabel() : owner.t(item.key);
        const iconName = item.key === 'menu.mute' ? (owner.muted() ? 'bell-off' : 'bell')
          : item.key === 'currency' ? (owner.currency() === 'CNY' ? 'yen' : 'coins') : item.ic;
        const icon = (window.OctoIcons && window.OctoIcons.icon(iconName)) || '';
        button.innerHTML = `<span class="ri-ic oi">${icon}</span><span class="ri-lb">${label}</span>`;
        appendBadge(button, item);
        button.addEventListener('click', (event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          owner.close();
          item.act();
        });
        button.addEventListener('contextmenu', (event) => toggleRadialContext(event, owner));
        radial.appendChild(button);
      });
    }

    function appendBadge(node, item) {
      const count = item.badge ? owner.waitingCount() : item.badgeBg ? owner.backgroundCount() : 0;
      if (!(item.badge || item.badgeBg) || count <= 0) return;
      const badge = document.createElement('span');
      badge.className = 'ri-badge';
      badge.textContent = count;
      node.appendChild(badge);
    }

    function updateBadges() {
      const nodes = owner.radial.querySelectorAll('.radial-item');
      visibleItems().forEach((item, index) => {
        if (!item.badge && !item.badgeBg) return;
        const node = nodes[index];
        if (!node) return;
        const count = item.badge ? owner.waitingCount() : owner.backgroundCount();
        let badge = node.querySelector('.ri-badge');
        if (count > 0) {
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'ri-badge';
            node.appendChild(badge);
          }
          badge.textContent = count;
        } else if (badge) {
          badge.remove();
        }
      });
    }

    owner.radial.addEventListener('pointerdown', (event) => claimRightPointer(event, owner));
    owner.radial.addEventListener('contextmenu', (event) => toggleRadialContext(event, owner));
    return { build, updateBadges };
  }

  return { create, claimRightPointer, toggleRadialContext };
})();
