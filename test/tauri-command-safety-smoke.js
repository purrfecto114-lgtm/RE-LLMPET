'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const commands = read('src-tauri/src/commands.rs');
const platform = read('src-tauri/src/platform.rs');

for (const provider of ['claude', 'codewhale', 'codex', 'opencode', 'aider']) {
  assert(commands.includes(`"${provider}"`), `provider allow-list should include ${provider}`);
}
assert(
  (commands.match(/unsupported agent provider/g) || []).length >= 2,
  'terminal and GUI launch paths must both reject unknown providers'
);
assert(!commands.includes('launch_terminal(provider.as_str())'), 'renderer input must not become an executable name');
assert(commands.includes('platform_state.set_ui_busy(on)'), 'ui_busy must update native state');
assert(commands.includes('platform_state.set_visual_bounds(&rect)'), 'pet_visual_bounds must update native state');
assert(commands.includes('platform_state.is_ui_busy()'), 'territory action must respect active UI interaction');
assert(platform.includes('ui_busy: AtomicBool'), 'native platform state must retain UI busy state');
assert(platform.includes('visual_bounds: Mutex<Option<VisualBounds>>'), 'native platform state must retain visual bounds');
assert(platform.includes('mouse_ignore_requested: AtomicBool'), 'renderer click-through intent must be retained natively');
assert(platform.includes('cursor_hit_test_started: AtomicBool'), 'native cursor hit-test worker must be single-start');
assert(platform.includes('window.cursor_position()'), 'click-through recovery must not depend on ignored renderer mouse events');
assert(platform.includes('.scale_factor()'), 'hit testing must account for Windows DPI scaling');
assert(platform.includes('window.set_ignore_cursor_events(ignore)'), 'native worker must own the applied click-through state');
assert(platform.includes('value.is_finite()'), 'visual bounds must reject NaN/Infinity');
assert(platform.includes('bounds.width <= 0.0'), 'visual bounds must reject non-positive dimensions');
assert(platform.includes('bounds.width > 4096.0'), 'visual bounds must enforce a sane maximum');
assert(commands.includes('Command::new("explorer.exe")'), 'Windows path opening must not invoke cmd.exe');
assert(commands.includes('which("wt.exe")'), 'provider terminals must prefer a resolved Windows Terminal path');
const terminalStart = commands.indexOf('fn launch_terminal');
const fallbackMarker = commands.indexOf('// Windows Terminal is optional.', terminalStart);
const modernTerminal = commands.slice(terminalStart, fallbackMarker);
assert(modernTerminal.includes('command.arg(executable)'), 'native provider binaries must be passed directly to Windows Terminal');
assert(modernTerminal.includes('if is_windows_script(executable)'), 'npm cmd/bat shims must use an explicit compatibility branch');
assert(commands.slice(fallbackMarker).includes('Command::new("cmd.exe")'), 'provider terminals must fall back to Command Prompt');
assert(commands.includes('pub fn commit_win_pos'), 'drag completion must persist exactly once');
const hotMove = commands.match(/pub fn set_win_pos[\s\S]*?\n}\n\n#\[tauri::command\]/);
assert(hotMove, 'set_win_pos hot path missing');
assert(!hotMove[0].includes('update_config'), 'pointermove must not write config on every frame');

const hookInstall = read('src-tauri/src/hook_install.rs');
const httpServer = read('src-tauri/src/http_server.rs');
assert(hookInstall.includes('.bak"') && hookInstall.includes('original restored'), 'hook config replacement must use backup rollback');
assert(hookInstall.includes('if had_original') && hookInstall.includes('fs::rename(&backup'), 'hook config replacement must track and restore the original');
assert(httpServer.includes('re-llmpet-backup'), 'runtime metadata replacement must retain a Windows backup');
assert(httpServer.includes('if had_original') && httpServer.includes('fs::rename(&backup'), 'runtime metadata replacement must roll back after failure');


const model = read('src-tauri/src/model.rs');
assert(model.includes(".map(|c| if c.is_control() { ' ' } else { c })"), 'log messages must flatten control characters');
assert(model.includes('take(4096)'), 'renderer/native log records must remain bounded');

console.log('tauri-command-safety-smoke: ok');
