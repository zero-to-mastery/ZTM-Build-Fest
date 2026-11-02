//! What the `orb` commands and a running orb say to each other over the socket:
//! one request line, one reply line, both JSON.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::feat::layout::tree::Split;
use crate::feat::sessions::state::AgentStatus;
use crate::ids::{AgentId, PaneId, ProjectId, SessionId};

/// The socket's file name inside orb's folder (`~/.orb`).
pub const SOCKET_FILE: &str = "orb.sock";

/// Where a running orb listens, given orb's folder.
pub fn socket_path(orb_root: &Path) -> PathBuf {
    orb_root.join(SOCKET_FILE)
}

/// One request: who asks (the pane the command runs in, if any) and what for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request {
    /// The pane the command was run from, when it runs inside orb.
    pub caller: Option<PaneId>,
    /// What is asked.
    #[serde(flatten)]
    pub op: Op,
}

/// What a request asks for, named on the wire as `<thing>.<verb>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op")]
pub enum Op {
    /// Every session, settled ones included.
    #[serde(rename = "session.list")]
    SessionList,
    /// A session's tabs and the panes in each.
    #[serde(rename = "tab.list")]
    TabList {
        /// The session, else the caller's.
        #[serde(default)]
        session: Option<SessionId>,
    },
    /// A session's panes, with the caller's marked.
    #[serde(rename = "pane.list")]
    PaneList {
        /// The session, else the caller's.
        #[serde(default)]
        session: Option<SessionId>,
    },
    /// Every live agent in every session.
    #[serde(rename = "agent.list")]
    AgentList,
    /// A new shell beside a pane (or its whole stack).
    #[serde(rename = "pane.split")]
    PaneSplit {
        /// The pane, else the caller's.
        #[serde(default)]
        pane: Option<PaneId>,
        /// Which side the new pane goes.
        direction: Direction,
    },
    /// A new shell stacked right after a pane.
    #[serde(rename = "pane.stack")]
    PaneStack {
        /// The pane, else the caller's.
        #[serde(default)]
        pane: Option<PaneId>,
    },
    /// A new floating shell in a session.
    #[serde(rename = "pane.float")]
    PaneFloat {
        /// The session, else the caller's.
        #[serde(default)]
        session: Option<SessionId>,
    },
    /// A new tab with one shell at the end of a session's tabs.
    #[serde(rename = "tab.create")]
    TabCreate {
        /// The session, else the caller's.
        #[serde(default)]
        session: Option<SessionId>,
    },
    /// A new session.
    #[serde(rename = "session.create")]
    SessionCreate {
        /// The project, else the caller's session's.
        #[serde(default)]
        project: Option<ProjectId>,
        /// In a new worktree from the project's default branch, else in its
        /// checkout.
        #[serde(default)]
        worktree: bool,
        /// Its name, else the usual one.
        #[serde(default)]
        name: Option<String>,
    },
    /// Closes a pane.
    #[serde(rename = "pane.close")]
    PaneClose { pane: PaneId },
    /// Names a pane; an empty name goes back to the usual one.
    #[serde(rename = "pane.rename")]
    PaneRename { pane: PaneId, name: String },
    /// Shows a pane and moves the keys into it.
    #[serde(rename = "pane.focus")]
    PaneFocus { pane: PaneId },
    /// Closes the tab holding a pane.
    #[serde(rename = "tab.close")]
    TabClose {
        /// The pane, else the caller's.
        #[serde(default)]
        pane: Option<PaneId>,
    },
    /// Names a session; an empty name goes back to the usual one.
    #[serde(rename = "session.rename")]
    SessionRename {
        /// The session, else the caller's.
        #[serde(default)]
        session: Option<SessionId>,
        name: String,
    },
    /// Moves a session to the Settled shelf.
    #[serde(rename = "session.settle")]
    SessionSettle {
        /// The session, else the caller's.
        #[serde(default)]
        session: Option<SessionId>,
    },
    /// Shows a session's focused pane and moves the keys into it.
    #[serde(rename = "session.focus")]
    SessionFocus { session: SessionId },
    /// Pastes text into a pane.
    #[serde(rename = "pane.send")]
    PaneSend { pane: PaneId, text: String },
    /// Presses named keys in a pane, in order.
    #[serde(rename = "pane.keys")]
    PaneKeys { pane: PaneId, keys: Vec<String> },
    /// Types a command and Enter into a pane.
    #[serde(rename = "pane.run")]
    PaneRun { pane: PaneId, command: String },
    /// A pane's screen, plus up to `lines` lines of history, as text.
    #[serde(rename = "pane.read")]
    PaneRead {
        /// The pane, else the caller's.
        #[serde(default)]
        pane: Option<PaneId>,
        /// How many lines of history to add above the screen.
        #[serde(default)]
        lines: usize,
    },
    /// Starts an agent in a shell pane and waits until orb sees it.
    #[serde(rename = "agent.start")]
    AgentStart {
        /// The pane, else the caller's.
        #[serde(default)]
        pane: Option<PaneId>,
        kind: AgentKind,
        /// A name for the pane.
        #[serde(default)]
        name: Option<String>,
        /// Typed after the program, each quoted for the shell.
        #[serde(default)]
        args: Vec<String>,
    },
    /// Pastes a prompt into an agent and presses Enter.
    #[serde(rename = "agent.prompt")]
    AgentPrompt {
        pane: PaneId,
        text: String,
        /// Wait for the turn to end or the agent to be blocked.
        #[serde(default)]
        wait: bool,
        /// Milliseconds the whole call may take; none waits as long as work
        /// goes on.
        #[serde(default)]
        timeout: Option<u64>,
    },
    /// Waits until a pane's agent is idle or waits on the user.
    #[serde(rename = "agent.wait")]
    AgentWait {
        pane: PaneId,
        /// Milliseconds to wait; none waits as long as work goes on.
        #[serde(default)]
        timeout: Option<u64>,
    },
    /// A pane's agent, as `agent list` shows it.
    #[serde(rename = "agent.get")]
    AgentGet { pane: PaneId },
    /// The last reply in a pane's agent's transcript.
    #[serde(rename = "agent.reply")]
    AgentReply { pane: PaneId },
}

