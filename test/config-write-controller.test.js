'use strict';

const assert = require('assert');
const latestValueApi = require('../frontend/shared/latest-value-controller.js');
const { createConfigWriteController } = require('../frontend/shared/config-write-controller.js');

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
  // A slow first write cannot overwrite the newest desired value: the second
  // value is serialized and applied after the first finishes.
  {
    const first = deferred();
    const calls = [];
    const snapshots = [];
    const controller = createConfigWriteController({
      latestValueApi,
      reload: async () => ({ skin: 'server' }),
      applySnapshot: (snapshot) => snapshots.push(snapshot),
    });
    const persist = (value) => {
      calls.push(value);
      return value === 'mascot' ? first.promise : Promise.resolve();
    };
    const p1 = controller.request('skin', 'mascot', persist);
    const p2 = controller.request('skin', 'cat', persist);
    await tick();
    assert.deepStrictEqual(calls, ['mascot']);
    first.resolve();
    await Promise.all([p1, p2]);
    assert.deepStrictEqual(calls, ['mascot', 'cat']);
    assert.deepStrictEqual(snapshots, []);
    controller.dispose();
  }

  // A current failure reloads authoritative config and reports the command.
  {
    const errors = [];
    const snapshots = [];
    const controller = createConfigWriteController({
      latestValueApi,
      reload: async () => ({ mode: 'pet' }),
      applySnapshot: (snapshot) => snapshots.push(snapshot),
      reportError: (key, error) => errors.push([key, error.message]),
    });
    await controller.request('mode', 'hidePet', async () => { throw new Error('disk full'); });
    await tick();
    assert.deepStrictEqual(errors, [['mode', 'disk full']]);
    assert.deepStrictEqual(snapshots, [{ mode: 'pet' }]);
    controller.dispose();
  }

  // A stale reload is skipped after a newer successful value. The pending
  // reconciliation runs again and applies a fresh authoritative snapshot.
  {
    const firstReload = deferred();
    const snapshots = [];
    let reloads = 0;
    const controller = createConfigWriteController({
      latestValueApi,
      reload: () => {
        reloads += 1;
        return reloads === 1 ? firstReload.promise : Promise.resolve({ currency: 'USD' });
      },
      applySnapshot: (snapshot) => snapshots.push(snapshot),
    });
    await controller.request('currency', 'CNY', async () => { throw new Error('offline'); });
    await tick();
    assert.strictEqual(reloads, 1, 'the stale reload must already be in flight');
    await controller.request('currency', 'USD', async () => {});
    firstReload.resolve({ currency: 'CNY' });
    await tick();
    assert.strictEqual(reloads, 2);
    assert.deepStrictEqual(snapshots, [{ currency: 'USD' }]);
    controller.dispose();
  }

  // Reconciliation waits for writes to every key. A failed mode write cannot
  // apply a full stale snapshot while a currency write is still in flight.
  {
    const currencyWrite = deferred();
    const snapshots = [];
    let reloads = 0;
    const controller = createConfigWriteController({
      latestValueApi,
      reload: async () => {
        reloads += 1;
        return { mode: 'pet', currency: 'CNY' };
      },
      applySnapshot: (snapshot) => snapshots.push(snapshot),
    });
    const currency = controller.request('currency', 'CNY', () => currencyWrite.promise);
    await controller.request('mode', 'hidePet', async () => { throw new Error('disk full'); });
    await tick();
    assert.strictEqual(reloads, 0, 'reload must wait for unrelated in-flight writes');
    currencyWrite.resolve();
    await currency;
    await tick();
    assert.strictEqual(reloads, 1);
    assert.deepStrictEqual(snapshots, [{ mode: 'pet', currency: 'CNY' }]);
    controller.dispose();
  }

  // A request arriving during reload invalidates that snapshot. Reconciliation
  // reruns after the newer write settles instead of silently leaving failed
  // optimistic UI in place.
  {
    const firstReload = deferred();
    const newerWrite = deferred();
    const snapshots = [];
    let reloads = 0;
    const controller = createConfigWriteController({
      latestValueApi,
      reload: () => {
        reloads += 1;
        return reloads === 1 ? firstReload.promise : Promise.resolve({ mode: 'pet', currency: 'USD' });
      },
      applySnapshot: (snapshot) => snapshots.push(snapshot),
    });
    await controller.request('mode', 'hidePet', async () => { throw new Error('offline'); });
    await tick();
    const newer = controller.request('currency', 'USD', () => newerWrite.promise);
    firstReload.resolve({ mode: 'pet', currency: 'CNY' });
    await tick();
    assert.deepStrictEqual(snapshots, [], 'stale full snapshot must not cross key boundaries');
    newerWrite.resolve();
    await newer;
    await tick();
    assert.strictEqual(reloads, 2);
    assert.deepStrictEqual(snapshots, [{ mode: 'pet', currency: 'USD' }]);
    controller.dispose();
  }

  // Reconciliation callback errors are reported instead of becoming unhandled
  // promise rejections in the renderer.
  {
    const errors = [];
    const controller = createConfigWriteController({
      latestValueApi,
      reload: async () => ({ skin: 'mascot' }),
      applySnapshot: () => { throw new Error('render failed'); },
      reportError: (key, error) => errors.push([key, error.message]),
    });
    await controller.request('skin', 'cat', async () => { throw new Error('write failed'); });
    await tick();
    assert.deepStrictEqual(errors, [
      ['skin', 'write failed'],
      ['config:apply', 'render failed'],
    ]);
    controller.dispose();
  }

  console.log('config-write-controller: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
