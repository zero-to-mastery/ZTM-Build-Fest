//! Carries the state machine's actions out against a `Platform`: the real
//! one (Win32 status reports, a `std::process::Child`) in `win32.rs` and
//! `main.rs`, or a fake in the tests. Controls from Windows arrive on a
//! channel; between them the driver ticks, polling the child for an exit.

use crate::machine::{Action, Event, Input, Machine, Status};
use std::io;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// How often the child is polled and a pending state reported.
pub const TICK: Duration = Duration::from_millis(250);

/// A request from the Service Control Manager.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    /// Stop, shutdown or preshutdown: all end the service the same way.
    Stop,
}

/// The child process, as the driver needs it.
pub trait ChildProcess {
    /// `Some(exit code)` once the child has exited.
    fn try_wait(&mut self) -> io::Result<Option<i32>>;
    /// Asks the child to stop gracefully. Called at most once per child.
    fn request_stop(&mut self);
    /// Ends the child now.
    fn kill(&mut self) -> io::Result<()>;
}

/// Everything outside the state machine.
pub trait Platform {
    type Child: ChildProcess;
    fn spawn(&mut self) -> io::Result<Self::Child>;
    fn report(&mut self, status: &Status);
    fn log(&mut self, event: &Event);
    /// A problem the machine doesn't model, for the log.
    fn log_error(&mut self, message: &str);
}

