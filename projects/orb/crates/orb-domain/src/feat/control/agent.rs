//! Agents in panes, for the control socket: which agent a pane holds, the line
//! that starts one, waiting on orb's state until an agent starts, works or
//! stops, and its last reply.

use std::fs;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::feat::control::protocol::{
    AgentKind, ApiError, ErrorCode, ReplyResult, StartedResult, WaitEnd, WaitResult,
};
use crate::feat::control::target::{self, Target};
use crate::feat::control::validator;
use crate::feat::harness::{HarnessId, Harnesses};
use crate::feat::sessions::state::{Agent, AgentStatus};
use crate::ids::PaneId;
use crate::{AppState, State};

/// How the waits pace themselves; tests shrink it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Timing {
    /// How often the state is read.
    pub tick: Duration,
    /// How often the sessions poll is poked.
    pub poke_every: Duration,
    /// How long `agent start` waits for the agent.
    pub start_limit: Duration,
    /// How long `agent prompt --wait` waits to see work start.
    pub stall_gate: Duration,
}

impl Timing {
    /// The pace a running orb uses.
    pub(crate) const REAL: Self = Self {
        tick: Duration::from_millis(100),
        poke_every: Duration::from_secs(1),
        start_limit: Duration::from_secs(30),
        stall_gate: Duration::from_secs(5),
    };
}

/// Whether an agent with `status` may still be running.
pub(crate) fn live(status: AgentStatus) -> bool {
    !matches!(
        status,
        AgentStatus::Stopped | AgentStatus::Gone | AgentStatus::Failed
    )
}

/// The agent bound to `pane`: a live one before a dead one.
pub(crate) fn pane_agent(app: &AppState, pane: PaneId) -> Option<&Agent> {
    app.sessions
        .all_agents()
        .filter(|agent| agent.pane.as_ref().is_some_and(|at| at.pane == pane))
        .min_by_key(|agent| !live(agent.status))
}

/// `kind`'s program and `args` as one shell line, each arg in single quotes
/// with `'` written `'\''` (POSIX shells and fish both read it).
pub(crate) fn shell_line(kind: AgentKind, args: &[String]) -> String {
    let program = match kind {
        AgentKind::Claude => "claude",
        AgentKind::Pi => "pi",
    };
    args.iter().fold(program.to_owned(), |line, arg| {
        format!("{line} {}", quoted(arg))
    })
}

/// `word` in single quotes, its own `'` written `'\''`, which POSIX shells
/// and fish both read as one word.
pub(crate) fn quoted(word: &str) -> String {
    // ponytail: POSIX single quotes; fish reads `\\` and a trailing `\` inside them differently, quote per shell if a word ever carries one.
    format!("'{}'", word.replace('\'', "'\\''"))
}

/// Reads `state` every tick until `check` gives an answer, poking the poll
/// after the first read and then every `poke_every`; `None` once `deadline`
/// passes, `timeout` once `gone` says the caller hung up. No lock is held
/// across the sleep or the poke.
fn poll_until<T, F>(
    state: &State,
    poke: &dyn Fn(),
    gone: &dyn Fn() -> bool,
    timing: Timing,
    deadline: Option<Instant>,
    mut check: F,
) -> Option<Result<T, ApiError>>
where
    F: FnMut(&AppState) -> Option<Result<T, ApiError>>,
{
    let mut poked: Option<Instant> = None;
    loop {
        let outcome = check(&state.read());
        if outcome.is_some() {
            return outcome;
        }
        if gone() {
            return Some(Err(caller_left()));
        }
        let now = Instant::now();
        if deadline.is_some_and(|deadline| now >= deadline) {
            return None;
        }
        if poked.is_none_or(|at| now.duration_since(at) >= timing.poke_every) {
            poke();
            poked = Some(now);
        }
        thread::sleep(timing.tick);
    }
}

/// `pane` still there, in a session that isn't settled.
fn pane_open(app: &AppState, pane: PaneId) -> Result<(), ApiError> {
    let resolved = target::resolve(app, Some(Target::Pane(pane)), None)?;
    validator::not_settled(app, resolved.session)
}

/// Why a prompt can't go to an agent that waits on the user.
pub(crate) fn blocked() -> ApiError {
    ApiError::new(
        ErrorCode::AgentBlocked,
        "the agent waits for approval or input",
    )
}

