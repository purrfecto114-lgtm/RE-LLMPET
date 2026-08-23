function renderTodoPop() {
  const acts = actionableItems();
  const renderSig = JSON.stringify({
    lang: window.OctoI18n.getLang(),
    project: curTodosProj,
    todos: curTodos,
    actions: acts,
  });
  if (renderSig === lastTodoPopRenderSig) return false;
  lastTodoPopRenderSig = renderSig;
  const done = curTodos.filter((t) => t.status === 'completed').length;
  tpProg.textContent = curTodos.length ? t('todo.progress', { done, total: curTodos.length }) : '';
  // 需要你处理
  if (acts.length) {
    tpActSec.classList.remove('hidden');
    tpActs.innerHTML = '';
    acts.forEach((c) => tpActs.appendChild(buildActCard(c)));
  } else {
    tpActSec.classList.add('hidden');
    tpActs.innerHTML = '';
  }
  // 待办
  if (curTodos.length) {
    tpTodoSec.classList.remove('hidden');
    tpList.innerHTML = curTodos
      .map((t) => {
        const cls = t.status === 'completed' ? 'tp-row done' : t.status === 'in_progress' ? 'tp-row doing' : 'tp-row';
        return `<div class="${cls}"><span class="ic">${TODO_ICON[t.status] || '⬜️'}</span><span class="tx">${esc(t.content)}</span></div>`;
      })
      .join('');
  } else {
    tpTodoSec.classList.add('hidden');
    tpList.innerHTML = '';
  }
  return true;
}

// 一张「需要你处理」卡片：问题 + 选项按钮(可点即答) + 自定义输入
function buildActCard(c) {
  const card = document.createElement('div');
  card.className = 'tp-act';
  const kindTag = c.kind === 'perm' ? t('ask.kindPerm')
    : c.kind === 'continue' ? t('ask.kindContinue')
      : c.kind === 'plan' ? t('ask.kindPlan') : t('ask.kindChoice');
  const head = document.createElement('div');
  head.className = 'tp-act-proj';
  head.textContent = `📂 ${c.project || '?'} · ${kindTag}`;
  card.appendChild(head);
  const q = document.createElement('div');
  q.className = 'tp-act-q';
  q.textContent = (c.header ? '【' + c.header + '】 ' : '') + (c.question || t('ask.needHandling'));
  card.appendChild(q);

  const opts = document.createElement('div');
  opts.className = 'tp-act-opts';
  if (c.kind === 'perm' && c.permId) {
    // 授权：允许/拒绝 → HTTP 原生通道回 CC
    (c.options || []).forEach((opt) => {
      const b = document.createElement('button');
      b.textContent = opt.label;
      if (opt.desc) b.title = opt.desc;
      b.addEventListener('click', (e) => { e.stopPropagation(); popPerm(c, opt.key); });
      opts.appendChild(b);
    });
  } else {
    // 对话类：选项只读展示 + 「去回复」按钮（桌宠不替你打字）
    (c.options || []).forEach((opt) => {
      const label = typeof opt === 'string' ? opt : opt.label;
      const desc = typeof opt === 'string' ? '' : opt.desc || '';
      const d = document.createElement('div');
      d.className = 'tp-act-ro';
      d.textContent = label;
      if (desc) d.title = desc;
      opts.appendChild(d);
    });
    const go = document.createElement('button');
    go.className = 'tp-act-go';
    go.textContent = t('ask.goReply');
    go.addEventListener('click', (e) => { e.stopPropagation(); popGoto(c); });
    opts.appendChild(go);
  }
  card.appendChild(opts);
  return card;
}

// 授权：回 CC 决策
function popPerm(choice, key) {
  window.pet.decidePermission(choice.permId, key);
  answered.add(choiceKey(choice));
  renderTodoPop();
  maybeCloseEmptyPop();
}
// 对话类：定位并唤起该会话窗口
function popGoto(choice) {
  window.pet.focusSession(choice.sessionId || '');
  answered.add(choiceKey(choice));
  renderTodoPop();
  maybeCloseEmptyPop();
}
function maybeCloseEmptyPop() {
  if (!actionableItems().length && !curTodos.length) closeTodoPop();
}

