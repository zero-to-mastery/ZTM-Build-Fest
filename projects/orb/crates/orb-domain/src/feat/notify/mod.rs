//! Notify — tells the user, with a desktop notification, that an agent needs
//! them while orb's terminal isn't focused.
//!
//! A notification's title names the agent's project and the agent, and its
//! body says why: the turn finished, or the session needs an approval or an answer.
//!
//! On macOS it goes to Notification Center through `terminal-notifier` when orb
//! finds it at startup: clicking it brings orb's kitty window forward, and a
//! later notification about the same agent replaces it. Otherwise, or when terminal-notifier fails (for example because
//! it isn't allowed to notify), it goes out through `osascript`, whose click
//! opens Script Editor. Either way its text is passed as arguments, never as code.
//!
//! On Linux it goes to the desktop's notification server. An approval or an
//! answer is critical, a finished turn normal, and a later notification about
//! the same agent replaces it. Clicking the latest one brings orb's window
//! forward on niri. With no notification server, nothing is shown.
//!
//! On any other OS, nothing is shown.
//!
//! Alongside the notification, orb plays herdr's sounds, whether or not its
//! terminal is focused: "request" each time an agent starts needing an
//! approval or an answer, and "done" when a turn finishes, unless the user is
//! looking at that agent (orb focused and its pane on screen). A sound that
//! can't play is skipped.

pub mod click;
pub mod none;
pub mod notifier;
pub mod osascript;
pub mod sound;
pub mod terminal_notifier;
pub mod xdg;
