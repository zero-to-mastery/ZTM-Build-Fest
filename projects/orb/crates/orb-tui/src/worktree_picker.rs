//! The worktree picker, drawn in the session picker's snacks frame: a float
//! over the sidebar and the right side holding a list box and a preview box,
//! side by side from 120 columns and stacked below that.
//!
//! The list box is titled `Worktrees`. Its input row holds the typed text and
//! how many worktrees are shown out of those listed, over an orange rule.
//! Each row is the worktree's icon, its dim `<repo>/` and its `orb-<hex>`
//! name, an orange count of uncommitted changes, and on the right what uses
//! it: `active ·` and the title of the newest open session, how long since it
//! settled, or `no session`.
//!
//! The preview box is titled with the selected row's label. It shows the
//! worktree's state, branch and size, then its path, branch, size, changes,
//! last commit, last use and what the next sweep does with it, then one line
//! per session using it. Facts git hasn't reported yet show as
//! `…`. The popup's bottom row, under both boxes, holds the picker's keys,
//! dim.

use std::path::Path;
use std::time::{Duration, SystemTime};

use orb_domain::AppState;
use orb_domain::feat::picker::list::{Matches, PickerItem};
use orb_domain::feat::picker::state::PickerState;
use orb_domain::feat::sessions::state::Sessions;
use orb_domain::feat::worktrees::state::{
    RowState, User, Verdict, Worktree, last_used, row_state, users, verdict,
};
use orb_domain::tilde;
use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Widget};

use crate::mouse::HitMap;
use crate::picker::{PickerScroll, WORKTREE, cut_left, highlight, span};
use crate::session_picker::{big, boxed, boxes, cut_right, render_input, with_hints};
use crate::sidebar::{
    BG_DARK, BLUE, BRANCH, COMMENT, COMPLETED_ICON, DARK3, DARK5, FG, FG_DARK, GREEN, GUTTER,
    ORANGE, RED, VISUAL, YELLOW, ago_label, render_split, session_status,
};

/// Draws the worktree picker over `area`: `picker`'s rows with live facts,
/// sizes and users from `state`, and the selected worktree's preview.
/// Returns how many rows the list fits and where the terminal cursor goes in
/// the input. Records the popup, the list box as the wheel's area and the
/// list's rows in `hits`; the preview maps to no row and takes no wheel.
pub(crate) fn render(
    picker: &PickerState,
    state: &AppState,
    now: SystemTime,
    area: Rect,
    buf: &mut Buffer,
    scroll: &mut PickerScroll,
    hits: &mut HitMap,
) -> (usize, Position) {
    let popup = big(area);
    Clear.render(popup, buf);
    buf.set_style(popup, Style::new().bg(BG_DARK));
    hits.record_overlay(popup);
    let frame = with_hints(picker, popup, buf);
    let [list_box, preview_box] = boxes(frame, area.width >= 120);
    hits.record_selector(list_box);
    let drawn = render_list(picker, state, now, list_box, buf, scroll, hits);
    render_preview(picker, state, now, preview_box, buf);
    drawn
}

/// A worktree as drawn: the worktree as last read, what uses it, what the
/// next sweep does with it, and its row state.
struct Row<'a> {
    worktree: &'a Worktree,
    users: Vec<User<'a>>,
    verdict: Verdict,
    state: RowState,
}

impl<'a> Row<'a> {
    /// The worktree at `path` in `app` at `now`; `None` once it's gone from
    /// the list.
    fn of(app: &'a AppState, path: &Path, now: SystemTime) -> Option<Self> {
        let worktree = app
            .worktrees
            .list
            .iter()
            .find(|worktree| worktree.path == path)?;
        let users = users(app, path);
        let verdict = verdict(&users, worktree.facts.as_ref(), &app.attached, now);
        Some(Self {
            worktree,
            state: row_state(&users, verdict),
            users,
            verdict,
        })
    }

    /// Uncommitted changes; `None` until git reports them.
    fn changes(&self) -> Option<usize> {
        self.worktree.facts.as_ref().map(|facts| facts.changes)
    }

    /// The user the row speaks for: the newest unsettled one, else the
    /// newest.
    fn lead(&self) -> Option<&User<'a>> {
        self.users.iter().max_by_key(|user| {
            (
                settled_at(user).is_none(),
                last_used(std::slice::from_ref(*user), None),
            )
        })
    }

    /// The row's icon: the lead session's status while active, a dim check
    /// once settled, a dim fork with nothing using it.
    fn icon(&self, app: &AppState, now: SystemTime) -> Span<'static> {
        match (
            self.state,
            self.lead().map(|user| user_status(user, app, now)),
        ) {
            (RowState::Active, Some(status)) => user_icon(status),
            (RowState::Settled, _) => span(format!("{COMPLETED_ICON} "), DARK3),
            (RowState::Active | RowState::Orphan, _) => span(format!("{WORKTREE} "), DARK3),
        }
    }

    /// When the last of its users settled.
    fn settled(&self) -> Option<SystemTime> {
        self.users.iter().filter_map(settled_at).max()
    }
}

