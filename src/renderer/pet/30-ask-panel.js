function showAskPanel() {
  const c = askQueue[askIdx];
  if (!c) { hideAsk(); return; }
  // The user explicitly opened the session surface. A short-lived background
  // permission snapshot must not close it and then disappear on the next poll.
  // Keep the choice queued; the next stats push after the user closes the list
  // will present it normally.
  if (sessListOpen) return;

  const sess = c.sessionId ? ' · #' + String(c.sessionId).slice(-3) : '';
  const queue = askQueue.length > 1 ? `${askIdx + 1}/${askQueue.length} · ` : '';
  askSess.textContent = queue + (c.project || '?') + sess;

  if (c.kind === 'ask') {
    if (!elic || elic.key !== choiceKey(c)) {
      elic = { key: choiceKey(c), questions: Array.isArray(c.questions) ? c.questions : [], qIdx: 0, answers: {}, selected: null, selSet: [], multi: false, otherOn: false };
    }
    renderElicitation(c);
  } else {
    elic = null;
    if (c.kind === 'codex-ask') renderCodexElicitation(c);
    else if (c.kind === 'perm' && c.permId) renderPerm(c);
    else if (c.kind === 'plan' && c.permId) renderPlan(c);
    else renderContinue(c);
  }

  bubble.classList.add('hidden');
  askEl.classList.remove('hidden');
  lastAskSig = askQueue.map(choiceKey).join(',');
  askActive = true;
  rlog('ask', 'show ' + (c.kind || '') + ': ' + String(c.question || '').slice(0, 36));
  fitPopup(askEl); // 富卡片：固定头尾、中部滚动，动态定高 + 520 宽
}

function clearAskBody() {
  askScroll.scrollTop = 0;
  askOpts.innerHTML = '';
  askOpts.classList.remove('perm-row');
  askQhead.textContent = '';
  askHint.textContent = '';
  askPage.textContent = '';
  askInputRow.classList.add('hidden');
  askText.value = '';
  askTerm.textContent = t('ask.goTerminal');
}

// ① elicitation（AskUserQuestion）：多选项卡 + Other + 分页 + Submit/Back
function renderElicitation(c) {
  clearAskBody();
  askLabel.textContent = 'Needs Input';
  const qs = elic.questions;
  const q = qs[elic.qIdx] ||
    { question: c.question || t('ask.needAnswer'), options: (c.options || []).map((o) => ({ label: o.label, description: o.desc })) };
  askQhead.textContent = q.header || '';
  askQ.textContent = q.question || '';
  const multi = !!q.multiSelect;
  elic.multi = multi;
  askHint.textContent = multi ? t('ask.multiHint') : t('ask.singleHint');

  const prior = elic.answers[q.question];
  const opts = q.options || [];
  const known = (v) => opts.some((o) => o.label === v);
  if (multi) {
    const parts = prior ? String(prior).split(/,\s*/).filter(Boolean) : [];
    elic.selSet = parts.filter(known);
    const otherText = parts.find((p) => !known(p));
    elic.otherOn = !!otherText;
    elic.selected = null;
    if (otherText) askText.value = otherText;
  } else {
    elic.selSet = [];
    elic.otherOn = false;
    elic.selected = prior != null ? (known(prior) ? prior : '__other__') : null;
  }

  for (const o of opts) askOpts.appendChild(buildRadioCard(o.label, o.description, o.label, q));
  askOpts.appendChild(buildRadioCard('Other', '', '__other__', q));
  if (elic.selected === '__other__' || (multi && elic.otherOn)) {
    askInputRow.classList.remove('hidden');
    if (!multi && prior && !known(prior)) askText.value = prior;
  }

  askPage.textContent = `${elic.qIdx + 1} / ${qs.length || 1}`;
  askFoot.classList.remove('hidden');
  const last = elic.qIdx >= (qs.length || 1) - 1;
  askSubmit.textContent = last ? 'Submit Answer' : 'Next ›';
  askBack.classList.toggle('hidden', elic.qIdx === 0);
  askTerm.classList.remove('hidden');
  updateSubmitEnabled(q);
  fitPopup(askEl); // 题目切换后内容高度变了，重新定高
}

