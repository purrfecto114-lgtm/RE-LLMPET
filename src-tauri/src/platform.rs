use crate::model::{AppState, Runtime};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, PhysicalPosition, Position};

const MAX_PARENT_DEPTH: usize = 16;
const HEALTH_CHECK_SECS: u64 = 30;
// Adaptive cursor hit-test polling. The old fixed 24ms loop (~42 Hz)
// woke forever even when the pet was idle. The current guard uses four tiers:
// 45ms near the hit target, 240ms when the cursor is far away, 500ms while
// interaction is not requested/UI is busy, and 1000ms while the pet is hidden.
// This keeps recovery responsive near the pet without paying the hot-loop cost
// during ordinary idle time.
const CURSOR_HIT_TEST_NEAR_MS: u64 = 45;
const CURSOR_HIT_TEST_FAR_MS: u64 = 240;
const CURSOR_HIT_TEST_IDLE_MS: u64 = 500;
const CURSOR_HIT_TEST_HIDDEN_MS: u64 = 1000;
const CURSOR_HIT_PADDING: f64 = 6.0;
const VISIBLE_MARGIN: i32 = 48;

#[cfg(windows)]
fn global_cursor_position() -> Option<tauri::PhysicalPosition<f64>> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT { x: 0, y: 0 };
    // SAFETY: GetCursorPos only writes to the valid POINT pointer supplied here.
    if unsafe { GetCursorPos(&mut point) } == 0 {
        None
    } else {
        Some(tauri::PhysicalPosition::new(
            f64::from(point.x),
            f64::from(point.y),
        ))
    }
}

