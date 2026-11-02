//! The which-key popup, drawn like LazyVim's default which-key (the helix
//! preset) in tokyonight-moon: a rounded float in the bottom-right corner,
//! sitting on the mode line, with the pending keys in its top border and one
//! `key ➜ icon desc` row per next key, groups as `+name`. The rows are in
//! which-key's order (letters and digits before symbols, lowercase before its
//! capital), and `esc close  ⌫ back` sits on the last row. The popup is as
//! tall as its rows; on a shorter screen the rows that don't fit are cut off.
//! While a pane mode is on, the same box lists that mode's keys instead,
//! titled with the mode and ending in `esc/⏎ exit`.

use orb_domain::{Intent, PaneMode};
use ratatui::buffer::Buffer;
use ratatui::crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Clear, Widget};
use ratatui_which_key::{Key as _, NodeResult};

use crate::keymap::Keys;
use crate::picker::WORKTREE;
use crate::sidebar::{
    BG_DARK, BLUE, BLUE1, BORDER, COMMENT, CYAN, DARK5, FOLDER, FOLDER_OPEN, GREEN, MAGENTA, ORANGE,
};

/// One row of the popup: a next key and what it does.
struct Entry {
    code: KeyCode,
    key: String,
    desc: String,
    icon: &'static str,
    colour: Color,
    group: bool,
}

/// Draws the popup for the pending sequence inside `area`, the screen above
/// the mode line. Nothing is drawn without a pending sequence, or when
/// `area` is too short for a row between the borders and the foot.
pub(crate) fn render(keys: &Keys, area: Rect, buf: &mut Buffer) {
    if !keys.active && keys.current_sequence.is_empty() {
        return;
    }
    let entries = entries(keys);
    if entries.is_empty() {
        return;
    }
    draw_box(&path(keys), &entries, &help(), area, buf);
}

/// Draws the key box for pane mode `mode` inside `area`, the screen above
/// the mode line: the mode's name in the top border, one row per key with
/// each arrow beside its letter, and `esc/⏎ exit` on the last row.
pub(crate) fn render_mode(mode: PaneMode, area: Rect, buf: &mut Buffer) {
    let (title, keys): (&str, &[(&str, &str)]) = match mode {
        PaneMode::Resize => (
            "RESIZE",
            &[
                ("h ←", "grow left"),
                ("j ↓", "grow down"),
                ("k ↑", "grow up"),
                ("l →", "grow right"),
                ("H", "shrink left"),
                ("J", "shrink down"),
                ("K", "shrink up"),
                ("L", "shrink right"),
                ("+", "grow"),
                ("-", "shrink"),
            ],
        ),
        PaneMode::Move => (
            "MOVE",
            &[
                ("h ←", "move left"),
                ("j ↓", "move down"),
                ("k ↑", "move up"),
                ("l →", "move right"),
                ("n ⇥", "next"),
                ("p", "previous"),
            ],
        ),
    };
    let entries: Vec<Entry> = keys
        .iter()
        .map(|(key, desc)| mode_entry(key, desc))
        .collect();
    draw_box(title, &entries, &exit_help(), area, buf);
}

/// A rounded float in the bottom-right of `area` with `title` in its top
/// border, `entries` as rows and `foot` on the last row. Nothing is drawn
/// when `area` is too short for a row between the borders and the foot.
fn draw_box(title: &str, entries: &[Entry], foot: &Line<'_>, area: Rect, buf: &mut Buffer) {
    if area.height < 4 {
        return;
    }
    let key_width = entries.iter().map(|e| width(&e.key)).max().unwrap_or(1);
    let inner_width = entries
        .iter()
        .map(|e| row_width(e, key_width))
        .max()
        .unwrap_or(0)
        .max(foot.width());
    let popup = {
        let width = to_u16(inner_width + 4).min(area.width);
        let height = to_u16(entries.len() + 3).min(area.height);
        Rect::new(
            area.right().saturating_sub(width + 1),
            area.bottom().saturating_sub(height),
            width,
            height,
        )
    };
    float(popup, buf);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(BORDER))
        .title(Line::from(span(format!(" {title} "), ORANGE)));
    let inner = block.inner(popup);
    block.render(popup, buf);
    let x = inner.x + 1;
    let max_width = inner.width.saturating_sub(1);
    let rows = inner.height.saturating_sub(1);
    for (entry, y) in entries.iter().zip(inner.y..inner.y + rows) {
        buf.set_line(x, y, &row(entry, key_width), max_width);
    }
    buf.set_line(x, inner.bottom() - 1, foot, max_width);
}

