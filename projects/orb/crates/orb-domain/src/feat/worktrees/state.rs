//! orb's worktrees as last read, and the rule that decides which ones a sweep
//! removes.

use std::cmp::Reverse;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::AppState;
use crate::feat::git::git_service::WorktreeFacts;
use crate::feat::sessions::state::{Agent, Project, Session};
use crate::ids::SessionId;

/// How long after the newest settle a worktree is pruned.
pub const PRUNE_AFTER: Duration = Duration::from_hours(3 * 24);

/// Every worktree under `~/.orb/worktrees/<repo>/`, as the worktrees actor
/// last read them.
#[derive(Debug, Clone, Default)]
pub struct Worktrees {
    /// Sorted by path.
    pub list: Vec<Worktree>,
}

/// One directory under `~/.orb/worktrees/<repo>/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    pub path: PathBuf,
    /// The main repository; `None` when the directory isn't a linked worktree
    /// or git can't tell.
    pub repo: Option<PathBuf>,
    /// `None` until read, or when git can't read them.
    pub facts: Option<WorktreeFacts>,
    /// Kilobytes on disk; `None` until `du` lands.
    pub size_kb: Option<u64>,
}

/// Something in orb that runs in a worktree.
#[derive(Debug, Clone)]
pub enum User<'a> {
    /// A session whose directory it is, with its agents.
    Session(&'a Project, &'a Session, Vec<&'a Agent>),
}

/// What the next sweep does with a worktree, and why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Kept: a session in it is attached.
    Attached,
    /// Kept: an agent in it is mid-turn.
    MidTurn,
    /// Kept: a session in it isn't settled.
    Active,
    /// Kept: git's facts aren't known yet, or can't be read.
    Unknown,
    /// Kept: it has uncommitted or untracked changes.
    Dirty,
    /// Removed at the next sweep.
    PruneNow,
    /// Removed once this much more time has passed.
    PruneIn(Duration),
}

/// How the worktree picker groups a row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowState {
    /// Something in it is in use.
    Active,
    /// It has users, all settled.
    Settled,
    /// Nothing in orb uses it.
    Orphan,
}

/// Everything in orb that uses the worktree at `path`: sessions whose
/// directory it is (with their agents). Sessions
/// of removed projects count, since their panes still run; sessions being
/// deleted don't. Paths match exactly as stored.
#[must_use]
pub fn users<'a>(app: &'a AppState, path: &Path) -> Vec<User<'a>> {
    let sessions = &app.sessions;
    sessions
        .sessions
        .iter()
        .filter(|session| session.dir == path && !sessions.deleting.contains(&session.id))
        .filter_map(|session| {
            let project = sessions.project(session.project)?;
            Some(User::Session(project, session, sessions.agents(session.id)))
        })
        .collect()
}

