//! Ids for tests, each kind in its own range, so a test that mixes up a
//! agent, a session and a pane id fails instead of passing by accident.

use crate::ids::{AgentId, PaneId, SessionId};

/// Agent (agent) `n`, for `n < 100`: 100 + n.
pub(crate) fn agent(n: i64) -> AgentId {
    AgentId(100 + below_100(n))
}

/// Session `n`, for `n < 100`: 200 + n.
pub(crate) fn session(n: i64) -> SessionId {
    SessionId(200 + below_100(n))
}

/// Pane `n`, for `n < 100`: 300 + n.
pub(crate) fn pane(n: i64) -> PaneId {
    PaneId(300 + below_100(n))
}

fn below_100(n: i64) -> i64 {
    assert!(
        (0..100).contains(&n),
        "test ids hold 0..100 per kind, got {n}"
    );
    n
}

#[rstest::rstest]
fn id_ranges_never_overlap() {
    // Given every agent, session and pane id the builders make.
    let agents: std::collections::HashSet<i64> = (0..100).map(|n| agent(n).0).collect();
    let sessions: std::collections::HashSet<i64> = (0..100).map(|n| session(n).0).collect();
    let panes: std::collections::HashSet<i64> = (0..100).map(|n| pane(n).0).collect();

    // When collecting the ids two kinds share.
    let shared: Vec<i64> = {
        let mut shared: Vec<i64> = agents
            .intersection(&sessions)
            .chain(agents.intersection(&panes))
            .chain(sessions.intersection(&panes))
            .copied()
            .collect();
        shared.sort_unstable();
        shared
    };

    // Then there are none.
    assert!(shared.is_empty(), "ids shared between kinds: {shared:?}");
}
