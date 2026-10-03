'use strict';

// R60 rewrite (仿照重写): pet.js is now the COMPOSITION ROOT of the pet
// window, per the R60-1 blueprint (upstream LLMPET v1.2.0 keeps its pet
// renderer as a thin assembly over focused modules). The responsibilities
// that 0.6.5→0.6.8 patch rounds had stacked into this one 2843-line file
// now live in sibling modules, each with a single owner:
//
//   pet-frame-table.js   state → image swap chain (mascot table + overrides)
//   pet-state-machine.js setState / transient / tool actions
//   pet-aggregate.js     pure (stats, now) ⇒ state ladder
//   pet-bubble.js        showBubble / hideBubble / viewport fit
//   pet-fx.js            sounds / confetti / error ribbons / micro-motions
//   pet-event-router.js  pet:event dispatch table (guard + handler map)
//   pet-drag.js          pointer gesture → window move queue
//
// What stays here: DOM ownership, geometry negotiation (fitPopup /
// petSizeController / geometryRevision-ack), the ask panel, session-list
// HUD, notepad, provider chooser, config/stats snapshot application, and
// the transient-UI (radial/blur) lifecycle. Tests that previously asserted
// implementation strings in pet.js for the moved parts now point at the
// owning module.

const petAgentView = window.OctoPetAgentView;
const runtimePolicy = window.OctoPetRuntimePolicy;
const PET_AGENT = petAgentView.currentAgent();
let petMode = 'single';
// R58-IMPL-C: second-pet pairing provider (config.duoProvider, default
// 'codex' = 0.6.6 behavior). Fed into the agent view partition and the
// runtime policy by applyConfigSnapshot on every config push.
let duoProvider = 'codex';

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
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((node) => {
    node.title = t(node.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  });
  updateProviderUI();
  if (sessListOpen) { slTitle.textContent = t('sess.title'); lastSessListSig = ''; renderSessList({ force: true }); }
}

// R50 (2026-08-30): right-click must not depend on the contextmenu event.
// preventDefault() on pointerdown suppresses the compat mouse pipeline on
// several WebView builds (WebView2/GTK), so the old flow — pointerdown claims
// input, contextmenu toggles the radial — could end with a claimed window and
// no menu. Toggle directly on pointerdown(button 2); the contextmenu handler
// remains as the fallback and is guarded against double-firing.
let rightClickHandledAt = 0;
function toggleRadialFromPointer() {
  rightClickHandledAt = perfNow();
  toggleRadial();
}

const stage = document.getElementById('stage');
const pixel = document.getElementById('pixel');
const mascot = document.getElementById('mascot');
const mascotImg = document.getElementById('mascot-img');
const cat = document.getElementById('cat'), petAnchor = document.getElementById('pet-anchor');
const catImg = document.getElementById('cat-img');
// R56: meme skin packs (cat/whale tables, lazy caches, pose rotation) moved to
// pet-skin-packs.js — the frame table routes meme skins through it.
const skinPacks = window.OctoPetSkinPacks;
// R59: custom expression overrides (expression studio); the override layer
// wraps every asset swap (see pet-frame-table.js).
const petExpressions = window.OctoPetExpressions;
const isMeme = () => skinPacks.isMeme(skin);

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
// R56: 瞬态 HUD（radial/chooser/sesslist/todopop）刚刚打开的时间戳。
// 所有 open 路径都汇入 syncUiBusy，在 busy→true 的沿上记录一次，
// dismissTransientUi 用它做 blur 宽限判定（防焦点抖动秒杀刚开的菜单）。
let transientUiOpenedAt = 0;
function syncUiBusy(force = false) {
  // R35.2 (2026-07-31): added providerChooserOpen to the busy union.
  // The 0.5.12 carpet audit (P0-1 证据A) flagged that the chooser was
  // not in this list, so Rust's native click-through guard and the
  // territory/blur branches didn't know the chooser was open — risking
  // the chooser being treated as non-interactive while it was visible.
  const busy = !!(radialOpen || todoPopOpen || sessListOpen || askActive || providerChooserOpen || isInteracting());
  if (!force && busy === lastUiBusy) return;
  if (busy && !lastUiBusy) transientUiOpenedAt = perfNow();
  lastUiBusy = busy;
  void nativeUiBusyController.request(busy);
  if (busy) {
    setMouseIgnore(false);
    // R56: focusPet() removed — stealing focus right after the radial/chooser
    // opens triggers a native Focused(false) bounce on X11/Wayland/WebView2
    // (focus-steal protection), which flows back as pet:window-blur and
    // dismisses the just-opened menu ("菜单出现一下就消失"). Upstream shows
    // radial synchronously without any set_focus; the right-click itself
    // already activated the window.
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
  // Note: .catch() already present - this was already handled
}
// 带上 sessionId：否则同一项目下两个并行会话若问了同样的问题，会共用一个 key，
// 答掉一个就把另一个也标记成 answered 吞掉。choice 各构造处都带 sessionId。
const choiceKey = (c) => (c && (c.sessionId || '') + '|' + (c.permId || '') + '|' + (c.project || '') + '|' + (c.question || '')) || '';
const snapshotChoices = (stats) => Array.isArray(stats && stats.pendingChoices)
  ? stats.pendingChoices
  : ((stats && stats.sessions) || []).filter((x) => x.choice).map((x) => x.choice);

// R60-F9/P1-5: backend options now carry an i18nKey (perm.*) alongside the
// zh-compat label — resolve the localized text for the active language and
// keep the label as the fallback for old payloads.
const optLabel = (opt) => (opt && opt.i18nKey && i18n ? t(opt.i18nKey) : (opt && opt.label) || '');

// 动态定高：保持上游 1.1.1 的逻辑像素尺寸和底部锚定语义。Rust 会按
// 当前 DPI 换算为物理像素，并在扩窗/缩窗时保持可见桌宠的底部中心不跳动。
const POPUP_W = 520;
const POPUP_BOTTOM = 200;
const ASK_VIEWPORT_MAX_H = 520;
let fitPopupSeq = 0;
let petSizeFrame = 0;
let pendingPetSize = null;
let petAnchorShift = [0, 0];
function applyPetLayout(layout) {
  const shiftX = Number(layout && layout.anchorShiftX) || 0;
  const shiftY = Number(layout && layout.anchorShiftY) || 0;
  petAnchorShift = [shiftX, shiftY];
  stage.style.setProperty('--pet-anchor-shift-x', shiftX + 'px');
  stage.style.setProperty('--pet-anchor-shift-y', shiftY + 'px');
  stage.classList.remove('pet-layout-left', 'pet-layout-right', 'pet-layout-top', 'pet-layout-bottom', 'pet-layout-center');
  stage.classList.add('pet-layout-' + ((layout && layout.side) || 'center'));
}
async function normalizePetAnchor() {
  const [shiftX, shiftY] = petAnchorShift;
  if (!shiftX && !shiftY) return;
  const [x, y] = await window.pet.getWinPos();
  await window.pet.setWinPos(Math.round(x + shiftX), Math.round(y + shiftY));
  lastWinPos = [Math.round(x + shiftX), Math.round(y + shiftY)];
  applyPetLayout(null);
}
const petSizeController = window.OctoLatestValue.createLatestValueController({
  retryDelays: [80, 250],
  equals: (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1],
  apply: async (size) => {
    await normalizePetAnchor();
    markGeometryBusy(size);
    const layout = await window.pet.setPetSize(size[0], size[1]);
    applyPetLayout(layout);
    return layout;
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
  // R57（用户报告的「叠加残影/烧屏」）：透明 WebView 窗口收缩后，已停绘区域
  //（display:none 的 HUD）的旧帧 alpha 不会被 WebView2/webkitgtk 自动清除，
  // 下次扩窗时旧像素重新落窗显影（tauri#10306 / WebView2Feedback#5673）。
  // 在每次尺寸确认后做一次合成层 nudge：root 提层一帧→全量重栅格化→
  // 强制 WebView 全帧 present，替换含旧 alpha 的合成面（对扩/缩两个方向都
  // 生效，成本仅 2 帧）。
  nudgeWebViewRepaint();
  // After the busy window closes, re-measure and re-emit visual bounds so
  // the native hit-test region snaps to the final size.
  requestAnimationFrame(reportPetVisualBounds);
  // R35.1: if openRadial() was deferred during the busy window, open it
  // exactly once now. The flag is cleared here and in closeRadial/blur/
  // drag-start so a stale intent can't reopen the HUD after dismissal.
  if (pendingRadialOpen) {
    pendingRadialOpen = false;
    if (!radialOpen && !todoPopOpen && !sessListOpen) {
      showRadialNow();
    }
  }
}

// R57：透明窗表面强制重绘（见 clearGeometryBusy 注释）。translateZ(0) 是
// 恒等变换，不产生视觉位移；两帧后释放，避免常驻合成层。reduced-motion
// 不受影响（无动画参与）。
function nudgeWebViewRepaint() {
  const root = document.documentElement;
  root.style.transform = 'translateZ(0)';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.style.transform = '';
    requestAnimationFrame(reportPetVisualBounds);
  }));
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
      // R58-1a: two rAF frames often run before the set_pet_size IPC lands,
      // so rows were measured at 320px width and wrapped → height overshoot
      // (measured +131px in sim), leaving an ever-growing dead zone at the
      // window top. Wait until innerWidth actually reaches POPUP_W (≤12
      // frames ≈ 200ms fallback) before measuring.
      let waits = 0;
      const measureWhenWide = () => {
        if (seq !== fitPopupSeq) return;
        if (Math.abs((window.innerWidth || 0) - POPUP_W) > 2 && waits < 12) {
          waits += 1;
          requestAnimationFrame(measureWhenWide);
          return;
        }
        measure();
      };
      requestAnimationFrame(measureWhenWide);
    } else {
      measure();
    }
  });
}
function resetPetSize() {
  fitPopupSeq++;
  setRequestedPetSize(0, 0);
}

