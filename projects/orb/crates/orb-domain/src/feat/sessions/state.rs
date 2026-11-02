//! The sidebar's contents: projects, their sessions and agents, the
//! sidebar's order, and its cursor.

use std::cmp::Reverse;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fuzzy_matcher::skim::SkimMatcherV2;
use serde::Serialize;

use crate::TextInput;
use crate::feat::harness::HarnessId;
use crate::feat::layout::state::Layouts;
use crate::feat::picker::list::fuzzy_match;
use crate::feat::sidebar::state::SidebarLayout;
use crate::ids::{AgentId, PaneId, ProjectId, SessionId};

mod tree;

/// What an agent is called before its transcript names it.
pub const NEW_AGENT: &str = "New agent";

/// The pane an agent runs in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneLaunch {
    pub pane: PaneId,
    /// The session the pane belongs to.
    pub session: SessionId,
}

/// What a session is for, which decides its look and keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SessionKind {
    /// Work in a project's checkout or worktree.
    Plain,
    /// A colony: runs in a world; Research and Learn sessions are colonies.
    Colony,
    /// A chat outside any project, in orb's Incognito folder.
    Incognito,
}

/// One directory holding tabs of panes, some of them running agents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub id: SessionId,
    pub project: ProjectId,
    pub kind: SessionKind,
    /// The session whose pane made it through `orb session create`, when that
    /// was a colony or a colonist; `None` = top level.
    pub parent: Option<SessionId>,
    /// Where its panes start.
    pub dir: PathBuf,
    /// The name the user gave with `r`; `None` = not renamed.
    pub name: Option<String>,
    /// The branch the store last recorded.
    pub branch: Option<String>,
    pub created_at: SystemTime,
    /// When the session was pinned; `None` = not pinned.
    pub pinned_at: Option<SystemTime>,
    /// When the session was settled; `None` = not settled.
    pub settled_at: Option<SystemTime>,
    /// Sorts Active: the later of its creation and its latest un-settle.
    pub active_since: SystemTime,
    /// When a turn last ended in one of its agent panes.
    pub last_activity_at: SystemTime,
}

/// orb's built-in fresh worlds, whose kits orb seeds when missing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderKind {
    /// `~/.orb/research/<name>/`.
    Research,
    /// `~/.orb/learn/<name>/`.
    Learn,
}

/// A folder's slug: `name`'s words joined by `-`, case kept (`GT-514 login`
/// → `GT-514-login`).
#[must_use]
pub fn folder_slug(name: &str) -> String {
    name.split_whitespace().collect::<Vec<_>>().join("-")
}

/// Where a world's colonies run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorldDirs {
    /// Every colony runs in the world's own folder.
    Shared(PathBuf),
    /// Each colony runs in its own copy of `kit`, a folder under `colonies`;
    /// `seed` is orb's built-in kit, written to `kit` when it's missing.
    Fresh {
        kit: PathBuf,
        colonies: PathBuf,
        seed: Option<FolderKind>,
    },
}

/// `project`'s world folders under orb's own folder `orb_root`; `None`
/// when it isn't a world.
#[must_use]
pub fn world_dirs(orb_root: &Path, project: &Project) -> Option<WorldDirs> {
    let built_in = |dir: &str, seed| WorldDirs::Fresh {
        kit: orb_root.join("templates").join(dir),
        colonies: orb_root.join(dir),
        seed: Some(seed),
    };
    match project.kind {
        ProjectKind::Research => Some(built_in("research", FolderKind::Research)),
        ProjectKind::Learn => Some(built_in("learn", FolderKind::Learn)),
        ProjectKind::FreshWorld => Some(WorldDirs::Fresh {
            kit: project.root.clone(),
            colonies: orb_root.join("worlds").join(&project.title),
            seed: None,
        }),
        ProjectKind::SharedWorld => Some(WorldDirs::Shared(project.root.clone())),
        ProjectKind::Normal | ProjectKind::Incognito => None,
    }
}

/// Whether a project is one the user added, a world colonies run in, or one
/// of orb's own folders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectKind {
    /// A directory the user added.
    Normal,
    /// orb's built-in fresh world whose colonies' folders are under `~/.orb/research`.
    Research,
    /// orb's built-in fresh world whose colonies' folders are under `~/.orb/learn`.
    Learn,
    /// orb's folder for chats outside any project (`/tmp/orb-incognito`).
    Incognito,
    /// A world whose colonies all run in its folder.
    SharedWorld,
    /// A world whose colonies each run in their own copy of its kit.
    FreshWorld,
}

