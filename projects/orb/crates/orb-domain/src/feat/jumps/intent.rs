//! What `<C-[>`/`<C-]>` do: land back or forward on a row in the jump list.

use crate::command::SessionsCommand;
use crate::feat::jumps::validator::{validate_jump_back, validate_jump_forward};
use crate::feat::pane::intent::show_pane;
use crate::feat::sessions::state::SidebarItem;
use crate::{AppState, Command, Focus};

/// `<C-[>`: lands on the row before the current one in the jump list.
pub(crate) fn jump_back(state: &mut AppState) -> Vec<Command> {
    match validate_jump_back(state) {
        Ok(()) => {
            let target = state.jumps.back(state.jump_from(), |item| {
                state.sessions.jumpable(item, &state.layouts)
            });
            land(state, target)
        }
        Err(_) => vec![],
    }
}

/// `<C-]>`: lands on the row after the current one in the jump list.
pub(crate) fn jump_forward(state: &mut AppState) -> Vec<Command> {
    match validate_jump_forward(state) {
        Ok(()) => {
            let target = state.jumps.forward(state.jump_from(), |item| {
                state.sessions.jumpable(item, &state.layouts)
            });
            land(state, target)
        }
        Err(_) => vec![],
    }
}

/// Lands a jump back or forward on `target`: the cursor moves there and its
/// session becomes active. From a
/// pane, the keys follow into the target's pane (an agent's own pane, which
/// is revealed and its layout saved) while orb is attached to it, else go to
/// the sidebar; elsewhere they stay put.
fn land(state: &mut AppState, target: Option<SidebarItem>) -> Vec<Command> {
    let Some(target) = target else {
        return vec![];
    };
    let from_pane = state.focus == Focus::Pane;
    state.sessions.cursor = Some(target);
    if let SidebarItem::Session(id) | SidebarItem::Agent { session: id, .. } = target {
        state.sessions.enter(id);
    }
    let pane = match target {
        SidebarItem::Session(id) if from_pane && state.attached.contains(&id) => show_pane(state),
        SidebarItem::Agent { session, pane } if from_pane && state.attached.contains(&session) => {
            state.layouts.reveal(session, pane);
            let mut commands = show_pane(state);
            if !commands.is_empty() {
                commands.push(Command::Sessions(SessionsCommand::SaveLayout(session)));
            }
            commands
        }
        _ => vec![],
    };
    let mut commands = vec![Command::Sessions(SessionsCommand::SaveJumps)];
    match (from_pane, pane.is_empty()) {
        (true, true) => {
            state.focus = Focus::Sidebar;
            commands.extend([
                Command::Detach,
                Command::Sessions(SessionsCommand::RefreshSessions),
            ]);
        }
        _ => commands.extend(pane),
    }
    commands
}

#[cfg(test)]
mod tests {
    use crate::command::SessionsCommand;
    use crate::feat::jumps::state::JumpList;
    use crate::feat::picker::intent::picked;
    use crate::feat::sessions::state::{AgentStatus, SidebarItem, sessions_for};
    use crate::ids::{AgentId, PaneId, ProjectId, SessionId};
    use crate::intent_handler::test_support::{
        agent, agent_row, answer_yes, close_agent_1s_pane, colony_with_colonists, jumping,
        on_agent, picking_agent_1, shown_focus, state_with, two_agents, two_agents_from_sidebar,
        with_projects,
    };
    use crate::{AppState, Command, Focus, Intent, IntentHandler};

    #[rstest::rstest]
    fn jump_back_lands_on_a_session() {
        // Given agent 1 listed before the cursor's agent 2.
        let mut state = jumping(Focus::Sidebar, &[], &[on_agent(1), on_agent(2)]);

        // When handling JumpBack.
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then the cursor is on agent 1.
        assert_eq!(
            state.sessions.cursor,
            Some(on_agent(1)),
            "<C-[> should land on the older row"
        );
    }

