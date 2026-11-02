//! What the session keys do: making, folding, pinning, settling and deleting
//! sessions, and what the confirms and name boxes for them ask for.

use crate::command::{SessionsCommand, Workspace};
use crate::feat::git::intent::workspace_items;
use crate::feat::picker::intent::open_picker;
use crate::feat::picker::state::{PickTarget, PickerState};
use crate::feat::sessions::state::{ProjectKind, SessionKind, SidebarItem, folder_slug};
use crate::feat::sessions::validator::{
    COLONIST_WORKING, FoldTarget, NewColonyError, SETTLE_IN_PROGRESS, ToggleSettleError,
    validate_delete, validate_fold, validate_new_colony, validate_new_incognito,
    validate_new_session, validate_settle_colonists, validate_toggle_pin, validate_toggle_settle,
    validate_unfold,
};
use crate::feat::sidebar::state::{Rename, RenameTarget};
use crate::ids::{ProjectId, SessionId};
use crate::{AppState, Command, Focus, TextInput};

/// Asks for a new Incognito session in its checkout, clearing a filter to
/// another project.
pub(crate) fn new_incognito(state: &mut AppState) -> Vec<Command> {
    match (
        validate_new_incognito(state),
        validate_new_session(state),
        state
            .sessions
            .own_project(ProjectKind::Incognito)
            .map(|project| project.id),
    ) {
        (Ok(()), Ok(()), Some(project)) => {
            let mut commands = unfilter(state, project);
            commands.extend(new_session(state, project, Workspace::Checkout, None));
            commands
        }
        _ => vec![],
    }
}

/// Opens the Settled shelf, the card or the colonists row under the cursor.
pub(crate) fn unfold(state: &mut AppState) -> Vec<Command> {
    match validate_unfold(state) {
        Ok(FoldTarget::Shelf) => state.sessions.open_shelf(),
        Ok(FoldTarget::Card(id)) => state.sessions.unfold(id),
        Ok(FoldTarget::Colonists(id)) => state.sessions.unfold_colonists(id),
        Ok(FoldTarget::Move(item)) => state.sessions.cursor = Some(item),
        Err(_) => {}
    }
    vec![]
}

/// Closes the Settled shelf, the card or the colonists row under the
/// cursor, or moves the cursor up a level where there's nothing to fold.
pub(crate) fn fold(state: &mut AppState) -> Vec<Command> {
    match validate_fold(state) {
        Ok(FoldTarget::Shelf) => state.sessions.close_shelf(),
        Ok(FoldTarget::Card(id)) => state.sessions.fold(id),
        Ok(FoldTarget::Colonists(id)) => state.sessions.fold_colonists(id),
        Ok(FoldTarget::Move(item)) => state.sessions.cursor = Some(item),
        Err(_) => {}
    }
    vec![]
}

/// Pins the selected session to the top, or unpins it.
pub(crate) fn toggle_pin(state: &mut AppState) -> Vec<Command> {
    match (
        validate_toggle_pin(state),
        state.sessions.selected_session(),
    ) {
        (Ok(()), Some(session)) => match session.pinned_at {
            Some(_) => {
                vec![Command::Sessions(SessionsCommand::UnpinSession(session.id))]
            }
            None => vec![Command::Sessions(SessionsCommand::PinSession(session.id))],
        },
        _ => vec![],
    }
}

/// `s`: un-settles a settled session at once, or opens the settle confirm
/// for an unsettled one.
pub(crate) fn toggle_settle(state: &mut AppState) -> Vec<Command> {
    match (
        validate_toggle_settle(state),
        state.sessions.selected_session(),
    ) {
        (Ok(()), Some(session)) if session.settled_at.is_some() => {
            vec![Command::Sessions(SessionsCommand::UnsettleSession(
                session.id,
            ))]
        }
        (Ok(()), Some(session)) => {
            let colonists = !state.sessions.under(session.id).is_empty();
            let picker = PickerState::settle_session(session.id, colonists, state.focus);
            open_picker(state, picker);
            vec![]
        }
        (Err(ToggleSettleError::InProgress), _) => {
            state.sessions.error = Some(SETTLE_IN_PROGRESS.to_owned());
            vec![]
        }
        _ => vec![],
    }
}

/// `d`: opens the close confirm for an agent row, or the delete confirm for
/// a session row.
pub(crate) fn delete(state: &mut AppState) -> Vec<Command> {
    match (
        validate_delete(state),
        state.sessions.cursor_row(&state.layouts),
    ) {
        (Ok(()), Some(SidebarItem::Agent { session, pane })) => {
            open_picker(state, PickerState::close_pane(pane, session, state.focus));
            vec![]
        }
        (Ok(()), Some(SidebarItem::Session(id))) => {
            let folder = deletes_folder(state, id);
            let colonists = !state.sessions.under(id).is_empty();
            open_picker(
                state,
                PickerState::delete_session(id, folder, colonists, state.focus),
            );
            vec![]
        }
        _ => vec![],
    }
}

