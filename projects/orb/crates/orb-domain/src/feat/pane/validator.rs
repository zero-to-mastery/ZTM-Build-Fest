//! Checks whether the user can attach to the selected session.

use wherror::Error;

use crate::AppState;

/// Why attaching can't proceed.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(debug)]
pub enum AttachError {
    /// No session is selected, or it is being deleted.
    NoSelection,
}

/// Allow attaching only to a selected session that isn't being deleted.
///
/// # Errors
///
/// Returns [`AttachError::NoSelection`] without such a session.
pub fn validate_attach(state: &AppState) -> Result<(), AttachError> {
    match state.sessions.selected_session() {
        None => Err(AttachError::NoSelection),
        Some(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::{AttachError, validate_attach};
    use crate::AppState;

    #[rstest::rstest]
    fn attach_rejected_without_selection() {
        // Given no selected agent.
        let state = AppState::default();

        // When validating attach.
        let result = validate_attach(&state);

        // Then validation fails with NoSelection.
        assert_eq!(
            result,
            Err(AttachError::NoSelection),
            "attach needs a selected agent"
        );
    }
}
