//! An open picker: what it picks, its list, and where the keys go back to.
//!
//! The directory picker reads its input as a path. The part through the last
//! `/` names the directory being browsed, and the rest filters its
//! subdirectories. Editing the directory part asks the frontend to list the
//! new directory.

use std::cmp::Reverse;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::feat::git::git_service::GitRef;
use crate::feat::layout::state::Layouts;
use crate::feat::picker::list::{BranchRow, Matches, PickerItem, PickerList};
use crate::feat::sessions::state::{Agent, AgentStatus, NEW_AGENT, Project, Session, Sessions};
use crate::feat::sessions::transcript::{Exchange, Role};
use crate::feat::worktrees::state::{User, order, users};
use crate::ids::{AgentId, PaneId, ProjectId, SessionId};
use crate::{AppState, Focus};

/// Which agents the session picker lists (`a`/`b`/`w`/`i`/`s`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionFilter {
    /// Every unsettled agent.
    All,
    /// Unsettled agents waiting for an approval or an answer.
    Blocked,
    /// Unsettled agents running a turn.
    Working,
    /// Unsettled agents that are idle or not polled yet.
    Idle,
    /// Only settled sessions' agents.
    Settled,
}

impl SessionFilter {
    /// Whether `agent`, running in `session`, is listed under this filter,
    /// judged by its own status. Failed, stopped and gone agents show only
    /// under `All`.
    fn lists(self, session: &Session, agent: &Agent) -> bool {
        let settled = session.settled_at.is_some();
        match self {
            Self::All => !settled,
            Self::Settled => settled,
            Self::Blocked => {
                !settled
                    && matches!(
                        agent.status,
                        AgentStatus::NeedsApproval | AgentStatus::NeedsInput
                    )
            }
            Self::Working => !settled && agent.status == AgentStatus::Working,
            Self::Idle => {
                !settled && matches!(agent.status, AgentStatus::Idle | AgentStatus::Unknown)
            }
        }
    }
}

/// What a workspace or base picker sets up: a new session in a project, or
/// an existing session's move.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PickTarget {
    /// A new session of `project`, named `name` in the `New session` box.
    New {
        project: ProjectId,
        name: Option<String>,
    },
    /// An existing session's new workspace.
    Move(SessionId),
}

/// What an open picker picks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PickerKind {
    /// `<C-g> n`: pick the project of a new session.
    Projects,
    /// `<C-g> c`: pick the world of a new colony.
    Worlds,
    /// `<C-g> P`: the projects screen, to start a session in, add or remove
    /// projects.
    ManageProjects,
    /// `<C-g> C`: the worlds screen, to start a colony in, add or remove
    /// worlds.
    ManageWorlds,
    /// `a` in the projects or worlds screen: pick a directory to add as a
    /// project, or as a world when `world`. `listed` is the directory text
    /// (e.g. `~/dev/`) the items were read from; `None` while the input isn't
    /// a path.
    Directories { listed: Option<String>, world: bool },
    /// `⏎` on a directory in world mode: add `root` as a shared or fresh
    /// world.
    WorldKind { root: PathBuf },
    /// `<C-g> w`: pick where `target`'s session runs.
    Workspace { target: PickTarget },
    /// A new worktree's base for `target`: the refs of the project's `root`,
    /// the default branch first, none disabled.
    Base { target: PickTarget, root: PathBuf },
    /// `<C-g> b`: pick a branch for `session`, whose refs are listed in `cwd`,
    /// its directory. `unstarted` is whether it has had no agent turn yet, so
    /// it can still follow a branch into another worktree.
    Branches {
        session: SessionId,
        cwd: PathBuf,
        unstarted: bool,
    },
    /// `<C-g> w` or `<C-g> b` where the project isn't a git repository: make it one.
    InitGit { project: ProjectId },
    /// `<C-g> f`: pick the project the sidebar is filtered to, or all of them.
    ProjectFilter,
    /// `d` in the projects screen: confirm removing `project`.
    RemoveProject { project: ProjectId },
    /// `s` on a session: confirm settling it.
    SettleSession { session: SessionId },
    /// `d` on a session: confirm deleting it. `folder` says its Research or
    /// Learn folder goes too.
    DeleteSession { session: SessionId, folder: bool },
    /// `d` on an agent row: confirm closing its pane.
    ClosePane { pane: PaneId, session: SessionId },
    /// `<C-g> Space`: pick an agent to jump into, listing the agents
    /// `filter` lets through; colonists' agents only when `colonists`.
    /// `<C-g> ,` sets `scope` to a colony: only the agents of the sessions
    /// under it.
    Sessions {
        filter: SessionFilter,
        colonists: bool,
        scope: Option<SessionId>,
    },
    /// `<C-g> W`: orb's worktrees, to look over and delete.
    Worktrees,
    /// `d` in the worktree picker: confirm force-removing the worktree at
    /// `path`. `dirty` is whether it has uncommitted changes.
    DeleteWorktree { path: PathBuf, dirty: bool },
    /// `<C-g> /`: messages across every agent's transcripts that match the typed
    /// text. `overflow` is whether more matched than are listed.
    Search { overflow: bool },
}

