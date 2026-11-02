//! The terminal orb runs in: the modes orb switches on for itself, and what it
//! passes through from the pane's child.
//!
//! orb asks for kitty key reports, with key repeats and releases (so every
//! key reaches the child unambiguously), bracketed paste, and focus changes.
//! The mouse is captured from startup until orb exits, and, in kitty, read in
//! pixels, and the child's cursor shape and clipboard copies are passed
//! through to the outer terminal. Everything is switched back
//! off on exit and on panic, except when only one pane's output handling
//! crashed.
//!
//! At start-up, before anything else reads input, orb asks the outer terminal
//! what it is and which colours it draws with. Pane images are forwarded only
//! to kitty, and a pane's colour questions can be answered with the colours
//! its text really shows in. When the outer terminal's own background is
//! exactly orb's navy, orb paints one step off it, since kitty draws pane
//! images over any cell of its own background colour, even one orb painted.
//! Resizing orb's window redraws it without erasing the whole screen, so the
//! panes' images stay on it. The log gets one line saying what the terminal
//! answered: its name and version, whether images reach it, its cell size,
//! and why the probe failed when it did.

use std::io::{self, Stdout, Write};
use std::panic;
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use orb_domain::{Log, ends_orb, panic_text};
use orb_term::{CellSize, GraphicsSupport, PANE_READER_THREAD};
use ratatui::Terminal;
use ratatui::backend::{Backend, ClearType, CrosstermBackend, WindowSize};
use ratatui::buffer::Cell;
use ratatui::crossterm::cursor::SetCursorStyle;
use ratatui::crossterm::event::{
    DisableBracketedPaste, DisableFocusChange, DisableMouseCapture, EnableBracketedPaste,
    EnableFocusChange, EnableMouseCapture, KeyboardEnhancementFlags, PopKeyboardEnhancementFlags,
    PushKeyboardEnhancementFlags,
};
use ratatui::crossterm::execute;
use ratatui::layout::{Position, Size};
use ratatui::style::Color;
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::io::Errno;

use crate::render::BACKGROUND;

/// How long start-up waits for the outer terminal to answer.
const PROBE_WAIT: Duration = Duration::from_millis(300);

/// The first kitty version that takes the transient hint (`N=1`).
const TRANSIENT_FROM: (u32, u32) = (0, 48);

/// orb's navy with blue one higher: the same to the eye, apart for kitty.
const BACKGROUND_STEP_OFF: Color = Color::Rgb(0x22, 0x24, 0x37);

/// orb's terminal: ratatui over stdout through [`KeepImages`].
pub(crate) type OrbTerminal = Terminal<KeepImages<CrosstermBackend<Stdout>>>;

/// A backend whose full clear keeps the outer terminal's images: it homes the
/// cursor and erases below, since erasing the whole screen deletes every
/// kitty image.
pub(crate) struct KeepImages<B>(B);

impl<B> Backend for KeepImages<B>
where
    B: Backend,
{
    type Error = B::Error;

    fn draw<'a, I>(&mut self, content: I) -> Result<(), Self::Error>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        self.0.draw(content)
    }

    fn append_lines(&mut self, n: u16) -> Result<(), Self::Error> {
        self.0.append_lines(n)
    }

    fn hide_cursor(&mut self) -> Result<(), Self::Error> {
        self.0.hide_cursor()
    }

    fn show_cursor(&mut self) -> Result<(), Self::Error> {
        self.0.show_cursor()
    }

    fn get_cursor_position(&mut self) -> Result<Position, Self::Error> {
        self.0.get_cursor_position()
    }

    fn set_cursor_position<P>(&mut self, position: P) -> Result<(), Self::Error>
    where
        P: Into<Position>,
    {
        self.0.set_cursor_position(position)
    }

    fn clear(&mut self) -> Result<(), Self::Error> {
        self.clear_region(ClearType::All)
    }

    fn clear_region(&mut self, clear_type: ClearType) -> Result<(), Self::Error> {
        match clear_type {
            ClearType::All => {
                self.0.set_cursor_position(Position::ORIGIN)?;
                self.0.clear_region(ClearType::AfterCursor)
            }
            other => self.0.clear_region(other),
        }
    }

    fn size(&self) -> Result<Size, Self::Error> {
        self.0.size()
    }

    fn window_size(&mut self) -> Result<WindowSize, Self::Error> {
        self.0.window_size()
    }

    fn flush(&mut self) -> Result<(), Self::Error> {
        Backend::flush(&mut self.0)
    }
}