/// Filters the sidebar to `filter`'s project, or to all projects, and asks
/// for the filter to be saved.
pub(crate) fn filter_to(state: &mut AppState, filter: Option<ProjectId>) -> Vec<Command> {
    state.sessions.filter_to(filter, &state.layouts);
    vec![Command::Sessions(SessionsCommand::SaveUi)]
}

/// Asks for `project` to be removed. A filter to it goes back to all
/// projects.
pub(crate) fn remove_project(state: &mut AppState, project: ProjectId) -> Vec<Command> {
    if state.sessions.filter == Some(project) {
        state.sessions.filter = None;
    }
    vec![
        Command::Sessions(SessionsCommand::RemoveProject(project)),
        Command::Sessions(SessionsCommand::SaveUi),
    ]
}

/// Settles `session`, answered `Yes` or `Colony only` in its confirm (with
/// every unsettled session under it when `with_colonists`), if the cursor is
/// still on it, it is still unsettled and no agent pane has a turn underway:
/// they leave `attached` and the cursor moves to the neighbouring card. A
/// turn that started meanwhile shows the refusal on the mode line.
pub(crate) fn settle_session(
    state: &mut AppState,
    session: SessionId,
    with_colonists: bool,
) -> Vec<Command> {
    match (
        validate_toggle_settle(state),
        state.sessions.selected_session(),
    ) {
        (Ok(()), Some(selected)) if selected.id == session && selected.settled_at.is_none() => {
            if with_colonists && validate_settle_colonists(state, session).is_err() {
                state.sessions.error = Some(COLONIST_WORKING.to_owned());
                return vec![];
            }
            settle_now(state, session, with_colonists)
        }
        (Err(ToggleSettleError::InProgress), Some(selected)) if selected.id == session => {
            state.sessions.error = Some(SETTLE_IN_PROGRESS.to_owned());
            vec![]
        }
        _ => vec![],
    }
}

/// Settles `session` on the screen side, with every unsettled session under
/// it when `with_colonists`: they leave `attached` and stop being active, a
/// cursor on `session` moves to the neighbouring card, and the sessions
/// actor is asked to settle.
pub(crate) fn settle_now(
    state: &mut AppState,
    session: SessionId,
    with_colonists: bool,
) -> Vec<Command> {
    let colonists = if with_colonists {
        state.sessions.under(session)
    } else {
        vec![]
    };
    for id in std::iter::once(session).chain(colonists.iter().copied()) {
        state.attached.remove(&id);
        state.sessions.leave(id);
    }
    if state
        .sessions
        .selected_session()
        .map(|selected| selected.id)
        == Some(session)
    {
        state.sessions.cursor = state.sessions.card_neighbour(
            SidebarItem::Session(session),
            &state.layouts,
            &colonists,
        );
    }
    vec![Command::Sessions(SessionsCommand::SettleSession {
        session,
        with_colonists,
    })]
}

/// Whether `item`, answered `Yes` in its delete or discard confirm, is still
/// under the cursor and can still be deleted.
pub(crate) fn still_deletable(state: &AppState, item: SidebarItem) -> bool {
    state.sessions.cursor_row(&state.layouts) == Some(item) && validate_delete(state).is_ok()
}

/// Hides `session` (with every unsettled session under it when
/// `with_colonists`) at once, detaches it, drops it from the jump list, moves
/// the sidebar cursor to the neighbouring row when it was on `session`, and
/// asks for the delete.
pub(crate) fn delete_session(
    state: &mut AppState,
    session: SessionId,
    with_colonists: bool,
) -> Vec<Command> {
    if with_colonists {
        for id in state.sessions.under(session) {
            state.sessions.deleting.insert(id);
            state.attached.remove(&id);
            state.sessions.leave(id);
            state.jumps.remove(SidebarItem::Session(id));
        }
    }
    let on_it = state
        .sessions
        .selected_session()
        .map(|selected| selected.id)
        == Some(session);
    let neighbour = state
        .sessions
        .row_neighbour(SidebarItem::Session(session), &state.layouts);
    state.sessions.deleting.insert(session);
    state.attached.remove(&session);
    state.sessions.leave(session);
    state.jumps.remove(SidebarItem::Session(session));
    if on_it {
        state.sessions.cursor = neighbour;
    }
    vec![
        Command::Sessions(SessionsCommand::DeleteSession {
            session,
            with_colonists,
        }),
        Command::Sessions(SessionsCommand::SaveJumps),
    ]
}

