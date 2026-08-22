'use strict';

const petAgentView = window.OctoPetAgentView;
const PET_AGENT = petAgentView.currentAgent();
let petMode = 'single';

function eventBelongsToThisPet(ev) {
  return petAgentView.eventBelongs(ev, petMode, PET_AGENT);
}

function statsForThisPet(snapshot) {
  return petAgentView.filterStats(snapshot, petMode, PET_AGENT);
}

const i18n = window.OctoI18n;
const t = (key, vars) => i18n ? i18n.t(key, vars) : key;
const LOCALES = { zh: 'zh-CN', en: 'en-US', ja: 'ja-JP' };
let currentLang = 'zh';
let skin = 'mascot';

function applyLanguage(next) {
  currentLang = i18n ? i18n.setLang(next) : 'zh';
  document.documentElement.lang = LOCALES[currentLang] || 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((n) => { n.title = t(n.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((n) => { n.placeholder = t(n.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((n) => { n.setAttribute('aria-label', t(n.dataset.i18nAriaLabel)); });
  updateProviderUI();
  if (sessListOpen) { slTitle.textContent = t('sess.title'); renderSessList(); }
}

const stage = document.getElementById('stage');
const pixel = document.getElementById('pixel');
const mascot = document.getElementById('mascot');
const mascotImg = document.getElementById('mascot-img');
const cat = document.getElementById('cat'), petAnchor = document.getElementById('pet-anchor');

const MASCOT_EYES = {
  working: 'mascot-work.png', // 干活：对着笔记本敲代码 + 咖啡（整幅工作场景）
  juggling: 'mascot-work.png', // 并行子任务：无独立图，回落到干活
  sweeping: 'mascot-work.png', // 清理上下文：无独立图，回落到干活
  loafing: 'mascot-sleep.png', // 间隙摸鱼：无独立图，回落到闭眼待机
  idle: 'mascot-sleep.png',   // 无任务：闭眼
  sleeping: 'mascot-sleep.png',
  thinking: 'mascot-think.png', // 思考：往上看
  happy: 'mascot-happy.png',  // 完成：^^ 笑眼
  greet: 'mascot-happy.png',
  talking: 'mascot-happy.png',
  waiting: 'mascot-wait.png', // 等你处理：瞪大
  needsinput: 'mascot-think.png', // 等你回复：往上看(期待)
  attention: 'mascot-wait.png', // 需要注意：瞪大（CodeWhale turn_end / OpenCode idle）
  error: 'mascot-wait.png',
  // 情绪短暂态 → 就近回落（专属图未画）
  loved: 'mascot-happy.png',
  excited: 'mascot-happy.png',
  sad: 'mascot-wait.png',
  sorry: 'mascot-wait.png',
  puzzled: 'mascot-think.png',
};
// B3: smooth fade when swapping mascot/cat images on state change.
const FADE_MS = 150; let fadeTimer = null;
function fadeSwapImg(img, newSrc) {
  if (!img || img.getAttribute('src') === newSrc) return;
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  img.style.opacity = '0';
  const onLoad = () => { img.removeEventListener('load', onLoad); if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; } img.style.opacity = '1'; };
  img.addEventListener('load', onLoad);
  fadeTimer = setTimeout(() => { fadeTimer = null; img.style.opacity = '1'; }, FADE_MS + 50);
  img.src = newSrc;
}
function updateMascotEyes(s) {
  if (!mascotImg) return;
  const f = MASCOT_EYES[s] || 'mascot.png';
  if (!mascotImg.getAttribute('src').endsWith(f)) fadeSwapImg(mascotImg, '../assets/' + f);
}
const catImg = document.getElementById('cat-img');
const CAT_STATES = {
  idle: 'cat-idle.gif',           // 转椅上冰淇淋+手机摸鱼：待命
  roam: 'cat-roam.gif',           // 撒腿跑着玩：闲逛
  working: 'cat-working.gif',     // 戴耳机猛拍「上号」按钮：干活
  thinking: 'cat-thinking.gif',   // 对着笔记本挠头：思考
  talking: 'cat-talking.gif',     // 对着笔记本疯狂输出喵喵喵：回应中
  juggling: 'cat-juggling.gif',   // 趴键盘上还同时刷手机：并行子任务
  sweeping: 'cat-sweeping.gif',   // 喷消毒水打扫：压缩/清理
  waiting: 'cat-waiting.gif',     // 冒汗紧张等待：等你授权
  needsinput: 'cat-needsinput.gif', // 头顶冒问号挠头：等你回复
  happy: 'cat-happy.gif',         // 摸小猫的头夸夸：完成庆祝
  greet: 'cat-greet.gif',         // 被闹钟炸醒弹射到工位：新会话火速上线
  attention: 'cat-attention.gif', // 从工位起身够手机看消息：需要注意
  sleeping: 'cat-sleeping.gif',   // 被窝里睡成一坨：睡觉
  error: 'cat-error.gif',         // 抱头崩溃大叫：出错
  loafing: 'cat-loafing.gif',     // 躺地上刷手机：上一步干完、等下一步的间隙摸鱼
  // 情绪短暂态 → 就近映射，别回落到摸鱼 idle 图（表情和文案会打架）
  loved: 'cat-happy.gif',         // 被夸 → 摸头开心
  excited: 'cat-happy.gif',
  sad: 'cat-sad.gif',             // 惹你生气了 → 嚎啕大哭
  sorry: 'cat-waiting.gif',       // 道歉 → 冒冷汗心虚
  puzzled: 'cat-needsinput.gif',  // 疑惑 → 头顶问号
};
// working/thinking stay longest → multi-pose rotation every 60s (avoids "stuck" look).
const CAT_POOLS = {
  working: [
    'cat-working.gif',   // 猛拍「上号」按钮
    'cat-working-2.gif', // 熬夜冠军：戴耳机对着显示器
    'cat-working-3.gif', // 捂着耳朵埋头猛敲键盘
    'cat-working-4.gif', // 边吃零食边敲键盘
  ],
  thinking: [
    'cat-thinking.gif',   // 对着笔记本挠头
    'cat-thinking-2.gif', // 躺着想：头顶「浮云」思考泡
  ],
  sleeping: [
    'cat-sleeping.gif',   // 被窝里睡成一坨
    'cat-sleeping-2.gif', // 坐椅子上拔下肚子毛当眼罩睡
  ],
  loafing: [
    'cat-loafing.gif',   // 躺地上刷手机
    'cat-loafing-2.gif', // 沙发上点外卖
    'cat-loafing-3.gif', // 靠着枕头奶瓶+手机
  ],
};
const CAT_ASSET_FILES = Array.from(new Set([
  ...Object.values(CAT_STATES),
  ...Object.values(CAT_POOLS).flat(),
]));
const catAssetCache = new Map();
// R30: lazy-load cat assets only when cat skin is selected (was ~2.4MB startup waste).
function preloadCatAssets() {
  for (const file of CAT_ASSET_FILES) {
    const image = new Image();
    image.decoding = 'async';
    image.src = `../assets/cat/${file}`;
    catAssetCache.set(file, image);
  }
}
function maybePreloadCatAssets() {
  if (skin === 'cat' && catAssetCache.size === 0) {
    preloadCatAssets();
  }
}
if (typeof requestIdleCallback === 'function') requestIdleCallback(maybePreloadCatAssets, { timeout: 1600 });
else setTimeout(maybePreloadCatAssets, 250);

const POOL_ROTATE_MS = 60 * 1000;
let poolIdx = 0;
let poolRot = null;
function updateCat(s) {
  if (!catImg) return;
  const pool = CAT_POOLS[s];
  const f = pool ? pool[poolIdx % pool.length] : (CAT_STATES[s] || CAT_STATES.idle);
  if (!catImg.getAttribute('src').endsWith(f)) fadeSwapImg(catImg, '../assets/cat/' + f);
  if (pool) {
    if (!poolRot) {
      poolRot = setInterval(() => {
        const cur = CAT_POOLS[state];
        if (!cur || skin !== 'cat') return;
        poolIdx++;
        fadeSwapImg(catImg, '../assets/cat/' + cur[poolIdx % cur.length]);
      }, POOL_ROTATE_MS);
    }
  } else if (poolRot) {
    clearInterval(poolRot);
    poolRot = null;
    poolIdx++; // 下次进入轮换态直接是下一张
  }
}
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const chipCost = document.getElementById('chip-cost');
const chipWindow = document.getElementById('chip-window');
const chip = document.getElementById('chip');
const sessionsEl = document.getElementById('sessions');
const radial = document.getElementById('radial');
const agentTag = document.getElementById('agent-tag');
const thinkEl = document.getElementById('think');
const sleepEl = document.getElementById('sleep');
const propEl = document.getElementById('prop');
const sidekickEl = document.getElementById('sidekick');
const askEl = document.getElementById('ask');
const askLabel = document.getElementById('ask-label');
const askSess = document.getElementById('ask-sess');
const askQhead = document.getElementById('ask-qhead');
const askQ = document.getElementById('ask-q');
const askHint = document.getElementById('ask-hint');
const askOpts = document.getElementById('ask-opts');
const askInputRow = document.getElementById('ask-input-row'); // .ask-other
const askText = document.getElementById('ask-text');
const askPage = document.getElementById('ask-page');
const askFoot = document.getElementById('ask-foot');
const askSubmit = document.getElementById('ask-submit');
const askBack = document.getElementById('ask-back');
const askTerm = document.getElementById('ask-term');
const notepad = document.getElementById('notepad');
const npBadge = document.getElementById('np-badge');
const todopop = document.getElementById('todopop');
const tpProg = document.getElementById('tp-prog');
const tpList = document.getElementById('tp-list');
const tpActs = document.getElementById('tp-acts');
const tpActSec = document.getElementById('tp-act-sec');
const tpTodoSec = document.getElementById('tp-todo-sec');
const sesslist = document.getElementById('sesslist');
const slRows = document.getElementById('sl-rows');
const slSub = document.getElementById('sl-sub');
const slTitle = document.getElementById('sl-title');
// R44 0.5.44: search + filter state for pet HUD session list
const slSearch = document.getElementById('sl-search');
let slQuery = '';
let slFilter = 'all'; // 'all' | 'claude' | 'codex' | 'attention' | 'archived'
let pinnedSet = new Set();
let archivedSet = new Set();
const pendingSessionPrefs = new Set();

let askActive = false;
let askQueue = []; // 当前所有待处理的选择/输入（每项含 project）
let askIdx = 0;
let lastAskSig = ''; // 当前面板内容签名，避免每 2s 重渲冲掉用户输入
const answered = new Set(); // 已答的 key，避免快照延迟导致重弹
let askHover = false; // 鼠标在选项面板上
let elic = null;      // elicitation 渲染态：{ key, questions, qIdx, answers, selected }
// 拖动窗口位置缓存 — 避免每次拖动走 async getWinPos 导致 pointermove 空白期/鬼畜跳
let lastWinPos = null;
// 面板开着、且(鼠标在面板上 / 输入框聚焦/有草稿 / 已选了选项) = 交互中：
// 此时别重渲面板、别改小章鱼状态，免得打断你思考/选择。面板一关就自动解除。
const isInteracting = () => askActive && (askHover || document.activeElement === askText || !!(askText && askText.value) || (elic && elic.selected != null));

// Tauri 迁移：交互状态改为事件驱动，不再每 700ms 常驻轮询。
const nativeUiBusyController = window.OctoLatestValue.createLatestValueController({
  apply: (on) => window.pet.uiBusy(on),
  retryDelays: [80, 250, 750],
  onError: (error) => rlog('ui-busy', String(error && error.message || error || 'unknown')),
});
const mouseIgnoreController = window.OctoLatestValue.createLatestValueController({
  apply: (ignore) => window.pet.setIgnoreMouse(ignore),
  retryDelays: [80, 250, 750],
  onError: (error) => rlog('mouse-ignore', String(error && error.message || error || 'unknown')),
});
let lastUiBusy = null;
function syncUiBusy(force = false) {
  // R35.2 (2026-07-31): added providerChooserOpen to the busy union.
  // The 0.5.12 carpet audit (P0-1 证据A) flagged that the chooser was
  // not in this list, so Rust's native click-through guard and the
  // territory/blur branches didn't know the chooser was open — risking
  // the chooser being treated as non-interactive while it was visible.
  const busy = !!(radialOpen || todoPopOpen || sessListOpen || askActive || providerChooserOpen || isInteracting());
  if (!force && busy === lastUiBusy) return;
  lastUiBusy = busy;
  void nativeUiBusyController.request(busy);
  if (busy) {
    setMouseIgnore(false);
    try { window.pet.focusPet(); } catch {}
  } else {
    setMouseIgnore(true);
  }
  requestAnimationFrame(reportPetVisualBounds);
}

const rlog = (tag, msg) => { try { window.pet.petLog(tag, msg); } catch {} }; // 把 UI 决策写日志，便于自检
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Round 7: route permission decisions to the correct IPC channel based on provider.
// Claude permissions → 'permission-decide', CodeWhale → 'cw-permission-decide'.
const routeDecision = (choice, behavior) => {
  // R32 (2026-07-31): CodeWhale batch authorization uses a different IPC.
  // The behavior object carries __cw_batch='session'|'tool' as a marker.
  if (behavior && behavior.__cw_batch) {
    return window.pet.decideCwPermissionBatch(choice.permId, behavior.__cw_batch);
  }
  if (choice && choice.provider === 'codewhale') {
    return window.pet.decideCwPermission(choice.permId, behavior);
  }
  return window.pet.decidePermission(choice.permId, behavior);
};
// R32 (2026-07-31): wrapper that turns the old fire-and-forget decidePermission
// pattern into await-then-finishChoice. The IPC must succeed BEFORE we remove
// the choice card — otherwise an IPC failure leaves the user thinking they
// answered while the agent is still blocked waiting.
//
// On failure: dispatch a toast event, restore the choice's interactive state,
// and DO NOT add to `answered` (so it stays in the queue for retry).
function submitDecision(choice, behavior, successMsg) {
  const buttons = askOpts ? askOpts.querySelectorAll('button') : [];
  buttons.forEach((b) => { b.disabled = true; });
  Promise.resolve()
    .then(() => routeDecision(choice, behavior))
    .then(() => {
      finishChoice(choice, successMsg);
    })
    .catch((err) => {
      const msg = String(err && (err.message || err) || 'unknown');
      rlog('ask', 'submitDecision failed: ' + msg);
      window.dispatchEvent(new CustomEvent('re-llmpet:bridge-error', {
        detail: { command: 'decide_permission', message: msg }
      }));
      // restore interactive state
      buttons.forEach((b) => { b.disabled = false; });
    });
}
// 带上 sessionId：否则同一项目下两个并行会话若问了同样的问题，会共用一个 key，
// 答掉一个就把另一个也标记成 answered 吞掉。choice 各构造处都带 sessionId。
const choiceKey = (c) => (c && (c.sessionId || '') + '|' + (c.permId || '') + '|' + (c.project || '') + '|' + (c.question || '')) || '';
const snapshotChoices = (stats) => Array.isArray(stats && stats.pendingChoices)
  ? stats.pendingChoices
  : ((stats && stats.sessions) || []).filter((x) => x.choice).map((x) => x.choice);

// 动态定高：保持上游 1.1.1 的逻辑像素尺寸和底部锚定语义。Rust 会按
// 当前 DPI 换算为物理像素，并在扩窗/缩窗时保持可见桌宠的底部中心不跳动。
const POPUP_W = 520;
const POPUP_BOTTOM = 200;
const ASK_VIEWPORT_MAX_H = 520;
let fitPopupSeq = 0;
let petSizeFrame = 0;
let pendingPetSize = null;
const petSizeController = window.OctoLatestValue.createLatestValueController({
  retryDelays: [80, 250],
  equals: (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1],
  apply: (size) => {
    markGeometryBusy(size);
    return window.pet.setPetSize(size[0], size[1]);
  },
  onError: (error) => {
    rlog('resize', 'set size failed: ' + String(error && error.message || error || 'unknown'));
  },
});
// R36 (2026-07-31): geometry revision/ack — replaces the fixed 260ms timer
// as the PRIMARY clear mechanism for geometryBusy. The 0.5.12 carpet audit
// P1-1 flagged that 260ms is a guess: slow machines / cross-monitor / high
// DPI may exceed it (HUD opens before resize settles), fast machines waste
// time waiting. Now we register a window-scoped onResized listener that
// fires when the OS actually applied the resize. When the reported size
// matches what we sent, we clear geometryBusy immediately. The 260ms timer
// is kept as a FALLBACK in case onResized never fires (e.g. Rust rejected
// the size, or the window was hidden).
//
// Verified via web-search of Tauri 2 docs: getCurrentWindow().onResized(cb)
// returns a Promise<UnlistenFn> that fires ONLY for the current window.
// The callback receives no payload (Tauri 2 limitation), so we read the
// current size via window.innerWidth/innerHeight and compare to expected.
let geometryRevision = 0;
let expectedPetSize = null;
let geometryAckUnlisten = null;
let geometryBusy = false;
let geometryBusyTimer = 0;
let petRendererDisposed = false;
function markGeometryBusy(expectedSize) {
  geometryBusy = true;
  // R36: store the expected size so onResized can confirm it matched.
  expectedPetSize = expectedSize || null;
  geometryRevision += 1;
  const myRevision = geometryRevision;
  if (geometryBusyTimer) clearTimeout(geometryBusyTimer);
  // R36: register a one-shot onResized listener for this revision.
  // If a previous listener exists (overlapping resize), unlisten it first.
  if (geometryAckUnlisten) {
    try { geometryAckUnlisten(); } catch {}
    geometryAckUnlisten = null;
  }
  const w = getCurrentTauriWindow();
  if (w && typeof w.onResized === 'function' && expectedPetSize) {
    try {
      Promise.resolve(w.onResized(() => {
        // Only handle if this is still the current revision.
        if (myRevision !== geometryRevision) return;
        // Check if the window's inner size matches what we sent (within 2px
        // tolerance for sub-pixel rounding). innerWidth/Height are CSS px.
        const actualW = Math.round(window.innerWidth || 0);
        const actualH = Math.round(window.innerHeight || 0);
        if (expectedPetSize
            && Math.abs(actualW - expectedPetSize[0]) <= 2
            && Math.abs(actualH - expectedPetSize[1]) <= 2) {
          clearGeometryBusy(myRevision);
        }
      })).then((off) => {
        // If a newer revision superseded us, or teardown already ran,
        // unlisten immediately instead of leaking a native listener.
        if ((petRendererDisposed || myRevision !== geometryRevision) && typeof off === 'function') {
          try { off(); } catch {}
        } else if (typeof off === 'function') {
          geometryAckUnlisten = off;
        }
      }).catch(() => {});
    } catch {}
  }
  // Fallback timer: clear busy after 260ms even if onResized didn't fire.
  // This handles the case where Rust rejected the size, the window is
  // hidden, or the OS didn't emit a resize event. The fallback ensures we
  // never permanently lock openRadial().
  geometryBusyTimer = setTimeout(() => {
    if (myRevision === geometryRevision) {
      clearGeometryBusy(myRevision);
    }
  }, 260);
}
function clearGeometryBusy(myRevision) {
  if (myRevision !== geometryRevision) return;
  geometryBusy = false;
  geometryBusyTimer = 0;
  expectedPetSize = null;
  // R36: unlisten the onResized listener — we got our ack (or timed out).
  if (geometryAckUnlisten) {
    try { geometryAckUnlisten(); } catch {}
    geometryAckUnlisten = null;
  }
  // After the busy window closes, re-measure and re-emit visual bounds so
  // the native hit-test region snaps to the final size.
  requestAnimationFrame(reportPetVisualBounds);
  // R35.1: if openRadial() was deferred during the busy window, open it
  // exactly once now. The flag is cleared here and in closeRadial/blur/
  // drag-start so a stale intent can't reopen the HUD after dismissal.
  if (pendingRadialOpen) {
    pendingRadialOpen = false;
    if (!radialOpen && !todoPopOpen && !sessListOpen) {
      openRadial();
    }
  }
}
function setRequestedPetSize(width, height) {
  let w = Number(width) || 0;
  let h = Number(height) || 0;
  pendingPetSize = [w, h];
  if (petSizeFrame) return;
  petSizeFrame = requestAnimationFrame(() => {
    petSizeFrame = 0;
    const size = pendingPetSize;
    pendingPetSize = null;
    if (!size) return;
    // Coalesce to the latest requested size. The controller commits its
    // dedupe cache only after IPC success, so a transient failure can retry.
    void petSizeController.request(size);
  });
}
function fitPopup(el) {
  if (!el) return;
  const seq = ++fitPopupSeq;
  requestAnimationFrame(() => {
    const measure = () => {
      if (seq !== fitPopupSeq) return;
      // 先解除当前 viewport 派生的 max-height，再在目标宽度下量真实内容。
      const prev = el.style.maxHeight;
      el.style.maxHeight = 'none';
      const contentH = el.scrollHeight;
      el.style.maxHeight = prev;
      const viewportH = el === askEl ? Math.min(contentH, ASK_VIEWPORT_MAX_H) : contentH;
      setRequestedPetSize(POPUP_W, Math.max(340, POPUP_BOTTOM + viewportH + 24));
    };
    if (Math.abs((window.innerWidth || 0) - POPUP_W) > 2) {
      setRequestedPetSize(POPUP_W, Math.max(340, window.innerHeight || 340));
      requestAnimationFrame(() => requestAnimationFrame(measure));
    } else {
      measure();
    }
  });
}
function resetPetSize() {
  fitPopupSeq++;
  setRequestedPetSize(0, 0);
}

// 从快照重建队列（多任务都在、且标明项目）
function refreshAsk(stats) {
  // 记事本行动中心开着时，事项在那里处理，别再另弹选项面板抢窗口
  if (todoPopOpen) { hideAsk(); return; }
  const items = snapshotChoices(stats)
    .filter((c) => (c.options && c.options.length) || c.allowInput);
  const present = new Set(items.map(choiceKey));
  for (const k of [...answered]) if (!present.has(k)) answered.delete(k); // 已消失=已答完，清理
  const fresh = items.filter((c) => !answered.has(choiceKey(c)));

  // 你正在答当前卡片、且它后端仍然有效 → 不重渲(保住勾选/输入)，但仍静默对账队列其余项，
  // 这样已解决的卡片不会残留、新卡片不会被你的“交互中”状态永久挡在外面。
  const cur = askActive ? askQueue[askIdx] : null;
  if (isInteracting() && cur && present.has(choiceKey(cur))) {
    askQueue = fresh;
    const i = fresh.findIndex((c) => choiceKey(c) === choiceKey(cur));
    askIdx = i >= 0 ? i : 0;
    return;
  }

  askQueue = fresh;
  if (!askQueue.length) { hideAsk(); return; }
  if (askIdx >= askQueue.length) askIdx = 0;
  const sig = askQueue.map(choiceKey).join(',');
  if (askActive && sig === lastAskSig) return; // 内容没变，别重渲（保住正在输入/勾选的）
  lastAskSig = sig;
  showAskPanel();
}

function enqueueChoice(c) {
  if (!c || (!(c.options && c.options.length) && !c.allowInput)) return;
  answered.delete(choiceKey(c));
  const i = askQueue.findIndex((x) => choiceKey(x) === choiceKey(c));
  if (i < 0) askQueue.push(c);
  // 记事本行动中心开着 → 新事项在那里显示，不另弹面板
  if (todoPopOpen) { renderTodoPop(); return; }
  // 你正在答当前面板时，新任务先进队列、不抢面板（等你答完再显示），避免打断
  if (isInteracting() && askActive) return;
  askIdx = askQueue.findIndex((x) => choiceKey(x) === choiceKey(c));
  showAskPanel();
}

function showAskPanel() {
  const c = askQueue[askIdx];
  if (!c) { hideAsk(); return; }
  if (sessListOpen) closeSessList(); // 卡片优先于会话列表

  const sess = c.sessionId ? ' · #' + String(c.sessionId).slice(-3) : '';
  askSess.textContent = (c.project || '?') + sess;

  if (c.kind === 'ask') {
    if (!elic || elic.key !== choiceKey(c)) {
      elic = { key: choiceKey(c), questions: Array.isArray(c.questions) ? c.questions : [], qIdx: 0, answers: {}, selected: null, selSet: [], multi: false, otherOn: false };
    }
    renderElicitation(c);
  } else {
    elic = null;
    if (c.kind === 'perm' && c.permId) renderPerm(c);
    else if (c.kind === 'plan' && c.permId) renderPlan(c);
    else renderContinue(c);
  }

  bubble.classList.add('hidden');
  askEl.classList.remove('hidden');
  lastAskSig = askQueue.map(choiceKey).join(',');
  askActive = true;
  syncUiBusy();
  rlog('ask', 'show ' + (c.kind || '') + ': ' + String(c.question || '').slice(0, 36));
  fitPopup(askEl); // 富卡片：动态定高 + 440 宽
}

function clearAskBody() {
  askOpts.innerHTML = '';
  askOpts.classList.remove('perm-row');
  askQhead.textContent = '';
  askHint.textContent = '';
  askPage.textContent = '';
  askInputRow.classList.add('hidden');
  askText.value = '';
}

// ① elicitation（AskUserQuestion）：多选项卡 + Other + 分页 + Submit/Back
function renderElicitation(c) {
  clearAskBody();
  askLabel.textContent = 'Needs Input';
  const qs = elic.questions;
  const q = qs[elic.qIdx] ||
    { question: c.question || t('pet.ask.needAnswer'), options: (c.options || []).map((o) => ({ label: o.label, description: o.desc })) };
  askQhead.textContent = q.header || '';
  askQ.textContent = q.question || '';
  const multi = !!q.multiSelect;
  elic.multi = multi;
  askHint.textContent = multi ? t('pet.ask.multiSelect') : t('pet.ask.chooseOne');

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
  if (!askText.dataset.ph) askText.dataset.ph = askText.placeholder || t('pet.ask.inputPlaceholder');
  askText.placeholder = t('pet.ask.emptyWarn');
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
  // R32 (2026-07-31): await IPC before removing the choice card.
  submitDecision(c, { type: 'elicitation-submit', answers: { ...elic.answers } }, t('pet.ask.submitted'));
}

function elicBack(c) {
  if (elic && elic.qIdx > 0) { elic.qIdx--; renderElicitation(c); }
}

// ② 授权：允许(绿)/拒绝(红) + 可选会话级批量授权按钮
function renderPerm(c) {
  clearAskBody();
  askLabel.textContent = t('pet.ask.needAuth');
  askQhead.textContent = c.header || '';
  askQ.textContent = c.question || t('pet.ask.needYouAuth');
  const opts = c.options || [];
  if (opts.length === 2) askOpts.classList.add('perm-row'); // 仅允许/拒绝时并排
  opts.forEach((opt) => {
    // W11: batch-allow keys (cw-allow-session, cw-allow-tool) render as green
    // "allow" style, not neutral "sugg" — they're approval actions.
    const isAllow = opt.key === 'allow' || opt.key === 'cw-allow-session' || opt.key === 'cw-allow-tool';
    const kind = isAllow ? 'allow' : opt.key === 'deny' ? 'deny' : 'sugg';
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
  askQ.textContent = c.question || t('pet.ask.waitingReply', { provider: firstProviderLabel() });
  askFoot.classList.add('hidden');
  askTerm.classList.remove('hidden');
}

// ④ ExitPlanMode 方案评审：展示方案 + 批准 / 打回并反馈
function renderPlan(c) {
  clearAskBody();
  askLabel.textContent = t('pet.ask.planReview');
  askQhead.textContent = c.project ? '📂 ' + c.project : '';
  askQ.textContent = c.question || t('pet.ask.reviewPlan');
  const approve = document.createElement('button');
  approve.className = 'ask-opt act allow';
  approve.innerHTML = `<span class="ask-ot"><span class="ask-ol">${t('pet.ask.approve')}</span></span>`;
  approve.addEventListener('click', () => submitPerm('allow', c, t('pet.ask.approved')));
  askOpts.appendChild(approve);
  const reject = document.createElement('button');
  reject.className = 'ask-opt act deny';
  reject.innerHTML = `<span class="ask-ot"><span class="ask-ol">${t('pet.ask.reject')}</span></span>`;
  reject.addEventListener('click', () => {
    // R32 (2026-07-31): await IPC before removing the choice card.
    submitDecision(c, { type: 'plan-feedback', feedback: (askText.value || '').trim() }, t('pet.ask.rejected'));
  });
  askOpts.appendChild(reject);
  askInputRow.classList.remove('hidden');
  askText.placeholder = t('pet.ask.feedbackPlaceholder');
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
    // 先关面板（置 askActive=false），确认气泡才不会被 showBubble 的 askActive 早退拦掉
    hideAsk();
    showBubble(bubbleMsg, 2600);
  }
}
function submitPerm(key, choice, label) {
  const msg = key === 'allow' ? t('pet.perm.allowed') : key === 'deny' ? t('pet.perm.denied') : t('pet.perm.remembered');
  // W11/W24: CodeWhale batch authorization keys.
  // R32 (2026-07-31): all paths now go through submitDecision() so the IPC
  // is awaited and the choice card is only removed on actual success.
  if (key === 'cw-allow-session') {
    submitDecision(choice, { __cw_batch: 'session' }, t('pet.perm.batchSession'));
    return;
  }
  if (key === 'cw-allow-tool') {
    submitDecision(choice, { __cw_batch: 'tool' }, t('pet.perm.batchTool'));
    return;
  }
  submitDecision(choice, key, msg);
}
// Go to Terminal：去会话终端自己答（授权/elicitation 都回 deny，让 CC 在终端重问）
// R32 (2026-07-31): focusSession is fire-and-forget (open terminal is best-
// effort), but the deny decision MUST be awaited — otherwise an IPC failure
// would leave the agent thinking we denied, while the user is in the terminal
// re-answering, causing double-submit confusion.
function gotoSession(choice) {
  if (!choice.permId) {
    // No permission to deny — just focus the terminal and finish.
    window.pet.focusSession(choice.sessionId || '');
    finishChoice(choice, t('pet.action.terminalTaken'));
    return;
  }
  // With a permission: await the deny, then focus the terminal and finish.
  const buttons = askOpts ? askOpts.querySelectorAll('button') : [];
  buttons.forEach((b) => { b.disabled = true; });
  Promise.resolve()
    .then(() => routeDecision(choice, 'deny'))
    .then(() => {
      window.pet.focusSession(choice.sessionId || '');
      finishChoice(choice, '💬 已带你去终端');
    })
    .catch((err) => {
      const msg = String(err && (err.message || err) || 'unknown');
      rlog('ask', 'gotoSession deny failed: ' + msg);
      window.dispatchEvent(new CustomEvent('re-llmpet:bridge-error', {
        detail: { command: 'decide_permission', message: msg }
      }));
      buttons.forEach((b) => { b.disabled = false; });
    });
}

function hideAsk() {
  if (askActive) rlog('ask', 'hide');
  lastAskSig = '';
  elic = null;
  askEl.classList.add('hidden');
  askHover = false;
  if (askText) askText.value = ''; // 清掉草稿，避免关闭后仍被判为「交互中」冻住状态
  if (askActive) { askActive = false; resetPetSize(); window.pet.blurPet(); }
  syncUiBusy();
}

// ---------- 记事本 / 行动清单 ----------
let curTodos = [];
let curTodosProj = '';
let curSessions = [];
let curPendingChoices = [];
let todoPopOpen = false;
const TODO_ICON = { completed: '✅', in_progress: '▶️', pending: '⬜️' };

// 当前需要你处理的事项：有 choice、还没答过的 waiting/needsinput 会话
function actionableItems() {
  return curPendingChoices
    .filter((choice) => !answered.has(choiceKey(choice)))
    .filter((choice) => (choice.options && choice.options.length) || choice.allowInput);
}

let notepadShown = false;
function updateNotepad(s) {
  curTodos = Array.isArray(s.todos) ? s.todos : [];
  curTodosProj = s.todosProject || '';
  curSessions = s.sessions || [];
  curPendingChoices = snapshotChoices(s);
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

function renderTodoPop() {
  const acts = actionableItems();
  const done = curTodos.filter((t) => t.status === 'completed').length;
  tpProg.textContent = curTodos.length ? `${t('pet.todo.label')} ${done}/${curTodos.length}` : '';
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
}

// 一张「需要你处理」卡片：问题 + 选项按钮(可点即答) + 自定义输入
function buildActCard(c) {
  const card = document.createElement('div');
  card.className = 'tp-act';
  const kindTag = c.kind === 'perm' ? t('pet.kind.perm') : c.kind === 'continue' ? t('pet.kind.continue') : c.kind === 'plan' ? t('pet.kind.plan') : t('pet.kind.choice');
  const head = document.createElement('div');
  head.className = 'tp-act-proj';
  head.textContent = `📂 ${c.project || '?'} · ${kindTag}`;
  card.appendChild(head);
  const q = document.createElement('div');
  q.className = 'tp-act-q';
  q.textContent = (c.header ? '【' + c.header + '】 ' : '') + (c.question || t('pet.action.needHandle'));
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
    go.textContent = t('pet.action.goReply');
    go.addEventListener('click', (e) => { e.stopPropagation(); popGoto(c); });
    opts.appendChild(go);
  }
  card.appendChild(opts);
  return card;
}

// 授权：回 CC 决策
// R32 (2026-07-31): await IPC before marking answered — the todo popup card
// stays interactive (the popup itself doesn't close on success, but if IPC
// fails the choice must remain answerable).
function popPerm(choice, key) {
  const msg = key === 'allow' ? t('pet.perm.allowed') : key === 'deny' ? t('pet.perm.denied') : t('pet.perm.rememberedShort');
  const todoPop = document.getElementById('todo-pop');
  const buttons = todoPop ? todoPop.querySelectorAll('button') : [];
  buttons.forEach((b) => { b.disabled = true; });
  Promise.resolve()
    .then(() => routeDecision(choice, key))
    .then(() => {
      answered.add(choiceKey(choice));
      showBubble(msg, 2200);
      renderTodoPop();
      maybeCloseEmptyPop();
    })
    .catch((err) => {
      const m = String(err && (err.message || err) || 'unknown');
      rlog('ask', 'popPerm failed: ' + m);
      window.dispatchEvent(new CustomEvent('re-llmpet:bridge-error', {
        detail: { command: 'decide_permission', message: m }
      }));
      buttons.forEach((b) => { b.disabled = false; });
    });
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
  if (askActive) hideAsk(); // 别和选项面板抢窗口
  if (sessListOpen) closeSessList();
  renderTodoPop();
  todopop.classList.remove('hidden');
  todoPopOpen = true;
  syncUiBusy();
  rlog('pop', `open acts=${actionableItems().length} todos=${curTodos.length}`);
  fitPopup(todopop);
}
function closeTodoPop() {
  todopop.classList.add('hidden');
  todoPopOpen = false;
  syncUiBusy();
  rlog('pop', 'close');
  window.pet.blurPet();
  resetPetSize();
}

// ---------- 会话列表 HUD（左键弹出）----------
let sessListOpen = false;
// Claude 橙色 burst（小图标）
const CLAUDE_ICON =
  '<svg viewBox="0 0 24 24" fill="#d97757"><path d="M12 1l2.2 6.3L20.5 5l-4 5.4 6.5 1.6-6.5 1.6 4 5.4-6.3-2.3L12 23l-2.2-6.3L3.5 19l4-5.4L1 12l6.5-1.6-4-5.4 6.3 2.3z"/></svg>';
// Keep provider identity visible in the mixed-session HUD. Codex reuses the
// official upstream terminal glyph; the remaining providers use compact local
// symbols so they are never visually misrepresented as Claude.
const CODEX_ICON =
  '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" fill="#3b82f6"/>' +
  '<path d="M7 8l4 4-4 4" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M13 16.5h4.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>';
const PROVIDER_ICONS = { claude: CLAUDE_ICON, codewhale: '🐋', codex: CODEX_ICON, opencode: '🧩', dsh: '🌊' };
const PROVIDER_LABELS = { claude: 'Claude', codewhale: 'CodeWhale', codex: 'Codex', opencode: 'OpenCode', dsh: 'dsh' };
const SESS_META = {
  waiting: t('pet.state.waiting'), needsinput: t('pet.state.needsinput'),
  working: t('pet.state.working'), juggling: t('pet.state.juggling'), sweeping: t('pet.state.sweeping'),
  thinking: t('pet.state.thinking'), loafing: t('pet.state.loafing'), error: t('pet.state.error'),
  idle: t('pet.state.idle'), sleeping: t('pet.state.sleeping'),
};
const SESS_SORT = { waiting: 0, needsinput: 0, error: 1, working: 2, juggling: 2, sweeping: 2, thinking: 2, loafing: 3, idle: 4, sleeping: 5 };
const SESSION_STATE_KEYS = {
  waiting: 'state.waiting', needsinput: 'state.needsinput', working: 'state.working',
  juggling: 'state.juggling', sweeping: 'state.sweeping', thinking: 'state.thinking',
  loafing: 'state.loafingLong', error: 'state.error', idle: 'state.idle', sleeping: 'state.sleeping',
};
function sessionStateLabel(value) {
  const key = SESSION_STATE_KEYS[value];
  return key ? t(key) : (SESS_META[value] || value || '');
}

// 对齐参考项目阈值：≥90% 红(hot)、≥75% 黄(warm)、其余灰
function ctxClass(p) { return p >= 90 ? 'high' : p >= 75 ? 'mid' : ''; }

// 单一判定：哪些会话出现在「头顶小点」和「会话列表 HUD」里（保持两处联动一致）
const isVisibleSession = (s) => !!s && !s.headless && s.state !== 'sleeping';
// 单一配色：小点和 HUD 用同一套（完成→绿、中断→红，否则按状态）
function sessionDotClass(s) {
  if (s.state === 'idle' && s.badge === 'done') return 'done';
  if (s.state === 'idle' && s.badge === 'interrupted') return 'error';
  return s.state || 'idle';
}

function visibleSessions() {
  return (curSessions || [])
    .filter(isVisibleSession)
    .filter((s) => {
      // R44 0.5.44: apply search query
      if (slQuery) {
        const q = slQuery.toLowerCase();
        const project = (s.project || '').toLowerCase();
        const op = (s.op || '').toLowerCase();
        const sid = (s.sessionId || '').toLowerCase();
        const provider = (s.providerId || s.provider || '').toLowerCase();
        if (!project.includes(q) && !op.includes(q) && !sid.includes(q) && !provider.includes(q)) {
          return false;
        }
      }
      // Apply filter
      const provider = s.providerId || s.provider || '';
      if (slFilter === 'attention') {
        if (s.state !== 'waiting' && s.state !== 'needsinput') return false;
      } else if (slFilter === 'archived') {
        if (!archivedSet.has(s.sessionId)) return false;
      } else {
        // Normal and provider views hide archived unless explicitly requested.
        if (archivedSet.has(s.sessionId)) return false;
        if ((slFilter === 'claude' || slFilter === 'codex') && provider !== slFilter) return false;
      }
      return true;
    })
    .sort((a, b) => {
      // R44 0.5.44: pinned sessions first
      const ap = pinnedSet.has(a.sessionId) ? 0 : 1;
      const bp = pinnedSet.has(b.sessionId) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      const pa = SESS_SORT[a.state] != null ? SESS_SORT[a.state] : 3;
      const pb = SESS_SORT[b.state] != null ? SESS_SORT[b.state] : 3;
      if (pa !== pb) return pa - pb;
      return (a.idleMs || 0) - (b.idleMs || 0);
    });
}

function renderSessList() {
  const list = visibleSessions();
  slSub.textContent = list.length ? t('sess.count', { n: list.length }) : '';
  slRows.innerHTML = '';
  if (!list.length) {
    const e = document.createElement('div');
    e.className = 'sl-empty';
    e.textContent = t('sess.empty');
    slRows.appendChild(e);
    return;
  }
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'sl-row';
    if (pinnedSet.has(s.sessionId)) row.classList.add('pinned');
    const attn = s.state === 'waiting' || s.state === 'needsinput';
    let meta;
    if (attn) meta = s.reason
      ? t(s.state === 'waiting' ? 'sess.waitFor' : 'sess.replyFor', { reason: s.reason })
      : sessionStateLabel(s.state);
    else if (s.state === 'working' || s.state === 'juggling' || s.state === 'sweeping' || s.state === 'thinking') meta = s.op || sessionStateLabel(s.state);
    else if (s.badge === 'done') meta = t('sess.justDone');
    else if (s.badge === 'interrupted') meta = t('sess.interrupted');
    else meta = sessionStateLabel(s.state);
    const dotCls = sessionDotClass(s);
    const ctx = typeof s.contextPercent === 'number'
      ? `<span class="sl-ctx ${ctxClass(s.contextPercent)}">${s.contextPercent}%</span>` : '';
    const providerId = s.providerId || s.provider;
    const provIcon = PROVIDER_ICONS[providerId] || '•';
    // R44 0.5.44: pin/archive action buttons (shown on hover)
    const isPinned = pinnedSet.has(s.sessionId);
    const isArchived = archivedSet.has(s.sessionId);
    const prefDisabled = pendingSessionPrefs.has(s.sessionId) ? ' disabled' : '';
    const pinBtn = isPinned
      ? `<button class="sl-action sl-unpin" title="${t('sess.unpin')}"${prefDisabled}>📌</button>`
      : `<button class="sl-action sl-pin" title="${t('sess.pin')}"${prefDisabled}>📍</button>`;
    const archiveBtn = isArchived
      ? `<button class="sl-action sl-unarchive" title="${t('sess.unarchive')}"${prefDisabled}>📥</button>`
      : `<button class="sl-action sl-archive" title="${t('sess.archive')}"${prefDisabled}>📤</button>`;
    const travelBtn = !s.headless && ['claude', 'codex'].includes(s.providerId || s.provider)
      ? `<button class="sl-action sl-travel" title="${t('pet.travel.title')}">🧳</button>` : '';
    row.innerHTML =
      `<span class="sl-dot ${dotCls}"></span>` +
      `<span class="sl-icon">${provIcon}</span>` +
      `<div class="sl-main"><div class="sl-name">${esc(s.project)}</div>` +
      `<div class="sl-meta ${attn ? 'attn' : ''}">${esc(meta)}</div></div>` +
      ctx +
      `<span class="sl-row-actions">${travelBtn}${pinBtn}${archiveBtn}</span>`;
    // Click row → focus session
    row.addEventListener('click', (e) => {
      if (e.target.closest('.sl-action')) return; // action button click handled separately
      window.pet.focusSession(s.sessionId || '');
      rlog('sesslist', 'focus ' + (s.project || ''));
      closeSessList();
    });
    const travelEl = row.querySelector('.sl-travel');
    if (travelEl) travelEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await window.pet.startTravel(s.sessionId || '', `探索 ${s.project || '这个项目'} 的结构、风险与值得记录的发现`);
        showBubble(`🧳 ${s.project || '项目'}：出发旅行！`, 3200, true);
        closeSessList();
      } catch (error) {
        showBubble(`⚠️ 无法出发：${String(error && (error.message || error) || 'unknown')}`, 5000, true);
      }
    });
    // Pin/unpin
    const pinEl = row.querySelector('.sl-pin, .sl-unpin');
    if (pinEl) pinEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const previous = { pinned: isPinned, archived: isArchived };
      pendingSessionPrefs.add(s.sessionId);
      if (isPinned) pinnedSet.delete(s.sessionId);
      else {
        pinnedSet.add(s.sessionId);
        archivedSet.delete(s.sessionId);
      }
      persistSessionPref(s.sessionId, 'pin', !isPinned, previous);
      renderSessList();
    });
    // Archive/unarchive
    const archEl = row.querySelector('.sl-archive, .sl-unarchive');
    if (archEl) archEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const previous = { pinned: isPinned, archived: isArchived };
      pendingSessionPrefs.add(s.sessionId);
      if (isArchived) archivedSet.delete(s.sessionId);
      else {
        archivedSet.add(s.sessionId);
        pinnedSet.delete(s.sessionId);
      }
      persistSessionPref(s.sessionId, 'archive', !isArchived, previous);
      renderSessList();
    });
    slRows.appendChild(row);
  }
}

