use crate::model::{now_ms, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const MAX_TRAVEL_MS: u64 = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TRAVEL_STATE_BYTES: u64 = 4 * 1024 * 1024;

/// P5-5 fix (R2): wait for a child process with a bounded timeout.
/// `child.wait()` can block forever if the child is unkillable (EPERM).
/// This polls `try_wait()` at 50ms intervals for up to `timeout`, then
/// gives up. Returns `Ok(status)` if the child exited, `Err(())` if
/// the timeout expired.
fn wait_bounded(
    child: &mut std::process::Child,
    timeout: Duration,
) -> Result<std::process::ExitStatus, ()> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {}
            Err(_) => return Err(()),
        }
        if Instant::now() >= deadline {
            return Err(());
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTrip {
    pub id: String,
    pub mode: String,
    pub provider: String,
    pub session_id: Option<String>,
    pub project: String,
    pub mission: String,
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Postcard {
    pub id: String,
    pub mode: String,
    pub provider: String,
    pub project: String,
    pub mission: String,
    pub summary: String,
    pub tokens: u64,
    pub started_at: u64,
    pub completed_at: u64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct PersistedTravel {
    active: Option<ActiveTrip>,
    postcards: Vec<Postcard>,
    total_tokens: u64,
    completed: u64,
    failed: u64,
    cancelled: u64,
}

pub struct TravelManager {
    path: PathBuf,
    persisted: Mutex<PersistedTravel>,
    active: Mutex<Option<ActiveTrip>>,
    child_pid: Mutex<Option<u32>>,
    cancel: AtomicBool,
}

impl TravelManager {
    pub fn open(app_dir: &Path) -> Arc<Self> {
        let path = app_dir.join("travel.json");
        let (mut persisted, converted_official) = load_persisted(&path);
        let recovered = if let Some(trip) = persisted.active.take() {
            persisted.failed = persisted.failed.saturating_add(1);
            persisted.postcards.push(interrupted_postcard(&trip));
            if persisted.postcards.len() > 100 {
                let extra = persisted.postcards.len() - 100;
                persisted.postcards.drain(0..extra);
            }
            true
        } else {
            false
        };
        let manager = Arc::new(Self {
            path,
            persisted: Mutex::new(persisted),
            active: Mutex::new(None),
            child_pid: Mutex::new(None),
            cancel: AtomicBool::new(false),
        });
        if recovered || converted_official {
            if let Err(error) = manager.persist() {
                eprintln!("[octopus] travel recovery persistence failed: {error}");
            }
        }
        manager
    }

    pub fn snapshot(&self) -> Value {
        let active = self
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let persisted = self
            .persisted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let child_pid = *self.child_pid.lock().unwrap_or_else(|e| e.into_inner());
        json!({
            "active": active,
            "childPid": child_pid,
            "postcards": persisted.postcards.iter().rev().take(30).cloned().collect::<Vec<_>>(),
            "growth": growth_view(&persisted),
            "maxDurationMinutes": 30,
        })
    }

    pub fn start_project(
        self: &Arc<Self>,
        app: AppHandle,
        runtime: Arc<Runtime>,
        session_id: String,
        mission: String,
    ) -> Result<Value, String> {
        let session = runtime
            .session(&session_id)
            .ok_or("session no longer exists")?;
        if session.headless {
            return Err("headless sessions cannot start travel".into());
        }
        if !matches!(session.provider.as_str(), "claude" | "codex") {
            return Err("travel currently supports Claude and Codex sessions".into());
        }
        let cwd = PathBuf::from(&session.cwd);
        if !cwd.is_dir() {
            return Err("session project directory is unavailable".into());
        }
        let project = project_name(&cwd);
        self.start(
            app,
            runtime,
            "travel",
            &session.provider,
            Some(session_id),
            project,
            cwd,
            mission,
        )
    }

    pub fn start_wander(
        self: &Arc<Self>,
        app: AppHandle,
        runtime: Arc<Runtime>,
        mission: String,
        provider: Option<String>,
    ) -> Result<Value, String> {
        let requested = provider
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_ascii_lowercase);
        let provider = match requested {
            Some(value) if matches!(value.as_str(), "claude" | "codex") => value,
            Some(_) => return Err("wander currently supports Claude and Codex only".into()),
            None => runtime
                .config()
                .providers
                .into_iter()
                .find(|value| matches!(value.as_str(), "claude" | "codex"))
                .unwrap_or_else(|| "claude".into()),
        };
        self.start(
            app,
            runtime,
            "wander",
            &provider,
            None,
            "Web Wander".into(),
            crate::model::home_dir(),
            mission,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn start(
        self: &Arc<Self>,
        app: AppHandle,
        runtime: Arc<Runtime>,
        mode: &str,
        provider: &str,
        session_id: Option<String>,
        project: String,
        cwd: PathBuf,
        mission: String,
    ) -> Result<Value, String> {
        let mission = clean_text(&mission, 1200);
        if mission.is_empty() {
            return Err("travel mission cannot be empty".into());
        }
        let executable = find_executable(provider)?;
        let mut active_guard = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if active_guard.is_some() {
            return Err("another trip is already running".into());
        }
        let trip = ActiveTrip {
            id: Uuid::new_v4().to_string(),
            mode: mode.into(),
            provider: provider.into(),
            session_id,
            project,
            mission,
            started_at: now_ms(),
        };
        *active_guard = Some(trip.clone());
        drop(active_guard);
        self.cancel.store(false, Ordering::Release);
        if let Err(error) = self.persist() {
            *self.active.lock().unwrap_or_else(|e| e.into_inner()) = None;
            return Err(format!("persist active travel state: {error}"));
        }
        let _ = app.emit("pet:travel", json!({"phase":"started","trip":trip.clone()}));
        let _ = app.emit(
            "pet:event",
            json!({
                "kind":"travel",
                "phase":"started",
                "provider":provider,
                "sessionId":trip.session_id,
                "text":if mode == "wander" { "开始闲逛网络" } else { "开始项目旅行" }
            }),
        );

        let manager = self.clone();
        thread::spawn(move || {
            // P5-4 fix (R2): wrap run_trip in catch_unwind so a panic
            // doesn't leave the trip permanently stuck in "traveling" state.
            // On panic, set active=None / child_pid=None, persist a failed
            // postcard, and emit pet:travel failed.
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                manager.run_trip(app.clone(), runtime.clone(), trip.clone(), executable, cwd);
            }));
            if let Err(panic_payload) = result {
                let msg = if let Some(s) = panic_payload.downcast_ref::<&str>() {
                    s.to_string()
                } else if let Some(s) = panic_payload.downcast_ref::<String>() {
                    s.clone()
                } else {
                    "unknown panic in travel worker".into()
                };
                eprintln!("[octopus] travel worker panic: {msg}");
                *manager.child_pid.lock().unwrap_or_else(|e| e.into_inner()) = None;
                let _ = fs::remove_file(
                    &runtime.app_dir.join(format!(".travel-{}.out", trip.id)),
                );
                let _ = fs::remove_file(
                    &runtime.app_dir.join(format!(".travel-{}.err", trip.id)),
                );
                *manager.active.lock().unwrap_or_else(|e| e.into_inner()) = None;
                let mut persisted = manager.persisted.lock().unwrap_or_else(|e| e.into_inner());
                persisted.failed = persisted.failed.saturating_add(1);
                persisted.postcards.push(Postcard {
                    id: trip.id.clone(),
                    mode: trip.mode.clone(),
                    provider: trip.provider.clone(),
                    project: trip.project.clone(),
                    mission: trip.mission.clone(),
                    summary: format!("internal error: {msg}"),
                    tokens: 0,
                    started_at: trip.started_at,
                    completed_at: now_ms(),
                    status: "failed".into(),
                });
                if persisted.postcards.len() > 100 {
                    let extra = persisted.postcards.len() - 100;
                    persisted.postcards.drain(0..extra);
                }
                drop(persisted);
                let _ = manager.persist();
                let _ = app.emit(
                    "pet:travel",
                    json!({"phase":"failed","trip":trip,"summary":format!("internal error: {msg}"),"tokens":0,"state":manager.snapshot()}),
                );
                let _ = app.emit(
                    "pet:event",
                    json!({"kind":"travel","phase":"failed","provider":trip.provider,"sessionId":trip.session_id,"text":"旅行线程内部错误"}),
                );
            }
        });
        Ok(self.snapshot())
    }

    fn run_trip(
        self: Arc<Self>,
        app: AppHandle,
        runtime: Arc<Runtime>,
        trip: ActiveTrip,
        executable: PathBuf,
        cwd: PathBuf,
    ) {
        let out_path = runtime.app_dir.join(format!(".travel-{}.out", trip.id));
        let err_path = runtime.app_dir.join(format!(".travel-{}.err", trip.id));
        let result = (|| -> Result<(String, u64), String> {
            let stdout = private_output_file(&out_path)?;
            let stderr = private_output_file(&err_path)?;
            let prompt = build_prompt(&trip);
            let args = provider_args(&trip);
            let mut command = provider_command(&executable, &args);
            command
                .current_dir(&cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::from(stdout))
                .stderr(Stdio::from(stderr));
            let mut child = command
                .spawn()
                .map_err(|error| format!("launch {}: {error}", trip.provider))?;
            let pid = child.id();
            *self.child_pid.lock().unwrap_or_else(|e| e.into_inner()) = Some(pid);
            let stdin_result = child
                .stdin
                .take()
                .ok_or_else(|| "travel CLI stdin was unavailable".to_string())
                .and_then(|mut stdin| {
                    stdin
                        .write_all(prompt.as_bytes())
                        .and_then(|_| stdin.flush())
                        .map_err(|error| format!("write travel prompt to stdin: {error}"))
                });
            if let Err(error) = stdin_result {
                let _ = crate::commands::kill_process_tree(pid);
                let _ = wait_bounded(&mut child, Duration::from_secs(2));
                return Err(error);
            }

            let started = Instant::now();
            let status = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break status,
                    Ok(None) => {}
                    Err(error) => {
                        // P5-5 fix (R2): kill best-effort, then bounded wait.
                        // On EPERM the child may be immortal (setuid, sandbox);
                        // we give it 2 seconds then proceed with cleanup.
                        let _ = crate::commands::kill_process_tree(pid);
                        let _ = child.kill();
                        let _ = wait_bounded(&mut child, Duration::from_secs(2));
                        return Err(format!("poll travel process: {error}"));
                    }
                }
                let stop_reason = if self.cancel.load(Ordering::Acquire) {
                    Some("cancelled".to_string())
                } else if started.elapsed() >= Duration::from_millis(MAX_TRAVEL_MS) {
                    Some("travel timed out after 30 minutes".to_string())
                } else if output_exceeded(&out_path, &err_path) {
                    Some("travel output exceeded 2 MiB".to_string())
                } else {
                    None
                };
                if let Some(reason) = stop_reason {
                    if let Err(error) = crate::commands::kill_process_tree(pid) {
                        let _ = child.kill();
                        // P5-5 fix (R2): bounded wait (2 s) to avoid blocking forever
                        // on EPERM (e.g. child dropped privileges / sandbox)
                        let _ = wait_bounded(&mut child, Duration::from_secs(2));
                        return Err(format!("{reason}; terminate process tree: {error}"));
                    }
                    let _ = wait_bounded(&mut child, Duration::from_secs(2));
                    return Err(reason);
                }
                thread::sleep(Duration::from_millis(50));
            };
            let output = read_bounded(&out_path);
            let errors = read_bounded(&err_path);
            if !status.success() {
                let message = clean_text(if errors.is_empty() { &output } else { &errors }, 2000);
                return Err(if message.is_empty() {
                    format!("{} exited with status {status}", trip.provider)
                } else {
                    message
                });
            }
            let tokens = usage_tokens(&output, &trip.provider);
            Ok((final_message(&output), tokens))
        })();
        *self.child_pid.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let _ = fs::remove_file(&out_path);
        let _ = fs::remove_file(&err_path);

        let (status, summary, tokens) = match result {
            Ok((summary, tokens)) => ("completed", summary, tokens),
            Err(error) if error == "cancelled" => ("cancelled", "旅行已取消".into(), 0),
            Err(error) => ("failed", error, 0),
        };
        {
            let mut persisted = self.persisted.lock().unwrap_or_else(|e| e.into_inner());
            persisted.total_tokens = persisted.total_tokens.saturating_add(tokens);
            match status {
                "completed" => persisted.completed = persisted.completed.saturating_add(1),
                "cancelled" => persisted.cancelled = persisted.cancelled.saturating_add(1),
                _ => persisted.failed = persisted.failed.saturating_add(1),
            }
            persisted.postcards.push(Postcard {
                id: trip.id.clone(),
                mode: trip.mode.clone(),
                provider: trip.provider.clone(),
                project: trip.project.clone(),
                mission: trip.mission.clone(),
                summary: clean_text(&summary, 5000),
                tokens,
                started_at: trip.started_at,
                completed_at: now_ms(),
                status: status.into(),
            });
            if persisted.postcards.len() > 100 {
                let extra = persisted.postcards.len() - 100;
                persisted.postcards.drain(0..extra);
            }
        }
        *self.active.lock().unwrap_or_else(|e| e.into_inner()) = None;
        if let Err(error) = self.persist() {
            runtime.write_log(
                "travel",
                &format!("persist completed travel state failed: {error}"),
            );
        }
        let snapshot = self.snapshot();
        // P5-3 fix (R2): stamp trip.id on every pet:travel emit so the
        // renderer can ignore terminal events from stale trips. Without this,
        // a fast cancel→new-start race could deliver "cancelled" for an old
        // trip after "started" for the new one, showing a cancel bubble over
        // an active trip.
        let _ = app.emit(
            "pet:travel",
            json!({
                "phase": status,
                "tripId": trip.id,
                "trip": trip.clone(),
                "summary": summary.clone(),
                "tokens": tokens,
                "state": snapshot.clone()
            }),
        );
        let _ = app.emit(
            "pet:event",
            json!({
                "kind":"travel",
                "phase":status,
                "provider":trip.provider,
                "sessionId":trip.session_id,
                "tripId":trip.id,
                "text":summary
            }),
        );
        crate::http_server::emit_stats_now(&app, &runtime);
    }

    pub fn cancel(&self) -> Result<Value, String> {
        if self
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_none()
        {
            return Err("no active trip".into());
        }
        self.cancel.store(true, Ordering::Release);
        // P5-2 fix: also kill the child directly so we don't depend solely on
        // the 50 ms worker poll. This closes the 50 ms window where cancel
        // could be requested but the child keeps running until the next poll
        // tick (or forever if the app exits within that window).
        self.kill_child_now();
        Ok(self.snapshot())
    }

    /// P5-1 fix: kill the in-flight child process and signal cancel so the
    /// worker thread winds down. Called from `RunEvent::ExitRequested` so the
    /// CLI child (and its process-group descendants) die with the app instead
    /// of being orphaned. Best-effort: errors are swallowed because the app
    /// is shutting down anyway and we must not block exit.
    pub fn shutdown(&self) {
        self.cancel.store(true, Ordering::Release);
        self.kill_child_now();
    }

    /// Kill the tracked child process tree if one is registered. Idempotent:
    /// safe to call when `child_pid` is `None` (no-op) and safe to call twice
    /// (the second `kill_process_tree` gets ESRCH and is treated as success).
    fn kill_child_now(&self) {
        let pid = *self.child_pid.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pid) = pid {
            // Delegates to platform-specific kill (taskkill /T on Windows,
            // kill(-pgid, SIGTERM then SIGKILL) on Unix). Errors are logged
            // via eprintln! (write_log may not be available in all contexts
            // and the app is typically exiting).
            if let Err(error) = crate::commands::kill_process_tree(pid) {
                eprintln!("[octopus] travel child kill failed for pid {pid}: {error}");
            }
        }
    }

    fn persist(&self) -> Result<(), String> {
        let active = self
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let mut persisted = self
            .persisted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        persisted.active = active;
        let bytes = serde_json::to_vec_pretty(&persisted).map_err(|error| error.to_string())?;
        write_private_atomic(&self.path, &bytes)
    }
}

