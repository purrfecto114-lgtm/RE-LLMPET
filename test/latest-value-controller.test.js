'use strict';

const assert = require('assert');
const { createLatestValueController } = require('../frontend/shared/latest-value-controller.js');

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
  // Intermediate values collapse while preserving the native truth: if value 1
  // succeeds after value 3 was requested, the controller records 1 then applies 3.
  {
    const first = deferred();
    const calls = [];
    const controller = createLatestValueController({
      apply(value) {
        calls.push(value);
        return value === 1 ? first.promise : Promise.resolve();
      },
    });
    const p1 = controller.request(1);
    const p2 = controller.request(2);
    const p3 = controller.request(3);
    await tick();
    assert.deepStrictEqual(calls, [1]);
    first.resolve();
    await Promise.all([p1, p2, p3]);
    assert.deepStrictEqual(calls, [1, 3]);
    assert.strictEqual(controller.state().appliedValue, 3);
    controller.dispose();
  }

  // Bounded retry is explicit and testable; it does not spin forever.
  {
    const timers = [];
    let attempts = 0;
    const controller = createLatestValueController({
      apply() {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error('transient')) : Promise.resolve();
      },
      retryDelays: [10],
      setTimer(fn, delay) {
        timers.push({ fn, delay, active: true });
        return timers.length - 1;
      },
      clearTimer(id) {
        if (timers[id]) timers[id].active = false;
      },
    });
    const done = controller.request('busy');
    await tick();
    assert.strictEqual(attempts, 1);
    assert.strictEqual(timers.length, 1);
    assert.strictEqual(timers[0].delay, 10);
    timers[0].fn();
    await done;
    assert.strictEqual(attempts, 2);
    assert.strictEqual(controller.state().appliedValue, 'busy');
    controller.dispose();
  }

  // Exhaustion leaves applied state untouched, so an identical future request
  // starts a fresh transaction instead of being incorrectly deduplicated.
  {
    let attempts = 0;
    const controller = createLatestValueController({
      apply() {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error('offline')) : Promise.resolve();
      },
    });
    await controller.request(true);
    assert.strictEqual(controller.state().appliedSet, false);
    await controller.request(true);
    assert.strictEqual(attempts, 2);
    assert.strictEqual(controller.state().appliedValue, true);
    controller.dispose();
  }

  // A new desired value cancels a scheduled retry for stale work.
  {
    const timers = [];
    const calls = [];
    const controller = createLatestValueController({
      apply(value) {
        calls.push(value);
        return value === 'old' ? Promise.reject(new Error('old failed')) : Promise.resolve();
      },
      retryDelays: [100],
      setTimer(fn) {
        timers.push({ fn, active: true });
        return timers.length - 1;
      },
      clearTimer(id) {
        if (timers[id]) timers[id].active = false;
      },
    });
    void controller.request('old');
    await tick();
    await controller.request('new');
    assert.deepStrictEqual(calls, ['old', 'new']);
    assert.strictEqual(timers[0].active, false);
    controller.dispose();
  }

  console.log('latest-value-controller: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