/// Picks `project` in the new-session picker: a filter to another project
/// goes back to all projects, and the empty `New session` name box opens,
/// giving the keys back to where the picker was opened from when it closes.
pub(crate) fn pick_project(state: &mut AppState, project: ProjectId) -> Vec<Command> {
    if state.sessions.project(project).is_none() {
        return vec![];
    }
    let return_to = state.focus;
    let commands = unfilter(state, project);
    state.rename = Some(Rename {
        target: RenameTarget::NewSession { project, return_to },
        input: TextInput::default(),
        creating: false,
    });
    state.focus = Focus::Rename;
    commands
}

/// `⏎` in the `New session` box: the keys go back to `return_to`; a git
/// project goes on to the workspace picker, any other gets its session in
/// its checkout at once. A blank name leaves the session unnamed.
pub(crate) fn confirm_session_name(
    state: &mut AppState,
    project: ProjectId,
    return_to: Focus,
) -> Vec<Command> {
    let name = state.rename.take().and_then(|rename| {
        let name = rename.input.text().trim();
        (!name.is_empty()).then(|| name.to_owned())
    });
    state.focus = return_to;
    let Some(found) = state.sessions.project(project) else {
        return vec![];
    };
    if !found.repo {
        return new_session(state, project, Workspace::Checkout, name);
    }
    let items = workspace_items(&state.sessions, found, &found.root, false);
    let picker = PickerState::workspace(PickTarget::New { project, name }, items, return_to);
    open_picker(state, picker);
    vec![]
}

/// Clears a sidebar filter to a project other than `project`, asking for
/// that to be saved.
fn unfilter(state: &mut AppState, project: ProjectId) -> Vec<Command> {
    let outside = state
        .sessions
        .filter
        .is_some_and(|filter| filter != project);
    if outside {
        state.sessions.filter = None;
    }
    outside
        .then_some(Command::Sessions(SessionsCommand::SaveUi))
        .into_iter()
        .collect()
}

/// Opens the empty `New colony` box for a colony in `world`.
pub(crate) fn open_colony_name(state: &mut AppState, world: ProjectId) -> Vec<Command> {
    state.rename = Some(Rename {
        target: RenameTarget::NewColony(world),
        input: TextInput::default(),
        creating: false,
    });
    state.focus = Focus::Rename;
    vec![]
}

/// Whether deleting `session` also deletes its folder: a colony in a fresh
/// world.
fn deletes_folder(state: &AppState, session: SessionId) -> bool {
    state.sessions.session(session).is_some_and(|session| {
        session.kind == SessionKind::Colony
            && state
                .sessions
                .project(session.project)
                .is_some_and(|project| project.kind.is_fresh_world())
    })
}

/// `⏎` in the `New colony` box: an empty folder name in a fresh world, one
/// already asked for, a gone world, or one while another session is being
/// made does nothing; an invalid folder name shows why on the mode line,
/// keeping the box open; a valid one asks for the colony, and the sessions
/// actor closes the box once it's made.
pub(crate) fn confirm_colony_name(state: &mut AppState) -> Vec<Command> {
    match (validate_new_colony(state), validate_new_session(state)) {
        (Err(NewColonyError::Invalid(what)), _) => {
            state.sessions.error = Some(format!("Name can't use {what}"));
        }
        (Ok(()), Ok(())) => return new_colony(state),
        _ => {}
    }
    vec![]
}

/// Asks the sessions actor for the colony the box names, keeping the box
/// open until the actor answers: a fresh world's folder slug, or a shared
/// world's trimmed name (empty = unnamed). Marks the start and records the
/// row it leaves as a jump, as [`new_session`] does.
fn new_colony(state: &mut AppState) -> Vec<Command> {
    let Some(Rename {
        target: RenameTarget::NewColony(world),
        input,
        creating,
    }) = &mut state.rename
    else {
        return vec![];
    };
    *creating = true;
    let world = *world;
    let fresh = state
        .sessions
        .project(world)
        .is_some_and(|project| project.kind.is_fresh_world());
    let name = if fresh {
        folder_slug(input.text())
    } else {
        input.text().trim().to_owned()
    };
    let command = Command::Sessions(SessionsCommand::NewColony {
        world,
        name,
        if_active: state.sessions.active(),
    });
    state.sessions.starting = true;
    state.jumps.jump(state.sessions.cursor, None);
    vec![command, Command::Sessions(SessionsCommand::SaveJumps)]
}