impl<B> Write for KeepImages<B>
where
    B: Write,
{
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        Write::flush(&mut self.0)
    }
}

/// Runs `f` on orb's terminal in raw mode on the alternate screen, with what
/// the outer terminal said about itself, asked before anything reads input
/// and written to `log` as one line. Restores the terminal whatever `f`
/// returns; ratatui's panic hook covers a panic.
///
/// # Errors
///
/// Returns an error if setting up the terminal fails, or `f`'s error.
pub(crate) fn run<F>(log: &Log, f: F) -> io::Result<()>
where
    F: FnOnce(&mut OrbTerminal, OuterTerminal) -> io::Result<()>,
{
    let result = ratatui::try_init().and_then(|initial| {
        drop(initial);
        let (outer, version, end) = probe();
        let mut terminal = Terminal::new(KeepImages(CrosstermBackend::new(io::stdout())))?;
        let cell = cell_size(terminal.backend_mut().window_size().ok());
        log.line(
            "terminal",
            &probe_line(version.as_deref(), &outer, cell, &end),
        );
        f(&mut terminal, outer)
    });
    ratatui::restore();
    result
}

/// What the outer terminal said about itself at start-up.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct OuterTerminal {
    /// Whether pane images can reach the screen.
    pub graphics: GraphicsSupport,
    /// The colour a pane's default text shows in (OSC 10), when it answered.
    pub foreground: Option<Color>,
    /// The outer terminal's own background (OSC 11), when it answered.
    pub background: Option<Color>,
    /// The colours a pane's ANSI colours 0–15 show in (OSC 4); `None` for each
    /// one it didn't answer.
    pub palette: [Option<Color>; 16],
}

impl OuterTerminal {
    /// Whether orb asks for the mouse in pixels: only from kitty, which
    /// always reports them along with its cell size.
    // ponytail: kitty only; ask DECRQM `?1016` at start-up if another terminal ever runs browsers.
    pub(crate) fn pixel_mouse(&self) -> bool {
        matches!(self.graphics, GraphicsSupport::Kitty { .. })
    }

    /// The colour orb paints behind cells with no background of their own:
    /// orb's navy, or one step off it when the outer terminal's own background
    /// is exactly that navy, so kitty still sees those cells as painted.
    pub(crate) fn orb_background(&self) -> Color {
        match self.background {
            Some(BACKGROUND) => BACKGROUND_STEP_OFF,
            _ => BACKGROUND,
        }
    }
}

/// How the start-up probe ended.
#[derive(Debug)]
pub(crate) enum ProbeEnd {
    /// The terminal answered up to the fence.
    Answered,
    /// No fence within [`PROBE_WAIT`].
    TimedOut,
    /// stdin closed before the fence.
    Closed,
    /// Reading stdin failed.
    ReadFailed(Errno),
    /// Writing the questions failed.
    WriteFailed(io::Error),
}

/// The start-up log line: the terminal's name and version, whether images
/// reach it, the cell size, and how the probe ended when it didn't answer.
pub(crate) fn probe_line(
    version: Option<&str>,
    outer: &OuterTerminal,
    cell: CellSize,
    end: &ProbeEnd,
) -> String {
    let failure = match end {
        ProbeEnd::Answered => None,
        ProbeEnd::TimedOut => Some(format!("no answer within {} ms", PROBE_WAIT.as_millis())),
        ProbeEnd::Closed => Some("stdin closed before the answer".to_owned()),
        ProbeEnd::ReadFailed(error) => Some(format!("couldn't read the answer: {error}")),
        ProbeEnd::WriteFailed(error) => Some(format!("couldn't ask: {error}")),
    };
    let who = match (version, failure) {
        (Some(version), None) => version.to_owned(),
        (None, None) => "no name given".to_owned(),
        (None, Some(failure)) => failure,
        (Some(version), Some(failure)) => format!("{version}, {failure}"),
    };
    let images = match outer.graphics {
        GraphicsSupport::None => "images off",
        GraphicsSupport::Kitty { transient: true } => "images on (transient)",
        GraphicsSupport::Kitty { transient: false } => "images on",
    };
    format!("{who}, {images}, cell {}x{} px", cell.width, cell.height)
}