/// A mode box row: `key` and what it does, with the popup's default icon.
fn mode_entry(key: &str, desc: &str) -> Entry {
    Entry {
        code: KeyCode::Null,
        key: key.to_owned(),
        desc: desc.to_owned(),
        icon: "\u{f111}",
        colour: DARK5,
        group: false,
    }
}

/// The keys under the pending sequence, in which-key's order: letters and
/// digits before symbols, lowercase before its capital.
fn entries(keys: &Keys) -> Vec<Entry> {
    let path = &keys.current_sequence;
    let scope = keys.scope();
    let mut entries: Vec<Entry> = keys
        .keymap()
        .children_at_path(path, scope)
        .unwrap_or_default()
        .into_iter()
        .map(|binding| {
            let full: Vec<KeyEvent> = path.iter().copied().chain([binding.key]).collect();
            let key = key_name(&binding.key);
            match keys.keymap().navigate(&full, scope) {
                Some(NodeResult::Leaf { action }) => {
                    let (icon, colour) = look(&action);
                    Entry {
                        code: binding.key.code,
                        key,
                        desc: binding.description,
                        icon,
                        colour,
                        group: false,
                    }
                }
                _ => Entry {
                    code: binding.key.code,
                    key,
                    desc: format!("+{}", binding.description),
                    icon: FOLDER,
                    colour: BLUE,
                    group: true,
                },
            }
        })
        .collect();
    entries.sort_by_key(|e| {
        let (symbol, upper) = match e.code {
            KeyCode::Char(c) => (!c.is_alphanumeric(), c.is_uppercase()),
            _ => (true, false),
        };
        (symbol, e.key.to_lowercase(), upper)
    });
    entries
}

/// orb's names for keys, as LazyVim writes them.
fn key_name(key: &KeyEvent) -> String {
    match key.display().as_str() {
        "Space" => "␣".to_owned(),
        "Tab" => "<Tab>".to_owned(),
        "Enter" => "<CR>".to_owned(),
        other => other.to_owned(),
    }
}

/// The icon and its colour for an intent (mini.icons style).
fn look(intent: &Intent) -> (&'static str, Color) {
    match intent {
        Intent::NewSession => ("\u{f067}", GREEN),
        Intent::OpenProjects => (FOLDER_OPEN, BLUE),
        Intent::FilterProjects => ("\u{f0b0}", CYAN),
        Intent::ChangeWorkspace => ("\u{f1bb}", GREEN),
        Intent::SwitchBranch => ("\u{e725}", ORANGE),
        Intent::ToggleSidebar => ("\u{f0db}", BLUE1),
        Intent::SelectFirst => ("\u{f062}", BLUE),
        Intent::OpenWorktreePicker => (WORKTREE, ORANGE),
        _ => ("\u{f111}", DARK5),
    }
}

/// The pending path, e.g. `<C-g>` or `<C-g> t`.
fn path(keys: &Keys) -> String {
    keys.current_sequence
        .iter()
        .map(key_name)
        .collect::<Vec<_>>()
        .join(" ")
}