/// Why there is nothing to prompt or wait on in `pane`.
pub(crate) fn no_agent(pane: PaneId) -> ApiError {
    ApiError::new(
        ErrorCode::NoAgent,
        format!("no live agent in pane {}", pane.0),
    )
}

/// Why a wait ended without an answer: nobody is listening any more.
fn caller_left() -> ApiError {
    ApiError::new(ErrorCode::Timeout, "the caller hung up")
}

/// Why a wait on `pane`'s agent gave up.
fn ran_out(pane: PaneId) -> ApiError {
    ApiError::new(
        ErrorCode::Timeout,
        format!(
            "the agent in pane {} was still working at the timeout",
            pane.0
        ),
    )
}

/// `pane`'s live agent, once the pane is checked still open; `no_agent`
/// when none is live.
fn live_agent(app: &AppState, pane: PaneId) -> Result<&Agent, ApiError> {
    pane_open(app, pane)?;
    pane_agent(app, pane)
        .filter(|agent| live(agent.status))
        .ok_or_else(|| no_agent(pane))
}

/// Whether `pane`'s agent wrote its transcript after `pasted`: a turn that
/// starts and ends between two polls still leaves that trace.
fn wrote_since(state: &State, pane: PaneId, pasted: SystemTime) -> bool {
    let transcript = pane_agent(&state.read(), pane).and_then(|agent| agent.transcript.clone());
    transcript
        .and_then(|path| fs::metadata(path).and_then(|meta| meta.modified()).ok())
        .is_some_and(|written| written > pasted)
}

/// Waits until `pane`'s agent is idle or blocked, through work and an
/// unknown status. An agent that stops or leaves is `no_agent`, a closed
/// pane `not_found`, a settled session `settled`; `timeout` once `deadline`
/// passes or `gone` says the caller hung up.
pub(crate) fn wait_done(
    state: &State,
    pane: PaneId,
    poke: &dyn Fn(),
    gone: &dyn Fn() -> bool,
    timing: Timing,
    deadline: Option<Instant>,
) -> Result<WaitResult, ApiError> {
    let done = poll_until(state, poke, gone, timing, deadline, |app| {
        let agent = match live_agent(app, pane) {
            Ok(agent) => agent,
            Err(error) => return Some(Err(error)),
        };
        let status = match agent.status {
            AgentStatus::Idle => WaitEnd::Idle,
            AgentStatus::NeedsApproval | AgentStatus::NeedsInput => WaitEnd::Blocked,
            AgentStatus::Working
            | AgentStatus::Unknown
            | AgentStatus::Stopped
            | AgentStatus::Gone
            | AgentStatus::Failed => return None,
        };
        Some(Ok(WaitResult { status }))
    });
    done.unwrap_or_else(|| Err(ran_out(pane)))
}

/// After a prompt pasted at `pasted`: waits up to `stall_gate` to see a turn
/// underway, then [`wait_done`]. Seeing none is `prompt_stalled`, unless the
/// agent wrote its transcript since the paste (a turn too short to see).
/// `deadline` covers both halves; when it comes before the gate, running
/// out is `timeout`, as is `gone` saying the caller hung up.
pub(crate) fn wait_prompted(
    state: &State,
    pane: PaneId,
    poke: &dyn Fn(),
    gone: &dyn Fn() -> bool,
    timing: Timing,
    deadline: Option<Instant>,
    pasted: SystemTime,
) -> Result<WaitResult, ApiError> {
    let gate = Instant::now() + timing.stall_gate;
    let first = deadline.map_or(gate, |deadline| deadline.min(gate));
    let seen = poll_until(
        state,
        poke,
        gone,
        timing,
        Some(first),
        |app| match live_agent(app, pane) {
            Ok(agent) => agent.status.in_progress().then_some(Ok(())),
            Err(error) => Some(Err(error)),
        },
    );
    match seen {
        Some(Err(error)) => return Err(error),
        None if first < gate => return Err(ran_out(pane)),
        None if !wrote_since(state, pane, pasted) => {
            return Err(ApiError::new(
                ErrorCode::PromptStalled,
                format!(
                    "the agent in pane {} didn't start working within {} s",
                    pane.0,
                    timing.stall_gate.as_secs()
                ),
            ));
        }
        Some(Ok(())) | None => {}
    }
    wait_done(state, pane, poke, gone, timing, deadline)
}