/// What the session picker's preview shows for an agent: its transcript's
/// last exchanges, and the transcript's length when they were read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionPreview {
    pub agent: AgentId,
    pub len: u64,
    pub exchanges: Vec<Exchange>,
}

/// What the search picker's preview shows for a hit: every indexed message of
/// the exchange it's in, as `(id, role, text)` in transcript order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchPreview {
    pub hit: i64,
    pub messages: Vec<(i64, Role, String)>,
}

/// How a picker takes letters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PickerMode {
    /// Typing filters; the picker has no list mode.
    Filter,
    /// List mode: letters are commands. `pending_g` is whether the first
    /// `g` of `gg` was pressed.
    List { pending_g: bool },
    /// A list-mode picker's search: typing filters until `Esc` goes back
    /// to the list.
    Search,
}

/// The open picker.
#[derive(Debug)]
pub struct PickerState {
    kind: PickerKind,
    list: PickerList,
    /// Where `Esc` or a pick returns the keys.
    return_to: Focus,
    /// What `~/` expands to.
    home: PathBuf,
    /// How many items fit on screen, as the frontend last drew it.
    page: usize,
    /// The branch to select when the refs are listed with nothing typed.
    wanted: Option<String>,
    /// The session picker's preview, as last read.
    preview: Option<SessionPreview>,
    /// The search picker's preview, as last loaded.
    search_preview: Option<SearchPreview>,
    /// The list this picker was opened over (a confirm, or the directory
    /// picker over the projects screen); it returns to it.
    under: Option<Box<PickerState>>,
    /// Whether letters filter or act as list keys.
    mode: PickerMode,
}

impl PickerState {
    /// A project picker over `items`, in the order given.
    pub fn projects(items: Vec<PickerItem>, return_to: Focus) -> Self {
        Self {
            kind: PickerKind::Projects,
            list: PickerList::new(items),
            return_to,
            home: PathBuf::new(),
            page: 0,
            wanted: None,
            preview: None,
            search_preview: None,
            under: None,
            mode: PickerMode::Filter,
        }
    }

    /// The session picker over `items`, in the order given, on all agents,
    /// settled ones hidden, opening in list mode.
    pub fn sessions(items: Vec<PickerItem>, return_to: Focus) -> Self {
        Self {
            kind: PickerKind::Sessions {
                filter: SessionFilter::All,
                colonists: false,
                scope: None,
            },
            list: PickerList::new(items),
            return_to,
            home: PathBuf::new(),
            page: 0,
            wanted: None,
            preview: None,
            search_preview: None,
            under: None,
            mode: PickerMode::List { pending_g: false },
        }
    }

    /// The `Colonists` picker: the session picker scoped to the sessions
    /// under `colony`, opening in list mode.
    pub fn colonists(items: Vec<PickerItem>, colony: SessionId, return_to: Focus) -> Self {
        Self {
            kind: PickerKind::Sessions {
                filter: SessionFilter::All,
                colonists: false,
                scope: Some(colony),
            },
            ..Self::sessions(items, return_to)
        }
    }

    /// The worktree picker over `items`, in the order given, opening in list
    /// mode.
    pub fn worktrees(items: Vec<PickerItem>, return_to: Focus) -> Self {
        Self {
            kind: PickerKind::Worktrees,
            mode: PickerMode::List { pending_g: false },
            ..Self::projects(items, return_to)
        }
    }

    /// The projects screen over `items`, in the order given, opening in list
    /// mode.
    pub fn manage_projects(items: Vec<PickerItem>, return_to: Focus) -> Self {
        Self {
            kind: PickerKind::ManageProjects,
            mode: PickerMode::List { pending_g: false },
            ..Self::projects(items, return_to)
        }
    }

    /// The world picker over `items`, in the order given.
    pub fn worlds(items: Vec<PickerItem>, return_to: Focus) -> Self {
        Self {
            kind: PickerKind::Worlds,
            ..Self::projects(items, return_to)
        }
    }

    /// The worlds screen over `items`, in the order given, opening in list
    /// mode.
    pub fn manage_worlds(items: Vec<PickerItem>, return_to: Focus) -> Self {
        Self {
            kind: PickerKind::ManageWorlds,
            mode: PickerMode::List { pending_g: false },
            ..Self::projects(items, return_to)
        }
    }

    /// The `Shared`/`Fresh` pick for adding `root` as a world, with `Shared`
    /// selected.
    pub fn world_kind(root: PathBuf, return_to: Focus) -> Self {
        Self {
            list: PickerList::new(vec![
                PickerItem::WorldKind { fresh: false },
                PickerItem::WorldKind { fresh: true },
            ]),
            ..Self::confirm(PickerKind::WorldKind { root }, false, return_to)
        }
    }

