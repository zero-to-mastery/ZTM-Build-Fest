//! Which session (and pane) a request is about: the one it names, else the
//! pane the command runs in.

use crate::AppState;
use crate::feat::control::protocol::{ApiError, ErrorCode};
use crate::ids::{PaneId, SessionId};

/// What a request names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Target {
    Pane(PaneId),
    Session(SessionId),
}

/// The session a request is about, and the pane when it named one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Resolved {
    pub session: SessionId,
    pub pane: Option<PaneId>,
}

/// `target` if given, else the caller's pane; `no_target` when neither,
/// `not_found` when the pane or session is missing or being deleted.
pub(crate) fn resolve(
    app: &AppState,
    target: Option<Target>,
    caller: Option<PaneId>,
) -> Result<Resolved, ApiError> {
    match target.or(caller.map(Target::Pane)) {
        None => Err(ApiError::new(
            ErrorCode::NoTarget,
            "no target given and not inside an orb pane",
        )),
        Some(Target::Pane(pane)) => {
            let session = app
                .layouts
                .owner_of(pane)
                .filter(|&session| live(app, session))
                .ok_or_else(|| ApiError::new(ErrorCode::NotFound, format!("no pane {}", pane.0)))?;
            Ok(Resolved {
                session,
                pane: Some(pane),
            })
        }
        Some(Target::Session(session)) if live(app, session) => Ok(Resolved {
            session,
            pane: None,
        }),
        Some(Target::Session(session)) => Err(ApiError::new(
            ErrorCode::NotFound,
            format!("no session {}", session.0),
        )),
    }
}

/// Whether session `id` exists and isn't being deleted.
fn live(app: &AppState, id: SessionId) -> bool {
    app.sessions.session(id).is_some() && !app.sessions.deleting.contains(&id)
}

#[cfg(test)]
mod tests {
    use super::{Resolved, resolve};
    use crate::feat::control::protocol::ErrorCode;
    use crate::feat::sessions::state::AgentStatus;
    use crate::ids::{PaneId, SessionId};
    use crate::intent_handler::test_support::{agent, state_with};

    #[rstest::rstest]
    fn missing_target_resolves_to_the_callers_pane() {
        // Given session 1 with pane 1.
        let app = state_with(vec![agent(1, AgentStatus::Idle)], 1);

        // When resolving no target from pane 1.
        let resolved = resolve(&app, None, Some(PaneId(1)));

        // Then the request is about the caller's pane and its session.
        assert_eq!(
            resolved,
            Ok(Resolved {
                session: SessionId(1),
                pane: Some(PaneId(1)),
            }),
            "no target means the caller's pane"
        );
    }

    #[rstest::rstest]
    fn missing_target_outside_orb_is_no_target() {
        // Given session 1 with pane 1.
        let app = state_with(vec![agent(1, AgentStatus::Idle)], 1);

        // When resolving no target from outside orb.
        let resolved = resolve(&app, None, None);

        // Then it is refused with no_target.
        assert_eq!(
            resolved.map_err(|error| error.code),
            Err(ErrorCode::NoTarget),
            "no target and no caller pane is no_target"
        );
    }
}
