'use strict';

// R59: expression studio controller (renderer/expressions.html).
//
// The window reuses tauri-bridge.js (`window.pet`) like the panel. The
// override table comes from get_custom_expressions + expressions:changed
// events; uploads read the picked file in the WebView and post base64 to
// save_custom_expression (the backend validates state/ext/size/magic).
// Interaction feedback is explicit on every action (disabled while
// in-flight, localized toast on success/failure) — the 0.6.x "按钮缺必要
// 交互" audit item applies here too.

(function () {
  const i18n = window.OctoI18n;
  const t = (key, vars) => (i18n ? i18n.t(key, vars) : key);
  const pet = window.pet;
  const states = window.OctoStates || { RENDER_STATE_WORDS: [] };
  const skinPacks = window.OctoPetSkinPacks;
  const toast = window.reLlmpetToast;

  const LOCALES = { zh: 'zh-CN', en: 'en', ja: 'ja' };
  let lang = 'zh';
  let skin = 'mascot';
  let snapshot = { enabled: false, states: {} };
  const previews = new Map(); // state -> { kind: 'custom'|'default'|'placeholder', src? }
  let busy = false;

  const grid = document.getElementById('grid');
  const enableEl = document.getElementById('enable');
  const countEl = document.getElementById('states-count');
  const langEl = document.getElementById('language');
  const closeEl = document.getElementById('close');

  function log(tag, message) {
    try { console.log('[expressions:' + tag + '] ' + message); } catch (_) {}
  }

  function applyLanguage(next) {
    lang = i18n ? i18n.setLang(next) : 'zh';
    document.documentElement.lang = LOCALES[lang] || 'zh-CN';
    document.querySelectorAll('[data-i18n]').forEach((node) => {
      node.textContent = t(node.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-title]').forEach((node) => {
      node.title = t(node.dataset.i18nTitle);
    });
    document.title = t('expr.title');
    if (langEl && langEl.value !== lang) langEl.value = lang;
    renderGrid();
  }

  // ── preview resolution ─────────────────────────────────────────────────
  // Override first; otherwise the active meme skin's bundled asset (the
  // studio is a settings window, so it previews the PRIMARY pet's skin);
  // mascot/pixel have no <img> pack table — placeholder.
  function defaultPreviewSrc(state) {
    if (!skinPacks) return null;
    try {
      const pack = skinPacks.packOf(skin);
      const file = (pack && pack.states && (pack.states[state] || pack.states.idle));
      if (file && pack.dir) return `../assets/${pack.dir}/${file}`;
    } catch (_) {}
    return null;
  }

  function refreshPreviews() {
    const overrideStates = snapshot.states || {};
    for (const state of states.RENDER_STATE_WORDS) {
      const override = overrideStates[state];
      if (override) {
        previews.set(state, { kind: 'custom', label: override.file, size: override.sizeBytes });
      } else {
        const src = defaultPreviewSrc(state);
        previews.set(state, src ? { kind: 'default', src } : { kind: 'placeholder' });
      }
    }
  }

  function fmtSize(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
  }

  // ── grid rendering ─────────────────────────────────────────────────────
  function renderGrid() {
    if (!grid) return;
    refreshPreviews();
    const overrideStates = snapshot.states || {};
    const customCount = Object.keys(overrideStates).length;
    if (countEl) countEl.textContent = t('expr.count', { count: customCount });
    grid.textContent = '';
    for (const state of states.RENDER_STATE_WORDS) {
      const info = previews.get(state) || { kind: 'placeholder' };
      const isCustom = info.kind === 'custom';
      const cell = document.createElement('div');
      cell.className = 'state' + (isCustom ? ' custom' : '');
      cell.setAttribute('role', 'listitem');

      const preview = document.createElement('div');
      preview.className = 'preview';
      const img = document.createElement('img');
      img.alt = state;
      if (isCustom) {
        // Lazy: load the data: URL from the backend; a failure keeps the
        // checkerboard placeholder (never a broken-image icon).
        pet.readCustomExpression(state).then((url) => {
          if (typeof url === 'string' && url.startsWith('data:')) img.src = url;
        }).catch(() => {});
      } else if (info.kind === 'default' && info.src) {
        img.src = info.src;
      } else {
        img.remove();
        const ph = document.createElement('span');
        ph.className = 'placeholder';
        ph.textContent = '🖼️';
        ph.setAttribute('aria-hidden', 'true');
        preview.appendChild(ph);
      }
      if (img.parentNode !== preview) preview.appendChild(img);
      cell.appendChild(preview);

      const name = document.createElement('div');
      name.className = 'state-name';
      name.textContent = state;
      name.title = t('expr.state.' + state);
      cell.appendChild(name);

      const label = document.createElement('div');
      label.className = 'state-label';
      label.textContent = t('expr.state.' + state);
      cell.appendChild(label);

      if (isCustom && info.size) {
        const size = document.createElement('div');
        size.className = 'size';
        size.textContent = fmtSize(info.size);
        cell.appendChild(size);
      }

      const actions = document.createElement('div');
      actions.className = 'state-actions';

      const uploadLabel = document.createElement('label');
      uploadLabel.className = 'upload';
      if (isCustom) uploadLabel.title = t('expr.replace');
      else uploadLabel.title = t('expr.upload');
      uploadLabel.textContent = isCustom ? t('expr.replace') : t('expr.upload');
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/gif,image/png,image/webp,image/jpeg';
      input.addEventListener('change', () => {
        if (input.files && input.files.length) void saveFile(state, input.files[0]);
        input.value = '';
      });
      uploadLabel.appendChild(input);
      actions.appendChild(uploadLabel);

      if (isCustom) {
        const remove = document.createElement('button');
        remove.className = 'remove';
        remove.type = 'button';
        remove.textContent = t('expr.remove');
        remove.addEventListener('click', () => void clearState(state, remove));
        actions.appendChild(remove);
      }
      cell.appendChild(actions);
      grid.appendChild(cell);
    }
  }

  // ── actions (each with visible in-flight state + localized toast) ──────
  function setBusy(on) {
    busy = on;
    if (enableEl) enableEl.disabled = on;
    grid.querySelectorAll('.upload, .remove').forEach((el) => { el.disabled = on; });
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000; // avoid String.fromCharCode.apply arg limits
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function extForFile(file) {
    const type = (file.type || '').toLowerCase();
    if (type === 'image/gif') return 'gif';
    if (type === 'image/png') return 'png';
    if (type === 'image/webp') return 'webp';
    if (type === 'image/jpeg' || type === 'image/jpg') return 'jpg';
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.gif')) return 'gif';
    if (name.endsWith('.png')) return 'png';
    if (name.endsWith('.webp')) return 'webp';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'jpg';
    return null;
  }

  async function saveFile(state, file) {
    if (busy) return;
    const ext = extForFile(file);
    if (!ext) {
      toastFeedback(t('expr.unsupportedType'), true);
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toastFeedback(t('expr.tooLarge', { size: fmtSize(file.size) }), true);
      return;
    }
    setBusy(true);
    try {
      const buffer = await file.arrayBuffer();
      const dataBase64 = arrayBufferToBase64(buffer);
      const next = await pet.saveCustomExpression(state, dataBase64, ext);
      if (next && typeof next === 'object') snapshot = next;
      renderGrid();
      toastFeedback(t('expr.saved', { state }), false);
    } catch (error) {
      log('save', String(error && (error.message || error) || 'unknown'));
      toastFeedback(t('expr.saveFailed', { error: String(error && (error.message || error) || 'unknown') }), true);
    } finally {
      setBusy(false);
    }
  }

  async function clearState(state, button) {
    if (busy) return;
    setBusy(true);
    if (button) button.disabled = true;
    try {
      const next = await pet.clearCustomExpression(state);
      if (next && typeof next === 'object') snapshot = next;
      renderGrid();
      toastFeedback(t('expr.removed', { state }), false);
    } catch (error) {
      log('clear', String(error && (error.message || error) || 'unknown'));
      toastFeedback(t('expr.removeFailed', { error: String(error && (error.message || error) || 'unknown') }), true);
    } finally {
      setBusy(false);
    }
  }

  function toastFeedback(message, isError) {
    if (toast && typeof toast.show === 'function') {
      toast.show(message, { command: 'expressions', timeout: isError ? 6000 : 3200 });
    } else {
      log('toast', message);
    }
  }

  // ── wiring ─────────────────────────────────────────────────────────────
  if (enableEl) {
    enableEl.addEventListener('change', async () => {
      const next = !!enableEl.checked;
      enableEl.disabled = true;
      try {
        const result = await pet.setCustomExpressionsEnabled(next);
        if (result && typeof result === 'object') snapshot = result;
        toastFeedback(t(next ? 'expr.enabledToast' : 'expr.disabledToast'), false);
      } catch (error) {
        enableEl.checked = !next; // revert on failure
        toastFeedback(t('expr.toggleFailed', { error: String(error && (error.message || error) || 'unknown') }), true);
      } finally {
        enableEl.disabled = false;
      }
    });
  }

  if (closeEl) {
    closeEl.addEventListener('click', () => {
      void pet.closeExpressions().catch(() => {});
    });
  }

  if (langEl) {
    langEl.addEventListener('change', () => {
      const next = langEl.value;
      applyLanguage(next);
      void pet.setLanguage(next).catch(() => {});
    });
  }

  // Keep the grid live while the pet window saves changes elsewhere (both
  // windows share the expressions:changed broadcast).
  if (pet && typeof pet.onExpressionsChanged === 'function') {
    pet.onExpressionsChanged((next) => {
      if (next && typeof next === 'object') {
        snapshot = next;
        if (enableEl) enableEl.checked = !!snapshot.enabled;
        renderGrid();
      }
    });
  }

  // ── boot ───────────────────────────────────────────────────────────────
  (async () => {
    try {
      const cfg = await pet.getConfig();
      if (cfg) {
        if (typeof cfg.lang === 'string') lang = cfg.lang;
        if (typeof cfg.skin === 'string') skin = cfg.skin;
      }
      const next = await pet.getCustomExpressions();
      if (next && typeof next === 'object') snapshot = next;
    } catch (error) {
      log('boot', String(error && (error.message || error) || 'unknown'));
    }
    if (enableEl) enableEl.checked = !!snapshot.enabled;
    applyLanguage(lang);
  })();
})();