#[cfg(not(windows))]
fn global_cursor_position(window: &tauri::WebviewWindow) -> Option<tauri::PhysicalPosition<f64>> {
    window.cursor_position().ok()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VisualBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CursorHitDecision {
    ignore: bool,
    delay_ms: u64,
}

#[derive(Default)]
pub struct PlatformState {
    health_started: AtomicBool,
    cursor_hit_test_started: AtomicBool,
    display_signature: Mutex<String>,
    ui_busy: AtomicBool,
    // P7-1 fix (R2): prevents concurrent patrol runs when both the
    // auto-poll thread and an IPC call (territory_run_now / territory_toggle_auto)
    // invoke run_now at the same time. compare_exchange(false→true) at
    // entry; a Drop guard resets to false on exit (panic-safe).
    pub patrol_busy: AtomicBool,
    mouse_ignore_requested: Mutex<HashMap<String, bool>>,
    mouse_ignore_applied: Mutex<HashMap<String, bool>>,
    visual_bounds: Mutex<HashMap<String, VisualBounds>>,
}

impl PlatformState {
    pub fn set_ui_busy(&self, on: bool) {
        self.ui_busy.store(on, Ordering::Release);
    }

    pub fn is_ui_busy(&self) -> bool {
        self.ui_busy.load(Ordering::Acquire)
    }

    pub fn request_mouse_ignore(&self, label: &str, on: bool) {
        self.mouse_ignore_requested
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(label.to_string(), on);
    }

    pub fn start_cursor_hit_test(self: &Arc<Self>, app: AppHandle) {
        if self.cursor_hit_test_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let state = self.clone();
        let _ = thread::Builder::new()
            .name("octopus-cursor-hit-test".into())
            .spawn(move || loop {
                let mut saw_window = false;
                let mut delay_ms = CURSOR_HIT_TEST_HIDDEN_MS;
                for label in ["pet", "pet-codex"] {
                    let Some(window) = app.get_webview_window(label) else {
                        continue;
                    };
                    saw_window = true;
                    let decision = state.cursor_hit_decision(label, &window);
                    delay_ms = delay_ms.min(decision.delay_ms);
                    let previous = state
                        .mouse_ignore_applied
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .get(label)
                        .copied()
                        .unwrap_or(false);
                    if previous != decision.ignore
                        && window.set_ignore_cursor_events(decision.ignore).is_ok()
                    {
                        state
                            .mouse_ignore_applied
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .insert(label.to_string(), decision.ignore);
                    }
                }
                if !saw_window {
                    thread::sleep(Duration::from_millis(CURSOR_HIT_TEST_HIDDEN_MS));
                    continue;
                }
                thread::sleep(Duration::from_millis(delay_ms));
            });
    }

    fn cursor_hit_decision(&self, label: &str, window: &tauri::WebviewWindow) -> CursorHitDecision {
        let ignore_requested = self
            .mouse_ignore_requested
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(label)
            .copied()
            .unwrap_or(false);
        if self.is_ui_busy() || !ignore_requested {
            return CursorHitDecision {
                ignore: false,
                delay_ms: CURSOR_HIT_TEST_IDLE_MS,
            };
        }
        if !window.is_visible().unwrap_or(false) {
            return CursorHitDecision {
                ignore: false,
                delay_ms: CURSOR_HIT_TEST_HIDDEN_MS,
            };
        }
        let Some(bounds) = self.visual_bounds(label) else {
            // Never enter an unrecoverable click-through state before the
            // renderer has reported a usable hit target.
            return CursorHitDecision {
                ignore: false,
                delay_ms: CURSOR_HIT_TEST_IDLE_MS,
            };
        };
        #[cfg(windows)]
        let cursor = global_cursor_position();
        #[cfg(not(windows))]
        let cursor = global_cursor_position(window);
        let (Some(cursor), Ok(origin)) = (cursor, window.inner_position()) else {
            // Fail open. An ignored window cannot receive renderer mouse events,
            // so a cursor-query failure must never leave it permanently click-through.
            return CursorHitDecision {
                ignore: false,
                delay_ms: CURSOR_HIT_TEST_NEAR_MS,
            };
        };
        let scale = window
            .scale_factor()
            .ok()
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(1.0);

        let left = f64::from(origin.x) + bounds.x * scale;
        let top = f64::from(origin.y) + bounds.y * scale;
        let right = left + bounds.width * scale;
        let bottom = top + bounds.height * scale;
        let padding = CURSOR_HIT_PADDING * scale;
        let over_interactive_region = cursor.x >= left - padding
            && cursor.x <= right + padding
            && cursor.y >= top - padding
            && cursor.y <= bottom + padding;

        let dx = if cursor.x < left {
            left - cursor.x
        } else if cursor.x > right {
            cursor.x - right
        } else {
            0.0
        };
        let dy = if cursor.y < top {
            top - cursor.y
        } else if cursor.y > bottom {
            cursor.y - bottom
        } else {
            0.0
        };
        let delay_ms = if dx <= 96.0 * scale && dy <= 96.0 * scale {
            CURSOR_HIT_TEST_NEAR_MS
        } else {
            CURSOR_HIT_TEST_FAR_MS
        };

        CursorHitDecision {
            ignore: !over_interactive_region,
            delay_ms,
        }
    }

    pub fn set_visual_bounds(&self, label: &str, rect: &Value) -> Result<(), String> {
        fn number(rect: &Value, key: &str) -> Result<f64, String> {
            rect.get(key)
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .ok_or_else(|| format!("invalid visual bounds field: {key}"))
        }

        let bounds = VisualBounds {
            x: number(rect, "x")?,
            y: number(rect, "y")?,
            width: number(rect, "width")?,
            height: number(rect, "height")?,
        };
        if bounds.width <= 0.0
            || bounds.height <= 0.0
            || bounds.width > 4096.0
            || bounds.height > 4096.0
            || bounds.x.abs() > 4096.0
            || bounds.y.abs() > 4096.0
        {
            return Err("visual bounds outside supported range".into());
        }
        self.visual_bounds
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(label.to_string(), bounds);
        Ok(())
    }

    pub fn visual_bounds(&self, label: &str) -> Option<VisualBounds> {
        self.visual_bounds
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(label)
            .copied()
    }

    pub fn start_health_check(self: &Arc<Self>, app: AppHandle, runtime: Arc<Runtime>) {
        if self.health_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let state = self.clone();
        let _ = thread::Builder::new()
            .name("octopus-display-health".into())
            .spawn(move || loop {
                thread::sleep(Duration::from_secs(HEALTH_CHECK_SECS));
                if let Err(error) = state.recover_windows(&app, &runtime, false) {
                    runtime.write_log("display", &format!("health check failed: {error}"));
                }
            });
    }

    pub fn recover_windows(
        &self,
        app: &AppHandle,
        runtime: &Runtime,
        force: bool,
    ) -> Result<bool, String> {
        let pet = app.get_webview_window("pet").ok_or("pet window missing")?;
        let monitors = pet
            .available_monitors()
            .map_err(|error| error.to_string())?;
        if monitors.is_empty() {
            return Err("no monitor information available".into());
        }
        let mut signatures = monitors
            .iter()
            .map(|monitor| {
                format!(
                    "{}:{}:{}:{}:{:.3}",
                    monitor.position().x,
                    monitor.position().y,
                    monitor.size().width,
                    monitor.size().height,
                    monitor.scale_factor()
                )
            })
            .collect::<Vec<_>>();
        signatures.sort();
        let signature = signatures.join("|");
        let changed = {
            let mut previous = self
                .display_signature
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let changed = *previous != signature;
            *previous = signature;
            changed
        };
        if !force && !changed {
            return Ok(false);
        }

        let mut moved = false;
        for label in ["pet", "pet-codex", "panel"] {
            if let Some(window) = app.get_webview_window(label) {
                if ensure_window_visible(&window, &monitors)? {
                    moved = true;
                    if label == "pet" || label == "pet-codex" {
                        if let Ok(position) = window.outer_position() {
                            // R24 (2026-07-30): outer_position() returns
                            // PhysicalPosition; pet_position stores LOGICAL.
                            // Convert to match commit_win_pos's storage format.
                            let scale = window.scale_factor().unwrap_or(1.0);
                            let logical_x = (position.x as f64 / scale).round() as i32;
                            let logical_y = (position.y as f64 / scale).round() as i32;
                            let point = Some(crate::model::Point {
                                x: logical_x,
                                y: logical_y,
                            });
                            let _ = runtime.update_config(|config| {
                                if label == "pet-codex" {
                                    config.pet_position_codex = point;
                                } else {
                                    config.pet_position = point;
                                }
                            });
                        }
                    }
                }
            }
        }
        if moved {
            runtime.write_log(
                "display",
                "recovered off-screen window after display topology/resume event",
            );
        }
        Ok(moved)
    }
}

fn ensure_window_visible(
    window: &tauri::WebviewWindow,
    monitors: &[tauri::window::Monitor],
) -> Result<bool, String> {
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let right = i64::from(position.x) + i64::from(size.width);
    let bottom = i64::from(position.y) + i64::from(size.height);
    let visible = monitors.iter().any(|monitor| {
        let mp = monitor.position();
        let ms = monitor.size();
        let mr = i64::from(mp.x) + i64::from(ms.width);
        let mb = i64::from(mp.y) + i64::from(ms.height);
        let overlap_x = right.min(mr) - i64::from(position.x).max(i64::from(mp.x));
        let overlap_y = bottom.min(mb) - i64::from(position.y).max(i64::from(mp.y));
        overlap_x >= i64::from(VISIBLE_MARGIN) && overlap_y >= i64::from(VISIBLE_MARGIN)
    });
    if visible {
        return Ok(false);
    }

    let target = window
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .or_else(|| monitors.first().cloned())
        .ok_or("no target monitor")?;
    let area = target.work_area();
    let max_x =
        i64::from(area.position.x) + i64::from(area.size.width) - i64::from(size.width) - 24;
    let max_y =
        i64::from(area.position.y) + i64::from(area.size.height) - i64::from(size.height) - 24;
    let x = max_x
        .max(i64::from(area.position.x) + 24)
        .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
    let y = max_y
        .max(i64::from(area.position.y) + 24)
        .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
    window
        .set_position(Position::Physical(PhysicalPosition::new(x, y)))
        .map_err(|error| error.to_string())?;
    Ok(true)
}

pub fn focus_session(app: &AppHandle, state: &AppState, session_id: &str) -> Result<(), String> {
    let session = state
        .runtime
        .session(session_id)
        .ok_or("session no longer exists")?;
    if session.headless {
        return Err("headless sessions have no terminal window".into());
    }
    let source_pid = session
        .source_pid
        .ok_or("session did not report a source process")?;
    let chain = process_chain(source_pid);
    if chain.is_empty() {
        return Err("source process is no longer available".into());
    }
    focus_process_chain(&chain)?;
    state.runtime.write_log(
        "focus",
        &format!(
            "focused session {} from pid chain {:?}",
            session_id.chars().take(64).collect::<String>(),
            chain
        ),
    );
    for label in ["pet", "pet-codex"] {
        if let Some(pet) = app.get_webview_window(label) {
            let _ = pet.set_always_on_top(true);
        }
    }
    Ok(())
}

fn process_chain(start: u32) -> Vec<u32> {
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut current = start;
    for _ in 0..MAX_PARENT_DEPTH {
        if current <= 1 || !seen.insert(current) {
            break;
        }
        chain.push(current);
        let Some(parent) = parent_pid(current) else {
            break;
        };
        current = parent;
    }
    chain
}

#[cfg(unix)]
fn parent_pid(pid: u32) -> Option<u32> {
    let output = Command::new("ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

#[cfg(windows)]
fn parent_pid(pid: u32) -> Option<u32> {
    let script =
        "(Get-CimInstance Win32_Process -Filter ('ProcessId=' + $args[0])).ParentProcessId";
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
            &pid.to_string(),
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

#[cfg(target_os = "macos")]
fn focus_process_chain(chain: &[u32]) -> Result<(), String> {
    for pid in chain {
        let script = format!(
            "tell application \"System Events\" to set frontmost of first application process whose unix id is {} to true",
            pid
        );
        if Command::new("osascript")
            .args(["-e", &script])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return Ok(());
        }
    }
    Err("macOS could not map the session process tree to an application window; grant Accessibility permission if needed".into())
}

#[cfg(windows)]
fn focus_process_chain(chain: &[u32]) -> Result<(), String> {
    let pids = chain
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let script = r#"
$ids = $args[0].Split(',') | ForEach-Object { [uint32]$_ }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OctopusFocus {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
$script:found = $false
[OctopusFocus]::EnumWindows({ param($h,$x)
  [uint32]$pid = 0
  [void][OctopusFocus]::GetWindowThreadProcessId($h, [ref]$pid)
  if (-not $script:found -and $ids -contains $pid -and [OctopusFocus]::IsWindowVisible($h)) {
    [void][OctopusFocus]::ShowWindowAsync($h, 9)
    $script:found = [OctopusFocus]::SetForegroundWindow($h)
  }
  return -not $script:found
}, [IntPtr]::Zero) | Out-Null
if ($script:found) { exit 0 } else { exit 3 }
"#;
    let status = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
            &pids,
        ])
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Windows could not find a visible terminal window for the session process tree".into())
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn focus_process_chain(chain: &[u32]) -> Result<(), String> {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("DISPLAY").is_none() {
        return Err("terminal focus is unsupported on pure Wayland sessions; use the details panel or native terminal UI".into());
    }
    for pid in chain {
        if let Ok(output) = Command::new("xdotool")
            .args(["search", "--pid", &pid.to_string()])
            .output()
        {
            if output.status.success() {
                if let Some(window_id) = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if Command::new("xdotool")
                        .args(["windowactivate", "--sync", window_id])
                        .status()
                        .map(|status| status.success())
                        .unwrap_or(false)
                    {
                        return Ok(());
                    }
                }
            }
        }
    }
    Err("X11 terminal focus requires xdotool and a visible window owned by the session process tree".into())
}
