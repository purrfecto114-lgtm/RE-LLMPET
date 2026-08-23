function perfNow() {
  return Date.now();
}

// ---------- 统计 + 聚合状态 ----------
let lastStats = null; // 最近一次快照：transient 到期时用它立即重算聚合态
let sayToken = 0;     // say 接棒 happy 的排队令牌（新事件作废旧排队）
function compactTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
function applyStats(s) {
  if (!s) return;
  lastStats = s;
  if (s.billingAvailable === false) {
    chipCost.textContent = '—';
    chipWindow.textContent = '';
    chipWindow.title = '';
    chipSep.classList.add('hidden');
    chipWindow.classList.add('hidden');
  } else {
    chipCost.textContent = '$' + (s.today.cost || 0).toFixed(3);
    chipWindow.textContent = t('chip.lifetime', { cost: (s.lifetime.cost || 0).toFixed(3) });
    chipSep.classList.remove('hidden');
    chipWindow.classList.remove('hidden');
  }
  lastWaiting = (s.waitingCount || 0) + (s.needsinputCount || 0); // 待处理徽标含「等你回复」
  lastBgZombie = (s.bg && s.bg.zombie) || 0;
  if (radialOpen) updateRadialBadge();
  renderSessions(s.sessions || []);
  updateNotepad(s); // 记事本：行动清单 + 待办
  if (sessListOpen) {
    // Sub-pages own their DOM while open. A stats push must not rebuild the
    // hidden session page or resize the window underneath the current page.
    if (!takeoverTarget) {
      renderSessList();
      fitPopup(sesslist);
    }
  } // HUD 开着时随快照刷新并重定高

  // 选项面板：按快照重建队列（多任务都在、标明项目；防漏事件/启动时已在等待）
  refreshAsk(s);

  if (DEBUG_STATE) { setState(DEBUG_STATE); return; }

  // 你正在看面板/打字 → 不再改小章鱼状态(别动来动去打断你)，安静等你答完
  if (isInteracting()) return;

  // 聚合梯子，对齐 STATES.md 的优先级表：
  //   waiting > 短暂态 > error(8) > needsinput/notification(7) > sweeping(6)
  //   > juggling(4) > working(3) > thinking(2) > idle(1) > sleeping(0)
  // 之前 working 排在 needsinput 前面，多会话时「等你回复」被干活态彻底盖住。
  if (s.waitingCount > 0) {
    setState('waiting');
  } else if (perfNow() < transientUntil) {
    setState(transientState);
  } else if (s.errorCount > 0) {
    setState('error'); // 有会话卡在 API 错误 → 瘫倒，直到该会话恢复或 oneshot 衰减
  } else if (s.needsinputCount > 0) {
    setState('needsinput');
  } else if (s.sweepingCount > 0) {
    setState('sweeping');
  } else if (s.jugglingCount > 0) {
    setState('juggling');
  } else if (s.workingCount > 0) {
    setState('working');
  } else if (s.thinkingCount > 0) {
    setState('thinking');
  } else if (s.loafingCount > 0) {
    setState('loafing'); // 工具间隙：上一步干完等下一步 → 摸鱼
  } else if (s.idleMs == null || s.idleMs > IDLE_SLEEP_MS) {
    // idleMs=null 表示已无任何活跃会话——什么都没发生就该睡觉；
    // 之前 null 落到 idle，桌宠永不入睡，睡着后会话被回收还会凭空惊醒。
    setState('sleeping');
  } else {
    setState('idle');
  }
}
window.pet.onStats(applyStats);

