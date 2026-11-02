//! The [`IntentHandler`]: the single decision point for all user input.

use crate::command::SessionsCommand;
use crate::feat::layout::intent::{SizeStep, SwapStep};
use crate::feat::pane::intent::enter_session;
use crate::feat::picker::intent::{PickerKey, project_item};
use crate::feat::picker::state::PickerKind;
use crate::feat::sessions::state::SidebarItem;
use crate::feat::{git, jumps, layout, pane, picker, sessions, sidebar};
use crate::ids::SessionId;
use crate::{AppState, Command, Focus, Intent};

/// Applies each [`Intent`] to [`AppState`] in one match; each arm calls its
/// feature's `intent.rs`.
pub struct IntentHandler;

impl IntentHandler {
    /// Apply `intent` to `state` and return the commands that must follow.
    /// Every intent first clears the error, which the user has now seen;
    /// otherwise an intent that fails validation changes nothing. After every
    /// intent, a cursor left on a row a fold hides opens the folds above it
    /// (a hidden one-agent colonist's agent row moves it to the card),
    /// unless a search has text.
    /// A focus key, tab switch, pane click or float toggle that moves the
    /// keys from one pane to another records the agent left and the agent
    /// entered, each only if its pane runs an agent.
    /// An intent that lands the keys in a different agent's pane visits it.
    /// Every intent but `PickerG` also ends a `gg` in progress.
    /// When an intent moves the keys from a pane to the sidebar, the cursor
    /// starts on the active row while it's listed; a row click or a jump
    /// keeps its own cursor.
    #[expect(
        clippy::too_many_lines,
        reason = "one arm per intent, each a call into its feature"
    )]
    pub fn handle(intent: &Intent, state: &mut AppState) -> Vec<Command> {
        state.sessions.error = None;
        if *intent != Intent::PickerG
            && let Some(picker) = state.picker.as_mut()
        {
            picker.forget_g();
        }
        let was_pane = state.focus == Focus::Pane;
        let left = was_pane.then(|| state.focused_agent());
        let mut commands = match intent {
            Intent::Quit => quit(state),
            Intent::SelectNext => sidebar::intent::select_next(state),
            Intent::SelectPrev => sidebar::intent::select_prev(state),
            Intent::SelectFirst => sidebar::intent::select_first(state),
            Intent::SelectLast => sidebar::intent::select_last(state),
            Intent::SelectHalfPageDown => sidebar::intent::half_page_down(state),
            Intent::SelectHalfPageUp => sidebar::intent::half_page_up(state),
            Intent::SelectRow(item) => sidebar::intent::select_row(state, *item),
            Intent::ToggleSidebar => sidebar::intent::toggle_sidebar(state),
            Intent::Attach => pane::intent::attach(state),
            Intent::LeavePane => pane::intent::leave_pane(state),
            Intent::FocusPanes => pane::intent::focus_panes(state),
            Intent::MoveFocus(nav) => layout::intent::move_focus(state, *nav),
            Intent::SplitPane(split) => layout::intent::split_pane(state, *split),
            Intent::AddPane => layout::intent::add_pane(state),
            Intent::StackPane => layout::intent::stack_pane(state),
            Intent::ClosePane => layout::intent::close_pane(state),
            Intent::ToggleFloats => layout::intent::toggle_floats(state),
            Intent::ToggleFloatEmbed => layout::intent::toggle_float_embed(state),
            Intent::TogglePinFloat => layout::intent::toggle_pin_float(state),
            Intent::SendCtrlG => layout::intent::send_ctrl_g(state),
            Intent::ToggleZoom => layout::intent::toggle_zoom(state),
            Intent::BreakPane => layout::intent::break_pane(state),
            Intent::GrowFocused => layout::intent::grow_or_shrink(state, SizeStep::Grow),
            Intent::ShrinkFocused => layout::intent::grow_or_shrink(state, SizeStep::Shrink),
            Intent::EnterPaneMode(mode) => layout::intent::enter_pane_mode(state, *mode),
            Intent::ExitPaneMode => layout::intent::exit_pane_mode(state),
            Intent::ResizeFocused { dir, grow } => {
                layout::intent::resize_focused(state, *dir, *grow)
            }
            Intent::MovePane(dir) => layout::intent::move_pane(state, *dir),
            Intent::MovePaneInOrder { forward } => {
                layout::intent::move_pane_in_order(state, *forward)
            }
            Intent::NewTab => layout::intent::new_tab(state),
            Intent::CloseTab => layout::intent::close_tab(state),
            Intent::RenameTab => layout::intent::rename_tab(state),
            Intent::RenamePane => layout::intent::rename_pane(state),
            Intent::GoToTab(n) => layout::intent::go_to_tab(state, *n),
            Intent::NextSwapLayout => layout::intent::swap_layout(state, SwapStep::Next),
            Intent::PreviousSwapLayout => layout::intent::swap_layout(state, SwapStep::Previous),
            Intent::MoveTabLeft => layout::intent::move_tab_left(state),
            Intent::MoveTabRight => layout::intent::move_tab_right(state),
            Intent::FocusPane(pane) => layout::intent::focus_pane(state, *pane),
            Intent::ShowStacked(pane) => layout::intent::show_stacked(state, *pane),
            Intent::DragFloat { pane, x, y } => layout::intent::drag_float(state, *pane, *x, *y),
            Intent::DropFloat => layout::intent::drop_float(state),
            Intent::JumpBack => jumps::intent::jump_back(state),
            Intent::JumpForward => jumps::intent::jump_forward(state),
            Intent::NewSession => picker::intent::open_project_picker(state),
            Intent::NewColony => picker::intent::open_world_picker(state),
            Intent::OpenProjects => picker::intent::open_projects(state),
            Intent::OpenWorlds => picker::intent::open_worlds(state),
            Intent::NewIncognito => sessions::intent::new_incognito(state),
            Intent::OpenSessionPicker => picker::intent::open_session_picker(state),
            Intent::OpenColonists => picker::intent::open_colonists(state),
            Intent::ToggleColonists => picker::intent::toggle_colonists(state),
            Intent::OpenWorktreePicker => picker::intent::open_worktree_picker(state),
            Intent::OpenSearch => picker::intent::open_search(state),
            Intent::FilterProjects => picker::intent::filter_projects(state),
            Intent::AddProject => picker::intent::add_project(state),
            Intent::ChangeWorkspace => git::intent::open_workspace_picker(state),
            Intent::PickerInput(ch) => picker::intent::key(state, PickerKey::Input(*ch)),
            Intent::PickerBackspace => picker::intent::key(state, PickerKey::Backspace),
            Intent::PickerDeleteWord => picker::intent::key(state, PickerKey::DeleteWord),
            Intent::PickerCursorLeft => picker::intent::key(state, PickerKey::CursorLeft),
            Intent::PickerCursorRight => picker::intent::key(state, PickerKey::CursorRight),
            Intent::PickerCursorTo(index) => {
                picker::intent::key(state, PickerKey::CursorTo(*index))
            }
            Intent::PickerNext => picker::intent::key(state, PickerKey::Next),
            Intent::PickerPrev => picker::intent::key(state, PickerKey::Prev),
            Intent::PickerHalfPageDown => picker::intent::key(state, PickerKey::HalfPageDown),
            Intent::PickerHalfPageUp => picker::intent::key(state, PickerKey::HalfPageUp),
            Intent::PickerConfirm => picker::intent::key(state, PickerKey::Confirm),
            Intent::PickerOpen => picker::intent::key(state, PickerKey::Open),
            Intent::PickerCancel => picker::intent::key(state, PickerKey::Cancel),
            Intent::PickerRemove => picker::intent::key(state, PickerKey::Remove),
            Intent::PickerSelectRow(index) => {
                picker::intent::key(state, PickerKey::SelectRow(*index))
            }
            Intent::PickerWheelNext => picker::intent::key(state, PickerKey::WheelNext),
            Intent::PickerWheelPrev => picker::intent::key(state, PickerKey::WheelPrev),
            Intent::PickerStartSearch => picker::intent::start_search(state),
            Intent::PickerLast => picker::intent::last(state),
            Intent::PickerG => picker::intent::press_g(state),
            Intent::SwitchBranch => git::intent::switch_branch(state),
            Intent::PickerFilter(pressed) => picker::intent::filter(state, *pressed),
            Intent::Unfold => sessions::intent::unfold(state),
            Intent::Fold => sessions::intent::fold(state),
            Intent::TogglePin => sessions::intent::toggle_pin(state),
            Intent::Rename => sidebar::intent::rename(state),
            Intent::Search => sidebar::intent::search(state),
            Intent::ToggleSettle => sessions::intent::toggle_settle(state),
            Intent::Delete => sessions::intent::delete(state),
        };
        if let Some(left) = left
            && state.focus == Focus::Pane
            && matches!(
                intent,
                Intent::MoveFocus(_)
                    | Intent::GoToTab(_)
                    | Intent::FocusPane(_)
                    | Intent::ShowStacked(_)
                    | Intent::ToggleFloats
            )
        {
            commands = record_focus_move(state, left, commands);
        }
        commands.extend(sessions::intent::visit_entered_pane(state, left.flatten()));
        state.sessions.reveal_cursor(&state.layouts);
        if was_pane
            && state.focus == Focus::Sidebar
            && !matches!(
                intent,
                Intent::SelectRow(_) | Intent::JumpBack | Intent::JumpForward
            )
            && let Some(row) = state.active_row()
            && state
                .sessions
                .sidebar(&state.layouts)
                .iter()
                .any(|listed| listed.item() == row)
        {
            state.sessions.cursor = Some(row);
        }
        commands
    }

    /// Re-lists the projects or worlds screen, open or under a picker, after
    /// the projects changed, keeping the selected project selected.
    pub fn relist_projects(state: &mut AppState) {
        let worlds = state
            .picker
            .iter()
            .flat_map(|picker| [Some(picker), picker.under()])
            .flatten()
            .any(|picker| *picker.kind() == PickerKind::ManageWorlds);
        let projects = if worlds {
            state.sessions.worlds_by_recency()
        } else {
            state.sessions.projects_by_recency()
        };
        let items = projects.into_iter().map(project_item).collect();
        if let Some(picker) = &mut state.picker {
            picker.show_projects(items);
        }
    }

    /// Opens session `id`, which a worker just made ready, as `⏎` on its
    /// row would, wherever the cursor is: it becomes active and attached,
    /// and the cursor moves to its row, opening the folds that hide it.
    /// Nothing happens for a session that is gone or being deleted.
    pub fn open_ready(state: &mut AppState, id: SessionId) -> Vec<Command> {
        if state.sessions.session(id).is_none() || state.sessions.deleting.contains(&id) {
            return vec![];
        }
        let commands = enter_session(state, id);
        state.sessions.cursor = state.active_row();
        state.sessions.reveal_cursor(&state.layouts);
        commands
    }
}

