//! Free localhost ports for the sidecars.
//!
//! Fixed ports would collide with whatever else the user runs (a dev Postgres on 5432 is
//! common), so each launch asks the OS. The OS may hand the port to someone else between
//! our probe and the sidecar's bind; that window is milliseconds and a failed bind shows up
//! as a health-check timeout, which the supervisor already reports.

use std::io;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};

/// Returns `count` distinct free ports on 127.0.0.1.
///
/// All listeners stay open until every port is chosen, otherwise the OS could return the
/// same ephemeral port twice.
pub fn pick_free_ports(count: usize) -> io::Result<Vec<u16>> {
    let listeners: Vec<TcpListener> = (0..count)
        .map(|_| TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)))
        .collect::<io::Result<Vec<TcpListener>>>()?;
    listeners.iter().map(|listener: &TcpListener| listener.local_addr().map(|addr| addr.port())).collect()
}

pub fn pick_free_port() -> io::Result<u16> {
    Ok(pick_free_ports(1)?[0])
}

/// True when nothing listens on 127.0.0.1:`port` right now.
pub fn is_port_free(port: u16) -> bool {
    let local: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    // Its own statement: the probe must be closed before the port is asked for an answer.
    let bindable: bool = TcpListener::bind(local).is_ok();
    bindable && !answers(local)
}

/// macOS lets the bind above succeed while another program listens on the same port on every
/// interface: Rust asks for address reuse on Unix, which there allows a more specific address.
/// That program would still take the port from an API open to the local network, so on macOS
/// the port is also tried the way a client would.
#[cfg(target_os = "macos")]
fn answers(local: SocketAddrV4) -> bool {
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;
    TcpStream::connect_timeout(&SocketAddr::V4(local), Duration::from_millis(300)).is_ok()
}

#[cfg(not(target_os = "macos"))]
fn answers(_local: SocketAddrV4) -> bool {
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct ServicePorts {
    pub postgres: u16,
    pub api: u16,
    pub ai: u16,
}

/// Drivers' phones reach the API over the LAN, and a bookmarked address must survive restarts,
/// so the API keeps this port whenever it is free. Postgres and the AI stay on random ports:
/// only the desktop process talks to them.
pub const PREFERRED_API_PORT: u16 = 3001;

impl ServicePorts {
    pub fn pick() -> io::Result<Self> {
        Self::pick_with(is_port_free(PREFERRED_API_PORT))
    }

    fn pick_with(preferred_api_free: bool) -> io::Result<Self> {
        let ports: Vec<u16> = pick_free_ports(3)?;
        let api: u16 = if preferred_api_free { PREFERRED_API_PORT } else { ports[1] };
        Ok(Self { postgres: ports[0], api, ai: ports[2] })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn api_keeps_its_preferred_port_when_free() {
        let ports: ServicePorts = ServicePorts::pick_with(true).unwrap();
        assert_eq!(ports.api, PREFERRED_API_PORT);
        assert_ne!(ports.postgres, PREFERRED_API_PORT);
        assert_ne!(ports.ai, PREFERRED_API_PORT);
    }

    #[test]
    fn api_falls_back_to_a_random_port_when_taken() {
        let ports: ServicePorts = ServicePorts::pick_with(false).unwrap();
        assert_ne!(ports.api, PREFERRED_API_PORT);
    }

    #[test]
    fn picks_distinct_non_zero_ports() {
        let ports: Vec<u16> = pick_free_ports(8).unwrap();
        let unique: HashSet<u16> = ports.iter().copied().collect();
        assert_eq!(unique.len(), 8);
        assert!(ports.iter().all(|p: &u16| *p != 0));
    }

    #[test]
    fn picked_port_is_bindable_once_released() {
        let port: u16 = pick_free_port().unwrap();
        assert!(is_port_free(port));
    }

    #[test]
    fn occupied_port_is_not_free() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port: u16 = listener.local_addr().unwrap().port();
        assert!(!is_port_free(port));
    }

    /// A program listening on every interface holds the port on 127.0.0.1 too.
    #[cfg(unix)]
    #[test]
    fn a_port_taken_on_every_interface_is_not_free() {
        let listener = TcpListener::bind("0.0.0.0:0").unwrap();
        let port: u16 = listener.local_addr().unwrap().port();
        assert!(!is_port_free(port));
    }

    #[test]
    fn service_ports_are_distinct() {
        let ports = ServicePorts::pick().unwrap();
        assert!(ports.postgres != ports.api && ports.api != ports.ai && ports.ai != ports.postgres);
    }
}