function renderSessions(sessions) {
  // 与会话列表 HUD 完全联动：同一过滤(非 headless/非睡眠)、同一配色、同一排序。
  const list = (sessions || []).filter(isVisibleSession).sort((a, b) => {
    const pinA = pinnedSessionIds.includes(sessionKey(a)) ? 0 : 1;
    const pinB = pinnedSessionIds.includes(sessionKey(b)) ? 0 : 1;
    if (pinA !== pinB) return pinA - pinB;
    const pa = SESS_SORT[a.state] != null ? SESS_SORT[a.state] : 3;
    const pb = SESS_SORT[b.state] != null ? SESS_SORT[b.state] : 3;
    return pa !== pb ? pa - pb : (a.idleMs || 0) - (b.idleMs || 0);
  });
  const renderSig = JSON.stringify(list.map((s) => ({
    key: sessionKey(s),
    project: s.project,
    state: s.state,
    reason: s.reason,
    dot: sessionDotClass(s),
  })));
  if (renderSig === lastSessionDotsRenderSig) {
    if (radialOpen) updateRadialBadge();
    return false;
  }
  lastSessionDotsRenderSig = renderSig;
  sessionsEl.innerHTML = '';
  for (const s of list) {
    const d = document.createElement('div');
    d.className = 'sess-dot ' + sessionDotClass(s);
    const label = s.state === 'waiting' ? waitPhrase(s.reason) : (sessMeta(s.state) || s.state);
    d.title = `${s.project} · ${label}`;
    sessionsEl.appendChild(d);
  }
  // 菜单开着时同步「待处理」角标
  if (radialOpen) updateRadialBadge();
  return true;
}

window.pet.onConfig((cfg) => {
  if (!cfg) return;
  muted = !!cfg.muted;
  if (cfg.lang) applyLang(cfg.lang);
  if (cfg.skin) applySkin(cfg.skin);
  pinnedSessionIds = Array.isArray(cfg.pinnedSessions) ? cfg.pinnedSessions.slice() : [];
  archivedSessionIds = Array.isArray(cfg.archivedSessions) ? cfg.archivedSessions.slice() : [];
  if (sessListOpen && !takeoverTarget) renderSessList();
});

// Static markup carries its Chinese text inline (so the window is never blank
// before the first config push); data-i18n rewrites it once the language is
// known and again on every switch.
function applyStaticI18n() {
  document.documentElement.lang = window.OctoI18n.getLang();
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of document.querySelectorAll('[data-i18n-ph]')) {
    el.placeholder = t(el.dataset.i18nPh);
    delete el.dataset.ph; // drop the cached original so the warn/restore pair re-seeds
  }
}

function applyLang(next) {
  if (next === window.OctoI18n.getLang()) return;
  window.OctoI18n.setLang(next);
  applyStaticI18n();
  // refreshAsk() skips a re-render while the queue signature is unchanged; drop
  // the signature so an open card is relabelled instead of sitting in the old
  // language until its content happens to change.
  lastAskSig = '';
  lastTodoPopRenderSig = '';
  lastSessListRenderSig = '';
  lastSessionDotsRenderSig = '';
  // Live views rebuild from the state we already hold; everything else refreshes
  // on the stats push the main process fires right after the switch.
  if (sessListOpen) {
    if (takeoverTarget) openTakeoverPage(takeoverTarget);
    else renderSessList();
  }
  if (todoPopOpen) renderTodoPop();
  if (radialOpen) buildRadial();
  if (lastStats) applyStats(lastStats);
}

function applySkin(s) {
  skin = ['pixel', 'mascot', ...Object.keys(MEME_PACKS)].includes(s) ? s : 'mascot';
  document.body.classList.toggle('skin-pixel', skin === 'pixel');
  document.body.classList.toggle('skin-mascot', skin === 'mascot');
  document.body.classList.toggle('skin-cat', isMeme());
  if (skin === 'mascot') updateMascotEyes(state);
  if (isMeme()) updateCat(state);
  requestAnimationFrame(reportPetVisualBounds);
}

function reportPetVisualBounds() {
  const el = curSkinEl();
  if (!el) return;
  const r = el.getBoundingClientRect();
  try { window.pet.petVisualBounds({ x: r.left, y: r.top, width: r.width, height: r.height }); } catch {}
}

