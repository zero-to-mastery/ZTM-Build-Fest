//! Changes an agent asks for to what the screen owns: closing, renaming,
//! settling and focusing a named pane, tab or session. Each acts on what it
//! names, never on what the user has selected, and leaves the keys and the
//! shown session alone, except `Focus`, settling the shown session, and
//! closing the last pane of the shown session, whose new shell takes the keys.

use crate::feat::control::protocol::{ApiError, ErrorCode};
use crate::feat::picker::intent::pick;
use crate::feat::sessions::intent::settle_now;
use crate::feat::sessions::state::SidebarItem;
use crate::feat::sessions::validator::{SETTLE_IN_PROGRESS, session_working};
use crate::ids::{PaneId, SessionId};
use crate::{AppState, Command, Focus, SessionsCommand};

/// A change to what the frontend owns, asked for by an agent and applied on
/// the screen loop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    ClosePane(PaneId),
    /// Closes the tab holding the pane.
    CloseTab(PaneId),
    RenamePane {
        pane: PaneId,
        name: String,
    },
    RenameSession {
        session: SessionId,
        name: String,
    },
    SettleSession(SessionId),
    /// Shows `pane` (else the session's focused pane) and moves the keys
    /// there, unless the user is typing in a picker, the rename box or the
    /// sidebar search.
    Focus {
        session: SessionId,
        pane: Option<PaneId>,
    },
    /// Runs a new session's panes without showing it.
    Attach(SessionId),
}

/// Applies `change` to `state` and returns the commands that must follow, or
/// why it can't; it never writes `sessions.error`, and it moves the keys or
/// the active session only for `Focus` and for settling the shown session.
///
/// # Errors
///
/// Returns `not_found` for a pane or session that doesn't exist,
/// `bad_request` for closing the tab of a float, and `failed` for settling a
/// session with a turn underway.
pub fn apply(state: &mut AppState, change: &Change) -> Result<Vec<Command>, ApiError> {
    match change {
        Change::ClosePane(pane) => {
            let session = owner(state, *pane)?;
            state.layouts.close_pane(*pane);
            Ok(closed(state, session))
        }
        Change::CloseTab(pane) => {
            let session = owner(state, *pane)?;
            if !state.layouts.close_tab_of(*pane) {
                return Err(ApiError::new(
                    ErrorCode::BadRequest,
                    "a float isn't in a tab",
                ));
            }
            Ok(closed(state, session))
        }
        Change::RenamePane { pane, name } => {
            let session = owner(state, *pane)?;
            state.layouts.rename_pane(*pane, trimmed(name));
            Ok(vec![save_layout(session)])
        }
        Change::RenameSession { session, name } => {
            exists(state, *session)?;
            Ok(vec![Command::Sessions(SessionsCommand::RenameSession {
                session: *session,
                name: trimmed(name),
            })])
        }
        Change::SettleSession(session) => settle(state, *session),
        Change::Focus { session, pane } => focus(state, *session, *pane),
        Change::Attach(session) => {
            state.attached.insert(*session);
            Ok(vec![])
        }
    }
}

/// The session holding `pane`; `not_found` when none does.
fn owner(state: &AppState, pane: PaneId) -> Result<SessionId, ApiError> {
    state
        .layouts
        .owner_of(pane)
        .ok_or_else(|| ApiError::new(ErrorCode::NotFound, format!("no pane {}", pane.0)))
}

/// `not_found` unless session `session` exists.
fn exists(state: &AppState, session: SessionId) -> Result<(), ApiError> {
    match state.sessions.session(session) {
        Some(_) => Ok(()),
        None => Err(ApiError::new(
            ErrorCode::NotFound,
            format!("no session {}", session.0),
        )),
    }
}