fn load_persisted(path: &Path) -> (PersistedTravel, bool) {
    let value = match read_travel_value(path) {
        Ok(Some(value)) => value,
        Ok(None) => return (PersistedTravel::default(), false),
        Err(error) => {
            eprintln!("[octopus] ignored invalid travel state: {error}");
            return (PersistedTravel::default(), false);
        }
    };
    if value.get("postcards").is_some() || value.get("totalTokens").is_some() {
        return (serde_json::from_value(value).unwrap_or_default(), false);
    }
    let looks_official = value.get("schemaVersion").is_some()
        || value.get("history").is_some()
        || value.get("growth").is_some();
    if looks_official {
        return (official_travel_to_persisted(&value), true);
    }
    // Unknown/future documents must not be rewritten as an empty current file.
    (PersistedTravel::default(), false)
}

fn read_travel_value(path: &Path) -> Result<Option<Value>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    if metadata.len() > MAX_TRAVEL_STATE_BYTES {
        return Err(format!("{} exceeds the travel state limit", path.display()));
    }
    let file = File::open(path).map_err(|error| error.to_string())?;
    let opened = file.metadata().map_err(|error| error.to_string())?;
    if !opened.is_file() || opened.len() != metadata.len() || !same_opened_file(&metadata, &opened)
    {
        return Err(format!("{} changed while opening", path.display()));
    }
    let mut bytes = Vec::with_capacity(opened.len().min(MAX_TRAVEL_STATE_BYTES) as usize);
    file.take(MAX_TRAVEL_STATE_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_TRAVEL_STATE_BYTES {
        return Err(format!(
            "{} grew beyond the travel state limit",
            path.display()
        ));
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[cfg(unix)]
fn same_opened_file(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    before.dev() == after.dev() && before.ino() == after.ino()
}

#[cfg(not(unix))]
fn same_opened_file(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    before.len() == after.len()
}

fn official_travel_to_persisted(value: &Value) -> PersistedTravel {
    let growth = value.get("growth").unwrap_or(&Value::Null);
    let mut postcards = value
        .get("history")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(official_trip_to_postcard)
        .take(100)
        .collect::<Vec<_>>();
    let mut interrupted_count = 0u64;
    if let Some(active) = value.get("active").filter(|v| v.is_object()) {
        if let Some(mut interrupted) = official_trip_to_postcard(active) {
            interrupted.status = "interrupted".into();
            interrupted.summary = "应用迁移时发现未完成旅行，已标记为中断。".into();
            interrupted.completed_at = now_ms();
            postcards.insert(0, interrupted);
            interrupted_count = 1;
        }
    }
    postcards.truncate(100);
    let history_tokens = postcards.iter().fold(0u64, |total, postcard| {
        total.saturating_add(postcard.tokens)
    });
    let derived_completed = postcards
        .iter()
        .filter(|row| row.status == "completed")
        .count() as u64;
    let derived_failed = postcards
        .iter()
        .filter(|row| matches!(row.status.as_str(), "failed" | "interrupted"))
        .count() as u64;
    let derived_cancelled = postcards
        .iter()
        .filter(|row| row.status == "cancelled")
        .count() as u64;
    // Official history is newest-first; this fork stores oldest-first.
    postcards.reverse();
    let growth_tokens = json_u64(growth.get("totalTokens"));
    PersistedTravel {
        active: None,
        postcards,
        total_tokens: if growth_tokens > 0 {
            growth_tokens
        } else {
            history_tokens
        },
        completed: json_u64(growth.get("completed")).max(derived_completed),
        failed: json_u64(growth.get("failed"))
            .saturating_add(interrupted_count)
            .max(derived_failed),
        cancelled: json_u64(growth.get("cancelled")).max(derived_cancelled),
    }
}

fn official_trip_to_postcard(value: &Value) -> Option<Postcard> {
    let object = value.as_object()?;
    let text = |key: &str| object.get(key).and_then(Value::as_str).unwrap_or_default();
    let usage = object.get("usage").unwrap_or(&Value::Null);
    let id = clean_text(text("id"), 128);
    if id.is_empty() {
        return None;
    }
    let mode = match clean_text(text("mode"), 24).as_str() {
        "project" | "travel" => "travel".to_string(),
        "wander" => "wander".to_string(),
        _ => "travel".to_string(),
    };
    let provider = clean_text(
        if text("agent").is_empty() {
            text("provider")
        } else {
            text("agent")
        },
        24,
    )
    .to_ascii_lowercase();
    let status = match clean_text(text("status"), 32).as_str() {
        "completed" => "completed",
        "cancelled" | "canceled" => "cancelled",
        "interrupted" => "interrupted",
        _ => "failed",
    };
    Some(Postcard {
        id,
        mode,
        provider: if provider.is_empty() {
            "claude".into()
        } else {
            provider
        },
        project: clean_text(text("project"), 160),
        mission: clean_text(text("mission"), 1200),
        summary: clean_text(
            if text("result").is_empty() {
                text("summary")
            } else {
                text("result")
            },
            5000,
        ),
        tokens: json_u64(usage.get("tokens")).max(json_u64(object.get("tokens"))),
        started_at: json_u64(object.get("startedAt")),
        completed_at: json_u64(object.get("endedAt")).max(json_u64(object.get("completedAt"))),
        status: status.into(),
    })
}

fn json_u64(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_u64)
        .or_else(|| value.and_then(Value::as_f64).map(|n| n.max(0.0) as u64))
        .unwrap_or(0)
}

fn interrupted_postcard(trip: &ActiveTrip) -> Postcard {
    Postcard {
        id: trip.id.clone(),
        mode: trip.mode.clone(),
        provider: trip.provider.clone(),
        project: trip.project.clone(),
        mission: trip.mission.clone(),
        summary: "应用重启，旅行已中断。".into(),
        tokens: 0,
        started_at: trip.started_at,
        completed_at: now_ms(),
        status: "interrupted".into(),
    }
}

fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_file_name(format!(".travel.{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|e| e.to_string())?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temp);
        return Err(error.to_string());
    }
    #[cfg(windows)]
    {
        let backup = path.with_extension("json.bak");
        let _ = fs::remove_file(&backup);
        if path.exists() {
            fs::rename(path, &backup).map_err(|e| e.to_string())?;
        }
        if let Err(error) = fs::rename(&temp, path) {
            let _ = fs::rename(&backup, path);
            let _ = fs::remove_file(&temp);
            return Err(error.to_string());
        }
        let _ = fs::remove_file(&backup);
    }
    #[cfg(not(windows))]
    fs::rename(&temp, path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn provider_args(trip: &ActiveTrip) -> Vec<String> {
    if trip.provider == "claude" {
        let tools = if trip.mode == "wander" {
            "WebSearch,WebFetch"
        } else {
            "Read,Glob,Grep"
        };
        [
            "-p",
            "--permission-mode",
            "plan",
            "--tools",
            tools,
            "--strict-mcp-config",
            "--output-format",
            "json",
            "--max-turns",
            "8",
            "--no-session-persistence",
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    } else {
        let mut args = Vec::new();
        if trip.mode == "wander" {
            // `--search` is a global Codex flag, so it must precede `exec`.
            // It exposes the hosted web_search tool without granting shell
            // network access or relaxing the read-only sandbox.
            args.push("--search".to_string());
        }
        args.extend(
            [
                "exec",
                "--ephemeral",
                "--sandbox",
                "read-only",
                "--ask-for-approval",
                "never",
                "--json",
                "-",
            ]
            .into_iter()
            .map(str::to_string),
        );
        args
    }
}

#[cfg(unix)]
fn provider_command(executable: &Path, args: &[String]) -> Command {
    use std::os::unix::process::CommandExt;
    let mut command = Command::new(executable);
    command.args(args).process_group(0);
    command
}

#[cfg(windows)]
fn provider_command(executable: &Path, args: &[String]) -> Command {
    use std::os::windows::process::CommandExt;
    let extension = executable
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat") {
        let mut tail = vec![cmd_quote_arg(&executable.to_string_lossy())];
        tail.extend(args.iter().map(|value| cmd_quote_arg(value)));
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/S", "/C"]).raw_arg(tail.join(" "));
        command
    } else {
        let mut command = Command::new(executable);
        command.args(args);
        command
    }
}

#[cfg(windows)]
fn cmd_quote_arg(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn output_exceeded(stdout: &Path, stderr: &Path) -> bool {
    [stdout, stderr]
        .iter()
        .filter_map(|path| fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .fold(0u64, u64::saturating_add)
        > MAX_OUTPUT_BYTES
}

fn build_prompt(trip: &ActiveTrip) -> String {
    if trip.mode == "wander" {
        let tool_boundary = if trip.provider == "claude" {
            "Use only WebSearch/WebFetch."
        } else {
            "Use only the native web_search tool; do not use shell commands or local network clients."
        };
        format!(
            "You are Octopus on a short web wander. {tool_boundary} Do not modify local files. Mission: {}. Return a concise postcard in Chinese with: discoveries, useful links described by title/domain, and one practical takeaway.",
            trip.mission
        )
    } else {
        format!(
            "You are Octopus travelling through this project in strict read-only mode. Use only Read/Glob/Grep and do not modify files or run shell commands. Mission: {}. Return a concise Chinese postcard covering discoveries, important file paths, risks, and one suggested next step.",
            trip.mission
        )
    }
}

fn project_name(cwd: &Path) -> String {
    cwd.file_name()
        .and_then(|name| name.to_str())
        .map(|name| clean_text(name, 120))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| cwd.to_string_lossy().chars().take(120).collect())
}

fn clean_text(value: &str, max: usize) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_control() && c != '\n' && c != '\t' {
                ' '
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .chars()
        .take(max)
        .collect()
}

fn executable_names(provider: &str) -> Vec<String> {
    let base = provider;
    #[cfg(windows)]
    {
        vec![
            format!("{base}.exe"),
            format!("{base}.cmd"),
            format!("{base}.bat"),
            base.into(),
        ]
    }
    #[cfg(not(windows))]
    {
        vec![base.into()]
    }
}

fn find_executable(provider: &str) -> Result<PathBuf, String> {
    let names = executable_names(provider);
    for dir in env::var_os("PATH")
        .into_iter()
        .flat_map(|path| env::split_paths(&path).collect::<Vec<_>>())
    {
        for name in &names {
            let candidate = dir.join(name);
            if is_executable_file(&candidate) {
                return Ok(candidate);
            }
        }
    }
    Err(format!("{} CLI not found in PATH", provider))
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn private_output_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|error| error.to_string())
}

fn read_bounded(path: &Path) -> String {
    let Ok(file) = File::open(path) else {
        return String::new();
    };
    let mut bytes = Vec::with_capacity(MAX_OUTPUT_BYTES as usize);
    if file
        .take(MAX_OUTPUT_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .is_err()
    {
        return String::new();
    }
    bytes.truncate(MAX_OUTPUT_BYTES as usize);
    String::from_utf8_lossy(&bytes).into_owned()
}

fn final_message(output: &str) -> String {
    let mut fallback = String::new();
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if let Some(text) = value
                .get("result")
                .or_else(|| value.get("finalResponse"))
                .or_else(|| value.pointer("/item/text"))
                .or_else(|| value.pointer("/message/content/0/text"))
                .and_then(Value::as_str)
            {
                fallback = text.to_string();
            }
        } else {
            fallback.push_str(line);
            fallback.push('\n');
        }
    }
    let result = clean_text(&fallback, 5000);
    if result.is_empty() {
        "旅行完成，但 CLI 没有返回可展示的明信片。".into()
    } else {
        result
    }
}

fn usage_tokens(output: &str, provider: &str) -> u64 {
    output
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .map(|value| usage_tokens_value(&value, provider))
        .max()
        .unwrap_or(0)
}

fn usage_tokens_value(value: &Value, provider: &str) -> u64 {
    match value {
        Value::Object(map) => {
            let value_for = |keys: &[&str]| {
                keys.iter()
                    .filter_map(|key| map.get(*key).and_then(Value::as_u64))
                    .max()
                    .unwrap_or(0)
            };
            let total = value_for(&["total_tokens", "totalTokens"]);
            let input = value_for(&["input_tokens", "inputTokens"]);
            let output = value_for(&["output_tokens", "outputTokens"]);
            let direct = if total > 0 {
                total
            } else if provider == "claude" {
                input
                    .saturating_add(output)
                    .saturating_add(value_for(&[
                        "cache_read_input_tokens",
                        "cacheReadInputTokens",
                        "cached_input_tokens",
                        "cachedInputTokens",
                    ]))
                    .saturating_add(value_for(&[
                        "cache_creation_input_tokens",
                        "cacheCreationInputTokens",
                        "cache_write_input_tokens",
                        "cacheWriteInputTokens",
                    ]))
            } else {
                // Codex reports cached input as a subset of input tokens.
                input.saturating_add(output)
            };
            direct.max(
                map.values()
                    .map(|nested| usage_tokens_value(nested, provider))
                    .max()
                    .unwrap_or(0),
            )
        }
        Value::Array(values) => values
            .iter()
            .map(|nested| usage_tokens_value(nested, provider))
            .max()
            .unwrap_or(0),
        _ => 0,
    }
}

fn growth_view(persisted: &PersistedTravel) -> Value {
    let total_tokens = persisted.total_tokens;
    let units = total_tokens / 10_000;
    json!({
        "totalTokens": total_tokens,
        "completed": persisted.completed,
        "failed": persisted.failed,
        "cancelled": persisted.cancelled,
        "leaves": units % 4,
        "stars": (units / 4) % 4,
        "moons": (units / 16) % 4,
        "days": units / 64,
        "nextLeafTokens": 10_000 - (total_tokens % 10_000),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_history_and_growth_convert_without_losing_tokens() {
        let value = json!({
            "schemaVersion": 2,
            "active": null,
            "history": [{
                "id":"trip-1",
                "mode":"project",
                "agent":"codex",
                "project":"demo",
                "mission":"inspect",
                "result":"all good",
                "usage":{"tokens":12345},
                "startedAt":10,
                "endedAt":20,
                "status":"completed"
            }],
            "growth":{"totalTokens":54321,"completed":3,"failed":1,"cancelled":2}
        });
        let persisted = official_travel_to_persisted(&value);
        assert_eq!(persisted.postcards.len(), 1);
        assert_eq!(persisted.postcards[0].mode, "travel");
        assert_eq!(persisted.postcards[0].tokens, 12345);
        assert_eq!(persisted.total_tokens, 54321);
        assert_eq!(persisted.completed, 3);
        assert_eq!(persisted.failed, 1);
        assert_eq!(persisted.cancelled, 2);
    }

    #[test]
    fn structured_cli_output_yields_final_message_and_usage() {
        let output = concat!(
            "{\"type\":\"item.completed\",\"item\":{\"text\":\"first\"}}\n",
            "{\"result\":\"postcard\",\"usage\":{\"input_tokens\":100,\"output_tokens\":40}}\n"
        );
        assert_eq!(final_message(output), "postcard");
        assert_eq!(usage_tokens(output, "claude"), 140);
    }

    #[test]
    fn codex_cached_input_is_not_double_counted() {
        let output =
            r#"{"usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":40}}"#;
        assert_eq!(usage_tokens(output, "codex"), 140);
        assert_eq!(usage_tokens(output, "claude"), 220);
    }

    #[test]
    fn codex_wander_enables_hosted_search_before_exec() {
        let trip = ActiveTrip {
            id: "trip".into(),
            mode: "wander".into(),
            provider: "codex".into(),
            session_id: None,
            project: "Web Wander".into(),
            mission: "look around".into(),
            started_at: 1,
        };
        let args = provider_args(&trip);
        assert_eq!(args.first().map(String::as_str), Some("--search"));
        assert_eq!(args.get(1).map(String::as_str), Some("exec"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--sandbox" && pair[1] == "read-only"));
        assert!(build_prompt(&trip).contains("native web_search"));
    }

    #[test]
    fn official_active_trip_is_archived_as_failed() {
        let value = json!({
            "schemaVersion": 2,
            "active": {
                "id":"trip-active",
                "mode":"wander",
                "agent":"claude",
                "project":"Web Wander",
                "mission":"look around",
                "startedAt":10,
                "status":"running"
            },
            "history": [],
            "growth":{"totalTokens":0,"completed":0,"failed":2,"cancelled":0}
        });
        let persisted = official_travel_to_persisted(&value);
        assert!(persisted.active.is_none());
        assert_eq!(persisted.failed, 3);
        assert_eq!(persisted.postcards.len(), 1);
        assert_eq!(persisted.postcards[0].status, "interrupted");
    }
    #[test]
    fn unknown_travel_document_is_not_marked_for_conversion() {
        let path = std::env::temp_dir().join(format!(
            "octopus-travel-unknown-{}-{}.json",
            std::process::id(),
            Uuid::new_v4()
        ));
        fs::write(&path, br#"{"futureFormat":true}"#).unwrap();
        let (persisted, converted) = load_persisted(&path);
        assert!(!converted);
        assert!(persisted.postcards.is_empty());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn official_history_is_capped_after_inserting_interrupted_trip() {
        let history = (0..100)
            .map(|index| {
                json!({
                    "id": format!("trip-{index}"),
                    "mode": "project",
                    "agent": "Claude",
                    "status": "completed",
                    "usage": {"tokens": 1}
                })
            })
            .collect::<Vec<_>>();
        let value = json!({
            "history": history,
            "active": {"id":"active","mode":"project","agent":"codex","status":"running"},
            "growth": {}
        });
        let persisted = official_travel_to_persisted(&value);
        assert_eq!(persisted.postcards.len(), 100);
        assert_eq!(persisted.total_tokens, 99);
        assert_eq!(persisted.failed, 1);
    }
}
