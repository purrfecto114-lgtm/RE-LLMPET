#!/usr/bin/env node
'use strict';
// 文档收尾：清除已删功能的全部残留描述（皮肤类 meme 引用保留）
const fs = require('fs');
function sub(file, pairs) {
  let s = fs.readFileSync(file, 'utf8');
  let hits = 0;
  for (const [re, to] of pairs) {
    if (re.test(s)) { s = s.replace(re, to); hits++; }
  }
  fs.writeFileSync(file, s);
  console.log(file, 'patched:', hits);
}

sub('README.md', [
  [/\s*；「领地模式」目前仅 macOS(?=\))/, ''],
  [/。表情包下发给 Claude \/ Codex 的 Prompt 也跟着切语言，英文界面不会突然甩一段中文进会话。\n/, '\n'],
  [/\n> 表情包的 GIF 素材本身带中文字幕（如月薪喵皮肤的「熬夜冠军」），换语言不会改图 —— 那要重做素材。\n/, '\n'],
  [/、Windows 领地模式/, ''],
  [/一键处理 Claude 授权、发送表情包指令、发起只读项目旅行；/, '一键处理 Claude 授权；'],
]);

sub('README_EN.md', [
  [/ — the main pet can watch all three backends, while Codex and dsh can each use a separate pet with its own skin and position\./,
   ' — the main pet watches all three backends.'],
  [/ A Travel Frog run contacts Anthropic or OpenAI only after you explicitly press \*\*Depart\*\*;/, ''],
]);

sub('README_JA.md', [
  [/ — 本体ペットで三つを監視し、Codex と dsh はそれぞれ独立したペットにも分けられます。/,
   ' — 本体ペットで三つを監視します。'],
]);

sub('docs/LOCAL_DEPLOYMENT.md', [
  [/\| macOS Apple Silicon \| 支持 \| “巡视”功能仅 macOS 可用 \|/, '| macOS Apple Silicon | 支持 | |'],
]);

sub('docs/LOCAL_DEPLOYMENT_EN.md', [
  [/\| macOS Apple Silicon \| Supported \| Patrol mode is macOS-only \|/, '| macOS Apple Silicon | Supported | |'],
]);

sub('docs/LOCAL_DEPLOYMENT_JA.md', [
  [/\| macOS Apple Silicon \| 対応 \| パトロールモードは macOS のみ \|/, '| macOS Apple Silicon | 対応 | |'],
]);
console.log('done');
