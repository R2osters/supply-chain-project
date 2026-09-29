//! Screen 03 "Système": can this PC run SCIP? Each check is a pure function of a measured value,
//! so thresholds are tested without the machine; [`SystemProbe`] does the measuring.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::context::Locale;

/// Windows 10 1809: first build with the WebView2 and networking features SCIP relies on.
pub const MIN_WINDOWS_BUILD: u32 = 17763;
pub const MIN_FREE_DISK: u64 = 2 * GB;
pub const MIN_RAM: u64 = 4 * GB;
pub const API_PORT: u16 = 3001;
pub const GPS_PORT: u16 = 5023;
const GB: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Check {
    pub id: &'static str,
    pub status: CheckStatus,
    pub label: String,
    pub detail: String,
}

pub trait SystemProbe {
    fn windows_build(&self) -> Option<u32>;
    fn free_disk_bytes(&self, path: &Path) -> Option<u64>;
    fn total_ram_bytes(&self) -> Option<u64>;
    fn webview2_version(&self) -> Option<String>;
    fn port_free(&self, port: u16) -> bool;
    fn app_running_in(&self, dir: &Path) -> bool;
}

fn gb(bytes: u64) -> String {
    format!("{:.1}", bytes as f64 / GB as f64)
}

pub fn check_os(build: Option<u32>, l: Locale) -> Check {
    let label = l.pick("Windows 10 (1809) ou plus récent", "Windows 10 (1809) or later").into();
    let (status, detail) = match build {
        Some(b) if b >= MIN_WINDOWS_BUILD => (CheckStatus::Ok, format!("build {b}")),
        Some(b) => (
            CheckStatus::Fail,
            format!("build {b} < {MIN_WINDOWS_BUILD}: {}", l.pick("mettez Windows à jour", "update Windows")),
        ),
        // Unknown is not proof of too old; the WebView2 check catches truly old systems.
        None => (CheckStatus::Warn, l.pick("version inconnue", "unknown version").into()),
    };
    Check { id: "os", status, label, detail }
}

pub fn check_disk(free: Option<u64>, l: Locale) -> Check {
    let label = l.pick("Espace disque (2 Go)", "Disk space (2 GB)").into();
    let (status, detail) = match free {
        Some(f) if f >= MIN_FREE_DISK => {
            (CheckStatus::Ok, format!("{} {}", gb(f), l.pick("Go libres", "GB free")))
        }
        Some(f) => (
            CheckStatus::Fail,
            format!("{} {}", gb(f), l.pick("Go libres, 2 Go nécessaires", "GB free, 2 GB needed")),
        ),
        None => (CheckStatus::Warn, l.pick("espace libre inconnu", "free space unknown").into()),
    };
    Check { id: "disk", status, label, detail }
}

pub fn check_ram(total: Option<u64>, l: Locale) -> Check {
    let label = l.pick("Mémoire (4 Go conseillés)", "Memory (4 GB recommended)").into();
    // Not blocking (docs/installer.md): SCIP runs with less, just slowly.
    let (status, detail) = match total {
        // Firmware reserves a little, so a "4 GB" PC reports slightly less.
        Some(t) if t >= MIN_RAM - MIN_RAM / 20 => (CheckStatus::Ok, format!("{} Go", gb(t))),
        Some(t) => (
            CheckStatus::Warn,
            format!("{} Go: {}", gb(t), l.pick("SCIP sera plus lent", "SCIP will be slower")),
        ),
        None => (CheckStatus::Warn, l.pick("mémoire inconnue", "memory unknown").into()),
    };
    Check { id: "ram", status, label, detail }
}

pub fn check_webview2(version: Option<String>, l: Locale) -> Check {
    let label = "Microsoft Edge WebView2".into();
    match version {
        Some(v) => Check { id: "webview2", status: CheckStatus::Ok, label, detail: v },
        None => Check {
            id: "webview2",
            status: CheckStatus::Fail,
            label,
            detail: l
                .pick(
                    "absent : installez « WebView2 Runtime » depuis microsoft.com",
                    "missing: install the WebView2 Runtime from microsoft.com",
                )
                .into(),
        },
    }
}

pub fn check_api_port(free: bool, l: Locale) -> Check {
    Check {
        id: "port-api",
        status: if free { CheckStatus::Ok } else { CheckStatus::Warn },
        label: format!("{} {API_PORT}", l.pick("Port", "Port")),
        detail: if free {
            l.pick("libre", "free").into()
        } else {
            l.pick("occupé : SCIP choisira un autre port", "in use: SCIP will pick another port").into()
        },
    }
}

