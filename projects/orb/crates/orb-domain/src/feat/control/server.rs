//! The running orb's side of the control socket: reads each request, answers
//! it from orb's state, asks the sessions actor for what it adds or the screen
//! loop for what it changes and for what a pane shows, and writes the reply.

use std::fs::{self, Permissions};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use error_stack::{Report, ResultExt};
use kameo::actor::ActorRef;
use kameo::error::SendError;
use wherror::Error;

use crate::command::SessionsCommand;
use crate::feat::control::agent::{self, Timing};
use crate::feat::control::change::Change;
use crate::feat::control::pane_control::{PaneControl, PaneRequest, key_event};
use crate::feat::control::protocol::{
    AgentRow, AgentsResult, ApiError, Done, ErrorCode, Op, PaneResult, PaneRow, PanesResult,
    PromptResult, ReadResult, Reply, Request, SessionRow, SessionsResult, StartResult, TabRow,
    TabsResult,
};
use crate::feat::control::target::{self, Resolved, Target};
use crate::feat::control::validator;
use crate::feat::harness::{HarnessId, Harnesses};
use crate::feat::sessions::sessions_actor::{
    ApiAdd, ApiPlace, ApiStart, ApiStartError, SessionsActor,
};
use crate::feat::sessions::state::{Agent, SessionKind};
use crate::ids::{PaneId, ProjectId, SessionId};
use crate::{AppState, Log, State};

/// How long a connection may take to send its request line.
const REQUEST_LIMIT: Duration = Duration::from_secs(5);

/// How long one check for a caller that hung up waits for a byte.
const GONE_PROBE: Duration = Duration::from_millis(1);

/// The control socket couldn't be opened.
#[derive(Debug, Error)]
#[error(debug)]
pub struct ControlServerError;

/// What the control server reads, who it asks, and where it logs.
#[derive(Debug, Clone)]
pub struct ControlDeps {
    /// orb's shared state, read to answer requests.
    pub state: State,
    /// Where failures go.
    pub log: Log,
    /// Makes panes and sessions.
    pub sessions: ActorRef<SessionsActor>,
    /// Runs the sessions actor's asks from the request threads.
    pub runtime: tokio::runtime::Handle,
    /// The screen loop, which applies changes to what it owns.
    pub panes: PaneControl,
    /// Read agents' transcripts for their replies.
    pub harnesses: Harnesses,
}

/// Opens the control socket at `path`, only for the user, and answers each
/// connection on its own thread. A socket left by an orb that crashed is
/// replaced.
///
/// # Errors
///
/// Returns an error if the socket can't be bound, made private, or its
/// thread can't start.
pub fn listen(path: &Path, deps: ControlDeps) -> Result<(), Report<ControlServerError>> {
    open(path, deps.log.clone(), move |line, gone| {
        reply_line(line, |request| answer(&deps, request, gone))
    })
}

/// Opens a socket at `path` as [`listen`] does, answering each request line
/// with the reply line `answer` gives; `answer`'s second argument says
/// whether the caller has hung up meanwhile.
pub(super) fn open<F>(path: &Path, log: Log, answer: F) -> Result<(), Report<ControlServerError>>
where
    F: Fn(&str, &dyn Fn() -> bool) -> String + Send + Sync + 'static,
{
    remove_socket(path, &log);
    let listener = UnixListener::bind(path)
        .change_context(ControlServerError)
        .attach_with(|| format!("couldn't bind {}", path.display()))?;
    fs::set_permissions(path, Permissions::from_mode(0o600))
        .change_context(ControlServerError)
        .attach("couldn't make the socket private")?;
    thread::Builder::new()
        .name("orb-control".into())
        .spawn(move || accept(&listener, &log, &Arc::new(answer)))
        .map(drop)
        .change_context(ControlServerError)
        .attach("couldn't start the control thread")
}

/// Removes the socket file; a missing one is fine, any other failure is logged.
pub fn remove_socket(path: &Path, log: &Log) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => log.line(
            "control",
            &format!("couldn't remove {}: {error}", path.display()),
        ),
    }
}

/// Hands each connection to its own thread, for as long as orb runs.
fn accept<F>(listener: &UnixListener, log: &Log, answer: &Arc<F>)
where
    F: Fn(&str, &dyn Fn() -> bool) -> String + Send + Sync + 'static,
{
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let answer = Arc::clone(answer);
                let spawned = thread::Builder::new()
                    .name("orb-control-request".into())
                    .spawn(move || serve(stream, REQUEST_LIMIT, &*answer));
                if let Err(error) = spawned {
                    log.error_on_change("control-spawn", "couldn't answer a request", &error);
                }
            }
            Err(error) => {
                log.error_on_change("control-accept", "couldn't accept a request", &error);
            }
        }
    }
}

/// Reads one request line, answers it, and writes one reply line. A client
/// that hangs up early, or sends no line within `read_limit`, gets nothing.
fn serve<F>(stream: UnixStream, read_limit: Duration, answer: &F)
where
    F: Fn(&str, &dyn Fn() -> bool) -> String,
{
    let mut line = String::new();
    let read = stream
        .set_read_timeout(Some(read_limit))
        .and_then(|()| BufReader::new(&stream).read_line(&mut line));
    if read.is_err() {
        return;
    }
    let probing = stream.set_read_timeout(Some(GONE_PROBE)).is_ok();
    let gone = || probing && hung_up(&stream);
    let reply = answer(&line, &gone);
    let mut stream = stream;
    let _ = writeln!(stream, "{reply}");
}

/// Whether the caller on `stream` hung up. It never sends more than its one
/// line, so a later read either times out (still there) or finds the end of
/// the stream (gone).
fn hung_up(mut stream: &UnixStream) -> bool {
    match stream.read(&mut [0; 1]) {
        Ok(0) => true,
        Ok(_) => false,
        Err(error) => !matches!(
            error.kind(),
            ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
        ),
    }
}

