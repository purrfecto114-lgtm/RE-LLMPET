#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const commands = fs.readFileSync(path.join(root, 'src-tauri/src/commands.rs'), 'utf8');
const hooks = fs.readFileSync(path.join(root, 'src-tauri/src/hook_install.rs'), 'utf8');
const lib = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
const ps = fs.readFileSync(path.join(root, 'scripts/windows-cli-diagnostics.ps1'), 'utf8');
const failures = [];
const pass = [];
function check(name, condition) {
  (condition ? pass : failures).push(name);
}
check('five provider ids remain allowlisted', ['claude','codewhale','codex','opencode','aider'].every(id => commands.includes(`"${id}" => Ok(AgentSpec`)));
check('unknown provider is rejected', commands.includes('unsupported agent provider'));
check('unknown provider no longer silently falls back to claude', !commands.includes('_ => "claude"'));
check('CodeWhale companion is required', commands.includes('MISSING_COMPANION_BINARY') && commands.includes('codewhale-tui'));
check('CodeWhale doctor JSON is probed', commands.includes('&["doctor", "--json"]'));
check('CodeWhale dispatcher and companion versions are compared', commands.includes('companionVersionProbe') && commands.includes('dispatcher/runtime version mismatch'));
check('failed probes make diagnostics unready', commands.includes('probe_succeeded') && commands.includes('--version failed'));
check('Windows cmd/bat version probes use cmd.exe', commands.includes('cmd_probe_call') && commands.includes('.args(["/D", "/S", "/C"])'));
check('diagnostics capture stdout and stderr', commands.includes('"stdout"') && commands.includes('"stderr"'));
check('diagnostics are bounded', commands.includes('.take(8192)') && commands.includes('pipe.take(64 * 1024)'));
check('working directory can be explicit', commands.includes('LLMPET_AGENT_CWD') && commands.includes('launch_agent_in'));
check('PATH resolver rejects non-executable Unix files', commands.includes('fn is_executable_file') && commands.includes('permissions().mode() & 0o111'));
check('CodeWhale doctor uses a bounded companion-first fallback chain', commands.includes('fn codewhale_doctor_probe') && commands.includes('probe_indicates_unknown_command') && commands.includes('doctor_attempts'));
check('GUI npm cmd/bat shims use the fixed compatibility path', commands.includes('fn open_gui_application') && commands.includes('if is_windows_script(executable)'));

const launchTerminal = commands.slice(commands.indexOf('fn launch_terminal'), commands.indexOf('fn open_path'));
check('Windows Terminal is first choice', launchTerminal.indexOf('which("wt.exe")') < launchTerminal.indexOf('Command::new("cmd.exe")'));
check('Windows Terminal receives starting directory', commands.includes('--startingDirectory'));
check('npm cmd/bat shims are handled', commands.includes('eq_ignore_ascii_case("cmd")') && commands.includes('eq_ignore_ascii_case("bat")'));
check('legacy cmd /C start launcher is gone', !commands.includes('.args(["/C", "start"'));
check('Windows log opening bypasses cmd.exe', commands.includes('Command::new("explorer.exe")'));
check('diagnostic commands are registered', lib.includes('diagnose_agent,') && lib.includes('launch_agent_in,'));
check('CodeWhale hook contract keeps current native events', ['session_start','session_end','message_submit','tool_call_before','tool_call_after','turn_end','on_error','mode_change','subagent_spawn','subagent_complete'].every(event => hooks.includes(`"${event}"`)));
check('permission hook remains foreground and strict', hooks.includes('let permission = event == "tool_call_before"') && hooks.includes('if permission { "false" } else { "true" }'));
check('observer hooks remain background', hooks.includes('block.push_str("background = true\\n")'));
check('Windows config replacement uses backup rollback', hooks.includes('.bak"') && hooks.includes('original restored'));
check('Windows config is not deleted before replacement', !hooks.includes('fs::remove_file(path).map_err'));
check('PowerShell diagnostics support Windows PowerShell 5.1', !ps.includes('??') && ps.includes('Read-BoundedText'));
check('PowerShell diagnostics isolate individual probe failures', ps.includes('started = $false') && ps.includes('error = $_.Exception.Message'));
check('PowerShell diagnostics support npm cmd/bat shims', ps.includes("$extension -ieq '.cmd'") && ps.includes("$extension -ieq '.bat'"));

check('R2 language command remains registered', commands.includes('pub fn set_language') && lib.includes('set_language,'));
check('R2 deferred drag persistence remains', commands.includes('pub fn commit_win_pos') && lib.includes('commit_win_pos,'));
check('R2 DPI anchored resize remains', commands.includes('fn resize_pet_anchored') && commands.includes('logical_to_physical'));
check('R2 native hit test remains enabled', lib.includes('start_cursor_hit_test'));
check('R2 UI busy and visual bounds remain real state', commands.includes('platform_state.set_ui_busy(on)') && commands.includes('platform_state.set_visual_bounds(&rect)'));
check('launch_agent_in is not exposed to pet capability without a cwd picker', !fs.readFileSync(path.join(root, 'src-tauri/capabilities/pet.json'), 'utf8').includes('allow-launch-agent-in'));
check('diagnose_agent is exposed without accepting arbitrary WebView cwd', fs.readFileSync(path.join(root, 'frontend/renderer/tauri-bridge.js'), 'utf8').includes("diagnoseAgent: (provider) => call('diagnose_agent', { provider })") && commands.includes('pub fn diagnose_agent(provider: String)') && fs.readFileSync(path.join(root, 'src-tauri/capabilities/pet.json'), 'utf8').includes('allow-diagnose-agent'));
if (failures.length) {
  console.error(`FAIL ${failures.length}/${pass.length + failures.length}`);
  for (const item of failures) console.error(`- ${item}`);
  process.exit(1);
}
console.log(`PASS ${pass.length}/${pass.length}`);
for (const item of pass) console.log(`- ${item}`);
