//! Tabs and splits: each attached session's tabs, each tab's panes laid out
//! as a tree of right and down splits, which pane has the keys, and whether
//! a tab is zoomed onto it, and each session's floating panes over its tabs.

pub mod floats;
pub(crate) mod intent;
pub mod state;
pub mod tree;
pub mod validator;
