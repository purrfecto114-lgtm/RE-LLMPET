'use strict';

// Guards the EN/JA localization against the two ways it rots silently:
//   1. key drift — a string added to zh but not to en/ja shows Chinese in an
//      English UI, and nothing crashes to tell you;
//   2. placeholder drift — a translation that drops {project} or {pct} renders
//      a sentence with a hole in it, again without an error.
// Also checks that every t('...') key used in the source actually exists.
//
// 2026-08-29 Electron-exit port: the dictionary moved from the deleted root
// shared/ to frontend/shared/i18n.js (plain UMD — require() works directly),
// and the only remaining JS consumers are the Tauri renderer pages
// frontend/renderer/pet.js + panel.js (the Electron main.js/backend/adapter.js
// callers are gone). The Rust side owns the config default now.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const i18n = require('../frontend/shared/i18n');

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
// PLACEHOLDER_DRIFT_OK lists keys whose zh form still carries a legacy slot
// that en/ja dropped. 'bubble.waiting' is dead in the renderer (no t() call
// site anywhere under frontend/), so nothing renders the stale {reason} slot.
// Kept as a documented exception instead of editing the dictionary during the
// 2026-08-29 Electron-exit cleanup; delete the key outright when gardening.
const PLACEHOLDER_DRIFT_OK = new Set(['bubble.waiting']);
for (const key of zhKeys) {
  const want = (i18n.DICT.zh[key].match(PLACEHOLDER) || []).sort();
  for (const lang of i18n.LANGS) {
    const got = (i18n.DICT[lang][key].match(PLACEHOLDER) || []).sort();
    if (PLACEHOLDER_DRIFT_OK.has(key)) {
      assert(got.every((slot) => want.includes(slot)),
        `${lang} "${key}" dropped a slot zh still has AND is not whitelisted`);
      continue;
    }
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
//   sess.filterClaude/filterCodex — provider filter tabs are product names
//   (R50: added with the r46 HUD filter chips, same rule as providerSplit)
//   diag.hooks / panel.providers — English loanwords the ja UI keeps verbatim
//   ("Octopus Hook", "Provider"); zh uses the same loanword, so ja == zh is
//   correct, not a copy. en differs only by plural/spacing. (R50)
const SHARED_VERBATIM = new Set([
  'lang.zh', 'lang.en', 'lang.ja',
  'ask.back', 'ask.submit', 'ask.needsInput',
  'bub.waitYou',
  'panel.less', 'panel.more', 'sess.interrupted', 'state.interrupted',
  'panel.providerSplit',
  'sess.filterClaude', 'sess.filterCodex',
  'diag.hooks', 'panel.providers',
]);
for (const lang of ['en', 'ja']) {
  const echoed = zhKeys.filter((k) => !SHARED_VERBATIM.has(k) && i18n.DICT[lang][k] === i18n.DICT.zh[k]);
  assert.deepStrictEqual(echoed, [], `${lang} still echoes zh for: ${echoed.join(', ')}`);
}

// ── 4. every t() key used in source exists ───────────────────────────────────
const SOURCES = [
  'frontend/renderer/pet.js', 'frontend/renderer/panel.js',
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
for (const file of ['frontend/renderer/pet.html', 'frontend/renderer/panel.html']) {
  collect(/data-i18n(?:-title|-ph|-placeholder)?="([^"]+)"/g, read(file));
}
assert(usedKeys.size > 100, `key scan found suspiciously few usages: ${usedKeys.size}`);
// KNOWN_GAPS (2026-08-29 audit): call sites whose keys are genuinely absent
// from frontend/shared/i18n.js. The renderer t() wrapper degrades to the raw
// key string, so these surface as literal "panel.waiting"-style text at
// runtime. Fixing them means adding dictionary entries (business-code owner);
// listed here so the guard stays strict for every other key.
// R50 (2026-08-30): the three former gaps were filled in the dictionary
// (panel.waiting / panel.refreshNow / provider.choose, all three locales).
const KNOWN_GAPS = new Set([]);
const unknown = [...usedKeys].filter((k) => !(k in i18n.DICT.zh) && !KNOWN_GAPS.has(k));
assert.deepStrictEqual(unknown, [], `t() uses keys absent from the dictionary: ${unknown.join(', ')}`);
for (const k of KNOWN_GAPS) {
  if (usedKeys.has(k)) console.warn(`i18n KNOWN_GAP: "${k}" still lacks a dictionary entry (renderer degrades to the raw key)`);
}

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

// ── 6. Rust config defaults to exactly the supported languages ───────────────
// The Electron-era ../backend/config DEFAULTS no longer exists. The Tauri
// config schema keeps its lang default in src-tauri/src/model.rs (AppConfig +
// sanitize — config_types.rs carries the other config structs, not lang).
const modelRs = read('src-tauri/src/model.rs');
assert(modelRs.includes('pub lang: String'), 'AppConfig must declare the lang field');
assert(modelRs.includes('lang: "zh".into()'),
  'AppConfig::default must initialize lang to "zh"');
assert(modelRs.includes('matches!(self.lang.as_str(), "zh" | "en" | "ja")'),
  'AppConfig::sanitize must only accept zh/en/ja and otherwise reset to zh');

i18n.setLang('zh');
console.log('i18n checks passed');
