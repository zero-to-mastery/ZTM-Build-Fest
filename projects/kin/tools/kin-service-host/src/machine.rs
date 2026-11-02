//! The service's life as a pure state machine: inputs (the service was
//! started, the child started or exited, Windows asked the service to stop,
//! time passed) go in, actions (report a status, start the child, ask it to
//! stop, end it) come out. No clock, no processes and no Win32 here, so every
//! path is tested on any machine; `driver.rs` carries the actions out.
//!
//! ```text
//!   Started ──► Spawning ──Spawned──► Running ──ChildExited──► WaitingToRestart
//!                  │                    │  ▲                         │
//!            SpawnFailed           StopRequested  └──── Tick (delay over) ┘
//!                  ▼                    ▼                         │
//!               Stopped ◄──ChildExited── Stopping ◄───────────────┘ StopRequested
//!                                       │  (Stopped at once: no child)
//!                                 Tick past the deadline: KillChild
//! ```
//!
//! Windows sees START_PENDING until the first child has started, RUNNING
//! from then on (also while a failed child waits to be started again: the
//! service itself is still up), STOP_PENDING with a growing checkpoint while
//! the child closes, then STOPPED with the child's exit code.

use crate::backoff::Backoff;
use std::time::Duration;

/// Times are offsets from the moment the host started (a monotonic clock).
pub type Instant = Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceState {
    StartPending,
    Running,
    StopPending,
    Stopped,
}

/// How the service ended, as Windows records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Success,
    /// The child's own exit code (reported as a service-specific error).
    Child(u32),
    /// A Windows error code, such as "file not found" for a missing program.
    Win32(u32),
}

/// One status report to the Service Control Manager.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Status {
    pub state: ServiceState,
    pub exit: Exit,
    /// Grows while a pending state makes progress; 0 otherwise.
    pub checkpoint: u32,
    pub wait_hint: Duration,
    /// Whether stop and shutdown requests are accepted now.
    pub accepts_stop: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    /// The Service Control Manager started the service.
    Started,
    Spawned,
    /// Starting the child failed, with the operating system's error code.
    SpawnFailed(Option<i32>),
    ChildExited(i32),
    /// Stop, shutdown or preshutdown.
    StopRequested,
    /// Time passed (the driver ticks a few times a second).
    Tick,
}

/// Things worth a line in the host's log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    ChildStarted,
    ChildExited { code: i32, restart_in: Duration },
    StopRequested,
    ChildKilled { after: Duration },
    SpawnFailed { os_error: Option<i32> },
    Stopped { exit: Exit },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Report(Status),
    Spawn,
    /// Ask the child to stop gracefully (close its stdin).
    AskChildToStop,
    /// The child didn't stop in time: end it.
    KillChild,
    Log(Event),
    /// The service has stopped; the driver returns.
    Finish,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    Spawning,
    Running { started_at: Instant },
    WaitingToRestart { until: Instant },
    Stopping { asked_at: Instant, killed: bool },
    Stopped,
}

/// The pending-state hint: how long until the next report. The driver
/// reports again on every tick, well inside it.
const WAIT_HINT: Duration = Duration::from_secs(10);
/// Windows' ERROR_FILE_NOT_FOUND, for a child that couldn't start for a
/// reason the operating system didn't name.
const ERROR_FILE_NOT_FOUND: u32 = 2;

#[derive(Debug, Clone)]
pub struct Machine {
    phase: Phase,
    backoff: Backoff,
    stop_timeout: Duration,
    checkpoint: u32,
    reported_running: bool,
    /// A stop that arrived while the child was being started.
    stop_pending: bool,
}

impl Machine {
    pub fn new(stop_timeout: Duration, backoff: Backoff) -> Self {
        Self {
            phase: Phase::Idle,
            backoff,
            stop_timeout,
            checkpoint: 0,
            reported_running: false,
            stop_pending: false,
        }
    }

    #[cfg(test)]
    pub fn is_stopped(&self) -> bool {
        self.phase == Phase::Stopped
    }

    fn pending(&mut self, state: ServiceState) -> Action {
        self.checkpoint += 1;
        Action::Report(Status {
            state,
            exit: Exit::Success,
            checkpoint: self.checkpoint,
            wait_hint: WAIT_HINT,
            accepts_stop: false,
        })
    }

