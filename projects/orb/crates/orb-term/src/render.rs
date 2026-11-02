//! Draws the child's screen into orb's frame.
//!
//! Every visible cell of the emulated terminal becomes a ratatui cell with the
//! same character, colors, and attributes. Named colors stay palette indices so
//! the user's terminal theme applies. Selected text is drawn in reverse
//! video. The renderer also reports where the child's cursor is and which
//! shape the child asked for.

use std::iter::once;

use alacritty_terminal::event::EventListener;
use alacritty_terminal::index::Point;
use alacritty_terminal::term::Term;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::vte::ansi::{
    Color as AnsiColor, CursorShape, CursorStyle, NamedColor, Rgb,
};
use ratatui::buffer::Buffer;
use ratatui::crossterm::cursor::SetCursorStyle;
use ratatui::layout::{Position, Rect};
use ratatui::style::{Color, Modifier, Style};

const DIM_BLACK: usize = NamedColor::DimBlack as usize;
const DIM_WHITE: usize = NamedColor::DimWhite as usize;

/// Draws the child's screen, at its scroll offset and with the selection in
/// reverse video, into `area` of `buf`; returns where the cursor is, or
/// `None` when the child hid it or it's outside the area.
pub(crate) fn render_term<L>(term: &Term<L>, area: Rect, buf: &mut Buffer) -> Option<Position>
where
    L: EventListener,
{
    let content = term.renderable_content();
    let selection = content.selection;
    for indexed in content.display_iter {
        let cell = indexed.cell;
        if cell
            .flags
            .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
        {
            continue;
        }
        let Some(target) = screen_position(indexed.point, content.display_offset, area)
            .and_then(|position| buf.cell_mut(position))
        else {
            continue;
        };
        let c = if cell.c.is_control() { ' ' } else { cell.c };
        match cell.zerowidth() {
            Some(zerowidth) => {
                target.set_symbol(&once(c).chain(zerowidth.iter().copied()).collect::<String>())
            }
            None => target.set_char(c),
        };
        let selected = selection.is_some_and(|range| range.contains(indexed.point));
        target.set_style(
            Style::new()
                .fg(color(cell.fg))
                .bg(color(cell.bg))
                .add_modifier(modifiers(cell.flags, selected)),
        );
    }
    match content.cursor.shape {
        CursorShape::Hidden => None,
        _ => screen_position(content.cursor.point, content.display_offset, area),
    }
}

/// The outer terminal's cursor style for the shape and blinking the child
/// asked for.
pub(crate) fn cursor_style<L>(term: &Term<L>) -> SetCursorStyle
where
    L: EventListener,
{
    let CursorStyle { shape, blinking } = term.cursor_style();
    match (shape, blinking) {
        (CursorShape::Block | CursorShape::HollowBlock, true) => SetCursorStyle::BlinkingBlock,
        (CursorShape::Underline, true) => SetCursorStyle::BlinkingUnderScore,
        (CursorShape::Underline, false) => SetCursorStyle::SteadyUnderScore,
        (CursorShape::Beam, true) => SetCursorStyle::BlinkingBar,
        (CursorShape::Beam, false) => SetCursorStyle::SteadyBar,
        (CursorShape::Block | CursorShape::HollowBlock, false) | (CursorShape::Hidden, _) => {
            SetCursorStyle::SteadyBlock
        }
    }
}

/// Where grid `point` lands in `area`, or `None` when it falls outside.
fn screen_position(point: Point, display_offset: usize, area: Rect) -> Option<Position> {
    let row = u16::try_from(point.line.0 + display_offset as i32).ok()?;
    let col = u16::try_from(point.column.0).ok()?;
    (row < area.height && col < area.width).then(|| Position::new(area.x + col, area.y + row))
}

/// The ratatui color for a cell color: palette colors keep their index, the
/// terminal's default colors follow the outer terminal.
fn color(color: AnsiColor) -> Color {
    match color {
        AnsiColor::Spec(Rgb { r, g, b }) => Color::Rgb(r, g, b),
        AnsiColor::Indexed(index) => Color::Indexed(index),
        AnsiColor::Named(named) => match named as usize {
            index @ 0..=15 => Color::Indexed(index as u8),
            index @ DIM_BLACK..=DIM_WHITE => Color::Indexed((index - DIM_BLACK) as u8),
            _ => Color::Reset,
        },
    }
}

