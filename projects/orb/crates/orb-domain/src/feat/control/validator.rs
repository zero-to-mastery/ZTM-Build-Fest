//! Checks a request must pass before it changes anything.

use crate::AppState;
use crate::feat::control::agent;
use crate::feat::control::protocol::{ApiError, ErrorCode};
use crate::feat::sessions::state::{Agent, AgentStatus};
use crate::ids::{PaneId, SessionId};

/// Refuses a change to settled session `session` with `settled`.
pub(crate) fn not_settled(app: &AppState, session: SessionId) -> Result<(), ApiError> {
    match app.sessions.session(session) {
        Some(found) if found.settled_at.is_some() => {
            Err(ApiError::new(ErrorCode::Settled, "session is settled"))
        }
        _ => Ok(()),
    }
}

/// Refuses `pane` with `pane_busy` while an agent bound to it may be running.
pub(crate) fn pane_free(app: &AppState, pane: PaneId) -> Result<(), ApiError> {
    match agent::pane_agent(app, pane) {
        Some(found) if agent::live(found.status) => Err(ApiError::new(
            ErrorCode::PaneBusy,
            format!("an agent is already live in pane {}", pane.0),
        )),
        _ => Ok(()),
    }
}

/// `pane`'s agent, ready for a prompt: `no_agent` when none is live,
/// `agent_blocked` while it waits for approval or input.
pub(crate) fn agent_ready(app: &AppState, pane: PaneId) -> Result<&Agent, ApiError> {
    let found = agent::pane_agent(app, pane)
        .filter(|found| agent::live(found.status))
        .ok_or_else(|| agent::no_agent(pane))?;
    match found.status {
        AgentStatus::NeedsApproval | AgentStatus::NeedsInput => Err(agent::blocked()),
        AgentStatus::Idle
        | AgentStatus::Working
        | AgentStatus::Unknown
        | AgentStatus::Stopped
        | AgentStatus::Gone
        | AgentStatus::Failed => Ok(found),
    }
}

#[cfg(test)]
mod tests {
    use super::{agent_ready, not_settled, pane_free};
    use crate::feat::control::protocol::ErrorCode;
    use crate::feat::sessions::state::AgentStatus;
    use crate::ids::{PaneId, SessionId};
    use crate::intent_handler::test_support::{agent, settle, state_with, stopped};

    #[rstest::rstest]
    fn settled_session_is_refused() {
        // Given session 1, settled.
        let app = settle(state_with(vec![stopped(1)], 1), &[1]);

        // When checking a change to session 1.
        let checked = not_settled(&app, SessionId(1));

        // Then it is refused with settled.
        assert_eq!(
            checked.map_err(|error| error.code),
            Err(ErrorCode::Settled),
            "a settled session can't be changed"
        );
    }

    #[rstest::rstest]
    #[case(AgentStatus::NeedsApproval)]
    #[case(AgentStatus::NeedsInput)]
    fn prompt_is_refused_while_the_agent_waits(#[case] status: AgentStatus) {
        // Given agent 1 in pane 1 waiting on the user.
        let app = state_with(vec![agent(1, status)], 1);

        // When checking a prompt to pane 1.
        let checked = agent_ready(&app, PaneId(1)).map(|_| ());

        // Then it is refused as blocked.
        assert_eq!(
            checked.map_err(|error| error.code),
            Err(ErrorCode::AgentBlocked),
            "an agent waiting on the user can't take a prompt"
        );
    }

    #[rstest::rstest]
    fn prompt_without_a_live_agent_is_no_agent() {
        // Given pane 1 whose agent stopped.
        let app = state_with(vec![stopped(1)], 1);

        // When checking a prompt to pane 1.
        let checked = agent_ready(&app, PaneId(1)).map(|_| ());

        // Then there is no agent to prompt.
        assert_eq!(
            checked.map_err(|error| error.code),
            Err(ErrorCode::NoAgent),
            "a pane with no live agent can't take a prompt"
        );
    }

    #[rstest::rstest]
    fn start_in_a_pane_with_a_live_agent_is_pane_busy() {
        // Given idle agent 1 in pane 1.
        let app = state_with(vec![agent(1, AgentStatus::Idle)], 1);

        // When checking a start in pane 1.
        let checked = pane_free(&app, PaneId(1));

        // Then the pane is busy.
        assert_eq!(
            checked.map_err(|error| error.code),
            Err(ErrorCode::PaneBusy),
            "a pane with a live agent can't start another"
        );
    }

    #[rstest::rstest]
    fn start_in_a_pane_whose_agent_stopped_is_allowed() {
        // Given pane 1 whose agent stopped.
        let app = state_with(vec![stopped(1)], 1);

        // When checking a start in pane 1.
        let checked = pane_free(&app, PaneId(1));

        // Then the start may go ahead.
        assert_eq!(
            checked.map_err(|error| error.code),
            Ok(()),
            "a pane whose agent stopped is free"
        );
    }
}