// ====================================================================
// 拖动 + 点击（短按=泡泡菜单 / 拖动=移动窗口）
// ====================================================================
let g = null; // 当前手势（同步建立，保证快速点击也能识别）
function clearDragGesture(gesture, settle = true) {
  if (!gesture || g !== gesture) return false;
  // Clear the global owner before releasePointerCapture(): Chromium may emit
  // lostpointercapture synchronously, and that event must not finish a newer
  // gesture or run the cleanup twice.
  g = null;
  try { gesture.el.releasePointerCapture(gesture.pid); } catch {}
  gesture.el.classList.remove('dragging');
  if (settle) setTimeout(settleEdgeLayout, 0);
  return true;
}

function cancelActiveDrag(settle = true) {
  const gesture = g;
  if (gesture) clearDragGesture(gesture, settle);
}

function attachDrag(el) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // A missed pointerup/lost-capture must never leak ownership into the next
    // press. This is especially important for a moving transparent window.
    cancelActiveDrag(false);
    try { el.setPointerCapture(e.pointerId); } catch {}
    el.classList.add('dragging');
    const gesture = { el, pid: e.pointerId, sx: e.screenX, sy: e.screenY, moved: false, win: null };
    g = gesture;
    window.pet.getWinPos().then(([wx, wy]) => {
      // IPC from an earlier click may resolve after a new pointerdown. Binding
      // that stale window origin to the new gesture produces a large jump.
      if (g === gesture) gesture.win = [wx, wy];
    }).catch(() => {});
  });
  el.addEventListener('pointermove', (e) => {
    const gesture = g;
    if (!gesture) return;
    if (e.pointerId != null && e.pointerId !== gesture.pid) return;
    // Transparent BrowserWindows can lose pointerup while they move. A later
    // hover has buttons=0; treat it as stale-capture cleanup, never as a drag.
    if (Number.isFinite(e.buttons) && (e.buttons & 1) === 0) {
      clearDragGesture(gesture);
      return;
    }
    const dx = e.screenX - gesture.sx;
    const dy = e.screenY - gesture.sy;
    if (!gesture.moved && Math.abs(dx) + Math.abs(dy) > 4) gesture.moved = true;
    if (gesture.moved && gesture.win) {
      if (radialOpen) closeRadial();
      movePetDuringDrag(gesture, e, gesture.win[0] + dx, gesture.win[1] + dy);
    }
  });
  el.addEventListener('pointerup', (e) => {
    const gesture = g;
    if (!gesture || (e.pointerId != null && e.pointerId !== gesture.pid)) return;
    const wasMove = gesture.moved;
    if (!clearDragGesture(gesture, wasMove)) return;
    if (wasMove) {
      // clearDragGesture schedules the final top/bottom or left/right anchor
      // exchange after the last setBounds has landed.
    } else {
      // 左键短按 = 会话列表 HUD（状态/会话名/上下文用量一览，点行聚焦该会话）。
      // 权限的允许/拒绝仍由 waiting 事件自动弹气泡，不走这里。
      if (radialOpen) closeRadial();
      else toggleSessList();
    }
  });
  el.addEventListener('pointercancel', (e) => {
    const gesture = g;
    if (!gesture || (e.pointerId != null && e.pointerId !== gesture.pid)) return;
    clearDragGesture(gesture);
  });
  el.addEventListener('lostpointercapture', (e) => {
    const gesture = g;
    if (!gesture || (e.pointerId != null && e.pointerId !== gesture.pid)) return;
    clearDragGesture(gesture);
  });
  // 右键 = 泡泡菜单
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    toggleRadial();
  });
}
stateEls.forEach(attachDrag);
window.addEventListener('blur', cancelActiveDrag);

// 卡片按钮：Submit/Next、Back、Go to Terminal、Other 输入
askSubmit.addEventListener('click', () => { const c = askQueue[askIdx]; if (c && c.kind === 'ask') elicNextOrSubmit(c); });
askBack.addEventListener('click', () => { const c = askQueue[askIdx]; if (c && c.kind === 'ask') elicBack(c); });
askTerm.addEventListener('click', () => { const c = askQueue[askIdx]; if (c) gotoSession(c); });
askText.addEventListener('input', () => updateSubmitEnabled());
// 自定义输入里按回车直接发送（仅 elicitation）；空内容不发、提示别忘了填
askText.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const c = askQueue[askIdx];
  if (!c || !elic) return;
  if (!(askText.value || '').trim()) { warnEmptyInput(); return; }
  if (askSubmit.classList.contains('disabled')) { warnEmptyInput(); return; }
  elicNextOrSubmit(c);
});
// 鼠标在面板上 = 交互中（配合 isInteracting 冻结轮询）
askEl.addEventListener('pointerenter', () => { askHover = true; });
askEl.addEventListener('pointerleave', () => { askHover = false; });