/// What the sweep does with a worktree that has these `users` and `facts`,
/// checked in order: kept while a session in it is attached or an agent in
/// it is mid-turn, a session in it isn't settled, its
/// facts are unknown or it has changes; otherwise pruned now with no users,
/// or [`PRUNE_AFTER`] after the newest settle.
#[must_use]
pub fn verdict(
    users: &[User<'_>],
    facts: Option<&WorktreeFacts>,
    attached: &HashSet<SessionId>,
    now: SystemTime,
) -> Verdict {
    let sessions = || {
        users.iter().map(|user| match user {
            User::Session(_, session, agents) => (*session, agents),
        })
    };
    if sessions().any(|(session, _)| attached.contains(&session.id)) {
        return Verdict::Attached;
    }
    if sessions().any(|(_, agents)| agents.iter().any(|agent| agent.status.in_progress())) {
        return Verdict::MidTurn;
    }
    let settles: Vec<Option<SystemTime>> =
        sessions().map(|(session, _)| session.settled_at).collect();
    if settles.iter().any(Option::is_none) {
        return Verdict::Active;
    }
    let Some(facts) = facts else {
        return Verdict::Unknown;
    };
    if facts.changes > 0 {
        return Verdict::Dirty;
    }
    // No users leaves no settle time.
    let Some(newest) = settles.into_iter().flatten().max() else {
        return Verdict::PruneNow;
    };
    let elapsed = now.duration_since(newest).unwrap_or_default();
    match PRUNE_AFTER.saturating_sub(elapsed) {
        Duration::ZERO => Verdict::PruneNow,
        left => Verdict::PruneIn(left),
    }
}

/// How the picker groups a worktree with these `users` and `verdict`.
#[must_use]
pub fn row_state(users: &[User<'_>], verdict: Verdict) -> RowState {
    match verdict {
        Verdict::Attached | Verdict::MidTurn | Verdict::Active => RowState::Active,
        _ if users.is_empty() => RowState::Orphan,
        _ => RowState::Settled,
    }
}

/// When the worktree was last used: the newest chat among its sessions'
/// agents (a session without agents counts from its last activity), or with
/// no users, its last commit. `None` reads as
/// never.
#[must_use]
pub fn last_used(users: &[User<'_>], facts: Option<&WorktreeFacts>) -> Option<SystemTime> {
    match users {
        [] => facts
            .and_then(|facts| facts.last_commit.as_ref())
            .map(|(time, _)| *time),
        users => users
            .iter()
            .map(|user| match user {
                User::Session(_, session, agents) => agents
                    .iter()
                    .map(|agent| agent.last_chat())
                    .max()
                    .unwrap_or(session.last_activity_at),
            })
            .max(),
    }
}

/// orb's worktrees as the picker lists them: active ones first, worktrees
/// with no users last, newest use first within each, then by path.
#[must_use]
pub fn order(app: &AppState) -> Vec<&Worktree> {
    let mut list: Vec<&Worktree> = app.worktrees.list.iter().collect();
    list.sort_by_cached_key(|worktree| {
        let users = users(app, &worktree.path);
        let facts = worktree.facts.as_ref();
        // Whether a row is active never depends on the clock.
        let active = row_state(&users, verdict(&users, facts, &app.attached, UNIX_EPOCH))
            == RowState::Active;
        let used = last_used(&users, facts);
        (
            !active,
            users.is_empty(),
            Reverse(used),
            worktree.path.clone(),
        )
    });
    list
}

#[cfg(test)]
mod tests {
    use crate::feat::harness::HarnessId;
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use super::{RowState, User, Verdict, Worktree, Worktrees, order, row_state, users, verdict};
    use crate::AppState;
    use crate::feat::git::git_service::WorktreeFacts;
    use crate::feat::sessions::state::{
        Agent, AgentStatus, PaneLaunch, Project, ProjectKind, Sessions, sessions_for,
    };
    use crate::ids::{AgentId, PaneId, ProjectId, SessionId};

    const WT: &str = "/w/orb/orb-1";

    fn days(n: u64) -> Duration {
        Duration::from_hours(24 * n)
    }

    /// A fixed clock, far enough from the epoch that day counts are exact.
    fn now() -> SystemTime {
        UNIX_EPOCH + days(100)
    }

    /// An idle, unsettled agent outside any group, running in `cwd`.
    fn agent(id: i64, cwd: &str) -> Agent {
        Agent {
            last_session: None,
            harness: HarnessId::new("claude"),
            id: AgentId(id),
            title: None,
            cwd: PathBuf::from(cwd),
            transcript: None,
            status: AgentStatus::Idle,
            turn_started_at: None,
            pane: Some(PaneLaunch {
                pane: PaneId(id),
                session: SessionId(id),
            }),
            branch: None,
            created_at: UNIX_EPOCH,
            last_activity_at: UNIX_EPOCH,
            unseen: false,
            model: None,
        }
    }

    /// `app` with each session `(id, ago)` settled `ago` days before `now`.
    fn settle(mut app: AppState, settles: &[(i64, u64)]) -> AppState {
        for &(id, ago) in settles {
            app.sessions
                .sessions
                .iter_mut()
                .filter(|session| session.id == SessionId(id))
                .for_each(|session| session.settled_at = Some(now() - days(ago)));
        }
        app
    }

    /// `agent`, last chatted in `secs` seconds after the epoch.
    fn chatted(agent: Agent, secs: u64) -> Agent {
        Agent {
            last_activity_at: UNIX_EPOCH + Duration::from_secs(secs),
            ..agent
        }
    }

    fn project(agents: Vec<Agent>) -> Project {
        Project {
            id: ProjectId(1),
            title: "orb".to_owned(),
            root: PathBuf::from("/code/orb"),
            created_at: UNIX_EPOCH,
            agents,
            repo: true,
            removed: false,
            kind: ProjectKind::Normal,
        }
    }

    /// `projects`, each agent's session in its directory.
    fn app(projects: Vec<Project>) -> AppState {
        AppState {
            sessions: Sessions {
                sessions: sessions_for(&projects),
                projects,
                ..Sessions::default()
            },
            ..AppState::default()
        }
    }

    fn facts(changes: usize) -> WorktreeFacts {
        WorktreeFacts {
            branch: Some("orb/1".to_owned()),
            changes,
            last_commit: None,
        }
    }

    /// The verdict on `WT` in `app`, at `now`.
    fn verdict_at(app: &AppState, facts: Option<&WorktreeFacts>) -> Verdict {
        verdict(&users(app, Path::new(WT)), facts, &app.attached, now())
    }

    #[rstest::rstest]
    fn verdict_of_an_orphan_is_prune_now() {
        // Given a worktree nothing uses.
        let app = app(vec![project(vec![])]);

        // When judging it with clean facts.
        let verdict = verdict_at(&app, Some(&facts(0)));

        // Then it prunes now.
        assert_eq!(verdict, Verdict::PruneNow, "an orphan should prune now");
    }

    #[rstest::rstest]
    fn worktree_whose_sessions_settled_four_days_ago_is_prunable() {
        // Given an agent in the worktree settled four days ago.
        let app = settle(app(vec![project(vec![agent(1, WT)])]), &[(1, 4)]);

        // When judging it with clean facts.
        let verdict = verdict_at(&app, Some(&facts(0)));

        // Then it prunes now.
        assert_eq!(
            verdict,
            Verdict::PruneNow,
            "4 settled days is past the limit"
        );
    }

    #[rstest::rstest]
    fn verdict_after_two_settled_days_is_prune_in_one_day() {
        // Given an agent in the worktree settled two days ago.
        let app = settle(app(vec![project(vec![agent(1, WT)])]), &[(1, 2)]);

        // When judging it with clean facts.
        let verdict = verdict_at(&app, Some(&facts(0)));

        // Then it prunes in a day.
        assert_eq!(
            verdict,
            Verdict::PruneIn(days(1)),
            "2 settled days leaves one"
        );
    }

    #[rstest::rstest]
    fn verdict_of_two_users_counts_from_the_newest_settle() {
        // Given two agents in the worktree, settled ten and two days ago.
        let app = settle(
            app(vec![project(vec![agent(1, WT), agent(2, WT)])]),
            &[(1, 10), (2, 2)],
        );

        // When judging it with clean facts.
        let verdict = verdict_at(&app, Some(&facts(0)));

        // Then the countdown runs from the newer settle.
        assert_eq!(
            verdict,
            Verdict::PruneIn(days(1)),
            "the newest settle should set the countdown"
        );
    }

    #[rstest::rstest]
    fn worktree_of_an_unsettled_session_is_kept() {
        // Given an unsettled, idle agent in the worktree.
        let app = app(vec![project(vec![agent(1, WT)])]);

        // When judging it with clean facts.
        let verdict = verdict_at(&app, Some(&facts(0)));

        // Then it's kept as active.
        assert_eq!(verdict, Verdict::Active, "an unsettled agent keeps it");
    }

    #[rstest::rstest]
    fn worktree_of_an_attached_session_is_kept() {
        // Given an agent settled eight days ago that is attached.
        let app = AppState {
            attached: HashSet::from([SessionId(1)]),
            ..settle(app(vec![project(vec![agent(1, WT)])]), &[(1, 8)])
        };

        // When judging it with clean facts.
        let verdict = verdict_at(&app, Some(&facts(0)));

        // Then it's kept as attached.
        assert_eq!(verdict, Verdict::Attached, "an attached agent keeps it");
    }

    #[rstest::rstest]
    fn verdict_with_a_mid_turn_agent_is_mid_turn() {
        // Given an agent in the worktree running a turn.
        let working = Agent {
            status: AgentStatus::Working,
            ..agent(1, WT)
        };
        let app = app(vec![project(vec![working])]);

        // When judging it with clean facts.
        let verdict = verdict_at(&app, Some(&facts(0)));

        // Then it's kept as mid-turn.
        assert_eq!(verdict, Verdict::MidTurn, "a turn underway keeps it");
    }

    #[rstest::rstest]
    fn verdict_with_changes_is_dirty() {
        // Given an agent settled eight days ago.
        let app = settle(app(vec![project(vec![agent(1, WT)])]), &[(1, 8)]);

        // When judging it with three uncommitted files.
        let verdict = verdict_at(&app, Some(&facts(3)));

        // Then it's kept as dirty.
        assert_eq!(verdict, Verdict::Dirty, "uncommitted changes keep it");
    }

    #[rstest::rstest]
    fn verdict_without_facts_is_unknown() {
        // Given an agent settled eight days ago.
        let app = settle(app(vec![project(vec![agent(1, WT)])]), &[(1, 8)]);

        // When judging it before its facts are read.
        let verdict = verdict_at(&app, None);

        // Then it's unknown.
        assert_eq!(verdict, Verdict::Unknown, "unread facts should be unknown");
    }

    #[rstest::rstest]
    fn users_list_a_session_once_with_its_agents() {
        // Given agents 1 and 2 both running in session 1 in the worktree.
        let second = Agent {
            pane: Some(PaneLaunch {
                pane: PaneId(2),
                session: SessionId(1),
            }),
            ..agent(2, WT)
        };
        let app = app(vec![project(vec![agent(1, WT), second])]);

        // When listing the worktree's users.
        let users = users(&app, Path::new(WT));

        // Then session 1 is the one user, holding both agents.
        assert!(
            matches!(users.as_slice(), [User::Session(_, session, agents)]
                if session.id == SessionId(1) && agents.len() == 2),
            "expected session 1 with two agents, got {users:?}"
        );
    }

    #[rstest::rstest]
    fn order_puts_newest_use_first_and_orphans_last() {
        // Given an orphan with a recent commit, and two worktrees whose
        // agents last chatted at 10 s and 20 s.
        let worktree = |path: &str, last_commit: Option<u64>| Worktree {
            path: PathBuf::from(path),
            repo: None,
            facts: Some(WorktreeFacts {
                last_commit: last_commit
                    .map(|secs| (UNIX_EPOCH + Duration::from_secs(secs), "commit".to_owned())),
                ..facts(0)
            }),
            size_kb: None,
        };
        let app = AppState {
            worktrees: Worktrees {
                list: vec![
                    worktree("/w/orb/orb-a", Some(1_000)),
                    worktree("/w/orb/orb-b", None),
                    worktree("/w/orb/orb-c", None),
                ],
            },
            ..app(vec![project(vec![
                chatted(agent(1, "/w/orb/orb-b"), 10),
                chatted(agent(2, "/w/orb/orb-c"), 20),
            ])])
        };

        // When ordering the worktrees.
        let paths: Vec<&Path> = order(&app).iter().map(|w| w.path.as_path()).collect();

        // Then the newest use leads and the orphan trails.
        assert_eq!(
            paths,
            [
                Path::new("/w/orb/orb-c"),
                Path::new("/w/orb/orb-b"),
                Path::new("/w/orb/orb-a"),
            ],
            "newest use first, orphans last"
        );
    }

    #[rstest::rstest]
    fn order_puts_active_worktrees_before_newer_settled_ones() {
        // Given a settled worktree last chatted at 20 s and an active one last
        // chatted at 10 s.
        let worktree = |path: &str| Worktree {
            path: PathBuf::from(path),
            repo: None,
            facts: Some(facts(0)),
            size_kb: None,
        };
        let app = AppState {
            worktrees: Worktrees {
                list: vec![worktree("/w/orb/orb-a"), worktree("/w/orb/orb-b")],
            },
            ..settle(
                app(vec![project(vec![
                    chatted(agent(1, "/w/orb/orb-a"), 20),
                    chatted(agent(2, "/w/orb/orb-b"), 10),
                ])]),
                &[(1, 1)],
            )
        };

        // When ordering the worktrees.
        let paths: Vec<&Path> = order(&app).iter().map(|w| w.path.as_path()).collect();

        // Then the active one leads despite its older use.
        assert_eq!(
            paths,
            [Path::new("/w/orb/orb-b"), Path::new("/w/orb/orb-a")],
            "active first, then newest use"
        );
    }

    #[rstest::rstest]
    #[case(true, Verdict::Active, RowState::Active)]
    #[case(true, Verdict::PruneIn(days(1)), RowState::Settled)]
    #[case(false, Verdict::PruneNow, RowState::Orphan)]
    fn row_state_follows_users_and_verdict(
        #[case] used: bool,
        #[case] verdict: Verdict,
        #[case] expected: RowState,
    ) {
        // Given a worktree with or without a settled agent in it.
        let agents = if used { vec![agent(1, WT)] } else { vec![] };
        let app = settle(app(vec![project(agents)]), &[(1, 6)]);

        // When working out its row state.
        let state = row_state(&users(&app, Path::new(WT)), verdict);

        // Then it matches the case.
        assert_eq!(state, expected, "row state for {verdict:?}");
    }

    #[rstest::rstest]
    fn users_include_sessions_of_removed_projects() {
        // Given a removed project with a session in the worktree.
        let app = app(vec![Project {
            removed: true,
            ..project(vec![agent(1, WT)])
        }]);

        // When listing the worktree's users.
        let users = users(&app, Path::new(WT));

        // Then the session is one of them.
        assert!(
            matches!(users.as_slice(), [User::Session(_, session, _)] if session.id == SessionId(1)),
            "a removed project's session should count, got {users:?}"
        );
    }
}