/// `key ➜ icon desc`, the key right-aligned to `key_width`.
fn row(entry: &Entry, key_width: usize) -> Line<'_> {
    let desc = if entry.group { BLUE } else { MAGENTA };
    Line::from(vec![
        span(format!("{:>key_width$}", entry.key), CYAN),
        span(" ➜ ", COMMENT),
        span(format!("{} ", entry.icon), entry.colour),
        span(entry.desc.as_str(), desc),
    ])
}

fn row_width(entry: &Entry, key_width: usize) -> usize {
    key_width + 3 + 2 + width(&entry.desc)
}

/// `esc close  ⌫ back`.
fn help() -> Line<'static> {
    Line::from(vec![
        span("esc ", CYAN),
        span("close  ", COMMENT),
        span("⌫ ", CYAN),
        span("back", COMMENT),
    ])
}

/// `esc/⏎ exit`.
fn exit_help() -> Line<'static> {
    Line::from(vec![span("esc/⏎ ", CYAN), span("exit", COMMENT)])
}

/// A floating box on `BG_DARK`.
fn float(area: Rect, buf: &mut Buffer) {
    Clear.render(area, buf);
    buf.set_style(area, Style::new().bg(BG_DARK));
}

fn span<'a>(text: impl Into<std::borrow::Cow<'a, str>>, fg: Color) -> Span<'a> {
    Span::styled(text, Style::new().fg(fg))
}

/// Display width of `text`.
fn width(text: &str) -> usize {
    Span::raw(text).width()
}

fn to_u16(n: usize) -> u16 {
    u16::try_from(n).unwrap_or(u16::MAX)
}

#[cfg(test)]
mod tests {
    use orb_domain::{Intent, PaneMode};
    use ratatui::buffer::{Buffer, Cell};
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::layout::Rect;
    use ratatui_which_key::Keymap;

    use super::{render, render_mode};
    use crate::keymap::{KeyCategory, Keys, LEADER, Scope, keymap, press};

    const SCREEN: Rect = Rect::new(0, 0, 80, 20);

    /// `keys` with `<C-g>` pressed.
    fn leader(mut keys: Keys) -> Keys {
        press(&mut keys, LEADER);
        keys
    }

    /// orb's keymap on an agent with `<C-g>` pressed.
    fn leader_on_agent() -> Keys {
        leader(Keys::new(keymap(), Scope::SIDEBAR))
    }

    /// A buffer the size of `SCREEN` with the popup drawn inside `area`.
    fn draw(keys: &Keys, area: Rect) -> Buffer {
        let mut buffer = Buffer::empty(SCREEN);
        render(keys, area, &mut buffer);
        buffer
    }

    /// Each row of `buffer` as text.
    fn lines(buffer: &Buffer) -> Vec<String> {
        buffer
            .area
            .rows()
            .map(|row| {
                row.columns()
                    .filter_map(|cell| buffer.cell(cell).map(Cell::symbol))
                    .collect::<String>()
            })
            .collect()
    }

    #[rstest::rstest]
    fn popup_rows_are_in_which_key_order() {
        // Given a keymap with `<C-g> /`, `B`, `b`, `a` and `1`, and `<C-g>` pressed.
        let keys = {
            let mut km = Keymap::new().with_leader(LEADER);
            for key in ["/", "B", "b", "a", "1"] {
                km.bind(
                    &format!("<leader>{key}"),
                    Intent::NewSession,
                    KeyCategory::Sessions,
                    Scope::SIDEBAR,
                );
            }
            leader(Keys::new(km, Scope::SIDEBAR))
        };

        // When drawing the popup.
        let buffer = draw(&keys, SCREEN);

        // Then the row keys read `1 a b B /` top to bottom.
        let order: Vec<String> = lines(&buffer)
            .iter()
            .filter_map(|line| line.split_once('➜'))
            .map(|(key, _)| key.trim_matches([' ', '│']).to_owned())
            .collect();
        assert_eq!(order, ["1", "a", "b", "B", "/"], "the row keys");
    }

