//! The pane's terminal emulator: the child's screen, its terminal modes, and
//! the replies it expects.
//!
//! Output from the child updates the screen. Queries the child sends (device
//! attributes, kitty keyboard flags, mode reports, its size and cell size in
//! pixels, its colours, and the terminal's name, which is orb's own) are
//! answered straight back to the child, and clipboard copies are reported to
//! the caller. Size queries go unanswered while the cells' pixels are unknown,
//! and colour queries while the pane wasn't told its colours. The pane
//! holds a synchronized update itself, in the order the child wrote it: it
//! stays hidden until the child ends it, its text passes 2 MiB, or its
//! deadline passes and the caller flushes it. Kitty graphics commands are
//! kept out of the screen and handed to the pane's own image model, at the
//! cursor the text before them left; its answers go straight back to the
//! child. Images on the main screen scroll with the text, and the cursor
//! moves past a placed image as kitty moves it, unless the child asked it not
//! to (`C=1`). User input is encoded for the modes the child currently has on;
//! pixel mouse reports, and whether they work, are answered and sent as the
//! child asked.
//!
//! The screen keeps a history the wheel scrolls back through, and a text
//! selection the mouse drags out and copies. Key presses and pastes bring the
//! view back to the live screen and drop the selection. The screen and its
//! history can also be read out as plain text.

use std::io::Write;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::{ClipboardType, Config, Term, TermMode, viewport_to_point};
use alacritty_terminal::vte::ansi::{NamedColor, Processor, Rgb};
use ratatui::buffer::Buffer;
use ratatui::crossterm::cursor::SetCursorStyle;
use ratatui::crossterm::event::{
    KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEvent, MouseEventKind,
};
use ratatui::layout::{Position, Rect};
use ratatui::style::Color;

use crate::encode::{encode_focus, encode_key, encode_mouse, encode_paste};
use crate::graphics::{GraphicsFrame, PaneGraphics};
use crate::pane::{GraphicsSupport, PaneColors, PaneEvent, PaneSize};
use crate::render::{cursor_style, render_term};
use crate::splitter::{Piece, Splitter};

/// Lines of output a pane keeps above its screen.
const HISTORY: usize = 10_000;
/// Lines a pane with main-screen images keeps free in its history. Their
/// images move by the change in the history's size, which stops counting
/// once the history is full; trimming it this far before each feed keeps the
/// count, unless one feed scrolls more than this.
const TRACK_SLACK: usize = 512;
/// Lines one wheel notch scrolls, or arrow keys it sends.
const WHEEL_LINES: i32 = 3;
/// Presses on one cell closer together than this are a double or triple
/// click (the sidebar's double-click window).
const MULTI_CLICK: Duration = Duration::from_millis(500);
/// How often dragging past an edge may scroll the view by a line.
const EDGE_SCROLL: Duration = Duration::from_millis(10);
/// What ends a double-click's word: whitespace and brackets.
const WORD_ENDS: &str = " \t[]{}<>()";
/// How long a child's synchronized update is held before it shows anyway.
const SYNC_TIMEOUT: Duration = Duration::from_millis(150);
/// Held text past this shows at once, torn; graphics commands don't count.
const SYNC_TEXT_CAP: usize = 2 * 1024 * 1024;
/// What orb calls itself when a pane's child asks (XTVERSION); never kitty,
/// so programs keep their generic paths.
const VERSION_REPLY: &str = concat!("\x1bP>|orb(", env!("CARGO_PKG_VERSION"), ")\x1b\\");
/// The colour index the child asks for its default text colour (OSC 10).
const FOREGROUND: usize = NamedColor::Foreground as usize;
/// The colour index the child asks for its default background (OSC 11).
const BACKGROUND: usize = NamedColor::Background as usize;

/// Called with everything the pane reports to its owner.
pub(crate) type Notify = Arc<dyn Fn(PaneEvent) + Send + Sync>;

/// The child's input, shared by the emulator (user input) and its listener
/// (query replies).
type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// Receives what the terminal emits while it processes the child's output.
struct Listener {
    writer: SharedWriter,
    notify: Notify,
    /// The pane's current size, which the emulator keeps up to date.
    size: Arc<Mutex<PaneSize>>,
    /// What the child is told its colours are.
    colors: Option<PaneColors>,
}

impl Listener {
    /// The colour at `index` the child asked for, when the pane was told it
    /// as RGB.
    fn color(&self, index: usize) -> Option<Rgb> {
        let colors = self.colors?;
        let color = match index {
            FOREGROUND => Some(colors.foreground),
            BACKGROUND => Some(colors.background),
            index => colors.palette.get(index).copied().flatten(),
        };
        match color? {
            Color::Rgb(r, g, b) => Some(Rgb { r, g, b }),
            _ => None,
        }
    }
}

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        match event {
            Event::PtyWrite(reply) => write_to(&self.writer, reply.as_bytes()),
            Event::ClipboardStore(ClipboardType::Clipboard, text) => {
                (self.notify)(PaneEvent::Clipboard(text));
            }
            Event::TextAreaSizeRequest(format) => {
                let size = *lock(&self.size);
                if size.cell.width > 0 && size.cell.height > 0 {
                    let window = WindowSize {
                        num_lines: size.rows,
                        num_cols: size.cols,
                        cell_width: size.cell.width,
                        cell_height: size.cell.height,
                    };
                    write_to(&self.writer, format(window).as_bytes());
                }
            }
            Event::ColorRequest(index, format) => {
                if let Some(color) = self.color(index) {
                    write_to(&self.writer, format(color).as_bytes());
                }
            }
            _ => {}
        }
    }
}

/// The child's screen and modes, plus the writer that reaches its input.
pub(crate) struct Emulator {
    term: Term<Listener>,
    parser: Processor,
    writer: SharedWriter,
    /// The pane's current size, shared with the listener's size answers.
    size: Arc<Mutex<PaneSize>>,
    /// The last press that started a selection, for counting double and
    /// triple clicks.
    press: Option<Press>,
    /// When dragging past an edge last scrolled the view.
    edge_scrolled: Option<Instant>,
    /// Picks the sequences the pane handles itself out of the child's output.
    splitter: Splitter,
    /// The synchronized update being held, if any.
    hold: Option<Hold>,
    /// The child's kitty images.
    graphics: PaneGraphics,
    /// The main screen's history size when last seen, to count the lines it
    /// scrolled since.
    main_history: usize,
    /// Whether the child turned pixel mouse reports (1016) on.
    pixel_mouse: bool,
    /// The cell of the last mouse event sent on to the child, so motion
    /// within one cell reaches a child reporting cells once.
    last_cell: Option<Position>,
}

/// A synchronized update being held: the child's output in order, how much
/// of it is text, and when it shows anyway.
struct Hold {
    pieces: Vec<Piece<'static>>,
    text_bytes: usize,
    deadline: Instant,
}

impl Hold {
    /// An empty hold that shows at `deadline`.
    fn new(deadline: Instant) -> Self {
        Self {
            pieces: Vec::new(),
            text_bytes: 0,
            deadline,
        }
    }

    /// Keeps `piece` for later; true once the held text is past the cap.
    fn keep(&mut self, piece: Piece<'_>) -> bool {
        if let Piece::Text(text) = &piece {
            self.text_bytes += text.len();
        }
        self.pieces.push(piece.into_owned());
        self.text_bytes > SYNC_TEXT_CAP
    }
}

/// A press that started a selection: its cell, when, and how many quick
/// presses on that cell it ends (1 to 3).
#[derive(Clone, Copy)]
struct Press {
    cell: Point,
    at: Instant,
    count: u8,
}

impl Emulator {
    /// A blank screen of `size` whose replies and input go to `writer`, with
    /// images reaching the outer terminal as `graphics` says and colour
    /// queries answered from `colors`.
    pub(crate) fn new(
        size: PaneSize,
        writer: Box<dyn Write + Send>,
        notify: Notify,
        graphics: GraphicsSupport,
        colors: Option<PaneColors>,
    ) -> Self {
        let writer: SharedWriter = Arc::new(Mutex::new(writer));
        let config = Config {
            scrolling_history: HISTORY,
            semantic_escape_chars: WORD_ENDS.to_owned(),
            kitty_keyboard: true,
            ..Config::default()
        };
        let shared_size = Arc::new(Mutex::new(size));
        let listener = Listener {
            writer: writer.clone(),
            notify,
            size: shared_size.clone(),
            colors,
        };
        Self {
            term: Term::new(config, &size, listener),
            parser: Processor::new(),
            writer,
            size: shared_size,
            press: None,
            edge_scrolled: None,
            splitter: Splitter::default(),
            hold: None,
            graphics: PaneGraphics::new(graphics),
            main_history: 0,
            pixel_mouse: false,
            last_cell: None,
        }
    }

    /// Processes output from the child, holding what comes inside a
    /// synchronized update until it ends.
    pub(crate) fn feed(&mut self, bytes: &[u8]) {
        let now = Instant::now();
        for piece in self.splitter.split(bytes) {
            let Some(hold) = &mut self.hold else {
                self.apply(piece, now);
                continue;
            };
            match piece {
                Piece::SyncStart => hold.deadline = now + SYNC_TIMEOUT,
                Piece::SyncEnd => self.release(now),
                piece => {
                    if hold.keep(piece) {
                        self.release(now);
                    }
                }
            }
        }
    }

