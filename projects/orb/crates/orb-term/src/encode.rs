//! Turns the user's input into the bytes the pane's child expects.
//!
//! Keys, pastes, mouse events, and focus changes are encoded for whatever
//! terminal modes the child has switched on: kitty keyboard flags (with a
//! printable key's text when the child asks for it), application cursor keys,
//! bracketed paste, mouse reporting, and focus events. Input the child didn't
//! ask for encodes to nothing.

use alacritty_terminal::term::TermMode;
use ratatui::crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEvent, MouseEventKind,
};
use ratatui::layout::{Position, Rect};
use terminput::{Encoding, KittyFlags};
use terminput_crossterm::to_terminput;

/// The bytes the child receives for `key`; empty when it should get nothing.
/// A child that didn't ask for event types hears a held key as presses and
/// never hears a release, as in kitty.
pub(crate) fn encode_key(key: &KeyEvent, mode: TermMode) -> Vec<u8> {
    let key = match (key.kind, mode.contains(TermMode::REPORT_EVENT_TYPES)) {
        (KeyEventKind::Release, false) => return Vec::new(),
        (KeyEventKind::Repeat, false) => KeyEvent {
            kind: KeyEventKind::Press,
            ..*key
        },
        _ => *key,
    };
    let flags = kitty_flags(mode);
    if key.modifiers.is_empty()
        && let Some(bytes) = fixed_key(key.code, flags, mode)
    {
        // kitty never reports these keys' releases in their legacy form.
        return if key.kind == KeyEventKind::Release {
            Vec::new()
        } else {
            bytes.to_vec()
        };
    }
    let encoding = if flags.is_empty() {
        Encoding::Xterm
    } else {
        Encoding::Kitty(flags)
    };
    with_text(encode_event(Event::Key(key), encoding), &key, mode)
}

/// `bytes`, a key's encoding, with kitty's associated-text field added when
/// the child asked for it (report associated text) and the key is a printable
/// one pressed or held without Ctrl, Alt, Super, Hyper or Meta, encoded as
/// CSI u. The modifier field is written as `1` when the encoding had none.
fn with_text(bytes: Vec<u8>, key: &KeyEvent, mode: TermMode) -> Vec<u8> {
    // ponytail: a held printable key reaches the child as repeated presses (kitty reports its repeats as plain text); asking kitty for every key as an escape code would fix it once crossterm reads associated text.
    let KeyCode::Char(c) = key.code else {
        return bytes;
    };
    let plain = !key.modifiers.intersects(
        KeyModifiers::CONTROL
            | KeyModifiers::ALT
            | KeyModifiers::SUPER
            | KeyModifiers::HYPER
            | KeyModifiers::META,
    );
    let wanted = plain
        && key.kind != KeyEventKind::Release
        && mode.contains(TermMode::REPORT_ASSOCIATED_TEXT);
    let body = bytes
        .strip_prefix(b"\x1b[")
        .and_then(|rest| rest.strip_suffix(b"u"));
    match body {
        Some(body) if wanted => {
            let modifiers: &[u8] = if body.contains(&b';') { b"" } else { b";1" };
            let text = format!(";{}u", u32::from(c));
            [b"\x1b[".as_slice(), body, modifiers, text.as_bytes()].concat()
        }
        _ => bytes,
    }
}

/// The bytes the child receives for pasted `text`: one bracketed paste when
/// the child enabled it (escape characters removed, so the paste can't end the
/// bracket early), otherwise the text with newlines sent as carriage returns.
pub(crate) fn encode_paste(text: &str, mode: TermMode) -> Vec<u8> {
    if mode.contains(TermMode::BRACKETED_PASTE) {
        format!("\x1b[200~{}\x1b[201~", text.replace('\x1b', "")).into_bytes()
    } else {
        text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
    }
}

