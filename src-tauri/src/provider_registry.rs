use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Provider capability flags — declarative, no hidden magic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityFlags {
    /// Provider installs and uses native hooks (Claude, CodeWhale, Codex, OpenCode, Aider)
    pub hook: bool,
    /// Provider is a passive observer reading session logs (e.g., dsh)
    pub observer: bool,
    /// Provider can be launched via `launch_agent` (has CLI executable)
    pub launch: bool,
    /// Provider contributes to usage metering / cost estimation
    pub metering: bool,
    /// Provider uses external permission bridge (needs /permission endpoint)
    pub permission_bridge: bool,
    /// Provider requires trust review before first hook install
    pub trust_review: bool,
    /// Provider supports subagent/delegation tracking
    pub subagent: bool,
}

impl Default for CapabilityFlags {
    fn default() -> Self {
        Self {
            hook: false,
            observer: false,
            launch: false,
            metering: false,
            permission_bridge: false,
            trust_review: false,
            subagent: false,
        }
    }
}

/// Permission mode for hook / external permission handling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    /// External permission via HTTP bridge (Claude, Codex)
    External,
    /// External permission after user grants trust (CodeWhale v4)
    ExternalAfterTrust,
    /// Observe native permission UI only, no bridge (Aider, OpenCode, dsh)
    ObserveNative,
    /// Permission handled inside terminal, no external UI (fallback)
    TerminalNative,
}

/// Hook command format for installing provider hooks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HookCommandFormat {
    /// JSON config with marker blocks (Claude, Codex)
    JsonMarker,
    /// TOML config with marker blocks (CodeWhale, Aider)
    TomlMarker,
    /// JavaScript plugin file (OpenCode)
    JsPlugin,
    /// Custom format for built-in providers with special needs
    Custom,
}

/// Marker set for hook config file installation.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MarkerSet {
    /// Marker string that begins the managed block
    pub begin: String,
    /// Marker string that ends the managed block
    pub end: String,
    /// Legacy marker variants for migration cleanup
    #[serde(default)]
    pub legacy: Vec<String>,
}

/// Diagnostic probe definitions for `diagnose_agent`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticProbes {
    /// Command to get provider version (e.g., "claude --version")
    #[serde(default)]
    pub version_cmd: Option<Vec<String>>,
    /// Doctor/health check command (e.g., "codewhale doctor --json")
    #[serde(default)]
    pub doctor_cmd: Option<Vec<String>>,
    /// Authentication status probe
    #[serde(default)]
    pub auth_cmd: Option<Vec<String>>,
    /// Config validation probe
    #[serde(default)]
    pub config_cmd: Option<Vec<String>>,
}

/// Metering adapter specification.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MeteringAdapter {
    /// Module path for transcript parsing
    #[serde(default)]
    pub transcript_parser: Option<String>,
    /// Module path for hook event parsing
    #[serde(default)]
    pub hook_parser: Option<String>,
    /// Pricing module identifier
    #[serde(default)]
    pub pricing_module: Option<String>,
}

/// UI metadata for frontend rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiMetadata {
    /// Icon identifier (CSS class, SVG path, or emoji fallback)
    pub icon: String,
    /// Human-readable label
    pub label: String,
    /// Accent color for UI (hex string)
    pub color: String,
    /// i18n key prefix (e.g., "tray.launchClaude" -> "tray.launch")
    pub i18n_prefix: String,
}

/// Core provider specification — single source of truth for all provider behavior.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSpec {
    /// Unique provider ID (e.g., "claude", "codewhale", "dsh", "my-custom-agent")
    pub id: String,
    /// Human-readable title
    pub title: String,
    /// CLI executable name (e.g., "claude", "codewhale", "codex", "opencode", "aider", "dsh")
    pub command: String,
    /// Companion executable for TUI/GUI detection
    #[serde(default)]
    pub companion: Option<String>,
    /// Config file path (resolved at runtime)
    #[serde(default)]
    pub config_path: String,
    /// Lifecycle events to hook into
    #[serde(default)]
    pub events: Vec<String>,
    /// Marker set for hook config
    #[serde(default)]
    pub markers: MarkerSet,
    /// Permission mode for external permission handling
    pub permission_mode: PermissionMode,
    /// Capability flags
    pub capabilities: CapabilityFlags,
    /// Hook command format
    pub hook_command_format: HookCommandFormat,
    /// Environment variable prefixes for fallback resolution
    #[serde(default)]
    pub env_var_prefixes: Vec<String>,
    /// Metering adapter
    #[serde(default)]
    pub metering: MeteringAdapter,
    /// Diagnostic probes
    #[serde(default)]
    pub diagnostic_probes: DiagnosticProbes,
    /// UI metadata
    pub ui_metadata: UiMetadata,
}

