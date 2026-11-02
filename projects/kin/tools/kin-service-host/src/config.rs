//! The host's command line. The Service Control Manager starts the host with
//! the command line stored in the service's `binPath`
//! (`server/service-install.mjs` writes it); nothing else configures it.
//!
//! ```text
//! kin-service-host --program PATH [--working-directory DIR]
//!                  [--env NAME=VALUE]... [--stop-timeout SECONDS]
//!                  [--log-file PATH] [-- CHILD-ARGUMENT...]
//! ```
//!
//! Paths and the child's arguments stay `OsString`: Windows command lines
//! may hold text that isn't valid Unicode, and the host passes them on as
//! they came. Option names and `--env` must be text.

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::time::Duration;

/// How long the child has to stop after it is asked, unless
/// `--stop-timeout` says otherwise. The service gives itself 30 seconds to
/// close its database (server/server.mjs), as the systemd unit allows 40.
pub const DEFAULT_STOP_TIMEOUT: Duration = Duration::from_secs(40);
const MAX_STOP_TIMEOUT_SECONDS: u64 = 600;

pub const USAGE: &str = "\
Usage: kin-service-host --program PATH [--working-directory DIR]
                        [--env NAME=VALUE]... [--stop-timeout SECONDS]
                        [--log-file PATH] [-- CHILD-ARGUMENT...]

Windows starts this program for the Kin service; it is not run by hand.
Install the service with: kin --install-service";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// The program the service runs (the Kin launcher, `kin.exe`).
    pub program: OsString,
    pub args: Vec<OsString>,
    /// Added to (or replacing) the environment the host was given.
    pub env: Vec<(String, String)>,
    pub working_directory: Option<OsString>,
    pub stop_timeout: Duration,
    /// The host's own log, which also takes the child's output.
    pub log_file: Option<OsString>,
}

/// What the command line asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Run(Config),
    Help,
    Version,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

fn error(message: impl Into<String>) -> ConfigError {
    ConfigError(message.into())
}

/// An absolute path in Windows (`C:\…`, `\\server\…`) or POSIX form. The
/// Service Control Manager starts services in `System32`, so a relative path
/// would quietly mean something else.
pub fn looks_absolute(path: &OsStr) -> bool {
    let Some(text) = path.to_str() else {
        // Not text: let the operating system judge it when it is used.
        return !path.is_empty();
    };
    let bytes = text.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    drive || text.starts_with("\\\\") || text.starts_with('/')
}

fn env_pair(value: &OsStr) -> Result<(String, String), ConfigError> {
    let text = value
        .to_str()
        .ok_or_else(|| error("--env must be text (NAME=VALUE)."))?;
    // A leading '=' marks Windows' hidden per-drive variables; a name never
    // starts with one here.
    let (name, variable) = text
        .split_once('=')
        .filter(|(name, _)| !name.is_empty())
        .ok_or_else(|| error(format!("--env \"{text}\" isn't NAME=VALUE.")))?;
    if name.contains('\0') || variable.contains('\0') {
        return Err(error("--env can't hold a NUL character."));
    }
    Ok((name.to_owned(), variable.to_owned()))
}

fn stop_timeout(value: &OsStr) -> Result<Duration, ConfigError> {
    let seconds = value
        .to_str()
        .and_then(|text| text.parse::<u64>().ok())
        .filter(|seconds| (1..=MAX_STOP_TIMEOUT_SECONDS).contains(seconds))
        .ok_or_else(|| {
            error(format!(
                "--stop-timeout must be a whole number of seconds from 1 to {MAX_STOP_TIMEOUT_SECONDS}."
            ))
        })?;
    Ok(Duration::from_secs(seconds))
}

fn set_once(slot: &mut Option<OsString>, name: &str, value: OsString) -> Result<(), ConfigError> {
    if slot.is_some() {
        return Err(error(format!("{name} is given twice.")));
    }
    *slot = Some(value);
    Ok(())
}