// Codex 选择对话的只读镜像。rollout watcher 能看见真实选项，
// 但不持有 app-server 的响应通道；因此这里展示完整内容，并引导
// 用户回到原 Codex 客户端/CLI 点选。原会话继续后快照会自动撤卡。
function renderCodexElicitation(c) {
  clearAskBody();
  askLabel.textContent = t('ask.needsInput');
  const qs = Array.isArray(c.questions) && c.questions.length
    ? c.questions
    : [{ header: c.header || '', question: c.question || t('ask.needAnswer'), options: c.options || [] }];
  askQhead.textContent = qs.length === 1 ? (qs[0].header || '') : c.header || '';
  askQ.textContent = qs.length === 1 ? (qs[0].question || c.question || '') : t('ask.codexMultiple', { n: qs.length });
  askHint.textContent = t('ask.codexReplyHint');

  for (const [index, q] of qs.entries()) {
    if (qs.length > 1) {
      const head = document.createElement('div');
      head.className = 'ask-external-question';
      head.textContent = `${index + 1}. ${q.header ? `【${q.header}】 ` : ''}${q.question || ''}`;
      askOpts.appendChild(head);
    }
    for (const o of (q.options || [])) {
      const row = document.createElement('div');
      row.className = 'ask-opt readonly';
      const label = typeof o === 'string' ? o : o.label;
      const desc = typeof o === 'string' ? '' : o.description || o.desc || '';
      row.innerHTML = '<span class="ask-radio"></span><span class="ask-ot">' +
        `<span class="ask-ol">${esc(label)}</span>` +
        (desc ? `<span class="ask-od">${esc(desc)}</span>` : '') + '</span>';
      askOpts.appendChild(row);
    }
  }
  askFoot.classList.add('hidden');
  askTerm.textContent = t('ask.goCodex');
  askTerm.classList.remove('hidden');
  fitPopup(askEl);
}

function buildRadioCard(label, desc, value, q) {
  const multi = elic.multi;
  const isSel = multi ? (value === '__other__' ? elic.otherOn : elic.selSet.includes(value)) : elic.selected === value;
  const card = document.createElement('button');
  card.className = 'ask-opt' + (multi ? ' multi' : '') + (isSel ? ' sel' : '');
  card.innerHTML =
    '<span class="ask-radio"></span><span class="ask-ot">' +
    `<span class="ask-ol">${esc(label)}</span>` + (desc ? `<span class="ask-od">${esc(desc)}</span>` : '') +
    '</span>';
  card.addEventListener('click', () => {
    if (multi) {
      if (value === '__other__') {
        elic.otherOn = !elic.otherOn;
        card.classList.toggle('sel', elic.otherOn);
        askInputRow.classList.toggle('hidden', !elic.otherOn);
        if (elic.otherOn) setTimeout(() => askText.focus(), 0);
      } else {
        const i = elic.selSet.indexOf(value);
        if (i >= 0) elic.selSet.splice(i, 1); else elic.selSet.push(value);
        card.classList.toggle('sel');
      }
    } else {
      elic.selected = value;
      askInputRow.classList.toggle('hidden', value !== '__other__');
      if (value === '__other__') setTimeout(() => askText.focus(), 0);
      [...askOpts.children].forEach((el) => el.classList.remove('sel'));
      card.classList.add('sel');
    }
    updateSubmitEnabled(q);
  });
  return card;
}

function updateSubmitEnabled() {
  let ok;
  if (elic && elic.multi) ok = elic.selSet.length > 0 || (elic.otherOn && (askText.value || '').trim());
  else ok = elic && elic.selected && (elic.selected !== '__other__' || (askText.value || '').trim());
  askSubmit.classList.toggle('disabled', !ok);
}

