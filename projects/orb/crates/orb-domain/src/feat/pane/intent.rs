//! What the pane keys do: moving the keys from the sidebar into a session's
//! panes and back.

use crate::command::SessionsCommand;
use crate::feat::pane::validator::validate_attach;
use crate::feat::sessions::state::SidebarItem;
use crate::ids::SessionId;
use crate::{AppState, Command, Focus};

/// `⏎` on a sidebar row: on the settled shelf or a colonists row opens or
/// closes it; on an agent row, or on the card of a colonist whose one agent
/// shows no row, reveals that agent's pane and attaches; else attaches to
/// the selected session.
pub(crate) fn attach(state: &mut AppState) -> Vec<Command> {
    match state.sessions.cursor {
        Some(SidebarItem::SettledShelf) => {
            if state.sessions.shelf_open {
                state.sessions.close_shelf();
            } else {
                state.sessions.open_shelf();
            }
            return vec![];
        }
        Some(SidebarItem::Colonists(id)) => {
            if state.sessions.colonists_open.contains(&id) {
                state.sessions.fold_colonists(id);
            } else {
                state.sessions.unfold_colonists(id);
            }
            return vec![];
        }
        _ => {}
    }
    let agent = state.sessions.selected_agent(&state.layouts).or_else(|| {
        let id = state.sessions.selected_session()?.id;
        if !state.sessions.hides_one_agent(id, &state.layouts) {
            return None;
        }
        let pane = state.sessions.agent_rows(id, &state.layouts).first()?.1;
        Some((id, pane))
    });
    match agent {
        Some((session, pane)) => {
            state.layouts.reveal(session, pane);
            let mut commands = attach_session(state);
            commands.push(Command::Sessions(SessionsCommand::SaveLayout(session)));
            commands
        }
        None => attach_session(state),
    }
}

/// Moves the keys from the sidebar into the right-hand area.
pub(crate) fn focus_panes(state: &mut AppState) -> Vec<Command> {
    match state.focus {
        Focus::Sidebar => focus_right(state),
        _ => vec![],
    }
}

/// Moves the keys from a pane to the sidebar, showing it if it's hidden.
pub(crate) fn leave_pane(state: &mut AppState) -> Vec<Command> {
    match state.focus {
        Focus::Pane => {
            state.sidebar.hidden = false;
            state.focus = Focus::Sidebar;
            vec![
                Command::Detach,
                Command::Sessions(SessionsCommand::RefreshSessions),
            ]
        }
        _ => vec![],
    }
}

/// Attaches to the selected session and records entering it as a jump (see
/// [`enter_session`]), unless it can't be attached to. The cursor lands on
/// the session's active row.
pub(crate) fn attach_session(state: &mut AppState) -> Vec<Command> {
    match (
        validate_attach(state),
        state.sessions.selected_session().map(|session| session.id),
    ) {
        (Ok(()), Some(id)) => {
            let commands = enter_session(state, id);
            state.sessions.cursor = state.active_row();
            commands
        }
        _ => vec![],
    }
}

/// [`show_session`] `id`, recording entering it as a jump to the agent in
/// its focused pane (a shell pane records the card), unless that is where
/// the last `<C-[>`/`<C-]>` landed.
pub(crate) fn enter_session(state: &mut AppState, id: SessionId) -> Vec<Command> {
    let mut commands = show_session(state, id);
    if state.jumps.enter(state.entry_row(id)) {
        commands.push(Command::Sessions(SessionsCommand::SaveJumps));
    }
    commands
}

/// Attaches to the selected session (see [`show_session`]), unless it can't
/// be attached to.
pub(crate) fn show_pane(state: &mut AppState) -> Vec<Command> {
    match (
        validate_attach(state),
        state.sessions.selected_session().map(|session| session.id),
    ) {
        (Ok(()), Some(id)) => show_session(state, id),
        _ => vec![],
    }
}

