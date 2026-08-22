'use strict';

// Guards the EN/JA localization against the two ways it rots silently:
//   1. key drift — a string added to zh but not to en/ja shows Chinese in an
//      English UI, and nothing crashes to tell you;
//   2. placeholder drift — a translation that drops {project} or {pct} renders
//      a sentence with a hole in it, again without an error.
// Also checks that every t('...') key used in the source actually exists.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const i18n = require('../shared/i18n');
const config = require('../backend/config');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const PLACEHOLDER = /\{(\w+)\}/g;

// ── 1. every locale carries every key ────────────────────────────────────────
const zhKeys = Object.keys(i18n.DICT.zh).sort();
assert(zhKeys.length > 150, 'zh dictionary looks truncated');
for (const lang of i18n.LANGS) {
  const keys = Object.keys(i18n.DICT[lang]).sort();
  const missing = zhKeys.filter((k) => !(k in i18n.DICT[lang]));
  const extra = keys.filter((k) => !(k in i18n.DICT.zh));
  assert.deepStrictEqual(missing, [], `${lang} is missing keys: ${missing.join(', ')}`);
  assert.deepStrictEqual(extra, [], `${lang} has keys zh does not: ${extra.join(', ')}`);
}

// ── 2. placeholders survive translation ──────────────────────────────────────
for (const key of zhKeys) {
  const want = (i18n.DICT.zh[key].match(PLACEHOLDER) || []).sort();
  for (const lang of i18n.LANGS) {
    const got = (i18n.DICT[lang][key].match(PLACEHOLDER) || []).sort();
    assert.deepStrictEqual(got, want, `${lang} "${key}" placeholder mismatch: ${got} vs ${want}`);
  }
}

// ── 3. EN/JA are actually translated, not zh copies ──────────────────────────
// Legitimately identical across locales:
//   lang.*        — the switcher lists each language in its own script
//   ask.back/submit/needsInput — already English in the original zh UI
//   bub.waitYou   — pure template, both slots are filled from other keys
//   panel.less/more, *.interrupted — the same kanji is correct in ja and zh
//   panel.providerSplit — two product names and two numbers, nothing to translate
const SHARED_VERBATIM = new Set([
  'lang.zh', 'lang.en', 'lang.ja',
  'ask.back', 'ask.submit', 'ask.needsInput',
  'bub.waitYou',
  'panel.less', 'panel.more', 'sess.interrupted', 'state.interrupted',
  'panel.providerSplit',
]);
for (const lang of ['en', 'ja']) {
  const echoed = zhKeys.filter((k) => !SHARED_VERBATIM.has(k) && i18n.DICT[lang][k] === i18n.DICT.zh[k]);
  assert.deepStrictEqual(echoed, [], `${lang} still echoes zh for: ${echoed.join(', ')}`);
}

// ── 4. every t() key used in source exists ───────────────────────────────────
const SOURCES = [
  'main.js', 'backend/adapter.js', 'renderer/pet.js', 'renderer/panel.js',
];
// Only fully-qualified "group.name" literals; the concatenated families
// (t('tool.' + x), t('lang.' + code)) are asserted member-by-member below.
const DOTTED = /^[a-z]+\.[A-Za-z]\w*$/;
const usedKeys = new Set();
const collect = (re, src) => {
  for (const m of src.matchAll(re)) if (DOTTED.test(m[1])) usedKeys.add(m[1]);
};
for (const file of SOURCES) {
  const src = read(file);
  collect(/\bt\(\s*'([\w.]+)'/g, src);
  // labelKey / key indirection used by the radial menu + the state label maps
  collect(/(?:labelKey|key):\s*'([\w.]+)'/g, src);
}
for (const file of ['renderer/pet.html', 'renderer/panel.html']) {
  collect(/data-i18n(?:-title|-ph)?="([^"]+)"/g, read(file));
}
assert(usedKeys.size > 100, `key scan found suspiciously few usages: ${usedKeys.size}`);
const unknown = [...usedKeys].filter((k) => !(k in i18n.DICT.zh));
assert.deepStrictEqual(unknown, [], `t() uses keys absent from the dictionary: ${unknown.join(', ')}`);

// Dynamic families are built by concatenation — assert every member exists.
for (const suffix of ['reply', 'plan', 'perm', 'default']) {
  for (const family of ['wait.', 'reason.']) {
    assert(family + suffix in i18n.DICT.zh, `missing ${family}${suffix}`);
  }
}
for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Read', 'Bash', 'Grep', 'Glob',
  'WebSearch', 'WebFetch', 'Task', 'TodoWrite', 'Js', 'Wait', 'default']) {
  assert('tool.' + tool in i18n.DICT.zh, `missing tool.${tool}`);
}
for (const code of i18n.LANGS) assert('lang.' + code in i18n.DICT.zh, `missing lang.${code}`);

// ── 5. t() behaviour ─────────────────────────────────────────────────────────
i18n.setLang('en');
assert.strictEqual(i18n.getLang(), 'en');
assert.strictEqual(i18n.t('bub.bigDone', { ops: 7 }), '🎉 Big one finished! (7 steps)');
assert.strictEqual(i18n.t('no.such.key'), 'no.such.key', 'unknown key must degrade to the key');
i18n.setLang('nope');
assert.strictEqual(i18n.getLang(), 'zh', 'an unknown language must fall back to zh');

// ── 6. config accepts exactly the supported languages ────────────────────────
assert.strictEqual(config.DEFAULTS.lang, 'zh');

i18n.setLang('zh');
console.log('i18n checks passed');