/// The control socket's reply line to `line`: `answer`'s reply to the
/// request it holds, or `bad_request` when it holds none.
fn reply_line<F>(line: &str, answer: F) -> String
where
    F: FnOnce(&Request) -> Reply,
{
    let reply = match serde_json::from_str::<Request>(line) {
        Ok(request) => answer(&request),
        Err(error) => Reply::err(ApiError::new(ErrorCode::BadRequest, error.to_string())),
    };
    serde_json::to_string(&reply).unwrap_or_default()
}

/// What a request comes to once read against the state.
#[derive(Debug)]
enum Action {
    /// Answered from the state alone.
    Answered(Reply),
    /// A new shell the sessions actor adds.
    Add(ApiAdd),
    /// A new session the sessions actor starts.
    Start(ApiStart),
    /// A change the screen loop applies.
    Change(Change),
    /// Typing the screen loop does into a pane: a send, keys or a run.
    Pane(PaneRequest),
    /// A pane's text the screen loop reads.
    Read(PaneRequest),
    /// An agent the screen loop types into a pane, then waits for.
    StartAgent {
        pane: PaneId,
        line: String,
        name: Option<String>,
    },
    /// A prompt pasted into an agent, then maybe waited on.
    Prompt {
        pane: PaneId,
        text: String,
        wait: bool,
        timeout: Option<Duration>,
    },
    /// A wait until the pane's agent is idle or blocked.
    Wait {
        pane: PaneId,
        timeout: Option<Duration>,
    },
    /// The last reply in an agent's transcript.
    Transcript { harness: HarnessId, path: PathBuf },
}

/// The reply to `request`: worked out from the state (with no lock held
/// after), then carried out. Each change, and any request refused before it
/// runs, writes one `api` log line; lists, reads, waits, gets and replies that
/// are answered write none. A wait stops once `gone` says the caller hung up.
pub(super) fn answer(deps: &ControlDeps, request: &Request, gone: &dyn Fn() -> bool) -> Reply {
    let planned = plan(&deps.state.read(), request);
    let reply = match planned {
        Ok(Action::Answered(reply)) => return reply,
        Ok(Action::Read(read)) => {
            return match deps.panes.ask(read) {
                Ok(text) => Reply::ok(&ReadResult {
                    text: text.unwrap_or_default(),
                }),
                Err(error) => Reply::err(error),
            };
        }
        Ok(Action::Wait { pane, timeout }) => {
            let deadline = timeout.map(|limit| Instant::now() + limit);
            let poke = || poke(deps);
            return match agent::wait_done(&deps.state, pane, &poke, gone, Timing::REAL, deadline) {
                Ok(done) => Reply::ok(&done),
                Err(error) => Reply::err(error),
            };
        }
        Ok(Action::Transcript { harness, path }) => {
            return match agent::last_reply(&deps.harnesses, &harness, &path) {
                Ok(reply) => Reply::ok(&reply),
                Err(error) => Reply::err(error),
            };
        }
        Ok(Action::Add(add)) => add_pane(deps, add),
        Ok(Action::Start(start)) => start_session(deps, start),
        Ok(Action::Change(change)) => typed(deps, PaneRequest::Change(change)),
        Ok(Action::Pane(request)) => typed(deps, request),
        Ok(Action::StartAgent { pane, line, name }) => start_agent(deps, pane, line, name),
        Ok(Action::Prompt {
            pane,
            text,
            wait,
            timeout,
        }) => prompt_agent(deps, pane, text, wait, timeout, gone),
        Err(error) => Reply::err(error),
    };
    deps.log.line("api", &log_text(request, &reply));
    reply
}

/// `<op> caller=<id> pane=<id> session=<id> project=<id> -> ok|<code>`, with
/// only the IDs `request` carries: never a name, a prompt or pasted text. A
/// `failed` reply adds its reason, which may quote git but never a prompt or
/// pasted text.
fn log_text(request: &Request, reply: &Reply) -> String {
    let fields = serde_json::to_value(request).unwrap_or_default();
    let text = |key| match fields.get(key) {
        Some(serde_json::Value::String(op)) if key == "op" => Some(op.clone()),
        Some(serde_json::Value::Number(id)) => Some(format!("{key}={id}")),
        _ => None,
    };
    let result = match &reply.error {
        None => "ok".to_owned(),
        Some(error) if error.code == ErrorCode::Failed => format!("failed: {}", error.message),
        Some(error) => serde_json::to_value(error.code)
            .ok()
            .and_then(|code| code.as_str().map(str::to_owned))
            .unwrap_or_default(),
    };
    ["op", "caller", "pane", "session", "project"]
        .into_iter()
        .filter_map(text)
        .chain([format!("-> {result}")])
        .collect::<Vec<_>>()
        .join(" ")
}

