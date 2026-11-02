//! Binary entry point for orb. This is the only place that reads process state
//! (the environment).

use std::backtrace::Backtrace;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;
use std::{panic, thread};

use error_stack::{Report, ResultExt};
use jiff::tz::TimeZone;
use orb_domain::feat::control::browser_socket;
use orb_domain::feat::control::client;
use orb_domain::feat::control::protocol::socket_path;
use orb_domain::feat::control::server::{self, ControlDeps};
use orb_domain::feat::git::git_cli::GitCli;
use orb_domain::feat::git::git_service::GitService;
use orb_domain::feat::harness::Harnesses;
use orb_domain::feat::harness::claude::ClaudeCode;
use orb_domain::feat::harness::claude::supervisor::ClaudeSupervisor;
use orb_domain::feat::harness::pi::Pi;
use orb_domain::feat::integration::{self, IntegrationPaths};
use orb_domain::feat::notify::click::{ClickTarget, Kitty, NiriTarget, on_path};
use orb_domain::feat::notify::notifier::NotifierService;
use orb_domain::feat::notify::sound::SoundService;
use orb_domain::feat::search::search_actor::{SearchActorDeps, spawn_search_actor};
use orb_domain::feat::sessions::child_env::{ORB_PANE_ID, child_env, terminal_browser_socket_env};
use orb_domain::feat::sessions::sessions_actor::{SessionsActorDeps, spawn_sessions_actor};
use orb_domain::feat::sessions::store::{self, Store, Upgrade};
use orb_domain::feat::worktrees::worktrees_actor::{
    SWEEP_EVERY, WorktreesActorDeps, spawn_worktrees_actor,
};
use orb_domain::feat::zmx::zmx_cli::ZmxCli;
use orb_domain::feat::zmx::zmx_service::ZmxService;
use orb_domain::ids::PaneId;
use orb_domain::{
    AppState, Finished, Log, Services, State, ancestry, ends_orb, panic_text, parse_parents,
    run_within, stop_gracefully,
};
use orb_tui::{Frontend, PANE_READER_THREAD};
use tokio::signal::unix::{Signal, SignalKind, signal};
use wherror::Error;

/// orb couldn't start, or its frontend failed.
#[derive(Debug, Error)]
#[error(debug)]
struct OrbError;

/// How long quitting waits for the workers to finish what they had queued.
const QUIT_CAP: Duration = Duration::from_secs(2);

/// How long quitting waits for the runtime's tasks after the workers stopped.
const RUNTIME_SHUTDOWN: Duration = Duration::from_millis(200);

fn main() -> Result<ExitCode, Report<OrbError>> {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args
        .first()
        .is_some_and(|arg| arg == "--version" || arg == "-V")
    {
        writeln!(
            std::io::stdout().lock(),
            "orb {}",
            env!("CARGO_PKG_VERSION")
        )
        .change_context(OrbError)?;
        return Ok(ExitCode::SUCCESS);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| Report::new(OrbError).attach("HOME is not set"))?;
    let orb_root = home.join(".orb");
    if args
        .first()
        .is_some_and(|arg| client::NOUNS.iter().any(|noun| arg == noun))
    {
        let caller = std::env::var(ORB_PANE_ID)
            .ok()
            .and_then(|id| id.parse().ok())
            .map(PaneId);
        let code = client::run(
            &args,
            caller,
            &socket_path(&orb_root),
            &mut std::io::stdout().lock(),
            &mut std::io::stderr().lock(),
        );
        return Ok(ExitCode::from(code));
    }
    let log = Log::new(orb_root.join("orb.log"));
    log.line(
        "start",
        &format!(
            "orb {} pid {}",
            env!("CARGO_PKG_VERSION"),
            std::process::id()
        ),
    );
    install_crash_hook(log.clone());
    let ended = run(home, orb_root, &args, &log);
    if let Err(report) = &ended {
        log.error("orb stopped", report);
    }
    ended.map(|()| ExitCode::SUCCESS)
}

