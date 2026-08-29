'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const json = (file) => JSON.parse(read(file));

const windows = json('src-tauri/tauri.windows.conf.json');
assert.deepStrictEqual(windows.bundle.targets, ['nsis']);
assert.strictEqual(windows.bundle.windows.webviewInstallMode.type, 'downloadBootstrapper');
assert.strictEqual(windows.bundle.windows.webviewInstallMode.silent, true);

const ico = fs.readFileSync(path.join(root, 'src-tauri/icons/icon.ico'));
assert(ico.length > 1024, 'Windows icon should not be an empty placeholder');
assert.strictEqual(ico.readUInt16LE(0), 0, 'ICO reserved word');
assert.strictEqual(ico.readUInt16LE(2), 1, 'ICO type');
assert(ico.readUInt16LE(4) >= 1, 'ICO image count');

const commands = read('src-tauri/src/commands.rs');
assert(commands.includes('#[cfg(target_os = "windows")]'));
assert(commands.includes('which("wt.exe")'), 'Windows Terminal must be the primary host');
// R22 (2026-07-30): cargo fmt may split the wt.exe args across lines.
// Accept either the inline form or the multiline form.
assert(
  commands.includes('"-w", "-1", "new-tab"')
  || (commands.includes('"-w",') && commands.includes('"-1",') && commands.includes('"new-tab",')),
  'Windows Terminal launch should create a new tab/window'
);
assert(commands.includes('"--startingDirectory"'), 'Windows Terminal must receive the validated working directory');
const launchStart = commands.indexOf('fn launch_terminal');
const fallbackMarker = commands.indexOf('// Windows Terminal is optional.', launchStart);
assert(launchStart >= 0 && fallbackMarker > launchStart, 'Windows Terminal block must precede fallback');
const modernBlock = commands.slice(launchStart, fallbackMarker);
assert(modernBlock.includes('command.arg(executable)'), 'native CLIs must be launched directly by Windows Terminal');
assert(modernBlock.includes('if is_windows_script(executable)'), 'cmd/bat shims need an explicit compatibility branch');
assert(modernBlock.includes('.args(["/D", "/S", "/K"])'), 'script shim compatibility must keep the terminal open');
const fallbackBlock = commands.slice(fallbackMarker, commands.indexOf('#[cfg(target_os = "macos")]', fallbackMarker));
assert(fallbackBlock.includes('Command::new("cmd.exe")'), 'Command Prompt must remain the fallback');
assert(fallbackBlock.includes('.args(["/D", "/S", "/K"])'), 'fallback must keep the provider CLI session open');
assert(!commands.includes('.args(["/C", "start"'), 'legacy cmd start wrapper must stay removed');
assert(!commands.includes('disableHardwareAcceleration'));

const platform = read('src-tauri/src/platform.rs');
assert.strictEqual(
  (platform.match(/EnumWindows\(EnumProc/g) || []).length,
  1,
  'PowerShell Add-Type block must declare EnumWindows exactly once'
);
assert(platform.includes('$script:found = $false'), 'focus state must use script scope');
assert(platform.includes('if ($script:found) { exit 0 } else { exit 3 }'), 'focus result must read script-scoped state');
assert(commands.includes('Command::new("explorer.exe")'), 'Windows path opening must bypass cmd.exe');
assert(!commands.includes('.args(["/C", "start", "", path'), 'paths must never be interpolated through cmd start');

const main = read('src-tauri/src/main.rs');
const hook = read('src-tauri/src/hook_client.rs');
assert(main.includes('--octopus-hook'), 'packaged executable must support Octopus native hook mode');
assert(main.includes('--re-llmpet-hook'), 'packaged executable must accept legacy hook mode during migration');
assert(hook.includes('USERPROFILE'), 'hook client needs a Windows home fallback');
assert(hook.includes('X-Re-Llmpet-Token'), 'hook transport must authenticate local requests');

const packageJson = json('package.json');
assert.strictEqual(packageJson.dependencies.electron, undefined);
assert.strictEqual(packageJson.devDependencies.electron, undefined);
assert(packageJson.scripts['package:win'].includes('--bundles nsis'));

// R22 (2026-08-10): hide_console_window regression guard.
// Octopus is a GUI-subsystem binary; every non-interactive console child
// (curl, cmd, powershell, taskkill) must have CREATE_NO_WINDOW applied via
// the shared helper. This prevents the "黑色 cmd 窗口" flash that users
// reported. launch_terminal is intentionally excluded (visible terminal).
assert(platform.includes('pub(crate) fn hide_console_window'),
  'platform.rs must define hide_console_window helper');
assert(platform.includes('CREATE_NO_WINDOW: u32 = 0x0800_0000'),
  'hide_console_window must use CREATE_NO_WINDOW (0x08000000)');

// Verify the helper is called at all expected spawn sites.
const pricing = read('src-tauri/src/pricing_sync.rs');
assert(pricing.includes('crate::platform::hide_console_window'),
  'pricing_sync curl spawn must hide console window (#1 source of black cmd)');

const travel = read('src-tauri/src/travel.rs');
assert(travel.includes('CREATE_NO_WINDOW') || travel.includes('hide_console_window'),
  'travel provider_command must hide console window for .cmd shim trips');

const hookClient = read('src-tauri/src/hook_client.rs');
assert(hookClient.includes('hide_console_window'),
  'hook_client resolve_ppid must hide powershell window');

// launch_terminal must NOT have hide_console_window (terminal is intentionally visible)
const launchTerminalSection = commands.slice(
  commands.indexOf('fn launch_terminal'),
  commands.indexOf('fn open_path')
);
assert(!launchTerminalSection.includes('hide_console_window'),
  'launch_terminal must NOT hide console window (user expects visible terminal)');

console.log('tauri-windows-static-smoke: ok');
