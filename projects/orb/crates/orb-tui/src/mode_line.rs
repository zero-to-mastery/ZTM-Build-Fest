//! The mode line: orb's bottom row, drawn like LazyVim's lualine in
//! tokyonight-moon.
//!
//! On the left, the mode in a block of its colour, an arrow into the
//! active session's branch, then its place, `<project>/<title>`. On the
//! right, `N running`, `fetching origin/<base>…` while Start fetches, or
//! `starting session…` with a spinner, how many agents need an approval or
//! an answer, and the local time in the mode's colour. When the line is too
//! narrow, the right side stays whole and the left side is cut at its end.

use std::borrow::Cow;
use std::time::SystemTime;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use orb_domain::feat::picker::state::PickerState;
use orb_domain::feat::sessions::state::{AgentStatus, Sessions, SidebarItem};
use orb_domain::{AppState, Focus, PaneMode};
use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Style, Stylize};
use ratatui::text::{Line, Span};
use ratatui::widgets::Widget;

use crate::sidebar::{
    APPROVAL_ICON, BG_DARK, BLACK, BLUE, BRANCH, CYAN, FG_DARK, FOLDER, GREEN, GREEN1, GUTTER,
    INPUT_ICON, MAGENTA, ORANGE, SPINNER, SPINNER_FRAME, YELLOW,
};

/// Closes a left block into the next (Nerd Font `nf-pl-left_hard_divider`).
const ARROW_RIGHT: &str = "\u{e0b0}";
/// Opens a right block (`nf-pl-right_hard_divider`).
const ARROW_LEFT: &str = "\u{e0b2}";
/// Before the time (`nf-fa-clock_o`).
const CLOCK: &str = "\u{f017}";

/// Draws the mode line into `area`: the mode, the active session's branch and
/// project on the left; the activity, the approval and input counts and the
/// time `now` in `tz` on the right. The right side keeps its width, and the
/// left is cut at its end.
pub(crate) fn render(
    state: &AppState,
    now: SystemTime,
    tz: &TimeZone,
    area: Rect,
    buf: &mut Buffer,
) {
    let (mode, colour) = mode(state);
    let right = right(&state.sessions, colour, now, tz);
    let right_width = u16::try_from(right.width())
        .unwrap_or(u16::MAX)
        .min(area.width);
    let [left_area, right_area] =
        Layout::horizontal([Constraint::Fill(1), Constraint::Length(right_width)]).areas(area);
    buf.set_style(area, Style::new().bg(BG_DARK));
    left(state, mode, colour).render(left_area, buf);
    right.render(right_area, buf);
}

/// The mode's name and colour.
fn mode(state: &AppState) -> (&'static str, Color) {
    match state.focus {
        Focus::Pane => match state.pane_mode() {
            Some(PaneMode::Resize) => ("RESIZE", ORANGE),
            Some(PaneMode::Move) => ("MOVE", MAGENTA),
            None => ("PANE", GREEN1),
        },
        Focus::Sidebar => ("NORMAL", BLUE),
        Focus::Picker if state.picker.as_ref().is_some_and(PickerState::searching) => {
            ("INSERT", GREEN)
        }
        Focus::Picker => ("PICKER", YELLOW),
        Focus::Rename | Focus::Search => ("INSERT", GREEN),
    }
}

/// a · b · c: the mode block, the branch block when there's a branch, then the
/// project, all of the active session. The project reads `<project>/<title>`;
/// the branch is the active agent's (its lead agent's while the active row
/// is its card), else the one the session recorded. With nothing active,
/// only the mode block.
fn left(state: &AppState, mode: &str, colour: Color) -> Line<'static> {
    let sessions = &state.sessions;
    let active = sessions.active().and_then(|id| sessions.session(id));
    let (branch, project): (Option<&str>, Option<String>) = match (active, state.active_row()) {
        (Some(session), Some(row)) => {
            let agent = match row {
                SidebarItem::Agent { pane, .. } => sessions.agent_in(pane),
                SidebarItem::Session(_) | SidebarItem::SettledShelf | SidebarItem::Colonists(_) => {
                    sessions.agents(session.id).into_iter().next()
                }
            };
            (
                agent
                    .and_then(|agent| agent.branch.as_deref())
                    .or(session.branch.as_deref()),
                sessions
                    .project(session.project)
                    .map(|project| format!("{}/{}", project.title, sessions.title(session))),
            )
        }
        _ => (None, None),
    };
    let mut spans = vec![on(format!(" {mode} "), BLACK, colour).bold()];
    match branch {
        Some(branch) => spans.extend([
            on(ARROW_RIGHT, colour, GUTTER),
            on(format!(" {BRANCH} {branch} "), colour, GUTTER),
            on(ARROW_RIGHT, GUTTER, BG_DARK),
        ]),
        None => spans.push(on(ARROW_RIGHT, colour, BG_DARK)),
    }
    spans.push(on(" ", FG_DARK, BG_DARK));
    spans.extend(project.map(|project| on(format!("{FOLDER} {project} "), FG_DARK, BG_DARK)));
    Line::from(spans)
}

