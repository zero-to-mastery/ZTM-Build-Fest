//! What the layout keys do: moving the keys between panes and tabs, making,
//! closing, resizing and moving panes, tabs and floats.

use crate::command::SessionsCommand;
use crate::feat::layout::state::{FocusMove, Layouts, SessionLayout, Tab};
use crate::feat::layout::tree::{NavDirection, Split};
use crate::feat::layout::validator::{
    validate_float_action, validate_focus_pane, validate_pane_action, validate_tab_action,
    validate_tiled_action,
};
use crate::feat::pane::intent::enter_session;
use crate::feat::sidebar::state::{Rename, RenameTarget};
use crate::feat::sidebar::validator::validate_resize;
use crate::ids::{PaneId, SessionId};
use crate::{AppState, Command, Focus, PaneMode, TextInput};

/// Splits the focused pane to the right or down.
pub(crate) fn split_pane(state: &mut AppState, split: Split) -> Vec<Command> {
    match (validate_tiled_action(state), state.shown_session()) {
        (Ok(()), Some(session)) => {
            vec![Command::Sessions(SessionsCommand::SplitPane {
                session,
                split,
            })]
        }
        _ => vec![],
    }
}

/// Adds a pane to the shown tab, or a float while a float has the keys.
pub(crate) fn add_pane(state: &mut AppState) -> Vec<Command> {
    match (validate_pane_action(state), state.shown_session()) {
        (Ok(()), Some(session))
            if state
                .shown_layout()
                .is_some_and(SessionLayout::float_focused) =>
        {
            vec![Command::Sessions(SessionsCommand::AddFloat(session))]
        }
        (Ok(()), Some(session)) => {
            vec![Command::Sessions(SessionsCommand::AddPane(session))]
        }
        _ => vec![],
    }
}

/// Adds a pane stacked on the focused one.
pub(crate) fn stack_pane(state: &mut AppState) -> Vec<Command> {
    match (validate_tiled_action(state), state.shown_session()) {
        (Ok(()), Some(session)) => {
            vec![Command::Sessions(SessionsCommand::StackPane(session))]
        }
        _ => vec![],
    }
}

/// Embeds the focused float in the tab, or floats the focused tiled pane.
pub(crate) fn toggle_float_embed(state: &mut AppState) -> Vec<Command> {
    save_if_changed(state, |layouts, owner| {
        if layouts.get(owner).is_some_and(SessionLayout::float_focused) {
            layouts.embed_float(owner)
        } else {
            layouts.float_pane(owner)
        }
    })
}

/// Pins or unpins the focused float.
pub(crate) fn toggle_pin_float(state: &mut AppState) -> Vec<Command> {
    match validate_float_action(state) {
        Ok(()) => save_if_changed(state, Layouts::toggle_pin),
        Err(_) => vec![],
    }
}

/// Sends Ctrl-g to the focused pane.
pub(crate) fn send_ctrl_g(state: &mut AppState) -> Vec<Command> {
    match validate_pane_action(state) {
        Ok(()) => vec![Command::SendCtrlG],
        Err(_) => vec![],
    }
}

/// Zooms the shown tab onto the focused pane, or back out.
pub(crate) fn toggle_zoom(state: &mut AppState) -> Vec<Command> {
    if validate_tiled_action(state).is_ok() {
        in_pane(state, Layouts::toggle_zoom);
    }
    vec![]
}

/// Moves the focused pane to a tab of its own.
pub(crate) fn break_pane(state: &mut AppState) -> Vec<Command> {
    match validate_tiled_action(state) {
        Ok(()) => in_pane(state, Layouts::break_pane).map_or_else(Vec::new, |owner| {
            vec![Command::Sessions(SessionsCommand::SaveLayout(owner))]
        }),
        Err(_) => vec![],
    }
}

/// Turns on pane mode `mode` while the keys are in a pane.
pub(crate) fn enter_pane_mode(state: &mut AppState, mode: PaneMode) -> Vec<Command> {
    if validate_pane_action(state).is_ok() {
        state.pane_mode = Some(mode);
    }
    vec![]
}

/// Turns pane mode off.
pub(crate) fn exit_pane_mode(state: &mut AppState) -> Vec<Command> {
    state.pane_mode = None;
    vec![]
}

/// Grows (`grow`) or shrinks the focused pane's `dir` side.
pub(crate) fn resize_focused(state: &mut AppState, dir: NavDirection, grow: bool) -> Vec<Command> {
    save_if_changed(state, |layouts, owner| {
        layouts.resize_side(owner, dir, grow)
    })
}

/// Swaps the focused pane with the one `dir` of it.
pub(crate) fn move_pane(state: &mut AppState, dir: NavDirection) -> Vec<Command> {
    save_if_changed(state, |layouts, owner| layouts.move_pane(owner, dir))
}

/// Swaps the focused pane with the next (`forward`) or previous one.
pub(crate) fn move_pane_in_order(state: &mut AppState, forward: bool) -> Vec<Command> {
    save_if_changed(state, |layouts, owner| {
        layouts.move_pane_in_order(owner, forward)
    })
}

/// Asks for a new tab in the shown session.
pub(crate) fn new_tab(state: &mut AppState) -> Vec<Command> {
    match (validate_tab_action(state), state.shown_session()) {
        (Ok(()), Some(session)) => {
            vec![Command::Sessions(SessionsCommand::NewTab(session))]
        }
        _ => vec![],
    }
}

/// Shows tab `n` of the shown session.
pub(crate) fn go_to_tab(state: &mut AppState, n: usize) -> Vec<Command> {
    on_tabs(state, |layouts, owner| layouts.go_to_tab(owner, n))
}

/// Moves the shown tab one place left.
pub(crate) fn move_tab_left(state: &mut AppState) -> Vec<Command> {
    on_tabs(state, Layouts::move_tab_left)
}

/// Moves the shown tab one place right.
pub(crate) fn move_tab_right(state: &mut AppState) -> Vec<Command> {
    on_tabs(state, Layouts::move_tab_right)
}

/// Gives pane `pane` of the shown session the keys, revealing it.
pub(crate) fn focus_pane(state: &mut AppState, pane: PaneId) -> Vec<Command> {
    match (validate_focus_pane(state, pane), state.shown_session()) {
        (Ok(()), Some(owner)) => {
            state.layouts.reveal(owner, pane);
            let mut commands = enter_session(state, owner);
            commands.push(Command::Sessions(SessionsCommand::SaveLayout(owner)));
            commands
        }
        _ => vec![],
    }
}

/// Shows stacked pane `pane` in its stack.
pub(crate) fn show_stacked(state: &mut AppState, pane: PaneId) -> Vec<Command> {
    match (validate_focus_pane(state, pane), state.shown_session()) {
        (Ok(()), Some(owner)) => {
            state.layouts.focus_pane(owner, pane);
            vec![Command::Sessions(SessionsCommand::SaveLayout(owner))]
        }
        _ => vec![],
    }
}

/// Moves float `pane` to `x`, `y` while it's dragged.
pub(crate) fn drag_float(state: &mut AppState, pane: PaneId, x: u16, y: u16) -> Vec<Command> {
    if let (Ok(()), Some(owner)) = (validate_float_action(state), state.shown_session()) {
        state.layouts.move_float_to(owner, pane, x, y);
    }
    vec![]
}

/// Saves the layout once a dragged float is dropped.
pub(crate) fn drop_float(state: &mut AppState) -> Vec<Command> {
    match (validate_float_action(state), state.shown_session()) {
        (Ok(()), Some(owner)) => {
            vec![Command::Sessions(SessionsCommand::SaveLayout(owner))]
        }
        _ => vec![],
    }
}

