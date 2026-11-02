//! Checks whether a pane, float or tab action can act on the shown layout.

use wherror::Error;

use crate::feat::layout::state::SessionLayout;
use crate::ids::PaneId;
use crate::{AppState, Focus};

/// Why a pane action (focus move between panes, split, close, zoom, pane
/// resize) can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum PaneActionError {
    /// The keys aren't in a pane.
    NotInPane,
    /// The selected agent has no layout.
    NoLayout,
}

/// Allow a pane action while the keys are in a pane of the shown layout.
///
/// # Errors
///
/// Returns [`PaneActionError::NotInPane`] when the keys are elsewhere, and
/// [`PaneActionError::NoLayout`] when no layout is shown.
pub fn validate_pane_action(state: &AppState) -> Result<(), PaneActionError> {
    if state.focus != Focus::Pane {
        return Err(PaneActionError::NotInPane);
    }
    state
        .shown_layout()
        .map(drop)
        .ok_or(PaneActionError::NoLayout)
}

/// Why a float action (pinning) can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum FloatActionError {
    /// The keys aren't in a pane.
    NotInPane,
    /// No float has the keys.
    NoFloatFocused,
}

/// Allow a float action while a float of the shown layout has the keys.
///
/// # Errors
///
/// Returns [`FloatActionError::NotInPane`] when the keys are elsewhere, and
/// [`FloatActionError::NoFloatFocused`] when no float has them.
pub fn validate_float_action(state: &AppState) -> Result<(), FloatActionError> {
    if state.focus != Focus::Pane {
        return Err(FloatActionError::NotInPane);
    }
    if state
        .shown_layout()
        .is_some_and(SessionLayout::float_focused)
    {
        Ok(())
    } else {
        Err(FloatActionError::NoFloatFocused)
    }
}

/// Why a tiled-only action (split, stack, zoom, break out) can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum TiledActionError {
    /// The keys aren't in a pane, or no layout is shown.
    Pane(PaneActionError),
    /// A float has the keys.
    FloatFocused,
}

/// Allow a tiled-only action while the keys are in a tiled pane of the shown
/// layout.
///
/// # Errors
///
/// Returns [`TiledActionError::Pane`] when a pane action can't proceed, and
/// [`TiledActionError::FloatFocused`] when a float has the keys.
pub fn validate_tiled_action(state: &AppState) -> Result<(), TiledActionError> {
    validate_pane_action(state).map_err(TiledActionError::Pane)?;
    if state
        .shown_layout()
        .is_some_and(SessionLayout::float_focused)
    {
        return Err(TiledActionError::FloatFocused);
    }
    Ok(())
}

/// Why a tab action can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum TabActionError {
    /// The selected agent has no layout.
    NoLayout,
}

/// Allow a tab action while a layout is shown.
///
/// # Errors
///
/// Returns [`TabActionError::NoLayout`] when no layout is shown.
pub fn validate_tab_action(state: &AppState) -> Result<(), TabActionError> {
    state
        .shown_layout()
        .map(drop)
        .ok_or(TabActionError::NoLayout)
}

/// Why a click can't focus a pane.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum FocusPaneError {
    /// The selected agent has no layout.
    NoLayout,
    /// The pane isn't in the shown tab or a drawn float.
    NotShown,
}