/// x · y: the activity and the counts, then the clock block.
fn right(sessions: &Sessions, colour: Color, now: SystemTime, tz: &TimeZone) -> Line<'static> {
    let counts = [
        (APPROVAL_ICON, AgentStatus::NeedsApproval, YELLOW),
        (INPUT_ICON, AgentStatus::NeedsInput, CYAN),
    ];
    let mut spans: Vec<Span<'static>> = activity(sessions, now)
        .map(|activity| on(format!("{activity}  "), ORANGE, BG_DARK))
        .into_iter()
        .chain(counts.into_iter().filter_map(|(icon, status, fg)| {
            match sessions.status_count(status) {
                0 => None,
                count => Some(on(format!("{icon} {count}  "), fg, BG_DARK)),
            }
        }))
        .collect();
    spans.push(on(ARROW_LEFT, colour, BG_DARK));
    spans.push(on(format!(" {CLOCK} {} ", clock(now, tz)), BLACK, colour).bold());
    Line::from(spans)
}

/// `<spinner> fetching origin/<b>…` while a start fetches, `<spinner> starting
/// session…`, `<spinner> N running`, or nothing.
fn activity(sessions: &Sessions, now: SystemTime) -> Option<String> {
    match (
        sessions.starting,
        &sessions.fetching,
        sessions.working_count(),
    ) {
        (true, Some(fetching), _) => Some(format!("{} fetching {fetching}…", spinner(now))),
        (true, None, _) => Some(format!("{} starting session…", spinner(now))),
        (false, _, 0) => None,
        (false, _, working) => Some(format!("{} {working} running", spinner(now))),
    }
}

/// `now` in `tz` as `HH:MM`, or `--:--` when jiff can't represent it.
fn clock(now: SystemTime, tz: &TimeZone) -> String {
    match Timestamp::try_from(now) {
        Ok(timestamp) => {
            let time = tz.to_datetime(timestamp);
            format!("{:02}:{:02}", time.hour(), time.minute())
        }
        Err(_) => "--:--".to_owned(),
    }
}

/// The spinner's frame: one per [`SPINNER_FRAME`] since the epoch, so it turns
/// with the loop's tick.
fn spinner(now: SystemTime) -> &'static str {
    let frames = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        / SPINNER_FRAME.as_millis();
    SPINNER
        .get(frames as usize % SPINNER.len())
        .copied()
        .unwrap_or_default()
}

/// `text` in `fg` on `bg`.
fn on<T>(text: T, fg: Color, bg: Color) -> Span<'static>
where
    T: Into<Cow<'static, str>>,
{
    Span::styled(text, Style::new().fg(fg).bg(bg))
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate parse failures with `?` and assert on the outcome"
)]
mod tests {
    use orb_domain::feat::harness::HarnessId;
    use std::time::{Duration, SystemTime};

    use crate::test_support::sessions_for;
    use jiff::tz::{self, TimeZone};
    use orb_domain::feat::picker::state::PickerState;
    use orb_domain::feat::sessions::state::{
        Agent, AgentStatus, PaneLaunch, Project, ProjectKind, Sessions, SidebarItem,
    };
    use orb_domain::ids::{AgentId, PaneId, ProjectId, SessionId};
    use orb_domain::{AppState, Focus, PaneMode};
    use ratatui::buffer::{Buffer, Cell};
    use ratatui::layout::Rect;
    use ratatui::style::Color;

    use super::render;
    use crate::sidebar::{BLUE, CYAN, FG_DARK, GREEN, GREEN1, YELLOW};