// ════════════════════════════════════════════════════════════════════════
// R60 module assembly. Order matters only where noted.
// ════════════════════════════════════════════════════════════════════════
let muted = false;
let state = 'idle'; // mirror of the state machine's state, kept in sync via
                    // the module hook below (tests and legacy call sites read it)

// ── pixel 皮肤本体（RV-A P0 修复：重写时 PIXEL_MAP/buildPixel 丢失会让
// pixel 皮肤渲染空白——.pixel-sprite 是空容器，SVG 由 JS 注入）──
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

// ── effects (sound / confetti / ribbons / micro-motions) ─────────────────
const curSkinEl = () => (skin === 'pixel' ? pixel : isMeme() ? cat : mascot);
const fx = window.OctoPetFx.create({
  stage, pixel,
  muted: () => muted,
  skin: () => skin,
  state: () => state,
  currentSkinEl: curSkinEl,
  uiBusy: () => !!lastUiBusy,
});

// ── frame table (mascot images + override-aware swap chain) ──────────────
const frames = window.OctoPetFrameTable.create({
  mascotImg, catImg, skinPacks, petExpressions,
  skin: () => skin,
  state: () => state,
});
skinPacks.configure({ img: catImg, swap: frames.swap });
function updateMascotEyes(s) { frames.updateMascot(s); } // legacy call-site shim
function updateCat(s) { frames.updateCat(s); }           // legacy call-site shim
function maybePreloadMemeAssets() {
  if (isMeme()) skinPacks.ensurePreloaded(skin);
}
if (typeof requestIdleCallback === 'function') requestIdleCallback(maybePreloadMemeAssets, { timeout: 1600 });
else setTimeout(maybePreloadMemeAssets, 250);
// RV-A/RV-C 评审修复（R60）：旧 pet.js 在模块加载时启动微动作链，重写后
// 装配调用丢失（眨眼/peek 全失）。补回启动调用。
fx.scheduleBlink();
fx.scheduleIdleAction();

// ── bubble owner ──────────────────────────────────────────────────────────
const bubbleApi = window.OctoPetBubble.create({
  bubble, bubbleText,
  muted: () => muted,
  // P2-6 (R60-2): the guard now covers EVERY overlay (ask/radial/sesslist/
  // todo/chooser) — the old guard missed sessListOpen/todoPopOpen, so the
  // dark HUD panels covered the bubble entirely.
  anyOverlayOpen: () => !!(radialOpen || todoPopOpen || sessListOpen || askActive || providerChooserOpen),
  fitPopup,
  resetPetSize,
});
const showBubble = (text, holdMs, force) => bubbleApi.showBubble(text, holdMs, force);

// ── state machine ─────────────────────────────────────────────────────────
const STATE_WORDS = (window.OctoStates && window.OctoStates.RENDER_STATE_WORDS) || [];
const stateEls = [pixel, mascot, cat].filter(Boolean);
const DEBUG_STATE = null; // 调试用：强制某状态（如 'sleeping'）；正常运行设为 null
const ERROR_DISMISS_COOLDOWN_MS = 30000; // 30s 冷却期
let errorDismissed = false;   // 用户已确认错误，冷却期内不重入 error
let errorDismissedAt = 0;     // 确认时间戳
// say 接棒定时器的清理钩子（router 创建后回填，见 below）
let clearSayTimerHook = () => {};
const sm = window.OctoPetStateMachine.create({
  stateEls, thinkEl, sleepEl, stateWords: STATE_WORDS,
  log: rlog,
  perfNow: () => perfNow(),
  hideBubble: () => bubbleApi.suppress(),
  onFrameUpdate(s) {
    if (skin === 'mascot') frames.updateMascot(s);
    if (isMeme()) frames.updateCat(s);
    if (petExpressions && petExpressions.hasOverride(s)) frames.reapply();
  },
  onErrorRibbons: () => fx.syncErrorRibbons(),
  reportBounds: () => reportPetVisualBounds(),
  replayAggregate: () => { if (lastStats) applyStats(lastStats, true); },
  onTransientCleared: () => clearSayTimerHook(),
  onStateApplied(s) { state = s; }, // composition-root mirror (legacy reads)
  // RV-B P0 fix (R60 评审团)：漏接 showBubble —— transient 的气泡文字
  // （任务完成/问候/报错/说语/领地/旅行）曾全链不显示（守卫恒 false）。
  showBubble: (text, holdMs) => bubbleApi.showBubble(text, holdMs),
  toolAction: (toolName) => runtimePolicy ? runtimePolicy.toolAction(toolName, activeProviderForPet()) : null,
  showProp(act, icon) {
    // R57 (upstream pet.js:2984)：cat / whale 的 GIF 已经表达工具动作，
    // 不再叠外围道具 emoji（叠加会污染皮肤画面——「皮肤不正确」的根因之一）。
    if (!isMeme() && icon) {
      propEl.textContent = icon;
      propEl.className = 'prop';
      void propEl.offsetWidth; // 重启动画
      const pm = PROP_MOTION[act];
      propEl.className = 'prop on' + (pm ? ' ' + pm : '');
    }
  },
  clearProp() { propEl.classList.remove('on'); },
  showSidekick() {
    sidekickEl.classList.remove('on');
    void sidekickEl.offsetWidth;
    sidekickEl.classList.add('on');
  },
});
const setState = (s) => sm.setState(s);          // legacy call-site shims
const transient = (s, ms, text, holdMs) => sm.transient(s, ms, text, holdMs);
const clearTransient = () => sm.clearTransient();

