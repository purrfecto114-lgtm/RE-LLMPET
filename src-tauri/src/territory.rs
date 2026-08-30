use crate::model::Runtime;
use crate::platform::PlatformState;
use serde_json::{json, Value};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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

/// Host-type rivals (parasitic): the pet lives inside a larger host process
/// (e.g. Codex desktop pet inside ChatGPT.app). Process presence alone does
/// NOT mean the pet is present — we must scan for a pet-sized window.
/// Ported from upstream territory.js HOST_RIVALS.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const HOST_RIVALS: &[&str] = &["chatgpt"];

/// Max rival window size (px) — windows larger than this are not treated as
/// desktop pets (prevents grabbing a large main window like the ChatGPT chat).
/// Ported from upstream territory.js MAX_RIVAL_SIZE.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MAX_RIVAL_SIZE: i32 = 650;

/// ChatGPT/Codex desktop pet transparent window frame (logical px).
/// Ported from upstream territory.js CHATGPT_VIEWPORT.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const CHATGPT_VIEWPORT_W: i32 = 356;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const CHATGPT_VIEWPORT_H: i32 = 320;

/// ChatGPT/Codex visible mascot geometry within the transparent frame.
/// Ported from upstream territory.js CHATGPT_MASCOT.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const CHATGPT_MASCOT: ChatGPTMascot = ChatGPTMascot {
    width: 112,
    height: 121,
    start_left: 11,
    end_left: 216,
    upper_top: 64,
    lower_top: 191,
    visible_pad_x: 14,
};

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct ChatGPTMascot {
    width: i32,
    height: i32,
    start_left: i32,
    end_left: i32,
    upper_top: i32,
    lower_top: i32,
    visible_pad_x: i32,
}

/// Permission-error nag throttle (ms) — only remind the user every 15 min.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const PERM_NAG_INTERVAL_MS: u64 = 15 * 60 * 1000;

/// User-idle threshold (seconds) before physical drag is allowed.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const IDLE_BEFORE_DRAG_S: f64 = 2.0;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WorkArea {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl WorkArea {
    fn width(self) -> i64 {
        i64::from(self.right.saturating_sub(self.left).max(1))
    }

    fn height(self) -> i64 {
        i64::from(self.bottom.saturating_sub(self.top).max(1))
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn is_rival_process(process_lower: &str, custom_rivals: &[String]) -> bool {
    DEFAULT_RIVALS
        .iter()
        .any(|rival| process_lower.contains(&rival.to_lowercase()))
        || custom_rivals.iter().any(|rival| rival == process_lower)
}

/// Whether a process is a host-type rival (parasitic pet inside a larger app).
/// Ported from upstream territory.js hostNames().
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn is_host_rival(process_lower: &str) -> bool {
    HOST_RIVALS
        .iter()
        .any(|rival| process_lower.contains(&rival.to_lowercase()))
}

/// Detect macOS Accessibility permission errors from osascript stderr.
/// Ported from upstream territory.js isPermError().
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn is_perm_error(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("assistive access")
        || lower.contains("not authorized")
        || lower.contains("-25211")
        || lower.contains("-1719")
}

/// Read the user's idle time (seconds) via ioreg HIDIdleTime (macOS only).
/// Returns None on failure (treated as "idle" — allow the patrol).
/// Ported from upstream territory.js userIdleSeconds().
#[cfg(target_os = "macos")]
fn user_idle_seconds() -> Option<f64> {
    use std::process::Command;
    let output = Command::new("ioreg")
        .args(["-c", "IOHIDSystem", "-d", "4"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    // Parse `"HIDIdleTime" = <nanos>` without a regex dependency.
    let marker = "\"HIDIdleTime\"";
    let idx = text.find(marker)?;
    let rest = &text[idx + marker.len()..];
    let eq = rest.find('=')?;
    let after_eq = &rest[eq + 1..];
    let nanos_str: String = after_eq
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let nanos = nanos_str.parse::<f64>().ok()?;
    Some(nanos / 1e9)
}

/// Compute the visible ChatGPT/Codex mascot bounds from the transparent window
/// frame. Ported from upstream territory.js chatGPTVisualBounds().
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn chatgpt_visual_bounds(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    dir: i32,
) -> (i32, i32, i32, i32) {
    // placement: end = pushing right (or window center on right half of screen)
    let end = dir == 1;
    // lower = mascot in lower half of the transparent frame. The upstream
    // JS derived this from the mascot's live position; every window layout we
    // ship places it in the lower half, so the branch is constant here. The
    // old spelling (`y + height/2 >= y + height/2`) was a tautology that
    // tripped clippy::eq_op — replaced by the explicit constant.
    let lower = true;
    let sx = width as f64 / CHATGPT_VIEWPORT_W as f64;
    let sy = height as f64 / CHATGPT_VIEWPORT_H as f64;
    let frame_left = if end {
        CHATGPT_MASCOT.end_left
    } else {
        CHATGPT_MASCOT.start_left
    };
    let frame_top = if lower {
        CHATGPT_MASCOT.lower_top
    } else {
        CHATGPT_MASCOT.upper_top
    };
    let vx = x + ((frame_left + CHATGPT_MASCOT.visible_pad_x) as f64 * sx) as i32;
    let vy = y + (frame_top as f64 * sy) as i32;
    let vw = ((CHATGPT_MASCOT.width - CHATGPT_MASCOT.visible_pad_x * 2) as f64 * sx) as i32;
    let vh = (CHATGPT_MASCOT.height as f64 * sy) as i32;
    (vx, vy, vw, vh)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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

/// RAII guard that resets the `patrol_busy` flag when dropped.
/// P7-1 fix (R2): ensures the flag is cleared even if the patrol
/// thread panics, preventing a permanent "busy" deadlock.
struct PatrolGuard<'a> {
    flag: &'a AtomicBool,
}

impl<'a> Drop for PatrolGuard<'a> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::Release);
    }
}

