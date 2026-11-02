//! The sessions actor — the owner of orb's agents, their statuses, and titles.
//!
//! At start it restores the saved agents into the shared state. Then it polls
//! the harnesses: every second while a turn is underway in any agent pane,
//! every five seconds otherwise, and right away when asked. Each poll reads
//! what each agent is doing from its pane: Stopped when the
//! pane's zmx session isn't running, else the latest report a harness like pi
//! wrote to the pane file, or the status of the Claude whose process runs
//! under the pane (by process ancestry from the pane's zmx process). An agent
//! with no pane is Stopped. Then it stamps when a turn starts, reads
//! new transcript lines for titles and branches, and saves what changed.
//! Asking the harnesses and zmx happens beside the actor's queue, between
//! the poll's start and the actor showing what it saw, so other requests
//! are handled meanwhile.
//!
//! It makes new sessions: a session row with one tab running a shell, in a
//! project's checkout, a worktree it already has, a new worktree made from a
//! base branch, or orb's Incognito folder (made first when missing). The new
//! session is selected and reported ready to open. A failure shows
//! the reason and removes the worktree and branch orb made for it. A session
//! an agent asks for is neither selected nor opened, and the agent is told
//! the new session and its pane, or why not, instead of the user. It also
//! adds shell panes where an agent asks without moving the keys. A new
//! worktree (for a new session, a move, or a restore) is made beside the
//! actor's queue, so the actor keeps handling other requests meanwhile; its
//! result is checked again when it arrives. A worktree made for a new
//! session whose project was removed meanwhile, or for a move whose session
//! was deleted or had its first turn meanwhile, is removed with its branch.
//! Whether each project is a git repository is found at start, on add and
//! after Initialize Git.
//!
//! Before a session's first agent turn it can move the session to another
//! workspace: the project's checkout, a worktree that already exists, or a
//! new one made from a base branch. Every pane is killed, the agents in
//! them unbound, and the session and its panes point at the new directory;
//! it is reported ready to open again, and opening it starts a fresh shell
//! in each pane.
//! A worktree orb made for a move that failed is removed again, and an orb
//! worktree no session uses after a move is removed unless it has changes.
//! When a turn
//! ends in a worktree still on orb's `orb/<hex>` branch, and the harness or
//! the user has titled the agent, the branch is renamed after that title.
//!
//! When the frontend finds an agent's orb worktree gone as it attaches, the
//! actor recreates it at the same path, so the session resumes the conversation
//! there. It prunes git's record of the old worktree, then checks out the
//! branch the worktree was on: the session's, else one of its agents', else
//! orb's `orb/<hex>` for the directory.
//! When that branch is gone it makes it again from the project's default
//! branch, fetched first from origin. Then it reports the session ready to
//! open, or shows git's reason.
//!
//! It checks branches out in a session's directory, unless a turn is
//! underway there. Before the first agent turn, picking the default branch
//! from a worktree checks it out in the project's checkout and moves the
//! session there. It makes a project a git repository when asked.
//!
//! At start it shows every harness by its name and mark.
//!
//! An agent whose harness orb doesn't know shows as Gone.
//!
//! A turn that ends while the keys aren't in its agent's pane shows as unseen
//! until the keys enter that pane. A session being deleted is hidden from the sidebar
//! until it is removed.
//!
//! It follows each session's settle lifecycle on its store row: a turn ending
//! in any of its agent panes is its latest activity, and a turn underway
//! un-settles it. Sessions settle only when the user settles them. Settling a
//! session kills every pane's program and keeps its layout and resume
//! commands. Whenever it kills a session's panes, the session leaves the
//! right side first.
//!
//! It makes colonies: in a shared world, in the world's own folder; in a
//! fresh world, in a new folder under it copied from the world's kit (orb
//! writes Research's and Learn's kits from their built-in defaults when
//! missing), never overwriting a folder that already exists. A fresh
//! colony's folder is copied, and a deleted fresh colony's folder removed,
//! beside the actor's queue, so other requests are handled meanwhile; a
//! copy whose world was removed meanwhile is removed again.
//!
//! It adds projects and removes them: a removed project leaves `<C-g> n` and the
//! project filter, its sessions stay, and adding it again
//! restores it.
//!
//! It restores the sidebar's saved width and project filter at start, and
//! saves them when asked. It does the same for the jump list, dropping saved
//! rows that no longer exist.
//!
//! It reports a notice for the frontend to announce when an agent it has
//! polled since orb started finishes a turn, or starts needing an approval or
//! an answer, in any project, unless the agent is being deleted.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use error_stack::{AttachmentKind, FrameKind, Report};
use kameo::mailbox;
use kameo::prelude::{
    Actor, ActorRef, Context, DelegatedReply, Message, Reply, ReplySender, Spawn,
};
use tokio::sync::Notify;