function persistSessionPref(sessionId, action, enabled, previous) {
  if (!window.pet) {
    pendingSessionPrefs.delete(sessionId);
    renderSessList();
    return;
  }
  const request = Promise.resolve().then(() => window.OctoSessionPrefs.save(
    window.pet, sessionId, action, enabled, pinnedSet, archivedSet,
  ));
  request.catch((err) => {
    pinnedSet[previous.pinned ? 'add' : 'delete'](sessionId);
    archivedSet[previous.archived ? 'add' : 'delete'](sessionId);
    const message = String(err && (err.message || err) || 'unknown');
    window.dispatchEvent(new CustomEvent('re-llmpet:bridge-error', {
      detail: { command: window.pet.setSessionPref ? 'set_session_pref' : 'set_session_prefs', message },
    }));
  }).finally(() => {
    pendingSessionPrefs.delete(sessionId);
    renderSessList();
  });
}
const sessionLifecycle = window.OctoPetSessionLifecycle.create({ element: sesslist,
  isOpen: () => sessListOpen, setOpen: (v) => { sessListOpen = v; }, radialOpen: () => radialOpen, closeRadial,
  todoOpen: () => todoPopOpen, closeTodo: closeTodoPop, providerChooserOpen: () => providerChooserOpen,
  closeProviderChooser, hideAsk, render: renderSessList, syncBusy: syncUiBusy, log: rlog,
  visibleCount: () => visibleSessions().length, fit: fitPopup, resetSize: resetPetSize });