/// Makes every crash end orb at once: the crash and a backtrace go to `log`,
/// the default message prints, and orb exits with 101; panes keep running.
/// A crash on a pane reader only writes its line; the reader stops showing
/// that pane.
#[expect(
    clippy::exit,
    reason = "a crash ends orb at once; panes keep running in zmx"
)]
fn install_crash_hook(log: Log) {
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        log.line("panic", &panic_text(info));
        if !ends_orb(thread::current().name(), PANE_READER_THREAD) {
            return;
        }
        log.line("panic", &Backtrace::force_capture().to_string());
        previous(info);
        std::process::exit(101);
    }));
}

/// Whether this orb may upgrade the saved data: the installed orb (run from
/// `$CARGO_HOME/bin`, default `~/.cargo/bin`, or from `~/.local/bin`, where
/// install.sh puts it) may; a test build may only when started with
/// `--upgrade-data`.
fn upgrade_policy(home: &Path, args: &[OsString]) -> Upgrade {
    let cargo_bin = std::env::var_os("CARGO_HOME")
        .map_or_else(|| home.join(".cargo"), PathBuf::from)
        .join("bin");
    let exe = std::env::current_exe().ok();
    store::upgrade_policy(
        exe.as_deref(),
        &[cargo_bin, home.join(".local/bin")],
        args.iter().any(|arg| arg == "--upgrade-data"),
    )
}

/// Everything after the log opens: integrations, store, actors, frontend,
/// then the shutdown in order.
fn run(
    home: PathBuf,
    orb_root: PathBuf,
    args: &[OsString],
    log: &Log,
) -> Result<(), Report<OrbError>> {
    let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from);
    let claude_dir = integration::claude_dir(config_dir, &home);
    let integrations = integration_paths(&home, &orb_root, &claude_dir);
    if args.first().is_some_and(|arg| arg == "integration") {
        return install_integrations(args, &integrations, &home);
    }
    let pi_sessions = std::env::var_os("PI_CODING_AGENT_SESSION_DIR")
        .map_or_else(|| home.join(".pi/agent/sessions"), PathBuf::from);
    let env = child_env(std::env::vars_os());
    let tz = TimeZone::system();
    let notifier = desktop_notifier();
    let sounds = desktop_sounds(&orb_root, log);
    let sockets = socket_paths(&orb_root);
    let store_path = orb_root.join("userdata/state.sqlite");
    let store_lock = store::lock(&store_path).change_context(OrbError)?;
    let store =
        Store::open_live(&store_path, upgrade_policy(&home, args), log).change_context(OrbError)?;
    let search_index = orb_root.join("userdata/search.sqlite");
    let worktrees_root = orb_root.join("worktrees");
    let runtime = tokio::runtime::Runtime::new().change_context(OrbError)?;
    let context = runtime.enter();
    let state = State::new(AppState {
        home,
        ..AppState::default()
    });
    let frontend = Frontend::new(tz);
    quit_on_signals(frontend.quitter(), log);
    let services = services(&env, claude_dir, pi_sessions, &orb_root, log);
    let git = services.git.clone();
    let harnesses = services.harnesses.clone();
    let zmx = services.zmx.clone();
    let sessions = spawn_sessions_actor(SessionsActorDeps {
        services,
        state: state.clone(),
        store,
        worktrees_root: worktrees_root.clone(),
        orb_root,
        incognito_root: PathBuf::from("/tmp/orb-incognito"),
        report: frontend.reporter(),
        integration_missing: !integrations.any_installed(),
    });
    runtime.block_on(sessions.wait_for_startup());
    let worktrees = spawn_worktrees_actor(WorktreesActorDeps {
        git: git.clone(),
        state: state.clone(),
        worktrees_root: worktrees_root.clone(),
        report: frontend.reporter(),
        sweep_every: SWEEP_EVERY,
    });
    let search = spawn_search_actor(SearchActorDeps {
        state: state.clone(),
        harnesses: harnesses.clone(),
        index_path: search_index,
        report: frontend.reporter(),
        log: log.clone(),
    });
    let workers = (sessions.clone(), worktrees.clone(), search.clone());
    let browser_env = open_sockets(
        &sockets,
        ControlDeps {
            state: state.clone(),
            log: log.clone(),
            sessions: sessions.clone(),
            runtime: runtime.handle().clone(),
            panes: frontend.controller(),
            harnesses: harnesses.clone(),
        },
    );
    let ended = frontend
        .run(
            state,
            sessions,
            worktrees,
            worktrees_root,
            search,
            git,
            harnesses,
            [env, browser_env].concat(),
            zmx,
            notifier,
            sounds,
            log.clone(),
        )
        .change_context(OrbError);
    remove_sockets(&sockets, log);
    let stopped = runtime.block_on(tokio::time::timeout(QUIT_CAP, async {
        tokio::join!(
            stop_gracefully(&workers.0),
            stop_gracefully(&workers.1),
            stop_gracefully(&workers.2)
        )
    }));
    if stopped.is_err() {
        log.line("quit", "workers still busy after 2 s");
    }
    drop(workers);
    drop(context);
    runtime.shutdown_timeout(RUNTIME_SHUTDOWN);
    drop(store_lock);
    ended
}