use super::pane_status::{PaneReport, match_records, pane_status};
use super::state::{
    Agent, AgentStatus, FolderKind, NEW_AGENT, Notice, NoticeKind, PaneLaunch, Project,
    ProjectKind, Session, SessionKind, Sessions, SidebarItem, WorldDirs, world_dirs,
};
use super::store::{
    AgentRow, FloatRow, NewPaneAgent, PaneRow, SessionFloats, SessionRow, SettledOverride, Store,
    StoreError, TabRow, Ui,
};
use super::template;
use crate::command::{SessionsCommand, Workspace};
use crate::common::{Log, Outcome, Reporter, Services, State};
use crate::feat::git::git_service::{GitError, GitRef, GitService, git_reason};
use crate::feat::git::validator::BUSY_DIRECTORY;
use crate::feat::git::worktree::{hex, hex_branch, is_orb_worktree, new_worktree_path, slug};
use crate::feat::harness::{
    Harness, HarnessError, HarnessId, RunningAgent, Scan, TranscriptFormat, unreadable_transcript,
};
use crate::feat::integration::pane_file::{AgentEvent, AgentReport, PaneFiles};
use crate::feat::integration::{NUDGE, panes_dir};
use crate::feat::jumps::state::JumpList;
use crate::feat::layout::floats::{Float, FloatLayout, Floats};
use crate::feat::layout::state::{Layouts, PaneEntry, SessionLayout, Tab};
use crate::feat::layout::tree::{Split, TileLayout};
use crate::feat::sidebar::state::{DEFAULT_WIDTH, clamp_width};
use crate::feat::zmx::zmx_service::{ZmxEntry, ZmxService, ZmxSession};
use crate::ids::{AgentId, PaneId, ProjectId, SessionId};
use crate::{AppState, Focus};

mod panes;
mod poll;
mod projects;
mod restore;
mod settle;
mod start;

use self::poll::{agent_mut, display_title, show};
use self::projects::{KitCopy, own_folder};
use self::restore::{pane_entry, pane_home, pane_launch, session_entries, unpolled};
use self::start::{answer_name_box, current_branch, rename_hex_branch};

/// How long to wait between polls while a turn is underway in any agent pane.
const FAST_POLL: Duration = Duration::from_secs(1);
/// How long to wait between polls otherwise.
const SLOW_POLL: Duration = Duration::from_secs(5);
/// The error shown when orb's store can't be written.
const SAVE_FAILED: &str = "couldn't save orb's state";
/// The error shown when a session's folder or the Incognito folder can't be
/// made.
const FOLDER_UNMADE: &str = "couldn't make the folder";
/// The error shown when a deleted session's folder can't be removed.
const FOLDER_UNREMOVED: &str = "couldn't remove the folder";
/// The error shown when a started session can't be saved or shown.
const NEW_SESSION_UNSAVED: &str = "couldn't save the new session";
/// How many random worktree names to try before giving up.
const WORKTREE_NAME_ATTEMPTS: u32 = 8;

/// What the sessions actor needs to start.
pub struct SessionsActorDeps {
    pub services: Services,
    pub state: State,
    pub store: Store,
    /// Where orb makes new worktrees.
    pub worktrees_root: PathBuf,
    /// orb's own folder (`~/.orb`): the Research/Learn roots and templates.
    pub orb_root: PathBuf,
    /// orb's Incognito project's root (`/tmp/orb-incognito`), made at start
    /// and before each Incognito start.
    pub incognito_root: PathBuf,
    /// Tells the frontend loop what changed, what failed and which session
    /// is ready to open.
    pub report: Reporter,
    /// Neither orb's Claude hook nor its pi extension is installed; the mode
    /// line says how to install them.
    pub integration_missing: bool,
}

