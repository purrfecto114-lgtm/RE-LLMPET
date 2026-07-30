#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const commands = read('src-tauri/src/commands.rs');
const panel = read('frontend/renderer/panel.js');
const i18n = read('frontend/shared/i18n.js');

const checks = [
  ['probe capture preserves a separately parsed JSON document', commands.includes('struct ProbeCapture') && commands.includes('json: parsed_json')],
  ['structured diagnostic JSON is redacted recursively', commands.includes('fn redact_sensitive_json') && commands.includes('fn sanitized_probe_json')],
  ['CodeWhale api_key source survives without secret material', commands.includes('json!({"source": source})') && commands.includes('"api_key_value"')],
  ['CodeWhale doctor summary extracts route and migration fields', commands.includes('fn codewhale_doctor_summary') && commands.includes('"requestPayloadMode"') && commands.includes('"sessionRecovery"')],
  ['CodeWhale authentication status is probed', commands.includes('&["auth", "status"]')],
  ['Codex authentication status is probed', commands.includes('&["login", "status"]')],
  ['OpenCode authenticated providers are listed', commands.includes('&["auth", "list"]')],
  ['OpenCode zero-credential output is detected', commands.includes('fn opencode_auth_has_entries') && commands.includes('0 credentials')],
  ['authentication failures are warnings rather than installation failures', commands.includes('authentication status could not be confirmed') && commands.includes('warnings.push')],
  ['diagnostics expose auth and structured doctor summaries', commands.includes('"doctorSummary": doctor_summary') && commands.includes('"authProbe": auth')],
  ['OpenCode uses its provider-native directory argument', commands.includes('"opencode" => &["--dir", "."]')],
  ['Windows native and shim launch paths both receive provider arguments', commands.includes('cmd_launch_call(executable, launch_args)') && commands.includes('command.arg(executable).args(launch_args.iter().copied())')],
  ['Windows evidence script captures provider auth state', read('scripts/windows-cli-diagnostics.ps1').includes("@('login','status')") && read('scripts/windows-cli-diagnostics.ps1').includes("@('auth','list')")],
  ['macOS and Linux launch paths retain provider arguments', commands.includes('command.extend(agent_launch_args(spec)') && commands.includes('provider_args.iter().cloned()')],
  ['diagnostic UI displays authentication status', panel.includes("t('diag.authStatus')") && panel.includes('probeStatus(result.authProbe)')],
  ['diagnostic UI displays provider/model routing summaries', panel.includes("t('diag.providerRoute')") && panel.includes("t('diag.modelRoute')")],
  ['diagnostic UI keeps auth output in a bounded details region', panel.includes("t('diag.authOutput')") && panel.includes('class="diag-details"')],
  ['new auth labels exist in all three locales', (i18n.match(/'diag\.authStatus':/g) || []).length === 3 && (i18n.match(/'diag\.authOutput':/g) || []).length === 3],
  ['new routing labels exist in all three locales', (i18n.match(/'diag\.providerRoute':/g) || []).length === 3 && (i18n.match(/'diag\.apiKeySource':/g) || []).length === 3],
  ['R5 drag and DPI implementation remains present', commands.includes('pub fn commit_win_pos') && commands.includes('fn resize_pet_anchored')],
];

for (const [name, condition] of checks) assert(condition, name);
console.log(`tauri-cli-auth-r6-smoke: ok (${checks.length} checks)`);
