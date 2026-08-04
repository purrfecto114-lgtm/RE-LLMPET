use crate::model::Runtime;
use crate::platform::PlatformState;
use serde_json::{json, Value};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "macos")]
const DEFAULT_RIVALS: &[&str] = &[
    "desktop goose",
    "desktopgoose",
    "bongo cat",
    "bongocat",
    "shimeji",
    "desktop pet",
    "桌面宠物",
    "桌宠",
];

pub fn start_auto(app: AppHandle, runtime: Arc<Runtime>, platform: Arc<PlatformState>) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(15));
        if !runtime.config().territory || platform.is_ui_busy() {
            continue;
        }
        if let Err(error) = run_now(&app, &runtime) {
            runtime.write_log("territory", &format!("automatic patrol failed: {error}"));
        }
    });
}

pub fn run_now(app: &AppHandle, runtime: &Runtime) -> Result<Value, String> {
    let config = runtime.config();
    for label in ["pet", "pet-codex"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.set_always_on_top(true);
            let should_show = config.mode != "hidePet"
                && (label == "pet" || config.pet_mode == "duo");
            if should_show {
                let _ = window.show();
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        macos_patrol(app, runtime)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let result = json!({
            "supported": false,
            "detected": 0,
            "moved": 0,
            "message": "Territory window pushing is available on macOS only; Octopus windows were raised.",
        });
        let _ = app.emit("pet:event", json!({
            "kind":"territory",
            "phase":"unsupported",
            "text":"领地模式的竞品窗口推动仅支持 macOS；已将 Octopus 窗口置顶。"
        }));
        Ok(result)
    }
}

#[cfg(target_os = "macos")]
fn macos_patrol(app: &AppHandle, runtime: &Runtime) -> Result<Value, String> {
    use std::process::Command;

    let config = runtime.config();
    let mut rivals = DEFAULT_RIVALS
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    for custom in config.territory_rivals {
        let custom = custom.trim();
        if custom.is_empty()
            || rivals
                .iter()
                .any(|known| known.eq_ignore_ascii_case(custom))
        {
            continue;
        }
        rivals.push(custom.to_string());
    }
    let script = r#"
set output to ""
tell application "System Events"
  repeat with proc in (every application process whose background only is false)
    try
      set procName to name of proc as text
      set winIndex to 0
      repeat with win in windows of proc
        set winIndex to winIndex + 1
        set p to position of win
        set s to size of win
        set output to output & procName & tab & winIndex & tab & (item 1 of p) & tab & (item 2 of p) & tab & (item 1 of s) & tab & (item 2 of s) & linefeed
      end repeat
    end try
  end repeat
end tell
return output
"#;
    let output = Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|error| format!("launch osascript: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(if stderr.to_ascii_lowercase().contains("not authorized")
            || stderr.to_ascii_lowercase().contains("assistive")
        {
            "macOS Accessibility permission is required to inspect and move rival windows".into()
        } else {
            format!("System Events query failed: {}", clean(&stderr, 1200))
        });
    }

    let monitor = app
        .get_webview_window("pet")
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| app.get_webview_window("pet").and_then(|window| window.primary_monitor().ok().flatten()))
        .ok_or("monitor information unavailable")?;
    let work = monitor.work_area();
    let left = work.position.x;
    let top = work.position.y;
    let right = left.saturating_add(work.size.width as i32);
    let bottom = top.saturating_add(work.size.height as i32);
    let center_x = i64::from(left) + i64::from(work.size.width) / 2;

    let mut detected = 0u32;
    let mut moved = 0u32;
    let mut details = Vec::new();
    let rows = String::from_utf8_lossy(&output.stdout);
    for line in rows.lines().take(500) {
        let columns = line.split('\t').collect::<Vec<_>>();
        if columns.len() != 6 {
            continue;
        }
        let process = clean(columns[0], 128);
        let process_lower = process.to_lowercase();
        if process_lower.contains("octopus") || process_lower.contains("re-llmpet") {
            continue;
        }
        if !rivals.iter().any(|rival| process_lower.contains(&rival.to_lowercase())) {
            continue;
        }
        let index = columns[1].parse::<u32>().unwrap_or(0);
        let x = columns[2].parse::<i32>().unwrap_or(left);
        let y = columns[3].parse::<i32>().unwrap_or(top);
        let width = columns[4].parse::<i32>().unwrap_or(200).max(1);
        let height = columns[5].parse::<i32>().unwrap_or(200).max(1);
        if index == 0 || detected >= 12 {
            continue;
        }
        detected += 1;
        let window_center = i64::from(x) + i64::from(width) / 2;
        let target_x = if window_center <= center_x {
            left
        } else {
            right.saturating_sub(width)
        };
        let target_y = y.clamp(top, bottom.saturating_sub(height).max(top));
        let _ = app.emit("pet:event", json!({"kind":"territory","phase":"spotted","rival":process.clone()}));
        let move_script = format!(
            "tell application \"System Events\" to tell application process \"{}\" to set position of window {} to {{{}, {}}}",
            applescript_escape(&process), index, target_x, target_y
        );
        let moved_ok = Command::new("osascript")
            .args(["-e", &move_script])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if moved_ok {
            moved += 1;
            let _ = app.emit("pet:event", json!({"kind":"territory","phase":"victory","rival":process.clone()}));
        } else {
            let _ = app.emit("pet:event", json!({"kind":"territory","phase":"defeat","rival":process.clone()}));
        }
        details.push(json!({
            "process": process,
            "windowIndex": index,
            "from": [x, y],
            "to": [target_x, target_y],
            "moved": moved_ok,
        }));
    }
    if detected == 0 {
        let _ = app.emit("pet:event", json!({"kind":"territory","phase":"clear","text":"巡视完成，没有发现其他桌宠。"}));
    }
    Ok(json!({
        "supported": true,
        "detected": detected,
        "moved": moved,
        "accessibilityRequired": true,
        "details": details,
    }))
}

#[cfg(target_os = "macos")]
fn applescript_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn clean(value: &str, max: usize) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .chars()
        .take(max)
        .collect()
}
