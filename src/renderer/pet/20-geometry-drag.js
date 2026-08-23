let askActive = false;
let askQueue = []; // 当前所有待处理的选择/输入（每项含 project）
let askIdx = 0;
let lastAskSig = ''; // 当前面板内容签名，避免每 2s 重渲冲掉用户输入
const answered = new Set(); // 已答的 key，避免快照延迟导致重弹
let askHover = false; // 鼠标在选项面板上
let elic = null;      // elicitation 渲染态：{ key, questions, qIdx, answers, selected }
let sessionSearch = '';
let sessionFilter = 'all';
let showArchived = false;
let pinnedSessionIds = [];
let archivedSessionIds = [];
// 面板开着、且(鼠标在面板上 / 输入框聚焦/有草稿 / 已选了选项) = 交互中：
// 此时别重渲面板、别改小章鱼状态，免得打断你思考/选择。面板一关就自动解除。
const isInteracting = () => askActive && (askHover || document.activeElement === askText || !!(askText && askText.value) || (elic && elic.selected != null));

// 把 UI 决策写日志，便于自检；双宠模式给 tag 带上身份前缀（claude:state / codex:state）
const rlog = (tag, msg) => { try { window.pet.petLog((AGENT === 'all' ? '' : AGENT + ':') + tag, msg); } catch {} };
// i18n: shared/i18n.js is loaded as a <script> before this file.
const t = (key, vars) => window.OctoI18n.t(key, vars);
// A reason arrives as a stable key ('reply'|'plan'|'perm'); older payloads may
// still carry free text, so fall back to whatever came in.
const waitPhrase = (reason) => (reason ? t('wait.' + reason) : t('wait.default'));
const reasonWord = (reason) => (reason ? t('reason.' + reason) : t('reason.default'));
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 带上 sessionId：否则同一项目下两个并行会话若问了同样的问题，会共用一个 key，
// 答掉一个就把另一个也标记成 answered 吞掉。choice 各构造处都带 sessionId。
const choiceKey = (c) => (c && (c.sessionId || '') + '|' + (c.requestId || c.permId || '') + '|' + (c.project || '') + '|' + (c.question || '')) || '';

// 动态定高：弹层贴 pet 上方(bottom:200)，把窗口高度调到刚好容纳内容，
// 避免固定大窗口留白 / 顶屏被下移。先扩到目标宽度再量高度：如果在基础
// 320px 窄窗里先测，长文本会被过度换行，错误地把弹层撑到整屏高。
const POPUP_W = 520;
const POPUP_BOTTOM = 200;
const ASK_VIEWPORT_MAX_H = 520;
// 普通会话页永远只占三条 Session 的固定高度；更多内容只在列表内部滚动。
// 掠夺按秒流入时也复用同一个值，BrowserWindow 从打开到结束不再改变尺寸。
// 右侧基线分支在 3 条会话时的实测内容高度为 310px，对应 520 × 534
// 的 BrowserWindow。固定使用这份三行高度；更多会话只在 sl-scroll 内滚动。
const SESSION_PANEL_H = 310;
// 接管页不能用当前 340px 小窗里的 CSS max-height 反推自身高度；否则顶部
// 打开时会陷入“窗口不长高 -> 页面只剩半截”的测量死循环。给它一份稳定
// 的完整面板高度，小屏幕由页面内部滚动兜底。
const TAKEOVER_PANEL_H = 320;
const BASE_PET_FRAME_H = 340;
const RESTING_FRAME_MAX_W = 360;
const RESTING_FRAME_MAX_H = 360;
let fitPopupSeq = 0;
let lastPetSizeRequestSig = '';
let edgeLayout = { vertical: 'above', horizontal: 'center' };

function browserWorkArea() {
  const s = window.screen || {};
  const width = Number.isFinite(s.availWidth) ? s.availWidth : (window.innerWidth || 320);
  const height = Number.isFinite(s.availHeight) ? s.availHeight : (window.innerHeight || 340);
  return {
    x: Number.isFinite(s.availLeft) ? s.availLeft : 0,
    y: Number.isFinite(s.availTop) ? s.availTop : 0,
    width,
    height,
  };
}

