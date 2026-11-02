//! Checks whether the user's sidebar actions can proceed: making a new
//! session, naming a new colony, pinning,
//! settling or deleting the selected session (pin and settle are refused on
//! an agent row), folding and unfolding a card or the Settled shelf, and
//! making an Incognito session.

use wherror::Error;

use crate::AppState;
use crate::feat::sessions::state::{ProjectKind, SidebarItem, SidebarRow, folder_slug};
use crate::feat::sidebar::state::{Rename, RenameTarget};
use crate::ids::SessionId;

/// Why making a colony from the `New colony` box can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum NewColonyError {
    /// The box isn't naming a colony, or a fresh world's folder name is
    /// empty.
    Empty,
    /// A fresh world's folder name uses something folder names can't: the
    /// char or sequence.
    Invalid(String),
    /// `⏎` already asked for the colony, and the sessions actor hasn't
    /// answered yet.
    Creating,
    /// Its world is gone, removed or no longer a world.
    NoWorld,
}

/// Characters a folder's slug can't hold anywhere.
const INVALID_CHARS: [char; 8] = ['/', '\\', '~', '^', ':', '?', '*', '['];

/// Allow making the colony the `New colony` box names: any name in a shared
/// world; in a fresh world, a usable folder name.
///
/// # Errors
///
/// Returns [`NewColonyError::Empty`] when the box isn't naming a colony or a
/// fresh world's slug is empty, [`NewColonyError::Invalid`] with the
/// offending char or sequence when that slug holds one of `/ \ ~ ^ : ? * [`,
/// starts with `-` or `.`, or holds `..`, [`NewColonyError::Creating`] while
/// the box's colony is being made, and [`NewColonyError::NoWorld`] when its
/// world is gone, removed or no longer a world.
pub fn validate_new_colony(state: &AppState) -> Result<(), NewColonyError> {
    let Some(Rename {
        target: RenameTarget::NewColony(world),
        input,
        creating,
    }) = &state.rename
    else {
        return Err(NewColonyError::Empty);
    };
    if *creating {
        return Err(NewColonyError::Creating);
    }
    let kind = state
        .sessions
        .project(*world)
        .filter(|project| !project.removed && project.kind.is_world())
        .map(|project| project.kind)
        .ok_or(NewColonyError::NoWorld)?;
    if !kind.is_fresh_world() {
        return Ok(());
    }
    let slug = folder_slug(input.text());
    let invalid = slug
        .matches(INVALID_CHARS)
        .next()
        .or_else(|| ["-", "."].into_iter().find(|lead| slug.starts_with(lead)))
        .or_else(|| slug.contains("..").then_some(".."));
    match (slug.is_empty(), invalid) {
        (true, _) => Err(NewColonyError::Empty),
        (false, Some(what)) => Err(NewColonyError::Invalid(what.to_owned())),
        (false, None) => Ok(()),
    }
}

/// Why settling or un-settling can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum ToggleSettleError {
    /// The cursor isn't on a session.
    NoSession,
    /// The cursor is on an agent row; pin and settle are per session.
    OnAgent,
    /// One of the session's agent panes is running a turn or waiting on the
    /// user.
    InProgress,
}

/// Whether one of session `session`'s agent panes has a turn underway.
pub fn session_working(state: &AppState, session: SessionId) -> bool {
    state
        .sessions
        .agents(session)
        .into_iter()
        .any(|agent| agent.status.in_progress())
}

/// What the mode line says when settling is refused because a session is
/// working.
pub const SETTLE_IN_PROGRESS: &str = "Can't settle while a session is working";

/// Allow settling the selected session only while none of its agent panes
/// has a turn underway; un-settling is always allowed.
///
/// # Errors
///
/// Returns [`ToggleSettleError::OnAgent`] with the cursor on an agent row,
/// [`ToggleSettleError::NoSession`] without a selected session, and
/// [`ToggleSettleError::InProgress`] if it isn't settled and one of its
/// agents has a turn underway.
pub fn validate_toggle_settle(state: &AppState) -> Result<(), ToggleSettleError> {
    let sessions = &state.sessions;
    if sessions.selected_agent(&state.layouts).is_some() {
        return Err(ToggleSettleError::OnAgent);
    }
    match sessions.selected_session() {
        None => Err(ToggleSettleError::NoSession),
        Some(session) if session.settled_at.is_none() && session_working(state, session.id) => {
            Err(ToggleSettleError::InProgress)
        }
        Some(_) => Ok(()),
    }
}