/// Owns [`Sessions`](super::state::Sessions) and the harnesses the frontend
/// shows (`AppState::harnesses`): the projects, the
/// sessions with their names, pins and settles, the agents' statuses and
/// titles, and the origin ref a start is fetching; it reports errors,
/// notices and the session a start made ready to the frontend loop. It adds
/// orb's Incognito, Research and Learn projects at start. It also restores the sidebar's width
/// and project filter, and selects a new session. It loads every session's
/// layout at start, adds the panes splits and new tabs make (it saves their
/// store rows, so it gives them their ids), lays out a new session, drops a
/// deleted
/// session's layout, and saves a layout when asked. The intent handler also
/// moves the cursor, opens and closes the shelf, marks a start as starting,
/// and resizes or
/// filters the sidebar before asking for that to be saved. It binds agents
/// to panes from the agents' pane files, keeps each pane's latest report and
/// resume command current, and owns each session's name, pin, settle and
/// activity state on its store row.
pub struct SessionsActor {
    services: Services,
    state: State,
    store: Store,
    worktrees_root: PathBuf,
    orb_root: PathBuf,
    report: Reporter,
    /// Cuts the ticker's wait short so it polls now.
    poke: Arc<Notify>,
    /// The saved agents, as last written to the store.
    rows: Vec<AgentRow>,
    /// Each saved session: its directory, where its new panes start, and
    /// its settle lifecycle.
    sessions: HashMap<SessionId, SessionRow>,
    /// What couldn't be read of each session's saved layout at start, kept
    /// through every save.
    unread: HashMap<SessionId, Unread>,
    /// The agents' reports of what runs in each pane.
    pane_files: PaneFiles,
    /// Each pane's latest agent report.
    pane_reports: HashMap<PaneId, PaneReport>,
}

/// Start a poll: apply the agents' pane reports and say what to ask.
#[derive(Debug)]
pub struct PollPlan;

/// What a poll must ask outside the actor. Reply to [`PollPlan`].
#[derive(Reply)]
pub struct Probe {
    /// The harnesses a known pane holds an agent of.
    asked: Vec<Arc<dyn Harness>>,
    /// The rest: listed as running nothing.
    skipped: Vec<HarnessId>,
    /// Every socket dir a bound pane runs on.
    dirs: Vec<PathBuf>,
    zmx: ZmxService,
    log: Log,
}

/// What the poll saw; the actor applies it. Reply: [`NextPoll`].
#[derive(Debug)]
pub struct PollSeen {
    listed: HashMap<HarnessId, Vec<RunningAgent>>,
    /// The last harness that couldn't be asked.
    failure: Option<Report<HarnessError>>,
    /// Each probed socket dir's sessions, `None` when zmx couldn't list it.
    dirs: HashMap<PathBuf, Option<Vec<ZmxEntry>>>,
}

/// Kill the panes zmx still runs for sessions that are already settled.
#[derive(Debug)]
pub struct KillSettled;

/// How long to wait before the next [`PollPlan`].
#[derive(Debug, Reply)]
pub struct NextPoll(pub Duration);

/// An agent's request for a new shell pane in `session` that leaves the keys
/// alone. Only ever `ask`ed: an `Err` reply to a `tell` would stop the actor.
#[derive(Debug)]
pub struct ApiAdd {
    pub session: SessionId,
    pub place: ApiPlace,
}

/// Where an [`ApiAdd`] puts its shell.
#[derive(Debug, Clone, Copy)]
pub enum ApiPlace {
    /// Splitting pane `at`, or its whole stack, in whichever tab holds it.
    Split { at: PaneId, split: Split },
    /// Stacked right after pane `at`.
    Stack { at: PaneId },
    /// In a new tab that isn't shown.
    Tab,
    /// Under the top float, the floats left shown or hidden.
    Float,
}

/// An agent's request for a new session in project `project`'s checkout, in
/// `dir`, or in a new worktree from its default branch, named `name`. Never
/// selected or opened. Only ever `ask`ed.
#[derive(Debug)]
pub struct ApiStart {
    pub project: ProjectId,
    pub worktree: bool,
    pub name: Option<String>,
    /// The session whose pane asked, when it's a colony or a colonist: the
    /// new session becomes its colonist.
    pub parent: Option<SessionId>,
    /// The folder to start in instead of the project's checkout, never a
    /// new worktree: the caller's own folder in a fresh world.
    pub dir: Option<PathBuf>,
}