/// Where the agent control socket and terminal-browser's split socket go,
/// given orb's folder.
fn socket_paths(orb_root: &Path) -> [PathBuf; 2] {
    [socket_path(orb_root), browser_socket::socket_path(orb_root)]
}

/// Opens the agent control socket and terminal-browser's split socket; when
/// one can't open, orb runs without it and says so in the log. Returns the
/// pane env that points terminal-browser at its socket, empty when that one
/// didn't open, so terminal-browser never asks a socket nobody answers.
fn open_sockets(sockets: &[PathBuf; 2], deps: ControlDeps) -> Vec<(OsString, OsString)> {
    let [control, browser] = sockets;
    let log = deps.log.clone();
    let browser_env = match browser_socket::listen(browser, deps.clone()) {
        Ok(()) => vec![terminal_browser_socket_env(browser)],
        Err(report) => {
            log.error("couldn't open terminal-browser's split socket", &report);
            Vec::new()
        }
    };
    if let Err(report) = server::listen(control, deps) {
        log.error("couldn't open the agent control socket", &report);
    }
    browser_env
}

/// Removes both sockets once orb no longer answers them.
fn remove_sockets(sockets: &[PathBuf; 2], log: &Log) {
    for socket in sockets {
        server::remove_socket(socket, log);
    }
}

/// The outside services the actors use: git, the agent harnesses, zmx and the
/// log.
fn services(
    env: &[(OsString, OsString)],
    claude_dir: PathBuf,
    pi_sessions: PathBuf,
    orb_root: &Path,
    log: &Log,
) -> Services {
    let git = GitService::new(Arc::new(GitCli::new(env.to_vec())), log.clone());
    let claude = ClaudeCode::new(Arc::new(ClaudeSupervisor::new(env.to_vec())), claude_dir);
    let pi = Pi::new(pi_sessions);
    Services {
        harnesses: Harnesses::new(vec![Arc::new(claude), Arc::new(pi)]),
        git,
        zmx: ZmxService::new(
            Arc::new(ZmxCli::new(env.to_vec())),
            orb_root.join("zmx"),
            log.clone(),
        ),
        log: log.clone(),
    }
}