    #[rstest::rstest]
    fn jump_forward_after_jump_back_returns_to_the_row() {
        // Given a jump back from agent 2 to agent 1.
        let mut state = jumping(Focus::Sidebar, &[], &[on_agent(1), on_agent(2)]);
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // When handling JumpForward.
        IntentHandler::handle(&Intent::JumpForward, &mut state);

        // Then the cursor is back on agent 2.
        assert_eq!(
            state.sessions.cursor,
            Some(on_agent(2)),
            "<C-]> should undo <C-[>"
        );
    }

    #[rstest::rstest]
    fn jump_back_returns_save_jumps() {
        // Given agent 1 listed before the cursor's agent 2.
        let mut state = jumping(Focus::Sidebar, &[], &[on_agent(1), on_agent(2)]);

        // When handling JumpBack.
        let commands = IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then the jump list is saved.
        assert!(
            commands.contains(&Command::Sessions(SessionsCommand::SaveJumps)),
            "<C-[> should save the jump list"
        );
    }

    #[rstest::rstest]
    fn jump_back_without_a_target_returns_no_commands() {
        // Given only the cursor's agent listed.
        let mut state = jumping(Focus::Sidebar, &[], &[on_agent(2)]);

        // When handling JumpBack.
        let commands = IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then nothing happens.
        assert!(commands.is_empty(), "<C-[> with nowhere to go does nothing");
    }

    #[rstest::rstest]
    fn jump_back_from_a_pane_onto_an_attached_agent_focuses_its_pane() {
        // Given the keys in agent 2's pane, with agent 1 attached and listed.
        let mut state = jumping(Focus::Pane, &[1, 2], &[on_agent(1), agent_row(2, 2)]);

        // When handling JumpBack.
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then the keys are in agent 1's pane.
        assert_eq!(
            (
                state.focus,
                state.sessions.selected_lead_agent().map(|agent| agent.id)
            ),
            (Focus::Pane, Some(AgentId(1))),
            "<C-[> from a pane should follow into the target's pane"
        );
    }

    #[rstest::rstest]
    fn jump_back_from_a_pane_onto_an_attached_agent_returns_attach() {
        // Given the keys in agent 2's pane, with agent 1 attached and listed.
        let mut state = jumping(Focus::Pane, &[1, 2], &[on_agent(1), agent_row(2, 2)]);

        // When handling JumpBack.
        let commands = IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then the loop shows agent 1's pane.
        assert!(
            commands.contains(&Command::Attach(SessionId(1))),
            "<C-[> onto a live pane should show it"
        );
    }

    #[rstest::rstest]
    fn jump_back_into_a_pane_adds_no_entry() {
        // Given the keys in agent 2's pane, with agent 1 attached and listed.
        let mut state = jumping(Focus::Pane, &[1, 2], &[on_agent(1), agent_row(2, 2)]);

        // When handling JumpBack.
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then the list is unchanged.
        assert_eq!(
            state.jumps.entries(),
            [on_agent(1), agent_row(2, 2)],
            "landing in a pane isn't itself a jump"
        );
    }

    #[rstest::rstest]
    fn re_entering_the_pane_jump_back_landed_in_keeps_jump_forward() {
        // Given a jump back from agent 2's pane into agent 1's, then a
        // click on the sidebar and `<C-g> l` back into agent 1's pane.
        let mut state = jumping(Focus::Pane, &[1, 2], &[on_agent(1), agent_row(2, 2)]);
        IntentHandler::handle(&Intent::JumpBack, &mut state);
        IntentHandler::handle(&Intent::LeavePane, &mut state);
        IntentHandler::handle(&Intent::FocusPanes, &mut state);

        // When handling JumpForward.
        IntentHandler::handle(&Intent::JumpForward, &mut state);

        // Then the cursor is back on session 2's agent.
        assert_eq!(
            state.sessions.cursor,
            Some(agent_row(2, 2)),
            "re-entering the landed pane should keep <C-]>"
        );
    }