// 自定义输入为空时按回车：不发送，抖一下 + 提示别忘了填（2.6s 后复原 placeholder）
let emptyWarnTimer = null;
function warnEmptyInput() {
  askText.focus();
  askText.classList.add('warn');
  if (!askText.dataset.ph) askText.dataset.ph = askText.placeholder || t('ask.placeholder');
  askText.placeholder = t('ask.emptyWarn');
  clearTimeout(emptyWarnTimer);
  emptyWarnTimer = setTimeout(() => {
    askText.classList.remove('warn');
    if (askText.dataset.ph) { askText.placeholder = askText.dataset.ph; delete askText.dataset.ph; }
  }, 2600);
}

function elicNextOrSubmit(c) {
  const qs = elic.questions;
  const q = qs[elic.qIdx];
  let val;
  if (elic.multi) {
    const parts = [...elic.selSet];
    if (elic.otherOn && (askText.value || '').trim()) parts.push((askText.value).trim());
    val = parts.join(', ');
  } else {
    val = elic.selected === '__other__' ? (askText.value || '').trim() : elic.selected;
  }
  if (!val) return; // 必须先选/填
  if (q && q.question) elic.answers[q.question] = val;
  else elic.answers[c.question || '_'] = val;
  if (elic.qIdx < (qs.length || 1) - 1) { elic.qIdx++; renderElicitation(c); return; }
  window.pet.decidePermission(c.permId, { type: 'elicitation-submit', answers: { ...elic.answers } });
  rlog('ask', 'elicitation submit ' + Object.keys(elic.answers).length);
  finishChoice(c, t('ask.submitted'));
}

function elicBack(c) {
  if (elic && elic.qIdx > 0) { elic.qIdx--; renderElicitation(c); }
}

// ② 授权：允许(绿)/拒绝(红) + 可选「始终允许」建议按钮(中性)
function renderPerm(c) {
  clearAskBody();
  askLabel.textContent = t('ask.needPerm');
  askQhead.textContent = c.header || '';
  askQ.textContent = c.question || t('ask.needPermQ');
  const opts = c.options || [];
  if (opts.length === 2) askOpts.classList.add('perm-row'); // 仅允许/拒绝时并排
  opts.forEach((opt) => {
    const kind = opt.key === 'allow' ? 'allow' : opt.key === 'deny' ? 'deny' : 'sugg';
    const card = document.createElement('button');
    card.className = 'ask-opt act ' + kind;
    card.innerHTML = `<span class="ask-ot"><span class="ask-ol">${esc(opt.label)}</span></span>`;
    card.addEventListener('click', () => submitPerm(opt.key, c, opt.label));
    askOpts.appendChild(card);
  });
  askFoot.classList.add('hidden');
  askTerm.classList.remove('hidden');
}

// ③ 纯回复（无选项）：只读问题 + Go to Terminal
function renderContinue(c) {
  clearAskBody();
  askLabel.textContent = 'Needs Input';
  askQ.textContent = c.question || t('ask.waitingReply');
  askFoot.classList.add('hidden');
  askTerm.classList.remove('hidden');
}

// ④ ExitPlanMode 方案评审：展示方案 + 批准 / 打回并反馈
function renderPlan(c) {
  clearAskBody();
  askLabel.textContent = t('ask.planLabel');
  askQhead.textContent = c.project ? '📂 ' + c.project : '';
  askQ.textContent = c.question || t('ask.planQ');
  const approve = document.createElement('button');
  approve.className = 'ask-opt act allow';
  approve.innerHTML = '<span class="ask-ot"><span class="ask-ol">' + esc(t('ask.approve')) + '</span></span>';
  approve.addEventListener('click', () => submitPerm('allow', c, t('ask.approved')));
  askOpts.appendChild(approve);
  const reject = document.createElement('button');
  reject.className = 'ask-opt act deny';
  reject.innerHTML = '<span class="ask-ot"><span class="ask-ol">' + esc(t('ask.reject')) + '</span></span>';
  reject.addEventListener('click', () => {
    window.pet.decidePermission(c.permId, { type: 'plan-feedback', feedback: (askText.value || '').trim() });
    finishChoice(c, t('ask.rejected'));
  });
  askOpts.appendChild(reject);
  askInputRow.classList.remove('hidden');
  askText.placeholder = t('ask.rejectPlaceholder');
  askFoot.classList.add('hidden');
  askTerm.classList.remove('hidden');
}

