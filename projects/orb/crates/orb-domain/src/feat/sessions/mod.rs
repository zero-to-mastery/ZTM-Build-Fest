//! Sessions — the work orb shows in one list across projects.
//!
//! Each session in the sidebar is a directory with tabs of panes, where the
//! user runs shells and agents. This feature tracks which sessions exist,
//! the agents (agent conversations) running in their panes and what each is
//! doing, and which session is selected. The user can make a session in a
//! project's checkout or a worktree, or a Research, Learn or Incognito one;
//! move it to another workspace before its first agent turn; pin it to the
//! top, settle it onto the Settled shelf (which kills its panes), give it a
//! name of orb's own, or delete it. A search narrows the sidebar to the
//! sessions whose title matches what the user types, and ends with the
//! cursor on the match or back where it was.

pub mod child_env;
pub(crate) mod intent;
pub mod pane_status;
pub mod sessions_actor;
pub mod state;
pub mod store;
pub mod template;
#[cfg(test)]
pub(crate) mod test_ids;
pub mod transcript;
pub mod validator;
