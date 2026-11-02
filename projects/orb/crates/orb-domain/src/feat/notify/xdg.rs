//! Freedesktop notifications — how orb notifies on Linux, through the
//! desktop's notification server on the session bus.
//!
//! Each agent has at most one notification on screen: a newer one about the
//! same agent replaces the older instead of stacking. Clicking a
//! notification takes the user back to orb, but only the latest one about its
//! agent does; a click on one that has since been replaced does nothing.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use error_stack::Report;

use super::click::{ClickRunner, ClickTarget, focus_orb};
use super::notifier::{Notifier, NotifyError, Urgency};
use crate::ids::AgentId;

/// One notification as the desktop is asked to show it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XdgNotification {
    /// The notification's title.
    pub summary: String,
    /// The notification's text.
    pub body: String,
    /// How insistently it asks for attention.
    pub urgency: Urgency,
    /// The id of the notification this one replaces.
    pub replaces: Option<u32>,
}

/// A freedesktop notification server.
pub trait Desktop: Send + Sync {
    fn name(&self) -> &'static str;

    /// Shows `notification` and returns its id. Calls `on_click`, from a
    /// thread of its own and at most once, if the user invokes its `default`
    /// action; never if it's closed without it.
    ///
    /// # Errors
    ///
    /// Returns an error if the notification couldn't be sent.
    fn show(
        &self,
        notification: &XdgNotification,
        on_click: Box<dyn FnOnce() + Send>,
    ) -> Result<u32, Report<NotifyError>>;
}

/// The latest notification shown about an agent.
#[derive(Debug, Clone, Copy)]
struct Shown {
    /// Its id on the notification server.
    id: u32,
    /// Which notify call showed it.
    generation: u64,
}

/// What orb has shown: each agent's latest notification, and the last
/// generation handed out.
#[derive(Debug, Default)]
struct Ledger {
    next: u64,
    agents: HashMap<AgentId, Shown>,
}

/// Shows notifications on a freedesktop notification server: one per
/// agent, a newer one replacing the older, whose click takes the user back
/// to orb.
#[derive(Clone)]
pub struct XdgNotifier {
    desktop: Arc<dyn Desktop>,
    click: Arc<ClickTarget>,
    runner: Arc<dyn ClickRunner>,
    shown: Arc<Mutex<Ledger>>,
}

impl XdgNotifier {
    /// A notifier showing on `desktop`, whose click goes to `click` and runs
    /// its steps through `runner`.
    pub fn new(
        desktop: Arc<dyn Desktop>,
        click: ClickTarget,
        runner: Arc<dyn ClickRunner>,
    ) -> Self {
        Self {
            desktop,
            click: Arc::new(click),
            runner,
            shown: Arc::new(Mutex::new(Ledger::default())),
        }
    }
}

impl Notifier for XdgNotifier {
    fn name(&self) -> &'static str {
        "xdg"
    }

    fn notify(
        &self,
        title: &str,
        body: &str,
        urgency: Urgency,
        agent: AgentId,
    ) -> Result<(), Report<NotifyError>> {
        let (replaces, generation) = {
            let mut ledger = self.shown.lock().unwrap_or_else(PoisonError::into_inner);
            ledger.next += 1;
            (ledger.agents.get(&agent).map(|shown| shown.id), ledger.next)
        };
        let on_click: Box<dyn FnOnce() + Send> = {
            let shown = Arc::clone(&self.shown);
            let click = Arc::clone(&self.click);
            let runner = Arc::clone(&self.runner);
            Box::new(move || {
                let latest = shown
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .agents
                    .get(&agent)
                    .is_some_and(|shown| shown.generation == generation);
                if latest {
                    focus_orb(&click, runner.as_ref());
                }
            })
        };
        let notification = XdgNotification {
            summary: title.to_owned(),
            body: body.to_owned(),
            urgency,
            replaces,
        };
        let id = self.desktop.show(&notification, on_click)?;
        self.shown
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .agents
            .insert(agent, Shown { id, generation });
        Ok(())
    }
}

/// The session bus's notification server, through notify-rust.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, Default)]
pub struct ZbusDesktop;

