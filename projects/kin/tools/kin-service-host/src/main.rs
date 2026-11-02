//! Kin's Windows service host (ADR 0025 §10, #749).
//!
//! A program registered with `sc.exe create` must answer the Service Control
//! Manager within seconds of starting, or Windows gives up on it (error
//! 1053). Node programs can't, so the service Windows starts is this small
//! host, which:
//!
//! 1. hands its thread to `StartServiceCtrlDispatcherW`, which calls
//!    `service_main` on a new thread;
//! 2. reports START_PENDING, starts the Kin launcher (`kin.exe`) with the
//!    arguments and environment from its own command line (`config.rs`), and
//!    reports RUNNING;
//! 3. starts the launcher again, after a growing delay, if it exits on its
//!    own (`backoff.rs`);
//! 4. on stop, shutdown or preshutdown, reports STOP_PENDING, closes the
//!    launcher's stdin (which asks it to stop: `process.rs`), waits up to
//!    `--stop-timeout`, ends it if it is still running, and reports STOPPED
//!    with its exit code.
//!
//! The decisions are a state machine (`machine.rs`) driven by `driver.rs`;
//! the Win32 declarations are in `win32.rs`. Everything but the final call
//! into the dispatcher builds and is tested on any platform.

mod backoff;
mod config;
mod driver;
mod host_log;
mod machine;
mod process;
mod win32;

use std::process::ExitCode;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Answers `--help` and `--version`; `None` means "run the service".
fn answer_command_line(command: &Result<config::Command, config::ConfigError>) -> Option<ExitCode> {
    match command {
        Ok(config::Command::Help) => {
            println!("{}", config::USAGE);
            Some(ExitCode::SUCCESS)
        }
        Ok(config::Command::Version) => {
            println!("{VERSION}");
            Some(ExitCode::SUCCESS)
        }
        _ => None,
    }
}

#[cfg(windows)]
fn main() -> ExitCode {
    let command = config::parse(std::env::args_os().skip(1));
    if let Some(code) = answer_command_line(&command) {
        return code;
    }
    service::run(command)
}

#[cfg(not(windows))]
fn main() -> ExitCode {
    let command = config::parse(std::env::args_os().skip(1));
    if let Some(code) = answer_command_line(&command) {
        return code;
    }
    eprintln!("kin-service-host runs Kin as a Windows service; it does nothing on this system.");
    ExitCode::from(2)
}

/// The Service Control Manager's entry points. Compiled everywhere (and so
/// checked by the Linux build); called only on Windows.
#[cfg_attr(not(windows), allow(dead_code))]
mod service {
    use crate::backoff::Backoff;
    use crate::config::{Command, Config, ConfigError, USAGE};
    use crate::driver::{self, Control};
    use crate::host_log::HostLog;
    use crate::machine::{Exit, Machine, ServiceState, Status};
    use crate::process::ProcessPlatform;
    use crate::win32::{self, Request, StatusHandle};
    use std::ffi::c_void;
    use std::path::Path;
    use std::process::ExitCode;
    use std::sync::mpsc::{self, Sender};
    use std::sync::OnceLock;
    use std::time::Duration;

    /// The parsed command line, for `service_main` (Windows calls it with
    /// only the arguments of `sc start`, not the service's command line).
    static STARTUP: OnceLock<Result<Config, ConfigError>> = OnceLock::new();
    /// Where the control handler sends stop requests.
    static CONTROLS: OnceLock<Sender<Control>> = OnceLock::new();

