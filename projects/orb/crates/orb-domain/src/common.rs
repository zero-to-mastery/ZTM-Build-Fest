//! Plumbing shared by every feature: the lock-protected [`State`] the
//! frontend and actors hold, the [`Reporter`] that tells the frontend loop
//! what workers did, the [`Services`] actors use, [`tilde`] for showing a path,
//! [`run_within`] and [`wait_within`] for a child process that mustn't hang
//! orb, [`ancestry`] for walking a process's parents, and the [`TextInput`]
//! behind every line the user types into, the [`Log`] that records failures,
//! kills and removals, what orb logs when it crashes, and [`stop_gracefully`]
//! for stopping a worker when orb quits.

mod child;
mod crash;
mod log;
mod paths;
mod process;
mod services;
mod shutdown;
mod state;
mod text_input;

pub use child::{Finished, run_within, wait_within};
pub use crash::{ends_orb, panic_text};
pub use log::Log;
pub use paths::tilde;
pub use process::{ancestry, parse_parents};
pub use services::Services;
pub use shutdown::stop_gracefully;
pub use state::{Outcome, Reporter, State};
pub use text_input::TextInput;