impl ProjectKind {
    /// Whether colonies run in it: Research, Learn and the user's worlds.
    #[must_use]
    pub fn is_world(self) -> bool {
        matches!(
            self,
            Self::Research | Self::Learn | Self::SharedWorld | Self::FreshWorld
        )
    }

    /// Whether each of its colonies gets its own folder: Research, Learn and
    /// the user's fresh worlds.
    #[must_use]
    pub fn is_fresh_world(self) -> bool {
        matches!(self, Self::Research | Self::Learn | Self::FreshWorld)
    }
}

/// What an agent's session is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    /// Not polled yet since orb started.
    Unknown,
    /// The session is running a turn.
    Working,
    /// The session waits for the user to approve something.
    NeedsApproval,
    /// The session waits for the user to answer.
    NeedsInput,
    /// The session is idle, ready for a prompt.
    Idle,
    /// The session failed.
    Failed,
    /// The session stopped.
    Stopped,
    /// Its harness no longer knows the session.
    Gone,
}

impl AgentStatus {
    /// Whether a turn is underway: running, or paused waiting on the user.
    pub fn in_progress(self) -> bool {
        matches!(self, Self::Working | Self::NeedsApproval | Self::NeedsInput)
    }
}

/// Why an agent needs the user, as a notification says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeKind {
    /// A turn ended.
    Finished,
    /// The session started waiting for an approval.
    NeedsApproval,
    /// The session started waiting for an answer.
    NeedsInput,
}

impl NoticeKind {
    /// What the notification's body says.
    pub fn label(self) -> &'static str {
        match self {
            Self::Finished => "Finished",
            Self::NeedsApproval => "Needs approval",
            Self::NeedsInput => "Needs input",
        }
    }
}

/// A status change the frontend announces as a notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub agent: AgentId,
    pub kind: NoticeKind,
    /// The agent's project's title.
    pub project: String,
    /// The agent's title, else "New agent".
    pub title: String,
}

/// One session orb started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Agent {
    pub id: AgentId,
    /// `None` until the transcript names the agent.
    pub title: Option<String>,
    /// Where the session runs.
    pub cwd: PathBuf,
    /// The session's transcript, once located.
    pub transcript: Option<PathBuf>,
    pub status: AgentStatus,
    /// When orb first saw the current turn running; `None` between turns.
    pub turn_started_at: Option<SystemTime>,
    /// How its pane runs; `None` for a harness orb doesn't know.
    pub pane: Option<PaneLaunch>,
    /// The session it runs in, or ran in before its pane ended; `None` for
    /// an agent that never ran in one.
    pub last_session: Option<SessionId>,
    /// The git branch the transcript last named.
    pub branch: Option<String>,
    /// When the agent was created (its store row's `created_at`).
    pub created_at: SystemTime,
    /// When orb last saw a turn end, else when the agent was created.
    pub last_activity_at: SystemTime,
    /// A turn ended after the user last selected the agent.
    pub unseen: bool,
    /// The `--model` a session from before the overhaul started with;
    /// `None` = unknown.
    pub model: Option<String>,
    /// The harness its session runs in.
    pub harness: HarnessId,
}

impl Agent {
    /// When the user last chatted in the agent: the later of the current
    /// turn's start and the last turn's end.
    pub fn last_chat(&self) -> SystemTime {
        self.turn_started_at
            .unwrap_or(UNIX_EPOCH)
            .max(self.last_activity_at)
    }

    /// The session whose pane it runs in; `None` once it has ended.
    pub fn session(&self) -> Option<SessionId> {
        self.pane.as_ref().map(|pane| pane.session)
    }

    /// The session it runs in, else the one it last ran in.
    pub fn home(&self) -> Option<SessionId> {
        self.session().or(self.last_session)
    }

    /// How urgently the agent needs the user, lowest first: an approval,
    /// an answer, a failure or lost session, a running turn, a turn done
    /// since the user last looked, then idle, then stopped.
    pub fn urgency(&self) -> u8 {
        match self.status {
            AgentStatus::NeedsApproval => 0,
            AgentStatus::NeedsInput => 1,
            AgentStatus::Failed | AgentStatus::Gone => 2,
            AgentStatus::Working => 3,
            AgentStatus::Idle if self.unseen => 4,
            AgentStatus::Idle | AgentStatus::Unknown => 5,
            AgentStatus::Stopped => 6,
        }
    }
}

/// The agent among `agents` that most needs the user (see
/// [`Agent::urgency`]); a session's status is its.
pub fn most_urgent<'a, I>(agents: I) -> Option<&'a Agent>
where
    I: IntoIterator<Item = &'a Agent>,
{
    agents.into_iter().min_by_key(|agent| agent.urgency())
}