    /// Acts on one piece of the child's output that isn't held.
    fn apply(&mut self, piece: Piece<'_>, now: Instant) {
        match piece {
            Piece::Text(text) => self.advance(&text),
            Piece::SyncStart => self.hold = Some(Hold::new(now + SYNC_TIMEOUT)),
            // Ends an update the parser started from a combined form
            // (`CSI ? 2026 ; 1049 h`), which reaches it unchanged.
            Piece::SyncEnd => {
                if self.parser.sync_timeout().sync_timeout().is_some() {
                    self.parser.stop_sync(&mut self.term);
                }
            }
            Piece::Graphics(body) => {
                let cursor = self.term.grid().cursor.point;
                let column = u16::try_from(cursor.column.0).unwrap_or(u16::MAX);
                let mut replies = Vec::new();
                let covered = self.graphics.command(
                    &body,
                    cursor.line.0,
                    column,
                    self.alt_screen(),
                    lock(&self.size).cell,
                    &mut replies,
                );
                self.write(&replies);
                if let Some(covered) = covered {
                    self.move_past(cursor.column.0, covered);
                }
            }
            Piece::ClearedScreen => self.graphics.cleared_screen(self.alt_screen()),
            Piece::Reset => {
                self.graphics.reset();
                self.pixel_mouse = false;
            }
            // ponytail: the last 1016 set or reset wins; kitty also goes back to cells on a later 1006 set, which no known child sends after 1016.
            Piece::PixelMouse(on) => self.pixel_mouse = on,
            // Not recognised where images aren't offered (an agent's pane,
            // or orb outside kitty), the same answer the child got before.
            Piece::PixelMouseQuery => {
                let state = match (self.graphics.answers(), self.pixel_mouse) {
                    (false, _) => 0,
                    (true, true) => 1,
                    (true, false) => 2,
                };
                self.write(format!("\x1b[?1016;{state}$y").as_bytes());
            }
            Piece::CellSizeQuery => {
                let cell = lock(&self.size).cell;
                if cell.width > 0 && cell.height > 0 {
                    self.write(format!("\x1b[6;{};{}t", cell.height, cell.width).as_bytes());
                }
            }
            Piece::VersionQuery => self.write(VERSION_REPLY.as_bytes()),
        }
    }

    /// Feeds `bytes` to the parser. A switch of screens frees the alternate
    /// screen's images; on the main screen, placements move with the lines
    /// the feed scrolled into the history.
    fn advance(&mut self, bytes: &[u8]) {
        let alt = self.alt_screen();
        self.before_main_change();
        self.parser.advance(&mut self.term, bytes);
        // ponytail: a switch is seen only when one run of text ends on the
        // other screen; leaving and re-entering within one run keeps the
        // alternate screen's images until the next switch.
        if self.alt_screen() != alt {
            self.graphics.switched_screen();
        }
        self.after_main_change();
    }

    /// Moves the cursor, at `column`, past a placed image covering
    /// `columns` × `rows` cells as kitty does: down to the image's last row
    /// (scrolling at the bottom), then right of it, or to the next line's
    /// start when that is past the last column.
    fn move_past(&mut self, column: usize, (columns, rows): (u32, u32)) {
        let down =
            usize::try_from(rows.saturating_sub(1)).map_or(HISTORY, |down| down.min(HISTORY));
        let mut bytes = b"\n".repeat(down);
        let right = match usize::try_from(columns).unwrap_or(usize::MAX) {
            0 => Vec::new(),
            columns if column.saturating_add(columns) >= self.term.columns() => b"\r\n".to_vec(),
            columns => format!("\x1b[{columns}C").into_bytes(),
        };
        bytes.extend_from_slice(&right);
        self.advance(&bytes);
    }

    /// Before the main screen changes: a pane with main-screen placements
    /// trims its history to leave [`TRACK_SLACK`] lines free, and the
    /// history's size is noted.
    fn before_main_change(&mut self) {
        if self.alt_screen() {
            return;
        }
        if self.graphics.has_main_placements() && self.term.history_size() > HISTORY - TRACK_SLACK {
            let grid = self.term.grid_mut();
            grid.update_history(HISTORY - TRACK_SLACK);
            grid.update_history(HISTORY);
        }
        self.main_history = self.term.history_size();
    }

    /// After the main screen changed: its placements move by the lines it
    /// scrolled into its history, or are dropped when a full history lost
    /// the count.
    fn after_main_change(&mut self) {
        if self.alt_screen() {
            return;
        }
        let history = self.term.history_size();
        // ponytail: only the history's size is counted, so lines scrolled
        // inside a scroll region (DECSTBM) and a resize that reflows to a new
        // width leave placements where they were; count region scrolls and
        // reflow if a main-screen program with images ever needs it.
        if self.graphics.has_main_placements() {
            if history >= HISTORY {
                self.graphics.lost_scroll();
            } else {
                // Both sizes are at most HISTORY lines.
                let lines = i32::try_from(history).unwrap_or(i32::MAX)
                    - i32::try_from(self.main_history).unwrap_or(i32::MAX);
                self.graphics.scrolled(lines, history);
            }
        }
        self.main_history = history;
    }

    /// Whether the child is on its alternate screen.
    fn alt_screen(&self) -> bool {
        self.term.mode().contains(TermMode::ALT_SCREEN)
    }

    /// Takes the bytes the pane's images have waiting for the outer
    /// terminal.
    pub(crate) fn take_graphics_output(&mut self) -> Vec<u8> {
        self.graphics.take_out()
    }

    /// The outer id of every image the pane holds.
    pub(crate) fn live_images(&self) -> Vec<u32> {
        self.graphics.live_images()
    }

    /// The pane's image model's id, different for every pane ever made.
    pub(crate) fn graphics_instance(&self) -> u64 {
        self.graphics.instance()
    }

    /// Starts or stops telling the child that images work (see
    /// [`PaneGraphics::answer`]).
    pub(crate) fn answer_graphics(&mut self, on: bool) {
        self.graphics.answer(on);
    }

    /// Shows the held synchronized update, in the order the child wrote it.
    fn release(&mut self, now: Instant) {
        for piece in self.hold.take().map(|hold| hold.pieces).unwrap_or_default() {
            self.apply(piece, now);
        }
    }

    /// Reflows the screen to `size`.
    pub(crate) fn resize(&mut self, size: PaneSize) {
        *lock(&self.size) = size;
        self.before_main_change();
        self.term.resize(size);
        self.after_main_change();
    }

    /// When the pending synchronized update must be shown even if the child
    /// never ends it; `None` when no update is pending.
    pub(crate) fn sync_deadline(&self) -> Option<Instant> {
        let held = self.hold.as_ref().map(|hold| hold.deadline);
        held.into_iter()
            .chain(self.parser.sync_timeout().sync_timeout())
            .min()
    }

    /// Shows the pending synchronized update if its deadline is at or before
    /// `now`.
    pub(crate) fn flush_expired_sync(&mut self, now: Instant) {
        if self.hold.as_ref().is_some_and(|hold| hold.deadline <= now) {
            self.release(now);
        }
        if self
            .parser
            .sync_timeout()
            .sync_timeout()
            .is_some_and(|deadline| deadline <= now)
        {
            self.parser.stop_sync(&mut self.term);
        }
    }

    /// Sends `key` to the child. A press or repeat first returns the view to
    /// the bottom and clears the selection; a release leaves both alone.
    pub(crate) fn key(&mut self, key: &KeyEvent) {
        if key.kind != KeyEventKind::Release {
            self.settle_view();
        }
        self.write(&encode_key(key, *self.term.mode()));
    }

    /// Sends pasted `text` to the child, after returning the view to the
    /// bottom and clearing the selection.
    pub(crate) fn paste(&mut self, text: &str) {
        self.settle_view();
        self.write(&encode_paste(text, *self.term.mode()));
    }

    /// Input reaches the child: show its live screen without a selection.
    fn settle_view(&mut self) {
        self.term.selection = None;
        self.term.scroll_display(Scroll::Bottom);
    }

    /// Types `line` and Enter into the child as raw input, never as a
    /// bracketed paste, so a shell runs it.
    pub(crate) fn type_line(&self, line: &str) {
        self.write(format!("{line}\r").as_bytes());
    }

    /// Sends a mouse event over the pane drawn at `area` to the child;
    /// `pixel` is where it happened in the outer terminal's pixels, when it
    /// reports them. A child with pixel mouse on gets pane pixels, others get
    /// cells, and motion within one cell only once. A press clears the
    /// selection.
    pub(crate) fn mouse(&mut self, event: MouseEvent, area: Rect, pixel: Option<Position>) {
        if matches!(event.kind, MouseEventKind::Down(_)) {
            self.term.selection = None;
        }
        let pixel = {
            let cell = lock(&self.size).cell;
            pixel.filter(|_| self.pixel_mouse).map(|at| {
                Position::new(
                    at.x.saturating_sub(area.x.saturating_mul(cell.width)),
                    at.y.saturating_sub(area.y.saturating_mul(cell.height)),
                )
            })
        };
        let at = Position::new(event.column, event.row);
        let moved = matches!(event.kind, MouseEventKind::Moved | MouseEventKind::Drag(_));
        if moved && pixel.is_none() && self.last_cell == Some(at) {
            return;
        }
        self.last_cell = Some(at);
        self.write(&encode_mouse(event, area, *self.term.mode(), pixel));
    }