/// What an [`ApiStart`] answers: the new session and its first pane, or why
/// there is none.
pub type ApiStarted = Result<(SessionId, PaneId), ApiStartError>;

/// Why an agent's new session wasn't made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiStartError {
    /// Another session is starting.
    Starting,
    /// The start failed; the message box text.
    Failed(String),
}

impl std::fmt::Display for ApiStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Starting => f.write_str("a session is already starting"),
            Self::Failed(why) => f.write_str(why),
        }
    }
}

/// Who asked for a new session, which decides how its start ends.
#[derive(Debug)]
enum Asker {
    /// The user, while the given session was active: the new session is
    /// selected and opens while that one still is active.
    User(Option<SessionId>),
    /// An agent: the new session isn't selected or opened, and how the start
    /// ended goes back on the reply.
    Api(Option<ReplySender<ApiStarted>>),
}

impl Asker {
    /// Whether the new session is selected in the sidebar.
    fn selects(&self) -> bool {
        matches!(self, Self::User(_))
    }
}

/// A worktree orb made, on its new branch.
#[derive(Debug)]
struct MadeWorktree {
    repo: PathBuf,
    path: PathBuf,
    branch: String,
}

/// The error shown when a worktree job ends without an answer.
const WORKTREE_UNMADE: &str = "couldn't make the worktree";

/// Which start a worktree job belongs to, with what applying its result
/// needs. `if_active` is the session that was active when the user asked; a
/// restore's is the restored session itself. A new session's `asker` says
/// who asked for it.
#[derive(Debug)]
enum Start {
    New {
        project: ProjectId,
        kind: ProjectKind,
        name: Option<String>,
        parent: Option<SessionId>,
        asker: Asker,
    },
    Move {
        session: SessionId,
        moving: Moving,
        if_active: Option<SessionId>,
    },
    Restore {
        session: SessionId,
    },
}

/// The session a finished start made ready to open, and the session that
/// was active when the user asked for the start.
#[derive(Debug, Clone, Copy)]
struct Opens {
    session: SessionId,
    if_active: Option<SessionId>,
}

/// Where a session being moved is, from before its new worktree was made.
#[derive(Debug)]
struct Moving {
    root: PathBuf,
    old_dir: PathBuf,
    old_branch: Option<String>,
    name: Option<String>,
}

/// A worktree job made (or failed to make) the worktree a start asked for.
#[derive(Debug)]
pub struct WorktreeReady {
    start: Start,
    made: Result<MadeWorktree, String>,
}

/// A colony job copied (or failed to copy) a fresh colony's folder.
#[derive(Debug)]
pub struct ColonyFolderReady {
    world: ProjectId,
    if_active: Option<SessionId>,
    made: Result<PathBuf, String>,
}

/// The slow part of a fresh colony's start: copying its folder, run beside
/// the actor's queue.
struct ColonyJob {
    world: ProjectId,
    if_active: Option<SessionId>,
    copy: KitCopy,
}

/// A folder removed beside the actor's queue: a deleted fresh colony's, or
/// one copied for a colony that wasn't made.
struct RemoveFolder {
    dir: PathBuf,
    log: Log,
    report: Reporter,
}

/// The slow part of a start: the git work that makes its worktree, run
/// beside the actor's queue.
struct WorktreeJob {
    start: Start,
    work: Work,
}

/// The git work of a [`WorktreeJob`]. It writes only the actor's own
/// `fetching` label.
struct Work {
    services: Services,
    state: State,
    report: Reporter,
    worktrees_root: PathBuf,
    repo: PathBuf,
    make: Make,
}

/// What a [`Work`] makes.
enum Make {
    /// A new worktree from `base` (the project's default branch, read in the
    /// job, when `None`), on `orb/<slug of name>` when that branch is free.
    New {
        base: Option<String>,
        name: Option<String>,
    },
    /// A missing worktree at `cwd` again, on the first of `branches` that
    /// exists, else on the first made anew from the default branch.
    Again { cwd: PathBuf, branches: Vec<String> },
}