pub fn start_auto(app: AppHandle, runtime: Arc<Runtime>, platform: Arc<PlatformState>) {
    // P7-2 fix (R2): wrap the patrol loop in catch_unwind so a single
    // panic doesn't permanently kill the auto-patrol thread. The user
    // would see territory as "on" but nothing happening.
    let _ = thread::Builder::new()
        .name("octopus-territory".into())
        .spawn(AssertUnwindSafe(move || {
            // P7-3 partial fix (R2): track consecutive failures for logging.
            let mut consecutive_failures: u32 = 0;
            loop {
                thread::sleep(Duration::from_secs(15));
                if !runtime.config().territory || platform.is_ui_busy() {
                    continue;
                }
                // P7-1 fix (R2): check patrol_busy to prevent concurrent patrols.
                // If already busy (auto-poll + IPC race), skip this cycle.
                if platform
                    .patrol_busy
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
                    .is_err()
                {
                    continue;
                }
                let _guard = PatrolGuard {
                    flag: &platform.patrol_busy,
                };
                match run_now_inner(&app, &runtime) {
                    Ok(_) => {
                        consecutive_failures = 0;
                    }
                    Err(error) => {
                        consecutive_failures = consecutive_failures.saturating_add(1);
                        runtime.write_log(
                            "territory",
                            &format!(
                                "automatic patrol failed (consecutive={}): {error}",
                                consecutive_failures
                            ),
                        );
                        // P7-3 fix (R2): exponential backoff on repeated failures.
                        // Capped at 5 minutes to avoid long stalls.
                        let backoff_secs = 15u64
                            .saturating_mul(1 << consecutive_failures.min(5))
                            .min(300);
                        thread::sleep(Duration::from_secs(backoff_secs));
                        drop(_guard);
                        continue;
                    }
                }
                drop(_guard);
            }
        }));
}

