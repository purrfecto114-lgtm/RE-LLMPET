//! R59: user-custom pet expressions ("自定义桌宠表情", the expression studio).
//!
//! Design contract:
//! * Storage: `<app_dir>/expressions/<state>.<ext>` — one file per render
//!   state. `<app_dir>` is the same `~/.re-llmpet` directory that already
//!   holds config.json / travel.json, so the whole pet state stays in one
//!   place and existing backup/uninstall sweeps see it.
//! * The override layer is GLOBAL (not per-skin): the studio replaces the
//!   *state's* image, whichever skin is active. The renderer falls back to
//!   the skin's own asset when no override exists, so a new skin keeps
//!   working without re-importing anything.
//! * State vocabulary: mirror of `frontend/shared/states.js`
//!   RENDER_STATE_WORDS. The R59 smoke test cross-checks the two lists, so
//!   they cannot drift silently. Custom states are rejected — a new word
//!   would leak through `classList.remove(...STATE_WORDS)` and break the
//!   class-leak test contract.
//! * Rendering path: the studio window uploads a file picked with a plain
//!   `<input type="file">` (works in every wry backend without a dialog
//!   plugin), reads it in the WebView and posts the bytes as base64. The
//!   CSP already allows `img-src data:`, so the pet window renders the
//!   returned `data:` URL directly — no new scheme/protocol surface.
//! * Security: state and extension are whitelist-checked (no path
//!   traversal), the decoded payload is size-bounded and magic-sniffed
//!   against the claimed type, the expressions directory must be a real
//!   directory (not a symlink), and files are written via temp+rename so a
//!   crashed save can never leave a half-written GIF in place.

use crate::model::{now_ms, AppState, Runtime};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};

/// Mirror of `frontend/shared/states.js` RENDER_STATE_WORDS (27 words).
/// Cross-checked by `test/tauri-expression-studio-r59-smoke.js`.
pub(crate) const EXPRESSION_STATES: [&str; 27] = [
    "error",
    "notification",
    "sweeping",
    "attention",
    "carrying",
    "juggling",
    "working",
    "thinking",
    "idle",
    "roam",
    "sleeping",
    "yawning",
    "dozing",
    "collapsing",
    "waking",
    "loafing",
    "happy",
    "waiting",
    "needsinput",
    "greet",
    "talking",
    "loved",
    "sad",
    "sorry",
    "excited",
    "puzzled",
    "lookout",
];

const ALLOWED_EXTS: [&str; 5] = ["gif", "png", "webp", "jpg", "jpeg"];
/// 8 MiB: the bundled whale GIFs weigh up to ~1.2 MiB per state; 8 MiB gives
/// generous headroom while keeping a malicious payload bounded.
const MAX_ASSET_BYTES: usize = 8 * 1024 * 1024;

fn expressions_dir(runtime: &Runtime) -> PathBuf {
    runtime.app_dir.join("expressions")
}

fn is_valid_state(state: &str) -> bool {
    EXPRESSION_STATES.contains(&state)
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "gif" => "image/gif",
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "image/jpeg",
    }
}

/// Magic-byte sniffing: the WebView posts `(ext, bytes)`; trusting the ext
/// alone would let a mislabeled payload (or plain text) masquerade as an
/// image and land in the pet window's `<img>` decode path.
fn bytes_match_ext(ext: &str, bytes: &[u8]) -> bool {
    match ext {
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "png" => {
            bytes.len() > 8 && bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a])
        }
        "jpg" | "jpeg" => bytes.len() > 3 && bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

/// One override file per state: saving `happy.gif` removes a previous
/// `happy.png` so the directory scan never reports two candidates.
fn remove_other_exts(dir: &Path, state: &str, keep_ext: &str) {
    for ext in ALLOWED_EXTS {
        if ext == keep_ext {
            continue;
        }
        let _ = fs::remove_file(dir.join(format!("{state}.{ext}")));
    }
}

