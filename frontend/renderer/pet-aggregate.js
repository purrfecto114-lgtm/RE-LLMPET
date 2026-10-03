'use strict';

// R60: pure aggregate ladder — (stats, now) ⇒ visual state, extracted from
// pet.js applyStats per the R60-1 blueprint (upstream 0.1.1:1220-1248 kept
// the ladder as a pure function so it could be unit-tested without a DOM).
// No DOM access; every dependency is an input. pet.js feeds it the state
// machine's transient window and the wander/error-dismissal facts.
//
// Ladder (STATES.md §3):
//   waiting > 短暂态 > error(8) > needsinput/notification(7) > sweeping(6)
//   > attention(5) > juggling(4) > working(3) > thinking(2) > idle(1) = roam(1) > sleeping(0)
// The aggregate part itself lives in pet-runtime-policy.js
// (aggregateState); this module only decides between waiting / transient /
// aggregate + the two overlays (roam while wandering, error-dismissal).
(function (root) {
  // inputs: {
  //   stats,             // per-pet filtered snapshot (may be null)
  //   now,               // perfNow() ms
  //   transientActive,   // stateMachine.isTransientActive()
  //   transientState,    // stateMachine.getTransientState()
  //   aggregate,         // (stats) => runtimePolicy.aggregateState(stats, {sleepMs})
  //   ownWanderTrip,     // trip object when THIS pet is wandering, else null
  //   errorDismissed,    // { dismissed: bool, at: ms, cooldownMs: number }
  // }
  function resolve(inputs) {
    const s = inputs && inputs.stats;
    if (!s) return 'idle';
    if ((s.waitingCount || 0) > 0) return 'waiting';
    if (inputs.transientActive) return inputs.transientState || 'idle';
    const next = inputs.aggregate ? inputs.aggregate(s) : 'idle';
    // R53: 闲逛进行中 → roam 表情（小跑 + 🐾 徽标）。优先级对齐 STATES.md：
    // roam 与 idle 同级(1)，只在聚合结果为 idle/sleeping 时接管；
    // waiting/needsinput/error/sweeping/attention/juggling/working/thinking
    // 仍然优先 —— 有会话等你处理时，闲逛表情让位。
    const ownTrip = inputs.ownWanderTrip;
    const wanderRoaming = !!(ownTrip && ownTrip.mode === 'wander'
      && (next === 'idle' || next === 'sleeping'));
    const dismissedError = next === 'error' && inputs.errorDismissed
      && inputs.errorDismissed.dismissed
      && (inputs.now - inputs.errorDismissed.at) < (inputs.errorDismissed.cooldownMs || 30000);
    if (dismissedError) return 'idle';
    return wanderRoaming ? 'roam' : next;
  }

  // Whether the error-dismissal latch should be reset (fresh error after a
  // dismissed one). Mirrors the two-line latch dance applyStats used to do.
  function errorLatchReset(inputs) {
    const s = inputs && inputs.stats;
    const next = inputs && inputs.aggregate ? inputs.aggregate(s) : 'idle';
    return next === 'error';
  }

  root.OctoPetAggregate = Object.freeze({ resolve, errorLatchReset });
})(typeof window !== 'undefined' ? window : globalThis);
