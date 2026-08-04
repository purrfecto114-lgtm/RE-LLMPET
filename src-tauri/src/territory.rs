use crate::model::Runtime;
use crate::platform::PlatformState;
use serde_json::{json, Value};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[allow(dead_code)]
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

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WorkArea {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[allow(dead_code)]
impl WorkArea {
    fn width(self) -> i64 {
        i64::from(self.right.saturating_sub(self.left).max(1))
    }

    fn height(self) -> i64 {
        i64::from(self.bottom.saturating_sub(self.top).max(1))
    }
}

#[allow(dead_code)]
fn choose_work_area(
    areas: &[WorkArea],
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Option<WorkArea> {
    let window_right = x.saturating_add(width.max(1));
    let window_bottom = y.saturating_add(height.max(1));
    areas.iter().copied().max_by(|left, right| {
        let score = |area: WorkArea| {
            let overlap_width = i64::from(
                window_right
                    .min(area.right)
                    .saturating_sub(x.max(area.left))
                    .max(0),
            );
            let overlap_height = i64::from(
                window_bottom
                    .min(area.bottom)
                    .saturating_sub(y.max(area.top))
                    .max(0),
            );
            let intersection = overlap_width.saturating_mul(overlap_height);
            let window_center_x = i64::from(x) + i64::from(width.max(1)) / 2;
            let window_center_y = i64::from(y) + i64::from(height.max(1)) / 2;
            let area_center_x = i64::from(area.left) + area.width() / 2;
            let area_center_y = i64::from(area.top) + area.height() / 2;
            let dx = window_center_x.saturating_sub(area_center_x);
            let dy = window_center_y.saturating_sub(area_center_y);
            (
                intersection,
                -(dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy))),
            )
        };
        score(*left).cmp(&score(*right))
    })
}

#[allow(dead_code)]
fn is_rival_process(process_lower: &str, custom_rivals: &[String]) -> bool {
    DEFAULT_RIVALS
        .iter()
        .any(|rival| process_lower.contains(&rival.to_lowercase()))
        || custom_rivals.iter().any(|rival| rival == process_lower)
}

#[allow(dead_code)]
fn edge_target(area: WorkArea, x: i32, y: i32, width: i32, height: i32) -> (i32, i32) {
    let width = width.max(1);
    let height = height.max(1);
    let center_x = i64::from(area.left) + area.width() / 2;
    let window_center_x = i64::from(x) + i64::from(width) / 2;
    let target_x = if window_center_x <= center_x {
        area.left
    } else {
        area.right.saturating_sub(width).max(area.left)
    };
    let target_y = y.clamp(area.top, area.bottom.saturating_sub(height).max(area.top));
    (target_x, target_y)
}

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
            let should_show =
                config.mode != "hidePet" && (label == "pet" || config.pet_mode == "duo");
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
        let _ = app.emit(
            "pet:event",
            json!({
                "kind":"territory",
                "phase":"unsupported",
                "text":"领地模式的竞品窗口推动仅支持 macOS；已将 Octopus 窗口置顶。"
            }),
        );
        Ok(result)
    }
}

#[cfg(target_os = "macos")]
fn macos_patrol(app: &AppHandle, runtime: &Runtime) -> Result<Value, String> {
    use std::process::Command;

    let config = runtime.config();
    let custom_rivals = config
        .territory_rivals
        .into_iter()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
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
        return Err(
            if stderr.to_ascii_lowercase().contains("not authorized")
                || stderr.to_ascii_lowercase().contains("assistive")
            {
                "macOS Accessibility permission is required to inspect and move rival windows"
                    .into()
            } else {
                format!("System Events query failed: {}", clean(&stderr, 1200))
            },
        );
    }

    let pet_window = app
        .get_webview_window("pet")
        .ok_or("pet window is unavailable")?;
    let monitors = pet_window
        .available_monitors()
        .map_err(|error| format!("read monitor information: {error}"))?;
    let work_areas = monitors
        .into_iter()
        .map(|monitor| {
            let work = monitor.work_area();
            WorkArea {
                left: work.position.x,
                top: work.position.y,
                right: work
                    .position
                    .x
                    .saturating_add(i32::try_from(work.size.width).unwrap_or(i32::MAX)),
                bottom: work
                    .position
                    .y
                    .saturating_add(i32::try_from(work.size.height).unwrap_or(i32::MAX)),
            }
        })
        .collect::<Vec<_>>();
    if work_areas.is_empty() {
        return Err("monitor information unavailable".into());
    }

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
        if !is_rival_process(&process_lower, &custom_rivals) {
            continue;
        }
        let index = columns[1].parse::<u32>().unwrap_or(0);
        let x = columns[2].parse::<i32>().unwrap_or(0);
        let y = columns[3].parse::<i32>().unwrap_or(0);
        let width = columns[4].parse::<i32>().unwrap_or(200).max(1);
        let height = columns[5].parse::<i32>().unwrap_or(200).max(1);
        if index == 0 || detected >= 12 {
            continue;
        }
        let Some(work_area) = choose_work_area(&work_areas, x, y, width, height) else {
            continue;
        };
        detected += 1;
        let (target_x, target_y) = edge_target(work_area, x, y, width, height);
        let _ = app.emit(
            "pet:event",
            json!({"kind":"territory","phase":"spotted","rival":process.clone()}),
        );
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
            let _ = app.emit(
                "pet:event",
                json!({"kind":"territory","phase":"victory","rival":process.clone()}),
            );
        } else {
            let _ = app.emit(
                "pet:event",
                json!({"kind":"territory","phase":"defeat","rival":process.clone()}),
            );
        }
        details.push(json!({
            "process": process,
            "windowIndex": index,
            "from": [x, y],
            "to": [target_x, target_y],
            "workArea": [work_area.left, work_area.top, work_area.right, work_area.bottom],
            "moved": moved_ok,
        }));
    }
    if detected == 0 {
        let _ = app.emit(
            "pet:event",
            json!({"kind":"territory","phase":"clear","text":"巡视完成，没有发现其他桌宠。"}),
        );
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rival_window_stays_on_its_own_monitor() {
        let areas = [
            WorkArea {
                left: 0,
                top: 0,
                right: 1920,
                bottom: 1080,
            },
            WorkArea {
                left: 1920,
                top: 0,
                right: 3840,
                bottom: 1080,
            },
        ];
        let selected = choose_work_area(&areas, 2400, 100, 400, 400).unwrap();
        assert_eq!(selected, areas[1]);
        let (x, _) = edge_target(selected, 2400, 100, 400, 400);
        assert!(x >= 1920);
    }

    #[test]
    fn custom_rivals_require_exact_process_name() {
        let custom = vec!["cat".to_string()];
        assert!(is_rival_process("cat", &custom));
        assert!(!is_rival_process("catalog", &custom));
        assert!(is_rival_process("desktop goose helper", &[]));
    }

    #[test]
    fn oversized_window_never_targets_before_monitor_origin() {
        let area = WorkArea {
            left: 100,
            top: 50,
            right: 900,
            bottom: 650,
        };
        let (x, y) = edge_target(area, 700, 600, 1200, 900);
        assert_eq!(x, 100);
        assert_eq!(y, 50);
    }
}
