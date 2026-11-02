//! What orb asks of zmx: the command a pane runs to attach to a session,
//! which sessions run on a socket directory, and ending one.
//!
//! A session lives in a socket directory (`ZMX_DIR`). orb's own panes use
//! `~/.orb/zmx`; a harness that already runs its sessions under zmx (pi, on
//! `~/.orb/pi`) keeps its own.

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use error_stack::Report;
use wherror::Error;

use crate::Log;

/// A zmx call failed. Every report carries a one-line reason as its latest
/// `String` attachment, fit for the mode line.
#[derive(Debug, Error)]
#[error(debug)]
pub struct ZmxError;

/// A zmx session: its name and the socket directory (`ZMX_DIR`) it lives in.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ZmxSession {
    pub name: String,
    pub dir: PathBuf,
}

/// One running session in `zmx list`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZmxEntry {
    pub name: String,
    /// The process zmx reports for the session (`pid=`).
    pub pid: Option<u32>,
    /// How many clients are attached (`clients=`).
    pub clients: Option<u32>,
    /// When the session was made, in unix seconds (`created=`).
    pub created: Option<i64>,
}

/// What a finished zmx command left behind.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ZmxOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

impl ZmxOutput {
    /// A failure whose reason is the first non-blank line zmx printed to
    /// stderr, else `zmx failed`.
    fn failure(&self) -> Report<ZmxError> {
        let reason = self
            .stderr
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("zmx failed")
            .to_owned();
        Report::new(ZmxError).attach(reason)
    }
}

/// `env ZMX_DIR=<dir> ZMX_NO_DETACH_KEY=1 zmx <args>`. The `env` prefix
/// carries `ZMX_DIR`, since panes and commands get only orb's child
/// environment.
pub fn zmx_argv<I, S>(dir: &Path, args: I) -> Vec<OsString>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let dir = {
        let mut word = OsString::from("ZMX_DIR=");
        word.push(dir);
        word
    };
    [
        OsString::from("env"),
        dir,
        "ZMX_NO_DETACH_KEY=1".into(),
        "zmx".into(),
    ]
    .into_iter()
    .chain(args.into_iter().map(Into::into))
    .collect()
}

/// The command a pane runs to attach to `session`. zmx creates a missing
/// session running a login `$SHELL`; on a running session it sends its
/// snapshot.
pub fn attach_argv(session: &ZmxSession) -> Vec<OsString> {
    zmx_argv(
        &session.dir,
        [OsString::from("attach"), session.name.clone().into()],
    )
}

/// The running sessions in `zmx list`'s stdout. Each line is
/// `  name=<n>\tpid=<p>\tclients=<c>\tcreated=…\tcwd=…\tcmd=…`; a line
/// carrying `err=` is a session whose daemon died (`status=cleaning up`) and
/// is left out, as is a line without a name.
pub fn parse_list(stdout: &str) -> Vec<ZmxEntry> {
    stdout
        .lines()
        .filter_map(|line| {
            let fields: Vec<(&str, &str)> = line
                .trim()
                .split('\t')
                .filter_map(|field| field.split_once('='))
                .collect();
            let value = |key: &str| {
                fields
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| *value)
            };
            match (value("name"), value("err")) {
                (Some(name), None) => Some(ZmxEntry {
                    name: name.to_owned(),
                    pid: value("pid").and_then(|pid| pid.parse().ok()),
                    clients: value("clients").and_then(|clients| clients.parse().ok()),
                    created: value("created").and_then(|created| created.parse().ok()),
                }),
                _ => None,
            }
        })
        .collect()
}

/// Runs zmx command lines built by [`zmx_argv`].
pub trait Zmx: Send + Sync {
    fn name(&self) -> &'static str;

    /// Runs `argv`.
    ///
    /// # Errors
    ///
    /// Returns an error, with the reason attached as a `String`, if the
    /// command can't start or outlives its time limit.
    fn run(&self, argv: &[OsString]) -> Result<ZmxOutput, Report<ZmxError>>;
}

/// Shared handle to the [`Zmx`] in use, with orb's own socket directory for
/// the panes it makes (`~/.orb/zmx`).
#[derive(Clone)]
pub struct ZmxService {
    zmx: Arc<dyn Zmx>,
    dir: PathBuf,
    log: Log,
}

