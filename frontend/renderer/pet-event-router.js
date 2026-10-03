'use strict';

// R60: event router — the single dispatch table for `pet:event` payloads,
// extracted from pet.js's 222-line switch per the R60-1 blueprint (upstream
// v1.2.0 pet.js:3381-3411 guard clauses + handler map: each kind registers
// its own function; guards live in front of the table, not inside arms).
//
// R60 fixes baked in (from the R60-2/R60-3 audits):
//   * P1-1 travel terminal phases are SINGLE-CHANNEL: travel.rs emits both
//     `pet:travel` and `pet:event(kind:travel)` for completed/failed, and
//     both frontend arms ran transient()+bubble → double celebration,
//     flickering text, reset durations. Terminal phases now render ONLY
//     from the onTravel handler (pet.js); this table keeps `started` (and
//     `cancelled`, which pet:travel delivers without a competing arm).
//   * P2-1/P2-2 dead arms removed: `longcmd` (no backend producer) and
//     `cancel` (the W12 server-side cancel channel was never wired in the
//     Tauri backend; queue reconciliation happens via refreshAsk).
//   * P2-7 tray toasts no longer double-beep in duo mode: both pet windows
//     render the bubble, only the primary window plays the sound.
//   * territory `unsupported` phase consumed (R60-b backend now sends
//     localized text) and every arm is i18n-wired (R58-RV-8 P1 debt).
(function (root) {
  function create(deps) {
    const d = deps || {};
    const t = d.t || ((k) => k);
    const perfNow = d.perfNow || (() => Date.now());
    const sm = d.stateMachine; // OctoPetStateMachine instance
    const fx = d.fx;           // OctoPetFx instance (SOUND/confetti)
    const showBubble = d.showBubble || (() => {});
    const isInteracting = d.isInteracting || (() => false);
    const eventBelongs = d.eventBelongs || (() => true);
    const enqueueChoice = d.enqueueChoice || (() => {});
    const openProviderChooser = d.openProviderChooser || (() => {});
    const replayAggregate = d.replayAggregate || (() => {});
    const isPrimaryPet = d.isPrimaryPet !== false; // pet-codex passes false
    // RV-I P2-3 (R60 review): single-mode double-audio gate. The hidden
    // pet-codex webview processes every broadcast event (eventBelongs is
    // true for single mode) — its AudioContext still beeps. In single mode
    // ONLY the primary window may play; in duo mode both windows play their
    // own (event-filtered) events.
    const canPlaySound = typeof d.canPlaySound === 'function'
      ? d.canPlaySound
      : () => isPrimaryPet;
    const SOUND = {
      waiting: () => { if (canPlaySound()) fx.SOUND.waiting(); },
      done: () => { if (canPlaySound()) fx.SOUND.done(); },
      error: () => { if (canPlaySound()) fx.SOUND.error(); },
      greet: () => { if (canPlaySound()) fx.SOUND.greet(); },
      bigDone: () => { if (canPlaySound()) fx.SOUND.bigDone(); },
    };

    // say 接棒 happy 的排队令牌（新事件作废旧排队）；sayTimer 归
    // clearTransient 统一管（F3）——通过 stateMachine 的 onTransientCleared
    // 钩子清理（pet.js 装配时接线）。
    let sayToken = 0;
    let sayTimer = null;
    function clearSayTimer() { clearTimeout(sayTimer); sayTimer = null; }

    const isMeme = typeof d.isMeme === 'function' ? d.isMeme : () => false;

    function sayHandler(ev) {
      if (ev.text && ev.text.length > 2 && sm.getState() !== 'waiting') {
        const dur = Math.min(6000, Math.max(2200, ev.text.length * 80));
        // Stop 会同批派生 turn-done(happy) + say(talking)：让庆祝先演完，
        // talking 排在 happy 结束后接棒，气泡文本立刻显示不用等。
        if (sm.getTransientState() === 'happy' && sm.isTransientActive()) {
          showBubble(`💬 ${ev.text}`, Math.min(4200, dur));
          const token = ++sayToken;
          clearTimeout(sayTimer);
          sayTimer = setTimeout(() => {
            if (token === sayToken && sm.getState() !== 'waiting'
              && sm.getState() === sm.getTransientState()) {
              sm.transient(ev.emotion || 'talking', dur);
            }
          }, sm.transientRemainingMs());
        } else if (ev.emotion) {
          // Claude 的话里带情绪（sorry/puzzled/excited）→ 短暂表情替代 talking
          sm.transient(ev.emotion, 2800, `💬 ${ev.text}`, Math.min(4200, ev.text.length * 80));
        } else {
          sm.transient('talking', dur, `💬 ${ev.text}`, Math.min(4200, dur));
        }
      }
    }

    const TABLE = {
      operation(ev) {
        // 高优先级稳态（等授权/等回复/出错/清理）不被工具事件降级成 working——
        // 之前 error 期间其它会话干活会导致 working↔error 持续闪烁。
        const state = sm.getState();
        const hold = state === 'waiting' || state === 'needsinput' || state === 'error' || state === 'sweeping';
        // transient（thinking/happy/talking…）存续期间也不盖（STATES.md：短暂态高于聚合）
        if (!hold && !sm.isTransientActive()) {
          sm.setState('working');
          sm.playAction(ev.tool, ev.icon);
        }
        showBubble(`${ev.icon || '🔧'} ${ev.detail}`);
      },

      say: sayHandler,

      'user-turn'(ev) {
        // 你的输入里带情绪（loved/sad/excited）→ 章鱼即时反应；否则像以前一样进 thinking
        if (ev.emotion && sm.getState() !== 'waiting') {
          const tip = ev.emotion === 'loved' ? t('bub.loved')
            : ev.emotion === 'sad' ? t('bub.sad') : t('bub.ack');
          sm.transient(ev.emotion, 2800, tip, 2600);
        } else {
          // 多会话时聚合里 working > thinking，直接 setState 会在下个快照被盖掉
          // （只闪 ~150ms）。用 transient 保证「刚提交任务」的思考表情至少停留一会。
          if (sm.getState() !== 'waiting') sm.transient('thinking', 3500);
          showBubble(t('bub.newTask'), 2600);
        }
      },

      'turn-done'() {
        sm.transient('happy', 1800, t('bub.roundDone'), 3400);
        SOUND.done();
      },

      'big-done'(ev) {
        sm.transient('happy', 2200, t('bub.bigDone', { ops: ev.ops || '' }), 3800);
        fx.confetti();
        SOUND.bigDone();
      },

      error(ev) {
        sm.transient('error', 2600, ev.text || t('bub.error'), 3000);
        SOUND.error();
      },

      waiting(ev) {
        sm.clearTransient(); // 残留的 talking/thinking 短暂态不得盖过等授权
        sm.setState('waiting');
        SOUND.waiting();
        if (ev.choice && ((ev.choice.options && ev.choice.options.length) || ev.choice.allowInput)) {
          enqueueChoice(ev.choice); // 直接弹出选项/输入
        } else {
          showBubble(t('bub.waitYou', {
            project: ev.project || '',
            wait: ev.reason || t('bub.waitDefault'),
          }), 6000);
        }
      },

      needsinput(ev) {
        // Claude 在末尾问「要不要继续」之类，等你回复 → 黄点 + 可在桌宠上继续/回复
        if (sm.getState() !== 'waiting') { sm.clearTransient(); sm.setState('needsinput'); }
        SOUND.done();
        if (ev.choice && ((ev.choice.options && ev.choice.options.length) || ev.choice.allowInput)) {
          enqueueChoice(ev.choice);
        } else {
          showBubble(t('bub.needReply', { project: ev.project || '' }), 6000);
        }
      },

      greet(ev) {
        sm.transient('greet', 2000, t('bub.greet', { project: ev.project || '' }), 2600);
        SOUND.greet();
      },

      'choose-provider'() {
        // P5-4 fix (R3) + R60-b F3: the backend now emits to the calling
        // window only (emit_to), so no frontend filter is needed.
        openProviderChooser();
      },

      // P1-1: started ONLY. completed/failed arrive once through pet:travel
      // (pet.js onTravel). cancelled is likewise delivered on the pet:travel
      // channel — a router arm here double-rendered the cancel bubble, so
      // terminal phases are single-channel across the board (RV-A P3).
      travel(ev) {
        if (ev.phase === 'started') {
          sm.transient('excited', 2200, ev.text || t('bub.travelDepart'), 3200);
        }
      },

      territory(ev) {
        // 领地模式(main 的 territory 编排):发现别的桌宠 → 走过去顶到屏幕边上。
        // 全程复用现成情绪态,窗口走位由主进程完成,这里只负责表情/气泡/音效。
        // R60-b P2-8: payloads now carry `provider` (duo slicing happens in
        // eventBelongs before the table is consulted).
        switch (ev.phase) {
          case 'spotted':
            sm.transient('puzzled', 2400, t('terr.spotted', { rival: ev.rival || t('terr.unknownRival') }), 2600);
            SOUND.waiting();
            break;
          case 'march':
            // 推挤最长十几秒,给个长时限的斗志表情,victory/defeat 到了自然接管
            sm.transient('excited', 16000, t('terr.shove'), 3200);
            break;
          case 'victory':
            // R57 (upstream loot 的 lookout 姿态)：驱逐成功后望向被顶到墙边的
            // 「战果」——cat/whale 有专属 lookout GIF（thinking-2 素材）；
            // mascot/pixel 无 lookout 图与动画，回落 happy（RV-A1：默认皮肤
            // 的胜利庆祝不能退化成静态底图）。
            sm.transient(isMeme() ? 'lookout' : 'happy', 3600, t('terr.won'), 3400);
            fx.confetti();
            SOUND.bigDone();
            break;
          case 'defeat':
            sm.transient('sad', 3000, t('terr.stuck', { rival: ev.rival || t('terr.itPronoun') }), 3200);
            SOUND.error();
            break;
          case 'partial':
            sm.transient('excited', 3200, t('terr.edge', { rival: ev.rival || t('terr.itPronoun') }), 3600);
            SOUND.done();
            break;
          case 'ontop':
            // 猫爪在上定律:发现别的桌宠进程,窗口层级已被主进程抬到最上
            sm.transient('excited', 2600, t('terr.onTop', { rival: ev.rival || t('terr.intruder') }), 3000);
            SOUND.greet();
            break;
          case 'noperm':
            showBubble(t('terr.noPerm'), 7000);
            break;
          case 'unsupported':
            // R60: backend-resolved localized text (R60-b F9).
            showBubble(ev.text || t('say.territory-unsupported'), 5000);
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
            sm.clearTransient();
            replayAggregate();
            break;
        }
      },

      // R13/R22: 'state' kind events (OpenCode session.status, CodeWhale
      // mode_change…). Sticky high-priority states break through the
      // transient window immediately; the rest wait for it to lapse.
      state(ev) {
        if (ev.state && d.stateWords && d.stateWords.includes(ev.state)) {
          const state = sm.getState();
          const hold = state === 'waiting' || state === 'needsinput' || state === 'error';
          const stickyHi = ev.state === 'waiting' || ev.state === 'needsinput'
            || ev.state === 'error' || ev.state === 'attention';
          if (!hold && (stickyHi || !sm.isTransientActive())) {
            // F1: 穿透稳态须清短暂态窗口，防下个快照借 transientUntil 盖回 happy/talking
            sm.clearTransient();
            sm.setState(ev.state);
          }
        }
      },

      // R56: tray-origin feedback toasts (uninstall hooks, price refresh, …).
      // lib.rs emits {"kind":"toast","message":…} for tray actions that have
      // no window of their own; before this case existed those events were
      // dead letters. R60 P2-7: both pet windows show the bubble, only the
      // PRIMARY window plays the sound (duo double-beep fix — the hidden
      // pet-codex webview processes this event too).
      toast(ev) {
        if (ev.message) {
          showBubble(String(ev.message), 4500, true);
          if (canPlaySound()) SOUND.done();
        }
      },
    };

    function handle(ev) {
      if (!ev || typeof ev !== 'object') return; // R1-A#3: reject malformed payloads
      if (!eventBelongs(ev)) return;
      // 你正在答面板/打字时：新的待答任务只悄悄进队列(不抢面板)，其余动画/彩带/气泡/状态变化一律不打断
      if (isInteracting()) {
        if ((ev.kind === 'waiting' || ev.kind === 'needsinput') && ev.choice) enqueueChoice(ev.choice);
        return;
      }
      const handler = TABLE[ev.kind];
      if (handler) handler(ev);
    }

    return Object.freeze({ handle, clearSayTimer, dispose: clearSayTimer });
  }

  root.OctoPetEventRouter = Object.freeze({ create });
})(typeof window !== 'undefined' ? window : globalThis);