/// `name` without the spaces around it; `None` (the usual name) when that
/// leaves nothing, as in the rename box.
fn trimmed(name: &str) -> Option<String> {
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

fn save_layout(session: SessionId) -> Command {
    Command::Sessions(SessionsCommand::SaveLayout(session))
}

/// After panes of `session` closed: a cursor on an agent row whose pane left
/// the layout goes to the session's card; the layout is saved (the frontend
/// kills the closed panes' programs, and a session left without panes gets a
/// new shell when it's saved).
fn closed(state: &mut AppState, session: SessionId) -> Vec<Command> {
    if let Some(SidebarItem::Agent { session: on, pane }) = state.sessions.cursor
        && on == session
        && state.layouts.owner_of(pane) != Some(session)
    {
        state.sessions.cursor = Some(SidebarItem::Session(session));
    }
    vec![save_layout(session)]
}

/// Settles `session` unless one of its agents has a turn underway: it leaves
/// `attached`, stops being active, and a cursor on it moves to the
/// neighbouring card.
fn settle(state: &mut AppState, session: SessionId) -> Result<Vec<Command>, ApiError> {
    exists(state, session)?;
    if session_working(state, session) {
        return Err(ApiError::new(ErrorCode::Failed, SETTLE_IN_PROGRESS));
    }
    Ok(settle_now(state, session, false))
}

/// Shows `pane` of `session` (else its focused pane) in its tab, makes the
/// session active and attached, puts the cursor on the pane's row and moves
/// the keys into it, recording the move as a jump. While the user types in a
/// picker, the rename box or the sidebar search, the keys stay there.
fn focus(
    state: &mut AppState,
    session: SessionId,
    pane: Option<PaneId>,
) -> Result<Vec<Command>, ApiError> {
    let pane = pane
        .or_else(|| state.layouts.get(session)?.focused())
        .filter(|&pane| state.layouts.owner_of(pane) == Some(session))
        .ok_or_else(|| {
            ApiError::new(
                ErrorCode::NotFound,
                format!("no pane to focus in session {}", session.0),
            )
        })?;
    let keys = state.focus;
    let from = state.jump_from();
    state.layouts.reveal(session, pane);
    let row = state.entry_row(session);
    let mut commands = pick(state, from, row, row);
    state.sessions.reveal_cursor(&state.layouts);
    commands.push(save_layout(session));
    if matches!(keys, Focus::Picker | Focus::Rename | Focus::Search) {
        state.focus = keys;
    }
    Ok(commands)
}

#[cfg(test)]
mod tests {
    use super::{Change, apply};
    use crate::feat::control::protocol::ErrorCode;
    use crate::feat::layout::state::{SessionLayout, test_entry};
    use crate::feat::layout::tree::Split;
    use crate::feat::sessions::state::{AgentStatus, SidebarItem};
    use crate::ids::{PaneId, SessionId};
    use crate::intent_handler::test_support::{
        agent, colony_with_colonists, left_pane_showing_1, state_with,
    };
    use crate::{Command, Focus, SessionsCommand};

    #[rstest::rstest]
    fn settle_of_a_working_session_is_refused_with_failed() {
        // Given session 1's agent working.
        let mut state = state_with(
            vec![agent(1, AgentStatus::Working), agent(2, AgentStatus::Idle)],
            2,
        );

        // When an agent asks to settle session 1.
        let result = apply(&mut state, &Change::SettleSession(SessionId(1)));

        // Then it is refused as failed.
        assert_eq!(
            result.map_err(|error| error.code),
            Err(ErrorCode::Failed),
            "a session with a turn underway can't be settled"
        );
    }

    #[rstest::rstest]
    fn settling_the_selected_session_moves_the_cursor_to_the_next_card() {
        // Given sessions 2 and 1 listed in that order, the cursor on 2.
        let mut state = state_with(
            vec![agent(1, AgentStatus::Idle), agent(2, AgentStatus::Idle)],
            2,
        );

        // When an agent asks to settle session 2.
        let _ = apply(&mut state, &Change::SettleSession(SessionId(2)));

        // Then the cursor is on session 1's card.
        assert_eq!(
            state.sessions.cursor,
            Some(SidebarItem::Session(SessionId(1))),
            "a settled selected session hands the cursor to the next card"
        );
    }

    #[rstest::rstest]
    fn settle_returns_one_settle_without_colonists() {
        // Given colony 1 with idle colonists.
        let mut state = colony_with_colonists([AgentStatus::Idle; 3]);

        // When an agent asks to settle colony 1.
        let result = apply(&mut state, &Change::SettleSession(SessionId(1)));

        // Then the sessions actor is asked to settle colony 1 alone.
        assert_eq!(
            result,
            Ok(vec![Command::Sessions(SessionsCommand::SettleSession {
                session: SessionId(1),
                with_colonists: false,
            })]),
            "the API settles the named session only"
        );
    }

    #[rstest::rstest]
    #[case::close_pane(Change::ClosePane(PaneId(2)))]
    #[case::close_tab(Change::CloseTab(PaneId(2)))]
    #[case::rename_pane(Change::RenamePane { pane: PaneId(2), name: "x".into() })]
    #[case::rename_session(Change::RenameSession { session: SessionId(2), name: "x".into() })]
    #[case::settle_session(Change::SettleSession(SessionId(2)))]
    fn changes_elsewhere_keep_the_keys_and_the_shown_session(#[case] change: Change) {
        // Given the user typing in session 1's pane, session 2 beside it.
        let mut state = left_pane_showing_1(&[1, 2], 1);
        state.focus = Focus::Pane;

        // When applying a change to session 2.
        let _ = apply(&mut state, &change);

        // Then the keys stay in session 1's pane, which stays shown.
        assert_eq!(
            (state.focus, state.shown_session()),
            (Focus::Pane, Some(SessionId(1))),
            "a change elsewhere leaves the keys and the screen"
        );
    }

    #[rstest::rstest]
    fn focus_moves_the_keys_into_the_pane() {
        // Given the user in the sidebar on session 1, and session 2 split
        // into panes 2 and 3 with pane 3 focused.
        let mut state = left_pane_showing_1(&[1], 1);
        state
            .layouts
            .split(SessionId(2), Split::Right, test_entry(3));

        // When focusing pane 2.
        let _ = apply(
            &mut state,
            &Change::Focus {
                session: SessionId(2),
                pane: Some(PaneId(2)),
            },
        );

        // Then the keys are in pane 2 of the shown session 2.
        let focused = state
            .layouts
            .get(SessionId(2))
            .and_then(SessionLayout::focused);
        assert_eq!(
            (state.focus, state.shown_session(), focused),
            (Focus::Pane, Some(SessionId(2)), Some(PaneId(2))),
            "focus shows the pane and moves the keys into it"
        );
    }

    #[rstest::rstest]
    fn focus_on_a_hidden_colonists_pane_opens_its_colonists_row() {
        // Given colonist 2 hidden under colony 1's folded colonists row.
        let mut state = colony_with_colonists([AgentStatus::Idle; 3]);

        // When focusing colonist 2's pane.
        let _ = apply(
            &mut state,
            &Change::Focus {
                session: SessionId(2),
                pane: Some(PaneId(2)),
            },
        );

        // Then colony 1's colonists row is open.
        assert!(
            state.sessions.colonists_open.contains(&SessionId(1)),
            "focusing a hidden colonist's pane should open its colonists row"
        );
    }
}