/// Asks orb to quit.
fn quit(state: &mut AppState) -> Vec<Command> {
    state.should_quit = true;
    vec![]
}

/// Records leaving agent row `left` for the focused agent, each only if it
/// runs an agent; nothing when the focus stayed on the same agent.
fn record_focus_move(
    state: &mut AppState,
    left: Option<SidebarItem>,
    mut commands: Vec<Command>,
) -> Vec<Command> {
    let entered = state.focused_agent();
    if left != entered && (left.is_some() || entered.is_some()) {
        state.jumps.jump(left, entered);
        if !commands.contains(&Command::Sessions(SessionsCommand::SaveJumps)) {
            commands.push(Command::Sessions(SessionsCommand::SaveJumps));
        }
    }
    commands
}

#[cfg(test)]
pub(crate) mod test_support;

#[cfg(test)]
mod tests {
    use crate::command::SessionsCommand;
    use crate::feat::layout::tree::NavDirection;
    use crate::feat::picker::list::PickerItem;
    use crate::feat::picker::state::{PickerKind, PickerState};
    use crate::feat::sessions::state::{AgentStatus, ProjectKind, SidebarItem};
    use crate::ids::{PaneId, ProjectId, SessionId};
    use crate::intent_handler::test_support::{
        ORPHAN, agent, agent_row, choosing_workspace, colony_with_colonists, highlight, in_root,
        jumping, left_pane_showing_1, managing, on_agent, picked_worktree, project_row,
        removing_alpha, split_layout, state_with, two_agents, two_agents_from_sidebar,
        two_projects, workspace_labels, worktree_picker_after,
    };
    use crate::{AppState, Command, Focus, Intent, IntentHandler};
    use std::path::PathBuf;

