//! What the agent in a pane is doing, from what one poll saw: the pane's zmx
//! session, the agents the harnesses see running matched to the pane their
//! process runs under, and the latest report the agent wrote to its pane file.

use std::collections::HashMap;

use super::state::AgentStatus;
use crate::feat::harness::RunningAgent;
use crate::feat::integration::pane_file::AgentEvent;
use crate::feat::zmx::zmx_service::ZmxEntry;
use crate::ids::PaneId;

/// The latest report from a pane's agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneReport {
    pub event: AgentEvent,
    /// When it was written, in unix ms.
    pub at: i64,
}

/// The status of each pane an agent's process runs under, given each running
/// pane's zmx process in `roots`. An agent belongs to the first root its
/// ancestry reaches, itself included; of several in one pane, the one the
/// fewest parents away wins.
pub fn match_records(
    records: &[RunningAgent],
    roots: &HashMap<u32, PaneId>,
) -> HashMap<PaneId, AgentStatus> {
    let mut nearest: HashMap<PaneId, (usize, AgentStatus)> = HashMap::new();
    for record in records {
        let found = record
            .ancestry
            .iter()
            .enumerate()
            .find_map(|(depth, pid)| roots.get(pid).map(|&pane| (depth, pane)));
        if let Some((depth, pane)) = found {
            let entry = nearest.entry(pane).or_insert((depth, record.status));
            if depth < entry.0 {
                *entry = (depth, record.status);
            }
        }
    }
    nearest
        .into_iter()
        .map(|(pane, (_, status))| (pane, status))
        .collect()
}

