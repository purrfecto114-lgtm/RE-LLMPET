'use strict';

// Persisted app config. Shape matches the frontend contract (preload README §4):
//   { mode, skin, petPosition, muted, permHook }
// Stored atomically under ~/.octopus/config.json.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { log } = require('./log');

const CONFIG_DIR = path.join(os.homedir(), '.octopus');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = Object.freeze({
  mode: 'pet',            // 'pet' | 'panel' | 'menubar'
  skin: 'mascot',         // 见 SKINS
  petPosition: null,      // {x,y} | null
  muted: false,
  permHook: true,         // whether the blocking permission HTTP hook is active
  lang: 'zh',             // 'zh' | 'en' | 'ja' — 界面与表情包文案语言
  pinnedSessions: [],     // 会话 HUD 置顶项（按稳定 session id）
  archivedSessions: [],   // 会话 HUD 归档项（不影响后端任务本身）
  sessionArchive: {       // 全量历史档案馆；备份必须由用户明确开启
    backupEnabled: false,
    backupIntervalHours: 24,
  },
  agentStartup: {         // LLMPET 启动时，只补拉起当前没有运行的交互式 CLI
    claude: true,
    codex: true,
    dsh: false,           // dsh 默认不自动拉起：它起的是本地 web 服务，会开浏览器
  },
});

let cache = null;

function sanitizeSessionIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim().slice(0, 256)))]
    .slice(0, 300);
}

// 皮肤白名单只此一份：渲染端 applySkin 和托盘菜单都以它为准，
// 少改一处就会出现"菜单能点、设置存不下"的静默回落。
const SKINS = ['mascot', 'pixel', 'cat', 'whale'];

function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  if (['pet', 'panel', 'menubar'].includes(raw.mode)) out.mode = raw.mode;
  if (SKINS.includes(raw.skin)) out.skin = raw.skin;
  if (raw.petPosition && Number.isFinite(raw.petPosition.x) && Number.isFinite(raw.petPosition.y)) {
    out.petPosition = { x: Math.round(raw.petPosition.x), y: Math.round(raw.petPosition.y) };
  }
  out.muted = !!raw.muted;
  out.permHook = raw.permHook !== false;
  if (['zh', 'en', 'ja'].includes(raw.lang)) out.lang = raw.lang;
  out.pinnedSessions = sanitizeSessionIds(raw.pinnedSessions);
  out.archivedSessions = sanitizeSessionIds(raw.archivedSessions)
    .filter((id) => !out.pinnedSessions.includes(id));
  if (raw.sessionArchive && typeof raw.sessionArchive === 'object') {
    out.sessionArchive = {
      backupEnabled: raw.sessionArchive.backupEnabled === true,
      backupIntervalHours: [6, 12, 24, 72, 168].includes(Number(raw.sessionArchive.backupIntervalHours))
        ? Number(raw.sessionArchive.backupIntervalHours)
        : DEFAULTS.sessionArchive.backupIntervalHours,
    };
  }
  if (raw.agentStartup && typeof raw.agentStartup === 'object') {
    out.agentStartup = {
      claude: raw.agentStartup.claude !== false,
      codex: raw.agentStartup.codex !== false,
      dsh: raw.agentStartup.dsh === true,
    };
  }
  return out;
}

function load() {
  if (cache) return cache;
  try {
    cache = sanitize(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(partial) {
  cache = sanitize({ ...load(), ...partial });
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = path.join(CONFIG_DIR, `.config.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, CONFIG_PATH);
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
  } catch (err) {
    log('config', 'save failed:', err.message);
  }
  return cache;
}

function get() { return load(); }

module.exports = { get, save, sanitize, CONFIG_PATH, DEFAULTS };
