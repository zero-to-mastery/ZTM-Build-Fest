//! Checks whether the open picker's keys can proceed: `⏎` picking a project
//! or adding a directory, `Tab` opening one, `d` removing a project in the
//! projects screen, `⏎` picking a session in the session or search picker,
//! `d` deleting a session in the session picker, and `d` deleting a
//! worktree.

use std::time::SystemTime;

use crate::feat::picker::list::PickerItem;

use wherror::Error;

use crate::feat::picker::state::PickerKind;
use crate::feat::sessions::state::{ProjectKind, SessionKind, SidebarItem};
use crate::feat::worktrees::state::{Verdict, users, verdict};
use crate::ids::SessionId;
use crate::{AppState, Focus};

/// Why `<C-g> ,` can't open the Colonists picker.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum OpenColonistsError {
    /// The keyed session isn't a colony.
    NotAColony,
}

/// The colony `<C-g> ,` opens on: the shown session in a pane, else the
/// sidebar's selected session (card, agent row or colonists row).
///
/// # Errors
///
/// Returns [`OpenColonistsError::NotAColony`] when it isn't a colony.
pub fn validate_open_colonists(state: &AppState) -> Result<SessionId, OpenColonistsError> {
    let session = match (state.focus, state.sessions.cursor) {
        (focus, Some(SidebarItem::Colonists(id))) if focus != Focus::Pane => {
            state.sessions.session(id)
        }
        _ => state.keyed_session(),
    };
    session
        .filter(|session| session.kind == SessionKind::Colony)
        .map(|session| session.id)
        .ok_or(OpenColonistsError::NotAColony)
}

/// Why picking a project can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum PickProjectError {
    /// No project picker is open.
    NoPicker,
    /// No project is highlighted.
    NoProject,
}

/// Allow picking the highlighted project for a new session, or the
/// highlighted world for a new colony.
///
/// # Errors
///
/// Returns [`PickProjectError::NoPicker`] unless the project picker, the
/// projects screen, the world picker or the worlds screen is open, and [`PickProjectError::NoProject`] when nothing
/// is highlighted.
pub fn validate_pick_project(state: &AppState) -> Result<(), PickProjectError> {
    match &state.picker {
        Some(picker)
            if matches!(
                picker.kind(),
                PickerKind::Projects
                    | PickerKind::ManageProjects
                    | PickerKind::Worlds
                    | PickerKind::ManageWorlds
            ) =>
        {
            match picker.selected() {
                None => Err(PickProjectError::NoProject),
                Some(_) => Ok(()),
            }
        }
        _ => Err(PickProjectError::NoPicker),
    }
}

/// Why opening a directory can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum OpenDirectoryError {
    /// No directory picker is open.
    NoPicker,
    /// No directory is highlighted.
    NoDirectory,
}

/// Allow browsing into the highlighted directory.
///
/// # Errors
///
/// Returns [`OpenDirectoryError::NoPicker`] unless the directory picker is
/// open, and [`OpenDirectoryError::NoDirectory`] when nothing is highlighted.
pub fn validate_open_directory(state: &AppState) -> Result<(), OpenDirectoryError> {
    match &state.picker {
        Some(picker) if matches!(picker.kind(), PickerKind::Directories { .. }) => {
            match picker.selected() {
                None => Err(OpenDirectoryError::NoDirectory),
                Some(_) => Ok(()),
            }
        }
        _ => Err(OpenDirectoryError::NoPicker),
    }
}

/// Why adding a directory as a project can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum AddDirectoryError {
    /// No directory picker is open.
    NoPicker,
    /// Nothing is highlighted, and the typed path doesn't end in `/`.
    NothingToAdd,
}

/// Allow adding the highlighted directory, or the typed one.
///
/// # Errors
///
/// Returns [`AddDirectoryError::NoPicker`] unless the directory picker is
/// open, and [`AddDirectoryError::NothingToAdd`] when it has no directory to
/// add.
pub fn validate_add_directory(state: &AppState) -> Result<(), AddDirectoryError> {
    match &state.picker {
        Some(picker) if matches!(picker.kind(), PickerKind::Directories { .. }) => {
            match picker.directory_to_add() {
                None => Err(AddDirectoryError::NothingToAdd),
                Some(_) => Ok(()),
            }
        }
        _ => Err(AddDirectoryError::NoPicker),
    }
}