/// Waits for the agent started in `pane`: replies once it reads idle or
/// working; `agent_blocked` if it waits for approval or input; `timeout`
/// after `start_limit`, asking whether the integration is installed.
pub(crate) fn wait_started(
    state: &State,
    pane: PaneId,
    poke: &dyn Fn(),
    timing: Timing,
) -> Result<StartedResult, ApiError> {
    let deadline = Instant::now() + timing.start_limit;
    let started = poll_until(state, poke, &|| false, timing, Some(deadline), |app| {
        if let Err(error) = pane_open(app, pane) {
            return Some(Err(error));
        }
        let agent = pane_agent(app, pane)?;
        match agent.status {
            AgentStatus::Idle | AgentStatus::Working => Some(Ok(StartedResult {
                pane,
                agent: agent.id,
                harness: agent.harness.to_string(),
                status: agent.status,
            })),
            AgentStatus::NeedsApproval | AgentStatus::NeedsInput => Some(Err(blocked())),
            AgentStatus::Unknown
            | AgentStatus::Stopped
            | AgentStatus::Gone
            | AgentStatus::Failed => None,
        }
    });
    started.unwrap_or_else(|| {
        Err(ApiError::new(
            ErrorCode::Timeout,
            format!(
                "no agent started in pane {} within {} s; is `orb integration install` done?",
                pane.0,
                timing.start_limit.as_secs()
            ),
        ))
    })
}