/// What `request` comes to, read from `app`, or why it's refused.
fn plan(app: &AppState, request: &Request) -> Result<Action, ApiError> {
    let caller = request.caller;
    let add = |session, place| Ok(Action::Add(ApiAdd { session, place }));
    match &request.op {
        Op::SessionList | Op::TabList { .. } | Op::PaneList { .. } | Op::AgentList => {
            Ok(Action::Answered(route(app, request)))
        }
        Op::PaneSplit { pane, direction } => {
            let (session, at) = tiled(app, *pane, caller, SPLIT_FLOAT)?;
            add(
                session,
                ApiPlace::Split {
                    at,
                    split: (*direction).into(),
                },
            )
        }
        Op::PaneStack { pane } => {
            let (session, at) = tiled(app, *pane, caller, SPLIT_FLOAT)?;
            add(session, ApiPlace::Stack { at })
        }
        Op::PaneFloat { session } => add(changing_session(app, *session, caller)?, ApiPlace::Float),
        Op::TabCreate { session } => add(changing_session(app, *session, caller)?, ApiPlace::Tab),
        Op::SessionCreate {
            project,
            worktree,
            name,
        } => session_create(app, *project, *worktree, name.clone(), caller),
        Op::PaneClose { pane } => {
            changing(app, Some(Target::Pane(*pane)), caller)?;
            Ok(Action::Change(Change::ClosePane(*pane)))
        }
        Op::PaneRename { pane, name } => {
            changing(app, Some(Target::Pane(*pane)), caller)?;
            Ok(Action::Change(Change::RenamePane {
                pane: *pane,
                name: name.clone(),
            }))
        }
        Op::PaneFocus { pane } => {
            let session = changing(app, Some(Target::Pane(*pane)), caller)?.session;
            Ok(Action::Change(Change::Focus {
                session,
                pane: Some(*pane),
            }))
        }
        Op::TabClose { pane } => {
            let (_, pane) = tiled(app, *pane, caller, "a float isn't in a tab")?;
            Ok(Action::Change(Change::CloseTab(pane)))
        }
        Op::SessionRename { session, name } => Ok(Action::Change(Change::RenameSession {
            session: changing_session(app, *session, caller)?,
            name: name.clone(),
        })),
        Op::SessionSettle { session } => Ok(Action::Change(Change::SettleSession(
            changing_session(app, *session, caller)?,
        ))),
        Op::SessionFocus { session } => Ok(Action::Change(Change::Focus {
            session: changing_session(app, Some(*session), caller)?,
            pane: None,
        })),
        Op::PaneSend { .. } | Op::PaneKeys { .. } | Op::PaneRun { .. } | Op::PaneRead { .. } => {
            pane_io(app, &request.op, caller)
        }
        Op::AgentStart { .. }
        | Op::AgentPrompt { .. }
        | Op::AgentWait { .. }
        | Op::AgentGet { .. }
        | Op::AgentReply { .. } => agent_io(app, &request.op, caller),
    }
}

/// What an agent request comes to, read from `app`. A wait is refused on a
/// settled session; a get and a reply are answered there.
fn agent_io(app: &AppState, op: &Op, caller: Option<PaneId>) -> Result<Action, ApiError> {
    match op {
        Op::AgentStart {
            pane,
            kind,
            name,
            args,
        } => {
            let Some(pane) = changing(app, pane.map(Target::Pane), caller)?.pane else {
                return Err(ApiError::new(ErrorCode::BadRequest, "no pane to start in"));
            };
            validator::pane_free(app, pane)?;
            Ok(Action::StartAgent {
                pane,
                line: agent::shell_line(*kind, args),
                name: name.clone(),
            })
        }
        Op::AgentPrompt {
            pane,
            text,
            wait,
            timeout,
        } => {
            changing(app, Some(Target::Pane(*pane)), caller)?;
            validator::agent_ready(app, *pane)?;
            Ok(Action::Prompt {
                pane: *pane,
                text: text.clone(),
                wait: *wait,
                timeout: timeout.map(Duration::from_millis),
            })
        }
        Op::AgentWait { pane, timeout } => {
            changing(app, Some(Target::Pane(*pane)), caller)?;
            Ok(Action::Wait {
                pane: *pane,
                timeout: timeout.map(Duration::from_millis),
            })
        }
        Op::AgentGet { pane } => {
            let session = target::resolve(app, Some(Target::Pane(*pane)), caller)?.session;
            let agent = agent::pane_agent(app, *pane).ok_or_else(|| agent::no_agent(*pane))?;
            Ok(Action::Answered(Reply::ok(&agent_row(
                app, session, agent, *pane,
            ))))
        }
        Op::AgentReply { pane } => {
            target::resolve(app, Some(Target::Pane(*pane)), caller)?;
            let agent = agent::pane_agent(app, *pane).ok_or_else(|| agent::no_agent(*pane))?;
            let path = agent
                .transcript
                .clone()
                .ok_or_else(|| ApiError::new(ErrorCode::NoReply, "no transcript yet"))?;
            Ok(Action::Transcript {
                harness: agent.harness.clone(),
                path,
            })
        }
        _ => Err(ApiError::new(ErrorCode::BadRequest, "not an agent request")),
    }
}

/// Pokes the sessions poll so it reads the panes now.
fn poke(deps: &ControlDeps) {
    let _ = deps
        .sessions
        .tell(SessionsCommand::RefreshSessions)
        .try_send();
}

/// Has the screen loop paste `text` into `pane`'s agent and press Enter;
/// with `wait`, waits for the turn to end or the agent to be blocked, with
/// `timeout` over the whole call, until `gone` says the caller hung up.
fn prompt_agent(
    deps: &ControlDeps,
    pane: PaneId,
    text: String,
    wait: bool,
    timeout: Option<Duration>,
    gone: &dyn Fn() -> bool,
) -> Reply {
    let deadline = timeout.map(|limit| Instant::now() + limit);
    let pasted = SystemTime::now();
    if let Err(error) = deps.panes.ask(PaneRequest::Prompt { pane, text }) {
        return Reply::err(error);
    }
    if !wait {
        return Reply::ok(&PromptResult { submitted: true });
    }
    let poke = || poke(deps);
    match agent::wait_prompted(
        &deps.state,
        pane,
        &poke,
        gone,
        Timing::REAL,
        deadline,
        pasted,
    ) {
        Ok(done) => Reply::ok(&done),
        Err(error) => Reply::err(error),
    }
}

/// Has the screen loop type `line` into `pane`, names the pane `name` if
/// given (a failed rename is logged, not replied), then waits for the agent
/// to start.
fn start_agent(deps: &ControlDeps, pane: PaneId, line: String, name: Option<String>) -> Reply {
    if let Err(error) = deps.panes.ask(PaneRequest::Launch { pane, line }) {
        return Reply::err(error);
    }
    if let Some(name) = name
        && let Err(error) = deps
            .panes
            .ask(PaneRequest::Change(Change::RenamePane { pane, name }))
    {
        deps.log.line(
            "control",
            &format!("couldn't name pane {}: {}", pane.0, error.message),
        );
    }
    match agent::wait_started(&deps.state, pane, &|| poke(deps), Timing::REAL) {
        Ok(started) => Reply::ok(&started),
        Err(error) => Reply::err(error),
    }
}

