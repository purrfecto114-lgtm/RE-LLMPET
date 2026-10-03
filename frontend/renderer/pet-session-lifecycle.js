'use strict';

window.OctoPetSessionLifecycle = (() => {
  function create(owner) {
    function open() {
      if (owner.radialOpen()) owner.closeRadial();
      if (owner.todoOpen()) owner.closeTodo();
      if (owner.providerChooserOpen()) owner.closeProviderChooser();
      owner.hideAsk();
      owner.render();
      owner.element.classList.remove('hidden');
      owner.setOpen(true);
      owner.syncBusy();
      owner.log('sesslist', `open ${owner.visibleCount()}`);
      owner.fit(owner.element);
    }

    function close() {
      if (!owner.isOpen()) return;
      owner.element.classList.add('hidden');
      owner.setOpen(false);
      owner.syncBusy();
      owner.log('sesslist', 'close');
      owner.resetSize();
    }

    function toggle() {
      if (owner.isOpen()) close();
      else open();
    }

    return { open, close, toggle };
  }

  return { create };
})();