/// Makes session `id` active and attaches to it, adding it to the attached
/// sessions and showing its layout with the keys in its focused pane. A
/// settled session is un-settled first. A session with no layout (its last
/// pane closed) gets a tab of one shell; the sessions actor then asks to
/// attach it, and the keys stay where they are until then. The keys always
/// arrive with no pane mode on.
fn show_session(state: &mut AppState, id: SessionId) -> Vec<Command> {
    let settled = state
        .sessions
        .session(id)
        .is_some_and(|session| session.settled_at.is_some());
    state.sessions.enter(id);
    let unsettle = settled.then_some(Command::Sessions(SessionsCommand::UnsettleSession(id)));
    match state.layouts.get(id) {
        Some(_) => {
            state.focus = Focus::Pane;
            state.pane_mode = None;
            state.attached.insert(id);
            unsettle
                .into_iter()
                .chain([
                    Command::Attach(id),
                    Command::Sessions(SessionsCommand::RefreshSessions),
                ])
                .collect()
        }
        None => unsettle
            .into_iter()
            .chain([Command::Sessions(SessionsCommand::NewTab(id))])
            .collect(),
    }
}

/// Moves the keys into the right-hand area: into the hovered session while
/// it's attached, else into the shown session with the cursor on its active
/// row; with nothing shown they stay put.
pub(crate) fn focus_right(state: &mut AppState) -> Vec<Command> {
    match state.sessions.selected_session().map(|session| session.id) {
        Some(id) if state.attached.contains(&id) && validate_attach(state).is_ok() => {
            attach_session(state)
        }
        _ => match (state.shown_session(), state.active_row()) {
            (Some(_), Some(row)) => {
                state.sessions.cursor = Some(row);
                attach_session(state)
            }
            _ => vec![],
        },
    }
}

#[cfg(test)]
mod tests {
    use crate::command::SessionsCommand;
    use crate::feat::layout::state::{Layouts, SessionLayout, test_entry};
    use crate::feat::sessions::state::{AgentStatus, SidebarItem};
    use crate::feat::sidebar::state::SidebarView;
    use crate::ids::{PaneId, SessionId};
    use crate::intent_handler::test_support::{
        agent, agent_row, attached, colony_with_colonists, jumping, left_pane, left_pane_showing_1,
        on_agent, on_agent_in_another_tab, settle, shown_focus, split_layout, state_at, state_with,
        stopped, two_agents_from_sidebar, two_projects, with_layout,
    };
    use crate::{AppState, Command, Focus, Intent, IntentHandler, PaneMode};

    #[rstest::rstest]
    fn attach_to_live_agent_sets_focus_attached() {
        // Given a selected idle agent.
        let mut state = state_with(vec![agent(1, AgentStatus::Idle)], 1);

        // When handling Attach.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then keys go to the session.
        assert_eq!(state.focus, Focus::Pane, "Attach should focus the session");
    }

    #[rstest::rstest]
    fn attach_to_live_agent_returns_attach_and_refresh() {
        // Given a selected idle agent.
        let mut state = state_with(vec![agent(1, AgentStatus::Idle)], 1);

        // When handling Attach.
        let commands = IntentHandler::handle(&Intent::Attach, &mut state);

        // Then the loop attaches to that agent, the statuses are refreshed
        // and its pane is visited.
        assert_eq!(
            commands,
            vec![
                Command::Attach(SessionId(1)),
                Command::Sessions(SessionsCommand::RefreshSessions),
                Command::Sessions(SessionsCommand::SaveJumps),
                Command::Sessions(SessionsCommand::Visit(PaneId(1))),
            ],
            "Attach should target the selected agent, then refresh"
        );
    }

    #[rstest::rstest]
    fn enter_on_an_agent_row_shows_its_tab_and_focuses_its_pane() {
        // Given an agent row whose pane is in tab 1 while tab 2 is shown.
        let mut state = on_agent_in_another_tab();

        // When handling Attach.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then tab 1 is shown with the agent's pane focused.
        let layout = state.layouts.get(SessionId(1));
        assert_eq!(
            (
                layout.map(SessionLayout::active),
                layout.and_then(SessionLayout::focused)
            ),
            (Some(0), Some(PaneId(1))),
            "Enter on an agent row should show its tab and focus its pane"
        );
    }