/// Asks the outer terminal for its name and version (XTVERSION), its default
/// text colour (OSC 10), its background (OSC 11) and its colours 0–15 (OSC 4),
/// fenced by a device-attributes query (DA1) every terminal answers last, and
/// reads the replies straight from stdin up to the fence, so they never reach
/// the input thread. Runs in raw mode before anything else reads input; keys
/// typed meanwhile are lost. A terminal slower than [`PROBE_WAIT`] counts as
/// one that answered nothing.
// ponytail: answers arriving after PROBE_WAIT reach the input thread as keys;
// a filter in front of crossterm's reader would close that if a slow terminal
// ever shows it.
/// Returns what it said, its XTVERSION text and how the probe ended.
fn probe() -> (OuterTerminal, Option<String>, ProbeEnd) {
    let mut out = io::stdout();
    match ask(&mut out).and_then(|()| out.flush()) {
        Ok(()) => {
            let (replies, end) = read_replies(PROBE_WAIT);
            (parse_probe(&replies), version(&replies), end)
        }
        Err(error) => (OuterTerminal::default(), None, ProbeEnd::WriteFailed(error)),
    }
}

/// Writes the probe's questions, the fence last.
fn ask<W>(out: &mut W) -> io::Result<()>
where
    W: Write,
{
    write!(out, "\x1b[>0q\x1b]10;?\x1b\\\x1b]11;?\x1b\\")?;
    for index in 0..16 {
        write!(out, "\x1b]4;{index};?\x1b\\")?;
    }
    write!(out, "\x1b[c")
}

/// Bytes read from stdin until the fence's reply is among them or `wait`
/// passes, and how the read ended. Polls fd 0 itself: on macOS `poll` fails
/// on `/dev/tty`.
fn read_replies(wait: Duration) -> (Vec<u8>, ProbeEnd) {
    let stdin = io::stdin();
    let deadline = Instant::now() + wait;
    let mut replies = Vec::new();
    let mut chunk = [0; 1024];
    let end = loop {
        if has_fence(&replies) {
            break ProbeEnd::Answered;
        }
        let Some(timeout) = deadline
            .checked_duration_since(Instant::now())
            .and_then(|left| Timespec::try_from(left).ok())
        else {
            break ProbeEnd::TimedOut;
        };
        match poll(&mut [PollFd::new(&stdin, PollFlags::IN)], Some(&timeout)) {
            Err(Errno::INTR) => continue,
            Ok(0) => break ProbeEnd::TimedOut,
            Err(error) => break ProbeEnd::ReadFailed(error),
            Ok(_) => {}
        }
        match rustix::io::read(&stdin, &mut chunk) {
            Ok(read) if read > 0 => {
                replies.extend_from_slice(chunk.get(..read).unwrap_or_default());
            }
            Err(Errno::INTR) => {}
            Ok(_) => break ProbeEnd::Closed,
            Err(error) => break ProbeEnd::ReadFailed(error),
        }
    };
    (replies, end)
}

/// Whether `replies` hold a device-attributes reply (`ESC [ ? … c`).
fn has_fence(replies: &[u8]) -> bool {
    replies.split(|byte| *byte == 0x1b).any(|part| {
        part.strip_prefix(b"[?").is_some_and(|rest| {
            rest.iter()
                .find(|byte| !byte.is_ascii_digit() && **byte != b';')
                == Some(&b'c')
        })
    })
}

/// What the probe replies say: kitty images when XTVERSION's name starts with
/// "kitty" (any case), transient from 0.48.0, and every colour answered.
/// Anything else, or no reply, leaves that part unknown.
pub(crate) fn parse_probe(replies: &[u8]) -> OuterTerminal {
    let text = String::from_utf8_lossy(replies);
    let mut outer = OuterTerminal::default();
    for reply in each_reply(&text) {
        if let Some(version) = reply.strip_prefix("P>|") {
            outer.graphics = graphics_support(version);
        }
        if let Some(color) = reply.strip_prefix("]10;") {
            outer.foreground = rgb(color);
        }
        if let Some(color) = reply.strip_prefix("]11;") {
            outer.background = rgb(color);
        }
        if let Some((index, color)) = reply
            .strip_prefix("]4;")
            .and_then(|entry| entry.split_once(';'))
            && let Some(slot) = index
                .parse::<usize>()
                .ok()
                .and_then(|index| outer.palette.get_mut(index))
        {
            *slot = rgb(color);
        }
    }
    outer
}

