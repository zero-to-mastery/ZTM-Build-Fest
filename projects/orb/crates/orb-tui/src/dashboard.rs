//! The start screen: what the right-hand area shows while no session is
//! shown. The word ORB in shadowed block letters fading from blue to violet
//! with its moons and stars, and under it a footer counting working agents,
//! sessions and projects; why a session couldn't start shows under the
//! footer. No menu and no keys.

use std::borrow::Cow;

use orb_domain::AppState;
use ratatui::buffer::Buffer;
use ratatui::layout::{Position, Rect};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Widget;
use unicode_segmentation::UnicodeSegmentation;

use crate::sidebar::{BLUE, COMMENT, DARK3, DARK5, MAGENTA, YELLOW, mark};

/// tokyonight-moon's `red`.
const RED: Color = Color::Rgb(0xff, 0x75, 0x7f);

/// ORB in ANSI Shadow, as LazyVim's header.
const SHADOW: [&str; 6] = [
    " ██████╗ ██████╗ ██████╗ ",
    "██╔═══██╗██╔══██╗██╔══██╗",
    "██║   ██║██████╔╝██████╔╝",
    "██║   ██║██╔══██╗██╔══██╗",
    "╚██████╔╝██║  ██║██████╔╝",
    " ╚═════╝ ╚═╝  ╚═╝╚═════╝ ",
];
const SHADOW_WIDTH: u16 = 25;

/// Moons rising off the B like LazyVim's z's, then the stars around the
/// banner, as `(x, y, glyph, colour)` from the banner's top-left cell.
const SKY: [(i16, i16, &str, Color); 10] = [
    (27, 4, "·", DARK5),
    (30, 3, "∘", COMMENT),
    (33, 2, "○", BLUE),
    (37, 0, "●", YELLOW),
    (-6, 1, "✦", DARK5),
    (-10, 4, "·", DARK3),
    (-3, 5, "⋆", COMMENT),
    (42, 4, "✧", DARK5),
    (22, -1, "·", DARK3),
    (4, -1, "⋆", DARK3),
];

/// Draws the start screen into `area`, centred, with `pane_error` under the
/// footer.
pub(crate) fn render(state: &AppState, pane_error: Option<&str>, area: Rect, buf: &mut Buffer) {
    let top = area.y + area.height.saturating_sub(8) / 2;
    banner(
        area.x + area.width.saturating_sub(SHADOW_WIDTH) / 2,
        top,
        area,
        buf,
    );
    let footer = top + 7;
    centre(stats(state), footer, area, buf);
    if let Some(error) = pane_error {
        centre(
            Line::from(span(error.to_owned(), RED)),
            footer + 1,
            area,
            buf,
        );
    }
}

/// The ORB letters with its moons and stars, the letters' top-left at
/// `(x, top)`: solid blocks from blue to violet row by row, their shadow in
/// darker tones of the same.
fn banner(x: u16, top: u16, area: Rect, buf: &mut Buffer) {
    for (row, text) in (0u16..).zip(SHADOW) {
        let t = f64::from(row) / 5.0;
        let solid = lerp(BLUE, MAGENTA, t);
        let edge = lerp(
            Color::Rgb(0x3b, 0x4f, 0x8c),
            Color::Rgb(0x5a, 0x45, 0x8c),
            t,
        );
        let spans: Vec<Span<'static>> = text
            .graphemes(true)
            .map(|cell| span(cell, if cell == "█" { solid } else { edge }))
            .collect();
        put(Line::from(spans), x, top + row, area, buf);
    }
    for (dx, dy, glyph, fg) in SKY {
        if let (Some(x), Some(y)) = (x.checked_add_signed(dx), top.checked_add_signed(dy)) {
            put(Line::from(span(glyph, fg)), x, y, area, buf);
        }
    }
}

