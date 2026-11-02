//! `osascript` as orb's [`Notifier`].
//!
//! Each notification runs one `osascript` whose script reads the title and
//! body from its arguments, so no agent title can change what the script
//! does. It runs with no stdin, stdout or stderr, so it never writes into
//! orb's screen, and a thread of its own waits for it to exit.

use std::ffi::OsString;

use error_stack::Report;

use super::notifier::{Notifier, NotifyError, Urgency, spawn_detached};
use crate::ids::AgentId;

/// Shows notifications with `osascript … display notification`, which macOS
/// attributes to Script Editor: a click opens Script Editor, and a later
/// notification replaces none.
#[derive(Debug, Clone, Copy, Default)]
pub struct OsascriptNotifier;

impl Notifier for OsascriptNotifier {
    fn name(&self) -> &'static str {
        "osascript"
    }

    fn notify(
        &self,
        title: &str,
        body: &str,
        _urgency: Urgency,
        _agent: AgentId,
    ) -> Result<(), Report<NotifyError>> {
        spawn_detached("osascript", osascript_args(title, body), || {})
    }
}

/// `osascript`'s arguments to show `title` and `body`: a script that reads
/// them from `argv`, then `--`, so a title starting with `-` isn't taken for
/// an option, then the two texts.
pub fn osascript_args(title: &str, body: &str) -> Vec<OsString> {
    [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        "--",
        title,
        body,
    ]
    .into_iter()
    .map(OsString::from)
    .collect()
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::osascript_args;

    #[rstest::rstest]
    fn osascript_args_pass_the_text_as_arguments_after_the_script() {
        // Given a title that would break out of an AppleScript string.
        let title = r#"-orb · "x" & (do shell script "rm -rf ~") & ""#;

        // When building osascript's arguments.
        let args = osascript_args(title, "Finished");

        // Then the script is fixed, and the title and body come last, after `--`.
        let expected: Vec<OsString> = [
            "-e",
            "on run argv",
            "-e",
            "display notification (item 2 of argv) with title (item 1 of argv)",
            "-e",
            "end run",
            "--",
            title,
            "Finished",
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        assert_eq!(args, expected, "osascript's arguments");
    }
}