function petGeometrySnapshot() {
  const el = curSkinEl();
  if (!el || !Number.isFinite(window.screenX) || !Number.isFinite(window.screenY)) return null;
  const rect = el.getBoundingClientRect();
  const viewportW = Math.max(1, window.innerWidth || 320);
  const viewportH = Math.max(1, window.innerHeight || 340);
  return {
    workArea: browserWorkArea(),
    windowRect: { x: window.screenX, y: window.screenY, width: viewportW, height: viewportH },
    petRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
  };
}

function setStageEdgeLayout(next) {
  const layout = next || edgeLayout;
  edgeLayout = {
    vertical: layout.vertical === 'below' ? 'below' : 'above',
    horizontal: ['left', 'right'].includes(layout.horizontal) ? layout.horizontal : 'center',
  };
  stage.classList.toggle('edge-below', edgeLayout.vertical === 'below');
  stage.classList.toggle('edge-left', edgeLayout.horizontal === 'left');
  stage.classList.toggle('edge-right', edgeLayout.horizontal === 'right');
  if (propEl && propEl.classList.contains('on')) requestAnimationFrame(alignToolProp);
}

// Changing the flex anchor moves the pet inside the transparent BrowserWindow.
// This payload lets the main process move/resize that window in the opposite
// direction, so the visible pet stays on exactly the same screen pixel.
function anchoredLayoutPayload(next) {
  const before = petGeometrySnapshot();
  if (!before) { setStageEdgeLayout(next); return null; }
  const oldPet = before.petRect;
  const wa = before.workArea;
  const waRight = wa.x + wa.width;
  const waBottom = wa.y + wa.height;
  const wr = before.windowRect;
  const compactHorizontalFrame = wr.width <= RESTING_FRAME_MAX_W;
  const compactVerticalFrame = wr.height <= RESTING_FRAME_MAX_H;
  let screenX = wr.x + oldPet.x;
  let screenY = wr.y + oldPet.y;

  // A frame at the work-area edge plus a large transparent inset means the OS
  // stopped the BrowserWindow before the user's visible pet reached the edge.
  // Treat that as an explicit edge drag and snap the *pet body*, not the frame.
  if (compactVerticalFrame && next.vertical === 'below' && wr.y <= wa.y + 3 && oldPet.y > 18) screenY = wa.y;
  if (compactVerticalFrame && next.vertical === 'above'
    && wr.y + wr.height >= waBottom - 3 && wr.height - oldPet.y - oldPet.height > 18) {
    screenY = waBottom - oldPet.height;
  }
  if (compactHorizontalFrame && next.horizontal === 'left' && wr.x <= wa.x + 3 && oldPet.x > 18) screenX = wa.x;
  if (compactHorizontalFrame && next.horizontal === 'right'
    && wr.x + wr.width >= waRight - 3 && wr.width - oldPet.x - oldPet.width > 18) {
    screenX = waRight - oldPet.width;
  }
  setStageEdgeLayout(next);
  const rect = curSkinEl().getBoundingClientRect();
  const viewportW = Math.max(1, window.innerWidth || 320);
  const viewportH = Math.max(1, window.innerHeight || 340);
  const xAlign = edgeLayout.horizontal;
  const yAlign = edgeLayout.vertical === 'below' ? 'top' : 'bottom';
  const xOffset = xAlign === 'left'
    ? rect.left
    : xAlign === 'right'
      ? viewportW - rect.right
      : rect.left + rect.width / 2 - viewportW / 2;
  const yOffset = yAlign === 'top' ? rect.top : viewportH - rect.bottom;
  return {
    screenX, screenY,
    width: rect.width, height: rect.height,
    xAlign, yAlign, xOffset, yOffset,
  };
}