/// The XTVERSION text in the probe replies, such as `kitty(0.48.2)`.
fn version(replies: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(replies);
    each_reply(&text)
        .find_map(|reply| reply.strip_prefix("P>|"))
        .map(str::to_owned)
}

/// Each reply in the probe's text: split at ESC, cut at a BEL.
fn each_reply(text: &str) -> impl Iterator<Item = &str> {
    text.split('\x1b')
        .map(|part| part.split_once('\x07').map_or(part, |(reply, _)| reply))
}

/// One cell's pixels from the outer terminal's window size; zero when it
/// reports no pixels.
pub(crate) fn cell_size(window: Option<WindowSize>) -> CellSize {
    let Some(WindowSize {
        columns_rows,
        pixels,
    }) = window
    else {
        return CellSize::default();
    };
    match (
        pixels.width.checked_div(columns_rows.width),
        pixels.height.checked_div(columns_rows.height),
    ) {
        (Some(width), Some(height)) if width > 0 && height > 0 => CellSize { width, height },
        _ => CellSize::default(),
    }
}

/// Image support for an XTVERSION answer such as `kitty(0.48.2)`.
fn graphics_support(version: &str) -> GraphicsSupport {
    let (name, number) = version.split_once('(').unwrap_or((version, ""));
    if !name.to_ascii_lowercase().starts_with("kitty") {
        return GraphicsSupport::None;
    }
    let mut parts = number
        .trim_end_matches(')')
        .split('.')
        .map(str::parse::<u32>);
    let release = match (parts.next(), parts.next()) {
        (Some(Ok(major)), Some(Ok(minor))) => Some((major, minor)),
        _ => None,
    };
    GraphicsSupport::Kitty {
        transient: release.is_some_and(|release| release >= TRANSIENT_FROM),
    }
}

/// The colour in an X11 `rgb:R/G/B` answer, each channel 1–4 hex digits.
fn rgb(spec: &str) -> Option<Color> {
    let mut channels = spec.strip_prefix("rgb:")?.split('/').map(channel);
    match (
        channels.next(),
        channels.next(),
        channels.next(),
        channels.next(),
    ) {
        (Some(Some(r)), Some(Some(g)), Some(Some(b)), None) => Some(Color::Rgb(r, g, b)),
        _ => None,
    }
}

/// One `rgb:` channel scaled to 8 bits.
fn channel(hex: &str) -> Option<u8> {
    let max = match hex.len() {
        1..=4 => (1_u32 << (4 * hex.len())) - 1,
        _ => return None,
    };
    let value = u32::from_str_radix(hex, 16).ok()?;
    u8::try_from(value * 255 / max).ok()
}

/// Switches on the modes orb needs from the outer terminal; with
/// `pixel_mouse`, the mouse in pixels.
///
/// # Errors
///
/// Returns an error if writing to the terminal fails.
pub(crate) fn enable<W>(out: &mut W, pixel_mouse: bool) -> io::Result<()>
where
    W: Write,
{
    execute!(
        out,
        PushKeyboardEnhancementFlags(
            KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                | KeyboardEnhancementFlags::REPORT_EVENT_TYPES
                | KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS
        ),
        EnableBracketedPaste,
        EnableFocusChange,
        EnableMouseCapture,
    )?;
    if pixel_mouse {
        out.write_all(b"\x1b[?1016h")?;
        out.flush()?;
    }
    Ok(())
}

/// Switches off everything orb changed in the outer terminal. Must run while
/// the alternate screen is still active: kitty key flags are kept per screen.
///
/// # Errors
///
/// Returns an error if writing to the terminal fails.
pub(crate) fn disable<W>(out: &mut W) -> io::Result<()>
where
    W: Write,
{
    out.write_all(b"\x1b[?1016l")?;
    execute!(
        out,
        DisableMouseCapture,
        SetCursorStyle::DefaultUserShape,
        DisableFocusChange,
        DisableBracketedPaste,
        PopKeyboardEnhancementFlags,
    )
}