    #[rstest::rstest]
    fn quit_sets_should_quit_in_state() {
        // Given a fresh AppState.
        let mut state = AppState::default();

        // When handling Quit.
        IntentHandler::handle(&Intent::Quit, &mut state);

        // Then the frontend is told to exit.
        assert!(state.should_quit, "Quit should set should_quit");
    }

    #[rstest::rstest]
    fn current_row_reads_current_worktree_inside_a_worktree() {
        // Given / When opening the workspace picker on an agent in a worktree.
        let state = choosing_workspace(vec![agent(1, AgentStatus::Idle)]);

        // Then the first row is the current worktree.
        assert_eq!(
            workspace_labels(&state).first().map(String::as_str),
            Some("Current worktree"),
            "a worktree agent's current row names the worktree"
        );
    }

    #[rstest::rstest]
    fn next_intent_clears_the_error() {
        // Given a failure on the mode line.
        let mut state = state_with(vec![in_root(1)], 1);
        state.sessions.error = Some("A session is working in this directory".to_owned());

        // When handling the next intent.
        IntentHandler::handle(&Intent::SelectNext, &mut state);

        // Then the failure is gone.
        assert_eq!(
            state.sessions.error, None,
            "the user has seen the error once they press a key"
        );
    }

    /// Adds project gamma (3, `/gamma`), with no agents, to `state`.
    fn add_gamma(state: &mut AppState) {
        if let Some(mut gamma) = state.sessions.projects.first().cloned() {
            gamma.id = ProjectId(3);
            gamma.title = "gamma".to_owned();
            gamma.root = "/gamma".into();
            gamma.agents = vec![];
            state.sessions.projects.push(gamma);
        }
    }