    /// Tells the child the pane gained or lost focus.
    pub(crate) fn focus(&self, focused: bool) {
        self.write(&encode_focus(focused, *self.term.mode()));
    }

    /// Whether the child asked for mouse reports.
    pub(crate) fn reads_mouse(&self) -> bool {
        self.term.mode().intersects(TermMode::MOUSE_MODE)
    }

    /// A wheel notch over the pane drawn at `area`: a wheel report while
    /// the child reads the mouse (at `pixel`, as [`Emulator::mouse`] takes
    /// it), else arrow keys on the alternate screen, else a scroll of the
    /// history.
    pub(crate) fn wheel(&mut self, event: MouseEvent, area: Rect, pixel: Option<Position>) {
        let up = match event.kind {
            MouseEventKind::ScrollUp => true,
            MouseEventKind::ScrollDown => false,
            _ => return,
        };
        if self.reads_mouse() {
            self.mouse(event, area, pixel);
        } else if self.alt_screen() {
            let code = if up { KeyCode::Up } else { KeyCode::Down };
            let arrow = KeyEvent::new(code, KeyModifiers::NONE);
            for _ in 0..WHEEL_LINES {
                self.key(&arrow);
            }
        } else {
            self.scroll(if up { WHEEL_LINES } else { -WHEEL_LINES });
        }
    }

    /// Moves the view `lines` into the history (down toward the live screen
    /// when negative).
    fn scroll(&mut self, lines: i32) {
        self.term.scroll_display(Scroll::Delta(lines));
    }

    /// Starts a selection at `at` in the pane drawn at `area`: a word on
    /// the second quick press on the same cell, its line on the third, else
    /// a plain selection that grows as the mouse drags.
    pub(crate) fn select_start(&mut self, at: Position, area: Rect, now: Instant) {
        let (cell, side) = self.cell(at, area);
        let count = match self.press {
            Some(last) if last.cell == cell && now.duration_since(last.at) < MULTI_CLICK => {
                last.count % 3 + 1
            }
            _ => 1,
        };
        self.press = Some(Press {
            cell,
            at: now,
            count,
        });
        let kind = match count {
            2 => SelectionType::Semantic,
            3 => SelectionType::Lines,
            _ => SelectionType::Simple,
        };
        self.term.selection = Some(Selection::new(kind, cell, side));
    }

    /// Extends the selection to `at`. Past the top or bottom edge of `area`
    /// the view first scrolls a line that way, at most every 10 ms.
    pub(crate) fn select_update(&mut self, at: Position, area: Rect, now: Instant) {
        let lines = match at.y {
            y if y < area.top() => 1,
            y if y >= area.bottom() => -1,
            _ => 0,
        };
        if lines != 0
            && self
                .edge_scrolled
                .is_none_or(|then| now.duration_since(then) >= EDGE_SCROLL)
        {
            self.scroll(lines);
            self.edge_scrolled = Some(now);
        }
        let (cell, side) = self.cell(at, area);
        if let Some(selection) = &mut self.term.selection {
            selection.update(cell, side);
        }
    }

    /// Ends the selection, which stays highlighted, and returns its text:
    /// lines joined by `\n`, no newline at the end. `None` when nothing is
    /// selected.
    pub(crate) fn select_finish(&mut self) -> Option<String> {
        self.edge_scrolled = None;
        let text = self.term.selection_to_string()?;
        let text = text.trim_end_matches('\n');
        (!text.is_empty()).then(|| text.to_owned())
    }

    /// The screen as plain text, after up to `history` lines of the history
    /// above it: soft-wrapped rows joined into one line, trailing blanks
    /// dropped from each line and from the end. The view's scroll position
    /// and the selection don't change it.
    pub(crate) fn text(&self, history: usize) -> String {
        let above = i32::try_from(history.min(self.term.history_size())).unwrap_or(0);
        let bottom = i32::try_from(self.term.screen_lines()).unwrap_or(1) - 1;
        let text = self.term.bounds_to_string(
            Point::new(Line(-above), Column(0)),
            Point::new(Line(bottom), self.term.last_column()),
        );
        text.lines()
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n")
            .trim_end()
            .to_owned()
    }

    /// The grid cell under `at` in the pane drawn at `area`, clamped into
    /// the pane, and the side of it a selection boundary takes: the left
    /// side, so the cell under a drag's end isn't included, except past the
    /// right edge, where the last column is.
    fn cell(&self, at: Position, area: Rect) -> (Point, Side) {
        let row =
            at.y.clamp(area.top(), area.bottom().saturating_sub(1).max(area.top())) - area.y;
        let (column, side) = match at.x {
            x if x >= area.right() => (area.width.saturating_sub(1), Side::Right),
            x => (x.saturating_sub(area.x), Side::Left),
        };
        let row = usize::from(row).min(self.term.screen_lines().saturating_sub(1));
        let column = usize::from(column).min(self.term.columns().saturating_sub(1));
        let viewport = Point::new(row, Column(column));
        (
            viewport_to_point(self.term.grid().display_offset(), viewport),
            side,
        )
    }

    /// Draws the screen into `area` of `buf`; returns the visible cursor's
    /// position.
    pub(crate) fn render(&self, area: Rect, buf: &mut Buffer) -> Option<Position> {
        render_term(&self.term, area, buf)
    }

    /// Draws the screen into `area` of `buf` and takes the pane's images
    /// for it: the bytes waiting for kitty and where its placements show,
    /// at the cell size the child was told. Returns the visible cursor's
    /// position and the images.
    pub(crate) fn render_with_graphics(
        &mut self,
        area: Rect,
        buf: &mut Buffer,
    ) -> (Option<Position>, GraphicsFrame) {
        let cursor = render_term(&self.term, area, buf);
        let cell = lock(&self.size).cell;
        let alt = self.alt_screen();
        let frame = self
            .graphics
            .frame(area, cell, self.term.grid().display_offset(), alt);
        (cursor, frame)
    }

    /// The cursor style the child asked for.
    pub(crate) fn cursor_style(&self) -> SetCursorStyle {
        cursor_style(&self.term)
    }

    fn write(&self, bytes: &[u8]) {
        write_to(&self.writer, bytes);
    }
}

/// Locks `mutex`, recovering the data if a previous holder panicked.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Writes `bytes` to the child's input. A child that stopped reading is not
/// an error the pane can act on, so write failures are dropped.
fn write_to(writer: &SharedWriter, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    let mut writer = lock(writer);
    let _ = writer.write_all(bytes).and_then(|()| writer.flush());
}

#[cfg(test)]
mod tests {
    use std::io::{self, Write};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use ratatui::buffer::{Buffer, Cell};
    use ratatui::crossterm::event::{
        KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    };
    use ratatui::layout::{Position, Rect};
    use ratatui::style::{Color, Modifier};

    use super::{Emulator, lock};
    use crate::pane::{CellSize, GraphicsSupport, PaneColors, PaneEvent, PaneSize};

    /// An in-memory child input that tests can read back.
    #[derive(Clone, Default)]
    struct SharedBuf(Arc<Mutex<Vec<u8>>>);

    impl SharedBuf {
        fn contents(&self) -> Vec<u8> {
            lock(&self.0).clone()
        }
    }

    impl Write for SharedBuf {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            lock(&self.0).extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// A 20×5 emulator, what it wrote to the child, and what it reported.
    fn emulator() -> (Emulator, SharedBuf, Arc<Mutex<Vec<PaneEvent>>>) {
        emulator_in(GraphicsSupport::None, CellSize::default(), None)
    }

    /// A 20×5 emulator with cells of 10×20 pixels in a kitty that keeps
    /// images in memory only, and what it wrote to the child.
    fn kitty_emulator() -> (Emulator, SharedBuf) {
        let cell = CellSize {
            width: 10,
            height: 20,
        };
        let (emulator, input, _) =
            emulator_in(GraphicsSupport::Kitty { transient: true }, cell, None);
        (emulator, input)
    }

    /// A 20×5 emulator told [`colors`], and what it wrote to the child.
    fn colored_emulator() -> (Emulator, SharedBuf) {
        let (emulator, input, _) =
            emulator_in(GraphicsSupport::None, CellSize::default(), Some(colors()));
        (emulator, input)
    }

    /// Test colours: palette entry 1 unknown, 15 apart from the rest.
    fn colors() -> PaneColors {
        PaneColors {
            foreground: Color::Rgb(0xc8, 0xd3, 0xf5),
            background: Color::Rgb(0x22, 0x24, 0x36),
            palette: std::array::from_fn(|index| match index {
                1 => None,
                15 => Some(Color::Rgb(0xff, 0xee, 0xdd)),
                _ => Some(Color::Rgb(0x11, 0x22, 0x33)),
            }),
        }
    }

    /// A 20×5 emulator with cells of `cell` pixels whose images reach the
    /// outer terminal as `graphics` says and that was told `colors`, what it
    /// wrote to the child, and what it reported.
    fn emulator_in(
        graphics: GraphicsSupport,
        cell: CellSize,
        colors: Option<PaneColors>,
    ) -> (Emulator, SharedBuf, Arc<Mutex<Vec<PaneEvent>>>) {
        let input = SharedBuf::default();
        let events = Arc::new(Mutex::new(Vec::new()));
        let notify = {
            let events = events.clone();
            Arc::new(move |event| lock(&events).push(event))
        };
        let size = PaneSize {
            cols: 20,
            rows: 5,
            cell,
        };
        (
            Emulator::new(size, Box::new(input.clone()), notify, graphics, colors),
            input,
            events,
        )
    }