#[cfg(target_os = "linux")]
impl Desktop for ZbusDesktop {
    fn name(&self) -> &'static str {
        "zbus"
    }

    fn show(
        &self,
        notification: &XdgNotification,
        on_click: Box<dyn FnOnce() + Send>,
    ) -> Result<u32, Report<NotifyError>> {
        use error_stack::ResultExt;

        let handle = {
            let mut sent = notify_rust::Notification::new();
            sent.appname("orb")
                .summary(&notification.summary)
                .body(&notification.body)
                .urgency(match notification.urgency {
                    Urgency::Normal => notify_rust::Urgency::Normal,
                    Urgency::Critical => notify_rust::Urgency::Critical,
                })
                .action("default", "Open");
            if let Some(id) = notification.replaces {
                sent.id(id);
            }
            sent.show()
                .change_context(NotifyError)
                .attach("couldn't reach the notification server")?
        };
        let id = handle.id();
        std::thread::Builder::new()
            .name("orb-notify".into())
            .spawn(move || {
                handle.wait_for_action(|action| {
                    if action == "default" {
                        on_click();
                    }
                });
            })
            .change_context(NotifyError)
            .attach("couldn't wait for the notification's click")?;
        Ok(id)
    }
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate failures with `?` and assert on the outcome"
)]
mod tests {
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex, PoisonError};

    use error_stack::Report;

    use super::{Desktop, XdgNotification, XdgNotifier};
    use crate::feat::notify::click::{ClickRunner, ClickTarget, NiriTarget};
    use crate::feat::notify::notifier::{Notifier, NotifierService, NotifyError, Urgency};
    use crate::feat::sessions::state::{Notice, NoticeKind};
    use crate::ids::AgentId;

    /// One program run: the program and its arguments.
    type Call = (PathBuf, Vec<String>);

    /// A click callback the fake desktop keeps until the test clicks or
    /// dismisses its notification.
    type OnClick = Box<dyn FnOnce() + Send>;

    /// A notification server that records what it's asked to show, numbers
    /// notifications from 1, and keeps each one's click callback.
    #[derive(Default)]
    struct FakeDesktop {
        failing: bool,
        shown: Mutex<Vec<XdgNotification>>,
        clicks: Mutex<Vec<Option<OnClick>>>,
    }

    impl FakeDesktop {
        fn failing() -> Self {
            Self {
                failing: true,
                ..Self::default()
            }
        }

        fn shown(&self) -> Vec<XdgNotification> {
            self.shown
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        }

        fn take_click(&self, n: usize) -> Option<OnClick> {
            self.clicks
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get_mut(n)
                .and_then(Option::take)
        }

        /// The user clicks the `n`-th notification shown.
        fn click(&self, n: usize) {
            if let Some(on_click) = self.take_click(n) {
                on_click();
            }
        }

        /// The user dismisses the `n`-th notification shown.
        fn drop_click(&self, n: usize) {
            drop(self.take_click(n));
        }
    }

    impl Desktop for FakeDesktop {
        fn name(&self) -> &'static str {
            "fake"
        }

        fn show(
            &self,
            notification: &XdgNotification,
            on_click: OnClick,
        ) -> Result<u32, Report<NotifyError>> {
            if self.failing {
                return Err(Report::new(NotifyError));
            }
            let mut shown = self.shown.lock().unwrap_or_else(PoisonError::into_inner);
            shown.push(notification.clone());
            self.clicks
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(Some(on_click));
            Ok(u32::try_from(shown.len()).unwrap_or(u32::MAX))
        }
    }

    /// A click runner that records every run and answers each with niri's
    /// list of one window, 6, owned by process 900.
    #[derive(Default)]
    struct RecordingRunner {
        calls: Mutex<Vec<Call>>,
    }

    impl RecordingRunner {
        fn calls(&self) -> Vec<Call> {
            self.calls
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        }
    }

    impl ClickRunner for RecordingRunner {
        fn name(&self) -> &'static str {
            "recording"
        }

        fn run(&self, program: &Path, args: &[OsString]) -> Option<String> {
            let args = args
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            self.calls
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push((program.to_owned(), args));
            Some(r#"[{"id": 6, "pid": 900}]"#.to_owned())
        }
    }

    /// orb under niri, its terminal process 900.
    fn click_target() -> ClickTarget {
        ClickTarget {
            kitty: None,
            niri: Some(NiriTarget {
                niri: PathBuf::from("/n/niri"),
                ancestors: vec![1200, 900, 1],
            }),
        }
    }

    fn notifier(desktop: &Arc<FakeDesktop>, runner: &Arc<RecordingRunner>) -> XdgNotifier {
        XdgNotifier::new(desktop.clone(), click_target(), runner.clone())
    }

    fn notice(kind: NoticeKind) -> Notice {
        Notice {
            agent: AgentId(1),
            kind,
            project: "orb".to_owned(),
            title: "Parser fix".to_owned(),
        }
    }

    fn focus_window() -> Call {
        (
            PathBuf::from("/n/niri"),
            ["msg", "action", "focus-window", "--id", "6"]
                .map(str::to_owned)
                .to_vec(),
        )
    }

    #[rstest::rstest]
    fn xdg_notification_has_title_and_body() -> Result<(), Report<NotifyError>> {
        // Given an xdg notifier.
        let desktop = Arc::new(FakeDesktop::default());
        let runner = Arc::new(RecordingRunner::default());
        let service = NotifierService::new(Arc::new(notifier(&desktop, &runner)));

        // When announcing that orb's "Parser fix" agent finished.
        service.announce(&notice(NoticeKind::Finished))?;

        // Then the desktop shows one notification titled by project and
        // agent, saying the turn finished.
        let texts: Vec<(String, String)> = desktop
            .shown()
            .into_iter()
            .map(|shown| (shown.summary, shown.body))
            .collect();
        assert_eq!(
            texts,
            [("orb · Parser fix".to_owned(), "Finished".to_owned())],
            "the notification should carry the title and the body"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn second_notice_for_an_agent_replaces_the_first() -> Result<(), Report<NotifyError>> {
        // Given an xdg notifier that has shown a notification about agent 1.
        let desktop = Arc::new(FakeDesktop::default());
        let runner = Arc::new(RecordingRunner::default());
        let notifier = notifier(&desktop, &runner);
        notifier.notify("orb · x", "Finished", Urgency::Normal, AgentId(1))?;

        // When notifying about agent 1 again.
        notifier.notify("orb · x", "Needs input", Urgency::Critical, AgentId(1))?;

        // Then the second notification replaces the first.
        let replaces = desktop.shown().get(1).and_then(|shown| shown.replaces);
        assert_eq!(replaces, Some(1), "the second should replace the first");
        Ok(())
    }

    #[rstest::rstest]
    fn notices_for_different_agents_dont_replace() -> Result<(), Report<NotifyError>> {
        // Given an xdg notifier that has shown a notification about agent 1.
        let desktop = Arc::new(FakeDesktop::default());
        let runner = Arc::new(RecordingRunner::default());
        let notifier = notifier(&desktop, &runner);
        notifier.notify("orb · x", "Finished", Urgency::Normal, AgentId(1))?;

        // When notifying about agent 2.
        notifier.notify("orb · y", "Finished", Urgency::Normal, AgentId(2))?;

        // Then the second notification replaces nothing.
        let shown = desktop.shown();
        assert!(
            shown.get(1).is_some_and(|shown| shown.replaces.is_none()),
            "a notification about another agent shouldn't replace: {shown:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn click_on_latest_notification_focuses_orb() -> Result<(), Report<NotifyError>> {
        // Given an xdg notifier that has shown a notification about agent 1.
        let desktop = Arc::new(FakeDesktop::default());
        let runner = Arc::new(RecordingRunner::default());
        notifier(&desktop, &runner).notify("orb · x", "Finished", Urgency::Normal, AgentId(1))?;

        // When the user clicks it.
        desktop.click(0);

        // Then orb's niri window is focused.
        assert!(
            runner.calls().contains(&focus_window()),
            "a click should focus orb's window: {:?}",
            runner.calls()
        );
        Ok(())
    }

    #[rstest::rstest]
    fn dismissed_notification_runs_no_click_steps() -> Result<(), Report<NotifyError>> {
        // Given an xdg notifier that has shown a notification about agent 1.
        let desktop = Arc::new(FakeDesktop::default());
        let runner = Arc::new(RecordingRunner::default());
        notifier(&desktop, &runner).notify("orb · x", "Finished", Urgency::Normal, AgentId(1))?;

        // When the user dismisses it.
        desktop.drop_click(0);

        // Then no click step runs.
        assert!(
            runner.calls().is_empty(),
            "a dismissed notification should run nothing"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn failed_send_is_quiet() {
        // Given an xdg notifier on a desktop that can't show notifications.
        let desktop = Arc::new(FakeDesktop::failing());
        let runner = Arc::new(RecordingRunner::default());

        // When notifying about agent 1.
        let result =
            notifier(&desktop, &runner).notify("orb · x", "Finished", Urgency::Normal, AgentId(1));

        // Then it reports the failure and runs no click step.
        assert!(
            result.is_err() && runner.calls().is_empty(),
            "a failed send should only report the failure"
        );
    }

    #[rstest::rstest]
    fn replaced_notifications_click_runs_no_steps() -> Result<(), Report<NotifyError>> {
        // Given an xdg notifier whose first notification about agent 1 was
        // replaced by a second.
        let desktop = Arc::new(FakeDesktop::default());
        let runner = Arc::new(RecordingRunner::default());
        let notifier = notifier(&desktop, &runner);
        notifier.notify("orb · x", "Finished", Urgency::Normal, AgentId(1))?;
        notifier.notify("orb · x", "Needs input", Urgency::Critical, AgentId(1))?;

        // When the first notification's click arrives.
        desktop.click(0);

        // Then no click step runs.
        assert!(
            runner.calls().is_empty(),
            "a replaced notification's click should run nothing"
        );
        Ok(())
    }
}