    /// 2023-11-14 22:13:20 UTC, at spinner frame 0.
    const NOW: u64 = 1_700_000_000;

    /// `sessions` with the sessions its projects' agents run in.
    fn fill(sessions: Sessions) -> Sessions {
        Sessions {
            sessions: sessions_for(&sessions.projects),
            ..sessions
        }
    }

    fn agent(id: i64, status: AgentStatus) -> Agent {
        Agent {
            last_session: None,
            harness: HarnessId::new("claude"),
            id: AgentId(id),
            title: Some("Fix the bug".to_owned()),
            cwd: "/Users/me/dev/orb".into(),
            transcript: None,
            status,
            turn_started_at: None,
            pane: Some(PaneLaunch {
                pane: PaneId(id),
                session: SessionId(id),
            }),
            branch: None,
            created_at: SystemTime::UNIX_EPOCH,
            last_activity_at: SystemTime::UNIX_EPOCH,
            unseen: false,
            model: None,
        }
    }

    fn project(id: i64, title: &str, agents: Vec<Agent>) -> Project {
        Project {
            id: ProjectId(id),
            title: title.to_owned(),
            root: format!("/Users/me/dev/{title}").into(),
            created_at: SystemTime::UNIX_EPOCH,
            removed: false,
            repo: true,
            agents,
            kind: ProjectKind::Normal,
        }
    }

    fn sessions(agents: Vec<Agent>) -> Sessions {
        fill(Sessions {
            projects: vec![project(1, "orb", agents)],
            ..Sessions::default()
        })
    }

    fn with_sessions(sessions: Sessions) -> AppState {
        AppState {
            sessions,
            ..AppState::default()
        }
    }

    /// Agent 1 (Idle) hovered and active, with the given focus.
    fn selected(focus: Focus) -> AppState {
        AppState {
            focus,
            sessions: Sessions {
                cursor: Some(SidebarItem::Session(SessionId(1))),
                active: Some(SessionId(1)),
                ..sessions(vec![agent(1, AgentStatus::Idle)])
            },
            ..AppState::default()
        }
    }

    /// Session 1 hovered and active, in a project titled `title`.
    fn selected_in(title: &str) -> AppState {
        AppState {
            sessions: Sessions {
                cursor: Some(SidebarItem::Session(SessionId(1))),
                active: Some(SessionId(1)),
                ..fill(Sessions {
                    projects: vec![project(1, title, vec![agent(1, AgentStatus::Idle)])],
                    ..Sessions::default()
                })
            },
            ..AppState::default()
        }
    }

    /// Draws `state`'s mode line `width` columns wide at `NOW` in `tz`.
    fn draw_in(state: &AppState, width: u16, tz: &TimeZone) -> Buffer {
        let mut buf = Buffer::empty(Rect::new(0, 0, width, 1));
        render(
            state,
            SystemTime::UNIX_EPOCH + Duration::from_secs(NOW),
            tz,
            buf.area,
            &mut buf,
        );
        buf
    }

    /// Draws `state`'s mode line 120 columns wide at `NOW` in UTC.
    fn draw(state: &AppState) -> Buffer {
        draw_in(state, 120, &TimeZone::UTC)
    }

    fn text(buffer: &Buffer) -> String {
        buffer.content.iter().map(Cell::symbol).collect()
    }

