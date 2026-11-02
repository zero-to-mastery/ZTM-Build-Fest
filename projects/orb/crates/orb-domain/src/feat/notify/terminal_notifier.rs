//! `terminal-notifier` as orb's [`Notifier`], whose notifications take the
//! user back to orb when clicked.
//!
//! A click makes macOS relaunch terminal-notifier, which runs the
//! notification's `-execute` line with `/bin/sh` and a bare `PATH`. So the
//! line names `kitten` by its full path: kitty focuses orb's window by its
//! id. Without kitty's socket or orb's window there is no `-execute`. Every
//! word of the line is quoted for `sh`, so no path can change what it runs.
//!
//! terminal-notifier reads its options through `NSUserDefaults`, which parses
//! a value starting with `(`, `{` or `"` as a property list and takes one
//! starting with `-` for the next option. terminal-notifier strips one leading
//! backslash from every value to allow for that, so orb prefixes every value
//! with one. A later notification about the same agent replaces the earlier
//! one. Like `osascript`, each one runs with no stdin, stdout or stderr, and a
//! thread of its own waits for it to exit. If it fails, for example because
//! it isn't allowed to notify, or is still running after 5 s, that thread
//! sends the same notification through a fallback notifier instead.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;

use error_stack::Report;

use super::click::ClickTarget;
use super::notifier::{Notifier, NotifyError, Urgency, spawn_detached};
use crate::ids::AgentId;

/// Shows notifications with `terminal-notifier`, whose click runs a command,
/// and through `fallback` when terminal-notifier exits unsuccessfully.
#[derive(Clone)]
pub struct TerminalNotifierNotifier {
    program: PathBuf,
    click: ClickTarget,
    fallback: Arc<dyn Notifier>,
}

impl TerminalNotifierNotifier {
    pub fn new(program: PathBuf, click: ClickTarget, fallback: Arc<dyn Notifier>) -> Self {
        Self {
            program,
            click,
            fallback,
        }
    }

    /// terminal-notifier's arguments to show `title` and `body` about
    /// `agent`, replacing an earlier one about it, whose click goes back to
    /// orb.
    fn args(&self, title: &str, body: &str, agent: AgentId) -> Vec<OsString> {
        let group = format!("orb-{}", agent.0);
        let execute = self.click_command();
        [
            ("-title", Some(title)),
            ("-message", Some(body)),
            ("-group", Some(group.as_str())),
            ("-execute", execute.as_deref()),
        ]
        .into_iter()
        .filter_map(|(option, value)| value.map(|value| [option.into(), format!("\\{value}")]))
        .flatten()
        .map(OsString::from)
        .collect()
    }

    /// The `sh` line a click runs: kitty focuses orb's window; `None` without
    /// kitty or orb's window.
    fn click_command(&self) -> Option<String> {
        let kitty = self.click.kitty.as_ref()?;
        let matching = format!("id:{}", kitty.window?);
        let kitten = kitty.kitten.to_string_lossy();
        Some(sh_words(&[
            &kitten,
            "@",
            "--to",
            &kitty.socket,
            "focus-window",
            "--match",
            &matching,
        ]))
    }
}

impl Notifier for TerminalNotifierNotifier {
    fn name(&self) -> &'static str {
        "terminal-notifier"
    }

    fn notify(
        &self,
        title: &str,
        body: &str,
        urgency: Urgency,
        agent: AgentId,
    ) -> Result<(), Report<NotifyError>> {
        let resend = {
            let fallback = Arc::clone(&self.fallback);
            let (title, body) = (title.to_owned(), body.to_owned());
            move || {
                let _ = fallback.notify(&title, &body, urgency, agent);
            }
        };
        spawn_detached(&self.program, self.args(title, body, agent), resend)
    }
}

/// `words` as one `sh` command, each single-quoted.
fn sh_words(words: &[&str]) -> String {
    words
        .iter()
        .map(|word| format!("'{}'", word.replace('\'', r"'\''")))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate setup failures with `?` and assert on the outcome"
)]
mod tests {
    use std::ffi::OsString;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::Arc;
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::time::Duration;

    use error_stack::{Report, ResultExt};
    use tempfile::TempDir;