function openTodoPop() {
  if (askActive) hideAsk(true); // 直接交给新面板接管尺寸，不经过 340px 中间帧
  if (sessListOpen) closeSessList(true);
  renderTodoPop();
  todopop.classList.remove('hidden');
  todoPopOpen = true;
  rlog('pop', `open acts=${actionableItems().length} todos=${curTodos.length}`);
  fitPopup(todopop);
}
function closeTodoPop(preserveSize = false) {
  todopop.classList.add('hidden');
  todoPopOpen = false;
  rlog('pop', 'close');
  window.pet.blurPet();
  if (!preserveSize) resetPetSize();
}

// ---------- 会话列表 HUD（左键弹出）----------
let sessListOpen = false;
let lastSessListRenderSig = '';
let lastSessionDotsRenderSig = '';
let stableSessionOrder = [];
let takeoverTarget = null;

// Claude 橙色 burst（小图标）
const CLAUDE_ICON =
  '<svg viewBox="0 0 24 24" fill="#d97757"><path d="M12 1l2.2 6.3L20.5 5l-4 5.4 6.5 1.6-6.5 1.6 4 5.4-6.3-2.3L12 23l-2.2-6.3L3.5 19l4-5.4L1 12l6.5-1.6-4-5.4 6.3 2.3z"/></svg>';
// Codex 蓝色终端块（>_ 提示符）
const CODEX_ICON =
  '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" fill="#3b82f6"/>' +
  '<path d="M7 8l4 4-4 4" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M13 16.5h4.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>';
// dsh（DeepSeek Harness）深蓝方块 + 鲸背波浪
const DSH_ICON =
  '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" fill="#4d6bfe"/>' +
  '<circle cx="8.6" cy="9" r="1.5" fill="#fff"/><path d="M12 9h5.4" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>' +
  '<path d="M5 15c1.6 0 1.6-1.7 3.3-1.7S9.9 15 11.5 15s1.6-1.7 3.3-1.7S16.4 15 18 15" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
const UNKNOWN_AGENT_ICON =
  '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" fill="#777582"/>' +
  '<text x="12" y="17" fill="#fff" font-size="14" font-weight="700" text-anchor="middle">?</text></svg>';
const AGENT_ICONS = { codex: CODEX_ICON, dsh: DSH_ICON, claude: CLAUDE_ICON, unknown: UNKNOWN_AGENT_ICON };
const agentIcon = (s) => AGENT_ICONS[s && s.agent] || UNKNOWN_AGENT_ICON;
// State → HUD label. Resolved per call (not a frozen table) so switching the
// language re-labels every row on the next render.
const SESS_META_ICON = {
  waiting: '✋ ', needsinput: '💬 ', working: '⚙️ ', juggling: '🤹 ',
  sweeping: '🧹 ', thinking: '💭 ', loafing: '🍦 ', error: '😵 ',
  idle: '', sleeping: '💤 ',
};
const SESS_META_KEY = {
  waiting: 'state.waiting', needsinput: 'state.needsinput', working: 'state.working',
  juggling: 'state.juggling', sweeping: 'state.sweeping', thinking: 'state.thinking',
  loafing: 'state.loafingLong', error: 'state.error', idle: 'state.idle',
  sleeping: 'state.sleeping',
};
function sessMeta(state) {
  const key = SESS_META_KEY[state];
  return key ? (SESS_META_ICON[state] || '') + t(key) : null;
}
const SESS_SORT = { waiting: 0, needsinput: 0, error: 1, working: 2, juggling: 2, sweeping: 2, thinking: 2, loafing: 3, idle: 4, sleeping: 5 };

// 对齐参考项目阈值：≥90% 红(hot)、≥75% 黄(warm)、其余灰
function ctxClass(p) { return p >= 90 ? 'high' : p >= 75 ? 'mid' : ''; }

const sessionKey = (s) => String((s && (s.sessionId || s.id)) || '');
function mergedOrdinarySessions() {
  const byId = new Map();
  for (const session of (curSessions || [])) {
    const key = sessionKey(session);
    if (key) byId.set(key, session);
  }
  return [...byId.values()];
}
const isBaseVisibleSession = (s) => !!s && !s.headless && s.state !== 'sleeping';
const isArchivedSession = (s) => archivedSessionIds.includes(sessionKey(s));
// 头顶状态点永远不展示已归档项；HUD 可通过「归档」开关单独查看。
const isVisibleSession = (s) => isBaseVisibleSession(s) && !isArchivedSession(s);
// 单一配色：小点和 HUD 用同一套（完成→绿、中断→红，否则按状态）
function sessionDotClass(s) {
  if (s.state === 'idle' && s.badge === 'done') return 'done';
  if (s.state === 'idle' && s.badge === 'interrupted') return 'error';
  return s.state || 'idle';
}