// ── aggregate ladder (pure) ───────────────────────────────────────────────
const aggregate = window.OctoPetAggregate;

// ── drag owner ────────────────────────────────────────────────────────────
const drag = window.OctoPetDrag.create({
  api: window.pet,
  log: rlog,
  setMouseIgnore,
  getWinPosCache: () => lastWinPos,
  onPosCached: (pos) => { lastWinPos = pos; },
  onPureClick() {
    // Error state unlock: clicking pet while in error state clears the lock
    // so other sessions can update the pet again.
    if (state === 'error') {
      errorDismissed = true;
      errorDismissedAt = perfNow();
      setState('idle');
      showBubble(t('bub.errorAck'), 3000, true);
      return;
    }
    if (radialOpen) closeRadial();
    else toggleSessList();
  },
  onDragStart: () => { pendingRadialOpen = false; },
  onDragConfirmed: () => { if (radialOpen) closeRadial(); },
  onRightClickPointer: () => toggleRadialFromPointer(),
  onContextMenuFallback: () => { if (perfNow() - rightClickHandledAt > 400) toggleRadial(); },
});

// ── event router ──────────────────────────────────────────────────────────
const router = window.OctoPetEventRouter.create({
  t,
  stateMachine: sm,
  fx,
  showBubble,
  isInteracting,
  eventBelongs: eventBelongsToThisPet,
  enqueueChoice,
  openProviderChooser,
  replayAggregate: () => { if (lastStats) applyStats(lastStats, true); },
  isPrimaryPet: PET_AGENT !== 'pet-codex', // P2-7: hidden pet-codex must not beep on toasts
  // RV-I P2-3: single-mode double-audio gate — the hidden pet-codex webview
  // processes every broadcast event; its AudioContext still beeps. Only the
  // primary window plays in single mode; both windows play their own
  // (event-filtered) sounds in duo mode.
  canPlaySound: () => petMode !== 'single' || PET_AGENT !== 'pet-codex',
  isMeme,
  stateWords: STATE_WORDS,
  perfNow: () => perfNow(),
});
clearSayTimerHook = () => router.clearSayTimer();
window.pet.onEvent(router.handle);

// ── tool action map (prop motion variants — kept for the prop DOM above) ──
const PROP_MOTION = { crank: 'spin', web: 'spin', search: 'hunt', type: 'jit' };

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
  // RV-B P1 修复（R60）：会话列表开着时不抢面板——旧版每 ~2s 快照重弹 ask
  // 面板并强关 sesslist，形成「列表↔卡片」乒乓。列表关闭后下一条快照
  // （≤2s）自然重开面板。
  if (sessListOpen) { lastAskSig = ''; return; }
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

  bubbleApi.suppress();
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
  // R57-RV-C13 (upstream 16e8dbc): the plan-mode placeholder stayed visible
  // after the panel switched to a non-plan card — reset it every clear.
  if (askText.placeholder !== t('ask.placeholder')) {
    askText.placeholder = t('ask.placeholder');
  }
}

// ① elicitation（AskUserQuestion）：多选项卡 + Other + 分页 + Submit/Back
function renderElicitation(c) {
  clearAskBody();
  askLabel.textContent = t('ask.needsInput');
  const qs = elic.questions;
  const q = qs[elic.qIdx] ||
    { question: c.question || t('ask.needAnswer'), options: (c.options || []).map((o) => ({ label: o.label, description: o.desc })) };
  askQhead.textContent = q.header || '';
  askQ.textContent = q.question || '';
  const multi = !!q.multiSelect;
  elic.multi = multi;
  askHint.textContent = multi ? t('ask.multiHint') : t('ask.chooseOne');

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
  // R57 (upstream 16e8dbc 同款缺陷修复)：elicitation 卡片里残留英文硬编码。
  askOpts.appendChild(buildRadioCard(t('ask.other'), '', '__other__', q));
  if (elic.selected === '__other__' || (multi && elic.otherOn)) {
    askInputRow.classList.remove('hidden');
    if (!multi && prior && !known(prior)) askText.value = prior;
  }

  askPage.textContent = `${elic.qIdx + 1} / ${qs.length || 1}`;
  askFoot.classList.remove('hidden');
  const last = elic.qIdx >= (qs.length || 1) - 1;
  askSubmit.textContent = last ? t('ask.submit') : t('ask.next');
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
  // R32 (2026-07-31): await IPC before removing the choice card.
  submitDecision(c, { type: 'elicitation-submit', answers: { ...elic.answers } }, t('ask.submitted'));
}

function elicBack(c) {
  if (elic && elic.qIdx > 0) { elic.qIdx--; renderElicitation(c); }
}

// ② 授权：允许(绿)/拒绝(红) + 可选会话级批量授权按钮
function renderPerm(c) {
  clearAskBody();
  askLabel.textContent = t('ask.needPerm');
  askQhead.textContent = c.header || '';
  askQ.textContent = c.question || t('ask.needPermQ');
  const opts = c.options || [];
  if (opts.length === 2) askOpts.classList.add('perm-row'); // 仅允许/拒绝时并排
  opts.forEach((opt) => {
    // W11: batch-allow keys (cw-allow-session, cw-allow-tool) render as green
    // "allow" style, not neutral "sugg" — they're approval actions.
    const isAllow = opt.key === 'allow' || opt.key === 'cw-allow-session' || opt.key === 'cw-allow-tool';
    const kind = isAllow ? 'allow' : opt.key === 'deny' ? 'deny' : 'sugg';
    const card = document.createElement('button');
    card.className = 'ask-opt act ' + kind;
    // R60-F9/P1-5: backend options carry i18nKey (perm.*); old payloads keep
    // the zh label fallback. en/ja users finally see localized buttons.
    card.innerHTML = `<span class="ask-ot"><span class="ask-ol">${esc(optLabel(opt))}</span></span>`;
    card.addEventListener('click', () => submitPerm(opt.key, c, optLabel(opt)));
    askOpts.appendChild(card);
  });
  askFoot.classList.add('hidden');
  askTerm.classList.remove('hidden');
}