const { open: openSessList, close: closeSessList, toggle: toggleSessList } = sessionLifecycle;
const travelView = window.OctoPetTravelView.create({
  api: window.pet,
  bubble: showBubble,
  close: closeSessList,
  provider: PET_AGENT,
});
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
let currentCurrency = 'USD';
let currentFxRate = 7.2;
let transientUntil = 0;   // 短暂状态（happy/error）持续到的时间
let transientState = null;
let muted = false;
let lastWaiting = 0;
let lastBgZombie = 0; // 后台疑似僵尸数
let radialOpen = false;

const IDLE_SLEEP_MS = 6 * 60 * 1000;
const stateEls = [pixel, mascot, cat].filter(Boolean);
const DEBUG_STATE = null; // 调试用：强制某状态（如 'sleeping'）；正常运行设为 null

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
  if (state === s) return;
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
  if (skin === 'cat') updateCat(s);
  requestAnimationFrame(reportPetVisualBounds);
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
  }
  if (act === 'summon') {
    sidekickEl.classList.remove('on');
    void sidekickEl.offsetWidth;
    sidekickEl.classList.add('on');
  }
  clearTimeout(actTimer);
  actTimer = setTimeout(clearAction, 2200);
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
const SOUND = {
  waiting: () => beep([660, 880], 0.2, 'sine', 0.08), // 上行提示音
  done: () => beep([784, 1047], 0.15, 'triangle', 0.06), // 愉快叮咚
  error: () => beep([220, 165], 0.2, 'sawtooth', 0.05), // 低沉
  greet: () => beep([523, 784], 0.13, 'sine', 0.05), // 招呼
  bigDone: () => beep([659, 784, 988, 1319], 0.13, 'triangle', 0.07), // 上行小号角
};