function restingEdgeLayout() {
  const snapshot = petGeometrySnapshot();
  if (!snapshot || !window.PetGeometry) return edgeLayout;
  // In an expanded popup the bottom-anchored pet's local y grows by exactly
  // the extra window height. Remove that artificial offset before deciding
  // whether the visible pet itself is actually in the top-edge zone.
  const frameHeightExcess = Math.max(0, snapshot.windowRect.height - BASE_PET_FRAME_H);
  let topThreshold = snapshot.petRect.y - frameHeightExcess + 2;
  if (edgeLayout.vertical === 'below') {
    // Measure the real normal-layout inset for the current skin/status stack.
    // A fixed number is wrong as soon as a chip/bubble changes height and can
    // make pointerup flip the pet back too early.
    const previous = { ...edgeLayout };
    setStageEdgeLayout({ ...previous, vertical: 'above' });
    topThreshold = curSkinEl().getBoundingClientRect().top - frameHeightExcess + 2;
    setStageEdgeLayout(previous);
  }
  return window.PetGeometry.chooseRestingLayout({
    ...snapshot,
    current: edgeLayout,
    threshold: Math.max(24, topThreshold),
    inferVerticalFrameClamp: snapshot.windowRect.height <= RESTING_FRAME_MAX_H,
    inferHorizontalFrameClamp: snapshot.windowRect.width <= RESTING_FRAME_MAX_W,
  });
}

function popupEdgeLayout(height, popupHeight) {
  const snapshot = petGeometrySnapshot();
  if (!snapshot || !window.PetGeometry) return edgeLayout;
  return window.PetGeometry.choosePopupLayout({
    ...snapshot,
    current: edgeLayout,
    popupHeight: Math.max(80, Number(popupHeight) || (Number(height) || 340) - POPUP_BOTTOM),
    inferVerticalFrameClamp: snapshot.windowRect.height <= RESTING_FRAME_MAX_H,
    inferHorizontalFrameClamp: snapshot.windowRect.width <= RESTING_FRAME_MAX_W,
  });
}

function popupFrameAlreadySettled(width, height, nextLayout) {
  if (!(width > 0) || !(height > 0) || !nextLayout) return false;
  const wa = browserWorkArea();
  const targetWidth = Math.min(width, wa.width);
  const targetHeight = Math.min(height, wa.height);
  const frame = {
    x: Number(window.screenX) || 0,
    y: Number(window.screenY) || 0,
    width: targetWidth,
    height: targetHeight,
  };
  const fullyVisible = window.PetGeometry && window.PetGeometry.windowFitsWorkArea
    ? window.PetGeometry.windowFitsWorkArea(frame, wa)
    : frame.x >= wa.x - 1 && frame.y >= wa.y - 1
      && frame.x + frame.width <= wa.x + wa.width + 1
      && frame.y + frame.height <= wa.y + wa.height + 1;
  return Math.abs((window.innerWidth || 0) - targetWidth) <= 1
    && Math.abs((window.innerHeight || 0) - targetHeight) <= 1
    && fullyVisible
    && nextLayout.vertical === edgeLayout.vertical
    && nextLayout.horizontal === edgeLayout.horizontal;
}