/// Why removing a project can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum RemoveProjectError {
    /// No projects screen is open.
    NoPicker,
    /// The highlighted row isn't a project.
    NotAProject,
    /// Research or Learn, which orb adds back at every start.
    OrbsOwn,
}

/// Allow asking to remove the project highlighted in the projects screen,
/// or the world highlighted in the worlds screen.
///
/// # Errors
///
/// Returns [`RemoveProjectError::NoPicker`] unless the projects or worlds
/// screen is open, [`RemoveProjectError::OrbsOwn`] on Research or Learn, and
/// [`RemoveProjectError::NotAProject`] when nothing is highlighted.
pub fn validate_remove_project(state: &AppState) -> Result<(), RemoveProjectError> {
    match &state.picker {
        Some(picker)
            if matches!(
                picker.kind(),
                PickerKind::ManageProjects | PickerKind::ManageWorlds
            ) =>
        {
            match picker.selected() {
                Some(PickerItem::Project {
                    kind: ProjectKind::Research | ProjectKind::Learn,
                    ..
                }) => Err(RemoveProjectError::OrbsOwn),
                Some(PickerItem::Project { .. }) => Ok(()),
                _ => Err(RemoveProjectError::NotAProject),
            }
        }
        _ => Err(RemoveProjectError::NoPicker),
    }
}

/// Why picking a session in the session or search picker can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum PickSessionError {
    /// No session picker is open.
    NoPicker,
    /// No session or hit is highlighted.
    NoSelection,
    /// The session, or the hit's agent, was deleted or is being deleted
    /// since the picker opened.
    Deleted,
    /// The hit's agent never ran in a session.
    NoSession,
    /// The agent row's pane closed or no longer runs an agent since the
    /// picker opened.
    PaneGone,
}

/// Allow jumping to the session highlighted in the session picker, or the
/// session of the hit highlighted in the search picker.
///
/// # Errors
///
/// Returns [`PickSessionError::NoPicker`] unless the session or search
/// picker is open, [`PickSessionError::NoSelection`] when no session or hit
/// is highlighted, [`PickSessionError::NoSession`] when the hit's agent
/// never ran in a session, [`PickSessionError::Deleted`] when the
/// session or the hit's agent is gone or being deleted, and
/// [`PickSessionError::PaneGone`] when the agent row's pane no longer runs
/// one of its session's agents.
pub fn validate_pick_session(state: &AppState) -> Result<(), PickSessionError> {
    let picker = match &state.picker {
        Some(picker)
            if matches!(
                picker.kind(),
                PickerKind::Sessions { .. } | PickerKind::Search { .. }
            ) =>
        {
            picker
        }
        _ => return Err(PickSessionError::NoPicker),
    };
    let (session, pane) = match picker.selected() {
        Some(&PickerItem::Session { id, pane, .. }) => (id, Some(pane)),
        Some(&PickerItem::Hit { agent, .. }) => (
            state
                .sessions
                .all_agents()
                .find(|shown| shown.id == agent)
                .ok_or(PickSessionError::Deleted)?
                .home()
                .ok_or(PickSessionError::NoSession)?,
            None,
        ),
        _ => return Err(PickSessionError::NoSelection),
    };
    match state.sessions.session(session) {
        Some(_) if !state.sessions.deleting.contains(&session) => {}
        _ => return Err(PickSessionError::Deleted),
    }
    match pane {
        Some(pane) if !state.sessions.runs_agent(session, pane, &state.layouts) => {
            Err(PickSessionError::PaneGone)
        }
        _ => Ok(()),
    }
}

/// Why closing the session picker's highlighted agent can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum CloseListedAgentError {
    /// The session picker isn't open.
    NoPicker,
    /// No agent row is highlighted.
    NoAgent,
    /// The row's session is gone or being deleted, or its pane no longer
    /// runs an agent.
    Gone,
}

/// Allow `d` on the session picker's highlighted agent.
///
/// # Errors
///
/// Returns [`CloseListedAgentError::NoPicker`] unless the session picker is
/// open, [`CloseListedAgentError::NoAgent`] when no agent row is highlighted,
/// and [`CloseListedAgentError::Gone`] when the row's session is gone or
/// being deleted or its pane no longer runs an agent.
pub fn validate_close_listed_agent(state: &AppState) -> Result<(), CloseListedAgentError> {
    let picker = match &state.picker {
        Some(picker) if matches!(picker.kind(), PickerKind::Sessions { .. }) => picker,
        _ => return Err(CloseListedAgentError::NoPicker),
    };
    let Some((session, pane)) = picker.selected_agent() else {
        return Err(CloseListedAgentError::NoAgent);
    };
    match state.sessions.session(session) {
        Some(_) if state.sessions.runs_agent(session, pane, &state.layouts) => Ok(()),
        _ => Err(CloseListedAgentError::Gone),
    }
}

