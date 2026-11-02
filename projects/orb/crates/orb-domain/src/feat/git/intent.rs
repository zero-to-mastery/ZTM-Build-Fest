//! What the git keys do: moving a session to another workspace and switching
//! its branch, and what picking in those pickers asks for.

use std::path::Path;

use crate::command::{SessionsCommand, Workspace};
use crate::feat::git::validator::{
    BUSY_DIRECTORY, ChangeWorkspaceError, SwitchBranchError, validate_change_workspace,
    validate_switch_branch,
};
use crate::feat::git::worktree::previous_worktree;
use crate::feat::picker::intent::open_picker;
use crate::feat::picker::list::{BranchRow, PickerItem, WorkspaceChoice};
use crate::feat::picker::state::{PickTarget, PickerKind, PickerState};
use crate::feat::sessions::intent::new_session;
use crate::feat::sessions::state::{Project, Session, Sessions};
use crate::feat::sessions::validator::validate_new_session;
use crate::ids::{ProjectId, SessionId};
use crate::{AppState, Command, Focus};

/// Opens the workspace picker for the keyed session, `git init`'s
/// confirm for a project that isn't a repo, or why its workspace is locked.
pub(crate) fn open_workspace_picker(state: &mut AppState) -> Vec<Command> {
    match validate_change_workspace(state) {
        Ok(()) => open_for_keyed_repo(state, |state, session, project| {
            let worktree = session.dir != project.root;
            let items = workspace_items(&state.sessions, project, &session.dir, worktree);
            let target = PickTarget::Move(session.id);
            (PickerState::workspace(target, items, state.focus), vec![])
        }),
        Err(ChangeWorkspaceError::Locked { worktree }) => {
            let workspace = if worktree {
                "Worktree"
            } else {
                "Local checkout"
            };
            state.sessions.error = Some(format!("Workspace locked · {workspace}"));
            vec![]
        }
        Err(_) => vec![],
    }
}

/// Opens the branch picker for the keyed session, `git init`'s confirm
/// for a project that isn't a repo, or why its directory is busy.
pub(crate) fn switch_branch(state: &mut AppState) -> Vec<Command> {
    match validate_switch_branch(state) {
        Ok(()) => open_for_keyed_repo(state, |state, session, _| {
            let (id, cwd) = (session.id, session.dir.clone());
            let unstarted = !state.sessions.turned(id);
            let picker = PickerState::branches(id, cwd.clone(), unstarted, None, state.focus);
            (picker, vec![Command::ListBranches(cwd)])
        }),
        Err(SwitchBranchError::Busy) => {
            state.sessions.error = Some(BUSY_DIRECTORY.to_owned());
            vec![]
        }
        Err(_) => vec![],
    }
}

/// Opens the picker `build` makes for the keyed session and its project,
/// returning the commands `build` asks for; for a project that isn't a repo,
/// opens `git init`'s confirm instead. Nothing without a keyed session in a
/// known project.
fn open_for_keyed_repo<F>(state: &mut AppState, build: F) -> Vec<Command>
where
    F: FnOnce(&AppState, &Session, &Project) -> (PickerState, Vec<Command>),
{
    let Some((picker, commands)) = state.keyed_session().and_then(|session| {
        let project = state.sessions.project(session.project)?;
        Some(if project.repo {
            build(state, session, project)
        } else {
            (PickerState::init_git(project.id, state.focus), vec![])
        })
    }) else {
        return vec![];
    };
    open_picker(state, picker);
    commands
}

/// What picking the selected branch of `picker`, a closed branch picker, asks
/// for:
/// - the current branch: nothing;
/// - before the first agent turn, a branch checked out in another worktree:
///   move the session there;
/// - before the first agent turn, the local default branch checked out
///   nowhere, from outside the project's checkout: check it out in the
///   checkout and move the session there;
/// - otherwise: check it out in the session's directory.
pub(crate) fn pick_branch(state: &mut AppState, picker: &PickerState) -> Vec<Command> {
    let (
        &PickerKind::Branches {
            session,
            ref cwd,
            unstarted,
        },
        Some(PickerItem::Branch(BranchRow { git_ref, .. })),
    ) = (picker.kind(), picker.selected())
    else {
        return vec![];
    };
    let elsewhere = git_ref.worktree.as_ref().filter(|path| *path != cwd);
    match (git_ref.current, unstarted, elsewhere) {
        (true, _, _) => vec![],
        (false, true, Some(path)) => {
            let to = Workspace::Existing(path.clone());
            change_workspace(state, session, to)
        }
        _ => {
            let outside_root = state
                .sessions
                .session(session)
                .and_then(|found| state.sessions.project(found.project))
                .is_some_and(|project| project.root != *cwd);
            let to_root = unstarted
                && git_ref.default
                && !git_ref.remote
                && git_ref.worktree.is_none()
                && outside_root;
            let command = Command::Sessions(SessionsCommand::SwitchBranch {
                session,
                git_ref: git_ref.clone(),
                to_root,
                if_active: state.sessions.active(),
            });
            if to_root {
                detach_moving(state, session, command)
            } else {
                vec![command]
            }
        }
    }
}