    fn running() -> Action {
        Action::Report(Status {
            state: ServiceState::Running,
            exit: Exit::Success,
            checkpoint: 0,
            wait_hint: Duration::ZERO,
            accepts_stop: true,
        })
    }

    fn stop(&mut self, exit: Exit, out: &mut Vec<Action>) {
        self.phase = Phase::Stopped;
        out.push(Action::Log(Event::Stopped { exit }));
        out.push(Action::Report(Status {
            state: ServiceState::Stopped,
            exit,
            checkpoint: 0,
            wait_hint: Duration::ZERO,
            accepts_stop: false,
        }));
        out.push(Action::Finish);
    }

    fn begin_stopping(&mut self, now: Instant, out: &mut Vec<Action>) {
        self.phase = Phase::Stopping {
            asked_at: now,
            killed: false,
        };
        self.checkpoint = 0;
        out.push(Action::Log(Event::StopRequested));
        out.push(self.pending(ServiceState::StopPending));
        out.push(Action::AskChildToStop);
    }

    /// Feeds one input in at `now`; the actions to carry out, in order, are
    /// appended to `out` (a buffer the driver reuses).
    pub fn step(&mut self, input: Input, now: Instant, out: &mut Vec<Action>) {
        match (self.phase, input) {
            (Phase::Stopped, _) => {}

            (Phase::Idle, Input::Started) => {
                self.phase = Phase::Spawning;
                out.push(self.pending(ServiceState::StartPending));
                out.push(Action::Spawn);
            }
            (Phase::Idle, Input::StopRequested) => self.stop(Exit::Success, out),
            (Phase::Idle, _) => {}

            (Phase::Spawning, Input::Spawned) => {
                self.phase = Phase::Running { started_at: now };
                out.push(Action::Log(Event::ChildStarted));
                if !self.reported_running {
                    self.reported_running = true;
                    out.push(Self::running());
                }
                if self.stop_pending {
                    self.begin_stopping(now, out);
                }
            }
            (Phase::Spawning, Input::SpawnFailed(os_error)) => {
                out.push(Action::Log(Event::SpawnFailed { os_error }));
                let code = os_error
                    .and_then(|code| u32::try_from(code).ok())
                    .filter(|&code| code != 0)
                    .unwrap_or(ERROR_FILE_NOT_FOUND);
                self.stop(Exit::Win32(code), out);
            }
            (Phase::Spawning, Input::StopRequested) => self.stop_pending = true,
            (Phase::Spawning, _) => {}

            (Phase::Running { started_at }, Input::ChildExited(code)) => {
                let restart_in = self.backoff.delay_after(now.saturating_sub(started_at));
                self.phase = Phase::WaitingToRestart {
                    until: now + restart_in,
                };
                out.push(Action::Log(Event::ChildExited { code, restart_in }));
            }
            (Phase::Running { .. }, Input::StopRequested) => self.begin_stopping(now, out),
            (Phase::Running { .. }, _) => {}

            (Phase::WaitingToRestart { until }, Input::Tick) if now >= until => {
                self.phase = Phase::Spawning;
                out.push(Action::Spawn);
            }
            // No child to stop: the service stops at once, cleanly, since
            // stopping is what was asked.
            (Phase::WaitingToRestart { .. }, Input::StopRequested) => {
                out.push(Action::Log(Event::StopRequested));
                self.stop(Exit::Success, out);
            }
            (Phase::WaitingToRestart { .. }, _) => {}

            (Phase::Stopping { .. }, Input::ChildExited(code)) => {
                let exit = match code {
                    0 => Exit::Success,
                    // Windows exit codes are 32-bit unsigned; std gives them
                    // as i32, so the bits are kept as they are.
                    code => Exit::Child(code as u32),
                };
                self.stop(exit, out);
            }
            (Phase::Stopping { asked_at, killed }, Input::Tick) => {
                if !killed && now.saturating_sub(asked_at) >= self.stop_timeout {
                    self.phase = Phase::Stopping {
                        asked_at,
                        killed: true,
                    };
                    out.push(Action::Log(Event::ChildKilled {
                        after: self.stop_timeout,
                    }));
                    out.push(Action::KillChild);
                }
                out.push(self.pending(ServiceState::StopPending));
            }
            (Phase::Stopping { .. }, _) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TIMEOUT: Duration = Duration::from_secs(40);

    fn at(seconds: u64) -> Instant {
        Duration::from_secs(seconds)
    }

    fn machine() -> Machine {
        Machine::new(TIMEOUT, Backoff::default())
    }

    fn step(machine: &mut Machine, input: Input, now: Instant) -> Vec<Action> {
        let mut out = Vec::new();
        machine.step(input, now, &mut out);
        out
    }

    fn reports(actions: &[Action]) -> Vec<(ServiceState, u32)> {
        actions
            .iter()
            .filter_map(|action| match action {
                Action::Report(status) => Some((status.state, status.checkpoint)),
                _ => None,
            })
            .collect()
    }

    fn final_exit(actions: &[Action]) -> Option<Exit> {
        actions.iter().find_map(|action| match action {
            Action::Report(status) if status.state == ServiceState::Stopped => Some(status.exit),
            _ => None,
        })
    }

    fn started() -> Machine {
        let mut machine = machine();
        step(&mut machine, Input::Started, at(0));
        step(&mut machine, Input::Spawned, at(0));
        machine
    }

    #[test]
    fn starting_reports_pending_then_running_once_the_child_is_up() {
        let mut machine = machine();
        let first = step(&mut machine, Input::Started, at(0));
        assert_eq!(reports(&first), [(ServiceState::StartPending, 1)]);
        assert_eq!(first.last(), Some(&Action::Spawn));
        let second = step(&mut machine, Input::Spawned, at(0));
        assert_eq!(
            second,
            [
                Action::Log(Event::ChildStarted),
                Action::Report(Status {
                    state: ServiceState::Running,
                    exit: Exit::Success,
                    checkpoint: 0,
                    wait_hint: Duration::ZERO,
                    accepts_stop: true,
                })
            ]
        );
    }

    #[test]
    fn a_graceful_stop_reports_stopped_with_the_childs_code() {
        let mut machine = started();
        let stop = step(&mut machine, Input::StopRequested, at(100));
        assert_eq!(reports(&stop), [(ServiceState::StopPending, 1)]);
        assert_eq!(stop.last(), Some(&Action::AskChildToStop));
        // A second request (shutdown after stop) changes nothing.
        assert!(step(&mut machine, Input::StopRequested, at(101)).is_empty());
        // Each tick tells Windows the stop is still progressing.
        let tick = step(&mut machine, Input::Tick, at(102));
        assert_eq!(reports(&tick), [(ServiceState::StopPending, 2)]);
        let exited = step(&mut machine, Input::ChildExited(0), at(103));
        assert_eq!(final_exit(&exited), Some(Exit::Success));
        assert_eq!(exited.last(), Some(&Action::Finish));
        assert!(machine.is_stopped());
        assert!(step(&mut machine, Input::Tick, at(104)).is_empty());

        let mut failing = started();
        step(&mut failing, Input::StopRequested, at(10));
        let exited = step(&mut failing, Input::ChildExited(7), at(11));
        assert_eq!(final_exit(&exited), Some(Exit::Child(7)));
        let mut odd = started();
        step(&mut odd, Input::StopRequested, at(10));
        let exited = step(&mut odd, Input::ChildExited(-1073741510), at(11));
        assert_eq!(final_exit(&exited), Some(Exit::Child(0xC000_013A)));
    }

    #[test]
    fn a_child_that_does_not_stop_in_time_is_ended() {
        let mut machine = started();
        step(&mut machine, Input::StopRequested, at(100));
        let before = step(
            &mut machine,
            Input::Tick,
            at(100) + TIMEOUT - Duration::from_millis(1),
        );
        assert!(!before.contains(&Action::KillChild));
        let deadline = step(&mut machine, Input::Tick, at(100) + TIMEOUT);
        assert!(deadline.contains(&Action::KillChild));
        assert!(deadline.contains(&Action::Log(Event::ChildKilled { after: TIMEOUT })));
        // Only once, while Windows keeps hearing about progress.
        let after = step(&mut machine, Input::Tick, at(200));
        assert!(!after.contains(&Action::KillChild));
        assert_eq!(reports(&after).len(), 1);
        let exited = step(&mut machine, Input::ChildExited(1), at(201));
        assert_eq!(final_exit(&exited), Some(Exit::Child(1)));
    }

    #[test]
    fn an_unexpected_exit_restarts_the_child_after_the_backoff() {
        let mut machine = started();
        let exited = step(&mut machine, Input::ChildExited(3), at(5));
        assert_eq!(
            exited,
            [Action::Log(Event::ChildExited {
                code: 3,
                restart_in: Duration::from_secs(1)
            })]
        );
        assert!(step(&mut machine, Input::Tick, at(5)).is_empty());
        assert_eq!(step(&mut machine, Input::Tick, at(6)), [Action::Spawn]);
        // RUNNING was reported already; a restart reports nothing new.
        assert_eq!(
            step(&mut machine, Input::Spawned, at(6)),
            [Action::Log(Event::ChildStarted)]
        );
        // A quick second failure waits twice as long.
        let again = step(&mut machine, Input::ChildExited(3), at(7));
        assert_eq!(
            again,
            [Action::Log(Event::ChildExited {
                code: 3,
                restart_in: Duration::from_secs(2)
            })]
        );
        assert!(step(&mut machine, Input::Tick, at(8)).is_empty());
        assert_eq!(step(&mut machine, Input::Tick, at(9)), [Action::Spawn]);
        // Even an exit code of 0 is unexpected while the service runs.
        step(&mut machine, Input::Spawned, at(9));
        let clean = step(&mut machine, Input::ChildExited(0), at(200));
        assert_eq!(
            clean,
            [Action::Log(Event::ChildExited {
                code: 0,
                restart_in: Duration::from_secs(1)
            })]
        );
    }

    #[test]
    fn a_stop_while_waiting_to_restart_stops_at_once() {
        let mut machine = started();
        step(&mut machine, Input::ChildExited(3), at(5));
        let stop = step(&mut machine, Input::StopRequested, at(5));
        assert!(!stop.contains(&Action::AskChildToStop));
        assert_eq!(final_exit(&stop), Some(Exit::Success));
        assert_eq!(stop.last(), Some(&Action::Finish));
        assert!(step(&mut machine, Input::Tick, at(100)).is_empty());
    }

    #[test]
    fn a_child_that_cannot_start_stops_the_service_with_the_reason() {
        let mut machine = machine();
        step(&mut machine, Input::Started, at(0));
        let failed = step(&mut machine, Input::SpawnFailed(Some(3)), at(0));
        assert!(failed.contains(&Action::Log(Event::SpawnFailed { os_error: Some(3) })));
        assert_eq!(final_exit(&failed), Some(Exit::Win32(3)));
        assert!(machine.is_stopped());

        let mut unnamed = machine_after_restart_wait();
        let failed = step(&mut unnamed, Input::SpawnFailed(None), at(10));
        assert_eq!(final_exit(&failed), Some(Exit::Win32(ERROR_FILE_NOT_FOUND)));
    }

    fn machine_after_restart_wait() -> Machine {
        let mut machine = started();
        step(&mut machine, Input::ChildExited(1), at(1));
        assert_eq!(step(&mut machine, Input::Tick, at(10)), [Action::Spawn]);
        machine
    }

    #[test]
    fn a_stop_during_a_start_is_honoured_once_the_child_is_up() {
        let mut machine = machine();
        step(&mut machine, Input::Started, at(0));
        assert!(step(&mut machine, Input::StopRequested, at(0)).is_empty());
        let spawned = step(&mut machine, Input::Spawned, at(0));
        assert_eq!(spawned.last(), Some(&Action::AskChildToStop));
        assert_eq!(
            reports(&spawned),
            [(ServiceState::Running, 0), (ServiceState::StopPending, 1)]
        );
    }

    #[test]
    fn inputs_that_do_not_apply_are_ignored() {
        let mut machine = machine();
        assert!(step(&mut machine, Input::Tick, at(0)).is_empty());
        assert!(step(&mut machine, Input::ChildExited(1), at(0)).is_empty());
        let mut running = started();
        assert!(step(&mut running, Input::Tick, at(1)).is_empty());
        assert!(step(&mut running, Input::Started, at(1)).is_empty());
        let mut idle = self::machine();
        assert_eq!(
            final_exit(&step(&mut idle, Input::StopRequested, at(0))),
            Some(Exit::Success)
        );
    }
}
