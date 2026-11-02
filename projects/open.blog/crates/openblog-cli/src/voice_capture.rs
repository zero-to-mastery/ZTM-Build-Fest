//! Timed capture for a voice session at the terminal (ADR 0269): an editor, or plain lines on
//! standard input.
//!
//! The clock is honest. In both modes the deadline comes from the session record, text that
//! arrives after it is thrown away, and a reader that is stuck waiting for a person never holds the
//! session open: standard input is read by a helper thread, and an editor is polled rather than
//! waited for. Nothing here corrects, trims or reflows what the author wrote. The only things not
//! kept are the header and marker line this module put in the editor file itself, and the one
//! final newline that an editor adds (the sample format adds it back).

use std::io::{BufRead, Write};
use std::path::Path;
use std::process::{Child, Command};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, SystemTime};

/// The line that separates the header from the author's text in the editor file.
pub const MARKER: &str =
    "-----8<----- write below this line; everything above it is ignored -----8<-----";

/// How a capture ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ended {
    /// The author closed the editor, or sent `.` or end of input.
    Finished,
    /// The deadline passed first.
    Deadline,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Captured {
    pub text: String,
    pub ended: Ended,
}

/// The editor command from `$VISUAL`, then `$EDITOR`, if either is set and not blank.
pub fn editor_command() -> Option<String> {
    ["VISUAL", "EDITOR"]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
}

/// The text below the marker. If the author deleted the marker, the known header is removed when
/// the file still starts with it; otherwise the whole file is the text. Line endings become LF
/// and the one final newline an editor adds is dropped.
pub fn text_below_marker(content: &str, header: &str) -> String {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut offset = 0;
    let mut after_marker = None;
    for line in content.split_inclusive('\n') {
        offset += line.len();
        if line.trim_end_matches(['\r', '\n']) == MARKER {
            after_marker = Some(offset);
            break;
        }
    }
    let text = match after_marker {
        Some(at) => &content[at..],
        None => content.strip_prefix(header).unwrap_or(content),
    };
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    text.strip_suffix('\n').unwrap_or(&text).to_string()
}

fn spawn_editor(editor: &str, path: &Path) -> std::io::Result<Child> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new("cmd");
        // cmd and many tools mistake a forward slash for a switch, so use the native separator.
        let native = path.display().to_string().replace('/', "\\");
        command.raw_arg(format!("/S /C \"{editor} \"{native}\"\""));
        command.spawn()
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group, so the whole tree can be stopped at the deadline.
        Command::new("sh")
            .arg("-c")
            .arg(format!("{editor} \"$1\""))
            .arg("sh")
            .arg(path)
            .process_group(0)
            .spawn()
    }
}

/// Stop the wrapper and everything it started, so a late save from the editor window cannot
/// arrive after the deadline. Only this child's own tree is touched.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{}", child.id())])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// A file name for one session's editor file, so a window left over from an earlier session can
/// never save into this one.
pub fn session_file_name(stem: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("{stem}-{}-{nanos}.md", std::process::id())
}

/// The process id a [`session_file_name`] carries, if `name` is one for `stem`.
fn owner_pid(name: &str, stem: &str) -> Option<u32> {
    let rest = name
        .strip_prefix(stem)?
        .strip_prefix('-')?
        .strip_suffix(".md")?;
    let (pid, nanos) = rest.split_once('-')?;
    nanos.parse::<u128>().ok()?;
    pid.parse().ok()
}

