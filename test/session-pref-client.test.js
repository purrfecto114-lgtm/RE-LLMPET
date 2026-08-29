#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'shared', 'session-pref-client.js'),
  'utf8',
);
const window = {};
vm.runInNewContext(source, { window, Promise, Error });

(async () => {
  const atomicCalls = [];
  const atomicApi = {
    setSessionPref: (...args) => {
      atomicCalls.push(args);
      return Promise.resolve();
    },
  };
  await window.OctoSessionPrefs.save(
    atomicApi, 'session-a', 'pin', true, new Set(['session-a']), new Set(),
  );
  assert.strictEqual(JSON.stringify(atomicCalls), JSON.stringify([['session-a', true, null]]));

  const fallbackCalls = [];
  const fallbackApi = {
    setSessionPrefs: (...args) => {
      fallbackCalls.push(args);
      return Promise.resolve();
    },
  };
  await window.OctoSessionPrefs.save(
    fallbackApi,
    'session-b',
    'archive',
    true,
    new Set(['session-a']),
    new Set(['session-b']),
  );
  assert.strictEqual(JSON.stringify(fallbackCalls), JSON.stringify([[['session-a'], ['session-b']]]));

  await assert.rejects(
    () => window.OctoSessionPrefs.save(null, 'session-c', 'pin', true, [], []),
    /unavailable/,
  );
  console.log('session-pref-client: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