/// A directory the user starts sessions in.
#[derive(Debug, Clone)]
pub struct Project {
    pub id: ProjectId,
    pub title: String,
    pub root: PathBuf,
    /// When the project was added.
    pub created_at: SystemTime,
    /// Newest first.
    pub agents: Vec<Agent>,
    /// Whether its root is in a git repository, as the sessions actor last
    /// found; never for orb's own projects. Not saved.
    pub repo: bool,
    /// Removed from `<C-g> n` and the project filter; its sessions stay.
    pub removed: bool,
    pub kind: ProjectKind,
}

/// A row the sidebar's cursor can rest on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidebarItem {
    /// A session's card, or its line on the Settled shelf.
    Session(SessionId),
    /// The Settled shelf's header.
    SettledShelf,
    /// An agent's line under its session's card, keyed by the agent's pane.
    Agent { session: SessionId, pane: PaneId },
    /// The colonists row under session `id`'s card.
    Colonists(SessionId),
}

/// One sidebar row, in display order. `depth` is how many levels down the
/// tree it sits (a top-level card is 0), `rails` whether each level above
/// it carries a guide line down past it, and `last` whether it's its
/// parent's last child.
#[derive(Debug, Clone)]
pub enum SidebarRow<'a> {
    /// A pinned or active session's two-line card, or (path) a one-line dim
    /// row.
    Card {
        project: &'a Project,
        session: &'a Session,
        depth: usize,
        rails: Vec<bool>,
        last: bool,
        /// A session shown only on the way to a stuck colonist under a
        /// folded colonists row: one dim line.
        path: bool,
    },
    /// The Settled shelf's header.
    ShelfHeader {
        /// How many sessions are settled.
        count: usize,
        /// Whether it reads as open: the shelf is, or a search lists its
        /// matches.
        open: bool,
    },
    /// A settled session, drawn as a one-line row.
    Settled {
        project: &'a Project,
        session: &'a Session,
    },
    /// An agent pane's line under its session's card; `last` is the card's
    /// last child (its agent rows, then its colonists row).
    Agent {
        session: &'a Session,
        agent: &'a Agent,
        pane: PaneId,
        depth: usize,
        rails: Vec<bool>,
        last: bool,
    },
    /// The row under `session`'s card that holds its colonists.
    Colonists {
        session: &'a Session,
        depth: usize,
        rails: Vec<bool>,
        last: bool,
        /// Its colonists show: the row is open, or a search has text.
        open: bool,
    },
}

impl SidebarRow<'_> {
    /// What the cursor rests on when it is on this row.
    pub fn item(&self) -> SidebarItem {
        match self {
            Self::Card { session, .. } | Self::Settled { session, .. } => {
                SidebarItem::Session(session.id)
            }
            Self::ShelfHeader { .. } => SidebarItem::SettledShelf,
            Self::Agent { session, pane, .. } => SidebarItem::Agent {
                session: session.id,
                pane: *pane,
            },
            Self::Colonists { session, .. } => SidebarItem::Colonists(session.id),
        }
    }
}

/// The sidebar search: the typed text, and where the cursor was before it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Search {
    pub input: TextInput,
    /// Where `Esc` puts the cursor back.
    pub return_to: Option<SidebarItem>,
}

