'use strict';

// R60: frame table + swap chain — the single owner of "which image does the
// pet show for state X". Extracted from pet.js per the R60-1 rewrite
// blueprint (upstream v1.2.0 pet.js:61-108 CAT_STATES/WHALE_STATES split
// into a declarative table + renderer; this module keeps the mascot table
// and the override-aware swap chain that pet-skin-packs.js (meme skins) and
// pet-expressions.js (custom overrides) plug into).
//
// Swap chain (last writer wins, exactly one <img> target per skin):
//   setState(s) → update(s) → [override layer pet-expressions]
//                             → [meme pack pet-skin-packs]  (via deps)
//                             → [mascot table MASCOT_EYES]  (this module)
//
// P0-1 fix (R60-2 audit): reapply() now FALLS BACK to the base asset when
// the current state has NO override. Previously clear/disable events left
// the pet stuck on the deleted override's image indefinitely (idle/sleeping
// never rotates), while the studio toast claimed "restored to default".
(function (root) {
  // Mascot (icon-style octopus) state → image table. States without a
  // dedicated pose fall back to a nearby pose (documented per row).
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
    // R53: 闲逛中 —— 基础形象 + waddle 动画 + 🐾 徽标（STATES.md 的 roam 态
    // 终于有了生产者：闲逛进行中不再回落到闭眼睡觉）。
    roam: 'mascot.png',
    // 情绪短暂态 → 就近回落（专属图未画）
    loved: 'mascot-happy.png',
    excited: 'mascot-happy.png',
    sad: 'mascot-wait.png',
    sorry: 'mascot-wait.png',
    puzzled: 'mascot-think.png',
  };

  // B3: smooth fade when swapping mascot/cat images on state change.
  // Keep the current decoded frame visible — hiding first made every stats
  // transition flash, and failed GIF loads could leave the pet transparent.
  function fadeSwapImg(img, newSrc) {
    if (!img || img.getAttribute('src') === newSrc) return;
    const preload = new Image();
    preload.onload = () => {
      const decoded = typeof preload.decode === 'function' ? preload.decode().catch(() => {}) : Promise.resolve();
      decoded.then(() => { img.src = newSrc; img.style.opacity = '1'; });
    };
    preload.onerror = () => { img.style.opacity = '1'; };
    preload.src = newSrc;
  }

  function create(deps) {
    const d = deps || {};
    // DOM + collaborators injected by pet.js (single wiring point).
    const mascotImg = d.mascotImg || null;
    const catImg = d.catImg || null;
    const skinPacks = d.skinPacks || null;         // OctoPetSkinPacks
    const petExpressions = d.petExpressions || null; // OctoPetExpressions
    const skinOf = typeof d.skin === 'function' ? d.skin : () => 'mascot';
    const stateOf = typeof d.state === 'function' ? d.state : () => 'idle';
    const isMeme = () => skinPacks && skinPacks.isMeme(skinOf());

    // R59 contract, preserved: expressionAwareSwap intercepts EVERY asset
    // swap — the initial state update AND the skin packs' 60s pose-rotation
    // timer — so an override for a pooled state (working×4, thinking×2 …)
    // is not reverted by rotation a minute later. Cached overrides swap
    // immediately; uncached ones show the pack asset for one frame and swap
    // in when the data: URL arrives (guarded against a state change
    // mid-fetch). The pixel skin renders CSS/SVG with no <img> target —
    // overrides skip it.
    function expressionAwareSwap(img, src) {
      if (!img) return;
      const swapState = stateOf();
      if (petExpressions && petExpressions.hasOverride(swapState)) {
        const cached = petExpressions.peek(swapState);
        if (cached) return fadeSwapImg(img, cached);
        petExpressions.resolve(swapState).then((url) => {
          if (url && stateOf() === swapState) fadeSwapImg(img, url);
        }).catch(() => {});
      }
      return fadeSwapImg(img, src);
    }

    function updateMascot(s) {
      if (!mascotImg) return;
      const f = MASCOT_EYES[s] || 'mascot.png';
      // Route through expressionAwareSwap so overrides apply to the mascot
      // skin as well (R59).
      if (!mascotImg.getAttribute('src').endsWith(f)) {
        expressionAwareSwap(mascotImg, '../assets/' + f);
      }
    }

    function updateCat(s) {
      if (skinPacks) skinPacks.update(skinOf(), s);
    }

    // P0-1 (R60-2): the expressions:changed rerender hook. Falls through to
    // the BASE asset when the current state has no override — clear/disable
    // must visibly restore the default expression, not freeze the deleted
    // one. The pixel skin is skipped (CSS/SVG target, no <img>).
    function reapply() {
      const skin = skinOf();
      if (!petExpressions || skin === 'pixel') return;
      const s = stateOf();
      if (petExpressions.hasOverride(s)) {
        const img = skin === 'mascot' ? mascotImg : catImg;
        if (img) expressionAwareSwap(img, img.getAttribute('src') || '');
      } else {
        // No override for the current state: replay the base asset so the
        // pet leaves the deleted/disabled override behind immediately.
        if (skin === 'mascot') updateMascot(s);
        else if (isMeme()) updateCat(s);
      }
    }

    function applyForSkin() {
      // Called from applySkin(): re-resolve the current state's asset under
      // the new skin.
      const s = stateOf();
      if (skinOf() === 'mascot') updateMascot(s);
      updateCat(s);
    }

    return Object.freeze({
      updateMascot,
      updateCat,
      reapply,
      applyForSkin,
      swap: expressionAwareSwap,
      // test surface
      _table: MASCOT_EYES,
      _fadeSwap: fadeSwapImg,
    });
  }

  root.OctoPetFrameTable = Object.freeze({ create, MASCOT_EYES, fadeSwapImg });
})(typeof window !== 'undefined' ? window : globalThis);
