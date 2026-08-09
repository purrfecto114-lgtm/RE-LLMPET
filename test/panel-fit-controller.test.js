'use strict';

const assert = require('assert');
const { createPanelFitController } = require('../frontend/shared/panel-fit-controller.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function tick() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  // A stale success cannot overwrite the latest committed request.
  {
    const first = deferred();
    const second = deferred();
    const controller = createPanelFitController({
      applyHeight(height) { return height === 400 ? first.promise : second.promise; },
    });
    const p1 = controller.request(400);
    const p2 = controller.request(500);
    second.resolve([700, 480]);
    await p2;
    first.resolve([700, 400]);
    assert.strictEqual((await p1).status, 'stale');
    assert.strictEqual(controller.state().lastCommittedRequest, 500);
    assert.strictEqual(controller.state().lastAppliedHeight, 480);
    controller.dispose();
  }

  // A stale failure cannot clear the active newer request.
  {
    const first = deferred();
    const second = deferred();
    const controller = createPanelFitController({
      applyHeight(height) { return height === 410 ? first.promise : second.promise; },
    });
    const p1 = controller.request(410);
    const p2 = controller.request(510);
    first.reject(new Error('stale failure'));
    await assert.rejects(p1, /stale failure/);
    assert.strictEqual(controller.state().activePhase, 'pending');
    second.resolve([700, 510]);
    await p2;
    assert.strictEqual(controller.state().lastCommittedRequest, 510);
    controller.dispose();
  }

  // Rust can clamp the requested height to the monitor work area. The actual
  // returned height, not the request, is used to consume the resize event.
  {
    const apply = deferred();
    let manualCount = 0;
    const controller = createPanelFitController({
      applyHeight: () => apply.promise,
      onManualResize: () => { manualCount += 1; },
    });
    const pending = controller.request(900);
    assert.strictEqual(controller.isManualResize(640), false);
    apply.resolve([700, 640]);
    await pending;
    assert.strictEqual(controller.state().activePhase, null);
    assert.strictEqual(manualCount, 0);
    controller.dispose();
  }

  // A resize racing the IPC response is not blindly assumed programmatic.
  // If it does not match the applied height by the settle deadline, the
  // deferred manual callback preserves the user's sizing intent.
  {
    const apply = deferred();
    const timers = [];
    const manualHeights = [];
    const controller = createPanelFitController({
      applyHeight: () => apply.promise,
      settleMs: 200,
      onManualResize: (height) => manualHeights.push(height),
      setTimer(fn, delay) {
        timers.push({ fn, delay, active: true });
        return timers.length;
      },
      clearTimer(id) {
        if (timers[id - 1]) timers[id - 1].active = false;
      },
    });
    const pending = controller.request(700);
    assert.strictEqual(controller.isManualResize(555), false);
    apply.resolve([700, 700]);
    await pending;
    assert.strictEqual(timers.length, 1);
    timers[0].fn();
    assert.deepStrictEqual(manualHeights, [555]);
    controller.dispose();
  }

  // Timer handles are opaque and may legally be zero in injected runtimes.
  // Reset/dispose must still cancel such a pending settle timer.
  {
    const cleared = [];
    const controller = createPanelFitController({
      applyHeight: () => Promise.resolve([700, 430]),
      setTimer() { return 0; },
      clearTimer(id) { cleared.push(id); },
    });
    await controller.request(430);
    controller.reset();
    assert.deepStrictEqual(cleared, [0]);
    controller.dispose();
  }

  // Cache commits only on success. Failed identical requests remain retryable,
  // while a successful identical request is deduplicated.
  {
    let attempts = 0;
    const timers = [];
    const controller = createPanelFitController({
      applyHeight() {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error('ipc failed')) : Promise.resolve([700, 420]);
      },
      setTimer(fn) {
        timers.push(fn);
        return timers.length;
      },
      clearTimer() {},
    });
    await assert.rejects(controller.request(420), /ipc failed/);
    await controller.request(420);
    timers[0]();
    const deduped = await controller.request(420);
    assert.strictEqual(attempts, 2);
    assert.strictEqual(deduped.status, 'deduped');
    controller.dispose();
  }

  await tick();
  console.log('panel-fit-controller: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
