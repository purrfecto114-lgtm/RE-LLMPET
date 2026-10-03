use serde::{Deserialize, Serialize};

/// Built-in provider IDs — single source of truth.
pub const BUILTIN_PROVIDER_IDS: &[&str] =
    &["claude", "codewhale", "codex", "opencode", "aider", "dsh"];

/// UI metadata for custom providers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomUiMetadata {
    pub icon: Option<String>,
    pub color: Option<String>,
}

/// Custom provider launch specification — user-defined, validated at config time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderSpec {
    /// Unique provider ID (alphanumeric + hyphen, max 32 chars)
    pub id: String,
    /// Human-readable label
    pub label: String,
    /// CLI executable name or absolute path (no shell expansion)
    pub command: String,
    /// Optional companion executable
    #[serde(default)]
    pub companion: Option<String>,
    /// Arguments passed to the executable (no shell metacharacters)
    #[serde(default)]
    pub args: Vec<String>,
    /// Whether this provider installs hooks (requires hook protocol compatibility)
    #[serde(default)]
    pub install_hooks: bool,
    /// Whether to include in usage metering
    #[serde(default)]
    pub metering: bool,
    /// Whether to use external permission bridge
    #[serde(default)]
    pub permission_bridge: bool,
    /// UI metadata (optional, fallback to generic)
    #[serde(default)]
    pub ui_metadata: Option<CustomUiMetadata>,
}

/// Validate a provider ID against built-in and custom provider IDs.
/// R51: superseded by provider_registry::validate_provider_ids for the
/// active call path; kept as the config-level primitive.
#[allow(dead_code)]
pub fn validate_provider_id(id: &str, custom_ids: &[String]) -> bool {
    let id_lower = id.trim().to_lowercase();
    if id_lower.is_empty() {
        return false;
    }
    BUILTIN_PROVIDER_IDS.contains(&id_lower.as_str()) || custom_ids.iter().any(|c| c == &id_lower)
}

/// Validate and filter a list of provider IDs against built-in and custom providers.
pub fn validate_provider_ids(ids: Vec<String>, custom_ids: &[String]) -> Vec<String> {
    let custom_set: std::collections::HashSet<_> = custom_ids.iter().cloned().collect();
    let mut seen = std::collections::HashSet::new();
    ids.into_iter()
        .map(|id| id.trim().to_lowercase())
        .filter(|id| !id.is_empty())
        .filter(|id| {
            (BUILTIN_PROVIDER_IDS.contains(&id.as_str()) || custom_set.contains(id))
                && seen.insert(id.clone())
        })
        .collect()
}

/// Validate custom provider specs.
pub fn validate_custom_provider_specs(specs: &mut Vec<CustomProviderSpec>) -> Vec<String> {
    let mut errors = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    let builtin_set: std::collections::HashSet<_> = BUILTIN_PROVIDER_IDS.iter().copied().collect();

    for spec in specs.iter_mut() {
        let id_lower = spec.id.trim().to_lowercase();
        spec.id = id_lower.clone();

        // Validate ID format
        if id_lower.is_empty() || id_lower.len() > 32 {
            errors.push(format!(
                "Provider '{}': ID must be 1-32 characters",
                spec.id
            ));
            continue;
        }
        if !id_lower
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            errors.push(format!(
                "Provider '{}': ID must be alphanumeric or hyphen",
                spec.id
            ));
            continue;
        }
        // Check conflict with built-in
        if builtin_set.contains(id_lower.as_str()) {
            errors.push(format!(
                "Provider '{}': ID conflicts with built-in provider",
                spec.id
            ));
            continue;
        }
        // Check duplicate
        if !seen_ids.insert(id_lower.clone()) {
            errors.push(format!("Provider '{}': duplicate ID", spec.id));
            continue;
        }
        // Validate command
        if spec.command.is_empty() {
            errors.push(format!("Provider '{}': command is required", spec.id));
            continue;
        }
        if spec
            .command
            .chars()
            .any(|c| matches!(c, '|' | '&' | ';' | '$' | '`' | '(' | ')' | '<' | '>'))
        {
            errors.push(format!(
                "Provider '{}': command contains invalid characters",
                spec.id
            ));
            continue;
        }
        // Validate label
        if spec.label.is_empty() || spec.label.len() > 64 {
            errors.push(format!(
                "Provider '{}': label must be 1-64 characters",
                spec.id
            ));
            continue;
        }
        // Validate args
        for arg in &spec.args {
            if arg
                .chars()
                .any(|c| matches!(c, '|' | '&' | ';' | '$' | '`' | '(' | ')' | '<' | '>'))
            {
                errors.push(format!(
                    "Provider '{}': args contain invalid characters",
                    spec.id
                ));
                break;
            }
        }
    }

    // Deduplicate by ID (keep first)
    let mut seen = std::collections::HashSet::new();
    specs.retain(|s| seen.insert(s.id.clone()));

    errors
}
