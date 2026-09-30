//! Starting the downloaded installer so that it outlives SCIP, which closes right after.

use std::path::Path;
use std::process::{Command, Stdio};

/// `--update`: upgrade at once and relaunch SCIP. With `--no-launch` (SCIP is closing): upgrade
/// and stay closed.
pub fn installer_args(relaunch: bool) -> Vec<&'static str> {
    if relaunch {
        vec!["--update"]
    } else {
        vec!["--update", "--no-launch"]
    }
}

/// Detached from SCIP (own process group, no console, no inherited handles): the installer stops
/// what remains of SCIP in its folder and replaces its files.
pub fn spawn_installer(path: &Path, relaunch: bool) -> std::io::Result<()> {
    let mut command = Command::new(path);
    command.args(installer_args(relaunch)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if let Some(dir) = path.parent() {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    command.spawn().map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_scip_never_relaunches_it() {
        assert_eq!(installer_args(true), ["--update"]);
        assert_eq!(installer_args(false), ["--update", "--no-launch"]);
    }
}
