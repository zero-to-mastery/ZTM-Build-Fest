//! The message box, drawn like LazyVim's notifier in tokyonight-moon: a
//! rounded float just under the tab bar at the right edge of the right side,
//! titled ` Messages` in cyan for info or ` Error` in red. It is at least
//! 40 columns wide and grows with its text to 40% of the right side; longer
//! lines are cut with `…`, and each line break starts a new line.

use std::time::{Duration, Instant};

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::widgets::{Block, BorderType, Clear, Padding, Paragraph, Widget};

use crate::session_picker::cut_right;
use crate::sidebar::{BG_DARK, CYAN, FAILED_ICON, FG, RED};

/// The narrowest the box gets, whatever its text.
const MIN_WIDTH: u16 = 40;
/// Before the info title (`nf-fa-info_circle`).
const INFO_ICON: &str = "\u{f05a}";
/// How long an info message shows.
const INFO_FOR: Duration = Duration::from_secs(3);
/// How long an error shows.
const ERROR_FOR: Duration = Duration::from_secs(5);
/// What the box says after orb copies a mouse selection.
const COPIED: &str = "Text copied to system clipboard";

/// What a message is about, which sets the box's title and colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToastKind {
    /// A notice, such as a copied selection or pruned worktrees.
    Info,
    /// Something that went wrong.
    Error,
}

/// One message in the box, shown until `until`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Toast {
    kind: ToastKind,
    text: String,
    until: Instant,
}

impl Toast {
    pub(crate) fn new(kind: ToastKind, text: impl Into<String>, until: Instant) -> Self {
        Self {
            kind,
            text: text.into(),
            until,
        }
    }
}

/// The one message the box shows, if any. Each error or notice orb reports
/// pops, shows for 3 s (info) or 5 s (an error), and is replaced by a newer
/// one, with two exceptions: the same error again doesn't pop until a key or
/// a success, and a notice doesn't replace an error that popped in the same
/// turn. The next key hides an error or notice; a success hides an error;
/// the copy notice stays until it times out.
#[derive(Debug, Default)]
pub(crate) struct Toasts {
    shown: Option<Toast>,
    /// The shown message is the copy notice, which a key doesn't hide.
    copy: bool,
    /// The last error that popped; the same error again doesn't pop until a
    /// key or a success.
    last_error: Option<String>,
    /// An error popped in this turn; a notice in the same turn doesn't
    /// replace it.
    error_this_turn: bool,
}

impl Toasts {
    /// Pops `text` as an error, unless it is the error that last popped.
    pub(crate) fn error(&mut self, text: String, now: Instant) {
        if self.last_error.as_ref() == Some(&text) {
            return;
        }
        self.show(
            Toast::new(ToastKind::Error, text.clone(), now + ERROR_FOR),
            false,
        );
        self.last_error = Some(text);
        self.error_this_turn = true;
    }

    /// Pops `text` as a notice, unless an error popped in this turn.
    pub(crate) fn notice(&mut self, text: String, now: Instant) {
        if !self.error_this_turn {
            self.show(Toast::new(ToastKind::Info, text, now + INFO_FOR), false);
        }
    }

    /// Pops the copy notice, unless an error popped in this turn.
    pub(crate) fn copied(&mut self, now: Instant) {
        if !self.error_this_turn {
            self.show(Toast::new(ToastKind::Info, COPIED, now + INFO_FOR), true);
        }
    }

    /// A key was handled: the user has seen the error or notice, so it hides
    /// and the same error may pop again.
    pub(crate) fn dismiss(&mut self) {
        if !self.copy {
            self.shown = None;
        }
        self.last_error = None;
        self.error_this_turn = false;
    }

    /// What failed works again: a showing error hides, a notice stays.
    pub(crate) fn recovered(&mut self) {
        if self
            .shown
            .as_ref()
            .is_some_and(|toast| toast.kind == ToastKind::Error)
        {
            self.shown = None;
        }
        self.last_error = None;
        self.error_this_turn = false;
    }

    /// A new batch of events starts.
    pub(crate) fn begin_turn(&mut self) {
        self.error_this_turn = false;
    }

    /// The message showing at `now`.
    pub(crate) fn shown(&self, now: Instant) -> Option<&Toast> {
        self.shown.as_ref().filter(|toast| toast.until > now)
    }

    /// When the showing message hides.
    pub(crate) fn deadline(&self, now: Instant) -> Option<Instant> {
        self.shown(now).map(|toast| toast.until)
    }

    fn show(&mut self, toast: Toast, copy: bool) {
        self.shown = Some(toast);
        self.copy = copy;
    }
}

