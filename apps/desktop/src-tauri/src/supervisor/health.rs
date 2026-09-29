//! Readiness probes. Kept dependency-free: every probe targets 127.0.0.1 over plain HTTP,
//! so a 30-line client beats pulling in an HTTP stack.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use super::process::build_command;
use super::spec::{HealthCheck, ProcessCommand};

const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const IO_TIMEOUT: Duration = Duration::from_secs(2);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

pub trait HealthProber: Send + Sync {
    /// One attempt; the supervisor handles retries and the overall deadline.
    fn probe(&self, check: &HealthCheck) -> bool;
}

pub struct NetProber;

impl HealthProber for NetProber {
    fn probe(&self, check: &HealthCheck) -> bool {
        match check {
            HealthCheck::Tcp { port } => connect("127.0.0.1", *port).is_some(),
            HealthCheck::Http { host, port, path } => http_ok(host, *port, path),
            HealthCheck::Command(command) => command_succeeds(command),
        }
    }
}

fn connect(host: &str, port: u16) -> Option<TcpStream> {
    let addr: SocketAddr = (host, port).to_socket_addrs().ok()?.next()?;
    let stream: TcpStream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).ok()?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).ok()?;
    Some(stream)
}

fn http_ok(host: &str, port: u16, path: &str) -> bool {
    let Some(mut stream) = connect(host, port) else { return false };
    let request: String = format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head: [u8; 64] = [0; 64];
    let read: usize = stream.read(&mut head).unwrap_or(0);
    is_success_status_line(&String::from_utf8_lossy(&head[..read]))
}

/// `HTTP/1.1 200 OK` → true. Only the status code matters.
pub(crate) fn is_success_status_line(response_start: &str) -> bool {
    response_start
        .split_whitespace()
        .nth(1)
        .and_then(|code: &str| code.parse::<u16>().ok())
        .is_some_and(|code: u16| (200..300).contains(&code))
}

fn command_succeeds(command: &ProcessCommand) -> bool {
    let Ok(mut child) = build_command(command)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline: Instant = Instant::now() + COMMAND_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn parses_status_lines() {
        assert!(is_success_status_line("HTTP/1.1 200 OK\r\n"));
        assert!(is_success_status_line("HTTP/1.0 204 No Content"));
        assert!(!is_success_status_line("HTTP/1.1 503 Service Unavailable"));
        assert!(!is_success_status_line("garbage"));
        assert!(!is_success_status_line(""));
    }

    #[test]
    fn tcp_probe_sees_a_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port: u16 = listener.local_addr().unwrap().port();
        assert!(NetProber.probe(&HealthCheck::Tcp { port }));
        drop(listener);
        assert!(!NetProber.probe(&HealthCheck::Tcp { port }));
    }

    fn serve_once(status_line: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port: u16 = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                let mut buf: [u8; 512] = [0; 512];
                let _ = socket.read(&mut buf);
                let _ = socket.write_all(format!("{status_line}\r\nContent-Length: 0\r\n\r\n").as_bytes());
            }
        });
        port
    }

    #[test]
    fn http_probe_accepts_2xx_only() {
        let ok: u16 = serve_once("HTTP/1.1 200 OK");
        assert!(NetProber.probe(&HealthCheck::http_local(ok, "/health")));
        let down: u16 = serve_once("HTTP/1.1 503 Service Unavailable");
        assert!(!NetProber.probe(&HealthCheck::http_local(down, "/health")));
    }

    #[test]
    fn command_probe_fails_for_a_missing_program() {
        let cmd = ProcessCommand::new("definitely-not-a-real-program-scip");
        assert!(!NetProber.probe(&HealthCheck::Command(cmd)));
    }
}