// ③ 纯回复（无选项）：只读问题 + Go to Terminal
function renderContinue(c) {
  clearAskBody();
  askLabel.textContent = t('ask.needsInput');
  askQ.textContent = c.question || t('perm.continueQuestion', { who: firstProviderLabel() });
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
  approve.innerHTML = `<span class="ask-ot"><span class="ask-ol">${esc(t('ask.approve'))}</span></span>`;
  approve.addEventListener('click', () => submitPerm('allow', c, t('ask.approved')));
  askOpts.appendChild(approve);
  const reject = document.createElement('button');
  reject.className = 'ask-opt act deny';
  reject.innerHTML = `<span class="ask-ot"><span class="ask-ol">${esc(t('ask.reject'))}</span></span>`;
  reject.addEventListener('click', () => {
    // R32 (2026-07-31): await IPC before removing the choice card.
    submitDecision(c, { type: 'plan-feedback', feedback: (askText.value || '').trim() }, t('ask.rejected'));
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
    // 先关面板（置 askActive=false），确认气泡才不会被 showBubble 的 askActive 早退拦掉
    hideAsk();
    showBubble(bubbleMsg, 2600);
  }
}
function submitPerm(key, choice, label) {
  const msg = key === 'allow' ? t('ask.allowed') : key === 'deny' ? t('ask.denied') : t('ask.remembered');
  // W11/W24: CodeWhale batch authorization keys.
  // R32 (2026-07-31): all paths now go through submitDecision() so the IPC
  // is awaited and the choice card is only removed on actual success.
  if (key === 'cw-allow-session') {
    submitDecision(choice, { __cw_batch: 'session' }, t('ask.cwSessionDone'));
    return;
  }
  if (key === 'cw-allow-tool') {
    submitDecision(choice, { __cw_batch: 'tool' }, t('ask.cwToolDone'));
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
    finishChoice(choice, t('ask.toTerminal'));
    return;
  }
  // With a permission: await the deny, then focus the terminal and finish.
  const buttons = askOpts ? askOpts.querySelectorAll('button') : [];
  buttons.forEach((b) => { b.disabled = true; });
  Promise.resolve()
    .then(() => routeDecision(choice, 'deny'))
    .then(() => {
      window.pet.focusSession(choice.sessionId || '');
      finishChoice(choice, t('ask.toTerminal'));
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
}

// 一张「需要你处理」卡片：问题 + 选项按钮(可点即答) + 自定义输入
function buildActCard(c) {
  const card = document.createElement('div');
  card.className = 'tp-act';
  const kindTag = c.kind === 'perm' ? t('ask.kindPerm') : c.kind === 'continue' ? t('ask.kindContinue')
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
      b.textContent = optLabel(opt); // R60-F9: i18nKey-aware (P1-5)
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
// R32 (2026-07-31): await IPC before marking answered — the todo popup card
// stays interactive (the popup itself doesn't close on success, but if IPC
// fails the choice must remain answerable).
function popPerm(choice, key) {
  const msg = key === 'allow' ? t('ask.allowed') : key === 'deny' ? t('ask.denied') : t('ask.remembered');
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
// dsh（DeepSeek Harness）深蓝方块 + 鲸背波浪（上游 main pet.js 同款）
const DSH_ICON =
  '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" fill="#4d6bfe"/>' +
  '<circle cx="8.6" cy="9" r="1.5" fill="#fff"/><path d="M12 9h5.4" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>' +
  '<path d="M5 15c1.6 0 1.6-1.7 3.3-1.7S9.9 15 11.5 15s1.6-1.7 3.3-1.7S16.4 15 18 15" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
const PROVIDER_ICONS = { claude: CLAUDE_ICON, codewhale: '🐋', codex: CODEX_ICON, opencode: '🧩', aider: '🛠️', dsh: DSH_ICON };
const PROVIDER_LABELS = { claude: 'Claude', codewhale: 'CodeWhale', codex: 'Codex', opencode: 'OpenCode', aider: 'Aider', dsh: 'DSH' };
const SESSION_STATE_KEYS = {
  waiting: 'state.waiting', needsinput: 'state.needsinput', working: 'state.working',
  juggling: 'state.juggling', sweeping: 'state.sweeping', thinking: 'state.thinking',
  loafing: 'state.loafingLong', error: 'state.error', idle: 'state.idle', sleeping: 'state.sleeping',
  attention: 'state.attention', notification: 'state.notification',
};
function sessionStateLabel(value) {
  const key = SESSION_STATE_KEYS[value];
  return key ? t(key) : (value || '');
}

// 对齐参考项目阈值：≥90% 红(hot)、≥75% 黄(warm)、其余灰
function ctxClass(p) { return p >= 90 ? 'high' : p >= 75 ? 'mid' : ''; }

// 单一判定：哪些会话出现在「头顶小点」和「会话列表 HUD」里（保持两处联动一致）
// R50: headless CHILD sessions (subagents) are hidden — they surface through
// their parent (juggling/summon) — but a BLOCKED child (waiting/needsinput)
// must stay visible: that is exactly the "other session is stuck and the pet
// never told me" case. Background headless sessions (claude -p) have no
// parentId and remain visible per STATES.md §3.
const isVisibleSession = (s) => !!s && s.state !== 'sleeping'
  && (!s.headless || s.state === 'waiting' || s.state === 'needsinput' || s.state === 'notification')
  // R58-1a (upstream pet.js:1486-1489 parity): archived sessions never show
  // as head status dots. This helper was dead code — renderSessions never
  // called it — which is why archiving left the bottom dots stale.
  && !archivedSet.has(s.sessionId);
// 单一配色：小点和 HUD 用同一套（完成→绿、中断→红，否则按状态）
function sessionDotClass(s) {
  // R57-RV-A2: the badge is authoritative regardless of the row state —
  // Stop now lands on `attention` (STATES.md §3) instead of idle, so the
  // old `state === 'idle'` gate kept both dots dead forever.
  if (s.badge === 'done') return 'done';
  if (s.badge === 'interrupted') return 'error';
  return s.state || 'idle';
}

function visibleSessions() {
  return runtimePolicy.projectVisibleSessions(curSessions)
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
        // R60 P2-9: attention/notification rows ARE actionable — the filter
        // only matched waiting/needsinput, so CodeWhale turn_end rows
        // vanished from the「待处理」view.
        const st = s.state;
        if (st !== 'waiting' && st !== 'needsinput' && st !== 'attention' && st !== 'notification') return false;
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
const SESS_SORT = { waiting: 0, needsinput: 0, error: 1, working: 2, juggling: 2, sweeping: 2, thinking: 2, loafing: 3, idle: 4, sleeping: 5 };

let lastSessListSig = '';
function renderSessList(opts) {
  const force = !!(opts && opts.force);
  const list = visibleSessions();
  // RV-B P1 修复（R60）：每 ~2s 快照全量重建会滚回顶部、吞掉复制 ID 的
  // 1.1s 反馈。套用 ask 面板的 lastAskSig 同款内容签名——未变则跳过重建；
  // 重建时保存/恢复 slRows 滚动位置。
  const sig = [slQuery, slFilter, list.map((s) => [s.sessionId, s.state, s.badge,
    pinnedSet.has(s.sessionId) ? 1 : 0, archivedSet.has(s.sessionId) ? 1 : 0,
    s.project, s.op, s.reason].join('\u0001')).join('\u0002')].join('\u0003');
  if (!force && sig === lastSessListSig) return;
  lastSessListSig = sig;
  const prevScrollTop = slRows ? slRows.scrollTop : 0;
  slSub.textContent = list.length ? t('sess.count', { n: list.length }) : '';
  slRows.innerHTML = '';
  if (!list.length) {
    const e = document.createElement('div');
    e.className = 'sl-empty';
    // R57-RV-C13: an empty list after filtering/search means the rows exist
    // but none match — "暂无" (nothing exists) is misleading.
    const allSessions = (lastStats && lastStats.sessions) || [];
    e.textContent = allSessions.length ? t('panel.noMatch') : t('sess.empty');
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
    // R59: travel-capable providers come from the backend config snapshot
    // (cfg.wanderSupported — travel.rs single source, now including opencode
    // + aider runners); the mirror is only for old payloads. The old
    // ['claude','codex'] literal hid the 🧳 button on codewhale sessions.
    const wanderCapable =
      (Array.isArray(wanderSupportedList) && wanderSupportedList.length
        ? wanderSupportedList
        : window.OctoPetTravelView.WANDER_SUPPORTED);
    const travelBtn = !s.headless && wanderCapable.includes(s.providerId || s.provider)
      ? `<button class="sl-action sl-travel" title="${t('sess.travel')}">🧳</button>` : '';
    // R57 (upstream main.js:1553-1560)：会话 ID 尾 8 位一键复制，跨 agent
    // resume 协作刚需（终端里 `claude --resume <paste>` / `opencode -s <paste>`）。
    const copyBtn = s.sessionId
      ? `<button class="sl-action sl-copy" title="${t('sess.copyId')}">${esc(String(s.sessionId).slice(-8))}</button>`
      : '';
    row.innerHTML =
      `<span class="sl-dot ${dotCls}"></span>` +
      `<span class="sl-icon">${provIcon}</span>` +
      `<div class="sl-main"><div class="sl-name">${esc(s.project)}</div>` +
      `<div class="sl-meta ${attn ? 'attn' : ''}">${esc(meta)}</div></div>` +
      ctx +
      `<span class="sl-row-actions">${copyBtn}${travelBtn}${pinBtn}${archiveBtn}</span>`;
    // Click row → focus session
    row.addEventListener('click', (e) => {
      if (e.target.closest('.sl-action')) return; // action button click handled separately
      window.pet.focusSession(s.sessionId || '');
      rlog('sesslist', 'focus ' + (s.project || ''));
      closeSessList();
    });
    // R57: 复制会话 ID（Clipboard API + execCommand 兜底），1.1s 已复制反馈。
    const copyEl = row.querySelector('.sl-copy');
    if (copyEl) copyEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = s.sessionId || '';
      // R57-RV-B7: restore to the id tail constant — a second click inside
      // the feedback window would otherwise snapshot "已复制" and restore it
      // forever.
      const tail = String(s.sessionId).slice(-8);
      const done = () => {
        copyEl.textContent = t('sess.copied');
        setTimeout(() => { copyEl.textContent = tail; }, 1100);
      };
      const fallback = () => {
        try {
          const ta = document.createElement('textarea');
          ta.value = id;
          ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          done();
        } catch {}
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(id).then(done, fallback);
      } else {
        fallback();
      }
    });
    const travelEl = row.querySelector('.sl-travel');
    if (travelEl) travelEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        // R59: mission=null → the backend picks a random TRILINGUAL mission
        // (the fixed Chinese mission text made every trip identical).
        await window.pet.startTravel(s.sessionId || '', null);
        showBubble(t('bubble.travelStart', { project: s.project || t('sess.travelProjectFallback') }), 3200, true);
        closeSessList();
      } catch (error) {
        const message = String(error && (error.message || error) || 'unknown');
        showBubble(t('bubble.travelFailDetail', { error: message }), 5000, true);
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
      // R58-1a: pinning un-archives, so dots must revive immediately; the
      // HUD shrinking must resize the window now, not at the next stats push
      // (an idle session may never push again).
      renderSessions(curSessions);
      if (sessListOpen) fitPopup(sesslist);
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
      // R58-1a: archive removes the dot immediately and shrinks the HUD —
      // previously the window height stayed frozen at the pre-archive size,
      // and with a bottom-anchored window the dead zone grew taller on every
      // click ("GUI 越来越高"). Re-fit now instead of waiting for stats.
      renderSessions(curSessions);
      if (sessListOpen) fitPopup(sesslist);
    });
    slRows.appendChild(row);
  }
  if (slRows) slRows.scrollTop = prevScrollTop;
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
    // R58-1a: after the IPC landed (or rolled back), converge dots and height.
    // Guard: the list may already be closed by blur — never fit a hidden
    // element (scrollHeight 0 would clamp the window to the 340 floor).
    renderSessions(curSessions);
    if (sessListOpen) fitPopup(sesslist);
  });
}
const sessionLifecycle = window.OctoPetSessionLifecycle.create({ element: sesslist,
  isOpen: () => sessListOpen, setOpen: (v) => { sessListOpen = v; }, radialOpen: () => radialOpen, closeRadial,
  todoOpen: () => todoPopOpen, closeTodo: closeTodoPop, providerChooserOpen: () => providerChooserOpen,
  closeProviderChooser, hideAsk, render: renderSessList, syncBusy: syncUiBusy, log: rlog,
  visibleCount: () => visibleSessions().length, fit: fitPopup, resetSize: resetPetSize });