function setRequestedPetSize(w, h, options = {}) {
  let width = Number(w) || 0;
  let height = Number(h) || 0;
  const nextLayout = options.popup
    ? popupEdgeLayout(height, options.popupHeight)
    : restingEdgeLayout();
  // Stats arrive every few seconds. Once an open popup already owns the exact
  // viewport and edge direction, a changing DOM anchor is not a resize request.
  // Reapplying the same BrowserWindow bounds makes macOS briefly repaint only
  // half of the transparent window, which looks like the panel lost its top.
  if (options.popup && popupFrameAlreadySettled(width, height, nextLayout)) return false;
  const anchor = anchoredLayoutPayload(nextLayout);
  // Stats arrive continuously. Re-sending an identical BrowserWindow resize
  // makes the transparent window briefly repaint even when nothing visible
  // changed, which reads as a flash around every open panel.
  const requestSig = JSON.stringify({ width, height, anchor });
  // For popups the real BrowserWindow is authoritative. A drag/native clamp can
  // leave it at 520x340 even though our last *requested* signature says
  // 520x544. popupFrameAlreadySettled() already proved the live frame is wrong,
  // so never let this historical signature swallow the repair request.
  if (!options.popup && requestSig === lastPetSizeRequestSig) return false;
  try {
    window.pet.setPetSize(width, height, anchor);
    lastPetSizeRequestSig = requestSig;
    return true;
  } catch {
    return false;
  }
}
function fitPopup(el) {
  if (!el) return;
  const seq = ++fitPopupSeq;
  requestAnimationFrame(() => {
    const fixedSessionPage = el === sesslist
      && slSessionView && !slSessionView.classList.contains('hidden');
    const fixedTakeoverPage = el === sesslist
      && slTakeoverView && !slTakeoverView.classList.contains('hidden');
    if (fixedSessionPage || fixedTakeoverPage) {
      if (seq !== fitPopupSeq) return;
      // 固定页无需先扩宽再测量；一次完成宽高与上下翻转，避免中间帧错位。
      const panelHeight = fixedTakeoverPage ? TAKEOVER_PANEL_H : SESSION_PANEL_H;
      setRequestedPetSize(
        POPUP_W,
        Math.max(340, POPUP_BOTTOM + panelHeight + 24),
        { popup: true, popupHeight: panelHeight },
      );
      return;
    }
    const measure = () => {
      if (seq !== fitPopupSeq) return;
      const popupW = POPUP_W;
      // 关键：先临时去掉 max-height 再量，否则 scrollHeight 会被「当前小窗口算出的
      // max-height」钳住（鸡生蛋问题）→ 窗口永远只长一点点、列表只剩 1 行+滚动条。
      const prev = el.style.maxHeight;
      el.style.maxHeight = 'none';
      const contentH = el.scrollHeight;
      el.style.maxHeight = prev;
      const viewportH = el === askEl ? Math.min(contentH, ASK_VIEWPORT_MAX_H) : contentH;
      const winH = Math.max(340, POPUP_BOTTOM + viewportH + 24);
      setRequestedPetSize(popupW, winH, { popup: true, popupHeight: viewportH });
    };

    const targetW = POPUP_W;
    if (Math.abs((window.innerWidth || 0) - targetW) > 2) {
      // 第一拍只扩宽，第二拍在正确的横向排版下测真实高度。
      setRequestedPetSize(targetW, Math.max(340, window.innerHeight || 340), { popup: true });
      requestAnimationFrame(() => requestAnimationFrame(measure));
    } else {
      measure();
    }
  });
}
function resetPetSize() {
  // Delayed bubble/meme/choice callbacks can outlive the surface that created
  // them. They must never collapse a newer popup which now owns the window.
  // Legitimate close paths clear their open flag before calling this function.
  if (sessListOpen || askActive || todoPopOpen) return false;
  fitPopupSeq++;
  setRequestedPetSize(0, 0);
  return true;
}

function activeSizedSurface() {
  if (sessListOpen && !sesslist.classList.contains('hidden')) return sesslist;
  if (askActive && !askEl.classList.contains('hidden')) return askEl;
  if (todoPopOpen && !todopop.classList.contains('hidden')) return todopop;
  if (!bubble.classList.contains('hidden')) return bubble;
  return null;
}

function settleEdgeLayout() {
  // No screen coordinates in the headless renderer tests; the real Electron
  // window always has them. This also avoids inventing a desktop in Node.
  if (!petGeometrySnapshot()) return;
  const surface = activeSizedSurface();
  // Dragging used to collapse the BrowserWindow back to 320x340 even while the
  // session list / question card / speech bubble was still open. The DOM kept
  // rendering, but Electron clipped it to that smaller transparent frame.
  if (surface) fitPopup(surface);
  else setRequestedPetSize(0, 0);
  requestAnimationFrame(reportPetVisualBounds);
}

