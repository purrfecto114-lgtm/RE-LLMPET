'use strict';

// Build-time/source-tree installer for the Rust hook bridge. Node is used only
// for this one-time configuration edit; the installed lifecycle hooks execute
// the native RE-LLMPET binary in hook mode and do not start Node or Electron.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact',
  'Notification', 'Elicitation', 'ElicitationResult',
  'PermissionDenied', 'TaskCreated', 'TaskCompleted', 'TeammateIdle',
  // R27 (2026-07-30): 5 new observer events from Claude Code v2.1.219+
  'Setup', 'InstructionsLoaded', 'CwdChanged', 'WorktreeRemove', 'DirectoryAdded',
];
const MARKER = '--re-llmpet-hook';

function quote(value) {
  const text = String(value);
  if (process.platform === 'win32') return `& '${text.replace(/'/g, "''")}'`;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function findBinary() {
  const requested = process.argv.find((arg) => arg.startsWith('--hook-bin='));
  const explicit = requested ? requested.slice('--hook-bin='.length) : process.env.OCTOPUS_HOOK_BIN;
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    explicit,
    path.join(__dirname, '..', 'src-tauri', 'target', 'release', `octopus${suffix}`),
    path.join(__dirname, '..', 'src-tauri', 'target', 'debug', `octopus${suffix}`),
    path.join(__dirname, '..', 'src-tauri', 'target', 'release', `re-llmpet-hook${suffix}`),
    path.join(__dirname, '..', 'src-tauri', 'target', 'debug', `re-llmpet-hook${suffix}`),
  ].filter(Boolean).map((p) => path.resolve(p));
  const found = candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  if (!found) throw new Error(`RE-LLMPET binary not found. Build it first with: cargo build --manifest-path src-tauri/Cargo.toml --release --bins`);
  return found;
}

function readJson(file, fallback) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 16 * 1024 * 1024) throw new Error('file too large');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.settings.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function isOurs(hook) {
  return hook && typeof hook.command === 'string' && hook.command.includes(MARKER);
}

function isOurHttp(hook) {
  if (!hook || hook.type !== 'http' || typeof hook.url !== 'string') return false;
  try {
    const url = new URL(hook.url);
    return url.hostname === '127.0.0.1' && Number(url.port) >= 41330 && Number(url.port) <= 41334 && url.pathname === '/permission';
  } catch { return false; }
}

function sync(hooks, event, desired, matcher) {
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  for (const group of hooks[event]) {
    if (!group || !Array.isArray(group.hooks)) continue;
    const existing = group.hooks.find(matcher);
    if (existing) {
      Object.assign(existing, desired);
      return 'updated';
    }
  }
  hooks[event].push({ matcher: '', hooks: [desired] });
  return 'added';
}

function remove(hooks) {
  let count = 0;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event].map((group) => {
      if (!group || !Array.isArray(group.hooks)) return group;
      const kept = group.hooks.filter((hook) => {
        const ours = isOurs(hook) || isOurHttp(hook);
        if (ours) count++;
        return !ours;
      });
      return { ...group, hooks: kept };
    }).filter((group) => !group || !Array.isArray(group.hooks) || group.hooks.length);
    if (!hooks[event].length) delete hooks[event];
  }
  return count;
}

function install() {
  const binary = findBinary();
  const settings = readJson(SETTINGS, {});
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const result = { added: 0, updated: 0, binary };
  for (const event of EVENTS) {
    const command = `${quote(binary)} --re-llmpet-hook --provider claude ${event}`;
    const desired = process.platform === 'win32'
      ? { type: 'command', shell: 'powershell', command, timeout: 5 }
      : { type: 'command', command, timeout: 5 };
    result[sync(settings.hooks, event, desired, isOurs)]++;
  }
  const pretoolCommand = `${quote(binary)} --re-llmpet-hook --provider claude --pretool PreToolUse`;
  const pretoolHook = process.platform === 'win32'
    ? { type: 'command', shell: 'powershell', command: pretoolCommand, timeout: 600 }
    : { type: 'command', command: pretoolCommand, timeout: 600 };
  result[sync(settings.hooks, 'PreToolUse', pretoolHook, isOurs)]++;
  const permissionCommand = `${quote(binary)} --re-llmpet-hook --provider claude --permission PermissionRequest`;
  const permissionHook = process.platform === 'win32'
    ? { type: 'command', shell: 'powershell', command: permissionCommand, timeout: 600 }
    : { type: 'command', command: permissionCommand, timeout: 600 };
  result[sync(settings.hooks, 'PermissionRequest', permissionHook, (hook) => isOurs(hook) || isOurHttp(hook))]++;
  writeAtomic(SETTINGS, settings);
  return result;
}

function uninstall() {
  const settings = readJson(SETTINGS, {});
  if (!settings.hooks) return { removed: 0 };
  const backup = `${SETTINGS}.re-llmpet-native-backup-${Date.now()}.bak`;
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, backup);
  const removed = remove(settings.hooks);
  if (removed) writeAtomic(SETTINGS, settings);
  return { removed, backup: removed ? backup : null };
}

try {
  console.log(process.argv.includes('--uninstall') ? uninstall() : install());
} catch (error) {
  console.error(`install-native-hooks: ${error.message}`);
  process.exitCode = 1;
}