    pub fn run(command: Result<Command, ConfigError>) -> ExitCode {
        let startup = command.and_then(|command| match command {
            Command::Run(config) => Ok(config),
            Command::Help | Command::Version => Err(ConfigError("unreachable".into())),
        });
        let _ = STARTUP.set(startup);
        // For a service in its own process the name in the table is not
        // used; Windows passes the real one to service_main.
        let mut name = win32::wide("Kin");
        let table = [
            win32::ServiceTableEntryW {
                service_name: name.as_mut_ptr(),
                service_proc: Some(service_main),
            },
            win32::ServiceTableEntryW {
                service_name: std::ptr::null_mut(),
                service_proc: None,
            },
        ];
        // SAFETY: `table` is a valid, NULL-terminated SERVICE_TABLE_ENTRYW
        // array; it and `name` outlive the call, which returns only after
        // the service has stopped.
        if unsafe { win32::StartServiceCtrlDispatcherW(table.as_ptr()) } != 0 {
            return ExitCode::SUCCESS;
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(win32::ERROR_FAILED_SERVICE_CONTROLLER_CONNECT) {
            eprintln!("{USAGE}");
            if let Some(Err(problem)) = STARTUP.get() {
                eprintln!("\n{problem}");
            }
            return ExitCode::from(2);
        }
        eprintln!("kin-service-host: the service dispatcher failed: {error}");
        ExitCode::FAILURE
    }

    unsafe extern "system" fn control_handler(
        control: u32,
        _event_type: u32,
        _event_data: *mut c_void,
        _context: *mut c_void,
    ) -> u32 {
        match win32::request_for(control) {
            Request::Send(request) => {
                if let Some(sender) = CONTROLS.get() {
                    // The receiver lives until the service has stopped; a
                    // send after that has nothing left to stop.
                    let _ = sender.send(request);
                }
                win32::NO_ERROR
            }
            Request::Interrogate => win32::NO_ERROR,
            Request::NotHandled => win32::ERROR_CALL_NOT_IMPLEMENTED,
        }
    }

    unsafe extern "system" fn service_main(argc: u32, argv: *mut *mut u16) {
        let fallback = win32::wide("Kin");
        // SAFETY: Windows passes argc entries in argv; the first is the
        // service's NUL-terminated name, valid while service_main runs.
        let name: *const u16 = if argc > 0 && !argv.is_null() && !(*argv).is_null() {
            *argv
        } else {
            fallback.as_ptr()
        };
        let (sender, receiver) = mpsc::channel();
        // service_main runs once in a process that hosts one service.
        let _ = CONTROLS.set(sender);
        // SAFETY: `name` is NUL-terminated UTF-16; the handler is a plain
        // function that never unwinds into Windows.
        let handle =
            win32::RegisterServiceCtrlHandlerExW(name, Some(control_handler), std::ptr::null_mut());
        if handle.is_null() {
            // Nothing to report to: Windows records the service as failed.
            return;
        }
        let status_handle = StatusHandle(handle);
        match STARTUP.get() {
            Some(Ok(config)) => run_service(config, &status_handle, &receiver),
            Some(Err(problem)) => refuse(&problem.to_string(), &status_handle),
            None => refuse(
                "the host was started without its configuration",
                &status_handle,
            ),
        }
    }

    fn run_service(
        config: &Config,
        status_handle: &StatusHandle,
        receiver: &mpsc::Receiver<Control>,
    ) {
        // A log that can't be opened leaves nowhere to say so; the service
        // runs without one rather than not at all.
        let (log, _) = match &config.log_file {
            Some(path) => HostLog::open(Path::new(path)),
            None => (HostLog::none(), None),
        };
        let mut platform = ProcessPlatform {
            config,
            log,
            reporter: |status: &Status| status_handle.report(status),
        };
        let machine = Machine::new(config.stop_timeout, Backoff::default());
        driver::run(&mut platform, machine, receiver, driver::TICK);
    }

    /// Stops at once with "the parameter is incorrect", which Windows
    /// writes to its event log with the service's name.
    fn refuse(problem: &str, status_handle: &StatusHandle) {
        eprintln!("kin-service-host: {problem}");
        let _ = status_handle.report(&Status {
            state: ServiceState::Stopped,
            exit: Exit::Win32(win32::ERROR_INVALID_PARAMETER),
            checkpoint: 0,
            wait_hint: Duration::ZERO,
            accepts_stop: false,
        });
    }
}