// 大任务完成的彩带
function confetti() {
  const el = curSkinEl();
  const sr = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const cx = r.left - sr.left + r.width / 2;
  const cy = r.top - sr.top + r.height * 0.35;
  const emojis = ['🎉', '✨', '⭐', '🧡', '🎊'];
  for (let i = 0; i < 12; i++) {
    const s = document.createElement('span');
    s.className = 'confetti';
    s.textContent = emojis[i % emojis.length];
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.8; // 向上扇形
    const dist = 45 + Math.random() * 70;
    s.style.left = cx + 'px';
    s.style.top = cy + 'px';
    s.style.fontSize = 12 + Math.random() * 12 + 'px';
    s.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
    s.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
    s.style.animationDelay = Math.random() * 0.12 + 's';
    stage.appendChild(s);
    setTimeout(() => s.remove(), 1300);
  }
}

function showBubble(text, holdMs = 3200, force = false) {
  if (!force && (muted || radialOpen || askActive)) return; // 选项面板开着时不弹气泡盖住它(force=重要提示强制显示)
  // emoji → 内联 SVG（OctoIcons 在 emoji 字符与 SVG 之间做安全替换；不可识别字符原样保留）
  if (window.OctoIcons && window.OctoIcons.hasMappedEmoji(text)) {
    window.OctoIcons.setTextWithIcons(bubbleText, text);
  } else {
    bubbleText.textContent = text;
  }
  bubble.classList.remove('hidden');
  bubble.scrollTop = 0; // 重置滚动到顶（上次长气泡可能滚到了下边）
  // 大段文字：把窗口按实际高度撑开（fitPopup 已按屏幕封顶，永远不顶出屏幕；
  // 实在超屏时由 #bubble 自身 overflow-y:auto 内滚动兜底）。
  fitPopup(bubble);
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, holdMs);
}
function hideBubble() {
  bubble.classList.add('hidden');
  // 若没有其它弹层占用大窗口尺寸，恢复原始尺寸（避免 pet 一直停在加大窗口里）
  if (!askActive && !sessListOpen && !todoPopOpen) resetPetSize();
}

function scheduleBlink() {
  clearTimeout(blinkTimer); // 防御性：确保前一个链被断开
  blinkTimer = setTimeout(() => {
    // 仅像素怪兽保留 class 眨眼位（cat 是 GIF 自带动效；mascot 之前的
    // 「眨眼」是把整幅工作场景换成闭眼底图 150ms，观感是画面闪断，已移除）。
    if (skin === 'pixel' && state !== 'sleeping' && state !== 'waiting') {
      pixel.classList.add('blink');
      setTimeout(() => pixel.classList.remove('blink'), 160);
    }
    scheduleBlink();
  }, 2500 + Math.random() * 4000);
}
scheduleBlink();

