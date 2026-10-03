'use strict';

// R60: bubble owner — showBubble / hideBubble / viewport fit, extracted
// from pet.js per the R60-1 blueprint (upstream keeps bubble primitives
// behind one small facade; z-order is delegated to CSS stacking).
//
// Guard contract (R50 semantics + R60 P2-6 extension): while ANY overlay is
// open the bubble stays suppressed (force=true still punches through for
// critical feedback). R50 only guarded ask/radial; the R60-2 audit flagged
// that sessListOpen/todoPopOpen were missing — the dark HUD panels (z30/32)
// fully covered the bubble (which has no z-index of its own), so mid-list
// status text appeared to "swallow" the bubble.
(function (root) {
  function create(deps) {
    const d = deps || {};
    const bubble = d.bubble || null;
    const bubbleText = d.bubbleText || null;
    const muted = typeof d.muted === 'function' ? d.muted : () => false;
    const anyOverlayOpen = typeof d.anyOverlayOpen === 'function' ? d.anyOverlayOpen : () => false;
    const fitPopup = typeof d.fitPopup === 'function' ? d.fitPopup : () => {};
    const resetPetSize = typeof d.resetPetSize === 'function' ? d.resetPetSize : () => {};

    let bubbleTimer = null;
    let bubbleOwnsResize = false;

    function fitBubbleToViewport() {
      if (!bubble) return;
      const top = Math.floor(bubble.getBoundingClientRect().top);
      const available = Math.max(0, top - 8);
      if (bubble.scrollHeight <= available) return;
      fitPopup(bubble);
      bubbleOwnsResize = true;
    }

    function showBubble(text, holdMs = 3200, force = false) {
      if (!bubble || !bubbleText) return;
      // RV-B P1 fix (R60): muted means no SOUND, not no TEXT — the old guard
      // swallowed every bubble (currency-switch confirmation, permission
      // receipt, greet, boot-failure) the moment the user muted the pet.
      // Sound muting lives in pet-fx.js beep(). Overlays still suppress.
      if (!force && anyOverlayOpen()) return; // 选项面板/列表/菜单开着时不弹气泡盖住它(force=重要提示强制显示)
      // emoji → 内联 SVG（OctoIcons 在 emoji 字符与 SVG 之间做安全替换；不可识别字符原样保留）
      if (root.OctoIcons && root.OctoIcons.hasMappedEmoji(text)) {
        root.OctoIcons.setTextWithIcons(bubbleText, text);
      } else {
        bubbleText.textContent = text;
      }
      bubble.classList.remove('hidden');
      bubbleText.scrollTop = 0; // 重置滚动到顶（上次长气泡可能滚到了下边）
      // R50: 免缩放优先 —— 气泡塞得进当前窗口就不动原生窗口；实在超屏时
      // 由 fitPopup 按屏幕封顶，#bubble 自身 overflow-y:auto 内滚动兜底。
      fitBubbleToViewport();
      clearTimeout(bubbleTimer);
      bubbleTimer = setTimeout(hideBubble, holdMs);
    }

    function hideBubble() {
      if (!bubble) return;
      bubble.classList.add('hidden');
      // R50: 只有本气泡真的撑大过窗口才缩回，短气泡不再引发 resize 抖动。
      // 若没有其它弹层占用大窗口尺寸，恢复原始尺寸（避免 pet 一直停在加大窗口里）
      // R56: radial/chooser 打开时也不能缩窗——radial item 的绝对坐标按当前
      // 大视口布置，中途缩窗会把菜单项裁掉/错位（叠加错位的一种）。
      if (bubbleOwnsResize && !anyOverlayOpen()) {
        bubbleOwnsResize = false;
        resetPetSize();
      }
    }

    function suppress() { if (bubble) bubble.classList.add('hidden'); }

    function dispose() {
      clearTimeout(bubbleTimer); bubbleTimer = null;
    }

    return Object.freeze({ showBubble, hideBubble, suppress, dispose });
  }

  root.OctoPetBubble = Object.freeze({ create });
})(typeof window !== 'undefined' ? window : globalThis);