function visibleSessions() {
  return mergedOrdinarySessions()
    .filter((s) => !s.headless && (s.state !== 'sleeping' || (showArchived && isArchivedSession(s))))
    .filter((s) => showArchived ? isArchivedSession(s) : !isArchivedSession(s))
    .filter((s) => {
      if (sessionFilter === 'attention') return ['waiting', 'needsinput', 'error'].includes(s.state);
      if (['claude', 'codex', 'dsh'].includes(sessionFilter)) return s.agent === sessionFilter;
      return true;
    })
    .filter((s) => {
      const q = sessionSearch.trim().toLocaleLowerCase();
      if (!q) return true;
      return [s.project, s.sessionId, s.cwd, s.op]
        .some((v) => String(v || '').toLocaleLowerCase().includes(q));
    })
    .sort((a, b) => {
      const pinA = pinnedSessionIds.includes(sessionKey(a)) ? 0 : 1;
      const pinB = pinnedSessionIds.includes(sessionKey(b)) ? 0 : 1;
      if (pinA !== pinB) return pinA - pinB;
      const pa = SESS_SORT[a.state] != null ? SESS_SORT[a.state] : 3;
      const pb = SESS_SORT[b.state] != null ? SESS_SORT[b.state] : 3;
      if (pa !== pb) return pa - pb;
      return (a.idleMs || 0) - (b.idleMs || 0); // most-recently-active first
    });
}

function sessionsForList() {
  const list = visibleSessions();
  const byKey = new Map(list.map((session) => [sessionKey(session), session]));
  const ordered = [];
  for (const key of stableSessionOrder) {
    const session = byKey.get(key);
    if (!session) continue;
    ordered.push(session);
    byKey.delete(key);
  }
  // While the panel is open, state/idle-time polling updates rows in place;
  // it must not reshuffle the list under the user's pointer. New sessions are
  // appended. Explicit search/filter/pin actions reset this order separately.
  ordered.push(...byKey.values());
  stableSessionOrder = ordered.map(sessionKey);
  return ordered;
}

function resetSessionListOrder() {
  stableSessionOrder = [];
  lastSessListRenderSig = '';
}

function createSessRow() {
  const row = document.createElement('div');
  row.className = 'sl-row';
  row.innerHTML =
    '<span class="sl-dot"></span>' +
    '<span class="sl-icon"></span>' +
    '<div class="sl-main"><div class="sl-name"></div><div class="sl-meta-line"><div class="sl-meta"></div><button class="sl-session-id"></button></div></div>' +
    '<span class="sl-ctx hidden"></span>' +
    '<button class="sl-takeover-entry"></button>' +
    '<span class="sl-actions">' +
    '<button class="sl-action pin">★</button>' +
    '<button class="sl-action archive">▣</button>' +
    '</span>';
  row._parts = {
    dot: row.querySelector('.sl-dot'),
    icon: row.querySelector('.sl-icon'),
    name: row.querySelector('.sl-name'),
    meta: row.querySelector('.sl-meta'),
    sessionId: row.querySelector('.sl-session-id'),
    context: row.querySelector('.sl-ctx'),
    takeover: row.querySelector('.sl-takeover-entry'),
    pin: row.querySelector('.sl-action.pin'),
    archive: row.querySelector('.sl-action.archive'),
  };
  row._parts.sessionId.addEventListener('click', async (event) => {
    event.stopPropagation();
    const id = sessionKey(row._session);
    if (!id || !window.pet.copySessionId) return;
    const ok = await window.pet.copySessionId(id);
    if (!ok) return;
    row._parts.sessionId.classList.add('copied');
    row._parts.sessionId.textContent = t('sess.copied');
    clearTimeout(row._copyTimer);
    row._copyTimer = setTimeout(() => {
      row._parts.sessionId.classList.remove('copied');
      updateSessionIdButton(row._parts.sessionId, id);
    }, 1100);
  });
  row._parts.takeover.addEventListener('click', (event) => {
    event.stopPropagation();
    openTakeoverPage(row._session);
  });
  row._parts.pin.addEventListener('click', (event) => {
    event.stopPropagation();
    const key = sessionKey(row._session);
    const pinned = pinnedSessionIds.includes(key);
    if (pinned) pinnedSessionIds = pinnedSessionIds.filter((id) => id !== key);
    else {
      pinnedSessionIds = [key, ...pinnedSessionIds.filter((id) => id !== key)];
      archivedSessionIds = archivedSessionIds.filter((id) => id !== key);
    }
    window.pet.setSessionPrefs(pinnedSessionIds, archivedSessionIds);
    resetSessionListOrder();
    renderSessList();
  });
  row._parts.archive.addEventListener('click', (event) => {
    event.stopPropagation();
    const key = sessionKey(row._session);
    const archived = archivedSessionIds.includes(key);
    if (archived) archivedSessionIds = archivedSessionIds.filter((id) => id !== key);
    else {
      archivedSessionIds = [key, ...archivedSessionIds.filter((id) => id !== key)];
      pinnedSessionIds = pinnedSessionIds.filter((id) => id !== key);
    }
    window.pet.setSessionPrefs(pinnedSessionIds, archivedSessionIds);
    resetSessionListOrder();
    renderSessList();
  });
  row.addEventListener('click', () => {
    const session = row._session || {};
    window.pet.focusSession(session.sessionId || '');
    rlog('sesslist', 'focus ' + (session.project || ''));
    closeSessList();
  });
  return row;
}

