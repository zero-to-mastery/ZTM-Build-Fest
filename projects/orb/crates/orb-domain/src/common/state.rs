//! Shared application state: the frontend and the actors each hold a clone,
//! and the [`Reporter`] through which the actors tell the frontend loop what
//! they did.
//!
//! Readers always see a consistent snapshot. Each field has at most one actor
//! that writes it; the intent handler may write any field.

use std::sync::{Arc, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

use crate::AppState;
use crate::feat::picker::list::PickerItem;
use crate::feat::sessions::state::Notice;
use crate::feat::sessions::transcript::Role;
use crate::ids::SessionId;

/// Shared, lock-protected [`AppState`]. Cloning shares the same state.
#[derive(Debug, Clone, Default)]
pub struct State {
    inner: Arc<RwLock<AppState>>,
}

impl State {
    /// Share `data` behind a new lock.
    pub fn new(data: AppState) -> Self {
        Self {
            inner: Arc::new(RwLock::new(data)),
        }
    }

    /// Read the state. A writer that panicked doesn't lock readers out.
    pub fn read(&self) -> RwLockReadGuard<'_, AppState> {
        self.inner.read().unwrap_or_else(PoisonError::into_inner)
    }

    /// Change the state. A writer that panicked doesn't lock later writers out.
    pub fn write(&self) -> RwLockWriteGuard<'_, AppState> {
        self.inner.write().unwrap_or_else(PoisonError::into_inner)
    }
}

/// What a worker tells the frontend loop. Durable facts (sessions, statuses,
/// layouts, worktrees) stay in [`AppState`], written by their owner; an
/// outcome says what changed or what the screen should do about it, and the
/// loop applies each one in one place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The worker changed its own part of the state; the next frame shows it.
    Changed,
    /// Session `session` is ready to open: a new session, or one restored,
    /// moved or switched to another branch. It opens while the active session
    /// is still `if_active`, the one active when the user asked.
    Ready {
        session: SessionId,
        if_active: Option<SessionId>,
    },
    /// Projects were added or removed; an open projects screen re-lists.
    ProjectsChanged,
    /// orb's worktrees were listed again; an open worktree picker re-lists.
    WorktreesChanged,
    /// Something failed; the message box shows why. The same error again
    /// doesn't pop until a key or a success (see the loop's message box).
    Failed(String),
    /// A later success: the error the message box shows goes.
    Recovered,
    /// A note for the message box, like a project just added.
    Notice(String),
    /// A status change to announce while orb's terminal isn't focused.
    Announce(Notice),
    /// The rows the search `query` found; dropped unless the search picker
    /// still has `query` typed.
    Hits {
        query: String,
        items: Vec<PickerItem>,
        overflow: bool,
    },
    /// The exchange of search hit `hit`; dropped unless `hit` is still the
    /// selected row.
    HitPreview {
        hit: i64,
        messages: Vec<(i64, Role, String)>,
    },
}

/// Sends a worker's [`Outcome`]s to the frontend loop. Cloning shares the
/// same destination. Never call it while holding the state's lock.
#[derive(Clone)]
pub struct Reporter {
    send: Arc<dyn Fn(Outcome) + Send + Sync>,
    #[cfg(test)]
    log: Arc<std::sync::Mutex<Vec<Outcome>>>,
}

impl Reporter {
    /// A reporter that hands each outcome to `send`.
    pub fn new<F>(send: F) -> Self
    where
        F: Fn(Outcome) + Send + Sync + 'static,
    {
        Self {
            send: Arc::new(send),
            #[cfg(test)]
            log: Arc::default(),
        }
    }

    /// Tells the loop `outcome`.
    pub fn report(&self, outcome: Outcome) {
        #[cfg(test)]
        self.log
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(outcome.clone());
        (self.send)(outcome);
    }

    /// Tells the loop the state changed.
    pub fn changed(&self) {
        self.report(Outcome::Changed);
    }

    /// Tells the loop `error`, or that the last error is resolved.
    pub fn error(&self, error: Option<String>) {
        self.report(error.map_or(Outcome::Recovered, Outcome::Failed));
    }

    /// Every outcome reported so far, oldest first.
    #[cfg(test)]
    pub(crate) fn outcomes(&self) -> Vec<Outcome> {
        self.log
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// The message box's error after the outcomes reported so far: the last
    /// failure, unless a success followed it.
    #[cfg(test)]
    pub(crate) fn shown_error(&self) -> Option<String> {
        self.outcomes()
            .into_iter()
            .filter_map(|outcome| match outcome {
                Outcome::Failed(error) => Some(Some(error)),
                Outcome::Recovered => Some(None),
                _ => None,
            })
            .next_back()
            .flatten()
    }
}