/// Restores the outer terminal on panic. Install it after ratatui's own hook,
/// so this one runs first, before ratatui leaves the alternate screen. A
/// crash on a pane reader leaves the screen alone: it writes its line to
/// `log` and orb keeps running without that pane.
pub(crate) fn install_panic_hook(log: Log) {
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        if !ends_orb(thread::current().name(), PANE_READER_THREAD) {
            log.line("panic", &panic_text(info));
            return;
        }
        let _ = disable(&mut io::stdout());
        previous(info);
    }));
}

/// Copies `text` to the system clipboard through the outer terminal (OSC 52).
///
/// # Errors
///
/// Returns an error if writing to the terminal fails.
pub(crate) fn copy_to_clipboard<W>(out: &mut W, text: &str) -> io::Result<()>
where
    W: Write,
{
    write!(out, "\x1b]52;c;{}\x07", STANDARD.encode(text))?;
    out.flush()
}

/// Sets the outer terminal's cursor shape.
///
/// # Errors
///
/// Returns an error if writing to the terminal fails.
pub(crate) fn set_cursor_style<W>(out: &mut W, style: SetCursorStyle) -> io::Result<()>
where
    W: Write,
{
    execute!(out, style)
}

#[cfg(test)]
mod tests {
    use std::io::{self, Write};
    use std::sync::{Arc, Mutex, PoisonError};

    use orb_term::{CellSize, GraphicsSupport};
    use ratatui::backend::{Backend, ClearType, CrosstermBackend};
    use ratatui::style::Color;

    use super::{
        KeepImages, OuterTerminal, ProbeEnd, ask, copy_to_clipboard, disable, enable, has_fence,
        parse_probe, probe_line,
    };
    use crate::render::BACKGROUND;

    /// An output whose bytes stay readable after a backend takes it.
    #[derive(Clone, Default)]
    struct SharedBuf(Arc<Mutex<Vec<u8>>>);

    impl SharedBuf {
        fn contents(&self) -> Vec<u8> {
            self.0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        }
    }

    impl Write for SharedBuf {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[rstest::rstest]
    fn full_clear_homes_and_erases_below() {
        // Given orb's backend writing to an empty output.
        let out = SharedBuf::default();
        let mut backend = KeepImages(CrosstermBackend::new(out.clone()));

        // When clearing the whole screen, as a resize does.
        let _ = backend.clear_region(ClearType::All);

        // Then it homes the cursor and erases below, never erasing the whole
        // screen, which would delete kitty's images.
        assert_eq!(
            out.contents(),
            b"\x1b[1;1H\x1b[J",
            "a full clear should home the cursor and erase below"
        );
    }

    #[rstest::rstest]
    fn clipboard_copy_writes_osc52_sequence() {
        // Given an empty output.
        let mut out = Vec::new();

        // When copying "hello".
        let _ = copy_to_clipboard(&mut out, "hello");

        // Then the output is an OSC 52 clipboard write of the base64 text.
        assert_eq!(
            out, b"\x1b]52;c;aGVsbG8=\x07",
            "copy should write OSC 52 with base64 text"
        );
    }

    #[rstest::rstest]
    fn enable_captures_the_mouse() {
        // Given an empty output.
        let mut out = Vec::new();

        // When switching on orb's terminal modes.
        let _ = enable(&mut out, false);

        // Then the output turns on SGR mouse reporting.
        assert!(
            String::from_utf8_lossy(&out).contains("\x1b[?1006h"),
            "enable should capture the mouse"
        );
    }

    #[rstest::rstest]
    #[case::asked(true)]
    #[case::not_asked(false)]
    fn enable_turns_pixel_mouse_on_only_when_asked(#[case] pixel_mouse: bool) {
        // Given an empty output.
        let mut out = Vec::new();

        // When switching on orb's terminal modes.
        let _ = enable(&mut out, pixel_mouse);

        // Then pixel mouse reports are turned on exactly when asked.
        assert_eq!(
            String::from_utf8_lossy(&out).contains("\x1b[?1016h"),
            pixel_mouse,
            "pixel mouse should follow the argument"
        );
    }