/// Spawns the sessions actor with a mailbox that never refuses a message.
/// Must be called inside a tokio runtime.
pub fn spawn_sessions_actor(deps: SessionsActorDeps) -> ActorRef<SessionsActor> {
    SessionsActor::spawn_with_mailbox(deps, mailbox::unbounded())
}

impl Actor for SessionsActor {
    type Args = SessionsActorDeps;
    type Error = kameo::error::Infallible;

    fn on_start(
        args: Self::Args,
        actor_ref: ActorRef<Self>,
    ) -> impl Future<Output = Result<Self, Self::Error>> + Send {
        let actor = Self::restore(args);
        {
            let actor_ref = actor_ref.clone();
            tokio::spawn(async move {
                let _ = actor_ref.tell(KillSettled).await;
            });
        }
        let poke = actor.poke.clone();
        tokio::spawn(async move {
            while let Ok(probe) = actor_ref.ask(PollPlan).await {
                let seen = probe.run().await;
                let Ok(NextPoll(next)) = actor_ref.ask(seen).await else {
                    break;
                };
                tokio::select! {
                    () = tokio::time::sleep(next) => {}
                    () = poke.notified() => {}
                }
            }
        });
        std::future::ready(Ok(actor))
    }
}

impl Message<SessionsCommand> for SessionsActor {
    type Reply = ();

    fn handle(
        &mut self,
        msg: SessionsCommand,
        ctx: &mut Context<Self, Self::Reply>,
    ) -> impl Future<Output = Self::Reply> + Send {
        match msg {
            SessionsCommand::SplitPane { session, split } => {
                self.add_pane(session, Placement::Split(split));
            }
            SessionsCommand::AddPane(session) => self.add_pane(session, Placement::Tile),
            SessionsCommand::AddFloat(session) => self.add_pane(session, Placement::Float),
            SessionsCommand::StackPane(session) => self.add_pane(session, Placement::Stack),
            SessionsCommand::NewTab(session) => self.add_pane(session, Placement::Tab),
            SessionsCommand::SaveLayout(session) => self.save_layout(session),
            SessionsCommand::NewSession {
                project,
                workspace,
                name,
                if_active,
            } => {
                if let Some(job) = self.new_session(project, workspace, name, if_active) {
                    job.spawn(ctx.actor_ref().clone());
                }
            }
            SessionsCommand::InitGit(id) => self.init_git(id),
            SessionsCommand::ChangeWorkspace {
                session,
                to,
                if_active,
            } => {
                if let Some(job) = self.change_workspace(session, to, if_active) {
                    job.spawn(ctx.actor_ref().clone());
                }
            }
            SessionsCommand::SwitchBranch {
                session,
                git_ref,
                to_root,
                if_active,
            } => self.switch_branch(session, &git_ref, to_root, if_active),
            SessionsCommand::AddProject(root) => self.add_project(root),
            SessionsCommand::AddWorld { root, kind } => self.add_world(root, kind),
            SessionsCommand::RefreshSessions => self.poke.notify_one(),
            SessionsCommand::PinSession(id) => self.pin_session(id),
            SessionsCommand::UnpinSession(id) => self.unpin_session(id),
            SessionsCommand::RenameSession { session, name } => self.rename_session(session, name),
            SessionsCommand::SettleSession {
                session,
                with_colonists: false,
            } => self.settle_session(session),
            SessionsCommand::SettleSession {
                session,
                with_colonists: true,
            } => self.settle_with_colonists(session),
            SessionsCommand::UnsettleSession(id) => self.unsettle_session(id),
            SessionsCommand::DeleteSession {
                session,
                with_colonists: false,
            } => {
                if let Some(removal) = self.delete_session(session) {
                    removal.spawn();
                }
            }
            SessionsCommand::DeleteSession {
                session,
                with_colonists: true,
            } => {
                for removal in self.delete_with_colonists(session) {
                    removal.spawn();
                }
            }
            SessionsCommand::Visit(pane) => self.visit(pane),
            SessionsCommand::SaveUi => self.save_ui(),
            SessionsCommand::SaveJumps => self.save_jumps(),
            SessionsCommand::RemoveProject(id) => self.remove_project(id),
            SessionsCommand::NewColony {
                world,
                name,
                if_active,
            } => {
                if let Some(job) = self.new_colony(world, &name, if_active) {
                    job.spawn(ctx.actor_ref().clone());
                }
            }
            SessionsCommand::RestoreWorktree(id) => {
                if let Some(job) = self.restore_worktree(id) {
                    job.spawn(ctx.actor_ref().clone());
                }
            }
        }
        std::future::ready(())
    }
}

