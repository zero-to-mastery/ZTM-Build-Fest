//! The `zmx` command line as orb's [`Zmx`].
//!
//! Each call runs with no stdin and exactly orb's child environment, and is
//! killed past [`TIMEOUT`]. zmx answers in milliseconds, so the frontend loop
//! may call it directly.

use std::ffi::OsString;
use std::process::Command;
use std::time::Duration;

use error_stack::Report;

use super::zmx_service::{Zmx, ZmxError, ZmxOutput};
use crate::common::{Finished, run_within};

/// How long one zmx command may take.
const TIMEOUT: Duration = Duration::from_secs(2);

/// Runs the `zmx` on `PATH` with exactly orb's child environment.
#[derive(Debug, Clone)]
pub struct ZmxCli {
    env: Vec<(OsString, OsString)>,
}

impl ZmxCli {
    /// A zmx whose commands run with exactly `env`.
    pub fn new(env: Vec<(OsString, OsString)>) -> Self {
        Self { env }
    }
}

impl Zmx for ZmxCli {
    fn name(&self) -> &'static str {
        "zmx"
    }

    fn run(&self, argv: &[OsString]) -> Result<ZmxOutput, Report<ZmxError>> {
        let Some((program, rest)) = argv.split_first() else {
            return Err(Report::new(ZmxError).attach("no zmx command to run".to_owned()));
        };
        let command = {
            let mut command = Command::new(program);
            command
                .args(rest)
                .env_clear()
                .envs(self.env.iter().map(|(key, value)| (key, value)));
            command
        };
        match run_within(command, TIMEOUT) {
            Ok(Finished::Exited(output)) => Ok(ZmxOutput {
                success: output.status.success(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            }),
            Ok(Finished::TimedOut) => Err(Report::new(ZmxError).attach("zmx timed out".to_owned())),
            Err(error) => Err(Report::new(error)
                .change_context(ZmxError)
                .attach("couldn't run zmx".to_owned())),
        }
    }
}
