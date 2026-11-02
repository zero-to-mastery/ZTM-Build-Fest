//! Worktrees — the git worktrees orb made under `~/.orb/worktrees/<repo>/`.
//!
//! This feature keeps the list of those worktrees with what git says about
//! each and how much disk it takes. It decides which ones a sweep removes: a
//! worktree nobody uses, or one whose users have all been settled for a week,
//! as long as it has no uncommitted changes. A sweep runs at start and every
//! hour after, and the user can delete a worktree by hand.

pub mod state;
pub mod worktrees_actor;