/// Parses the arguments after the program name. Options take their value as
/// the next argument or after `=`; everything after `--` is the child's.
pub fn parse<I>(arguments: I) -> Result<Command, ConfigError>
where
    I: IntoIterator<Item = OsString>,
{
    let mut arguments = arguments.into_iter();
    let mut program = None;
    let mut working_directory = None;
    let mut log_file = None;
    let mut timeout = None;
    let mut env = Vec::new();
    let mut child_args = Vec::new();

    while let Some(argument) = arguments.next() {
        let Some(text) = argument.to_str() else {
            return Err(error(
                "An option isn't text; the child's arguments go after --.",
            ));
        };
        if text == "--" {
            child_args.extend(arguments.by_ref());
            break;
        }
        match text {
            "--help" | "-h" => return Ok(Command::Help),
            "--version" => return Ok(Command::Version),
            _ => {}
        }
        let (name, inline) = match text.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(OsString::from(value))),
            _ => (text, None),
        };
        if !matches!(
            name,
            "--program" | "--working-directory" | "--env" | "--stop-timeout" | "--log-file"
        ) {
            return Err(error(format!("Unknown argument \"{text}\".")));
        }
        let name = name.to_owned();
        let value = match inline {
            Some(value) => value,
            None => arguments
                .next()
                .ok_or_else(|| error(format!("{name} needs a value.")))?,
        };
        match name.as_str() {
            "--program" => set_once(&mut program, &name, value)?,
            "--working-directory" => set_once(&mut working_directory, &name, value)?,
            "--log-file" => set_once(&mut log_file, &name, value)?,
            "--stop-timeout" => {
                if timeout.is_some() {
                    return Err(error("--stop-timeout is given twice."));
                }
                timeout = Some(stop_timeout(&value)?);
            }
            _ => env.push(env_pair(&value)?),
        }
    }

    let program = program.ok_or_else(|| error("--program is required."))?;
    for (name, path) in [
        ("--program", Some(&program)),
        ("--working-directory", working_directory.as_ref()),
        ("--log-file", log_file.as_ref()),
    ] {
        if let Some(path) = path {
            if !looks_absolute(path) {
                return Err(error(format!("{name} must be an absolute path.")));
            }
        }
    }
    Ok(Command::Run(Config {
        program,
        args: child_args,
        env,
        working_directory,
        stop_timeout: timeout.unwrap_or(DEFAULT_STOP_TIMEOUT),
        log_file,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    fn run(list: &[&str]) -> Config {
        match parse(args(list)) {
            Ok(Command::Run(config)) => config,
            other => panic!("expected a configuration, got {other:?}"),
        }
    }

    fn fails(list: &[&str]) -> String {
        parse(args(list)).expect_err("expected an error").0
    }

    #[test]
    fn the_install_command_line_is_read_whole() {
        let config = run(&[
            "--program",
            "C:\\Program Files\\Kin\\kin.exe",
            "--working-directory=C:\\ProgramData\\Kin",
            "--env",
            "KIN_DATA_DIR=C:\\ProgramData\\Kin",
            "--env",
            "KIN_EXTRA=a=b",
            "--stop-timeout",
            "45",
            "--log-file",
            "C:\\ProgramData\\Kin\\logs\\service-host.log",
            "--",
            "--stop-on-stdin-close",
            "--log-file",
            "C:\\ProgramData\\Kin\\logs\\kin.log",
        ]);
        assert_eq!(config.program, "C:\\Program Files\\Kin\\kin.exe");
        assert_eq!(
            config.working_directory.as_deref(),
            Some(OsStr::new("C:\\ProgramData\\Kin"))
        );
        assert_eq!(
            config.env,
            vec![
                ("KIN_DATA_DIR".to_owned(), "C:\\ProgramData\\Kin".to_owned()),
                ("KIN_EXTRA".to_owned(), "a=b".to_owned()),
            ]
        );
        assert_eq!(config.stop_timeout, Duration::from_secs(45));
        assert_eq!(
            config.log_file.as_deref(),
            Some(OsStr::new("C:\\ProgramData\\Kin\\logs\\service-host.log"))
        );
        // The child's own options are never read as the host's.
        assert_eq!(
            config.args,
            args(&[
                "--stop-on-stdin-close",
                "--log-file",
                "C:\\ProgramData\\Kin\\logs\\kin.log"
            ])
        );
    }

    #[test]
    fn defaults_apply_when_options_are_left_out() {
        let config = run(&["--program=/usr/local/lib/kin/kin"]);
        assert_eq!(config.stop_timeout, DEFAULT_STOP_TIMEOUT);
        assert!(config.args.is_empty() && config.env.is_empty());
        assert_eq!(config.working_directory, None);
        assert_eq!(config.log_file, None);
    }

    #[test]
    fn help_and_version_are_answered() {
        assert_eq!(parse(args(&["--help"])), Ok(Command::Help));
        assert_eq!(parse(args(&["-h"])), Ok(Command::Help));
        assert_eq!(parse(args(&["--version"])), Ok(Command::Version));
    }

    #[test]
    fn mistakes_are_named() {
        assert_eq!(fails(&[]), "--program is required.");
        assert_eq!(fails(&["--program"]), "--program needs a value.");
        assert_eq!(
            fails(&["--program", "kin.exe"]),
            "--program must be an absolute path."
        );
        assert_eq!(
            fails(&["--program", "C:\\a.exe", "--program", "C:\\b.exe"]),
            "--program is given twice."
        );
        assert_eq!(
            fails(&["--program", "C:\\a.exe", "--log-file", "logs\\x.log"]),
            "--log-file must be an absolute path."
        );
        assert_eq!(
            fails(&["--program", "C:\\a.exe", "extra"]),
            "Unknown argument \"extra\"."
        );
        assert_eq!(
            fails(&["--program", "C:\\a.exe", "--supervise"]),
            "Unknown argument \"--supervise\"."
        );
        assert_eq!(
            fails(&["--program", "C:\\a.exe", "--env", "NOVALUE"]),
            "--env \"NOVALUE\" isn't NAME=VALUE."
        );
        assert_eq!(
            fails(&["--program", "C:\\a.exe", "--env", "=C:=C:\\"]),
            "--env \"=C:=C:\\\" isn't NAME=VALUE."
        );
        for timeout in ["0", "601", "ten", "-1", "1.5"] {
            assert!(
                fails(&["--program", "C:\\a.exe", "--stop-timeout", timeout])
                    .starts_with("--stop-timeout must be")
            );
        }
        assert_eq!(
            fails(&[
                "--program",
                "C:\\a.exe",
                "--stop-timeout",
                "5",
                "--stop-timeout",
                "6"
            ]),
            "--stop-timeout is given twice."
        );
    }

    #[test]
    fn absolute_paths_are_recognised_in_both_forms() {
        for path in [
            "C:\\Kin\\kin.exe",
            "c:/kin/kin.exe",
            "\\\\server\\share\\kin.exe",
            "/usr/bin/kin",
        ] {
            assert!(looks_absolute(OsStr::new(path)), "{path}");
        }
        for path in ["kin.exe", "C:kin.exe", "Kin\\kin.exe", "", "\\kin.exe"] {
            assert!(!looks_absolute(OsStr::new(path)), "{path}");
        }
    }
}
