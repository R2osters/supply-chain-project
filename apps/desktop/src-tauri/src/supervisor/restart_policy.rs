//! ============================================================================
//!  RESTART POLICY — the one place to tune how crashed sidecars are relaunched.
//! ============================================================================
//!
//! Defaults: at most 3 restarts in a row, waiting 1 s, then 2 s, then 4 s. A process that
//! stayed up for 5 minutes or more is considered to have recovered, so its counter starts
//! over; without that, three unrelated crashes spread over a week would disable the service.
//!
//! Why these numbers: a sidecar that dies within seconds three times in a row is almost
//! always broken (bad migration, port stolen, corrupt data), and looping forever would hide
//! the error from the user. The backoff leaves the OS time to release ports and file locks.

use std::time::Duration;

pub const MAX_RESTARTS: u32 = 3;
pub const BASE_BACKOFF: Duration = Duration::from_secs(1);
/// Uptime after which a crash counts as a fresh incident, not part of a crash loop.
pub const STABLE_UPTIME: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartDecision {
    /// Wait `after`, then start again. `attempt` is the new consecutive-restart count
    /// (1 for the first restart) and must be fed back as `attempts` on the next crash.
    Restart { after: Duration, attempt: u32 },
    /// Stop trying and show the error with the log path.
    GiveUp,
}

/// `attempts`: restarts already made in the current crash streak.
/// `last_uptime`: how long the process ran before this crash.
pub fn restart_decision(attempts: u32, last_uptime: Duration) -> RestartDecision {
    let streak: u32 = if last_uptime >= STABLE_UPTIME { 0 } else { attempts };
    if streak >= MAX_RESTARTS {
        return RestartDecision::GiveUp;
    }
    RestartDecision::Restart { after: BASE_BACKOFF * 2u32.pow(streak), attempt: streak + 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUICK: Duration = Duration::from_secs(3);

    fn restart(after_secs: u64, attempt: u32) -> RestartDecision {
        RestartDecision::Restart { after: Duration::from_secs(after_secs), attempt }
    }

    #[test]
    fn backs_off_exponentially_then_gives_up() {
        assert_eq!(restart_decision(0, QUICK), restart(1, 1));
        assert_eq!(restart_decision(1, QUICK), restart(2, 2));
        assert_eq!(restart_decision(2, QUICK), restart(4, 3));
        assert_eq!(restart_decision(3, QUICK), RestartDecision::GiveUp);
        assert_eq!(restart_decision(50, QUICK), RestartDecision::GiveUp);
    }

    #[test]
    fn long_uptime_resets_the_streak() {
        assert_eq!(restart_decision(3, STABLE_UPTIME), restart(1, 1));
        assert_eq!(restart_decision(2, Duration::from_secs(3600)), restart(1, 1));
    }

    #[test]
    fn just_under_the_stable_threshold_still_counts() {
        let almost: Duration = STABLE_UPTIME - Duration::from_millis(1);
        assert_eq!(restart_decision(3, almost), RestartDecision::GiveUp);
    }

    #[test]
    fn feeding_attempt_back_walks_the_whole_schedule() {
        let mut attempts: u32 = 0;
        let mut delays: Vec<u64> = Vec::new();
        while let RestartDecision::Restart { after, attempt } = restart_decision(attempts, QUICK) {
            delays.push(after.as_secs());
            attempts = attempt;
        }
        assert_eq!(delays, vec![1, 2, 4]);
    }
}
