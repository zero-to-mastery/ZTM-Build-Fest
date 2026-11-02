//! Control — lets an agent (or a script) running inside orb ask orb to do
//! things: list sessions, tabs, panes and agents, add and close panes, tabs and
//! sessions, type into panes and read them, and start, prompt and read other
//! agents.
//!
//! A running orb listens on a socket only the user can open. The `orb session`,
//! `orb tab`, `orb pane` and `orb agent` commands send it one request each and
//! print its JSON reply. `orb integration install` puts a skill in Claude's and
//! pi's folders that teaches agents these commands. A second socket answers
//! terminal-browser, so `terminal-browser open --split` opens an orb pane.

pub(crate) mod agent;
pub mod browser_socket;
pub mod change;
pub mod client;
pub mod pane_control;
pub mod protocol;
pub mod server;
pub(crate) mod target;
pub(crate) mod validator;