/// When `user` was settled; `None` while it's open.
fn settled_at(user: &User<'_>) -> Option<SystemTime> {
    match user {
        User::Session(_, session, _) => session.settled_at,
    }
}

/// A session user's status glyph, word and colour (see [`session_status`]).
fn user_status(
    user: &User<'_>,
    app: &AppState,
    now: SystemTime,
) -> (&'static str, Option<&'static str>, Color) {
    match user {
        User::Session(_, session, agents) => {
            session_status(agents, app.attached.contains(&session.id), now)
        }
    }
}

/// `user`'s title: the session's.
fn user_title(user: &User<'_>, sessions: &Sessions) -> String {
    match user {
        User::Session(_, session, _) => sessions.title(session),
    }
}

/// A status glyph in its colour.
fn user_icon((glyph, _, fg): (&str, Option<&str>, Color)) -> Span<'static> {
    span(format!("{glyph} "), fg)
}

/// How long before `now` `at` was, as the sidebar says it.
fn ago(now: SystemTime, at: SystemTime) -> String {
    ago_label(now.duration_since(at).unwrap_or_default())
}

/// What the next sweep does with a worktree, and the colour to say it in.
fn sweep(verdict: Verdict) -> (String, Color) {
    let (text, fg) = match verdict {
        Verdict::Attached => ("kept: a session in it is attached", DARK5),
        Verdict::MidTurn => ("kept: an agent in it is mid-turn", DARK5),
        Verdict::Active => ("kept: a session in it is active", DARK5),
        Verdict::Dirty => ("kept: uncommitted changes", ORANGE),
        Verdict::Unknown => ("…", DARK5),
        Verdict::PruneNow => ("prunes at next sweep", RED),
        Verdict::PruneIn(left) => return (format!("prunes in {}", countdown(left)), YELLOW),
    };
    (text.to_owned(), fg)
}

/// `left` in whole days, or in hours rounded up under a day.
fn countdown(left: Duration) -> String {
    match left.as_secs() / 86_400 {
        0 => format!("{}h", left.as_secs().div_ceil(3600)),
        days => format!("{days}d"),
    }
}

/// A size in KB as `N.NG`, `NM` or `NK`; `…` until it's known.
fn size_label(kb: Option<u64>) -> String {
    const MB: u64 = 1024;
    const GB: u64 = 1024 * 1024;
    match kb {
        None => "…".to_owned(),
        Some(kb) if kb >= GB => format!("{}.{}G", kb / GB, kb % GB * 10 / GB),
        Some(kb) if kb >= MB => format!("{}M", kb / MB),
        Some(kb) => format!("{kb}K"),
    }
}

/// The list box: title, input row with the count, orange rule, rows.
/// Records each row in `hits`. Returns the rows' height and the cursor.
fn render_list(
    picker: &PickerState,
    state: &AppState,
    now: SystemTime,
    area: Rect,
    buf: &mut Buffer,
    scroll: &mut PickerScroll,
    hits: &mut HitMap,
) -> (usize, Position) {
    let block = boxed(Some(Line::from(span(" Worktrees ", BLUE))));
    let inner = block.inner(area);
    block.render(area, buf);
    let [input, rule, rows] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Fill(1),
    ])
    .areas(inner);
    let shown: Vec<(&PickerItem, &Matches)> = picker.shown().collect();
    let count = format!("{}/{}", shown.len(), picker.total());
    let cursor = render_input(picker, &count, input, buf, hits);
    Line::from(span("─".repeat(usize::from(rule.width)), ORANGE)).render(rule, buf);
    let page = usize::from(rows.height).max(1);
    let offset = scroll.follow(picker.selection(), shown.len(), page);
    for ((index, (item, matches)), y) in shown
        .into_iter()
        .enumerate()
        .skip(offset)
        .zip(rows.top()..rows.bottom())
    {
        let row = Rect::new(rows.x, y, rows.width, 1);
        hits.record_picker_row(row, index);
        if index == picker.selection() {
            buf.set_style(row, Style::new().bg(VISUAL));
        }
        render_row(item, matches, state, now, row, buf);
    }
    (page, cursor)
}