/// The mouse report the child receives for `event` over the pane drawn at
/// `area`: SGR in pane cells, or SGR in pane pixels (0-based, as kitty
/// counts) when `pixel` is given, which is when the child turned pixel mouse
/// reports on and the outer terminal reported them. Empty when the child
/// didn't ask for this kind of event or it happened outside the pane.
pub(crate) fn encode_mouse(
    event: MouseEvent,
    area: Rect,
    mode: TermMode,
    pixel: Option<Position>,
) -> Vec<u8> {
    let wanted = match event.kind {
        MouseEventKind::Moved => mode.contains(TermMode::MOUSE_MOTION),
        MouseEventKind::Drag(_) => mode.intersects(TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION),
        _ => mode.intersects(TermMode::MOUSE_MODE),
    };
    // Pixel mouse alone selects SGR reports, so only cell reports need it.
    if !wanted
        || !(pixel.is_some() || mode.contains(TermMode::SGR_MOUSE))
        || !area.contains(Position::new(event.column, event.row))
    {
        return Vec::new();
    }
    let relative = MouseEvent {
        column: event.column - area.x,
        row: event.row - area.y,
        ..event
    };
    let Some(at) = pixel else {
        return encode_event(Event::Mouse(relative), Encoding::Xterm);
    };
    // The report at the pane's first cell, `ESC [ < cb ; 1 ; 1 M|m`, with its
    // coordinates swapped for the pixels.
    let cell = encode_event(
        Event::Mouse(MouseEvent {
            column: 0,
            row: 0,
            ..event
        }),
        Encoding::Xterm,
    );
    match (cell.split(|byte| *byte == b';').next(), cell.last()) {
        (Some(head), Some(end)) => {
            [head, format!(";{};{}", at.x, at.y).as_bytes(), &[*end]].concat()
        }
        _ => Vec::new(),
    }
}

/// The focus report the child receives when the pane gains or loses focus;
/// empty unless the child enabled focus events.
pub(crate) fn encode_focus(focused: bool, mode: TermMode) -> Vec<u8> {
    match (mode.contains(TermMode::FOCUS_IN_OUT), focused) {
        (false, _) => Vec::new(),
        (true, true) => b"\x1b[I".to_vec(),
        (true, false) => b"\x1b[O".to_vec(),
    }
}

/// The kitty keyboard flags the child pushed, in terminput's representation.
fn kitty_flags(mode: TermMode) -> KittyFlags {
    [
        (
            TermMode::DISAMBIGUATE_ESC_CODES,
            KittyFlags::DISAMBIGUATE_ESCAPE_CODES,
        ),
        (TermMode::REPORT_EVENT_TYPES, KittyFlags::REPORT_EVENT_TYPES),
        (
            TermMode::REPORT_ALTERNATE_KEYS,
            KittyFlags::REPORT_ALTERNATE_KEYS,
        ),
        (
            TermMode::REPORT_ALL_KEYS_AS_ESC,
            KittyFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES,
        ),
    ]
    .into_iter()
    .filter(|(term, _)| mode.contains(*term))
    .fold(KittyFlags::empty(), |flags, (_, kitty)| flags | kitty)
}

/// Unmodified keys terminput encodes differently from what terminals send:
/// Enter/Tab/Backspace stay legacy under kitty unless every key is reported as
/// an escape code, and cursor keys use SS3 in application cursor mode.
fn fixed_key(code: KeyCode, flags: KittyFlags, mode: TermMode) -> Option<&'static [u8]> {
    let legacy_under_kitty =
        !flags.is_empty() && !flags.contains(KittyFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES);
    let ss3 = flags.is_empty() && mode.contains(TermMode::APP_CURSOR);
    let bytes: &[u8] = match code {
        KeyCode::Enter if legacy_under_kitty => b"\r",
        KeyCode::Tab if legacy_under_kitty => b"\t",
        KeyCode::Backspace if legacy_under_kitty => b"\x7f",
        KeyCode::Up if ss3 => b"\x1bOA",
        KeyCode::Down if ss3 => b"\x1bOB",
        KeyCode::Right if ss3 => b"\x1bOC",
        KeyCode::Left if ss3 => b"\x1bOD",
        KeyCode::Home if ss3 => b"\x1bOH",
        KeyCode::End if ss3 => b"\x1bOF",
        _ => return None,
    };
    Some(bytes)
}

