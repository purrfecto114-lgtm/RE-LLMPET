'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const css = read('frontend/renderer/pet.css');
const html = read('frontend/renderer/pet.html');

/* ── Helper: minimal JSDOM-like environment to evaluate CSS layout ── */
const { JSDOM } = require('jsdom');

/* The layout classes must exist in CSS as selectors */
const layoutClasses = [
  'pet-layout-center',
  'pet-layout-bottom',
  'pet-layout-left',
  'pet-layout-right',
  'pet-layout-top'
];

for (const cls of layoutClasses) {
  const selector = '.' + cls + ' .sesslist';
  assert(css.indexOf(selector) >= 0,
    `CSS must define layout rule for ${cls}: ${selector}`);
}

/* ── Verify actual computed styles with JSDOM ── */
const dom = new JSDOM(html, {
  resources: 'usable',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'file://' + path.join(root, 'frontend/renderer/pet.html')
});

const document = dom.window.document;

/* Inject the CSS into the JSDOM */
const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);

/* Helper to get computed style of .sesslist under a layout class */
function getSesslistStyle(layoutClass) {
  const stage = document.getElementById('stage');
  stage.className = 'pet-layout-' + layoutClass;
  const sesslist = document.querySelector('.sesslist');
  if (!sesslist) return null;
  const cs = dom.window.getComputedStyle(sesslist);
  return {
    top: cs.top,
    bottom: cs.bottom,
    left: cs.left,
    right: cs.right,
    maxHeight: cs.maxHeight
  };
}

/* Test each layout class produces the expected inward-expansion direction */
const tests = [
  {
    class: 'center',
    expect: { bottom: '200px', top: 'auto', left: '12px', right: '12px' }
  },
  {
    class: 'bottom',
    expect: { bottom: '200px', top: 'auto', left: '12px', right: '12px' }
  },
  {
    class: 'left',
    expect: { bottom: 'auto', top: '14px', left: '180px', right: '12px' }
  },
  {
    class: 'right',
    expect: { bottom: 'auto', top: '14px', left: '12px', right: '180px' }
  },
  {
    class: 'top',
    expect: { bottom: 'auto', top: '180px', left: '12px', right: '12px' }
  }
];

for (const t of tests) {
  const style = getSesslistStyle(t.class);
  assert(style !== null, `layout class ${t.class} must produce a .sesslist element`);
  for (const [prop, expected] of Object.entries(t.expect)) {
    assert.strictEqual(style[prop], expected,
      `pet-layout-${t.class} .sesslist ${prop} must be ${expected}, got ${style[prop]}`);
  }
}

console.log('phase1-pet-layout-regression: ok');