/// What picking `choice` in `project`'s new-session workspace picker asks
/// for: a session in the checkout or the previous worktree, or the base
/// branch picker for a new worktree, listing the project root's refs.
pub(crate) fn pick_new_workspace(
    state: &mut AppState,
    project: ProjectId,
    name: Option<String>,
    choice: Option<PickerItem>,
) -> Vec<Command> {
    match choice {
        Some(PickerItem::Workspace(WorkspaceChoice::Current { .. })) => {
            new_session(state, project, Workspace::Checkout, name)
        }
        Some(PickerItem::Workspace(WorkspaceChoice::Previous { path, .. })) => {
            new_session(state, project, Workspace::Existing(path), name)
        }
        Some(PickerItem::Workspace(WorkspaceChoice::NewWorktree)) => {
            let Some(root) = state.sessions.project(project).map(|p| p.root.clone()) else {
                return vec![];
            };
            let target = PickTarget::New { project, name };
            let picker = PickerState::base(target, root.clone(), state.focus);
            open_picker(state, picker);
            vec![Command::ListBranches(root)]
        }
        _ => vec![],
    }
}

/// What picking `choice` in session `session`'s workspace picker asks for:
/// nothing to stay, a move to the previous worktree, or the base branch
/// picker for a new worktree, listing the project root's refs.
pub(crate) fn pick_move_workspace(
    state: &mut AppState,
    session: SessionId,
    choice: Option<PickerItem>,
) -> Vec<Command> {
    match choice {
        Some(PickerItem::Workspace(WorkspaceChoice::Previous { path, .. })) => {
            change_workspace(state, session, Workspace::Existing(path))
        }
        Some(PickerItem::Workspace(WorkspaceChoice::NewWorktree)) => {
            let Some(root) = state
                .sessions
                .session(session)
                .and_then(|found| state.sessions.project(found.project))
                .map(|project| project.root.clone())
            else {
                return vec![];
            };
            let picker = PickerState::base(PickTarget::Move(session), root.clone(), state.focus);
            open_picker(state, picker);
            vec![Command::ListBranches(root)]
        }
        _ => vec![],
    }
}

/// Asks for `session` to move to `to`, one start at a time (see
/// [`detach_moving`]).
pub(crate) fn change_workspace(
    state: &mut AppState,
    session: SessionId,
    to: Workspace,
) -> Vec<Command> {
    detach_moving(
        state,
        session,
        Command::Sessions(SessionsCommand::ChangeWorkspace {
            session,
            to,
            if_active: state.sessions.active(),
        }),
    )
}

/// Asks for `command`, which moves `session` to another directory, one start
/// at a time: marks the start and detaches the session, so the frontend
/// drops its pane clients before the sessions actor kills its panes.
fn detach_moving(state: &mut AppState, session: SessionId, command: Command) -> Vec<Command> {
    if validate_new_session(state).is_err() {
        return vec![];
    }
    state.sessions.starting = true;
    state.attached.remove(&session);
    if state.focus == Focus::Pane {
        state.focus = Focus::Sidebar;
    }
    vec![command]
}

/// The workspace picker's rows for something in `cwd`: stay there
/// (`worktree` is whether that's a worktree), a new worktree, then the
/// project's previous worktree other than `cwd`.
pub(crate) fn workspace_items(
    sessions: &Sessions,
    project: &Project,
    cwd: &Path,
    worktree: bool,
) -> Vec<PickerItem> {
    [
        WorkspaceChoice::Current { worktree },
        WorkspaceChoice::NewWorktree,
    ]
    .into_iter()
    .chain(
        previous_worktree(sessions, project, cwd)
            .map(|(path, branch)| WorkspaceChoice::Previous { path, branch }),
    )
    .map(PickerItem::Workspace)
    .collect()
}

#[cfg(test)]
mod tests {

    use crate::feat::picker::state::{PickTarget, PickerKind, PickerState};
    use crate::feat::sessions::state::{Agent, AgentStatus};
    use crate::ids::{ProjectId, SessionId};
    use crate::intent_handler::test_support::{
        agent, choosing_workspace, in_root, state_with, workspace_labels,
    };
    use crate::{AppState, Command, Focus, Intent, IntentHandler};

    #[rstest::rstest]
    fn change_workspace_on_a_session_opens_the_workspace_picker() {
        // Given a selected session whose agent has had no turn.
        let mut state = state_with(vec![in_root(1)], 1);

        // When handling ChangeWorkspace.
        IntentHandler::handle(&Intent::ChangeWorkspace, &mut state);

        // Then the session's workspace picker is open and takes the keys.
        assert_eq!(
            (state.focus, state.picker.as_ref().map(PickerState::kind)),
            (
                Focus::Picker,
                Some(&PickerKind::Workspace {
                    target: PickTarget::Move(SessionId(1))
                })
            ),
            "ChangeWorkspace should open the workspace picker"
        );
    }