    /// The search picker, with nothing typed and no rows yet.
    pub fn search(return_to: Focus) -> Self {
        Self {
            kind: PickerKind::Search { overflow: false },
            ..Self::projects(Vec::new(), return_to)
        }
    }

    /// A project filter picker over `items`, in the order given, with
    /// `current`'s project selected, else the first item.
    pub fn project_filter(
        items: Vec<PickerItem>,
        current: Option<ProjectId>,
        return_to: Focus,
    ) -> Self {
        let list = {
            let selected = items
                .iter()
                .find(|item| matches!(item, PickerItem::Project { id, .. } if Some(*id) == current))
                .cloned();
            let mut list = PickerList::new(items);
            if let Some(selected) = selected {
                list.select(&selected);
            }
            list
        };
        Self {
            kind: PickerKind::ProjectFilter,
            list,
            return_to,
            home: PathBuf::new(),
            page: 0,
            wanted: None,
            preview: None,
            search_preview: None,
            under: None,
            mode: PickerMode::Filter,
        }
    }

    /// The `No`/`Yes` confirm for removing `project`, with `No` selected.
    pub fn remove_project(project: ProjectId, return_to: Focus) -> Self {
        Self::confirm(PickerKind::RemoveProject { project }, false, return_to)
    }

    /// The settle confirm for `session`, with `No` selected: `No`/`Yes`, or
    /// `No`/`Colony only`/`With colonists` when it has `colonists`.
    pub fn settle_session(session: SessionId, colonists: bool, return_to: Focus) -> Self {
        Self::confirm(PickerKind::SettleSession { session }, colonists, return_to)
    }

    /// The delete confirm for `session` (and its folder when `folder`), with
    /// `No` selected: `No`/`Yes`, or `No`/`Colony only`/`With colonists`
    /// when it has `colonists`.
    pub fn delete_session(
        session: SessionId,
        folder: bool,
        colonists: bool,
        return_to: Focus,
    ) -> Self {
        Self::confirm(
            PickerKind::DeleteSession { session, folder },
            colonists,
            return_to,
        )
    }

    /// The `No`/`Yes` confirm for closing agent pane `pane` of `session`,
    /// with `No` selected.
    pub fn close_pane(pane: PaneId, session: SessionId, return_to: Focus) -> Self {
        Self::confirm(PickerKind::ClosePane { pane, session }, false, return_to)
    }

    /// The `No`/`Yes` confirm for deleting the worktree at `path`, with `No`
    /// selected, over `list`, which it returns to.
    pub fn delete_worktree(list: PickerState, path: PathBuf, dirty: bool) -> Self {
        let return_to = list.return_to;
        Self::confirm(PickerKind::DeleteWorktree { path, dirty }, false, return_to).over(list)
    }

    /// This picker drawn over `list`, which it returns to; the keys go back
    /// to where `list` was opened from when they close.
    #[must_use]
    pub fn over(self, list: PickerState) -> Self {
        Self {
            return_to: list.return_to,
            under: Some(Box::new(list)),
            ..self
        }
    }

    /// The picker this one was opened over, if any.
    pub fn back(self) -> Option<PickerState> {
        self.under.map(|list| *list)
    }

    /// The picker this confirm is drawn over, if any.
    pub fn under(&self) -> Option<&PickerState> {
        self.under.as_deref()
    }

    /// A confirm of `kind` with `No` selected: `No`/`Yes`, or
    /// `No`/`Colony only`/`With colonists` when `covers`.
    fn confirm(kind: PickerKind, covers: bool, return_to: Focus) -> Self {
        let items = if covers {
            vec![
                PickerItem::Confirm(false),
                PickerItem::Covers { colonists: false },
                PickerItem::Covers { colonists: true },
            ]
        } else {
            vec![PickerItem::Confirm(false), PickerItem::Confirm(true)]
        };
        Self {
            kind,
            list: PickerList::new(items),
            return_to,
            home: PathBuf::new(),
            page: 0,
            wanted: None,
            preview: None,
            search_preview: None,
            under: None,
            mode: PickerMode::Filter,
        }
    }

    /// A workspace picker for `target` over `items`, in the order given.
    pub fn workspace(target: PickTarget, items: Vec<PickerItem>, return_to: Focus) -> Self {
        Self {
            kind: PickerKind::Workspace { target },
            list: PickerList::new(items),
            return_to,
            home: PathBuf::new(),
            page: 0,
            wanted: None,
            preview: None,
            search_preview: None,
            under: None,
            mode: PickerMode::Filter,
        }
    }