    #[rstest::rstest]
    fn disable_turns_pixel_mouse_off() {
        // Given an empty output.
        let mut out = Vec::new();

        // When switching off orb's terminal modes.
        let _ = disable(&mut out);

        // Then pixel mouse reports are turned off.
        assert!(
            String::from_utf8_lossy(&out).contains("\x1b[?1016l"),
            "disable should turn pixel mouse off"
        );
    }

    #[rstest::rstest]
    fn enable_asks_for_disambiguated_keys() {
        // Given an empty output.
        let mut out = Vec::new();

        // When switching on orb's terminal modes.
        let _ = enable(&mut out, false);

        // Then it pushes kitty flags 7 (disambiguate, event types, alternate keys).
        assert!(
            String::from_utf8_lossy(&out).contains("\x1b[>7u"),
            "enable should push kitty flags 7 (disambiguate, event types, alternate keys), \
             so Ctrl+[ and Alt+[ arrive distinct and held keys report their releases"
        );
    }

    #[rstest::rstest]
    #[case(b"\x1bP>|kitty(0.48.2)\x1b\\\x1b[?62;c", GraphicsSupport::Kitty { transient: true })]
    #[case(b"\x1bP>|kitty(0.47.0)\x1b\\\x1b[?62;c", GraphicsSupport::Kitty { transient: false })]
    #[case(b"\x1bP>|Kitty(0.48.0)\x1b\\\x1b[?62;c", GraphicsSupport::Kitty { transient: true })]
    #[case(b"\x1bP>|WezTerm 20240203\x1b\\\x1b[?65;c", GraphicsSupport::None)]
    #[case(b"\x1b[?62;c", GraphicsSupport::None)]
    #[case(b"", GraphicsSupport::None)]
    fn probe_reply_gives_graphics_support(
        #[case] replies: &[u8],
        #[case] expected: GraphicsSupport,
    ) {
        // Given the outer terminal's replies to the probe.

        // When reading them.
        let outer = parse_probe(replies);

        // Then the image support follows XTVERSION's name and version.
        assert_eq!(outer.graphics, expected, "image support for {replies:?}");
    }

    #[rstest::rstest]
    #[case(b"\x1b]4;1;rgb:f3f3/8b8b/a8a8\x1b\\", 1, Color::Rgb(0xf3, 0x8b, 0xa8))]
    #[case(b"\x1b]4;15;rgb:a6/ad/c8\x07", 15, Color::Rgb(0xa6, 0xad, 0xc8))]
    #[case(b"\x1b]4;0;rgb:4/5/6\x1b\\", 0, Color::Rgb(0x44, 0x55, 0x66))]
    fn palette_reply_gives_the_outer_colour(
        #[case] replies: &[u8],
        #[case] index: usize,
        #[case] expected: Color,
    ) {
        // Given the outer terminal's answer for one palette colour.

        // When reading it.
        let outer = parse_probe(replies);

        // Then that palette entry is the answered colour.
        assert_eq!(
            outer.palette.get(index),
            Some(&Some(expected)),
            "palette colour {index} from {replies:?}"
        );
    }

    #[rstest::rstest]
    fn unanswered_palette_colour_stays_unknown() {
        // Given an outer terminal that answered colour 1 only.
        let replies = b"\x1b]4;1;rgb:f3f3/8b8b/a8a8\x1b\\\x1b[?62;c";

        // When reading its replies.
        let outer = parse_probe(replies);

        // Then colour 2 is unknown.
        assert_eq!(
            outer.palette.get(2),
            Some(&None),
            "an unanswered palette colour should stay unknown"
        );
    }

    #[rstest::rstest]
    fn foreground_reply_gives_the_outer_foreground() {
        // Given the outer terminal's default text colour answer.
        let replies = b"\x1b]10;rgb:cdcd/d6d6/f4f4\x1b\\\x1b[?62;c";

        // When reading its replies.
        let outer = parse_probe(replies);

        // Then the foreground is that colour.
        assert_eq!(
            outer.foreground,
            Some(Color::Rgb(0xcd, 0xd6, 0xf4)),
            "foreground should be the answered colour"
        );
    }

