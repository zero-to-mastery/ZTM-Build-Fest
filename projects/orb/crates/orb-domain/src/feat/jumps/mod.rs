//! Jump list — `<C-[>`/`<C-]>` back and forward through the sidebar rows
//! the user jumped between, as in neovim.
//!
//! A jump is entering a session's pane, `gg`/`G`, a search `⏎` that keeps a
//! match, or a `<C-g> n` pick; it records the row it leaves and the row it lands
//! on. The list keeps the newest 20 rows, each at most once, and skips rows
//! that are deleted or hidden by the project filter. Landing on a row moves
//! the cursor there and shows its pane only while orb is still attached to
//! it; it never attaches or clears the filter.

pub(crate) mod intent;
pub mod state;
pub mod validator;