// 记事本：点击开/关 行动清单弹层
notepad.addEventListener('click', (e) => { e.stopPropagation(); todoPopOpen ? closeTodoPop() : openTodoPop(); });
notepad.addEventListener('contextmenu', (e) => e.stopPropagation());
document.getElementById('tp-close').addEventListener('click', (e) => { e.stopPropagation(); closeTodoPop(); });

// 会话列表 HUD：关闭 + 底部操作（新开按钮按本窗口的 agent 分流）
document.getElementById('sl-close').addEventListener('click', (e) => { e.stopPropagation(); closeSessList(); });
if (slTakeoverClaude) slTakeoverClaude.addEventListener('click', (e) => {
  e.stopPropagation();
  runTakeover('claude');
});
if (slTakeoverCodex) slTakeoverCodex.addEventListener('click', (e) => {
  e.stopPropagation();
  runTakeover('codex');
});
slBack.addEventListener('click', (e) => { e.stopPropagation(); showSessionPage(); });
slSearch.addEventListener('input', () => {
  sessionSearch = slSearch.value || '';
  resetSessionListOrder();
  renderSessList();
  fitPopup(sesslist);
});
slSearch.addEventListener('focus', () => window.pet.focusPet());
slSearch.addEventListener('blur', () => window.pet.blurPet());
slFilters.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  e.stopPropagation();
  if (btn === slArchivedToggle) {
    showArchived = !showArchived;
    btn.classList.toggle('active', showArchived);
  } else if (btn.dataset.filter) {
    sessionFilter = btn.dataset.filter;
    slFilters.querySelectorAll('[data-filter]').forEach((el) => el.classList.toggle('active', el === btn));
  }
  resetSessionListOrder();
  renderSessList();
  fitPopup(sesslist);
});
const slNewBtn = document.getElementById('sl-new');
const slNewCodexBtn = document.getElementById('sl-new-codex');
const slNewDshBtn = document.getElementById('sl-new-dsh');
// 单宠多后端：三个入口都能开
if (slNewCodexBtn) slNewCodexBtn.classList.remove('hidden');
if (slNewDshBtn) slNewDshBtn.classList.remove('hidden');
slNewBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  window.pet.launchClaude();
  closeSessList();
});
if (slNewCodexBtn) slNewCodexBtn.addEventListener('click', (e) => { e.stopPropagation(); window.pet.launchCodex(); closeSessList(); });
if (slNewDshBtn) slNewDshBtn.addEventListener('click', (e) => { e.stopPropagation(); window.pet.launchDsh(); closeSessList(); });
document.getElementById('sl-archive').addEventListener('click', (e) => {
  e.stopPropagation();
  window.pet.openSessionArchive();
  closeSessList();
});
document.getElementById('sl-panel').addEventListener('click', (e) => { e.stopPropagation(); window.pet.openPanel(); closeSessList(); });
sesslist.addEventListener('contextmenu', (e) => e.stopPropagation());
todopop.querySelectorAll('.tp-ops button').forEach((b) => {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const op = b.dataset.op;
    if (op === 'panel') window.pet.openPanel();
    else if (op === 'claude') {
      window.pet.launchClaude();
    }
    else if (op === 'log') window.pet.openLog();
    closeTodoPop();
  });
});

// ---------- 泡泡菜单 ----------
let radialOpenSeq = 0;
let lastRadialMetrics = null;
// labelKey (not label): buildRadial resolves it at render time, so the menu
// follows a language switch without rebuilding this table.