    /// Whether the projects screen, open or under the open picker, lists
    /// `row`.
    fn projects_screen_lists(state: &AppState, row: &PickerItem) -> bool {
        state
            .picker
            .iter()
            .flat_map(|picker| [Some(picker), picker.under()])
            .flatten()
            .filter(|picker| *picker.kind() == PickerKind::ManageProjects)
            .any(|picker| picker.shown().any(|(item, _)| item == row))
    }

    #[rstest::rstest]
    fn relist_projects_lists_a_new_world() {
        // Given the worlds screen, then shared world gamma added.
        let mut state = two_projects(None, on_agent(21));
        IntentHandler::handle(&Intent::OpenWorlds, &mut state);
        add_gamma(&mut state);
        if let Some(gamma) = state.sessions.projects.last_mut() {
            gamma.kind = ProjectKind::SharedWorld;
        }

        // When re-listing the projects.
        IntentHandler::relist_projects(&mut state);

        // Then gamma shows as a row of the worlds screen.
        let gamma = PickerItem::Project {
            id: ProjectId(3),
            title: "gamma".to_owned(),
            root: "/gamma".into(),
            kind: ProjectKind::SharedWorld,
        };
        assert!(
            state
                .picker
                .iter()
                .filter(|picker| *picker.kind() == PickerKind::ManageWorlds)
                .any(|picker| picker.shown().any(|(item, _)| *item == gamma)),
            "a re-list should show the new world in the worlds screen"
        );
    }

