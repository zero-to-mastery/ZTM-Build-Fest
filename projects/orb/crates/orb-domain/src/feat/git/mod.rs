//! Git — the repositories behind each project's agents.
//!
//! orb runs `git` to put an agent in its own worktree, to list and check out
//! branches, and to rename a worktree's branch once its agent has a title.

pub mod git_cli;
pub mod git_service;
pub(crate) mod intent;
pub mod validator;
pub mod worktree;