    /// A branch picker for `session` in `cwd`, empty until its refs are
    /// listed; then `wanted` is selected if listed, else the first branch.
    pub fn branches(
        session: SessionId,
        cwd: PathBuf,
        unstarted: bool,
        wanted: Option<String>,
        return_to: Focus,
    ) -> Self {
        Self {
            kind: PickerKind::Branches {
                session,
                cwd,
                unstarted,
            },
            list: PickerList::default(),
            return_to,
            home: PathBuf::new(),
            page: 0,
            wanted,
            preview: None,
            search_preview: None,
            under: None,
            mode: PickerMode::Filter,
        }
    }

    /// A base branch picker for `target`'s new worktree, listing the refs of
    /// `root`; empty until they are listed.
    pub fn base(target: PickTarget, root: PathBuf, return_to: Focus) -> Self {
        Self {
            kind: PickerKind::Base { target, root },
            list: PickerList::default(),
            return_to,
            home: PathBuf::new(),
            page: 0,
            wanted: None,
            preview: None,
            search_preview: None,
            under: None,
            mode: PickerMode::Filter,
        }
    }

    /// The one-row picker that offers to make `project` a git repository.
    pub fn init_git(project: ProjectId, return_to: Focus) -> Self {
        Self {
            kind: PickerKind::InitGit { project },
            list: PickerList::new(vec![PickerItem::InitGit]),
            return_to,
            home: PathBuf::new(),
            page: 0,
            wanted: None,
            preview: None,
            search_preview: None,
            under: None,
            mode: PickerMode::Filter,
        }
    }

    /// A directory picker with `~/` typed, and `home`, the directory to list.
    pub fn directories(home: PathBuf, return_to: Focus) -> (Self, PathBuf) {
        let list = {
            let mut list = PickerList::default();
            list.replace_input("~/");
            list
        };
        let picker = Self {
            kind: PickerKind::Directories {
                listed: Some("~/".to_owned()),
                world: false,
            },
            list,
            return_to,
            home: home.clone(),
            page: 0,
            wanted: None,
            preview: None,
            search_preview: None,
            under: None,
            mode: PickerMode::Filter,
        };
        (picker, home)
    }

    /// A directory picker like [`Self::directories`], picking a folder to
    /// add as a world.
    pub fn world_directories(home: PathBuf, return_to: Focus) -> (Self, PathBuf) {
        let (picker, home) = Self::directories(home, return_to);
        let picker = Self {
            kind: PickerKind::Directories {
                listed: Some("~/".to_owned()),
                world: true,
            },
            ..picker
        };
        (picker, home)
    }

    /// Types `ch`. Returns a directory to list when the directory part changed.
    pub fn insert(&mut self, ch: char) -> Option<PathBuf> {
        self.list.insert(ch);
        self.edited()
    }

    /// Deletes the grapheme before the cursor. Returns a directory to list
    /// when the directory part changed.
    pub fn backspace(&mut self) -> Option<PathBuf> {
        self.list.backspace();
        self.edited()
    }

    /// Deletes the word before the cursor. Returns a directory to list when
    /// the directory part changed.
    pub fn delete_word(&mut self) -> Option<PathBuf> {
        self.list.delete_word();
        self.edited()
    }

    /// Shows `names`, the subdirectories of `dir`, alphabetically ignoring
    /// case. Ignored unless `dir` is the directory being browsed.
    pub fn show_directories(&mut self, dir: &Path, names: Vec<String>) {
        let PickerKind::Directories {
            listed: Some(listed),
            ..
        } = &self.kind
        else {
            return;
        };
        if expand(listed, &self.home) != dir {
            return;
        }
        let items = {
            let mut names = names;
            names.sort_by_cached_key(|name| (name.to_lowercase(), name.clone()));
            names
                .into_iter()
                .map(|name| PickerItem::Directory { name })
                .collect()
        };
        let leaf =
            split_path(self.list.input()).map_or_else(String::new, |(_, leaf)| leaf.to_owned());
        self.list.set_items(items, &leaf);
    }

    /// Shows `items`, a fresh [`worktree_items`], filtered by the typed text,
    /// keeping the selected worktree selected while it's still shown. Ignored
    /// unless this is the worktree picker.
    pub fn show_worktrees(&mut self, items: Vec<PickerItem>) {
        if !matches!(self.kind, PickerKind::Worktrees) {
            return;
        }
        let path_of = |item: &PickerItem| match item {
            PickerItem::Worktree { path, .. } => Some(path.clone()),
            _ => None,
        };
        let selected = self.list.selected().and_then(path_of);
        let wanted = items
            .iter()
            .find(|item| selected.is_some() && path_of(item) == selected)
            .cloned();
        let pattern = self.list.input().to_owned();
        self.list.set_items(items, &pattern);
        if let Some(wanted) = wanted {
            self.list.select(&wanted);
        }
    }