impl Message<ApiAdd> for SessionsActor {
    type Reply = Result<PaneId, String>;

    fn handle(
        &mut self,
        msg: ApiAdd,
        _ctx: &mut Context<Self, Self::Reply>,
    ) -> impl Future<Output = Self::Reply> + Send {
        std::future::ready(self.add_pane_at(&msg))
    }
}

impl Message<ApiStart> for SessionsActor {
    type Reply = DelegatedReply<ApiStarted>;

    fn handle(
        &mut self,
        msg: ApiStart,
        ctx: &mut Context<Self, Self::Reply>,
    ) -> impl Future<Output = Self::Reply> + Send {
        let (delegated, reply) = ctx.reply_sender();
        if let Some(job) = self.api_start(msg, reply) {
            job.spawn(ctx.actor_ref().clone());
        }
        std::future::ready(delegated)
    }
}

impl Message<WorktreeReady> for SessionsActor {
    type Reply = ();

    fn handle(
        &mut self,
        msg: WorktreeReady,
        _ctx: &mut Context<Self, Self::Reply>,
    ) -> impl Future<Output = Self::Reply> + Send {
        self.worktree_ready(msg);
        std::future::ready(())
    }
}

impl Message<ColonyFolderReady> for SessionsActor {
    type Reply = ();

    fn handle(
        &mut self,
        msg: ColonyFolderReady,
        _ctx: &mut Context<Self, Self::Reply>,
    ) -> impl Future<Output = Self::Reply> + Send {
        if let Some(removal) = self.colony_folder_ready(msg) {
            removal.spawn();
        }
        std::future::ready(())
    }
}

impl Message<KillSettled> for SessionsActor {
    type Reply = ();

    async fn handle(
        &mut self,
        _msg: KillSettled,
        _ctx: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        self.kill_settled();
    }
}

impl Message<PollPlan> for SessionsActor {
    type Reply = Probe;

    fn handle(
        &mut self,
        _msg: PollPlan,
        _ctx: &mut Context<Self, Self::Reply>,
    ) -> impl Future<Output = Self::Reply> + Send {
        std::future::ready(self.poll_plan())
    }
}

impl Message<PollSeen> for SessionsActor {
    type Reply = NextPoll;

    fn handle(
        &mut self,
        msg: PollSeen,
        _ctx: &mut Context<Self, Self::Reply>,
    ) -> impl Future<Output = Self::Reply> + Send {
        std::future::ready(NextPoll(self.poll_seen(msg)))
    }
}

impl Probe {
    /// Asks the harnesses what their agents are doing, then zmx what runs in
    /// each socket dir, beside the actor's queue. A harness that can't be
    /// asked is left out of the listing; a dir zmx can't list is left
    /// unlisted.
    async fn run(self) -> PollSeen {
        let Self {
            asked,
            skipped,
            dirs,
            zmx,
            log,
        } = self;
        let mut listed: HashMap<HarnessId, Vec<RunningAgent>> =
            skipped.into_iter().map(|id| (id, Vec::new())).collect();
        let mut failure = None;
        for harness in asked {
            match harness.running().await {
                Ok(agents) => {
                    listed.insert(harness.id(), agents);
                }
                Err(report) => failure = Some(report),
            }
        }
        let dirs = {
            let job_log = log.clone();
            tokio::task::spawn_blocking(move || {
                dirs.into_iter()
                    .map(|dir| {
                        let found = zmx
                            .list(&dir)
                            .inspect_err(|report| {
                                job_log.error_on_change(
                                    &format!("poll: zmx list {}", dir.display()),
                                    "couldn't list zmx sessions",
                                    report,
                                );
                            })
                            .ok();
                        (dir, found)
                    })
                    .collect()
            })
            .await
            .unwrap_or_else(|error| {
                log.error("poll: zmx probe", &error);
                HashMap::new()
            })
        };
        PollSeen {
            listed,
            failure,
            dirs,
        }
    }
}