/// Runs `edit` on the shown layout while the keys are in one of its panes;
/// the session it edited, if any.
fn in_pane<F>(state: &mut AppState, edit: F) -> Option<SessionId>
where
    F: FnOnce(&mut Layouts, SessionId),
{
    let (Ok(()), Some(owner)) = (validate_pane_action(state), state.shown_session()) else {
        return None;
    };
    edit(&mut state.layouts, owner);
    Some(owner)
}

/// Runs `edit` on the shown layout's tabs and saves the layout; the keys
/// stay where they are.
fn on_tabs<F>(state: &mut AppState, edit: F) -> Vec<Command>
where
    F: FnOnce(&mut Layouts, SessionId),
{
    let (Ok(()), Some(owner)) = (validate_tab_action(state), state.shown_session()) else {
        return vec![];
    };
    edit(&mut state.layouts, owner);
    vec![Command::Sessions(SessionsCommand::SaveLayout(owner))]
}

/// Which way a swap-layout key cycles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SwapStep {
    /// `Alt ]`: the next layout.
    Next,
    /// `Alt [`: the previous layout.
    Previous,
}

/// Whether a resize key grows or shrinks what has the keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SizeStep {
    Grow,
    Shrink,
}

/// `Alt ]` (or `Alt [` for [`SwapStep::Previous`]): cycles the floats' layout
/// while a float has the keys, else the shown tab's swap layout; saves the
/// layout.
pub(crate) fn swap_layout(state: &mut AppState, step: SwapStep) -> Vec<Command> {
    let back = step == SwapStep::Previous;
    match (validate_float_action(state), back) {
        (Ok(()), _) => save_if_changed(state, |layouts, owner| {
            layouts.cycle_float_layout(owner, back)
        }),
        (Err(_), true) => on_tabs(state, Layouts::previous_swap_layout),
        (Err(_), false) => on_tabs(state, Layouts::next_swap_layout),
    }
}

/// Moves the focus to the pane `nav` of the focused one, or across to the
/// tab beside it, and saves the layout. Only while the keys are in a pane.
pub(crate) fn move_focus(state: &mut AppState, nav: NavDirection) -> Vec<Command> {
    if state.focus != Focus::Pane {
        return vec![];
    }
    let (Ok(()), Some(owner)) = (validate_pane_action(state), state.shown_session()) else {
        return vec![];
    };
    match state.layouts.move_focus(owner, nav) {
        FocusMove::Moved => vec![Command::Sessions(SessionsCommand::SaveLayout(owner))],
        FocusMove::Stuck => vec![],
    }
}

/// Shows or hides the shown session's floats and saves the layout; with
/// none, asks for a shell float. Only while the keys are in a pane.
pub(crate) fn toggle_floats(state: &mut AppState) -> Vec<Command> {
    let (Ok(()), Some(owner)) = (validate_pane_action(state), state.shown_session()) else {
        return vec![];
    };
    if state.layouts.toggle_floats(owner) {
        vec![Command::Sessions(SessionsCommand::SaveLayout(owner))]
    } else {
        vec![Command::Sessions(SessionsCommand::AddFloat(owner))]
    }
}

/// Closes the focused pane and saves the layout.
pub(crate) fn close_pane(state: &mut AppState) -> Vec<Command> {
    let focused = state.shown_layout().and_then(SessionLayout::focused);
    let (Ok(()), Some(owner), Some(focused)) =
        (validate_pane_action(state), state.shown_session(), focused)
    else {
        return vec![];
    };
    state.layouts.close_pane(focused);
    vec![Command::Sessions(SessionsCommand::SaveLayout(owner))]
}

/// Closes the shown tab and saves the layout.
pub(crate) fn close_tab(state: &mut AppState) -> Vec<Command> {
    let (Ok(()), Some(owner)) = (validate_tab_action(state), state.shown_session()) else {
        return vec![];
    };
    state.layouts.close_tab(owner);
    vec![Command::Sessions(SessionsCommand::SaveLayout(owner))]
}

/// Runs `edit` on the shown layout while the keys are in one of its panes,
/// saving the layout when it reports a change.
fn save_if_changed<F>(state: &mut AppState, edit: F) -> Vec<Command>
where
    F: FnOnce(&mut Layouts, SessionId) -> bool,
{
    let mut changed = false;
    let owner = in_pane(state, |layouts, owner| changed = edit(layouts, owner));
    owner
        .filter(|_| changed)
        .map(SessionsCommand::SaveLayout)
        .map(Command::Sessions)
        .into_iter()
        .collect()
}

/// Grows or shrinks (`step`) what has the keys: the sidebar, saving its new
/// width, or the focused pane.
pub(crate) fn grow_or_shrink(state: &mut AppState, step: SizeStep) -> Vec<Command> {
    let grow = step == SizeStep::Grow;
    match state.focus {
        Focus::Sidebar => {
            if validate_resize(state).is_err() {
                return vec![];
            }
            let changed = if grow {
                state.sidebar.widen()
            } else {
                state.sidebar.narrow()
            };
            changed
                .then_some(Command::Sessions(SessionsCommand::SaveUi))
                .into_iter()
                .collect()
        }
        Focus::Pane => {
            let mut changed = false;
            let owner = in_pane(state, |layouts, owner| {
                changed = layouts.resize_focused(owner, grow);
            });
            owner
                .filter(|_| changed)
                .map(SessionsCommand::SaveLayout)
                .map(Command::Sessions)
                .into_iter()
                .collect()
        }
        Focus::Picker | Focus::Rename | Focus::Search => vec![],
    }
}

/// Opens the rename box on the shown tab, holding its name.
pub(crate) fn rename_tab(state: &mut AppState) -> Vec<Command> {
    let (Ok(()), Some(owner)) = (validate_tab_action(state), state.shown_session()) else {
        return vec![];
    };
    let Some((tab, name)) = state.layouts.get(owner).map(|layout| {
        let name = layout.active_tab().and_then(Tab::name).unwrap_or_default();
        (layout.active(), TextInput::new(name))
    }) else {
        return vec![];
    };
    state.rename = Some(Rename {
        target: RenameTarget::Tab { owner, tab },
        input: name,
        creating: false,
    });
    state.focus = Focus::Rename;
    vec![]
}

/// Opens the rename box on the focused pane, holding its name.
pub(crate) fn rename_pane(state: &mut AppState) -> Vec<Command> {
    let focused = state.shown_layout().and_then(SessionLayout::focused);
    let (Ok(()), Some(pane)) = (validate_pane_action(state), focused) else {
        return vec![];
    };
    let name = state
        .layouts
        .entry(pane)
        .and_then(|entry| entry.name.as_deref())
        .unwrap_or_default();
    state.rename = Some(Rename {
        target: RenameTarget::Pane(pane),
        input: TextInput::new(name),
        creating: false,
    });
    state.focus = Focus::Rename;
    vec![]
}

#[cfg(test)]
mod tests {
    use crate::command::SessionsCommand;
    use crate::feat::layout::floats::FloatLayout;
    use crate::feat::layout::state::{SessionLayout, Tab, test_entry};
    use crate::feat::layout::tree::{NavDirection, Split, SwapLayout};

