//! Codex (OpenAI) pricing — mirror of `metering.rs`'s Claude pricing table.
//!
//! Codex rollouts report `last_token_usage` as `{ input_tokens, cached_input_tokens,
//! output_tokens, reasoning_output_tokens }`. OpenAI bills three rates:
//!   - fresh input  = input_tokens - cached_input_tokens   (cached is a SUBSET)
//!   - cached input = cached_input_tokens                  (model-specific rate)
//!   - output       = output_tokens                        (reasoning is a SUBSET)
//!
//! Adding cached input or reasoning output on top would double-bill them, which is
//! why both are tracked separately but never summed into the charged base.
//!
//! Priority: user override (`~/.re-llmpet/pricing.json`, `codexModels` map)
//! > synced cache (models.dev `openaiModels`) > built-ins below.
//!
//! R10 backport: ported from upstream `backend/codex-pricing.js` (162 lines).

use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

/// USD per 1,000,000 tokens. Keyword tiers are the last-resort fallback for a
/// model id the sync has never seen; exact ids come from models.dev at runtime.
#[derive(Clone, Debug)]
pub struct CodexPriceRow {
    pub input: f64,
    pub cached_input: f64,
    pub output: f64,
    pub context_window: Option<u64>,
}

/// Default tier pricing (fallback when model id is unknown).
fn default_codex_pricing() -> HashMap<&'static str, CodexPriceRow> {
    let mut m = HashMap::new();
    m.insert(
        "pro",
        CodexPriceRow {
            input: 30.0,
            cached_input: 30.0,
            output: 180.0,
            context_window: None,
        },
    );
    m.insert(
        "codex",
        CodexPriceRow {
            input: 1.75,
            cached_input: 0.175,
            output: 14.0,
            context_window: None,
        },
    );
    m.insert(
        "mini",
        CodexPriceRow {
            input: 0.75,
            cached_input: 0.075,
            output: 4.5,
            context_window: None,
        },
    );
    m.insert(
        "nano",
        CodexPriceRow {
            input: 0.2,
            cached_input: 0.02,
            output: 1.2,
            context_window: None,
        },
    );
    m.insert(
        "default",
        CodexPriceRow {
            input: 5.0,
            cached_input: 0.5,
            output: 30.0,
            context_window: None,
        },
    );
    m
}

/// Built-in exact prices so a first run (or an offline machine) still bills the
/// models Codex actually ships with, instead of falling back to the tier guess.
fn builtin_codex_models() -> HashMap<&'static str, CodexPriceRow> {
    let mut m = HashMap::new();
    let entries: &[(&str, f64, f64, f64)] = &[
        ("gpt-5.6", 5.0, 0.5, 30.0),
        ("gpt-5.6-sol", 5.0, 0.5, 30.0),
        ("gpt-5.6-terra", 2.0, 0.2, 12.0),
        ("gpt-5.6-luna", 0.2, 0.02, 1.2),
        ("gpt-5.5", 5.0, 0.5, 30.0),
        ("gpt-5.5-pro", 30.0, 30.0, 180.0),
        ("gpt-5.4", 2.5, 0.25, 15.0),
        ("gpt-5.4-pro", 30.0, 30.0, 180.0),
        ("gpt-5.3-codex", 1.75, 0.175, 14.0),
        ("gpt-5.2-codex", 1.75, 0.175, 14.0),
        ("gpt-5.1-codex", 1.25, 0.125, 10.0),
        ("gpt-5-codex", 1.25, 0.125, 10.0),
        ("gpt-5", 1.25, 0.125, 10.0),
    ];
    for &(id, input, cached, output) in entries {
        m.insert(
            id,
            CodexPriceRow {
                input,
                cached_input: cached,
                output,
                context_window: None,
            },
        );
    }
    m
}

/// Internal profile ids that have no public price (guardian/auto-review subagent).
/// These stay OUT of the exact table on purpose so `price_for_codex()` reports
/// them as estimates.
fn internal_profile_ids() -> &'static [&'static str] {
    &["codex-auto-review", "unknown"]
}

/// Normalize an OpenAI/Codex model name: lowercase, drop any provider/region
/// prefix (openai/, azure/global/, openrouter/openai/) and the dated suffix
/// models.dev appends (gpt-5.5-2026-04-23 → gpt-5.5).
pub fn norm_codex_model_name(model: &str) -> String {
    let s = model.to_ascii_lowercase();
    let s = s.split(':').next().unwrap_or("").trim();
    if s.is_empty() {
        return String::new();
    }
    let bare = s.rsplit('/').next().unwrap_or(s);
    // Strip -YYYY-MM-DD or -YYYYMMDD suffix
    let bare = if let Some(idx) = bare.rfind("-20") {
        let suffix = &bare[idx + 1..];
        if suffix.len() == 10 && suffix.chars().filter(|c| *c == '-').count() == 2 {
            &bare[..idx]
        } else if suffix.len() == 8 && suffix.chars().all(|c| c.is_ascii_digit()) {
            &bare[..idx]
        } else {
            bare
        }
    } else {
        bare
    };
    bare.to_string()
}

