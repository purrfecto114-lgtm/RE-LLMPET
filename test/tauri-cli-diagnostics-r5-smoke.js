"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const commands = read("src-tauri/src/commands.rs");
const hooks = read("src-tauri/src/hook_install.rs");
const ps = read("scripts/windows-cli-diagnostics.ps1");
const panelHtml = read("frontend/renderer/panel.html");
const panelJs = read("frontend/renderer/panel.js");
const panelCss = read("frontend/renderer/panel.css");
const bridge = read("frontend/renderer/tauri-bridge.js");
const i18n = read("frontend/shared/i18n.js");

const checks = [
  ["CodeWhale explicit config env is honored by diagnostics", commands.includes('var_os("CODEWHALE_CONFIG_PATH")') && commands.includes('var_os("DEEPSEEK_CONFIG_PATH")')],
  ["CodeWhale legacy config fallback is reported", commands.includes('join(".deepseek").join("config.toml")') && commands.includes('"legacy-fallback"')],
  ["Hook installation uses the same config precedence", hooks.includes('var_os("CODEWHALE_CONFIG_PATH")') && hooks.includes('var_os("DEEPSEEK_CONFIG_PATH")') && hooks.includes('join(".deepseek").join("config.toml")')],
  ["Windows evidence script uses the same config precedence", ps.includes('$env:DEEPSEEK_CONFIG_PATH') && ps.includes("'.deepseek\\config.toml'")],
  ["Windows evidence output is bounded and redacted", ps.includes("function Protect-DiagnosticText") && ps.includes("api[_-]?key") && ps.includes("$raw.Length -gt $Limit")],
  ["Windows evidence script probes Claude doctor", ps.includes("$claudeDoctor") && ps.includes("-Arguments @('doctor')")],
  ["Claude official doctor is probed", commands.includes('"claude" => (') && commands.includes('&["doctor"]')],
  ["CodeWhale JSON doctor has companion-first dispatcher fallback", commands.includes('fn codewhale_doctor_probe') && commands.includes('surface: Some("companion")') && commands.includes('surface: Some("dispatcher")') && commands.includes('doctorTarget')],
  ["CodeWhale compatibility scan never returns config contents", commands.includes('fn codewhale_config_compatibility') && commands.includes('legacyModelIds') && commands.includes('deprecatedTlsBypass') && !commands.includes('"configContents"')],
  ["probe output is bounded and redacted", commands.includes('fn redact_sensitive_line') && commands.includes('"api_key"') && commands.includes('.take(8192)')],
  ["diagnostics expose executable kind", commands.includes('fn executable_kind') && commands.includes('"executableKind"')],
  ["diagnostics stay inside the existing panel", panelHtml.includes('id="provider-diagnostic"') && !fs.existsSync(path.join(root, "frontend", "renderer", "diagnostics.html"))],
  ["provider rows expose a diagnose action", panelJs.includes('class="prov-diagnose"') && panelJs.includes('async function diagnoseProvider')],
  ["panel can rerun and launch with visible errors", panelJs.includes("data-diag-action=\"rerun\"") && panelJs.includes('launchAgentChecked') && panelJs.includes('renderProviderDiagnosticError')],
  ["checked launch returns a Promise", bridge.includes("launchAgentChecked: (provider) => call('launch_agent'" )],
  ["diagnostic UI has bounded scrolling styles", panelCss.includes('.diag-details pre') && panelCss.includes('max-height: 180px')],
  ["diagnostic labels exist in all three locales", (i18n.match(/'diag\.action':/g) || []).length === 3 && (i18n.match(/'diag\.doctor':/g) || []).length === 3 && (i18n.match(/'diag\.warnings':/g) || []).length === 3],
  ["diagnostic UI distinguishes warnings from hard failures", panelJs.includes('result.warnings') && panelJs.includes('diag-warnings') && panelCss.includes('.diag-warnings')],
];

for (const [name, ok] of checks) assert(ok, name);
console.log(`tauri-cli-diagnostics-r5-smoke: ok (${checks.length} checks)`);
