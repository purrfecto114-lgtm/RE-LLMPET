function renderSessList() {
  const list = sessionsForList();
  const renderSig = JSON.stringify({
    lang: window.OctoI18n.getLang(),
    search: sessionSearch,
    filter: sessionFilter,
    archived: showArchived,
    rows: list.map((s) => ({
      key: sessionKey(s),
      project: s.project,
      agent: s.agent,
      state: s.state,
      reason: s.reason,
      op: s.op,
      badge: s.badge,
      contextPercent: s.contextPercent,
      sessionId: s.sessionId,
      pinned: pinnedSessionIds.includes(sessionKey(s)),
      archived: archivedSessionIds.includes(sessionKey(s)),
    })),
  });
  if (renderSig === lastSessListRenderSig) return false;
  lastSessListRenderSig = renderSig;
  const previousScrollTop = slRows.scrollTop;
  slSub.textContent = list.length ? t('sess.count', { n: list.length }) : '';
  if (!list.length) {
    slRows.innerHTML = '';
    const e = document.createElement('div');
    e.className = 'sl-empty';
    e.textContent = t('sess.empty');
    slRows.appendChild(e);
    return true;
  }
  const existingRows = new Map();
  for (const child of [...slRows.children]) {
    const key = child.dataset && child.dataset.sessionKey;
    if (key) existingRows.set(key, child);
    else child.remove();
  }
  const retainedKeys = new Set();
  for (const [index, session] of list.entries()) {
    const key = sessionKey(session);
    const row = existingRows.get(key) || createSessRow();
    retainedKeys.add(key);
    updateSessRow(row, session);
    const currentAtIndex = slRows.children[index] || null;
    if (currentAtIndex !== row) {
      if (typeof slRows.insertBefore === 'function') slRows.insertBefore(row, currentAtIndex);
      else if (!row.parentNode) slRows.appendChild(row);
    }
  }
  for (const [key, row] of existingRows) {
    if (!retainedKeys.has(key)) row.remove();
  }
  // Preserve reading position even when rows are added, removed, or reordered.
  const maxScrollTop = Math.max(
    0,
    (Number(slRows.scrollHeight) || 0) - (Number(slRows.clientHeight) || 0),
  );
  slRows.scrollTop = Math.min(Number(previousScrollTop) || 0, maxScrollTop);
  return true;
}

function setTakeoverStatus(text, kind = '') {
  slTakeoverStatus.textContent = text || '';
  slTakeoverStatus.className = 'sl-takeover-status' + (kind ? ' ' + kind : '');
}

function takeoverResultText(result, target) {
  const code = result && result.code;
  if (code === 'native-fork') return t('takeover.nativeFork');
  if (code === 'native-resume') return t('takeover.nativeResume');
  if (code === 'handoff-launched') return t('takeover.handoffLaunched');
  if (code === 'invalid-target') return t('takeover.invalidTarget');
  if (code === 'invalid-provider') return t('takeover.invalidProvider');
  if (code === 'cli-missing') return t('takeover.cliMissing', { who: target === 'codex' ? 'Codex' : 'Claude' });
  return t('takeover.launchFailed');
}

