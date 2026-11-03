//! A small arrow-key picker with optional type-to-filter, drawn with crossterm.
//!
//! Layout:
//!
//! ```text
//! › Prompt: filter
//!
//! ❯ Highlighted item
//!   Item
//!
//! [help message]
//! ```

use std::io::{self, Write};

use crossterm::cursor::{self, Hide, MoveTo, Show};
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::style::{Print, Stylize};
use crossterm::terminal::{self, Clear, ClearType};
use crossterm::{execute, queue};

const MAX_PAGE_SIZE: usize = 15;

/// How the picker was closed.
pub enum Outcome {
    /// Enter was pressed; holds the index into the original items.
    Selected(usize),
    /// Esc was pressed.
    Back,
    /// Ctrl+C was pressed.
    Quit,
}

pub struct Picker<'a> {
    prompt: &'a str,
    items: Vec<&'a str>,
    help: &'a str,
    filterable: bool,
    gap_after: Option<usize>,
}

/// The parts of the picker that change as the user types and moves.
struct State {
    filter: String,
    /// Indices into `items` that match `filter`.
    matches: Vec<usize>,
    /// Position of the highlighted item within `matches`.
    cursor: usize,
    /// Position within `matches` of the first visible item.
    offset: usize,
}

/// Keeps the terminal in raw mode until dropped, even on early return or error.
struct RawMode;

impl RawMode {
    fn enable() -> io::Result<Self> {
        terminal::enable_raw_mode()?;
        Ok(Self)
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        let _ = terminal::disable_raw_mode();
        let _ = execute!(io::stdout(), Show);
    }
}

impl<'a> Picker<'a> {
    pub fn new(prompt: &'a str, items: Vec<&'a str>) -> Self {
        Self {
            prompt,
            items,
            help: "",
            filterable: false,
            gap_after: None,
        }
    }

    pub fn help(mut self, help: &'a str) -> Self {
        self.help = help;
        self
    }

    /// Let the user type to narrow the list (case-insensitive substring match).
    pub fn filterable(mut self) -> Self {
        self.filterable = true;
        self
    }

    /// Draw a blank line after the item at `index`.
    pub fn gap_after(mut self, index: usize) -> Self {
        self.gap_after = Some(index);
        self
    }

    /// Draw the picker from the current cursor row down and wait for a choice.
    /// The picker's lines are cleared before returning.
    pub fn run(self) -> io::Result<Outcome> {
        let _raw = RawMode::enable()?;
        let (_, top) = cursor::position()?;

        let mut state = State {
            filter: String::new(),
            matches: (0..self.items.len()).collect(),
            cursor: 0,
            offset: 0,
        };

        let outcome = loop {
            self.render(&mut state, top)?;

            // Any other event (such as a resize) just redraws.
            let Event::Key(key) = event::read()? else {
                continue;
            };
            if key.kind != KeyEventKind::Press {
                continue;
            }

            let len = state.matches.len();
            match key.code {
                KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    break Outcome::Quit;
                }
                KeyCode::Esc => break Outcome::Back,
                KeyCode::Enter => {
                    if let Some(&index) = state.matches.get(state.cursor) {
                        break Outcome::Selected(index);
                    }
                }
                KeyCode::Up if len > 0 => state.cursor = (state.cursor + len - 1) % len,
                KeyCode::Down if len > 0 => state.cursor = (state.cursor + 1) % len,
                KeyCode::Backspace if self.filterable => {
                    state.filter.pop();
                    self.apply_filter(&mut state);
                }
                KeyCode::Char(c)
                    if self.filterable
                        && !key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
                {
                    state.filter.push(c);
                    self.apply_filter(&mut state);
                }
                _ => {}
            }
        };

        execute!(io::stdout(), MoveTo(0, top), Clear(ClearType::FromCursorDown))?;
        Ok(outcome)
    }

    fn apply_filter(&self, state: &mut State) {
        let filter = state.filter.to_lowercase();
        state.matches = (0..self.items.len())
            .filter(|&i| self.items[i].to_lowercase().contains(&filter))
            .collect();
        state.cursor = 0;
        state.offset = 0;
    }

    fn render(&self, state: &mut State, top: u16) -> io::Result<()> {
        let (width, height) = terminal::size()?;
        let width = width as usize;

        // Prompt, blank, blank and help lines take 4 rows; fit the items in the rest.
        let fixed_rows = 4 + self.gap_after.is_some() as usize;
        let page_size = (height as usize)
            .saturating_sub(top as usize + fixed_rows)
            .clamp(1, MAX_PAGE_SIZE);

        // Scroll so the highlighted item stays on screen.
        if state.cursor < state.offset {
            state.offset = state.cursor;
        } else if state.cursor >= state.offset + page_size {
            state.offset = state.cursor + 1 - page_size;
        }

        let mut out = io::stdout();
        let mut row = top;

        let prompt = format!("{} {}", self.prompt, state.filter);
        queue!(
            out,
            MoveTo(0, row),
            Clear(ClearType::FromCursorDown),
            Print("›".green()),
            Print(" "),
            Print(truncate(&prompt, width.saturating_sub(2))),
        )?;
        let input_col = (2 + prompt.chars().count()).min(width.saturating_sub(1)) as u16;
        row += 2;

        let len = state.matches.len();
        let end = (state.offset + page_size).min(len);

        if len == 0 {
            queue!(out, MoveTo(0, row), Print("  No matches".dark_grey()))?;
            row += 1;
        }

        for pos in state.offset..end {
            let index = state.matches[pos];
            let name = truncate(self.items[index], width.saturating_sub(2));

            let (prefix, label) = if pos == state.cursor {
                ("❯".cyan(), name.cyan().bold())
            } else if pos == state.offset && state.offset > 0 {
                ("↑".dark_grey(), name.reset())
            } else if pos == end - 1 && end < len {
                ("↓".dark_grey(), name.reset())
            } else {
                (" ".reset(), name.reset())
            };

            queue!(out, MoveTo(0, row), Print(prefix), Print(" "), Print(label))?;
            row += 1;

            if self.gap_after == Some(index) {
                row += 1;
            }
        }

        row += 1;
        queue!(
            out,
            MoveTo(0, row),
            Print(truncate(&format!("[{}]", self.help), width).dark_grey()),
        )?;

        // Show the text cursor after the filter text, or hide it if there is nothing to type.
        if self.filterable {
            queue!(out, MoveTo(input_col, top), Show)?;
        } else {
            queue!(out, Hide)?;
        }

        out.flush()
    }
}

/// Cut `s` to at most `max` characters so long names don't wrap and break the layout.
fn truncate(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}