/// Allow focusing `pane` when it is in the shown tab or is one of its drawn floats.
///
/// # Errors
///
/// Returns [`FocusPaneError::NoLayout`] when no layout is shown, and
/// [`FocusPaneError::NotShown`] when `pane` isn't in its shown tab or a drawn float.
pub fn validate_focus_pane(state: &AppState, pane: PaneId) -> Result<(), FocusPaneError> {
    let layout = state.shown_layout().ok_or(FocusPaneError::NoLayout)?;
    if layout.active_tab().is_some_and(|tab| tab.holds(pane)) || layout.floats().draws(pane) {
        Ok(())
    } else {
        Err(FocusPaneError::NotShown)
    }
}

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use super::{
        FloatActionError, FocusPaneError, PaneActionError, TabActionError, TiledActionError,
        validate_float_action, validate_focus_pane, validate_pane_action, validate_tab_action,
        validate_tiled_action,
    };
    use crate::feat::harness::HarnessId;
    use crate::feat::layout::state::{SessionLayout, test_entry};
    use crate::feat::layout::tree::Split;
    use crate::feat::sessions::state::{
        Agent, AgentStatus, PaneLaunch, Project, ProjectKind, Sessions, SidebarItem, sessions_for,
    };
    use crate::ids::{AgentId, PaneId, ProjectId, SessionId};
    use crate::{AppState, Focus};

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

    /// Agent 1 selected, running in pane 1 of session 1, with the keys at
    /// `focus`; attached and active, so its session is shown, when `open`.
    fn selected(focus: Focus, open: bool) -> AppState {
        let mut state = AppState {
            sessions: Sessions {
                projects: vec![Project {
                    id: ProjectId(1),
                    title: "work".into(),
                    root: "/work".into(),
                    created_at: SystemTime::UNIX_EPOCH,
                    removed: false,
                    repo: true,
                    agents: vec![agent(1)],
                    kind: ProjectKind::Normal,
                }],
                cursor: Some(SidebarItem::Session(SessionId(1))),
                ..Sessions::default()
            },
            focus,
            ..AppState::default()
        };
        state.sessions.sessions = sessions_for(&state.sessions.projects);
        state
            .layouts
            .insert(SessionId(1), SessionLayout::of(test_entry(1)));
        if open {
            state.attached.insert(SessionId(1));
            state.sessions.enter(SessionId(1));
        }
        state
    }

    #[rstest::rstest]
    fn pane_action_is_refused_outside_a_pane() {
        // Given the keys in the sidebar beside an open layout.
        let state = selected(Focus::Sidebar, true);

        // When validating a pane action.
        let result = validate_pane_action(&state);

        // Then it is refused.
        assert_eq!(
            result,
            Err(PaneActionError::NotInPane),
            "pane actions need the keys in a pane"
        );
    }

    #[rstest::rstest]
    fn pane_action_is_refused_without_a_layout() {
        // Given the keys in a pane but no layout open.
        let state = selected(Focus::Pane, false);

        // When validating a pane action.
        let result = validate_pane_action(&state);

        // Then it is refused.
        assert_eq!(
            result,
            Err(PaneActionError::NoLayout),
            "pane actions need a shown layout"
        );
    }

    #[rstest::rstest]
    fn pane_action_is_allowed_in_a_shown_pane() {
        // Given the keys in a pane of the shown layout.
        let state = selected(Focus::Pane, true);

        // When validating a pane action.
        let result = validate_pane_action(&state);

        // Then it is allowed.
        assert_eq!(result, Ok(()), "pane action in a shown pane");
    }

    #[rstest::rstest]
    fn float_action_rejected_without_a_float_focused() {
        // Given the keys in a tiled pane of the shown layout.
        let state = selected(Focus::Pane, true);

        // When validating a float action.
        let result = validate_float_action(&state);

        // Then it is refused.
        assert_eq!(
            result,
            Err(FloatActionError::NoFloatFocused),
            "float actions need a float with the keys"
        );
    }

    #[rstest::rstest]
    fn float_action_is_allowed_while_a_float_has_the_keys() {
        // Given a float of the shown layout with the keys.
        let mut state = selected(Focus::Pane, true);
        state.layouts.add_float(SessionId(1), test_entry(20));

        // When validating a float action.
        let result = validate_float_action(&state);

        // Then it is allowed.
        assert_eq!(result, Ok(()), "float action on a focused float");
    }

    #[rstest::rstest]
    fn tiled_action_rejected_while_a_float_has_the_keys() {
        // Given a float of the shown layout with the keys.
        let mut state = selected(Focus::Pane, true);
        state.layouts.add_float(SessionId(1), test_entry(20));

        // When validating a tiled-only action.
        let result = validate_tiled_action(&state);

        // Then it is refused.
        assert_eq!(
            result,
            Err(TiledActionError::FloatFocused),
            "tiled-only actions wait while a float has the keys"
        );
    }

    #[rstest::rstest]
    fn tab_action_is_refused_without_a_layout() {
        // Given no layout open.
        let state = selected(Focus::Sidebar, false);

        // When validating a tab action.
        let result = validate_tab_action(&state);

        // Then it is refused.
        assert_eq!(
            result,
            Err(TabActionError::NoLayout),
            "tab actions need a shown layout"
        );
    }

    #[rstest::rstest]
    fn tab_action_is_allowed_with_a_shown_layout() {
        // Given an open layout.
        let state = selected(Focus::Sidebar, true);

        // When validating a tab action.
        let result = validate_tab_action(&state);

        // Then it is allowed.
        assert_eq!(result, Ok(()), "tab action with a shown layout");
    }

    #[rstest::rstest]
    fn focus_pane_is_refused_for_a_pane_of_another_tab() {
        // Given a second tab shown, holding pane 2.
        let mut state = selected(Focus::Sidebar, true);
        state.layouts.new_tab(SessionId(1), test_entry(2));

        // When validating a click on the agent's own pane in the first tab.
        let result = validate_focus_pane(&state, PaneId(1));

        // Then it is refused.
        assert_eq!(
            result,
            Err(FocusPaneError::NotShown),
            "only the shown tab's panes take clicks"
        );
    }

    #[rstest::rstest]
    fn focus_pane_is_allowed_for_a_pane_of_the_shown_tab() {
        // Given a split shown tab.
        let mut state = selected(Focus::Sidebar, true);
        state
            .layouts
            .split(SessionId(1), Split::Right, test_entry(2));

        // When validating a click on pane 2.
        let result = validate_focus_pane(&state, PaneId(2));

        // Then it is allowed.
        assert_eq!(result, Ok(()), "a shown pane takes clicks");
    }

    #[rstest::rstest]
    fn focus_pane_is_allowed_for_a_shown_float() {
        // Given a shown float over the shown layout.
        let mut state = selected(Focus::Sidebar, true);
        state.layouts.add_float(SessionId(1), test_entry(20));

        // When validating a click on the float.
        let result = validate_focus_pane(&state, PaneId(20));

        // Then it is allowed.
        assert_eq!(result, Ok(()), "a shown float takes clicks");
    }

    #[rstest::rstest]
    fn focus_pane_is_refused_for_a_hidden_unpinned_float() {
        // Given a hidden, unpinned float.
        let mut state = selected(Focus::Sidebar, true);
        state.layouts.add_float(SessionId(1), test_entry(20));
        state.layouts.toggle_floats(SessionId(1));

        // When validating a click on the float.
        let result = validate_focus_pane(&state, PaneId(20));

        // Then it is refused.
        assert_eq!(
            result,
            Err(FocusPaneError::NotShown),
            "a hidden float isn't drawn and takes no clicks"
        );
    }
}
