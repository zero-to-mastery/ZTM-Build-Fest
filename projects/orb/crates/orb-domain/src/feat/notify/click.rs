//! Where a click on a notification takes the user: the kitty window orb runs
//! in, and on Linux the niri window showing it. On Linux orb runs the click's
//! steps itself.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Deserialize;

use crate::common::{Finished, run_within};

/// Where a click on a notification takes the user: what orb found at startup.
#[derive(Debug, Clone, Default)]
pub struct ClickTarget {
    /// orb's kitty; `None` without `kitten` or kitty's socket.
    pub kitty: Option<Kitty>,
    /// niri, the compositor orb's window is on; `None` without `NIRI_SOCKET` or `niri`.
    pub niri: Option<NiriTarget>,
}

/// The kitty orb runs in, driven by its remote control.
#[derive(Debug, Clone)]
pub struct Kitty {
    /// The `kitten` program.
    pub kitten: PathBuf,
    /// kitty's remote control socket, as `KITTY_LISTEN_ON` gives it.
    pub socket: String,
    /// orb's kitty window, `KITTY_WINDOW_ID`.
    pub window: Option<u64>,
}

/// The niri compositor, driven by `niri msg`.
#[derive(Debug, Clone)]
pub struct NiriTarget {
    /// The `niri` program.
    pub niri: PathBuf,
    /// orb's process and its parents, one of which owns orb's window.
    pub ancestors: Vec<u32>,
}

/// How long one click step may run before it's killed.
const CLICK_LIMIT: Duration = Duration::from_secs(2);

/// Runs a click step's program.
pub trait ClickRunner: Send + Sync {
    fn name(&self) -> &'static str;

    /// Runs `program` with `args`; its stdout if it exits 0, else `None`
    /// (it couldn't start, failed, or ran too long).
    fn run(&self, program: &Path, args: &[OsString]) -> Option<String>;
}

/// Runs click steps as child processes, each killed after [`CLICK_LIMIT`].
#[derive(Debug, Clone, Copy, Default)]
pub struct CommandClickRunner;

impl ClickRunner for CommandClickRunner {
    fn name(&self) -> &'static str {
        "command"
    }

    fn run(&self, program: &Path, args: &[OsString]) -> Option<String> {
        let command = {
            let mut command = Command::new(program);
            command.args(args);
            command
        };
        match run_within(command, CLICK_LIMIT) {
            Ok(Finished::Exited(output)) if output.status.success() => {
                Some(String::from_utf8_lossy(&output.stdout).into_owned())
            }
            _ => None,
        }
    }
}

/// Takes the user back to orb: raises orb's niri window. A step orb can't
/// do is skipped.
pub fn focus_orb(click: &ClickTarget, runner: &dyn ClickRunner) {
    if let Some(niri) = &click.niri {
        let window = runner
            .run(&niri.niri, &os_args(&["msg", "--json", "windows"]))
            .and_then(|json| niri_window(&json, &niri.ancestors));
        if let Some(id) = window {
            let id = id.to_string();
            runner.run(
                &niri.niri,
                &os_args(&["msg", "action", "focus-window", "--id", &id]),
            );
        }
    }
}

/// `words` as a program's arguments.
fn os_args(words: &[&str]) -> Vec<OsString> {
    words.iter().map(OsString::from).collect()
}

/// One niri window, as `niri msg --json windows` lists it.
#[derive(Deserialize)]
struct NiriWindow {
    id: u64,
    pid: Option<u32>,
}

/// The first niri window in `json` whose process is one of `ancestors`
/// (orb's terminal); `None` if there's none or `json` isn't niri's list.
// ponytail: a single-instance kitty shows every window under one pid, so the
// first wins; match kitty's window id too if that ever matters.
fn niri_window(json: &str, ancestors: &[u32]) -> Option<u64> {
    serde_json::from_str::<Vec<NiriWindow>>(json)
        .ok()?
        .into_iter()
        .find(|window| window.pid.is_some_and(|pid| ancestors.contains(&pid)))
        .map(|window| window.id)
}