/// orb's projects, sessions and agents, and where the sidebar's cursor is.
///
/// Written by the sessions actor (projects, `sessions`, `starting` when a
/// start ends, `fetching`, the cursor and `filter` after a restore, the
/// cursor on a new session, removing a session from `deleting`) and by the
/// intent handler (the cursor on navigation, settle and delete, `active`,
/// `shelf_open`, `folded`, `colonists_open`, `starting` when a start begins, adding a session
/// to `deleting`, `filter`, `error`). The frontend loop moves `error` into
/// the message box.
#[derive(Debug, Clone, Default)]
pub struct Sessions {
    /// In the order orb first used them.
    pub projects: Vec<Project>,
    /// Every session, in the order the store made them. Written only by the
    /// sessions actor.
    pub sessions: Vec<Session>,
    /// What the sidebar's cursor is on.
    pub cursor: Option<SidebarItem>,
    /// The session the right-hand area shows, set by entering a row; `None`
    /// before any is entered and after the active session is settled or
    /// deleted. Written only by the intent handler; read it through
    /// [`Sessions::active`].
    pub active: Option<SessionId>,
    /// The Settled shelf shows its sessions. Written only by the intent
    /// handler.
    pub shelf_open: bool,
    /// A new session is being created, or a session's worktree recreated.
    pub starting: bool,
    /// Some saved layouts couldn't be read at start. For the rest of the run
    /// orb kills no pane program, deletes no pane and prunes no worktree it
    /// can't account for. Written only by the sessions actor, at start.
    pub partial_load: bool,
    /// The origin ref a start is fetching, like `origin/main`; none when no
    /// fetch is running. Written only by the sessions actor.
    pub fetching: Option<String>,
    /// Why the intent just handled was refused, for the message box.
    /// Written only by the intent handler (it clears it first on every
    /// intent) and the frontend loop, which moves it into the message box
    /// after each turn. Workers report their errors instead.
    pub error: Option<String>,
    /// Sessions hidden while they are removed. The intent handler inserts,
    /// the sessions actor removes.
    pub deleting: HashSet<SessionId>,
    /// The project the sidebar is filtered to; `None` = all projects.
    pub filter: Option<ProjectId>,
    /// The sidebar search while the user types one. Written only by the
    /// intent handler; the frontend clears it when it gives the keys to a
    /// pane.
    pub search: Option<Search>,
    /// Sessions whose cards hide their agent rows. Written only by the
    /// intent handler; empty at start and never saved.
    pub folded: HashSet<SessionId>,
    /// Sessions whose colonists row shows all its colonists. Written only by
    /// the intent handler; empty at start (every colonists row folded) and
    /// never saved.
    pub colonists_open: HashSet<SessionId>,
}

impl Sessions {
    /// Non-removed projects whose kind passes `keep`, most recently active
    /// first: by their agents' latest activity, else when they were added.
    /// Ties go by title, then id.
    fn by_recency<F>(&self, keep: F) -> Vec<&Project>
    where
        F: Fn(ProjectKind) -> bool,
    {
        let mut projects: Vec<&Project> = self
            .projects
            .iter()
            .filter(|project| !project.removed && keep(project.kind))
            .collect();
        projects.sort_by_key(|&project| {
            let latest = project
                .agents
                .iter()
                .map(|agent| agent.last_activity_at)
                .max()
                .unwrap_or(project.created_at);
            (Reverse(latest), &project.title, project.id.0)
        });
        projects
    }

    /// The projects the user added and didn't remove, most recently active
    /// first: by their agents' latest activity, else when they were added.
    /// Ties go by title, then id. orb's own projects (Research, Learn,
    /// Incognito) and the worlds aren't listed.
    pub fn projects_by_recency(&self) -> Vec<&Project> {
        self.by_recency(|kind| kind == ProjectKind::Normal)
    }

    /// The worlds (Research, Learn and the user's) not removed, in
    /// `projects_by_recency`'s order.
    pub fn worlds_by_recency(&self) -> Vec<&Project> {
        self.by_recency(ProjectKind::is_world)
    }

    /// orb's own project of `kind` (Research, Learn or Incognito), unless it
    /// was removed.
    pub fn own_project(&self, kind: ProjectKind) -> Option<&Project> {
        self.projects
            .iter()
            .find(|project| project.kind == kind && !project.removed)
    }

    /// Session `id`, if it still exists.
    pub fn session(&self, id: SessionId) -> Option<&Session> {
        self.sessions.iter().find(|session| session.id == id)
    }

    /// Project `id`, if it still exists.
    pub fn project(&self, id: ProjectId) -> Option<&Project> {
        self.projects.iter().find(|project| project.id == id)
    }

    /// The agents running in session `id`'s panes (its agent panes'
    /// conversations), oldest first; none while it is being deleted.
    pub fn agents(&self, id: SessionId) -> Vec<&Agent> {
        if self.deleting.contains(&id) {
            return Vec::new();
        }
        let mut agents: Vec<&Agent> = self
            .all_agents()
            .filter(|agent| agent.session() == Some(id))
            .collect();
        agents.sort_by_key(|agent| (agent.created_at, agent.id.0));
        agents
    }

    /// What `session` is called: its `r` name, else the first of its agents
    /// a transcript named, else its directory's name.
    pub fn title(&self, session: &Session) -> String {
        session
            .name
            .clone()
            .or_else(|| {
                self.agents(session.id)
                    .into_iter()
                    .find_map(|agent| agent.title.clone())
            })
            .unwrap_or_else(|| {
                session.dir.file_name().map_or_else(
                    || session.dir.display().to_string(),
                    |name| name.to_string_lossy().into_owned(),
                )
            })
    }

