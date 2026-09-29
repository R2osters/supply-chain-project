//! Time source for the supervisor. Real time in the app, virtual time in tests so the
//! backoff and timeout paths run instantly and deterministically.

use std::time::{Duration, Instant};

pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
    fn sleep(&self, duration: Duration);
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

#[cfg(test)]
pub mod testing {
    use super::*;
    use std::sync::Mutex;

    /// `sleep` advances time without blocking and records what was asked for.
    pub struct FakeClock {
        origin: Instant,
        elapsed: Mutex<Duration>,
        pub sleeps: Mutex<Vec<Duration>>,
    }

    impl FakeClock {
        pub fn new() -> Self {
            Self {
                origin: Instant::now(),
                elapsed: Mutex::new(Duration::ZERO),
                sleeps: Mutex::new(Vec::new()),
            }
        }

        pub fn advance(&self, by: Duration) {
            *self.elapsed.lock().unwrap() += by;
        }
    }

    impl Default for FakeClock {
        fn default() -> Self {
            Self::new()
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Instant {
            self.origin + *self.elapsed.lock().unwrap()
        }

        fn sleep(&self, duration: Duration) {
            self.sleeps.lock().unwrap().push(duration);
            self.advance(duration);
        }
    }
}
