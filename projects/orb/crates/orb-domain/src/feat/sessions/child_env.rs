//! The environment every process orb starts runs with: the terminal pane's
//! child and every harness command.
//!
//! The child inherits orb's environment minus two groups of variables: the ones
//! that would make it think it runs inside another agent's session, and the
//! ones that name the terminal orb itself runs in. In their place it gets one
//! fixed terminal identity, so the attached program picks the same
//! capabilities (kitty keys, synchronized output) no matter how orb was
//! launched.
//!
//! Each pane's program also gets `ORB_PANE_ID`, naming the pane it runs in;
//! one inherited from orb's own environment is dropped, so harness commands
//! and an orb started inside a pane never see a stale one. The zmx session
//! variables go too: with `ZMX_SESSION` set, `zmx attach` switches the
//! enclosing session's client and exits, so an orb started inside a pane
//! could never attach its own.
//!
//! While orb runs in kitty, pane programs also get terminal-browser's own
//! settings for its fast path: whole frames patched in place through shared
//! memory. They steer terminal-browser only.
//!
//! Each pane's program also gets `TERMINAL_BROWSER_TERMINAL_SOCKET`, naming
//! orb's socket for terminal-browser's splits, while that socket is open; one
//! inherited from orb's own environment is dropped.

use std::ffi::OsString;
use std::path::Path;

use crate::ids::PaneId;

/// The variable naming the pane a program runs in. orb sets it on each
/// pane's program, and drops one inherited from its own environment.
pub const ORB_PANE_ID: &str = "ORB_PANE_ID";

/// The variable naming the socket terminal-browser asks for its splits. orb
/// sets it on each pane's program while that socket is open, and drops one
/// inherited from its own environment, so a pane never asks another orb.
pub const TERMINAL_BROWSER_TERMINAL_SOCKET: &str = "TERMINAL_BROWSER_TERMINAL_SOCKET";

/// The terminal identity every child gets.
const IDENTITY: [(&str, &str); 4] = [
    ("TERM", "xterm-256color"),
    ("COLORTERM", "truecolor"),
    ("TERM_PROGRAM", "WezTerm"),
    ("CLAUDE_CODE_FORCE_SYNC_OUTPUT", "1"),
];

/// Variables an agent session sets for the processes it spawns.
const SESSION_VARS: [&str; 12] = [
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_PID",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SESSION_KIND",
    "CLAUDE_EFFORT",
    "CLAUDE_AGENT_SDK_VERSION",
];

/// Variables that identify the outer terminal or force its colours.
const TERMINAL_VARS: [&str; 11] = [
    "STY",
    "WINDOWID",
    "TERMINATOR_UUID",
    "TILIX_ID",
    "VTE_VERSION",
    "WT_SESSION",
    "TERMINAL_EMULATOR",
    "ZED_TERM",
    "COLORFGBG",
    "__CFBundleIdentifier",
    "FORCE_COLOR",
];

/// Prefixes of variables that identify the outer terminal or multiplexer.
const TERMINAL_PREFIXES: [&str; 11] = [
    "KITTY_",
    "ZELLIJ",
    "ZMX_SESSION",
    "TMUX",
    "TERM_PROGRAM",
    "LC_TERMINAL",
    "ITERM_",
    "WEZTERM_",
    "GHOSTTY_",
    "ALACRITTY_",
    "KONSOLE_",
];

/// The child's environment: `parent` without agent session and outer-terminal
/// variables, plus orb's terminal identity.
pub fn child_env<I>(parent: I) -> Vec<(OsString, OsString)>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    parent
        .into_iter()
        .filter(|(key, _)| !key.to_str().is_some_and(is_scrubbed))
        .chain(IDENTITY.map(|(key, value)| (key.into(), value.into())))
        .collect()
}

/// `env` plus `ORB_PANE_ID=<pane>`. zmx hands it to the program it starts
/// when it creates the pane's session; a reattach keeps the program's own.
pub fn pane_env(env: &[(OsString, OsString)], pane: PaneId) -> Vec<(OsString, OsString)> {
    env.iter()
        .cloned()
        .chain([(ORB_PANE_ID.into(), pane.0.to_string().into())])
        .collect()
}