/// What a send, keys, run or read comes to, read from `app`: settled before
/// an unknown key name, so a refused list of keys sends nothing.
fn pane_io(app: &AppState, op: &Op, caller: Option<PaneId>) -> Result<Action, ApiError> {
    match op {
        Op::PaneSend { pane, text } => {
            changing(app, Some(Target::Pane(*pane)), caller)?;
            Ok(Action::Pane(PaneRequest::Send {
                pane: *pane,
                text: text.clone(),
            }))
        }
        Op::PaneKeys { pane, keys } => {
            changing(app, Some(Target::Pane(*pane)), caller)?;
            let keys = keys
                .iter()
                .map(|name| {
                    key_event(name).ok_or_else(|| {
                        ApiError::new(ErrorCode::BadRequest, format!("unknown key {name}"))
                    })
                })
                .collect::<Result<_, _>>()?;
            Ok(Action::Pane(PaneRequest::Keys { pane: *pane, keys }))
        }
        Op::PaneRun { pane, command } => {
            changing(app, Some(Target::Pane(*pane)), caller)?;
            Ok(Action::Pane(PaneRequest::Run {
                pane: *pane,
                line: command.clone(),
            }))
        }
        Op::PaneRead { pane, lines } => match changing(app, pane.map(Target::Pane), caller)? {
            Resolved {
                pane: Some(pane), ..
            } => Ok(Action::Read(PaneRequest::Read {
                pane,
                lines: *lines,
            })),
            Resolved { pane: None, .. } => {
                Err(ApiError::new(ErrorCode::BadRequest, "no pane to read"))
            }
        },
        _ => Err(ApiError::new(
            ErrorCode::BadRequest,
            "not pane input or output",
        )),
    }
}

/// Asks the screen loop for `request` and replies `{}` once it's done.
fn typed(deps: &ControlDeps, request: PaneRequest) -> Reply {
    match deps.panes.ask(request) {
        Ok(_) => Reply::ok(&Done {}),
        Err(error) => Reply::err(error),
    }
}

/// What a change is about, as [`target::resolve`] finds it; `settled` when
/// its session is settled.
fn changing(
    app: &AppState,
    target: Option<Target>,
    caller: Option<PaneId>,
) -> Result<Resolved, ApiError> {
    let resolved = target::resolve(app, target, caller)?;
    validator::not_settled(app, resolved.session)?;
    Ok(resolved)
}

/// The session a change names, else the caller's; `settled` when it is.
fn changing_session(
    app: &AppState,
    session: Option<SessionId>,
    caller: Option<PaneId>,
) -> Result<SessionId, ApiError> {
    changing(app, session.map(Target::Session), caller).map(|resolved| resolved.session)
}

/// Project `project`, else the caller's session's; `not_found` when it's gone
/// or removed.
fn project_for(
    app: &AppState,
    project: Option<ProjectId>,
    caller: Option<PaneId>,
) -> Result<ProjectId, ApiError> {
    let id = match project {
        Some(id) => Some(id),
        None => {
            let session = target::resolve(app, None, caller)?.session;
            app.sessions.session(session).map(|session| session.project)
        }
    };
    id.and_then(|id| app.sessions.project(id))
        .filter(|project| !project.removed)
        .map(|project| project.id)
        .ok_or_else(|| ApiError::new(ErrorCode::NotFound, "no such project"))
}

/// A new session of `project` (else the caller's session's). Without
/// `project`, a caller in a fresh world gets one in its own folder, no
/// worktree; `--worktree` there, or `project` naming a fresh world, is a
/// `bad_request`. A caller in a colony or a colonist makes it that
/// session's colonist.
fn session_create(
    app: &AppState,
    project: Option<ProjectId>,
    worktree: bool,
    name: Option<String>,
    caller: Option<PaneId>,
) -> Result<Action, ApiError> {
    let named = project.is_some();
    let project = project_for(app, project, caller)?;
    let asking = target::resolve(app, None, caller)
        .ok()
        .and_then(|resolved| app.sessions.session(resolved.session));
    let dir = match app
        .sessions
        .project(project)
        .filter(|project| project.kind.is_fresh_world())
    {
        None => None,
        Some(world) if named => {
            return Err(ApiError::new(
                ErrorCode::BadRequest,
                format!(
                    "can't start a session in fresh world {}; make its colonies with <C-g> c",
                    world.title
                ),
            ));
        }
        Some(world) if worktree => {
            return Err(ApiError::new(
                ErrorCode::BadRequest,
                format!(
                    "fresh world {}'s folders aren't git repositories; for a worktree, name a project with --project",
                    world.title
                ),
            ));
        }
        Some(_) => Some(
            asking
                .map(|session| session.dir.clone())
                .ok_or_else(|| ApiError::new(ErrorCode::NotFound, "no such session"))?,
        ),
    };
    let parent = asking
        .filter(|session| session.kind == SessionKind::Colony || session.parent.is_some())
        .map(|session| session.id);
    Ok(Action::Start(ApiStart {
        project,
        worktree,
        name,
        parent,
        dir,
    }))
}

/// Pane `pane` (else the caller's) and its session; `bad_request` saying
/// `why` when it's a float.
fn tiled(
    app: &AppState,
    pane: Option<PaneId>,
    caller: Option<PaneId>,
    why: &str,
) -> Result<(SessionId, PaneId), ApiError> {
    match changing(app, pane.map(Target::Pane), caller)? {
        Resolved {
            session,
            pane: Some(at),
        } if !app
            .layouts
            .get(session)
            .is_some_and(|layout| layout.floats().holds(at)) =>
        {
            Ok((session, at))
        }
        _ => Err(ApiError::new(ErrorCode::BadRequest, why)),
    }
}

