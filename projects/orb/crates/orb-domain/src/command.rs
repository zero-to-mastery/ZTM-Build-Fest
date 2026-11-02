//! Commands: work the [`IntentHandler`](crate::IntentHandler) asks for after it
//! has updated [`AppState`](crate::AppState). The frontend loop carries out
//! the pane commands (`Attach`, `Detach`, `SendCtrlG`) and the quick reads
//! (`ListDirectories`, `ListBranches`, `LoadPreview`) itself. Each actor's
//! commands are grouped in its own list, which the loop forwards whole:
//! [`SessionsCommand`] (sessions, projects, panes, layouts, the sidebar's
//! saved state), [`WorktreesCommand`] (rescan, delete) and [`SearchCommand`]
//! (query, preview).

use std::path::PathBuf;

use crate::feat::git::git_service::GitRef;
use crate::feat::layout::tree::Split;
use crate::feat::sessions::state::ProjectKind;
use crate::ids::{AgentId, PaneId, ProjectId, SessionId};

/// Something that must happen in response to an intent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Give every pane of the session a client and show it, with the keys in
    /// its focused pane. If its orb worktree is gone, the sessions actor
    /// recreates it first and the frontend attaches once it's back.
    Attach(SessionId),
    /// Stop sending input to the terminal pane.
    Detach,
    /// Write Ctrl g to the focused pane.
    SendCtrlG,
    /// List the refs of the directory's repository into the open branch picker.
    ListBranches(PathBuf),
    /// List the directory's subdirectories into the open directory picker.
    ListDirectories(PathBuf),
    /// Read the agent's transcript into the open session picker's preview.
    LoadPreview { agent: AgentId, transcript: PathBuf },
    /// Work for the sessions actor.
    Sessions(SessionsCommand),
    /// Work for the worktrees actor.
    Worktrees(WorktreesCommand),
    /// Work for the search actor.
    Search(SearchCommand),
}

/// Work the frontend loop forwards to the sessions actor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionsCommand {
    /// Split `session`'s focused pane `split`; the sessions actor makes the pane.
    SplitPane { session: SessionId, split: Split },
    /// Add a shell to `session`'s shown tab and re-tile it unless it was
    /// changed by hand; the sessions actor makes the pane.
    AddPane(SessionId),
    /// Open a shell float on top of `session`'s floats and show them; the
    /// sessions actor makes the pane.
    AddFloat(SessionId),
    /// Stack a shell with `session`'s focused pane; the sessions actor makes
    /// the pane.
    StackPane(SessionId),
    /// Open a tab of one new pane in `session`.
    NewTab(SessionId),
    /// Save `session`'s tabs, splits, focus and pane names as the app state
    /// has them.
    SaveLayout(SessionId),
    /// Make a session of `project` in `workspace`, with one shell, named
    /// `name`.
    NewSession {
        project: ProjectId,
        workspace: Workspace,
        name: Option<String>,
        /// The session active when the user asked; what this start opens
        /// opens only while it still is.
        if_active: Option<SessionId>,
    },
    /// Make the project's root a git repository (`git init`).
    InitGit(ProjectId),
    /// Move `session`, before its first agent turn, to `to`, restarting its
    /// panes there.
    ChangeWorkspace {
        session: SessionId,
        to: Workspace,
        /// The session active when the user asked; what this start opens
        /// opens only while it still is.
        if_active: Option<SessionId>,
    },
    /// Check `git_ref` out in `session`'s directory; with `to_root`, check it
    /// out in the project's checkout and move the session there.
    SwitchBranch {
        session: SessionId,
        git_ref: GitRef,
        to_root: bool,
        /// The session active when the user asked; what this start opens
        /// opens only while it still is.
        if_active: Option<SessionId>,
    },
    /// Add the directory as a project.
    AddProject(PathBuf),
    /// Add `root` as a world of `kind` (`SharedWorld` or `FreshWorld`), named
    /// after its folder; an existing project at `root` becomes that world.
    AddWorld { root: PathBuf, kind: ProjectKind },
    /// Poll the sessions' statuses now instead of waiting for the next tick.
    RefreshSessions,
    /// Pin the session to the top of the sidebar; a settled session
    /// un-settles.
    PinSession(SessionId),
    /// Unpin the session.
    UnpinSession(SessionId),
    /// Give the session a name, or with `None` go back to its agents' or
    /// directory's.
    RenameSession {
        session: SessionId,
        name: Option<String>,
    },
    /// Move the session to the Settled shelf, with every unsettled session
    /// under it when `with_colonists`; none moves while any has a turn
    /// underway.
    SettleSession {
        session: SessionId,
        with_colonists: bool,
    },
    /// Bring the session back from the Settled shelf and keep it active.
    UnsettleSession(SessionId),
    /// Delete the session: its panes, tabs and agents, and every unsettled
    /// session under it when `with_colonists`.
    DeleteSession {
        session: SessionId,
        with_colonists: bool,
    },
    /// The keys are in this agent pane now.
    Visit(PaneId),
    /// Save the sidebar's width and project filter as they now are in the
    /// app state.
    SaveUi,
    /// Save the jump list as it now is in the app state.
    SaveJumps,
    /// Remove the project from `<C-g> n` and the project filter; its sessions
    /// stay.
    RemoveProject(ProjectId),
    /// Make a colony in world `world` with one shell: in a fresh world in a
    /// new folder `name` (a slug) copied from its kit; in a shared world in
    /// its folder, named `name` unless empty.
    NewColony {
        world: ProjectId,
        name: String,
        /// The session active when the user asked; what this start opens
        /// opens only while it still is.
        if_active: Option<SessionId>,
    },
    /// Make the session's orb worktree again, gone from disk, then attach to
    /// it. The frontend loop sends this when `Attach` finds the worktree gone.
    /// It opens while the session is still active.
    RestoreWorktree(SessionId),
}

/// Work the frontend loop forwards to the worktrees actor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorktreesCommand {
    /// Rescan orb's worktrees and re-read their facts, then their sizes.
    RefreshWorktrees,
    /// Force-remove the worktree at `path`, keeping its branch.
    DeleteWorktree { path: PathBuf },
}

/// Work the frontend loop forwards to the search actor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchCommand {
    /// Bring the search index up to date and run `query` in it, listing the
    /// rows in the open search picker while `query` is still its typed text.
    SearchTranscripts { query: String },
    /// Load the exchange of search hit `hit`, the prompt at `prompt_offset` in
    /// the transcript at `path` and its replies, into the search picker's
    /// preview.
    LoadSearchPreview {
        hit: i64,
        path: PathBuf,
        prompt_offset: u64,
    },
}

/// Where a new session runs, or where a session moves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Workspace {
    /// The project's checkout (its root).
    Checkout,
    /// A new worktree orb makes from `base`, a branch or remote ref name.
    NewWorktree { base: String },
    /// A worktree that already exists.
    Existing(PathBuf),
}