    #[rstest::rstest]
    fn background_reply_gives_the_outer_background() {
        // Given the outer terminal's background answer.
        let replies = b"\x1b]11;rgb:2222/2424/3636\x1b\\\x1b[?62;c";

        // When reading its replies.
        let outer = parse_probe(replies);

        // Then the background is that colour.
        assert_eq!(
            outer.background,
            Some(Color::Rgb(0x22, 0x24, 0x36)),
            "background should be the answered colour"
        );
    }

    #[rstest::rstest]
    #[case::same_as_orbs(Some(BACKGROUND), Color::Rgb(0x22, 0x24, 0x37))]
    #[case::one_off_orbs(Some(Color::Rgb(0x22, 0x24, 0x37)), BACKGROUND)]
    #[case::another(Some(Color::Rgb(0x1e, 0x1e, 0x2e)), BACKGROUND)]
    #[case::unanswered(None, BACKGROUND)]
    fn orb_background_steps_off_only_an_exact_match(
        #[case] outer_background: Option<Color>,
        #[case] expected: Color,
    ) {
        // Given an outer terminal with that background.
        let outer = OuterTerminal {
            background: outer_background,
            ..OuterTerminal::default()
        };

        // When choosing orb's background.
        let background = outer.orb_background();

        // Then orb's navy moves one step off only when the outer background
        // is exactly it.
        assert_eq!(
            background, expected,
            "orb's background over {outer_background:?}"
        );
    }

    #[rstest::rstest]
    #[case("\x1b[>0q")]
    #[case("\x1b]10;?\x1b\\")]
    #[case("\x1b]11;?\x1b\\")]
    #[case("\x1b]4;0;?\x1b\\")]
    #[case("\x1b]4;15;?\x1b\\")]
    fn probe_asks_before_the_fence(#[case] question: &str) {
        // Given an empty output.
        let mut out = Vec::new();

        // When asking the probe's questions.
        let _ = ask(&mut out);

        // Then the question comes before the device-attributes fence, so its
        // answer arrives before the fence's.
        let text = String::from_utf8_lossy(&out);
        let (asked, fence) = (text.find(question), text.find("\x1b[c"));
        assert!(
            asked.is_some() && asked < fence,
            "{question:?} should be asked before the fence in {text:?}"
        );
    }

    #[rstest::rstest]
    #[case(b"\x1bP>|kitty(0.48.2)\x1b\\\x1b[?62;c", true)]
    #[case(b"\x1bP>|kitty(0.48.2)\x1b\\", false)]
    #[case(b"\x1b[?62;", false)]
    fn fence_reply_ends_the_wait(#[case] replies: &[u8], #[case] expected: bool) {
        // Given the replies read so far.

        // When checking for the fence's reply.
        let fenced = has_fence(replies);

        // Then reading stops only once the device attributes arrived.
        assert_eq!(fenced, expected, "fence in {replies:?}");
    }

    #[rstest::rstest]
    #[case::kitty(
        Some("kitty(0.48.2)"),
        GraphicsSupport::Kitty { transient: true },
        CellSize { width: 10, height: 21 },
        ProbeEnd::Answered,
        "kitty(0.48.2), images on (transient), cell 10x21 px"
    )]
    #[case::timed_out(
        None,
        GraphicsSupport::None,
        CellSize::default(),
        ProbeEnd::TimedOut,
        "no answer within 300 ms, images off, cell 0x0 px"
    )]
    #[case::not_kitty(
        Some("WezTerm 20240203"),
        GraphicsSupport::None,
        CellSize { width: 8, height: 16 },
        ProbeEnd::Answered,
        "WezTerm 20240203, images off, cell 8x16 px"
    )]
    fn probe_line_says_what_orb_found(
        #[case] version: Option<&str>,
        #[case] graphics: GraphicsSupport,
        #[case] cell: CellSize,
        #[case] end: ProbeEnd,
        #[case] expected: &str,
    ) {
        // Given what the probe found.
        let outer = OuterTerminal {
            graphics,
            ..OuterTerminal::default()
        };

        // When writing the start-up line.
        let line = probe_line(version, &outer, cell, &end);

        // Then it reads as expected.
        assert_eq!(line, expected, "the terminal line");
    }
}
