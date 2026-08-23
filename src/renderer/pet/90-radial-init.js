const MENU = [
  { ic: 'chart',  labelKey: 'menu.panel', act: () => window.pet.openPanel() },
  { ic: 'mask',   labelKey: 'menu.skin', act: () => toggleSkin() },
  { ic: 'hand',   labelKey: 'menu.pending', badge: true, act: () => window.pet.openPanel() },
  { ic: 'zombie', labelKey: 'menu.background', badgeBg: true, act: () => window.pet.openPanel() },
  { ic: 'doc',    labelKey: 'menu.log', act: () => window.pet.openLog() },
  { ic: 'bell',   labelKey: 'menu.mute', act: () => window.pet.toggleMute() },
  { ic: 'power',  labelKey: 'menu.quit', act: () => window.pet.quit() },
];

function toggleSkin() {
  const order = ['mascot', 'pixel', 'cat', 'whale'];
  const next = order[(order.indexOf(skin) + 1) % order.length];
  applySkin(next);
  window.pet.setSkin(next);
}

function usableRadialMetrics(metrics) {
  if (!metrics || !metrics.window || !metrics.workArea) return null;
  const wr = metrics.window;
  const wa = metrics.workArea;
  if (![wr.x, wr.y, wr.width, wr.height, wa.x, wa.y, wa.width, wa.height].every(Number.isFinite)) return null;
  if (wr.width <= 0 || wr.height <= 0 || wa.width <= 0 || wa.height <= 0) return null;
  return metrics;
}

function radialFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function settledRadialMetrics() {
  if (!window.pet || typeof window.pet.getWindowMetrics !== 'function') return null;
  let metrics = null;
  try { metrics = usableRadialMetrics(await window.pet.getWindowMetrics()); } catch { return null; }
  // setPetSize/resetPetSize 在主进程同步落 bounds，但 renderer 的 resize 与
  // flex 重排会晚一拍。等到 DOM viewport 也追上主进程尺寸后再取 pet rect。
  for (let i = 0; metrics && i < 6; i++) {
    const wr = metrics.window;
    const settled = Math.abs((window.innerWidth || 0) - wr.width) <= 1
      && Math.abs((window.innerHeight || 0) - wr.height) <= 1;
    if (settled) break;
    await radialFrame();
    try { metrics = usableRadialMetrics(await window.pet.getWindowMetrics()) || metrics; } catch {}
  }
  await radialFrame();
  return metrics;
}

