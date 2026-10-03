use std::collections::HashSet;
use std::sync::Mutex;

#[derive(Debug, Default)]
struct DiagnosticState {
    provider: Option<String>,
    /// Tracks all child PIDs registered by parallel diagnostic probes.
    /// Multiple probes (e.g. `--version`, `doctor`, `auth status`) can run
    /// concurrently, each registering its own PID.
    pids: HashSet<u32>,
    cancel_requested: bool,
}

/// Owns the lifecycle of the single diagnostic job supported by the UI.
///
/// Provider ownership, child PID registration and cancellation live under one
/// mutex so these transitions cannot contradict each other. In particular, a
/// PID cannot be registered after cancellation without the caller being told
/// to terminate that just-spawned process immediately.
///
/// Supports multiple concurrent PIDs so that parallel diagnostic probes can
/// each register independently. Cancellation targets all tracked PIDs.
#[derive(Debug, Default)]
pub(crate) struct DiagnosticControl {
    state: Mutex<DiagnosticState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CancelRequest {
    pub active: bool,
    /// All child PIDs that were registered at the moment of cancellation.
    /// The caller must terminate each one.
    pub pids: Vec<u32>,
}

impl DiagnosticControl {
    pub(crate) fn begin(&self, provider: String) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(active) = state.provider.as_deref() {
            return Err(format!(
                "{active} diagnostic already in progress; cancel it first or wait for completion"
            ));
        }
        state.provider = Some(provider);
        state.pids.clear();
        state.cancel_requested = false;
        Ok(())
    }

    /// Registers a child process if cancellation has not already won the race.
    /// A false return means the caller must terminate the newly spawned child.
    /// Multiple PIDs can be registered concurrently for parallel probes.
    pub(crate) fn register_pid(&self, pid: u32) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.provider.is_none() || state.cancel_requested {
            return false;
        }
        state.pids.insert(pid);
        true
    }

    pub(crate) fn clear_pid(&self, pid: u32) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.pids.remove(&pid);
    }

    /// Claims responsibility for terminating a specific child. Exactly one
    /// caller can claim a given PID, preventing concurrent taskkill/killpg calls.
    pub(crate) fn claim_pid_for_termination(&self, pid: u32) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.pids.remove(&pid)
    }

    pub(crate) fn restore_pid_after_failed_termination(&self, pid: u32) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.provider.is_some() && state.cancel_requested {
            state.pids.insert(pid);
        }
    }

    pub(crate) fn is_cancel_requested(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .cancel_requested
    }

    /// Requests cancellation and returns all currently registered PIDs.
    /// The caller must terminate each one.
    pub(crate) fn request_cancel(&self) -> CancelRequest {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let active = state.provider.is_some();
        if active {
            state.cancel_requested = true;
        }
        let pids = if active {
            state.pids.drain().collect()
        } else {
            Vec::new()
        };
        CancelRequest { active, pids }
    }

    /// Releases all ownership after the blocking worker has returned or
    /// panicked. Callers must run this before propagating a join error.
    pub(crate) fn finish(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.provider = None;
        state.pids.clear();
        state.cancel_requested = false;
    }
}

#[cfg(test)]
mod tests {
    use super::DiagnosticControl;

    #[test]
    fn prevents_overlapping_diagnostics_and_resets_after_finish() {
        let control = DiagnosticControl::default();
        control.begin("claude".into()).unwrap();
        assert!(control.begin("codewhale".into()).is_err());
        control.finish();
        assert!(control.begin("codewhale".into()).is_ok());
    }

    #[test]
    fn cancellation_and_pid_registration_are_atomic() {
        let control = DiagnosticControl::default();
        control.begin("codewhale".into()).unwrap();
        let cancelled = control.request_cancel();
        assert!(cancelled.active);
        assert!(cancelled.pids.is_empty());
        assert!(!control.register_pid(42));
        assert!(control.is_cancel_requested());
    }

    #[test]
    fn cancel_returns_all_pids_and_clear_is_generation_safe() {
        let control = DiagnosticControl::default();
        control.begin("opencode".into()).unwrap();
        assert!(control.register_pid(41));
        assert!(control.register_pid(42));
        control.clear_pid(99); // non-existent, no-op
        let cancelled = control.request_cancel();
        assert!(cancelled.active);
        assert_eq!(cancelled.pids.len(), 2);
        assert!(cancelled.pids.contains(&41));
        assert!(cancelled.pids.contains(&42));
        // After cancel, claim should fail (already drained)
        assert!(!control.claim_pid_for_termination(41));
    }

    #[test]
    fn multiple_pids_register_and_clear_independently() {
        let control = DiagnosticControl::default();
        control.begin("claude".into()).unwrap();
        assert!(control.register_pid(10));
        assert!(control.register_pid(20));
        assert!(control.register_pid(30));
        control.clear_pid(20);
        // 20 is gone, but 10 and 30 remain
        assert!(!control.claim_pid_for_termination(20));
        assert!(control.claim_pid_for_termination(10));
        assert!(control.claim_pid_for_termination(30));
        assert!(control.request_cancel().pids.is_empty());
    }

    #[test]
    fn restore_pid_reinserts_after_failed_termination() {
        let control = DiagnosticControl::default();
        control.begin("claude".into()).unwrap();
        assert!(control.register_pid(55));
        control.request_cancel(); // drain all pids
        control.restore_pid_after_failed_termination(55);
        assert!(control.claim_pid_for_termination(55));
    }
}
