'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const pet = read('frontend/renderer/pet.js');
const html = read('frontend/renderer/pet.html');
const radial = read('frontend/renderer/pet-radial-menu.js');
const commands = read('src-tauri/src/commands.rs');

assert(html.indexOf('pet-radial-menu.js') < html.indexOf('pet.js'),
  'radial menu owner must load before pet.js');
assert(radial.includes('window.OctoPetRadialMenu'),
  'radial menu must have a focused global owner');
assert(radial.includes('stage.getBoundingClientRect()'),
  'radial placement must read the current stage rect');
assert(radial.indexOf('const sr') < radial.indexOf('sr.width'),
  'radial placement must declare sr before using its bounds');

const radialSandbox = { window: {} };
vm.runInNewContext(radial, radialSandbox);
const radialOwner = radialSandbox.window.OctoPetRadialMenu;
const radialEvents = [];
const rightPointer = {
  button: 2,
  preventDefault: () => radialEvents.push('prevent-pointer'),
  stopPropagation: () => radialEvents.push('stop-pointer'),
};
assert.strictEqual(radialOwner.claimRightPointer(rightPointer, {
  claimInput: () => radialEvents.push('claim'),
}), true, 'right pointer helper must claim the overlay input');
const rightMenu = {
  preventDefault: () => radialEvents.push('prevent-menu'),
  stopPropagation: () => radialEvents.push('stop-menu'),
};
assert.strictEqual(radialOwner.toggleRadialContext(rightMenu, {
  toggle: () => radialEvents.push('toggle'),
}), true, 'second overlay right-click must toggle the radial');
assert.deepStrictEqual(radialEvents,
  ['prevent-pointer', 'stop-pointer', 'claim', 'prevent-menu', 'stop-menu', 'toggle']);

const pointerStart = pet.indexOf("el.addEventListener('pointerdown'");
const pointerEnd = pet.indexOf("el.addEventListener('pointermove'", pointerStart);
const pointer = pet.slice(pointerStart, pointerEnd);
assert(pointer.includes('if (e.button === 2)'),
  'right pointerdown must explicitly claim the gesture');
assert(pointer.indexOf('setMouseIgnore(false)') < pointer.indexOf('if (e.button !== 0)'),
  'right pointerdown must claim input before left-drag filtering');

assert(commands.includes('struct PetAnchorGeometry'),
  'anchored resize must use a pure geometry input');
assert(commands.includes('fn place_pet_anchor('),
  'anchored resize must delegate placement to a pure geometry helper');
assert(commands.includes('anchor_shift_x'),
  'bounded resize must return an explicit visual-anchor shift');
assert(commands.includes('right_edge_layout_stays_in_work_area'),
  'Rust geometry helper needs a bounded right-edge layout test');
assert(commands.includes('negative_origin_scaled_layout_stays_in_work_area'),
  'Rust geometry helper needs negative-origin and scale coverage');
assert(commands.includes('ordinary_anchor_is_stable'),
  'Rust geometry helper needs ordinary placement coverage');
assert(commands.includes('right_edge_anchor_is_stable'),
  'Rust geometry helper needs right-edge placement coverage');
assert(commands.includes('bottom_edge_anchor_is_stable'),
  'Rust geometry helper needs bottom-edge placement coverage');
assert(commands.includes('corner_anchor_is_stable'),
  'Rust geometry helper needs corner placement coverage');

console.log('phase1-pet-interaction-regression: ok');