/// The program `agent start` types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Pi,
}

/// Which side of a pane `pane split` puts the new one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Right,
    Down,
}

impl From<Direction> for Split {
    fn from(direction: Direction) -> Self {
        match direction {
            Direction::Right => Self::Right,
            Direction::Down => Self::Down,
        }
    }
}

/// Why a request failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// Nothing listens on the socket (only the client says this).
    NotRunning,
    /// The request couldn't be read or makes no sense.
    BadRequest,
    /// No target was given and the command doesn't run inside an orb pane.
    NoTarget,
    /// The pane, session or agent doesn't exist (or is being deleted).
    NotFound,
    /// The session is settled, so nothing in it may change.
    Settled,
    /// A session is already starting.
    Starting,
    /// The agent waits for an approval or an answer.
    AgentBlocked,
    /// An agent is already live in that pane.
    PaneBusy,
    /// No live agent in that pane.
    NoAgent,
    /// The agent has no reply yet.
    NoReply,
    /// The wait ran out of time.
    Timeout,
    /// The agent didn't start working after the prompt.
    PromptStalled,
    /// Something else went wrong; the message says what.
    Failed,
}

/// A failure as it goes on the wire: a code and a message for people.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiError {
    /// Why it failed.
    pub code: ErrorCode,
    /// What happened, in words.
    pub message: String,
}

impl ApiError {
    /// A failure with this code and message.
    pub fn new<M>(code: ErrorCode, message: M) -> Self
    where
        M: Into<String>,
    {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// One reply: `ok` with a result, or not `ok` with an error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reply {
    /// Whether the request succeeded.
    pub ok: bool,
    /// What a successful request gives back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    /// Why a request failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ApiError>,
}

impl Reply {
    /// A successful reply carrying `result`; a result that can't be written
    /// as JSON becomes a `failed` reply.
    pub fn ok<T>(result: &T) -> Self
    where
        T: Serialize,
    {
        match serde_json::to_value(result) {
            Ok(value) => Self {
                ok: true,
                result: Some(value),
                error: None,
            },
            Err(error) => Self::err(ApiError::new(ErrorCode::Failed, error.to_string())),
        }
    }

