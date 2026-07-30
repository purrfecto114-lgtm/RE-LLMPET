'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'resources', 'memes', 'catalog.json');
const OUTPUT = path.join(ROOT, 'frontend', 'shared', 'memes.js');
const CHECK = process.argv.includes('--check');
const SAFE_MEDIA = /^[a-z0-9][a-z0-9-]*\/(?:[a-z0-9][a-z0-9._-]*)$/;
const SAFE_REACTIONS = new Set(['idle', 'thinking', 'working', 'waiting', 'needsinput', 'happy', 'error', 'sorry', 'puzzled', 'excited', 'sad', 'loved']);

function fail(message) {
  console.error(`generate-public-meme-catalog: ${message}`);
  process.exit(1);
}

function readCatalog() {
  let raw;
  try {
    raw = fs.readFileSync(SOURCE);
  } catch (error) {
    fail(`cannot read ${path.relative(ROOT, SOURCE)}: ${error.message}`);
  }
  let catalog;
  try {
    catalog = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    fail(`invalid JSON: ${error.message}`);
  }
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.items)) {
    fail('unsupported catalog schema');
  }
  return { raw, catalog };
}

function cleanText(value, field, max) {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    fail(`${field} is empty, too long, or contains control characters`);
  }
  return text;
}

function localized(item, lang) {
  if (lang === 'zh') {
    return {
      label: cleanText(item.label, `${item.id}.label`, 96),
      description: cleanText(item.description, `${item.id}.description`, 240),
      reactionLabel: cleanText(item.reaction && item.reaction.label, `${item.id}.reaction.label`, 160),
    };
  }
  const copy = item.i18n && item.i18n[lang];
  if (!copy) fail(`${item.id}.i18n.${lang} is missing`);
  return {
    label: cleanText(copy.label, `${item.id}.i18n.${lang}.label`, 96),
    description: cleanText(copy.description, `${item.id}.i18n.${lang}.description`, 240),
    reactionLabel: cleanText(copy.reactionLabel, `${item.id}.i18n.${lang}.reactionLabel`, 160),
  };
}

function buildPublic(catalog) {
  const ids = new Set();
  return catalog.items.map((item, index) => {
    const id = cleanText(item && item.id, `items[${index}].id`, 64);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || ids.has(id)) fail(`invalid or duplicate meme id: ${id}`);
    ids.add(id);
    const gif = cleanText(item.media && item.media.gif, `${id}.media.gif`, 160);
    const audio = cleanText(item.media && item.media.audio, `${id}.media.audio`, 160);
    if (!SAFE_MEDIA.test(gif) || !SAFE_MEDIA.test(audio)) fail(`${id} has unsafe media path`);
    for (const relative of [gif, audio]) {
      const absolute = path.join(ROOT, 'frontend', 'assets', 'memes', relative);
      if (!absolute.startsWith(path.join(ROOT, 'frontend', 'assets', 'memes') + path.sep) || !fs.existsSync(absolute)) {
        fail(`${id} media is missing: ${relative}`);
      }
    }
    const durationMs = Number(item.media.durationMs);
    const reactionDurationMs = Number(item.reaction && item.reaction.durationMs);
    if (!Number.isFinite(durationMs) || durationMs < 500 || durationMs > 30000) fail(`${id} has invalid media duration`);
    if (!Number.isFinite(reactionDurationMs) || reactionDurationMs < 500 || reactionDurationMs > 30000) fail(`${id} has invalid reaction duration`);
    const reactionState = cleanText(item.reaction.state, `${id}.reaction.state`, 32);
    if (!SAFE_REACTIONS.has(reactionState)) fail(`${id} has unsupported reaction state: ${reactionState}`);
    return {
      id,
      category: cleanText(item.category, `${id}.category`, 64),
      media: { gif, audio, durationMs, placement: item.media.placement === 'pet-right' ? 'pet-right' : 'overlay' },
      reaction: {
        state: reactionState,
        durationMs: reactionDurationMs,
      },
      copy: {
        zh: localized(item, 'zh'),
        en: localized(item, 'en'),
        ja: localized(item, 'ja'),
      },
    };
  });
}

const { raw, catalog } = readCatalog();
const publicItems = buildPublic(catalog);
const sourceSha256 = crypto.createHash('sha256').update(raw).digest('hex');
const generated = `'use strict';\n\n// Generated from resources/memes/catalog.json. Instruction bodies deliberately stay\n// outside the renderer bundle; this file exposes only validated presentation data.\n(function attachPublicMemeCatalog(global) {\n  const data = ${JSON.stringify({ schemaVersion: 1, sourceSha256, items: publicItems }, null, 2)};\n  global.LLMPET_MEMES = Object.freeze(data);\n})(window);\n`;

if (CHECK) {
  const existing = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
  if (existing !== generated) fail('frontend/shared/memes.js is stale; run npm run generate:memes');
  console.log(`generate-public-meme-catalog: ok (${publicItems.length} public entries, prompts excluded)`);
} else {
  fs.writeFileSync(OUTPUT, generated);
  console.log(`generate-public-meme-catalog: wrote ${path.relative(ROOT, OUTPUT)} (${publicItems.length} entries)`);
}