impl ZmxService {
    pub fn new(zmx: Arc<dyn Zmx>, dir: PathBuf, log: Log) -> Self {
        Self { zmx, dir, log }
    }

    /// orb's pane socket directory.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The session named `name` on orb's pane socket directory.
    pub fn session(&self, name: String) -> ZmxSession {
        ZmxSession {
            name,
            dir: self.dir.clone(),
        }
    }

    /// The running sessions on `dir`; none when the directory doesn't exist
    /// (zmx then prints `no sessions found` to stderr and exits 0).
    ///
    /// # Errors
    ///
    /// Returns an error if zmx can't run or exits with an error.
    pub fn list(&self, dir: &Path) -> Result<Vec<ZmxEntry>, Report<ZmxError>> {
        let output = self.zmx.run(&zmx_argv(dir, ["list"]))?;
        if output.success {
            Ok(parse_list(&output.stdout))
        } else {
            Err(output.failure())
        }
    }

    /// Ends `session` (`zmx kill <name>` on its directory) and logs it with
    /// `why`: `kill <name> (<dir>) <why>: ok`, `already gone` for a session zmx
    /// no longer has, or `failed: <zmx's first error line>`.
    pub fn kill(&self, session: &ZmxSession, why: &str) {
        let outcome = match self
            .zmx
            .run(&zmx_argv(&session.dir, ["kill", session.name.as_str()]))
        {
            Ok(output) if output.success => "ok".to_owned(),
            Ok(output) if output.stderr.contains("SessionNotFound") => "already gone".to_owned(),
            Ok(output) => format!("failed: {}", first_line(&output.failure())),
            Err(report) => format!("failed: {}", first_line(&report)),
        };
        self.log.line(
            "kill",
            &format!(
                "{} ({}) {why}: {outcome}",
                session.name,
                session.dir.display()
            ),
        );
    }
}

/// The one-line reason a zmx report carries, else `zmx failed`.
fn first_line(report: &Report<ZmxError>) -> String {
    report
        .downcast_ref::<String>()
        .cloned()
        .unwrap_or_else(|| "zmx failed".to_owned())
}

impl fmt::Debug for ZmxService {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Zmx<{}>", self.zmx.name())
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use std::ffi::OsString;
    use std::sync::{Mutex, PoisonError};

    use error_stack::Report;

    use super::{Zmx, ZmxError, ZmxOutput};

    /// A zmx that records each command and answers every one with the same
    /// output.
    pub(crate) struct FakeZmx {
        output: ZmxOutput,
        calls: Mutex<Vec<Vec<OsString>>>,
    }

    impl FakeZmx {
        /// A zmx whose commands all end with `output`.
        pub(crate) fn new(output: ZmxOutput) -> Self {
            Self {
                output,
                calls: Mutex::default(),
            }
        }

        /// The commands run so far.
        pub(crate) fn calls(&self) -> Vec<Vec<OsString>> {
            self.calls
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        }
    }

    impl Zmx for FakeZmx {
        fn name(&self) -> &'static str {
            "fake"
        }

        fn run(&self, argv: &[OsString]) -> Result<ZmxOutput, Report<ZmxError>> {
            self.calls
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(argv.to_vec());
            Ok(self.output.clone())
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate setup failures with `?` and assert on the outcome"
)]
mod tests {
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use error_stack::Report;

    use super::fake::FakeZmx;
    use super::{ZmxEntry, ZmxError, ZmxOutput, ZmxService, ZmxSession, attach_argv, parse_list};
    use crate::Log;

    fn words(words: &[&str]) -> Vec<OsString> {
        words.iter().map(OsString::from).collect()
    }

    fn orb_p7(dir: &str) -> ZmxSession {
        ZmxSession {
            name: "orb-p7".to_owned(),
            dir: PathBuf::from(dir),
        }
    }

    fn service(zmx: &Arc<FakeZmx>) -> ZmxService {
        ZmxService::new(
            zmx.clone(),
            PathBuf::from("/home/u/.orb/zmx"),
            Log::default(),
        )
    }