    /// The cell where `needle` starts.
    fn cell_at<'a>(buffer: &'a Buffer, needle: &str) -> Option<&'a Cell> {
        let symbols: Vec<&str> = buffer.content.iter().map(Cell::symbol).collect();
        let at = (0..symbols.len()).find(|&at| {
            symbols
                .get(at..)
                .is_some_and(|rest| rest.concat().starts_with(needle))
        })?;
        buffer.content.get(at)
    }

    #[rstest::rstest]
    fn mode_line_starts_with_the_mode_block() {
        // Given a selected agent in the sidebar.
        let state = selected(Focus::Sidebar);

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then it starts with the NORMAL block.
        let text = text(&buffer);
        assert!(text.starts_with(" NORMAL "), "mode line was '{text}'");
    }

    #[rstest::rstest]
    #[case::normal(Focus::Sidebar, BLUE)]
    #[case::pane(Focus::Pane, GREEN1)]
    #[case::picker(Focus::Picker, YELLOW)]
    #[case::search(Focus::Search, GREEN)]
    #[case::rename(Focus::Rename, GREEN)]
    fn mode_block_takes_the_mode_colour(#[case] focus: Focus, #[case] colour: Color) {
        // Given a selected agent with that focus.
        let state = selected(focus);

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then the mode name's first letter is on the mode's colour.
        assert_eq!(
            buffer.cell((1, 0)).map(|cell| cell.bg),
            Some(colour),
            "mode block background"
        );
    }

    #[rstest::rstest]
    #[case(Focus::Rename)]
    #[case(Focus::Search)]
    fn mode_line_shows_insert_while_typing(#[case] focus: Focus) {
        // Given the user typing in the rename box or the search.
        let state = AppState {
            focus,
            ..AppState::default()
        };

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then the mode is INSERT.
        let text = text(&buffer);
        assert!(text.starts_with(" INSERT "), "mode line was '{text}'");
    }

    #[rstest::rstest]
    fn mode_line_shows_insert_in_a_list_pickers_search() {
        // Given the session picker in search mode with the keys.
        let picker = {
            let mut picker = PickerState::sessions(vec![], Focus::Sidebar);
            picker.start_search();
            picker
        };
        let state = AppState {
            focus: Focus::Picker,
            picker: Some(picker),
            ..AppState::default()
        };

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then the mode is INSERT.
        let text = text(&buffer);
        assert!(text.starts_with(" INSERT "), "mode line was '{text}'");
    }

    #[rstest::rstest]
    fn mode_line_shows_picker_in_a_list_pickers_list() {
        // Given the session picker in list mode with the keys.
        let state = AppState {
            focus: Focus::Picker,
            picker: Some(PickerState::sessions(vec![], Focus::Sidebar)),
            ..AppState::default()
        };

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then the mode is PICKER.
        let text = text(&buffer);
        assert!(text.starts_with(" PICKER "), "mode line was '{text}'");
    }

    #[rstest::rstest]
    #[case::pane(Focus::Pane, " PANE ")]
    #[case::picker(Focus::Picker, " PICKER ")]
    fn mode_line_names_the_focus_mode(#[case] focus: Focus, #[case] block: &str) {
        // Given a selected agent with that focus.
        let state = selected(focus);

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then the mode block names that mode.
        let text = text(&buffer);
        assert!(text.starts_with(block), "mode line was '{text}'");
    }

    #[rstest::rstest]
    #[case::resize(PaneMode::Resize, " RESIZE ")]
    #[case::move_(PaneMode::Move, " MOVE ")]
    fn mode_line_names_the_pane_mode(#[case] mode: PaneMode, #[case] block: &str) {
        // Given a selected agent with the keys in a pane in that mode.
        let state = AppState {
            pane_mode: Some(mode),
            ..selected(Focus::Pane)
        };

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then the mode block names the pane mode.
        let text = text(&buffer);
        assert!(text.starts_with(block), "mode line was '{text}'");
    }

    #[rstest::rstest]
    fn project_shows_the_sessions_title_on_a_session() {
        // Given session 1 selected, its agent titled `Fix the bug`, in orb.
        let state = selected(Focus::Sidebar);

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then the project reads orb/Fix the bug.
        let text = text(&buffer);
        assert!(
            text.contains("\u{f07b} orb/Fix the bug"),
            "mode line was '{text}'"
        );
    }

    #[rstest::rstest]
    fn branch_block_shows_the_sessions_branch() {
        // Given a selected session that recorded branch orb/y, its agent on
        // no branch.
        let mut state = selected(Focus::Sidebar);
        for session in &mut state.sessions.sessions {
            session.branch = Some("orb/y".to_owned());
        }

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then the branch block names orb/y.
        let text = text(&buffer);
        assert!(text.contains("\u{e0a0} orb/y"), "mode line was '{text}'");
    }

    #[rstest::rstest]
    fn branch_block_shows_the_lead_agents_branch() {
        // Given an active session whose agent is on branch orb/x.
        let state = with_sessions(Sessions {
            active: Some(SessionId(1)),
            ..sessions(vec![Agent {
                branch: Some("orb/x".to_owned()),
                ..agent(1, AgentStatus::Idle)
            }])
        });

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then the branch block names orb/x.
        let text = text(&buffer);
        assert!(text.contains("\u{e0a0} orb/x"), "mode line was '{text}'");
    }

    #[rstest::rstest]
    fn no_branch_block_without_a_branch() {
        // Given a selected agent with no branch.
        let state = selected(Focus::Sidebar);

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then there is no branch icon.
        let text = text(&buffer);
        assert!(!text.contains('\u{e0a0}'), "mode line was '{text}'");
    }

    #[rstest::rstest]
    fn project_follows_the_branch_in_fg_dark() {
        // Given a selected agent in project orb.
        let state = selected(Focus::Sidebar);

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then the project shows in fg_dark.
        assert_eq!(
            cell_at(&buffer, "\u{f07b} orb").map(|cell| cell.fg),
            Some(FG_DARK),
            "project foreground in '{}'",
            text(&buffer)
        );
    }

    /// Agents 1 (branch `main`) and 2 (titled `Other`, branch `orb/z`),
    /// the hover on session 2 and session 1 active.
    fn hover_on_two_active_one() -> AppState {
        with_sessions(Sessions {
            cursor: Some(SidebarItem::Session(SessionId(2))),
            active: Some(SessionId(1)),
            ..sessions(vec![
                Agent {
                    branch: Some("main".to_owned()),
                    ..agent(1, AgentStatus::Idle)
                },
                Agent {
                    title: Some("Other".to_owned()),
                    branch: Some("orb/z".to_owned()),
                    ..agent(2, AgentStatus::Idle)
                },
            ])
        })
    }

    #[rstest::rstest]
    fn branch_block_shows_the_active_sessions_branch_not_the_hovers() {
        // Given the hover on session 2 and session 1, on main, active.
        let state = hover_on_two_active_one();

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then the branch block names main.
        let text = text(&buffer);
        assert!(text.contains("\u{e0a0} main"), "mode line was '{text}'");
    }

    #[rstest::rstest]
    fn project_shows_the_active_session_not_the_hovered_one() {
        // Given the hover on session 2 (Other) and session 1 active.
        let state = hover_on_two_active_one();

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then the project reads session 1's orb/Fix the bug.
        let text = text(&buffer);
        assert!(
            text.contains("\u{f07b} orb/Fix the bug"),
            "mode line was '{text}'"
        );
    }

    #[rstest::rstest]
    fn nothing_active_shows_only_the_mode_block() {
        // Given a hovered agent on a branch, but no active session.
        let state = with_sessions(Sessions {
            cursor: Some(SidebarItem::Session(SessionId(1))),
            ..sessions(vec![Agent {
                branch: Some("orb/x".to_owned()),
                ..agent(1, AgentStatus::Idle)
            }])
        });

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then there is no branch or project.
        let text = text(&buffer);
        assert!(
            !text.contains('\u{e0a0}') && !text.contains('\u{f07b}') && !text.contains('/'),
            "mode line was '{text}'"
        );
    }

    #[rstest::rstest]
    fn error_is_not_on_the_mode_line() {
        // Given a failure.
        let state = with_sessions(Sessions {
            error: Some("Workspace locked".to_owned()),
            ..Sessions::default()
        });

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then the error is not on it.
        let text = text(&buffer);
        assert!(!text.contains("Workspace locked"), "mode line was '{text}'");
    }

    #[rstest::rstest]
    fn activity_counts_working_agents() {
        // Given three working agents.
        let state = with_sessions(sessions(vec![
            agent(1, AgentStatus::Working),
            agent(2, AgentStatus::Working),
            agent(3, AgentStatus::Working),
        ]));

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then it counts three running.
        let text = text(&buffer);
        assert!(text.contains("3 running"), "mode line was '{text}'");
    }

    #[rstest::rstest]
    fn activity_shows_starting_session() {
        // Given a session being started.
        let state = with_sessions(Sessions {
            starting: true,
            ..sessions(vec![])
        });

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then it says a session is starting.
        let text = text(&buffer);
        assert!(text.contains("starting session…"), "mode line was '{text}'");
    }

    #[rstest::rstest]
    fn activity_shows_the_fetch_in_progress() {
        // Given a session being started while origin/main is fetched.
        let state = with_sessions(Sessions {
            starting: true,
            fetching: Some("origin/main".to_owned()),
            ..sessions(vec![])
        });

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then it says origin/main is being fetched.
        let text = text(&buffer);
        assert!(
            text.contains("fetching origin/main…"),
            "mode line was '{text}'"
        );
    }

    #[rstest::rstest]
    fn activity_ignores_a_fetch_without_a_start() {
        // Given a fetch left set with no session being started and no agent working.
        let state = with_sessions(Sessions {
            fetching: Some("origin/main".to_owned()),
            ..sessions(vec![])
        });

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then it says nothing about fetching.
        let text = text(&buffer);
        assert!(!text.contains("fetching"), "mode line was '{text}'");
    }

    #[rstest::rstest]
    fn starting_spinner_turns_a_frame_later() {
        // Given a session being started and no agent working.
        let state = with_sessions(Sessions {
            starting: true,
            ..sessions(vec![])
        });

        // When drawing the mode line one spinner frame after `NOW`.
        let buffer = {
            let mut buf = Buffer::empty(Rect::new(0, 0, 120, 1));
            let now = SystemTime::UNIX_EPOCH + Duration::from_secs(NOW) + super::SPINNER_FRAME;
            render(&state, now, &TimeZone::UTC, buf.area, &mut buf);
            buf
        };

        // Then the spinner beside it shows its second frame.
        let text = text(&buffer);
        assert!(
            text.contains("⠙ starting session…"),
            "mode line was '{text}'"
        );
    }

    #[rstest::rstest]
    fn no_activity_when_idle() {
        // Given only idle agents.
        let state = with_sessions(sessions(vec![
            agent(1, AgentStatus::Idle),
            agent(2, AgentStatus::Idle),
        ]));

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then there is no activity.
        let text = text(&buffer);
        assert!(
            !text.contains("running") && !text.contains("starting"),
            "mode line was '{text}'"
        );
    }

    #[rstest::rstest]
    fn approval_count_follows_the_activity() {
        // Given one working agent and one waiting for an approval.
        let state = with_sessions(sessions(vec![
            agent(1, AgentStatus::Working),
            agent(2, AgentStatus::NeedsApproval),
        ]));

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then the approval count comes after the activity.
        let text = text(&buffer);
        assert!(
            text.find("1 running")
                .zip(text.find("\u{f071} 1"))
                .is_some_and(|(running, approvals)| running < approvals),
            "mode line was '{text}'"
        );
        // And it is yellow.
        assert_eq!(
            cell_at(&buffer, "\u{f071} 1").map(|cell| cell.fg),
            Some(YELLOW),
            "approval count foreground"
        );
    }

    #[rstest::rstest]
    fn input_count_shows_on_the_right() {
        // Given one agent waiting for an answer.
        let state = with_sessions(sessions(vec![agent(1, AgentStatus::NeedsInput)]));

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then the input count shows in cyan.
        assert_eq!(
            cell_at(&buffer, "\u{f059} 1").map(|cell| cell.fg),
            Some(CYAN),
            "input count foreground in '{}'",
            text(&buffer)
        );
    }

    #[rstest::rstest]
    fn counts_include_agents_the_filter_hides() {
        // Given a working agent in jinn while the sidebar shows only orb.
        let state = with_sessions(fill(Sessions {
            projects: vec![
                project(1, "orb", vec![agent(1, AgentStatus::Idle)]),
                project(2, "jinn", vec![agent(2, AgentStatus::Working)]),
            ],
            filter: Some(ProjectId(1)),
            ..Sessions::default()
        }));

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then the hidden agent still counts.
        let text = text(&buffer);
        assert!(text.contains("1 running"), "mode line was '{text}'");
    }

    #[rstest::rstest]
    fn no_row_position_on_the_right() {
        // Given seven agents, the hover and the active session on agent 5.
        let state = with_sessions(Sessions {
            cursor: Some(SidebarItem::Session(SessionId(5))),
            active: Some(SessionId(5)),
            ..sessions((1..=7).map(|id| agent(id, AgentStatus::Idle)).collect())
        });

        // When drawing the mode line.
        let buffer = draw(&state);

        // Then no n/m position shows.
        let text = text(&buffer);
        assert!(!text.contains(" 3/7 "), "mode line was '{text}'");
    }

    #[rstest::rstest]
    fn clock_shows_local_time() {
        // Given a zone at +07:00, where NOW is 05:13.
        let zone = TimeZone::fixed(tz::offset(7));

        // When drawing the mode line in that zone.
        let buffer = draw_in(&AppState::default(), 120, &zone);

        // Then the clock shows 05:13.
        let text = text(&buffer);
        assert!(text.contains("05:13"), "mode line was '{text}'");
    }

    #[rstest::rstest]
    #[case::before_the_switch("2026-03-08T06:30:00Z", "01:30")]
    #[case::after_the_switch("2026-03-08T07:30:00Z", "03:30")]
    fn clock_follows_a_dst_switch(
        #[case] instant: &str,
        #[case] expected: &str,
    ) -> Result<(), jiff::Error> {
        // Given US Eastern time, which springs forward at 07:00 UTC on 2026-03-08.
        let zone = TimeZone::posix("EST5EDT,M3.2.0,M11.1.0")?;
        let now = SystemTime::from(instant.parse::<jiff::Timestamp>()?);

        // When drawing the mode line at that instant in that zone.
        let mut buffer = Buffer::empty(Rect::new(0, 0, 120, 1));
        render(&AppState::default(), now, &zone, buffer.area, &mut buffer);

        // Then the clock shows the local time on that side of the switch.
        let text = text(&buffer);
        assert!(text.contains(expected), "mode line was '{text}'");
        Ok(())
    }

    #[rstest::rstest]
    fn narrow_line_keeps_the_right_side_whole() {
        // Given a selected session in a long-named project.
        let state = selected_in("a-project-name-long-enough-to-run-past-the-clock-retry");

        // When drawing the mode line 60 columns wide.
        let buffer = draw_in(&state, 60, &TimeZone::UTC);

        // Then the clock block is whole at the end.
        let text = text(&buffer);
        assert!(text.ends_with(" \u{f017} 22:13 "), "mode line was '{text}'");
        // And the project is cut.
        assert!(!text.contains("retry"), "mode line was '{text}'");
    }

    #[rstest::rstest]
    fn narrow_line_cuts_the_project_before_the_mode_block() {
        // Given a selected session in a long-named project.
        let state = selected_in("a-project-name-long-enough-to-run-past-the-clock-retry");

        // When drawing the mode line 60 columns wide.
        let buffer = draw_in(&state, 60, &TimeZone::UTC);

        // Then the line still starts with the mode block.
        let text = text(&buffer);
        assert!(text.starts_with(" NORMAL "), "mode line was '{text}'");
    }

    #[rstest::rstest]
    fn line_as_wide_as_the_right_side_shows_only_the_right_side() {
        // Given nothing selected, so the right side is the 10-column clock block.
        let state = AppState::default();

        // When drawing the mode line exactly 10 columns wide.
        let buffer = draw_in(&state, 10, &TimeZone::UTC);

        // Then the line is the whole clock block and nothing of the left.
        let text = text(&buffer);
        assert_eq!(text, "\u{e0b2} \u{f017} 22:13 ", "mode line");
    }

    #[rstest::rstest]
    fn line_narrower_than_the_right_side_cuts_the_right_side_at_its_end() {
        // Given nothing selected, so the right side is the 10-column clock block.
        let state = AppState::default();

        // When drawing the mode line 6 columns wide.
        let buffer = draw_in(&state, 6, &TimeZone::UTC);

        // Then the clock block shows from its start and is cut at its end.
        let text = text(&buffer);
        assert_eq!(text, "\u{e0b2} \u{f017} 22", "mode line");
    }

    #[rstest::rstest]
    #[case(0)]
    #[case(1)]
    fn tiny_line_draws_without_panicking(#[case] width: u16) {
        // Given a working agent.
        let state = with_sessions(sessions(vec![agent(1, AgentStatus::Working)]));

        // When drawing the mode line that narrow.
        let buffer = draw_in(&state, width, &TimeZone::UTC);

        // Then it fills exactly that many cells.
        assert_eq!(buffer.content.len(), usize::from(width), "mode line cells");
    }

    #[rstest::rstest]
    fn wide_grapheme_at_the_cut_is_dropped_whole() {
        // Given a selected session in a project whose wide character would
        // straddle the cut.
        let state = selected_in("a日");

        // When drawing the mode line so the left side ends mid-character.
        let buffer = draw_in(&state, 24, &TimeZone::UTC);

        // Then the wide character is left out and the right side stays whole.
        let text = text(&buffer);
        assert_eq!(
            text, " NORMAL \u{e0b0} \u{f07b} a \u{e0b2} \u{f017} 22:13 ",
            "mode line"
        );
    }
}