    /// Where the 20×5 emulator is drawn: at the top left of the frame.
    const AREA: Rect = Rect::new(0, 0, 20, 5);

    /// Where edge-scroll tests draw the emulator: one row down, so there is
    /// a row above it.
    const LOWERED: Rect = Rect::new(0, 1, 20, 5);

    /// The emulator's screen drawn into [`AREA`].
    fn screen(emulator: &Emulator) -> Buffer {
        let mut buf = Buffer::empty(AREA);
        emulator.render(AREA, &mut buf);
        buf
    }

    /// An image of 10×20 pixels the child sends and places at its cursor.
    const PLACED_IMAGE: &[u8] = b"\x1b_Ga=T,f=32,s=10,v=20,t=s,i=1,p=1,C=1,q=2;bmFtZQ==\x1b\\";

    /// The emulator drawn into [`AREA`] with its images: the first row's
    /// symbols without trailing blanks, and how many placements show.
    fn shown(emulator: &mut Emulator) -> (String, usize) {
        let mut buf = Buffer::empty(AREA);
        let (_, frame) = emulator.render_with_graphics(AREA, &mut buf);
        let row: String = (0..AREA.width)
            .filter_map(|x| buf.cell((x, 0)))
            .map(Cell::symbol)
            .collect();
        (row.trim_end().to_owned(), frame.visible.len())
    }

    /// The symbols of the emulator's row `y`, concatenated, without
    /// trailing blanks.
    fn row(emulator: &Emulator, y: u16) -> String {
        let buf = screen(emulator);
        let row: String = (0..AREA.width)
            .filter_map(|x| buf.cell((x, y)))
            .map(Cell::symbol)
            .collect();
        row.trim_end().to_owned()
    }

    /// The symbols of the emulator's first row, concatenated.
    fn first_row(emulator: &Emulator) -> String {
        row(emulator, 0)
    }

    /// Whether the cells `x` of row `y` are all drawn in reverse video.
    fn reversed(emulator: &Emulator, xs: std::ops::Range<u16>, y: u16) -> bool {
        let buf = screen(emulator);
        xs.into_iter().all(|x| {
            buf.cell((x, y))
                .is_some_and(|cell| cell.modifier.contains(Modifier::REVERSED))
        })
    }

    /// A child that printed `line1` to `line9`: the screen shows `line5`
    /// to `line9`, the history holds the rest.
    fn nine_lines() -> (Emulator, SharedBuf) {
        let (mut emulator, input, _) = emulator();
        let lines: Vec<String> = (1..=9).map(|n| format!("line{n}")).collect();
        emulator.feed(lines.join("\r\n").as_bytes());
        (emulator, input)
    }

    /// A wheel notch at the top left of the pane.
    fn wheel(kind: MouseEventKind) -> MouseEvent {
        MouseEvent {
            kind,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        }
    }

    /// One wheel notch up over the pane drawn at [`AREA`].
    fn wheel_up(emulator: &mut Emulator) {
        emulator.wheel(wheel(MouseEventKind::ScrollUp), AREA, None);
    }

    /// A drag from `from` to `to` in the pane drawn at [`AREA`].
    fn drag(emulator: &mut Emulator, from: (u16, u16), to: (u16, u16)) {
        let now = Instant::now();
        emulator.select_start(Position::new(from.0, from.1), AREA, now);
        emulator.select_update(Position::new(to.0, to.1), AREA, now);
    }

    /// `count` quick presses on `at`, 100 ms apart.
    fn clicks(emulator: &mut Emulator, at: (u16, u16), count: u32) {
        let start = Instant::now();
        for n in 0..count {
            let now = start + Duration::from_millis(100) * n;
            emulator.select_start(Position::new(at.0, at.1), AREA, now);
        }
    }

    #[rstest::rstest]
    fn da1_query_is_answered() {
        // Given a fresh emulator.
        let (mut emulator, input, _) = emulator();

        // When the child asks for the primary device attributes.
        emulator.feed(b"\x1b[c");

        // Then the child receives a VT102 reply.
        assert_eq!(input.contents(), b"\x1b[?6c", "DA1 reply");
    }

    #[rstest::rstest]
    fn typed_line_reaches_the_child_with_enter() {
        // Given a fresh emulator.
        let (emulator, input, _) = emulator();

        // When typing a resume command.
        emulator.type_line("claude --resume aa");

        // Then the child receives the line and a carriage return.
        assert_eq!(input.contents(), b"claude --resume aa\r", "typed line");
    }

    #[rstest::rstest]
    fn typed_line_ignores_bracketed_paste() {
        // Given a child that turned bracketed paste on.
        let (mut emulator, input, _) = emulator();
        emulator.feed(b"\x1b[?2004h");

        // When typing a resume command.
        emulator.type_line("claude --resume aa");

        // Then the line reaches the child unwrapped.
        assert_eq!(input.contents(), b"claude --resume aa\r", "unwrapped line");
    }

    #[rstest::rstest]
    fn kitty_keyboard_query_is_answered() {
        // Given a fresh emulator.
        let (mut emulator, input, _) = emulator();

        // When the child asks for the kitty keyboard flags.
        emulator.feed(b"\x1b[?u");

        // Then the child learns kitty is supported with no flags set.
        assert_eq!(input.contents(), b"\x1b[?0u", "kitty flags reply");
    }

    #[rstest::rstest]
    fn child_kitty_push_switches_keys_to_kitty_encoding() {
        // Given a child that pushed kitty flags 5 (disambiguate + alternate keys).
        let (mut emulator, input, _) = emulator();
        emulator.feed(b"\x1b[>5u");

        // When the user presses Shift+Enter.
        emulator.key(&KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT));

        // Then the child receives the kitty encoding.
        assert!(
            input.contents().ends_with(b"\x1b[13;2u"),
            "Shift+Enter should be kitty-encoded, got {:?}",
            String::from_utf8_lossy(&input.contents())
        );
    }

    #[rstest::rstest]
    fn child_with_terminal_browsers_flags_gets_typed_text() {
        // Given a child that pushed kitty flags 27 (disambiguate, event types,
        // every key as an escape code, associated text).
        let (mut emulator, input, _) = emulator();
        emulator.feed(b"\x1b[>27u");

        // When the user types `a`.
        emulator.key(&KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE));