    /// [`state_with`] agent 1 in the root, selected, its project outside
    /// git.
    fn outside_git() -> AppState {
        let mut state = state_with(vec![in_root(1)], 1);
        for project in &mut state.sessions.projects {
            project.repo = false;
        }
        state
    }

    #[rstest::rstest]
    fn change_workspace_outside_git_offers_init_git() {
        // Given a selected session of a project outside git.
        let mut state = outside_git();

        // When handling ChangeWorkspace.
        IntentHandler::handle(&Intent::ChangeWorkspace, &mut state);

        // Then the picker offers to make the project a git repository.
        assert_eq!(
            state.picker.as_ref().map(PickerState::kind),
            Some(&PickerKind::InitGit {
                project: ProjectId(1)
            }),
            "a project outside git has no worktrees to pick"
        );
    }

    #[rstest::rstest]
    fn switch_branch_outside_git_offers_init_git() {
        // Given a selected session of a project outside git.
        let mut state = outside_git();

        // When handling SwitchBranch.
        IntentHandler::handle(&Intent::SwitchBranch, &mut state);

        // Then the picker offers to make the project a git repository.
        assert_eq!(
            state.picker.as_ref().map(PickerState::kind),
            Some(&PickerKind::InitGit {
                project: ProjectId(1)
            }),
            "a project outside git has no branches to pick"
        );
    }

    #[rstest::rstest]
    fn locked_workspace_shows_the_lock_message() {
        // Given a selected session in the root checkout whose agent is
        // titled, so a turn has run.
        let mut state = state_with(
            vec![Agent {
                title: Some("fix the tests".into()),
                ..in_root(1)
            }],
            1,
        );

        // When handling ChangeWorkspace.
        IntentHandler::handle(&Intent::ChangeWorkspace, &mut state);

        // Then the mode line says the local checkout is locked.
        assert_eq!(
            state.sessions.error.as_deref(),
            Some("Workspace locked · Local checkout"),
            "a session that had a turn should show the lock"
        );
    }

    #[rstest::rstest]
    fn workspace_picker_offers_previous_worktree_with_its_branch() {
        // Given another session of the project in a worktree on `orb/feat`.
        let mut state = AppState {
            focus: Focus::Sidebar,
            ..state_with(vec![in_root(1), agent(2, AgentStatus::Idle)], 1)
        };
        for session in &mut state.sessions.sessions {
            if session.id == SessionId(2) {
                session.branch = Some("orb/feat".into());
            }
        }

        // When opening the workspace picker on a root agent.
        IntentHandler::handle(&Intent::ChangeWorkspace, &mut state);

        // Then the last row offers that worktree by its branch.
        assert_eq!(
            workspace_labels(&state),
            [
                "Current checkout",
                "New worktree",
                "Previous worktree (orb/feat)"
            ],
            "the seed worktree should be offered"
        );
    }

    #[rstest::rstest]
    fn workspace_picker_omits_previous_worktree_without_a_seed() {
        // Given / When opening the workspace picker on a project's only agent.
        let state = choosing_workspace(vec![in_root(1)]);

        // Then there is no previous-worktree row.
        assert_eq!(
            workspace_labels(&state),
            ["Current checkout", "New worktree"],
            "no seed means no previous worktree"
        );
    }

    #[rstest::rstest]
    fn switch_branch_opens_the_branch_picker() {
        // Given a selected prompt-less agent in the root.
        let mut state = state_with(vec![in_root(1)], 1);

        // When handling SwitchBranch.
        IntentHandler::handle(&Intent::SwitchBranch, &mut state);

        // Then its branch picker is open and takes the keys.
        assert_eq!(
            (state.focus, state.picker.as_ref().map(PickerState::kind)),
            (
                Focus::Picker,
                Some(&PickerKind::Branches {
                    session: SessionId(1),
                    cwd: "/work".into(),
                    unstarted: true,
                })
            ),
            "SwitchBranch should open the branch picker"
        );
    }

    #[rstest::rstest]
    fn switch_branch_on_a_session_lists_branches_in_its_dir() {
        // Given a selected session in the root.
        let mut state = state_with(vec![in_root(1)], 1);

        // When handling SwitchBranch.
        let commands = IntentHandler::handle(&Intent::SwitchBranch, &mut state);

        // Then the root's refs are listed.
        assert_eq!(
            commands,
            [Command::ListBranches("/work".into())],
            "the picker's refs come from the session's directory"
        );
    }

    #[rstest::rstest]
    fn busy_directory_shows_the_error() {
        // Given a working sibling in the selected agent's directory.
        let mut state = state_with(
            vec![
                in_root(1),
                Agent {
                    cwd: "/work".into(),
                    ..agent(2, AgentStatus::Working)
                },
            ],
            1,
        );

        // When handling SwitchBranch.
        IntentHandler::handle(&Intent::SwitchBranch, &mut state);

        // Then the mode line says Claude is working there.
        assert_eq!(
            state.sessions.error.as_deref(),
            Some("A session is working in this directory"),
            "a busy directory should refuse the switch"
        );
    }
}
