function openTakeoverPage(session) {
  if (!sessionActionAllowed(session, 'takeover')) return false;
  takeoverTarget = session;
  sesslist.classList.remove('session-list-mode');
  sesslist.classList.add('takeover-mode');
  slSessionView.classList.add('hidden');
  slTakeoverView.classList.remove('hidden');
  slBack.classList.remove('hidden');
  slTitle.textContent = t('takeover.pickTitle');
  slSub.textContent = '';
  const source = agentName(session.agent);
  slTakeoverSession.textContent = t('takeover.source', { who: source, project: session.project });
  slTakeoverClaudeMode.textContent = t(session.agent === 'claude' ? 'takeover.nativeMode' : 'takeover.handoffMode');
  slTakeoverCodexMode.textContent = t(session.agent === 'codex' ? 'takeover.nativeMode' : 'takeover.handoffMode');
  slTakeoverClaude.disabled = false;
  slTakeoverCodex.disabled = false;
  setTakeoverStatus('');
  fitPopup(sesslist);
  return true;
}

async function runTakeover(target) {
  const source = takeoverTarget;
  if (!sessionActionAllowed(source, 'takeover') || !['claude', 'codex'].includes(target)) return false;
  slTakeoverClaude.disabled = true;
  slTakeoverCodex.disabled = true;
  setTakeoverStatus(t('takeover.starting'), 'warn');
  let result;
  try {
    result = await window.pet.takeOverSession(source.sessionId || '', target);
  } catch {
    result = { ok: false, code: 'launch-failed' };
  }
  if (!takeoverTarget || takeoverTarget.sessionId !== source.sessionId) return;
  setTakeoverStatus(takeoverResultText(result, target), result && result.ok ? 'ok' : 'error');
  slTakeoverClaude.disabled = false;
  slTakeoverCodex.disabled = false;
  rlog(
    'takeover',
    `${source.agent || '-'}→${target} id=${String(source.sessionId || '').slice(-8)} ` +
      `ok=${!!(result && result.ok)} code=${result && result.code || '-'}`,
  );
  fitPopup(sesslist);
  return true;
}

function showSessionPage() {
  takeoverTarget = null;
  sesslist.classList.remove('takeover-mode');
  sesslist.classList.add('session-list-mode');
  slTakeoverView.classList.add('hidden');
  slSessionView.classList.remove('hidden');
  slBack.classList.add('hidden');
  slTitle.textContent = t('sess.title');
  renderSessList();
  fitPopup(sesslist);
}

function openSessList() {
  if (radialOpen) closeRadial();
  if (todoPopOpen) closeTodoPop(true);
  hideAsk(true);
  resetSessionListOrder();
  showSessionPage();
  sesslist.classList.remove('hidden');
  sessListOpen = true;
  rlog('sesslist', 'open ' + visibleSessions().length);
  fitPopup(sesslist); // 动态定高 + 440 宽，会话名不截断
}
function closeSessList(preserveSize = false) {
  if (!sessListOpen) return;
  sesslist.classList.add('hidden');
  sessListOpen = false;
  takeoverTarget = null;
  rlog('sesslist', 'close');
  if (!preserveSize) resetPetSize();
}

function toggleSessList() { sessListOpen ? closeSessList() : openSessList(); }

// 工具 -> 干活动作；道具 emoji 的运动变体
const TOOL_ACT = {
  Edit: 'type', MultiEdit: 'type', Write: 'type', NotebookEdit: 'type',
  Read: 'read',
  Bash: 'crank',
  Grep: 'search', Glob: 'search',
  WebSearch: 'web', WebFetch: 'web',
  Task: 'summon', Agent: 'summon',
  TodoWrite: 'check',
};
const ACT_CLASSES = ['act-type', 'act-read', 'act-search', 'act-crank', 'act-web', 'act-summon', 'act-check', 'act-work'];
const PROP_MOTION = { crank: 'spin', web: 'spin', search: 'hunt', type: 'jit' };
let actTimer = null;

let state = 'idle';
let bubbleTimer = null;
let blinkTimer = null;
let transientUntil = 0;   // 短暂状态（happy/error）持续到的时间
let transientState = null;
let muted = false;
let skin = 'mascot';
let lastWaiting = 0;
let lastBgZombie = 0; // 后台疑似僵尸数
let radialOpen = false;

const IDLE_SLEEP_MS = 6 * 60 * 1000;
const stateEls = [pixel, mascot, cat].filter(Boolean);
const DEBUG_STATE = null; // 调试用：强制某状态（如 'sleeping'）；正常运行设为 null
const DEBUG_CONFETTI = false; // 临时：定时放彩带验证；验证完改回 false