    #[rstest::rstest]
    fn enter_on_an_agent_row_attaches_with_the_keys_in_the_pane() {
        // Given an agent row of a session that isn't attached.
        let mut state = on_agent_in_another_tab();

        // When handling Attach.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then the session is attached with the keys in the pane.
        assert_eq!(
            (state.focus, state.attached.contains(&SessionId(1))),
            (Focus::Pane, true),
            "Enter on an agent row should attach its session"
        );
    }

    #[rstest::rstest]
    fn enter_on_an_agent_row_saves_the_layout() {
        // Given an agent row whose pane is in another tab.
        let mut state = on_agent_in_another_tab();

        // When handling Attach.
        let commands = IntentHandler::handle(&Intent::Attach, &mut state);

        // Then the session's layout is saved.
        assert!(
            commands.contains(&Command::Sessions(SessionsCommand::SaveLayout(SessionId(
                1
            )))),
            "Enter on an agent row should save the revealed layout"
        );
    }

    #[rstest::rstest]
    fn enter_on_a_settled_session_unsettles_and_attaches_it() {
        // Given a selected settled session.
        let mut state = settle(state_with(vec![stopped(1)], 1), &[1]);

        // When handling Attach.
        let commands = IntentHandler::handle(&Intent::Attach, &mut state);

        // Then it is un-settled, then attached.
        assert_eq!(
            commands.get(..2),
            Some(
                &[
                    Command::Sessions(SessionsCommand::UnsettleSession(SessionId(1))),
                    Command::Attach(SessionId(1))
                ][..]
            ),
            "⏎ on a settled session should bring it back and attach"
        );
    }

    /// Settled session 1 selected in the sidebar, its last pane closed.
    fn settled_without_layout() -> AppState {
        AppState {
            focus: Focus::Sidebar,
            layouts: Layouts::default(),
            ..settle(state_with(vec![stopped(1)], 1), &[1])
        }
    }

    #[rstest::rstest]
    fn enter_on_a_settled_session_without_a_layout_opens_a_shell_tab() {
        // Given a selected settled session whose last pane closed.
        let mut state = settled_without_layout();

        // When handling Attach.
        let commands = IntentHandler::handle(&Intent::Attach, &mut state);

        // Then it is un-settled, then gets a tab of one shell.
        assert_eq!(
            commands.get(..2),
            Some(
                &[
                    Command::Sessions(SessionsCommand::UnsettleSession(SessionId(1))),
                    Command::Sessions(SessionsCommand::NewTab(SessionId(1)))
                ][..]
            ),
            "⏎ on an emptied session should open a shell in it"
        );
    }

    #[rstest::rstest]
    fn enter_on_a_session_without_a_layout_keeps_the_keys_in_the_sidebar() {
        // Given a selected settled session whose last pane closed.
        let mut state = settled_without_layout();

        // When handling Attach.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then the keys stay in the sidebar and nothing is attached yet.
        assert_eq!(
            (state.focus, state.attached.is_empty()),
            (Focus::Sidebar, true),
            "the attach waits for the new tab"
        );
    }

    #[rstest::rstest]
    fn attach_shows_the_agents_session() {
        // Given a selected idle agent running in session 1.
        let mut state = state_with(vec![agent(1, AgentStatus::Idle)], 1);

        // When handling Attach.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then session 1 is shown.
        assert_eq!(
            state.shown_session(),
            Some(SessionId(1)),
            "attaching should show the agent's session"
        );
    }

    #[rstest::rstest]
    fn attach_adds_the_agent_to_attached() {
        // Given a selected idle agent.
        let mut state = state_with(vec![agent(1, AgentStatus::Idle)], 1);

        // When handling Attach.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then the agent is attached.
        assert!(
            state.attached.contains(&SessionId(1)),
            "Attach should add the agent to attached"
        );
    }

