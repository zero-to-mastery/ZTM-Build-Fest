//! Harnesses, the programs an agent runs in.
//!
//! Everything orb does differently per harness (the agents it sees running,
//! reading transcripts, how to resume a conversation, and where its status
//! comes from) lives in that harness's implementation. Each
//! agent stores the id of its harness, and shared code picks the harness by
//! it.

pub mod claude;
pub mod pi;

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use error_stack::Report;
use wherror::Error;

use super::sessions::state::AgentStatus;
use super::sessions::transcript::{Exchange, MessageRead};
use crate::ids::AgentId;

/// The id a harness is stored and looked up by.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HarnessId(String);

impl HarnessId {
    pub fn new<S>(id: S) -> Self
    where
        S: Into<String>,
    {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for HarnessId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// How the frontend marks a harness: its id, name and sidebar mark.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessInfo {
    pub id: HarnessId,
    /// The name the user sees.
    pub label: String,
    /// The mark beside its agent rows (`✳`, `π`).
    pub icon: Option<String>,
}

/// What a transcript scan found since the last offset.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scan {
    /// The generated title, else the first prompt.
    pub title: Option<String>,
    /// The name the user gave the session inside the harness.
    pub custom_title: Option<String>,
    /// The git branch the transcript named; `None` leaves it to git.
    pub branch: Option<String>,
    /// A generated title arrived in the lines scanned.
    pub ai_titled: bool,
    /// Bytes read so far; pass it to the next scan.
    pub offset: u64,
}

/// How a harness writes its transcripts, and how to read them.
pub trait TranscriptFormat: Send + Sync {
    /// The transcript file of `session_id` started in `cwd`, if it exists.
    fn locate(&self, cwd: &Path, session_id: &str) -> Option<PathBuf>;

    /// Scans the lines added since `offset`, building on `previous`.
    ///
    /// # Errors
    ///
    /// Returns an error if the transcript can't be read.
    fn scan(&self, path: &Path, offset: u64, previous: &Scan) -> io::Result<Scan>;

    /// The transcript's length and its last exchanges.
    ///
    /// # Errors
    ///
    /// Returns an error if the transcript can't be read.
    fn exchanges(&self, path: &Path) -> io::Result<(u64, Vec<Exchange>)>;

    /// The prompts and replies added since `offset`.
    ///
    /// # Errors
    ///
    /// Returns an error if the transcript can't be read.
    fn messages(&self, path: &Path, offset: u64, prompt_offset: u64) -> io::Result<MessageRead>;
}

/// The log text for agent `agent`'s transcript at `path` that couldn't be
/// read.
pub fn unreadable_transcript(agent: AgentId, path: &Path) -> String {
    format!(
        "couldn't read agent {}'s transcript {}",
        agent.0,
        path.display()
    )
}

/// A harness call failed. Every report carries a one-line reason as its
/// latest `String` attachment, fit for the mode line.
#[derive(Debug, Error)]
#[error(debug)]
pub struct HarnessError;

/// An agent the harness sees running, by process: its status and the pids
/// from its own up to the root, which tell the pane it runs in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningAgent {
    pub status: AgentStatus,
    pub ancestry: Vec<u32>,
}

/// A program an agent runs in, which writes the transcripts.
#[async_trait]
pub trait Harness: TranscriptFormat {
    /// The name its service shows in debug output.
    fn name(&self) -> &'static str;

    fn id(&self) -> HarnessId;

    /// The name the user sees.
    fn label(&self) -> &'static str;

    /// How the frontend marks it.
    fn info(&self) -> HarnessInfo;

    /// The command typed into a pane's fresh shell to bring conversation
    /// `session_id` back.
    fn resume_command(&self, session_id: &str) -> String;

    /// The agents it sees running, for harnesses that report status by
    /// process; none for the rest.
    ///
    /// # Errors
    ///
    /// Returns an error if the harness can't be asked.
    async fn running(&self) -> Result<Vec<RunningAgent>, Report<HarnessError>> {
        Ok(Vec::new())
    }

    /// Whether the agent's status comes from the reports orb's integration
    /// writes to its pane file, rather than from the agents it sees running.
    fn reports_status(&self) -> bool {
        false
    }
}

/// Every harness orb knows, in registration order; the first is the default.
#[derive(Clone)]
pub struct Harnesses {
    all: Vec<Arc<dyn Harness>>,
}

impl Harnesses {
    pub fn new(all: Vec<Arc<dyn Harness>>) -> Self {
        Self { all }
    }

    /// The harness stored as `id`, if orb knows it.
    pub fn get(&self, id: &HarnessId) -> Option<&Arc<dyn Harness>> {
        self.all.iter().find(|harness| harness.id() == *id)
    }

