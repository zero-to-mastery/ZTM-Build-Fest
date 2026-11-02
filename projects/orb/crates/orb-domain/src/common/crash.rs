//! What orb writes when it crashes, and whether a crash ends orb. A crash
//! ends orb, except one while showing a pane's output: orb then stops
//! showing only that pane.

use std::panic::{Location, PanicHookInfo};
use std::thread;

/// One log line for a crash: the thread, the place in the code, the message.
fn panic_line(thread: Option<&str>, location: Option<&Location<'_>>, message: &str) -> String {
    let thread = thread.unwrap_or("<unnamed>");
    match location {
        Some(at) => format!("thread '{thread}' panicked at {at}: {message}"),
        None => format!("thread '{thread}' panicked: {message}"),
    }
}

/// Whether a crash on `thread` ends orb: always, except on the pane reader
/// (`pane_reader`), whose own handler stops showing that one pane.
#[must_use]
pub fn ends_orb(thread: Option<&str>, pane_reader: &str) -> bool {
    thread != Some(pane_reader)
}

/// [`panic_line`] for the crash `info` describes, on the current thread.
#[must_use]
pub fn panic_text(info: &PanicHookInfo<'_>) -> String {
    let message = info
        .payload()
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
        .unwrap_or("panic");
    panic_line(thread::current().name(), info.location(), message)
}

#[cfg(test)]
mod tests {
    use std::panic::Location;

    use super::{ends_orb, panic_line};

    #[rstest::rstest]
    fn panic_line_names_thread_place_and_message() {
        // Given a place in the code.
        let here = Location::caller();

        // When writing the line for a crash there on the pane reader.
        let line = panic_line(Some("orb-pane-reader"), Some(here), "boom");

        // Then it names the thread, the place and the message.
        assert_eq!(
            line,
            format!("thread 'orb-pane-reader' panicked at {here}: boom"),
            "crash line should name thread, place and message"
        );
    }

    #[rstest::rstest]
    #[case(Some("orb-pane-reader"), false)]
    #[case(Some("main"), true)]
    #[case(Some("tokio-runtime-worker"), true)]
    #[case(None, true)]
    fn crash_ends_orb_unless_in_a_pane_reader(#[case] thread: Option<&str>, #[case] ends: bool) {
        // Given a crash on `thread`.
        // When asking whether it ends orb.
        let result = ends_orb(thread, "orb-pane-reader");

        // Then only the pane reader keeps orb running.
        assert_eq!(result, ends, "crash on {thread:?} ends orb");
    }
}
