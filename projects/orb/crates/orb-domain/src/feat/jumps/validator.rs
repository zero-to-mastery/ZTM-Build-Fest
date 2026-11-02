//! Checks whether `<C-[>`/`<C-]>` can move through the jump list.

use wherror::Error;

use crate::AppState;

/// Why a jump back or forward can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum JumpError {
    /// No row in that direction is reachable.
    NoTarget,
}

/// Allow `<C-[>` while an older reachable row is listed.
///
/// # Errors
///
/// Returns [`JumpError::NoTarget`] when no older row is reachable.
pub fn validate_jump_back(state: &AppState) -> Result<(), JumpError> {
    state
        .jumps
        .peek_back(state.jump_from(), |item| {
            state.sessions.jumpable(item, &state.layouts)
        })
        .map(drop)
        .ok_or(JumpError::NoTarget)
}

/// Allow `<C-]>` after a `<C-[>` while a newer reachable row is listed.
///
/// # Errors
///
/// Returns [`JumpError::NoTarget`] when no newer row is reachable.
pub fn validate_jump_forward(state: &AppState) -> Result<(), JumpError> {
    state
        .jumps
        .peek_forward(state.jump_from(), |item| {
            state.sessions.jumpable(item, &state.layouts)
        })
        .map(drop)
        .ok_or(JumpError::NoTarget)
}

#[cfg(test)]
mod tests {
    use crate::feat::harness::HarnessId;
    use std::time::SystemTime;

    use super::{JumpError, validate_jump_back};
    use crate::AppState;
    use crate::feat::jumps::state::JumpList;
    use crate::feat::sessions::state::{
        Agent, AgentStatus, PaneLaunch, Project, ProjectKind, Sessions, SidebarItem, sessions_for,
    };
    use crate::ids::{AgentId, PaneId, ProjectId, SessionId};

    fn agent(id: i64) -> Agent {
        Agent {
            last_session: None,
            harness: HarnessId::new("claude"),
            id: AgentId(id),
            title: None,
            cwd: "/tmp".into(),
            transcript: None,
            status: AgentStatus::Idle,
            turn_started_at: None,
            pane: Some(PaneLaunch {
                pane: PaneId(id),
                session: SessionId(id),
            }),
            branch: None,
            created_at: SystemTime::UNIX_EPOCH,
            last_activity_at: SystemTime::UNIX_EPOCH,
            unseen: false,
            model: None,
        }
    }

    fn on(id: i64) -> SidebarItem {
        SidebarItem::Session(SessionId(id))
    }

    /// Agents 1 and 2, the cursor on agent 2, and a jump list of `jumps`.
    fn jumping(jumps: &[i64]) -> AppState {
        let mut state = AppState {
            sessions: Sessions {
                projects: vec![Project {
                    id: ProjectId(1),
                    title: "work".into(),
                    root: "/work".into(),
                    created_at: SystemTime::UNIX_EPOCH,
                    removed: false,
                    repo: true,
                    agents: vec![agent(1), agent(2)],
                    kind: ProjectKind::Normal,
                }],
                cursor: Some(on(2)),
                ..Sessions::default()
            },
            jumps: JumpList::from_saved(jumps.iter().copied().map(on).collect()),
            ..AppState::default()
        };
        state.sessions.sessions = sessions_for(&state.sessions.projects);
        state
    }

    #[rstest::rstest]
    fn jump_back_without_an_older_row_is_rejected() {
        // Given a jump list holding only the cursor's agent.
        let state = jumping(&[2]);

        // When validating a jump back.
        let result = validate_jump_back(&state);

        // Then there's nowhere to go.
        assert_eq!(result, Err(JumpError::NoTarget), "<C-[> needs an older row");
    }

    #[rstest::rstest]
    fn jump_back_onto_an_older_row_is_allowed() {
        // Given agent 1 listed before the cursor's agent 2.
        let state = jumping(&[1, 2]);

        // When validating a jump back.
        let result = validate_jump_back(&state);

        // Then the jump can go ahead.
        assert_eq!(result, Ok(()), "<C-[> onto agent 1 should be allowed");
    }
}