pub fn check_gps_port(free: bool, l: Locale) -> Check {
    Check {
        id: "port-gps",
        status: if free { CheckStatus::Ok } else { CheckStatus::Warn },
        label: format!("{} {GPS_PORT} (GPS)", l.pick("Port", "Port")),
        detail: if free {
            l.pick("libre", "free").into()
        } else {
            l.pick(
                "occupé : les boîtiers GPS ne pourront pas envoyer leurs positions",
                "in use: GPS trackers will not be able to send positions",
            )
            .into()
        },
    }
}

pub fn check_scip_running(running: bool, l: Locale) -> Check {
    Check {
        id: "scip-running",
        status: if running { CheckStatus::Fail } else { CheckStatus::Ok },
        label: l.pick("SCIP fermé", "SCIP closed").into(),
        detail: if running {
            l.pick("Fermez SCIP pour continuer", "Close SCIP to continue").into()
        } else {
            l.pick("aucune instance en cours", "not running").into()
        },
    }
}

/// Nearest existing folder: the install folder usually does not exist yet, but its drive does.
pub fn existing_ancestor(path: &Path) -> Option<PathBuf> {
    path.ancestors().find(|p| p.exists()).map(Path::to_path_buf)
}

pub fn run_system_checks(probe: &dyn SystemProbe, install_dir: &Path, locale: Locale) -> Vec<Check> {
    let disk_root = existing_ancestor(install_dir);
    vec![
        check_os(probe.windows_build(), locale),
        check_disk(disk_root.and_then(|root| probe.free_disk_bytes(&root)), locale),
        check_ram(probe.total_ram_bytes(), locale),
        check_webview2(probe.webview2_version(), locale),
        check_api_port(probe.port_free(API_PORT), locale),
        check_gps_port(probe.port_free(GPS_PORT), locale),
        check_scip_running(probe.app_running_in(install_dir), locale),
    ]
}

/// The WebView2 runtime registers under EdgeUpdate with this client id, per machine or per user
/// (Microsoft's documented detection method). `pv` of "0.0.0.0" means uninstalled.
pub const WEBVIEW2_CLIENT: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

pub fn usable_webview_version(pv: Option<String>) -> Option<String> {
    pv.map(|v| v.trim().to_string()).filter(|v| !v.is_empty() && v != "0.0.0.0")
}

/// Can we listen on `port` on all interfaces (as SCIP will)? A failure on any address counts:
/// something else (maybe an old SCIP) holds it.
pub fn port_is_free(port: u16) -> bool {
    use std::net::{Ipv4Addr, TcpListener};
    // One at a time: each listener is dropped at the end of its statement, so the second bind
    // does not collide with our own first one.
    let any = TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).is_ok();
    let local = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok();
    any && local
}

pub struct RealProbe;

#[cfg(windows)]
impl SystemProbe for RealProbe {
    fn windows_build(&self) -> Option<u32> {
        // The registry is not subject to the "compatibility manifest" lie of GetVersionEx.
        use winreg::enums::HKEY_LOCAL_MACHINE;
        let key = winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
            .ok()?;
        key.get_value::<String, _>("CurrentBuildNumber").ok()?.trim().parse().ok()
    }

    fn free_disk_bytes(&self, path: &Path) -> Option<u64> {
        use windows::core::HSTRING;
        use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let mut free: u64 = 0;
        unsafe { GetDiskFreeSpaceExW(&HSTRING::from(path), Some(&mut free), None, None).ok()? };
        Some(free)
    }

    fn total_ram_bytes(&self) -> Option<u64> {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut status =
            MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        unsafe { GlobalMemoryStatusEx(&mut status).ok()? };
        Some(status.ullTotalPhys)
    }

    fn webview2_version(&self) -> Option<String> {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        let machine = [
            format!(r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT}"),
            format!(r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT}"),
        ];
        let user = format!(r"Software\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT}");
        let candidates = machine
            .iter()
            .map(|k| (HKEY_LOCAL_MACHINE, k.as_str()))
            .chain([(HKEY_CURRENT_USER, user.as_str())]);
        for (hive, subkey) in candidates {
            let pv =
                winreg::RegKey::predef(hive).open_subkey(subkey).ok().and_then(|k| k.get_value("pv").ok());
            if let Some(v) = usable_webview_version(pv) {
                return Some(v);
            }
        }
        None
    }

    fn port_free(&self, port: u16) -> bool {
        port_is_free(port)
    }