    #[rstest::rstest]
    fn jump_back_from_the_sidebar_onto_an_attached_agent_keeps_the_sidebar_focused() {
        // Given the sidebar on agent 2, with agent 1 attached and listed.
        let mut state = jumping(Focus::Sidebar, &[1], &[on_agent(1), on_agent(2)]);

        // When handling JumpBack.
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then the sidebar keeps the keys.
        assert_eq!(
            state.focus,
            Focus::Sidebar,
            "a sidebar <C-[> never moves the keys"
        );
    }

    #[rstest::rstest]
    fn jump_back_onto_an_agent_without_a_pane_returns_no_attach() {
        // Given the sidebar on agent 2, with agent 1 listed and unattached.
        let mut state = jumping(Focus::Sidebar, &[], &[on_agent(1), on_agent(2)]);

        // When handling JumpBack.
        let commands = IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then it only saves the list.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::SaveJumps)],
            "<C-[> must never attach"
        );
    }

    #[rstest::rstest]
    fn jump_back_from_a_pane_onto_an_agent_without_a_pane_focuses_the_sidebar() {
        // Given the keys in agent 2's pane, with agent 1 listed and unattached.
        let mut state = jumping(Focus::Pane, &[2], &[on_agent(1), agent_row(2, 2)]);

        // When handling JumpBack.
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then the sidebar has the keys.
        assert_eq!(
            state.focus,
            Focus::Sidebar,
            "<C-[> out of a pane onto a row without one goes to the sidebar"
        );
    }

    #[rstest::rstest]
    fn jump_back_from_a_pane_onto_an_agent_without_a_pane_returns_detach() {
        // Given the keys in agent 2's pane, with agent 1 listed and unattached.
        let mut state = jumping(Focus::Pane, &[2], &[on_agent(1), agent_row(2, 2)]);

        // When handling JumpBack.
        let commands = IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then the pane loses the keys.
        assert!(
            commands.contains(&Command::Detach),
            "leaving a pane should detach its keys"
        );
    }

    #[rstest::rstest]
    fn jump_back_from_a_pane_with_the_sidebar_hidden_focuses_the_hidden_sidebar() {
        // Given the keys in agent 2's pane with the sidebar hidden, and
        // agent 1 listed and unattached.
        let mut state = jumping(Focus::Pane, &[2], &[on_agent(1), agent_row(2, 2)]);
        state.sidebar.hidden = true;

        // When handling JumpBack.
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then the hidden sidebar has the keys.
        assert_eq!(
            state.focus,
            Focus::Sidebar,
            "with the sidebar hidden, <C-[> out of a pane goes to the sidebar"
        );
    }

    #[rstest::rstest]
    fn jump_back_skips_a_row_hidden_by_the_filter() {
        // Given the sidebar filtered to beta on agent 22, with beta's
        // agent 21, then alpha's agent 11, listed before it.
        let mut state = with_projects(&["alpha", "beta"]);
        if let [alpha, beta] = state.sessions.projects.as_mut_slice() {
            alpha.agents = vec![agent(11, AgentStatus::Idle)];
            beta.agents = vec![agent(21, AgentStatus::Idle), agent(22, AgentStatus::Idle)];
        }
        state.sessions.sessions = sessions_for(&state.sessions.projects);
        state.sessions.filter = Some(ProjectId(2));
        state.sessions.cursor = Some(on_agent(22));
        state.jumps = JumpList::from_saved(vec![on_agent(21), on_agent(11), on_agent(22)]);

        // When handling JumpBack.
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then it lands on agent 21.
        assert_eq!(
            state.sessions.cursor,
            Some(on_agent(21)),
            "<C-[> should skip rows the filter hides"
        );
    }

    #[rstest::rstest]
    fn jump_back_after_a_delete_skips_the_deleted_agent() {
        // Given agents 3, 2 and 1 listed, and 1, 3, 2 in the jump list, with
        // agent 2 deleted from the sidebar (the cursor moves to agent 1).
        let mut state = state_with((1..=3).map(|id| agent(id, AgentStatus::Idle)).collect(), 2);
        state.jumps = JumpList::from_saved(vec![on_agent(1), on_agent(3), on_agent(2)]);
        answer_yes(&Intent::Delete, &mut state);
        IntentHandler::handle(&Intent::PickerConfirm, &mut state);

        // When handling JumpBack.
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then it lands on agent 3.
        assert_eq!(
            state.sessions.cursor,
            Some(on_agent(3)),
            "a deleted agent is never a target"
        );
    }

    #[rstest::rstest]
    fn jumping_back_past_a_picked_agent_then_forward_returns_to_the_agent() {
        // Given session 1's agent picked from session 2, then a `<C-[>` onto
        // session 2's card.
        let mut state = picking_agent_1();
        IntentHandler::handle(&Intent::PickerConfirm, &mut state);
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // When handling JumpForward.
        IntentHandler::handle(&Intent::JumpForward, &mut state);

        // Then the cursor is back on session 1's agent row.
        assert_eq!(
            state.sessions.cursor,
            Some(agent_row(1, 1)),
            "forward should return to the picked agent"
        );
    }

    /// Picks session `id`'s agent in the session picker opened from `state`.
    fn pick_agent_of(state: &mut AppState, id: i64) {
        IntentHandler::handle(&Intent::OpenSessionPicker, state);
        for _ in 0..3 {
            if picked(state).0 == Some(AgentId(id)) {
                break;
            }
            IntentHandler::handle(&Intent::PickerNext, state);
        }
        IntentHandler::handle(&Intent::PickerConfirm, state);
    }

    #[rstest::rstest]
    fn jumping_back_after_chained_agent_picks_reaches_the_middle_agent() {
        // Given sessions 1-3 on session 3, then session 2's agent picked, then
        // session 1's agent picked.
        let mut state = state_with(
            vec![
                agent(1, AgentStatus::Idle),
                agent(2, AgentStatus::Idle),
                agent(3, AgentStatus::Idle),
            ],
            3,
        );
        pick_agent_of(&mut state, 2);
        pick_agent_of(&mut state, 1);

        // When handling JumpBack.
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then the cursor is on session 2's agent row.
        assert_eq!(
            state.sessions.cursor,
            Some(agent_row(2, 2)),
            "back should reach the agent picked in the middle"
        );
    }

    #[rstest::rstest]
    fn jump_back_from_a_pane_onto_an_agent_focuses_its_pane() {
        // Given the keys in agent 2's pane, with agent 1 listed before it.
        let mut state = two_agents();
        state.jumps = JumpList::from_saved(vec![agent_row(1, 1)]);

        // When handling JumpBack.
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then the keys are in agent 1's pane.
        assert_eq!(
            (state.focus, shown_focus(&state)),
            (Focus::Pane, Some(PaneId(1))),
            "<C-[> from a pane should follow into the agent's pane"
        );
    }

    #[rstest::rstest]
    fn jump_back_from_a_pane_onto_an_agent_saves_its_layout() {
        // Given the keys in agent 2's pane, with agent 1 listed before it.
        let mut state = two_agents();
        state.jumps = JumpList::from_saved(vec![agent_row(1, 1)]);

        // When handling JumpBack.
        let commands = IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then session 1's layout, showing agent 1's pane, is saved.
        assert!(
            commands.contains(&Command::Sessions(SessionsCommand::SaveLayout(SessionId(
                1
            )))),
            "revealing the agent's pane should save the layout"
        );
    }

    #[rstest::rstest]
    fn jump_back_from_the_sidebar_onto_an_agent_keeps_the_sidebar_focused() {
        // Given the sidebar on agent 2's row, with agent 1 listed before it.
        let mut state =
            two_agents_from_sidebar(agent_row(1, 2), &[agent_row(1, 1), agent_row(1, 2)]);

        // When handling JumpBack.
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then the sidebar keeps the keys.
        assert_eq!(
            state.focus,
            Focus::Sidebar,
            "a sidebar <C-[> onto an agent never moves the keys"
        );
    }

    #[rstest::rstest]
    fn jump_back_onto_an_agent_puts_the_cursor_on_its_row() {
        // Given the sidebar on agent 2's row, with agent 1 listed before it.
        let mut state =
            two_agents_from_sidebar(agent_row(1, 2), &[agent_row(1, 1), agent_row(1, 2)]);

        // When handling JumpBack.
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then the cursor is on agent 1's row.
        assert_eq!(
            state.sessions.cursor,
            Some(agent_row(1, 1)),
            "<C-[> should land on the agent's row"
        );
    }

    #[rstest::rstest]
    fn jump_back_skips_a_closed_agent() {
        // Given the sidebar on agent 2, with agent 1's card, then its
        // agent, listed before it, and then agent 1's pane closed.
        let mut state = jumping(Focus::Sidebar, &[], &[on_agent(1), agent_row(1, 1)]);
        close_agent_1s_pane(&mut state);

        // When handling JumpBack.
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then the cursor skips the closed agent for session 1's card.
        assert_eq!(
            state.sessions.cursor,
            Some(on_agent(1)),
            "<C-[> should skip an agent whose pane closed"
        );
    }

    #[rstest::rstest]
    fn jump_back_from_a_pane_starts_at_the_focused_agent() {
        // Given the keys in agent 2's pane, the cursor on session 1's card,
        // agent 1 listed, and a `<C-[>` onto agent 1.
        let mut state = two_agents();
        state.jumps = JumpList::from_saved(vec![agent_row(1, 1)]);
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // When handling JumpForward.
        IntentHandler::handle(&Intent::JumpForward, &mut state);

        // Then the cursor is back on agent 2's row.
        assert_eq!(
            state.sessions.cursor,
            Some(agent_row(1, 2)),
            "<C-[> from a pane should start at its agent, so <C-]> returns there"
        );
    }

    /// Both sessions attached, the cursor on agent 2 in the sidebar,
    /// agent 1 listed before it.
    fn jumping_back_to_1() -> AppState {
        jumping(Focus::Sidebar, &[1, 2], &[on_agent(1)])
    }

    #[rstest::rstest]
    fn jump_back_from_the_sidebar_makes_the_target_active() {
        // Given the cursor on agent 2, agent 1 listed before it.
        let mut state = jumping_back_to_1();

        // When handling JumpBack.
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then session 1 is active.
        assert_eq!(
            state.sessions.active(),
            Some(SessionId(1)),
            "a jump should make its target active"
        );
    }

    #[rstest::rstest]
    fn jump_back_from_the_sidebar_puts_the_cursor_on_the_target() {
        // Given the cursor on agent 2, agent 1 listed before it.
        let mut state = jumping_back_to_1();

        // When handling JumpBack.
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then the cursor is on agent 1.
        assert_eq!(
            state.sessions.cursor,
            Some(on_agent(1)),
            "a jump should hover its target"
        );
    }

    #[rstest::rstest]
    fn jump_to_a_one_agent_colonists_agent_lands_on_its_card() {
        // Given the agent of colonist 3 (one agent, no colonists) listed
        // before the cursor's colony 1.
        let mut state = AppState {
            jumps: JumpList::from_saved(vec![agent_row(3, 3)]),
            ..colony_with_colonists([AgentStatus::Idle; 3])
        };

        // When handling JumpBack.
        IntentHandler::handle(&Intent::JumpBack, &mut state);

        // Then the cursor is on colonist 3's card.
        assert_eq!(
            state.sessions.cursor,
            Some(SidebarItem::Session(SessionId(3))),
            "a jump to a hidden one-agent row should land on its card"
        );
    }
}