    #[rstest::rstest]
    fn relist_projects_lists_a_new_project() {
        // Given the projects screen, then project gamma added.
        let mut state = managing(None, on_agent(21));
        add_gamma(&mut state);

        // When re-listing the projects.
        IntentHandler::relist_projects(&mut state);

        // Then gamma shows as a row.
        assert!(
            projects_screen_lists(&state, &project_row(3, "gamma")),
            "a re-list should show the new project"
        );
    }

    #[rstest::rstest]
    fn relist_projects_keeps_the_selected_project() {
        // Given the projects screen with beta highlighted, then project gamma
        // added.
        let mut state = managing(None, on_agent(21));
        highlight(&mut state, &project_row(2, "beta"));
        add_gamma(&mut state);

        // When re-listing the projects.
        IntentHandler::relist_projects(&mut state);

        // Then beta is still highlighted.
        assert_eq!(
            state.picker.as_ref().and_then(PickerState::selected),
            Some(&project_row(2, "beta")),
            "a re-list should keep the highlighted project"
        );
    }

    #[rstest::rstest]
    fn relist_projects_relists_the_projects_screen_under_a_confirm() {
        // Given the remove confirm over the projects screen, then project
        // gamma added.
        let mut state = removing_alpha(None, on_agent(21));
        add_gamma(&mut state);

        // When re-listing the projects.
        IntentHandler::relist_projects(&mut state);

        // Then the confirm stays on top and the list under it shows gamma.
        assert_eq!(
            (
                matches!(
                    state.picker.as_ref().map(PickerState::kind),
                    Some(PickerKind::RemoveProject { .. })
                ),
                projects_screen_lists(&state, &project_row(3, "gamma")),
            ),
            (true, true),
            "a re-list should reach the projects screen under the confirm"
        );
    }

    #[rstest::rstest]
    #[case(Intent::SelectNext)]
    #[case(Intent::SelectHalfPageDown)]
    fn plain_cursor_moves_record_nothing(#[case] intent: Intent) {
        // Given the cursor on agent 2, the first row.
        let mut state = jumping(Focus::Sidebar, &[], &[]);

        // When moving the cursor down.
        IntentHandler::handle(&intent, &mut state);

        // Then the jump list is still empty.
        assert!(state.jumps.entries().is_empty(), "{intent:?} isn't a jump");
    }

    #[rstest::rstest]
    fn g_then_another_key_then_g_keeps_the_selection() {
        // Given the worktree picker after `g` then a move to the second row.
        let mut state = worktree_picker_after(&[Intent::PickerG, Intent::PickerNext]);

        // When handling PickerG again.
        IntentHandler::handle(&Intent::PickerG, &mut state);

        // Then the second row stays selected.
        assert_eq!(
            picked_worktree(&state),
            Some(PathBuf::from(ORPHAN)),
            "a key between the g presses should cancel gg"
        );
    }

    #[rstest::rstest]
    fn moving_focus_to_another_agent_records_the_agent_left_then_the_agent_entered() {
        // Given the keys in agent 2's pane, agent 1's pane to its left.
        let mut state = two_agents();

        // When moving the focus left.
        IntentHandler::handle(&Intent::MoveFocus(NavDirection::Left), &mut state);

        // Then agent 2, then agent 1, are recorded.
        assert_eq!(
            state.jumps.entries(),
            [agent_row(1, 2), agent_row(1, 1)],
            "a focus move between agents should record both"
        );
    }

    /// Whether `commands` hold a visit to `pane`.
    fn visits(commands: &[Command], pane: i64) -> bool {
        commands.contains(&Command::Sessions(SessionsCommand::Visit(PaneId(pane))))
    }

    /// Whether `commands` hold any visit.
    fn visits_any(commands: &[Command]) -> bool {
        commands
            .iter()
            .any(|command| matches!(command, Command::Sessions(SessionsCommand::Visit(_))))
    }

