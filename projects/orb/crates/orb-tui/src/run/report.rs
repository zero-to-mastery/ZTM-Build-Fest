//! The loop's handling of the actors' reports: open a ready session, show
//! errors and notices in the message box, and announce status changes with a
//! sound and on the desktop.

use super::*;

/// A session a worker made ready to open, waiting in the loop until it can.
#[derive(Debug, Clone, Copy)]
pub(super) struct Ready {
    session: SessionId,
    /// The session that was active when the user asked.
    if_active: Option<SessionId>,
    /// It waited while the user typed in a picker, the rename box or the
    /// search.
    waited: bool,
}

/// What the loop does with a session a worker made ready to open.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum StartedAttach {
    /// The user opened another session meanwhile: drop it.
    Drop,
    /// The user is typing (a picker, the rename box, the search): keep the
    /// request until the keys are back.
    Wait,
    /// Attach now. `keep_keys` leaves the keys in the sidebar, for a request
    /// that waited and came back there.
    Attach { keep_keys: bool },
}

/// What to do with a ready session, asked for while `if_active` was the
/// active session, given the `active` session now, where the keys are, and
/// whether it has `waited` already. From the sidebar or a pane it opens at
/// once; in a pane it takes the keys into its own pane. Moving the cursor
/// around doesn't cancel it; opening another session does.
pub(super) fn started_attach(
    if_active: Option<SessionId>,
    active: Option<SessionId>,
    focus: Focus,
    waited: bool,
) -> StartedAttach {
    match focus {
        _ if if_active != active => StartedAttach::Drop,
        Focus::Picker | Focus::Rename | Focus::Search => StartedAttach::Wait,
        Focus::Pane => StartedAttach::Attach { keep_keys: false },
        Focus::Sidebar => StartedAttach::Attach { keep_keys: waited },
    }
}

/// Whether the projects or worlds screen is open, or under the open picker.
fn projects_open(state: &AppState) -> bool {
    state.picker.as_ref().is_some_and(|picker| {
        [Some(picker), picker.under()]
            .into_iter()
            .flatten()
            .any(|shown| {
                matches!(
                    shown.kind(),
                    PickerKind::ManageProjects | PickerKind::ManageWorlds
                )
            })
    })
}

/// Shows a worker's `outcome` in `state` and the message box at `now`: an
/// error or notice pops, a success hides the error, changed worktrees
/// re-list an open worktree picker, and search rows and previews fill the
/// search picker unless they're stale (see [`PickerState::show_hits`] and
/// [`PickerState::show_search_preview`]). Then an open projects screen
/// re-lists, so it keeps its recency order as sessions get busier.
///
/// [`PickerState::show_hits`]: orb_domain::feat::picker::state::PickerState::show_hits
/// [`PickerState::show_search_preview`]: orb_domain::feat::picker::state::PickerState::show_search_preview
pub(super) fn show(outcome: Outcome, state: &mut AppState, toasts: &mut Toasts, now: Instant) {
    match outcome {
        Outcome::Changed
        | Outcome::Ready { .. }
        | Outcome::Announce(_)
        | Outcome::ProjectsChanged => {}
        Outcome::Failed(error) => toasts.error(error, now),
        Outcome::Recovered => toasts.recovered(),
        Outcome::Notice(text) => toasts.notice(text, now),
        Outcome::WorktreesChanged => {
            let items = worktree_items(state);
            if let Some(picker) = &mut state.picker {
                picker.show_worktrees(items);
            }
        }
        Outcome::Hits {
            query,
            items,
            overflow,
        } => {
            if let Some(picker) = &mut state.picker {
                picker.show_hits(&query, items, overflow);
            }
        }
        Outcome::HitPreview { hit, messages } => {
            if let Some(picker) = &mut state.picker {
                picker.show_search_preview(hit, messages);
            }
        }
    }
    if projects_open(state) {
        IntentHandler::relist_projects(state);
    }
}

impl App {
    /// Applies a worker's `outcome`: a ready session waits to open (see
    /// [`Self::open_ready`]), a status change is announced, and every
    /// outcome shows on the screen (see [`show`]).
    pub(super) fn apply(&mut self, outcome: Outcome) {
        match &outcome {
            Outcome::Ready { session, if_active } => {
                self.ready = Some(Ready {
                    session: *session,
                    if_active: *if_active,
                    waited: false,
                });
            }
            Outcome::Announce(notice) => self.announce(notice.clone()),
            _ => {}
        }
        show(
            outcome,
            &mut self.state.write(),
            &mut self.toasts,
            Instant::now(),
        );
    }

    /// Opens the ready session as [`started_attach`] decides: at once, or,
    /// if the user was typing when it came up, once the keys are back,
    /// leaving them in the sidebar with the pane drawn if they came back
    /// there (as a click on the sidebar does). One the user moved on from is
    /// dropped.
    pub(super) fn open_ready(&mut self) {
        let Some(ready) = self.ready.take() else {
            return;
        };
        let (commands, keep_keys) = {
            let mut state = self.state.write();
            let decision = started_attach(
                ready.if_active,
                state.sessions.active(),
                state.focus,
                ready.waited,
            );
            let keep_keys = match decision {
                StartedAttach::Drop => return,
                StartedAttach::Wait => {
                    self.ready = Some(Ready {
                        waited: true,
                        ..ready
                    });
                    return;
                }
                StartedAttach::Attach { keep_keys } => keep_keys,
            };
            let focus = state.focus;
            let commands = IntentHandler::open_ready(&mut state, ready.session);
            if keep_keys {
                state.focus = focus;
            }
            (commands, keep_keys)
        };
        for command in &commands {
            self.execute(command);
        }
        if keep_keys {
            // The pane loses the keys, as on a click on the sidebar.
            self.execute(&Command::Detach);
        }
    }

    /// Moves the refusal the last intents or the loop's own work left in
    /// the state into the message box.
    pub(super) fn take_error(&mut self) {
        if self.state.read().sessions.error.is_none() {
            return;
        }
        if let Some(error) = self.state.write().sessions.error.take() {
            self.toasts.error(error, Instant::now());
        }
    }

    /// Plays `notice`'s sound on a thread of its own: a request always, a
    /// finished turn unless orb is focused and the agent's pane is on
    /// screen. Then, while orb's terminal isn't focused, sends `notice` on a
    /// thread of its own (the desktop's notification server can be slow to
    /// answer); while it is, the sidebar already shows it and it's dropped.
    /// A sound that can't play or a notice that can't be sent is logged and
    /// dropped.
    fn announce(&self, notice: Notice) {
        let looking = self.focused && self.state.read().agent_on_screen(notice.agent);
        if let Some(sound) = sound_for(notice.kind, looking) {
            let sounds = self.sounds.clone();
            let log = self.log.clone();
            if let Err(error) = thread::Builder::new()
                .name("orb-sound".into())
                .spawn(move || {
                    if let Err(report) = sounds.play(sound) {
                        log.error("couldn't play a sound", &report);
                    }
                })
            {
                self.log.error("couldn't start the sound thread", &error);
            }
        }
        if self.focused {
            return;
        }
        let notifier = self.notifier.clone();
        let log = self.log.clone();
        if let Err(error) = thread::Builder::new()
            .name("orb-notice".into())
            .spawn(move || {
                if let Err(report) = notifier.announce(&notice) {
                    log.error("couldn't send a desktop notification", &report);
                }
            })
        {
            self.log
                .error("couldn't start the desktop notification thread", &error);
        }
    }
}