    /// A service whose log is written to `path`.
    fn service_logging(zmx: &Arc<FakeZmx>, path: &Path) -> ZmxService {
        ZmxService::new(
            zmx.clone(),
            PathBuf::from("/home/u/.orb/zmx"),
            Log::new(path.to_path_buf()),
        )
    }

    fn failed(stderr: &str) -> ZmxOutput {
        ZmxOutput {
            success: false,
            stdout: String::new(),
            stderr: stderr.to_owned(),
        }
    }

    fn reason<T>(result: Result<T, Report<ZmxError>>) -> Option<String> {
        result.err()?.downcast_ref::<String>().cloned()
    }

    #[rstest::rstest]
    fn attach_argv_without_a_command_leaves_the_shell_to_zmx() {
        // Given orb-p7 on /z and no command.
        let session = orb_p7("/z");

        // When building the pane's command.
        let argv = attach_argv(&session);

        // Then it ends at the session name, so zmx starts a login shell.
        assert_eq!(
            argv,
            words(&[
                "env",
                "ZMX_DIR=/z",
                "ZMX_NO_DETACH_KEY=1",
                "zmx",
                "attach",
                "orb-p7"
            ]),
            "no command after the session name"
        );
    }

    #[rstest::rstest]
    #[case("/home/u/.orb/zmx")]
    #[case("/home/u/.orb/pi")]
    fn attach_argv_uses_the_sessions_socket_dir(#[case] dir: &str) {
        // Given orb-p7 on `dir`.
        let session = orb_p7(dir);

        // When building the pane's command.
        let argv = attach_argv(&session);

        // Then ZMX_DIR names that directory.
        assert_eq!(
            argv.get(1),
            Some(&OsString::from(format!("ZMX_DIR={dir}"))),
            "ZMX_DIR is the session's socket dir"
        );
    }

    #[rstest::rstest]
    fn parse_list_reads_name_pid_and_clients() {
        // Given the line zmx 0.8.1 prints for a running session.
        let stdout = "  name=probe\tpid=46886\tclients=0\tcreated=1791299028\tcwd=file://Mac/Users/u\tcmd=sleep 30\n";

        // When parsing it.
        let entries = parse_list(stdout);

        // Then its name, pid and client count come back.
        assert_eq!(
            entries,
            [ZmxEntry {
                name: "probe".to_owned(),
                pid: Some(46886),
                clients: Some(0),
                created: Some(1_791_299_028),
            }],
            "one running session"
        );
    }

    #[rstest::rstest]
    fn list_line_reads_the_created_time() {
        // Given a session made at 1791332500.
        let stdout = "  name=p\tpid=1\tclients=0\tcreated=1791332500\n";

        // When parsing it.
        let created: Vec<Option<i64>> = parse_list(stdout)
            .into_iter()
            .map(|entry| entry.created)
            .collect();

        // Then its creation time is read in unix seconds.
        assert_eq!(created, [Some(1_791_332_500)], "created= should be read");
    }

    #[rstest::rstest]
    fn parse_list_reads_every_session() {
        // Given two sessions.
        let stdout = "  name=a\tpid=1\tclients=1\n  name=b\tpid=2\tclients=0\n";

        // When parsing them.
        let names: Vec<String> = parse_list(stdout)
            .into_iter()
            .map(|entry| entry.name)
            .collect();

        // Then both come back in order.
        assert_eq!(names, ["a", "b"], "every session, in order");
    }

    #[rstest::rstest]
    fn parse_list_leaves_out_a_session_whose_daemon_died() {
        // Given a session zmx is cleaning up.
        let stdout = "  name=x\terr=ConnectionRefused\tstatus=cleaning up\n";

        // When parsing it.
        let entries = parse_list(stdout);

        // Then it isn't running.
        assert!(entries.is_empty(), "a dead daemon isn't a running session");
    }

    #[rstest::rstest]
    fn parse_list_of_no_sessions_is_empty() {
        // Given zmx's empty stdout.
        // When parsing it.
        let entries = parse_list("");

        // Then nothing runs.
        assert!(entries.is_empty(), "no sessions");
    }

