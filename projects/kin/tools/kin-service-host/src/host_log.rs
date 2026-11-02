//! The host's own log: one JSON object per line, like the rest of Kin's
//! logs, in the file `--log-file` names. The child's stdout and stderr go
//! to the same file, so a launcher that fails before it opens its own log
//! still leaves its reason somewhere. Without `--log-file` nothing is kept:
//! a service has no console.

use crate::machine::{Event, Exit};
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::path::Path;
use std::process::Stdio;

/// A log over this size is moved to `<name>.1` when the host starts.
pub const ROTATE_BYTES: u64 = 1024 * 1024;

pub struct HostLog {
    file: Option<File>,
}

impl HostLog {
    /// A log that keeps nothing.
    pub fn none() -> Self {
        Self { file: None }
    }

    /// Opens `path` for appending, creating its folder, after moving a large
    /// old log aside. A log that can't be opened is not a reason to keep
    /// the service from running: the error is returned beside an empty log.
    pub fn open(path: &Path) -> (Self, Option<std::io::Error>) {
        let opened = (|| {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            if fs::metadata(path)
                .map(|meta| meta.len() > ROTATE_BYTES)
                .unwrap_or(false)
            {
                let mut old = path.as_os_str().to_owned();
                old.push(".1");
                fs::rename(path, old)?;
            }
            OpenOptions::new().create(true).append(true).open(path)
        })();
        match opened {
            Ok(file) => (Self { file: Some(file) }, None),
            Err(error) => (Self::none(), Some(error)),
        }
    }

    pub fn write_line(&mut self, line: &str) {
        if let Some(file) = self.file.as_mut() {
            // A full disk must not stop the service; the line is lost.
            let _ = file
                .write_all(line.as_bytes())
                .and_then(|()| file.write_all(b"\n"));
        }
    }

    /// Where the child's stdout or stderr goes: this log, or nowhere.
    pub fn child_output(&self) -> Stdio {
        match self.file.as_ref().map(File::try_clone) {
            Some(Ok(file)) => Stdio::from(file),
            _ => Stdio::null(),
        }
    }
}

/// `text` as a JSON string, quotes included.
pub fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", control as u32);
            }
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

fn exit_fields(exit: Exit) -> String {
    match exit {
        Exit::Success => "\"code\":0".to_owned(),
        Exit::Child(code) => format!("\"code\":{code}"),
        Exit::Win32(code) => format!("\"windowsError\":{code}"),
    }
}

/// One log line for `event`.
pub fn event_line(event: &Event) -> String {
    match *event {
        Event::ChildStarted => "{\"event\":\"service_host_child_started\"}".to_owned(),
        Event::ChildExited { code, restart_in } => format!(
            "{{\"event\":\"service_host_child_exited\",\"code\":{code},\"restartInMs\":{}}}",
            restart_in.as_millis()
        ),
        Event::StopRequested => "{\"event\":\"service_host_stop_requested\"}".to_owned(),
        Event::ChildKilled { after } => format!(
            "{{\"event\":\"service_host_child_killed\",\"afterMs\":{}}}",
            after.as_millis()
        ),
        Event::SpawnFailed { os_error } => match os_error {
            Some(code) => format!("{{\"event\":\"service_host_start_failed\",\"osError\":{code}}}"),
            None => "{\"event\":\"service_host_start_failed\"}".to_owned(),
        },
        Event::Stopped { exit } => format!(
            "{{\"event\":\"service_host_stopped\",{}}}",
            exit_fields(exit)
        ),
    }
}

/// A log line for a problem outside the state machine.
pub fn error_line(message: &str) -> String {
    format!(
        "{{\"event\":\"service_host_error\",\"message\":{}}}",
        json_string(message)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn events_are_single_json_lines() {
        assert_eq!(
            event_line(&Event::ChildExited {
                code: -1,
                restart_in: Duration::from_secs(2)
            }),
            "{\"event\":\"service_host_child_exited\",\"code\":-1,\"restartInMs\":2000}"
        );
        assert_eq!(
            event_line(&Event::Stopped {
                exit: Exit::Child(3)
            }),
            "{\"event\":\"service_host_stopped\",\"code\":3}"
        );
        assert_eq!(
            event_line(&Event::Stopped {
                exit: Exit::Win32(2)
            }),
            "{\"event\":\"service_host_stopped\",\"windowsError\":2}"
        );
        assert_eq!(
            event_line(&Event::SpawnFailed { os_error: Some(5) }),
            "{\"event\":\"service_host_start_failed\",\"osError\":5}"
        );
        assert_eq!(
            event_line(&Event::ChildKilled {
                after: Duration::from_secs(40)
            }),
            "{\"event\":\"service_host_child_killed\",\"afterMs\":40000}"
        );
    }

    #[test]
    fn messages_are_escaped() {
        assert_eq!(
            json_string("C:\\Kin \"x\"\n\u{1}"),
            "\"C:\\\\Kin \\\"x\\\"\\n\\u0001\""
        );
        assert_eq!(
            error_line("bad\tthing"),
            "{\"event\":\"service_host_error\",\"message\":\"bad\\tthing\"}"
        );
    }

    #[test]
    fn the_log_appends_and_moves_a_large_one_aside() {
        let directory = std::env::temp_dir().join(format!("kin-host-log-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        let path = directory.join("logs").join("service-host.log");
        let (mut log, error) = HostLog::open(&path);
        assert!(error.is_none());
        log.write_line("one");
        drop(log);
        let (mut log, _) = HostLog::open(&path);
        log.write_line("two");
        drop(log);
        assert_eq!(fs::read_to_string(&path).unwrap(), "one\ntwo\n");

        fs::write(&path, vec![b'x'; ROTATE_BYTES as usize + 1]).unwrap();
        let (mut log, _) = HostLog::open(&path);
        log.write_line("fresh");
        drop(log);
        assert_eq!(fs::read_to_string(&path).unwrap(), "fresh\n");
        let mut old = path.as_os_str().to_owned();
        old.push(".1");
        assert_eq!(fs::metadata(old).unwrap().len(), ROTATE_BYTES + 1);
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_log_that_cannot_open_keeps_nothing() {
        let file = std::env::temp_dir().join(format!("kin-host-log-file-{}", std::process::id()));
        fs::write(&file, b"not a folder").unwrap();
        // A folder can't be made inside a file.
        let (mut log, error) = HostLog::open(&file.join("service-host.log"));
        assert!(error.is_some());
        log.write_line("lost");
        fs::remove_file(&file).unwrap();
    }
}