function buildRadial(metrics = lastRadialMetrics) {
  radial.innerHTML = '';
  const el = curSkinEl();
  const sr = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const cx = r.left - sr.left + r.width / 2;
  const cy = r.top - sr.top + r.height / 2;
  const items = MENU.filter((it) => !it.when || it.when()); // 平台不支持的项(如非 mac 的巡视)不渲染
  const n = items.length;
  const exact = usableRadialMetrics(metrics);
  if (exact) lastRadialMetrics = exact;
  const frame = exact && exact.window;
  const viewportW = Math.max(1, frame ? frame.width : (window.innerWidth || 320));
  const viewportH = Math.max(1, frame ? frame.height : (window.innerHeight || 340));
  const wa = exact ? exact.workArea : browserWorkArea();
  const winX = frame ? frame.x : (Number.isFinite(window.screenX) ? window.screenX : wa.x);
  const winY = frame ? frame.y : (Number.isFinite(window.screenY) ? window.screenY : wa.y);
  const pad = 5;
  // Intersect the BrowserWindow viewport with the actually visible work area.
  // This protects old saved positions that may still have part of the
  // transparent window off-screen before the first drag normalises them.
  const safeRect = {
    x: Math.max(pad, wa.x - winX + pad),
    y: Math.max(pad, wa.y - winY + pad),
    width: Math.max(46, Math.min(viewportW - pad, wa.x + wa.width - winX - pad) - Math.max(pad, wa.x - winX + pad)),
    height: Math.max(46, Math.min(viewportH - pad, wa.y + wa.height - winY - pad) - Math.max(pad, wa.y - winY + pad)),
  };
  const preferred = [];
  // A side-edge pet must fan into the desktop first. Trying the vertical fan
  // before the inward fan is what created the clipped half-heart in corners.
  if (edgeLayout.horizontal === 'left') preferred.push('right');
  else if (edgeLayout.horizontal === 'right') preferred.push('left');
  if (edgeLayout.vertical === 'below') preferred.push('below');
  else preferred.push('above');
  preferred.push(edgeLayout.vertical === 'below' ? 'above' : 'below');
  const layout = window.PetGeometry
    ? window.PetGeometry.radialLayout({ count: n, center: { x: cx, y: cy }, safeRect, preferred })
    : { direction: 'above', points: [] };
  rlog(
    'radial',
    `layout=${layout.direction} frame=${winX},${winY} ${viewportW}x${viewportH} ` +
      `safe=${safeRect.x},${safeRect.y} ${safeRect.width}x${safeRect.height}`,
  );
  items.forEach((it, i) => {
    const point = layout.points[i] || { x: cx, y: cy };
    const x = point.x;
    const y = point.y;
    const b = document.createElement('div');
    b.className = 'radial-item';
    b.style.left = x + 'px';
    b.style.top = y + 'px';
    b.style.transitionDelay = i * 0.03 + 's';
    // Key, not label: the old `it.label === '静音'` test silently picked the
    // wrong bell icon under any non-Chinese UI.
    const icName = it.labelKey === 'menu.mute' ? (muted ? 'bell-off' : 'bell') : it.ic;
    const icHtml = (window.OctoIcons && window.OctoIcons.icon(icName)) || '';
    b.innerHTML = `<span class="ri-ic oi">${icHtml}</span><span class="ri-lb">${esc(t(it.labelKey))}</span>`;
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

async function openRadial() {
  const seq = ++radialOpenSeq;
  if (todoPopOpen) closeTodoPop();
  if (sessListOpen) closeSessList();
  radialOpen = true;
  try { window.pet.uiBusy(true); } catch {}
  bubble.classList.add('hidden');
  // closeSessList/closeTodoPop 会异步把 BrowserWindow 从弹层尺寸缩回基础
  // 尺寸。必须等窗口和 DOM 都归位后再布局，否则菜单会按旧大窗坐标生成，
  // 随后的缩窗会把按钮直接裁出可见区域。
  let metrics = await settledRadialMetrics();
  if (seq !== radialOpenSeq || !radialOpen) return;
  settleEdgeLayout();
  metrics = await settledRadialMetrics() || metrics;
  if (seq !== radialOpenSeq || !radialOpen) return;
  buildRadial(metrics);
  radial.classList.remove('hidden');
}
function closeRadial() {
  radialOpenSeq++;
  radial.classList.add('hidden');
  radialOpen = false;
  try { window.pet.uiBusy(!!(todoPopOpen || sessListOpen || askActive || isInteracting())); } catch {}
}
function toggleRadial() {
  if (radialOpen) closeRadial();
  else openRadial().catch(() => closeRadial());
}
// 点遮罩空白处关闭
radial.addEventListener('click', () => closeRadial());
window.addEventListener('blur', () => { if (radialOpen) closeRadial(); });

// ---------- 初始化 ----------
(async () => {
  const cfg = await window.pet.getConfig();
  if (cfg) {
    muted = !!cfg.muted;
    window.OctoI18n.setLang(cfg.lang || 'zh');
    applySkin(cfg.skin || 'mascot');
  }
  // Convert positions saved by older builds (which anchored the transparent
  // window rather than the visible pet) as soon as the real skin is known.
  requestAnimationFrame(settleEdgeLayout);
  applyStaticI18n();
  const s = await window.pet.getStats();
  // 有快照就按真实聚合态亮相；之前无条件 setState('idle') 会把刚算出的
  // working/waiting 盖掉，启动瞬间总是先闪一下空闲。getStats 落空但推送
  // 已先到时（lastStats 已有值）同样不能清。
  if (s) applyStats(s);
  else if (!lastStats) setState('idle');
  showBubble(t('bub.online'), 3000);
  if (DEBUG_CONFETTI) setInterval(() => confetti(), 2500);
})();

// ---------- 透明区域点击穿透（命中测试）----------
// 桌宠窗口是透明矩形，空白处不该拦住后面的应用。光标在内容(小章鱼/卡片/菜单/记事本)
// 上 → 接收点击；在透明区 → 让窗口穿透。forward:true 使穿透时 mousemove 仍回传，
// 因此一旦光标回到内容上即可恢复可点。拖动中(g)始终保持可点。
const HIT_SEL = '#pixel,#mascot,#cat,#radial,#notepad,#todopop,#ask,#sesslist';
let mouseIgnoring = false;
function setMouseIgnore(on) {
  if (on === mouseIgnoring) return;
  mouseIgnoring = on;
  try { window.pet.setIgnoreMouse(on); } catch {}
}
window.addEventListener('mousemove', (e) => {
  // A stale gesture may currently own the whole transparent BrowserWindow, so
  // the hover can land outside the original pet element and never reach its
  // pointermove handler. Clean it up at window scope as well.
  if (g && Number.isFinite(e.buttons) && (e.buttons & 1) === 0) cancelActiveDrag();
  if (g) { setMouseIgnore(false); return; } // 拖动中保持可点
  const el = document.elementFromPoint(e.clientX, e.clientY);
  // 命中测试权威同步悬停态：穿透切换时 pointerleave 可能漏发，会把 askHover 卡在 true，
  // 进而让 isInteracting() 永远为真、refreshAsk 永不对账（旧卡片冻结、新卡片进不来）。
  askHover = !!(el && el.closest('#ask'));
  setMouseIgnore(!(el && el.closest(HIT_SEL)));
}, true);
// 启动即默认穿透（透明区不挡），光标移到内容上时由上面的命中测试恢复
setMouseIgnore(true);

// ---------- 交互状态上报(领地模式避战用) ----------
// 主进程无法区分「气泡 fitPopup 撑大的窗口」和「用户真的开着面板」,由渲染端
// 每 700ms 对账一次,变化才上报。覆盖:选项面板交互/右键菜单/记事本/会话列表。
let lastUiBusy = null;
setInterval(() => {
  const busy = !!(radialOpen || todoPopOpen || sessListOpen || askActive || isInteracting());
  if (busy === lastUiBusy) return;
  lastUiBusy = busy;
  try { window.pet.uiBusy(busy); } catch {}
}, 700);
// 气泡、皮肤切换和窗口自适应都可能改变本体在透明窗里的局部位置。
// 窗口尺寸变化(fitPopup/resetPetSize)在渲染端表现为 resize 事件,按事件上报;
// 常驻轮询只留一个低频兜底,不必每 500ms 强制一次 getBoundingClientRect 回流。
window.addEventListener('resize', () => requestAnimationFrame(() => {
  reportPetVisualBounds();
  alignToolProp();
}));
setInterval(reportPetVisualBounds, 3000);