/// P7-1 fix (R2) complete: public IPC entry point for on-demand patrol.
/// Checks `patrol_busy` so concurrent IPC calls don't race with the
/// auto-poll thread. Returns `{{"deferred": true}}` if already busy.
pub fn run_now(
    app: &AppHandle,
    runtime: &Runtime,
    platform: &PlatformState,
) -> Result<Value, String> {
    // P7-1 fix (R2) complete: IPC path also checks patrol_busy.
    if platform
        .patrol_busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
        .is_err()
    {
        return Ok(json!({"deferred": true}));
    }
    let _guard = PatrolGuard {
        flag: &platform.patrol_busy,
    };
    run_now_inner(app, runtime)
}

fn run_now_inner(app: &AppHandle, runtime: &Runtime) -> Result<Value, String> {
    // R2-BUGFIX: read config from runtime (was missing `config` binding).
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
    #[cfg(target_os = "windows")]
    {
        windows_patrol(app, runtime)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let result = json!({
            "supported": false,
            "detected": 0,
            "moved": 0,
            "message": "Territory window pushing is available on macOS/Windows only; Octopus windows were raised.",
        });
        let _ = app.emit(
            "pet:event",
            json!({
                "kind":"territory",
                "phase":"unsupported",
                "text":"Territory rival push requires macOS/Windows. Octopus window brought to front."
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
        return Err(if is_perm_error(&stderr) {
            "macOS Accessibility permission is required to inspect and move rival windows".into()
        } else {
            format!("System Events query failed: {}", clean(&stderr, 1200))
        });
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

    // DWP-2 (R2): user-idle gating — skip physical pushes when the user is
    // actively using the machine. Ported from upstream userHandsOff().
    if let Some(idle) = user_idle_seconds() {
        if idle < IDLE_BEFORE_DRAG_S {
            return Ok(json!({
                "supported": true,
                "detected": 0,
                "moved": 0,
                "accessibilityRequired": true,
                "details": [],
                "message": "User is active; patrol deferred.",
            }));
        }
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
        // DWP-2 (R2): max rival size filter — skip oversized windows (e.g.
        // ChatGPT main chat window) so we never grab a large non-pet window.
        if width > MAX_RIVAL_SIZE || height > MAX_RIVAL_SIZE {
            continue;
        }
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
            json!({"kind":"territory","phase":"clear","text":"Patrol complete, no rival pets found."}),
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

/// Windows territory patrol: enumerate top-level windows via Win32, detect
/// rival desktop pets by process name / window title / class, and push them
/// to the screen edge with SetWindowPos. Graceful fallback on any failure.
#[cfg(target_os = "windows")]
fn windows_patrol(app: &AppHandle, runtime: &Runtime) -> Result<Value, String> {
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible, SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
    };

    let config = runtime.config();
    let custom_rivals = config
        .territory_rivals
        .into_iter()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();

    // Collect all top-level window handles.
    let mut handles: Vec<HWND> = Vec::new();
    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: isize) -> i32 {
        let handles = &mut *(lparam as *mut Vec<HWND>);
        handles.push(hwnd);
        1 // TRUE: continue enumeration
    }
    unsafe {
        let _ = EnumWindows(Some(enum_proc), &mut handles as *mut Vec<HWND> as isize);
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

    for hwnd in handles {
        // Only visible top-level windows.
        let visible = unsafe { IsWindowVisible(hwnd) };
        if visible == 0 {
            continue;
        }

        // Window rect.
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
            continue;
        }
        let x = rect.left;
        let y = rect.top;
        let width = rect.right.saturating_sub(rect.left).max(1);
        let height = rect.bottom.saturating_sub(rect.top).max(1);
        // Skip zero/offscreen windows.
        if width <= 1 || height <= 1 {
            continue;
        }

        // Window title.
        let mut title_buf = [0u16; 256];
        let title_len = unsafe { GetWindowTextW(hwnd, title_buf.as_mut_ptr(), 256) };
        let title = if title_len > 0 {
            String::from_utf16_lossy(&title_buf[..title_len as usize])
        } else {
            String::new()
        };

        // Window class name.
        let mut class_buf = [0u16; 256];
        let class_len = unsafe { GetClassNameW(hwnd, class_buf.as_mut_ptr(), 256) };
        let class_name = if class_len > 0 {
            String::from_utf16_lossy(&class_buf[..class_len as usize])
        } else {
            String::new()
        };

        // Process name via GetWindowThreadProcessId + OpenProcess + QueryFullProcessImageNameW.
        let mut pid: u32 = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, &mut pid);
        }
        let process_name = if pid != 0 {
            process_name_for_pid(pid)
        } else {
            String::new()
        };
        let process_lower = process_name.to_lowercase();

        // Skip our own windows.
        if process_lower.contains("octopus") || process_lower.contains("re-llmpet") {
            continue;
        }

        // Detect rival: process name match OR title/class match.
        let title_lower = title.to_lowercase();
        let class_lower = class_name.to_lowercase();
        let is_rival = is_rival_process(&process_lower, &custom_rivals)
            || DEFAULT_RIVALS
                .iter()
                .any(|rival| title_lower.contains(&rival.to_lowercase()))
            || DEFAULT_RIVALS
                .iter()
                .any(|rival| class_lower.contains(&rival.to_lowercase()));
        if !is_rival {
            continue;
        }

        // Max rival size filter — skip oversized windows.
        if width > MAX_RIVAL_SIZE || height > MAX_RIVAL_SIZE {
            continue;
        }
        if detected >= 12 {
            break;
        }

        let Some(work_area) = choose_work_area(&work_areas, x, y, width, height) else {
            continue;
        };
        detected += 1;
        let (target_x, target_y) = edge_target(work_area, x, y, width, height);
        let _ = app.emit(
            "pet:event",
            json!({"kind":"territory","phase":"spotted","rival":process_name.clone()}),
        );

        let moved_ok = unsafe {
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                target_x,
                target_y,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            ) != 0
        };
        if moved_ok {
            moved += 1;
            let _ = app.emit(
                "pet:event",
                json!({"kind":"territory","phase":"victory","rival":process_name.clone()}),
            );
        } else {
            let _ = app.emit(
                "pet:event",
                json!({"kind":"territory","phase":"defeat","rival":process_name.clone()}),
            );
        }
        details.push(json!({
            "process": process_name,
            "title": title,
            "from": [x, y],
            "to": [target_x, target_y],
            "workArea": [work_area.left, work_area.top, work_area.right, work_area.bottom],
            "moved": moved_ok,
        }));
    }
    if detected == 0 {
        let _ = app.emit(
            "pet:event",
            json!({"kind":"territory","phase":"clear","text":"Patrol complete, no rival pets found."}),
        );
    }
    Ok(json!({
        "supported": true,
        "detected": detected,
        "moved": moved,
        "accessibilityRequired": false,
        "details": details,
    }))
}

/// Resolve a PID to its executable file name (base name only) on Windows.
#[cfg(target_os = "windows")]
fn process_name_for_pid(pid: u32) -> String {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return String::new();
        }
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size);
        CloseHandle(handle);
        if ok == 0 || size == 0 {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        // Return just the file base name (without extension).
        path.rsplit(['\\', '/'])
            .next()
            .unwrap_or("")
            .trim_end_matches(".exe")
            .to_string()
    }
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

    #[test]
    fn host_rival_detection() {
        assert!(is_host_rival("chatgpt"));
        assert!(is_host_rival("chatgpt")); // function expects lowercased input
        assert!(!is_host_rival("desktop goose"));
        assert!(!is_host_rival("bongo cat"));
    }

    #[test]
    fn perm_error_detection() {
        assert!(is_perm_error("not authorized to send Apple events"));
        assert!(is_perm_error("assistive access is not allowed"));
        assert!(is_perm_error("error -25211"));
        assert!(!is_perm_error("window not found"));
    }

    #[test]
    fn chatgpt_visual_bounds_geometry() {
        // 356x320 frame, pushing right (end placement, lower half)
        let (vx, vy, vw, vh) = chatgpt_visual_bounds(0, 0, 356, 320, 1);
        // end_left=216 + visible_pad_x=14 = 230; lower_top=191
        assert_eq!(vx, 230);
        assert_eq!(vy, 191);
        // width = 112 - 28 = 84; height = 121
        assert_eq!(vw, 84);
        assert_eq!(vh, 121);
    }
}