/// Draws `toast` one row below the top of `right`, its right edge one column
/// in from the right side's. Nothing is drawn when `right` is too small for
/// a line of text.
pub(crate) fn render(toast: &Toast, right: Rect, buf: &mut Buffer) {
    let (icon, title, colour) = match toast.kind {
        ToastKind::Info => (INFO_ICON, "Messages", CYAN),
        ToastKind::Error => (FAILED_ICON, "Error", RED),
    };
    let lines: Vec<&str> = toast.text.split('\n').collect();
    let area = {
        let text_width = lines
            .iter()
            .map(|line| Line::raw(*line).width())
            .max()
            .unwrap_or(0);
        let max_width = MIN_WIDTH.max(right.width * 2 / 5);
        let width = u16::try_from(text_width + 4)
            .unwrap_or(u16::MAX)
            .clamp(MIN_WIDTH, max_width)
            .min(right.width.saturating_sub(1));
        let height = u16::try_from(lines.len() + 2)
            .unwrap_or(u16::MAX)
            .min(right.height.saturating_sub(1));
        Rect::new(
            right.right().saturating_sub(width + 1),
            right.y + 1,
            width,
            height,
        )
    };
    if area.width < 5 || area.height < 3 {
        return;
    }
    Clear.render(area, buf);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(colour))
        .title(Line::styled(format!(" {icon} {title} "), Style::new().fg(colour)).centered())
        .padding(Padding::horizontal(1))
        .style(Style::new().bg(BG_DARK));
    let text_width = usize::from(area.width - 4);
    let text: Vec<Line> = lines
        .iter()
        .map(|line| Line::styled(cut_right(line, text_width), Style::new().fg(FG)))
        .collect();
    Paragraph::new(text).block(block).render(area, buf);
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;

    use super::{COPIED, Toast, ToastKind, Toasts, render};
    use crate::sidebar::{CYAN, RED};

    const RIGHT: Rect = Rect::new(10, 0, 120, 30);

    fn draw(kind: ToastKind, text: &str, right: Rect) -> Buffer {
        let mut buffer = Buffer::empty(Rect::new(0, 0, right.right(), right.bottom()));
        render(&Toast::new(kind, text, Instant::now()), right, &mut buffer);
        buffer
    }

    /// The text of row `y`.
    fn row(buffer: &Buffer, y: u16) -> String {
        (0..buffer.area.width)
            .map(|x| buffer[(x, y)].symbol())
            .collect()
    }

    /// The columns of row `y` that hold something other than a space.
    fn drawn(buffer: &Buffer, y: u16) -> Vec<u16> {
        (0..buffer.area.width)
            .filter(|x| buffer[(*x, y)].symbol() != " ")
            .collect()
    }

    #[rstest::rstest]
    fn info_toast_has_cyan_messages_title() {
        // Given an info toast.
        // When drawn.
        let buffer = draw(ToastKind::Info, "pruned 2 worktrees", RIGHT);

        // Then the top edge is cyan and titled Messages.
        let top = row(&buffer, 1);
        let corner = drawn(&buffer, 1).first().copied();
        assert!(
            top.contains("Messages") && corner.is_some_and(|x| buffer[(x, 1)].fg == CYAN),
            "info box should be cyan with a Messages title: {top:?}"
        );
    }

    #[rstest::rstest]
    fn error_toast_has_red_error_title() {
        // Given an error toast.
        // When drawn.
        let buffer = draw(ToastKind::Error, "claude --bg failed", RIGHT);

        // Then the top edge is red and titled Error.
        let top = row(&buffer, 1);
        let corner = drawn(&buffer, 1).first().copied();
        assert!(
            top.contains("Error") && corner.is_some_and(|x| buffer[(x, 1)].fg == RED),
            "error box should be red with an Error title: {top:?}"
        );
    }

    #[rstest::rstest]
    fn short_message_gets_a_forty_column_box() {
        // Given a short message.
        // When drawn.
        let buffer = draw(ToastKind::Info, "hi", RIGHT);

        // Then the box is 40 columns wide.
        let edge = drawn(&buffer, 1);
        let width = edge.first().zip(edge.last()).map(|(l, r)| r - l + 1);
        assert_eq!(
            width,
            Some(40),
            "a short message should still get a 40-column box"
        );
    }

    #[rstest::rstest]
    fn long_line_is_cut_at_forty_percent() {
        // Given a line longer than 40% of a 120-column area.
        // When drawn.
        let buffer = draw(ToastKind::Info, &"x".repeat(100), RIGHT);

        // Then the box is 48 columns wide and its line ends with "…".
        let text = row(&buffer, 2);
        let expected = format!("│ {}… │", "x".repeat(43));
        assert!(
            text.contains(&expected),
            "the line should be cut with … at 40% of the area: {text:?}"
        );
    }

    #[rstest::rstest]
    fn line_break_starts_a_new_line() {
        // Given a message with a line break.
        // When drawn.
        let buffer = draw(ToastKind::Info, "first\nsecond", RIGHT);

        // Then each half is on its own row, and the box closes after them.
        let rows = [row(&buffer, 2), row(&buffer, 3), row(&buffer, 4)];
        assert!(
            rows[0].contains("first") && rows[1].contains("second") && rows[2].contains('╰'),
            "a line break should give two text lines: {rows:?}"
        );
    }

    #[rstest::rstest]
    fn box_sits_under_the_tab_bar_one_column_from_the_right() {
        // Given any toast.
        // When drawn.
        let buffer = draw(ToastKind::Info, "hi", RIGHT);

        // Then its top-right corner is on row 1, one column in from the right.
        let corner = (RIGHT.right() - 2, RIGHT.y + 1);
        assert!(
            buffer[corner].symbol() == "╮" && drawn(&buffer, RIGHT.y).is_empty(),
            "the box should start one row down and one column in from the right"
        );
    }

    #[rstest::rstest]
    fn narrow_area_keeps_box_inside() {
        // Given a 30-column area.
        let right = Rect::new(50, 0, 30, 10);

        // When drawn.
        let buffer = draw(ToastKind::Error, "something went wrong here", right);

        // Then nothing is drawn left of the area.
        let edge = drawn(&buffer, 1);
        assert!(
            edge.first().is_some_and(|x| *x >= right.x)
                && edge.last() == Some(&(right.right() - 2)),
            "the box should fit inside a narrow area: {edge:?}"
        );
    }

    /// A box that has just popped `error` at `at`.
    fn error_seen(error: &str, at: Instant) -> Toasts {
        let mut toasts = Toasts::default();
        toasts.error(error.to_owned(), at);
        toasts
    }

    #[rstest::rstest]
    fn new_error_still_shows_just_before_five_seconds() {
        // Given a new error.
        let at = Instant::now();
        let toasts = error_seen("boom", at);

        // When 4.9 s have passed.
        let shown = toasts.shown(at + Duration::from_millis(4900));

        // Then it still shows.
        assert_eq!(
            shown,
            Some(&Toast::new(
                ToastKind::Error,
                "boom",
                at + Duration::from_secs(5)
            )),
            "an error should show for 5 s"
        );
    }

    #[rstest::rstest]
    fn new_error_hides_after_five_seconds() {
        // Given a new error.
        let at = Instant::now();
        let toasts = error_seen("boom", at);

        // When 5 s have passed.
        let shown = toasts.shown(at + Duration::from_secs(5));

        // Then nothing shows.
        assert!(shown.is_none(), "an error should hide after 5 s");
    }

    #[rstest::rstest]
    fn new_notice_hides_after_three_seconds() {
        // Given a new notice.
        let at = Instant::now();
        let mut toasts = Toasts::default();
        toasts.notice("pruned 2 worktrees".to_owned(), at);

        // When 3 s have passed.
        let shown = toasts.shown(at + Duration::from_secs(3));

        // Then nothing shows.
        assert!(shown.is_none(), "a notice should hide after 3 s");
    }

    #[rstest::rstest]
    fn same_error_again_without_a_key_does_not_pop() {
        // Given an error that already timed out.
        let at = Instant::now();
        let mut toasts = error_seen("boom", at);
        let later = at + Duration::from_secs(6);

        // When the same error is reported again, with no key between.
        toasts.error("boom".to_owned(), later);

        // Then nothing shows.
        assert!(
            toasts.shown(later).is_none(),
            "the same error reported again should not bring the box back"
        );
    }

    #[rstest::rstest]
    fn same_error_after_a_key_pops_again() {
        // Given an error that a key then hid.
        let at = Instant::now();
        let mut toasts = error_seen("boom", at);
        toasts.dismiss();

        // When the same error is reported again.
        toasts.error("boom".to_owned(), at);

        // Then it shows again.
        assert!(
            toasts.shown(at).is_some(),
            "the same error after a key should pop again"
        );
    }

    #[rstest::rstest]
    fn same_error_after_a_recovery_pops_again() {
        // Given an error, then a success.
        let at = Instant::now();
        let mut toasts = error_seen("boom", at);
        toasts.recovered();

        // When the same error is reported again.
        toasts.error("boom".to_owned(), at);

        // Then it shows again.
        assert!(
            toasts.shown(at).is_some(),
            "the same error after a success should pop again"
        );
    }

    #[rstest::rstest]
    fn error_replaces_showing_info() {
        // Given an info toast showing.
        let at = Instant::now();
        let mut toasts = Toasts::default();
        toasts.copied(at);

        // When an error is reported.
        toasts.error("boom".to_owned(), at);

        // Then the error shows.
        assert_eq!(
            toasts.shown(at).map(|toast| toast.kind),
            Some(ToastKind::Error),
            "a newer message should replace the one showing"
        );
    }

    #[rstest::rstest]
    fn key_hides_the_error() {
        // Given an error showing.
        let at = Instant::now();
        let mut toasts = error_seen("boom", at);

        // When a key is handled.
        toasts.dismiss();

        // Then nothing shows.
        assert!(toasts.shown(at).is_none(), "a key should hide the error");
    }

    #[rstest::rstest]
    fn key_hides_a_notice() {
        // Given a notice showing.
        let at = Instant::now();
        let mut toasts = Toasts::default();
        toasts.notice("Added project orb".to_owned(), at);

        // When a key is handled.
        toasts.dismiss();

        // Then nothing shows.
        assert!(toasts.shown(at).is_none(), "a key should hide the notice");
    }

    #[rstest::rstest]
    fn key_keeps_the_copy_notice() {
        // Given the copy notice showing.
        let at = Instant::now();
        let mut toasts = Toasts::default();
        toasts.copied(at);

        // When a key is handled.
        toasts.dismiss();

        // Then the copy notice still shows.
        assert!(
            toasts.shown(at).is_some(),
            "a key shouldn't hide the copy notice"
        );
    }

    #[rstest::rstest]
    fn recovery_hides_the_error() {
        // Given an error showing.
        let at = Instant::now();
        let mut toasts = error_seen("boom", at);

        // When what failed works again.
        toasts.recovered();

        // Then nothing shows.
        assert!(
            toasts.shown(at).is_none(),
            "a later success should hide the error"
        );
    }

    #[rstest::rstest]
    fn recovery_keeps_a_notice() {
        // Given a notice showing.
        let at = Instant::now();
        let mut toasts = Toasts::default();
        toasts.notice("Added project orb".to_owned(), at);

        // When what failed works again.
        toasts.recovered();

        // Then the notice still shows.
        assert!(
            toasts.shown(at).is_some(),
            "a success shouldn't hide a notice"
        );
    }

    #[rstest::rstest]
    fn copy_shows_the_copy_notice() {
        // Given a copy event.
        let at = Instant::now();
        let mut toasts = Toasts::default();
        toasts.copied(at);

        // When asking what shows.
        let shown = toasts.shown(at);

        // Then it is the copy notice.
        assert_eq!(
            shown,
            Some(&Toast::new(
                ToastKind::Info,
                COPIED,
                at + Duration::from_secs(3)
            )),
            "a copy should show the copy notice for 3 s"
        );
    }

    #[rstest::rstest]
    fn new_project_notice_pops_as_info() {
        // Given no message showing.
        let at = Instant::now();
        let mut toasts = Toasts::default();

        // When a project notice is reported.
        toasts.notice("Added project orb".to_owned(), at);

        // Then it shows as info for 3 s.
        assert_eq!(
            toasts.shown(at),
            Some(&Toast::new(
                ToastKind::Info,
                "Added project orb",
                at + Duration::from_secs(3)
            )),
            "a new project notice should pop as info"
        );
    }

    #[rstest::rstest]
    fn notice_in_the_same_turn_does_not_hide_the_error() {
        // Given an error reported in this turn.
        let at = Instant::now();
        let mut toasts = Toasts::default();
        toasts.begin_turn();
        toasts.error("boom".to_owned(), at);

        // When a notice is reported in the same turn.
        toasts.notice("Added project orb".to_owned(), at);

        // Then the error still shows.
        assert_eq!(
            toasts.shown(at).map(|toast| toast.kind),
            Some(ToastKind::Error),
            "a notice in the same turn should not hide the error"
        );
    }

    #[rstest::rstest]
    fn error_in_the_same_turn_replaces_the_notice() {
        // Given a notice reported in this turn.
        let at = Instant::now();
        let mut toasts = Toasts::default();
        toasts.begin_turn();
        toasts.notice("Added project orb".to_owned(), at);

        // When an error is reported in the same turn.
        toasts.error("boom".to_owned(), at);

        // Then the error shows.
        assert_eq!(
            toasts.shown(at).map(|toast| toast.kind),
            Some(ToastKind::Error),
            "an error in the same turn should replace the notice"
        );
    }
}