const { open: openSessList, close: closeSessList, toggle: toggleSessList } = sessionLifecycle;
function activeProviderForPet() {
  return runtimePolicy.resolveProvider(curSessions, activeProviders, PET_AGENT, duoProvider);
}
const travelView = window.OctoPetTravelView.create({
  api: window.pet,
  bubble: showBubble,
  close: closeSessList,
  provider: activeProviderForPet,
  // R50: dual-pet isolation — this pet only tracks trips owned by its own
  // window (pet / pet-codex); wander degrades to a supported enabled provider.
  agent: PET_AGENT,
  enabledProviders: () => activeProviders,
  // R59: backend-authoritative wander capability set from the config
  // snapshot; pet-travel-view.js falls back to its mirror only when the
  // field is absent (old backend payload).
  supported: () => wanderSupportedList,
});

function perfNow() {
  return Date.now();
}

// ---------- 统计 + 聚合状态 ----------
let lastStats = null; // 最近一次快照：transient 到期时用它立即重算聚合态
let lastStatsRevision = -1; // R40.1: monotonic revision guard — reject stale stats
let currentCurrency = 'USD';
let currentFxRate = 7.2;
let lastWaiting = 0;
let lastBgZombie = 0; // 后台疑似僵尸数
let radialOpen = false;
const IDLE_SLEEP_MS = 6 * 60 * 1000;

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