/// Asks for a new session of `project` in `workspace`, named `name`, one at
/// a time: marks the start and records the row it leaves as a jump
/// (`attach_session` records the new session's row when the frontend
/// attaches it).
pub(crate) fn new_session(
    state: &mut AppState,
    project: ProjectId,
    workspace: Workspace,
    name: Option<String>,
) -> Vec<Command> {
    if validate_new_session(state).is_err() {
        return vec![];
    }
    state.sessions.starting = true;
    state.jumps.jump(state.sessions.cursor, None);
    let if_active = state.sessions.active();
    vec![
        Command::Sessions(SessionsCommand::NewSession {
            project,
            workspace,
            name,
            if_active,
        }),
        Command::Sessions(SessionsCommand::SaveJumps),
    ]
}

/// The visit for the agent pane the keys landed in, when it isn't `left`,
/// the agent whose pane had them before the intent.
pub(crate) fn visit_entered_pane(state: &AppState, left: Option<SidebarItem>) -> Option<Command> {
    let entered = (state.focus == Focus::Pane)
        .then(|| state.focused_agent())
        .flatten();
    match entered {
        Some(SidebarItem::Agent { pane, .. }) if entered != left => {
            Some(Command::Sessions(SessionsCommand::Visit(pane)))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use crate::command::{SessionsCommand, Workspace};
    use crate::feat::picker::list::PickerItem;
    use crate::feat::picker::state::PickerKind;
    use crate::feat::sessions::state::{AgentStatus, ProjectKind, SessionKind, SidebarItem};
    use crate::feat::sessions::validator::SETTLE_IN_PROGRESS;
    use crate::ids::{PaneId, ProjectId, SessionId};
    use crate::intent_handler::test_support::{
        agent, at, colony_with_colonists, incognito, on_agent_in_another_tab, settle, state_at,
        state_with, stopped,
    };
    use crate::{AppState, Command, Intent, IntentHandler};

    #[rstest::rstest]
    fn l_on_the_shelf_opens_it() {
        // Given the cursor on the collapsed Settled header.
        let mut state = settle(state_at(vec![stopped(1)], SidebarItem::SettledShelf), &[1]);

        // When handling Unfold on the header.
        IntentHandler::handle(&Intent::Unfold, &mut state);

        // Then the shelf is open.
        assert!(
            state.sessions.shelf_open,
            "l on the header should open the shelf"
        );
    }

    #[rstest::rstest]
    fn h_on_a_settled_agent_closes_the_shelf_and_selects_it() {
        // Given the shelf open and the cursor on settled agent 1.
        let mut state = settle(state_with(vec![stopped(1)], 1), &[1]);
        state.sessions.shelf_open = true;

        // When handling Fold.
        IntentHandler::handle(&Intent::Fold, &mut state);

        // Then the shelf is closed with its header selected.
        assert_eq!(
            (state.sessions.shelf_open, state.sessions.cursor),
            (false, Some(SidebarItem::SettledShelf)),
            "h in the shelf should close it onto its header"
        );
    }

    #[rstest::rstest]
    fn h_on_an_active_card_keeps_the_shelf_open() {
        // Given the shelf open and the cursor on active agent 1.
        let mut state = settle(
            state_with(vec![agent(1, AgentStatus::Idle), stopped(2)], 1),
            &[2],
        );
        state.sessions.shelf_open = true;

        // When handling Fold.
        IntentHandler::handle(&Intent::Fold, &mut state);

        // Then the shelf and cursor are unchanged.
        assert_eq!(
            (state.sessions.shelf_open, state.sessions.cursor),
            (true, Some(SidebarItem::Session(SessionId(1)))),
            "h on a card leaves the shelf alone"
        );
    }

    #[rstest::rstest]
    fn settle_on_a_settled_agent_returns_unsettle() {
        // Given a selected settled agent.
        let mut state = settle(state_with(vec![stopped(1)], 1), &[1]);

        // When handling ToggleSettle.
        let commands = IntentHandler::handle(&Intent::ToggleSettle, &mut state);

        // Then the sessions actor is asked to un-settle it.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::UnsettleSession(
                SessionId(1)
            ))],
            "ToggleSettle on a settled agent should return Unsettle"
        );
    }

    #[rstest::rstest]
    fn settle_on_a_settled_agent_keeps_the_cursor() {
        // Given a selected settled agent.
        let mut state = settle(state_with(vec![stopped(1)], 1), &[1]);

        // When handling ToggleSettle.
        IntentHandler::handle(&Intent::ToggleSettle, &mut state);

        // Then the cursor stays on it.
        assert_eq!(
            state.sessions.cursor,
            Some(SidebarItem::Session(SessionId(1))),
            "un-settle should keep the cursor on the agent"
        );
    }

    #[rstest::rstest]
    fn toggle_pin_on_a_session_returns_pin_session() {
        // Given a selected unpinned session.
        let mut state = state_with(vec![agent(1, AgentStatus::Idle)], 1);

        // When handling TogglePin.
        let commands = IntentHandler::handle(&Intent::TogglePin, &mut state);

        // Then the sessions actor is asked to pin it.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::PinSession(SessionId(1)))],
            "p on an unpinned session pins it"
        );
    }

    #[rstest::rstest]
    fn toggle_pin_on_a_pinned_agent_returns_unpin() {
        // Given a selected pinned agent.
        let mut state = state_with(vec![agent(1, AgentStatus::Idle)], 1);
        if let Some(session) = state.sessions.sessions.get_mut(0) {
            session.pinned_at = Some(at(1));
        }

        // When handling TogglePin.
        let commands = IntentHandler::handle(&Intent::TogglePin, &mut state);

        // Then the sessions actor is asked to unpin it.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::UnpinSession(SessionId(
                1
            )))],
            "TogglePin on a pinned agent should return Unpin"
        );
    }

    /// The open picker's kind and selected item.
    fn open_confirm(state: &AppState) -> Option<(&PickerKind, Option<&PickerItem>)> {
        state
            .picker
            .as_ref()
            .map(|picker| (picker.kind(), picker.selected()))
    }

    #[rstest::rstest]
    fn toggle_settle_on_a_session_opens_its_confirm() {
        // Given a selected idle agent.
        let mut state = state_with(vec![agent(1, AgentStatus::Idle)], 1);

        // When handling ToggleSettle.
        IntentHandler::handle(&Intent::ToggleSettle, &mut state);

        // Then its settle confirm is open with No selected.
        assert_eq!(
            open_confirm(&state),
            Some((
                &PickerKind::SettleSession {
                    session: SessionId(1)
                },
                Some(&PickerItem::Confirm(false))
            )),
            "s should ask to settle the agent"
        );
    }

    /// The rows of the open picker.
    fn picker_rows(state: &AppState) -> Vec<PickerItem> {
        state
            .picker
            .as_ref()
            .map(|picker| picker.shown().map(|(item, _)| item.clone()).collect())
            .unwrap_or_default()
    }

    #[rstest::rstest]
    fn toggle_settle_on_a_colony_with_colonists_offers_three_rows() {
        // Given a selected colony with a colonist, which has its own.
        let mut state = colony_with_colonists([AgentStatus::Idle; 3]);

        // When handling ToggleSettle.
        IntentHandler::handle(&Intent::ToggleSettle, &mut state);

        // Then the confirm offers No, Colony only and With colonists.
        assert_eq!(
            picker_rows(&state),
            [
                PickerItem::Confirm(false),
                PickerItem::Covers { colonists: false },
                PickerItem::Covers { colonists: true },
            ],
            "s on a colony with colonists should offer three rows"
        );
    }

    #[rstest::rstest]
    fn toggle_settle_without_colonists_keeps_two_rows() {
        // Given a selected idle agent with no colonists.
        let mut state = state_with(vec![agent(1, AgentStatus::Idle)], 1);

        // When handling ToggleSettle.
        IntentHandler::handle(&Intent::ToggleSettle, &mut state);

        // Then the confirm offers No and Yes.
        assert_eq!(
            picker_rows(&state),
            [PickerItem::Confirm(false), PickerItem::Confirm(true)],
            "s without colonists should offer No and Yes"
        );
    }

    #[rstest::rstest]
    fn delete_on_a_colony_with_colonists_offers_three_rows() {
        // Given a selected colony with a colonist, which has its own.
        let mut state = colony_with_colonists([AgentStatus::Idle; 3]);

        // When handling Delete.
        IntentHandler::handle(&Intent::Delete, &mut state);

        // Then the confirm offers No, Colony only and With colonists.
        assert_eq!(
            picker_rows(&state),
            [
                PickerItem::Confirm(false),
                PickerItem::Covers { colonists: false },
                PickerItem::Covers { colonists: true },
            ],
            "d on a colony with colonists should offer three rows"
        );
    }

    #[rstest::rstest]
    fn settle_on_a_settled_agent_opens_no_confirm() {
        // Given a selected settled agent.
        let mut state = settle(state_with(vec![stopped(1)], 1), &[1]);

        // When handling ToggleSettle.
        IntentHandler::handle(&Intent::ToggleSettle, &mut state);

        // Then no confirm opens.
        assert!(state.picker.is_none(), "un-settling needs no confirm");
    }

    #[rstest::rstest]
    fn settle_is_refused_while_an_agent_works() {
        // Given a selected agent Claude is working in.
        let mut state = state_with(vec![agent(1, AgentStatus::Working)], 1);

        // When handling ToggleSettle.
        IntentHandler::handle(&Intent::ToggleSettle, &mut state);

        // Then the mode line says it can't settle.
        assert_eq!(
            state.sessions.error.as_deref(),
            Some(SETTLE_IN_PROGRESS),
            "s on a working agent should say why it can't settle"
        );
    }

    #[rstest::rstest]
    fn settle_on_a_working_agent_opens_no_confirm() {
        // Given a selected agent Claude is working in.
        let mut state = state_with(vec![agent(1, AgentStatus::Working)], 1);

        // When handling ToggleSettle.
        IntentHandler::handle(&Intent::ToggleSettle, &mut state);

        // Then no confirm opens.
        assert!(
            state.picker.is_none(),
            "an agent that can't be settled should not ask to settle"
        );
    }

    #[rstest::rstest]
    fn delete_opens_the_delete_confirm_with_no_selected() {
        // Given a selected agent.
        let mut state = state_with(vec![agent(1, AgentStatus::Idle)], 1);

        // When handling DeleteAgent.
        IntentHandler::handle(&Intent::Delete, &mut state);

        // Then its delete confirm is open with No selected.
        assert_eq!(
            open_confirm(&state),
            Some((
                &PickerKind::DeleteSession {
                    session: SessionId(1),
                    folder: false
                },
                Some(&PickerItem::Confirm(false))
            )),
            "d should ask to delete the agent"
        );
    }

    #[rstest::rstest]
    #[case(ProjectKind::Research)]
    #[case(ProjectKind::FreshWorld)]
    fn delete_on_a_fresh_world_colony_asks_to_delete_its_folder(#[case] kind: ProjectKind) {
        // Given a selected colony in a fresh world of `kind`.
        let mut state = state_with(vec![agent(1, AgentStatus::Idle)], 1);
        if let Some(project) = state.sessions.projects.first_mut() {
            project.kind = kind;
        }
        if let Some(session) = state.sessions.sessions.first_mut() {
            session.kind = SessionKind::Colony;
        }

        // When handling Delete.
        IntentHandler::handle(&Intent::Delete, &mut state);

        // Then its delete confirm says it takes the folder.
        assert_eq!(
            open_confirm(&state).map(|(kind, _)| kind),
            Some(&PickerKind::DeleteSession {
                session: SessionId(1),
                folder: true
            }),
            "d on a {kind:?} colony should ask to delete its folder too"
        );
    }

    #[rstest::rstest]
    fn new_incognito_opens_no_name_box() {
        // Given the Incognito project.
        let mut state = incognito();

        // When handling NewIncognito.
        IntentHandler::handle(&Intent::NewIncognito, &mut state);

        // Then no name box is open.
        assert!(state.rename.is_none(), "␣i asks no name");
    }

    #[rstest::rstest]
    fn new_incognito_returns_new_session_in_the_incognito_checkout() {
        // Given the Incognito project.
        let mut state = incognito();

        // When handling NewIncognito.
        let commands = IntentHandler::handle(&Intent::NewIncognito, &mut state);

        // Then a session in the Incognito folder is asked for.
        assert!(
            commands.contains(&Command::Sessions(SessionsCommand::NewSession {
                project: ProjectId(2),
                workspace: Workspace::Checkout,
                name: None,
                if_active: None,
            })),
            "NewIncognito should ask for a session in the Incognito folder, got {commands:?}"
        );
    }

    #[rstest::rstest]
    fn new_incognito_marks_starting() {
        // Given the Incognito project and no start in flight.
        let mut state = incognito();

        // When handling NewIncognito.
        IntentHandler::handle(&Intent::NewIncognito, &mut state);

        // Then a start is in flight.
        assert!(
            state.sessions.starting,
            "a new Incognito session should mark a start in flight"
        );
    }

    #[rstest::rstest]
    fn new_incognito_while_starting_returns_nothing() {
        // Given the Incognito project while a start is in flight.
        let mut state = incognito();
        state.sessions.starting = true;

        // When handling NewIncognito.
        let commands = IntentHandler::handle(&Intent::NewIncognito, &mut state);

        // Then nothing is asked for.
        assert!(commands.is_empty(), "one new session at a time");
    }

    #[rstest::rstest]
    fn new_incognito_clears_a_filter_to_another_project() {
        // Given the sidebar filtered to alpha.
        let mut state = incognito();
        state.sessions.filter = Some(ProjectId(1));

        // When handling NewIncognito.
        IntentHandler::handle(&Intent::NewIncognito, &mut state);

        // Then the filter is cleared.
        assert_eq!(
            state.sessions.filter, None,
            "a filter hiding the new Incognito session should be cleared"
        );
    }

    #[rstest::rstest]
    fn delete_on_an_agent_row_opens_the_close_pane_confirm() {
        // Given the cursor on the agent row of pane 1.
        let mut state = on_agent_in_another_tab();

        // When handling Delete.
        IntentHandler::handle(&Intent::Delete, &mut state);

        // Then the confirm for closing pane 1 is open with No selected.
        assert_eq!(
            open_confirm(&state),
            Some((
                &PickerKind::ClosePane {
                    pane: PaneId(1),
                    session: SessionId(1)
                },
                Some(&PickerItem::Confirm(false))
            )),
            "d on an agent row should ask to close its pane"
        );
    }

    /// Session 1's card with its agent row, the cursor on `cursor`, folded
    /// or not.
    fn card_at(cursor: SidebarItem, folded: bool) -> AppState {
        let mut state = state_at(vec![agent(1, AgentStatus::Idle)], cursor);
        if folded {
            state.sessions.folded.insert(SessionId(1));
        }
        state
    }

    const AGENT_1: SidebarItem = SidebarItem::Agent {
        session: SessionId(1),
        pane: PaneId(1),
    };

    #[rstest::rstest]
    fn unfold_on_a_folded_card_unfolds_it() {
        // Given session 1's card folded, with the cursor on it.
        let mut state = card_at(SidebarItem::Session(SessionId(1)), true);

        // When handling Unfold (`l`).
        IntentHandler::handle(&Intent::Unfold, &mut state);

        // Then the card is open.
        assert!(
            !state.sessions.folded.contains(&SessionId(1)),
            "l should open the card"
        );
    }

    #[rstest::rstest]
    fn fold_on_a_card_folds_it() {
        // Given session 1's open card, with the cursor on it.
        let mut state = card_at(SidebarItem::Session(SessionId(1)), false);

        // When handling Fold (`h`).
        IntentHandler::handle(&Intent::Fold, &mut state);

        // Then the card is folded.
        assert!(
            state.sessions.folded.contains(&SessionId(1)),
            "h should fold the card"
        );
    }

    #[rstest::rstest]
    fn fold_on_an_agent_row_folds_its_card() {
        // Given the cursor on session 1's agent row.
        let mut state = card_at(AGENT_1, false);

        // When handling Fold (`h`).
        IntentHandler::handle(&Intent::Fold, &mut state);

        // Then session 1's card is folded.
        assert!(
            state.sessions.folded.contains(&SessionId(1)),
            "h on an agent row should fold its card"
        );
    }

    #[rstest::rstest]
    fn fold_on_an_agent_row_moves_the_cursor_to_its_card() {
        // Given the cursor on session 1's agent row.
        let mut state = card_at(AGENT_1, false);

        // When handling Fold (`h`).
        IntentHandler::handle(&Intent::Fold, &mut state);

        // Then the cursor is on session 1's card.
        assert_eq!(
            state.sessions.cursor,
            Some(SidebarItem::Session(SessionId(1))),
            "the folded row's cursor moves to its card"
        );
    }

    #[rstest::rstest]
    fn unfold_on_an_agent_row_does_nothing() {
        // Given the cursor on session 1's agent row, the card open.
        let mut state = card_at(AGENT_1, false);

        // When handling Unfold (`l`).
        IntentHandler::handle(&Intent::Unfold, &mut state);

        // Then the cursor stays and nothing is folded.
        assert_eq!(
            (state.sessions.cursor, state.sessions.folded.is_empty()),
            (Some(AGENT_1), true),
            "l on an agent row should do nothing"
        );
    }

    #[rstest::rstest]
    fn fold_and_unfold_on_a_card_without_agents_do_nothing(
        #[values(Intent::Fold, Intent::Unfold)] intent: Intent,
    ) {
        // Given session 1's card whose agent pane has closed.
        let mut state = card_at(SidebarItem::Session(SessionId(1)), false);
        for project in &mut state.sessions.projects {
            for agent in &mut project.agents {
                agent.pane = None;
            }
        }

        // When handling `intent`.
        IntentHandler::handle(&intent, &mut state);

        // Then nothing is folded.
        assert!(
            state.sessions.folded.is_empty(),
            "{intent:?} has no agent rows to act on"
        );
    }

    #[rstest::rstest]
    fn h_on_the_open_shelf_header_closes_it() {
        // Given the cursor on the open Settled header.
        let mut state = settle(state_at(vec![stopped(1)], SidebarItem::SettledShelf), &[1]);
        state.sessions.shelf_open = true;

        // When handling Fold (`h`).
        IntentHandler::handle(&Intent::Fold, &mut state);

        // Then the shelf is closed.
        assert!(
            !state.sessions.shelf_open,
            "h on the header should close the shelf"
        );
    }

    #[rstest::rstest]
    fn l_on_a_colonists_row_opens_it() {
        // Given the cursor on colony 1's folded colonists row.
        let mut state = colony_with_colonists([AgentStatus::Idle; 3]);
        state.sessions.cursor = Some(SidebarItem::Colonists(SessionId(1)));

        // When handling Unfold (`l`).
        IntentHandler::handle(&Intent::Unfold, &mut state);

        // Then the colonists row is open.
        assert!(
            state.sessions.colonists_open.contains(&SessionId(1)),
            "l on a colonists row should open it"
        );
    }

    #[rstest::rstest]
    fn h_on_an_open_colonists_row_folds_it() {
        // Given the cursor on colony 1's open colonists row.
        let mut state = colony_with_colonists([AgentStatus::Idle; 3]);
        state.sessions.colonists_open.insert(SessionId(1));
        state.sessions.cursor = Some(SidebarItem::Colonists(SessionId(1)));

        // When handling Fold (`h`).
        IntentHandler::handle(&Intent::Fold, &mut state);

        // Then the colonists row is folded.
        assert!(
            !state.sessions.colonists_open.contains(&SessionId(1)),
            "h on an open colonists row should fold it"
        );
    }

    #[rstest::rstest]
    fn h_on_a_folded_colonists_row_moves_to_its_card() {
        // Given the cursor on colony 1's folded colonists row.
        let mut state = colony_with_colonists([AgentStatus::Idle; 3]);
        state.sessions.cursor = Some(SidebarItem::Colonists(SessionId(1)));

        // When handling Fold (`h`).
        IntentHandler::handle(&Intent::Fold, &mut state);

        // Then the cursor is on colony 1's card.
        assert_eq!(
            state.sessions.cursor,
            Some(SidebarItem::Session(SessionId(1))),
            "h on a folded colonists row should move to its card"
        );
    }

    #[rstest::rstest]
    fn h_on_a_colonist_with_open_agent_rows_folds_them() {
        // Given colony 1's colonists row open and the cursor on colonist 2,
        // whose agent row shows.
        let mut state = colony_with_colonists([AgentStatus::Idle; 3]);
        state.sessions.colonists_open.insert(SessionId(1));
        state.sessions.cursor = Some(SidebarItem::Session(SessionId(2)));

        // When handling Fold (`h`).
        IntentHandler::handle(&Intent::Fold, &mut state);

        // Then colonist 2's card is folded.
        assert!(
            state.sessions.folded.contains(&SessionId(2)),
            "h on a colonist with open agent rows should fold them"
        );
    }

    #[rstest::rstest]
    fn h_on_a_colonist_without_open_agent_rows_moves_to_its_colonists_row() {
        // Given every colonists row open and the cursor on colonist 3, whose
        // one agent shows no row.
        let mut state = colony_with_colonists([AgentStatus::Idle; 3]);
        state
            .sessions
            .colonists_open
            .extend([SessionId(1), SessionId(2)]);
        state.sessions.cursor = Some(SidebarItem::Session(SessionId(3)));

        // When handling Fold (`h`).
        IntentHandler::handle(&Intent::Fold, &mut state);

        // Then the cursor is on colonist 2's colonists row.
        assert_eq!(
            state.sessions.cursor,
            Some(SidebarItem::Colonists(SessionId(2))),
            "h on a colonist without agent rows should move up to its colonists row"
        );
    }

    #[rstest::rstest]
    fn h_on_a_colonist_of_a_settled_colony_stays_put() {
        // Given colony 1 settled in the open shelf, and the cursor on its
        // colonist 2, lifted to the top level with its card folded.
        let mut state = settle(colony_with_colonists([AgentStatus::Idle; 3]), &[1]);
        state.sessions.shelf_open = true;
        state.sessions.folded.insert(SessionId(2));
        state.sessions.cursor = Some(SidebarItem::Session(SessionId(2)));

        // When handling Fold (`h`).
        IntentHandler::handle(&Intent::Fold, &mut state);

        // Then the cursor stays on colonist 2.
        assert_eq!(
            state.sessions.cursor,
            Some(SidebarItem::Session(SessionId(2))),
            "h on a top-level colonist shouldn't move to its settled colony"
        );
    }
}