/// What the mode line says when settling with colonists is refused because
/// a colonist is working.
pub const COLONIST_WORKING: &str = "Can't settle while a colonist is working";

/// Why a session can't be settled together with its colonists.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
#[error(debug)]
pub enum SettleColonistsError {
    /// A session under it has a turn underway.
    Working,
}

/// Allow settling `session` with its colonists only while none of the
/// sessions under it has a turn underway.
///
/// # Errors
///
/// Returns [`SettleColonistsError::Working`] when one does.
pub fn validate_settle_colonists(
    state: &AppState,
    session: SessionId,
) -> Result<(), SettleColonistsError> {
    let working = state
        .sessions
        .under(session)
        .into_iter()
        .any(|id| session_working(state, id));
    if working {
        Err(SettleColonistsError::Working)
    } else {
        Ok(())
    }
}

/// Why pinning or unpinning can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum TogglePinError {
    /// The cursor isn't on a session.
    NoSession,
    /// The cursor is on an agent row; pin and settle are per session.
    OnAgent,
}

/// Allow pinning or unpinning the selected session.
///
/// # Errors
///
/// Returns [`TogglePinError::OnAgent`] with the cursor on an agent row, and
/// [`TogglePinError::NoSession`] without a selected session.
pub fn validate_toggle_pin(state: &AppState) -> Result<(), TogglePinError> {
    match (
        state.sessions.selected_agent(&state.layouts),
        state.sessions.selected_session(),
    ) {
        (Some(_), _) => Err(TogglePinError::OnAgent),
        (None, Some(_)) => Ok(()),
        (None, None) => Err(TogglePinError::NoSession),
    }
}

/// Why deleting can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum DeleteError {
    /// The cursor isn't on a session.
    NoSelection,
}

/// Allow deleting the selected session, whatever it is doing.
///
/// # Errors
///
/// Returns [`DeleteError::NoSelection`] without a selected session.
pub fn validate_delete(state: &AppState) -> Result<(), DeleteError> {
    match state.sessions.selected_session() {
        Some(_) => Ok(()),
        None => Err(DeleteError::NoSelection),
    }
}

/// Why making a new session can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum NewSessionError {
    /// A session is already being made, or a workspace changed.
    Starting,
}

/// Allow making a new session, one at a time.
///
/// # Errors
///
/// Returns [`NewSessionError::Starting`] while a start is in flight.
pub fn validate_new_session(state: &AppState) -> Result<(), NewSessionError> {
    if state.sessions.starting {
        Err(NewSessionError::Starting)
    } else {
        Ok(())
    }
}

/// Why making an Incognito session can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum NewIncognitoError {
    /// orb has no Incognito project (it adds one at start), or it was removed.
    NoProject,
}

/// Allow making an Incognito session.
///
/// # Errors
///
/// Returns [`NewIncognitoError::NoProject`] without a non-removed Incognito
/// project.
pub fn validate_new_incognito(state: &AppState) -> Result<(), NewIncognitoError> {
    match state.sessions.own_project(ProjectKind::Incognito) {
        None => Err(NewIncognitoError::NoProject),
        Some(_) => Ok(()),
    }
}

/// What `l` opens or `h` folds at the cursor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FoldTarget {
    /// The Settled shelf.
    Shelf,
    /// A session's card, by its agent rows.
    Card(SessionId),
    /// A session's colonists row.
    Colonists(SessionId),
    /// No fold: the cursor moves up to this row.
    Move(SidebarItem),
}

/// Why unfolding at the cursor can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum UnfoldError {
    /// The cursor is on an agent row, or on nothing.
    NotOnCard,
    /// The session is settled; its row has no agent rows.
    Settled,
    /// The card has no agent rows to show.
    NoAgents,
}