function applyStats(s, force) {
  if (!s) return;
  s = statsForThisPet(s);
  // R40.1: reject stale-revision snapshots (force=true = internal lastStats replay, e.g. transient fallback).
  if (!force && !acceptStatsRevision(s)) return;
  lastStats = s;
  const today = s.today || {}, w5h = s.window5h || {}; // R1-A#1: defensive reads
  chipCost.textContent = fmtCost(today.cost || 0);
  chipWindow.textContent = '5h ' + fmtCost(w5h.cost || 0);
  // 从 stats 推送同步权威窗口位置，校正拖动缓存
  if (s.winPos && s.winPos.length === 2) {
    const [wx, wy] = s.winPos;
    if (Number.isFinite(wx) && Number.isFinite(wy)) {
      lastWinPos = [wx, wy];
      drag.setCachedPos(lastWinPos); // RV-A P2：双缓存同步缺口——外部权威位置更新必须回写 drag 侧，否则纯点击回旧位
    }
  }
  lastWaiting = (s.waitingCount || 0) + (s.needsinputCount || 0); // 待处理徽标含「等你回复」
  lastBgZombie = (s.bg && s.bg.zombie) || 0;
  if (radialOpen) radialMenu.updateBadges();
  renderSessions(s.sessions || []);
  if (petMode === 'duo') updateProviderUI();
  updateNotepad(s); // 记事本：行动清单 + 待办
  travelView.update(s.travel);
  if (sessListOpen) { renderSessList(); fitPopup(sesslist); } // HUD 开着时随快照刷新并重定高

  // 选项面板：按快照重建队列（多任务都在、标明项目；防漏事件/启动时已在等待）
  refreshAsk(s);

  if (DEBUG_STATE) { setState(DEBUG_STATE); return; }

  // 你正在看面板/打字 → 不再改小章鱼状态(别动来动去打断你)，安静等你答完
  if (isInteracting()) return;

  // R60: the aggregate ladder is now a pure function (pet-aggregate.js).
  // Ladder semantics identical to the 0.6.8 inline version (STATES.md §3):
  //   waiting > 短暂态 > error(8) > needsinput/notification(7) > sweeping(6)
  //   > attention(5) > juggling(4) > working(3) > thinking(2) > idle(1) > sleeping(0)
  // RV-C P2-1: computed ONCE — resolve() and the latch check previously each
  // re-ran the runtimePolicy aggregate (O(n) session scan ×2 per push).
  const ownTrip = s.travel && s.travel.active
    && s.travel.active[window.OctoPetTravelView.ownerKeyFor(PET_AGENT)];
  const aggregateFn = (snap) => runtimePolicy.aggregateState(snap, { sleepMs: IDLE_SLEEP_MS });
  const aggregateNext = aggregateFn(s);
  const next = aggregate.resolve({
    stats: s,
    now: perfNow(),
    transientActive: sm.isTransientActive(),
    transientState: sm.getTransientState(),
    aggregate: aggregateFn,
    ownWanderTrip: ownTrip || null,
    errorDismissed: { dismissed: errorDismissed, at: errorDismissedAt, cooldownMs: ERROR_DISMISS_COOLDOWN_MS },
  });
  if (aggregateNext === 'error' && !errorDismissed) errorDismissed = false;
  setState(next);
}
window.pet.onStats(applyStats);
if (window.pet.onTravel) {
  window.pet.onTravel((event) => {
    if (!event || !eventBelongsToThisPet(event)) return;
    if (event.state) travelView.update(event.state);
    else window.pet.getTravel().then(travelView.update).catch(() => {});
    // P1-1 (R60-2): terminal travel phases render HERE ONLY. travel.rs also
    // emits a pet:event(kind:travel) copy of completed/failed — the old
    // pet.js handled both channels, doubling the transient and flickering
    // the bubble text (📮 summary ↔ bare summary). The event-router's
    // travel arm now keeps only `started`/`cancelled`.
    if (event.phase === 'completed') {
      transient('happy', 2600, `📮 ${event.summary || t('bub.travelDone')}`, 8000);
      fx.confetti();
      // R57 (R57-1e 声音覆盖)：travel 完成有彩带无音效——补 bigDone 号角，
      // 与 big-done/territory victory 的听觉反馈对齐。RV-I P2-3：隐藏副宠窗
      // 不出声（单窗模式）。
      if (petMode !== 'single' || PET_AGENT !== 'pet-codex') fx.SOUND.bigDone();
    } else if (event.phase === 'failed') {
      transient('error', 2600, `🧳 ${event.summary || t('bub.travelFailPlain')}`, 5000);
    } else if (event.phase === 'cancelled') {
      showBubble(t('bubble.travelCancel'), 2600, true);
    }
  });
}

function decorateSessionDot(d, s) {
  d.className = 'sess-dot ' + sessionDotClass(s);
  // R60 P2-10: localized tooltip — the old builder hardcoded `等你…` and
  // read the zh-only SESS_META fallback, so en/ja users always got Chinese.
  const label = s.state === 'waiting'
    ? t('sess.waitFor', { reason: s.reason || t('bub.waitDefault') })
    : sessionStateLabel(s.state);
  d.title = `${s.project} · ${label}`;
}

function renderSessions(sessions) {
  // 与会话列表 HUD 完全联动：同一过滤(非 headless/非睡眠/非归档)、同一配色、同一排序。
  const list = runtimePolicy.projectVisibleSessions(sessions)
    .filter(isVisibleSession) // R58-1a: revive the archived filter for dots
    .sort((a, b) => {
    const pa = SESS_SORT[a.state] != null ? SESS_SORT[a.state] : 3;
    const pb = SESS_SORT[b.state] != null ? SESS_SORT[b.state] : 3;
    return pa !== pb ? pa - pb : (a.idleMs || 0) - (b.idleMs || 0);
  });
  runtimePolicy.patchSessionDots(sessionsEl, list, decorateSessionDot);
  // 菜单开着时同步「待处理」角标
  if (radialOpen) radialMenu.updateBadges();
}