/// terminput's encoding of `event`; empty when terminput can't encode it.
fn encode_event(event: Event, encoding: Encoding) -> Vec<u8> {
    let mut buf = [0u8; 32];
    let len = to_terminput(event)
        .ok()
        .and_then(|event| event.encode(&mut buf, encoding).ok())
        .unwrap_or(0);
    buf.get(..len).map(<[u8]>::to_vec).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use alacritty_terminal::term::TermMode;
    use ratatui::crossterm::event::{
        KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    };
    use ratatui::layout::{Position, Rect};

    use super::{encode_focus, encode_key, encode_mouse, encode_paste};

    fn mouse(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
        MouseEvent {
            kind,
            column,
            row,
            modifiers: KeyModifiers::NONE,
        }
    }

    #[rstest::rstest]
    #[case(KeyCode::Enter, KeyModifiers::SHIFT, b"\x1b[13;2u")]
    #[case(KeyCode::BackTab, KeyModifiers::SHIFT, b"\x1b[9;2u")]
    #[case(KeyCode::Char('h'), KeyModifiers::CONTROL, b"\x1b[104;5u")]
    #[case(KeyCode::Backspace, KeyModifiers::NONE, b"\x7f")]
    #[case(KeyCode::Enter, KeyModifiers::NONE, b"\r")]
    #[case(KeyCode::Tab, KeyModifiers::NONE, b"\t")]
    #[case(KeyCode::Esc, KeyModifiers::NONE, b"\x1b[27u")]
    #[case(KeyCode::Char('a'), KeyModifiers::NONE, b"a")]
    #[case(KeyCode::Char('A'), KeyModifiers::CONTROL | KeyModifiers::SHIFT, b"\x1b[97:65;6u")]
    fn kitty_mode_encodes_keys(
        #[case] code: KeyCode,
        #[case] modifiers: KeyModifiers,
        #[case] expected: &[u8],
    ) {
        // Given a child that pushed kitty disambiguate + alternate keys.
        let mode = TermMode::DISAMBIGUATE_ESC_CODES | TermMode::REPORT_ALTERNATE_KEYS;

        // When encoding the key.
        let bytes = encode_key(&KeyEvent::new(code, modifiers), mode);

        // Then it gets the kitty encoding.
        assert_eq!(bytes, expected, "{modifiers}+{code} under kitty");
    }

    #[rstest::rstest]
    #[case(KeyCode::BackTab, KeyModifiers::SHIFT, b"\x1b[Z")]
    #[case(KeyCode::Char('h'), KeyModifiers::CONTROL, b"\x08")]
    #[case(KeyCode::Char('g'), KeyModifiers::CONTROL, b"\x07")]
    #[case(KeyCode::Backspace, KeyModifiers::NONE, b"\x7f")]
    #[case(KeyCode::Up, KeyModifiers::NONE, b"\x1b[A")]
    #[case(KeyCode::Enter, KeyModifiers::NONE, b"\r")]
    #[case(KeyCode::Esc, KeyModifiers::NONE, b"\x1b")]
    #[case(KeyCode::Char('b'), KeyModifiers::ALT, b"\x1bb")]
    fn legacy_mode_encodes_keys(
        #[case] code: KeyCode,
        #[case] modifiers: KeyModifiers,
        #[case] expected: &[u8],
    ) {
        // Given a child with no keyboard modes.
        let mode = TermMode::empty();

        // When encoding the key.
        let bytes = encode_key(&KeyEvent::new(code, modifiers), mode);

        // Then it gets the legacy encoding.
        assert_eq!(bytes, expected, "{modifiers}+{code} in legacy mode");
    }

    #[rstest::rstest]
    #[case(KeyCode::Up, b"\x1bOA")]
    #[case(KeyCode::Down, b"\x1bOB")]
    #[case(KeyCode::Right, b"\x1bOC")]
    #[case(KeyCode::Left, b"\x1bOD")]
    #[case(KeyCode::Home, b"\x1bOH")]
    #[case(KeyCode::End, b"\x1bOF")]
    fn application_cursor_mode_sends_ss3_keys(#[case] code: KeyCode, #[case] expected: &[u8]) {
        // Given a child in application cursor mode (DECCKM).
        let mode = TermMode::APP_CURSOR;

        // When encoding an unmodified cursor key.
        let bytes = encode_key(&KeyEvent::new(code, KeyModifiers::NONE), mode);

        // Then it gets the SS3 form.
        assert_eq!(bytes, expected, "{code} under DECCKM");
    }

    #[rstest::rstest]
    fn key_release_sends_nothing() {
        // Given a release of `a` and a child that doesn't want event types.
        let key = KeyEvent::new_with_kind(
            KeyCode::Char('a'),
            KeyModifiers::NONE,
            KeyEventKind::Release,
        );

        // When encoding it.
        let bytes = encode_key(&key, TermMode::empty());

        // Then nothing is sent.
        assert!(bytes.is_empty(), "releases should not reach the child");
    }

    #[rstest::rstest]
    #[case::letter(KeyCode::Char('a'), KeyModifiers::NONE, b"\x1b[97;1;97u")]
    #[case::shifted_letter(KeyCode::Char('A'), KeyModifiers::SHIFT, b"\x1b[97;2;65u")]
    #[case::space(KeyCode::Char(' '), KeyModifiers::NONE, b"\x1b[32;1;32u")]
    fn associated_text_rides_on_a_printable_key(
        #[case] code: KeyCode,
        #[case] modifiers: KeyModifiers,
        #[case] expected: &[u8],
    ) {
        // Given a child that asked for every key as an escape code, with its text.
        let mode = TermMode::DISAMBIGUATE_ESC_CODES
            | TermMode::REPORT_ALL_KEYS_AS_ESC
            | TermMode::REPORT_ASSOCIATED_TEXT;

        // When encoding the key.
        let bytes = encode_key(&KeyEvent::new(code, modifiers), mode);

        // Then it carries the text it types.
        assert_eq!(bytes, expected, "{modifiers}+{code} with associated text");
    }

    #[rstest::rstest]
    fn ctrl_key_carries_no_associated_text() {
        // Given a child that asked for every key as an escape code, with its text.
        let mode = TermMode::DISAMBIGUATE_ESC_CODES
            | TermMode::REPORT_ALL_KEYS_AS_ESC
            | TermMode::REPORT_ASSOCIATED_TEXT;

        // When encoding Ctrl+a.
        let bytes = encode_key(
            &KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL),
            mode,
        );

        // Then it has no text field, since it types nothing.
        assert_eq!(bytes, b"\x1b[97;5u", "Ctrl+a has no text");
    }

    #[rstest::rstest]
    fn printable_key_without_associated_text_mode_has_no_text() {
        // Given a child that asked for every key as an escape code, without its text.
        let mode = TermMode::DISAMBIGUATE_ESC_CODES | TermMode::REPORT_ALL_KEYS_AS_ESC;

        // When encoding `a`.
        let bytes = encode_key(&KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE), mode);

        // Then it has no text field.
        assert_eq!(bytes, b"\x1b[97u", "no text unless the child asked");
    }

    #[rstest::rstest]
    fn release_carries_no_associated_text() {
        // Given a child that asked for event types and associated text.
        let mode = TermMode::DISAMBIGUATE_ESC_CODES
            | TermMode::REPORT_EVENT_TYPES
            | TermMode::REPORT_ALL_KEYS_AS_ESC
            | TermMode::REPORT_ASSOCIATED_TEXT;

        // When encoding a release of `a`.
        let key = KeyEvent::new_with_kind(
            KeyCode::Char('a'),
            KeyModifiers::NONE,
            KeyEventKind::Release,
        );
        let bytes = encode_key(&key, mode);

        // Then the release has no text field.
        assert_eq!(bytes, b"\x1b[97;1:3u", "a release types nothing");
    }

    #[rstest::rstest]
    #[case::arrow(KeyCode::Up, KeyModifiers::NONE, TermMode::empty(), b"\x1b[A")]
    #[case::arrow_under_kitty(
        KeyCode::Up,
        KeyModifiers::NONE,
        TermMode::DISAMBIGUATE_ESC_CODES,
        b"\x1b[A"
    )]
    #[case::ctrl_key(KeyCode::Char('x'), KeyModifiers::CONTROL, TermMode::empty(), b"\x18")]
    fn repeat_reaches_a_child_without_event_types_as_a_press(
        #[case] code: KeyCode,
        #[case] modifiers: KeyModifiers,
        #[case] mode: TermMode,
        #[case] expected: &[u8],
    ) {
        // Given a held key and a child that didn't ask for event types.
        let key = KeyEvent::new_with_kind(code, modifiers, KeyEventKind::Repeat);

        // When encoding its repeat.
        let bytes = encode_key(&key, mode);

        // Then the child gets the key's press.
        assert_eq!(bytes, expected, "a repeat of {modifiers}+{code} is a press");
    }

    #[rstest::rstest]
    fn repeat_reaches_a_child_with_event_types_as_a_repeat() {
        // Given a child that asked for kitty event types.
        let mode = TermMode::DISAMBIGUATE_ESC_CODES | TermMode::REPORT_EVENT_TYPES;

        // When encoding a repeat of Up.
        let key = KeyEvent::new_with_kind(KeyCode::Up, KeyModifiers::NONE, KeyEventKind::Repeat);
        let bytes = encode_key(&key, mode);

        // Then it gets kitty's repeat report.
        assert_eq!(bytes, b"\x1b[1;1:2A", "Up repeat under event types");
    }

    #[rstest::rstest]
    fn release_reaches_a_child_with_event_types() {
        // Given a child that asked for kitty event types.
        let mode = TermMode::DISAMBIGUATE_ESC_CODES | TermMode::REPORT_EVENT_TYPES;

        // When encoding a release of Ctrl+x.
        let key = KeyEvent::new_with_kind(
            KeyCode::Char('x'),
            KeyModifiers::CONTROL,
            KeyEventKind::Release,
        );
        let bytes = encode_key(&key, mode);

        // Then it gets kitty's release report.
        assert_eq!(bytes, b"\x1b[120;5:3u", "Ctrl+x release under event types");
    }

    #[rstest::rstest]
    fn enter_release_sends_nothing_under_kitty() {
        // Given a child that asked for kitty event types, but not every key as
        // an escape code.
        let mode = TermMode::DISAMBIGUATE_ESC_CODES | TermMode::REPORT_EVENT_TYPES;

        // When encoding a release of Enter.
        let key =
            KeyEvent::new_with_kind(KeyCode::Enter, KeyModifiers::NONE, KeyEventKind::Release);
        let bytes = encode_key(&key, mode);

        // Then nothing is sent, as kitty sends nothing.
        assert!(bytes.is_empty(), "Enter's release has no legacy form");
    }

    #[rstest::rstest]
    fn paste_is_bracketed_when_child_enabled_bracketed_paste() {
        // Given a child with bracketed paste on.
        let mode = TermMode::BRACKETED_PASTE;

        // When pasting two lines.
        let bytes = encode_paste("a\nb", mode);

        // Then they arrive as one bracketed paste.
        assert_eq!(
            bytes, b"\x1b[200~a\nb\x1b[201~",
            "paste should be bracketed"
        );
    }

    #[rstest::rstest]
    fn paste_without_bracketed_mode_sends_carriage_returns() {
        // Given a child without bracketed paste.
        let mode = TermMode::empty();

        // When pasting text with CRLF and LF line endings.
        let bytes = encode_paste("a\r\nb\nc", mode);

        // Then every line ending becomes a carriage return.
        assert_eq!(bytes, b"a\rb\rc", "newlines should become carriage returns");
    }

    #[rstest::rstest]
    fn bracketed_paste_strips_escape_characters() {
        // Given a child with bracketed paste on.
        let mode = TermMode::BRACKETED_PASTE;

        // When pasting text that contains an end-of-paste sequence.
        let bytes = encode_paste("x\x1b[201~y", mode);

        // Then its escape character is removed, so the bracket can't end early.
        assert_eq!(
            bytes, b"\x1b[200~x[201~y\x1b[201~",
            "escape characters should be stripped"
        );
    }

    #[rstest::rstest]
    fn wheel_over_pane_encodes_sgr_relative_to_pane() {
        // Given a child with SGR click reporting and a pane at (10, 5).
        let mode = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        let area = Rect::new(10, 5, 20, 10);

        // When the wheel scrolls up at screen cell (14, 7).
        let bytes = encode_mouse(mouse(MouseEventKind::ScrollUp, 14, 7), area, mode, None);

        // Then the child gets an SGR wheel report at pane cell (5, 3), 1-based.
        assert_eq!(bytes, b"\x1b[<64;5;3M", "wheel should be pane-relative SGR");
    }

    #[rstest::rstest]
    fn mouse_outside_pane_sends_nothing() {
        // Given a child with SGR click reporting and a pane at (10, 5).
        let mode = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        let area = Rect::new(10, 5, 20, 10);

        // When the wheel scrolls outside the pane.
        let bytes = encode_mouse(mouse(MouseEventKind::ScrollUp, 2, 2), area, mode, None);

        // Then nothing is sent.
        assert!(
            bytes.is_empty(),
            "events outside the pane should be dropped"
        );
    }

    #[rstest::rstest]
    #[case::no_mouse_mode(TermMode::empty())]
    #[case::click_without_sgr(TermMode::MOUSE_REPORT_CLICK)]
    fn mouse_sends_nothing_without_child_mouse_mode(#[case] mode: TermMode) {
        // Given a child that didn't enable SGR mouse reporting.
        let area = Rect::new(0, 0, 80, 24);

        // When the left button goes down inside the pane.
        let bytes = encode_mouse(
            mouse(MouseEventKind::Down(MouseButton::Left), 1, 1),
            area,
            mode,
            None,
        );

        // Then nothing is sent.
        assert!(bytes.is_empty(), "mouse needs a child mouse mode plus SGR");
    }

    #[rstest::rstest]
    #[case::click_tracking(TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE, b"")]
    #[case::motion_tracking(TermMode::MOUSE_MOTION | TermMode::SGR_MOUSE, b"\x1b[<35;2;2M")]
    fn motion_is_sent_only_when_child_tracks_motion(
        #[case] mode: TermMode,
        #[case] expected: &[u8],
    ) {
        // Given a pane covering the whole screen.
        let area = Rect::new(0, 0, 80, 24);

        // When the mouse moves to (1, 1) with no button held.
        let bytes = encode_mouse(mouse(MouseEventKind::Moved, 1, 1), area, mode, None);

        // Then it is reported only if the child tracks motion.
        assert_eq!(bytes, expected, "motion needs MOUSE_MOTION");
    }

    #[rstest::rstest]
    #[case::press(MouseEventKind::Down(MouseButton::Left), b"\x1b[<0;15;27M")]
    #[case::release(MouseEventKind::Up(MouseButton::Left), b"\x1b[<0;15;27m")]
    fn pixel_report_carries_pane_pixels(#[case] kind: MouseEventKind, #[case] expected: &[u8]) {
        // Given a child with SGR click reporting and a pane at (10, 5).
        let mode = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        let area = Rect::new(10, 5, 20, 10);

        // When the left button acts at screen cell (14, 7), pane pixel (15, 27).
        let bytes = encode_mouse(mouse(kind, 14, 7), area, mode, Some(Position::new(15, 27)));

        // Then the child gets an SGR report in pane pixels.
        assert_eq!(bytes, expected, "the report should carry the pixels");
    }

    #[rstest::rstest]
    fn pixel_report_needs_no_sgr_mode() {
        // Given a child with click reporting but no SGR mode (pixel mouse
        // alone selects SGR).
        let mode = TermMode::MOUSE_REPORT_CLICK;
        let area = Rect::new(0, 0, 80, 24);

        // When the left button goes down with a pixel position.
        let bytes = encode_mouse(
            mouse(MouseEventKind::Down(MouseButton::Left), 1, 1),
            area,
            mode,
            Some(Position::new(12, 25)),
        );

        // Then a pixel report is sent.
        assert_eq!(
            bytes, b"\x1b[<0;12;25M",
            "pixel mouse selects SGR on its own"
        );
    }

    #[rstest::rstest]
    #[case::gained(true, b"\x1b[I")]
    #[case::lost(false, b"\x1b[O")]
    fn focus_change_is_reported_when_child_enabled_focus_events(
        #[case] focused: bool,
        #[case] expected: &[u8],
    ) {
        // Given a child with focus events on.
        let mode = TermMode::FOCUS_IN_OUT;

        // When the pane's focus changes.
        let bytes = encode_focus(focused, mode);

        // Then the child gets the matching focus report.
        assert_eq!(bytes, expected, "focus {focused} should be reported");
    }

    #[rstest::rstest]
    fn focus_change_sends_nothing_without_focus_events() {
        // Given a child without focus events.
        let mode = TermMode::empty();

        // When the pane loses focus.
        let bytes = encode_focus(false, mode);

        // Then nothing is sent.
        assert!(bytes.is_empty(), "focus needs ?1004");
    }
}
