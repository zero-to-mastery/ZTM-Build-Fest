//! The name box: a LazyVim-style input centred at the top of the screen,
//! where the user types orb's own name for a session (`Rename Session`), a
//! tab, a pane or an agent's pane (`Rename Agent`), the name of a new
//! colony (`New colony`), or the name of a new session (`New session`).

use crate::mouse::HitMap;
use crate::picker::visible;
use crate::sidebar::{BLUE1, FG, YELLOW};
use orb_domain::feat::sidebar::state::{Rename, RenameTarget};
use ratatui::buffer::Buffer;
use ratatui::layout::{Alignment, Position, Rect};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Clear, Widget};

/// The box's width, borders included, on a screen wide enough for it.
const WIDTH: u16 = 60;
/// Nerd Font's edit glyph (`nf-fa-edit`), before the name.
const EDIT: &str = "\u{f044}";

/// Draws the rename box over the top of `area` (the screen above the mode
/// line). A name too long for the box shows its part up to the cursor.
/// Records the box and its text line in `hits`, so a click outside it can
/// close it and a click in the name can move its cursor. Returns where the
/// terminal cursor goes.
pub(crate) fn render(rename: &Rename, area: Rect, buf: &mut Buffer, hits: &mut HitMap) -> Position {
    let popup = {
        let width = area.width.min(WIDTH);
        Rect {
            x: area.x + (area.width - width) / 2,
            y: area.y + area.height.saturating_sub(3).min(2),
            width,
            height: area.height.min(3),
        }
    };
    Clear.render(popup, buf);
    hits.record_overlay(popup);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(YELLOW))
        .title(title(rename.target))
        .title_style(Style::new().fg(YELLOW))
        .title_alignment(Alignment::Center);
    let inner = block.inner(popup);
    block.render(popup, buf);
    let prefix = vec![
        Span::raw(" "),
        Span::styled(EDIT, Style::new().fg(BLUE1)),
        Span::raw("  "),
    ];
    let prefix_width: usize = prefix.iter().map(Span::width).sum();
    let room = usize::from(inner.width).saturating_sub(prefix_width + 1);
    let (shown, before) = visible(rename.input.text(), rename.input.cursor(), room);
    hits.record_text(
        inner,
        prefix_width,
        rename.input.text(),
        rename.input.cursor(),
        room,
    );
    let mut spans = prefix;
    spans.push(Span::styled(shown, Style::new().fg(FG)));
    Line::from(spans).render(inner, buf);
    let x = u16::try_from(prefix_width + before)
        .unwrap_or(u16::MAX)
        .min(inner.width.saturating_sub(1));
    Position::new(inner.x + x, inner.y)
}

/// The box's title for what it names.
fn title(target: RenameTarget) -> &'static str {
    match target {
        RenameTarget::Session(_) => " Rename Session ",
        RenameTarget::NewColony(_) => " New colony ",
        RenameTarget::Tab { .. } => " Rename Tab ",
        RenameTarget::Pane(_) => " Rename Pane ",
        RenameTarget::Agent(_) => " Rename Agent ",
        RenameTarget::NewSession { .. } => " New session ",
    }
}

#[cfg(test)]
mod tests {
    use orb_domain::feat::sidebar::state::{Rename, RenameTarget};
    use orb_domain::ids::{PaneId, ProjectId, SessionId};
    use orb_domain::{Focus, TextInput};
    use ratatui::buffer::Buffer;
    use ratatui::layout::{Position, Rect};

    use super::render;
    use crate::mouse::HitMap;
    use crate::sidebar::YELLOW;

    /// The rename box holding `text` drawn on a 100x10 screen.
    fn drawn(text: &str) -> (Buffer, Position) {
        drawn_for(RenameTarget::Session(SessionId(1)), text)
    }

    /// The name box for `target` holding `text` drawn on a 100x10 screen.
    fn drawn_for(target: RenameTarget, text: &str) -> (Buffer, Position) {
        let area = Rect::new(0, 0, 100, 10);
        let mut buf = Buffer::empty(area);
        let rename = Rename {
            target,
            input: TextInput::new(text),
            creating: false,
        };
        let cursor = render(&rename, area, &mut buf, &mut HitMap::default());
        (buf, cursor)
    }

    /// Row `y` of `buf` as text.
    fn row(buf: &Buffer, y: u16) -> String {
        (0..buf.area.width).map(|x| buf[(x, y)].symbol()).collect()
    }