/// Why a float can't be split or stacked.
const SPLIT_FLOAT: &str = "floats can't be split or stacked";

/// Asks the sessions actor for the shell `add` describes and replies with it.
fn add_pane(deps: &ControlDeps, add: ApiAdd) -> Reply {
    match deps
        .runtime
        .block_on(async { deps.sessions.ask(add).await })
    {
        Ok(pane) => Reply::ok(&PaneResult { pane }),
        Err(error) => Reply::err(ApiError::new(ErrorCode::Failed, error.to_string())),
    }
}

/// Asks the sessions actor to start `start` and replies with the new session
/// and its first pane, or `starting` when the actor says another session is
/// starting.
fn start_session(deps: &ControlDeps, start: ApiStart) -> Reply {
    match deps
        .runtime
        .block_on(async { deps.sessions.ask(start).await })
    {
        Ok((session, pane)) => {
            if let Err(error) = deps.panes.ask(PaneRequest::Change(Change::Attach(session))) {
                deps.log.line(
                    "control",
                    &format!("couldn't run session {}: {}", session.0, error.message),
                );
            }
            Reply::ok(&StartResult { session, pane })
        }
        Err(SendError::HandlerError(ApiStartError::Starting)) => Reply::err(ApiError::new(
            ErrorCode::Starting,
            ApiStartError::Starting.to_string(),
        )),
        Err(error) => Reply::err(ApiError::new(ErrorCode::Failed, error.to_string())),
    }
}

/// The reply to a list `request`, read from `app`.
fn route(app: &AppState, request: &Request) -> Reply {
    match request.op {
        Op::SessionList => Reply::ok(&sessions(app)),
        Op::TabList { session } => match in_session(app, session, request.caller) {
            Ok(resolved) => Reply::ok(&tabs(app, resolved.session)),
            Err(error) => Reply::err(error),
        },
        Op::PaneList { session } => match in_session(app, session, request.caller) {
            Ok(resolved) => Reply::ok(&panes(app, resolved.session, request.caller)),
            Err(error) => Reply::err(error),
        },
        Op::AgentList => Reply::ok(&agents(app)),
        _ => Reply::err(ApiError::new(ErrorCode::BadRequest, "not a list")),
    }
}

/// The session named, else the caller's.
fn in_session(
    app: &AppState,
    session: Option<SessionId>,
    caller: Option<PaneId>,
) -> Result<Resolved, ApiError> {
    target::resolve(app, session.map(Target::Session), caller)
}

/// Every session not being deleted, settled ones included.
fn sessions(app: &AppState) -> SessionsResult {
    let sessions = app
        .sessions
        .sessions
        .iter()
        .filter(|session| !app.sessions.deleting.contains(&session.id))
        .map(|session| SessionRow {
            id: session.id,
            project: session.project,
            name: app.sessions.title(session),
            dir: session.dir.to_string_lossy().into_owned(),
            branch: session.branch.clone(),
            settled: session.settled_at.is_some(),
        })
        .collect();
    SessionsResult { sessions }
}

/// Session `session`'s tabs, numbered from 1 as the tab bar shows them, with
/// their panes; none without a layout.
fn tabs(app: &AppState, session: SessionId) -> TabsResult {
    let tabs = app
        .layouts
        .get(session)
        .map(|layout| {
            layout
                .tabs()
                .iter()
                .enumerate()
                .map(|(index, tab)| TabRow {
                    index: index + 1,
                    panes: tab.pane_ids(),
                })
                .collect()
        })
        .unwrap_or_default();
    TabsResult { session, tabs }
}

/// Session `session`'s panes: each tab's, then the floats, with `caller`'s
/// marked.
fn panes(app: &AppState, session: SessionId, caller: Option<PaneId>) -> PanesResult {
    let Some(layout) = app.layouts.get(session) else {
        return PanesResult { panes: Vec::new() };
    };
    let agents = app.sessions.agent_rows(session, &app.layouts);
    let placed = layout
        .tabs()
        .iter()
        .enumerate()
        .flat_map(|(index, tab)| {
            tab.pane_ids()
                .into_iter()
                .map(move |pane| (pane, Some(index + 1)))
        })
        .chain(layout.floats().pane_ids().map(|pane| (pane, None)));
    let panes = placed
        .map(|(pane, tab)| {
            let entry = app.layouts.entry(pane);
            PaneRow {
                id: pane,
                session,
                tab,
                float: tab.is_none(),
                name: entry.and_then(|entry| entry.name.clone()),
                cwd: entry
                    .map(|entry| entry.cwd.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                agent: agents
                    .iter()
                    .find(|&&(_, shown)| shown == pane)
                    .map(|(agent, _)| agent.id),
                caller: Some(pane) == caller,
            }
        })
        .collect();
    PanesResult { panes }
}

/// Every live agent in every session not being deleted.
fn agents(app: &AppState) -> AgentsResult {
    let agents = app
        .sessions
        .sessions
        .iter()
        .flat_map(|session| {
            app.sessions
                .agent_rows(session.id, &app.layouts)
                .into_iter()
                .map(move |(agent, pane)| agent_row(app, session.id, agent, pane))
        })
        .collect();
    AgentsResult { agents }
}

/// `agent`'s row in `agent list`, running in `pane` of `session`.
fn agent_row(app: &AppState, session: SessionId, agent: &Agent, pane: PaneId) -> AgentRow {
    AgentRow {
        id: agent.id,
        pane: Some(pane),
        session,
        harness: agent.harness.to_string(),
        name: app.layouts.agent_name(pane, Some(agent)).to_owned(),
        title: agent.title.clone(),
        status: agent.status,
        cwd: agent.cwd.to_string_lossy().into_owned(),
        branch: agent.branch.clone(),
    }
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate setup failures with `?` and assert on the outcome"
)]
mod tests {
    use std::ffi::OsString;
    use std::io::{self, Read, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;
    use std::thread;
    use std::time::Duration;

    use error_stack::{Report, ResultExt};
    use tempfile::TempDir;

    use super::{Action, ControlServerError, log_text, open, plan, reply_line, route, serve};
    use crate::feat::control::client;
    use crate::feat::control::protocol::{
        AgentKind, ApiError, Direction, Done, ErrorCode, Op, Reply, Request,
    };
    use crate::feat::layout::state::test_entry;
    use crate::feat::sessions::state::{AgentStatus, ProjectKind, SessionKind};
    use crate::ids::{PaneId, SessionId};
    use crate::intent_handler::test_support::{agent, settle, state_with, stopped};
    use crate::{AppState, Log, State};

    /// Listens on a socket in a fresh temp dir, answering from `app`.
    fn listening(app: AppState) -> Result<(TempDir, PathBuf), Report<ControlServerError>> {
        let dir = tempfile::tempdir().change_context(ControlServerError)?;
        let socket = dir.path().join("orb.sock");
        let state = State::new(app);
        open(&socket, Log::default(), move |line, _gone| {
            reply_line(line, |request| route(&state.read(), request))
        })?;
        Ok((dir, socket))
    }

    #[rstest::rstest]
    fn socket_is_created_with_mode_0600() -> Result<(), Report<ControlServerError>> {
        // Given / When orb listens on a socket.
        let (_dir, socket) = listening(AppState::default())?;

        // Then only the user can open it.
        let mode = std::fs::metadata(&socket)
            .change_context(ControlServerError)?
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "the socket is private to the user");
        Ok(())
    }