function finishChoice(choice, bubbleMsg) {
  answered.add(choiceKey(choice));
  elic = null;
  askQueue = askQueue.filter((c) => choiceKey(c) !== choiceKey(choice));
  if (askQueue.length) {
    // 还有下一题：直接展示，不弹确认气泡盖住选项面板
    askIdx = 0; showAskPanel();
  } else {
    // The confirmation bubble takes ownership of the same expanded window.
    // Do not collapse ask -> 320x340 and immediately expand again: the two
    // one-way IPC resizes can be calculated from different renderer frames and
    // persist a small anchor error as a visible pet jump.
    hideAsk(true);
    if (!showBubble(bubbleMsg, 2600)) resetPetSize();
  }
}
function submitPerm(key, choice, label) {
  window.pet.decidePermission(choice.permId, key);
  const msg = key === 'allow' ? t('ask.allowed') : key === 'deny' ? t('ask.denied') : t('ask.remembered');
  finishChoice(choice, msg);
}
// Go to Terminal：去会话终端自己答（授权/elicitation 都回 deny，让 CC 在终端重问）
function gotoSession(choice) {
  if (choice.permId) window.pet.decidePermission(choice.permId, 'deny');
  window.pet.focusSession(choice.sessionId || '');
  // Codex 的选择卡是只读镜像，不能因“打开原会话”就当成
  // 已回答。保留在队列里，等 rollout 真正继续后 refreshAsk 自动关闭。
  if (choice.externalOnly) {
    hideAsk(true);
    if (!showBubble(t('ask.toCodex'), 2600)) resetPetSize();
    return;
  }
  finishChoice(choice, t('ask.toTerminal'));
}

function hideAsk(preserveSize = false) {
  if (askActive) rlog('ask', 'hide');
  lastAskSig = '';
  elic = null;
  askEl.classList.add('hidden');
  askHover = false;
  if (askText) askText.value = ''; // 清掉草稿，避免关闭后仍被判为「交互中」冻住状态
  if (askActive) {
    askActive = false;
    if (!preserveSize) resetPetSize();
    window.pet.blurPet();
  }
}

// ---------- 记事本 / 行动清单 ----------
let curTodos = [];
let curTodosProj = '';
let curSessions = [];
let todoPopOpen = false;
let lastTodoPopRenderSig = '';
const TODO_ICON = { completed: '✅', in_progress: '▶️', pending: '⬜️' };

// 当前需要你处理的事项：有 choice、还没答过的 waiting/needsinput 会话
function actionableItems() {
  return curSessions
    .filter((x) => (x.state === 'waiting' || x.state === 'needsinput') && x.choice && !answered.has(choiceKey(x.choice)))
    .map((x) => x.choice)
    .filter((c) => (c.options && c.options.length) || c.allowInput);
}

let notepadShown = false;
function updateNotepad(s) {
  curTodos = Array.isArray(s.todos) ? s.todos : [];
  curTodosProj = s.todosProject || '';
  curSessions = s.sessions || [];
  const acts = actionableItems();
  if (!curTodos.length && !acts.length) {
    notepad.classList.add('hidden');
    if (notepadShown) { rlog('notepad', 'hide'); notepadShown = false; }
    if (todoPopOpen) closeTodoPop();
    return;
  }
  notepad.classList.remove('hidden');
  if (!notepadShown) { rlog('notepad', `show acts=${acts.length} todos=${curTodos.length}`); notepadShown = true; }
  if (acts.length) {
    npBadge.textContent = acts.length; // 优先显示「需处理」数
    npBadge.classList.add('urgent');
  } else {
    const done = curTodos.filter((t) => t.status === 'completed').length;
    npBadge.textContent = `${done}/${curTodos.length}`;
    npBadge.classList.remove('urgent');
  }
  // 弹层开着、且用户没在弹层里打字 → 同步刷新内容
  if (todoPopOpen && !todopop.contains(document.activeElement)) { renderTodoPop(); fitPopup(todopop); }
}