/// Where [`SessionsActor::add_pane`] puts the new shell.
#[derive(Debug, Clone, Copy)]
enum Placement {
    /// In the shown tab, re-tiled by pane count unless it was changed by hand.
    Tile,
    /// Splitting the shown tab's focused pane.
    Split(Split),
    /// Stacked with the shown tab's focused pane.
    Stack,
    /// In a new tab, or the first tab of a session without a layout.
    Tab,
    /// On top of the session's floats, which are shown.
    Float,
}

impl SessionsActor {
    /// Changes agent `id`'s saved row with `change` (given the time now),
    /// then saves and shows it. Does nothing if the agent is gone.
    fn edit<F>(&mut self, id: AgentId, change: F)
    where
        F: FnOnce(&mut AgentRow, i64),
    {
        let Some(row) = self.rows.iter_mut().find(|row| row.id == id) else {
            return;
        };
        change(row, now_ms());
        let saved = self.store.save_agent(row);
        {
            let mut guard = self.state.write();
            let app = &mut *guard;
            let sessions = &mut app.sessions;
            if let Some(agent) = agent_mut(sessions, id) {
                let status = agent.status;
                show(
                    agent,
                    row,
                    status,
                    pane_launch(row, &app.layouts, &self.unread),
                );
            }
        }
        self.report_saved(saved);
    }

    /// Changes session `id`'s saved row with `change` (given the time now),
    /// then saves and shows it. Does nothing if the session is gone.
    fn edit_session<F>(&mut self, id: SessionId, change: F)
    where
        F: FnOnce(&mut SessionRow, i64),
    {
        let Some(row) = self.sessions.get_mut(&id) else {
            return;
        };
        change(row, now_ms());
        let saved = self.store.save_session(row);
        {
            let mut app = self.state.write();
            let sessions = &mut app.sessions;
            if let Some(shown) = sessions.sessions.iter_mut().find(|shown| shown.id == id) {
                *shown = show_session(row);
            }
        }
        self.report_saved(saved);
    }

    /// Reports that a row was shown after `saved`: why the save failed, else
    /// that the state changed.
    fn report_saved(&self, saved: Result<(), Report<StoreError>>) {
        match saved {
            Ok(()) => self.report.changed(),
            Err(report) => {
                let error = save_failed(&self.services.log, &report);
                self.report.report(Outcome::Failed(error));
            }
        }
    }

    /// Shows a harness failure in the mode line.
    fn fail(&self, report: &Report<HarnessError>) {
        self.services
            .log
            .error_on_change("poll: harness", "harness poll failed", report);
        self.report.report(Outcome::Failed(reason(report)));
    }

    /// The directory project `id`'s sessions start in.
    fn project_root(&self, id: ProjectId) -> Option<PathBuf> {
        self.state
            .read()
            .sessions
            .projects
            .iter()
            .find(|project| project.id == id)
            .map(|project| project.root.clone())
    }

    /// What agent `id`'s session was doing at the last poll.
    fn status(&self, id: AgentId) -> Option<AgentStatus> {
        self.state
            .read()
            .sessions
            .all_agents()
            .find(|agent| agent.id == id)
            .map(|agent| agent.status)
    }
}

/// The saved tabs of a session whose tree didn't read, and where each of the
/// session's panes no read tab or float holds runs, with its name and resume
/// command. Each layout save of the session writes them back as they were,
/// so they are never deleted.
#[derive(Debug, Default)]
struct Unread {
    tabs: Vec<TabRow>,
    panes: Vec<PaneEntry>,
    /// Panes of a session whose tabs all read that no saved tab or float
    /// held. Their programs may still run, so settling, deleting or moving
    /// the session kills them, but a save doesn't keep their rows.
    loose: Vec<PaneEntry>,
}

/// Logs `error` behind the message `shown` and returns `shown` for the
/// message box.
fn failed<E>(log: &Log, shown: &str, error: &E) -> String
where
    E: std::fmt::Debug,
{
    log.error(shown, error);
    shown.to_owned()
}