    #[rstest::rstest]
    fn popup_top_border_shows_the_pending_path() {
        // Given `<C-g>` pressed on an agent.
        let keys = leader_on_agent();

        // When drawing the popup.
        let buffer = draw(&keys, SCREEN);

        // Then the top border carries ` <C-g> `.
        let lines = lines(&buffer);
        let top = lines.iter().find(|line| line.contains('╭'));
        assert!(
            top.is_some_and(|line| line.contains("╭ <C-g> ")),
            "the top border was {top:?}"
        );
    }

    #[rstest::rstest]
    fn leaf_row_reads_key_arrow_icon_desc() {
        // Given `<C-g>` pressed on an agent.
        let keys = leader_on_agent();

        // When drawing the popup.
        let buffer = draw(&keys, SCREEN);

        // Then the `n` row reads `n ➜ <plus> new session`.
        let lines = lines(&buffer);
        assert!(
            lines
                .iter()
                .any(|line| line.contains("│ n ➜ \u{f067} new session")),
            "the screen was {lines:#?}"
        );
    }

    #[rstest::rstest]
    fn group_row_reads_plus_name() {
        // Given a keymap with a `<C-g> x` group named `extra`, and `<C-g>` pressed.
        let keys = {
            let mut km = Keymap::new().with_leader(LEADER);
            km.describe_group("<leader>x", "extra");
            km.bind(
                "<leader>xa",
                Intent::NewSession,
                KeyCategory::Sessions,
                Scope::SIDEBAR,
            );
            leader(Keys::new(km, Scope::SIDEBAR))
        };

        // When drawing the popup.
        let buffer = draw(&keys, SCREEN);

        // Then the `x` row reads `x ➜ <folder> +extra`.
        let lines = lines(&buffer);
        assert!(
            lines
                .iter()
                .any(|line| line.contains("│ x ➜ \u{f07b} +extra")),
            "the screen was {lines:#?}"
        );
    }

    #[rstest::rstest]
    fn popup_foot_shows_the_help() {
        // Given `<C-g>` pressed on an agent.
        let keys = leader_on_agent();

        // When drawing the popup.
        let buffer = draw(&keys, SCREEN);

        // Then the row above the bottom border reads `esc close  ⌫ back`.
        let lines = lines(&buffer);
        let foot = lines
            .iter()
            .position(|line| line.contains('╰'))
            .and_then(|bottom| lines.get(bottom - 1));
        assert!(
            foot.is_some_and(|line| line.contains("│ esc close  ⌫ back")),
            "the foot was {foot:?}"
        );
    }

    #[rstest::rstest]
    fn popup_sits_bottom_right_on_the_area_bottom() {
        // Given `<C-g>` pressed on an agent, and an area smaller than the screen.
        let keys = leader_on_agent();
        let area = Rect::new(0, 0, 60, 16);

        // When drawing the popup inside the area.
        let buffer = draw(&keys, area);

        // Then its bottom-right corner is on the area's last row, one column
        // in from its right edge.
        let corner = buffer
            .cell((area.right() - 2, area.bottom() - 1))
            .map(Cell::symbol);
        assert_eq!(corner, Some("╯"), "the bottom-right corner");
    }

    #[rstest::rstest]
    fn too_tall_popup_is_cut_off_keeping_the_foot() {
        // Given `<C-g>` pressed on an agent, and an area 7 rows tall.
        let keys = leader_on_agent();
        let area = Rect::new(0, 0, 80, 7);

        // When drawing the popup inside the area.
        let buffer = draw(&keys, area);

        // Then the box fills the 7 rows and its last inner row is the help.
        let lines = lines(&buffer);
        let row_has = |y: usize, text: &str| lines.get(y).is_some_and(|line| line.contains(text));
        assert!(
            row_has(0, "╭") && row_has(5, "esc close  ⌫ back") && row_has(6, "╰"),
            "the screen was {lines:#?}"
        );
    }

