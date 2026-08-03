use crate::model::{AppState, Runtime};
use serde_json::Value;
use std::collections::HashSet;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, PhysicalPosition, Position};

const MAX_PARENT_DEPTH: usize = 16;
const HEALTH_CHECK_SECS: u64 = 30;
// R37 (2026-08-01): adaptive cursor hit-test polling. The 0.5.12 carpet
// audit P1-4 flagged that the fixed 24ms poll (~42Hz) runs forever even
// when the pet is idle and no click-through is requested. Now we use:
//   - CURSOR_HIT_TEST_MS (24ms) when mouse_ignore_requested is true
//     (active click-through management — need responsive cursor tracking)
//   - CURSOR_HIT_TEST_IDLE_MS (250ms) when mouse_ignore_requested is false
//     (idle — just checking if the flag flipped, ~4Hz is sufficient)
// This reduces idle wakeups by ~10× with no user-visible difference.
const CURSOR_HIT_TEST_MS: u64 = 24;
const CURSOR_HIT_TEST_IDLE_MS: u64 = 250;
const CURSOR_HIT_PADDING: f64 = 6.0;
const VISIBLE_MARGIN: i32 = 48;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VisualBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Default)]
pub struct PlatformState {
    health_started: AtomicBool,
    cursor_hit_test_started: AtomicBool,
    display_signature: Mutex<String>,
    ui_busy: AtomicBool,
    mouse_ignore_requested: AtomicBool,
    mouse_ignore_applied: AtomicBool,
    visual_bounds: Mutex<Option<VisualBounds>>,
}

impl PlatformState {
    pub fn set_ui_busy(&self, on: bool) {
        self.ui_busy.store(on, Ordering::Release);
    }

    pub fn is_ui_busy(&self) -> bool {
        self.ui_busy.load(Ordering::Acquire)
    }

    pub fn request_mouse_ignore(&self, on: bool) {
        self.mouse_ignore_requested.store(on, Ordering::Release);
    }

    pub fn start_cursor_hit_test(self: &Arc<Self>, app: AppHandle) {
        if self.cursor_hit_test_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let state = self.clone();
        let _ = thread::Builder::new()
            .name("octopus-cursor-hit-test".into())
            .spawn(move || loop {
                // R37: adaptive sleep — 24ms when actively managing click-through
                // (mouse_ignore_requested=true), 250ms when idle. This reduces
                // idle CPU wakeups from ~42Hz to ~4Hz.
                let requested = state.mouse_ignore_requested.load(Ordering::Acquire);
                let sleep_ms = if requested {
                    CURSOR_HIT_TEST_MS
                } else {
                    CURSOR_HIT_TEST_IDLE_MS
                };
                thread::sleep(Duration::from_millis(sleep_ms));
                let Some(window) = app.get_webview_window("pet") else {
                    continue;
                };
                let ignore = state.should_ignore_cursor(&window);
                let previous = state.mouse_ignore_applied.load(Ordering::Acquire);
                if previous != ignore && window.set_ignore_cursor_events(ignore).is_ok() {
                    state.mouse_ignore_applied.store(ignore, Ordering::Release);
                }
            });
    }

    fn should_ignore_cursor(&self, window: &tauri::WebviewWindow) -> bool {
        if !self.mouse_ignore_requested.load(Ordering::Acquire) {
            return false;
        }
        let Some(bounds) = self.visual_bounds() else {
            // Never enter an unrecoverable click-through state before the
            // renderer has reported a usable hit target.
            return false;
        };
        let Ok(cursor) = window.cursor_position() else {
            return false;
        };
        let Ok(origin) = window.inner_position() else {
            return false;
        };
        let scale = window
            .scale_factor()
            .ok()
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(1.0);
        let padding = CURSOR_HIT_PADDING * scale;
        let left = f64::from(origin.x) + bounds.x * scale - padding;
        let top = f64::from(origin.y) + bounds.y * scale - padding;
        let right = left + bounds.width * scale + padding * 2.0;
        let bottom = top + bounds.height * scale + padding * 2.0;
        let over_interactive_region =
            cursor.x >= left && cursor.x <= right && cursor.y >= top && cursor.y <= bottom;
        !over_interactive_region
    }

    pub fn set_visual_bounds(&self, rect: &Value) -> Result<(), String> {
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
        *self
            .visual_bounds
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(bounds);
        Ok(())
    }

    pub fn visual_bounds(&self) -> Option<VisualBounds> {
        *self
            .visual_bounds
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub fn start_health_check(self: &Arc<Self>, app: AppHandle, runtime: Arc<Runtime>) {
        if self.health_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let state = self.clone();
        let _ = thread::Builder::new()
            .name("re-llmpet-display-health".into())
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
        for label in ["pet", "panel"] {
            if let Some(window) = app.get_webview_window(label) {
                if ensure_window_visible(&window, &monitors)? {
                    moved = true;
                    if label == "pet" {
                        if let Ok(position) = window.outer_position() {
                            // R24 (2026-07-30): outer_position() returns
                            // PhysicalPosition; pet_position stores LOGICAL.
                            // Convert to match commit_win_pos's storage format.
                            let scale = window.scale_factor().unwrap_or(1.0);
                            let logical_x = (position.x as f64 / scale).round() as i32;
                            let logical_y = (position.y as f64 / scale).round() as i32;
                            let _ = runtime.update_config(|config| {
                                config.pet_position = Some(crate::model::Point {
                                    x: logical_x,
                                    y: logical_y,
                                });
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
    if let Some(pet) = app.get_webview_window("pet") {
        let _ = pet.set_always_on_top(true);
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