// 空闲小动作：闲着时偶尔东张西望 / 蹦一下，更有生命感
let idleActionTimer = null;
function scheduleIdleAction() {
  clearTimeout(idleActionTimer); // 防御性：确保前一个链被断开
  idleActionTimer = setTimeout(() => {
    if (state === 'idle' && !radialOpen && !muted) {
      // 只有像素怪兽有 peek 动画；mascot 的 glance CSS 指向已不存在的
      // #teyes（img 皮肤没有 SVG 眼睛节点），cat 由 GIF 自带动效。
      if (skin === 'pixel') {
        pixel.classList.add('peek');
        setTimeout(() => pixel.classList.remove('peek'), 620);
      }
    }
    scheduleIdleAction();
  }, 7000 + Math.random() * 7000);
}
scheduleIdleAction();

const curSkinEl = () => (skin === 'pixel' ? pixel : skin === 'cat' ? cat : mascot);

// ---------- 事件 ----------
window.pet.onEvent((ev) => {
  if (!ev || typeof ev !== 'object') return; // R1-A#3: reject malformed payloads
  if (!eventBelongsToThisPet(ev)) return;
  // 你正在答面板/打字时：新的待答任务只悄悄进队列(不抢面板)，其余动画/彩带/气泡/状态变化一律不打断
  if (isInteracting()) {
    if ((ev.kind === 'waiting' || ev.kind === 'needsinput') && ev.choice) enqueueChoice(ev.choice);
    return;
  }
  switch (ev.kind) {
    case 'operation': {
      // 高优先级稳态（等授权/等回复/出错/清理）不被工具事件降级成 working——
      // 之前 error 期间其它会话干活会导致 working↔error 持续闪烁。
      const hold = state === 'waiting' || state === 'needsinput' || state === 'error' || state === 'sweeping';
      // transient（thinking/happy/talking…）存续期间也不盖（STATES.md：短暂态高于聚合）
      if (!hold && perfNow() >= transientUntil) {
        setState('working');
        playAction(ev.tool, ev.icon);
      }
      showBubble(`${ev.icon || '🔧'} ${ev.detail}`);
      break;
    }
    case 'say':
      if (ev.text && ev.text.length > 2 && state !== 'waiting') {
        const dur = Math.min(6000, Math.max(2200, ev.text.length * 80));
        // Stop 会同批派生 turn-done(happy) + say(talking)：让庆祝先演完，
        // talking 排在 happy 结束后接棒，气泡文本立刻显示不用等。
        if (transientState === 'happy' && perfNow() < transientUntil) {
          showBubble(`💬 ${ev.text}`, Math.min(4200, dur));
          const token = ++sayToken;
          setTimeout(() => {
            if (token === sayToken && state !== 'waiting') transient(ev.emotion || 'talking', dur);
          }, Math.max(0, transientUntil - perfNow()));
        } else if (ev.emotion) {
          // Claude 的话里带情绪（sorry/puzzled/excited）→ 短暂表情替代 talking
          transient(ev.emotion, 2800, `💬 ${ev.text}`, Math.min(4200, ev.text.length * 80));
        } else {
          transient('talking', dur, `💬 ${ev.text}`, Math.min(4200, dur));
        }
      }
      break;
    case 'user-turn':
      // 你的输入里带情绪（loved/sad/excited）→ 章鱼即时反应；否则像以前一样进 thinking
      if (ev.emotion && state !== 'waiting') {
        const tip = ev.emotion === 'loved' ? t('pet.emotion.loved') : ev.emotion === 'sad' ? t('pet.emotion.sad') : t('pet.emotion.default');
        transient(ev.emotion, 2800, tip, 2600);
      } else {
        // 多会话时聚合里 working > thinking，直接 setState 会在下个快照被盖掉
        // （只闪 ~150ms）。用 transient 保证「刚提交任务」的思考表情至少停留一会。
        if (state !== 'waiting') transient('thinking', 3500);
        showBubble(t('bubble.newTask'), 2600);
      }
      break;
    case 'turn-done':
      transient('happy', 1800, '✅ 这一轮搞定啦！', 3400);
      SOUND.done();
      break;
    case 'big-done':
      transient('happy', 2200, `🎉 大任务搞定！(${ev.ops || ''}步)`, 3800);
      confetti();
      SOUND.bigDone();
      break;
    case 'error':
      transient('error', 2600, ev.text || '😵 出了点状况，在想办法…', 3000);
      SOUND.error();
      break;
    case 'waiting':
      clearTransient(); // 残留的 talking/thinking 短暂态不得盖过等授权
      setState('waiting');
      SOUND.waiting();
      if (ev.choice && ((ev.choice.options && ev.choice.options.length) || ev.choice.allowInput)) {
        enqueueChoice(ev.choice); // 直接弹出选项/输入
      } else {
        showBubble(`✋ ${ev.project || ''} 等你${ev.reason || '处理'}`, 6000);
      }
      break;
    case 'needsinput':
      // Claude 在末尾问「要不要继续」之类，等你回复 → 黄点 + 可在桌宠上继续/回复
      if (state !== 'waiting') { clearTransient(); setState('needsinput'); }
      SOUND.done();
      if (ev.choice && ((ev.choice.options && ev.choice.options.length) || ev.choice.allowInput)) {
        enqueueChoice(ev.choice);
      } else {
        showBubble(`💬 ${ev.project || ''} 等你回复`, 6000);
      }
      break;
    case 'greet':
      transient('greet', 2000, `👋 ${ev.project || ''} 新会话，你好！`, 2600);
      SOUND.greet();
      break;
    case 'choose-provider': {
      // R35.1: primary_action emits this when >1 provider enabled & no
      // active session. Open chooser so user explicitly picks (P0-5 fix).
      // P4-2 (R3): only show chooser on the pet matching ev.provider.
      if (currentPetAgent() === (ev.provider || 'claude')) {
        openProviderChooser();
      }
      break;
    }
    case 'longcmd':
      if (state !== 'waiting') showBubble(t('bubble.longCommand'), 3000);
      break;
    case 'travel':
      if (ev.phase === 'started') transient('excited', 2200, ev.text || '🧳 出发旅行！', 3200);
      else if (ev.phase === 'completed') transient('happy', 2600, ev.text || '📮 旅行完成！', 8000);
      else if (ev.phase === 'failed') transient('error', 2600, ev.text || '旅行失败', 5000);
      break;
    case 'territory':
      // 领地模式(main 的 territory 编排):发现别的桌宠 → 走过去顶到屏幕边上。
      // 全程复用现成情绪态,窗口走位由主进程完成,这里只负责表情/气泡/音效。
      switch (ev.phase) {
        case 'spotted':
          transient('puzzled', 2400, `👀 咦？「${ev.rival || '不明生物'}」闯进我的地盘！`, 2600);
          SOUND.waiting();
          break;
        case 'march':
          // 推挤最长十几秒,给个长时限的斗志表情,victory/defeat 到了自然接管
          transient('excited', 16000, '🥊 走开走开！这是我的桌面！', 3200);
          break;
        case 'victory':
          transient('happy', 2800, '🏆 哼！把它顶到墙边啦～', 3400);
          confetti();
          SOUND.bigDone();
          break;
        case 'defeat':
          transient('sad', 3000, `😤 「${ev.rival || '它'}」纹丝不动…算它狠！`, 3200);
          SOUND.error();
          break;
        case 'partial':
          transient('excited', 3200, `💨 已经把「${ev.rival || '它'}」推到系统允许的最边上啦！`, 3600);
          SOUND.done();
          break;
        case 'ontop':
          // 猫爪在上定律:发现别的桌宠进程,窗口层级已被主进程抬到最上
          transient('excited', 2600, `🐾 猫爪在上定律！「${ev.rival || '入侵者'}」不许压着我～`, 3000);
          SOUND.greet();
          break;
        case 'noperm':
          showBubble('🔒 想把入侵者顶走，但还没有「辅助功能」权限（系统设置 → 隐私与安全性 → 辅助功能）', 7000);
          break;
        case 'searching':
          showBubble(t('bubble.patrolling'), 2400);
          break;
        case 'clear':
          showBubble(t('bubble.patrolDone'), 2600);
          break;
        case 'busy':
          showBubble(t('bubble.patrolBusy'), 2600);
          break;
        case 'abort':
          // 中途撤退(用户来了/弹层打开):静默收掉 march 的长斗志表情,
          // 立刻回落到真实聚合态,不冒气泡打扰正事。
          clearTransient();
          if (lastStats) applyStats(lastStats);
          break;
      }
      break;
    // W12: cancel — a permission was resolved server-side (auto-close, client
    // disconnect, batch-clear, or user clicked). Remove the matching choice from
    // the ask queue and hide the panel if it was the current one. This prevents
    // the pet from staying stuck on "waiting" when the user acts in the
    // CodeWhale terminal or presses Ctrl+C instead of clicking the pet bubble.
    case 'cancel': {
      if (ev.permId) {
        // R30 (2026-07-31): capture the choice BEFORE filtering it out.
        // The old code did filter() then find() on the filtered array,
        // which always returned undefined — making the cancel handler
        // a no-op and cancelled choices re-appeared from stale snapshots.
        const cancelled = askQueue.find((c) => c.permId === ev.permId)
          || { sessionId: ev.sessionId, permId: ev.permId };
        // Remove from queue by permId
        askQueue = askQueue.filter((c) => c.permId !== ev.permId);
        answered.add(choiceKey(cancelled));
        // If the current ask panel is showing this permId, hide it / advance
        if (askActive && askQueue.length === 0) {
          hideAsk();
          // Clear the waiting state — settle back to idle/working via stats
          if (state === 'waiting' || state === 'needsinput') {
            setState('idle');
            if (lastStats) applyStats(lastStats);
          }
        } else if (askActive && askQueue.length > 0) {
          // Show the next queued choice
          askIdx = 0;
          showAskPanel();
        }
      }
      break;
    }
    // R13: handle 'state' kind events (from OpenCode session.status, CodeWhale mode_change, etc.)
    // These provide immediate state transitions without waiting for the next stats snapshot.
    // R22 (2026-08-10): allow high-priority sticky states (waiting, needsinput,
    // error, attention) to break through the transient suppression window.
    // Previously, a turn-done transient (1.8s) would block the subsequent
    // attention state event from CodeWhale turn_end, leaving the pet stuck
    // in "happy" then falling to idle instead of showing "attention".
    case 'state': {
      if (ev.state && STATE_WORDS.includes(ev.state)) {
        const hold = state === 'waiting' || state === 'needsinput' || state === 'error';
        // Sticky high-priority states break through transients immediately.
        const stickyHi = ev.state === 'waiting' || ev.state === 'needsinput'
          || ev.state === 'error' || ev.state === 'attention';
        if (!hold && (stickyHi || perfNow() >= transientUntil)) {
          setState(ev.state);
        }
      }
      break;
    }
  }
});

function perfNow() {
  return Date.now();
}

// ---------- 统计 + 聚合状态 ----------
let lastStats = null; // 最近一次快照：transient 到期时用它立即重算聚合态
let lastStatsRevision = -1; // R40.1: monotonic revision guard — reject stale stats
let sayToken = 0;     // say 接棒 happy 的排队令牌（新事件作废旧排队）
// Format cost in the current currency (same logic as panel.js).
function fmtCost(cost) {
  const n = Number(cost) || 0;
  const sym = currentCurrency === 'CNY' ? '¥' : '$';
  const display = currentCurrency === 'CNY' ? n * currentFxRate : n;
  if (Math.abs(display) < 1) return sym + display.toFixed(3);
  if (Math.abs(display) < 100) return sym + display.toFixed(2);
  return sym + display.toFixed(1);
}

// R40.1 (audit P0-3): the backend stamps each stats payload with a
// monotonic `__revision` (see commands.rs::do_emit_stats and
// http_server.rs). The 0.5.19 plugin generated revisions but the
// frontend never checked them, so a late-arriving revision-41
// "working" snapshot could overwrite a fresh revision-42 "completed"
// snapshot — the UI would visually regress from "done" to "working".
// Fix: reject any snapshot whose revision is older than the last
// accepted one. Revisions < 0 (missing field, e.g. from an outdated
// backend) are accepted unconditionally to preserve compatibility.
function acceptStatsRevision(s) {
  if (!s) return true;
  const rev = Number(s.__revision);
  if (!Number.isFinite(rev) || rev < 0) return true; // backend without revision — accept
  if (rev <= lastStatsRevision) return false;       // stale — reject
  lastStatsRevision = rev;
  return true;
}