/// [`failed`] with the store's fixed message.
fn save_failed<E>(log: &Log, error: &E) -> String
where
    E: std::fmt::Debug,
{
    failed(log, SAVE_FAILED, error)
}

/// Logs the git failure `report` behind `what` and returns git's reason for
/// the message box.
fn git_failed(log: &Log, what: &str, report: &Report<GitError>) -> String {
    log.error(what, report);
    git_reason(report)
}

/// `ids` sorted with repeats dropped, for a log line.
fn sorted_ids<I>(ids: I) -> Vec<i64>
where
    I: Iterator<Item = i64>,
{
    let mut ids: Vec<i64> = ids.collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// Removes `dir`, made for a session that then failed to start, logging why
/// if it can't. A folder that was never made is fine.
fn remove_unstarted(log: &Log, dir: &Path) {
    if let Err(error) = fs::remove_dir_all(dir)
        && error.kind() != io::ErrorKind::NotFound
    {
        log.error(
            &format!(
                "couldn't remove the folder {} after a failed start",
                dir.display()
            ),
            &error,
        );
    }
}

/// The one-line reason a harness failure carries.
fn reason(report: &Report<HarnessError>) -> String {
    report
        .downcast_ref::<String>()
        .cloned()
        .unwrap_or_else(|| "harness command failed".to_owned())
}

/// How a saved agent looks with `status`, its pane run as `pane`.
fn agent(row: &AgentRow, status: AgentStatus, pane: Option<PaneLaunch>) -> Agent {
    Agent {
        id: row.id,
        title: display_title(row),
        cwd: row.cwd.clone(),
        transcript: row.transcript_path.clone(),
        status,
        turn_started_at: row.turn_started_at.map(from_ms),
        pane,
        last_session: row.orb_session,
        branch: row.branch.clone(),
        created_at: from_ms(row.created_at),
        last_activity_at: from_ms(row.last_activity_at),
        unseen: row.last_activity_at > row.last_visited_at,
        model: row.model.clone(),
        harness: row.harness.clone(),
    }
}

/// The kind of session a project's new session gets: Incognito in
/// Incognito, plain elsewhere (colonies come only from the new-colony key).
fn session_kind(kind: ProjectKind) -> SessionKind {
    match kind {
        ProjectKind::Incognito => SessionKind::Incognito,
        ProjectKind::Normal
        | ProjectKind::SharedWorld
        | ProjectKind::FreshWorld
        | ProjectKind::Research
        | ProjectKind::Learn => SessionKind::Plain,
    }
}

/// How a saved session looks: settled only while settled by hand or by
/// idleness, active since the later of its creation and its latest
/// un-settle.
fn show_session(row: &SessionRow) -> Session {
    Session {
        id: row.id,
        project: row.project_id,
        kind: row.kind,
        parent: row.parent,
        dir: row.dir.clone(),
        name: row.name.clone(),
        branch: row.branch.clone(),
        created_at: from_ms(row.created_at),
        pinned_at: row.pinned_at.map(from_ms),
        settled_at: row
            .settled_at
            .filter(|_| row.settled_override == Some(SettledOverride::Settled))
            .map(from_ms),
        active_since: from_ms(row.created_at.max(row.unsettled_at.unwrap_or(0))),
        last_activity_at: from_ms(row.last_activity_at),
    }
}

/// Whether saved jump-list row `item` still names one of `sessions`, shown
/// or not.
fn exists(sessions: &HashMap<SessionId, SessionRow>, item: SidebarItem) -> bool {
    match item {
        SidebarItem::Session(id) => sessions.contains_key(&id),
        SidebarItem::SettledShelf | SidebarItem::Agent { .. } | SidebarItem::Colonists(_) => false,
    }
}

/// Milliseconds since the Unix epoch, now.
fn now_ms() -> i64 {
    to_ms(SystemTime::now())
}

/// Milliseconds since the Unix epoch at `time`; before the epoch clamps to 0.
pub(crate) fn to_ms(time: SystemTime) -> i64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

/// Milliseconds since the Unix epoch as a time; negative clamps to the epoch.
fn from_ms(ms: i64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_millis(u64::try_from(ms).unwrap_or(0))
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate setup failures with `?` and assert on the outcome"
)]
mod tests;
