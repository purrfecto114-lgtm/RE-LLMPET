#!/usr/bin/env node
'use strict';
const fs = require('fs');
function sub(file, pairs) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [re, to] of pairs) {
    if (!re.test(s)) { console.log(file, 'MISS:', String(re).slice(0, 60)); continue; }
    s = s.replace(re, to);
  }
  fs.writeFileSync(file, s);
  console.log('ok', file);
}

sub('README.md', [
  [/；「领地模式」目前仅 macOS）/, '）'],
]);

sub('docs/LOCAL_DEPLOYMENT.md', [
  [/### “巡视”不能移动其他桌宠\n\n请在“系统设置 → 隐私与安全性 → 辅助功能”中允许当前启动 LLMPET 的 Electron 应用，然后重启 LLMPET。\n\n/, ''],
]);

sub('docs/LOCAL_DEPLOYMENT_EN.md', [
  [/- \*\*Patrol cannot move another pet:\*\* grant the Electron process Accessibility permission and restart LLMPET\.\n/, ''],
]);

sub('docs/LOCAL_DEPLOYMENT_JA.md', [
  [/- \*\*パトロールで他のペットを動かせない：\*\* Electron プロセスにアクセシビリティ権限を許可し、LLMPET を再起動してください。\n/, ''],
]);
console.log('done');