    /// A failed reply.
    pub fn err(error: ApiError) -> Self {
        Self {
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}

/// One session in `session list`.
#[derive(Debug, Clone, Serialize)]
pub struct SessionRow {
    pub id: SessionId,
    pub project: ProjectId,
    /// The name the sidebar shows.
    pub name: String,
    pub dir: String,
    pub branch: Option<String>,
    pub settled: bool,
}

/// `session list`'s result.
#[derive(Debug, Clone, Serialize)]
pub struct SessionsResult {
    pub sessions: Vec<SessionRow>,
}

/// One tab in `tab list`: its place and its panes.
#[derive(Debug, Clone, Serialize)]
pub struct TabRow {
    /// Its place in the tab bar, counted from 1.
    pub index: usize,
    pub panes: Vec<PaneId>,
}

/// `tab list`'s result.
#[derive(Debug, Clone, Serialize)]
pub struct TabsResult {
    pub session: SessionId,
    pub tabs: Vec<TabRow>,
}

/// One pane in `pane list`.
#[derive(Debug, Clone, Serialize)]
pub struct PaneRow {
    pub id: PaneId,
    pub session: SessionId,
    /// The tab holding it, counted from 1; none for a floating pane.
    pub tab: Option<usize>,
    pub float: bool,
    pub name: Option<String>,
    pub cwd: String,
    /// The agent live in it, if any.
    pub agent: Option<AgentId>,
    /// Whether it is the pane the command ran from.
    pub caller: bool,
}

/// `pane list`'s result.
#[derive(Debug, Clone, Serialize)]
pub struct PanesResult {
    pub panes: Vec<PaneRow>,
}

/// One agent in `agent list`.
#[derive(Debug, Clone, Serialize)]
pub struct AgentRow {
    pub id: AgentId,
    pub pane: Option<PaneId>,
    pub session: SessionId,
    pub harness: String,
    /// The name the sidebar shows.
    pub name: String,
    /// The agent's own title, once its transcript names it.
    pub title: Option<String>,
    pub status: AgentStatus,
    pub cwd: String,
    pub branch: Option<String>,
}

/// What an add replies: the new pane.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneResult {
    pub pane: PaneId,
}

/// `session create`'s result: the new session and its first pane.
#[derive(Debug, Clone, Serialize)]
pub struct StartResult {
    pub session: SessionId,
    pub pane: PaneId,
}

/// What a change replies once done: nothing (`{}`).
#[derive(Debug, Clone, Serialize)]
#[expect(
    clippy::empty_structs_with_brackets,
    reason = "a unit struct would go on the wire as null, not {}"
)]
pub struct Done {}

/// `pane read`'s result: the screen as text, empty when it shows nothing.
#[derive(Debug, Clone, Serialize)]
pub struct ReadResult {
    pub text: String,
}

/// `agent start`'s result: the agent orb saw start in the pane.
#[derive(Debug, Clone, Serialize)]
pub struct StartedResult {
    pub pane: PaneId,
    pub agent: AgentId,
    pub harness: String,
    pub status: AgentStatus,
}

/// `agent prompt`'s result without `--wait`.
#[derive(Debug, Clone, Serialize)]
pub struct PromptResult {
    pub submitted: bool,
}

/// How a wait on an agent ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitEnd {
    /// The turn ended.
    Idle,
    /// The agent waits for an approval or an answer.
    Blocked,
}

/// `agent wait`'s (and `agent prompt --wait`'s) result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WaitResult {
    pub status: WaitEnd,
}

/// `agent reply`'s result: the last reply's text and when it was written,
/// in unix milliseconds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReplyResult {
    pub text: String,
    pub at: Option<i64>,
}

/// `agent list`'s result.
#[derive(Debug, Clone, Serialize)]
pub struct AgentsResult {
    pub agents: Vec<AgentRow>,
}