    /// Shows `items`, fresh project rows, in the projects or worlds screen (this picker
    /// or the one under it), filtered by the typed text, keeping the selected
    /// project selected while it's still shown. Other pickers ignore it.
    pub fn show_projects(&mut self, items: Vec<PickerItem>) {
        if !matches!(
            self.kind,
            PickerKind::ManageProjects | PickerKind::ManageWorlds
        ) {
            if let Some(list) = &mut self.under {
                list.show_projects(items);
            }
            return;
        }
        let id_of = |item: &PickerItem| match item {
            PickerItem::Project { id, .. } => Some(*id),
            _ => None,
        };
        let selected = self.list.selected().and_then(id_of);
        let wanted = items
            .iter()
            .find(|item| selected.is_some() && id_of(item) == selected)
            .cloned();
        let pattern = self.list.input().to_owned();
        self.list.set_items(items, &pattern);
        if let Some(wanted) = wanted {
            self.list.select(&wanted);
        }
    }

    /// Shows `refs`, listed in `cwd`, filtered by the typed text. Ignored
    /// unless this is `cwd`'s branch or base picker. A branch picker selects
    /// the wanted branch when nothing is typed and, once the agent has had a
    /// prompt, disables a branch checked out in another worktree. A base
    /// picker lists the default branch first and disables none.
    pub fn show_branches(&mut self, cwd: &Path, refs: Vec<GitRef>) {
        let unstarted = match &self.kind {
            PickerKind::Branches {
                cwd: picker_cwd,
                unstarted,
                ..
            } if picker_cwd == cwd => *unstarted,
            PickerKind::Base { root, .. } if root == cwd => {
                let mut refs = refs;
                refs.sort_by_key(|git_ref| !git_ref.default);
                let items = refs
                    .into_iter()
                    .map(|git_ref| {
                        PickerItem::Branch(BranchRow {
                            disabled: false,
                            git_ref,
                        })
                    })
                    .collect();
                let pattern = self.list.input().to_owned();
                self.list.set_items(items, &pattern);
                return;
            }
            _ => return,
        };
        let items = refs
            .into_iter()
            .map(|git_ref| {
                let elsewhere = git_ref.worktree.as_ref().is_some_and(|path| path != cwd);
                PickerItem::Branch(BranchRow {
                    disabled: elsewhere && !unstarted,
                    git_ref,
                })
            })
            .collect::<Vec<_>>();
        let wanted = items
            .iter()
            .find(|item| {
                matches!(item, PickerItem::Branch(row) if Some(&row.git_ref.name) == self.wanted.as_ref())
            })
            .cloned();
        let pattern = self.list.input().to_owned();
        self.list.set_items(items, &pattern);
        if let Some(wanted) = wanted.filter(|_| pattern.is_empty()) {
            self.list.select(&wanted);
        }
    }

    /// Applies `pressed` in the session picker, or goes back to all when it
    /// is already the filter, re-listing `sessions`' agents under the typed
    /// text and selecting the best match. Other pickers ignore it.
    pub fn set_filter(&mut self, pressed: SessionFilter, sessions: &Sessions, layouts: &Layouts) {
        let PickerKind::Sessions {
            filter,
            colonists,
            scope,
        } = &mut self.kind
        else {
            return;
        };
        *filter = if *filter == pressed {
            SessionFilter::All
        } else {
            pressed
        };
        let items = session_items(sessions, layouts, *filter, *colonists, *scope);
        let pattern = self.list.input().to_owned();
        self.list.set_items(items, &pattern);
    }

    /// Shows or hides colonists' agents in the session picker, keeping the
    /// filter and the typed text. Other pickers, and the Colonists picker,
    /// ignore it.
    pub fn toggle_colonists(&mut self, sessions: &Sessions, layouts: &Layouts) {
        let PickerKind::Sessions {
            filter,
            colonists,
            scope: None,
        } = &mut self.kind
        else {
            return;
        };
        *colonists = !*colonists;
        let items = session_items(sessions, layouts, *filter, *colonists, None);
        let pattern = self.list.input().to_owned();
        self.list.set_items(items, &pattern);
    }

    /// The selected row's agent: a session row's agent's, or a
    /// search hit's. `None` for any other row.
    pub fn selected_agent_id(&self) -> Option<AgentId> {
        match self.list.selected() {
            Some(&(PickerItem::Session { agent, .. } | PickerItem::Hit { agent, .. })) => {
                Some(agent)
            }
            _ => None,
        }
    }

    /// The selected row's agent, as its session and pane; `None` unless an
    /// agent row of the session picker is selected.
    pub fn selected_agent(&self) -> Option<(SessionId, PaneId)> {
        match self.list.selected() {
            Some(&PickerItem::Session { id, pane, .. }) => Some((id, pane)),
            _ => None,
        }
    }