    #[rstest::rstest]
    fn entering_a_session_visits_its_focused_agent_pane() {
        // Given the sidebar on session 1, whose focused pane runs agent 2.
        let mut state = two_agents_from_sidebar(SidebarItem::Session(SessionId(1)), &[]);

        // When handling Attach.
        let commands = IntentHandler::handle(&Intent::Attach, &mut state);

        // Then agent 2's pane is visited.
        assert!(
            visits(&commands, 2),
            "entering a session should visit the agent its keys land on"
        );
    }

    #[rstest::rstest]
    fn moving_focus_to_another_agent_pane_visits_it() {
        // Given the keys in agent 2's pane, agent 1's pane to its left.
        let mut state = two_agents();

        // When moving the focus left.
        let commands = IntentHandler::handle(&Intent::MoveFocus(NavDirection::Left), &mut state);

        // Then agent 1's pane is visited.
        assert!(
            visits(&commands, 1),
            "a focus move into an agent's pane should visit it"
        );
    }

    #[rstest::rstest]
    fn key_that_keeps_focus_sends_no_visit() {
        // Given the keys in agent 2's pane.
        let mut state = two_agents();

        // When growing the focused pane.
        let commands = IntentHandler::handle(&Intent::GrowFocused, &mut state);

        // Then nothing is visited.
        assert!(
            !visits_any(&commands),
            "a key that keeps the keys in the same pane should visit nothing"
        );
    }

    #[rstest::rstest]
    fn entering_a_shell_pane_sends_no_visit() {
        // Given the keys in agent 1's pane, shell pane 50 to its right.
        let mut state = split_layout();
        state.layouts.focus_pane(SessionId(1), PaneId(1));

        // When moving the focus right.
        let commands = IntentHandler::handle(&Intent::MoveFocus(NavDirection::Right), &mut state);

        // Then nothing is visited.
        assert!(!visits_any(&commands), "a shell pane has no agent to visit");
    }

    #[rstest::rstest]
    fn moving_focus_from_an_agent_to_a_shell_records_only_the_agent_left() {
        // Given the keys in agent 1's pane, shell pane 50 to its right.
        let mut state = split_layout();
        state.layouts.focus_pane(SessionId(1), PaneId(1));

        // When moving the focus right.
        IntentHandler::handle(&Intent::MoveFocus(NavDirection::Right), &mut state);

        // Then only session 1's agent is recorded.
        assert_eq!(
            state.jumps.entries(),
            [agent_row(1, 1)],
            "a shell pane is never recorded"
        );
    }

    #[rstest::rstest]
    fn clicking_another_agents_pane_records_the_move() {
        // Given the keys in agent 2's pane.
        let mut state = two_agents();

        // When clicking agent 1's pane.
        IntentHandler::handle(&Intent::FocusPane(PaneId(1)), &mut state);

        // Then agent 2, then agent 1, are recorded.
        assert_eq!(
            state.jumps.entries(),
            [agent_row(1, 2), agent_row(1, 1)],
            "a click between agents should record the agent left then the one entered"
        );
    }

    #[rstest::rstest]
    fn moving_focus_onto_the_same_pane_records_nothing() {
        // Given the keys in agent 2's pane, the rightmost.
        let mut state = two_agents();

        // When moving the focus right, past the edge.
        IntentHandler::handle(&Intent::MoveFocus(NavDirection::Right), &mut state);

        // Then nothing is recorded.
        assert!(
            state.jumps.entries().is_empty(),
            "a stuck focus move isn't a jump"
        );
    }

    #[rstest::rstest]
    fn new_app_state_has_no_folded_cards() {
        // Given / When a fresh app state.
        let state = AppState::default();

        // Then every card is open.
        assert!(state.sessions.folded.is_empty(), "cards start open");
    }

    #[rstest::rstest]
    fn open_ready_attaches_the_session_though_the_cursor_moved() {
        // Given session 1 active and the cursor moved to session 2 while a
        // restore of session 1 ran.
        let mut state = left_pane_showing_1(&[1, 2], 2);

        // When the restored session 1 opens.
        let commands = IntentHandler::open_ready(&mut state, SessionId(1));

        // Then session 1 is attached, not the hovered session 2.
        assert!(
            commands.contains(&Command::Attach(SessionId(1))),
            "a ready session should open wherever the cursor is, got {commands:?}"
        );
    }

