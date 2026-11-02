//! Checks whether the user's git actions on the keyed session can
//! proceed: changing its workspace, and switching its branch.

use std::path::Path;

use wherror::Error;

use crate::AppState;
use crate::feat::sessions::state::Sessions;

/// Why changing the keyed session's workspace can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum ChangeWorkspaceError {
    /// There is no keyed session (see [`AppState::keyed_session`]).
    NoSelection,
    /// A session is already being made, or a workspace changed.
    Starting,
    /// An agent turn has run in the session. `worktree` is whether it runs
    /// in a worktree rather than the project's checkout.
    Locked { worktree: bool },
}

/// Allow changing the keyed session's workspace before its first agent
/// turn, one start at a time.
///
/// # Errors
///
/// Returns [`ChangeWorkspaceError::NoSelection`] without a keyed session,
/// [`ChangeWorkspaceError::Starting`] while a start is in flight, and
/// [`ChangeWorkspaceError::Locked`] once an agent turn has run in it.
pub fn validate_change_workspace(state: &AppState) -> Result<(), ChangeWorkspaceError> {
    let sessions = &state.sessions;
    let session = state.keyed_session();
    let project = session.and_then(|session| sessions.project(session.project));
    match (session, project) {
        (None, _) | (Some(_), None) => Err(ChangeWorkspaceError::NoSelection),
        _ if sessions.starting => Err(ChangeWorkspaceError::Starting),
        (Some(session), Some(project)) if sessions.turned(session.id) => {
            Err(ChangeWorkspaceError::Locked {
                worktree: session.dir != project.root,
            })
        }
        _ => Ok(()),
    }
}

/// What the mode line says when a branch switch is refused as
/// [`SwitchBranchError::Busy`].
pub const BUSY_DIRECTORY: &str = "A session is working in this directory";

/// Why switching the keyed session's branch can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum SwitchBranchError {
    /// There is no keyed session (see [`AppState::keyed_session`]).
    NoSelection,
    /// A session is already being made, or a workspace changed.
    Starting,
    /// An agent in the directory the checkout would change is working or
    /// waiting.
    Busy,
}

/// Allow switching the branch in the keyed session's directory, unless
/// a start is in flight or a turn is underway in that directory.
///
/// # Errors
///
/// Returns [`SwitchBranchError::NoSelection`] without a keyed session,
/// [`SwitchBranchError::Starting`] while a start is in flight, and
/// [`SwitchBranchError::Busy`] while any agent in its directory is in
/// progress.
pub fn validate_switch_branch(state: &AppState) -> Result<(), SwitchBranchError> {
    let sessions = &state.sessions;
    match state.keyed_session() {
        None => Err(SwitchBranchError::NoSelection),
        _ if sessions.starting => Err(SwitchBranchError::Starting),
        Some(session) => not_busy(sessions, &session.dir),
    }
}

/// [`SwitchBranchError::Busy`] while any agent in `dir` is in progress.
fn not_busy(sessions: &Sessions, dir: &Path) -> Result<(), SwitchBranchError> {
    if sessions
        .all_agents()
        .any(|agent| agent.cwd == dir && agent.status.in_progress())
    {
        Err(SwitchBranchError::Busy)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::feat::harness::HarnessId;
    use std::time::SystemTime;

    use super::{
        ChangeWorkspaceError, SwitchBranchError, validate_change_workspace, validate_switch_branch,
    };
    use crate::AppState;
    use crate::feat::sessions::state::{
        Agent, AgentStatus, PaneLaunch, Project, ProjectKind, Sessions, SidebarItem, sessions_for,
    };
    use crate::ids::{AgentId, PaneId, ProjectId, SessionId};

    /// One project at `/work` whose only session, selected, runs in the
    /// root with one agent titled `title`.
    fn selected(title: Option<&str>) -> AppState {
        let mut state = AppState {
            sessions: Sessions {
                projects: vec![Project {
                    id: ProjectId(1),
                    title: "work".into(),
                    root: "/work".into(),
                    created_at: SystemTime::UNIX_EPOCH,
                    removed: false,
                    repo: true,
                    agents: vec![Agent {
                        last_session: None,
                        harness: HarnessId::new("claude"),
                        id: AgentId(1),
                        title: title.map(Into::into),
                        cwd: "/work".into(),
                        transcript: None,
                        status: AgentStatus::Idle,
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
                    }],
                    kind: ProjectKind::Normal,
                }],
                cursor: Some(SidebarItem::Session(SessionId(1))),
                ..Sessions::default()
            },
            ..AppState::default()
        };
        state.sessions.sessions = sessions_for(&state.sessions.projects);
        state
    }

    #[rstest::rstest]
    fn change_workspace_rejected_after_an_agent_turn() {
        // Given a selected session in the root checkout whose agent has a
        // title, so a turn has run.
        let state = selected(Some("fix the tests"));

        // When validating a workspace change.
        let result = validate_change_workspace(&state);

        // Then it is locked to the local checkout.
        assert_eq!(
            result,
            Err(ChangeWorkspaceError::Locked { worktree: false }),
            "a session that had a turn should be locked"
        );
    }

    #[rstest::rstest]
    fn change_workspace_rejected_while_starting() {
        // Given a selected session with no turn, while a start is in flight.
        let state = {
            let mut state = selected(None);
            state.sessions.starting = true;
            state
        };

        // When validating a workspace change.
        let result = validate_change_workspace(&state);

        // Then validation fails with Starting.
        assert_eq!(
            result,
            Err(ChangeWorkspaceError::Starting),
            "one start at a time"
        );
    }

    #[rstest::rstest]
    fn change_workspace_allowed_before_the_first_agent_turn() {
        // Given a selected session whose agent has had no turn.
        let state = selected(None);

        // When validating a workspace change.
        let result = validate_change_workspace(&state);

        // Then it is allowed.
        assert_eq!(
            result,
            Ok(()),
            "a session with no turn can change workspace"
        );
    }

    /// [`selected`] plus agent 2, working in `cwd`.
    fn with_working_agent(cwd: &str) -> AppState {
        let mut state = selected(None);
        if let Some(project) = state.sessions.projects.first_mut() {
            let working = project.agents.first().map(|agent| Agent {
                id: AgentId(2),
                cwd: cwd.into(),
                status: AgentStatus::Working,
                ..agent.clone()
            });
            project.agents.extend(working);
        }
        state
    }

    #[rstest::rstest]
    fn switch_branch_rejected_while_the_sessions_dir_is_busy() {
        // Given another agent working in the selected session's directory.
        let state = with_working_agent("/work");

        // When validating a branch switch.
        let result = validate_switch_branch(&state);

        // Then validation fails with Busy.
        assert_eq!(
            result,
            Err(SwitchBranchError::Busy),
            "a checkout would change files under the running turn"
        );
    }

    #[rstest::rstest]
    fn switch_branch_allowed_while_an_agent_elsewhere_works() {
        // Given another agent working in a different directory.
        let state = with_working_agent("/work-tree");

        // When validating a branch switch.
        let result = validate_switch_branch(&state);

        // Then it is allowed.
        assert_eq!(result, Ok(()), "a turn elsewhere doesn't block a checkout");
    }
}