let activeProviders = [];
let availableProviders = ['claude', 'codewhale', 'codex', 'opencode', 'aider'];
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
  // R58-IMPL-C: sync the second-pet pairing to the partition views.
  // A missing/stale duoProvider field falls back to 'codex' (0.6.6).
  duoProvider = typeof cfg.duoProvider === 'string' && cfg.duoProvider ? cfg.duoProvider : 'codex';
  petAgentView.setDuoProvider(duoProvider);
  // R59: second-pet URL query self-alignment lives in the identity owner
  // module (pet-agent-view.js) — see its doc comment.
  petAgentView.syncDuoQuery(cfg);
  if (cfg.lang) applyLanguage(cfg.lang);
  territorySupported = !!cfg.territorySupported;
  // R59: single-source wander capability (was a drifting frontend mirror).
  if (Array.isArray(cfg.wanderSupported)) wanderSupportedList = cfg.wanderSupported;
  // R58-IMPL-C: window identity ('pet-codex') decides which skin/position
  // fields apply — the semantic provider is config-driven, but the
  // skinCodex/petPositionCodex field names stay (data compatibility).
  const effectiveSkin = PET_AGENT === 'pet-codex' && petMode === 'duo' ? cfg.skinCodex : cfg.skin;
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
    // R58-RV-1/RV-3 P1: another window (panel or the duo pet) archived a
    // session — converge the head dots and the HUD list HERE, not at the
    // next stats push (an idle session may never push again). The same
    // cross-window staleness was the original "底部状态点未清除" symptom.
    renderSessions(curSessions);
    if (sessListOpen) {
      renderSessList();
      fitPopup(sesslist);
    }
  }
  // 从配置推送同步权威窗口位置
  const savedPosition = PET_AGENT === 'pet-codex' && petMode === 'duo' ? cfg.petPositionCodex : cfg.petPosition;
  if (savedPosition && Number.isFinite(savedPosition.x) && Number.isFinite(savedPosition.y)) {
    lastWinPos = [savedPosition.x, savedPosition.y];
    if (drag) drag.setCachedPos(lastWinPos); // RV-A P2：同步 drag 侧缓存
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
      const provider = activeProviderForPet();
      agentTag.className = `agent-tag ${provider || 'aggregate'}`;
      agentTag.textContent = provider ? (PROVIDER_LABELS[provider] || provider) : 'Agent';
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
let providerChooserPrevFocus = null;
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
  providerChooserPrevFocus = document.activeElement;
  setRequestedPetSize(520, Math.max(420, 210 + choices.length * 48));
  syncUiBusy();
  // R35.2 (2026-07-31): focus the first item for keyboard accessibility.
  // R57 (upstream GUI audit P2-6)：窗口尚未持有焦点时 focus() 会触发原生激活，
  // 在透明置顶窗上引发一次焦点反弹（R56 同类根因的残留支线）。仅在已持焦时
  // 直接聚焦；键盘可达性不受影响（用户点开窗口即持焦）。
  const firstItem = providerChooserList.querySelector('.pc-item');
  if (firstItem && document.hasFocus()) {
    try { firstItem.focus(); } catch {}
  }
}
function closeProviderChooser() {
  if (!providerChooserEl) return;
  providerChooserEl.classList.add('hidden');
  providerChooserOpen = false;
  syncUiBusy();
  // R57（upstream GUI audit P0-1b）：chooser 隐藏与窗口收缩原本同帧发生——
  // 「display:none 的 520 宽帧」还没 present 就缩回 320，透明 WebView 的
  // 合成面会保留 chooser 旧帧像素（用户截图中的 provider 列表残影）。
  // 先让已清空的宽帧完成 present，再延迟两帧收缩；收缩 ack 后
  // clearGeometryBusy 的 nudgeWebViewRepaint() 会做全帧重绘双保险。
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!radialOpen && !todoPopOpen && !sessListOpen && !askActive && !providerChooserOpen) {
      resetPetSize();
    }
  }));
  // Restore focus to element that was focused before the chooser opened
  if (providerChooserPrevFocus && providerChooserPrevFocus.isConnected) {
    try { providerChooserPrevFocus.focus(); } catch {}
  }
  providerChooserPrevFocus = null;
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
  if (!providerChooserOpen) return;
  if (e.key === 'Escape') {
    closeProviderChooser();
    return;
  }
  // Focus trap: Tab/Shift+Tab cycles within the chooser
  if (e.key === 'Tab') {
    const items = providerChooserList ? [...providerChooserList.querySelectorAll('.pc-item:not([disabled])')] : [];
    const closeBtn = document.getElementById('pc-close');
    const focusable = closeBtn ? [closeBtn, ...items] : items;
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  // Arrow key navigation between items
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = providerChooserList ? [...providerChooserList.querySelectorAll('.pc-item:not([disabled])')] : [];
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown'
      ? items[Math.min(idx + 1, items.length - 1)]
      : items[Math.max(idx - 1, 0)];
    if (next) next.focus();
  }
  // Enter/Space on focused item activates it
  if ((e.key === 'Enter' || e.key === ' ') && document.activeElement && document.activeElement.classList.contains('pc-item')) {
    e.preventDefault();
    document.activeElement.click();
  }
});
// R35.1: blur closes the chooser too (consistent with radial/sesslist).