function applyStats(s) {
  if (!s) return;
  s = statsForThisPet(s);
  // R40.1: reject stale-revision snapshots to prevent UI regression.
  if (!acceptStatsRevision(s)) return;
  lastStats = s;
  const today = s.today || {}, w5h = s.window5h || {}; // R1-A#1: defensive reads
  chipCost.textContent = fmtCost(today.cost || 0);
  chipWindow.textContent = '5h ' + fmtCost(w5h.cost || 0);
  // 从 stats 推送同步权威窗口位置，校正拖动缓存
  if (s.winPos && s.winPos.length === 2) {
    const [wx, wy] = s.winPos;
    if (Number.isFinite(wx) && Number.isFinite(wy)) lastWinPos = [wx, wy];
  }
  lastWaiting = (s.waitingCount || 0) + (s.needsinputCount || 0); // 待处理徽标含「等你回复」
  lastBgZombie = (s.bg && s.bg.zombie) || 0;
  if (radialOpen) updateRadialBadge();
  renderSessions(s.sessions || []);
  updateNotepad(s); // 记事本：行动清单 + 待办
  travelView.update(s.travel);
  if (sessListOpen) { renderSessList(); fitPopup(sesslist); } // HUD 开着时随快照刷新并重定高

  // 选项面板：按快照重建队列（多任务都在、标明项目；防漏事件/启动时已在等待）
  refreshAsk(s);

  if (DEBUG_STATE) { setState(DEBUG_STATE); return; }

  // 你正在看面板/打字 → 不再改小章鱼状态(别动来动去打断你)，安静等你答完
  if (isInteracting()) return;

  // 聚合梯子，对齐 STATES.md 的优先级表：
  //   waiting > 短暂态 > error(8) > needsinput/notification(7) > sweeping(6)
  //   > attention(5) > juggling(4) > working(3) > thinking(2) > idle(1) > sleeping(0)
  // 之前 working 排在 needsinput 前面，多会话时「等你回复」被干活态彻底盖住。
  // R22 (2026-08-10): added attentionCount branch. CodeWhale turn_end and
  // OpenCode session.idle set state="attention" — without this branch the
  // pet appeared stuck in idle/sleeping while a session was actively waiting.
  if (s.waitingCount > 0) {
    setState('waiting');
  } else if (perfNow() < transientUntil) {
    setState(transientState);
  } else if (s.apiErrorCount > 0) {
    setState('error'); // v0.5.71: API error (apiErrorAfter) → 瘫倒, until API recovers
  } else if (s.errorCount > 0) {
    setState('error'); // 有会话卡在 API 错误 → 瘫倒，直到该会话恢复或 oneshot 衰减
  } else if (s.interruptedCount > 0) {
    setState('needsinput'); // v0.5.71: ESC 中断 → 显示「等你回复」态, pet waits for user action
  } else if (s.needsinputCount > 0) {
    setState('needsinput');
  } else if (s.sweepingCount > 0) {
    setState('sweeping');
  } else if (s.attentionCount > 0) {
    setState('attention'); // 会话需要关注（CodeWhale turn_end / OpenCode idle）
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
if (window.pet.onTravel) {
  window.pet.onTravel((event) => {
    if (!event || !eventBelongsToThisPet(event)) return;
    if (event.state) travelView.update(event.state);
    else window.pet.getTravel().then(travelView.update).catch(() => {});
    if (event.phase === 'completed') {
      transient('happy', 2600, `📮 ${event.summary || '旅行明信片已送达'}`, 8000);
      confetti();
    } else if (event.phase === 'failed') {
      transient('error', 2600, `🧳 ${event.summary || '旅行失败'}`, 5000);
    } else if (event.phase === 'cancelled') {
      showBubble(t('bubble.travelCancel'), 2600, true);
    }
  });
}

function renderSessions(sessions) {
  sessionsEl.innerHTML = '';
  // 与会话列表 HUD 完全联动：同一过滤(非 headless/非睡眠)、同一配色、同一排序。
  const list = (sessions || []).filter(isVisibleSession).sort((a, b) => {
    const pa = SESS_SORT[a.state] != null ? SESS_SORT[a.state] : 3;
    const pb = SESS_SORT[b.state] != null ? SESS_SORT[b.state] : 3;
    return pa !== pb ? pa - pb : (a.idleMs || 0) - (b.idleMs || 0);
  });
  for (const s of list) {
    const d = document.createElement('div');
    d.className = 'sess-dot ' + sessionDotClass(s);
    const label = s.state === 'waiting' ? `等你${s.reason || '处理'}` : (SESS_META[s.state] || s.state);
    d.title = `${s.project} · ${label}`;
    sessionsEl.appendChild(d);
  }
  // 菜单开着时同步「待处理」角标
  if (radialOpen) updateRadialBadge();
}

let activeProviders = [];
let availableProviders = ['claude', 'codewhale', 'codex', 'opencode', 'dsh'];
// R35.2 (2026-07-31): latestProviderStatuses — the per-provider install
// status map, sourced from config_view()'s `providers.statuses` (NOT
// from stats(), which the 0.5.12 carpet audit P0-1 证据C confirmed does
// not include a `providers` field). The chooser reads this to show
// ok/warn/off badges that match the panel. Before this fix, the chooser
// read lastStats.providers.statuses which was always undefined, so every
// provider showed as "pending/off" even when hooks were installed.
let latestProviderStatuses = {};

// R40.5 (audit P0-2): Unified config snapshot application. Both the
// onConfig event handler and the getConfig() bootstrap path MUST call
// this function. The previous code only applied providers.active/statuses
// in the onConfig path, so if the pet:config event arrived before the
// listener was registered (cold start race), the provider buttons would
// be permanently hidden until another config event happened.
function applyConfigSnapshot(cfg) {
  if (!cfg) return;
  muted = !!cfg.muted;
  petMode = cfg.petMode === 'duo' ? 'duo' : 'single';
  if (cfg.lang) applyLanguage(cfg.lang);
  territorySupported = !!cfg.territorySupported;
  const effectiveSkin = PET_AGENT === 'codex' && petMode === 'duo' ? cfg.skinCodex : cfg.skin;
  if (effectiveSkin) applySkin(effectiveSkin);
  // R40.5: providers.active + statuses applied in BOTH paths
  if (cfg.providers && Array.isArray(cfg.providers.active)) {
    activeProviders = cfg.providers.active;
  }
  if (cfg.providers && Array.isArray(cfg.providers.all) && cfg.providers.all.length) {
    availableProviders = cfg.providers.all;
  }
  if (cfg.providers && cfg.providers.statuses && typeof cfg.providers.statuses === 'object') {
    latestProviderStatuses = cfg.providers.statuses;
  }
  // R40.5: always update UI after applying providers (was only in onConfig)
  updateProviderUI();
  // Currency config — persist across restarts
  if (cfg.currency === 'USD' || cfg.currency === 'CNY') {
    currentCurrency = cfg.currency;
  }
  if (Number.isFinite(cfg.fxRate) && cfg.fxRate > 0) {
    currentFxRate = cfg.fxRate;
  }
  // R44 0.5.44: load pinned/archived sessions from config
  if (Array.isArray(cfg.pinnedSessions)) {
    pinnedSet = new Set(cfg.pinnedSessions);
  }
  if (Array.isArray(cfg.archivedSessions)) {
    archivedSet = new Set(cfg.archivedSessions);
  }
  // 从配置推送同步权威窗口位置
  const savedPosition = PET_AGENT === 'codex' && petMode === 'duo' ? cfg.petPositionCodex : cfg.petPosition;
  if (savedPosition && Number.isFinite(savedPosition.x) && Number.isFinite(savedPosition.y)) {
    lastWinPos = [savedPosition.x, savedPosition.y];
  }
}

const configWrites = window.OctoConfigWrites.createConfigWriteController({
  reload: () => window.pet.getConfig(),
  applySnapshot: applyConfigSnapshot,
  reportError(command, error) {
    window.dispatchEvent(new CustomEvent('re-llmpet:bridge-error', {
      detail: { command, message: String(error && (error.message || error) || 'unknown') }
    }));
  },
});

window.pet.onConfig(applyConfigSnapshot);

// Provider-specific labels are used only for direct “primary action” affordances.
// The session-list “New Agent ▾” button is always a chooser and never implies
// that the first active provider will be launched automatically.
function firstProviderId() { return activeProviders[0] || ''; }
function firstProviderLabel() { return PROVIDER_LABELS[firstProviderId()] || firstProviderId(); }

function updateProviderUI() {
  const fallbackLabel = currentLang === 'en' ? 'Agent' : currentLang === 'ja' ? 'エージェント' : 'Agent';
  const label = firstProviderLabel() || fallbackLabel;
  const slNew = document.getElementById('sl-new');
  if (slNew) {
    slNew.style.display = '';
    slNew.textContent = currentLang === 'en' ? '🚀 New Agent ▾'
      : currentLang === 'ja' ? '🚀 新規エージェント ▾' : '🚀 新开 Agent ▾';
  }
  const tpClaude = document.querySelector('.tp-ops [data-op="claude"]');
  if (tpClaude) tpClaude.textContent = currentLang === 'en'
    ? `💬 Launch ${label}`
    : currentLang === 'ja' ? `💬 ${label} を起動` : `💬 唤起 ${label}`;
  // R35.1 (2026-07-31): the agent-tag NO LONGER displays「名称 +N」.
  // The 0.5.11 deep-recheck P0-5 flagged this as conflating "enabled
  // providers" with "active provider" and silently launching the first
  // array item. The tag is now always hidden; provider selection goes
  // through the #provider-chooser modal (see chooseProviderAndLaunch).
  // We keep the element for tooltip/ARIA use if needed in R36.
  if (agentTag) {
    if (petMode === 'duo') {
      agentTag.className = `agent-tag ${PET_AGENT}`;
      agentTag.textContent = PET_AGENT === 'codex' ? 'Codex' : 'Claude';
    } else {
      agentTag.className = 'agent-tag hidden';
      agentTag.textContent = '';
    }
    // Provide a tooltip summarizing enabled providers (accessible name
    // for screen readers, hover text for sighted users). This replaces
    // the visual「+N」with a non-visual summary.
    if (activeProviders.length > 0) {
      const summary = activeProviders
        .map((id) => PROVIDER_LABELS[id] || id)
        .join(' · ');
      agentTag.title = currentLang === 'en' ? `Enabled: ${summary}`
        : currentLang === 'ja' ? `有効: ${summary}` : `已启用: ${summary}`;
    }
  }
}

// “新开 Agent” is an explicit picker. It always opens the available-provider
// chooser, even when only one provider is enabled, so the dropdown never
// launches a hard-coded or implicit default. Selection is the only launch.
// The chooser uses provider status from config, closes on outside click/Escape,
// and awaits the native launch before dismissing itself.
let providerChooserOpen = false;
const providerChooserEl = document.getElementById('provider-chooser');
const providerChooserList = document.getElementById('pc-list');
const providerChooserClose = document.getElementById('pc-close');

function chooseProviderAndLaunch() {
  openProviderChooser();
}

// R35.2 (2026-07-31): launchProviderChecked — awaits the launch IPC and
// surfaces failures via toast + rlog. The 0.5.12 carpet audit P0-1 证据D
// flagged that the old code used fire-and-forget launchAgent (send),
// so a failed launch left the user with no feedback. We use
// launchAgentChecked (call) which rejects on IPC failure.
function launchProviderChecked(provider) {
  if (!provider) return;
  rlog('launch', 'checked ' + provider);
  Promise.resolve()
    .then(() => window.pet.launchAgentChecked(provider))
    .catch((err) => {
      const msg = String(err && (err.message || err) || 'unknown');
      rlog('launch', 'failed ' + provider + ': ' + msg);
      // Dispatch a bridge-error so the toast shows.
      try {
        window.dispatchEvent(new CustomEvent('re-llmpet:bridge-error', {
          detail: { command: 'launch_agent', message: `${provider}: ${msg}` }
        }));
      } catch {}
    });
}

function openProviderChooser() {
  if (!providerChooserEl || !providerChooserList) return;
  if (providerChooserOpen) return;
  // R35.2 (2026-07-31): mutual exclusion — close other overlays before
  // opening the chooser. The 0.5.12 carpet audit P0-1 证据E noted the
  // chooser lacked strict mutual exclusion with radial/sesslist/todo/ask.
  if (radialOpen) closeRadial();
  if (sessListOpen) closeSessList();
  if (todoPopOpen) closeTodoPop();
  // R35.2: read provider statuses from latestProviderStatuses (sourced
  // from config_view() via onConfig), NOT from lastStats. The 0.5.12
  // carpet audit P0-1 证据C confirmed Runtime::stats() does NOT include
  // a `providers` field, so the old code always showed all providers as
  // "pending/off" even when hooks were installed.
  const statuses = latestProviderStatuses || {};
  const activeSet = new Set(activeProviders);
  const choices = [...availableProviders].sort((a, b) => Number(activeSet.has(b)) - Number(activeSet.has(a)));
  providerChooserList.innerHTML = choices.map((id) => {
    const icon = PROVIDER_ICONS[id] || '•';
    const label = PROVIDER_LABELS[id] || id;
    const st = statuses[id] || {};
    const installed = st.installed != null ? !!st.installed : false;
    const enabled = activeSet.has(id);
    const failed = st.state === 'error';
    const cls = failed ? 'warn' : installed ? 'ok' : 'off';
    const statusText = failed ? (currentLang === 'en' ? 'error' : currentLang === 'ja' ? 'エラー' : '错误')
      : installed ? (currentLang === 'en' ? (enabled ? 'ready' : 'available') : currentLang === 'ja' ? (enabled ? '準備' : '利用可') : (enabled ? '就绪' : '可用'))
      : enabled ? (currentLang === 'en' ? 'hook missing' : currentLang === 'ja' ? 'Hook 未同期' : 'Hook 未同步')
      : (currentLang === 'en' ? 'available' : currentLang === 'ja' ? '利用可' : '可用');
    return `<button type="button" class="pc-item" data-provider="${esc(id)}">
      <span class="pc-ic">${icon}</span>
      <span class="pc-label">${esc(label)}</span>
      <span class="pc-status ${cls}">${esc(statusText)}</span>
    </button>`;
  }).join('');
  providerChooserEl.classList.remove('hidden');
  providerChooserOpen = true;
  setRequestedPetSize(520, Math.max(420, 210 + choices.length * 48));
  syncUiBusy();
  // R35.2 (2026-07-31): focus the first item for keyboard accessibility.
  // The audit P0-1 证据E flagged the missing focus management. We move
  // focus to the first provider button so arrow-key/Enter navigation
  // works and screen readers announce the dialog. Full focus trap is R36.
  const firstItem = providerChooserList.querySelector('.pc-item');
  if (firstItem) {
    try { firstItem.focus(); } catch {}
  }
}
function closeProviderChooser() {
  if (!providerChooserEl) return;
  providerChooserEl.classList.add('hidden');
  providerChooserOpen = false;
  syncUiBusy();
  if (!radialOpen && !todoPopOpen && !sessListOpen && !askActive) resetPetSize();
}
// Wire up the chooser interactions. Close on ✕, on outside click, on
// Escape. Launch on item click.
if (providerChooserEl) {
  if (providerChooserClose) {
    providerChooserClose.addEventListener('click', (e) => {
      e.stopPropagation();
      closeProviderChooser();
    });
  }
  providerChooserEl.addEventListener('click', (e) => {
    // Outside-card click closes.
    if (e.target === providerChooserEl) closeProviderChooser();
  });
  if (providerChooserList) {
    providerChooserList.addEventListener('click', (e) => {
      const btn = e.target.closest('.pc-item');
      if (!btn) return;
      e.stopPropagation();
      const provider = btn.dataset.provider;
      if (!provider) return;
      // R35.2 (2026-07-31): await the launch BEFORE closing the chooser.
      // The 0.5.12 carpet audit P0-1 证据D flagged that the old code
      // closed the chooser first, then fire-and-forget launched — so a
      // failed launch left no UI to retry from. Now we disable the
      // clicked item, await launchAgentChecked, and only close on
      // success. On failure we keep the chooser open + re-enable the
      // item + show a toast, so the user can retry or pick another.
      btn.disabled = true;
      const originalLabel = btn.querySelector('.pc-label');
      const originalText = originalLabel ? originalLabel.textContent : '';
      if (originalLabel) {
        originalLabel.textContent = currentLang === 'en' ? 'Launching…'
          : currentLang === 'ja' ? '起動中…' : '启动中…';
      }
      Promise.resolve()
        .then(() => window.pet.launchAgentChecked(provider))
        .then(() => {
          rlog('launch', 'chooser ok ' + provider);
          closeProviderChooser();
        })
        .catch((err) => {
          const msg = String(err && (err.message || err) || 'unknown');
          rlog('launch', 'chooser failed ' + provider + ': ' + msg);
          // Restore the button label + re-enable for retry.
          btn.disabled = false;
          if (originalLabel) originalLabel.textContent = originalText;
          // Show a toast so the user knows the launch failed.
          try {
            window.dispatchEvent(new CustomEvent('re-llmpet:bridge-error', {
              detail: { command: 'launch_agent', message: `${provider}: ${msg}` }
            }));
          } catch {}
          // Keep the chooser open so the user can retry or pick another.
        });
    });
  }
}
window.addEventListener('keydown', (e) => {
  if (providerChooserOpen && e.key === 'Escape') {
    closeProviderChooser();
    return;
  }
  // v0.5.72: keyboard shortcuts for quick actions.
  // Ctrl+P / Cmd+P → open panel (detail view)
  // Ctrl+M / Cmd+M → toggle pet mode (single ↔ duo)
  // Ctrl+S / Cmd+S → cycle skin (mascot → cat → pixel)
  // ? (Shift+/) → show shortcuts help bubble
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'p') { e.preventDefault(); try { window.pet.openPanel(); } catch {} }
    else if (k === 'm') { e.preventDefault(); try { window.pet.setPetMode(petMode === 'single' ? 'duo' : 'single'); } catch {} }
    else if (k === 's') { e.preventDefault(); applySkin(skin === 'mascot' ? 'cat' : skin === 'cat' ? 'pixel' : 'mascot'); }
  } else if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
    // v0.5.73: ? shows shortcuts help
    e.preventDefault();
    showBubble(t('help.shortcuts'), 5000);
  }
});
// R35.1: blur closes the chooser too (consistent with radial/sesslist).

