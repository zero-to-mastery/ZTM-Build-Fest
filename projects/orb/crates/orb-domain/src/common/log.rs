//! orb's log file: one line per event, so a failure, kill or removal can be
//! traced after the fact. Writing never fails orb: every I/O error is ignored.

use std::collections::HashMap;
use std::fmt::Debug;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use error_stack::Report;
use error_stack::fmt::ColorMode;

/// Where orb writes its log, rolled to `<path>.1` once it reaches its cap.
/// The default writes nowhere.
#[derive(Debug, Clone, Default)]
pub struct Log {
    inner: Option<Arc<Inner>>,
}

#[derive(Debug)]
struct Inner {
    path: PathBuf,
    cap: u64,
    /// Held while writing; the last text logged per `error_on_change` site.
    last: Mutex<HashMap<String, String>>,
}

/// The size at which the log rolls to `<path>.1`.
const CAP: u64 = 5 * 1024 * 1024;

impl Log {
    /// A log at `path` that rolls at 5 MB.
    pub fn new(path: PathBuf) -> Self {
        Self::with_cap(path, CAP)
    }

    /// A log at `path` that rolls once the file reaches `cap` bytes. Error
    /// reports print without terminal styling from then on, so the file holds
    /// plain text.
    pub fn with_cap(path: PathBuf, cap: u64) -> Self {
        Report::set_color_mode(ColorMode::None);
        Self {
            inner: Some(Arc::new(Inner {
                path,
                cap,
                last: Mutex::new(HashMap::new()),
            })),
        }
    }

    /// Appends `<RFC 3339 UTC> <kind> <text>`; continuation lines of `text`
    /// are indented two spaces.
    pub fn line(&self, kind: &str, text: &str) {
        if let Some(inner) = &self.inner {
            inner.write(&inner.lock(), kind, text);
        }
    }

    /// Logs `what` followed by `error`'s whole cause chain.
    pub fn error<E>(&self, what: &str, error: &E)
    where
        E: Debug,
    {
        self.line("error", &error_text(what, error));
    }

    /// Like `error`, unless the same text was the last one logged for `site`.
    pub fn error_on_change<E>(&self, site: &str, what: &str, error: &E)
    where
        E: Debug,
    {
        if let Some(inner) = &self.inner {
            let text = error_text(what, error);
            let mut last = inner.lock();
            if last.get(site) != Some(&text) {
                inner.write(&last, "error", &text);
                last.insert(site.to_owned(), text);
            }
        }
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, String>> {
        self.last.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Rolls the file if it is at its cap, then appends one entry. The guard
    /// proves the caller holds the lock.
    fn write(&self, _guard: &MutexGuard<'_, HashMap<String, String>>, kind: &str, text: &str) {
        if fs::metadata(&self.path).is_ok_and(|meta| meta.len() >= self.cap) {
            let old = {
                let mut name = self.path.as_os_str().to_owned();
                name.push(".1");
                PathBuf::from(name)
            };
            let _ = fs::rename(&self.path, old);
        }
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let entry = format!(
            "{} {kind} {}\n",
            jiff::Timestamp::now(),
            text.replace('\n', "\n  ")
        );
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            let _ = file.write_all(entry.as_bytes());
        }
    }
}

fn error_text<E>(what: &str, error: &E) -> String
where
    E: Debug,
{
    format!("{what}\n{error:?}")
}

#[cfg(test)]
mod tests {
    use std::io;

    use error_stack::{Report, ResultExt};
    use wherror::Error;

    use super::*;

    #[derive(Debug, Error)]
    #[error(debug)]
    struct InnerFailure;

    #[derive(Debug, Error)]
    #[error(debug)]
    struct OuterFailure;

    fn read(path: &std::path::Path) -> String {
        fs::read_to_string(path).unwrap_or_default()
    }

    fn old(path: &std::path::Path) -> PathBuf {
        path.with_file_name("orb.log.1")
    }