function applySkin(s) {
  skin = ['pixel', 'mascot', 'cat', 'whale'].includes(s) ? s : 'mascot';
  document.body.classList.toggle('skin-pixel', skin === 'pixel');
  document.body.classList.toggle('skin-mascot', skin === 'mascot');
  // R57 (upstream pet.js:3868)：两套 meme 皮肤（cat/whale）都切 skin-cat 类——
  // 该类携带 meme 皮肤共用规则（#prop 道具隐藏、.sessions 加宽），whale 再
  // 叠加 skin-whale 拿专属尺寸。漏切会让 whale 下这些规则失效。
  document.body.classList.toggle('skin-cat', isMeme());
  document.body.classList.toggle('skin-whale', skin === 'whale');
  // R30/R56: lazy-load meme assets when switching to cat/whale skin
  skinPacks.ensurePreloaded(skin);
  // R60: frame re-resolution (mascot table + meme packs + overrides) lives
  // in the frame-table owner.
  frames.applyForSkin();
  // R57：换皮时同步错误丝带（离开 whale 时立即清场，防效果泄漏）。
  fx.syncErrorRibbons();
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
// R60: the gesture machinery lives in pet-drag.js; pet.js owns the pet-level
// click semantics (pure-click → error unlock / session list) via callbacks.
// ====================================================================
if (petAnchor) drag.attachDrag(petAnchor);
drag.setCachedPos(lastWinPos);
// 启动时预加载窗口位置到缓存
window.pet.getWinPos().then(([wx, wy]) => { lastWinPos = [wx, wy]; drag.setCachedPos(lastWinPos); }).catch(() => {});

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
notepad.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
document.getElementById('tp-close').addEventListener('click', (e) => { e.stopPropagation(); closeTodoPop(); });

// 会话列表 HUD：关闭 + 底部操作
document.getElementById('sl-close').addEventListener('click', (e) => { e.stopPropagation(); closeSessList(); });
// R44 0.5.44: search input + filter buttons
if (slSearch) {
  slSearch.addEventListener('input', (e) => {
    slQuery = e.target.value.trim();
    renderSessList();
    if (sessListOpen) fitPopup(sesslist); // R58-1a (upstream 4112-4113 pair)
  });
}
document.querySelectorAll('.sl-filter').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    slFilter = btn.dataset.filter;
    document.querySelectorAll('.sl-filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderSessList();
    if (sessListOpen) fitPopup(sesslist); // R58-1a (upstream 4125-4131 pair)
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
// R16: wander button — handled by OctoPetTravelView (pet-travel-view.js) which
// passes the per-pet provider. DWP-3 (R2): removed the duplicate listener here
// that fired alongside the travel view's, causing double wander launches and
// passing provider=null (which mis-routed in duo mode). Single source of truth.
sesslist.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
// Bug 2 fix: 全局禁止原生右键菜单（radial menu 替代系统菜单）
document.addEventListener('contextmenu', (e) => { e.preventDefault(); });
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

let territorySupported = false; // 由 pet:config 下发(仅 macOS true)
// R59: wander-capable provider set from the backend config snapshot
// (cfg.wanderSupported — injected from travel.rs's single source). null =
// old-backend payload; consumers fall back to the module mirror.
let wanderSupportedList = null;

function toggleSkin() {
  const order = ['mascot', 'pixel', 'cat', 'whale'];
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
  showBubble(t(currentCurrency === 'CNY' ? 'bubble.currencyCny' : 'bubble.currencyUsd'), 2000);
}

const radialMenu = window.OctoPetRadialMenu.create({
  radial, stage, t, currentSkin: curSkinEl, close: closeRadial,
  toggle: toggleRadial, claimInput: () => setMouseIgnore(false), toggleSkin, toggleCurrency,
  territorySupported: () => territorySupported,
  muted: () => muted, currency: () => currentCurrency,
  // R58-IMPL-D (B7): the radial patrol item needs the bubble for its
  // deferred/busy feedback (see pet-radial-menu.js) — same pattern as the
  // travel view's owner contract above.
  bubble: showBubble,
  currencyLabel: () => currentLang === 'en' ? 'Currency' : currentLang === 'ja' ? '通貨' : '货币',
  waitingCount: () => lastWaiting, backgroundCount: () => lastBgZombie,
  // R56: share the petAnchor right-click timestamp with the radial so one
  // physical right-click can't double-toggle (pointerdown + late contextmenu).
  noteRightClick: () => { rightClickHandledAt = perfNow(); },
  rightClickHandledRecently: () => perfNow() - rightClickHandledAt < 400,
});

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

function showRadialNow() {
  if (todoPopOpen) closeTodoPop();
  if (sessListOpen) closeSessList();
  // RV-B P1 修复（R60）：ask 面板开着时右键曾把窗口骤缩到 320×340 裁卡，
  // 且 radial (z20) 被 ask (z32) 盖死。与 openTodoPop 同款互斥：卡片优先。
  if (askActive) hideAsk();
  radialMenu.build();
  radial.classList.remove('hidden');
  radialOpen = true;
  syncUiBusy();
  bubbleApi.suppress();
}

function requestRadialViewport() {
  pendingRadialOpen = true;
  // R50: await the resize IPC chain (normalizePetAnchor -> set_pet_size ->
  // applyPetLayout) BEFORE building the radial. The old rAF×2 heuristic read
  // geometryBusy before petSizeController.apply() had even started (it first
  // awaits getWinPos), so the radial was laid out in the pre-resize viewport
  // and ended up misaligned once the window snapped to 320x340.
  Promise.resolve(petSizeController.request([320, 340]))
    .catch(() => {})
    .then(() => requestAnimationFrame(() => {
      if (!pendingRadialOpen || geometryBusy) return;
      pendingRadialOpen = false;
      if (!radialOpen && !todoPopOpen && !sessListOpen) showRadialNow();
    }));
}

function openRadial() {
  // R35.1: if a geometry transaction is in flight, record a SINGLE
  // pending intent and return. The settle callback in markGeometryBusy()
  // will open the radial exactly once when the resize completes. No
  // recursive timer, no queue.
  if (geometryBusy) {
    pendingRadialOpen = true;
    return;
  }
  requestRadialViewport();
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
// R56: transient-UI blur grace — set_ignore_mouse / window re-activation can
// bounce Focused(false)→(true) on X11/WebView2 right after a menu opens.
// A blur arriving <300ms after we opened a transient HUD is treated as
// focus jitter, not a real "user switched apps" signal (upstream main
// pet.js:4372 radialOpenSeq guard is the same idea). The timestamp is
// recorded by syncUiBusy on the not-busy→busy edge.
function dismissTransientUi(reason = 'blur') {
  const openedRecently = perfNow() - transientUiOpenedAt < 300;
  const anyOpen = radialOpen || todoPopOpen || sessListOpen || providerChooserOpen;
  if (openedRecently && anyOpen && (reason === 'dom-blur' || reason === 'native-blur')) {
    rlog('dismiss', 'grace:' + reason);
    return;
  }
  pendingRadialOpen = false;
  if (providerChooserOpen) closeProviderChooser();
  if (radialOpen) closeRadial();
  if (sessListOpen) closeSessList();
  if (todoPopOpen) closeTodoPop();
  rlog('dismiss', reason);
}
window.addEventListener('blur', () => dismissTransientUi('dom-blur'));
if (window.pet && typeof window.pet.onWindowBlur === 'function') {
  window.pet.onWindowBlur(() => {
    // R56: 双保险——原生层 Focused(false) 但文档层仍持有焦点时是焦点
    // 抖动而非真切换，不关菜单（X11 焦点守护/穿透恢复都可能触发）。
    if (typeof document.hasFocus === 'function' && document.hasFocus()) {
      rlog('dismiss', 'native-blur-ignored:doc-focused');
      return;
    }
    dismissTransientUi('native-blur');
  });
}

// R59: expression studio overrides — subscribe to the backend table and
// re-apply to the current state when it changes while the studio is open.
// R60 P0-1: the rerender hook now falls back to the BASE asset when the
// current state has no override (see pet-frame-table.js reapply()).
petExpressions.configure({
  api: window.pet,
  log: rlog,
  rerender: () => frames.reapply(),
});

// ---------- 初始化 ----------
// P1-2 (R60-2 audit): pet-agent-view.js sets sessionStorage
// 'octo-duo-replace-pending' right before location.replace() realigns the
// second pet's query. The replacement document checks the flag here and
// suppresses the ONE-TIME boot artifacts (entrance animation + online
// bubble + greet sound) that previously played twice per startup.
const duoReplacePending = (() => {
  try { return sessionStorage.getItem('octo-duo-replace-pending') === '1'; }
  catch { return false; }
})();
if (duoReplacePending) {
  try { sessionStorage.removeItem('octo-duo-replace-pending'); } catch {}
  stage.style.animation = 'none'; // suppress the second pet-appear playback
}
(async () => { // R1-A#5: try/catch so getConfig/getStats rejection doesn't leave pet blank
  try {
    const cfg = await window.pet.getConfig();
    if (cfg) applyConfigSnapshot(cfg); // R40.5: unified snapshot applies providers too
    const s = await window.pet.getStats();
    if (s) applyStats(s); else if (!lastStats) setState('idle'); // 有快照按真实态亮相
    // F11 (R60-3): a reloaded duo window must re-pull the travel snapshot —
    // the boot sequence never did, so the second pet lost its active trip's
    // status bar + cancel button until the next pet:travel event (up to 30
    // minutes on long trips).
    if (window.pet.getTravel) window.pet.getTravel().then(travelView.update).catch(() => {});
    if (!duoReplacePending) showBubble(t('bub.online'), 3000);
  } catch (err) {
    console.error('[octopus] pet boot failed:', err);
    rlog('init', 'boot failed: ' + String(err && (err.message || err) || 'unknown'));
    setState('idle'); showBubble(t('bub.bootFail'), 5000);
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
  if (drag.isDragging()) { setMouseIgnore(false); return; } // 拖动中保持可点
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
// R60: each module now owns its own timer disposal (P2-4: sayTimer and
// errorRibbonTimer were previously missing from this list — the modules
// make under-cleanup structurally impossible).
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
  // R56: pose-rotation timer ownership moved to pet-skin-packs.js; it stops
  // itself on non-meme updates, and pagehide ends the document anyway.
  if (visualBoundsObserver) visualBoundsObserver.disconnect();
  // R60 module disposals:
  sm.dispose();          // transient + act timers
  fx.dispose();          // blink / idle / error-ribbon timers (P2-4)
  bubbleApi.dispose();   // bubble timer
  router.dispose();      // say takeover timer (P2-4)
  drag.dispose();        // pending move frame + gesture
  clearTimeout(emptyWarnTimer); emptyWarnTimer = null;
});
