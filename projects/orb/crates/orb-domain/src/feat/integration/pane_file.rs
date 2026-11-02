//! The pane files orb's Claude hook and pi extension write: the latest
//! report of the agent in each pane, `<pane id>.json` in `~/.orb/panes/`.
//! Files, so reports made while orb is down wait for it.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use serde::Deserialize;

use crate::feat::sessions::state::AgentStatus;
use crate::ids::PaneId;

/// What the agent in a pane reported last.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AgentReport {
    /// `claude` or `pi`: the harness id.
    pub agent: String,
    pub event: AgentEvent,
    /// The conversation's id in its harness.
    pub session_id: String,
    pub transcript: Option<PathBuf>,
    /// Why the conversation started: Claude's `source`, pi's latest `reason`.
    pub source: Option<String>,
    /// When it was written, in unix ms.
    pub at: i64,
}

/// What the agent was doing when it reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentEvent {
    Start,
    Working,
    Idle,
    End,
}

impl AgentEvent {
    /// The status a pane reporting this reads as: a fresh agent that hasn't
    /// run a turn is idle, and one that quit is stopped.
    pub fn status(self) -> AgentStatus {
        match self {
            Self::Working => AgentStatus::Working,
            Self::Start | Self::Idle => AgentStatus::Idle,
            Self::End => AgentStatus::Stopped,
        }
    }
}

impl AgentReport {
    /// A fresh conversation in place of the pane's current one: Claude's
    /// `/clear` or pi's `/new`.
    pub fn replaces_conversation(&self) -> bool {
        matches!(self.source.as_deref(), Some("clear" | "new"))
    }
}

/// Reads a pane-file folder, handing back each file once per change.
#[derive(Debug)]
pub struct PaneFiles {
    dir: PathBuf,
    /// Each file's modification time when it was last handed back.
    seen: HashMap<PaneId, SystemTime>,
}

impl PaneFiles {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            seen: HashMap::new(),
        }
    }

    /// Pane `pane`'s file.
    pub fn file(&self, pane: PaneId) -> PathBuf {
        self.dir.join(format!("{}.json", pane.0))
    }

    /// The reports written or rewritten since the last call, oldest first. A
    /// missing folder gives none; a file that isn't a report is skipped until
    /// it changes again. Temp files (`.<pane>.<pid>.tmp`) aren't read.
    pub fn changed(&mut self) -> Vec<(PaneId, AgentReport)> {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut reports: Vec<(PaneId, AgentReport)> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                let pane = path
                    .extension()
                    .filter(|ext| *ext == "json")
                    .and(path.file_stem())
                    .and_then(|stem| stem.to_str())
                    .and_then(|stem| stem.parse().ok())
                    .map(PaneId)?;
                let modified = entry.metadata().and_then(|meta| meta.modified()).ok()?;
                if self.seen.insert(pane, modified) == Some(modified) {
                    return None;
                }
                let text = fs::read_to_string(&path).ok()?;
                serde_json::from_str(&text)
                    .ok()
                    .map(|report| (pane, report))
            })
            .collect();
        reports.sort_by_key(|(_, report)| report.at);
        reports
    }
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests set files up with `?` and assert on the outcome"
)]
mod tests {
    use std::fs::{self, File};
    use std::path::Path;
    use std::time::{Duration, SystemTime};

    use error_stack::{Report, ResultExt};
    use tempfile::TempDir;

    use super::{AgentEvent, AgentReport, PaneFiles};
    use crate::feat::integration::IntegrationError;
    use crate::feat::sessions::state::AgentStatus;
    use crate::ids::PaneId;

    type TestResult = Result<(), Report<IntegrationError>>;

    fn write(dir: &Path, pane: i64, at: i64) -> TestResult {
        let json = format!(
            r#"{{"agent":"claude","event":"start","session_id":"s-{pane}","transcript":"/t/s.jsonl","source":"startup","at":{at}}}"#
        );
        fs::write(dir.join(format!("{pane}.json")), json).change_context(IntegrationError)
    }

