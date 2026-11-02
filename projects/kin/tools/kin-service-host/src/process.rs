//! The real `Platform`: the child is a `std::process::Child`, and statuses
//! go to whatever reporter the caller gives (Windows' `SetServiceStatus`).
//!
//! **Stopping gracefully.** The child's stdin is a pipe the host holds; to
//! ask it to stop, the host closes its end. A Windows service has no
//! console, so console control events (Ctrl+C, `GenerateConsoleCtrlEvent`)
//! aren't available, and `TerminateProcess` gives no chance to close
//! anything. The Kin launcher, started with `--stop-on-stdin-close`, reads
//! the closed pipe as "stop" and passes the stop on to the service the same
//! way (server/launcher.mjs, KIN_STOP_WITH_LAUNCHER in server/server.mjs),
//! which closes its database and exits. The same happens if the host itself
//! dies, since its end of the pipe closes with it.
//!
//! **Ending it.** If the child doesn't stop in time, `Child::kill` ends the
//! launcher (TerminateProcess). Node starts the service process inside a
//! job object that ends it when the launcher ends (libuv's kill-on-close
//! job), so the service goes with it.

use crate::config::Config;
use crate::driver::{ChildProcess, Platform};
use crate::host_log::{error_line, event_line, HostLog};
use crate::machine::{Event, Status};
use std::io;
use std::process::{Child, Command, Stdio};

pub struct ProcessChild {
    child: Child,
}

impl ChildProcess for ProcessChild {
    fn try_wait(&mut self) -> io::Result<Option<i32>> {
        // On Windows every exit has a code; elsewhere a signal has none.
        Ok(self
            .child
            .try_wait()?
            .map(|status| status.code().unwrap_or(1)))
    }

    fn request_stop(&mut self) {
        drop(self.child.stdin.take());
    }

    fn kill(&mut self) -> io::Result<()> {
        self.child.kill()
    }
}

/// The command that starts the child described by `config`.
pub fn child_command(config: &Config, log: &HostLog) -> Command {
    let mut command = Command::new(&config.program);
    command
        .args(&config.args)
        .envs(config.env.iter().map(|(name, value)| (name, value)))
        .stdin(Stdio::piped())
        .stdout(log.child_output())
        .stderr(log.child_output());
    if let Some(directory) = &config.working_directory {
        command.current_dir(directory);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window: a service has no desktop to show it on.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

pub struct ProcessPlatform<'a, R: FnMut(&Status) -> io::Result<()>> {
    pub config: &'a Config,
    pub log: HostLog,
    pub reporter: R,
}

impl<R: FnMut(&Status) -> io::Result<()>> Platform for ProcessPlatform<'_, R> {
    type Child = ProcessChild;

    fn spawn(&mut self) -> io::Result<ProcessChild> {
        let child = child_command(self.config, &self.log).spawn()?;
        Ok(ProcessChild { child })
    }

    fn report(&mut self, status: &Status) {
        if let Err(error) = (self.reporter)(status) {
            self.log.write_line(&error_line(&format!(
                "reporting the service status failed: {error}"
            )));
        }
    }

    fn log(&mut self, event: &Event) {
        self.log.write_line(&event_line(event));
    }

    fn log_error(&mut self, message: &str) {
        self.log.write_line(&error_line(message));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::backoff::Backoff;
    use crate::driver::{run, Control};
    use crate::machine::{Exit, Machine, ServiceState};
    use std::ffi::OsString;
    use std::sync::mpsc;
    use std::time::Duration;

    fn shell(script: &str, timeout: Duration, log_file: Option<OsString>) -> Config {
        Config {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env: vec![("KIN_HOST_TEST".into(), "from-the-host".into())],
            working_directory: Some("/".into()),
            stop_timeout: timeout,
            log_file,
        }
    }

    fn run_until_stopped(config: &Config, stop_after: Duration) -> (Status, Vec<ServiceState>) {
        let (sender, receiver) = mpsc::channel();
        let stopper = std::thread::spawn(move || {
            std::thread::sleep(stop_after);
            let _ = sender.send(Control::Stop);
        });
        let log = match &config.log_file {
            Some(path) => HostLog::open(std::path::Path::new(path)).0,
            None => HostLog::none(),
        };
        let mut states = Vec::new();
        let mut platform = ProcessPlatform {
            config,
            log,
            reporter: |status: &Status| {
                states.push(status.state);
                Ok(())
            },
        };
        let machine = Machine::new(config.stop_timeout, Backoff::default());
        let last = run(&mut platform, machine, &receiver, Duration::from_millis(20)).unwrap();
        drop(platform);
        stopper.join().unwrap();
        states.dedup();
        (last, states)
    }

    #[test]
    fn closing_stdin_stops_a_real_child_that_listens() {
        let directory =
            std::env::temp_dir().join(format!("kin-host-process-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        let log = directory.join("host.log");
        // Reads stdin to its end, then exits with 0, as the launcher does.
        let config = shell(
            "echo \"child $KIN_HOST_TEST\"; cat >/dev/null; echo closed; exit 0",
            Duration::from_secs(20),
            Some(log.clone().into()),
        );
        let (last, states) = run_until_stopped(&config, Duration::from_millis(300));
        assert_eq!(last.exit, Exit::Success);
        assert_eq!(
            states,
            [
                ServiceState::StartPending,
                ServiceState::Running,
                ServiceState::StopPending,
                ServiceState::Stopped
            ]
        );
        let text = std::fs::read_to_string(&log).unwrap();
        assert!(text.contains("child from-the-host"), "{text}");
        assert!(text.contains("closed"), "{text}");
        assert!(text.contains("service_host_stopped"), "{text}");
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_real_child_that_ignores_stdin_is_ended() {
        let config = shell("exec sleep 30", Duration::from_secs(1), None);
        let started = std::time::Instant::now();
        let (last, _) = run_until_stopped(&config, Duration::from_millis(100));
        assert!(started.elapsed() < Duration::from_secs(10));
        // Killed by a signal: no exit code, reported as 1.
        assert_eq!(last.exit, Exit::Child(1));
    }
}