    #[rstest::rstest]
    fn open_ready_moves_the_cursor_to_the_opened_session() {
        // Given session 1 active and the cursor on session 2.
        let mut state = left_pane_showing_1(&[1, 2], 2);

        // When the ready session 1 opens.
        IntentHandler::open_ready(&mut state, SessionId(1));

        // Then the cursor is on session 1's entered row.
        assert_eq!(
            state.sessions.cursor,
            Some(state.entry_row(SessionId(1))),
            "opening should put the cursor on the opened session"
        );
    }

    #[rstest::rstest]
    fn open_ready_does_nothing_for_a_deleted_session() {
        // Given session 1 being deleted and the cursor on session 2.
        let mut state = left_pane_showing_1(&[1, 2], 2);
        state.sessions.deleting.insert(SessionId(1));

        // When the ready session 1 opens.
        let commands = IntentHandler::open_ready(&mut state, SessionId(1));

        // Then nothing is asked for.
        assert!(
            commands.is_empty(),
            "a session being deleted shouldn't open, got {commands:?}"
        );
    }

    #[rstest::rstest]
    fn cursor_on_a_hidden_colonist_opens_the_colonists_rows_above_it() {
        // Given every colonists row folded and the cursor on colonist 3,
        // which they hide.
        let mut state = colony_with_colonists([AgentStatus::Idle; 3]);
        state.sessions.cursor = Some(SidebarItem::Session(SessionId(3)));

        // When handling an intent that leaves the cursor where it is.
        IntentHandler::handle(&Intent::Quit, &mut state);

        // Then the colonists rows of 1 and 2 are open.
        assert_eq!(
            state.sessions.colonists_open,
            [SessionId(1), SessionId(2)].into(),
            "a cursor on a hidden colonist should open every colonists row above it"
        );
    }

    #[rstest::rstest]
    fn cursor_on_a_one_agent_colonists_agent_row_moves_to_its_card() {
        // Given the cursor on the agent row colonist 3 hides (one agent, no
        // colonists).
        let mut state = colony_with_colonists([AgentStatus::Idle; 3]);
        state.sessions.cursor = Some(SidebarItem::Agent {
            session: SessionId(3),
            pane: PaneId(3),
        });

        // When handling an intent that leaves the cursor where it is.
        IntentHandler::handle(&Intent::Quit, &mut state);

        // Then the cursor is on colonist 3's card.
        assert_eq!(
            state.sessions.cursor,
            Some(SidebarItem::Session(SessionId(3))),
            "a hidden one-agent row should hand the cursor to its card"
        );
    }

    #[rstest::rstest]
    fn cursor_on_a_stuck_colonist_opens_no_fold() {
        // Given colonist 3 waiting for an answer, listed under the folded
        // colonists rows, with the cursor on it.
        let mut state = colony_with_colonists([
            AgentStatus::Idle,
            AgentStatus::Idle,
            AgentStatus::NeedsInput,
        ]);
        state.sessions.cursor = Some(SidebarItem::Session(SessionId(3)));

        // When handling an intent that leaves the cursor where it is.
        IntentHandler::handle(&Intent::Quit, &mut state);

        // Then every colonists row stays folded.
        assert!(
            state.sessions.colonists_open.is_empty(),
            "a listed stuck colonist shouldn't open its colonists rows, got {:?}",
            state.sessions.colonists_open
        );
    }

    #[rstest::rstest]
    fn open_ready_on_a_hidden_colonist_opens_its_colonists_row() {
        // Given colonist 2 hidden under colony 1's folded colonists row.
        let mut state = colony_with_colonists([AgentStatus::Idle; 3]);

        // When the ready colonist 2 opens.
        IntentHandler::open_ready(&mut state, SessionId(2));

        // Then colony 1's colonists row is open.
        assert!(
            state.sessions.colonists_open.contains(&SessionId(1)),
            "opening a hidden colonist should open its colonists row"
        );
    }
}