    #[rstest::rstest]
    fn leave_pane_focuses_the_sidebar() {
        // Given keys going to an attached session.
        let mut state = attached();

        // When handling LeavePane.
        IntentHandler::handle(&Intent::LeavePane, &mut state);

        // Then keys drive the sidebar.
        assert_eq!(
            state.focus,
            Focus::Sidebar,
            "LeavePane should focus the sidebar"
        );
    }

    #[rstest::rstest]
    fn leave_pane_keeps_the_agent_attached() {
        // Given keys going to agent 1's attached session.
        let mut state = attached();

        // When handling LeavePane.
        IntentHandler::handle(&Intent::LeavePane, &mut state);

        // Then agent 1 is still attached.
        assert!(
            state.attached.contains(&SessionId(1)),
            "LeavePane should keep the agent attached"
        );
    }

    #[rstest::rstest]
    fn leave_pane_returns_detach_and_refresh() {
        // Given keys going to an attached session.
        let mut state = attached();

        // When handling LeavePane.
        let commands = IntentHandler::handle(&Intent::LeavePane, &mut state);

        // Then the loop stops sending the pane input and the statuses are
        // refreshed.
        assert_eq!(
            commands,
            vec![
                Command::Detach,
                Command::Sessions(SessionsCommand::RefreshSessions)
            ],
            "LeavePane should detach, then refresh"
        );
    }

    #[rstest::rstest]
    fn leave_pane_while_the_sidebar_is_hidden_shows_it_with_the_keys() {
        // Given keys going to an attached session, with the sidebar hidden.
        let mut state = AppState {
            sidebar: SidebarView {
                hidden: true,
                ..SidebarView::default()
            },
            ..attached()
        };

        // When handling LeavePane (`<C-g> h`).
        IntentHandler::handle(&Intent::LeavePane, &mut state);

        // Then the sidebar is shown and has the keys.
        assert_eq!(
            (state.sidebar.hidden, state.focus),
            (false, Focus::Sidebar),
            "LeavePane should show a hidden sidebar and focus it"
        );
    }

    #[rstest::rstest]
    fn leave_pane_from_the_sidebar_does_nothing() {
        // Given the sidebar on attached agent 2.
        let mut state = left_pane(&[2], 2);

        // When handling LeavePane.
        let commands = IntentHandler::handle(&Intent::LeavePane, &mut state);

        // Then nothing happens.
        assert_eq!(
            (state.focus, commands),
            (Focus::Sidebar, vec![]),
            "the keys are already out of the panes"
        );
    }

    #[rstest::rstest]
    fn focus_panes_from_the_sidebar_on_an_attached_session_enters_its_panes() {
        // Given the sidebar on attached agent 2.
        let mut state = left_pane(&[2], 2);

        // When handling FocusPanes (`<C-g> l`).
        IntentHandler::handle(&Intent::FocusPanes, &mut state);

        // Then keys go into agent 2's pane.
        assert_eq!(
            state.focus,
            Focus::Pane,
            "<C-g> l should go into the selected session's pane"
        );
    }

    #[rstest::rstest]
    fn focus_panes_from_the_sidebar_returns_attach_and_refresh() {
        // Given the sidebar on attached agent 2.
        let mut state = left_pane(&[2], 2);

        // When handling FocusPanes (`<C-g> l`).
        let commands = IntentHandler::handle(&Intent::FocusPanes, &mut state);

        // Then the loop attaches to agent 2, the statuses are refreshed and
        // its pane is visited.
        assert_eq!(
            commands,
            vec![
                Command::Attach(SessionId(2)),
                Command::Sessions(SessionsCommand::RefreshSessions),
                Command::Sessions(SessionsCommand::SaveJumps),
                Command::Sessions(SessionsCommand::Visit(PaneId(2))),
            ],
            "<C-g> l should attach to the selected session, then refresh"
        );
    }