    #[rstest::rstest]
    fn log_appends_a_line_with_its_kind_and_text() {
        // Given a log in an empty directory.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("orb.log");
        let log = Log::new(path.clone());

        // When logging a kill.
        log.line("kill", "orb-p7 closed");

        // Then the file has one timestamped line with the kind and text.
        let content = read(&path);
        let (stamp, rest) = content.trim_end().split_once(' ').unwrap_or_default();
        assert!(
            content.lines().count() == 1
                && stamp.parse::<jiff::Timestamp>().is_ok()
                && rest == "kill orb-p7 closed",
            "expected one `<timestamp> kill orb-p7 closed` line, got {content:?}"
        );
    }

    #[rstest::rstest]
    fn log_rolls_to_a_single_old_file_at_its_cap() {
        // Given a log with a 10-byte cap that already holds one line.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("orb.log");
        let log = Log::with_cap(path.clone(), 10);
        log.line("start", "first");

        // When logging a second line.
        log.line("start", "second");

        // Then the old file holds the first line and the log the second.
        let (old, new) = (read(&old(&path)), read(&path));
        assert!(
            old.contains("first")
                && !old.contains("second")
                && new.contains("second")
                && !new.contains("first"),
            "expected first in orb.log.1 and second in orb.log, got {old:?} / {new:?}"
        );
    }

    #[rstest::rstest]
    fn second_roll_replaces_the_old_file() {
        // Given a log with a 10-byte cap that has rolled once.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("orb.log");
        let log = Log::with_cap(path.clone(), 10);
        log.line("start", "first");
        log.line("start", "second");

        // When logging a third line.
        log.line("start", "third");

        // Then the old file holds only the second line, and no other file exists.
        let old = read(&old(&path));
        let names = {
            let mut names: Vec<String> = fs::read_dir(dir.path())
                .unwrap()
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        };
        assert!(
            old.contains("second") && !old.contains("first") && names == ["orb.log", "orb.log.1"],
            "expected orb.log.1 to hold only the second line, got {old:?} in {names:?}"
        );
    }

    #[rstest::rstest]
    fn logged_error_carries_its_whole_cause_chain() {
        // Given a report two contexts deep over an I/O error.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("orb.log");
        let log = Log::new(path.clone());
        let report = Err::<(), _>(Report::new(io::Error::other("disk on fire")))
            .change_context(InnerFailure)
            .attach("a")
            .change_context(OuterFailure)
            .attach("b")
            .unwrap_err();

        // When logging it.
        log.error("couldn't save orb's state", &report);

        // Then every context, attachment and the I/O message are in the file.
        let content = read(&path);
        assert!(
            [
                "couldn't save orb's state",
                "InnerFailure",
                "OuterFailure",
                "a",
                "b",
                "disk on fire"
            ]
            .iter()
            .all(|part| content.contains(part)),
            "expected the whole chain, got {content:?}"
        );
    }

    #[rstest::rstest]
    fn logged_error_has_no_terminal_styling() {
        // Given a log.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("orb.log");
        let log = Log::new(path.clone());

        // When logging a report.
        log.error(
            "couldn't index",
            &Report::new(io::Error::other("gone")).attach("failed to read"),
        );

        // Then the file holds no escape sequences.
        let content = read(&path);
        assert!(
            !content.contains('\u{1b}'),
            "expected plain text, got {content:?}"
        );
    }

    #[rstest::rstest]
    fn default_log_writes_nothing() {
        // Given an empty directory and the default log.
        let dir = tempfile::tempdir().unwrap();
        let log = Log::default();

        // When logging a line and an error.
        log.line("kill", "orb-p7 closed");
        log.error("couldn't save orb's state", &io::Error::other("nope"));

        // Then the directory stays empty.
        assert!(
            fs::read_dir(dir.path()).unwrap().next().is_none(),
            "default log should write nowhere"
        );
    }

    #[rstest::rstest]
    fn repeated_error_is_logged_once_until_it_changes() {
        // Given a log.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("orb.log");
        let log = Log::new(path.clone());

        // When the same site logs A, A, then B.
        for text in ["A failed", "A failed", "B failed"] {
            log.error_on_change("poll", "harness poll failed", &io::Error::other(text));
        }

        // Then the file has one error line for A and one for B.
        let content = read(&path);
        let errors: Vec<&str> = content
            .lines()
            .filter(|line| line.contains(" error "))
            .collect();
        assert!(
            errors.len() == 2
                && content.matches("A failed").count() == 1
                && content.contains("B failed"),
            "expected one A and one B error, got {content:?}"
        );
    }
}
