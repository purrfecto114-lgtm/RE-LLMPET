'use strict';

// R60: presentation effects — Web Audio beeps, confetti bursts, whale error
// ribbons, pixel-skin blink/idle micro-motions. Extracted from pet.js per
// the R60-1 blueprint (upstream 0.1.1 pet.js:898-950 kept sound & one-shot
// DOM performances in one "fx" section; this gives them a focused owner so
// the state machine and event router stay presentation-free).
(function (root) {
  function create(deps) {
    const d = deps || {};
    const stage = d.stage || null;
    const pixel = d.pixel || null;
    const muted = typeof d.muted === 'function' ? d.muted : () => false;
    const skinOf = typeof d.skin === 'function' ? d.skin : () => 'mascot';
    const stateOf = typeof d.state === 'function' ? d.state : () => 'idle';
    const currentSkinEl = typeof d.currentSkinEl === 'function' ? d.currentSkinEl : () => null;
    const busyUi = typeof d.uiBusy === 'function' ? d.uiBusy : () => false;

    // ---------- 声音提示（Web Audio 合成，无需音频文件） ----------
    let audioCtx = null;
    function beep(freqs, dur = 0.13, type = 'sine', gain = 0.06) {
      if (muted()) return;
      try {
        audioCtx = audioCtx || new (root.AudioContext || root.webkitAudioContext)();
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
      const el = currentSkinEl();
      if (!el || !stage) return;
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

    // ── R57 (upstream pet.js:3105-3143)：whale 错误丝带 ──────────────────────
    // whale 的 error GIF 没有包含红色彩带，因此在错误持续期间补一层独立的 CSS
    // 丝带。离开 whale/error 会立即清场，避免效果泄漏到 cat 或普通状态。
    const errorRibbonNodes = new Set();
    let errorRibbonTimer = null;
    function clearErrorRibbons() {
      clearTimeout(errorRibbonTimer);
      errorRibbonTimer = null;
      for (const node of errorRibbonNodes) node.remove();
      errorRibbonNodes.clear();
    }
    function errorRibbonBurst() {
      // 挂在皮肤容器里而不是 stage 上：透明窗切换 left/right 锚点时，彩带会跟着
      // 宠物一起移动，不会留在旧的窗口坐标（upstream 同款防御）。
      const el = currentSkinEl();
      if (!el) return;
      for (let i = 0; i < 14; i++) {
        const ribbon = document.createElement('span');
        ribbon.className = `confetti error-ribbon ${i % 3 === 1 ? 'ribbon-bright' : (i % 3 === 2 ? 'ribbon-deep' : '')}`;
        const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.25;
        const dist = 56 + Math.random() * 78;
        ribbon.style.left = '50%';
        ribbon.style.top = '38%';
        ribbon.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
        ribbon.style.setProperty('--dy', Math.sin(ang) * dist + 22 + 'px');
        ribbon.style.setProperty('--turn', (Math.random() > 0.5 ? 1 : -1) * (180 + Math.random() * 300) + 'deg');
        ribbon.style.animationDelay = Math.random() * 0.12 + 's';
        el.appendChild(ribbon);
        errorRibbonNodes.add(ribbon);
        setTimeout(() => {
          ribbon.remove();
          errorRibbonNodes.delete(ribbon);
        }, 1600);
      }
    }
    function syncErrorRibbons() {
      clearErrorRibbons();
      if (skinOf() !== 'whale' || stateOf() !== 'error') return;
      errorRibbonBurst();
      errorRibbonTimer = setTimeout(syncErrorRibbons, 1750);
    }

    // ---------- 像素皮肤微动作（眨眼 / 东张西望） ----------
    let blinkTimer = null;
    function scheduleBlink() {
      clearTimeout(blinkTimer); // 防御性：确保前一个链被断开
      blinkTimer = setTimeout(() => {
        // 仅像素怪兽保留 class 眨眼位（cat 是 GIF 自带动效；mascot 之前的
        // 「眨眼」是把整幅工作场景换成闭眼底图 150ms，观感是画面闪断，已移除）。
        if (skinOf() === 'pixel' && stateOf() !== 'sleeping' && stateOf() !== 'waiting') {
          pixel.classList.add('blink');
          setTimeout(() => pixel.classList.remove('blink'), 160);
        }
        scheduleBlink();
      }, 2500 + Math.random() * 4000);
    }
    let idleActionTimer = null;
    function scheduleIdleAction() {
      clearTimeout(idleActionTimer); // 防御性：确保前一个链被断开
      idleActionTimer = setTimeout(() => {
        if (stateOf() === 'idle' && !busyUi() && !muted()) {
          // 只有像素怪兽有 peek 动画；mascot 的 glance CSS 指向已不存在的
          // #teyes（img 皮肤没有 SVG 眼睛节点），cat 由 GIF 自带动效。
          if (skinOf() === 'pixel') {
            pixel.classList.add('peek');
            setTimeout(() => pixel.classList.remove('peek'), 620);
          }
        }
        scheduleIdleAction();
      }, 7000 + Math.random() * 7000);
    }

    function dispose() {
      clearTimeout(blinkTimer); blinkTimer = null;
      clearTimeout(idleActionTimer); idleActionTimer = null;
      clearErrorRibbons();
    }

    return Object.freeze({
      SOUND, beep, confetti, syncErrorRibbons, clearErrorRibbons,
      scheduleBlink, scheduleIdleAction, dispose,
    });
  }

  root.OctoPetFx = Object.freeze({ create });
})(typeof window !== 'undefined' ? window : globalThis);