    fn app_running_in(&self, dir: &Path) -> bool {
        crate::processes::app_running_in(crate::processes::list(), dir)
    }
}

#[cfg(not(windows))]
impl SystemProbe for RealProbe {
    fn windows_build(&self) -> Option<u32> {
        None
    }
    fn free_disk_bytes(&self, _path: &Path) -> Option<u64> {
        None
    }
    fn total_ram_bytes(&self) -> Option<u64> {
        None
    }
    fn webview2_version(&self) -> Option<String> {
        None
    }
    fn port_free(&self, port: u16) -> bool {
        port_is_free(port)
    }
    fn app_running_in(&self, _dir: &Path) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FR: Locale = Locale::Fr;

    #[test]
    fn os_threshold_is_1809() {
        assert_eq!(check_os(Some(17763), FR).status, CheckStatus::Ok);
        assert_eq!(check_os(Some(26200), FR).status, CheckStatus::Ok);
        assert_eq!(check_os(Some(17134), FR).status, CheckStatus::Fail);
        assert_eq!(check_os(None, FR).status, CheckStatus::Warn);
    }

    #[test]
    fn disk_needs_two_gigabytes() {
        assert_eq!(check_disk(Some(2 * GB), FR).status, CheckStatus::Ok);
        assert_eq!(check_disk(Some(2 * GB - 1), FR).status, CheckStatus::Fail);
        assert_eq!(check_disk(None, FR).status, CheckStatus::Warn);
    }

    #[test]
    fn low_ram_only_warns() {
        assert_eq!(check_ram(Some(16 * GB), FR).status, CheckStatus::Ok);
        assert_eq!(check_ram(Some(4 * GB - 100 * 1024 * 1024), FR).status, CheckStatus::Ok);
        assert_eq!(check_ram(Some(2 * GB), FR).status, CheckStatus::Warn);
    }

    #[test]
    fn webview_and_ports() {
        assert_eq!(check_webview2(None, FR).status, CheckStatus::Fail);
        assert_eq!(usable_webview_version(Some("0.0.0.0".into())), None);
        assert_eq!(usable_webview_version(Some(" 131.0.2903.70 ".into())).as_deref(), Some("131.0.2903.70"));
        assert_eq!(check_api_port(false, FR).status, CheckStatus::Warn);
        assert_eq!(check_gps_port(true, FR).status, CheckStatus::Ok);
        let running = check_scip_running(true, FR);
        assert_eq!(
            (running.status, running.detail.as_str()),
            (CheckStatus::Fail, "Fermez SCIP pour continuer")
        );
    }

    #[test]
    fn busy_port_is_detected() {
        let listener = std::net::TcpListener::bind(("0.0.0.0", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!port_is_free(port));
        drop(listener);
    }

    struct FakeProbe;
    impl SystemProbe for FakeProbe {
        fn windows_build(&self) -> Option<u32> {
            Some(22631)
        }
        fn free_disk_bytes(&self, _path: &Path) -> Option<u64> {
            Some(50 * GB)
        }
        fn total_ram_bytes(&self) -> Option<u64> {
            Some(8 * GB)
        }
        fn webview2_version(&self) -> Option<String> {
            Some("130.0".into())
        }
        fn port_free(&self, port: u16) -> bool {
            port != API_PORT
        }
        fn app_running_in(&self, _dir: &Path) -> bool {
            false
        }
    }

    #[test]
    fn all_checks_in_contract_order() {
        let tmp = tempfile::tempdir().unwrap();
        let checks = run_system_checks(&FakeProbe, &tmp.path().join("not").join("yet"), Locale::En);
        let ids: Vec<&str> = checks.iter().map(|c| c.id).collect();
        assert_eq!(ids, ["os", "disk", "ram", "webview2", "port-api", "port-gps", "scip-running"]);
        assert_eq!(checks[4].status, CheckStatus::Warn);
        assert!(checks.iter().all(|c| c.status != CheckStatus::Fail));
        let json = serde_json::to_value(&checks[0]).unwrap();
        assert_eq!(json["status"], "ok");
    }

    #[cfg(windows)]
    #[test]
    fn real_probe_reads_this_machine() {
        let probe = RealProbe;
        assert!(probe.windows_build().is_some_and(|b| b > 10000));
        assert!(probe.total_ram_bytes().is_some_and(|r| r > GB));
        let tmp = std::env::temp_dir();
        assert!(probe.free_disk_bytes(&tmp).is_some());
    }
}