/// Allow unfolding the Settled shelf from its header, a colonists row, or a
/// card that shows agent rows.
///
/// # Errors
///
/// Returns [`UnfoldError::NotOnCard`] off the header, colonists rows and
/// cards,
/// [`UnfoldError::Settled`] on a settled session, and
/// [`UnfoldError::NoAgents`] on a card without agent rows.
pub fn validate_unfold(state: &AppState) -> Result<FoldTarget, UnfoldError> {
    let sessions = &state.sessions;
    match sessions.cursor {
        Some(SidebarItem::SettledShelf) => Ok(FoldTarget::Shelf),
        Some(SidebarItem::Colonists(id)) => Ok(FoldTarget::Colonists(id)),
        Some(SidebarItem::Session(id)) => match sessions.session(id) {
            Some(session) if session.settled_at.is_some() => Err(UnfoldError::Settled),
            Some(_)
                if !sessions.agent_rows(id, &state.layouts).is_empty()
                    && !sessions.hides_one_agent(id, &state.layouts) =>
            {
                Ok(FoldTarget::Card(id))
            }
            _ => Err(UnfoldError::NoAgents),
        },
        Some(SidebarItem::Agent { .. }) | None => Err(UnfoldError::NotOnCard),
    }
}

/// Why folding at the cursor can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum FoldError {
    /// No row is selected.
    NoSelection,
    /// The settled session isn't in the open shelf.
    NotInShelf,
    /// The card has no agent rows to hide.
    NoAgents,
}

/// Allow folding the Settled shelf from its header or a settled session in
/// the open shelf, a card that has agent rows from the card or one of its
/// agent rows, and an open colonists row. Off a colonist whose agent rows
/// don't show, the cursor moves up instead: to the colonists row above it,
/// else to the dim path line above a stuck colonist; off a folded colonists
/// row, to its card. A colonist lifted to the top level by a settled colony
/// doesn't move.
///
/// # Errors
///
/// Returns [`FoldError::NoSelection`] with no row selected,
/// [`FoldError::NotInShelf`] on a settled session while the shelf is
/// closed, and [`FoldError::NoAgents`] on a card without agent rows.
pub fn validate_fold(state: &AppState) -> Result<FoldTarget, FoldError> {
    let sessions = &state.sessions;
    match sessions.cursor {
        Some(SidebarItem::SettledShelf) => Ok(FoldTarget::Shelf),
        Some(SidebarItem::Agent { session, .. }) => Ok(FoldTarget::Card(session)),
        Some(SidebarItem::Session(id)) => match sessions.session(id) {
            Some(session) if session.settled_at.is_some() && sessions.shelf_open => {
                Ok(FoldTarget::Shelf)
            }
            Some(session) if session.settled_at.is_some() => Err(FoldError::NotInShelf),
            Some(session) => {
                let rows: Vec<SidebarItem> = sessions
                    .sidebar(&state.layouts)
                    .iter()
                    .map(SidebarRow::item)
                    .collect();
                let shows_agents = rows
                    .iter()
                    .any(|row| matches!(row, SidebarItem::Agent { session, .. } if *session == id));
                let up = || {
                    let parent = session.parent.filter(|_| !sessions.top(id))?;
                    [SidebarItem::Colonists(parent), SidebarItem::Session(parent)]
                        .into_iter()
                        .find(|item| rows.contains(item))
                };
                if shows_agents {
                    Ok(FoldTarget::Card(id))
                } else if let Some(item) = up() {
                    Ok(FoldTarget::Move(item))
                } else if !sessions.agent_rows(id, &state.layouts).is_empty() {
                    Ok(FoldTarget::Card(id))
                } else {
                    Err(FoldError::NoAgents)
                }
            }
            None => Err(FoldError::NoAgents),
        },
        Some(SidebarItem::Colonists(id)) if sessions.colonists_open.contains(&id) => {
            Ok(FoldTarget::Colonists(id))
        }
        Some(SidebarItem::Colonists(id)) => Ok(FoldTarget::Move(SidebarItem::Session(id))),
        None => Err(FoldError::NoSelection),
    }
}

#[cfg(test)]
mod tests {
    use crate::feat::harness::HarnessId;
    use std::time::SystemTime;

    use super::{
        DeleteError, FoldError, FoldTarget, NewColonyError, NewIncognitoError, NewSessionError,
        TogglePinError, ToggleSettleError, UnfoldError, validate_delete, validate_fold,
        validate_new_colony, validate_new_incognito, validate_new_session, validate_toggle_pin,
        validate_toggle_settle, validate_unfold,
    };
    use crate::feat::sessions::state::{
        Agent, AgentStatus, PaneLaunch, Project, ProjectKind, Sessions, SidebarItem, layouts_for,
        sessions_for,
    };
    use crate::feat::sidebar::state::{Rename, RenameTarget};
    use crate::ids::{AgentId, PaneId, ProjectId, SessionId};
    use crate::{AppState, TextInput};

