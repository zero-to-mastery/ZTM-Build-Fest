//! pi, a coding agent the user runs in a pane: status from the reports orb's
//! extension writes to the pane file, titles read from pi's own session
//! files.

pub mod session_file;

use std::io;
use std::path::{Path, PathBuf};

use super::{Harness, HarnessId, HarnessInfo, Scan, TranscriptFormat};
use crate::feat::sessions::transcript::{Exchange, MessageRead};

/// The id pi agents are stored under.
pub const ID: &str = "pi";

/// The name the user sees for pi.
const LABEL: &str = "pi";

/// How the frontend marks pi: its name and `π`.
pub fn info() -> HarnessInfo {
    HarnessInfo {
        id: HarnessId::new(ID),
        label: LABEL.to_owned(),
        icon: Some("π".to_owned()),
    }
}

/// pi: session files under `sessions_dir`.
pub struct Pi {
    sessions_dir: PathBuf,
}

impl Pi {
    /// `sessions_dir` is where pi writes its session files.
    pub fn new(sessions_dir: PathBuf) -> Self {
        Self { sessions_dir }
    }
}

impl TranscriptFormat for Pi {
    fn locate(&self, cwd: &Path, session_id: &str) -> Option<PathBuf> {
        session_file::find(&self.sessions_dir, Some(cwd), session_id)
    }

    fn scan(&self, path: &Path, offset: u64, previous: &Scan) -> io::Result<Scan> {
        session_file::scan(path, offset, previous)
    }

    fn exchanges(&self, path: &Path) -> io::Result<(u64, Vec<Exchange>)> {
        session_file::exchanges(path)
    }

    fn messages(&self, path: &Path, offset: u64, prompt_offset: u64) -> io::Result<MessageRead> {
        session_file::messages(path, offset, prompt_offset)
    }
}

impl Harness for Pi {
    fn name(&self) -> &'static str {
        ID
    }

    fn id(&self) -> HarnessId {
        HarnessId::new(ID)
    }

    fn label(&self) -> &'static str {
        LABEL
    }

    fn info(&self) -> HarnessInfo {
        info()
    }

    fn resume_command(&self, session_id: &str) -> String {
        format!("pi --session-id {session_id}")
    }

    /// pi reports each turn to its pane file through orb's extension.
    fn reports_status(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use error_stack::Report;

    use super::{Pi, info};
    use crate::feat::harness::{Harness, HarnessError};

    #[rstest::rstest]
    #[tokio::test]
    async fn pi_runs_nothing_by_process() -> Result<(), Report<HarnessError>> {
        // Given pi.
        let pi = Pi::new(PathBuf::from("/nonexistent/pi"));

        // When asking what it sees running.
        let running = pi.running().await?;

        // Then nothing: its status comes from its pane reports.
        assert!(running.is_empty(), "pi should see no agent by process");
        Ok(())
    }

    #[rstest::rstest]
    fn pi_info_marks_pi_with_pi() {
        // Given / When reading pi's info.
        let info = info();

        // Then its mark is π.
        assert_eq!(info.icon.as_deref(), Some("π"), "pi's mark");
    }
}