    use crate::feat::sidebar::state::RenameTarget;
    use crate::ids::{PaneId, SessionId};
    use crate::intent_handler::test_support::{
        agent_row, jumping, laid_out, on_agent, shown_focus, shown_tab_name, split_layout,
        two_agents, with_layout,
    };
    use crate::{AppState, Command, Focus, Intent, IntentHandler, PaneMode};
    use ratatui::layout::Rect;

    #[rstest::rstest]
    #[case(Intent::GrowFocused, 36)]
    #[case(Intent::ShrinkFocused, 28)]
    fn grow_and_shrink_move_the_sidebars_edge_a_step(
        #[case] intent: Intent,
        #[case] expected: u16,
    ) {
        // Given a 32-column sidebar with the keys.
        let mut state = laid_out(Focus::Sidebar, 32, false);

        // When handling the resize.
        IntentHandler::handle(&intent, &mut state);

        // Then the sidebar is 4 columns wider or narrower.
        assert_eq!(
            state.sidebar.width, expected,
            "{intent:?} should make the sidebar {expected} wide"
        );
    }

    #[rstest::rstest]
    fn growing_the_sidebar_returns_save_ui() {
        // Given a 32-column sidebar with the keys.
        let mut state = laid_out(Focus::Sidebar, 32, false);

        // When growing it.
        let commands = IntentHandler::handle(&Intent::GrowFocused, &mut state);

        // Then the new width is saved.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::SaveUi)],
            "a resize should save the width"
        );
    }

    #[rstest::rstest]
    #[case(Intent::ShrinkFocused, 24)]
    #[case(Intent::GrowFocused, 80)]
    fn grow_and_shrink_stop_at_the_sidebars_bounds(#[case] intent: Intent, #[case] width: u16) {
        // Given a sidebar with the keys, already at a bound.
        let mut state = laid_out(Focus::Sidebar, width, false);

        // When resizing it past the bound.
        IntentHandler::handle(&intent, &mut state);

        // Then it stays at the bound.
        assert_eq!(
            state.sidebar.width, width,
            "{intent:?} should stop at {width}"
        );
    }

    #[rstest::rstest]
    fn growing_the_sidebar_at_a_bound_returns_no_commands() {
        // Given a sidebar at its 80-column maximum, with the keys.
        let mut state = laid_out(Focus::Sidebar, 80, false);

        // When growing it.
        let commands = IntentHandler::handle(&Intent::GrowFocused, &mut state);

        // Then nothing is saved.
        assert!(commands.is_empty(), "an unchanged width isn't saved");
    }

    #[rstest::rstest]
    #[case(Intent::GrowFocused)]
    #[case(Intent::ShrinkFocused)]
    fn grow_and_shrink_keep_a_hidden_sidebars_width(#[case] intent: Intent) {
        // Given a hidden 32-column sidebar that had the keys.
        let mut state = laid_out(Focus::Sidebar, 32, true);

        // When handling the resize.
        IntentHandler::handle(&intent, &mut state);

        // Then the width is unchanged.
        assert_eq!(
            state.sidebar.width, 32,
            "{intent:?} should do nothing while the sidebar is hidden"
        );
    }

    /// `with_layout(Focus::Pane)` with a second tab of shell pane 60, shown.
    fn two_tabs() -> AppState {
        let mut state = with_layout(Focus::Pane);
        state.layouts.new_tab(SessionId(1), test_entry(60));
        state
    }

    fn shown_tab(state: &AppState) -> Option<usize> {
        state.shown_layout().map(SessionLayout::active)
    }

    fn shown_swap_layout(state: &AppState) -> Option<SwapLayout> {
        state
            .shown_layout()
            .and_then(SessionLayout::active_tab)
            .map(Tab::swap_layout)
    }

    fn tab_count(state: &AppState) -> usize {
        state.shown_layout().map_or(0, |layout| layout.tabs().len())
    }

    fn pane_count(state: &AppState) -> usize {
        state.shown_layout().map_or(0, |layout| {
            layout.placed(Rect::new(0, 0, 80, 24), |_| 0).panes.len()
        })
    }

    #[rstest::rstest]
    fn split_pane_asks_the_sessions_actor_for_a_pane() {
        // Given agent 1's lone pane with the keys.
        let mut state = with_layout(Focus::Pane);

        // When splitting it right.
        let commands = IntentHandler::handle(&Intent::SplitPane(Split::Right), &mut state);

        // Then the sessions actor is asked to split session 1.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::SplitPane {
                session: SessionId(1),
                split: Split::Right
            })],
            "a split goes through the sessions actor, which makes the pane"
        );
    }

    #[rstest::rstest]
    fn split_pane_outside_a_pane_does_nothing() {
        // Given agent 1's layout shown while the sidebar has the keys.
        let mut state = with_layout(Focus::Sidebar);

        // When splitting.
        let commands = IntentHandler::handle(&Intent::SplitPane(Split::Right), &mut state);

        // Then nothing is asked for.
        assert!(commands.is_empty(), "a split needs the keys in a pane");
    }

    #[rstest::rstest]
    fn add_pane_asks_the_sessions_actor_for_a_pane() {
        // Given agent 1's lone pane with the keys.
        let mut state = with_layout(Focus::Pane);

        // When adding a pane.
        let commands = IntentHandler::handle(&Intent::AddPane, &mut state);

        // Then the sessions actor is asked to add one to session 1.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::AddPane(SessionId(1)))],
            "adding goes through the sessions actor, which makes the pane"
        );
    }

    #[rstest::rstest]
    fn add_pane_while_a_float_has_the_keys_asks_for_a_float() {
        // Given a float of session 1 with the keys.
        let mut state = with_layout(Focus::Pane);
        state.layouts.add_float(SessionId(1), test_entry(70));

        // When adding a pane.
        let commands = IntentHandler::handle(&Intent::AddPane, &mut state);

        // Then the sessions actor is asked for another float.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::AddFloat(SessionId(1)))],
            "a new pane opens as a float while a float has the keys"
        );
    }

    #[rstest::rstest]
    fn toggle_floats_with_no_floats_asks_for_a_float() {
        // Given agent 1's lone pane with the keys and no floats.
        let mut state = with_layout(Focus::Pane);

        // When showing the floats.
        let commands = IntentHandler::handle(&Intent::ToggleFloats, &mut state);

        // Then the sessions actor is asked for a shell float.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::AddFloat(SessionId(1)))],
            "with no floats, showing them opens one"
        );
    }

    #[rstest::rstest]
    fn toggle_floats_with_floats_saves_the_layout() {
        // Given a float of session 1, shown.
        let mut state = with_layout(Focus::Pane);
        state.layouts.add_float(SessionId(1), test_entry(70));

        // When hiding the floats.
        let commands = IntentHandler::handle(&Intent::ToggleFloats, &mut state);

        // Then the layout is saved.
        assert!(
            commands.contains(&Command::Sessions(SessionsCommand::SaveLayout(SessionId(
                1
            )))),
            "hiding the floats moves the keys, so the layout is saved"
        );
    }

    #[rstest::rstest]
    fn toggle_float_embed_on_a_split_pane_saves_the_layout() {
        // Given two side-by-side panes, pane 50 with the keys.
        let mut state = split_layout();

        // When turning the focused pane into a float.
        let commands = IntentHandler::handle(&Intent::ToggleFloatEmbed, &mut state);

        // Then the layout is saved.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::SaveLayout(SessionId(1)))],
            "floating a pane saves the layout"
        );
    }

    #[rstest::rstest]
    fn toggle_float_embed_on_a_lone_pane_does_nothing() {
        // Given agent 1's lone pane with the keys.
        let mut state = with_layout(Focus::Pane);

        // When turning the focused pane into a float.
        let commands = IntentHandler::handle(&Intent::ToggleFloatEmbed, &mut state);

        // Then nothing is saved.
        assert!(
            commands.is_empty(),
            "a tab's only pane can't become a float"
        );
    }

    #[rstest::rstest]
    fn toggle_float_embed_on_a_float_saves_the_layout() {
        // Given a float of session 1 with the keys.
        let mut state = with_layout(Focus::Pane);
        state.layouts.add_float(SessionId(1), test_entry(70));

        // When putting the float back into the tab.
        let commands = IntentHandler::handle(&Intent::ToggleFloatEmbed, &mut state);

        // Then the layout is saved.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::SaveLayout(SessionId(1)))],
            "embedding a float saves the layout"
        );
    }

    #[rstest::rstest]
    fn toggle_pin_float_without_a_float_does_nothing() {
        // Given agent 1's lone pane with the keys.
        let mut state = with_layout(Focus::Pane);

        // When pinning.
        let commands = IntentHandler::handle(&Intent::TogglePinFloat, &mut state);

        // Then nothing is saved.
        assert!(commands.is_empty(), "only a float can be pinned");
    }

    #[rstest::rstest]
    fn toggle_pin_float_on_a_float_saves_the_layout() {
        // Given a float of session 1 with the keys.
        let mut state = with_layout(Focus::Pane);
        state.layouts.add_float(SessionId(1), test_entry(70));

        // When pinning it.
        let commands = IntentHandler::handle(&Intent::TogglePinFloat, &mut state);

        // Then the layout is saved.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::SaveLayout(SessionId(1)))],
            "pinning a float saves the layout"
        );
    }

    #[rstest::rstest]
    fn toggle_floats_outside_a_pane_does_nothing() {
        // Given agent 1's layout shown while the sidebar has the keys.
        let mut state = with_layout(Focus::Sidebar);

        // When showing the floats.
        let commands = IntentHandler::handle(&Intent::ToggleFloats, &mut state);

        // Then nothing is asked for.
        assert!(
            commands.is_empty(),
            "showing the floats needs the keys in a pane"
        );
    }

    #[rstest::rstest]
    fn add_pane_outside_a_pane_does_nothing() {
        // Given agent 1's layout shown while the sidebar has the keys.
        let mut state = with_layout(Focus::Sidebar);

        // When adding a pane.
        let commands = IntentHandler::handle(&Intent::AddPane, &mut state);

        // Then nothing is asked for.
        assert!(
            commands.is_empty(),
            "adding a pane needs the keys in a pane"
        );
    }

    #[rstest::rstest]
    fn stack_pane_asks_the_sessions_actor_for_a_stacked_pane() {
        // Given agent 1's lone pane with the keys.
        let mut state = with_layout(Focus::Pane);

        // When stacking a pane (`<C-g> p s`).
        let commands = IntentHandler::handle(&Intent::StackPane, &mut state);

        // Then the sessions actor is asked to stack one in session 1.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::StackPane(SessionId(1)))],
            "stacking goes through the sessions actor, which makes the pane"
        );
    }

    #[rstest::rstest]
    fn stack_pane_without_a_layout_does_nothing() {
        // Given the keys in a pane focus with no layout shown.
        let mut state = AppState {
            focus: Focus::Pane,
            ..AppState::default()
        };

        // When stacking a pane.
        let commands = IntentHandler::handle(&Intent::StackPane, &mut state);

        // Then nothing is asked for.
        assert!(commands.is_empty(), "stacking needs a shown layout");
    }

    #[rstest::rstest]
    fn move_focus_saves_the_layout() {
        // Given shell pane 50 split off and focused.
        let mut state = split_layout();

        // When moving the focus left.
        let commands = IntentHandler::handle(&Intent::MoveFocus(NavDirection::Left), &mut state);

        // Then session 1's layout is saved.
        assert!(
            commands.contains(&Command::Sessions(SessionsCommand::SaveLayout(SessionId(
                1
            )))),
            "a focus move should be saved"
        );
    }

    #[rstest::rstest]
    fn moving_focus_returns_save_jumps() {
        // Given the keys in agent 2's pane, agent 1's pane to its left.
        let mut state = two_agents();

        // When moving the focus left.
        let commands = IntentHandler::handle(&Intent::MoveFocus(NavDirection::Left), &mut state);

        // Then the jump list is saved.
        assert!(
            commands.contains(&Command::Sessions(SessionsCommand::SaveJumps)),
            "a focus move between agents should save the jump list"
        );
    }

    #[rstest::rstest]
    fn close_pane_saves_the_layout() {
        // Given shell pane 50 split off and focused.
        let mut state = split_layout();

        // When closing it.
        let commands = IntentHandler::handle(&Intent::ClosePane, &mut state);

        // Then session 1's layout is saved.
        assert!(
            commands.contains(&Command::Sessions(SessionsCommand::SaveLayout(SessionId(
                1
            )))),
            "a closed pane should be saved"
        );
    }

    #[rstest::rstest]
    fn zoom_saves_nothing() {
        // Given two panes side by side.
        let mut state = split_layout();

        // When zooming.
        let commands = IntentHandler::handle(&Intent::ToggleZoom, &mut state);

        // Then nothing is saved.
        assert!(commands.is_empty(), "zoom isn't saved");
    }

    #[rstest::rstest]
    fn close_pane_on_a_split_removes_it() {
        // Given shell pane 50 split off and focused.
        let mut state = split_layout();

        // When closing the focused pane.
        IntentHandler::handle(&Intent::ClosePane, &mut state);

        // Then only agent 1's pane is left, focused.
        assert_eq!(
            (pane_count(&state), shown_focus(&state)),
            (1, Some(PaneId(1))),
            "closing the split leaves the agent's pane"
        );
    }

    #[rstest::rstest]
    fn close_pane_on_an_agents_pane_closes_it() {
        // Given agent 1's lone pane with the keys.
        let mut state = with_layout(Focus::Pane);

        // When closing it.
        let commands = IntentHandler::handle(&Intent::ClosePane, &mut state);

        // Then its layout is gone and saved as such.
        assert_eq!(
            (state.layouts.get(SessionId(1)).is_some(), commands),
            (
                false,
                vec![Command::Sessions(SessionsCommand::SaveLayout(SessionId(1)))]
            ),
            "an agent's pane closes like any other"
        );
    }

    #[rstest::rstest]
    fn move_focus_left_from_the_only_tabs_leftmost_pane_keeps_the_keys() {
        // Given agent 1's lone pane in its only tab, with the keys.
        let mut state = with_layout(Focus::Pane);

        // When moving the focus left (`Alt h`).
        let commands = IntentHandler::handle(&Intent::MoveFocus(NavDirection::Left), &mut state);

        // Then the pane keeps the keys and nothing happens.
        assert_eq!(
            (state.focus, commands),
            (Focus::Pane, vec![]),
            "Alt h never reaches the sidebar"
        );
    }

    #[rstest::rstest]
    #[case::left(NavDirection::Left)]
    #[case::down(NavDirection::Down)]
    #[case::up(NavDirection::Up)]
    #[case::right(NavDirection::Right)]
    fn move_focus_in_the_sidebar_does_nothing(#[case] nav: NavDirection) {
        // Given agent 1's layout shown while the sidebar has the keys.
        let mut state = with_layout(Focus::Sidebar);

        // When moving the focus (`Alt h/j/k/l`).
        let commands = IntentHandler::handle(&Intent::MoveFocus(nav), &mut state);

        // Then the sidebar keeps the keys and nothing happens.
        assert_eq!(
            (state.focus, commands),
            (Focus::Sidebar, vec![]),
            "Alt {nav:?} does nothing in the sidebar"
        );
    }

    #[rstest::rstest]
    fn send_ctrl_g_in_a_pane_returns_send_ctrl_g() {
        // Given the keys in session 1's pane.
        let mut state = with_layout(Focus::Pane);

        // When handling SendCtrlG (`<C-g> <C-g>`).
        let commands = IntentHandler::handle(&Intent::SendCtrlG, &mut state);

        // Then the frontend is asked to write Ctrl g to the pane.
        assert_eq!(
            commands,
            vec![Command::SendCtrlG],
            "<C-g> <C-g> should send Ctrl g to the pane"
        );
    }

    #[rstest::rstest]
    fn send_ctrl_g_in_the_sidebar_returns_nothing() {
        // Given session 1's layout shown with the keys in the sidebar.
        let mut state = with_layout(Focus::Sidebar);

        // When handling SendCtrlG.
        let commands = IntentHandler::handle(&Intent::SendCtrlG, &mut state);

        // Then nothing is sent: no pane has the keys.
        assert!(commands.is_empty(), "no pane to send Ctrl g to");
    }

    #[rstest::rstest]
    fn grow_in_a_pane_grows_it() {
        // Given shell pane 50 split off on the right and focused.
        let mut state = split_layout();
        let width = |state: &AppState| {
            state
                .shown_layout()?
                .placed(Rect::new(0, 0, 80, 24), |_| 0)
                .panes
                .into_iter()
                .find(|place| place.pane == PaneId(50))
                .map(|place| place.area.width)
        };
        let before = width(&state);

        // When growing.
        IntentHandler::handle(&Intent::GrowFocused, &mut state);

        // Then pane 50 is 24 columns wider: 30% of the 80-column tab.
        assert_eq!(
            width(&state),
            before.map(|width| width + 24),
            "Alt + grows the focused pane"
        );
    }

    #[rstest::rstest]
    fn grow_that_stacks_returns_save_layout() {
        // Given two panes over a 10-column body, too narrow for a grow step.
        let mut state = split_layout();
        state.layouts.fit_to(Rect::new(0, 0, 10, 24));

        // When growing.
        let commands = IntentHandler::handle(&Intent::GrowFocused, &mut state);

        // Then the stacked layout is saved.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::SaveLayout(SessionId(1)))],
            "an Alt + that stacks the split saves the layout"
        );
    }

    #[rstest::rstest]
    fn grow_that_only_zooms_returns_no_commands() {
        // Given two panes over a 10-column body that one Alt + stacked.
        let mut state = split_layout();
        state.layouts.fit_to(Rect::new(0, 0, 10, 24));
        IntentHandler::handle(&Intent::GrowFocused, &mut state);

        // When growing again.
        let commands = IntentHandler::handle(&Intent::GrowFocused, &mut state);

        // Then nothing is saved.
        assert!(
            commands.is_empty(),
            "an Alt + that only zooms leaves the saved tree alone"
        );
    }

    /// Shell pane 50's width in the 80-column tab.
    fn pane_50_width(state: &AppState) -> Option<u16> {
        state
            .shown_layout()?
            .placed(Rect::new(0, 0, 80, 24), |_| 0)
            .panes
            .into_iter()
            .find(|place| place.pane == PaneId(50))
            .map(|place| place.area.width)
    }

    #[rstest::rstest]
    fn resize_side_grows_the_focused_pane_5_percent() {
        // Given shell pane 50 split off on the right and focused.
        let mut state = split_layout();
        let before = pane_50_width(&state);

        // When pushing its left border out.
        IntentHandler::handle(
            &Intent::ResizeFocused {
                dir: NavDirection::Left,
                grow: true,
            },
            &mut state,
        );

        // Then pane 50 is 4 columns wider: 5% of the 80-column tab.
        assert_eq!(
            pane_50_width(&state),
            before.map(|width| width + 4),
            "a resize-mode step moves the border 5% of the tab"
        );
    }

    #[rstest::rstest]
    fn resize_side_that_changes_the_tree_returns_save_layout() {
        // Given shell pane 50 split off on the right and focused.
        let mut state = split_layout();

        // When pushing its left border out.
        let commands = IntentHandler::handle(
            &Intent::ResizeFocused {
                dir: NavDirection::Left,
                grow: true,
            },
            &mut state,
        );

        // Then the layout is saved.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::SaveLayout(SessionId(1)))],
            "a resize-mode step that changes the tree saves the layout"
        );
    }

    #[rstest::rstest]
    fn resize_side_on_a_zoomed_tab_returns_no_commands() {
        // Given two panes side by side, zoomed.
        let mut state = split_layout();
        IntentHandler::handle(&Intent::ToggleZoom, &mut state);

        // When pushing the focused pane's left border out.
        let commands = IntentHandler::handle(
            &Intent::ResizeFocused {
                dir: NavDirection::Left,
                grow: true,
            },
            &mut state,
        );

        // Then nothing is saved.
        assert!(
            commands.is_empty(),
            "resize mode on a zoomed tab changes nothing"
        );
    }

    #[rstest::rstest]
    fn move_pane_that_moves_returns_save_layout() {
        // Given shell pane 50 split off on the right and focused.
        let mut state = split_layout();

        // When moving it left.
        let commands = IntentHandler::handle(&Intent::MovePane(NavDirection::Left), &mut state);

        // Then the layout is saved.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::SaveLayout(SessionId(1)))],
            "a move that swaps panes saves the layout"
        );
    }

    #[rstest::rstest]
    fn move_pane_in_order_on_a_lone_pane_returns_no_commands() {
        // Given the keys in a lone pane.
        let mut state = with_layout(Focus::Pane);

        // When moving it to the next pane.
        let commands =
            IntentHandler::handle(&Intent::MovePaneInOrder { forward: true }, &mut state);

        // Then nothing is saved.
        assert!(commands.is_empty(), "a lone pane has nothing to swap with");
    }

    #[rstest::rstest]
    fn move_pane_keeps_the_focus_on_the_moved_pane() {
        // Given shell pane 50 split off on the right and focused.
        let mut state = split_layout();

        // When moving it left.
        IntentHandler::handle(&Intent::MovePane(NavDirection::Left), &mut state);

        // Then pane 50 still has the focus.
        assert_eq!(
            shown_focus(&state),
            Some(PaneId(50)),
            "the focus follows the moved pane"
        );
    }

    #[rstest::rstest]
    fn move_pane_on_a_zoomed_tab_returns_no_commands() {
        // Given two panes side by side, zoomed.
        let mut state = split_layout();
        IntentHandler::handle(&Intent::ToggleZoom, &mut state);

        // When moving the focused pane left.
        let commands = IntentHandler::handle(&Intent::MovePane(NavDirection::Left), &mut state);

        // Then nothing is saved.
        assert!(
            commands.is_empty(),
            "move mode on a zoomed tab changes nothing"
        );
    }

    #[rstest::rstest]
    fn move_pane_in_the_sidebar_does_nothing() {
        // Given two panes side by side, the keys in the sidebar.
        let mut state = split_layout();
        state.focus = Focus::Sidebar;

        // When moving the focused pane left.
        let commands = IntentHandler::handle(&Intent::MovePane(NavDirection::Left), &mut state);

        // Then nothing is saved.
        assert!(commands.is_empty(), "a move needs the keys in a pane");
    }

    #[rstest::rstest]
    fn enter_pane_mode_in_a_pane_turns_it_on() {
        // Given the keys in a pane.
        let mut state = with_layout(Focus::Pane);

        // When entering resize mode.
        IntentHandler::handle(&Intent::EnterPaneMode(PaneMode::Resize), &mut state);

        // Then resize mode is on.
        assert_eq!(
            state.pane_mode(),
            Some(PaneMode::Resize),
            "<C-g> r in a pane turns resize mode on"
        );
    }

    #[rstest::rstest]
    fn enter_pane_mode_in_the_sidebar_does_nothing() {
        // Given the keys in the sidebar.
        let mut state = with_layout(Focus::Sidebar);

        // When entering resize mode.
        IntentHandler::handle(&Intent::EnterPaneMode(PaneMode::Resize), &mut state);

        // Then no mode is turned on.
        assert_eq!(state.pane_mode, None, "a pane mode needs a pane");
    }

    #[rstest::rstest]
    fn exit_pane_mode_turns_it_off() {
        // Given resize mode on in a pane.
        let mut state = with_layout(Focus::Pane);
        state.pane_mode = Some(PaneMode::Resize);

        // When leaving the mode.
        IntentHandler::handle(&Intent::ExitPaneMode, &mut state);

        // Then no mode is on.
        assert_eq!(state.pane_mode(), None, "Esc or Enter leaves the mode");
    }

    #[rstest::rstest]
    #[case(Intent::SplitPane(Split::Right))]
    #[case(Intent::StackPane)]
    #[case(Intent::BreakPane)]
    fn tiled_only_intents_do_nothing_while_a_float_has_the_keys(#[case] intent: Intent) {
        // Given two panes side by side and a float with the keys.
        let mut state = split_layout();
        state.layouts.add_float(SessionId(1), test_entry(70));

        // When handling the tiled-only intent.
        let commands = IntentHandler::handle(&intent, &mut state);

        // Then nothing happens.
        assert!(
            commands.is_empty(),
            "{intent:?} waits while a float has the keys"
        );
    }

    #[rstest::rstest]
    fn zoom_does_nothing_while_a_float_has_the_keys() {
        // Given two panes side by side and a float with the keys.
        let mut state = split_layout();
        state.layouts.add_float(SessionId(1), test_entry(70));

        // When zooming.
        IntentHandler::handle(&Intent::ToggleZoom, &mut state);

        // Then the tab isn't zoomed.
        let zoomed = state
            .shown_layout()
            .and_then(SessionLayout::active_tab)
            .is_some_and(Tab::zoomed);
        assert!(!zoomed, "zoom waits while a float has the keys");
    }

    #[rstest::rstest]
    fn toggle_zoom_zooms_the_shown_tab() {
        // Given two panes side by side.
        let mut state = split_layout();

        // When zooming.
        IntentHandler::handle(&Intent::ToggleZoom, &mut state);

        // Then the tab is zoomed.
        let zoomed = state
            .shown_layout()
            .and_then(SessionLayout::active_tab)
            .is_some_and(Tab::zoomed);
        assert!(zoomed, "the shown tab should be zoomed");
    }

    #[rstest::rstest]
    fn new_tab_asks_the_sessions_actor_for_a_tab() {
        // Given agent 1's one-tab layout.
        let mut state = with_layout(Focus::Pane);

        // When opening a tab.
        let commands = IntentHandler::handle(&Intent::NewTab, &mut state);

        // Then the sessions actor is asked for a tab in session 1.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::NewTab(SessionId(1)))],
            "a new tab goes through the sessions actor, which makes the pane"
        );
    }

    #[rstest::rstest]
    fn close_tab_removes_the_shown_tab() {
        // Given a second tab shown.
        let mut state = two_tabs();

        // When closing the tab.
        IntentHandler::handle(&Intent::CloseTab, &mut state);

        // Then only the first tab is left, shown.
        assert_eq!(
            (tab_count(&state), shown_tab(&state)),
            (1, Some(0)),
            "the shown tab closes"
        );
    }

    #[rstest::rstest]
    fn close_tab_holding_an_agents_pane_closes_it() {
        // Given agent 1's one-tab layout.
        let mut state = with_layout(Focus::Pane);

        // When closing the tab.
        let commands = IntentHandler::handle(&Intent::CloseTab, &mut state);

        // Then its layout is gone and saved as such.
        assert_eq!(
            (state.layouts.get(SessionId(1)).is_some(), commands),
            (
                false,
                vec![Command::Sessions(SessionsCommand::SaveLayout(SessionId(1)))]
            ),
            "a tab holding an agent's pane closes like any other"
        );
    }

    #[rstest::rstest]
    fn rename_tab_opens_the_rename_box_on_the_tab() {
        // Given a second tab shown.
        let mut state = two_tabs();

        // When renaming the tab.
        IntentHandler::handle(&Intent::RenameTab, &mut state);

        // Then the rename box names agent 1's second tab and has the keys.
        assert_eq!(
            (
                state.rename.as_ref().map(|rename| rename.target),
                state.focus
            ),
            (
                Some(RenameTarget::Tab {
                    owner: SessionId(1),
                    tab: 1
                }),
                Focus::Rename
            ),
            "the rename box opens on the shown tab"
        );
    }

    #[rstest::rstest]
    fn rename_pane_opens_the_rename_box_on_the_focused_pane() {
        // Given shell pane 50 split off and focused, named "server".
        let mut state = split_layout();
        state.layouts.rename_pane(PaneId(50), Some("server".into()));

        // When renaming the pane.
        IntentHandler::handle(&Intent::RenamePane, &mut state);

        // Then the rename box names pane 50, holding its name, and has the keys.
        assert_eq!(
            (
                state
                    .rename
                    .as_ref()
                    .map(|rename| (rename.target, rename.input.text().to_owned())),
                state.focus
            ),
            (
                Some((RenameTarget::Pane(PaneId(50)), "server".to_owned())),
                Focus::Rename
            ),
            "the rename box opens on the focused pane"
        );
    }

    #[rstest::rstest]
    fn go_to_tab_shows_it() {
        // Given a second tab shown.
        let mut state = two_tabs();

        // When going to tab 1.
        IntentHandler::handle(&Intent::GoToTab(1), &mut state);

        // Then the first tab is shown.
        assert_eq!(shown_tab(&state), Some(0), "Alt 1 shows the first tab");
    }

    #[rstest::rstest]
    fn next_swap_layout_moves_a_lone_pane_tab_to_vertical() {
        // Given one pane in a fresh tab (BASE).
        let mut state = with_layout(Focus::Pane);

        // When handling Intent::NextSwapLayout.
        IntentHandler::handle(&Intent::NextSwapLayout, &mut state);

        // Then the shown tab is vertical.
        assert_eq!(
            shown_swap_layout(&state),
            Some(SwapLayout::Vertical),
            "Alt ] steps BASE to vertical"
        );
    }

    #[rstest::rstest]
    fn previous_swap_layout_wraps_a_lone_pane_tab_to_horizontal() {
        // Given one pane in a fresh tab (BASE).
        let mut state = with_layout(Focus::Pane);

        // When handling Intent::PreviousSwapLayout.
        IntentHandler::handle(&Intent::PreviousSwapLayout, &mut state);

        // Then the shown tab is horizontal (half-stacked and stacked don't fit 1 pane).
        assert_eq!(
            shown_swap_layout(&state),
            Some(SwapLayout::Horizontal),
            "Alt [ wraps BASE back to horizontal"
        );
    }

    /// The shown session's float layout.
    fn shown_float_layout(state: &AppState) -> Option<FloatLayout> {
        state.shown_layout().map(|layout| layout.floats().layout())
    }

    #[rstest::rstest]
    fn next_swap_layout_with_a_float_focused_cycles_the_float_layout() {
        // Given a staggered float of session 1 with the keys.
        let mut state = with_layout(Focus::Pane);
        state.layouts.add_float(SessionId(1), test_entry(70));

        // When handling Intent::NextSwapLayout.
        IntentHandler::handle(&Intent::NextSwapLayout, &mut state);

        // Then the floats are enlarged.
        assert_eq!(
            shown_float_layout(&state),
            Some(FloatLayout::Enlarged),
            "Alt ] on a float steps staggered to enlarged"
        );
    }

    #[rstest::rstest]
    fn next_swap_layout_with_a_float_focused_keeps_the_tab_layout() {
        // Given a float of session 1 with the keys over a fresh tab (BASE).
        let mut state = with_layout(Focus::Pane);
        state.layouts.add_float(SessionId(1), test_entry(70));

        // When handling Intent::NextSwapLayout.
        IntentHandler::handle(&Intent::NextSwapLayout, &mut state);

        // Then the tab is still BASE.
        assert_eq!(
            shown_swap_layout(&state),
            Some(SwapLayout::Base),
            "Alt ] on a float leaves the tab's layout alone"
        );
    }

    #[rstest::rstest]
    fn previous_swap_layout_with_a_float_focused_saves_the_layout() {
        // Given a float of session 1 with the keys.
        let mut state = with_layout(Focus::Pane);
        state.layouts.add_float(SessionId(1), test_entry(70));

        // When handling Intent::PreviousSwapLayout.
        let commands = IntentHandler::handle(&Intent::PreviousSwapLayout, &mut state);

        // Then session 1's layout is saved.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::SaveLayout(SessionId(1)))],
            "a float layout step should be saved"
        );
    }

    #[rstest::rstest]
    fn next_swap_layout_from_the_sidebar_with_floats_shown_cycles_the_tab() {
        // Given a float of session 1 shown while the sidebar has the keys.
        let mut state = with_layout(Focus::Sidebar);
        state.layouts.add_float(SessionId(1), test_entry(70));

        // When handling Intent::NextSwapLayout.
        IntentHandler::handle(&Intent::NextSwapLayout, &mut state);

        // Then the tab steps to vertical.
        assert_eq!(
            shown_swap_layout(&state),
            Some(SwapLayout::Vertical),
            "Alt ] from the sidebar cycles the tab, not the floats"
        );
    }

    #[rstest::rstest]
    fn next_swap_layout_saves_the_layout() {
        // Given one pane in a fresh tab.
        let mut state = with_layout(Focus::Pane);

        // When handling Intent::NextSwapLayout.
        let commands = IntentHandler::handle(&Intent::NextSwapLayout, &mut state);

        // Then session 1's layout is saved.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::SaveLayout(SessionId(1)))],
            "a swap layout step should be saved"
        );
    }

    #[rstest::rstest]
    fn move_tab_left_swaps_it() {
        // Given a second tab shown, named logs.
        let mut state = two_tabs();
        state
            .layouts
            .rename_tab(SessionId(1), 1, Some("logs".to_owned()));

        // When moving it left.
        IntentHandler::handle(&Intent::MoveTabLeft, &mut state);

        // Then logs is the first tab, still shown.
        assert_eq!(
            (shown_tab(&state), shown_tab_name(&state).as_deref()),
            (Some(0), Some("logs")),
            "Alt i moves the tab left"
        );
    }

    #[rstest::rstest]
    fn focus_pane_focuses_the_clicked_pane() {
        // Given shell pane 50 split off and focused, the sidebar with the keys.
        let mut state = split_layout();
        state.focus = Focus::Sidebar;

        // When clicking agent 1's pane.
        IntentHandler::handle(&Intent::FocusPane(PaneId(1)), &mut state);

        // Then agent 1's pane has the focus.
        assert_eq!(
            shown_focus(&state),
            Some(PaneId(1)),
            "the clicked pane is focused"
        );
    }

    #[rstest::rstest]
    fn focus_pane_moves_the_keys_into_the_panes() {
        // Given agent 1's layout shown while the sidebar has the keys.
        let mut state = with_layout(Focus::Sidebar);

        // When clicking agent 1's pane.
        IntentHandler::handle(&Intent::FocusPane(PaneId(1)), &mut state);

        // Then the keys are in the pane.
        assert_eq!(state.focus, Focus::Pane, "a click moves the keys in");
    }

    #[rstest::rstest]
    fn show_stacked_focuses_the_pane() {
        // Given shell pane 50 split off and focused, the sidebar with the keys.
        let mut state = split_layout();
        state.focus = Focus::Sidebar;

        // When the wheel shows agent 1's pane.
        IntentHandler::handle(&Intent::ShowStacked(PaneId(1)), &mut state);

        // Then agent 1's pane has the tab's focus.
        assert_eq!(
            shown_focus(&state),
            Some(PaneId(1)),
            "the wheel shows the next stacked pane"
        );
    }

    #[rstest::rstest]
    fn show_stacked_leaves_the_keys_where_they_are() {
        // Given shell pane 50 split off and focused, the sidebar with the keys.
        let mut state = split_layout();
        state.focus = Focus::Sidebar;

        // When the wheel shows agent 1's pane.
        IntentHandler::handle(&Intent::ShowStacked(PaneId(1)), &mut state);

        // Then the sidebar keeps the keys.
        assert_eq!(state.focus, Focus::Sidebar, "a wheel notch is not a click");
    }

    #[rstest::rstest]
    fn show_stacked_ignores_a_pane_outside_the_shown_tab() {
        // Given shell pane 50 split off and focused.
        let mut state = split_layout();

        // When asked to show pane 99, which no tab holds.
        let commands = IntentHandler::handle(&Intent::ShowStacked(PaneId(99)), &mut state);

        // Then nothing happens.
        assert_eq!(
            (shown_focus(&state), commands),
            (Some(PaneId(50)), vec![]),
            "only the shown tab's panes can be shown"
        );
    }

    #[rstest::rstest]
    fn break_pane_in_a_pane_opens_a_tab() {
        // Given shell pane 50 split off and focused, the keys in it.
        let mut state = split_layout();

        // When handling BreakPane (`<C-g> t b`).
        IntentHandler::handle(&Intent::BreakPane, &mut state);

        // Then the session has a second tab.
        assert_eq!(tab_count(&state), 2, "the pane breaks out to a new tab");
    }

    #[rstest::rstest]
    fn break_pane_saves_the_layout() {
        // Given shell pane 50 split off and focused, the keys in it.
        let mut state = split_layout();

        // When handling BreakPane (`<C-g> t b`).
        let commands = IntentHandler::handle(&Intent::BreakPane, &mut state);

        // Then session 1's layout is saved.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::SaveLayout(SessionId(1)))],
            "the new tab is saved"
        );
    }

    #[rstest::rstest]
    fn break_pane_from_the_sidebar_does_nothing() {
        // Given shell pane 50 split off and focused, the sidebar with the keys.
        let mut state = split_layout();
        state.focus = Focus::Sidebar;

        // When handling BreakPane.
        IntentHandler::handle(&Intent::BreakPane, &mut state);

        // Then the session keeps one tab.
        assert_eq!(tab_count(&state), 1, "breaking a pane needs the keys in it");
    }

    #[rstest::rstest]
    fn focus_pane_on_a_tiled_pane_with_floats_shown_hides_them() {
        // Given a shown float over agent 1's pane.
        let mut state = with_layout(Focus::Pane);
        state.layouts.add_float(SessionId(1), test_entry(70));

        // When clicking agent 1's pane.
        IntentHandler::handle(&Intent::FocusPane(PaneId(1)), &mut state);

        // Then the floats are hidden.
        assert_eq!(
            state.shown_layout().map(SessionLayout::float_focused),
            Some(false),
            "a click on a tiled pane hides the floats"
        );
    }

    #[rstest::rstest]
    fn focus_pane_on_a_float_brings_it_to_the_top() {
        // Given floats 70 and 71, 71 on top.
        let mut state = with_layout(Focus::Pane);
        state.layouts.add_float(SessionId(1), test_entry(70));
        state.layouts.add_float(SessionId(1), test_entry(71));

        // When clicking float 70.
        IntentHandler::handle(&Intent::FocusPane(PaneId(70)), &mut state);

        // Then float 70 is on top with the keys.
        assert_eq!(
            shown_focus(&state),
            Some(PaneId(70)),
            "a click on a float brings it to the top"
        );
    }

    #[rstest::rstest]
    fn focus_pane_on_a_pinned_float_shows_the_floats() {
        // Given a pinned float, hidden.
        let mut state = with_layout(Focus::Pane);
        state.layouts.add_float(SessionId(1), test_entry(70));
        IntentHandler::handle(&Intent::TogglePinFloat, &mut state);
        state.layouts.toggle_floats(SessionId(1));

        // When clicking the pinned float.
        IntentHandler::handle(&Intent::FocusPane(PaneId(70)), &mut state);

        // Then the floats are shown.
        assert_eq!(
            state.shown_layout().map(SessionLayout::float_focused),
            Some(true),
            "a click on a pinned float shows the floats"
        );
    }

    #[rstest::rstest]
    fn drag_float_moves_the_focused_float() {
        // Given a float of session 1 with the keys.
        let mut state = with_layout(Focus::Pane);
        state.layouts.add_float(SessionId(1), test_entry(70));

        // When dragging it to (3, 4).
        IntentHandler::handle(
            &Intent::DragFloat {
                pane: PaneId(70),
                x: 3,
                y: 4,
            },
            &mut state,
        );

        // Then its frame's top-left corner is at (3, 4).
        let corner = state.shown_layout().and_then(|layout| {
            layout
                .floats()
                .visible(Rect::new(0, 0, 80, 24))
                .last()
                .map(|(_, frame, _)| (frame.x, frame.y))
        });
        assert_eq!(corner, Some((3, 4)), "the dragged float follows the mouse");
    }

    #[rstest::rstest]
    fn drag_float_returns_no_commands() {
        // Given a float of session 1 with the keys.
        let mut state = with_layout(Focus::Pane);
        state.layouts.add_float(SessionId(1), test_entry(70));

        // When dragging it.
        let commands = IntentHandler::handle(
            &Intent::DragFloat {
                pane: PaneId(70),
                x: 3,
                y: 4,
            },
            &mut state,
        );

        // Then nothing is saved yet.
        assert!(commands.is_empty(), "only the release saves a drag");
    }

    #[rstest::rstest]
    fn drop_float_saves_the_layout() {
        // Given a float of session 1 with the keys.
        let mut state = with_layout(Focus::Pane);
        state.layouts.add_float(SessionId(1), test_entry(70));

        // When releasing a drag.
        let commands = IntentHandler::handle(&Intent::DropFloat, &mut state);

        // Then the layout is saved.
        assert_eq!(
            commands,
            vec![Command::Sessions(SessionsCommand::SaveLayout(SessionId(1)))],
            "the release saves the dragged float"
        );
    }

    #[rstest::rstest]
    fn drop_float_without_a_float_does_nothing() {
        // Given agent 1's lone pane with the keys.
        let mut state = with_layout(Focus::Pane);

        // When releasing a drag.
        let commands = IntentHandler::handle(&Intent::DropFloat, &mut state);

        // Then nothing is saved.
        assert!(commands.is_empty(), "no float, nothing to save");
    }

    #[rstest::rstest]
    fn moving_the_focus_between_agents_moves_the_active_row() {
        // Given the keys in agent 2's pane.
        let mut state = two_agents();

        // When moving the focus left onto agent 1's pane.
        IntentHandler::handle(&Intent::MoveFocus(NavDirection::Left), &mut state);

        // Then the active row is agent 1's.
        assert_eq!(
            state.active_row(),
            Some(agent_row(1, 1)),
            "the active row should follow the focused agent"
        );
    }

    #[rstest::rstest]
    fn moving_the_focus_between_agents_keeps_the_cursor() {
        // Given the keys in agent 2's pane, the cursor on session 1's card.
        let mut state = two_agents();

        // When moving the focus left onto agent 1's pane.
        IntentHandler::handle(&Intent::MoveFocus(NavDirection::Left), &mut state);

        // Then the cursor is still on the card.
        assert_eq!(
            state.sessions.cursor,
            Some(on_agent(1)),
            "a focus move in a pane should not move the hover"
        );
    }

    #[rstest::rstest]
    fn focusing_a_shell_pane_marks_the_card() {
        // Given session 1's agent pane focused, shell pane 50 to its right.
        let mut state = split_layout();
        IntentHandler::handle(&Intent::MoveFocus(NavDirection::Left), &mut state);

        // When moving the focus right onto the shell.
        IntentHandler::handle(&Intent::MoveFocus(NavDirection::Right), &mut state);

        // Then the active row is session 1's card.
        assert_eq!(
            state.active_row(),
            Some(on_agent(1)),
            "a shell pane should mark the card"
        );
    }

    #[rstest::rstest]
    fn focusing_an_agent_in_a_folded_session_marks_the_card() {
        // Given the keys in agent 2's pane of folded session 1.
        let mut state = two_agents();
        state.sessions.folded.insert(SessionId(1));

        // When moving the focus left onto agent 1's pane.
        IntentHandler::handle(&Intent::MoveFocus(NavDirection::Left), &mut state);

        // Then the active row is the card.
        assert_eq!(
            state.active_row(),
            Some(on_agent(1)),
            "a folded session should mark its card"
        );
    }

    #[rstest::rstest]
    fn focusing_an_agent_in_a_folded_session_keeps_it_folded() {
        // Given the keys in agent 2's pane of folded session 1.
        let mut state = two_agents();
        state.sessions.folded.insert(SessionId(1));

        // When moving the focus left onto agent 1's pane.
        IntentHandler::handle(&Intent::MoveFocus(NavDirection::Left), &mut state);

        // Then session 1 is still folded.
        assert!(
            state.sessions.hides_agents(SessionId(1)),
            "a focus move should not unfold the card"
        );
    }

    #[rstest::rstest]
    fn clicking_a_shown_pane_keeps_the_active_session() {
        // Given the keys in active session 2's pane, the cursor on attached
        // agent 1.
        let mut state = jumping(Focus::Pane, &[1, 2], &[]);
        state.sessions.cursor = Some(on_agent(1));

        // When clicking session 2's pane.
        IntentHandler::handle(&Intent::FocusPane(PaneId(2)), &mut state);

        // Then session 2 is still active.
        assert_eq!(
            state.sessions.active(),
            Some(SessionId(2)),
            "a click on a shown pane should not enter the hovered session"
        );
    }
}