    #[rstest::rstest]
    fn new_session_rejected_while_starting() {
        // Given a session start in flight.
        let state = AppState {
            sessions: Sessions {
                starting: true,
                ..Sessions::default()
            },
            ..AppState::default()
        };

        // When validating a new session.
        let result = validate_new_session(&state);

        // Then validation fails with Starting.
        assert_eq!(
            result,
            Err(NewSessionError::Starting),
            "one new session at a time"
        );
    }

    #[rstest::rstest]
    fn new_session_allowed_otherwise() {
        // Given no start in flight.
        let state = AppState::default();

        // When validating a new session.
        let result = validate_new_session(&state);

        // Then it is allowed.
        assert_eq!(result, Ok(()), "a new session can start");
    }

    /// orb's Incognito project, `removed` or not, with nothing selected.
    fn incognito_project(removed: bool) -> AppState {
        AppState {
            sessions: Sessions {
                projects: vec![Project {
                    id: ProjectId(1),
                    title: "Incognito".into(),
                    root: "/tmp/orb-incognito".into(),
                    created_at: SystemTime::UNIX_EPOCH,
                    removed,
                    repo: true,
                    agents: vec![],
                    kind: ProjectKind::Incognito,
                }],
                ..Sessions::default()
            },
            ..AppState::default()
        }
    }

    #[rstest::rstest]
    #[case::none(AppState::default())]
    #[case::removed(incognito_project(true))]
    fn new_incognito_rejected_without_an_incognito_project(#[case] state: AppState) {
        // Given no Incognito project, or only a removed one.

        // When validating a new Incognito session.
        let result = validate_new_incognito(&state);

        // Then validation fails with NoProject.
        assert_eq!(
            result,
            Err(NewIncognitoError::NoProject),
            "an Incognito session needs the Incognito project"
        );
    }