/// The executable `program` in the first absolute directory of `path` (a
/// `PATH` value) that has one.
pub fn on_path(program: &str, path: &OsStr) -> Option<PathBuf> {
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(program))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, PoisonError};

    use super::{ClickRunner, ClickTarget, NiriTarget, focus_orb, niri_window};

    /// One program run: the program and its arguments.
    type Call = (PathBuf, Vec<String>);

    /// niri's window list: a browser, a window with no pid, and orb's kitty
    /// (pid 900).
    const WINDOWS: &str = r#"[
        {"id": 2, "title": "API Keys | Firefox", "app_id": "firefox", "pid": 300},
        {"id": 5, "title": null, "app_id": "mpv"},
        {"id": 6, "title": "orb ~", "app_id": "kitty", "pid": 900}
    ]"#;

    /// orb (pid 1200) under fish (1100) under kitty (900) under launchd.
    const ANCESTORS: [u32; 4] = [1200, 1100, 900, 1];

    /// A click runner that records every run and answers niri's window list
    /// with `windows`, everything else with empty output.
    struct FakeRunner {
        calls: Mutex<Vec<Call>>,
        windows: String,
    }

    impl FakeRunner {
        fn new(windows: &str) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                windows: windows.to_owned(),
            }
        }

        fn calls(&self) -> Vec<Call> {
            self.calls
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        }
    }

    impl ClickRunner for FakeRunner {
        fn name(&self) -> &'static str {
            "fake"
        }

        fn run(&self, program: &Path, args: &[OsString]) -> Option<String> {
            let args: Vec<String> = args
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            let lists_windows = args == ["msg", "--json", "windows"];
            self.calls
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push((program.to_owned(), args));
            Some(if lists_windows {
                self.windows.clone()
            } else {
                String::new()
            })
        }
    }

    fn click() -> ClickTarget {
        ClickTarget {
            kitty: None,
            niri: Some(NiriTarget {
                niri: PathBuf::from("/n/niri"),
                ancestors: ANCESTORS.to_vec(),
            }),
        }
    }

    fn call(args: &[&str]) -> Call {
        (
            PathBuf::from("/n/niri"),
            args.iter().map(|arg| (*arg).to_owned()).collect(),
        )
    }

    #[rstest::rstest]
    fn click_focuses_orbs_niri_window() {
        // Given orb under niri, with orb's kitty in niri's window list.
        let runner = FakeRunner::new(WINDOWS);

        // When the click takes the user back to orb.
        focus_orb(&click(), &runner);

        // Then niri lists its windows and raises orb's.
        assert_eq!(
            runner.calls(),
            vec![
                call(&["msg", "--json", "windows"]),
                call(&["msg", "action", "focus-window", "--id", "6"]),
            ],
            "the click's steps, in order"
        );
    }

    #[rstest::rstest]
    fn niri_window_is_the_one_holding_orb() {
        // Given niri's window list with orb's kitty last.
        // When looking for the window whose process is one of orb's ancestors.
        let window = niri_window(WINDOWS, &ANCESTORS);

        // Then it's orb's kitty window.
        assert_eq!(window, Some(6), "the window orb runs in");
    }

    #[rstest::rstest]
    fn niri_window_is_none_without_orbs_process() {
        // Given niri's window list where no window belongs to orb's processes.
        // When looking for orb's window.
        let window = niri_window(WINDOWS, &[1200, 1100, 1]);

        // Then there is none.
        assert_eq!(window, None, "no window holds orb");
    }

    #[rstest::rstest]
    fn click_without_niri_runs_nothing() {
        // Given orb outside niri.
        let runner = FakeRunner::new(WINDOWS);

        // When the click takes the user back to orb.
        focus_orb(&ClickTarget::default(), &runner);

        // Then no step runs.
        assert!(runner.calls().is_empty(), "nothing to raise without niri");
    }
}