    #[rstest::rstest]
    #[case(&[])]
    #[case(&[1])]
    fn focus_panes_from_the_sidebar_on_an_unattached_session_keeps_the_keys(
        #[case] attached: &[i64],
    ) {
        // Given session 2 selected and unattached, with no session or session 1
        // attached.
        let mut state = left_pane(attached, 2);
        let before = state.focus;

        // When handling FocusPanes (`<C-g> l`).
        IntentHandler::handle(&Intent::FocusPanes, &mut state);

        // Then the keys stay put.
        assert_eq!(
            state.focus, before,
            "<C-g> l with {attached:?} attached should keep the keys"
        );
    }

    #[rstest::rstest]
    #[case(false)]
    #[case(true)]
    fn enter_on_the_shelf_toggles_it(#[case] open: bool) {
        // Given the cursor on the Settled header, with the shelf `open`.
        let mut state = settle(state_at(vec![stopped(1)], SidebarItem::SettledShelf), &[1]);
        state.sessions.shelf_open = open;

        // When handling Attach.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then the shelf flipped.
        assert_eq!(
            state.sessions.shelf_open, !open,
            "⏎ on the header should toggle the shelf"
        );
    }

    #[rstest::rstest]
    fn enter_on_the_shelf_returns_no_commands() {
        // Given the cursor on the Settled header.
        let mut state = settle(state_at(vec![stopped(1)], SidebarItem::SettledShelf), &[1]);

        // When handling Attach.
        let commands = IntentHandler::handle(&Intent::Attach, &mut state);

        // Then nothing attaches.
        assert!(commands.is_empty(), "⏎ on the header shouldn't attach");
    }

    #[rstest::rstest]
    fn attach_on_b_after_a_lists_their_agents() {
        // Given agent 1 entered, then the cursor moved to agent 2.
        let mut state = jumping(Focus::Sidebar, &[], &[]);
        state.sessions.cursor = Some(on_agent(1));
        IntentHandler::handle(&Intent::Attach, &mut state);
        state.focus = Focus::Sidebar;
        state.sessions.cursor = Some(on_agent(2));

        // When handling Attach on agent 2.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then the jump list is session 1's agent, then session 2's.
        assert_eq!(
            state.jumps.entries(),
            [agent_row(1, 1), agent_row(2, 2)],
            "entering each pane should record its agent"
        );
    }

    #[rstest::rstest]
    fn attach_returns_save_jumps() {
        // Given agent 2 selected.
        let mut state = jumping(Focus::Sidebar, &[], &[]);

        // When handling Attach.
        let commands = IntentHandler::handle(&Intent::Attach, &mut state);

        // Then the jump list is saved.
        assert!(
            commands.contains(&Command::Sessions(SessionsCommand::SaveJumps)),
            "entering a pane should save the jump list"
        );
    }

    #[rstest::rstest]
    fn re_entering_the_pane_jump_back_landed_in_returns_no_save_jumps() {
        // Given a jump back from agent 2's pane into agent 1's, then a
        // click on the sidebar.
        let mut state = jumping(Focus::Pane, &[1, 2], &[on_agent(1), agent_row(2, 2)]);
        IntentHandler::handle(&Intent::JumpBack, &mut state);
        IntentHandler::handle(&Intent::LeavePane, &mut state);

        // When handling `<C-g> l` back into agent 1's pane.
        let commands = IntentHandler::handle(&Intent::FocusPanes, &mut state);

        // Then the list isn't saved: nothing was recorded.
        assert!(
            !commands.contains(&Command::Sessions(SessionsCommand::SaveJumps)),
            "re-entering the landed pane records nothing to save"
        );
    }

    #[rstest::rstest]
    fn enter_on_an_agent_row_records_the_agent() {
        // Given the sidebar on agent 1's row, with agent 2's pane focused.
        let mut state = two_agents_from_sidebar(agent_row(1, 1), &[]);

        // When handling Attach.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then agent 1 is recorded.
        assert_eq!(
            state.jumps.entries(),
            [agent_row(1, 1)],
            "⏎ on an agent row should record that agent"
        );
    }

    #[rstest::rstest]
    fn enter_on_a_card_records_its_focused_agent() {
        // Given the sidebar on session 1's card, with agent 2's pane focused.
        let mut state = two_agents_from_sidebar(on_agent(1), &[]);

        // When handling Attach.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then agent 2 is recorded.
        assert_eq!(
            state.jumps.entries(),
            [agent_row(1, 2)],
            "⏎ on a card should record the agent in its focused pane"
        );
    }