    fn report(pane: i64, at: i64) -> AgentReport {
        AgentReport {
            agent: "claude".to_owned(),
            event: AgentEvent::Start,
            session_id: format!("s-{pane}"),
            transcript: Some("/t/s.jsonl".into()),
            source: Some("startup".to_owned()),
            at,
        }
    }

    fn scratch() -> Result<(TempDir, PaneFiles), Report<IntegrationError>> {
        let tmp = TempDir::new().change_context(IntegrationError)?;
        let files = PaneFiles::new(tmp.path().to_owned());
        Ok((tmp, files))
    }

    #[rstest::rstest]
    fn changed_hands_back_a_new_report() -> TestResult {
        // Given pane 7's agent reported a start.
        let (tmp, mut files) = scratch()?;
        write(tmp.path(), 7, 1)?;

        // When reading the changed files.
        let changed = files.changed();

        // Then that report comes back.
        assert_eq!(
            changed,
            vec![(PaneId(7), report(7, 1))],
            "a new report should be handed back"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn changed_skips_a_report_already_handed_back() -> TestResult {
        // Given pane 7's report was already read.
        let (tmp, mut files) = scratch()?;
        write(tmp.path(), 7, 1)?;
        files.changed();

        // When reading again with nothing rewritten.
        let changed = files.changed();

        // Then nothing comes back.
        assert_eq!(changed, Vec::new(), "an unchanged report should be skipped");
        Ok(())
    }

    #[rstest::rstest]
    fn changed_hands_back_a_rewritten_report() -> TestResult {
        // Given pane 7's report was read, then rewritten later.
        let (tmp, mut files) = scratch()?;
        write(tmp.path(), 7, 1)?;
        files.changed();
        write(tmp.path(), 7, 2)?;
        File::options()
            .write(true)
            .open(tmp.path().join("7.json"))
            .and_then(|file| file.set_modified(SystemTime::now() + Duration::from_secs(5)))
            .change_context(IntegrationError)?;

        // When reading again.
        let changed = files.changed();

        // Then the new report comes back.
        assert_eq!(
            changed,
            vec![(PaneId(7), report(7, 2))],
            "a rewritten report should be handed back"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn changed_returns_reports_oldest_first() -> TestResult {
        // Given pane 1 reported after pane 2.
        let (tmp, mut files) = scratch()?;
        write(tmp.path(), 1, 2)?;
        write(tmp.path(), 2, 1)?;

        // When reading the changed files.
        let changed = files.changed();

        // Then pane 2's report comes first.
        assert_eq!(
            changed,
            vec![(PaneId(2), report(2, 1)), (PaneId(1), report(1, 2))],
            "reports should come back oldest first"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn changed_skips_a_file_that_isnt_a_report() -> TestResult {
        // Given pane 7's file holds something else.
        let (tmp, mut files) = scratch()?;
        fs::write(tmp.path().join("7.json"), "{}").change_context(IntegrationError)?;

        // When reading the changed files.
        let changed = files.changed();

        // Then nothing comes back.
        assert_eq!(changed, Vec::new(), "a non-report should be skipped");
        Ok(())
    }

    #[rstest::rstest]
    fn changed_reads_nothing_from_a_missing_folder() {
        // Given a folder that doesn't exist.
        let mut files = PaneFiles::new("/nonexistent/orb/panes".into());

        // When reading the changed files.
        let changed = files.changed();

        // Then nothing comes back.
        assert_eq!(changed, Vec::new(), "a missing folder should give nothing");
    }

    #[rstest::rstest]
    #[case(AgentEvent::Start, AgentStatus::Idle)]
    #[case(AgentEvent::Working, AgentStatus::Working)]
    #[case(AgentEvent::Idle, AgentStatus::Idle)]
    #[case(AgentEvent::End, AgentStatus::Stopped)]
    fn agent_event_reads_as_a_status(#[case] event: AgentEvent, #[case] expected: AgentStatus) {
        // Given a pane's latest event.
        // When reading it as a status.
        let status = event.status();

        // Then it maps per the pane-report table.
        assert_eq!(status, expected, "{event:?} should read as {expected:?}");
    }
}