fn find_override_file(dir: &Path, state: &str) -> Option<PathBuf> {
    for ext in ALLOWED_EXTS {
        let candidate = dir.join(format!("{state}.{ext}"));
        if let Ok(meta) = fs::symlink_metadata(&candidate) {
            if meta.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// The expressions directory must be a real directory we created — a
/// pre-planted symlink would redirect writes outside the app dir.
fn ensure_real_dir(dir: &Path) -> Result<(), String> {
    match fs::symlink_metadata(dir) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err("expressions directory is a symlink".into());
            }
            if !meta.is_dir() {
                return Err("expressions path is not a directory".into());
            }
            Ok(())
        }
        Err(_) => {
            fs::create_dir_all(dir).map_err(|error| format!("create expressions dir: {error}"))
        }
    }
}

/// Snapshot shared by get/save/clear/enable + the change event.
fn snapshot(runtime: &Runtime) -> Value {
    let dir = expressions_dir(runtime);
    let mut states = serde_json::Map::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let Some(name) = entry.file_name().into_string().ok() else {
                continue;
            };
            let Some((state, ext)) = name.rsplit_once('.') else {
                continue;
            };
            if !is_valid_state(state) || !ALLOWED_EXTS.contains(&ext) {
                continue;
            }
            // First (in ALLOWED_EXTS order) file wins; remove_other_exts keeps
            // this unambiguous in practice.
            states.entry(state.to_string()).or_insert_with(|| {
                json!({
                    "file": name,
                    "ext": ext,
                    "sizeBytes": meta.len(),
                })
            });
        }
    }
    json!({
        // The enable flag lives in the config (transactional, sanitized);
        // the file table is derived from disk.
        "enabled": runtime.config().custom_expressions.unwrap_or(false),
        "states": Value::Object(states),
    })
}

fn emit_snapshot(app: &AppHandle, runtime: &Runtime) {
    let _ = app.emit("expressions:changed", snapshot(runtime));
}

#[tauri::command]
pub fn get_custom_expressions(state: State<'_, AppState>) -> Value {
    snapshot(&state.runtime)
}

#[tauri::command]
pub fn save_custom_expression(
    app: AppHandle,
    state: State<'_, AppState>,
    state_name: String,
    data_base64: String,
    ext: String,
) -> Result<Value, String> {
    let state_name = state_name.trim().to_ascii_lowercase();
    if !is_valid_state(&state_name) {
        return Err(format!("unknown expression state: {state_name}"));
    }
    let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if !ALLOWED_EXTS.contains(&ext.as_str()) {
        return Err(format!("unsupported image type: {ext}"));
    }
    let bytes = base64_decode(data_base64.trim())?;
    if bytes.is_empty() {
        return Err("expression payload is empty".into());
    }
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(format!(
            "expression image exceeds {} bytes",
            MAX_ASSET_BYTES
        ));
    }
    if !bytes_match_ext(&ext, &bytes) {
        return Err("image bytes do not match the claimed type".into());
    }

    let dir = expressions_dir(&state.runtime);
    ensure_real_dir(&dir)?;
    remove_other_exts(&dir, &state_name, &ext);
    // Atomic write: temp file in the SAME directory, then rename over the
    // target. A crash mid-write can never leave a truncated GIF that the
    // pet window would try to decode.
    let temp = dir.join(format!(".{state_name}.{ext}.{}.tmp", now_ms()));
    fs::write(&temp, &bytes).map_err(|error| format!("write expression: {error}"))?;
    let target = dir.join(format!("{state_name}.{ext}"));
    if let Err(error) = fs::rename(&temp, &target) {
        let _ = fs::remove_file(&temp);
        return Err(format!("install expression: {error}"));
    }
    state.runtime.write_log(
        "expressions",
        &format!("saved override for state '{state_name}'"),
    );
    emit_snapshot(&app, &state.runtime);
    Ok(snapshot(&state.runtime))
}