function shortSessionId(id) {
  const value = String(id || '');
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function updateSessionIdButton(button, id) {
  button.classList.toggle('hidden', !id);
  button.textContent = id ? `ID ${shortSessionId(id)} ⧉` : '';
  button.title = id ? `${id}\n${t('sess.copyId')}` : '';
}

function updateSessRow(row, session) {
  row._session = session;
  const parts = row._parts;
  const key = sessionKey(session);
  const attention = session.state === 'waiting' || session.state === 'needsinput';
  let meta;
  if (attention) meta = session.reason
    ? t(session.state === 'waiting' ? 'sess.waitFor' : 'sess.replyFor', { reason: reasonWord(session.reason) })
    : sessMeta(session.state);
  else if (['working', 'juggling', 'sweeping', 'thinking'].includes(session.state)) {
    meta = session.op || sessMeta(session.state);
  } else if (session.badge === 'done') meta = t('sess.justDone');
  else if (session.badge === 'interrupted') meta = t('sess.interrupted');
  else meta = sessMeta(session.state) || session.state;

  const pinned = pinnedSessionIds.includes(key);
  const archived = archivedSessionIds.includes(key);
  row.dataset.sessionKey = key;
  row.className = 'sl-row';
  parts.dot.className = `sl-dot ${sessionDotClass(session)}`;
  parts.icon.title = agentName(session.agent);
  const iconMarkup = agentIcon(session);
  if (parts.icon.innerHTML !== iconMarkup) parts.icon.innerHTML = iconMarkup;
  parts.name.textContent = session.project || '';
  parts.meta.className = `sl-meta${attention ? ' attn' : ''}`;
  parts.meta.textContent = meta || '';
  if (!parts.sessionId.classList.contains('copied')) updateSessionIdButton(parts.sessionId, key);
  if (typeof session.contextPercent === 'number') {
    parts.context.className = `sl-ctx ${ctxClass(session.contextPercent)}`.trim();
    parts.context.textContent = `${session.contextPercent}%`;
  } else {
    parts.context.className = 'sl-ctx hidden';
    parts.context.textContent = '';
  }
  parts.takeover.title = t('takeover.entryTitle');
  parts.takeover.textContent = t('takeover.entry');
  parts.takeover.classList.toggle('hidden', !sessionActionAllowed(session, 'takeover'));
  parts.pin.className = `sl-action pin${pinned ? ' active' : ''}`;
  parts.pin.title = t(pinned ? 'sess.unpin' : 'sess.pin');
  parts.archive.className = `sl-action archive${archived ? ' active' : ''}`;
  parts.archive.title = t(archived ? 'sess.unarchive' : 'sess.archive');
}