    /// The session the selected row opens: a session row's, or the one a
    /// hit's agent runs or last ran in. `None` for any other row.
    pub fn picked_session(&self, sessions: &Sessions) -> Option<SessionId> {
        match *self.list.selected()? {
            PickerItem::Session { id, .. } => Some(id),
            PickerItem::Hit { agent, .. } => sessions
                .all_agents()
                .find(|shown| shown.id == agent)
                .and_then(Agent::home),
            _ => None,
        }
    }

    /// The selected worktree row's path; `None` unless one is selected.
    pub fn selected_worktree(&self) -> Option<&Path> {
        match self.list.selected() {
            Some(PickerItem::Worktree { path, .. }) => Some(path),
            _ => None,
        }
    }

    /// Drops the selected row, keeping the typed text, and selects the next
    /// row, else the previous one.
    pub fn remove_selected_row(&mut self) {
        self.list.remove_selected();
    }

    /// Keeps `exchanges`, read from `agent`'s transcript at `len` bytes, as
    /// the preview. Dropped unless `agent` is still the selected row, so a
    /// late read for an old selection never shows.
    pub fn show_preview(&mut self, agent: AgentId, len: u64, exchanges: Vec<Exchange>) {
        if self.selected_agent_id() == Some(agent) {
            self.preview = Some(SessionPreview {
                agent,
                len,
                exchanges,
            });
        }
    }

    /// The selected agent's preview; `None` until it's read, or with no
    /// agent selected.
    pub fn preview(&self) -> Option<&SessionPreview> {
        self.preview
            .as_ref()
            .filter(|preview| Some(preview.agent) == self.selected_agent_id())
    }

    /// Forgets both the session and the search picker's preview.
    pub fn clear_preview(&mut self) {
        self.preview = None;
        self.search_preview = None;
    }

    /// The selected hit's message id, transcript and prompt offset; `None`
    /// unless a hit row is selected.
    pub fn selected_hit(&self) -> Option<(i64, &Path, u64)> {
        match self.list.selected() {
            Some(PickerItem::Hit {
                id,
                path,
                prompt_offset,
                ..
            }) => Some((*id, path, *prompt_offset)),
            _ => None,
        }
    }

    /// Keeps `messages` as hit `hit`'s preview. Dropped unless `hit` is still
    /// the selected row, so a late load for an old selection never shows.
    pub fn show_search_preview(&mut self, hit: i64, messages: Vec<(i64, Role, String)>) {
        if self.selected_hit().map(|(id, ..)| id) == Some(hit) {
            self.search_preview = Some(SearchPreview { hit, messages });
        }
    }

    /// The selected hit's preview; `None` until it's loaded, or with no hit
    /// selected.
    pub fn search_preview(&self) -> Option<&SearchPreview> {
        self.search_preview
            .as_ref()
            .filter(|preview| self.selected_hit().map(|(id, ..)| id) == Some(preview.hit))
    }

    /// The typed text while this is the search picker; `None` otherwise.
    pub fn search_query(&self) -> Option<&str> {
        matches!(self.kind, PickerKind::Search { .. }).then(|| self.list.input())
    }

    /// Lists `items`, the rows `query` found, in the order given, selecting
    /// the first. Ignored unless this is the search picker and `query` is
    /// still its typed text, so a late result never replaces newer ones.
    /// `overflow` is whether more matched than `items` holds.
    pub fn show_hits(&mut self, query: &str, items: Vec<PickerItem>, overflow: bool) {
        let PickerKind::Search { overflow: shown } = &mut self.kind else {
            return;
        };
        if self.list.input() != query {
            return;
        }
        *shown = overflow;
        self.list.set_items(items, "");
    }

    /// Whether the selected agent's transcript, now `len` bytes long, needs
    /// reading for the preview: nothing was read for it yet, or it was read
    /// at another length.
    pub fn wants_preview(&self, len: u64) -> bool {
        self.selected_agent_id().is_some()
            && self.preview().is_none_or(|preview| preview.len != len)
    }

    /// Selects the shown row holding `item`; stays put when none does.
    pub fn select(&mut self, item: &PickerItem) {
        self.list.select(item);
    }

    /// Browses into the selected directory. Returns it to list.
    pub fn open_directory(&mut self) -> Option<PathBuf> {
        let (dir_text, _) = split_path(self.list.input())?;
        let Some(PickerItem::Directory { name }) = self.list.selected() else {
            return None;
        };
        let input = format!("{dir_text}{name}/");
        self.list.replace_input(&input);
        self.edited()
    }

    /// The directory `⏎` adds: the selected one, else the typed directory
    /// when nothing follows its last `/`.
    pub fn directory_to_add(&self) -> Option<PathBuf> {
        if !matches!(self.kind, PickerKind::Directories { .. }) {
            return None;
        }
        let (dir_text, leaf) = split_path(self.list.input())?;
        let dir = expand(dir_text, &self.home);
        match self.list.selected() {
            Some(PickerItem::Directory { name }) => Some(dir.join(name)),
            Some(
                PickerItem::Project { .. }
                | PickerItem::Workspace(_)
                | PickerItem::Branch(_)
                | PickerItem::InitGit
                | PickerItem::AllProjects
                | PickerItem::Confirm(_)
                | PickerItem::Covers { .. }
                | PickerItem::Session { .. }
                | PickerItem::Worktree { .. }
                | PickerItem::Hit { .. }
                | PickerItem::WorldKind { .. },
            ) => None,
            None => leaf.is_empty().then_some(dir),
        }
    }

