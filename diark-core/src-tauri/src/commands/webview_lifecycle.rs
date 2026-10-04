use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Instant;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SsoSessionId(pub String);

impl SsoSessionId {
    pub fn new(target: SsoTarget, label: &str) -> Self {
        Self(format!("{}-{}-{}", target.as_str(), label, uuid::Uuid::new_v4()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for SsoSessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SsoTarget {
    Portal,
    Wecode,
    Moodle,
}

impl SsoTarget {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Portal => "portal",
            Self::Wecode => "wecode",
            Self::Moodle => "moodle",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SsoOutcome {
    Success,
    AuthExpired,
    Failed(String),
    TimedOut,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CleanupReason {
    Success,
    AuthExpired,
    Failed(String),
    TimedOut,
    Cancelled,
    BuildError,
    AppExit,
}

impl CleanupReason {
    pub fn to_outcome(&self) -> SsoOutcome {
        match self {
            Self::Success => SsoOutcome::Success,
            Self::AuthExpired => SsoOutcome::AuthExpired,
            Self::Failed(s) => SsoOutcome::Failed(s.clone()),
            Self::TimedOut => SsoOutcome::TimedOut,
            Self::Cancelled => SsoOutcome::Cancelled,
            Self::BuildError => SsoOutcome::Failed("WINDOW_BUILD_ERROR".to_string()),
            Self::AppExit => SsoOutcome::Cancelled,
        }
    }
}

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum SsoError {
    #[error("Session already exists for target: {0}")]
    SessionAlreadyExists(String),
    #[error("Session not found: {0}")]
    SessionNotFound(String),
    #[error("Window build failed: {0}")]
    WindowBuildFailed(String),
    #[error("Window not found: {0}")]
    WindowNotFound(String),
    #[error("Process ownership violation: {0}")]
    ProcessOwnershipViolation(String),
    #[error("Internal SSO error: {0}")]
    Internal(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedWebviewProcess {
    pub pid: u32,
    pub owner_session: SsoSessionId,
    pub is_shared: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowAction {
    Created(SsoSessionId),
    ReusedExisting(SsoSessionId),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SsoSession {
    pub target: SsoTarget,
    pub label: String,
    pub is_silent: bool,
}

pub struct SsoSessionState {
    pub id: SsoSessionId,
    pub label: String,
    pub target: SsoTarget,
    pub is_silent: bool,
    pub started_at: Instant,
    pub cancellation: CancellationToken,
    pub completion: Option<oneshot::Sender<Result<SsoOutcome, SsoError>>>,
    pub owned_process: Option<OwnedWebviewProcess>,
    pub is_terminal: bool,
}

pub struct SsoRegistryInner {
    pub sessions: HashMap<SsoSessionId, SsoSessionState>,
    pub target_to_session: HashMap<SsoTarget, SsoSessionId>,
    pub label_to_session: HashMap<String, SsoSessionId>,
    pub receivers: HashMap<SsoSessionId, oneshot::Receiver<Result<SsoOutcome, SsoError>>>,
}

#[derive(Clone)]
pub struct SsoSessionRegistry {
    pub inner: Arc<StdMutex<SsoRegistryInner>>,
}

impl Default for SsoSessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl SsoSessionRegistry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(StdMutex::new(SsoRegistryInner {
                sessions: HashMap::new(),
                target_to_session: HashMap::new(),
                label_to_session: HashMap::new(),
                receivers: HashMap::new(),
            })),
        }
    }

    pub fn take_receiver(
        &self,
        session_id: &SsoSessionId,
    ) -> Option<oneshot::Receiver<Result<SsoOutcome, SsoError>>> {
        if let Ok(mut inner) = self.inner.lock() {
            inner.receivers.remove(session_id)
        } else {
            None
        }
    }

    pub fn set_owned_process(&self, session_id: &SsoSessionId, process: OwnedWebviewProcess) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(session) = inner.sessions.get_mut(session_id) {
                session.owned_process = Some(process);
            }
        }
    }

    pub fn active_session_count(&self) -> usize {
        if let Ok(inner) = self.inner.lock() {
            inner.sessions.len()
        } else {
            0
        }
    }

    pub fn get_session_by_target(&self, target: SsoTarget) -> Option<SsoSessionId> {
        if let Ok(inner) = self.inner.lock() {
            inner.target_to_session.get(&target).cloned()
        } else {
            None
        }
    }

    pub fn is_active(&self, session_id: &SsoSessionId) -> bool {
        if let Ok(inner) = self.inner.lock() {
            inner.sessions.contains_key(session_id)
        } else {
            false
        }
    }

    pub fn register(
        &self,
        target: SsoTarget,
        label: &str,
        is_silent: bool,
    ) -> Result<(WindowAction, CancellationToken), SsoError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| SsoError::Internal(format!("Registry mutex lock poisoned: {e}")))?;

        // 1. Singleton Invariant: Exactly one active session per target
        if let Some(existing_id) = inner.target_to_session.get(&target) {
            if let Some(existing_state) = inner.sessions.get(existing_id) {
                if !existing_state.is_terminal {
                    return Ok((
                        WindowAction::ReusedExisting(existing_id.clone()),
                        existing_state.cancellation.clone(),
                    ));
                }
            }
        }

        // 2. Create new session
        let session_id = SsoSessionId::new(target, label);
        let cancellation = CancellationToken::new();
        let (tx, rx) = oneshot::channel::<Result<SsoOutcome, SsoError>>();

        let state = SsoSessionState {
            id: session_id.clone(),
            label: label.to_string(),
            target,
            is_silent,
            started_at: Instant::now(),
            cancellation: cancellation.clone(),
            completion: Some(tx),
            owned_process: None,
            is_terminal: false,
        };

        inner.sessions.insert(session_id.clone(), state);
        inner.target_to_session.insert(target, session_id.clone());
        inner.label_to_session.insert(label.to_string(), session_id.clone());
        inner.receivers.insert(session_id.clone(), rx);

        Ok((WindowAction::Created(session_id), cancellation))
    }

    pub fn mark_terminal(
        &self,
        session_id: &SsoSessionId,
        reason: CleanupReason,
    ) -> Option<TerminalSessionData> {
        let mut inner = self.inner.lock().ok()?;

        let session = inner.sessions.get_mut(session_id)?;
        if session.is_terminal {
            return None;
        }
        session.is_terminal = true;
        session.cancellation.cancel();

        let label = session.label.clone();
        let target = session.target;
        let completion = session.completion.take();
        let owned = session.owned_process.clone();

        inner.target_to_session.remove(&target);
        inner.label_to_session.remove(&label);

        let mut other_pids = Vec::new();
        for (id, s) in inner.sessions.iter() {
            if id != session_id {
                if let Some(ref p) = s.owned_process {
                    other_pids.push(p.pid);
                }
            }
        }

        inner.sessions.remove(session_id);

        if let Some(tx) = completion {
            let _ = tx.send(Ok(reason.to_outcome()));
        }

        Some(TerminalSessionData {
            label,
            target,
            owned,
            other_pids,
            reason,
        })
    }

    pub fn get_cancellation_token(&self, session_id: &SsoSessionId) -> Option<CancellationToken> {
        if let Ok(inner) = self.inner.lock() {
            inner.sessions.get(session_id).map(|s| s.cancellation.clone())
        } else {
            None
        }
    }
}

#[derive(Debug, Clone)]
pub struct TerminalSessionData {
    pub label: String,
    pub target: SsoTarget,
    pub owned: Option<OwnedWebviewProcess>,
    pub other_pids: Vec<u32>,
    pub reason: CleanupReason,
}

static GLOBAL_REGISTRY: OnceLock<SsoSessionRegistry> = OnceLock::new();

pub fn get_or_init_registry(app: Option<&AppHandle>) -> SsoSessionRegistry {
    if let Some(a) = app {
        if let Some(reg) = a.try_state::<SsoSessionRegistry>() {
            return reg.inner().clone();
        }
    }
    GLOBAL_REGISTRY
        .get_or_init(SsoSessionRegistry::new)
        .clone()
}

pub fn ensure_sso_window(
    app: &AppHandle,
    session: SsoSession,
) -> Result<WindowAction, SsoError> {
    let registry = get_or_init_registry(Some(app));
    let (action, cancellation) = registry.register(session.target, &session.label, session.is_silent)?;

    match &action {
        WindowAction::ReusedExisting(_) => {
            if let Some(win) = app.get_webview_window(&session.label) {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
        WindowAction::Created(session_id) => {
            let app_handle = app.clone();
            let s_id = session_id.clone();
            let token = cancellation.clone();

            tauri::async_runtime::spawn(async move {
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(120)) => {
                        eprintln!("[SSO Lifecycle] 120s Watchdog expired for session {s_id}");
                        let _ = cleanup_sso_session(
                            &app_handle,
                            &s_id,
                            CleanupReason::TimedOut,
                        );
                    }
                    _ = token.cancelled() => {
                        // Watchdog aborted due to early completion or cancellation
                    }
                }
            });
        }
    }

    Ok(action)
}

pub fn cleanup_sso_session(
    app: &AppHandle,
    session_id: &SsoSessionId,
    reason: CleanupReason,
) -> Result<(), SsoError> {
    let registry = get_or_init_registry(Some(app));
    let terminal_data = match registry.mark_terminal(session_id, reason.clone()) {
        Some(data) => data,
        None => return Ok(()),
    };

    let label = &terminal_data.label;

    if let Some(reg) = app.try_state::<crate::commands::portal_auth::PartialStateRegistry>() {
        if let Ok(mut states) = reg.states.lock() {
            states.remove(label);
        }
    }

    let portal_harvester = crate::commands::portal_auth::get_portal_harvester_registry_static();
    if let Ok(mut sessions) = portal_harvester.sessions.lock() {
        sessions.remove(label);
    }

    let wecode_harvester = crate::commands::portal_auth::get_wecode_harvester_registry_static();
    if let Ok(mut sessions) = wecode_harvester.sessions.lock() {
        sessions.remove(label);
    }

    match &reason {
        CleanupReason::TimedOut => {
            let _ = app.emit("sso-callback-failed", "Quá thời gian đăng nhập (Timeout 120s)");
            let _ = app.emit_to("main", "portal-sync-failed", "Quá thời gian đăng nhập (Timeout 120s)");
            let _ = app.emit_to("main", "wecode-sync-failed", "Quá thời gian đăng nhập (Timeout 120s)");
        }
        CleanupReason::AuthExpired => {
            let _ = app.emit("sso-callback-failed", "Phiên đăng nhập hết hạn (Auth Expired)");
            let _ = app.emit_to("main", "portal-sync-failed", "AUTH_EXPIRED");
            let _ = app.emit_to("main", "wecode-sync-failed", "AUTH_EXPIRED");
        }
        CleanupReason::Failed(err) => {
            let _ = app.emit("sso-callback-error", err.clone());
            let _ = app.emit_to("main", "portal-sync-failed", err.clone());
            let _ = app.emit_to("main", "wecode-sync-failed", err.clone());
        }
        _ => {}
    }

    // Destroy WebviewWindow
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.destroy();
    }

    // Process Watchdog Contract: Terminate dedicated leftover process only if safety invariants are satisfied
    if let Some(owned) = terminal_data.owned {
        let _ = verify_and_terminate_process(&owned, &terminal_data.other_pids);
    }

    Ok(())
}

pub fn cleanup_all_sso_sessions(
    app: &AppHandle,
    registry: &SsoSessionRegistry,
    reason: CleanupReason,
) {
    let session_ids: Vec<SsoSessionId> = {
        if let Ok(inner) = registry.inner.lock() {
            inner.sessions.keys().cloned().collect()
        } else {
            Vec::new()
        }
    };

    for id in session_ids {
        let _ = cleanup_sso_session(app, &id, reason.clone());
    }
}

pub fn attach_window_process(
    registry: &SsoSessionRegistry,
    session_id: &SsoSessionId,
    window: &WebviewWindow,
) {
    #[cfg(target_os = "windows")]
    {
        if let Some(pid) = detect_webview_process_id(window) {
            let current_pid = std::process::id();
            // If the PID equals the host app process ID, it is shared with the main application!
            let is_shared = pid == current_pid;
            registry.set_owned_process(
                session_id,
                OwnedWebviewProcess {
                    pid,
                    owner_session: session_id.clone(),
                    is_shared,
                },
            );
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (registry, session_id, window);
    }
}

#[cfg(target_os = "windows")]
pub fn detect_webview_process_id(_window: &WebviewWindow) -> Option<u32> {
    None
}

#[cfg(target_os = "windows")]
pub fn verify_and_terminate_process(
    owned: &OwnedWebviewProcess,
    other_active_pids: &[u32],
) -> Result<(), SsoError> {
    let pid = owned.pid;
    let current_pid = std::process::id();

    // Invariant 1: PID cannot be 0 or equal to host app PID
    if pid == 0 || pid == current_pid {
        let msg = format!("Refusing to terminate PID {pid}: matches host app or invalid PID");
        eprintln!("[Process Watchdog] {msg}");
        return Err(SsoError::ProcessOwnershipViolation(msg));
    }

    // Invariant 2: Cannot be marked as shared
    if owned.is_shared {
        let msg = format!("Refusing to terminate PID {pid}: process is marked as shared");
        eprintln!("[Process Watchdog] {msg}");
        return Err(SsoError::ProcessOwnershipViolation(msg));
    }

    // Invariant 3: Cannot be shared with any other active SSO session
    if other_active_pids.contains(&pid) {
        let msg = format!("Refusing to terminate PID {pid}: process is shared with another active SSO session");
        eprintln!("[Process Watchdog] {msg}");
        return Err(SsoError::ProcessOwnershipViolation(msg));
    }

    // Invariant 4 & 5: Verified Windows process inspection and termination
    unsafe {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
        };
        use windows_sys::Win32::System::ProcessStatus::K32GetProcessImageFileNameA;

        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
            0,
            pid,
        );

        if handle == 0 {
            // Process does not exist or already exited cleanly
            return Ok(());
        }

        let mut image_name = [0u8; 512];
        let len = K32GetProcessImageFileNameA(handle, image_name.as_mut_ptr(), image_name.len() as u32);
        if len > 0 {
            let name_str = String::from_utf8_lossy(&image_name[..len as usize]).to_lowercase();
            // Invariant 5: Process must strictly be msedgewebview2.exe
            if !name_str.ends_with("msedgewebview2.exe") {
                CloseHandle(handle);
                let msg = format!("Refusing to terminate PID {pid}: process image {name_str} is not msedgewebview2.exe");
                eprintln!("[Process Watchdog] {msg}");
                return Err(SsoError::ProcessOwnershipViolation(msg));
            }
        }

        let res = TerminateProcess(handle, 1);
        CloseHandle(handle);

        if res == 0 {
            eprintln!("[Process Watchdog] Note: TerminateProcess returned 0 for PID {pid} (process may have already exited)");
        } else {
            eprintln!("[Process Watchdog] Successfully terminated dedicated WebView2 process {pid} for session {}", owned.owner_session);
        }
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn verify_and_terminate_process(
    _owned: &OwnedWebviewProcess,
    _other_active_pids: &[u32],
) -> Result<(), SsoError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sso_session_singleton_same_target_creates_only_one_session() {
        let registry = SsoSessionRegistry::new();
        let (action1, _) = registry
            .register(SsoTarget::Portal, "sso-portal-sync-window", false)
            .unwrap();
        assert!(matches!(action1, WindowAction::Created(_)));
        assert_eq!(registry.active_session_count(), 1);

        let s1_id = match action1 {
            WindowAction::Created(id) => id,
            _ => panic!("Expected Created"),
        };

        // Re-launching same target must reuse existing session without creating a new one
        let (action2, _) = registry
            .register(SsoTarget::Portal, "sso-portal-sync-window", false)
            .unwrap();
        assert!(matches!(action2, WindowAction::ReusedExisting(_)));
        assert_eq!(registry.active_session_count(), 1);

        let s2_id = match action2 {
            WindowAction::ReusedExisting(id) => id,
            _ => panic!("Expected ReusedExisting"),
        };
        assert_eq!(s1_id, s2_id, "Reused session ID must match initial session ID");
    }

    #[test]
    fn test_sso_session_terminal_callback_emits_one_result() {
        let registry = SsoSessionRegistry::new();
        let (action, _) = registry
            .register(SsoTarget::Wecode, "sso-wecode-sync-window", true)
            .unwrap();
        let session_id = match action {
            WindowAction::Created(id) => id,
            _ => panic!("Expected Created"),
        };

        let mut rx = registry.take_receiver(&session_id).expect("Receiver must exist");

        // Trigger terminal cleanup
        let data = registry.mark_terminal(&session_id, CleanupReason::Success);
        assert!(data.is_some());

        // First terminal callback receives outcome
        let outcome = rx.try_recv();
        assert!(matches!(outcome, Ok(Ok(SsoOutcome::Success))));

        // Second call is idempotent: does not panic or error, returns None
        let second = registry.mark_terminal(&session_id, CleanupReason::Failed("Duplicate".to_string()));
        assert!(second.is_none());

        // Registry has completely removed the session
        assert_eq!(registry.active_session_count(), 0);
    }

    #[test]
    fn test_sso_session_timeout_cancels_session() {
        let registry = SsoSessionRegistry::new();
        let (action, _) = registry
            .register(SsoTarget::Moodle, "sso-moodle-sync-window", false)
            .unwrap();
        let session_id = match action {
            WindowAction::Created(id) => id,
            _ => panic!("Expected Created"),
        };

        let mut rx = registry.take_receiver(&session_id).expect("Receiver must exist");

        let data = registry.mark_terminal(&session_id, CleanupReason::TimedOut);
        assert!(data.is_some());

        let outcome = rx.try_recv();
        assert!(matches!(outcome, Ok(Ok(SsoOutcome::TimedOut))));
        assert_eq!(registry.active_session_count(), 0);
    }

    #[test]
    fn test_sso_session_completion_before_deadline_cancels_timer() {
        let registry = SsoSessionRegistry::new();
        let (action, token) = registry
            .register(SsoTarget::Portal, "sso-portal-sync-window", false)
            .unwrap();
        let session_id = match action {
            WindowAction::Created(id) => id,
            _ => panic!("Expected Created"),
        };

        assert!(!token.is_cancelled(), "Token must not be cancelled initially");

        // Complete before deadline
        let _ = registry.mark_terminal(&session_id, CleanupReason::Success);

        assert!(token.is_cancelled(), "Token must be cancelled upon completion to abort watchdog");
    }

    #[test]
    fn test_sso_session_build_error_leaves_clean_registry() {
        let registry = SsoSessionRegistry::new();
        let (action, _) = registry
            .register(SsoTarget::Wecode, "sso-wecode-sync-window", true)
            .unwrap();
        let session_id = match action {
            WindowAction::Created(id) => id,
            _ => panic!("Expected Created"),
        };

        assert_eq!(registry.active_session_count(), 1);

        // Simulate build error cleanup
        let data = registry.mark_terminal(&session_id, CleanupReason::BuildError);
        assert!(data.is_some());

        // Zero junk in registry
        assert_eq!(registry.active_session_count(), 0);
        assert!(registry.get_session_by_target(SsoTarget::Wecode).is_none());
        assert!(!registry.is_active(&session_id));
    }

    #[test]
    fn test_sso_session_process_ownership_rules_reject_unsafe_termination() {
        let session_id = SsoSessionId::new(SsoTarget::Portal, "test");
        let current_pid = std::process::id();

        // 1. PID 0 rejected
        let proc_zero = OwnedWebviewProcess {
            pid: 0,
            owner_session: session_id.clone(),
            is_shared: false,
        };
        assert!(matches!(
            verify_and_terminate_process(&proc_zero, &[]),
            Err(SsoError::ProcessOwnershipViolation(_))
        ));

        // 2. Host app PID rejected
        let proc_host = OwnedWebviewProcess {
            pid: current_pid,
            owner_session: session_id.clone(),
            is_shared: false,
        };
        assert!(matches!(
            verify_and_terminate_process(&proc_host, &[]),
            Err(SsoError::ProcessOwnershipViolation(_))
        ));

        // 3. Shared process rejected
        let proc_shared = OwnedWebviewProcess {
            pid: 999998,
            owner_session: session_id.clone(),
            is_shared: true,
        };
        assert!(matches!(
            verify_and_terminate_process(&proc_shared, &[]),
            Err(SsoError::ProcessOwnershipViolation(_))
        ));

        // 4. Process shared with another active session rejected
        let proc_conflict = OwnedWebviewProcess {
            pid: 999997,
            owner_session: session_id,
            is_shared: false,
        };
        assert!(matches!(
            verify_and_terminate_process(&proc_conflict, &[999997, 88888]),
            Err(SsoError::ProcessOwnershipViolation(_))
        ));
    }

    #[test]
    fn test_sso_session_cleanup_reasons_map_to_proper_outcomes() {
        assert_eq!(CleanupReason::Success.to_outcome(), SsoOutcome::Success);
        assert_eq!(CleanupReason::AuthExpired.to_outcome(), SsoOutcome::AuthExpired);
        assert_eq!(CleanupReason::TimedOut.to_outcome(), SsoOutcome::TimedOut);
        assert_eq!(CleanupReason::Cancelled.to_outcome(), SsoOutcome::Cancelled);
        assert_eq!(
            CleanupReason::Failed("test_err".to_string()).to_outcome(),
            SsoOutcome::Failed("test_err".to_string())
        );
        assert_eq!(
            CleanupReason::BuildError.to_outcome(),
            SsoOutcome::Failed("WINDOW_BUILD_ERROR".to_string())
        );
        assert_eq!(CleanupReason::AppExit.to_outcome(), SsoOutcome::Cancelled);
    }
}