/// Runs the service until it has stopped and returns the last status
/// reported (STOPPED).
pub fn run<P: Platform>(
    platform: &mut P,
    mut machine: Machine,
    controls: &Receiver<Control>,
    tick: Duration,
) -> Option<Status> {
    let epoch = Instant::now();
    let now = || epoch.elapsed();
    let mut child: Option<P::Child> = None;
    let mut last_status = None;
    // Inputs that actions produce (Spawned, SpawnFailed) are fed back in
    // before the next control or tick. Both buffers are reused.
    let mut actions = Vec::with_capacity(8);
    let mut inputs = vec![Input::Started];
    let mut controls_open = true;

    loop {
        while let Some(input) = inputs.pop() {
            actions.clear();
            machine.step(input, now(), &mut actions);
            for action in actions.drain(..) {
                match action {
                    Action::Report(status) => {
                        platform.report(&status);
                        last_status = Some(status);
                    }
                    Action::Spawn => match platform.spawn() {
                        Ok(spawned) => {
                            child = Some(spawned);
                            inputs.push(Input::Spawned);
                        }
                        Err(error) => inputs.push(Input::SpawnFailed(error.raw_os_error())),
                    },
                    Action::AskChildToStop => {
                        if let Some(child) = child.as_mut() {
                            child.request_stop();
                        }
                    }
                    Action::KillChild => {
                        if let Some(child) = child.as_mut() {
                            if let Err(error) = child.kill() {
                                platform.log_error(&format!("ending the child failed: {error}"));
                            }
                        }
                    }
                    Action::Log(event) => platform.log(&event),
                    Action::Finish => return last_status,
                }
            }
        }

        // Wait for a control or the next tick. If the control handler's
        // sender is gone (it never is while the service runs), keep ticking.
        let control = if controls_open {
            match controls.recv_timeout(tick) {
                Ok(control) => Some(control),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => {
                    controls_open = false;
                    None
                }
            }
        } else {
            std::thread::sleep(tick);
            None
        };
        if control == Some(Control::Stop) {
            inputs.push(Input::StopRequested);
        }

        if let Some(running) = child.as_mut() {
            match running.try_wait() {
                Ok(Some(code)) => {
                    child = None;
                    inputs.push(Input::ChildExited(code));
                }
                Ok(None) => {}
                Err(error) => {
                    // The child's state is unknown: end it and treat it as a
                    // failure, so it is started again or the stop completes.
                    platform.log_error(&format!("checking the child failed: {error}"));
                    let _ = running.kill();
                    child = None;
                    inputs.push(Input::ChildExited(1));
                }
            }
        }
        // Inputs are popped last-first: the exit (or stop) is handled before
        // the tick.
        inputs.insert(0, Input::Tick);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backoff::Backoff;
    use crate::machine::{Exit, ServiceState};
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::mpsc;

    /// A child that exits with `exit_code` after `polls` polls, or when asked
    /// to stop (if `obeys_stop`), or when killed.
    struct FakeChild {
        script: ChildScript,
        polls: u32,
        stop_asked: bool,
        killed: bool,
        record: Rc<RefCell<Vec<String>>>,
    }

    #[derive(Clone, Copy)]
    struct ChildScript {
        exits_after_polls: Option<(u32, i32)>,
        obeys_stop: bool,
    }

    impl ChildProcess for FakeChild {
        fn try_wait(&mut self) -> io::Result<Option<i32>> {
            self.polls += 1;
            if self.killed {
                return Ok(Some(1));
            }
            if self.stop_asked && self.script.obeys_stop {
                return Ok(Some(0));
            }
            Ok(match self.script.exits_after_polls {
                Some((polls, code)) if self.polls >= polls => Some(code),
                _ => None,
            })
        }
        fn request_stop(&mut self) {
            self.stop_asked = true;
            self.record.borrow_mut().push("ask-stop".into());
        }
        fn kill(&mut self) -> io::Result<()> {
            self.killed = true;
            self.record.borrow_mut().push("kill".into());
            Ok(())
        }
    }

    struct FakePlatform {
        scripts: Vec<io::Result<ChildScript>>,
        record: Rc<RefCell<Vec<String>>>,
        statuses: Vec<Status>,
        stop_after_spawns: Option<(usize, mpsc::Sender<Control>)>,
        spawns: usize,
    }

    impl Platform for FakePlatform {
        type Child = FakeChild;
        fn spawn(&mut self) -> io::Result<FakeChild> {
            self.spawns += 1;
            self.record.borrow_mut().push("spawn".into());
            if let Some((count, sender)) = &self.stop_after_spawns {
                if self.spawns == *count {
                    sender.send(Control::Stop).unwrap();
                }
            }
            let script = self.scripts.remove(0)?;
            Ok(FakeChild {
                script,
                polls: 0,
                stop_asked: false,
                killed: false,
                record: Rc::clone(&self.record),
            })
        }
        fn report(&mut self, status: &Status) {
            self.statuses.push(*status);
        }
        fn log(&mut self, event: &Event) {
            self.record.borrow_mut().push(format!("{event:?}"));
        }
        fn log_error(&mut self, message: &str) {
            self.record.borrow_mut().push(message.to_owned());
        }
    }

    fn platform(scripts: Vec<io::Result<ChildScript>>) -> FakePlatform {
        FakePlatform {
            scripts,
            record: Rc::new(RefCell::new(Vec::new())),
            statuses: Vec::new(),
            stop_after_spawns: None,
            spawns: 0,
        }
    }

    const QUICK: Duration = Duration::from_millis(1);

    fn quick_machine(stop_timeout: Duration) -> Machine {
        Machine::new(
            stop_timeout,
            Backoff::new(QUICK, QUICK * 4, Duration::from_secs(60)),
        )
    }

    fn states(platform: &FakePlatform) -> Vec<ServiceState> {
        let mut states: Vec<ServiceState> = platform.statuses.iter().map(|s| s.state).collect();
        states.dedup();
        states
    }

    #[test]
    fn a_stop_closes_the_child_and_reports_its_exit() {
        let mut platform = platform(vec![Ok(ChildScript {
            exits_after_polls: None,
            obeys_stop: true,
        })]);
        let (sender, receiver) = mpsc::channel();
        platform.stop_after_spawns = Some((1, sender));
        let last = run(
            &mut platform,
            quick_machine(Duration::from_secs(5)),
            &receiver,
            QUICK,
        );
        assert_eq!(
            last.map(|s| (s.state, s.exit)),
            Some((ServiceState::Stopped, Exit::Success))
        );
        assert_eq!(
            states(&platform),
            [
                ServiceState::StartPending,
                ServiceState::Running,
                ServiceState::StopPending,
                ServiceState::Stopped
            ]
        );
        let record = platform.record.borrow();
        assert!(record.contains(&"ask-stop".to_owned()));
        assert!(!record.contains(&"kill".to_owned()));
    }

    #[test]
    fn a_child_that_ignores_the_stop_is_killed_after_the_timeout() {
        let mut platform = platform(vec![Ok(ChildScript {
            exits_after_polls: None,
            obeys_stop: false,
        })]);
        let (sender, receiver) = mpsc::channel();
        platform.stop_after_spawns = Some((1, sender));
        let started = Instant::now();
        let last = run(
            &mut platform,
            quick_machine(Duration::from_millis(30)),
            &receiver,
            QUICK,
        );
        assert!(started.elapsed() >= Duration::from_millis(30));
        assert_eq!(last.map(|s| s.exit), Some(Exit::Child(1)));
        let record = platform.record.borrow();
        let ask = record.iter().position(|line| line == "ask-stop").unwrap();
        let kill = record.iter().position(|line| line == "kill").unwrap();
        assert!(ask < kill);
    }

    #[test]
    fn a_crashing_child_is_started_again_until_the_service_stops() {
        let crash = ChildScript {
            exits_after_polls: Some((1, 3)),
            obeys_stop: true,
        };
        let stays = ChildScript {
            exits_after_polls: None,
            obeys_stop: true,
        };
        let mut platform = platform(vec![Ok(crash), Ok(crash), Ok(stays)]);
        let (sender, receiver) = mpsc::channel();
        platform.stop_after_spawns = Some((3, sender));
        let last = run(
            &mut platform,
            quick_machine(Duration::from_secs(5)),
            &receiver,
            QUICK,
        );
        assert_eq!(last.map(|s| s.exit), Some(Exit::Success));
        assert_eq!(platform.spawns, 3);
        // RUNNING is reported once; restarts are the host's business.
        assert_eq!(
            platform
                .statuses
                .iter()
                .filter(|s| s.state == ServiceState::Running)
                .count(),
            1
        );
        let record = platform.record.borrow();
        assert_eq!(
            record
                .iter()
                .filter(|line| line.starts_with("ChildExited { code: 3"))
                .count(),
            2
        );
    }

    #[test]
    fn a_program_that_cannot_start_stops_the_service() {
        let mut platform = platform(vec![Err(io::Error::from_raw_os_error(2))]);
        let (_sender, receiver) = mpsc::channel();
        let last = run(
            &mut platform,
            quick_machine(Duration::from_secs(5)),
            &receiver,
            QUICK,
        );
        assert_eq!(
            last.map(|s| (s.state, s.exit)),
            Some((ServiceState::Stopped, Exit::Win32(2)))
        );
        assert_eq!(
            states(&platform),
            [ServiceState::StartPending, ServiceState::Stopped]
        );
    }
}