/// The ratatui modifiers for a cell's attributes, with reverse video toggled
/// for a selected cell.
fn modifiers(flags: Flags, selected: bool) -> Modifier {
    [
        (Flags::BOLD, Modifier::BOLD),
        (Flags::DIM, Modifier::DIM),
        (Flags::ITALIC, Modifier::ITALIC),
        (Flags::ALL_UNDERLINES, Modifier::UNDERLINED),
        (Flags::INVERSE, Modifier::REVERSED),
        (Flags::HIDDEN, Modifier::HIDDEN),
        (Flags::STRIKEOUT, Modifier::CROSSED_OUT),
    ]
    .into_iter()
    .filter(|(cell, _)| flags.intersects(*cell))
    .fold(Modifier::empty(), |mods, (_, modifier)| mods | modifier)
        ^ if selected {
            Modifier::REVERSED
        } else {
            Modifier::empty()
        }
}

#[cfg(test)]
mod tests {
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::index::{Column, Line, Point, Side};
    use alacritty_terminal::selection::{Selection, SelectionType};
    use alacritty_terminal::term::test::TermSize;
    use alacritty_terminal::term::{Config, Term};
    use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};
    use ratatui::buffer::{Buffer, Cell};
    use ratatui::crossterm::cursor::SetCursorStyle;
    use ratatui::layout::{Position, Rect};
    use ratatui::style::{Color, Modifier};

    use super::{cursor_style, render_term};

    /// The pane area most tests draw into: the top left of the buffer.
    const AREA: Rect = Rect::new(0, 0, 20, 5);

    /// A 20×5 terminal after the child wrote `output`.
    fn term_with(output: &str) -> Term<VoidListener> {
        let mut term = Term::new(Config::default(), &TermSize::new(20, 5), VoidListener);
        Processor::<StdSyncHandler>::new().advance(&mut term, output.as_bytes());
        term
    }

    /// `term` with its first row selected from column 0 up to, not
    /// including, column `end`.
    fn select_first_row(mut term: Term<VoidListener>, end: usize) -> Term<VoidListener> {
        let mut selection = Selection::new(
            SelectionType::Simple,
            Point::new(Line(0), Column(0)),
            Side::Left,
        );
        selection.update(Point::new(Line(0), Column(end)), Side::Left);
        term.selection = Some(selection);
        term
    }

    /// Whether cell `x` of row 0 is drawn in reverse video.
    fn reversed(buf: &Buffer, x: u16) -> bool {
        buf.cell((x, 0))
            .is_some_and(|cell| cell.modifier.contains(Modifier::REVERSED))
    }

    /// Draws `term` into `area` of a 30×10 buffer; returns the buffer and the
    /// reported cursor position.
    fn render(term: &Term<VoidListener>, area: Rect) -> (Buffer, Option<Position>) {
        let mut buf = Buffer::empty(Rect::new(0, 0, 30, 10));
        let cursor = render_term(term, area, &mut buf);
        (buf, cursor)
    }

    /// The symbols of row `y`, concatenated.
    fn row(buf: &Buffer, y: u16) -> String {
        (0..buf.area.width)
            .filter_map(|x| buf.cell((x, y)))
            .map(Cell::symbol)
            .collect()
    }

    #[rstest::rstest]
    #[case("\x1b[31mX", Color::Indexed(1), Color::Reset)]
    #[case("\x1b[38;5;200mX", Color::Indexed(200), Color::Reset)]
    #[case("\x1b[38;2;1;2;3mX", Color::Rgb(1, 2, 3), Color::Reset)]
    #[case("\x1b[41mX", Color::Reset, Color::Indexed(1))]
    #[case("X", Color::Reset, Color::Reset)]
    fn sgr_colors_map_to_ratatui_colors(
        #[case] output: &str,
        #[case] fg: Color,
        #[case] bg: Color,
    ) {
        // Given a child that wrote a colored character.
        let term = term_with(output);

        // When rendering its screen.
        let (buf, _) = render(&term, AREA);

        // Then the cell has the matching ratatui colors.
        assert_eq!(
            buf.cell((0, 0)).map(|cell| (cell.fg, cell.bg)),
            Some((fg, bg)),
            "colors for {}",
            output.escape_debug()
        );
    }

    #[rstest::rstest]
    #[case("1", Modifier::BOLD)]
    #[case("2", Modifier::DIM)]
    #[case("3", Modifier::ITALIC)]
    #[case("4", Modifier::UNDERLINED)]
    #[case("7", Modifier::REVERSED)]
    #[case("9", Modifier::CROSSED_OUT)]
    fn sgr_attributes_map_to_modifiers(#[case] sgr: &str, #[case] expected: Modifier) {
        // Given a child that wrote a character with an SGR attribute.
        let term = term_with(&format!("\x1b[{sgr}mX"));

        // When rendering its screen.
        let (buf, _) = render(&term, AREA);

        // Then the cell has the matching modifier.
        assert_eq!(
            buf.cell((0, 0)).map(|cell| cell.modifier),
            Some(expected),
            "modifier for SGR {sgr}"
        );
    }

    #[rstest::rstest]
    fn wide_character_renders_in_its_first_cell() {
        // Given a child that wrote a double-width character.
        let term = term_with("中");

        // When rendering its screen.
        let (buf, _) = render(&term, AREA);

        // Then the first cell holds the whole character.
        assert_eq!(
            buf.cell((0, 0)).map(Cell::symbol),
            Some("中"),
            "wide character should land in its first cell"
        );
    }

    #[rstest::rstest]
    fn cells_render_offset_by_area_origin() {
        // Given a child that wrote "hi".
        let term = term_with("hi");

        // When rendering into an area starting at (3, 2).
        let (buf, _) = render(&term, Rect::new(3, 2, 10, 3));

        // Then the text starts at the area's origin.
        assert!(
            row(&buf, 2).starts_with("   hi"),
            "text should start at column 3 of row 2"
        );
    }

    #[rstest::rstest]
    fn tab_cells_render_as_spaces() {
        // Given a child that wrote a tab between two characters.
        let term = term_with("a\tb");

        // When rendering its screen.
        let (buf, _) = render(&term, AREA);

        // Then no cell shows a raw tab.
        assert!(
            !row(&buf, 0).contains('\t'),
            "tab cells should render as spaces"
        );
    }

    #[rstest::rstest]
    fn visible_cursor_position_is_reported() {
        // Given a child that wrote "ab", leaving the cursor in column 2.
        let term = term_with("ab");

        // When rendering into an area starting at (1, 1).
        let (_, cursor) = render(&term, Rect::new(1, 1, 20, 5));

        // Then the cursor is reported in buffer coordinates.
        assert_eq!(
            cursor,
            Some(Position::new(3, 1)),
            "cursor should sit after \"ab\""
        );
    }

    #[rstest::rstest]
    fn hidden_cursor_is_not_reported() {
        // Given a child that hid the cursor.
        let term = term_with("\x1b[?25l");

        // When rendering its screen.
        let (_, cursor) = render(&term, AREA);

        // Then no cursor position is reported.
        assert_eq!(cursor, None, "hidden cursor should not be reported");
    }

    #[rstest::rstest]
    #[case("\x1b[6 q", SetCursorStyle::SteadyBar)]
    #[case("\x1b[2 q", SetCursorStyle::SteadyBlock)]
    #[case("\x1b[3 q", SetCursorStyle::BlinkingUnderScore)]
    fn cursor_style_follows_child_decscusr(#[case] output: &str, #[case] expected: SetCursorStyle) {
        // Given a child that set its cursor style with DECSCUSR.
        let term = term_with(output);

        // When reading the cursor style.
        let style = cursor_style(&term);

        // Then it maps to the matching outer-terminal style.
        assert_eq!(style, expected, "style for {}", output.escape_debug());
    }

    #[rstest::rstest]
    fn selected_cells_are_reversed() {
        // Given `abc` with `ab` selected.
        let term = select_first_row(term_with("abc"), 2);

        // When rendering its screen.
        let (buf, _) = render(&term, AREA);

        // Then `a` and `b` are reversed and `c` isn't.
        assert_eq!(
            [reversed(&buf, 0), reversed(&buf, 1), reversed(&buf, 2)],
            [true, true, false],
            "reverse video over the selection only"
        );
    }

    #[rstest::rstest]
    fn selected_inverse_cells_show_plain() {
        // Given inverse text `abc` with `ab` selected.
        let term = select_first_row(term_with("\x1b[7mabc"), 2);

        // When rendering its screen.
        let (buf, _) = render(&term, AREA);

        // Then the selected inverse cell is drawn without reverse video.
        assert!(
            !reversed(&buf, 0),
            "selection should flip inverse text back"
        );
    }
}
