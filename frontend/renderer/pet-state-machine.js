'use strict';

// R60: pet state machine — setState / transient / clearTransient / tool
// actions, extracted from pet.js per the R60-1 blueprint. Mirrors upstream
// v1.2.0 pet.js:2945-3044 (STATE_WORDS full-set class removal so no state
// class ever lingers on a skin element) + 0.1.1:880-894 (transient expiry
// actively recomputes the aggregate from the last snapshot instead of
// waiting for the next push — worst case ~4s of tail).
//
// Priority contract (STATES.md §3): waiting > transient > aggregate ladder.
// `transient()` refuses to fire while `waiting` is active; every other
// state may be transiently covered (including needsinput — the §3 table
// ranks the transient layer above the whole aggregate ladder).
(function (root) {
  function create(deps) {
    const d = deps || {};
    const stateEls = d.stateEls || [];
    const thinkEl = d.thinkEl || null;
    const sleepEl = d.sleepEl || null;
    const stateWords = d.stateWords || [];
    const log = typeof d.log === 'function' ? d.log : () => {};
    const perfNow = typeof d.perfNow === 'function' ? d.perfNow : () => Date.now();
    // Collaborator hooks (injected by pet.js):
    const onFrameUpdate = typeof d.onFrameUpdate === 'function' ? d.onFrameUpdate : () => {};
    const onErrorRibbons = typeof d.onErrorRibbons === 'function' ? d.onErrorRibbons : () => {};
    const reportBounds = typeof d.reportBounds === 'function' ? d.reportBounds : () => {};
    const replayAggregate = typeof d.replayAggregate === 'function' ? d.replayAggregate : () => {};
    const onTransientCleared = typeof d.onTransientCleared === 'function' ? d.onTransientCleared : () => {};

    // Tool → action class mapping; the provider-specific variants live in
    // pet-runtime-policy.js (toolAction(tool, provider)).
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

    let state = 'idle';
    let transientState = null;
    let transientUntil = 0;   // 短暂状态（happy/error）持续到的时间
    let transientTimer = null;
    let actTimer = null;

    function getState() { return state; }
    function isTransientActive() { return perfNow() < transientUntil; }
    function getTransientState() { return transientState; }
    // Remaining transient window in ms (0 once lapsed) — the say arm of the
    // event router queues its talking takeover for exactly this long.
    function transientRemainingMs() { return Math.max(0, transientUntil - perfNow()); }

    function setState(s) {
      if (state === s) return;
      for (const el of stateEls) {
        el.classList.remove(...stateWords);
        el.classList.add(s);
      }
      state = s;
      if (d.onStateApplied) d.onStateApplied(s); // composition-root mirror (legacy reads)
      log('state', s);
      if (thinkEl) thinkEl.classList.toggle('on', s === 'thinking');
      if (sleepEl) sleepEl.classList.toggle('on', s === 'sleeping');
      if (s === 'thinking' || s === 'sleeping') d.hideBubble && d.hideBubble();
      if (s === 'working') {
        // 进入干活态 → 立刻挂上「持续忙碌」基线动作，不等具体 tool 事件，
        // 任何时刻都显得在忙（具体 tool 动作会在它之上叠加，结束后回落到这里）。
        for (const el of stateEls) el.classList.add('act-work');
      } else {
        clearAction(); // 离开干活态才清掉动作
      }
      // 注意：不要在这里 hideAsk()！面板显隐只由 refreshAsk(按是否有待答事项) 管。
      // 之前「s!=='waiting' 就 hideAsk」会在聚合态变 working/thinking 时把 needsinput 的面板闪掉。
      onFrameUpdate(s);
      // R59: overrides whose data: URL is already on the img (or whose pack
      // asset matches the current src) need an explicit re-apply — the swap
      // helper's src guard would no-op and the pet would keep showing the
      // last state's override after the state changed.
      // R57 (upstream pet.js:2974 syncErrorRibbons)：whale 的 error GIF 没有
      // 红色彩带，持续 error 期间补一层独立 CSS 丝带；离开 whale/error 立即清场。
      onErrorRibbons();
      requestAnimationFrame(reportBounds);
    }

    // 按工具播放专属动作 + 头顶道具。道具/分身的 DOM 演出由 pet.js 通过
    // showProp/showSidekick 注入（它们持有 #prop/#sidekick 节点与 meme 皮肤判断）。
    function playAction(toolName, icon) {
      if (state === 'waiting' || state === 'sleeping') return;
      const act = d.toolAction ? d.toolAction(toolName) : (TOOL_ACT[toolName] || 'work');
      for (const el of stateEls) {
        el.classList.remove(...ACT_CLASSES);
        el.classList.add('act-' + act); // 通用 work 也有身体动作（不再只闪图标）
      }
      if (d.showProp) d.showProp(act, icon);
      if (act === 'summon' && d.showSidekick) d.showSidekick();
      clearTimeout(actTimer);
      actTimer = setTimeout(clearAction, 2200);
    }
    function clearAction() {
      for (const el of stateEls) el.classList.remove(...ACT_CLASSES);
      if (d.clearProp) d.clearProp();
      // 具体 tool 动作结束后，仍在干活 → 回落到「持续忙碌」基线，别安静下来
      if (state === 'working') for (const el of stateEls) el.classList.add('act-work');
    }

    // 短暂状态：happy/error/greet…，到点后由 applyStats 接管。
    // 到期不再干等下一个快照（周期推送最坏 ~4s，短暂态会拖尾）——
    // 定时用最近一次快照主动重算聚合态，到点即回落（R56: 重放加 force 绕过 R40.1 修订号守卫）。
    function transient(s, ms, text, holdMs) {
      if (state === 'waiting') return; // 等用户优先（STATES.md §3：waiting > 短暂态）
      transientState = s;
      transientUntil = perfNow() + ms;
      setState(s);
      clearTimeout(transientTimer);
      transientTimer = setTimeout(() => { if (state === transientState) replayAggregate(); }, ms + 30); // 仅当短暂态仍生效才回落：中途被 waiting/error 等稳态接管时不踢场
      if (text && d.showBubble) d.showBubble(text, holdMs || ms);
    }
    // 高优先级稳态（waiting/needsinput/error/state 穿透）接管时清掉残留短暂态，
    // 否则会借 transientUntil 复活盖回来。
    function clearTransient() {
      transientUntil = 0;
      transientState = null;
      clearTimeout(transientTimer);
      onTransientCleared(); // F3: say 接棒定时器等关联计时器归此管
    }

    function dispose() {
      clearTimeout(transientTimer); transientTimer = null;
      clearTimeout(actTimer); actTimer = null;
    }

    return Object.freeze({
      getState, isTransientActive, getTransientState, transientRemainingMs,
      setState, transient, clearTransient,
      playAction, clearAction, dispose,
      // test surface
      _toolAct: TOOL_ACT,
    });
  }

  root.OctoPetStateMachine = Object.freeze({ create });
})(typeof window !== 'undefined' ? window : globalThis);