    /// Whether an agent turn has run in session `id`: one of its agents,
    /// ended ones included, has a title (its first prompt or an agent's
    /// title) or a turn underway.
    pub fn turned(&self, id: SessionId) -> bool {
        self.all_agents().any(|agent| {
            agent.home() == Some(id) && (agent.title.is_some() || agent.status.in_progress())
        })
    }

    /// Session `id`'s agent rows: its agents whose pane a tab or float of
    /// its layout holds, with the pane.
    pub fn agent_rows(&self, id: SessionId, layouts: &Layouts) -> Vec<(&Agent, PaneId)> {
        self.agents(id)
            .into_iter()
            .filter_map(|agent| Some((agent, agent.pane.as_ref()?.pane)))
            .filter(|&(_, pane)| layouts.owner_of(pane) == Some(id))
            .collect()
    }

    /// Whether pane `pane` still runs one of session `id`'s agents (never
    /// while the session is being deleted).
    pub fn runs_agent(&self, id: SessionId, pane: PaneId, layouts: &Layouts) -> bool {
        self.agent_rows(id, layouts)
            .iter()
            .any(|&(_, shown)| shown == pane)
    }

    /// Whether session `id`'s card hides its agent rows: it's folded and no
    /// search has text, since a search lists a folded card as if open.
    pub fn hides_agents(&self, id: SessionId) -> bool {
        self.folded.contains(&id) && !self.searching()
    }

    /// Whether `agent` runs in a session being deleted.
    pub fn is_deleting(&self, agent: &Agent) -> bool {
        agent
            .session()
            .is_some_and(|session| self.deleting.contains(&session))
    }

    /// Every agent in sidebar order: project by project, newest first.
    pub fn all_agents(&self) -> impl Iterator<Item = &Agent> {
        self.projects
            .iter()
            .flat_map(|project| project.agents.iter())
    }

    /// Where the search's terms matched `title`, as sorted byte offsets:
    /// empty without a search or with blank text, `None` when a term
    /// doesn't match.
    pub fn title_matches(&self, title: &str) -> Option<Vec<usize>> {
        let terms: Vec<&str> = self
            .search
            .as_ref()
            .map(|search| search.input.text().split_whitespace().collect())
            .unwrap_or_default();
        match terms.as_slice() {
            [] => Some(Vec::new()),
            terms => {
                fuzzy_match(&SkimMatcherV2::default(), title, terms).map(|(_, offsets)| offsets)
            }
        }
    }

    /// Move the cursor to the first row the search lists, or to
    /// nothing when none matches. Blank text leaves the cursor where it is.
    pub fn select_first_match(&mut self, layouts: &Layouts) {
        if self.searching() {
            self.cursor = self.matches(layouts).first().copied();
        }
    }

    /// Move the cursor to the next row the search lists, agent rows
    /// included, past the shelf header; wraps from the last one to the first. Without a
    /// cursor, or with one on a row that's gone, selects the first.
    pub fn select_next_match(&mut self, layouts: &Layouts) {
        let matches = self.matches(layouts);
        let next = match self.position(&matches, layouts) {
            None => matches.first(),
            Some(at) => matches.get((at + 1) % matches.len()),
        };
        if let Some(&next) = next {
            self.cursor = Some(next);
        }
    }

    /// Move the cursor to the previous row the search lists, agent
    /// rows included, past the shelf header; wraps from the first one to the last. Without
    /// a cursor, or with one on a row that's gone, selects the first.
    pub fn select_prev_match(&mut self, layouts: &Layouts) {
        let matches = self.matches(layouts);
        let prev = match self.position(&matches, layouts) {
            None => matches.first(),
            Some(at) => matches.get((at + matches.len() - 1) % matches.len()),
        };
        if let Some(&prev) = prev {
            self.cursor = Some(prev);
        }
    }

    /// End the search and put the cursor back where it was before it, or on
    /// the first row when that row is no longer listed.
    pub fn cancel_search(&mut self, layouts: &Layouts) {
        let Some(search) = self.search.take() else {
            return;
        };
        self.cursor = search.return_to;
        let items = self.items(layouts);
        if self.position(&items, layouts).is_none() {
            self.cursor = items.first().copied();
        }
    }

    /// Makes session `id` the one the right-hand area shows.
    pub fn enter(&mut self, id: SessionId) {
        self.active = Some(id);
    }

    /// Leaves session `id`: nothing is active any more if it was.
    pub fn leave(&mut self, id: SessionId) {
        if self.active == Some(id) {
            self.active = None;
        }
    }

    /// The active session, while it still exists and isn't being deleted.
    pub fn active(&self) -> Option<SessionId> {
        self.active
            .filter(|id| !self.deleting.contains(id) && self.session(*id).is_some())
    }