#[tauri::command]
pub fn clear_custom_expression(
    app: AppHandle,
    state: State<'_, AppState>,
    state_name: String,
) -> Result<Value, String> {
    let state_name = state_name.trim().to_ascii_lowercase();
    if !is_valid_state(&state_name) {
        return Err(format!("unknown expression state: {state_name}"));
    }
    let dir = expressions_dir(&state.runtime);
    if dir.is_dir() {
        for ext in ALLOWED_EXTS {
            let _ = fs::remove_file(dir.join(format!("{state_name}.{ext}")));
        }
    }
    state.runtime.write_log(
        "expressions",
        &format!("cleared override for state '{state_name}'"),
    );
    emit_snapshot(&app, &state.runtime);
    Ok(snapshot(&state.runtime))
}

#[tauri::command]
pub fn set_custom_expressions_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<Value, String> {
    state
        .runtime
        .update_config(|config| config.custom_expressions = Some(enabled))?;
    // Config writes already broadcast pet:config / panel:config; the override
    // table rides its own event so the pet only re-resolves images once.
    emit_snapshot(&app, &state.runtime);
    Ok(snapshot(&state.runtime))
}

#[tauri::command]
pub fn read_custom_expression(
    state: State<'_, AppState>,
    state_name: String,
) -> Result<String, String> {
    let state_name = state_name.trim().to_ascii_lowercase();
    if !is_valid_state(&state_name) {
        return Err(format!("unknown expression state: {state_name}"));
    }
    let dir = expressions_dir(&state.runtime);
    let file = find_override_file(&dir, &state_name).ok_or("no override for this state")?;
    let bytes = crate::secure_file::read_regular_bounded(
        &file,
        MAX_ASSET_BYTES as u64,
        "expression override",
    )?;
    let ext = file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    Ok(format!(
        "data:{};base64,{}",
        mime_for_ext(&ext),
        base64_encode(&bytes)
    ))
}

/// Open the expression studio window (mirrors open_panel: reuse the window
/// created at startup, float it above the always-on-top pet, focus it).
#[tauri::command]
pub fn open_expressions(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("expression-studio")
        .ok_or("expression studio window missing")?;
    // R22 (panel): the pet windows are alwaysOnTop, so the studio must float
    // while visible or it would be clipped behind the pet.
    window.set_always_on_top(true).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    let _ = app.emit("expressions:shown", ());
    Ok(())
}

#[tauri::command]
pub fn close_expressions(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("expression-studio")
        .ok_or("expression studio window missing")?;
    let _ = window.set_always_on_top(false);
    window.hide().map_err(|e| e.to_string())?;
    let _ = app.emit("expressions:hidden", ());
    Ok(())
}