/// Why deleting a worktree can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum DeleteWorktreeError {
    /// No worktree picker is open.
    NoPicker,
    /// No worktree row is highlighted.
    NoSelection,
    /// A session in the worktree is attached.
    Attached,
    /// An agent in the worktree has a turn underway.
    MidTurn,
}

/// Allow asking to delete the worktree highlighted in the worktree picker.
///
/// # Errors
///
/// Returns [`DeleteWorktreeError::NoPicker`] unless the worktree picker is
/// open, [`DeleteWorktreeError::NoSelection`] when no row is highlighted,
/// [`DeleteWorktreeError::Attached`] when a session in it is attached, and
/// [`DeleteWorktreeError::MidTurn`] when an agent in it has a turn underway.
pub fn validate_delete_worktree(state: &AppState) -> Result<(), DeleteWorktreeError> {
    let path = match &state.picker {
        Some(picker) if *picker.kind() == PickerKind::Worktrees => picker
            .selected_worktree()
            .ok_or(DeleteWorktreeError::NoSelection)?,
        _ => return Err(DeleteWorktreeError::NoPicker),
    };
    let facts = state
        .worktrees
        .list
        .iter()
        .find(|worktree| worktree.path == path)
        .and_then(|worktree| worktree.facts.as_ref());
    // The time only moves the prune countdown, which never refuses.
    match verdict(
        &users(state, path),
        facts,
        &state.attached,
        SystemTime::UNIX_EPOCH,
    ) {
        Verdict::Attached => Err(DeleteWorktreeError::Attached),
        Verdict::MidTurn => Err(DeleteWorktreeError::MidTurn),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use crate::feat::harness::HarnessId;
    use std::path::{Path, PathBuf};

    use std::time::SystemTime;

    use super::{
        AddDirectoryError, CloseListedAgentError, DeleteWorktreeError, OpenDirectoryError,
        PickProjectError, PickSessionError, RemoveProjectError, validate_add_directory,
        validate_close_listed_agent, validate_delete_worktree, validate_open_directory,
        validate_pick_project, validate_pick_session, validate_remove_project,
    };
    use crate::feat::picker::list::PickerItem;
    use crate::feat::picker::state::PickerState;
    use crate::feat::sessions::state::{
        Agent, AgentStatus, PaneLaunch, Project, ProjectKind, Sessions, sessions_for,
    };
    use crate::ids::{AgentId, PaneId, ProjectId, SessionId};
    use crate::{AppState, Focus};

    const HOME: &str = "/home/me";

    fn alpha() -> PickerItem {
        PickerItem::Project {
            id: ProjectId(1),
            title: "alpha".into(),
            root: "/alpha".into(),
            kind: ProjectKind::Normal,
        }
    }

    /// The session picker over one row, session 1 running agent 1.
    fn picking_agent_1() -> PickerState {
        PickerState::sessions(
            vec![PickerItem::Session {
                id: SessionId(1),
                agent: AgentId(1),
                pane: PaneId(1),
                label: "work/New agent".into(),
                split: 5,
                settled: false,
            }],
            Focus::Sidebar,
        )
    }

    /// The directory picker at `~/`, which lists `names`.
    fn browsing(names: &[&str]) -> PickerState {
        let (mut picker, _) = PickerState::directories(PathBuf::from(HOME), Focus::Sidebar);
        let names = names.iter().map(|name| (*name).to_owned()).collect();
        picker.show_directories(Path::new(HOME), names);
        picker
    }

    #[rstest::rstest]
    fn pick_project_is_refused_without_a_project() {
        // Given an open project picker with no projects.
        let state = AppState {
            picker: Some(PickerState::projects(vec![], Focus::Sidebar)),
            ..AppState::default()
        };

        // When validating a pick.
        let result = validate_pick_project(&state);

        // Then validation fails with NoProject.
        assert_eq!(
            result,
            Err(PickProjectError::NoProject),
            "nothing highlighted can't be picked"
        );
    }

    #[rstest::rstest]
    fn pick_project_is_allowed_in_the_projects_screen() {
        // Given the projects screen with alpha highlighted.
        let state = AppState {
            picker: Some(PickerState::manage_projects(vec![alpha()], Focus::Sidebar)),
            ..AppState::default()
        };

        // When validating a pick.
        let result = validate_pick_project(&state);

        // Then it is allowed.
        assert_eq!(result, Ok(()), "the projects screen should pick a project");
    }

    #[rstest::rstest]
    fn pick_project_is_allowed_while_starting() {
        // Given alpha highlighted while a session start is in flight.
        let state = AppState {
            picker: Some(PickerState::projects(vec![alpha()], Focus::Sidebar)),
            sessions: Sessions {
                starting: true,
                ..Sessions::default()
            },
            ..AppState::default()
        };

        // When validating a pick.
        let result = validate_pick_project(&state);

        // Then it is allowed.
        assert_eq!(
            result,
            Ok(()),
            "a project can be picked while another session starts"
        );
    }

    #[rstest::rstest]
    fn open_directory_is_refused_without_a_directory() {
        // Given the directory picker at `~/`, which lists nothing.
        let state = AppState {
            picker: Some(browsing(&[])),
            ..AppState::default()
        };

        // When validating an open.
        let result = validate_open_directory(&state);

        // Then validation fails with NoDirectory.
        assert_eq!(
            result,
            Err(OpenDirectoryError::NoDirectory),
            "nothing highlighted can't be opened"
        );
    }

    #[rstest::rstest]
    fn add_directory_is_refused_when_the_filter_matches_nothing() {
        // Given the directory picker at `~/`, which lists `dev`, with `x`
        // typed, which matches nothing.
        let state = AppState {
            picker: Some({
                let mut picker = browsing(&["dev"]);
                picker.insert('x');
                picker
            }),
            ..AppState::default()
        };

        // When validating an add.
        let result = validate_add_directory(&state);

        // Then validation fails with NothingToAdd.
        assert_eq!(
            result,
            Err(AddDirectoryError::NothingToAdd),
            "an unmatched filter has nothing to add"
        );
    }

    #[rstest::rstest]
    fn remove_project_is_refused_with_no_project_highlighted() {
        // Given the projects screen with no rows.
        let state = AppState {
            picker: Some(PickerState::manage_projects(vec![], Focus::Sidebar)),
            ..AppState::default()
        };

        // When validating a removal.
        let result = validate_remove_project(&state);

        // Then validation fails with NotAProject.
        assert_eq!(
            result,
            Err(RemoveProjectError::NotAProject),
            "with nothing highlighted there is nothing to remove"
        );
    }

    #[rstest::rstest]
    fn remove_project_is_refused_in_the_project_filter() {
        // Given the project filter with alpha highlighted.
        let state = AppState {
            picker: Some(PickerState::project_filter(
                vec![PickerItem::AllProjects, alpha()],
                Some(ProjectId(1)),
                Focus::Sidebar,
            )),
            ..AppState::default()
        };

        // When validating a removal.
        let result = validate_remove_project(&state);

        // Then validation fails with NoPicker.
        assert_eq!(
            result,
            Err(RemoveProjectError::NoPicker),
            "only the projects screen removes projects"
        );
    }

    #[rstest::rstest]
    fn remove_project_is_allowed_on_a_project_row() {
        // Given the projects screen with alpha highlighted.
        let state = AppState {
            picker: Some(PickerState::manage_projects(vec![alpha()], Focus::Sidebar)),
            ..AppState::default()
        };

        // When validating a removal.
        let result = validate_remove_project(&state);

        // Then it is allowed.
        assert_eq!(result, Ok(()), "a project row can be removed");
    }

    #[rstest::rstest]
    fn pick_session_is_refused_for_an_agent_being_deleted() {
        // Given agent 1 highlighted in the session picker while it's being
        // deleted.
        let state = {
            let mut state = deleting(AgentStatus::Idle);
            state.picker = Some(picking_agent_1());
            state.sessions.deleting.insert(SessionId(1));
            state
        };

        // When validating a pick.
        let result = validate_pick_session(&state);

        // Then validation fails with Deleted.
        assert_eq!(
            result,
            Err(PickSessionError::Deleted),
            "an agent being deleted can't be jumped into"
        );
    }

    #[rstest::rstest]
    fn pick_session_checks_a_hits_agent_in_the_search_picker() {
        // Given the search picker over one hit in agent 1, and no agents in
        // the sidebar.
        let picker = {
            let mut picker = PickerState::search(Focus::Sidebar);
            picker.show_hits(
                "",
                vec![PickerItem::Hit {
                    id: 1,
                    agent: AgentId(1),
                    label: "work/New agent".into(),
                    split: 5,
                    snippet: "fix the bug".into(),
                    lit: vec![],
                    text_lit: vec![],
                    path: "/t/1.jsonl".into(),
                    prompt_offset: 0,
                }],
                false,
            );
            picker
        };
        let state = AppState {
            picker: Some(picker),
            ..AppState::default()
        };

        // When validating a pick.
        let result = validate_pick_session(&state);

        // Then the hit's agent is looked up, and it's gone.
        assert_eq!(
            result,
            Err(PickSessionError::Deleted),
            "a hit's agent is checked like a session row's"
        );
    }

    /// The search picker over one hit, in agent 1, over `state`.
    fn searching_agent_1(state: AppState) -> AppState {
        let mut picker = PickerState::search(Focus::Sidebar);
        picker.show_hits(
            "",
            vec![PickerItem::Hit {
                id: 1,
                agent: AgentId(1),
                label: "alpha/New agent".into(),
                split: 6,
                snippet: "fix the bug".into(),
                lit: vec![],
                text_lit: vec![],
                path: "/t/1.jsonl".into(),
                prompt_offset: 0,
            }],
            false,
        );
        AppState {
            picker: Some(picker),
            ..state
        }
    }

    /// `state` with agent 1 out of its pane, as `last_session` left it.
    fn ended(mut state: AppState, last_session: Option<SessionId>) -> AppState {
        for agent in state
            .sessions
            .projects
            .iter_mut()
            .flat_map(|project| project.agents.iter_mut())
        {
            agent.pane = None;
            agent.last_session = last_session;
        }
        state
    }

    #[rstest::rstest]
    fn pick_session_allows_a_hit_in_an_ended_agent() {
        // Given a hit in agent 1, which ended in session 1.
        let state = searching_agent_1(ended(deleting(AgentStatus::Idle), Some(SessionId(1))));

        // When validating a pick.
        let result = validate_pick_session(&state);

        // Then it is allowed: the pick opens session 1.
        assert_eq!(result, Ok(()), "an ended agent's session can be opened");
    }

    #[rstest::rstest]
    fn pick_session_is_refused_for_a_hit_without_a_session() {
        // Given a hit in agent 1, which never ran in a session.
        let state = searching_agent_1(ended(deleting(AgentStatus::Idle), None));

        // When validating a pick.
        let result = validate_pick_session(&state);

        // Then validation fails with NoSession.
        assert_eq!(
            result,
            Err(PickSessionError::NoSession),
            "a hit with no session has nothing to open"
        );
    }

    #[rstest::rstest]
    fn pick_session_is_refused_for_an_agent_no_longer_listed() {
        // Given agent 1 highlighted in the session picker, but no longer in
        // the sidebar.
        let state = AppState {
            picker: Some(picking_agent_1()),
            ..AppState::default()
        };

        // When validating a pick.
        let result = validate_pick_session(&state);

        // Then validation fails with Deleted.
        assert_eq!(
            result,
            Err(PickSessionError::Deleted),
            "a deleted agent can't be jumped into"
        );
    }

    #[rstest::rstest]
    fn close_listed_agent_rejected_when_session_gone() {
        // Given agent 1's session highlighted in the session picker, but no
        // longer in the sidebar.
        let state = AppState {
            picker: Some(picking_agent_1()),
            ..AppState::default()
        };

        // When validating `d`.
        let result = validate_close_listed_agent(&state);

        // Then validation fails with Gone.
        assert_eq!(
            result,
            Err(CloseListedAgentError::Gone),
            "a gone session's agent can't be closed"
        );
    }

    #[rstest::rstest]
    fn close_listed_agent_rejected_outside_the_session_picker() {
        // Given the project picker open.
        let state = AppState {
            picker: Some(PickerState::projects(vec![alpha()], Focus::Sidebar)),
            ..AppState::default()
        };

        // When validating `d`.
        let result = validate_close_listed_agent(&state);

        // Then validation fails with NoPicker.
        assert_eq!(
            result,
            Err(CloseListedAgentError::NoPicker),
            "only the session picker closes listed agents"
        );
    }

    #[rstest::rstest]
    fn close_listed_agent_rejected_when_pane_gone() {
        // Given agent 1 highlighted in the session picker, its pane closed
        // since.
        let state = AppState {
            picker: Some(picking_agent_1()),
            ..ended(deleting(AgentStatus::Idle), Some(SessionId(1)))
        };

        // When validating `d`.
        let result = validate_close_listed_agent(&state);

        // Then validation fails with Gone.
        assert_eq!(
            result,
            Err(CloseListedAgentError::Gone),
            "a closed pane's agent can't be closed again"
        );
    }

    #[rstest::rstest]
    fn pick_session_rejected_when_pane_gone() {
        // Given agent 1 highlighted in the session picker, its pane closed
        // since.
        let state = AppState {
            picker: Some(picking_agent_1()),
            ..ended(deleting(AgentStatus::Idle), Some(SessionId(1)))
        };

        // When validating a pick.
        let result = validate_pick_session(&state);

        // Then validation fails with PaneGone.
        assert_eq!(
            result,
            Err(PickSessionError::PaneGone),
            "a closed pane can't be jumped into"
        );
    }

    const WORKTREE: &str = "/home/me/.orb/worktrees/alpha/orb-ffff";

    /// The worktree picker over `WORKTREE`, where agent 1, `status`, runs.
    fn deleting(status: AgentStatus) -> AppState {
        let agent = Agent {
            last_session: None,
            harness: HarnessId::new("claude"),
            id: AgentId(1),
            title: None,
            cwd: WORKTREE.into(),
            transcript: None,
            status,
            turn_started_at: None,
            pane: Some(PaneLaunch {
                pane: PaneId(1),
                session: SessionId(1),
            }),
            branch: None,
            created_at: SystemTime::UNIX_EPOCH,
            last_activity_at: SystemTime::UNIX_EPOCH,
            unseen: false,
            model: None,
        };
        let row = PickerItem::Worktree {
            path: WORKTREE.into(),
            label: "alpha/orb-ffff".into(),
            split: 6,
            extra: String::new(),
        };
        let projects = vec![Project {
            id: ProjectId(1),
            title: "alpha".into(),
            root: "/alpha".into(),
            created_at: SystemTime::UNIX_EPOCH,
            removed: false,
            repo: true,
            agents: vec![agent],
            kind: ProjectKind::Normal,
        }];
        AppState {
            picker: Some(PickerState::worktrees(vec![row], Focus::Sidebar)),
            sessions: Sessions {
                sessions: sessions_for(&projects),
                projects,
                ..Sessions::default()
            },
            ..AppState::default()
        }
    }

    #[rstest::rstest]
    fn delete_worktree_rejected_without_selection() {
        // Given the worktree picker with `x` typed, which matches nothing.
        let state = {
            let mut state = deleting(AgentStatus::Idle);
            if let Some(picker) = &mut state.picker {
                picker.insert('x');
            }
            state
        };

        // When validating a delete.
        let result = validate_delete_worktree(&state);

        // Then validation fails with NoSelection.
        assert_eq!(
            result,
            Err(DeleteWorktreeError::NoSelection),
            "nothing highlighted can't be deleted"
        );
    }

    #[rstest::rstest]
    fn delete_worktree_rejected_while_an_agent_in_it_is_attached() {
        // Given a worktree whose agent is attached.
        let state = AppState {
            attached: [SessionId(1)].into(),
            ..deleting(AgentStatus::Idle)
        };

        // When validating a delete.
        let result = validate_delete_worktree(&state);

        // Then validation fails with Attached.
        assert_eq!(
            result,
            Err(DeleteWorktreeError::Attached),
            "an attached agent's worktree can't be deleted"
        );
    }

    #[rstest::rstest]
    fn delete_worktree_rejected_while_an_agent_in_it_is_mid_turn() {
        // Given a worktree whose agent is working.
        let state = deleting(AgentStatus::Working);

        // When validating a delete.
        let result = validate_delete_worktree(&state);

        // Then validation fails with MidTurn.
        assert_eq!(
            result,
            Err(DeleteWorktreeError::MidTurn),
            "a mid-turn agent's worktree can't be deleted"
        );
    }

    #[rstest::rstest]
    fn delete_worktree_allowed_on_an_active_idle_row() {
        // Given a worktree whose active agent is idle and detached.
        let state = deleting(AgentStatus::Idle);

        // When validating a delete.
        let result = validate_delete_worktree(&state);

        // Then it is allowed.
        assert_eq!(
            result,
            Ok(()),
            "an active idle agent's worktree can be deleted"
        );
    }
}