    /// The session under the cursor, or whose agent row it's on, if it still
    /// exists and isn't being deleted.
    pub fn selected_session(&self) -> Option<&Session> {
        match self.cursor? {
            SidebarItem::Session(id) | SidebarItem::Agent { session: id, .. }
                if !self.deleting.contains(&id) =>
            {
                self.session(id)
            }
            _ => None,
        }
    }

    /// The agent row under the cursor, as its session and pane, while that
    /// pane still runs one of the session's agents.
    pub fn selected_agent(&self, layouts: &Layouts) -> Option<(SessionId, PaneId)> {
        match self.cursor? {
            SidebarItem::Agent { session, pane } if self.runs_agent(session, pane, layouts) => {
                Some((session, pane))
            }
            _ => None,
        }
    }

    /// The row the cursor reads as: its own, or its session's card once the
    /// agent row it was on is gone.
    pub fn cursor_row(&self, layouts: &Layouts) -> Option<SidebarItem> {
        match self.cursor? {
            SidebarItem::Agent { session, .. } if self.selected_agent(layouts).is_none() => {
                Some(SidebarItem::Session(session))
            }
            item => Some(item),
        }
    }

    /// The agent running in pane `pane`, if any.
    pub fn agent_in(&self, pane: PaneId) -> Option<&Agent> {
        self.all_agents().find(|agent| {
            agent
                .pane
                .as_ref()
                .is_some_and(|launch| launch.pane == pane)
        })
    }

    /// The selected session's lead agent: its oldest agent pane's.
    pub fn selected_lead_agent(&self) -> Option<&Agent> {
        self.agents(self.selected_session()?.id).into_iter().next()
    }

    /// The project of the session under the cursor.
    pub fn selected_project(&self) -> Option<&Project> {
        self.project(self.selected_session()?.project)
    }

    /// Move the cursor to the row below; wraps from the last row to the first.
    /// Without a cursor, or with one on a row that's gone, selects the first
    /// row.
    pub fn select_next(&mut self, layouts: &Layouts) {
        let items = self.items(layouts);
        let next = match self.position(&items, layouts) {
            None => items.first(),
            Some(at) => items.get((at + 1) % items.len()),
        };
        if let Some(&next) = next {
            self.cursor = Some(next);
        }
    }

    /// Move the cursor to the row above; wraps from the first row to the last.
    /// Without a cursor, or with one on a row that's gone, selects the first
    /// row.
    pub fn select_prev(&mut self, layouts: &Layouts) {
        let items = self.items(layouts);
        let prev = match self.position(&items, layouts) {
            None => items.first(),
            Some(at) => items.get((at + items.len() - 1) % items.len()),
        };
        if let Some(&prev) = prev {
            self.cursor = Some(prev);
        }
    }

    /// Move the cursor to `item` when it's one of the sidebar's rows;
    /// otherwise leave it.
    pub fn select_row(&mut self, item: SidebarItem, layouts: &Layouts) {
        if self.items(layouts).contains(&item) {
            self.cursor = Some(item);
        }
    }

    /// Move the cursor to the first row.
    pub fn select_first(&mut self, layouts: &Layouts) {
        if let Some(&first) = self.items(layouts).first() {
            self.cursor = Some(first);
        }
    }

    /// Move the cursor to the last row.
    pub fn select_last(&mut self, layouts: &Layouts) {
        if let Some(&last) = self.items(layouts).last() {
            self.cursor = Some(last);
        }
    }

    /// Move the cursor down by as many rows as fit in half the sidebar's
    /// visible height, at least one; stays put on the last row. Without a
    /// cursor, or with one on a row that's gone, selects the first row.
    pub fn half_page_down(&mut self, layout: &SidebarLayout, layouts: &Layouts) {
        let items = self.items(layouts);
        let target = match self.position(&items, layouts) {
            None => items.first(),
            Some(at) => {
                let steps = half_page(layout, at + 1..items.len());
                items.get((at + steps).min(items.len() - 1))
            }
        };
        if let Some(&target) = target {
            self.cursor = Some(target);
        }
    }

    /// Move the cursor up by as many rows as fit in half the sidebar's
    /// visible height, at least one; stays put on the first row. Without a
    /// cursor, or with one on a row that's gone, selects the first row.
    pub fn half_page_up(&mut self, layout: &SidebarLayout, layouts: &Layouts) {
        let items = self.items(layouts);
        let target = match self.position(&items, layouts) {
            None => items.first(),
            Some(at) => items.get(at.saturating_sub(half_page(layout, (0..at).rev()))),
        };
        if let Some(&target) = target {
            self.cursor = Some(target);
        }
    }