// Switch the internal top/bottom anchor *during* a drag, just before the
// transparent BrowserWindow reaches the work-area boundary. The visible pet
// is kept on the same screen pixel and the gesture is rebased, so the next
// pointer frame continues from there instead of producing edge -> pause ->
// jump. Returning from the top probes the normal layout first and restores it
// as soon as the whole frame can fit on-screen again.
function movePetDuringDrag(gesture, e, targetX, targetY) {
  const el = curSkinEl();
  if (!el) {
    window.pet.setWinPos(targetX, targetY);
    return;
  }
  const before = el.getBoundingClientRect();
  const petScreenX = targetX + before.left;
  const petScreenY = targetY + before.top;
  const wa = browserWorkArea();
  let nextVertical = edgeLayout.vertical;
  let nextHorizontal = edgeLayout.horizontal;

  if (edgeLayout.vertical === 'above') {
    nextVertical = window.PetGeometry
      ? window.PetGeometry.chooseDragVerticalLayout({
        current: 'above', workArea: wa, targetWindowY: targetY,
        petScreenY, abovePetOffset: before.top,
      })
      : (targetY <= wa.y + 2 ? 'below' : 'above');
  } else if (edgeLayout.vertical === 'below') {
    const candidate = { ...edgeLayout, vertical: 'above' };
    setStageEdgeLayout(candidate);
    const normalRect = el.getBoundingClientRect();
    const probed = window.PetGeometry
      ? window.PetGeometry.chooseDragVerticalLayout({
        current: 'below', workArea: wa, targetWindowY: targetY,
        petScreenY, abovePetOffset: normalRect.top,
      })
      : (petScreenY - normalRect.top >= wa.y + 2 ? 'above' : 'below');
    if (probed === 'above') {
      nextVertical = 'above';
    } else {
      setStageEdgeLayout({ ...edgeLayout, vertical: 'below' });
      nextVertical = 'below';
    }
  }

  if (window.PetGeometry && window.PetGeometry.chooseDragHorizontalLayout) {
    let centeredPetOffset = before.left;
    if (edgeLayout.horizontal !== 'center') {
      const previous = { ...edgeLayout };
      setStageEdgeLayout({ ...previous, horizontal: 'center' });
      centeredPetOffset = el.getBoundingClientRect().left;
      setStageEdgeLayout(previous);
    }
    nextHorizontal = window.PetGeometry.chooseDragHorizontalLayout({
      current: edgeLayout.horizontal,
      workArea: wa,
      targetWindowX: targetX,
      windowWidth: Math.max(1, window.innerWidth || 320),
      petScreenX,
      centeredPetOffset,
    });
  }

  if (nextVertical !== edgeLayout.vertical || nextHorizontal !== edgeLayout.horizontal) {
    setStageEdgeLayout({ vertical: nextVertical, horizontal: nextHorizontal });
  }
  const after = el.getBoundingClientRect();
  const anchoredX = petScreenX - after.left;
  const anchoredY = petScreenY - after.top;

  if (Math.abs(anchoredX - targetX) > 0.5 || Math.abs(anchoredY - targetY) > 0.5) {
    gesture.win = [anchoredX, anchoredY];
    gesture.sx = e.screenX;
    gesture.sy = e.screenY;
  }
  window.pet.setWinPos(anchoredX, anchoredY);
}

// 从快照重建队列（多任务都在、且标明项目）
function refreshAsk(stats) {
  // 记事本行动中心开着时，事项在那里处理，别再另弹选项面板抢窗口
  if (todoPopOpen) { hideAsk(); return; }
  const items = (stats.sessions || [])
    .filter((x) => (x.state === 'waiting' || x.state === 'needsinput') && x.choice)
    .map((x) => x.choice)
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