    /// Records how many items fit on screen, for half-page moves.
    pub fn resize(&mut self, page: usize) {
        self.page = page;
    }

    /// Selects the next item.
    pub fn next(&mut self) {
        self.list.next();
    }

    /// Selects the previous item.
    pub fn prev(&mut self) {
        self.list.prev();
    }

    /// Moves the selection down half a page.
    pub fn half_page_down(&mut self) {
        self.list.half_page_down(self.page);
    }

    /// Moves the selection up half a page.
    pub fn half_page_up(&mut self) {
        self.list.half_page_up(self.page);
    }

    /// Whether the picker is in list mode, where letters are commands.
    pub fn listing(&self) -> bool {
        matches!(self.mode, PickerMode::List { .. })
    }

    /// Whether a list-mode picker is in its search mode.
    pub fn searching(&self) -> bool {
        self.mode == PickerMode::Search
    }

    /// Moves a list-mode picker's keys into its input box. Other pickers
    /// ignore it.
    pub fn start_search(&mut self) {
        if self.listing() {
            self.mode = PickerMode::Search;
        }
    }

    /// Takes a searching picker back to its list, keeping the typed text.
    pub fn leave_search(&mut self) {
        if self.searching() {
            self.mode = PickerMode::List { pending_g: false };
        }
    }

    /// `g` in list mode: the second of `gg` selects the first item, the first
    /// waits for it.
    pub fn press_g(&mut self) {
        if let PickerMode::List { pending_g } = &mut self.mode {
            if *pending_g {
                self.list.first();
            }
            *pending_g = !*pending_g;
        }
    }

    /// Any key but `g` ends a `gg` in progress.
    pub fn forget_g(&mut self) {
        if let PickerMode::List { pending_g } = &mut self.mode {
            *pending_g = false;
        }
    }

    /// Selects the last item.
    pub fn last(&mut self) {
        self.list.last();
    }

    /// Selects shown row `index` unless it's a heading, disabled or past the end.
    pub fn select_row(&mut self, index: usize) {
        self.list.select_row(index);
    }

    /// Selects the next item, stopping on the last.
    pub fn select_below(&mut self) {
        self.list.select_below();
    }

    /// Selects the previous item, stopping on the first.
    pub fn select_above(&mut self) {
        self.list.select_above();
    }

    /// Moves the cursor one grapheme left.
    pub fn cursor_left(&mut self) {
        self.list.cursor_left();
    }

    /// Moves the cursor one grapheme right.
    pub fn cursor_right(&mut self) {
        self.list.cursor_right();
    }

    /// Moves the cursor to grapheme `index`, or to the end when the input is
    /// shorter.
    pub fn cursor_to(&mut self, index: usize) {
        self.list.cursor_to(index);
    }

    /// What the picker picks.
    pub fn kind(&self) -> &PickerKind {
        &self.kind
    }

    /// Where the keys go when the picker closes.
    pub fn return_to(&self) -> Focus {
        self.return_to
    }

    /// How many items fit on screen, as last drawn.
    pub fn page(&self) -> usize {
        self.page
    }

    /// The typed text.
    pub fn input(&self) -> &str {
        self.list.input()
    }

    /// The cursor, as a grapheme index into [`input`](Self::input).
    pub fn cursor(&self) -> usize {
        self.list.cursor()
    }

    /// The selected row, as an index into [`shown`](Self::shown).
    pub fn selection(&self) -> usize {
        self.list.selection()
    }

    /// The selected item; `None` when nothing is shown.
    pub fn selected(&self) -> Option<&PickerItem> {
        self.list.selected()
    }

    /// The shown items and where they matched, in display order.
    pub fn shown(&self) -> impl Iterator<Item = (&PickerItem, &Matches)> {
        self.list.shown()
    }

    /// How many items the picker has, shown or hidden by the filter.
    pub fn total(&self) -> usize {
        self.list.total()
    }

    /// After an edit: re-filter, or start browsing the new directory. The
    /// search picker's rows come from the search index, so it keeps them.
    fn edited(&mut self) -> Option<PathBuf> {
        let input = self.list.input().to_owned();
        let PickerKind::Directories { listed, .. } = &mut self.kind else {
            if !matches!(self.kind, PickerKind::Search { .. }) {
                self.list.refilter(&input);
            }
            return None;
        };
        match split_path(&input) {
            None => {
                *listed = None;
                self.list.set_items(Vec::new(), "");
                None
            }
            Some((dir_text, _)) if listed.as_deref() != Some(dir_text) => {
                *listed = Some(dir_text.to_owned());
                self.list.set_items(Vec::new(), "");
                Some(expand(dir_text, &self.home))
            }
            Some((_, leaf)) => {
                self.list.refilter(leaf);
                None
            }
        }
    }
}