/// `✳ 2 working · 14 sessions · 4 projects`, numbers in magenta, after the
/// first registered harness's mark.
fn stats(state: &AppState) -> Line<'static> {
    let (glyph, fg) = mark(
        state
            .harnesses
            .first()
            .and_then(|info| info.icon.as_deref()),
    );
    let sessions = &state.sessions;
    let live = sessions
        .sessions
        .iter()
        .filter(|session| !sessions.deleting.contains(&session.id))
        .count();
    let projects = sessions
        .projects
        .iter()
        .filter(|project| !project.removed)
        .count();
    Line::from(vec![
        span(format!("{glyph} "), fg),
        span(sessions.working_count().to_string(), MAGENTA),
        span(" working · ", BLUE),
        span(live.to_string(), MAGENTA),
        span(format!(" {} · ", plural(live, "session")), BLUE),
        span(projects.to_string(), MAGENTA),
        span(format!(" {}", plural(projects, "project")), BLUE),
    ])
}

fn plural(count: usize, word: &str) -> String {
    match count {
        1 => word.to_owned(),
        _ => format!("{word}s"),
    }
}

fn span<T>(text: T, fg: Color) -> Span<'static>
where
    T: Into<Cow<'static, str>>,
{
    Span::styled(text, Style::new().fg(fg))
}

/// Draws `line` from `(x, y)` to `area`'s right edge; nothing when that cell
/// is outside `area`.
fn put(line: Line<'_>, x: u16, y: u16, area: Rect, buf: &mut Buffer) {
    if area.contains(Position::new(x, y)) {
        line.render(Rect::new(x, y, area.right() - x, 1), buf);
    }
}

/// Draws `line` centred on `area`'s row `y`.
fn centre(line: Line<'_>, y: u16, area: Rect, buf: &mut Buffer) {
    let width = u16::try_from(line.width()).unwrap_or(u16::MAX);
    put(
        line,
        area.x + area.width.saturating_sub(width) / 2,
        y,
        area,
        buf,
    );
}

/// The colour `t` of the way from `from` to `to`.
fn lerp(from: Color, to: Color, t: f64) -> Color {
    let (Color::Rgb(r1, g1, b1), Color::Rgb(r2, g2, b2)) = (from, to) else {
        return from;
    };
    let mix = |a: u8, b: u8| (f64::from(a) + (f64::from(b) - f64::from(a)) * t).round() as u8;
    Color::Rgb(mix(r1, r2), mix(g1, g2), mix(b1, b2))
}

#[cfg(test)]
mod tests {
    use orb_domain::feat::harness::HarnessId;
    use std::time::SystemTime;

    use crate::test_support::sessions_for;
    use orb_domain::AppState;
    use orb_domain::feat::harness::claude::info;
    use orb_domain::feat::sessions::state::{
        Agent, AgentStatus, PaneLaunch, Project, ProjectKind, Sessions, SidebarItem,
    };
    use orb_domain::ids::{AgentId, PaneId, ProjectId, SessionId};
    use ratatui::buffer::{Buffer, Cell};
    use ratatui::layout::{Position, Rect};

    use super::{SHADOW, render};
    use crate::sidebar::ORANGE;

    /// `sessions` with the sessions its projects' agents run in.
    fn fill(sessions: Sessions) -> Sessions {
        Sessions {
            sessions: sessions_for(&sessions.projects),
            ..sessions
        }
    }

    fn agent(id: i64) -> Agent {
        Agent {
            last_session: None,
            harness: HarnessId::new("claude"),
            id: AgentId(id),
            title: Some("Fix the bug".to_owned()),
            cwd: "/Users/me/dev/orb".into(),
            transcript: None,
            status: AgentStatus::Idle,
            turn_started_at: None,
            pane: Some(PaneLaunch {
                pane: PaneId(id),
                session: SessionId(id),
            }),
            branch: Some("main".to_owned()),
            created_at: SystemTime::UNIX_EPOCH,
            last_activity_at: SystemTime::UNIX_EPOCH,
            unseen: false,
            model: None,
        }
    }

    /// orb holding `agents`, agent 1 selected.
    fn state(agents: Vec<Agent>) -> AppState {
        AppState {
            sessions: fill(Sessions {
                projects: vec![Project {
                    id: ProjectId(1),
                    title: "orb".to_owned(),
                    root: "/Users/me/dev/orb".into(),
                    created_at: SystemTime::UNIX_EPOCH,
                    removed: false,
                    repo: true,
                    agents,
                    kind: ProjectKind::Normal,
                }],
                cursor: Some(SidebarItem::Session(SessionId(1))),
                ..Sessions::default()
            }),
            home: "/Users/me".into(),
            ..AppState::default()
        }
    }