// ---------- 像素小怪兽 ----------
const PIXEL_MAP = [
  '..##############..',
  '..##############..',
  '..##############..',
  '#####OO####OO#####',
  '#####OO####OO#####',
  '..##############..',
  '..##############..',
  '..##############..',
  '..##############..',
  '...##.##..##.##...',
  '...##.##..##.##...',
];
function buildPixel() {
  if (!pixel) return;
  const sprite = pixel.querySelector('.pixel-sprite');
  const rows = PIXEL_MAP.length;
  const cols = PIXEL_MAP[0].length;
  const cell = 9;
  const W = cols * cell;
  const H = rows * cell;
  let rects = '';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const c = PIXEL_MAP[y][x];
      if (c === '.') continue;
      const fill = c === 'O' ? '#2a1b2e' : '#c2694a';
      rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${fill}"/>`;
    }
  }
  sprite.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${rects}</svg>`;
}
buildPixel();

// ---------- 状态机（作用于两种形象，仅当前皮肤可见） ----------
// 前端会 setState 的全部状态词（聚合态 + 短暂态 + 情绪态）——统一取自
// shared/states.js（pet.html 以 <script> 在 pet.js 之前加载它）。classList.remove
// 必须覆盖此全集，漏一个就会 class 残留在皮肤元素上。
const STATE_WORDS = (window.OctoStates && window.OctoStates.RENDER_STATE_WORDS) || [];
function setState(s) {
  if (state === s) {
    // 语义状态没变，限时视觉层仍可能刚刚到期；同状态快照也要让猫
    // 重新选图，否则 30s 的高压工作姿态会一直拖到下一次状态切换。
    if (isMeme()) updateCat(s);
    return;
  }
  for (const el of stateEls) {
    el.classList.remove(...STATE_WORDS);
    el.classList.add(s);
  }
  state = s;
  rlog('state', s);
  thinkEl.classList.toggle('on', s === 'thinking');
  sleepEl.classList.toggle('on', s === 'sleeping');
  if (s === 'thinking' || s === 'sleeping') bubble.classList.add('hidden');
  if (s === 'working') {
    // 进入干活态 → 立刻挂上「持续忙碌」基线动作，不等具体 tool 事件，
    // 任何时刻都显得在忙（具体 tool 动作会在它之上叠加，结束后回落到这里）。
    for (const el of stateEls) el.classList.add('act-work');
  } else {
    clearAction(); // 离开干活态才清掉动作
  }
  // 注意：不要在这里 hideAsk()！面板显隐只由 refreshAsk(按是否有待答事项) 管。
  // 之前「s!=='waiting' 就 hideAsk」会在聚合态变 working/thinking 时把 needsinput 的面板闪掉。
  if (skin === 'mascot') updateMascotEyes(s);
  if (isMeme()) updateCat(s);
}

// 按工具播放专属动作 + 头顶道具
function playAction(toolName, icon) {
  if (state === 'waiting' || state === 'sleeping') return;
  const act = TOOL_ACT[toolName] || 'work';
  for (const el of stateEls) {
    el.classList.remove(...ACT_CLASSES);
    el.classList.add('act-' + act); // 通用 work 也有身体动作（不再只闪图标）
  }
  if (icon) {
    propEl.textContent = icon;
    propEl.className = 'prop';
    void propEl.offsetWidth; // 重启动画
    const pm = PROP_MOTION[act];
    propEl.className = 'prop on' + (pm ? ' ' + pm : '');
    requestAnimationFrame(alignToolProp);
  }
  if (act === 'summon') {
    sidekickEl.classList.remove('on');
    void sidekickEl.offsetWidth;
    sidekickEl.classList.add('on');
  }
  clearTimeout(actTimer);
  actTimer = setTimeout(clearAction, 2200);
}

function alignToolProp() {
  if (!propEl || !propEl.classList.contains('on')) return;
  const petEl = curSkinEl();
  if (!petEl) return;
  const rect = petEl.getBoundingClientRect();
  const viewportW = Math.max(1, window.innerWidth || 320);
  const viewportH = Math.max(1, window.innerHeight || 340);
  const size = Math.max(24, Number(propEl.offsetWidth) || Number(propEl.offsetHeight) || 28);
  const preferred = edgeLayout.horizontal === 'left' ? 'right' : 'left';
  const position = window.PetGeometry && window.PetGeometry.adornmentPosition
    ? window.PetGeometry.adornmentPosition({
      petRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      viewport: { x: 0, y: 0, width: viewportW, height: viewportH },
      preferred,
      size,
    })
    : { x: rect.left - size - 5, y: rect.top + 12 };
  propEl.style.left = `${Math.round(position.x)}px`;
  propEl.style.top = `${Math.round(position.y)}px`;
  propEl.dataset.side = position.side || preferred;
}
function clearAction() {
  for (const el of stateEls) el.classList.remove(...ACT_CLASSES);
  propEl.classList.remove('on');
  // 具体 tool 动作结束后，仍在干活 → 回落到「持续忙碌」基线，别安静下来
  if (state === 'working') for (const el of stateEls) el.classList.add('act-work');
}

// 短暂状态：happy/error/greet…，到点后由 applyStats 接管。
// 到期不再干等下一个快照（周期推送最坏 ~4s，短暂态会拖尾）——
// 定时用最近一次快照主动重算聚合态，到点即回落。
let transientTimer = null;
function transient(s, ms, text, holdMs) {
  if (state === 'waiting') return; // 等用户优先
  transientState = s;
  transientUntil = perfNow() + ms;
  setState(s);
  clearTimeout(transientTimer);
  transientTimer = setTimeout(() => { if (lastStats) applyStats(lastStats); }, ms + 30);
  if (text) showBubble(text, holdMs || ms);
}
// 高优先级稳态（waiting/needsinput/error）接管时清掉残留短暂态，
// 否则 talking/thinking 会在下个快照借 transientUntil 复活盖回来。
function clearTransient() {
  transientUntil = 0;
  clearTimeout(transientTimer);
}

// ---------- 声音提示（Web Audio 合成，无需音频文件） ----------
let audioCtx = null;
function beep(freqs, dur = 0.13, type = 'sine', gain = 0.06) {
  if (muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    let t = audioCtx.currentTime;
    for (const f of freqs) {
      const o = audioCtx.createOscillator();
      const gnode = audioCtx.createGain();
      o.type = type;
      o.frequency.value = f;
      gnode.gain.setValueAtTime(0, t);
      gnode.gain.linearRampToValueAtTime(gain, t + 0.012);
      gnode.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(gnode);
      gnode.connect(audioCtx.destination);
      o.start(t);
      o.stop(t + dur);
      t += dur * 0.92;
    }
  } catch {}
}