/// An agent pane's status: Stopped without a running zmx session; for a
/// harness whose status comes from its reports (`reads_reports`), its latest
/// `report` written since the session was made, else Stopped; otherwise the
/// `matched` agent's status, else Stopped.
pub fn pane_status(
    running: Option<&ZmxEntry>,
    reads_reports: bool,
    report: Option<PaneReport>,
    matched: Option<AgentStatus>,
) -> AgentStatus {
    let Some(session) = running else {
        return AgentStatus::Stopped;
    };
    if !reads_reports {
        return matched.unwrap_or(AgentStatus::Stopped);
    }
    // ponytail: a pi that crashes inside a live session keeps its last report
    // until the pane reports again; a process check would catch it.
    report
        .filter(|report| {
            session
                .created
                .is_none_or(|created| report.at >= created.saturating_mul(1000))
        })
        .map_or(AgentStatus::Stopped, |report| report.event.status())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{PaneReport, match_records, pane_status};
    use crate::feat::harness::RunningAgent;
    use crate::feat::integration::pane_file::AgentEvent;
    use crate::feat::sessions::state::AgentStatus;
    use crate::feat::zmx::zmx_service::ZmxEntry;
    use crate::ids::PaneId;

    /// A Claude the user started, whose process and parents are `ancestry`.
    fn interactive(ancestry: &[u32], status: AgentStatus) -> RunningAgent {
        RunningAgent {
            status,
            ancestry: ancestry.to_vec(),
        }
    }

    /// Pane 7's zmx session, its process pid 100, made at unix second 10.
    fn running() -> ZmxEntry {
        ZmxEntry {
            name: "orb-p7".to_owned(),
            pid: Some(100),
            clients: Some(1),
            created: Some(10),
        }
    }

    fn roots() -> HashMap<u32, PaneId> {
        HashMap::from([(100, PaneId(7)), (200, PaneId(8))])
    }

    #[rstest::rstest]
    fn record_under_a_panes_shell_matches_that_pane() {
        // Given a Claude under pane 7's shell.
        let records = [interactive(&[300, 100, 1], AgentStatus::Working)];

        // When matching records to panes.
        let matched = match_records(&records, &roots());

        // Then pane 7 takes its status.
        assert_eq!(
            matched,
            HashMap::from([(PaneId(7), AgentStatus::Working)]),
            "the record should belong to pane 7"
        );
    }

    #[rstest::rstest]
    fn record_that_is_the_zmx_program_matches_its_pane() {
        // Given a Claude that is pane 8's zmx program itself.
        let records = [interactive(&[200, 50, 1], AgentStatus::Idle)];

        // When matching records to panes.
        let matched = match_records(&records, &roots());

        // Then pane 8 takes its status.
        assert_eq!(
            matched,
            HashMap::from([(PaneId(8), AgentStatus::Idle)]),
            "depth 0 should match"
        );
    }

    #[rstest::rstest]
    fn record_outside_every_pane_matches_nothing() {
        // Given a Claude in some other terminal.
        let records = [interactive(&[400, 1], AgentStatus::Working)];

        // When matching records to panes.
        let matched = match_records(&records, &roots());

        // Then no pane takes it.
        assert!(matched.is_empty(), "a Claude outside orb matches no pane");
    }

    #[rstest::rstest]
    fn nearest_record_in_a_pane_wins() {
        // Given a Claude in pane 7 and another started from its `!` shell.
        let records = [
            interactive(&[500, 400, 300, 100], AgentStatus::Idle),
            interactive(&[300, 100], AgentStatus::NeedsApproval),
        ];

        // When matching records to panes.
        let matched = match_records(&records, &roots());

        // Then the outer Claude, fewest parents from the pane, gives its status.
        assert_eq!(
            matched,
            HashMap::from([(PaneId(7), AgentStatus::NeedsApproval)]),
            "the nearest record should win"
        );
    }

    #[rstest::rstest]
    fn pane_without_a_zmx_session_is_stopped() {
        // Given a pane whose zmx session is gone, with a working report.
        let report = PaneReport {
            event: AgentEvent::Working,
            at: 20_000,
        };

        // When reading its status.
        let status = pane_status(None, true, Some(report), Some(AgentStatus::Working));

        // Then it's Stopped.
        assert_eq!(status, AgentStatus::Stopped, "no session, no agent");
    }

    #[rstest::rstest]
    fn claude_pane_takes_its_matched_status() {
        // Given a running pane with a matched record.
        // When reading its status.
        let status = pane_status(Some(&running()), false, None, Some(AgentStatus::NeedsInput));

        // Then it's the record's.
        assert_eq!(
            status,
            AgentStatus::NeedsInput,
            "the matched record gives the status"
        );
    }

    #[rstest::rstest]
    fn claude_pane_without_a_match_is_stopped() {
        // Given a running pane no record matched.
        // When reading its status.
        let status = pane_status(Some(&running()), false, None, None);

        // Then it's Stopped.
        assert_eq!(status, AgentStatus::Stopped, "no Claude runs in the pane");
    }

    #[rstest::rstest]
    #[case(AgentEvent::Working, AgentStatus::Working)]
    #[case(AgentEvent::Idle, AgentStatus::Idle)]
    #[case(AgentEvent::Start, AgentStatus::Idle)]
    #[case(AgentEvent::End, AgentStatus::Stopped)]
    fn pi_pane_reads_its_latest_report(#[case] event: AgentEvent, #[case] expected: AgentStatus) {
        // Given a running pane whose pi reported after the session was made.
        let report = PaneReport { event, at: 20_000 };

        // When reading its status.
        let status = pane_status(Some(&running()), true, Some(report), None);

        // Then it follows the report.
        assert_eq!(status, expected, "{event:?} should read as {expected:?}");
    }

    #[rstest::rstest]
    fn pi_report_older_than_its_zmx_session_is_stopped() {
        // Given a pane whose shell was recreated after pi last reported idle.
        let report = PaneReport {
            event: AgentEvent::Idle,
            at: 9_999,
        };

        // When reading its status.
        let status = pane_status(Some(&running()), true, Some(report), None);

        // Then it's Stopped.
        assert_eq!(
            status,
            AgentStatus::Stopped,
            "a report from before the session is stale"
        );
    }

    #[rstest::rstest]
    fn pi_pane_without_a_report_is_stopped() {
        // Given a running pane whose pi never reported.
        // When reading its status.
        let status = pane_status(Some(&running()), true, None, None);

        // Then it's Stopped.
        assert_eq!(status, AgentStatus::Stopped, "no report, no pi");
    }
}