    #[rstest::rstest]
    fn list_runs_zmx_list_on_the_given_dir() -> Result<(), Report<ZmxError>> {
        // Given a zmx with no sessions.
        let zmx = Arc::new(FakeZmx::new(ZmxOutput {
            success: true,
            ..ZmxOutput::default()
        }));

        // When listing /p.
        service(&zmx).list(Path::new("/p"))?;

        // Then zmx list ran on /p.
        assert_eq!(
            zmx.calls(),
            [words(&[
                "env",
                "ZMX_DIR=/p",
                "ZMX_NO_DETACH_KEY=1",
                "zmx",
                "list"
            ])],
            "zmx list on the given dir"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn list_reports_zmxs_first_error_line() {
        // Given zmx list failing.
        let zmx = Arc::new(FakeZmx::new(failed("\n  error: AccessDenied  \nmore\n")));

        // When listing a dir.
        let result = service(&zmx).list(Path::new("/p"));

        // Then zmx's first line is the reason.
        assert_eq!(
            reason(result).as_deref(),
            Some("error: AccessDenied"),
            "the first non-blank stderr line"
        );
    }

    #[rstest::rstest]
    fn kill_runs_zmx_kill_on_the_sessions_dir() {
        // Given a zmx that kills.
        let zmx = Arc::new(FakeZmx::new(ZmxOutput {
            success: true,
            ..ZmxOutput::default()
        }));

        // When killing orb-p7 on /z.
        service(&zmx).kill(&orb_p7("/z"), "closed");

        // Then zmx kill ran on /z.
        assert_eq!(
            zmx.calls(),
            [words(&[
                "env",
                "ZMX_DIR=/z",
                "ZMX_NO_DETACH_KEY=1",
                "zmx",
                "kill",
                "orb-p7"
            ])],
            "zmx kill on the session's dir"
        );
    }

    #[rstest::rstest]
    fn kill_logs_the_session_and_why() -> Result<(), std::io::Error> {
        // Given a zmx that kills and a log file.
        let zmx = Arc::new(FakeZmx::new(ZmxOutput {
            success: true,
            ..ZmxOutput::default()
        }));
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("orb.log");

        // When killing orb-p7 on /z because it closed.
        service_logging(&zmx, &path).kill(&orb_p7("/z"), "closed");

        // Then the log names the session, its dir, why and the outcome.
        let log = std::fs::read_to_string(&path)?;
        assert!(
            log.contains(" kill orb-p7 (/z) closed: ok\n"),
            "the kill line should be logged, got {log:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn failed_kill_logs_zmxs_first_error_line() -> Result<(), std::io::Error> {
        // Given zmx kill failing for a reason other than a gone session.
        let zmx = Arc::new(FakeZmx::new(failed(
            "error: failed to kill session=orb-p7: ConnectionRefused\n",
        )));
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("orb.log");

        // When killing it.
        service_logging(&zmx, &path).kill(&orb_p7("/z"), "closed");

        // Then the log carries zmx's first error line.
        let log = std::fs::read_to_string(&path)?;
        assert!(
            log.contains(
                " kill orb-p7 (/z) closed: failed: error: failed to kill session=orb-p7: ConnectionRefused\n"
            ),
            "the failure reason should be logged, got {log:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn kill_of_a_gone_session_logs_already_gone() -> Result<(), std::io::Error> {
        // Given zmx kill finding no session.
        let zmx = Arc::new(FakeZmx::new(failed(
            "error: failed to kill session=orb-p7: SessionNotFound\n",
        )));
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("orb.log");

        // When killing it.
        service_logging(&zmx, &path).kill(&orb_p7("/z"), "closed");

        // Then the log says it was already gone.
        let log = std::fs::read_to_string(&path)?;
        assert!(
            log.contains(" kill orb-p7 (/z) closed: already gone\n"),
            "a gone session should be logged as already gone, got {log:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn session_is_on_orbs_pane_socket_dir() {
        // Given a service whose pane socket dir is /home/u/.orb/zmx.
        let zmx = Arc::new(FakeZmx::new(ZmxOutput::default()));

        // When naming session orb-p7.
        let session = service(&zmx).session("orb-p7".to_owned());

        // Then it lives on that dir.
        assert_eq!(
            session,
            orb_p7("/home/u/.orb/zmx"),
            "a pane's session is on orb's pane socket dir"
        );
    }
}