/// Provider registry — centralizes all provider knowledge.
pub struct ProviderRegistry {
    builtin: HashMap<String, ProviderSpec>,
    custom: HashMap<String, ProviderSpec>,
}

impl ProviderRegistry {
    /// Create a new registry with built-in providers and optional custom providers.
    pub fn new(custom_specs: Vec<crate::config_types::CustomProviderSpec>) -> Self {
        let mut registry = Self {
            builtin: Self::builtin_specs(),
            custom: HashMap::new(),
        };
        for spec in custom_specs {
            if let Some(prov_spec) = registry.custom_spec_to_provider_spec(spec) {
                registry.custom.insert(prov_spec.id.clone(), prov_spec);
            }
        }
        registry
    }

    /// Get a provider spec by ID (checks custom first, then built-in).
    pub fn get(&self, id: &str) -> Option<&ProviderSpec> {
        self.custom.get(id).or_else(|| self.builtin.get(id))
    }

    /// Check if a provider ID exists in the registry.
    pub fn contains(&self, id: &str) -> bool {
        self.custom.contains_key(id) || self.builtin.contains_key(id)
    }

    /// Get all provider IDs (built-in + custom).
    pub fn all_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.builtin.keys().cloned().collect();
        ids.extend(self.custom.keys().cloned());
        ids
    }

    /// Get all provider specs (built-in + custom).
    pub fn all_specs(&self) -> Vec<&ProviderSpec> {
        let mut specs: Vec<&ProviderSpec> = self.builtin.values().collect();
        specs.extend(self.custom.values());
        specs
    }

    /// Get only built-in provider IDs.
    pub fn builtin_ids(&self) -> Vec<String> {
        self.builtin.keys().cloned().collect()
    }

    /// Get provider specs that have the `hook` capability.
    pub fn hook_providers(&self) -> Vec<&ProviderSpec> {
        self.all_specs().into_iter().filter(|s| s.capabilities.hook).collect()
    }

    /// Get provider specs that have the `observer` capability.
    pub fn observer_providers(&self) -> Vec<&ProviderSpec> {
        self.all_specs().into_iter().filter(|s| s.capabilities.observer).collect()
    }

    /// Get provider specs that have the `launch` capability.
    pub fn launch_providers(&self) -> Vec<&ProviderSpec> {
        self.all_specs().into_iter().filter(|s| s.capabilities.launch).collect()
    }

    /// Get provider specs that have the `metering` capability.
    pub fn metering_providers(&self) -> Vec<&ProviderSpec> {
        self.all_specs().into_iter().filter(|s| s.capabilities.metering).collect()
    }

    /// Get provider specs that have the `permission_bridge` capability.
    pub fn permission_bridge_providers(&self) -> Vec<&ProviderSpec> {
        self.all_specs().into_iter().filter(|s| s.capabilities.permission_bridge).collect()
    }

    /// Convert custom spec to internal ProviderSpec.
    fn custom_spec_to_provider_spec(&self, spec: crate::config_types::CustomProviderSpec) -> Option<ProviderSpec> {
        // Validate ID: alphanumeric + hyphen, max 32 chars, not empty, not conflicting with built-in
        if spec.id.is_empty()
            || spec.id.len() > 32
            || !spec.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            || self.builtin.contains_key(&spec.id)
        {
            return None;
        }
        // Validate command: non-empty, no shell metacharacters
        if spec.command.is_empty()
            || spec.command.chars().any(|c| matches!(c, '|' | '&' | ';' | '$' | '`' | '(' | ')' | '<' | '>'))
        {
            return None;
        }
        // Validate label
        if spec.label.is_empty() || spec.label.len() > 64 {
            return None;
        }

        // Build a minimal ProviderSpec for custom providers
        let id = spec.id.clone();
        let label = spec.label.clone();
        let command = spec.command.clone();
        let companion = spec.companion.clone();
        let install_hooks = spec.install_hooks;
        let metering = spec.metering;
        let permission_bridge = spec.permission_bridge;
        let ui_metadata = spec.ui_metadata.clone();

        Some(ProviderSpec {
            id: id.clone(),
            title: label.clone(),
            command: command.clone(),
            companion,
            config_path: String::new(),
            events: vec![],
            markers: MarkerSet {
                begin: format!("# octopus:{}-hooks:begin", id),
                end: format!("# octopus:{}-hooks:end", id),
                legacy: vec![],
            },
            permission_mode: if permission_bridge {
                PermissionMode::External
            } else {
                PermissionMode::ObserveNative
            },
            capabilities: CapabilityFlags {
                hook: install_hooks,
                observer: true,
                launch: true,
                metering,
                permission_bridge,
                trust_review: false,
                subagent: false,
            },
            hook_command_format: HookCommandFormat::Custom,
            env_var_prefixes: vec![],
            metering: MeteringAdapter {
                transcript_parser: None,
                hook_parser: None,
                pricing_module: None,
            },
            diagnostic_probes: DiagnosticProbes {
                version_cmd: Some(vec![command.clone(), "--version".to_string()]),
                doctor_cmd: None,
                auth_cmd: None,
                config_cmd: None,
            },
            ui_metadata: UiMetadata {
                icon: ui_metadata.as_ref().and_then(|u| u.icon.clone()).unwrap_or_else(|| "⬦".to_string()),
                label,
                color: ui_metadata.as_ref().and_then(|u| u.color.clone()).unwrap_or_else(|| "#8a8a8e".to_string()),
                i18n_prefix: format!("custom.{}", id),
            },
        })
    }

    /// Built-in provider specifications — exact mirror of current hardcoded behavior.
    fn builtin_specs() -> HashMap<String, ProviderSpec> {
        let mut map = HashMap::new();

        // Helper to create config path
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));

        // Claude Code
        map.insert(
            "claude".to_string(),
            ProviderSpec {
                id: "claude".to_string(),
                title: "Claude Code".to_string(),
                command: "claude".to_string(),
                companion: None,
                config_path: home.join(".claude").join("settings.json").to_string_lossy().to_string(),
                events: vec![
                    "PreToolUse".to_string(), "PostToolUse".to_string(), "UserPromptSubmit".to_string(), "Stop".to_string(),
                    "Notification".to_string(), "PreCompact".to_string(), "SubagentStart".to_string(), "SubagentStop".to_string()
                ],
                markers: MarkerSet {
                    begin: "# octopus:claude-hooks:begin".to_string(),
                    end: "# octopus:claude-hooks:end".to_string(),
                    legacy: vec!["# re-llmpet-hooks:begin".to_string(), "# re-llmpet-hooks:end".to_string()],
                },
                permission_mode: PermissionMode::External,
                capabilities: CapabilityFlags {
                    hook: true,
                    observer: true,
                    launch: true,
                    metering: true,
                    permission_bridge: true,
                    trust_review: false,
                    subagent: true,
                },
                hook_command_format: HookCommandFormat::JsonMarker,
                env_var_prefixes: vec!["CLAUDE_".to_string()],
                metering: MeteringAdapter {
                    transcript_parser: Some("crate::metering::parse_claude_assistant".to_string()),
                    hook_parser: Some("crate::metering::parse_hook".to_string()),
                    pricing_module: Some("codex".to_string()),
                },
                diagnostic_probes: DiagnosticProbes {
                    version_cmd: Some(vec!["claude".to_string(), "--version".to_string()]),
                    doctor_cmd: None,
                    auth_cmd: Some(vec!["claude".to_string(), "auth".to_string(), "status".to_string()]),
                    config_cmd: Some(vec!["claude".to_string(), "config".to_string(), "list".to_string()]),
                },
                ui_metadata: UiMetadata {
                    icon: "🤖".to_string(),
                    label: "Claude Code".to_string(),
                    color: "#d97757".to_string(),
                    i18n_prefix: "tray.launchClaude".to_string(),
                },
            },
        );

        // CodeWhale
        map.insert(
            "codewhale".to_string(),
            ProviderSpec {
                id: "codewhale".to_string(),
                title: "CodeWhale".to_string(),
                command: "codewhale".to_string(),
                companion: Some("codewhale-tui".to_string()),
                config_path: home.join(".config").join("codewhale").join("config.toml").to_string_lossy().to_string(),
                events: vec![
                    "turn_start".to_string(), "turn_end".to_string(), "tool_call".to_string(), "tool_result".to_string(),
                    "user_message".to_string(), "assistant_message".to_string(), "approval_asked".to_string(), "approval_decided".to_string(),
                    "compaction_start".to_string(), "compaction_end".to_string()
                ],
                markers: MarkerSet {
                    begin: "# octopus:codewhale-hooks:v4".to_string(),
                    end: "# octopus:codewhale-hooks:end".to_string(),
                    legacy: vec!["# re-llmpet-hooks:begin".to_string(), "# re-llmpet-hooks:end".to_string()],
                },
                permission_mode: PermissionMode::ExternalAfterTrust,
                capabilities: CapabilityFlags {
                    hook: true,
                    observer: true,
                    launch: true,
                    metering: true,
                    permission_bridge: true,
                    trust_review: true,
                    subagent: true,
                },
                hook_command_format: HookCommandFormat::TomlMarker,
                env_var_prefixes: vec!["CODEWHALE_".to_string(), "DEEPSEEK_".to_string()],
                metering: MeteringAdapter {
                    transcript_parser: None,
                    hook_parser: Some("crate::metering::parse_hook".to_string()),
                    pricing_module: Some("codewhale".to_string()),
                },
                diagnostic_probes: DiagnosticProbes {
                    version_cmd: Some(vec!["codewhale".to_string(), "--version".to_string()]),
                    doctor_cmd: Some(vec!["codewhale".to_string(), "doctor".to_string(), "--json".to_string()]),
                    auth_cmd: Some(vec!["codewhale".to_string(), "auth".to_string(), "status".to_string()]),
                    config_cmd: Some(vec!["codewhale".to_string(), "config".to_string(), "list".to_string()]),
                },
                ui_metadata: UiMetadata {
                    icon: "🐋".to_string(),
                    label: "CodeWhale".to_string(),
                    color: "#00b4d8".to_string(),
                    i18n_prefix: "tray.launchCodewhale".to_string(),
                },
            },
        );

        // Codex (OpenAI)
        map.insert(
            "codex".to_string(),
            ProviderSpec {
                id: "codex".to_string(),
                title: "Codex".to_string(),
                command: "codex".to_string(),
                companion: None,
                config_path: home.join(".codex").join("hooks.json").to_string_lossy().to_string(),
                events: vec![
                    "session_start".to_string(), "turn_start".to_string(), "turn_end".to_string(), "tool_call".to_string(),
                    "tool_result".to_string(), "user_message".to_string(), "assistant_message".to_string(),
                    "pre_tool_use".to_string(), "post_tool_use".to_string(), "notification".to_string()
                ],
                markers: MarkerSet {
                    begin: "# octopus:codex-hooks:begin".to_string(),
                    end: "# octopus:codex-hooks:end".to_string(),
                    legacy: vec![],
                },
                permission_mode: PermissionMode::External,
                capabilities: CapabilityFlags {
                    hook: true,
                    observer: true,
                    launch: true,
                    metering: true,
                    permission_bridge: true,
                    trust_review: false,
                    subagent: true,
                },
                hook_command_format: HookCommandFormat::JsonMarker,
                env_var_prefixes: vec!["CODEX_".to_string(), "OPENAI_".to_string()],
                metering: MeteringAdapter {
                    transcript_parser: Some("crate::metering::parse_codex_transcript".to_string()),
                    hook_parser: Some("crate::metering::parse_hook".to_string()),
                    pricing_module: Some("codex".to_string()),
                },
                diagnostic_probes: DiagnosticProbes {
                    version_cmd: Some(vec!["codex".to_string(), "--version".to_string()]),
                    doctor_cmd: Some(vec!["codex".to_string(), "doctor".to_string(), "--json".to_string()]),
                    auth_cmd: Some(vec!["codex".to_string(), "auth".to_string(), "status".to_string()]),
                    config_cmd: Some(vec!["codex".to_string(), "config".to_string(), "list".to_string()]),
                },
                ui_metadata: UiMetadata {
                    icon: "💻".to_string(),
                    label: "Codex".to_string(),
                    color: "#00d4aa".to_string(),
                    i18n_prefix: "tray.launchCodex".to_string(),
                },
            },
        );

        // OpenCode
        map.insert(
            "opencode".to_string(),
            ProviderSpec {
                id: "opencode".to_string(),
                title: "OpenCode".to_string(),
                command: "opencode".to_string(),
                companion: None,
                config_path: home.join(".config").join("opencode").join("plugins").join("llmpet-hook.js").to_string_lossy().to_string(),
                events: vec![
                    "PreToolUse".to_string(), "PostToolUse".to_string(), "UserPromptSubmit".to_string(), "Stop".to_string(),
                    "Notification".to_string(), "SubagentStart".to_string(), "SubagentStop".to_string()
                ],
                markers: MarkerSet {
                    begin: "// octopus:opencode-hooks:begin".to_string(),
                    end: "// octopus:opencode-hooks:end".to_string(),
                    legacy: vec![],
                },
                permission_mode: PermissionMode::ObserveNative,
                capabilities: CapabilityFlags {
                    hook: true,
                    observer: true,
                    launch: true,
                    metering: false,
                    permission_bridge: false,
                    trust_review: false,
                    subagent: true,
                },
                hook_command_format: HookCommandFormat::JsPlugin,
                env_var_prefixes: vec!["OPENCODE_".to_string()],
                metering: MeteringAdapter {
                    transcript_parser: None,
                    hook_parser: None,
                    pricing_module: None,
                },
                diagnostic_probes: DiagnosticProbes {
                    version_cmd: Some(vec!["opencode".to_string(), "--version".to_string()]),
                    doctor_cmd: None,
                    auth_cmd: None,
                    config_cmd: None,
                },
                ui_metadata: UiMetadata {
                    icon: "🔓".to_string(),
                    label: "OpenCode".to_string(),
                    color: "#6366f1".to_string(),
                    i18n_prefix: "tray.launchOpencode".to_string(),
                },
            },
        );

        // Aider
        map.insert(
            "aider".to_string(),
            ProviderSpec {
                id: "aider".to_string(),
                title: "Aider".to_string(),
                command: "aider".to_string(),
                companion: None,
                config_path: home.join(".aider.conf.yml").to_string_lossy().to_string(),
                events: vec![
                    "turn_start".to_string(), "turn_end".to_string(), "tool_call".to_string(), "tool_result".to_string()
                ],
                markers: MarkerSet {
                    begin: "# octopus:aider-hooks:begin".to_string(),
                    end: "# octopus:aider-hooks:end".to_string(),
                    legacy: vec![],
                },
                permission_mode: PermissionMode::TerminalNative,
                capabilities: CapabilityFlags {
                    hook: true,
                    observer: true,
                    launch: true,
                    metering: false,
                    permission_bridge: false,
                    trust_review: false,
                    subagent: false,
                },
                hook_command_format: HookCommandFormat::TomlMarker,
                env_var_prefixes: vec!["AIDER_".to_string()],
                metering: MeteringAdapter {
                    transcript_parser: None,
                    hook_parser: None,
                    pricing_module: None,
                },
                diagnostic_probes: DiagnosticProbes {
                    version_cmd: Some(vec!["aider".to_string(), "--version".to_string()]),
                    doctor_cmd: None,
                    auth_cmd: None,
                    config_cmd: None,
                },
                ui_metadata: UiMetadata {
                    icon: "🤝".to_string(),
                    label: "Aider".to_string(),
                    color: "#f59e0b".to_string(),
                    i18n_prefix: "tray.launchAider".to_string(),
                },
            },
        );

        // dsh (DeepSeek Harness) — passive observer, no hooks, no metering
        map.insert(
            "dsh".to_string(),
            ProviderSpec {
                id: "dsh".to_string(),
                title: "DeepSeek Harness".to_string(),
                command: "dsh".to_string(),
                companion: Some("dsh".to_string()),
                config_path: std::env::var("DSH_HOME")
                    .ok()
                    .map(PathBuf::from)
                    .or_else(|| Some(home.join(".dsh")))
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                events: vec![
                    "turn_start".to_string(), "turn_end".to_string(), "tool_call".to_string(), "tool_result".to_string(),
                    "user_message".to_string(), "assistant_message".to_string(), "approval_asked".to_string(), "approval_decided".to_string(),
                    "compaction_start".to_string(), "compaction_end".to_string(), "session_title".to_string()
                ],
                markers: MarkerSet {
                    begin: "# octopus:dsh-hooks:begin".to_string(),
                    end: "# octopus:dsh-hooks:end".to_string(),
                    legacy: vec![],
                },
                permission_mode: PermissionMode::ObserveNative,
                capabilities: CapabilityFlags {
                    hook: false,
                    observer: true,
                    launch: true,
                    metering: false,
                    permission_bridge: false,
                    trust_review: false,
                    subagent: true,
                },
                hook_command_format: HookCommandFormat::Custom,
                env_var_prefixes: vec!["DSH_".to_string()],
                metering: MeteringAdapter {
                    transcript_parser: None,
                    hook_parser: None,
                    pricing_module: None,
                },
                diagnostic_probes: DiagnosticProbes {
                    version_cmd: Some(vec!["dsh".to_string(), "--version".to_string()]),
                    doctor_cmd: None,
                    auth_cmd: None,
                    config_cmd: None,
                },
                ui_metadata: UiMetadata {
                    icon: "🌊".to_string(),
                    label: "DeepSeek Harness".to_string(),
                    color: "#00b4d8".to_string(),
                    i18n_prefix: "tray.launchDsh".to_string(),
                },
            },
        );

