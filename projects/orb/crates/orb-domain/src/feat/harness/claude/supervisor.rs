//! What orb asks the `claude` program.
//!
//! `claude agents --json --all` reports the Claudes users start in panes, by
//! process; `ps` gives each one's parents, which tell the pane it runs in.
//! Every `claude` process runs with orb's child environment and no stdin,
//! and is killed if it outlives its time limit.
//! When `claude` fails, the first line it printed becomes the reason.

use std::ffi::OsString;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use error_stack::{Report, ResultExt};
use serde::Deserialize;
use tokio::process::Command;
use tokio::time::timeout;

use crate::common::{ancestry, parse_parents};
use crate::feat::harness::{HarnessError, RunningAgent};
use crate::feat::sessions::state::AgentStatus;

const LIST_TIMEOUT: Duration = Duration::from_secs(10);

/// `waitingFor` values that mean Claude waits for an approval.
const APPROVALS: [&str; 3] = ["permission prompt", "sandbox request", "worker request"];

/// What orb asks the `claude` program: the agents it runs.
#[async_trait]
pub trait ClaudeAgents: Send + Sync {
    fn name(&self) -> &'static str;

    /// The interactive Claudes running now, each with its status and its
    /// process ancestry.
    ///
    /// # Errors
    ///
    /// Returns an error if `claude` can't be asked or its answer can't be
    /// read.
    async fn list(&self) -> Result<Vec<RunningAgent>, Report<HarnessError>>;
}

/// Asks the `claude` program on the `PATH`.
#[derive(Debug, Clone)]
pub struct ClaudeSupervisor {
    /// The environment every `claude` process gets.
    env: Vec<(OsString, OsString)>,
}

impl ClaudeSupervisor {
    /// A supervisor whose `claude` processes run with exactly `env`.
    pub fn new(env: Vec<(OsString, OsString)>) -> Self {
        Self { env }
    }

    fn claude(&self, args: &[&str]) -> Command {
        self.command("claude", args)
    }

    /// `program` with `args`, orb's child environment and no stdin, killed
    /// when dropped.
    fn command(&self, program: &str, args: &[&str]) -> Command {
        let mut command = Command::new(program);
        command
            .args(args)
            .env_clear()
            .envs(self.env.iter().map(|(key, value)| (key, value)))
            .stdin(Stdio::null())
            .kill_on_drop(true);
        command
    }
}

#[async_trait]
impl ClaudeAgents for ClaudeSupervisor {
    fn name(&self) -> &'static str {
        "claude"
    }

    /// Each agent's ancestry comes from one `ps` call.
    async fn list(&self) -> Result<Vec<RunningAgent>, Report<HarnessError>> {
        let command = self.claude(&["agents", "--json", "--all"]);
        let text = run(command, "claude agents", LIST_TIMEOUT).await?;
        let mut agents = parse_agents(&text)?;
        if !agents.is_empty() {
            // ponytail: a failed `ps` leaves each agent its own pid, which
            // still matches a Claude that is its zmx session's program.
            let parents = run(
                self.command("ps", &["-A", "-o", "pid=,ppid="]),
                "ps",
                LIST_TIMEOUT,
            )
            .await
            .map(|text| parse_parents(&text))
            .unwrap_or_default();
            for agent in &mut agents {
                if let Some(&pid) = agent.ancestry.first() {
                    agent.ancestry = ancestry(pid, &parents);
                }
            }
        }
        Ok(agents)
    }
}

/// Runs `command` for at most `limit`; returns its stdout, then its stderr.
async fn run(
    mut command: Command,
    what: &str,
    limit: Duration,
) -> Result<String, Report<HarnessError>> {
    let output = timeout(limit, command.output())
        .await
        .change_context(HarnessError)
        .attach(format!("{what} timed out after {} s", limit.as_secs()))?
        .map_err(|error| {
            let reason = format!("couldn't run {what}: {error}");
            Report::new(error)
                .change_context(HarnessError)
                .attach(reason)
        })?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success() {
        Ok(text)
    } else {
        Err(failure(
            &text,
            &format!("{what} exited with {}", output.status),
        ))
    }
}

/// A report whose reason is the first line `claude` printed, else
/// `fallback`.
fn failure(text: &str, fallback: &str) -> Report<HarnessError> {
    let reason = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or(fallback);
    Report::new(HarnessError).attach(reason.to_owned())
}

/// One record of `claude agents --json`; unknown fields are ignored.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRecord {
    pid: Option<u32>,
    kind: Option<String>,
    status: Option<String>,
    waiting_for: Option<String>,
    state: Option<String>,
}

/// The interactive agents (`kind` `interactive`) in `claude agents
/// --json`'s array, by their `pid`. Anything else, background sessions
/// included, is skipped. A record's own `sessionId` is ignored; orb's hook
/// says which conversation runs where.
fn parse_agents(json: &str) -> Result<Vec<RunningAgent>, Report<HarnessError>> {
    let records: Vec<AgentRecord> = serde_json::from_str(json)
        .change_context(HarnessError)
        .attach("claude agents printed unreadable JSON".to_owned())?;
    Ok(records
        .into_iter()
        .filter_map(|record| match (record.kind.as_deref(), record.pid) {
            (Some("interactive"), Some(pid)) => Some(RunningAgent {
                status: status_of(&record),
                ancestry: vec![pid],
            }),
            _ => None,
        })
        .collect())
}

