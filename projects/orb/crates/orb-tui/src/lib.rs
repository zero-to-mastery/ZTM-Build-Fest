//! The ratatui frontend: reads input, maps keys to intents, drives the
//! terminal pane, and draws [`AppState`](orb_domain::AppState).

mod dashboard;
mod graphics;
mod keymap;
mod mode_line;
mod mouse;
mod outer_terminal;
mod picker;
mod rename;
mod render;
mod run;
mod search_picker;
mod session_picker;
mod sidebar;
mod tabs;
#[cfg(test)]
mod test_support;
mod toast;
mod which_key;
mod worktree_picker;

pub use orb_term::PANE_READER_THREAD;
pub use run::{Frontend, TuiRunError};