    #[rstest::rstest]
    fn box_is_sixty_columns_centred_two_rows_from_the_top() {
        // Given a 100-column screen.
        // When drawing the rename box.
        let (buf, _) = drawn("Fix the sidebar");

        // Then its corners are at columns 20 and 79 of row 2.
        assert_eq!(
            (buf[(20, 2)].symbol(), buf[(79, 2)].symbol()),
            ("╭", "╮"),
            "the box's top corners"
        );
    }

    #[rstest::rstest]
    fn box_border_is_yellow() {
        // Given a 100-column screen.
        // When drawing the rename box.
        let (buf, _) = drawn("Fix the sidebar");

        // Then its border is yellow.
        assert_eq!(buf[(20, 3)].fg, YELLOW, "the box's left border");
    }

    #[rstest::rstest]
    #[case(RenameTarget::Session(SessionId(1)), " Rename Session ")]
    #[case(RenameTarget::Tab { owner: SessionId(1), tab: 0 }, " Rename Tab ")]
    #[case(RenameTarget::Pane(PaneId(1)), " Rename Pane ")]
    #[case(RenameTarget::Agent(PaneId(1)), " Rename Agent ")]
    #[case(RenameTarget::NewColony(ProjectId(1)), " New colony ")]
    #[case(
        RenameTarget::NewSession { project: ProjectId(1), return_to: Focus::Sidebar },
        " New session "
    )]
    fn box_is_titled_by_its_target(#[case] target: RenameTarget, #[case] title: &str) {
        // Given a 100-column screen.
        // When drawing the name box for the target.
        let (buf, _) = drawn_for(target, "Fix the sidebar");

        // Then its top border carries the target's title.
        assert!(
            row(&buf, 2).contains(title),
            "the box's title: {:?}",
            row(&buf, 2)
        );
    }

    #[rstest::rstest]
    fn box_shows_the_name_after_the_edit_icon() {
        // Given a 100-column screen.
        // When drawing the rename box holding "Fix the sidebar".
        let (buf, _) = drawn("Fix the sidebar");

        // Then its line is the icon, then the name.
        assert!(
            row(&buf, 3).contains(" \u{f044}  Fix the sidebar"),
            "the box's line: {:?}",
            row(&buf, 3)
        );
    }

    #[rstest::rstest]
    fn cursor_sits_after_the_name() {
        // Given a 100-column screen.
        // When drawing the rename box holding "Fix".
        let (_, cursor) = drawn("Fix");

        // Then the cursor is past the border, the icon's four columns and the
        // three letters.
        assert_eq!(cursor, Position::new(28, 3), "the cursor after the name");
    }

    #[rstest::rstest]
    fn long_name_keeps_the_cursor_in_the_box() {
        // Given a name wider than the box.
        // When drawing it.
        let (_, cursor) = drawn(&"x".repeat(80));

        // Then the cursor stays inside the right border.
        assert_eq!(cursor, Position::new(78, 3), "the cursor at the box's end");
    }

    #[rstest::rstest]
    fn hit_map_records_the_box() {
        // Given the rename box on a 100x10 screen.
        let area = Rect::new(0, 0, 100, 10);
        let rename = Rename {
            target: RenameTarget::Session(SessionId(1)),
            input: TextInput::new("Fix the sidebar"),
            creating: false,
        };
        let mut hits = HitMap::default();

        // When drawing it.
        render(&rename, area, &mut Buffer::empty(area), &mut hits);

        // Then its top-left corner is on the recorded box.
        assert!(
            hits.on_overlay(Position::new(20, 2)),
            "the box should be recorded from its top-left corner"
        );
    }

    #[rstest::rstest]
    fn hit_map_maps_the_name_to_its_graphemes() {
        // Given the rename box holding "Fix the sidebar" on a 100x10 screen.
        let area = Rect::new(0, 0, 100, 10);
        let rename = Rename {
            target: RenameTarget::Session(SessionId(1)),
            input: TextInput::new("Fix the sidebar"),
            creating: false,
        };
        let mut hits = HitMap::default();

        // When drawing it.
        let cursor = render(&rename, area, &mut Buffer::empty(area), &mut hits);

        // Then the column before the terminal cursor maps to the final "r".
        assert_eq!(
            hits.text_at(Position::new(cursor.x - 1, cursor.y)),
            Some(14),
            "the column before the cursor should be the last grapheme"
        );
    }
}
