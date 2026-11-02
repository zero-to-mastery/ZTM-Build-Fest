//! The delay before a child that stopped on its own is started again: one
//! second, doubling to a minute, and back to one second once a child has
//! run for a minute. The same schedule as the launcher's `--supervise`
//! (server/launcher.mjs), so a crash loop costs little and a rare crash is
//! answered quickly.

use std::time::Duration;

pub const MIN_DELAY: Duration = Duration::from_secs(1);
pub const MAX_DELAY: Duration = Duration::from_secs(60);
/// A child that ran this long is healthy again; its failure starts over.
pub const RESET_AFTER: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backoff {
    next: Duration,
    min: Duration,
    max: Duration,
    reset_after: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new(MIN_DELAY, MAX_DELAY, RESET_AFTER)
    }
}

impl Backoff {
    pub fn new(min: Duration, max: Duration, reset_after: Duration) -> Self {
        Self {
            next: min,
            min,
            max: max.max(min),
            reset_after,
        }
    }

    /// The delay before the next start, for a child that ran `ran_for`.
    pub fn delay_after(&mut self, ran_for: Duration) -> Duration {
        if ran_for >= self.reset_after {
            self.next = self.min;
        }
        let delay = self.next;
        self.next = self.next.saturating_mul(2).min(self.max);
        delay
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delays_double_up_to_a_minute() {
        let mut backoff = Backoff::default();
        let delays: Vec<u64> = (0..9)
            .map(|_| backoff.delay_after(Duration::from_millis(10)).as_secs())
            .collect();
        assert_eq!(delays, [1, 2, 4, 8, 16, 32, 60, 60, 60]);
    }

    #[test]
    fn a_minute_of_running_starts_over() {
        let mut backoff = Backoff::default();
        for _ in 0..5 {
            backoff.delay_after(Duration::ZERO);
        }
        assert_eq!(backoff.delay_after(RESET_AFTER), MIN_DELAY);
        assert_eq!(
            backoff.delay_after(RESET_AFTER - Duration::from_millis(1)),
            Duration::from_secs(2)
        );
    }

    #[test]
    fn a_maximum_below_the_minimum_is_the_minimum() {
        let mut backoff = Backoff::new(
            Duration::from_secs(5),
            Duration::from_secs(1),
            Duration::from_secs(60),
        );
        assert_eq!(backoff.delay_after(Duration::ZERO), Duration::from_secs(5));
        assert_eq!(backoff.delay_after(Duration::ZERO), Duration::from_secs(5));
    }
}
