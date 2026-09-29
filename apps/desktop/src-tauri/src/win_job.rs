//! Ties every sidecar to a Windows Job Object that is killed when SCIP.exe dies.
//!
//! The normal shutdown path stops services in order, but if SCIP.exe crashes or is killed
//! from the Task Manager, an orphaned postgres.exe would keep `pgdata` locked and the next
//! launch would fail. The job's KILL_ON_JOB_CLOSE flag makes Windows clean up for us.

use std::process::Child;

#[cfg(windows)]
mod imp {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;

    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Stored as `usize` because raw handles are not `Send`. The handle is never closed on
    /// purpose: it must live exactly as long as the process.
    static JOB: OnceLock<Option<usize>> = OnceLock::new();

    fn job_handle() -> Option<usize> {
        *JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            (ok != 0).then_some(job as usize)
        })
    }

    pub fn adopt(child: &Child) {
        let Some(job) = job_handle() else {
            log::warn!("job object unavailable; sidecars may outlive a crash of SCIP");
            return;
        };
        let ok = unsafe { AssignProcessToJobObject(job as _, child.as_raw_handle() as _) };
        if ok == 0 {
            log::warn!("could not attach pid {} to the job object", child.id());
        }
    }
}

/// Best effort: failure only loses crash cleanup, never blocks startup.
pub fn adopt(child: &Child) {
    #[cfg(windows)]
    imp::adopt(child);
    #[cfg(not(windows))]
    let _ = child;
}