    /// Where the cursor goes when session `item` is settled: the next card
    /// below whose session isn't in `skip`, else the nearest one above,
    /// else the shelf header the settle creates.
    pub fn card_neighbour(
        &self,
        item: SidebarItem,
        layouts: &Layouts,
        skip: &[SessionId],
    ) -> Option<SidebarItem> {
        self.neighbour(
            item,
            layouts,
            |row| matches!(row, SidebarRow::Card { session, .. } if !skip.contains(&session.id)),
        )
        .or(Some(SidebarItem::SettledShelf))
    }

    /// Where the cursor goes when `item` is deleted: the next row below,
    /// else the nearest one above, skipping shelf headers, agent rows and
    /// colonists rows; else the shelf header if another session is settled.
    pub fn row_neighbour(&self, item: SidebarItem, layouts: &Layouts) -> Option<SidebarItem> {
        self.neighbour(item, layouts, |row| {
            !matches!(
                row,
                SidebarRow::ShelfHeader { .. }
                    | SidebarRow::Agent { .. }
                    | SidebarRow::Colonists { .. }
            )
        })
        .or_else(|| {
            self.settled_listed(layouts)
                .into_iter()
                .any(|(_, session)| SidebarItem::Session(session.id) != item)
                .then_some(SidebarItem::SettledShelf)
        })
    }

    /// Filters the sidebar to `filter`'s project, or to all projects; a
    /// cursor on a row no longer listed moves to the first row.
    pub fn filter_to(&mut self, filter: Option<ProjectId>, layouts: &Layouts) {
        self.filter = filter;
        let items = self.items(layouts);
        if self.position(&items, layouts).is_none() {
            self.cursor = items.first().copied();
        }
    }

    /// Show the Settled shelf's sessions.
    pub fn open_shelf(&mut self) {
        self.shelf_open = true;
    }

    /// Hide the Settled shelf's sessions and put the cursor on its header.
    pub fn close_shelf(&mut self) {
        self.shelf_open = false;
        self.cursor = Some(SidebarItem::SettledShelf);
    }

    /// Hide session `id`'s agent rows and put the cursor on its card.
    pub fn fold(&mut self, id: SessionId) {
        self.folded.insert(id);
        self.cursor = Some(SidebarItem::Session(id));
    }

    /// Show session `id`'s agent rows again.
    pub fn unfold(&mut self, id: SessionId) {
        self.folded.remove(&id);
    }

    /// Show every colonist under session `id`'s colonists row.
    pub fn unfold_colonists(&mut self, id: SessionId) {
        self.colonists_open.insert(id);
    }

    /// Fold session `id`'s colonists row back to its stuck colonists; the
    /// cursor stays where it is.
    pub fn fold_colonists(&mut self, id: SessionId) {
        self.colonists_open.remove(&id);
    }

    /// Whether a jump can land on `item`: it still exists, isn't being
    /// deleted, and the project filter lists it. Never the Settled header
    /// nor a colonists row; an agent row only while its pane still runs an
    /// agent.
    pub fn jumpable(&self, item: SidebarItem, layouts: &Layouts) -> bool {
        match item {
            SidebarItem::Session(id) => self.listed(id),
            SidebarItem::Agent { session, pane } => {
                self.jumpable(SidebarItem::Session(session), layouts)
                    && self.runs_agent(session, pane, layouts)
            }
            SidebarItem::SettledShelf | SidebarItem::Colonists(_) => false,
        }
    }

    /// How many agents have `status`, not counting those being deleted.
    pub fn status_count(&self, status: AgentStatus) -> usize {
        self.shown_agents()
            .filter(|agent| agent.status == status)
            .count()
    }

    /// How many agents are running a turn right now, not counting those
    /// being deleted.
    pub fn working_count(&self) -> usize {
        self.status_count(AgentStatus::Working)
    }

    /// Whether something shows a spinner: a session is being started or a
    /// agent is working.
    pub fn spinning(&self) -> bool {
        self.starting || self.working_count() > 0
    }

    /// Whether any agent not being deleted has a turn underway.
    pub fn any_in_progress(&self) -> bool {
        self.shown_agents().any(|agent| agent.status.in_progress())
    }

    /// Every agent but those being deleted.
    fn shown_agents(&self) -> impl Iterator<Item = &Agent> {
        self.all_agents().filter(|agent| !self.is_deleting(agent))
    }

