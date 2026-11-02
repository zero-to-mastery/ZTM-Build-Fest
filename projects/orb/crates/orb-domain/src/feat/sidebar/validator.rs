//! Checks whether the user can resize the sidebar (not while it's hidden),
//! or rename the selected row (only a session).

use wherror::Error;

use crate::AppState;

/// Why resizing can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum ResizeError {
    /// The sidebar is hidden.
    Hidden,
}

/// Allow resizing only while the sidebar is shown.
///
/// # Errors
///
/// Returns [`ResizeError::Hidden`] while the sidebar is hidden.
pub fn validate_resize(state: &AppState) -> Result<(), ResizeError> {
    if state.sidebar.hidden {
        Err(ResizeError::Hidden)
    } else {
        Ok(())
    }
}

/// Why renaming can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum RenameError {
    /// The cursor isn't on a session.
    NoSession,
}

/// Allow renaming only the selected session, not the Settled header.
///
/// # Errors
///
/// Returns [`RenameError::NoSession`] without a selected session.
pub fn validate_rename(state: &AppState) -> Result<(), RenameError> {
    match state.sessions.selected_session() {
        None => Err(RenameError::NoSession),
        Some(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::{RenameError, ResizeError, validate_rename, validate_resize};
    use crate::AppState;
    use crate::feat::sessions::state::{Sessions, SidebarItem};
    use crate::feat::sidebar::state::SidebarView;

    fn hidden() -> AppState {
        AppState {
            sidebar: SidebarView {
                hidden: true,
                ..SidebarView::default()
            },
            ..AppState::default()
        }
    }

    #[rstest::rstest]
    fn resize_rejected_while_hidden() {
        // Given a hidden sidebar.
        let state = hidden();

        // When validating a resize.
        let result = validate_resize(&state);

        // Then validation fails with Hidden.
        assert_eq!(
            result,
            Err(ResizeError::Hidden),
            "a hidden sidebar can't be resized"
        );
    }

    #[rstest::rstest]
    #[case::shelf_header(SidebarItem::SettledShelf)]
    fn rename_rejected_without_a_selected_session(#[case] cursor: SidebarItem) {
        // Given the cursor on the Settled header.
        let state = AppState {
            sessions: Sessions {
                cursor: Some(cursor),
                ..Sessions::default()
            },
            ..AppState::default()
        };

        // When validating a rename.
        let result = validate_rename(&state);

        // Then validation fails with NoSession.
        assert_eq!(
            result,
            Err(RenameError::NoSession),
            "only a session can be renamed"
        );
    }
}