    #[rstest::rstest]
    fn no_popup_without_a_pending_sequence() {
        // Given orb's keymap with nothing pressed.
        let keys = Keys::new(keymap(), Scope::SIDEBAR);

        // When drawing the popup.
        let buffer = draw(&keys, SCREEN);

        // Then nothing is drawn.
        let lines = lines(&buffer);
        assert!(
            !lines.iter().any(|line| line.contains('╭')),
            "the screen was {lines:#?}"
        );
    }

    #[rstest::rstest]
    fn leader_popup_in_a_pane_lists_the_pane_and_tab_groups() {
        // Given `<C-g>` pressed in a pane.
        let keys = leader(Keys::new(keymap(), Scope::PANE));

        // When drawing the popup.
        let buffer = draw(&keys, SCREEN);

        // Then it has the `p ➜ <folder> +pane` and `t ➜ <folder> +tab` rows.
        let lines = lines(&buffer);
        let listed = |row: &str| lines.iter().any(|line| line.contains(row));
        assert!(
            listed("p ➜ \u{f07b} +pane") && listed("t ➜ \u{f07b} +tab"),
            "the screen was {lines:#?}"
        );
    }

    #[rstest::rstest]
    fn pane_popup_lists_the_float_rows() {
        // Given `<C-g>` and `p` pressed in a pane.
        let keys = {
            let mut keys = leader(Keys::new(keymap(), Scope::PANE));
            press(
                &mut keys,
                KeyEvent::new(KeyCode::Char('p'), KeyModifiers::NONE),
            );
            keys
        };

        // When drawing the popup.
        let buffer = draw(&keys, SCREEN);

        // Then it has the floats, embed/float and pin float rows.
        let lines = lines(&buffer);
        let listed = |key: &str, label: &str| {
            lines
                .iter()
                .any(|line| line.contains(&format!("{key} ➜")) && line.contains(label))
        };
        assert!(
            listed("w", "floats") && listed("e", "embed/float") && listed("i", "pin float"),
            "the screen was {lines:#?}"
        );
    }

    /// A buffer the size of `SCREEN` with `mode`'s key box drawn on it.
    fn draw_mode(mode: PaneMode) -> Buffer {
        let mut buffer = Buffer::empty(SCREEN);
        render_mode(mode, SCREEN, &mut buffer);
        buffer
    }

    #[rstest::rstest]
    #[case::move_(PaneMode::Move, &["h ←", "j ↓", "k ↑", "l →", "n ⇥", "p"])]
    #[case::resize(
        PaneMode::Resize,
        &["h ←", "j ↓", "k ↑", "l →", "H", "J", "K", "L", "+", "-"]
    )]
    fn mode_box_lists_the_modes_keys(#[case] mode: PaneMode, #[case] expected: &[&str]) {
        // Given a pane mode on.

        // When drawing its key box.
        let buffer = draw_mode(mode);

        // Then the row keys are the mode's keys, each arrow beside its letter.
        let keys: Vec<String> = lines(&buffer)
            .iter()
            .filter_map(|line| line.split_once('➜'))
            .map(|(key, _)| key.trim_matches([' ', '│']).to_owned())
            .collect();
        assert_eq!(keys, expected, "the mode box rows");
    }

    #[rstest::rstest]
    fn mode_box_top_border_names_the_mode() {
        // Given move mode on.

        // When drawing its key box.
        let buffer = draw_mode(PaneMode::Move);

        // Then the top border carries ` MOVE `.
        let titled = lines(&buffer).iter().any(|line| line.contains("╭ MOVE "));
        assert!(titled, "the top border should name the mode");
    }

    #[rstest::rstest]
    fn mode_box_foot_reads_esc_enter_exit() {
        // Given resize mode on.

        // When drawing its key box.
        let buffer = draw_mode(PaneMode::Resize);

        // Then a row reads `esc/⏎ exit`.
        let foot = lines(&buffer)
            .iter()
            .any(|line| line.contains("esc/⏎ exit"));
        assert!(foot, "the foot should say how to leave the mode");
    }
}
