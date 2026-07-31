#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const commands = read('src-tauri/src/commands.rs');
const bridge = read('frontend/renderer/tauri-bridge.js');
const panel = read('frontend/renderer/panel.js');
const i18n = read('frontend/shared/i18n.js');
const ps = read('scripts/windows-cli-diagnostics.ps1');
const capability = read('src-tauri/capabilities/pet.json');

const checks = [
  ['CodeWhale doctor starts from the matched companion surface', commands.includes('codewhale_doctor_probe(') && commands.includes('"surface": "companion"')],
  ['CodeWhale doctor falls back to dispatcher only for command/schema drift', commands.includes('probe_indicates_unknown_command') && commands.includes('companion_is_definitive')],
  ['CodeWhale doctor attempts remain auditable', commands.includes('"doctorAttempts": doctor_attempts') && commands.includes('"parseableJson"')],
  ['CodeWhale config-validation JSON remains usable without fallback', commands.includes('if should_try_dispatcher') && commands.includes('companion_capture.take()')],
  ['Windows diagnostics mirror the companion-first fallback', ps.includes('$codewhaleDoctorAttempts') && ps.includes("surface = 'companion'") && ps.includes("surface = 'dispatcher'")],
  ['Windows diagnostics test both unknown command and JSON shape', ps.includes('Test-UnknownCommandProbe') && ps.includes('Test-ParseableJsonProbe')],
  ['project-level CodeWhale overlays are reported without returning contents', commands.includes('"projectOverlays"') && commands.includes('.codewhale").join("config.toml")') && !commands.includes('projectConfigContents')],
  ['simultaneous current and legacy project overlays produce a warning', commands.includes('Both .codewhale/config.toml and legacy .deepseek/config.toml exist')],
  ['Claude versions before the verified sleep/wake fix are warned, not blocked', commands.includes('version_is_older(&actual, "2.1.200")') && commands.includes('warnings.push(format!')],
  ['diagnostic WebView can no longer select arbitrary cwd', bridge.includes("diagnoseAgent: (provider) => call('diagnose_agent', { provider })") && !bridge.includes('cwd: cwd || null')],
  ['Rust diagnostic command no longer accepts cwd', (commands.includes('pub fn diagnose_agent(provider: String)') || commands.includes('pub async fn diagnose_agent(provider: String)')) && commands.includes('agent_working_directory(None)')],
  ['arbitrary cwd launch remains outside pet capability', !capability.includes('allow-launch-agent-in')],
  ['diagnostic UI shows doctor surface', panel.includes("t('diag.doctorSurface')")],
  ['diagnostic UI shows active project overlays', panel.includes("t('diag.projectConfig')") && panel.includes('configInfo.projectOverlays')],
  ['new labels exist in all three languages', (i18n.match(/'diag\.doctorSurface':/g) || []).length === 3 && (i18n.match(/'diag\.projectConfig':/g) || []).length === 3],
  ['Aider diagnostics report config paths and credential variable names without values', commands.includes('fn aider_configuration_summary') && commands.includes('credentialEnvironment') && !commands.includes('credentialEnvironmentValues')],
  ['Aider diagnostic UI is localized in all three languages', panel.includes("t('diag.configCandidates')") && panel.includes("t('diag.credentialHints')") && (i18n.match(/'diag\.configCandidates':/g) || []).length === 3 && (i18n.match(/'diag\.credentialHints':/g) || []).length === 3],
  ['Windows diagnostic script mirrors Aider non-secret discovery', ps.includes('$aiderConfigCandidates') && ps.includes('$aiderCredentialEnvironment') && !ps.includes('credentialEnvironmentValues')],
  ['OpenCode working-directory hardening remains intact', commands.includes('"opencode" => &["--dir", "."]')],
  ['Tauri click-through workaround remains native-state based', read('src-tauri/src/lib.rs').includes('start_cursor_hit_test') && commands.includes('platform_state.set_visual_bounds(&rect)')],
  ['DPI anchored resizing remains intact', commands.includes('fn resize_pet_anchored') && commands.includes('logical_to_physical')],
  ['visual asset CSP remains local-only', [read('frontend/renderer/panel.html'), read('frontend/renderer/pet.html')].every((html) => html.includes("img-src 'self' data:") && !/img-src[^;]*https?:/i.test(html))],
  ['offline static gate has a stable package command', JSON.parse(read('package.json')).scripts['check:static'] === 'python3 scripts/static-check.py && python3 scripts/rust-structure-smoke.py'],
];

for (const [name, ok] of checks) assert(ok, name);
console.log(`tauri-cli-resilience-r7-smoke: ok (${checks.length} checks)`);