function applySkin(s) {
  skin = ['pixel', 'mascot', 'cat'].includes(s) ? s : 'mascot';
  document.body.classList.toggle('skin-pixel', skin === 'pixel');
  document.body.classList.toggle('skin-mascot', skin === 'mascot');
  document.body.classList.toggle('skin-cat', skin === 'cat');
  // R30: lazy-load cat assets when switching to cat skin
  if (skin === 'cat' && catAssetCache.size === 0) {
    preloadCatAssets();
  }
  if (skin === 'mascot') updateMascotEyes(state);
  if (skin === 'cat') updateCat(state);
  else if (poolRot) { clearInterval(poolRot); poolRot = null; }
  requestAnimationFrame(reportPetVisualBounds);
}

// R35.1: hit-test selector excludes animated skin elements (#pixel/#mascot/#cat)
// — their transforms shift the click-through boundary during state animations.
// R35.2: added #provider-chooser (0.5.12 carpet audit P0-1 证据B).
// R22 (2026-08-10): added #re-llmpet-toast — persistent error toast's ✕ button
// was in the click-through zone and impossible to dismiss.
const INTERACTIVE_HIT_SEL = '#pet-anchor,#radial,#notepad,#todopop,#ask,#sesslist,#provider-chooser,#re-llmpet-toast';

function reportPetVisualBounds() {
  const rects = Array.from(document.querySelectorAll(INTERACTIVE_HIT_SEL))
    .filter((el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    })
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
  if (!rects.length) return;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  try {
    window.pet.petVisualBounds({ x: left, y: top, width: right - left, height: bottom - top });
  } catch {}
}

// R22: expose reportPetVisualBounds globally so toast.js can call it when a
// toast appears or disappears, keeping the click-through region in sync.
window.reportPetVisualBounds = reportPetVisualBounds;

// ====================================================================
// 拖动 + 点击（短按=会话列表 / 移动=等价上游的手动窗口拖动）
// ====================================================================
let g = null;
let dragFrame = 0;
let pendingDragPos = null;
let dragMoveChain = Promise.resolve();

function queueWindowMove(x, y) {
  pendingDragPos = [Math.round(x), Math.round(y)];
  if (dragFrame) return;
  dragFrame = requestAnimationFrame(() => {
    dragFrame = 0;
    const pos = pendingDragPos;
    pendingDragPos = null;
    if (!pos) return;
    dragMoveChain = dragMoveChain
      .catch(() => {})
      .then(() => window.pet.setWinPos(pos[0], pos[1]))
      .catch((error) => rlog('drag', 'move failed: ' + String(error && error.message || error || 'unknown')));
    lastWinPos = pos;
  });
}

function flushWindowMove() {
  if (dragFrame) {
    cancelAnimationFrame(dragFrame);
    dragFrame = 0;
  }
  const pos = pendingDragPos;
  pendingDragPos = null;
  if (pos) {
    dragMoveChain = dragMoveChain
      .catch(() => {})
      .then(() => window.pet.setWinPos(pos[0], pos[1]))
      .catch((error) => rlog('drag', 'move failed: ' + String(error && error.message || error || 'unknown')));
    lastWinPos = pos;
  }
}

function commitWindowMove() {
  flushWindowMove();
  dragMoveChain = dragMoveChain
    .catch(() => {})
    .then(() => window.pet.commitWinPos())
    .then(([wx, wy]) => { lastWinPos = [wx, wy]; })
    .catch((error) => rlog('drag', 'commit failed: ' + String(error && error.message || error || 'unknown')));
}

function attachDrag(el) {
  const finishGesture = (gesture, allowClick) => {
    if (!gesture) return;
    if (g === gesture) g = null;
    try { gesture.el.releasePointerCapture(gesture.pid); } catch {}
    gesture.el.classList.remove('dragging');
    // Re-enable native hit-test ownership after the gesture. `true` means the
    // transparent regions may ignore input again; the native guard still keeps
    // the window interactive while the cursor is over the pet or an open HUD.
    setMouseIgnore(true);
    if (gesture.moved) commitWindowMove();
    else if (allowClick) {
      if (radialOpen) closeRadial();
      else toggleSessList();
    }
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // R35.1: a drag start cancels any pending radial open — the user has
    // switched intent from "click to open HUD" to "drag the pet".
    pendingRadialOpen = false;
    setMouseIgnore(false);
    try { el.setPointerCapture(e.pointerId); } catch {}
    el.classList.add('dragging');
    g = {
      el, pid: e.pointerId, sx: e.screenX, sy: e.screenY, cx: e.screenX, cy: e.screenY, moved: false, win: lastWinPos,
    };
    const gesture = g;
    window.pet.getWinPos().then(([wx, wy]) => {
      if (g !== gesture) return;
      gesture.win = [wx, wy];
      lastWinPos = [wx, wy];
      if (gesture.moved) queueWindowMove(wx + gesture.cx - gesture.sx, wy + gesture.cy - gesture.sy);
    }).catch(() => {});
  });

  el.addEventListener('pointermove', (e) => {
    const gesture = g;
    if (!gesture || gesture.pid !== e.pointerId) return;
    gesture.cx = e.screenX;
    gesture.cy = e.screenY;
    const dx = gesture.cx - gesture.sx;
    const dy = gesture.cy - gesture.sy;
    if (!gesture.moved && Math.abs(dx) + Math.abs(dy) > 4) {
      gesture.moved = true;
      if (radialOpen) closeRadial();
    }
    if (gesture.moved && gesture.win) {
      queueWindowMove(gesture.win[0] + dx, gesture.win[1] + dy);
    }
  });

  el.addEventListener('pointerup', (e) => {
    const gesture = g;
    if (!gesture || gesture.pid !== e.pointerId) return;
    finishGesture(gesture, true);
  });
  el.addEventListener('pointercancel', () => finishGesture(g, false));
  el.addEventListener('lostpointercapture', () => { if (g) finishGesture(g, false); });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    toggleRadial();
  });
}
if (petAnchor) attachDrag(petAnchor);

// 启动时预加载窗口位置到缓存
window.pet.getWinPos().then(([wx, wy]) => { lastWinPos = [wx, wy]; }).catch(() => {});

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
askEl.addEventListener('pointerenter', () => { askHover = true; syncUiBusy(); });
askEl.addEventListener('pointerleave', () => { askHover = false; syncUiBusy(); });

// 记事本：点击开/关 行动清单弹层
notepad.addEventListener('click', (e) => { e.stopPropagation(); todoPopOpen ? closeTodoPop() : openTodoPop(); });
notepad.addEventListener('contextmenu', (e) => e.stopPropagation());
document.getElementById('tp-close').addEventListener('click', (e) => { e.stopPropagation(); closeTodoPop(); });

