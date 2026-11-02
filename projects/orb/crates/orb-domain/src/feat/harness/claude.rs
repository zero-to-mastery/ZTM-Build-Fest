//! Claude Code: the interactive Claudes it runs, seen by process, and
//! transcripts under its config dir.

pub mod supervisor;
pub mod transcript;

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use error_stack::Report;

use self::supervisor::ClaudeAgents;
use super::{Harness, HarnessError, HarnessId, HarnessInfo, RunningAgent, Scan, TranscriptFormat};
use crate::feat::sessions::transcript::{Exchange, MessageRead};

/// The id Claude Code agents are stored under.
pub const ID: &str = "claude";

/// The name the user sees for Claude Code.
const LABEL: &str = "Claude Code";

/// How the frontend marks Claude Code: its name and `✳`.
pub fn info() -> HarnessInfo {
    HarnessInfo {
        id: HarnessId::new(ID),
        label: LABEL.to_owned(),
        icon: Some("✳".to_owned()),
    }
}

/// Claude Code: its agents through `agents`, transcripts under `claude_dir`.
pub struct ClaudeCode {
    agents: Arc<dyn ClaudeAgents>,
    claude_dir: PathBuf,
}

impl ClaudeCode {
    pub fn new(agents: Arc<dyn ClaudeAgents>, claude_dir: PathBuf) -> Self {
        Self { agents, claude_dir }
    }
}

impl TranscriptFormat for ClaudeCode {
    fn locate(&self, cwd: &Path, session_id: &str) -> Option<PathBuf> {
        transcript::locate(&self.claude_dir, cwd, session_id)
    }

    fn scan(&self, path: &Path, offset: u64, previous: &Scan) -> io::Result<Scan> {
        transcript::scan_title(
            path,
            offset,
            previous.title.clone(),
            previous.custom_title.clone(),
            previous.branch.clone(),
        )
    }

    fn exchanges(&self, path: &Path) -> io::Result<(u64, Vec<Exchange>)> {
        transcript::read_exchanges(path)
    }

    fn messages(&self, path: &Path, offset: u64, prompt_offset: u64) -> io::Result<MessageRead> {
        transcript::read_messages(path, offset, prompt_offset)
    }
}

#[async_trait]
impl Harness for ClaudeCode {
    fn name(&self) -> &'static str {
        self.agents.name()
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
        format!("claude --resume {session_id}")
    }

    async fn running(&self) -> Result<Vec<RunningAgent>, Report<HarnessError>> {
        self.agents.list().await
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use std::sync::{
        Mutex, PoisonError,
        atomic::{AtomicUsize, Ordering},
    };

    use async_trait::async_trait;
    use error_stack::Report;
    use tokio::sync::oneshot;

    use super::supervisor::ClaudeAgents;
    use crate::feat::harness::{HarnessError, RunningAgent};

    /// A `claude` that runs the agents the test scripts.
    pub(crate) struct FakeClaude {
        running: Mutex<Result<Vec<RunningAgent>, String>>,
        /// How many times `list` was called.
        lists: AtomicUsize,
        /// While set, `list` waits until its sender is used or dropped.
        gate: Mutex<Option<oneshot::Receiver<()>>>,
    }

    impl FakeClaude {
        /// A `claude` running `running`.
        pub(crate) fn running(running: Vec<RunningAgent>) -> Self {
            Self {
                running: Mutex::new(Ok(running)),
                lists: AtomicUsize::new(0),
                gate: Mutex::new(None),
            }
        }

        /// A `claude` running `running` whose first `list` waits until the
        /// returned sender is used or dropped.
        pub(crate) fn gated(running: Vec<RunningAgent>) -> (Self, oneshot::Sender<()>) {
            let (open, gate) = oneshot::channel();
            let claude = Self {
                gate: Mutex::new(Some(gate)),
                ..Self::running(running)
            };
            (claude, open)
        }

        /// How many times `list` was called.
        pub(crate) fn lists(&self) -> usize {
            self.lists.load(Ordering::SeqCst)
        }

        /// From now on `list` answers `running`, or fails with the reason.
        pub(crate) fn set_running(&self, running: Result<Vec<RunningAgent>, String>) {
            *self.running.lock().unwrap_or_else(PoisonError::into_inner) = running;
        }
    }

    #[async_trait]
    impl ClaudeAgents for FakeClaude {
        fn name(&self) -> &'static str {
            "fake"
        }

        async fn list(&self) -> Result<Vec<RunningAgent>, Report<HarnessError>> {
            self.lists.fetch_add(1, Ordering::SeqCst);
            let gate = self
                .gate
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            if let Some(gate) = gate {
                let _ = gate.await;
            }
            self.running
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
                .map_err(|reason| Report::new(HarnessError).attach(reason))
        }
    }
}