    #[rstest::rstest]
    fn enter_on_a_card_with_a_shell_focused_records_the_card() {
        // Given the sidebar on session 1's card, with shell pane 50 focused.
        let mut state = split_layout();
        state.focus = Focus::Sidebar;

        // When handling Attach.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then session 1's card is recorded.
        assert_eq!(
            state.jumps.entries(),
            [on_agent(1)],
            "⏎ on a card with a shell focused should record the card"
        );
    }

    #[rstest::rstest]
    fn focus_panes_from_the_sidebar_without_a_layout_keeps_the_keys() {
        // Given agent 1 selected but not attached.
        let mut state = state_with(vec![agent(1, AgentStatus::Idle)], 1);

        // When handling FocusPanes (`<C-g> l`).
        IntentHandler::handle(&Intent::FocusPanes, &mut state);

        // Then the sidebar keeps the keys.
        assert_eq!(state.focus, Focus::Sidebar, "nothing is shown to enter");
    }

    #[rstest::rstest]
    fn focus_panes_from_a_pane_does_nothing() {
        // Given agent 1's pane with the keys.
        let mut state = with_layout(Focus::Pane);

        // When handling FocusPanes (`<C-g> l`).
        let commands = IntentHandler::handle(&Intent::FocusPanes, &mut state);

        // Then nothing happens.
        assert_eq!(
            (state.focus, commands),
            (Focus::Pane, vec![]),
            "the keys are already in the panes"
        );
    }

    #[rstest::rstest]
    fn entering_a_pane_starts_with_no_pane_mode() {
        // Given resize mode left over with the keys in the sidebar.
        let mut state = with_layout(Focus::Sidebar);
        state.pane_mode = Some(PaneMode::Resize);

        // When attaching to the selected session.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then the keys arrive in the pane with no mode on.
        assert_eq!(state.pane_mode(), None, "a pane is entered with no mode");
    }

    #[rstest::rstest]
    fn attach_on_an_agent_row_of_a_float_shows_it_on_top() {
        // Given agent 1's pane turned into a hidden float beside shell pane
        // 50, the cursor on its agent row in the sidebar.
        let mut state = split_layout();
        state.layouts.focus_pane(SessionId(1), PaneId(1));
        state.layouts.float_pane(SessionId(1));
        state.layouts.toggle_floats(SessionId(1));
        state.focus = Focus::Sidebar;
        state.sessions.cursor = Some(SidebarItem::Agent {
            session: SessionId(1),
            pane: PaneId(1),
        });

        // When handling Attach.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then the floats are shown with agent 1's float on top.
        assert_eq!(
            shown_focus(&state),
            Some(PaneId(1)),
            "Enter on a float's agent row shows the floats with it on top"
        );
    }

    #[rstest::rstest]
    fn attach_on_a_hovered_row_makes_its_session_active() {
        // Given sessions 1 and 2 attached, session 1 active, session 2 hovered.
        let mut state = left_pane_showing_1(&[1, 2], 2);

        // When handling Attach.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then session 2 is active.
        assert_eq!(
            state.sessions.active(),
            Some(SessionId(2)),
            "⏎ should make the hovered session active"
        );
    }

    #[rstest::rstest]
    fn attach_on_a_hovered_row_shows_its_session() {
        // Given sessions 1 and 2 attached, session 1 active, session 2 hovered.
        let mut state = left_pane_showing_1(&[1, 2], 2);

        // When handling Attach.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then the right side shows session 2.
        assert_eq!(
            state.shown_session(),
            Some(SessionId(2)),
            "⏎ should switch the right side to the hovered session"
        );
    }