/// Splits a path the user typed into the directory part, through the last
/// `/`, and the rest. `None` unless it starts with `/` or `~/`.
pub fn split_path(input: &str) -> Option<(&str, &str)> {
    if !(input.starts_with('/') || input.starts_with("~/")) {
        return None;
    }
    input.split_at_checked(input.rfind('/')? + 1)
}

/// The directory `dir_text` names, with `~/` meaning `home` and no trailing `/`.
pub fn expand(dir_text: &str, home: &Path) -> PathBuf {
    let path = match dir_text.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(dir_text),
    };
    path.components().collect()
}

/// The session picker's rows: one per agent running in a pane of a session
/// inside the project filter (removed projects too), newest chat first by
/// the agent's latest chat, ties to the higher agent id. Sessions being
/// deleted, sessions with no agent panes, and agents `filter` leaves out are
/// left out, and so are colonists' agents unless `colonists`. With `scope`,
/// only the sessions under that colony are listed (through settled ones
/// under the settled filter), whatever the project filter.
pub fn session_items(
    sessions: &Sessions,
    layouts: &Layouts,
    filter: SessionFilter,
    colonists: bool,
    scope: Option<SessionId>,
) -> Vec<PickerItem> {
    let scoped = scope.map(|colony| sessions.below(colony, filter == SessionFilter::Settled));
    let mut rows: Vec<(SystemTime, i64, PickerItem)> = sessions
        .sessions
        .iter()
        .filter(|session| match &scoped {
            Some(ids) => ids.contains(&session.id),
            None => {
                sessions
                    .filter
                    .is_none_or(|filter| filter == session.project)
                    && (colonists || session.parent.is_none())
            }
        })
        .filter(|session| !sessions.deleting.contains(&session.id))
        .filter_map(|session| Some((session, sessions.project(session.project)?)))
        .flat_map(|(session, project)| {
            let (prefix, split) = session_label(sessions, project, session);
            sessions
                .agent_rows(session.id, layouts)
                .into_iter()
                .filter(move |(agent, _)| filter.lists(session, agent))
                .map(move |(agent, pane)| {
                    (
                        agent.last_chat(),
                        agent.id.0,
                        PickerItem::Session {
                            id: session.id,
                            agent: agent.id,
                            pane,
                            label: format!("{prefix}/{}", layouts.agent_name(pane, Some(agent))),
                            split,
                            settled: session.settled_at.is_some(),
                        },
                    )
                })
        })
        .collect();
    rows.sort_by_key(|(last_chat, id, _)| Reverse((*last_chat, *id)));
    rows.into_iter().map(|(_, _, item)| item).collect()
}

/// A session's picker label, `<project>/title`, and the byte offset where
/// the title starts.
pub fn session_label(sessions: &Sessions, project: &Project, session: &Session) -> (String, usize) {
    (
        format!("{}/{}", project.title, sessions.title(session)),
        project.title.len() + 1,
    )
}

/// A search hit's label in `agent`: its session's label while that session
/// exists, else `<project>/<agent title>`.
pub fn hit_label(sessions: &Sessions, project: &Project, agent: &Agent) -> (String, usize) {
    match agent.home().and_then(|id| sessions.session(id)) {
        Some(session) => session_label(sessions, project, session),
        None => {
            let title = agent.title.as_deref().unwrap_or(NEW_AGENT);
            (
                format!("{}/{title}", project.title),
                project.title.len() + 1,
            )
        }
    }
}

/// The worktree picker's rows: `app`'s worktrees in [`order`], each labelled
/// `<repo>/<name>` and matched also on its branch and its users' titles.
pub fn worktree_items(app: &AppState) -> Vec<PickerItem> {
    order(app)
        .into_iter()
        .map(|worktree| {
            let file_name = |path: Option<&Path>| {
                path.and_then(Path::file_name)
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default()
            };
            let repo = file_name(worktree.path.parent());
            let name = file_name(Some(&worktree.path));
            let branch = worktree
                .facts
                .as_ref()
                .and_then(|facts| facts.branch.as_deref());
            let users = users(app, &worktree.path);
            let titles = users.iter().map(|user| match user {
                User::Session(_, session, _) => app.sessions.title(session),
            });
            PickerItem::Worktree {
                path: worktree.path.clone(),
                label: format!("{repo}/{name}"),
                split: repo.len() + 1,
                extra: branch
                    .map(str::to_owned)
                    .into_iter()
                    .chain(titles)
                    .collect::<Vec<_>>()
                    .join(" "),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests;