/// One worktree row: its icon, its label with `<repo>/` dim and the matches
/// lit, its change count, and what uses it on the right. A worktree gone
/// from the list shows only its label, dim.
fn render_row(
    item: &PickerItem,
    matches: &Matches,
    state: &AppState,
    now: SystemTime,
    area: Rect,
    buf: &mut Buffer,
) {
    let PickerItem::Worktree {
        path, label, split, ..
    } = item
    else {
        return;
    };
    let area = Rect {
        width: area.width.saturating_sub(1),
        ..area
    };
    let Some(row) = Row::of(state, path, now) else {
        let gone = highlight(label, &matches.name, |_| DARK3);
        std::iter::once(Span::raw("   "))
            .chain(gone)
            .collect::<Line>()
            .render(area, buf);
        return;
    };
    let (dim, bright) = match row.state {
        RowState::Active => (DARK5, FG),
        RowState::Settled | RowState::Orphan => (DARK3, COMMENT),
    };
    let mut left = vec![Span::raw(" "), row.icon(state, now)];
    left.extend(highlight(label, &matches.name, |at| {
        if at < *split { dim } else { bright }
    }));
    if let Some(changes) = row.changes().filter(|&changes| changes > 0) {
        left.push(span(format!(" ●{changes}"), ORANGE));
    }
    let left = Line::from(left);
    let right = match row.state {
        RowState::Active => {
            let active = span("active · ", GREEN);
            let room = usize::from(area.width).saturating_sub(left.width() + 2 + active.width());
            let title = row
                .lead()
                .map(|user| user_title(user, &state.sessions))
                .unwrap_or_default();
            Line::from(vec![active, span(cut_right(&title, room), FG_DARK)])
        }
        RowState::Settled => {
            let ago = row.settled().map(|at| ago(now, at)).unwrap_or_default();
            Line::from(span(format!("settled {ago}"), COMMENT))
        }
        RowState::Orphan => Line::from(span("no session", DARK3)),
    };
    render_split(left, right, area, buf);
}

/// The preview box: untitled and empty with nothing selected, else titled
/// with the row's label and holding the worktree's card.
fn render_preview(
    picker: &PickerState,
    state: &AppState,
    now: SystemTime,
    area: Rect,
    buf: &mut Buffer,
) {
    let Some(PickerItem::Worktree { path, label, .. }) = picker.selected() else {
        boxed(None).render(area, buf);
        return;
    };
    let block = boxed(Some(Line::from(span(format!(" {label} "), BLUE))));
    let inner = block.inner(area);
    block.render(area, buf);
    let Some(row) = Row::of(state, path, now) else {
        return;
    };
    for (line, y) in card(&row, state, now, inner.width)
        .into_iter()
        .zip(inner.top()..inner.bottom())
    {
        line.render(Rect::new(inner.x, y, inner.width, 1), buf);
    }
}