    #[rstest::rstest]
    fn attach_on_a_hovered_row_keeps_the_cursor_on_its_entered_row() {
        // Given sessions 1 and 2 attached, session 1 active, session 2 hovered.
        let mut state = left_pane_showing_1(&[1, 2], 2);

        // When handling Attach.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then the cursor is on session 2's entered row.
        assert_eq!(
            state.sessions.cursor,
            Some(state.entry_row(SessionId(2))),
            "⏎ should leave the hover on the entered row"
        );
    }

    #[rstest::rstest]
    fn leave_pane_puts_the_cursor_on_the_active_row() {
        // Given the keys in active session 2's pane, the cursor on agent 1.
        let mut state = jumping(Focus::Pane, &[2], &[]);
        state.sessions.cursor = Some(on_agent(1));
        let active_row = state.active_row();

        // When handling LeavePane.
        IntentHandler::handle(&Intent::LeavePane, &mut state);

        // Then the cursor is on the active row.
        assert_eq!(
            state.sessions.cursor, active_row,
            "leaving a pane should hover the active row"
        );
    }

    #[rstest::rstest]
    fn focus_panes_on_an_unattached_row_enters_the_active_session() {
        // Given session 1 attached and active, unattached agent 2 hovered.
        let mut state = left_pane_showing_1(&[1], 2);
        let active_row = state.active_row();

        // When handling FocusPanes (`<C-g> l`).
        IntentHandler::handle(&Intent::FocusPanes, &mut state);

        // Then the keys are in session 1 with the cursor on its active row.
        assert_eq!(
            (state.focus, state.sessions.cursor),
            (Focus::Pane, active_row),
            "<C-g> l should fall back to the active session"
        );
    }

    #[rstest::rstest]
    fn leave_pane_keeps_the_cursor_when_the_active_row_is_filtered_out() {
        // Given the keys in alpha's agent 11, the sidebar filtered to beta
        // with the cursor on agent 21.
        let mut state = two_projects(Some(2), on_agent(21));
        state
            .layouts
            .insert(SessionId(11), SessionLayout::of(test_entry(11)));
        state.attached.insert(SessionId(11));
        state.sessions.enter(SessionId(11));
        state.focus = Focus::Pane;

        // When handling LeavePane.
        IntentHandler::handle(&Intent::LeavePane, &mut state);

        // Then the cursor stays on agent 21.
        assert_eq!(
            state.sessions.cursor,
            Some(on_agent(21)),
            "a filtered-out active row should not take the hover"
        );
    }

    #[rstest::rstest]
    #[case(false)]
    #[case(true)]
    fn enter_on_a_colonists_row_toggles_it(#[case] open: bool) {
        // Given the cursor on colony 1's colonists row, `open` or folded.
        let mut state = colony_with_colonists([AgentStatus::Idle; 3]);
        if open {
            state.sessions.colonists_open.insert(SessionId(1));
        }
        state.sessions.cursor = Some(SidebarItem::Colonists(SessionId(1)));

        // When handling Attach.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then the colonists row flipped.
        assert_eq!(
            state.sessions.colonists_open.contains(&SessionId(1)),
            !open,
            "⏎ on a colonists row should toggle it"
        );
    }

    #[rstest::rstest]
    fn enter_on_a_one_agent_colonist_shows_its_agents_pane() {
        // Given every colonists row open, the cursor on colonist 3 (one
        // agent, no agent row) whose agent's pane is in tab 1 while tab 2
        // is shown.
        let mut state = colony_with_colonists([AgentStatus::Idle; 3]);
        state
            .sessions
            .colonists_open
            .extend([SessionId(1), SessionId(2)]);
        state.layouts.new_tab(SessionId(3), test_entry(60));
        state.sessions.cursor = Some(SidebarItem::Session(SessionId(3)));

        // When handling Attach.
        IntentHandler::handle(&Intent::Attach, &mut state);

        // Then tab 1 is shown with the agent's pane focused.
        let layout = state.layouts.get(SessionId(3));
        assert_eq!(
            (
                layout.map(SessionLayout::active),
                layout.and_then(SessionLayout::focused)
            ),
            (Some(0), Some(PaneId(3))),
            "⏎ on a one-agent colonist should show its agent's pane"
        );
    }
}