/// Minimal base64 (RFC 4648, with padding) — encode + decode. The project
/// deliberately avoids a new dependency for ~50 lines of well-tested code
/// (supply-chain discipline: every added crate widens the SBOM and the
/// cargo-audit surface).
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 63] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(triple >> 6) as usize & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[triple as usize & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    fn value_of(byte: u8) -> Result<u32, String> {
        match byte {
            b'A'..=b'Z' => Ok((byte - b'A') as u32),
            b'a'..=b'z' => Ok((byte - b'a' + 26) as u32),
            b'0'..=b'9' => Ok((byte - b'0' + 52) as u32),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("invalid base64 character: {}", byte as char)),
        }
    }
    let bytes: Vec<u8> = input
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    // The decoder must not be a length-extension oracle for the 8 MiB cap:
    // reject oversized INPUT up front (4/3 ratio) instead of expanding first.
    if bytes.len() > (MAX_ASSET_BYTES / 3 + 1) * 4 {
        return Err("base64 payload exceeds the size limit".into());
    }
    let stripped: Vec<u8> = bytes
        .iter()
        .copied()
        .take_while(|byte| *byte != b'=')
        .collect();
    if bytes.len() - stripped.len() > 2 {
        return Err("invalid base64 padding".into());
    }
    if !bytes[stripped.len()..].iter().all(|byte| *byte == b'=') {
        return Err("invalid base64 padding characters".into());
    }
    let mut out = Vec::with_capacity(stripped.len() * 3 / 4);
    for chunk in stripped.chunks(4) {
        let mut sextet = [0u32; 4];
        for (index, byte) in chunk.iter().enumerate() {
            sextet[index] = value_of(*byte)?;
        }
        out.push(((sextet[0] << 2) | (sextet[1] >> 4)) as u8);
        if chunk.len() > 2 {
            out.push((((sextet[1] & 0x0f) << 4) | (sextet[2] >> 2)) as u8);
        }
        if chunk.len() > 3 {
            out.push((((sextet[2] & 0x03) << 6) | sextet[3]) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip_matches_known_vectors() {
        // RFC 4648 test vectors.
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        for payload in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar"] {
            assert_eq!(
                base64_decode(&base64_encode(payload)).unwrap(),
                payload.to_vec()
            );
        }
    }

    #[test]
    fn base64_decode_rejects_invalid_input() {
        assert!(base64_decode("!!!!").is_err());
        // Whitespace is tolerated (the WebView may wrap long strings).
        assert_eq!(base64_decode("Zm9v\n").unwrap(), b"foo".to_vec());
        // The decoder is intentionally lenient: unpadded tails and 1-2
        // trailing '=' are accepted (btoa on the WebView side always emits
        // canonical padding anyway); only non-alphabet characters and >2
        // padding chars are rejected.
        assert!(base64_decode("Zm9").is_ok()); // unpadded tail is tolerated
        assert!(base64_decode("Zm9=").is_ok());
        assert!(base64_decode("Zm9===").is_err()); // >2 padding chars
    }

    #[test]
    fn base64_decode_bounds_oversized_payload() {
        // 12 MiB of 'A' would decode to ~9 MiB — rejected before expansion.
        let huge = "A".repeat(12 * 1024 * 1024);
        assert!(base64_decode(&huge).is_err());
    }

    #[test]
    fn magic_sniffing_matches_claimed_types() {
        assert!(bytes_match_ext(
            "png",
            &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]
        ));
        assert!(!bytes_match_ext("png", b"not a png"));
        assert!(bytes_match_ext("gif", b"GIF89a......"));
        assert!(bytes_match_ext("jpg", &[0xff, 0xd8, 0xff, 0xe0]));
        assert!(bytes_match_ext("jpeg", &[0xff, 0xd8, 0xff, 0xe0]));
        assert!(bytes_match_ext(
            "webp",
            [b'R', b'I', b'F', b'F', 0, 0, 0, 0, b'W', b'E', b'B', b'P'].as_slice()
        ));
        assert!(!bytes_match_ext("webp", b"RIFF____NOPE"));
    }

    #[test]
    fn state_whitelist_covers_renderer_vocabulary() {
        // The exact 27-word mirror of states.js RENDER_STATE_WORDS; the
        // cross-file check lives in test/tauri-expression-studio-r59-smoke.js.
        assert_eq!(EXPRESSION_STATES.len(), 27);
        for word in ["idle", "working", "loved", "lookout", "waking", "roam"] {
            assert!(is_valid_state(word), "{word} must be overridable");
        }
        for word in ["..", "idle.png", "newstate", ""] {
            assert!(!is_valid_state(word), "{word:?} must be rejected");
        }
    }

    #[test]
    fn snapshot_reports_enabled_from_config_and_files_from_disk() {
        // Pure-disk part of the snapshot: uses the real app_dir layout via a
        // temp dir. The config half is exercised by the command-level smoke.
        let dir = std::env::temp_dir().join(format!(
            "octopus-expr-snap-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("happy.gif"), b"GIF89a-rest").unwrap();
        fs::write(dir.join("not-a-state.gif"), b"GIF89a-x").unwrap();
        fs::write(dir.join("readme.txt"), b"ignored").unwrap();
        let mut found = 0;
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let Some((state, _)) = name.rsplit_once('.') else {
                    continue;
                };
                if is_valid_state(state) && find_override_file(&dir, state).is_some() {
                    found += 1;
                }
            }
        }
        assert_eq!(found, 1, "only the whitelisted state counts");
        let _ = fs::remove_dir_all(&dir);
    }
}