/// The preview's lines `width` wide: the meta line over a rule, the field
/// table, a dotted rule, then `Used by N` and a line per user.
fn card(row: &Row<'_>, app: &AppState, now: SystemTime, width: u16) -> Vec<Line<'static>> {
    let facts = row.worktree.facts.as_ref();
    let size = size_label(row.worktree.size_kb);
    let room = usize::from(width).saturating_sub(17);
    let mut lines = vec![meta(row, app, now, &size)];
    lines.push(Line::from(span("─".repeat(usize::from(width)), DARK3)));
    lines.push(field(
        "Path",
        vec![span(
            cut_left(&tilde(&row.worktree.path, &app.home), room),
            FG_DARK,
        )],
    ));
    let branch = match facts {
        None => "…".to_owned(),
        Some(facts) => facts
            .branch
            .clone()
            .unwrap_or_else(|| "(detached)".to_owned()),
    };
    lines.push(field("Branch", vec![span(branch, FG_DARK)]));
    lines.push(field("Size", vec![span(size, FG_DARK)]));
    let changes = match row.changes() {
        None => span("…", DARK5),
        Some(0) => span("clean", GREEN),
        Some(changes) => span(format!("{changes} uncommitted"), ORANGE),
    };
    lines.push(field("Changes", vec![changes]));
    if let Some((at, subject)) = facts.and_then(|facts| facts.last_commit.as_ref()) {
        let ago = format!("{:<4}", ago(now, *at));
        let subject = cut_right(subject, room.saturating_sub(ago.len()));
        lines.push(field(
            "Last commit",
            vec![span(ago, DARK5), span(subject, FG_DARK)],
        ));
    }
    let used = last_used(&row.users, facts).map_or_else(|| "never".to_owned(), |at| ago(now, at));
    lines.push(field("Last used", vec![span(used, FG_DARK)]));
    let (sweep, fg) = sweep(row.verdict);
    lines.push(field("Sweep", vec![span(sweep, fg)]));
    lines.push(Line::from(span(
        format!(" {}", "┄".repeat(usize::from(width).saturating_sub(2))),
        GUTTER,
    )));
    lines.push(Line::from(Span::styled(
        format!(" Used by {}", row.users.len()),
        Style::new().fg(BLUE).add_modifier(Modifier::BOLD),
    )));
    if row.users.is_empty() {
        lines.push(Line::from(span("   Nothing uses it", COMMENT)));
    }
    lines.extend(
        row.users
            .iter()
            .map(|user| user_line(user, app, now, usize::from(width))),
    );
    lines
}

/// The preview's first line: the icon, the state word, the branch and the
/// size.
fn meta(row: &Row<'_>, app: &AppState, now: SystemTime, size: &str) -> Line<'static> {
    let (word, fg) = match row.state {
        RowState::Active => ("active", GREEN),
        RowState::Settled => ("settled", COMMENT),
        RowState::Orphan => ("no session", DARK5),
    };
    let mut spans = vec![Span::raw(" "), row.icon(app, now), span(word, fg)];
    if let Some(branch) = row
        .worktree
        .facts
        .as_ref()
        .and_then(|facts| facts.branch.as_deref())
    {
        spans.push(span(" · ", DARK3));
        spans.push(span(format!("{BRANCH} {branch}"), DARK5));
    }
    spans.push(span(" · ", DARK3));
    spans.push(span(size.to_owned(), DARK5));
    Line::from(spans)
}

/// A field table row: `name` dim in a 12-wide column, then `value`.
fn field(name: &str, value: Vec<Span<'static>>) -> Line<'static> {
    std::iter::once(span(format!("   {name:<12}"), COMMENT))
        .chain(value)
        .collect()
}

/// One `Used by` line `width` wide: the user's icon, its dim `<project>/`
/// and bright title, and on the right its status and how long since its
/// last chat, or how long since it settled.
fn user_line(user: &User<'_>, app: &AppState, now: SystemTime, width: usize) -> Line<'static> {
    let (icon, when) = match settled_at(user) {
        Some(at) => (
            span(format!("{COMPLETED_ICON} "), DARK3),
            format!("settled {}", ago(now, at)),
        ),
        None => {
            let status = user_status(user, app, now);
            let last = last_used(std::slice::from_ref(user), None).unwrap_or(now);
            (
                user_icon(status),
                format!("{} · {}", status.1.unwrap_or("idle"), ago(now, last)),
            )
        }
    };
    let User::Session(project, ..) = user;
    let mut line = Line::from(vec![
        Span::raw("   "),
        icon,
        span(format!("{}/", project.title), DARK5),
        span(user_title(user, &app.sessions), FG),
    ]);
    let gap = width.saturating_sub(line.width() + Line::raw(when.as_str()).width() + 1);
    line.spans.push(Span::raw(" ".repeat(gap.max(1))));
    line.spans.push(span(when, DARK3));
    line
}

#[cfg(test)]
mod tests {
    use orb_domain::feat::harness::HarnessId;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use orb_domain::feat::git::git_service::WorktreeFacts;
    use orb_domain::feat::picker::state::{PickerState, worktree_items};
    use orb_domain::feat::sessions::state::{
        Agent, AgentStatus, PaneLaunch, Project, ProjectKind, Sessions,
    };
    use orb_domain::feat::worktrees::state::{Worktree, Worktrees};
    use orb_domain::ids::{AgentId, PaneId, ProjectId, SessionId};
    use orb_domain::{AppState, Focus};
    use ratatui::buffer::{Buffer, Cell};
    use ratatui::layout::{Position, Rect};
    use ratatui::style::Color;
    use unicode_segmentation::UnicodeSegmentation;

    use super::render;
    use crate::mouse::HitMap;
    use crate::picker::PickerScroll;
    use crate::sidebar::{DARK5, GREEN, ORANGE, RED, YELLOW};
    use crate::test_support::sessions_for;

    /// The clock every picker is drawn at.
    fn now() -> SystemTime {
        UNIX_EPOCH + Duration::from_hours(24 * 30)
    }

    /// `name`'s path under `~/.orb/worktrees/orb/`.
    fn path(name: &str) -> PathBuf {
        PathBuf::from("/Users/me/.orb/worktrees/orb").join(name)
    }

    /// Idle agent `id` titled `title` in the worktree `name`, last active
    /// five minutes before [`now`].
    fn agent(id: i64, title: &str, name: &str) -> Agent {
        Agent {
            last_session: None,
            harness: HarnessId::new("claude"),
            id: AgentId(id),
            title: Some(title.to_owned()),
            cwd: path(name),
            transcript: None,
            status: AgentStatus::Idle,
            turn_started_at: None,
            pane: Some(PaneLaunch {
                pane: PaneId(id),
                session: SessionId(id),
            }),
            branch: None,
            created_at: UNIX_EPOCH,
            last_activity_at: now() - Duration::from_mins(5),
            unseen: false,
            model: None,
        }
    }

    /// `agent`, last active `days` before [`now`].
    fn idle_for(agent: Agent, days: u64) -> Agent {
        Agent {
            last_activity_at: now() - Duration::from_hours(24 * days),
            ..agent
        }
    }

    /// `app` with session `id` settled `ago` before [`now`].
    fn settle(mut app: AppState, id: i64, ago: Duration) -> AppState {
        app.sessions
            .sessions
            .iter_mut()
            .filter(|session| session.id == SessionId(id))
            .for_each(|session| session.settled_at = Some(now() - ago));
        app
    }

    /// Git's facts: on `orb/work` with `changes`, committed two hours ago.
    fn facts(changes: usize) -> WorktreeFacts {
        WorktreeFacts {
            branch: Some("orb/work".to_owned()),
            changes,
            last_commit: Some((now() - Duration::from_hours(2), "Fix login".to_owned())),
        }
    }

    /// The worktree `name` with `facts` and a size of `size_kb`.
    fn worktree(name: &str, facts: Option<WorktreeFacts>, size_kb: Option<u64>) -> Worktree {
        Worktree {
            path: path(name),
            repo: Some("/Users/me/dev/orb".into()),
            facts,
            size_kb,
        }
    }

    /// `agents` in one project, `orb`, each in its own session, over
    /// `worktrees`.
    fn app(agents: Vec<Agent>, worktrees: Vec<Worktree>) -> AppState {
        let projects = vec![Project {
            id: ProjectId(1),
            title: "orb".to_owned(),
            root: "/Users/me/dev/orb".into(),
            created_at: UNIX_EPOCH,
            removed: false,
            repo: true,
            agents,
            kind: ProjectKind::Normal,
        }];
        AppState {
            home: "/Users/me".into(),
            sessions: Sessions {
                sessions: sessions_for(&projects),
                projects,
                ..Sessions::default()
            },
            worktrees: Worktrees { list: worktrees },
            ..AppState::default()
        }
    }

    /// In order: `orb-aaaa` active (1.5G), `orb-bbbb` settled 9 days ago,
    /// `orb-cccc` settled 10 days ago with 3 changes, `orb-dddd` used by
    /// nothing, its size not yet known.
    fn fixture() -> AppState {
        let app = app(
            vec![
                agent(1, "Fix the bug", "orb-aaaa"),
                idle_for(agent(2, "Write docs", "orb-bbbb"), 9),
                idle_for(agent(3, "Refactor", "orb-cccc"), 10),
            ],
            vec![
                worktree("orb-aaaa", Some(facts(0)), Some(1024 * 1024 * 3 / 2)),
                worktree("orb-bbbb", Some(facts(0)), Some(2048)),
                worktree("orb-cccc", Some(facts(3)), Some(512)),
                worktree("orb-dddd", Some(facts(0)), None),
            ],
        );
        let app = settle(app, 2, Duration::from_hours(24 * 9));
        settle(app, 3, Duration::from_hours(24 * 10))
    }

    /// The worktree picker over `app`'s worktrees, row `row` selected.
    fn picker(app: &AppState, row: usize) -> PickerState {
        let mut picker = PickerState::worktrees(worktree_items(app), Focus::Sidebar);
        picker.select_row(row);
        picker
    }

    /// Draws `picker` over a `width`×`height` screen with live data from
    /// `app`.
    fn draw(picker: &PickerState, app: &AppState, width: u16, height: u16) -> Buffer {
        let mut buf = Buffer::empty(Rect::new(0, 0, width, height));
        render(
            picker,
            app,
            now(),
            buf.area,
            &mut buf,
            &mut PickerScroll::default(),
            &mut HitMap::default(),
        );
        buf
    }

    /// Draws `picker` over a `width`×`height` screen with live data from
    /// `app`. Returns what it recorded and the input's cursor, two lines
    /// above the first row.
    fn hits_of(
        picker: &PickerState,
        app: &AppState,
        width: u16,
        height: u16,
    ) -> (HitMap, Position) {
        let mut buf = Buffer::empty(Rect::new(0, 0, width, height));
        let mut hits = HitMap::default();
        let (_, cursor) = render(
            picker,
            app,
            now(),
            buf.area,
            &mut buf,
            &mut PickerScroll::default(),
            &mut hits,
        );
        (hits, cursor)
    }

    /// The screen's lines, top to bottom.
    fn lines(buf: &Buffer) -> Vec<String> {
        (0..buf.area.height)
            .map(|y| {
                (0..buf.area.width)
                    .filter_map(|x| buf.cell((x, y)).map(Cell::symbol))
                    .collect()
            })
            .collect()
    }

    /// The cell where `text` first starts, row by row.
    fn find(buf: &Buffer, text: &str) -> Option<(u16, u16)> {
        let len = text.graphemes(true).count();
        (0..buf.area.height).find_map(|y| {
            let row: Vec<&str> = (0..buf.area.width)
                .filter_map(|x| buf.cell((x, y)).map(Cell::symbol))
                .collect();
            (0..row.len())
                .find(|&x| {
                    row.get(x..x + len)
                        .is_some_and(|cells| cells.concat() == text)
                })
                .map(|x| (x as u16, y))
        })
    }

    /// The line `text` first shows on.
    fn line_of(buf: &Buffer, text: &str) -> String {
        find(buf, text)
            .and_then(|(_, y)| lines(buf).into_iter().nth(usize::from(y)))
            .unwrap_or_default()
    }

    /// The foreground of the cell where `text` first starts.
    fn fg_of(buf: &Buffer, text: &str) -> Option<Color> {
        find(buf, text)
            .and_then(|at| buf.cell(at))
            .map(|cell| cell.fg)
    }

    /// The fixture's picker, stacked, so the list's rows come before the
    /// preview.
    fn stacked() -> Buffer {
        let app = fixture();
        draw(&picker(&app, 0), &app, 100, 40)
    }

    #[rstest::rstest]
    fn hints_name_the_worktree_keys() {
        // Given the fixture's worktrees.
        let app = fixture();

        // When drawing the picker.
        let buf = draw(&picker(&app, 0), &app, 140, 30);

        // Then the hints name delete and, as ⏎ does nothing, leave it out.
        let expected = " ↑↓/j/k rows · / search · d delete · Esc close ";
        assert!(find(&buf, expected).is_some(), "the hints {expected:?}");
    }

    #[rstest::rstest]
    fn active_row_shows_active_and_the_lead_title() {
        // Given the fixture, `orb-aaaa` used by an open agent.

        // When drawing the picker.
        let buf = stacked();

        // Then its right side reads a green `active · ` and the title.
        assert_eq!(
            fg_of(&buf, "active · Fix the bug"),
            Some(GREEN),
            "the active row's right side"
        );
    }

    #[rstest::rstest]
    fn settled_row_shows_settled_and_its_age() {
        // Given the fixture, `orb-bbbb`'s agent settled 9 days ago.

        // When drawing the picker.
        let buf = stacked();

        // Then its row reads `settled 9d`.
        let row = line_of(&buf, "orb-bbbb");
        assert!(row.contains("settled 9d"), "row was {row}");
    }

    #[rstest::rstest]
    fn orphan_row_shows_no_session() {
        // Given the fixture, `orb-dddd` used by nothing.

        // When drawing the picker.
        let buf = stacked();

        // Then its row reads `no session`.
        let row = line_of(&buf, "orb-dddd");
        assert!(row.contains("no session"), "row was {row}");
    }

    #[rstest::rstest]
    fn dirty_row_shows_an_orange_change_count() {
        // Given the fixture, `orb-cccc` with 3 uncommitted changes.

        // When drawing the picker.
        let buf = stacked();

        // Then its row shows an orange `●3`.
        assert_eq!(fg_of(&buf, "●3"), Some(ORANGE), "the change count");
    }

    #[rstest::rstest]
    fn row_prefix_is_dark5_on_an_active_row() {
        // Given the fixture, `orb-aaaa` active.

        // When drawing the picker.
        let buf = stacked();

        // Then its `orb/` prefix is DARK5.
        assert_eq!(fg_of(&buf, "orb/orb-aaaa"), Some(DARK5), "the prefix");
    }

    #[rstest::rstest]
    fn preview_is_titled_with_the_selected_label() {
        // Given the fixture with `orb-bbbb` selected.
        let app = fixture();

        // When drawing the picker wide.
        let buf = draw(&picker(&app, 1), &app, 140, 40);

        // Then the boxes' top border holds ` orb/orb-bbbb `.
        let row = find(&buf, " orb/orb-bbbb ").map(|(_, y)| y);
        let top = find(&buf, "╭").map(|(_, y)| y);
        assert_eq!(row, top, "the preview's title row");
    }

    #[rstest::rstest]
    fn preview_shows_each_field_label() {
        // Given the fixture with `orb-aaaa` selected.
        let app = fixture();

        // When drawing the picker.
        let buf = draw(&picker(&app, 0), &app, 140, 40);

        // Then every field's label shows.
        let screen = lines(&buf).join("\n");
        let missing: Vec<&str> = [
            "Path",
            "Branch",
            "Size",
            "Changes",
            "Last commit",
            "Last used",
            "Sweep",
        ]
        .into_iter()
        .filter(|label| !screen.contains(&format!("   {label}")))
        .collect();
        assert!(missing.is_empty(), "missing {missing:?} in\n{screen}");
    }

    /// `orb-aaaa` used by two open agents.
    fn shared() -> AppState {
        app(
            vec![
                agent(1, "Fix the bug", "orb-aaaa"),
                agent(2, "Plan it", "orb-aaaa"),
            ],
            vec![worktree("orb-aaaa", Some(facts(0)), Some(512))],
        )
    }

    #[rstest::rstest]
    fn preview_counts_its_users() {
        // Given a worktree used by two agents.
        let app = shared();

        // When drawing the picker.
        let buf = draw(&picker(&app, 0), &app, 140, 40);

        // Then the preview reads `Used by 2`.
        assert!(find(&buf, "Used by 2").is_some(), "no `Used by 2`");
    }

    #[rstest::rstest]
    fn preview_lists_one_line_per_user_under_used_by() {
        // Given a worktree used by two agents.
        let app = shared();

        // When drawing the picker.
        let buf = draw(&picker(&app, 0), &app, 140, 40);

        // Then each agent has its own line under `Used by`.
        let rows = ["Used by", "orb/Fix the bug", "orb/Plan it"]
            .map(|text| find(&buf, text).map(|(_, y)| y));
        let listed =
            matches!(rows, [Some(by), Some(one), Some(two)] if by < one && one != two && by < two);
        assert!(listed, "rows were {rows:?}");
    }

    #[rstest::rstest]
    fn preview_with_no_users_says_nothing_uses_it() {
        // Given the fixture with `orb-dddd`, used by nothing, selected.
        let app = fixture();

        // When drawing the picker.
        let buf = draw(&picker(&app, 3), &app, 140, 40);

        // Then the preview says `Nothing uses it`.
        assert!(
            find(&buf, "Nothing uses it").is_some(),
            "no `Nothing uses it`"
        );
    }

    #[rstest::rstest]
    fn unknown_size_shows_an_ellipsis() {
        // Given the fixture with `orb-dddd`, its size not yet known, selected.
        let app = fixture();

        // When drawing the picker.
        let buf = draw(&picker(&app, 3), &app, 140, 40);

        // Then its `Size` field reads `…`.
        let size = find(&buf, "Size")
            .and_then(|(x, y)| buf.cell((x + 12, y)))
            .map(|cell| cell.symbol().to_owned());
        assert_eq!(size.as_deref(), Some("…"), "the size field");
    }

    /// One agent, `Solo`, in `orb-eeee`.
    fn solo() -> Agent {
        agent(1, "Solo", "orb-eeee")
    }

    /// `orb-eeee` with `facts`, used by `agent` if any.
    fn lone(agent: Option<Agent>, facts: Option<WorktreeFacts>) -> AppState {
        app(
            agent.into_iter().collect(),
            vec![worktree("orb-eeee", facts, Some(512))],
        )
    }

    /// `app` with agent 1 attached.
    fn attached(app: AppState) -> AppState {
        AppState {
            attached: HashSet::from([SessionId(1)]),
            ..app
        }
    }

    /// `orb-eeee` with `facts`, used by `solo`'s session settled `ago`
    /// before [`now`].
    fn settled_for(ago: Duration, facts: Option<WorktreeFacts>) -> AppState {
        settle(lone(Some(solo()), facts), 1, ago)
    }

    #[rstest::rstest]
    #[case::attached(
        attached(lone(Some(solo()), Some(facts(0)))),
        "kept: a session in it is attached",
        DARK5
    )]
    #[case::mid_turn(
        lone(Some(Agent { status: AgentStatus::Working, ..solo() }), Some(facts(0))),
        "kept: an agent in it is mid-turn",
        DARK5
    )]
    #[case::active(
        lone(Some(solo()), Some(facts(0))),
        "kept: a session in it is active",
        DARK5
    )]
    #[case::unknown(settled_for(Duration::from_hours(1), None), "…", DARK5)]
    #[case::dirty(
        settled_for(Duration::from_hours(1), Some(facts(2))),
        "kept: uncommitted changes",
        ORANGE
    )]
    #[case::prune_now(lone(None, Some(facts(0))), "prunes at next sweep", RED)]
    #[case::prune_in_days(
        settled_for(Duration::from_hours(24), Some(facts(0))),
        "prunes in 2d",
        YELLOW
    )]
    #[case::prune_in_hours(
        settled_for(Duration::from_mins(3 * 24 * 60 - 150), Some(facts(0))),
        "prunes in 3h",
        YELLOW
    )]
    fn sweep_line_reads_the_verdict(#[case] app: AppState, #[case] text: &str, #[case] fg: Color) {
        // Given `orb-eeee` in some state, selected.

        // When drawing the picker.
        let buf = draw(&picker(&app, 0), &app, 140, 40);

        // Then its `Sweep` field reads `text` in `fg`.
        let value = find(&buf, "Sweep").and_then(|(x, y)| {
            let line = lines(&buf).into_iter().nth(usize::from(y))?;
            buf.cell((x + 12, y)).map(|cell| (line, cell.fg))
        });
        assert!(
            value
                .as_ref()
                .is_some_and(|(line, at)| line.contains(text) && *at == fg),
            "wanted {text:?} in {fg:?}, sweep line was {value:?}"
        );
    }

    #[rstest::rstest]
    fn wide_area_puts_the_boxes_side_by_side() {
        // Given the fixture on a 120-column screen.
        let app = fixture();

        // When drawing the picker.
        let buf = draw(&picker(&app, 0), &app, 120, 40);

        // Then the top border row holds two box corners.
        let top = line_of(&buf, "╭");
        assert_eq!(top.matches('╭').count(), 2, "top row was {top}");
    }

    #[rstest::rstest]
    fn narrow_area_stacks_the_list_over_the_preview() {
        // Given the fixture on a 100-column screen.
        let app = fixture();

        // When drawing the picker.
        let buf = draw(&picker(&app, 0), &app, 100, 40);

        // Then two box corners sit in the same column on different rows.
        let corners: Vec<(usize, usize)> = lines(&buf)
            .iter()
            .enumerate()
            .filter_map(|(y, line)| {
                line.graphemes(true)
                    .position(|grapheme| grapheme == "╭")
                    .map(|x| (x, y))
            })
            .collect();
        let stacked = matches!(corners.as_slice(), [(x1, _), (x2, _)] if x1 == x2);
        assert!(stacked, "corners were {corners:?}");
    }

    #[rstest::rstest]
    #[case::wide(160, 40)]
    #[case::stacked(100, 40)]
    fn hit_map_maps_a_list_row_to_its_index(#[case] width: u16, #[case] height: u16) {
        // Given the worktree picker over the fixture.
        let app = fixture();

        // When drawing it on a `width`×`height` screen.
        let (hits, cursor) = hits_of(&picker(&app, 0), &app, width, height);

        // Then the list's second row maps to shown row 1.
        assert_eq!(
            hits.picker_row_at(Position::new(cursor.x, cursor.y + 3)),
            Some(1),
            "the second list row should be shown row 1 at {width}×{height}"
        );
    }

    #[rstest::rstest]
    fn hit_map_maps_the_preview_to_nothing() {
        // Given the worktree picker over the fixture.
        let app = fixture();

        // When drawing it wide, the preview beside the list.
        let (hits, _) = hits_of(&picker(&app, 0), &app, 160, 40);

        // Then a point in the preview is on the popup but on no row.
        let at = Position::new(140, 20);
        assert_eq!(
            (hits.on_overlay(at), hits.picker_row_at(at)),
            (true, None),
            "the preview should be inside the popup and on no row"
        );
    }

    #[rstest::rstest]
    #[case::wide(160, 40, Position::new(140, 20))]
    #[case::stacked(100, 40, Position::new(50, 33))]
    fn hit_map_leaves_the_preview_out_of_the_wheels_area(
        #[case] width: u16,
        #[case] height: u16,
        #[case] preview: Position,
    ) {
        // Given the worktree picker over the fixture.
        let app = fixture();

        // When drawing it on a `width`×`height` screen.
        let (hits, cursor) = hits_of(&picker(&app, 0), &app, width, height);

        // Then the wheel's area holds the list's input but not the preview.
        assert_eq!(
            (hits.on_selector(cursor), hits.on_selector(preview)),
            (true, false),
            "the wheel should cover the list and not the preview at {width}×{height}"
        );
    }

    #[rstest::rstest]
    fn hit_map_leaves_outside_the_popup_off_the_overlay() {
        // Given the worktree picker over the fixture.
        let app = fixture();

        // When drawing it on a 160×40 screen.
        let (hits, _) = hits_of(&picker(&app, 0), &app, 160, 40);

        // Then the top-left corner, outside the popup, is off the overlay, so
        // a click there cancels.
        assert!(
            !hits.on_overlay(Position::new(0, 0)),
            "the corner should be outside the popup"
        );
    }
}