    #[rstest::rstest]
    fn pane_list_over_the_socket_marks_the_callers_pane() -> Result<(), Report<ControlServerError>>
    {
        // Given orb listening with session 1, pane 1, agent 1.
        let (_dir, socket) = listening(state_with(vec![agent(1, AgentStatus::Idle)], 1))?;
        let (mut out, mut err) = (Vec::new(), Vec::new());

        // When pane 1 runs `pane list`.
        let words: Vec<OsString> = ["pane", "list"].iter().map(OsString::from).collect();
        client::run(&words, Some(PaneId(1)), &socket, &mut out, &mut err);

        // Then it gets one pane, its own, marked as the caller, with agent 1.
        let reply: serde_json::Value =
            serde_json::from_slice(&out).change_context(ControlServerError)?;
        let field = |pane: &serde_json::Value, key: &str| pane.get(key).cloned();
        let summary: Vec<_> = reply
            .get("panes")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .map(|pane| {
                (
                    field(pane, "id").and_then(|v| v.as_i64()),
                    field(pane, "caller").and_then(|v| v.as_bool()),
                    field(pane, "agent").and_then(|v| v.as_i64()),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![(Some(1), Some(true), Some(1))],
            "the caller's pane is listed and marked, err: {}",
            String::from_utf8_lossy(&err)
        );
        Ok(())
    }

    #[rstest::rstest]
    fn split_of_a_float_is_a_bad_request() {
        // Given session 1 with float pane 2.
        let mut app = state_with(vec![agent(1, AgentStatus::Idle)], 1);
        app.layouts.add_float_hidden(SessionId(1), test_entry(2));

        // When planning a split of pane 2.
        let request = Request {
            caller: None,
            op: Op::PaneSplit {
                pane: Some(PaneId(2)),
                direction: Direction::Right,
            },
        };
        let planned = plan(&app, &request);

        // Then it is refused with bad_request.
        assert_eq!(
            planned.map(drop).map_err(|error| error.code),
            Err(ErrorCode::BadRequest),
            "a float can't be split"
        );
    }

    #[rstest::rstest]
    #[case::pane_split(Op::PaneSplit { pane: None, direction: Direction::Right })]
    #[case::pane_stack(Op::PaneStack { pane: None })]
    #[case::pane_float(Op::PaneFloat { session: None })]
    #[case::tab_create(Op::TabCreate { session: None })]
    #[case::tab_close(Op::TabClose { pane: None })]
    #[case::pane_close(Op::PaneClose { pane: PaneId(1) })]
    #[case::pane_rename(Op::PaneRename { pane: PaneId(1), name: "x".into() })]
    #[case::pane_focus(Op::PaneFocus { pane: PaneId(1) })]
    #[case::session_rename(Op::SessionRename { session: None, name: "x".into() })]
    #[case::session_settle(Op::SessionSettle { session: None })]
    #[case::session_focus(Op::SessionFocus { session: SessionId(1) })]
    #[case::pane_send(Op::PaneSend { pane: PaneId(1), text: "x".into() })]
    #[case::pane_keys(Op::PaneKeys { pane: PaneId(1), keys: vec!["enter".into()] })]
    #[case::pane_run(Op::PaneRun { pane: PaneId(1), command: "x".into() })]
    #[case::pane_read(Op::PaneRead { pane: None, lines: 0 })]
    #[case::agent_start(Op::AgentStart { pane: None, kind: AgentKind::Claude, name: None, args: vec![] })]
    #[case::agent_prompt(Op::AgentPrompt { pane: PaneId(1), text: "x".into(), wait: false, timeout: None })]
    #[case::agent_wait(Op::AgentWait { pane: PaneId(1), timeout: None })]
    fn request_on_a_settled_session_is_refused(#[case] op: Op) {
        // Given session 1, settled, with pane 1.
        let app = settle(state_with(vec![stopped(1)], 1), &[1]);

        // When planning the request from pane 1.
        let planned = plan(
            &app,
            &Request {
                caller: Some(PaneId(1)),
                op,
            },
        );

        // Then it is refused with settled.
        assert_eq!(
            planned.map(drop).map_err(|error| error.code),
            Err(ErrorCode::Settled),
            "nothing in a settled session changes"
        );
    }

    #[rstest::rstest]
    fn log_line_names_ids_and_never_the_name() {
        // Given pane 4 renaming session 2 to a private name, refused.
        let request = Request {
            caller: Some(PaneId(4)),
            op: Op::SessionRename {
                session: Some(SessionId(2)),
                name: "secret plan".into(),
            },
        };
        let reply = Reply::err(ApiError::new(ErrorCode::Settled, "session is settled"));

        // When writing its log line.
        let text = log_text(&request, &reply);

        // Then it has the op, the IDs and the code, and not the name.
        assert_eq!(
            text, "session.rename caller=4 session=2 -> settled",
            "the log line carries IDs only"
        );
    }

    #[rstest::rstest]
    fn log_line_of_a_failure_carries_its_reason() {
        // Given a pane close that failed because the screen didn't answer.
        let request = Request {
            caller: None,
            op: Op::PaneClose { pane: PaneId(3) },
        };
        let reply = Reply::err(ApiError::new(
            ErrorCode::Failed,
            "orb's screen didn't answer",
        ));

        // When writing its log line.
        let text = log_text(&request, &reply);

        // Then the reason follows the code.
        assert_eq!(
            text, "pane.close pane=3 -> failed: orb's screen didn't answer",
            "a failure logs why"
        );
    }

    #[rstest::rstest]
    fn log_line_of_a_success_ends_in_ok() {
        // Given a pane close from outside orb that worked.
        let request = Request {
            caller: None,
            op: Op::PaneClose { pane: PaneId(3) },
        };

        // When writing its log line.
        let text = log_text(&request, &Reply::ok(&Done {}));

        // Then it ends in ok.
        assert_eq!(text, "pane.close pane=3 -> ok", "a success logs ok");
    }

    #[rstest::rstest]
    fn unknown_key_name_is_a_bad_request() {
        // Given live session 1 with pane 1.
        let app = state_with(vec![agent(1, AgentStatus::Idle)], 1);

        // When planning keys `enter` then an unknown `nope` for pane 1.
        let request = Request {
            caller: None,
            op: Op::PaneKeys {
                pane: PaneId(1),
                keys: vec!["enter".into(), "nope".into()],
            },
        };
        let planned = plan(&app, &request);

        // Then it is refused with bad_request before anything reaches the
        // screen loop.
        assert_eq!(
            planned.map(drop).map_err(|error| error.code),
            Err(ErrorCode::BadRequest),
            "an unknown key name sends nothing"
        );
    }

    #[rstest::rstest]
    fn log_line_of_a_send_leaves_out_the_text() {
        // Given pane 1 pasting private text into pane 3, done.
        let request = Request {
            caller: Some(PaneId(1)),
            op: Op::PaneSend {
                pane: PaneId(3),
                text: "secret".into(),
            },
        };

        // When writing its log line.
        let text = log_text(&request, &Reply::ok(&Done {}));

        // Then it has the op and the IDs, and not the text.
        assert_eq!(
            text, "pane.send caller=1 pane=3 -> ok",
            "typed text never reaches the log"
        );
    }

    #[rstest::rstest]
    fn agent_get_on_a_settled_session_is_answered() {
        // Given session 1, settled, with stopped agent 1 in pane 1.
        let app = settle(state_with(vec![stopped(1)], 1), &[1]);

        // When planning `agent get` for pane 1.
        let request = Request {
            caller: None,
            op: Op::AgentGet { pane: PaneId(1) },
        };
        let planned = plan(&app, &request);

        // Then it is answered from the state.
        assert!(
            matches!(&planned, Ok(Action::Answered(reply)) if reply.ok),
            "a settled session's agent can still be read, got {planned:?}"
        );
    }

    #[rstest::rstest]
    fn log_line_of_a_prompt_leaves_out_the_text() {
        // Given pane 1 prompting the agent in pane 3 with private text, done.
        let request = Request {
            caller: Some(PaneId(1)),
            op: Op::AgentPrompt {
                pane: PaneId(3),
                text: "secret".into(),
                wait: true,
                timeout: Some(9),
            },
        };

        // When writing its log line.
        let text = log_text(&request, &Reply::ok(&Done {}));

        // Then it has the op and the IDs, and not the text.
        assert_eq!(
            text, "agent.prompt caller=1 pane=3 -> ok",
            "a prompt's text never reaches the log"
        );
    }

    /// The parent `orb session create` gives the new session when pane 1 of
    /// session 1, of `kind` and `parent`, asks.
    fn parent_from(kind: SessionKind, parent: Option<SessionId>) -> Option<SessionId> {
        let mut app = state_with(vec![agent(1, AgentStatus::Idle)], 1);
        if let Some(session) = app.sessions.sessions.first_mut() {
            session.kind = kind;
            session.parent = parent;
        }
        let planned = plan(
            &app,
            &Request {
                caller: Some(PaneId(1)),
                op: Op::SessionCreate {
                    project: None,
                    worktree: false,
                    name: None,
                },
            },
        );
        match planned {
            Ok(Action::Start(start)) => start.parent,
            _ => None,
        }
    }

    #[rstest::rstest]
    fn session_create_from_a_colony_pane_makes_its_colonist() {
        // Given session 1, a colony, with pane 1.
        // When pane 1 runs `session create`.
        let parent = parent_from(SessionKind::Colony, None);

        // Then the new session's parent is session 1.
        assert_eq!(
            parent,
            Some(SessionId(1)),
            "a colony's pane makes a colonist"
        );
    }

    #[rstest::rstest]
    fn session_create_from_a_colonist_pane_makes_its_colonist() {
        // Given session 1, a plain colonist of session 9, with pane 1.
        // When pane 1 runs `session create`.
        let parent = parent_from(SessionKind::Plain, Some(SessionId(9)));

        // Then the new session's parent is session 1.
        assert_eq!(
            parent,
            Some(SessionId(1)),
            "a colonist's pane makes its own colonist"
        );
    }

    #[rstest::rstest]
    fn session_create_from_a_normal_pane_is_top_level() {
        // Given session 1, plain and top level, with pane 1.
        // When pane 1 runs `session create`.
        let parent = parent_from(SessionKind::Plain, None);

        // Then the new session has no parent.
        assert_eq!(
            parent, None,
            "a normal session's pane makes a top-level session"
        );
    }

    /// What `orb session create` plans when pane 1 of session 1, a colony
    /// in a project of `kind`, asks with `worktree` and, when `named`, the
    /// project's id; and session 1's folder.
    fn created_from_colony(
        kind: ProjectKind,
        worktree: bool,
        named: bool,
    ) -> (Result<Action, ApiError>, Option<PathBuf>) {
        let mut app = state_with(vec![agent(1, AgentStatus::Idle)], 1);
        let project = app.sessions.projects.first_mut().map(|project| {
            project.kind = kind;
            project.id
        });
        let dir = app.sessions.sessions.first_mut().map(|session| {
            session.kind = SessionKind::Colony;
            session.dir.clone()
        });
        let planned = plan(
            &app,
            &Request {
                caller: Some(PaneId(1)),
                op: Op::SessionCreate {
                    project: project.filter(|_| named),
                    worktree,
                    name: None,
                },
            },
        );
        (planned, dir)
    }

    #[rstest::rstest]
    #[case::research(ProjectKind::Research)]
    #[case::learn(ProjectKind::Learn)]
    #[case::fresh_world(ProjectKind::FreshWorld)]
    fn session_create_naming_a_fresh_world_is_a_bad_request(#[case] kind: ProjectKind) {
        // Given session 1, a colony with pane 1, in a fresh world of `kind`.
        // When pane 1 runs `session create --project <the world>`.
        let (planned, _) = created_from_colony(kind, false, true);

        // Then it is refused with bad_request.
        assert_eq!(
            planned.map(drop).map_err(|error| error.code),
            Err(ErrorCode::BadRequest),
            "a fresh world named with --project takes colonies, not API sessions"
        );
    }

    #[rstest::rstest]
    #[case::research(ProjectKind::Research)]
    #[case::learn(ProjectKind::Learn)]
    #[case::fresh_world(ProjectKind::FreshWorld)]
    fn session_create_in_a_fresh_world_starts_in_the_callers_folder(#[case] kind: ProjectKind) {
        // Given session 1, a colony with pane 1, in a fresh world of `kind`.
        // When pane 1 runs `session create` without --project.
        let (planned, dir) = created_from_colony(kind, false, false);

        // Then the new session starts in session 1's folder.
        let start_dir = match planned {
            Ok(Action::Start(start)) => start.dir,
            _ => None,
        };
        assert_eq!(start_dir, dir, "a helper starts in its colony's folder");
    }

    #[rstest::rstest]
    fn session_create_in_a_fresh_world_is_the_callers_colonist() {
        // Given session 1, a colony with pane 1, in a fresh world.
        // When pane 1 runs `session create` without --project.
        let (planned, _) = created_from_colony(ProjectKind::Research, false, false);

        // Then the new session's parent is session 1.
        let parent = match planned {
            Ok(Action::Start(start)) => start.parent,
            _ => None,
        };
        assert_eq!(parent, Some(SessionId(1)), "a helper sits under its colony");
    }

    #[rstest::rstest]
    fn session_create_with_worktree_in_a_fresh_world_is_a_bad_request() {
        // Given session 1, a colony with pane 1, in a fresh world.
        // When pane 1 runs `session create --worktree` without --project.
        let (planned, _) = created_from_colony(ProjectKind::Research, true, false);

        // Then it is refused with bad_request.
        assert_eq!(
            planned.map(drop).map_err(|error| error.code),
            Err(ErrorCode::BadRequest),
            "a fresh world's folders have no git for a worktree"
        );
    }

    #[rstest::rstest]
    fn session_create_in_a_normal_project_has_no_dir() {
        // Given session 1, a colony with pane 1, in a normal project.
        // When pane 1 runs `session create`.
        let (planned, _) = created_from_colony(ProjectKind::Normal, false, false);

        // Then the new session gets no folder of its own.
        let has_dir = match planned {
            Ok(Action::Start(start)) => start.dir.is_some(),
            _ => true,
        };
        assert!(
            !has_dir,
            "a normal project's session starts in its checkout"
        );
    }

    #[rstest::rstest]
    fn silent_connection_is_closed_after_the_read_limit() -> io::Result<()> {
        // Given a connection served with a 50 ms read limit.
        let (mut client, server) = UnixStream::pair()?;
        thread::spawn(move || {
            serve(
                server,
                Duration::from_millis(50),
                &|_: &str, _: &dyn Fn() -> bool| String::new(),
            );
        });

        // When the client sends nothing.
        let read = client.read(&mut [0; 1])?;

        // Then orb closes the connection without a reply.
        assert_eq!(read, 0, "a silent connection should be closed");
        Ok(())
    }

    #[rstest::rstest]
    fn answer_sees_a_caller_that_hung_up() -> io::Result<()> {
        // Given a connection whose answer runs until its caller hangs up.
        let (mut client, server) = UnixStream::pair()?;
        let served = thread::spawn(move || {
            serve(server, Duration::from_secs(5), &|_: &str,
                                                    gone: &dyn Fn()
                -> bool| {
                while !gone() {
                    thread::sleep(Duration::from_millis(1));
                }
                String::new()
            });
        });

        // When the client sends a line and hangs up.
        writeln!(client, "{{}}")?;
        drop(client);

        // Then the answer stops and serve returns.
        assert!(
            served.join().is_ok(),
            "serve should return once the caller left"
        );
        Ok(())
    }
}