/// The reply of the last exchange that has one, in `transcript` as `harness`
/// reads it; `no_reply` when there is none or orb doesn't know the harness,
/// `failed` when the file can't be read.
pub(crate) fn last_reply(
    harnesses: &Harnesses,
    harness: &HarnessId,
    transcript: &Path,
) -> Result<ReplyResult, ApiError> {
    let no_reply = |why: &str| ApiError::new(ErrorCode::NoReply, why);
    let reader = harnesses
        .get(harness)
        .ok_or_else(|| no_reply(&format!("orb can't read {harness} transcripts")))?;
    let (_, exchanges) = reader.exchanges(transcript).map_err(|error| {
        ApiError::new(
            ErrorCode::Failed,
            format!("couldn't read {}: {error}", transcript.display()),
        )
    })?;
    let (text, written) = exchanges
        .into_iter()
        .rev()
        .find_map(|exchange| exchange.reply)
        .ok_or_else(|| no_reply("the agent hasn't replied yet"))?;
    Ok(ReplyResult {
        text,
        at: written
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .and_then(|since| i64::try_from(since.as_millis()).ok()),
    })
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate setup failures with `?` and assert on the outcome"
)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, SystemTime};

    use super::{Timing, last_reply, shell_line, wait_done, wait_prompted, wait_started};
    use crate::State;
    use crate::feat::control::protocol::{AgentKind, ErrorCode, WaitEnd, WaitResult};
    use crate::feat::harness::fake::FakeHarness;
    use crate::feat::harness::{HarnessId, Harnesses};
    use crate::feat::sessions::state::{Agent, AgentStatus};
    use crate::feat::sessions::transcript::Exchange;
    use crate::ids::{AgentId, PaneId};
    use crate::intent_handler::test_support::{agent, launch, state_with, stopped};

    const FAST: Timing = Timing {
        tick: Duration::from_millis(1),
        poke_every: Duration::from_millis(1),
        start_limit: Duration::from_millis(50),
        stall_gate: Duration::from_millis(50),
    };

    /// Pane 1 of session 1 holding stopped agent 1.
    fn stopped_pane() -> State {
        State::new(state_with(vec![stopped(1)], 1))
    }

    /// Agent 2 with `status`, bound to pane 1 of session 1, added to `state`
    /// as the hook's report would.
    fn bind_new_agent(state: &State, status: AgentStatus) {
        for project in &mut state.write().sessions.projects {
            project.agents.push(Agent {
                pane: Some(launch(1)),
                ..agent(2, status)
            });
        }
    }

    /// Agent `id` in `state` now reads `status`.
    fn set_status(state: &State, id: i64, status: AgentStatus) {
        for project in &mut state.write().sessions.projects {
            for found in project.agents.iter_mut().filter(|found| found.id.0 == id) {
                found.status = status;
            }
        }
    }

    /// An exchange whose reply is `reply`.
    fn exchange(reply: Option<&str>) -> Exchange {
        Exchange {
            reply: reply.map(|text| (text.to_owned(), None)),
            ..Exchange::default()
        }
    }

    /// `last_reply` from a claude transcript holding `exchanges`.
    fn reply_from(exchanges: Vec<Exchange>) -> Result<String, ErrorCode> {
        let harnesses = Harnesses::new(vec![Arc::new(
            FakeHarness::new("claude", Vec::new()).with_exchanges(exchanges),
        )]);
        last_reply(&harnesses, &HarnessId::new("claude"), Path::new("/t"))
            .map(|reply| reply.text)
            .map_err(|error| error.code)
    }

    #[rstest::rstest]
    fn start_wait_replies_once_a_new_agent_in_the_pane_turns_idle() {
        // Given pane 1 holding a stopped agent, and a poll that sees agent 2
        // start there idle.
        let state = stopped_pane();
        let poke = || bind_new_agent(&state, AgentStatus::Idle);

        // When waiting for an agent to start in pane 1.
        let started = wait_started(&state, PaneId(1), &poke, FAST);

        // Then the new agent is the one that started.
        assert_eq!(
            started
                .map(|started| started.agent)
                .map_err(|error| error.code),
            Ok(AgentId(2)),
            "the start should reply with the new agent"
        );
    }

    #[rstest::rstest]
    fn start_wait_times_out_when_no_agent_appears() {
        // Given pane 1 holding a stopped agent, and a poll that sees nothing.
        let state = stopped_pane();

        // When waiting for an agent to start in pane 1.
        let started = wait_started(&state, PaneId(1), &|| {}, FAST);

        // Then it times out, pointing at the integration.
        assert!(
            started
                .as_ref()
                .is_err_and(|error| error.code == ErrorCode::Timeout
                    && error.message.contains("orb integration install")),
            "no agent should time out naming the integration, got {started:?}"
        );
    }

    #[rstest::rstest]
    fn start_wait_on_an_agent_waiting_for_approval_is_agent_blocked() {
        // Given pane 1 holding a stopped agent, and a poll that sees agent 2
        // start there waiting for approval.
        let state = stopped_pane();
        let poke = || bind_new_agent(&state, AgentStatus::NeedsApproval);

        // When waiting for an agent to start in pane 1.
        let started = wait_started(&state, PaneId(1), &poke, FAST);

        // Then it is refused as blocked.
        assert_eq!(
            started
                .map(|started| started.agent)
                .map_err(|error| error.code),
            Err(ErrorCode::AgentBlocked),
            "an agent waiting for approval should be agent_blocked"
        );
    }

    #[rstest::rstest]
    fn prompt_wait_is_stalled_when_no_work_starts() {
        // Given idle agent 1 in pane 1 with no transcript, which never starts
        // working.
        let state = State::new(state_with(vec![agent(1, AgentStatus::Idle)], 1));

        // When waiting on a prompt with no deadline.
        let waited = wait_prompted(
            &state,
            PaneId(1),
            &|| {},
            &|| false,
            FAST,
            None,
            SystemTime::now(),
        );

        // Then the prompt is stalled.
        assert_eq!(
            waited.map_err(|error| error.code),
            Err(ErrorCode::PromptStalled),
            "no work within the gate should be prompt_stalled"
        );
    }

    #[rstest::rstest]
    fn prompt_wait_returns_once_the_agent_goes_from_working_to_idle() {
        // Given idle agent 1 in pane 1, which the first poll sees working and
        // the third sees idle again.
        let state = State::new(state_with(vec![agent(1, AgentStatus::Idle)], 1));
        let polls = AtomicUsize::new(0);
        let poke = || match polls.fetch_add(1, Ordering::SeqCst) + 1 {
            1 => set_status(&state, 1, AgentStatus::Working),
            3 => set_status(&state, 1, AgentStatus::Idle),
            _ => {}
        };

        // When waiting on a prompt with no deadline.
        let waited = wait_prompted(
            &state,
            PaneId(1),
            &poke,
            &|| false,
            FAST,
            None,
            SystemTime::now(),
        );

        // Then the turn ends idle.
        assert_eq!(
            waited.map_err(|error| error.code),
            Ok(WaitResult {
                status: WaitEnd::Idle
            }),
            "working then idle should end the wait idle"
        );
    }

    #[rstest::rstest]
    fn wait_on_a_blocked_agent_replies_blocked() {
        // Given agent 1 in pane 1 waiting for input.
        let state = State::new(state_with(vec![agent(1, AgentStatus::NeedsInput)], 1));

        // When waiting on pane 1.
        let waited = wait_done(&state, PaneId(1), &|| {}, &|| false, FAST, None);

        // Then the wait ends blocked.
        assert_eq!(
            waited.map_err(|error| error.code),
            Ok(WaitResult {
                status: WaitEnd::Blocked
            }),
            "an agent waiting for input should end the wait blocked"
        );
    }

    #[rstest::rstest]
    fn wait_ends_once_its_caller_hangs_up() {
        // Given working agent 1 in pane 1 and no deadline.
        let state = State::new(state_with(vec![agent(1, AgentStatus::Working)], 1));

        // When waiting on pane 1 for a caller that already hung up.
        let waited = wait_done(&state, PaneId(1), &|| {}, &|| true, FAST, None);

        // Then the wait gives up.
        assert_eq!(
            waited.map_err(|error| error.code),
            Err(ErrorCode::Timeout),
            "nobody is left to answer, so the wait should stop"
        );
    }

    #[rstest::rstest]
    fn wait_ends_with_no_agent_when_the_agent_stops() {
        // Given working agent 1 in pane 1, which the poll sees stop.
        let state = State::new(state_with(vec![agent(1, AgentStatus::Working)], 1));
        let poke = || set_status(&state, 1, AgentStatus::Stopped);

        // When waiting on pane 1.
        let waited = wait_done(&state, PaneId(1), &poke, &|| false, FAST, None);

        // Then there is no agent to wait on.
        assert_eq!(
            waited.map_err(|error| error.code),
            Err(ErrorCode::NoAgent),
            "a stopped agent should end the wait with no_agent"
        );
    }

    #[rstest::rstest]
    fn reply_is_the_last_exchange_with_a_reply() {
        // Given a transcript replying "first", then "second", then a prompt
        // not yet answered.
        let exchanges = vec![
            exchange(Some("first")),
            exchange(Some("second")),
            exchange(None),
        ];

        // When reading the last reply.
        let reply = reply_from(exchanges);

        // Then it is the last one written.
        assert_eq!(
            reply,
            Ok("second".to_owned()),
            "the reply should be the last exchange that has one"
        );
    }

    #[rstest::rstest]
    fn reply_without_any_reply_is_no_reply() {
        // Given a transcript whose only prompt has no reply yet.
        let exchanges = vec![exchange(None)];

        // When reading the last reply.
        let reply = reply_from(exchanges);

        // Then there is no reply.
        assert_eq!(
            reply,
            Err(ErrorCode::NoReply),
            "no reply in the transcript should be no_reply"
        );
    }

    #[rstest::rstest]
    #[case(AgentKind::Claude, &[], "claude")]
    #[case(AgentKind::Pi, &["--model", "opus"], "pi '--model' 'opus'")]
    #[case(AgentKind::Claude, &["it's"], r"claude 'it'\''s'")]
    fn shell_line_quotes_each_argument(
        #[case] kind: AgentKind,
        #[case] args: &[&str],
        #[case] expected: &str,
    ) {
        // Given the agent's kind and arguments.
        let args: Vec<String> = args.iter().map(|&arg| arg.to_owned()).collect();

        // When building its shell line.
        let line = shell_line(kind, &args);

        // Then each argument is single-quoted.
        assert_eq!(line, expected, "the shell line should quote each argument");
    }

    #[rstest::rstest]
    fn prompt_wait_on_a_turn_too_short_to_see_replies_idle() -> std::io::Result<()> {
        // Given idle agent 1 in pane 1 whose transcript was written after the
        // paste, though orb never saw it working.
        let dir = tempfile::tempdir()?;
        let transcript = dir.path().join("t.jsonl");
        std::fs::write(&transcript, "{}")?;
        let state = State::new(state_with(
            vec![Agent {
                transcript: Some(transcript),
                ..agent(1, AgentStatus::Idle)
            }],
            1,
        ));

        // When waiting on a prompt pasted before that write.
        let waited = wait_prompted(
            &state,
            PaneId(1),
            &|| {},
            &|| false,
            FAST,
            None,
            SystemTime::UNIX_EPOCH,
        );

        // Then the turn counts as done, not stalled.
        assert_eq!(
            waited.map_err(|error| error.code),
            Ok(WaitResult {
                status: WaitEnd::Idle
            }),
            "a transcript written since the paste means the turn ran"
        );
        Ok(())
    }
}