    use super::TerminalNotifierNotifier;
    use crate::feat::notify::click::{ClickTarget, Kitty};
    use crate::feat::notify::notifier::{Notifier, NotifyError, Urgency};
    use crate::ids::AgentId;

    /// What a fallback notifier was asked to show: title, body and agent.
    type Resent = (String, String, AgentId);

    /// A fallback notifier that sends each notification it's asked to show
    /// down a channel.
    struct Fallback(Sender<Resent>);

    impl Notifier for Fallback {
        fn name(&self) -> &'static str {
            "fallback"
        }

        fn notify(
            &self,
            title: &str,
            body: &str,
            _urgency: Urgency,
            agent: AgentId,
        ) -> Result<(), Report<NotifyError>> {
            let _ = self.0.send((title.to_owned(), body.to_owned(), agent));
            Ok(())
        }
    }

    /// A fallback notifier, and what it gets asked to show.
    fn fallback() -> (Arc<Fallback>, Receiver<Resent>) {
        let (sender, resent) = mpsc::channel();
        (Arc::new(Fallback(sender)), resent)
    }

    /// Writes a `terminal-notifier` into `dir` that shows nothing and exits `code`.
    fn exiting(dir: &Path, code: i32) -> Result<PathBuf, Report<NotifyError>> {
        let path = dir.join("terminal-notifier");
        fs::write(&path, format!("#!/bin/sh\nexit {code}\n")).change_context(NotifyError)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
            .change_context(NotifyError)?;
        Ok(path)
    }

    fn kitty(window: Option<u64>) -> Kitty {
        Kitty {
            kitten: PathBuf::from("/k/kitten"),
            socket: "unix:/tmp/kitty-1".to_owned(),
            window,
        }
    }

    fn notifier(click: ClickTarget) -> TerminalNotifierNotifier {
        TerminalNotifierNotifier::new(PathBuf::from("/t/terminal-notifier"), click, fallback().0)
    }

    /// The `-execute` value in `args`, without its leading backslash.
    fn execute(args: &[OsString]) -> Option<String> {
        let at = args.iter().position(|arg| arg == "-execute")?;
        let value = args.get(at + 1)?.to_string_lossy();
        value.strip_prefix('\\').map(str::to_owned)
    }

    #[rstest::rstest]
    fn args_prefix_every_value_with_a_backslash() {
        // Given a notifier with nothing to go back to, and a title that looks like an option.
        let notifier = notifier(ClickTarget::default());

        // When building the arguments for agent 7.
        let args = notifier.args("-orb · (x) \"y\"", "Finished", AgentId(7));

        // Then title, body and the agent's group each carry one leading backslash.
        let expected: Vec<OsString> = [
            "-title",
            "\\-orb · (x) \"y\"",
            "-message",
            "\\Finished",
            "-group",
            "\\orb-7",
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        assert_eq!(args, expected, "terminal-notifier's arguments");
    }

    #[rstest::rstest]
    fn args_prefix_the_click_command_with_a_backslash() {
        // Given a notifier knowing orb's kitty window.
        let notifier = notifier(ClickTarget {
            kitty: Some(kitty(Some(9))),
            niri: None,
        });

        // When building the arguments.
        let args = notifier.args("orb · x", "Finished", AgentId(7));

        // Then the value after -execute starts with one backslash.
        let value = args
            .iter()
            .position(|arg| arg == "-execute")
            .and_then(|at| args.get(at + 1));
        assert!(
            value.is_some_and(|value| value.to_string_lossy().starts_with("\\'")),
            "the -execute value in {args:?}"
        );
    }

    #[rstest::rstest]
    fn kitty_window_is_focused_by_id() {
        // Given a notifier knowing orb's kitty window 9.
        let notifier = notifier(ClickTarget {
            kitty: Some(kitty(Some(9))),
            niri: None,
        });

        // When building the arguments.
        let args = notifier.args("orb · x", "Finished", AgentId(7));

        // Then -execute has kitty focus window 9.
        assert_eq!(
            execute(&args).as_deref(),
            Some("'/k/kitten' '@' '--to' 'unix:/tmp/kitty-1' 'focus-window' '--match' 'id:9'"),
            "the -execute line in {args:?}"
        );
    }

    #[rstest::rstest]
    #[case::kitty_without_a_window(Some(kitty(None)))]
    #[case::no_kitty(None)]
    fn click_command_is_left_out_without_orbs_kitty_window(#[case] kitty: Option<Kitty>) {
        // Given a notifier that can't name orb's kitty window.
        let notifier = notifier(ClickTarget { kitty, niri: None });

        // When building the arguments.
        let args = notifier.args("orb · x", "Finished", AgentId(7));

        // Then there is no -execute.
        assert_eq!(execute(&args), None, "no click command in {args:?}");
    }

    /// Writes an executable `name` into `dir` that appends its arguments, one
    /// per line, then `--`, to `log`.
    fn recorder(dir: &Path, name: &str, log: &Path) -> std::io::Result<PathBuf> {
        let path = dir.join(name);
        let script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" -- >> '{}'\n",
            log.display()
        );
        fs::write(&path, script)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
        Ok(path)
    }

    #[rstest::rstest]
    #[case::a_quote("unix:/tmp/kitty 'it's'")]
    #[case::a_substitution("unix:/tmp/$(touch pwned)`touch pwned`")]
    #[case::spaces_and_separators("unix:/tmp/two words; a|b && c")]
    fn click_command_hands_kitten_its_arguments_verbatim(
        #[case] socket: &str,
    ) -> std::io::Result<()> {
        // Given a recording kitten in a directory whose name needs quoting.
        let root = TempDir::new()?;
        let bin = root.path().join("it's $dir");
        fs::create_dir_all(&bin)?;
        let log = root.path().join("log");
        let click = ClickTarget {
            kitty: Some(Kitty {
                kitten: recorder(&bin, "kitten", &log)?,
                socket: socket.to_owned(),
                window: Some(9),
            }),
            niri: None,
        };
        let args = notifier(click).args("orb · x", "Finished", AgentId(7));

        // When sh runs the -execute line in the temporary directory.
        let line = execute(&args).unwrap_or_default();
        Command::new("/bin/sh")
            .args(["-c", &line])
            .current_dir(root.path())
            .status()?;

        // Then kitten got exactly its arguments, and nothing else ran.
        let recorded = fs::read_to_string(&log)?;
        let expected = ["@", "--to", socket, "focus-window", "--match", "id:9", "--"]
            .map(|line| format!("{line}\n"))
            .concat();
        let pwned = root.path().join("pwned").exists();
        assert_eq!(
            (recorded, pwned),
            (expected, false),
            "what kitten got for {socket:?}, and whether anything else ran"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[case::not_allowed_to_notify(3)]
    #[case::refused_by_the_notification_service(5)]
    fn failing_terminal_notifier_resends_the_notice_through_the_fallback(
        #[case] code: i32,
    ) -> Result<(), Report<NotifyError>> {
        // Given a terminal-notifier that exits `code`, and a fallback notifier.
        let dir = TempDir::new().change_context(NotifyError)?;
        let (fallback, resent) = fallback();
        let notifier = TerminalNotifierNotifier::new(
            exiting(dir.path(), code)?,
            ClickTarget::default(),
            fallback,
        );

        // When notifying that agent 7 finished.
        notifier.notify("orb · x", "Finished", Urgency::Normal, AgentId(7))?;

        // Then the fallback is asked to show the same notification.
        assert_eq!(
            resent.recv_timeout(Duration::from_secs(5)).ok(),
            Some(("orb · x".to_owned(), "Finished".to_owned(), AgentId(7))),
            "what the fallback showed after terminal-notifier exited {code}"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn succeeding_terminal_notifier_sends_nothing_through_the_fallback()
    -> Result<(), Report<NotifyError>> {
        // Given a terminal-notifier that exits 0, and a fallback notifier.
        let dir = TempDir::new().change_context(NotifyError)?;
        let (fallback, resent) = fallback();
        let notifier = TerminalNotifierNotifier::new(
            exiting(dir.path(), 0)?,
            ClickTarget::default(),
            fallback,
        );

        // When notifying that agent 7 finished.
        notifier.notify("orb · x", "Finished", Urgency::Normal, AgentId(7))?;

        // Then the fallback is asked to show nothing.
        assert!(
            resent.recv_timeout(Duration::from_secs(1)).is_err(),
            "the fallback should stay quiet when terminal-notifier succeeds"
        );
        Ok(())
    }
}