/// Whether `pid` names a process that is still running. When that cannot be told, it is taken to
/// be running, so a file another window may still be writing is never deleted.
pub fn process_alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{
            CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, STILL_ACTIVE,
        };
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        // SAFETY: plain Win32 calls on a handle this function opens and closes itself.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle == 0 {
                return GetLastError() != ERROR_INVALID_PARAMETER;
            }
            let mut code = 0u32;
            let known = GetExitCodeProcess(handle, &mut code) != 0;
            CloseHandle(handle);
            !known || code == STILL_ACTIVE as u32
        }
    }
    #[cfg(not(windows))]
    {
        match Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
        {
            Ok(status) if status.success() => true,
            // `kill -0` also fails for a process owned by someone else; `ps` tells the two apart.
            Ok(_) => Command::new("ps")
                .args(["-p", &pid.to_string()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map_or(true, |status| status.success()),
            Err(_) => true,
        }
    }
}

fn held_by_another_window(name: &str, stem: &str) -> bool {
    owner_pid(name, stem).is_some_and(|pid| pid != std::process::id() && process_alive(pid))
}

/// Whether another running `openblog` process has an editor file `<stem>-<pid>-*.md` open in
/// `dir`, that is, another window is writing or polishing right now.
pub fn other_window_editing(dir: &Path, stem: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries
        .flatten()
        .any(|entry| held_by_another_window(&entry.file_name().to_string_lossy(), stem))
}

/// Delete leftover editor files `<stem>.md` and `<stem>-*.md` in `dir`, best effort. A file that
/// belongs to another `openblog` process still running is left alone: that window is still using
/// it.
pub fn remove_stale(dir: &Path, stem: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let dashed = format!("{stem}-");
    let exact = format!("{stem}.md");
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if (name == exact || (name.starts_with(&dashed) && name.ends_with(".md")))
            && !held_by_another_window(&name, stem)
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Open `path` in `editor` and wait for it to close. For editing a copy with no clock.
pub fn edit_file(editor: &str, path: &Path) -> Result<(), String> {
    let status = spawn_editor(editor, path)
        .and_then(|mut child| child.wait())
        .map_err(|error| format!("Cannot start the editor `{editor}`: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "The editor `{editor}` did not finish normally, so nothing was saved."
        ))
    }
}

/// The file as text, waiting out a moment's hold by the editor or a virus scanner (Windows).
fn read_lossy(path: &Path) -> Option<String> {
    crate::fsutil::retry_transient(|| std::fs::read(path))
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// An editor that returns sooner than this with the file untouched did not wait for its window.
const NOT_WAITING_WITHIN: Duration = Duration::from_secs(3);

/// What to say when the editor returned without waiting for its window to close.
pub fn not_waiting(editor: &str) -> String {
    format!(
        "The editor `{editor}` returned straight away without any change, so it did not wait for its window to close. Nothing was locked or thrown away, and the clock keeps running. Close that window without saving, set $VISUAL or $EDITOR to a command that waits (such as `code --wait` or `subl -w`), then run `openblog voice --resume`."
    )
}

/// Write `file_content` (header, marker, any text so far) to `path`, open it in the editor, and
/// wait until the editor closes or `now_unix() >= deadline_unix`. At the deadline the file is read
/// as it stands and the editor is stopped; whatever it writes later is never read. Each change
/// seen while waiting is passed to `progress` so an interrupted session keeps it.
pub fn capture_in_editor(
    editor: &str,
    path: &Path,
    header: &str,
    file_content: &str,
    deadline_unix: i64,
    now_unix: &dyn Fn() -> i64,
    progress: &mut dyn FnMut(&str),
) -> Result<Captured, String> {
    std::fs::write(path, file_content)
        .map_err(|error| format!("Cannot create the editor file: {error}"))?;
    let mut child = match spawn_editor(editor, path) {
        Ok(child) => child,
        Err(error) => {
            let _ = std::fs::remove_file(path);
            return Err(format!("Cannot start the editor `{editor}`: {error}"));
        }
    };
    let deadline_at = SystemTime::UNIX_EPOCH + Duration::from_secs(deadline_unix.max(0) as u64);
    let saved_late = |stamp: Option<SystemTime>| stamp.is_some_and(|at| at >= deadline_at);
    let mut seen = modified(path);
    let first_stamp = seen;
    let started = std::time::Instant::now();
    // The last text accepted before the deadline.
    let mut accepted = text_below_marker(file_content, header);
    let result = loop {
        if now_unix() >= deadline_unix {
            let text = if saved_late(modified(path)) {
                accepted.clone()
            } else {
                // A file that cannot be read keeps the last text seen, never nothing.
                read_lossy(path)
                    .map(|c| text_below_marker(&c, header))
                    .unwrap_or_else(|| accepted.clone())
            };
            kill_tree(&mut child);
            break Ok(Captured {
                text,
                ended: Ended::Deadline,
            });
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let late = saved_late(modified(path));
                let content = read_lossy(path);
                // An editor that hands the file to a window already open returns at once, before
                // the author has typed anything. Its window would save where nothing reads, so
                // that is not the end of the writing: the session stays open.
                if status.success()
                    && !late
                    && now_unix() < deadline_unix
                    && started.elapsed() < NOT_WAITING_WITHIN
                    && modified(path) == first_stamp
                    && content.as_deref() == Some(file_content)
                {
                    break Err(not_waiting(editor));
                }
                let text = if late {
                    accepted.clone()
                } else {
                    content
                        .map(|c| text_below_marker(&c, header))
                        .unwrap_or_else(|| accepted.clone())
                };
                if !status.success() && now_unix() < deadline_unix {
                    progress(&text);
                    break Err(format!(
                        "The editor `{editor}` did not finish normally. What it had saved is kept; run `openblog voice --resume` to carry on while time is left."
                    ));
                }
                // A window that closed after the deadline does not extend it.
                let ended = if late || now_unix() >= deadline_unix {
                    Ended::Deadline
                } else {
                    Ended::Finished
                };
                break Ok(Captured { text, ended });
            }
            Ok(None) => {}
            Err(error) => {
                kill_tree(&mut child);
                break Err(format!("Lost track of the editor: {error}"));
            }
        }
        let stamp = modified(path);
        if stamp != seen {
            seen = stamp;
            if !saved_late(stamp) {
                if let Some(content) = read_lossy(path) {
                    accepted = text_below_marker(&content, header);
                    progress(&accepted);
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let _ = std::fs::remove_file(path);
    result
}

/// Read lines from the reader `open` makes, on a helper thread (a standard input lock cannot move
/// between threads, so the thread opens it itself). `None` marks the end of the input.
pub fn spawn_line_reader<R, F>(open: F) -> Receiver<Option<String>>
where
    R: BufRead,
    F: FnOnce() -> R + Send + 'static,
{
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = open();
        loop {
            let mut raw = Vec::new();
            match reader.read_until(b'\n', &mut raw) {
                Ok(0) | Err(_) => {
                    let _ = sender.send(None);
                    break;
                }
                Ok(_) => {
                    let line = String::from_utf8_lossy(&raw);
                    let line = line.trim_end_matches(['\n', '\r']).to_string();
                    if sender.send(Some(line)).is_err() {
                        break;
                    }
                }
            }
        }
    });
    receiver
}

/// Collect lines until `.` on a line of its own, the end of input, or the deadline. `initial` is
/// the text already saved (a resumed session); new lines follow it. Lines that arrive after the
/// deadline are discarded. A countdown line is printed to `out` every 30 seconds, and at 10.
pub fn capture_lines(
    lines: &Receiver<Option<String>>,
    initial: &str,
    deadline_unix: i64,
    now_unix: &dyn Fn() -> i64,
    out: &mut dyn Write,
    progress: &mut dyn FnMut(&str),
) -> Captured {
    let mut text = initial.to_string();
    let mut last_notice = None;
    let mut any = !initial.is_empty();
    loop {
        let remaining = deadline_unix - now_unix();
        if remaining <= 0 {
            return Captured {
                text,
                ended: Ended::Deadline,
            };
        }
        if (remaining % 30 == 0 || remaining == 10) && last_notice != Some(remaining) {
            last_notice = Some(remaining);
            let _ = writeln!(out, "[{}:{:02} left]", remaining / 60, remaining % 60);
            let _ = out.flush();
        }
        let wait = Duration::from_millis(250).min(Duration::from_secs(remaining as u64));
        match lines.recv_timeout(wait) {
            Ok(Some(line)) => {
                if now_unix() >= deadline_unix {
                    return Captured {
                        text,
                        ended: Ended::Deadline,
                    };
                }
                if line.trim_end() == "." {
                    return Captured {
                        text,
                        ended: Ended::Finished,
                    };
                }
                if any {
                    text.push('\n');
                }
                any = true;
                text.push_str(&line);
                progress(&text);
            }
            Ok(None) | Err(RecvTimeoutError::Disconnected) => {
                return Captured {
                    text,
                    ended: Ended::Finished,
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

#[cfg(test)]
mod tests;