    pub fn all(&self) -> &[Arc<dyn Harness>] {
        &self.all
    }

    /// How the frontend marks each harness, in registration order.
    pub fn infos(&self) -> Vec<HarnessInfo> {
        self.all.iter().map(|harness| harness.info()).collect()
    }
}

impl fmt::Debug for Harnesses {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let names: Vec<&str> = self.all.iter().map(|harness| harness.name()).collect();
        write!(f, "Harnesses<{}>", names.join(", "))
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, PoisonError};

    use async_trait::async_trait;
    use error_stack::Report;

    use super::{
        Harness, HarnessError, HarnessId, HarnessInfo, RunningAgent, Scan, TranscriptFormat,
    };
    use crate::feat::sessions::transcript::{Exchange, MessageRead};

    /// A harness named `id` whose every transcript holds the exchanges the
    /// test scripts, and that sees the agents the test scripts running.
    pub(crate) struct FakeHarness {
        id: &'static str,
        /// What [`TranscriptFormat::exchanges`] answers for any path.
        exchanges: Vec<Exchange>,
        /// What [`Harness::running`] answers.
        running: Mutex<Result<Vec<RunningAgent>, String>>,
        /// What [`Harness::reports_status`] answers.
        reports: bool,
    }

    impl FakeHarness {
        /// A harness that sees `running`.
        pub(crate) fn new(id: &'static str, running: Vec<RunningAgent>) -> Self {
            Self {
                id,
                exchanges: Vec::new(),
                running: Mutex::new(Ok(running)),
                reports: false,
            }
        }

        /// This harness, reading `exchanges` from any transcript.
        pub(crate) fn with_exchanges(self, exchanges: Vec<Exchange>) -> Self {
            Self { exchanges, ..self }
        }

        /// A harness like pi, whose status comes from its pane reports.
        pub(crate) fn reporting(id: &'static str) -> Self {
            Self {
                reports: true,
                ..Self::new(id, Vec::new())
            }
        }

        /// From now on [`Harness::running`] answers `running`, or fails
        /// with the reason.
        pub(crate) fn set_running(&self, running: Result<Vec<RunningAgent>, String>) {
            *self.running.lock().unwrap_or_else(PoisonError::into_inner) = running;
        }
    }

    impl TranscriptFormat for FakeHarness {
        fn locate(&self, _cwd: &Path, _session_id: &str) -> Option<PathBuf> {
            None
        }

        fn scan(&self, _path: &Path, _offset: u64, previous: &Scan) -> io::Result<Scan> {
            Ok(previous.clone())
        }

        fn exchanges(&self, _path: &Path) -> io::Result<(u64, Vec<Exchange>)> {
            Ok((0, self.exchanges.clone()))
        }

        fn messages(
            &self,
            _path: &Path,
            offset: u64,
            prompt_offset: u64,
        ) -> io::Result<MessageRead> {
            Ok(MessageRead {
                messages: Vec::new(),
                offset,
                restarted: false,
                prompt_offset,
            })
        }
    }

    #[async_trait]
    impl Harness for FakeHarness {
        fn name(&self) -> &'static str {
            "fake"
        }

        fn id(&self) -> HarnessId {
            HarnessId::new(self.id)
        }

        fn label(&self) -> &'static str {
            self.id
        }

        fn info(&self) -> HarnessInfo {
            HarnessInfo {
                id: self.id(),
                label: self.id.to_owned(),
                icon: None,
            }
        }

        fn resume_command(&self, session_id: &str) -> String {
            format!("{} --resume {session_id}", self.id)
        }

        async fn running(&self) -> Result<Vec<RunningAgent>, Report<HarnessError>> {
            self.running
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
                .map_err(|reason| Report::new(HarnessError).attach(reason))
        }

        fn reports_status(&self) -> bool {
            self.reports
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::fake::FakeHarness;
    use super::{HarnessId, Harnesses};

    #[rstest::rstest]
    fn infos_list_each_harness_in_registration_order() {
        // Given two harnesses, `first` registered before `second`.
        let harnesses = Harnesses::new(vec![
            Arc::new(FakeHarness::new("first", Vec::new())),
            Arc::new(FakeHarness::new("second", Vec::new())),
        ]);

        // When listing their infos.
        let ids: Vec<HarnessId> = harnesses.infos().into_iter().map(|info| info.id).collect();

        // Then they come in registration order.
        assert_eq!(
            ids,
            [HarnessId::new("first"), HarnessId::new("second")],
            "infos should follow registration order"
        );
    }
}