        // Then the child receives the key with the text it types.
        assert!(
            input.contents().ends_with(b"\x1b[97;1;97u"),
            "`a` should carry its text, got {:?}",
            String::from_utf8_lossy(&input.contents())
        );
    }

    #[rstest::rstest]
    fn synchronized_text_is_hidden_until_the_update_ends() {
        // Given a fresh emulator.
        let (mut emulator, _, _) = emulator();

        // When the child starts a synchronized update and writes text.
        emulator.feed(b"\x1b[?2026hhi");

        // Then the text isn't on screen yet.
        assert!(
            !first_row(&emulator).contains("hi"),
            "text inside an open synchronized update should be hidden"
        );
    }

    #[rstest::rstest]
    fn synchronized_text_appears_once_the_deadline_passes() {
        // Given a synchronized update the child never ends.
        let (mut emulator, _, _) = emulator();
        emulator.feed(b"\x1b[?2026hhi");

        // When flushing well after its deadline.
        emulator.flush_expired_sync(Instant::now() + Duration::from_secs(1));

        // Then the text is on screen.
        assert!(
            first_row(&emulator).contains("hi"),
            "an expired synchronized update should be shown"
        );
    }

    #[rstest::rstest]
    fn synchronized_text_shows_once_the_update_ends() {
        // Given a synchronized update holding text.
        let (mut emulator, _, _) = emulator();
        emulator.feed(b"\x1b[?2026hhi");

        // When the child ends the update.
        emulator.feed(b"\x1b[?2026l");

        // Then the text is on screen.
        assert!(
            first_row(&emulator).contains("hi"),
            "an ended synchronized update should be shown"
        );
    }

    #[rstest::rstest]
    fn nested_sync_start_moves_the_deadline() {
        // Given a synchronized update started a moment ago.
        let (mut emulator, _, _) = emulator();
        emulator.feed(b"\x1b[?2026h");
        let first = emulator.sync_deadline();
        std::thread::sleep(Duration::from_millis(5));

        // When the child starts another one inside it.
        emulator.feed(b"\x1b[?2026h");

        // Then the update shows later than first planned.
        assert!(
            emulator.sync_deadline() > first,
            "a nested start should move the deadline on"
        );
    }

    #[rstest::rstest]
    fn held_text_past_two_mib_shows_without_the_end() {
        // Given a synchronized update holding text.
        let (mut emulator, _, _) = emulator();
        emulator.feed(b"\x1b[?2026hhi");

        // When more than 2 MiB of further text arrives without an end.
        emulator.feed(&vec![b'\r'; 2 * 1024 * 1024]);

        // Then the text is on screen.
        assert!(
            first_row(&emulator).contains("hi"),
            "an oversized synchronized update should be shown"
        );
    }

    #[rstest::rstest]
    fn combined_sync_start_ends_on_the_plain_end() {
        // Given a synchronized update started together with another mode.
        let (mut emulator, _, _) = emulator();
        emulator.feed(b"\x1b[?7;2026hhi");

        // When the child ends it with the plain end.
        emulator.feed(b"\x1b[?2026l");

        // Then the text is on screen.
        assert!(
            first_row(&emulator).contains("hi"),
            "the plain end should end a combined start"
        );
    }

    #[rstest::rstest]
    fn clipboard_write_is_reported() {
        // Given a fresh emulator.
        let (mut emulator, _, events) = emulator();

        // When the child copies "hello" to the clipboard with OSC 52.
        emulator.feed(b"\x1b]52;c;aGVsbG8=\x07");

        // Then the copy is reported.
        assert_eq!(
            *lock(&events),
            [PaneEvent::Clipboard("hello".to_owned())],
            "OSC 52 copy should be reported"
        );
    }

    #[rstest::rstest]
    fn scrolling_up_shows_earlier_output() {
        // Given a shell that printed nine lines into a five-row pane.
        let (mut emulator, _) = nine_lines();

        // When one wheel notch scrolls up.
        wheel_up(&mut emulator);

        // Then the top row shows the line three above the screen's first.
        assert_eq!(row(&emulator, 0), "line2", "top row after one notch up");
    }

    #[rstest::rstest]
    fn history_keeps_the_last_ten_thousand_lines() {
        // Given a shell that printed 10 010 numbered lines.
        let (mut emulator, _, _) = emulator();
        let lines: Vec<String> = (1..=10_010).map(|n| n.to_string()).collect();
        emulator.feed(lines.join("\r\n").as_bytes());

        // When scrolling as far back as the history goes.
        emulator.scroll(20_000);

        // Then the oldest line kept is the one 10 000 above the screen.
        assert_eq!(row(&emulator, 0), "6", "oldest line in the history");
    }

    #[rstest::rstest]
    fn key_returns_the_view_to_the_bottom() {
        // Given a pane scrolled back into its history.
        let (mut emulator, _) = nine_lines();
        wheel_up(&mut emulator);

        // When the user types a key.
        emulator.key(&KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE));

        // Then the live screen is shown again.
        assert_eq!(row(&emulator, 0), "line5", "top row of the live screen");
    }

    #[rstest::rstest]
    #[case::mouse_tracking("\x1b[?1000h\x1b[?1006h", "\x1b[<64;1;1M")]
    #[case::alternate_screen("\x1b[?1049h", "\x1b[A\x1b[A\x1b[A")]
    #[case::alternate_screen_cursor_keys("\x1b[?1049h\x1b[?1h", "\x1bOA\x1bOA\x1bOA")]
    fn wheel_reaches_the_child_by_its_modes(#[case] modes: &str, #[case] expected: &str) {
        // Given a child that switched on `modes`.
        let (mut emulator, input, _) = emulator();
        emulator.feed(modes.as_bytes());

        // When one wheel notch scrolls up over the pane.
        wheel_up(&mut emulator);

        // Then the child receives the input those modes call for.
        assert_eq!(
            String::from_utf8_lossy(&input.contents()),
            expected,
            "wheel input for {}",
            modes.escape_debug()
        );
    }

    #[rstest::rstest]
    fn wheel_on_the_main_screen_writes_nothing_to_the_child() {
        // Given a shell on the main screen that doesn't read the mouse.
        let (mut emulator, input) = nine_lines();

        // When one wheel notch scrolls up over the pane.
        wheel_up(&mut emulator);

        // Then the child receives nothing.
        assert!(input.contents().is_empty(), "the wheel should only scroll");
    }

    #[rstest::rstest]
    #[case::clicks("\x1b[?1000h", true)]
    #[case::drags("\x1b[?1002h", true)]
    #[case::motion("\x1b[?1003h", true)]
    #[case::nothing("", false)]
    fn child_reads_the_mouse_after_asking(#[case] modes: &str, #[case] expected: bool) {
        // Given a child that switched on `modes`.
        let (mut emulator, _, _) = emulator();
        emulator.feed(modes.as_bytes());

        // When asking whether it reads the mouse.
        let reads = emulator.reads_mouse();

        // Then the answer follows its mouse tracking mode.
        assert_eq!(
            reads,
            expected,
            "reads the mouse after {}",
            modes.escape_debug()
        );
    }

    #[rstest::rstest]
    fn drag_over_two_lines_copies_their_text() {
        // Given a child that printed two lines.
        let (mut emulator, _, _) = emulator();
        emulator.feed(b"one\r\ntwo");

        // When dragging from the first line's start past the second's end.
        drag(&mut emulator, (0, 0), (3, 1));
        let text = emulator.select_finish();

        // Then both lines are copied, joined by a newline.
        assert_eq!(text.as_deref(), Some("one\ntwo"), "copied text");
    }

    #[rstest::rstest]
    fn drag_while_scrolled_back_copies_the_scrolled_lines() {
        // Given a pane scrolled back so its top row shows `line2`.
        let (mut emulator, _) = nine_lines();
        wheel_up(&mut emulator);

        // When dragging over the top row.
        drag(&mut emulator, (0, 0), (5, 0));
        let text = emulator.select_finish();

        // Then the history line shown there is copied.
        assert_eq!(text.as_deref(), Some("line2"), "copied text");
    }

    #[rstest::rstest]
    fn double_click_copies_the_word() {
        // Given a child that printed three words.
        let (mut emulator, _, _) = emulator();
        emulator.feed(b"foo bar baz");

        // When double-clicking inside the middle word.
        clicks(&mut emulator, (5, 0), 2);
        let text = emulator.select_finish();

        // Then that word is copied.
        assert_eq!(text.as_deref(), Some("bar"), "copied word");
    }

    #[rstest::rstest]
    fn triple_click_copies_the_line() {
        // Given a child that printed three words.
        let (mut emulator, _, _) = emulator();
        emulator.feed(b"foo bar baz");

        // When triple-clicking inside the middle word.
        clicks(&mut emulator, (5, 0), 3);
        let text = emulator.select_finish();

        // Then the whole line is copied.
        assert_eq!(text.as_deref(), Some("foo bar baz"), "copied line");
    }

    #[rstest::rstest]
    fn fourth_quick_click_starts_a_plain_selection() {
        // Given a child that printed three words.
        let (mut emulator, _, _) = emulator();
        emulator.feed(b"foo bar baz");

        // When clicking four times quickly on one cell.
        clicks(&mut emulator, (5, 0), 4);
        let text = emulator.select_finish();

        // Then nothing is selected, as after a single click.
        assert_eq!(text, None, "a fourth click starts over");
    }

    #[rstest::rstest]
    fn click_without_drag_copies_nothing() {
        // Given a child that printed three words.
        let (mut emulator, _, _) = emulator();
        emulator.feed(b"foo bar baz");

        // When clicking once and releasing without moving.
        clicks(&mut emulator, (5, 0), 1);
        let text = emulator.select_finish();

        // Then there is nothing to copy.
        assert_eq!(text, None, "a click selects nothing");
    }

    #[rstest::rstest]
    fn dragging_above_the_top_edge_scrolls_into_history() {
        // Given a selection started on the pane's first row.
        let (mut emulator, _) = nine_lines();
        let now = Instant::now();
        emulator.select_start(Position::new(0, 1), LOWERED, now);

        // When the drag moves above the pane.
        emulator.select_update(Position::new(0, 0), LOWERED, now);

        // Then the view scrolls one line into the history.
        assert_eq!(row(&emulator, 0), "line4", "top row after the edge scroll");
    }

    #[rstest::rstest]
    fn dragging_below_the_bottom_edge_scrolls_toward_the_live_screen() {
        // Given a pane scrolled back three lines, selecting from its last row.
        let (mut emulator, _) = nine_lines();
        emulator.wheel(wheel(MouseEventKind::ScrollUp), LOWERED, None);
        let now = Instant::now();
        emulator.select_start(Position::new(0, 5), LOWERED, now);

        // When the drag moves below the pane.
        emulator.select_update(Position::new(0, 6), LOWERED, now);

        // Then the view scrolls one line back toward the live screen.
        assert_eq!(row(&emulator, 0), "line3", "top row after the edge scroll");
    }

    #[rstest::rstest]
    fn edge_scroll_waits_between_lines() {
        // Given a drag that just scrolled the view past the top edge.
        let (mut emulator, _) = nine_lines();
        let now = Instant::now();
        emulator.select_start(Position::new(0, 1), LOWERED, now);
        emulator.select_update(Position::new(0, 0), LOWERED, now);

        // When the drag moves above the pane again at the same instant.
        emulator.select_update(Position::new(1, 0), LOWERED, now);

        // Then the view doesn't scroll a second line.
        assert_eq!(row(&emulator, 0), "line4", "top row after two quick moves");
    }

    #[rstest::rstest]
    fn key_clears_the_selection() {
        // Given a selection over `one`.
        let (mut emulator, _, _) = emulator();
        emulator.feed(b"one");
        drag(&mut emulator, (0, 0), (3, 0));

        // When the user types a key.
        emulator.key(&KeyEvent::new(KeyCode::Char('a'), KeyModifiers::NONE));

        // Then `one` is no longer highlighted.
        assert!(
            !reversed(&emulator, 0..3, 0),
            "the key should clear the selection"
        );
    }

    #[rstest::rstest]
    fn key_release_keeps_the_selection() {
        // Given a selection over `one`.
        let (mut emulator, _, _) = emulator();
        emulator.feed(b"one");
        drag(&mut emulator, (0, 0), (3, 0));

        // When a key is released.
        emulator.key(&KeyEvent::new_with_kind(
            KeyCode::Char('a'),
            KeyModifiers::NONE,
            KeyEventKind::Release,
        ));

        // Then `one` is still highlighted.
        assert!(
            reversed(&emulator, 0..3, 0),
            "a release should leave the selection"
        );
    }

    #[rstest::rstest]
    fn new_press_clears_the_old_selection() {
        // Given a selection over `one`.
        let (mut emulator, _, _) = emulator();
        emulator.feed(b"one two");
        drag(&mut emulator, (0, 0), (3, 0));

        // When a new press lands elsewhere in the pane.
        emulator.select_start(Position::new(10, 2), AREA, Instant::now());

        // Then `one` is no longer highlighted.
        assert!(
            !reversed(&emulator, 0..3, 0),
            "the press should replace the selection"
        );
    }

    #[rstest::rstest]
    fn finished_selection_stays_highlighted() {
        // Given a selection over `one`.
        let (mut emulator, _, _) = emulator();
        emulator.feed(b"one");
        drag(&mut emulator, (0, 0), (3, 0));

        // When the selection ends.
        emulator.select_finish();

        // Then `one` is still highlighted.
        assert!(
            reversed(&emulator, 0..3, 0),
            "the selection should stay drawn"
        );
    }

    #[rstest::rstest]
    fn text_is_the_screen_as_plain_text() {
        // Given a child that printed `line1` to `line9` on a 5-row screen.
        let (emulator, _) = nine_lines();

        // When reading the text with no history.
        let text = emulator.text(0);

        // Then it is the five lines on screen.
        assert_eq!(
            text, "line5\nline6\nline7\nline8\nline9",
            "the text is what the screen shows"
        );
    }

    #[rstest::rstest]
    #[case::two_lines(2, 3)]
    #[case::more_than_kept(100, 1)]
    fn text_adds_the_history_asked_for(#[case] history: usize, #[case] first: usize) {
        // Given a child that printed `line1` to `line9` on a 5-row screen.
        let (emulator, _) = nine_lines();

        // When reading the text with `history` lines of history.
        let text = emulator.text(history);

        // Then it starts that far back, capped at what's kept, and runs to
        // the bottom of the screen.
        let expected = (first..=9)
            .map(|n| format!("line{n}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(text, expected, "history lines come before the screen");
    }

    #[rstest::rstest]
    fn text_joins_a_soft_wrapped_row() {
        // Given 30 `a`s printed on a 20-column screen, wrapping once.
        let (mut emulator, _, _) = emulator();
        let line = "a".repeat(30);
        emulator.feed(line.as_bytes());

        // When reading the text.
        let text = emulator.text(0);

        // Then the wrapped row reads as one line.
        assert_eq!(text, line, "a soft wrap isn't a line break");
    }

    #[rstest::rstest]
    fn text_drops_trailing_blank_rows() {
        // Given a child that printed `hi` and nothing else.
        let (mut emulator, _, _) = emulator();
        emulator.feed(b"hi");

        // When reading the text.
        let text = emulator.text(0);

        // Then the blank rows below it are gone.
        assert_eq!(text, "hi", "trailing blanks are dropped");
    }

    #[rstest::rstest]
    fn direct_graphics_query_is_answered_ok() {
        // Given a pane in kitty.
        let (mut emulator, input) = kitty_emulator();

        // When the child asks whether direct images work.
        emulator.feed(b"\x1b_Ga=q,t=d,i=7,s=1,v=1,f=24;AAAA\x1b\\");

        // Then it hears OK.
        assert_eq!(
            String::from_utf8_lossy(&input.contents()),
            "\x1b_Gi=7;OK\x1b\\",
            "graphics query reply"
        );
    }

    #[rstest::rstest]
    fn graphics_query_for_other_media_gets_an_error() {
        // Given a pane in kitty.
        let (mut emulator, input) = kitty_emulator();

        // When the child asks whether shared-memory images work.
        emulator.feed(b"\x1b_Ga=q,t=s,i=7,s=1,v=1,f=24;bmFtZQ==\x1b\\");

        // Then it hears an error.
        assert_eq!(
            String::from_utf8_lossy(&input.contents()),
            "\x1b_Gi=7;EINVAL:orb answers only direct queries\x1b\\",
            "shared-memory query reply"
        );
    }

    #[rstest::rstest]
    fn graphics_query_without_kitty_gets_an_error() {
        // Given a pane whose outer terminal shows no images.
        let (mut emulator, input, _) = emulator();

        // When the child asks whether direct images work.
        emulator.feed(b"\x1b_Ga=q,t=d,i=7,s=1,v=1,f=24;AAAA\x1b\\");

        // Then it hears an error.
        assert_eq!(
            String::from_utf8_lossy(&input.contents()),
            "\x1b_Gi=7;EINVAL:no graphics\x1b\\",
            "graphics query reply without kitty"
        );
    }

    #[rstest::rstest]
    fn graphics_query_is_refused_while_answers_are_off() {
        // Given a pane in kitty that stopped answering image questions.
        let (mut emulator, input) = kitty_emulator();
        emulator.answer_graphics(false);

        // When the child asks whether direct images work.
        emulator.feed(b"\x1b_Ga=q,t=d,i=7,s=1,v=1,f=24;AAAA\x1b\\");

        // Then it hears that there are no graphics.
        assert_eq!(
            String::from_utf8_lossy(&input.contents()),
            "\x1b_Gi=7;EINVAL:no graphics\x1b\\",
            "graphics query reply while answers are off"
        );
    }

    #[rstest::rstest]
    fn transmit_is_dropped_while_answers_are_off() {
        // Given a pane in kitty that stopped answering image questions.
        let (mut emulator, _) = kitty_emulator();
        emulator.answer_graphics(false);

        // When the child sends and places an image.
        emulator.feed(PLACED_IMAGE);

        // Then nothing waits for kitty.
        assert_eq!(
            String::from_utf8_lossy(&emulator.take_graphics_output()),
            "",
            "an image sent while answers are off stays out of kitty"
        );
    }

    #[rstest::rstest]
    fn transmit_that_asked_gets_an_ok_reply() {
        // Given a pane in kitty.
        let (mut emulator, input) = kitty_emulator();

        // When the child transmits image 5 without silencing replies.
        emulator.feed(b"\x1b_Ga=t,f=24,s=1,v=1,i=5;AAAA\x1b\\");

        // Then it hears OK for image 5.
        assert_eq!(
            String::from_utf8_lossy(&input.contents()),
            "\x1b_Gi=5;OK\x1b\\",
            "transmit reply"
        );
    }

    #[rstest::rstest]
    fn leaving_the_alternate_screen_frees_its_images() {
        // Given a child that sent an image on the alternate screen.
        let (mut emulator, _) = kitty_emulator();
        emulator.feed(b"\x1b[?1049h\x1b_Ga=t,f=24,s=1,v=1,i=1,q=2;AAAA\x1b\\");

        // When it leaves the alternate screen.
        emulator.feed(b"\x1b[?1049l");

        // Then the pane holds no images.
        assert!(
            emulator.live_images().is_empty(),
            "alternate-screen images should be freed"
        );
    }

    #[rstest::rstest]
    fn clearing_the_screen_frees_its_images() {
        // Given a child that placed an image on the main screen.
        let (mut emulator, _) = kitty_emulator();
        emulator.feed(b"\x1b_Ga=T,f=24,s=1,v=1,i=1,q=2;AAAA\x1b\\");

        // When it clears the screen.
        emulator.feed(b"\x1b[2J");

        // Then the pane holds no images.
        assert!(
            emulator.live_images().is_empty(),
            "a cleared screen's images should be freed"
        );
    }

    #[rstest::rstest]
    fn reset_frees_every_image() {
        // Given a child that sent an image.
        let (mut emulator, _) = kitty_emulator();
        emulator.feed(b"\x1b_Ga=t,f=24,s=1,v=1,i=1,q=2;AAAA\x1b\\");

        // When it resets the terminal.
        emulator.feed(b"\x1bc");

        // Then the pane holds no images.
        assert!(
            emulator.live_images().is_empty(),
            "a reset should free every image"
        );
    }

    #[rstest::rstest]
    fn text_area_size_query_is_answered_in_pixels() {
        // Given a 20×5 pane with cells of 10×20 pixels.
        let (mut emulator, input) = kitty_emulator();

        // When the child asks for its size in pixels.
        emulator.feed(b"\x1b[14t");

        // Then it hears 100 pixels high by 200 wide.
        assert_eq!(
            String::from_utf8_lossy(&input.contents()),
            "\x1b[4;100;200t",
            "text area size reply"
        );
    }

    #[rstest::rstest]
    fn text_area_size_follows_a_resize() {
        // Given a 20×5 pane with cells of 10×20 pixels.
        let (mut emulator, input) = kitty_emulator();

        // When it is resized to 30×6 and the child asks for its size in
        // pixels.
        emulator.resize(PaneSize {
            cols: 30,
            rows: 6,
            cell: CellSize {
                width: 10,
                height: 20,
            },
        });
        emulator.feed(b"\x1b[14t");

        // Then it hears the new size: 120 pixels high by 300 wide.
        assert_eq!(
            String::from_utf8_lossy(&input.contents()),
            "\x1b[4;120;300t",
            "text area size reply after a resize"
        );
    }

    #[rstest::rstest]
    fn cell_size_query_is_answered() {
        // Given a pane with cells of 10×20 pixels.
        let (mut emulator, input) = kitty_emulator();

        // When the child asks for its cell size.
        emulator.feed(b"\x1b[16t");

        // Then it hears 20 pixels high by 10 wide.
        assert_eq!(
            String::from_utf8_lossy(&input.contents()),
            "\x1b[6;20;10t",
            "cell size reply"
        );
    }

    #[rstest::rstest]
    #[case::text_area(b"\x1b[14t")]
    #[case::cell(b"\x1b[16t")]
    fn size_queries_wait_without_a_cell_size(#[case] query: &[u8]) {
        // Given a pane whose cells' pixels are unknown.
        let (mut emulator, input, _) = emulator();

        // When the child asks for a size in pixels.
        emulator.feed(query);

        // Then it hears nothing.
        assert!(
            input.contents().is_empty(),
            "a size query without a cell size gets no reply"
        );
    }

    #[rstest::rstest]
    #[case::foreground("10", "rgb:c8c8/d3d3/f5f5")]
    #[case::background("11", "rgb:2222/2424/3636")]
    fn default_colour_query_is_answered(#[case] code: &str, #[case] color: &str) {
        // Given a pane told its colours.
        let (mut emulator, input) = colored_emulator();

        // When the child asks for a default colour.
        emulator.feed(format!("\x1b]{code};?\x07").as_bytes());

        // Then it hears that colour.
        assert_eq!(
            String::from_utf8_lossy(&input.contents()),
            format!("\x1b]{code};{color}\x07"),
            "default colour reply"
        );
    }

    #[rstest::rstest]
    #[case::first(0, "rgb:1111/2222/3333")]
    #[case::last(15, "rgb:ffff/eeee/dddd")]
    fn palette_colour_query_is_answered(#[case] index: usize, #[case] color: &str) {
        // Given a pane told its palette.
        let (mut emulator, input) = colored_emulator();

        // When the child asks for a palette colour.
        emulator.feed(format!("\x1b]4;{index};?\x1b\\").as_bytes());

        // Then it hears that colour.
        assert_eq!(
            String::from_utf8_lossy(&input.contents()),
            format!("\x1b]4;{index};{color}\x1b\\"),
            "palette colour reply"
        );
    }

    #[rstest::rstest]
    fn unanswered_palette_colour_gets_no_reply() {
        // Given a pane whose palette colour 1 is unknown.
        let (mut emulator, input) = colored_emulator();

        // When the child asks for palette colour 1.
        emulator.feed(b"\x1b]4;1;?\x1b\\");

        // Then it hears nothing.
        assert!(
            input.contents().is_empty(),
            "an unknown palette colour gets no reply"
        );
    }

    #[rstest::rstest]
    fn version_query_is_answered_with_orbs_own_name() {
        // Given a fresh emulator.
        let (mut emulator, input, _) = emulator();

        // When the child asks for the terminal's name and version.
        emulator.feed(b"\x1b[>0q");

        // Then it hears orb's own name and version.
        assert_eq!(
            String::from_utf8_lossy(&input.contents()),
            concat!("\x1bP>|orb(", env!("CARGO_PKG_VERSION"), ")\x1b\\"),
            "version reply"
        );
    }

    #[rstest::rstest]
    fn graphics_command_lands_at_the_cursor_cell() {
        // Given a 120×40 pane in kitty drawn five columns and three rows in.
        let (mut emulator, _) = kitty_emulator();
        let cell = CellSize {
            width: 10,
            height: 20,
        };
        emulator.resize(PaneSize {
            cols: 120,
            rows: 40,
            cell,
        });
        let area = Rect::new(5, 3, 120, 40);

        // When the child moves to row 35, column 101 and places an image.
        emulator.feed(b"\x1b[35;101H");
        emulator.feed(PLACED_IMAGE);

        // Then the image shows at that cell of the outer screen.
        let mut buf = Buffer::empty(area);
        let (_, frame) = emulator.render_with_graphics(area, &mut buf);
        let at: Vec<_> = frame.visible.iter().map(|visible| visible.at).collect();
        assert_eq!(at, vec![Position::new(105, 37)], "the image's outer cell");
    }

    #[rstest::rstest]
    fn held_update_shows_no_new_text_or_image() {
        // Given a pane in kitty.
        let (mut emulator, _) = kitty_emulator();

        // When the child starts a synchronized update, writes text and
        // places an image.
        emulator.feed(b"\x1b[?2026hhi");
        emulator.feed(PLACED_IMAGE);

        // Then neither the text nor the image shows.
        assert_eq!(
            shown(&mut emulator),
            (String::new(), 0),
            "a held update shows nothing"
        );
    }

    #[rstest::rstest]
    fn ended_update_shows_text_and_image_together() {
        // Given a synchronized update holding text and an image.
        let (mut emulator, _) = kitty_emulator();
        emulator.feed(b"\x1b[?2026hhi");
        emulator.feed(PLACED_IMAGE);

        // When the child ends the update.
        emulator.feed(b"\x1b[?2026l");

        // Then one draw shows both.
        assert_eq!(
            shown(&mut emulator),
            ("hi".to_owned(), 1),
            "an ended update shows its text and image"
        );
    }

    #[rstest::rstest]
    fn expired_update_shows_text_and_image() {
        // Given a synchronized update holding text and an image that the
        // child never ends.
        let (mut emulator, _) = kitty_emulator();
        emulator.feed(b"\x1b[?2026hhi");
        emulator.feed(PLACED_IMAGE);

        // When flushing well after its deadline.
        emulator.flush_expired_sync(Instant::now() + Duration::from_secs(1));

        // Then one draw shows both.
        assert_eq!(
            shown(&mut emulator),
            ("hi".to_owned(), 1),
            "an expired update shows its text and image"
        );
    }

    #[rstest::rstest]
    fn render_drains_the_queued_output() {
        // Given a pane in kitty whose child sent an image.
        let (mut emulator, _) = kitty_emulator();
        emulator.feed(PLACED_IMAGE);

        // When drawing the pane.
        let mut buf = Buffer::empty(AREA);
        let (_, frame) = emulator.render_with_graphics(AREA, &mut buf);

        // Then the draw carries the transmit and leaves nothing behind.
        assert_eq!(
            (frame.out.is_empty(), emulator.take_graphics_output()),
            (false, Vec::new()),
            "the draw takes the waiting bytes"
        );
    }

    #[rstest::rstest]
    fn hidden_pane_hands_over_queued_output() {
        // Given a pane in kitty whose child sent an image.
        let (mut emulator, _) = kitty_emulator();
        emulator.feed(PLACED_IMAGE);

        // When taking its waiting bytes twice, as for a pane not drawn.
        let first = emulator.take_graphics_output();
        let second = emulator.take_graphics_output();

        // Then the transmit comes out once.
        assert!(
            first.windows(8).any(|bytes| bytes == b"bmFtZQ==") && second.is_empty(),
            "first {:?}, second {:?}",
            String::from_utf8_lossy(&first),
            String::from_utf8_lossy(&second)
        );
    }

    /// An image of 25×30 pixels (3 columns by 2 rows of 10×20 cells) the
    /// child sends and places at its cursor without `C=1`, as a shell's
    /// `kitten icat` does.
    const SHELL_IMAGE: &[u8] = b"\x1b_Ga=T,f=32,s=25,v=30,t=s,i=1,p=1,q=2;bmFtZQ==\x1b\\";

    /// The outer cells where the emulator's placements show in [`AREA`].
    fn placed_at(emulator: &mut Emulator) -> Vec<Position> {
        let mut buf = Buffer::empty(AREA);
        let (_, frame) = emulator.render_with_graphics(AREA, &mut buf);
        frame.visible.iter().map(|visible| visible.at).collect()
    }

    /// Where the emulator's cursor shows in [`AREA`].
    fn cursor(emulator: &Emulator) -> Option<Position> {
        emulator.render(AREA, &mut Buffer::empty(AREA))
    }

    #[rstest::rstest]
    fn placed_image_moves_the_cursor_past_it() {
        // Given a pane in kitty.
        let (mut emulator, _) = kitty_emulator();

        // When the child places a 3×2-cell image at the top left.
        emulator.feed(SHELL_IMAGE);

        // Then the cursor is on the image's last row, right of it.
        assert_eq!(
            cursor(&emulator),
            Some(Position::new(3, 1)),
            "the cursor after a placed image"
        );
    }

    #[rstest::rstest]
    fn image_placed_with_c1_leaves_the_cursor() {
        // Given a pane in kitty.
        let (mut emulator, _) = kitty_emulator();

        // When the child places an image asking the cursor not to move.
        emulator.feed(PLACED_IMAGE);

        // Then the cursor stays at the top left.
        assert_eq!(
            cursor(&emulator),
            Some(Position::new(0, 0)),
            "the cursor after a C=1 image"
        );
    }

    #[rstest::rstest]
    fn png_image_moves_the_cursor_by_its_declared_size() {
        // Given a pane in kitty.
        let (mut emulator, _) = kitty_emulator();

        // When the child places a PNG it declared as 25×30 pixels.
        emulator.feed(b"\x1b_Ga=T,f=100,s=25,v=30,i=1,p=1,q=2;iVBORw0KGgo=\x1b\\");

        // Then the cursor is on the image's last row, right of it.
        assert_eq!(
            cursor(&emulator),
            Some(Position::new(3, 1)),
            "the cursor after a PNG image"
        );
    }

    #[rstest::rstest]
    fn image_on_the_bottom_line_scrolls_the_screen_to_fit() {
        // Given a pane in kitty whose cursor is on its bottom row.
        let (mut emulator, _) = kitty_emulator();
        emulator.feed(b"\x1b[5;1H");

        // When the child places a 2-row image there.
        emulator.feed(SHELL_IMAGE);

        // Then the screen scrolled one line and the image shows from row 3.
        assert_eq!(
            placed_at(&mut emulator),
            vec![Position::new(0, 3)],
            "the image after the screen scrolled to fit it"
        );
    }

    #[rstest::rstest]
    fn shell_image_scrolls_up_with_the_text() {
        // Given a pane in kitty with an image on row 2.
        let (mut emulator, _) = kitty_emulator();
        emulator.feed(b"\x1b[3;1H");
        emulator.feed(SHELL_IMAGE);

        // When two lines scroll in at the bottom.
        emulator.feed(b"\x1b[5;1H\n\n");

        // Then the image shows on row 0.
        assert_eq!(
            placed_at(&mut emulator),
            vec![Position::new(0, 0)],
            "the image after two lines scrolled"
        );
    }

    #[rstest::rstest]
    fn shell_image_shows_while_the_view_is_scrolled_back() {
        // Given a pane in kitty whose top-row image scrolled six lines off
        // the screen.
        let (mut emulator, _) = kitty_emulator();
        emulator.feed(SHELL_IMAGE);
        emulator.feed(b"\x1b[5;1H\n\n\n\n\n\n");

        // When the wheel scrolls the view six lines back.
        emulator.wheel(wheel(MouseEventKind::ScrollUp), AREA, None);
        emulator.wheel(wheel(MouseEventKind::ScrollUp), AREA, None);

        // Then the image shows on the top row again.
        assert_eq!(
            placed_at(&mut emulator),
            vec![Position::new(0, 0)],
            "the image in the scrolled-back view"
        );
    }

    #[rstest::rstest]
    fn shell_image_past_the_history_is_freed() {
        // Given a pane in kitty with an image whose transmit went out.
        let (mut emulator, _) = kitty_emulator();
        emulator.feed(SHELL_IMAGE);
        let outer = emulator.live_images();
        emulator.take_graphics_output();

        // When more lines than the history holds scroll in at once.
        emulator.feed(&b"\n".repeat(10_100));

        // Then kitty is told to free the image.
        let expected = outer
            .iter()
            .map(|outer| format!("\x1b_Ga=d,d=I,i={outer},q=2\x1b\\"))
            .collect::<Vec<_>>()
            .concat();
        assert_eq!(
            String::from_utf8_lossy(&emulator.take_graphics_output()),
            expected,
            "the free for an image past the history"
        );
    }

    #[rstest::rstest]
    fn shell_image_survives_a_full_history() {
        // Given a pane in kitty whose history is full, with an image on
        // row 2.
        let (mut emulator, _) = kitty_emulator();
        emulator.feed(&b"\n".repeat(10_100));
        emulator.feed(b"\x1b[3;1H");
        emulator.feed(SHELL_IMAGE);

        // When two lines scroll in at the bottom, one feed each.
        emulator.feed(b"\x1b[5;1H\n");
        emulator.feed(b"\n");

        // Then the image shows on row 0.
        assert_eq!(
            placed_at(&mut emulator),
            vec![Position::new(0, 0)],
            "the image after two lines scrolled into a full history"
        );
    }

    #[rstest::rstest]
    fn alternate_screen_image_stays_put_while_its_text_scrolls() {
        // Given a pane in kitty with an image on the alternate screen's top
        // row, placed as terminal-browser places them.
        let (mut emulator, _) = kitty_emulator();
        emulator.feed(b"\x1b[?1049h");
        emulator.feed(PLACED_IMAGE);

        // When two lines scroll in at the alternate screen's bottom.
        emulator.feed(b"\x1b[5;1H\n\n");

        // Then the image still shows on the top row.
        assert_eq!(
            placed_at(&mut emulator),
            vec![Position::new(0, 0)],
            "the alternate screen's image after its text scrolled"
        );
    }

    /// Where the pixel-mouse tests draw the pane: a cell in from the left, a
    /// row down.
    const OFFSET: Rect = Rect::new(2, 1, 20, 5);

    /// A mouse event of `kind` at screen cell (3, 2).
    fn at_three_two(kind: MouseEventKind) -> MouseEvent {
        MouseEvent {
            kind,
            column: 3,
            row: 2,
            modifiers: KeyModifiers::NONE,
        }
    }

    /// A left press at screen cell (3, 2), screen pixel (35, 47).
    fn press_at_three_two(emulator: &mut Emulator) {
        emulator.mouse(
            at_three_two(MouseEventKind::Down(MouseButton::Left)),
            OFFSET,
            Some(Position::new(35, 47)),
        );
    }

    #[rstest::rstest]
    #[case::off(b"", "\x1b[?1016;2$y")]
    #[case::on(b"\x1b[?1016h", "\x1b[?1016;1$y")]
    fn pixel_mouse_query_follows_the_childs_setting(#[case] before: &[u8], #[case] expected: &str) {
        // Given a pane in kitty whose child sent `before`.
        let (mut emulator, input) = kitty_emulator();
        emulator.feed(before);

        // When the child asks about pixel mouse reports.
        emulator.feed(b"\x1b[?1016$p");

        // Then it hears its own setting.
        assert_eq!(
            String::from_utf8_lossy(&input.contents()),
            expected,
            "pixel mouse mode reply"
        );
    }

    #[rstest::rstest]
    #[case::answers_off(true)]
    #[case::outside_kitty(false)]
    fn pixel_mouse_query_is_not_recognised_where_images_are_off(#[case] in_kitty: bool) {
        // Given a pane in kitty that stopped answering image questions, or a
        // pane outside kitty.
        let (mut emulator, input) = if in_kitty {
            let (mut emulator, input) = kitty_emulator();
            emulator.answer_graphics(false);
            (emulator, input)
        } else {
            let (emulator, input, _) = emulator();
            (emulator, input)
        };

        // When the child asks about pixel mouse reports.
        emulator.feed(b"\x1b[?1016$p");

        // Then it hears the mode isn't recognised.
        assert_eq!(
            String::from_utf8_lossy(&input.contents()),
            "\x1b[?1016;0$y",
            "pixel mouse mode reply"
        );
    }

    #[rstest::rstest]
    fn click_reaches_a_pixel_mouse_child_in_pane_pixels() {
        // Given a pane in kitty whose child asked for pixel mouse reports.
        let (mut emulator, input) = kitty_emulator();
        emulator.feed(b"\x1b[?1000h\x1b[?1006h\x1b[?1016h");

        // When the left button goes down at screen pixel (35, 47).
        press_at_three_two(&mut emulator);

        // Then the child gets the pixel within its pane.
        assert_eq!(
            String::from_utf8_lossy(&input.contents()),
            "\x1b[<0;15;27M",
            "pixel mouse report"
        );
    }

    #[rstest::rstest]
    fn click_reaches_a_cell_mouse_child_in_cells() {
        // Given a pane in kitty whose child asked for cell mouse reports.
        let (mut emulator, input) = kitty_emulator();
        emulator.feed(b"\x1b[?1000h\x1b[?1006h");

        // When the left button goes down at screen cell (3, 2).
        press_at_three_two(&mut emulator);

        // Then the child gets the cell within its pane.
        assert_eq!(
            String::from_utf8_lossy(&input.contents()),
            "\x1b[<0;2;2M",
            "cell mouse report"
        );
    }

    #[rstest::rstest]
    fn reset_turns_pixel_mouse_off() {
        // Given a child that asked for pixel mouse reports, reset the
        // terminal, then asked for cell reports.
        let (mut emulator, input) = kitty_emulator();
        emulator.feed(b"\x1b[?1016h\x1bc\x1b[?1000h\x1b[?1006h");

        // When the left button goes down at screen cell (3, 2).
        press_at_three_two(&mut emulator);

        // Then the child gets the cell within its pane.
        assert_eq!(
            String::from_utf8_lossy(&input.contents()),
            "\x1b[<0;2;2M",
            "cell mouse report after a reset"
        );
    }

    #[rstest::rstest]
    #[case::cells(b"\x1b[?1003h\x1b[?1006h", 1)]
    #[case::pixels(b"\x1b[?1003h\x1b[?1006h\x1b[?1016h", 2)]
    fn motion_within_a_cell_reaches_the_child_as_it_asked(
        #[case] modes: &[u8],
        #[case] reports: usize,
    ) {
        // Given a child tracking motion in `modes`.
        let (mut emulator, input) = kitty_emulator();
        emulator.feed(modes);

        // When the mouse moves twice within screen cell (3, 2).
        for pixel in [Position::new(31, 41), Position::new(35, 47)] {
            emulator.mouse(at_three_two(MouseEventKind::Moved), OFFSET, Some(pixel));
        }

        // Then a cell child hears it once and a pixel child each time.
        assert_eq!(
            String::from_utf8_lossy(&input.contents())
                .matches("\x1b[<")
                .count(),
            reports,
            "motion reports in {:?}",
            String::from_utf8_lossy(&input.contents())
        );
    }
}
