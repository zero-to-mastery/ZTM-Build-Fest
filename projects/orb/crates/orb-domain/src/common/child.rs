//! Running a child process for at most a time limit, killed past it, so a
//! command that hangs can't hang orb.

use std::io::Read;
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// How often a running child is checked for having exited once it has run
/// [`FAST_FOR`].
const POLL: Duration = Duration::from_millis(10);
/// How often a child is checked in its first [`FAST_FOR`], so one that exits
/// at once is back in a millisecond or two.
const FAST_POLL: Duration = Duration::from_millis(1);
/// How long a child is checked every [`FAST_POLL`].
const FAST_FOR: Duration = Duration::from_millis(20);

/// How a child run by [`run_within`] ended.
#[derive(Debug)]
pub enum Finished {
    /// It exited within the limit, with this status and output.
    Exited(Output),
    /// It ran past the limit and was killed.
    TimedOut,
}

/// Runs `command` with no stdin and piped stdout/stderr for at most `limit`,
/// killing (and reaping) it if it runs longer. A child that exits at once is
/// noticed within a millisecond or two.
///
/// # Errors
///
/// Returns an error if the command can't be started or waited on.
pub fn run_within(mut command: Command, limit: Duration) -> std::io::Result<Finished> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let Some(status) = wait_within(&mut child, limit)? else {
        return Ok(Finished::TimedOut);
    };
    Ok(Finished::Exited(Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    }))
}

/// Waits at most `limit` for a started `child` to exit, killing (and
/// reaping) it if it runs longer; `None` when it was killed. A child that
/// exits at once is noticed within a millisecond or two.
///
/// # Errors
///
/// Returns an error if the child can't be waited on.
pub fn wait_within(child: &mut Child, limit: Duration) -> std::io::Result<Option<ExitStatus>> {
    let started = Instant::now();
    let deadline = started + limit;
    loop {
        match child.try_wait()? {
            Some(status) => return Ok(Some(status)),
            None if Instant::now() < deadline => thread::sleep(if started.elapsed() < FAST_FOR {
                FAST_POLL
            } else {
                POLL
            }),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(None);
            }
        }
    }
}

/// Reads all of `pipe` on a thread of its own, so a child that prints more
/// than a pipe holds isn't stalled waiting for orb to read it.
fn drain<R>(pipe: Option<R>) -> JoinHandle<Vec<u8>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    })
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate setup failures with `?` and assert on the outcome"
)]
mod tests {
    use std::fs;
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    use tempfile::TempDir;

    use super::{FAST_POLL, Finished, run_within};

    /// `program` with `args`.
    fn command(program: &str, args: &[&str]) -> Command {
        let mut command = Command::new(program);
        command.args(args);
        command
    }

    #[rstest::rstest]
    fn run_within_adds_under_5_ms_to_a_command_that_exits_at_once() {
        // Given a command that exits at once, and how fast it runs when simply
        // started and waited on (best of five), so a busy machine slows both
        // the same.
        let bare = (0..5)
            .filter_map(|_| {
                let started = Instant::now();
                command("true", &[])
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .and_then(|mut child| child.wait())
                    .ok()
                    .map(|_| started.elapsed())
            })
            .min();

        // When running it through run_within five times, keeping the fastest.
        let fastest = (0..5)
            .filter_map(|_| {
                let started = Instant::now();
                run_within(command("true", &[]), Duration::from_secs(5))
                    .ok()
                    .map(|_| started.elapsed())
            })
            .min();

        // Then run_within added under 5 ms, plus however much longer than
        // asked this machine sleeps one check interval (a shared CI machine
        // can sleep several times the 1 ms it was asked for).
        let oversleep = std::iter::repeat_with(|| {
            let started = Instant::now();
            thread::sleep(FAST_POLL);
            started.elapsed().saturating_sub(FAST_POLL)
        })
        .take(5)
        .min()
        .unwrap_or_default();
        let allowed = Duration::from_millis(5) + oversleep;
        assert!(
            fastest
                .zip(bare)
                .is_some_and(|(took, bare)| took.saturating_sub(bare) < allowed),
            "run_within should add under {allowed:?} to a command that exits at once, fastest took {fastest:?} against {bare:?} bare"
        );
    }

    #[rstest::rstest]
    fn run_within_says_a_command_that_outlives_the_limit_timed_out() {
        // Given a command that runs longer than the limit.
        let sleep = command("sleep", &["10"]);

        // When running it with a 100 ms limit.
        let result = run_within(sleep, Duration::from_millis(100));

        // Then it timed out.
        assert!(
            matches!(result, Ok(Finished::TimedOut)),
            "a command past its limit should time out"
        );
    }

    #[rstest::rstest]
    fn run_within_kills_a_command_that_outlives_the_limit() -> std::io::Result<()> {
        // Given a command that writes its pid to a file, then runs longer than the limit.
        let dir = TempDir::new()?;
        let pid_file = dir.path().join("pid");
        let sleep = command(
            "sh",
            &[
                "-c",
                r#"echo $$ > "$0"; exec sleep 10"#,
                &pid_file.to_string_lossy(),
            ],
        );

        // When running it with a 500 ms limit.
        let _timed_out = run_within(sleep, Duration::from_millis(500));

        // Then that process is gone.
        let pid = fs::read_to_string(&pid_file)?;
        let alive = Command::new("kill")
            .args(["-0", pid.trim()])
            .stderr(Stdio::null())
            .status()?
            .success();
        assert!(!alive, "a command past its limit should be killed");
        Ok(())
    }

    #[rstest::rstest]
    fn run_within_returns_all_of_an_output_longer_than_a_pipe_holds() -> std::io::Result<()> {
        // Given a command that prints 1 MB, far more than a pipe holds.
        let head = command("head", &["-c", "1000000", "/dev/zero"]);

        // When running it with a 5 s limit.
        let stdout_len = match run_within(head, Duration::from_secs(5))? {
            Finished::Exited(output) => Some(output.stdout.len()),
            Finished::TimedOut => None,
        };

        // Then all of its output comes back.
        assert_eq!(stdout_len, Some(1_000_000), "the whole stdout");
        Ok(())
    }
}