/// The settings that put terminal-browser on its fast path (patched frames
/// through shared memory) while orb shows kitty images; none otherwise.
pub fn terminal_browser_env(kitty_images: bool) -> Vec<(OsString, OsString)> {
    if !kitty_images {
        return Vec::new();
    }
    [
        ("TERMINAL_BROWSER_PRESENT", "patched"),
        ("TERMINAL_BROWSER_FRAMES", "shared"),
    ]
    .map(|(key, value)| (key.into(), value.into()))
    .into()
}

/// The setting that sends terminal-browser's splits to orb's socket at
/// `socket`.
pub fn terminal_browser_socket_env(socket: &Path) -> (OsString, OsString) {
    (TERMINAL_BROWSER_TERMINAL_SOCKET.into(), socket.into())
}

fn is_scrubbed(key: &str) -> bool {
    key == ORB_PANE_ID
        || key == TERMINAL_BROWSER_TERMINAL_SOCKET
        || SESSION_VARS.contains(&key)
        || TERMINAL_VARS.contains(&key)
        || IDENTITY.iter().any(|(name, _)| *name == key)
        || TERMINAL_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::Path;

    use super::{
        ORB_PANE_ID, TERMINAL_BROWSER_TERMINAL_SOCKET, child_env, pane_env, terminal_browser_env,
        terminal_browser_socket_env,
    };
    use crate::ids::PaneId;

    fn env_of(vars: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        child_env(
            vars.iter()
                .map(|(key, value)| (OsString::from(key), OsString::from(value))),
        )
    }

    fn values_of<'a>(env: &'a [(OsString, OsString)], key: &str) -> Vec<&'a OsString> {
        env.iter()
            .filter(|(name, _)| name == key)
            .map(|(_, value)| value)
            .collect()
    }

    #[rstest::rstest]
    #[case("CLAUDECODE")]
    #[case("CLAUDE_CODE_CHILD_SESSION")]
    #[case("CLAUDE_CODE_SESSION_ID")]
    #[case("CLAUDE_CODE_MESSAGING_SOCKET")]
    #[case("CLAUDE_CODE_MESSAGING_TOKEN")]
    #[case("CLAUDE_CODE_ENTRYPOINT")]
    #[case("CLAUDE_PID")]
    #[case("CLAUDE_CODE_EXECPATH")]
    #[case("CLAUDE_CODE_SESSION_ATTENDED")]
    #[case("CLAUDE_CODE_SESSION_KIND")]
    #[case("CLAUDE_EFFORT")]
    #[case("CLAUDE_AGENT_SDK_VERSION")]
    fn claude_session_variables_are_removed(#[case] key: &str) {
        // Given orb runs inside a Claude session.
        let parent = [(key, "1")];

        // When building the child's environment.
        let env = env_of(&parent);

        // Then the session variable is gone.
        assert!(values_of(&env, key).is_empty(), "{key} should be removed");
    }

    #[rstest::rstest]
    #[case("KITTY_WINDOW_ID")]
    #[case("KITTY_PID")]
    #[case("ZELLIJ")]
    #[case("ZELLIJ_SESSION_NAME")]
    #[case("TMUX")]
    #[case("TERM_PROGRAM_VERSION")]
    #[case("LC_TERMINAL")]
    #[case("ITERM_SESSION_ID")]
    #[case("WT_SESSION")]
    #[case("VTE_VERSION")]
    #[case("__CFBundleIdentifier")]
    #[case("FORCE_COLOR")]
    fn outer_terminal_identity_is_removed(#[case] key: &str) {
        // Given orb runs in a terminal that identifies itself.
        let parent = [(key, "1")];

        // When building the child's environment.
        let env = env_of(&parent);

        // Then the identity variable is gone.
        assert!(values_of(&env, key).is_empty(), "{key} should be removed");
    }

    #[rstest::rstest]
    #[case("ZMX_SESSION")]
    #[case("ZMX_SESSION_PREFIX")]
    fn enclosing_zmx_session_is_removed(#[case] key: &str) {
        // Given orb runs inside another orb's pane, a zmx session.
        let parent = [(key, "orb-p470")];

        // When building the child's environment.
        let env = env_of(&parent);

        // Then the zmx session variable is gone, so a pane's `zmx attach`
        // attaches instead of switching the enclosing client.
        assert!(values_of(&env, key).is_empty(), "{key} should be removed");
    }

    #[rstest::rstest]
    #[case("PATH", "/usr/bin:/bin")]
    #[case("HOME", "/Users/me")]
    #[case("CLAUDE_CONFIG_DIR", "/Users/me/.claude-work")]
    #[case("LANG", "en_US.UTF-8")]
    fn user_variables_are_kept(#[case] key: &str, #[case] value: &str) {
        // Given a user variable in orb's environment.
        let parent = [(key, value)];

        // When building the child's environment.
        let env = env_of(&parent);

        // Then the child sees it unchanged.
        assert_eq!(
            values_of(&env, key),
            [&OsString::from(value)],
            "{key} should be kept as is"
        );
    }

    #[rstest::rstest]
    #[case("TERM", "xterm-256color")]
    #[case("COLORTERM", "truecolor")]
    #[case("TERM_PROGRAM", "WezTerm")]
    #[case("CLAUDE_CODE_FORCE_SYNC_OUTPUT", "1")]
    fn terminal_identity_is_set(#[case] key: &str, #[case] value: &str) {
        // Given orb runs in kitty.
        let parent = [("TERM", "xterm-kitty"), ("TERM_PROGRAM", "kitty")];

        // When building the child's environment.
        let env = env_of(&parent);

        // Then the child has exactly one of orb's identity values.
        assert_eq!(
            values_of(&env, key),
            [&OsString::from(value)],
            "{key} should be set once to {value}"
        );
    }

    #[rstest::rstest]
    fn pane_env_sets_orb_pane_id() {
        // Given orb's child environment.
        let env = env_of(&[("PATH", "/bin")]);

        // When building pane 7's environment.
        let pane = pane_env(&env, PaneId(7));

        // Then ORB_PANE_ID names pane 7, once.
        assert_eq!(
            values_of(&pane, ORB_PANE_ID),
            [&OsString::from("7")],
            "ORB_PANE_ID should be the pane's id"
        );
    }

    #[rstest::rstest]
    fn child_env_drops_an_inherited_orb_pane_id() {
        // Given orb runs inside another orb's pane.
        let parent = [(ORB_PANE_ID, "3")];

        // When building the child's environment.
        let env = env_of(&parent);

        // Then the inherited pane id is gone.
        assert!(
            values_of(&env, ORB_PANE_ID).is_empty(),
            "an inherited ORB_PANE_ID should be removed"
        );
    }

    #[rstest::rstest]
    fn child_env_drops_an_inherited_terminal_browser_socket() {
        // Given orb runs inside another orb's pane.
        let parent = [(
            TERMINAL_BROWSER_TERMINAL_SOCKET,
            "/other/.orb/terminal-browser.sock",
        )];

        // When building the child's environment.
        let env = env_of(&parent);

        // Then the inherited socket is gone.
        assert!(
            values_of(&env, TERMINAL_BROWSER_TERMINAL_SOCKET).is_empty(),
            "an inherited TERMINAL_BROWSER_TERMINAL_SOCKET should be removed"
        );
    }

    #[rstest::rstest]
    fn terminal_browser_socket_env_names_the_socket() {
        // Given orb's terminal-browser socket.
        let socket = Path::new("/h/.orb/terminal-browser.sock");

        // When building the setting.
        let setting = terminal_browser_socket_env(socket);

        // Then it names that socket.
        assert_eq!(
            setting,
            (
                OsString::from(TERMINAL_BROWSER_TERMINAL_SOCKET),
                OsString::from("/h/.orb/terminal-browser.sock")
            ),
            "the setting should name orb's terminal-browser socket"
        );
    }

    #[rstest::rstest]
    #[case("TERMINAL_BROWSER_PRESENT", "patched")]
    #[case("TERMINAL_BROWSER_FRAMES", "shared")]
    fn terminal_browser_vars_are_set_with_kitty_images(#[case] key: &str, #[case] value: &str) {
        // Given orb shows kitty images.
        let kitty_images = true;

        // When building terminal-browser's settings.
        let env = terminal_browser_env(kitty_images);

        // Then the setting is there, once.
        assert_eq!(
            values_of(&env, key),
            [&OsString::from(value)],
            "{key} should be set once to {value}"
        );
    }

    #[rstest::rstest]
    fn terminal_browser_vars_are_absent_without_kitty_images() {
        // Given orb shows no kitty images.
        let kitty_images = false;

        // When building terminal-browser's settings.
        let env = terminal_browser_env(kitty_images);

        // Then there are none.
        assert!(
            env.is_empty(),
            "no terminal-browser settings without kitty images"
        );
    }
}