map
    }
}
/// Global registry instance — initialized at startup from config.
static mut REGISTRY: Option<ProviderRegistry> = None;

/// Initialize the global registry from custom provider specs.
pub fn init_registry(custom_specs: Vec<crate::config_types::CustomProviderSpec>) {
    unsafe {
        REGISTRY = Some(ProviderRegistry::new(custom_specs));
    }
}

/// Get the global registry instance.
pub fn registry() -> &'static ProviderRegistry {
    unsafe {
        REGISTRY.as_ref().expect("Provider registry not initialized")
    }
}

/// Validate a list of provider IDs against the registry.
pub fn validate_provider_ids(ids: &[String]) -> Vec<String> {
    let reg = registry();
    ids.iter()
        .map(|id| id.trim().to_lowercase())
        .filter(|id| !id.is_empty() && reg.contains(id))
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect()
}

/// Get the default pet agent from config (first non-codex provider, or first available).
pub fn default_pet_agent(active: &[String]) -> String {
    let reg = registry();
    for id in active {
        if let Some(spec) = reg.get(id) {
            if spec.id != "codex" {
                return spec.id.to_string();
            }
        }
    }
    active.first().cloned().unwrap_or_else(|| "claude".to_string())
}

/// Get all providers with hook capability (for hook resync).
pub fn hook_provider_ids() -> Vec<String> {
    registry().hook_providers().iter().map(|s| s.id.clone()).collect()
}

/// Get all providers with observer capability.
pub fn observer_provider_ids() -> Vec<String> {
    registry().observer_providers().iter().map(|s| s.id.clone()).collect()
}

/// Get all providers with launch capability.
pub fn launch_provider_ids() -> Vec<String> {
    registry().launch_providers().iter().map(|s| s.id.clone()).collect()
}

/// Get provider spec for CLI commands.
pub fn get_provider_spec(id: &str) -> Option<&ProviderSpec> {
    registry().get(id)
}