/// Resolve a price row. `exact` is false when the id was never in the table —
/// the caller surfaces that as "billed at an estimated rate" in diagnostics
/// rather than silently presenting a guess as a real number.
pub fn price_for_codex(model: &str) -> (CodexPriceRow, bool) {
    static CACHE: OnceLock<HashMap<String, CodexPriceRow>> = OnceLock::new();
    let models = CACHE.get_or_init(|| {
        let mut m: HashMap<String, CodexPriceRow> = HashMap::new();
        // Layer 1: built-in exact prices (offline fallback)
        for (id, row) in builtin_codex_models() {
            m.insert(id.to_string(), row.clone());
        }
        // R12 backport: Layer 2 — synced openai models from models.dev cache.
        // The pricing-cache.models-dev.json file contains entries for openai
        // models (gpt-5.x series) with cache_read = cached_input rate.
        // This is the equivalent of upstream's _extractOpenAIModels.
        if let Ok(catalog) = std::fs::read_to_string(
            std::env::var("HOME")
                .map(|h| std::path::Path::new(&h).join(".re-llmpet"))
                .unwrap_or_else(|_| std::path::PathBuf::from("~/.re-llmpet"))
                .join("pricing-cache.models-dev.json"),
        ) {
            if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&catalog) {
                if let Some(entries) = doc.get("entries").and_then(|v| v.as_object()) {
                    for (id, entry) in entries.iter() {
                        let input = entry.get("input_usd_per_million").and_then(|v| v.as_f64());
                        let output = entry.get("output_usd_per_million").and_then(|v| v.as_f64());
                        if input.is_none() && output.is_none() {
                            continue;
                        }
                        // For Codex: cache_read = cached_input rate.
                        // Pro models have cached_input = input (no discount);
                        // standard models use 10% of input when cache_read is missing.
                        let cached_input = entry
                            .get("cache_read_usd_per_million")
                            .and_then(|v| v.as_f64())
                            .unwrap_or_else(|| {
                                let inp = input.unwrap_or(0.0);
                                if id.contains("-pro") {
                                    inp
                                } else {
                                    inp * 0.1
                                }
                            });
                        let normed = norm_codex_model_name(id);
                        if !normed.is_empty() {
                            m.insert(
                                normed,
                                CodexPriceRow {
                                    input: input.unwrap_or(0.0),
                                    cached_input,
                                    output: output.unwrap_or(0.0),
                                    context_window: entry
                                        .get("context_window")
                                        .and_then(|v| v.as_u64()),
                                },
                            );
                        }
                    }
                }
            }
        }
        m
    });

    let id = norm_codex_model_name(model);
    if !id.is_empty() && models.contains_key(&id) && !internal_profile_ids().contains(&id.as_str())
    {
        return (models[&id].clone(), true);
    }

    // Tier fallback
    let tier = if id.contains("-pro") {
        "pro"
    } else if id.contains("nano") {
        "nano"
    } else if id.contains("mini") {
        "mini"
    } else if id.contains("codex") {
        "codex"
    } else {
        "default"
    };
    let defaults = default_codex_pricing();
    (defaults[tier].clone(), false)
}

/// Cost of one usage delta. Cached input is discounted, not additive; reasoning
/// output is already inside output_tokens and is never charged twice.
///
/// Returns USD cost (not per-million).
pub fn codex_usage_cost(input: u64, cached_input: u64, output: u64, price: &CodexPriceRow) -> f64 {
    let fresh_input = input.saturating_sub(cached_input.min(input)) as f64;
    let cached = cached_input as f64;
    let out = output as f64;
    (fresh_input * price.input + cached * price.cached_input + out * price.output) / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_strips_dated_suffix() {
        assert_eq!(norm_codex_model_name("gpt-5.5-2026-04-23"), "gpt-5.5");
        assert_eq!(norm_codex_model_name("gpt-5.5-20260423"), "gpt-5.5");
        assert_eq!(norm_codex_model_name("openai/gpt-5.5"), "gpt-5.5");
        assert_eq!(norm_codex_model_name("GPT-5.5-PRO"), "gpt-5.5-pro");
    }

    #[test]
    fn pro_model_uses_pro_tier() {
        let (price, exact) = price_for_codex("gpt-5.5-pro");
        assert!(exact);
        assert_eq!(price.input, 30.0);
        assert_eq!(price.cached_input, 30.0); // Pro: no cache discount
        assert_eq!(price.output, 180.0);
    }

    #[test]
    fn codex_model_uses_codex_tier() {
        let (price, exact) = price_for_codex("gpt-5.3-codex");
        assert!(exact);
        assert_eq!(price.input, 1.75);
        assert_eq!(price.cached_input, 0.175);
        assert_eq!(price.output, 14.0);
    }

    #[test]
    fn unknown_model_uses_default_tier_with_estimate_flag() {
        let (price, exact) = price_for_codex("some-unknown-model");
        assert!(!exact);
        assert_eq!(price.input, 5.0);
    }

    #[test]
    fn internal_profile_is_estimate() {
        let (_, exact) = price_for_codex("codex-auto-review");
        assert!(!exact);
    }

    #[test]
    fn cost_does_not_double_bill_cache() {
        // 1000 input, 800 cached → fresh = 200, cached = 800
        // cost = (200 * 1.75 + 800 * 0.175 + 500 * 14) / 1e6
        let price = CodexPriceRow {
            input: 1.75,
            cached_input: 0.175,
            output: 14.0,
            context_window: None,
        };
        let cost = codex_usage_cost(1000, 800, 500, &price);
        let expected = (200.0 * 1.75 + 800.0 * 0.175 + 500.0 * 14.0) / 1_000_000.0;
        assert!((cost - expected).abs() < 1e-12);
    }

    #[test]
    fn pro_cache_rate_is_full_input() {
        // Pro models: cachedInput = input rate (no 10% discount)
        let price = CodexPriceRow {
            input: 30.0,
            cached_input: 30.0,
            output: 180.0,
            context_window: None,
        };
        let cost = codex_usage_cost(1000, 1000, 0, &price);
        // All cached, so cost = 1000 * 30 / 1e6
        assert!((cost - 0.03).abs() < 1e-12);
    }
}
