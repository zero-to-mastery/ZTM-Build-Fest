//! The control server's line to the screen loop: hands it a request and waits
//! for the loop's answer, so changes to what the screen owns happen on the
//! loop's thread.

use std::sync::Arc;
use std::sync::mpsc::{self, Sender};
use std::time::Duration;

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::feat::control::change::Change;
use crate::feat::control::protocol::{ApiError, ErrorCode};
use crate::ids::PaneId;

/// What an agent asks the screen loop to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaneRequest {
    Change(Change),
    /// Paste `text` into the pane (bracketed when its program turned that on).
    Send {
        pane: PaneId,
        text: String,
    },
    /// Press `keys` in the pane, in order.
    Keys {
        pane: PaneId,
        keys: Vec<KeyEvent>,
    },
    /// Type `line` and Enter into the pane as raw input, so a shell runs it.
    Run {
        pane: PaneId,
        line: String,
    },
    /// Type `line` and Enter as `Run` does, unless a line already waits to be
    /// typed in the pane (`pane_busy`).
    Launch {
        pane: PaneId,
        line: String,
    },
    /// Paste `text`, then press Enter, with nothing in between.
    Prompt {
        pane: PaneId,
        text: String,
    },
    /// The pane's screen, after up to `lines` lines of history, as text.
    Read {
        pane: PaneId,
        lines: usize,
    },
}

/// The loop's answer: the screen text for a read, nothing for the rest.
pub type PaneReply = Result<Option<String>, ApiError>;

/// The key `name` stands for in `orb pane keys`: `enter esc tab backspace
/// up down left right home end pageup pagedown`, `shift+tab`, `ctrl+<a-z>`,
/// `alt+<a-z>`, in any case; `None` for any other name.
pub(crate) fn key_event(name: &str) -> Option<KeyEvent> {
    let name = name.to_ascii_lowercase();
    let code = match name.as_str() {
        "enter" => KeyCode::Enter,
        "esc" => KeyCode::Esc,
        "tab" => KeyCode::Tab,
        "backspace" => KeyCode::Backspace,
        "up" => KeyCode::Up,
        "down" => KeyCode::Down,
        "left" => KeyCode::Left,
        "right" => KeyCode::Right,
        "home" => KeyCode::Home,
        "end" => KeyCode::End,
        "pageup" => KeyCode::PageUp,
        "pagedown" => KeyCode::PageDown,
        "shift+tab" => return Some(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT)),
        _ => {
            let (modifier, letter) = name
                .strip_prefix("ctrl+")
                .map(|letter| (KeyModifiers::CONTROL, letter))
                .or_else(|| {
                    name.strip_prefix("alt+")
                        .map(|letter| (KeyModifiers::ALT, letter))
                })?;
            let letter = letter
                .parse::<char>()
                .ok()
                .filter(char::is_ascii_lowercase)?;
            return Some(KeyEvent::new(KeyCode::Char(letter), modifier));
        }
    };
    Some(KeyEvent::new(code, KeyModifiers::NONE))
}

/// How long a request waits for the loop.
const LOOP_WAIT: Duration = Duration::from_secs(5);

/// Hands requests to the screen loop and waits for its answer. Cloning shares
/// the loop.
#[derive(Clone)]
pub struct PaneControl {
    send: Arc<dyn Fn(PaneRequest, Sender<PaneReply>) + Send + Sync>,
}

impl PaneControl {
    /// A handle that passes each request, with where to answer it, to `send`.
    pub fn new<F>(send: F) -> Self
    where
        F: Fn(PaneRequest, Sender<PaneReply>) + Send + Sync + 'static,
    {
        Self {
            send: Arc::new(send),
        }
    }

    /// Asks the loop to carry out `request` and waits for its answer.
    ///
    /// # Errors
    ///
    /// Returns the loop's refusal, or `failed` when the loop is gone or takes
    /// longer than five seconds.
    pub fn ask(&self, request: PaneRequest) -> PaneReply {
        let (tx, rx) = mpsc::channel();
        (self.send)(request, tx);
        rx.recv_timeout(LOOP_WAIT).unwrap_or_else(|_| {
            Err(ApiError::new(
                ErrorCode::Failed,
                "orb's screen didn't answer",
            ))
        })
    }
}

impl std::fmt::Debug for PaneControl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PaneControl")
    }
}

#[cfg(test)]
mod tests {
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    use super::key_event;

    #[rstest::rstest]
    #[case::enter("enter", KeyCode::Enter, KeyModifiers::NONE)]
    #[case::any_case("Esc", KeyCode::Esc, KeyModifiers::NONE)]
    #[case::pageup("pageup", KeyCode::PageUp, KeyModifiers::NONE)]
    #[case::shift_tab("shift+tab", KeyCode::BackTab, KeyModifiers::SHIFT)]
    #[case::ctrl("ctrl+c", KeyCode::Char('c'), KeyModifiers::CONTROL)]
    #[case::alt("alt+b", KeyCode::Char('b'), KeyModifiers::ALT)]
    fn key_names_make_their_key_events(
        #[case] name: &str,
        #[case] code: KeyCode,
        #[case] modifiers: KeyModifiers,
    ) {
        // Given / When looking up the key name.
        let key = key_event(name);

        // Then it is the key it names.
        assert_eq!(
            key,
            Some(KeyEvent::new(code, modifiers)),
            "{name} names its key"
        );
    }

    #[rstest::rstest]
    #[case::ctrl_digit("ctrl+1")]
    #[case::ctrl_two_letters("ctrl+ab")]
    #[case::unknown("f13")]
    #[case::empty("")]
    fn other_key_names_make_nothing(#[case] name: &str) {
        // Given / When looking up a name outside the table.
        let key = key_event(name);

        // Then there is no key.
        assert_eq!(key, None, "{name:?} names no key");
    }
}
