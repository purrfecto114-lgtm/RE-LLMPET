use serde::Deserialize;
use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

pub(crate) const SERVER_ID: &str = "re-llmpet";
pub(crate) const SERVER_HEADER: &str = "x-re-llmpet-server";
pub(crate) const TOKEN_HEADER: &str = "x-re-llmpet-token";
pub(crate) const BASE_PORT: u16 = 41330;
pub(crate) const PORT_COUNT: u16 = 5;
const MAX_RESPONSE_BYTES: usize = 32 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(650);
const RETRY_DELAY: Duration = Duration::from_millis(75);

#[derive(Debug, Deserialize)]
struct RuntimeFile {
    app: String,
    port: u16,
    token: String,
    #[serde(default)]
    pid: Option<u32>,
}

pub(crate) fn default_runtime_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .map(|home| home.join(".re-llmpet").join("runtime.json"))
}

/// Activates the instance named by the authenticated runtime file.
///
/// A public `/state` response is intentionally not enough to suppress startup:
/// another loopback process could imitate that endpoint. Only possession of the
/// current runtime token and a matching authenticated `/activate` response
/// proves ownership strongly enough for this compatibility guard.
pub(crate) fn activate_runtime_instance(runtime_path: &Path) -> Result<u16, String> {
    let runtime = read_runtime(runtime_path)?;
    activate_existing_with_retry(runtime_path, runtime.port, 4)?;
    Ok(runtime.port)
}

pub(crate) fn activate_existing_with_retry(
    runtime_path: &Path,
    expected_port: u16,
    attempts: usize,
) -> Result<(), String> {
    let attempts = attempts.max(1);
    let mut last_error = String::from("activation was not attempted");
    for attempt in 0..attempts {
        match activate_existing(runtime_path, expected_port) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = error,
        }
        if attempt + 1 < attempts {
            thread::sleep(RETRY_DELAY);
        }
    }
    Err(last_error)
}

pub(crate) fn activate_existing(runtime_path: &Path, expected_port: u16) -> Result<(), String> {
    let runtime = read_runtime(runtime_path)?;
    if runtime.port != expected_port {
        return Err("runtime port does not match the occupied compatibility port".into());
    }
    let body = b"{}";
    let request = format!(
        "POST /activate HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Re-Llmpet-Token: {}\r\nX-Re-Llmpet-Server: {}\r\nConnection: close\r\n\r\n",
        runtime.port,
        body.len(),
        runtime.token,
        SERVER_ID
    );
    let mut payload = request.into_bytes();
    payload.extend_from_slice(body);
    let response = exchange(runtime.port, &payload)?;
    if response_matches(&response) {
        Ok(())
    } else {
        Err("existing instance rejected authenticated activation".into())
    }
}

/// Removes a stale runtime credential only when it still belongs to this exact
/// server. Token + port + PID matching prevents an older process from deleting
/// a newer instance's runtime file during overlapping shutdown/startup.
pub(crate) fn remove_runtime_if_owned(
    runtime_path: &Path,
    expected_port: u16,
    expected_token: &str,
    expected_pid: u32,
) -> Result<bool, String> {
    let runtime = match read_runtime(runtime_path) {
        Ok(runtime) => runtime,
        Err(_) if !runtime_path.exists() => return Ok(false),
        Err(error) => return Err(error),
    };
    if runtime.port != expected_port
        || runtime.token != expected_token
        || runtime.pid != Some(expected_pid)
    {
        return Ok(false);
    }
    fs::remove_file(runtime_path).map_err(|error| error.to_string())?;
    Ok(true)
}

fn read_runtime(runtime_path: &Path) -> Result<RuntimeFile, String> {
    let metadata = fs::metadata(runtime_path).map_err(|error| error.to_string())?;
    if metadata.len() > 16 * 1024 {
        return Err("runtime file exceeds 16 KiB".into());
    }
    let runtime: RuntimeFile = serde_json::from_slice(
        &fs::read(runtime_path).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if runtime.app != SERVER_ID || !port_in_range(runtime.port) || !valid_token(&runtime.token) {
        return Err("runtime identity is invalid".into());
    }
    Ok(runtime)
}

fn port_in_range(port: u16) -> bool {
    (BASE_PORT..BASE_PORT + PORT_COUNT).contains(&port)
}

fn exchange(port: u16, request: &[u8]) -> Result<Vec<u8>, String> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(CONNECT_TIMEOUT))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(CONNECT_TIMEOUT))
        .map_err(|error| error.to_string())?;
    stream.write_all(request).map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())?;

    let mut response = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    loop {
        let read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        if response.len() + read > MAX_RESPONSE_BYTES {
            return Err("instance response exceeds 32 KiB".into());
        }
        response.extend_from_slice(&chunk[..read]);
    }
    Ok(response)
}

fn response_matches(response: &[u8]) -> bool {
    let Some(split) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let head = String::from_utf8_lossy(&response[..split]).to_ascii_lowercase();
    if !head.starts_with("http/1.1 200 ")
        || !head.contains(&format!("{}: {}", SERVER_HEADER, SERVER_ID))
    {
        return false;
    }
    serde_json::from_slice::<Value>(&response[split + 4..])
        .ok()
        .and_then(|body| body.get("ok").and_then(Value::as_bool))
        == Some(true)
}

fn valid_token(token: &str) -> bool {
    (32..=128).contains(&token.len())
        && token
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_authenticated_success_response() {
        let response = b"HTTP/1.1 200 OK\r\nx-re-llmpet-server: re-llmpet\r\n\r\n{\"ok\":true}";
        assert!(response_matches(response));
    }

    #[test]
    fn rejects_identity_drift() {
        let response = b"HTTP/1.1 200 OK\r\nx-re-llmpet-server: other\r\n\r\n{\"ok\":true}";
        assert!(!response_matches(response));
    }

    #[test]
    fn accepts_only_compatibility_ports() {
        assert!(port_in_range(BASE_PORT));
        assert!(port_in_range(BASE_PORT + PORT_COUNT - 1));
        assert!(!port_in_range(BASE_PORT - 1));
        assert!(!port_in_range(BASE_PORT + PORT_COUNT));
    }
}