    /// orb's agent 1, selected.
    fn selected_agent() -> AppState {
        state(vec![agent(1)])
    }

    /// Draws `state`'s start screen on a `width`×`height` buffer with
    /// `pane_error`.
    fn draw(state: &AppState, pane_error: Option<&str>, width: u16, height: u16) -> Buffer {
        let mut buf = Buffer::empty(Rect::new(0, 0, width, height));
        render(state, pane_error, buf.area, &mut buf);
        buf
    }

    fn lines(buf: &Buffer) -> Vec<String> {
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .filter_map(|x| buf.cell((x, y)).map(Cell::symbol))
                    .collect()
            })
            .collect()
    }

    /// The first line holding `text`.
    fn line_with(buf: &Buffer, text: &str) -> String {
        lines(buf)
            .into_iter()
            .find(|line| line.contains(text))
            .unwrap_or_default()
    }

    #[rstest::rstest]
    fn wide_area_draws_the_orb_banner() {
        // Given a selected agent.
        let state = selected_agent();

        // When drawing the start screen 80×40.
        let buf = draw(&state, None, 80, 40);

        // Then every row of the ORB letters is drawn.
        let screen = lines(&buf).join("\n");
        assert!(
            SHADOW.iter().all(|row| screen.contains(row)),
            "screen was\n{screen}"
        );
    }

    #[rstest::rstest]
    fn start_screen_has_no_menu() {
        // Given a selected agent.
        let state = selected_agent();

        // When drawing the start screen 80×40.
        let buf = draw(&state, None, 80, 40);

        // Then no menu item or key is drawn.
        let screen = lines(&buf).join("\n");
        let keys = buf.content.iter().any(|cell| cell.fg == ORANGE);
        assert!(
            !screen.contains("New session") && !screen.contains("Quit") && !keys,
            "screen was\n{screen}"
        );
    }

    #[rstest::rstest]
    fn wide_area_draws_the_footer_counts() {
        // Given orb with two sessions, the first selected.
        let state = AppState {
            harnesses: vec![info()],
            ..state(vec![agent(1), agent(2)])
        };

        // When drawing the start screen 80×40.
        let buf = draw(&state, None, 80, 40);

        // Then the footer counts working agents, sessions and projects.
        let footer = line_with(&buf, "working");
        assert_eq!(
            footer.trim(),
            "✳ 0 working · 2 sessions · 1 project",
            "the footer"
        );
    }

    #[rstest::rstest]
    fn one_session_and_one_project_are_counted_in_the_singular() {
        // Given orb with one session.
        let state = selected_agent();

        // When drawing the start screen 80×40.
        let buf = draw(&state, None, 80, 40);

        // Then the footer says 1 session and 1 project.
        let footer = line_with(&buf, "working");
        assert!(
            footer.contains(" 1 session · 1 project"),
            "footer was '{footer}'"
        );
    }

    #[rstest::rstest]
    fn pane_error_shows_one_line_under_the_footer() {
        // Given a selected agent whose session couldn't start.
        let state = selected_agent();

        // When drawing the start screen 80×40 with the pane's error.
        let buf = draw(&state, Some("zmx attach failed"), 80, 40);

        // Then the error is on the line under the footer.
        let lines = lines(&buf);
        let under = lines
            .iter()
            .position(|line| line.contains("working"))
            .and_then(|footer| lines.get(footer + 1));
        assert_eq!(
            under.map(|line| line.trim()),
            Some("zmx attach failed"),
            "the line under the footer"
        );
    }

    #[rstest::rstest]
    fn small_area_draws_nothing_outside_itself() {
        // Given a selected agent and a 4×3 area inside a 40×20 buffer.
        let state = selected_agent();
        let area = Rect::new(10, 10, 4, 3);
        let mut buf = Buffer::empty(Rect::new(0, 0, 40, 20));

        // When drawing the start screen into the area.
        render(&state, Some("zmx attach failed"), area, &mut buf);

        // Then every cell outside the area is still blank.
        let drawn: Vec<Position> = buf
            .area
            .positions()
            .filter(|at| !area.contains(*at))
            .filter(|at| buf.cell(*at).is_some_and(|cell| cell.symbol() != " "))
            .collect();
        assert_eq!(drawn, [], "cells drawn outside the area");
    }
}
