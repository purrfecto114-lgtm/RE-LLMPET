#!/usr/bin/env node
'use strict';
// 阶段0手术自检 — 用法: node scripts/verify-surgery.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let fails = 0;
function ok(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { console.error('  ✗ ' + msg); fails++; }
}

console.log('── A. 已删文件 ──');
for (const f of ['backend/territory.js','backend/travel.js','backend/growth.js','backend/meme-catalog.js','backend/command-dispatch.js']) {
  ok(!fs.existsSync(path.join(ROOT, f)), '已删除 ' + f);
}
ok(!fs.existsSync(path.join(ROOT, 'assets/memes')), '已删除 assets/memes/');

console.log('── B. 保留文件 ──');
for (const f of ['renderer/pet.js','renderer/pet.html','renderer/pet.css','renderer/panel.js','shared/i18n.js','shared/states.js','backend/config.js','backend/emotion.js','backend/session-archive.js','backend/runtime-monitor.js','backend/program-registry.js','backend/program-skill.js']) {
  ok(fs.existsSync(path.join(ROOT, f)), '保留 ' + f);
}
for (const d of ['cat','whale','agents']) ok(fs.existsSync(path.join(ROOT, 'assets', d)), '保留 assets/' + d);
ok(fs.existsSync(path.join(ROOT, 'assets/cat/CREDITS.md')), 'cat CREDITS.md 在');
ok(fs.existsSync(path.join(ROOT, 'assets/whale/CREDITS.md')), 'whale CREDITS.md 在');
const catN = fs.readdirSync(path.join(ROOT, 'assets/cat')).length;
const whaleN = fs.readdirSync(path.join(ROOT, 'assets/whale')).length;
ok(catN >= 20, 'cat 形态资产完整（' + catN + ' 个文件）');
ok(whaleN >= 12, 'whale 形态资产完整（' + whaleN + ' 个文件）');

console.log('── C. 无死模块引用 ──');
const jsFiles = [];
for (const d of ['.', 'backend', 'renderer', 'shared', 'hook', 'test']) {
  for (const f of fs.readdirSync(path.join(ROOT, d))) if (f.endsWith('.js')) jsFiles.push(d + '/' + f);
}
const DEAD = ['territory', 'travel', 'growth', 'meme-catalog', 'command-dispatch'];
for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of DEAD) {
    ok(!src.includes("require('./" + m + "')") && !src.includes("require('../backend/" + m + "')"), f + ' 无 ' + m + ' 引用');
  }
}

console.log('── D. IPC 通道清理 ──');
const DEAD_IPC = ['meme-catalog','meme-trigger','travel-get','travel-postcards','travel-start','travel-wander','travel-cancel','territory-run-now','loot-codex-pet','territory-toggle-auto','pet:meme','pet:travel','pet:meme-catalog-changed','close-pet'];
for (const ch of DEAD_IPC) {
  ok(!R('main.js').includes("'" + ch + "'"), 'main.js 无 ' + ch);
  ok(!R('preload.js').includes(ch), 'preload.js 无 ' + ch);
  ok(!R('renderer/pet.js').includes(ch), 'pet.js 无 ' + ch);
}

console.log('── E. 触发链标识符清零（pet.js）──');
const pet = R('renderer/pet.js');
for (const id of ['startMemeWorkReaction','finishMemeWorkReaction','activeMemeWorkVisual','playMeme','applyDeliveredMemeWorkReaction','memeWorkReaction','lootActionVisual','slTravel','slMeme','memeMediaUrl','openMemePage','openTravelPage','renderTravel','travelBelongsToThisPet','travelData','startLootCapture','appendLootSession','lootCapture','memeTarget','lootKeptSessions','loadMemeCatalog','TRAVEL_POPUP_W','territorySupported','lootSupported','travelBelongs']) {
  ok(!pet.includes(id), 'pet.js 无 ' + id);
}

console.log('── F. 双宠标识符清零 ──');
for (const id of ['petWinCodex','petWinDsh','splitAgents','CLONE_SHIFT','applyPetMode','applyDshPet','skinCodex','skinDsh','dshPet','petPositionCodex','petPositionDsh','petMode']) {
  ok(!R('main.js').includes(id), 'main.js 无 ' + id);
  ok(!R('backend/config.js').includes(id), 'config.js 无 ' + id);
}
for (const id of ["AGENT === 'codex'","AGENT === 'dsh'","AGENT !== 'all'"]) {
  ok(!pet.includes(id), 'pet.js 无 ' + id);
}

console.log('── G. 三形态皮肤系统完好 ──');
for (const id of ['MEME_PACKS','updateCat','catAssetMatches','isMeme','CAT_STATES','WHALE_STATES','toggleSkin']) {
  ok(pet.includes(id), 'pet.js 保留 ' + id);
}

console.log('── H. 保留 IPC 通道仍在 ──');
const main = R('main.js');
for (const ch of ["'set-skin'","'set-mode'","'launch-claude'","'launch-codex'","'launch-dsh'","'focus-session'","'get-config'","'get-stats'","'ui-busy'","'pet-visual-bounds'"]) {
  ok(main.includes(ch), 'main.js 保留 ' + ch);
}
for (const fn of ['createPetWindows','makePetWindow','frontendConfig','codexWatch','dshWatch','applySkin','refreshTrayMenu']) {
  ok(main.includes(fn), 'main.js 保留 ' + fn);
}

console.log('── I. i18n 键清理 ──');
const i18n = R('shared/i18n.js');
for (const k of ["'travel.", "'meme.", "'territory.", "'terr.", "'loot.", "'tray.codexPet'", "'tray.dshPet'", "'tray.skinClaude'", "'tray.skinCodex'", "'tray.skinDsh'", "'bub.onlineCodex'", "'bub.onlineDsh'", "'menu.loot'", "'menu.patrol'", "'menu.collapse'"]) {
  ok(!i18n.includes(k), 'i18n 无键 ' + k);
}
for (const k of ["'tray.launchClaude'", "'tray.launchCodex'", "'tray.launchDsh'", "'sess.newCodex'", "'sess.newDsh'", "'menu.skin'"]) {
  ok(i18n.includes(k), 'i18n 保留键 ' + k);
}

console.log('── J. HTML/CSS 清理 ──');
for (const id of ['sl-travel', 'sl-meme', 'sl-loot', 'sl-wander', 'meme-player']) {
  ok(!R('renderer/pet.html').includes(id), 'pet.html 无 ' + id);
  ok(!R('renderer/pet.css').includes(id), 'pet.css 无 ' + id);
}
ok(R('renderer/pet.html').includes('sl-takeover-view'), 'pet.html 保留 takeover');
ok(R('renderer/pet.html').includes('sl-new-codex') && R('renderer/pet.html').includes('sl-new-dsh'), 'pet.html 保留三拉起入口');

console.log('');
if (fails) { console.error('共 ' + fails + ' 项未通过'); process.exit(1); }
console.log('手术自检全部通过');