    /// Whether a search with text is filtering the sidebar.
    pub fn searching(&self) -> bool {
        self.search
            .as_ref()
            .is_some_and(|search| !search.input.text().trim().is_empty())
    }

    /// The rows the search steps through, in display order: the cards of
    /// the sessions that match, their agent rows and the settled rows;
    /// never a session shown only as the way to a match, a colonists row
    /// or the shelf header.
    fn matches(&self, layouts: &Layouts) -> Vec<SidebarItem> {
        self.sidebar(layouts)
            .iter()
            .filter(|row| match row {
                SidebarRow::Card { session, path, .. } => !path && self.hits(session, layouts),
                SidebarRow::Agent { .. } | SidebarRow::Settled { .. } => true,
                SidebarRow::ShelfHeader { .. } | SidebarRow::Colonists { .. } => false,
            })
            .map(SidebarRow::item)
            .collect()
    }

    /// What each sidebar row's cursor rests on, in display order.
    fn items(&self, layouts: &Layouts) -> Vec<SidebarItem> {
        self.sidebar(layouts).iter().map(SidebarRow::item).collect()
    }

    /// Where the cursor is in `items`, if it's on one of them; a cursor on
    /// a vanished agent row is on its session's card.
    fn position(&self, items: &[SidebarItem], layouts: &Layouts) -> Option<usize> {
        let cursor = self.cursor_row(layouts)?;
        items.iter().position(|&item| item == cursor)
    }

    /// The first row after `item`'s that `fits`, else the nearest one before
    /// it.
    fn neighbour<F>(&self, item: SidebarItem, layouts: &Layouts, fits: F) -> Option<SidebarItem>
    where
        F: Fn(&SidebarRow<'_>) -> bool,
    {
        let rows = self.sidebar(layouts);
        let at = rows
            .iter()
            .position(|row| row.item() == item)
            .unwrap_or(rows.len());
        let (before, after) = rows.split_at(at);
        after
            .iter()
            .skip(1)
            .find(|row| fits(row))
            .or_else(|| before.iter().rev().find(|row| fits(row)))
            .map(SidebarRow::item)
    }
}

/// How many of the rows at `indices`, walked in order, fit in half of
/// `layout`'s visible height; at least one. A row the layout doesn't know
/// counts as one line.
fn half_page<I>(layout: &SidebarLayout, indices: I) -> usize
where
    I: Iterator<Item = usize>,
{
    let half = usize::from(layout.rows / 2).max(1);
    indices
        .scan(0, |lines, at| {
            *lines += layout
                .heights
                .get(at)
                .map_or(1, |&height| usize::from(height));
            Some(*lines)
        })
        .take_while(|&lines| lines <= half)
        .count()
        .max(1)
}

/// The sessions `projects`' agents run in, one per pane session, as the
/// sessions actor would show them: each in its first agent's directory,
/// neither pinned nor settled, active since the agent's creation.
#[cfg(test)]
pub(crate) fn sessions_for(projects: &[Project]) -> Vec<Session> {
    let mut shown: Vec<Session> = Vec::new();
    for project in projects {
        for agent in &project.agents {
            let Some(id) = agent.session() else {
                continue;
            };
            if shown.iter().any(|session| session.id == id) {
                continue;
            }
            shown.push(Session {
                id,
                project: project.id,
                kind: match project.kind {
                    ProjectKind::Normal | ProjectKind::SharedWorld => SessionKind::Plain,
                    ProjectKind::Research | ProjectKind::Learn | ProjectKind::FreshWorld => {
                        SessionKind::Colony
                    }
                    ProjectKind::Incognito => SessionKind::Incognito,
                },
                dir: agent.cwd.clone(),
                name: None,
                branch: None,
                created_at: agent.created_at,
                pinned_at: None,
                settled_at: None,
                parent: None,
                active_since: agent.created_at,
                last_activity_at: agent.last_activity_at,
            });
        }
    }
    shown
}

/// Layouts holding every pane `projects`' agents run in: one tab per pane,
/// in its agent's session.
#[cfg(test)]
pub(crate) fn layouts_for(projects: &[Project]) -> Layouts {
    use crate::feat::layout::state::{SessionLayout, test_entry};
    let mut layouts = Layouts::default();
    for launch in projects
        .iter()
        .flat_map(|project| &project.agents)
        .filter_map(|agent| agent.pane.as_ref())
    {
        let entry = test_entry(launch.pane.0);
        match layouts.get(launch.session) {
            Some(_) => layouts.new_tab(launch.session, entry),
            None => layouts.insert(launch.session, SessionLayout::of(entry)),
        }
    }
    layouts
}

#[cfg(test)]
mod tests;
