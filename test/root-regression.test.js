'use strict';
const fs = require('fs');
const assert = require('assert');

const pet = fs.readFileSync('frontend/renderer/pet.js', 'utf8');
assert.match(pet, /if \(petAnchor\) attachDrag\(petAnchor\)/,
  'stable pet anchor must own drag and context-menu gestures');
assert.doesNotMatch(pet, /stateEls\.forEach\(attachDrag\)/,
  'skin-specific gesture ownership reintroduces interaction loss');

const platform = fs.readFileSync('src-tauri/src/platform.rs', 'utf8');
assert.match(platform, /GetCursorPos/,
  'Windows click-through recovery must use a global cursor API');
assert.match(platform, /Fail open/,
  'cursor-query failure must restore interaction rather than keep click-through');

const pricing = fs.readFileSync('src-tauri/src/pricing_sync.rs', 'utf8');
assert.match(pricing, /RE_LLMPET_MODELS_DEV_URL/,
  'pricing refresh must support an HTTPS enterprise mirror');
assert.match(pricing, /CURL_ATTEMPTS_PER_SOURCE: usize = 3/,
  'pricing refresh must retry transient network failures explicitly');
assert.match(pricing, /force_ipv4 = attempt == 1/,
  'pricing refresh must retry a broken dual-stack route over IPv4');
assert.match(pricing, /RE_LLMPET_MODELS_DEV_URL/,
  'pricing refresh must support a configured HTTPS mirror');
assert.doesNotMatch(pricing, /MODELS_DEV_MIRROR_URL/,
  'pricing refresh must not embed an unverified third-party mirror');
assert.doesNotMatch(pricing, /"--connect-timeout",\s*"5"/,
  'pricing refresh must not retain the five-second connect deadline');
console.log('root regression checks passed');