    /// One project holding session 1, whose agent agent 1 is `status`, with
    /// the cursor on it.
    fn on_session(status: AgentStatus) -> AppState {
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
                        title: None,
                        cwd: "/work".into(),
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
                    }],
                    kind: ProjectKind::Normal,
                }],
                cursor: Some(SidebarItem::Session(SessionId(1))),
                ..Sessions::default()
            },
            ..AppState::default()
        };
        state.sessions.sessions = sessions_for(&state.sessions.projects);
        state.layouts = layouts_for(&state.sessions.projects);
        state
    }

    #[rstest::rstest]
    fn settle_is_refused_while_an_agent_works() {
        // Given a selected session whose agent is running a turn.
        let state = on_session(AgentStatus::Working);

        // When validating a settle.
        let result = validate_toggle_settle(&state);

        // Then validation fails with InProgress.
        assert_eq!(
            result,
            Err(ToggleSettleError::InProgress),
            "a working session can't be settled"
        );
    }

    #[rstest::rstest]
    fn unsettling_is_allowed_while_an_agent_works() {
        // Given a settled session whose agent is running a turn.
        let state = {
            let mut state = on_session(AgentStatus::Working);
            if let Some(session) = state.sessions.sessions.first_mut() {
                session.settled_at = Some(SystemTime::UNIX_EPOCH);
            }
            state
        };

        // When validating an un-settle.
        let result = validate_toggle_settle(&state);

        // Then it's allowed.
        assert_eq!(result, Ok(()), "a settled session can always come back");
    }

    #[rstest::rstest]
    fn settle_is_refused_off_a_session() {
        // Given the cursor on nothing.
        let state = AppState::default();

        // When validating a settle.
        let result = validate_toggle_settle(&state);

        // Then validation fails with NoSession.
        assert_eq!(
            result,
            Err(ToggleSettleError::NoSession),
            "only a session settles"
        );
    }

    #[rstest::rstest]
    fn toggle_pin_allowed_on_a_session() {
        // Given a selected session.
        let state = on_session(AgentStatus::Idle);

        // When validating a pin.
        let result = validate_toggle_pin(&state);

        // Then it's allowed.
        assert_eq!(result, Ok(()), "a session can be pinned");
    }

    #[rstest::rstest]
    fn toggle_pin_rejected_on_a_session_being_deleted() {
        // Given the selected session being deleted.
        let state = {
            let mut state = on_session(AgentStatus::Idle);
            state.sessions.deleting.insert(SessionId(1));
            state
        };

        // When validating a pin.
        let result = validate_toggle_pin(&state);

        // Then validation fails with NoSession.
        assert_eq!(
            result,
            Err(TogglePinError::NoSession),
            "a session being deleted can't be pinned"
        );
    }

    /// [`on_session`] with the cursor on session 1's agent row for pane 1.
    fn on_agent_row() -> AppState {
        let mut state = on_session(AgentStatus::Idle);
        state.sessions.cursor = Some(SidebarItem::Agent {
            session: SessionId(1),
            pane: PaneId(1),
        });
        state
    }

    #[rstest::rstest]
    fn toggle_pin_rejected_on_an_agent_row() {
        // Given the cursor on an agent row.
        let state = on_agent_row();

        // When validating a pin.
        let result = validate_toggle_pin(&state);

        // Then validation fails with OnAgent.
        assert_eq!(
            result,
            Err(TogglePinError::OnAgent),
            "pin is per session, not per agent"
        );
    }

    #[rstest::rstest]
    fn toggle_settle_rejected_on_an_agent_row() {
        // Given the cursor on an agent row.
        let state = on_agent_row();

        // When validating a settle.
        let result = validate_toggle_settle(&state);

        // Then validation fails with OnAgent.
        assert_eq!(
            result,
            Err(ToggleSettleError::OnAgent),
            "settle is per session, not per agent"
        );
    }

    #[rstest::rstest]
    fn delete_allowed_on_a_working_session() {
        // Given a selected session whose agent is running a turn.
        let state = on_session(AgentStatus::Working);

        // When validating a delete.
        let result = validate_delete(&state);

        // Then it's allowed.
        assert_eq!(result, Ok(()), "a session can be deleted whatever it does");
    }

    #[rstest::rstest]
    fn delete_rejected_off_a_row() {
        // Given the cursor on nothing.
        let state = AppState::default();

        // When validating a delete.
        let result = validate_delete(&state);

        // Then validation fails with NoSelection.
        assert_eq!(
            result,
            Err(DeleteError::NoSelection),
            "nothing selected, nothing deleted"
        );
    }

    /// `on_session` with its session settled and the shelf `open` or not.
    fn on_settled(open: bool) -> AppState {
        let mut state = on_session(AgentStatus::Idle);
        state.sessions.shelf_open = open;
        if let Some(session) = state.sessions.sessions.first_mut() {
            session.settled_at = Some(SystemTime::UNIX_EPOCH);
        }
        state
    }

    #[rstest::rstest]
    fn fold_on_a_settled_session_in_the_open_shelf_folds_the_shelf() {
        // Given a settled session selected in the open shelf.
        let state = on_settled(true);

        // When validating a fold.
        let result = validate_fold(&state);

        // Then it folds the shelf.
        assert_eq!(
            result,
            Ok(FoldTarget::Shelf),
            "a settled row closes its shelf"
        );
    }

    #[rstest::rstest]
    fn fold_rejected_on_a_settled_session_while_the_shelf_is_closed() {
        // Given a settled session selected while the shelf is closed.
        let state = on_settled(false);

        // When validating a fold.
        let result = validate_fold(&state);

        // Then validation fails with NotInShelf.
        assert_eq!(
            result,
            Err(FoldError::NotInShelf),
            "a closed shelf can't close again"
        );
    }

    #[rstest::rstest]
    fn fold_on_a_card_with_agents_folds_the_card() {
        // Given an active session with an agent pane selected.
        let state = on_session(AgentStatus::Idle);

        // When validating a fold.
        let result = validate_fold(&state);

        // Then it folds the card.
        assert_eq!(
            result,
            Ok(FoldTarget::Card(SessionId(1))),
            "a card with agents folds"
        );
    }

    #[rstest::rstest]
    fn fold_on_an_agent_row_folds_its_card() {
        // Given session 1's agent row selected.
        let mut state = on_session(AgentStatus::Idle);
        state.sessions.cursor = Some(SidebarItem::Agent {
            session: SessionId(1),
            pane: PaneId(1),
        });

        // When validating a fold.
        let result = validate_fold(&state);

        // Then it folds session 1's card.
        assert_eq!(
            result,
            Ok(FoldTarget::Card(SessionId(1))),
            "h on an agent row folds its card"
        );
    }

    #[rstest::rstest]
    fn fold_rejected_on_a_card_without_agents() {
        // Given an active session whose only agent has no pane.
        let mut state = on_session(AgentStatus::Idle);
        for project in &mut state.sessions.projects {
            for agent in &mut project.agents {
                agent.pane = None;
            }
        }

        // When validating a fold.
        let result = validate_fold(&state);

        // Then validation fails with NoAgents.
        assert_eq!(
            result,
            Err(FoldError::NoAgents),
            "a card without agent rows has nothing to fold"
        );
    }

    #[rstest::rstest]
    fn unfold_rejected_on_an_agent_row() {
        // Given session 1's agent row selected.
        let mut state = on_session(AgentStatus::Idle);
        state.sessions.cursor = Some(SidebarItem::Agent {
            session: SessionId(1),
            pane: PaneId(1),
        });

        // When validating an unfold.
        let result = validate_unfold(&state);

        // Then validation fails with NotOnCard.
        assert_eq!(
            result,
            Err(UnfoldError::NotOnCard),
            "an agent row has nothing to open"
        );
    }

    #[rstest::rstest]
    fn unfold_rejected_on_a_settled_session() {
        // Given a settled session selected in the open shelf.
        let state = on_settled(true);

        // When validating an unfold.
        let result = validate_unfold(&state);

        // Then validation fails with Settled.
        assert_eq!(
            result,
            Err(UnfoldError::Settled),
            "a settled row has no agent rows"
        );
    }

    #[rstest::rstest]
    fn unfold_on_a_colonists_row_targets_it() {
        // Given session 1's colonists row selected.
        let mut state = on_session(AgentStatus::Idle);
        state.sessions.cursor = Some(SidebarItem::Colonists(SessionId(1)));

        // When validating an unfold.
        let result = validate_unfold(&state);

        // Then it targets that colonists row.
        assert_eq!(
            result,
            Ok(FoldTarget::Colonists(SessionId(1))),
            "l on a colonists row should open it"
        );
    }

    /// The `New colony` box holding `text`, for project 1, a world of `kind`.
    fn naming(kind: ProjectKind, text: &str) -> AppState {
        let mut state = crate::intent_handler::test_support::with_projects(&["kit"]);
        for project in &mut state.sessions.projects {
            project.kind = kind;
        }
        state.rename = Some(Rename {
            target: RenameTarget::NewColony(ProjectId(1)),
            input: TextInput::new(text),
            creating: false,
        });
        state
    }

    #[rstest::rstest]
    #[case("a/b", "/")]
    #[case("a\\b", "\\")]
    #[case("~x", "~")]
    #[case("a^b", "^")]
    #[case("a:b", ":")]
    #[case("a?b", "?")]
    #[case("a*b", "*")]
    #[case("a[b", "[")]
    #[case("-x", "-")]
    #[case(".x", ".")]
    #[case("a..b", "..")]
    fn new_folder_rejects_what_folders_cant_hold(#[case] text: &str, #[case] what: &str) {
        // Given the name box holding the text.
        let state = naming(ProjectKind::Research, text);

        // When validating the new folder.
        let result = validate_new_colony(&state);

        // Then it names what can't be used.
        assert_eq!(
            result,
            Err(NewColonyError::Invalid(what.to_owned())),
            "{text:?} should be refused"
        );
    }

    #[rstest::rstest]
    fn new_folder_rejects_an_empty_name() {
        // Given the name box holding only spaces.
        let state = naming(ProjectKind::Research, "   ");

        // When validating the new folder.
        let result = validate_new_colony(&state);

        // Then it's refused as empty.
        assert_eq!(result, Err(NewColonyError::Empty), "a blank name");
    }

    #[rstest::rstest]
    fn new_folder_while_creating_is_creating() {
        // Given the name box holding a fresh name that `⏎` already asked for.
        let mut state = naming(ProjectKind::Research, "tokio cancel");
        if let Some(rename) = &mut state.rename {
            rename.creating = true;
        }

        // When validating the new folder.
        let result = validate_new_colony(&state);

        // Then it's refused until the actor answers.
        assert_eq!(result, Err(NewColonyError::Creating), "a second ⏎");
    }

    #[rstest::rstest]
    fn new_folder_allowed_for_a_fresh_slug() {
        // Given the name box holding a fresh name.
        let state = naming(ProjectKind::Research, "tokio cancel");

        // When validating the new folder.
        let result = validate_new_colony(&state);

        // Then it's allowed.
        assert_eq!(result, Ok(()), "a fresh slug");
    }
}