/// Quits orb, as `<C-g> q` does, on SIGTERM, SIGINT or SIGHUP. A signal orb
/// can't listen for is logged and keeps its default.
fn quit_on_signals<F>(quit: F, log: &Log)
where
    F: Fn() + Send + Sync + 'static,
{
    let mut streams: Vec<Signal> = [
        (SignalKind::terminate(), "SIGTERM"),
        (SignalKind::interrupt(), "SIGINT"),
        (SignalKind::hangup(), "SIGHUP"),
    ]
    .into_iter()
    .filter_map(|(kind, name)| {
        signal(kind)
            .inspect_err(|error| log.line("signal", &format!("can't listen for {name}: {error}")))
            .ok()
    })
    .collect();
    tokio::spawn(async move {
        std::future::poll_fn(|cx| {
            if streams
                .iter_mut()
                .any(|stream| stream.poll_recv(cx).is_ready())
            {
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        })
        .await;
        quit();
    });
}

/// Where orb's integrations live: under `orb_root`, `claude_dir`, and pi's
/// agent dir (`$PI_CODING_AGENT_DIR`, else under `home`).
fn integration_paths(home: &Path, orb_root: &Path, claude_dir: &Path) -> IntegrationPaths {
    IntegrationPaths {
        orb_root: orb_root.to_owned(),
        claude_dir: claude_dir.to_owned(),
        pi_dir: integration::pi_agent_dir(
            std::env::var_os("PI_CODING_AGENT_DIR").map(PathBuf::from),
            home,
        ),
    }
}

/// `orb integration install`: installs both integrations and prints what it
/// wrote.
fn install_integrations(
    args: &[OsString],
    paths: &IntegrationPaths,
    home: &Path,
) -> Result<(), Report<OrbError>> {
    if args.get(1).is_none_or(|arg| arg != "install") || args.len() > 2 {
        return Err(Report::new(OrbError).attach("usage: orb integration install"));
    }
    let lines = integration::install(paths, home).change_context(OrbError)?;
    let mut out = std::io::stdout().lock();
    for line in lines {
        writeln!(out, "{line}").change_context(OrbError)?;
    }
    Ok(())
}

/// Desktop notices, clicked back to orb's window (kitty on macOS, niri on
/// Linux).
fn desktop_notifier() -> NotifierService {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let kitty = {
        let kitten = std::env::var_os("KITTY_INSTALLATION_DIR")
            .filter(|_| cfg!(target_os = "macos"))
            .map(|dir| PathBuf::from(dir).join("../../MacOS/kitten"))
            .filter(|kitten| kitten.is_file())
            .or_else(|| on_path("kitten", &path));
        let socket = std::env::var("KITTY_LISTEN_ON").ok();
        let window = std::env::var("KITTY_WINDOW_ID")
            .ok()
            .and_then(|id| id.parse().ok());
        kitten.zip(socket).map(|(kitten, socket)| Kitty {
            kitten,
            socket,
            window,
        })
    };
    let niri = std::env::var_os("NIRI_SOCKET")
        .and_then(|_| on_path("niri", &path))
        .map(|niri| NiriTarget {
            niri,
            ancestors: own_ancestry(),
        });
    NotifierService::desktop(&path, ClickTarget { kitty, niri })
}

/// herdr's sounds, written into `~/.orb/sounds` and played by the OS's own
/// player; silent, after one log line, when they can't be written.
fn desktop_sounds(orb_root: &Path, log: &Log) -> SoundService {
    let path = std::env::var_os("PATH").unwrap_or_default();
    SoundService::desktop(&orb_root.join("sounds"), &path).unwrap_or_else(|report| {
        log.error("couldn't set up sounds", &report);
        SoundService::silent()
    })
}

/// orb's process and its parents, for finding the window it runs in; just
/// orb when `ps` can't say.
fn own_ancestry() -> Vec<u32> {
    let parents = {
        let mut command = std::process::Command::new("ps");
        command.args(["-A", "-o", "pid=,ppid="]);
        match run_within(command, Duration::from_secs(2)) {
            Ok(Finished::Exited(output)) => parse_parents(&String::from_utf8_lossy(&output.stdout)),
            _ => HashMap::new(),
        }
    };
    ancestry(std::process::id(), &parents)
}