fn status_of(record: &AgentRecord) -> AgentStatus {
    match (record.status.as_deref(), record.state.as_deref()) {
        (Some("busy"), _) => AgentStatus::Working,
        (Some("waiting"), _) => match record.waiting_for.as_deref() {
            Some(waiting_for) if APPROVALS.contains(&waiting_for) => AgentStatus::NeedsApproval,
            _ => AgentStatus::NeedsInput,
        },
        (_, Some("failed")) => AgentStatus::Failed,
        (Some(_), _) => AgentStatus::Idle,
        (None, _) => AgentStatus::Stopped,
    }
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate parse failures with `?` and assert on the outcome"
)]
mod tests {
    use error_stack::Report;

    use super::{AgentStatus, HarnessError, RunningAgent, parse_agents};

    #[rstest::rstest]
    #[case(
        r#"{"pid":1,"kind":"interactive","status":"busy","state":"working"}"#,
        AgentStatus::Working
    )]
    #[case(
        r#"{"pid":1,"kind":"interactive","status":"waiting","waitingFor":"permission prompt"}"#,
        AgentStatus::NeedsApproval
    )]
    #[case(
        r#"{"pid":1,"kind":"interactive","status":"waiting","waitingFor":"sandbox request"}"#,
        AgentStatus::NeedsApproval
    )]
    #[case(
        r#"{"pid":1,"kind":"interactive","status":"waiting","waitingFor":"worker request"}"#,
        AgentStatus::NeedsApproval
    )]
    #[case(
        r#"{"pid":1,"kind":"interactive","status":"waiting","waitingFor":"input needed"}"#,
        AgentStatus::NeedsInput
    )]
    #[case(
        r#"{"pid":1,"kind":"interactive","status":"waiting","waitingFor":"dialog open"}"#,
        AgentStatus::NeedsInput
    )]
    #[case(
        r#"{"pid":1,"kind":"interactive","status":"waiting"}"#,
        AgentStatus::NeedsInput
    )]
    #[case(
        r#"{"pid":1,"kind":"interactive","status":"idle","state":"failed"}"#,
        AgentStatus::Failed
    )]
    #[case(
        r#"{"pid":1,"kind":"interactive","status":"idle","state":"blocked"}"#,
        AgentStatus::Idle
    )]
    #[case(
        r#"{"pid":1,"kind":"interactive","state":"failed"}"#,
        AgentStatus::Failed
    )]
    #[case(
        r#"{"pid":1,"kind":"interactive","state":"stopped"}"#,
        AgentStatus::Stopped
    )]
    #[case(
        r#"{"pid":1,"kind":"interactive","state":"done"}"#,
        AgentStatus::Stopped
    )]
    #[case(
        r#"{"pid":1,"kind":"interactive","state":"blocked"}"#,
        AgentStatus::Stopped
    )]
    #[case(r#"{"pid":1,"kind":"interactive"}"#, AgentStatus::Stopped)]
    #[case(
        r#"{"pid":1,"kind":"interactive","status":"busy"}"#,
        AgentStatus::Working
    )]
    #[case(
        r#"{"pid":1,"kind":"interactive","status":"waiting","waitingFor":"permission prompt"}"#,
        AgentStatus::NeedsApproval
    )]
    #[case(
        r#"{"pid":1,"kind":"interactive","status":"waiting","waitingFor":"dialog open"}"#,
        AgentStatus::NeedsInput
    )]
    #[case(r#"{"pid":1,"kind":"interactive","status":"idle"}"#, AgentStatus::Idle)]
    fn agent_record_maps_to_agent_status(
        #[case] record: &str,
        #[case] expected: AgentStatus,
    ) -> Result<(), Report<HarnessError>> {
        // Given one `claude agents --json` record.
        let json = format!("[{record}]");

        // When parsing it.
        let agents = parse_agents(&json)?;

        // Then its status maps per the approved table.
        let statuses: Vec<AgentStatus> = agents.iter().map(|agent| agent.status).collect();
        assert_eq!(statuses, [expected], "{record} should map to {expected:?}");
        Ok(())
    }

    #[rstest::rstest]
    fn interactive_record_is_kept_by_its_pid() -> Result<(), Report<HarnessError>> {
        // Given an interactive record, which has no id.
        let json = r#"[
          {"pid":63163,"kind":"interactive","startedAt":1790143927372,
           "name":"itemku-frontend-next-v2-18","status":"waiting","waitingFor":"dialog open"}
        ]"#;

        // When parsing it.
        let agents = parse_agents(json)?;

        // Then it is kept by its pid.
        assert_eq!(
            agents,
            [RunningAgent {
                status: AgentStatus::NeedsInput,
                ancestry: vec![63163],
            }],
            "the interactive record should be listed by its pid"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn background_record_is_skipped() -> Result<(), Report<HarnessError>> {
        // Given a background record, which has an id.
        let json = r#"[
          {"pid":960,"id":"28bf38e2","cwd":"/Users/me/dev/orb","kind":"background",
           "startedAt":1790233098717,"sessionId":"28bf38e2-8929-4841-b907-f87d5d469a10",
           "name":"orb-m2-probe","status":"idle","state":"blocked"}
        ]"#;

        // When parsing it.
        let agents = parse_agents(json)?;

        // Then nothing is listed.
        assert!(
            agents.is_empty(),
            "a background session isn't a pane's agent"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn interactive_record_without_a_pid_is_skipped() -> Result<(), Report<HarnessError>> {
        // Given an interactive record with no pid.
        let json = r#"[{"kind":"interactive","status":"idle"}]"#;

        // When parsing it.
        let agents = parse_agents(json)?;

        // Then nothing is listed.
        assert!(agents.is_empty(), "a record with no pid can't be matched");
        Ok(())
    }

    #[rstest::rstest]
    fn malformed_agents_json_is_an_error() {
        // Given output that isn't JSON.
        let text = "claude: command not found";

        // When parsing it.
        let result = parse_agents(text);

        // Then parsing fails.
        assert!(result.is_err(), "malformed JSON should be an error");
    }
}