// 会话列表 HUD：关闭 + 底部操作
document.getElementById('sl-close').addEventListener('click', (e) => { e.stopPropagation(); closeSessList(); });
// R44 0.5.44: search input + filter buttons
if (slSearch) {
  slSearch.addEventListener('input', (e) => {
    slQuery = e.target.value.trim();
    renderSessList();
  });
}
document.querySelectorAll('.sl-filter').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    slFilter = btn.dataset.filter;
    document.querySelectorAll('.sl-filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderSessList();
  });
});
// “新开” never calls primaryAction(): existing sessions must not turn a new
// session request into focus/open-panel behavior. The chooser owns overlay
// replacement and launches only after the user selects a provider.
document.getElementById('sl-new').addEventListener('click', (e) => {
  e.stopPropagation();
  chooseProviderAndLaunch();
});
document.getElementById('sl-panel').addEventListener('click', (e) => { e.stopPropagation(); window.pet.openPanel(); closeSessList(); });
// B1: wander button — pass null to let backend pick from config or built-in defaults
const slWander = document.getElementById('sl-wander');
if (slWander) slWander.addEventListener('click', (e) => {
  e.stopPropagation();
  window.pet.startWander(null, null).then(() => {
    showBubble(`🐾 ${currentLang === 'en' ? 'Off to wander!' : currentLang === 'ja' ? '散歩に出発！' : '出发闲逛！'}`, 3200, true);
  }).catch((err) => {
    showBubble(`❌ ${String(err || '闲逛失败')}`, 3000);
  });
  closeSessList();
});
sesslist.addEventListener('contextmenu', (e) => e.stopPropagation());
todopop.querySelectorAll('.tp-ops button').forEach((b) => {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const op = b.dataset.op;
    if (op === 'panel') window.pet.openPanel();
    else if (op === 'claude') window.pet.primaryAction();
    else if (op === 'log') window.pet.openLog();
    closeTodoPop();
  });
});

// ---------- 泡泡菜单 ----------
let territorySupported = false; // 由 pet:config 下发(仅 macOS true)
const MENU = [
  { ic: 'chart',  key: 'menu.panel', act: () => window.pet.openPanel() },
  { ic: 'mask',   key: 'menu.skin', act: () => toggleSkin() },
  { ic: 'hand',   key: 'menu.pending', badge: true, act: () => window.pet.openPanel() },
  { ic: 'zombie', key: 'menu.background', badgeBg: true, act: () => window.pet.openPanel() },
  { ic: 'doc',    key: 'menu.log', act: () => window.pet.openLog() },
  { ic: 'search', key: 'menu.patrol', when: () => territorySupported, act: () => window.pet.territoryRunNow() },
  { ic: 'bell',   key: 'menu.mute', act: () => window.pet.toggleMute() },
  { ic: 'coins',  key: 'currency', act: () => toggleCurrency() },
  { ic: 'power',  key: 'menu.quit', act: () => window.pet.quit() },
];

function toggleSkin() {
  const order = ['mascot', 'pixel', 'cat'];
  const next = order[(order.indexOf(skin) + 1) % order.length];
  applySkin(next);
  void configWrites.request('skin', next, (value) => window.pet.setSkin(value));
}

function toggleCurrency() {
  const next = currentCurrency === 'USD' ? 'CNY' : 'USD';
  currentCurrency = next;
  void configWrites.request('currency', next, (value) => window.pet.setCurrency(value));
  // Immediately refresh chip display with the new currency
  if (lastStats) {
    chipCost.textContent = fmtCost(lastStats.today.cost || 0);
    chipWindow.textContent = '5h ' + fmtCost(lastStats.window5h.cost || 0);
  }
  showBubble(currentCurrency === 'CNY' ? '💴 切换为 ¥（人民币）' : '💲 切换为 $（美元）', 2000);
}

function buildRadial() {
  radial.innerHTML = '';
  // R35 (2026-07-31): read the STABLE #pet-anchor rect instead of the
  // visible skin element's rect. The skin element (e.g. #mascot.happy)
  // may be mid-animation (happyJump translates -22px, attn rotates ±4deg,
  // bob translates ±7px). Reading its rect mid-frame would place the
  // radial menu center at the pet's *transient* position, causing the
  // "HUD 错位" the audit flagged. #pet-anchor never receives a transform,
  // so its rect is invariant under all state animations.
  const anchor = document.getElementById('pet-anchor');
  const el = anchor || curSkinEl(); // fall back if anchor is somehow missing
  const sr = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const cx = r.left - sr.left + r.width / 2;
  const cy = r.top - sr.top + r.height / 2;
  const items = MENU.filter((it) => !it.when || it.when()); // 平台不支持的项(如非 mac 的巡视)不渲染
  const n = items.length;
  const radius = 78;
  const startA = 192, endA = 348; // 头顶上方的弧
  items.forEach((it, i) => {
    const a = ((startA + (endA - startA) * (n === 1 ? 0.5 : i / (n - 1))) * Math.PI) / 180;
    const x = cx + radius * Math.cos(a);
    const y = cy + radius * Math.sin(a);
    // R22: clamp to stay within the window bounds (items are 46px, centered)
    const clampedX = Math.max(23, Math.min(sr.width - 23, x));
    const clampedY = Math.max(23, Math.min(sr.height - 23, y));
    const b = document.createElement('div');
    b.className = 'radial-item';
    b.style.left = clampedX + 'px';
    b.style.top = clampedY + 'px';
    b.style.transitionDelay = i * 0.03 + 's';
    const label = it.key === 'currency' ? (currentLang === 'en' ? 'Currency' : currentLang === 'ja' ? '通貨' : '货币') : t(it.key);
    const icName = it.key === 'menu.mute' ? (muted ? 'bell-off' : 'bell')
      : it.key === 'currency' ? (currentCurrency === 'CNY' ? 'yen' : 'coins') : it.ic;
    const icHtml = (window.OctoIcons && window.OctoIcons.icon(icName)) || '';
    b.innerHTML = `<span class="ri-ic oi">${icHtml}</span><span class="ri-lb">${label}</span>`;
    const cnt = it.badge ? lastWaiting : it.badgeBg ? lastBgZombie : 0;
    if ((it.badge || it.badgeBg) && cnt > 0) {
      const bd = document.createElement('span');
      bd.className = 'ri-badge';
      bd.textContent = cnt;
      b.appendChild(bd);
    }
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeRadial();
      it.act();
    });
    radial.appendChild(b);
  });
}

function updateRadialBadge() {
  const items = radial.querySelectorAll('.radial-item');
  MENU.forEach((m, idx) => {
    if (!m.badge && !m.badgeBg) return;
    const node = items[idx];
    if (!node) return;
    const cnt = m.badge ? lastWaiting : lastBgZombie;
    let bd = node.querySelector('.ri-badge');
    if (cnt > 0) {
      if (!bd) { bd = document.createElement('span'); bd.className = 'ri-badge'; node.appendChild(bd); }
      bd.textContent = cnt;
    } else if (bd) bd.remove();
  });
}

// R35.1 (2026-07-31): a SINGLE pending radial intent flag, replacing the
// recursive `setTimeout(openRadial, 260)` that could queue multiple
// delayed opens on repeated clicks. The 0.5.11 deep-recheck (P0-1 #2)
// noted that the old code had no retry count or pending token, so 5
// rapid clicks would schedule 5 opens; if the user changed intent or
// the geometry settled, stale timers would still fire.
//
// Semantics:
//   - pendingRadialOpen is set to `true` by openRadial() when geometryBusy.
//   - markGeometryBusy()'s settle callback checks the flag and opens ONCE.
//   - closeRadial(), blur, drag start, and state changes clear the flag
//     so a stale intent can't reopen the HUD after the user dismissed it.
let pendingRadialOpen = false;

function openRadial() {
  // R35.1: if a geometry transaction is in flight, record a SINGLE
  // pending intent and return. The settle callback in markGeometryBusy()
  // will open the radial exactly once when the resize completes. No
  // recursive timer, no queue.
  if (geometryBusy) {
    pendingRadialOpen = true;
    return;
  }
  if (todoPopOpen) closeTodoPop();
  if (sessListOpen) closeSessList();
  buildRadial();
  radial.classList.remove('hidden');
  radialOpen = true;
  syncUiBusy();
  bubble.classList.add('hidden');
}
function closeRadial() {
  // R35.1: clear any pending radial intent so a deferred open can't fire
  // after the user (or blur) dismissed the radial.
  pendingRadialOpen = false;
  radial.classList.add('hidden');
  radialOpen = false;
  syncUiBusy();
}
function toggleRadial() {
  radialOpen ? closeRadial() : openRadial();
}
// 点遮罩空白处关闭
radial.addEventListener('click', () => closeRadial());
// R35.1: blur must also clear the pending intent — otherwise a window
// that loses focus mid-resize would reopen the radial when it regains
// focus and the busy timer settles.
function dismissTransientUi(reason = 'blur') {
  pendingRadialOpen = false;
  if (providerChooserOpen) closeProviderChooser();
  if (radialOpen) closeRadial();
  if (sessListOpen) closeSessList();
  if (todoPopOpen) closeTodoPop();
  rlog('dismiss', reason);
}
window.addEventListener('blur', () => dismissTransientUi('dom-blur'));
if (window.pet && typeof window.pet.onWindowBlur === 'function') {
  window.pet.onWindowBlur(() => dismissTransientUi('native-blur'));
}

// ---------- 初始化 ----------
(async () => { // R1-A#5: try/catch so getConfig/getStats rejection doesn't leave pet blank
  try {
    const cfg = await window.pet.getConfig();
    if (cfg) applyConfigSnapshot(cfg); // R40.5: unified snapshot applies providers too
    const s = await window.pet.getStats();
    if (s) applyStats(s); else if (!lastStats) setState('idle'); // 有快照按真实态亮相
    showBubble(t('bub.online'), 3000);
  } catch (err) {
    console.error('[octopus] pet boot failed:', err);
    rlog('init', 'boot failed: ' + String(err && (err.message || err) || 'unknown'));
    setState('idle'); showBubble('⚠️ 初始化失败，请重启', 5000);
  }
})();

// ---------- 透明区域点击穿透（命中测试）----------
// 桌宠窗口是透明矩形，空白处不该拦住后面的应用。Tauri 没有 Electron
// `forward:true`，所以 renderer 只声明期望状态；Rust 侧用桌面坐标命中守护
// 恢复输入，避免一旦穿透后永远收不到 mousemove 的死锁。
const HIT_SEL = INTERACTIVE_HIT_SEL;
function setMouseIgnore(on) {
  void mouseIgnoreController.request(!!on);
}
window.addEventListener('mousemove', (e) => {
  if (g) { setMouseIgnore(false); return; } // 拖动中保持可点
  const el = document.elementFromPoint(e.clientX, e.clientY);
  // 命中测试权威同步悬停态：穿透切换时 pointerleave 可能漏发，会把 askHover 卡在 true，
  // 进而让 isInteracting() 永远为真、refreshAsk 永不对账（旧卡片冻结、新卡片进不来）。
  askHover = !!(el && el.closest('#ask'));
  setMouseIgnore(!(el && el.closest(HIT_SEL)));
}, true);
// 启动即默认穿透（透明区不挡），光标移到内容上时由上面的命中测试恢复
setMouseIgnore(true);

// ---------- 交互状态与可视边界上报（事件驱动） ----------
// 首次同步一次；之后由各弹层 open/close、resize、皮肤/状态变化触发。
syncUiBusy(true);
window.addEventListener('resize', () => {
  requestAnimationFrame(reportPetVisualBounds);
});
const visualBoundsObserver = typeof ResizeObserver === 'function'
  ? new ResizeObserver(() => requestAnimationFrame(reportPetVisualBounds))
  : null;
if (visualBoundsObserver) {
  visualBoundsObserver.observe(stage);
  if (petAnchor) visualBoundsObserver.observe(petAnchor);
}

// ---------- 生命周期清理 ----------
// renderer context may be destroyed/reloaded. beforeunload ensures
// all intervals/timeouts are cleared, preventing orphaned timers.
window.addEventListener('beforeunload', () => {
  petRendererDisposed = true;
  geometryRevision += 1;
  if (geometryBusyTimer) clearTimeout(geometryBusyTimer);
  geometryBusyTimer = 0;
  if (geometryAckUnlisten) {
    try { geometryAckUnlisten(); } catch {}
    geometryAckUnlisten = null;
  }
  if (petSizeFrame) cancelAnimationFrame(petSizeFrame);
  petSizeFrame = 0;
  petSizeController.dispose();
  configWrites.dispose();
  nativeUiBusyController.dispose();
  mouseIgnoreController.dispose();
  clearInterval(poolRot); poolRot = null;
  if (visualBoundsObserver) visualBoundsObserver.disconnect();
  clearTimeout(bubbleTimer); bubbleTimer = null;
  clearTimeout(transientTimer); transientTimer = null;
  clearTimeout(actTimer); actTimer = null;
  clearTimeout(emptyWarnTimer); emptyWarnTimer = null;
  clearTimeout(blinkTimer); blinkTimer = null;
  clearTimeout(idleActionTimer); idleActionTimer = null;});