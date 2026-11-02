use orb_domain::feat::harness::HarnessId;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use crate::test_support::sessions_for;
use jiff::tz::TimeZone;
use orb_domain::Intent;
use orb_domain::feat::layout::floats::Floats;
use orb_domain::feat::layout::state::{PaneEntry, SessionLayout, Tab};
use orb_domain::feat::layout::tree::{Node, Split, SwapLayout, TileLayout};
use orb_domain::feat::picker::list::PickerItem;
use orb_domain::feat::picker::state::PickerState;
use orb_domain::feat::search::state::SearchProgress;
use orb_domain::feat::sessions::state::{
    Agent, AgentStatus, PaneLaunch, Project, ProjectKind, Search, Sessions, SidebarItem,
};
use orb_domain::feat::sidebar::state::{Rename, RenameTarget, SidebarView};
use orb_domain::feat::zmx::zmx_service::ZmxSession;
use orb_domain::ids::{AgentId, PaneId, ProjectId, SessionId};
use orb_domain::{AppState, Focus, PaneMode, TextInput};
use orb_term::{CellSize, GraphicsSupport, Pane, PaneCommand, PaneSize};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::{Buffer, Cell};
use ratatui::layout::{Position, Rect};
use ratatui::style::{Color, Modifier};

use super::{BACKGROUND, layout, render};
use crate::sidebar::{BLACK, BLUE, COMMENT, GUTTER};
use ratatui::crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

use crate::keymap::{Keys, LEADER, Scope, keymap, press};
use crate::mouse::{self, Clicks, HitMap, MouseRoute};
use crate::picker::PickerScroll;
use crate::sidebar::SidebarScroll;
use crate::toast::{Toast, ToastKind};

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

fn sessions(agents: Vec<Agent>) -> Sessions {
    fill(Sessions {
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
        ..Sessions::default()
    })
}

/// Draws `state` on an 80x8 screen.
fn draw(state: &AppState) -> Buffer {
    draw_with(state, &Keys::new(keymap(), Scope::SIDEBAR))
}

/// Draws `state` on an 80x8 screen with `keys` pending.
fn draw_with(state: &AppState, keys: &Keys) -> Buffer {
    frame(state, None, keys, 8, BACKGROUND)
        .backend()
        .buffer()
        .clone()
}

/// Draws `state` on an 80x40 screen, tall enough for the whole start screen.
fn draw_tall(state: &AppState, pane_error: Option<&str>) -> Buffer {
    let keys = Keys::new(keymap(), Scope::SIDEBAR);
    frame(state, pane_error, &keys, 40, BACKGROUND)
        .backend()
        .buffer()
        .clone()
}

/// The terminal after drawing `state` on an 80-column screen `height`
/// rows tall, with `pane_error` and `keys` pending, on `background`.
fn frame(
    state: &AppState,
    pane_error: Option<&str>,
    keys: &Keys,
    height: u16,
    background: Color,
) -> Terminal<TestBackend> {
    let Ok(mut terminal) = Terminal::new(TestBackend::new(80, height));
    let Ok(_) = terminal.draw(|frame| {
        render(
            frame,
            state,
            &HashMap::new(),
            pane_error,
            None,
            keys,
            SystemTime::UNIX_EPOCH,
            &TimeZone::UTC,
            background,
            &mut SidebarScroll::default(),
            &mut PickerScroll::default(),
            &mut HitMap::default(),
            &mut Vec::new(),
        );
    });
    terminal
}

/// A live pane that printed `PANE-TEXT`, once the text is on its screen.
fn pane_with_text() -> Option<Pane> {
    let command = PaneCommand {
        argv: vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf PANE-TEXT; sleep 5".into(),
        ],
        cwd: "/".into(),
        env: vec![("PATH".into(), "/bin:/usr/bin".into())],
        graphics: GraphicsSupport::None,
        colors: None,
    };
    let size = PaneSize {
        cols: 48,
        rows: 7,
        cell: CellSize::default(),
    };
    let pane = Pane::spawn(&command, size, |_| {}).ok()?;
    let area = Rect::new(0, 0, 48, 7);
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let mut buffer = Buffer::empty(area);
        pane.render(area, &mut buffer);
        if text(&buffer, area).contains("PANE-TEXT") {
            return Some(pane);
        }
        thread::sleep(Duration::from_millis(10));
    }
    None
}

/// Agent 1's pane: a live pane in kitty with 10x20 pixel cells that showed
/// an image covering its whole 48x7 screen, then printed `PANE-TEXT`.
fn image_pane() -> Option<HashMap<PaneId, Pane>> {
    let command = PaneCommand {
        argv: vec![
            "/bin/sh".into(),
            "-c".into(),
            r"printf '\033_Ga=T,f=32,s=480,v=140,t=s,i=1,C=1,q=2;AAAA\033\\'; printf PANE-TEXT; sleep 5"
                .into(),
        ],
        cwd: "/".into(),
        env: vec![("PATH".into(), "/bin:/usr/bin".into())],
        graphics: GraphicsSupport::Kitty { transient: true },
        colors: None,
    };
    let size = PaneSize {
        cols: 48,
        rows: 7,
        cell: CellSize {
            width: 10,
            height: 20,
        },
    };
    let pane = Pane::spawn(&command, size, |_| {}).ok()?;
    let area = Rect::new(0, 0, 48, 7);
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let mut buffer = Buffer::empty(area);
        pane.render(area, &mut buffer);
        if text(&buffer, area).contains("PANE-TEXT") {
            return Some(HashMap::from([(PaneId(1), pane)]));
        }
        thread::sleep(Duration::from_millis(10));
    }
    None
}

/// Agent 1's pane: a live pane that printed `PANE-TEXT`.
fn agent_pane() -> Option<HashMap<PaneId, Pane>> {
    pane_with_text().map(|pane| HashMap::from([(PaneId(1), pane)]))
}

/// Draws `state` on an 80x8 screen with `panes` running; returns the
/// right side's text.
fn right_side_with_pane(state: &AppState, panes: &HashMap<PaneId, Pane>) -> String {
    let buffer = draw_with_pane(state, panes);
    let [_, right, _] = layout(buffer.area, &SidebarView::default());
    text(&buffer, right)
}

/// Draws `state` on an 80x8 screen with `panes` running.
fn draw_with_pane(state: &AppState, panes: &HashMap<PaneId, Pane>) -> Buffer {
    draw_with_pane_and_toast(state, panes, None)
}

/// Draws `state` on an 80x8 screen with `panes` running and `toast` in the
/// message box.
fn draw_with_pane_and_toast(
    state: &AppState,
    panes: &HashMap<PaneId, Pane>,
    toast: Option<&Toast>,
) -> Buffer {
    let Ok(mut terminal) = Terminal::new(TestBackend::new(80, 8));
    let keys = Keys::new(keymap(), Scope::SIDEBAR);
    let Ok(_) = terminal.draw(|frame| {
        render(
            frame,
            state,
            panes,
            None,
            toast,
            &keys,
            SystemTime::UNIX_EPOCH,
            &TimeZone::UTC,
            BACKGROUND,
            &mut SidebarScroll::default(),
            &mut PickerScroll::default(),
            &mut HitMap::default(),
            &mut Vec::new(),
        );
    });
    terminal.backend().buffer().clone()
}

/// Agent 1, selected, with the given focus.
fn selected(focus: Focus) -> AppState {
    AppState {
        focus,
        sessions: Sessions {
            cursor: Some(SidebarItem::Session(SessionId(1))),
            ..sessions(vec![agent(1, AgentStatus::Idle)])
        },
        ..AppState::default()
    }
}

/// Pane `id`, a shell in `orb-p<id>`.
fn entry(id: i64) -> PaneEntry {
    PaneEntry {
        id: PaneId(id),
        zmx: ZmxSession {
            name: format!("orb-p{id}"),
            dir: "/tmp/zmx".into(),
        },
        cwd: "/tmp".into(),
        name: None,
        resume: None,
    }
}

/// Agent 1, selected, attached and active, running in pane 1, the one
/// tab of session 1, with the given focus.
fn shown(focus: Focus) -> AppState {
    let mut state = selected(focus);
    state.attached.insert(SessionId(1));
    state.sessions.enter(SessionId(1));
    if let Some(agent) = state
        .sessions
        .projects
        .first_mut()
        .and_then(|project| project.agents.first_mut())
    {
        agent.pane = Some(PaneLaunch {
            pane: PaneId(1),
            session: SessionId(1),
        });
    }
    state.sessions.sessions = sessions_for(&state.sessions.projects);
    state
        .layouts
        .insert(SessionId(1), SessionLayout::of(entry(1)));
    state
}

/// orb with no row selected, with the given focus.
fn unselected(focus: Focus) -> AppState {
    AppState {
        focus,
        sessions: sessions(vec![]),
        ..AppState::default()
    }
}

fn right_side(buffer: &Buffer) -> String {
    text(buffer, right_of(buffer))
}

/// The right side's area with the default sidebar.
fn right_of(buffer: &Buffer) -> Rect {
    let [_, right, _] = layout(buffer.area, &SidebarView::default());
    right
}

/// The text inside `area`, row by row.
fn text(buffer: &Buffer, area: Rect) -> String {
    area.rows()
        .map(|row| {
            row.columns()
                .filter_map(|cell| buffer.cell(cell).map(Cell::symbol))
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn mode_line(buffer: &Buffer) -> String {
    let [_, _, mode_line] = layout(buffer.area, &SidebarView::default());
    text(buffer, mode_line)
}

#[rstest::rstest]
fn session_picker_is_drawn_by_its_own_renderer() {
    // Given an open session picker with no agents.
    let state = AppState {
        focus: Focus::Picker,
        picker: Some(PickerState::sessions(vec![], Focus::Sidebar)),
        ..AppState::default()
    };

    // When drawing a frame.
    let buffer = draw_tall(&state, None);

    // Then the input row shows the session picker's `0/0` count.
    let screen = text(&buffer, buffer.area);
    assert!(screen.contains("0/0"), "screen was\n{screen}");
}

#[rstest::rstest]
fn worktree_picker_is_drawn_by_its_own_renderer() {
    // Given an open worktree picker with no worktrees.
    let state = AppState {
        focus: Focus::Picker,
        picker: Some(PickerState::worktrees(vec![], Focus::Sidebar)),
        ..AppState::default()
    };

    // When drawing a frame.
    let buffer = draw_tall(&state, None);

    // Then the list box is titled ` Worktrees ` over a `0/0` count.
    let screen = text(&buffer, buffer.area);
    assert!(
        screen.contains(" Worktrees ") && screen.contains("0/0"),
        "screen was\n{screen}"
    );
}

#[rstest::rstest]
fn search_picker_is_drawn_by_its_own_renderer() {
    // Given an open search picker while one of two transcripts is indexed.
    let state = AppState {
        focus: Focus::Picker,
        picker: Some(PickerState::search(Focus::Sidebar)),
        search: SearchProgress {
            indexed: 1,
            total: 2,
            error: None,
        },
        ..AppState::default()
    };

    // When drawing a frame.
    let buffer = draw(&state);

    // Then the list title shows the indexing progress.
    let screen = text(&buffer, buffer.area);
    assert!(screen.contains("indexing 1/2"), "screen was\n{screen}");
}

/// An open `Delete worktree?` confirm over a worktree picker listing
/// `orb/orb-1234`.
fn delete_worktree_confirm() -> AppState {
    let path = PathBuf::from("/Users/me/.orb/worktrees/orb/orb-1234");
    let list = PickerState::worktrees(
        vec![PickerItem::Worktree {
            path: path.clone(),
            label: "orb/orb-1234".to_owned(),
            split: 4,
            extra: String::new(),
        }],
        Focus::Sidebar,
    );
    AppState {
        focus: Focus::Picker,
        picker: Some(PickerState::delete_worktree(list, path, false)),
        ..AppState::default()
    }
}

/// Where `needle` first shows on `buffer`.
fn find(buffer: &Buffer, needle: &str) -> Option<Position> {
    buffer.area.positions().find(|at| {
        let rest = Rect::new(at.x, at.y, buffer.area.right() - at.x, 1);
        text(buffer, rest).starts_with(needle)
    })
}

#[rstest::rstest]
fn delete_worktree_confirm_draws_over_the_worktree_list() {
    // Given a delete confirm opened over the worktree picker.
    let state = delete_worktree_confirm();

    // When drawing a frame.
    let buffer = frame(
        &state,
        None,
        &Keys::new(keymap(), Scope::SIDEBAR),
        20,
        BACKGROUND,
    )
    .backend()
    .buffer()
    .clone();

    // Then the list's row and the confirm's title are both on screen.
    let screen = text(&buffer, buffer.area);
    assert!(
        screen.contains("orb/orb-1234") && screen.contains("Delete worktree?"),
        "screen was\n{screen}"
    );
}

#[rstest::rstest]
fn click_on_a_list_row_behind_the_delete_confirm_cancels_the_confirm() {
    // Given a delete confirm drawn over the worktree picker.
    let state = delete_worktree_confirm();
    let mut hits = HitMap::default();
    let buffer = {
        let Ok(mut terminal) = Terminal::new(TestBackend::new(80, 20));
        let keys = Keys::new(keymap(), Scope::SIDEBAR);
        let Ok(_) = terminal.draw(|frame| {
            render(
                frame,
                &state,
                &HashMap::new(),
                None,
                None,
                &keys,
                SystemTime::UNIX_EPOCH,
                &TimeZone::UTC,
                BACKGROUND,
                &mut SidebarScroll::default(),
                &mut PickerScroll::default(),
                &mut hits,
                &mut Vec::new(),
            );
        });
        terminal.backend().buffer().clone()
    };
    let row = find(&buffer, "orb/orb-1234");

    // When clicking the list's row.
    let route = row.map(|at| {
        let event = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: at.x,
            row: at.y,
            modifiers: KeyModifiers::NONE,
        };
        mouse::route(
            event,
            &hits,
            Focus::Picker,
            None,
            &mut Clicks::default(),
            Instant::now(),
        )
    });

    // Then the click cancels the confirm instead of selecting the row.
    assert_eq!(
        route,
        Some(MouseRoute::Intents(vec![Intent::PickerCancel])),
        "a click behind the confirm should close it"
    );
}

#[rstest::rstest]
fn selected_agent_shows_the_start_screen() {
    // Given a selected agent that isn't attached.
    let state = selected(Focus::Sidebar);

    // When drawing a frame.
    let buffer = draw_tall(&state, None);

    // Then the right side is the start screen's banner.
    let right = text(&buffer, right_of(&buffer));
    assert!(
        right.contains("██╔═══██╗██╔══██╗██╔══██╗"),
        "right side was\n{right}"
    );
}

#[rstest::rstest]
fn pane_error_shows_on_the_start_screen() {
    // Given a selected agent whose session couldn't start.
    let state = selected(Focus::Sidebar);

    // When drawing a frame with the pane's error.
    let buffer = draw_tall(&state, Some("zmx attach failed"));

    // Then the error is on the right side.
    let right = text(&buffer, right_of(&buffer));
    assert!(
        right.contains("zmx attach failed"),
        "right side was\n{right}"
    );
}

#[rstest::rstest]
#[case::empty_right_side(AppState::default(), (79, 0))]
#[case::inside_the_picker(
        AppState {
            focus: Focus::Picker,
            picker: Some(PickerState::projects(vec![], Focus::Sidebar)),
            ..AppState::default()
        },
        (70, 1)
    )]
fn cells_without_a_background_get_orbs(#[case] state: AppState, #[case] at: (u16, u16)) {
    // Given a frame's state.

    // When drawing a frame.
    let buffer = draw(&state);

    // Then a cell nothing coloured has orb's background.
    assert_eq!(
        buffer.cell(at).map(|cell| cell.bg),
        Some(BACKGROUND),
        "background at {at:?}"
    );
}

#[rstest::rstest]
fn cells_without_a_background_get_the_chosen_background() {
    // Given a background chosen in place of orb's navy.
    let background = Color::Rgb(0x22, 0x24, 0x37);

    // When drawing an empty frame on it.
    let buffer = frame(
        &AppState::default(),
        None,
        &Keys::new(keymap(), Scope::SIDEBAR),
        8,
        background,
    )
    .backend()
    .buffer()
    .clone();

    // Then a cell nothing coloured has the chosen background.
    assert_eq!(
        buffer.cell((79, 0)).map(|cell| cell.bg),
        Some(background),
        "an empty cell should get the chosen background"
    );
}

#[rstest::rstest]
fn attached_pane_default_background_gets_orbs() {
    // Given a live pane that printed text with no background colour.
    let panes = agent_pane();
    let state = shown(Focus::Pane);

    // When drawing a frame while attached.
    let buffer = panes.as_ref().map(|panes| draw_with_pane(&state, panes));

    // Then the pane's first cell, under the tab bar, has orb's background.
    let [_, right, _] = layout(Rect::new(0, 0, 80, 8), &SidebarView::default());
    let bg = buffer.and_then(|buffer| buffer.cell((right.x, right.y + 1)).map(|cell| cell.bg));
    assert_eq!(bg, Some(BACKGROUND), "the pane's background");
}

#[rstest::rstest]
fn image_hole_cells_get_the_default_background() {
    // Given a live pane showing an image over its whole screen.
    let panes = image_pane();
    let state = shown(Focus::Pane);

    // When drawing a frame while attached.
    let buffer = panes.as_ref().map(|panes| draw_with_pane(&state, panes));

    // Then a cell inside the pane's content keeps the terminal's default
    // background, so the image shows through it.
    let [_, right, _] = layout(Rect::new(0, 0, 80, 8), &SidebarView::default());
    let bg = buffer.and_then(|buffer| buffer.cell((right.x + 2, right.y + 3)).map(|cell| cell.bg));
    assert_eq!(bg, Some(Color::Reset), "the background over the image");
}

#[rstest::rstest]
fn overlay_over_an_image_keeps_its_background() {
    // Given a live pane showing an image over its whole screen, and a
    // message over the pane.
    let panes = image_pane();
    let state = shown(Focus::Pane);
    let toast = Toast::new(
        ToastKind::Info,
        "COVER",
        Instant::now() + Duration::from_secs(5),
    );

    // When drawing a frame while attached.
    let buffer = panes
        .as_ref()
        .map(|panes| draw_with_pane_and_toast(&state, panes, Some(&toast)));

    // Then the message's cells over the image keep a background of their
    // own, so the message covers the image.
    let bg = buffer.and_then(|buffer| {
        let at = find(&buffer, "COVER")?;
        buffer.cell(at).map(|cell| cell.bg)
    });
    assert!(
        bg.is_some_and(|bg| bg != Color::Reset),
        "the message's background over the image was {bg:?}"
    );
}

/// Agent 1 selected, with the rename box open on it holding "Fix" and
/// the keys in `focus`.
fn renaming(focus: Focus) -> AppState {
    AppState {
        rename: Some(Rename {
            target: RenameTarget::Session(SessionId(1)),
            input: TextInput::new("Fix"),
            creating: false,
        }),
        ..selected(focus)
    }
}

#[rstest::rstest]
fn rename_box_puts_the_cursor_after_the_name() {
    // Given the rename box holding "Fix" with the keys.
    let state = renaming(Focus::Rename);

    // When drawing a frame.
    let cursor = cursor_of(&state, &HashMap::new());

    // Then the cursor is after the name in the box, centred on the
    // 80-column screen two rows from the top.
    assert_eq!(
        cursor,
        Some(Position::new(18, 3)),
        "the cursor in the rename box"
    );
}

#[rstest::rstest]
fn rename_box_is_not_drawn_without_the_keys() {
    // Given a rename box left open while the sidebar has the keys.
    let state = renaming(Focus::Sidebar);

    // When drawing a frame.
    let buffer = draw(&state);

    // Then no rename box is drawn.
    let screen: String = buffer.content.iter().map(Cell::symbol).collect();
    assert!(
        !screen.contains("Rename Session"),
        "the rename box shows only while it has the keys"
    );
}

#[rstest::rstest]
fn leader_popup_on_a_two_row_screen_still_draws_the_mode_line() {
    // Given `<C-g>` pressed on a two-row screen, too short for the popup.
    let Ok(mut terminal) = Terminal::new(TestBackend::new(80, 2));
    let mut keys = Keys::new(keymap(), Scope::SIDEBAR);
    press(&mut keys, LEADER);

    // When drawing a frame.
    let state = AppState::default();
    let Ok(_) = terminal.draw(|frame| {
        render(
            frame,
            &state,
            &HashMap::new(),
            None,
            None,
            &keys,
            SystemTime::UNIX_EPOCH,
            &TimeZone::UTC,
            BACKGROUND,
            &mut SidebarScroll::default(),
            &mut PickerScroll::default(),
            &mut HitMap::default(),
            &mut Vec::new(),
        );
    });

    // Then the frame is drawn without the popup.
    let mode_line = mode_line(terminal.backend().buffer());
    assert!(
        mode_line.starts_with(" NORMAL"),
        "mode line was '{mode_line}'"
    );
}

#[rstest::rstest]
fn leader_popup_sits_above_the_mode_line() {
    // Given `<C-g>` pressed on a 20-row screen.
    let Ok(mut terminal) = Terminal::new(TestBackend::new(80, 20));
    let mut keys = Keys::new(keymap(), Scope::SIDEBAR);
    press(&mut keys, LEADER);

    // When drawing a frame.
    let state = AppState::default();
    let Ok(_) = terminal.draw(|frame| {
        render(
            frame,
            &state,
            &HashMap::new(),
            None,
            None,
            &keys,
            SystemTime::UNIX_EPOCH,
            &TimeZone::UTC,
            BACKGROUND,
            &mut SidebarScroll::default(),
            &mut PickerScroll::default(),
            &mut HitMap::default(),
            &mut Vec::new(),
        );
    });

    // Then the popup's bottom-right corner is on the row above the mode
    // line.
    let corner = terminal.backend().buffer().cell((78, 18)).map(Cell::symbol);
    assert_eq!(corner, Some("╯"), "the popup's bottom-right corner");
}

#[rstest::rstest]
fn attached_focus_draws_the_live_pane() {
    // Given a live pane for the selected agent, attached.
    let panes = agent_pane();
    let state = shown(Focus::Pane);

    // When drawing a frame.
    let right = panes
        .as_ref()
        .map(|panes| right_side_with_pane(&state, panes));

    // Then the pane's output is on the right side.
    assert!(
        right
            .as_deref()
            .is_some_and(|right| right.contains("PANE-TEXT")),
        "right side was {right:?}"
    );
}

/// Agent 1, selected in the sidebar, attached and active.
fn left_pane() -> AppState {
    let mut state = AppState {
        attached: HashSet::from([SessionId(1)]),
        ..selected(Focus::Sidebar)
    };
    state.sessions.enter(SessionId(1));
    state
}

#[rstest::rstest]
fn sidebar_focus_draws_the_shown_layouts_pane() {
    // Given agent 1's live pane shown while the sidebar has the keys.
    let panes = agent_pane();
    let state = shown(Focus::Sidebar);

    // When drawing a frame.
    let right = panes
        .as_ref()
        .map(|panes| right_side_with_pane(&state, panes));

    // Then the pane's output is on the right side.
    assert!(
        right
            .as_deref()
            .is_some_and(|right| right.contains("PANE-TEXT")),
        "right side was {right:?}"
    );
}

#[rstest::rstest]
fn attached_agent_without_a_layout_shows_the_start_screen() {
    // Given agent 1 attached and selected in the sidebar, with no layout.
    let state = left_pane();

    // When drawing a frame.
    let buffer = draw_tall(&state, None);

    // Then the right side is the start screen's banner.
    let right = right_side(&buffer);
    assert!(
        right.contains("██╔═══██╗██╔══██╗██╔══██╗"),
        "right side was\n{right}"
    );
}

#[rstest::rstest]
fn sidebar_focus_puts_the_cursor_on_the_sidebar_not_the_left_pane() {
    // Given agent 1's live pane shown, with the sidebar focused.
    let panes = agent_pane();
    let state = shown(Focus::Sidebar);

    // When drawing a frame.
    let cursor = panes.as_ref().map(|panes| cursor_of(&state, panes));

    // Then the cursor is on the selected row's first cell, not in the pane.
    assert_eq!(
        cursor,
        Some(Some(Position::new(0, 3))),
        "the cursor with the pane left shown"
    );
}

/// Where the cursor shows once `state` is drawn on an 80x8 screen with
/// `panes` running; `None` while it's hidden.
fn cursor_of(state: &AppState, panes: &HashMap<PaneId, Pane>) -> Option<Position> {
    let Ok(mut terminal) = Terminal::new(TestBackend::new(80, 8));
    let keys = Keys::new(keymap(), Scope::SIDEBAR);
    let Ok(_) = terminal.draw(|frame| {
        render(
            frame,
            state,
            panes,
            None,
            None,
            &keys,
            SystemTime::UNIX_EPOCH,
            &TimeZone::UTC,
            BACKGROUND,
            &mut SidebarScroll::default(),
            &mut PickerScroll::default(),
            &mut HitMap::default(),
            &mut Vec::new(),
        );
    });
    terminal
        .backend()
        .cursor_visible()
        .then(|| terminal.get_cursor_position().ok())
        .flatten()
}

#[rstest::rstest]
fn list_mode_picker_shows_no_cursor() {
    // Given an open worktree picker in list mode with the keys.
    let state = AppState {
        focus: Focus::Picker,
        picker: Some(PickerState::worktrees(vec![], Focus::Sidebar)),
        ..AppState::default()
    };

    // When drawing a frame.
    let cursor = cursor_of(&state, &HashMap::new());

    // Then the cursor is hidden.
    assert_eq!(cursor, None, "no cursor in a list-mode picker");
}

#[rstest::rstest]
fn search_mode_picker_shows_the_cursor() {
    // Given an open worktree picker in search mode with the keys.
    let picker = {
        let mut picker = PickerState::worktrees(vec![], Focus::Sidebar);
        picker.start_search();
        picker
    };
    let state = AppState {
        focus: Focus::Picker,
        picker: Some(picker),
        ..AppState::default()
    };

    // When drawing a frame.
    let cursor = cursor_of(&state, &HashMap::new());

    // Then the cursor shows.
    assert!(cursor.is_some(), "a searching picker shows its cursor");
}

#[rstest::rstest]
fn search_focus_puts_the_cursor_after_the_search_text() {
    // Given a search holding "ab" with the keys.
    let mut state = selected(Focus::Search);
    state.sessions.search = Some(Search {
        input: TextInput::new("ab"),
        return_to: None,
    });

    // When drawing a frame.
    let cursor = cursor_of(&state, &HashMap::new());

    // Then the cursor is after "> ab" in the input box.
    assert_eq!(cursor, Some(Position::new(5, 1)), "the search cursor");
}

#[rstest::rstest]
fn sidebar_focus_puts_the_cursor_on_the_selected_rows_first_cell() {
    // Given agent 1 selected with the sidebar focused.
    let state = selected(Focus::Sidebar);

    // When drawing a frame.
    let cursor = cursor_of(&state, &HashMap::new());

    // Then the cursor is on the first cell of the selected row's first line.
    assert_eq!(cursor, Some(Position::new(0, 3)), "the sidebar cursor");
}

#[rstest::rstest]
fn sidebar_cursor_follows_the_selection_to_a_later_row() {
    // Given agent 1 and a settled agent, with the sidebar focused on
    // the Settled header below agent 1's two-line card.
    let mut state = AppState {
        focus: Focus::Sidebar,
        sessions: Sessions {
            cursor: Some(SidebarItem::SettledShelf),
            ..sessions(vec![
                agent(1, AgentStatus::Idle),
                agent(2, AgentStatus::Stopped),
            ])
        },
        ..AppState::default()
    };
    if let Some(session) = state.sessions.sessions.get_mut(1) {
        session.settled_at = Some(SystemTime::UNIX_EPOCH);
    }

    // When drawing a frame.
    let cursor = cursor_of(&state, &HashMap::new());

    // Then the cursor is on the first cell of the header's row.
    assert_eq!(cursor, Some(Position::new(0, 6)), "the sidebar cursor");
}

#[rstest::rstest]
fn attached_focus_puts_the_cursor_in_the_focused_pane() {
    // Given a live pane for the selected agent, attached.
    let panes = agent_pane();
    let state = shown(Focus::Pane);

    // When drawing a frame.
    let cursor = panes.as_ref().and_then(|panes| cursor_of(&state, panes));

    // Then the cursor is in the pane, under the tab bar.
    let [_, right, _] = layout(Rect::new(0, 0, 80, 8), &state.sidebar);
    let body = Rect::new(right.x, right.y + 1, right.width, right.height - 1);
    assert!(
        cursor.is_some_and(|cursor| body.contains(cursor)),
        "the attached cursor was {cursor:?}, outside {body:?}"
    );
}

#[rstest::rstest]
fn no_selection_shows_the_start_screen() {
    // Given no row selected.
    let state = unselected(Focus::Sidebar);

    // When drawing a frame.
    let right = right_side(&draw_tall(&state, None));

    // Then the right side is the start screen's banner.
    assert!(
        right.contains("██╔═══██╗██╔══██╗██╔══██╗"),
        "right side was\n{right}"
    );
}

#[rstest::rstest]
fn hidden_sidebar_gives_the_right_side_the_whole_body() {
    // Given a hidden sidebar on an 80x8 screen.
    let sidebar = SidebarView {
        hidden: true,
        ..SidebarView::default()
    };

    // When laying the screen out.
    let [_, right, _] = layout(Rect::new(0, 0, 80, 8), &sidebar);

    // Then the right side is everything above the mode line.
    assert_eq!(right, Rect::new(0, 0, 80, 7), "the right side's area");
}

#[rstest::rstest]
fn sidebar_takes_its_width() {
    // Given a 40-column sidebar.
    let sidebar = SidebarView {
        width: 40,
        ..SidebarView::default()
    };

    // When laying an 80x8 screen out.
    let [sidebar_area, _, _] = layout(Rect::new(0, 0, 80, 8), &sidebar);

    // Then the sidebar is 40 columns wide.
    assert_eq!(sidebar_area.width, 40, "the sidebar's width");
}

/// `state` with the sidebar hidden.
fn hidden(state: AppState) -> AppState {
    AppState {
        sidebar: SidebarView {
            hidden: true,
            ..SidebarView::default()
        },
        ..state
    }
}

#[rstest::rstest]
fn hidden_sidebar_centres_the_start_screen_on_the_whole_width() {
    // Given no row selected with the sidebar hidden.
    let state = hidden(unselected(Focus::Sidebar));

    // When drawing a frame 80 columns wide.
    let buffer = draw(&state);

    // Then the 25-column banner's second row starts in column 27.
    let row = text(&buffer, Rect::new(27, 1, 25, 1));
    assert_eq!(row, "██╔═══██╗██╔══██╗██╔══██╗", "the banner's second row");
}

#[rstest::rstest]
fn hidden_sidebar_draws_the_attached_pane_from_the_left_edge() {
    // Given a live pane for the selected agent, attached, with the sidebar hidden.
    let panes = agent_pane();
    let state = hidden(shown(Focus::Pane));

    // When drawing a frame.
    let row = panes.as_ref().map(|panes| {
        let buffer = draw_with_pane(&state, panes);
        text(&buffer, Rect::new(1, 2, 79, 1))
    });

    // Then the pane's output starts inside its frame, under the tab bar.
    assert!(
        row.as_deref()
            .is_some_and(|row| row.starts_with("PANE-TEXT")),
        "the pane's first row was {row:?}"
    );
}

/// `shown(Focus::Sidebar)` after `edit` changed agent 1's layout.
fn laid_out<F>(edit: F) -> AppState
where
    F: FnOnce(&mut AppState),
{
    let mut state = shown(Focus::Sidebar);
    edit(&mut state);
    state
}

#[rstest::rstest]
fn tab_bar_labels_each_tab_by_number_and_name() {
    // Given a first tab named logs and a second unnamed tab.
    let state = laid_out(|state| {
        state
            .layouts
            .rename_tab(SessionId(1), 0, Some("logs".to_owned()));
        state.layouts.new_tab(SessionId(1), entry(2));
    });

    // When drawing a frame.
    let buffer = draw(&state);

    // Then the tab bar holds ` 1 logs ` and ` 2 `.
    let bar = tab_bar(&buffer);
    assert!(
        bar.contains(" 1 logs ") && bar.contains(" 2 "),
        "tab bar was '{bar}'"
    );
}

#[rstest::rstest]
fn unnamed_tab_shows_its_focused_panes_name() {
    // Given an unnamed tab whose focused pane is named "server".
    let state = laid_out(|state| {
        state
            .layouts
            .rename_pane(PaneId(1), Some("server".to_owned()));
    });

    // When drawing a frame.
    let buffer = draw(&state);

    // Then the tab bar holds ` 1 server `.
    let bar = tab_bar(&buffer);
    assert!(bar.contains(" 1 server "), "tab bar was '{bar}'");
}

#[rstest::rstest]
fn shown_tab_is_bold_black_on_blue() {
    // Given two tabs, the first shown.
    let state = laid_out(|state| {
        state.layouts.new_tab(SessionId(1), entry(2));
        state.layouts.go_to_tab(SessionId(1), 1);
    });

    // When drawing a frame.
    let buffer = draw(&state);

    // Then the first tab's number is bold black on blue.
    let right = right_of(&buffer);
    let number = (right.x..right.right())
        .filter_map(|x| buffer.cell((x, right.y)))
        .find(|cell| cell.symbol() == "1")
        .map(|cell| (cell.fg, cell.bg, cell.modifier.contains(Modifier::BOLD)));
    assert_eq!(number, Some((BLACK, BLUE, true)), "the shown tab's number");
}

/// The tab bar's text.
fn tab_bar(buffer: &Buffer) -> String {
    let right = right_of(buffer);
    text(buffer, Rect::new(right.x, right.y, right.width, 1))
}

/// `shown(Focus::Sidebar)` with session 1 named `name` on `branch`.
fn labelled(name: Option<&str>, branch: Option<&str>) -> AppState {
    let mut state = shown(Focus::Sidebar);
    for session in &mut state.sessions.sessions {
        session.name = name.map(str::to_owned);
        session.branch = branch.map(str::to_owned);
    }
    state
}

#[rstest::rstest]
#[case::name(labelled(Some("work"), Some("feat")), " work ")]
#[case::branch(labelled(None, Some("feat")), " feat ")]
#[case::neither(labelled(None, None), " session ")]
fn tab_bar_starts_with_the_session_label(#[case] state: AppState, #[case] label: &str) {
    // Given session 1 with a name, a branch, or neither.

    // When drawing a frame.
    let buffer = draw(&state);

    // Then the tab bar starts with its name, else its branch, else `session`.
    let bar = tab_bar(&buffer);
    assert!(bar.starts_with(label), "tab bar was '{bar}'");
}

#[rstest::rstest]
fn tab_bar_ends_with_a_plus_chevron() {
    // Given two tabs.
    let state = laid_out(|state| state.layouts.new_tab(SessionId(1), entry(2)));

    // When drawing a frame.
    let buffer = draw(&state);

    // Then a ` + ` chevron follows the last tab.
    let bar = tab_bar(&buffer);
    assert!(
        bar.trim_end().ends_with(" 2 \u{e0b0}\u{e0b0} + \u{e0b0}"),
        "tab bar was '{bar}'"
    );
}

/// The foreground, background and boldness of the tab bar cell where
/// `needle` starts.
fn bar_style(buffer: &Buffer, needle: &str) -> Option<(Color, Color, bool)> {
    find_in_bar(buffer, needle)
        .and_then(|at| buffer.cell(at))
        .map(|cell| (cell.fg, cell.bg, cell.modifier.contains(Modifier::BOLD)))
}

#[rstest::rstest]
fn swap_layout_name_is_lit_on_an_untouched_tab() {
    // Given a tab whose second pane was tiled in, untouched by hand.
    let state = laid_out(|state| state.layouts.add_tiled(SessionId(1), entry(2)));

    // When drawing a frame.
    let buffer = draw(&state);

    // Then its layout name is bold black on blue, like the shown tab.
    assert_eq!(
        bar_style(&buffer, "VERTICAL"),
        Some((BLACK, BLUE, true)),
        "the lit layout name"
    );
}

#[rstest::rstest]
fn swap_layout_name_is_dim_on_a_tab_changed_by_hand() {
    // Given a tab split by hand.
    let state = laid_out(|state| {
        state.layouts.split(SessionId(1), Split::Right, entry(2));
    });

    // When drawing a frame.
    let buffer = draw(&state);

    // Then its layout name is dim, like the other tabs.
    assert_eq!(
        bar_style(&buffer, "BASE"),
        Some((COMMENT, GUTTER, false)),
        "the dim layout name"
    );
}

#[rstest::rstest]
fn swap_layout_indicator_ends_the_tab_bar() {
    // Given a tab whose second pane was tiled in.
    let state = laid_out(|state| state.layouts.add_tiled(SessionId(1), entry(2)));

    // When drawing a frame.
    let buffer = draw(&state);

    // Then the bar ends with the keys' hint and the layout name.
    let bar = tab_bar(&buffer);
    assert!(
        bar.trim_end()
            .ends_with(" Alt <[]> \u{e0b0} VERTICAL \u{e0b0}"),
        "tab bar was '{bar}'"
    );
}

#[rstest::rstest]
fn one_pane_tab_draws_no_swap_layout_indicator() {
    // Given a tab with one pane.
    let state = shown(Focus::Sidebar);

    // When drawing a frame.
    let buffer = draw(&state);

    // Then the bar has no swap layout indicator.
    let bar = tab_bar(&buffer);
    assert!(!bar.contains("Alt <[]>"), "tab bar was '{bar}'");
}

#[rstest::rstest]
fn swap_layout_indicator_gives_way_to_tabs() {
    // Given ten tabs, too many for the bar, the shown one with two panes.
    let state = {
        let mut state = ten_tabs(1);
        state.layouts.add_tiled(SessionId(1), entry(11));
        state
    };

    // When drawing a frame.
    let buffer = draw(&state);

    // Then the indicator is dropped.
    let bar = tab_bar(&buffer);
    assert!(!bar.contains("Alt <[]>"), "tab bar was '{bar}'");
}

#[rstest::rstest]
fn tab_bar_shows_the_float_layout_while_a_float_has_the_keys() {
    // Given a float of session 1 with the keys over a one-pane tab.
    let state = laid_out(|state| {
        state.focus = Focus::Pane;
        state.layouts.add_float(SessionId(1), entry(2));
    });

    // When drawing a frame.
    let buffer = draw(&state);

    // Then the bar ends with the keys' hint and the float layout name.
    let bar = tab_bar(&buffer);
    assert!(
        bar.trim_end()
            .ends_with(" Alt <[]> \u{e0b0} STAGGERED \u{e0b0}"),
        "tab bar was '{bar}'"
    );
}

#[rstest::rstest]
fn float_layout_name_is_dim_once_the_floats_are_changed_by_hand() {
    // Given a float of session 1 with the keys, moved by hand.
    let state = laid_out(|state| {
        state.focus = Focus::Pane;
        state.layouts.fit_to(Rect::new(0, 0, 80, 24));
        state.layouts.add_float(SessionId(1), entry(2));
        state.layouts.move_pane(
            SessionId(1),
            orb_domain::feat::layout::tree::NavDirection::Right,
        );
    });

    // When drawing a frame.
    let buffer = draw(&state);

    // Then the float layout name is dim, like the other tabs.
    assert_eq!(
        bar_style(&buffer, "STAGGERED"),
        Some((COMMENT, GUTTER, false)),
        "the dim float layout name"
    );
}

#[rstest::rstest]
fn tab_bar_keeps_the_tab_layout_while_the_keys_are_in_the_sidebar() {
    // Given a float of session 1 shown over a one-pane tab, the keys in the sidebar.
    let state = laid_out(|state| state.layouts.add_float(SessionId(1), entry(2)));

    // When drawing a frame.
    let buffer = draw(&state);

    // Then the bar has no layout indicator, as for any one-pane tab.
    let bar = tab_bar(&buffer);
    assert!(!bar.contains("Alt <[]>"), "tab bar was '{bar}'");
}

/// Agent 1's session with ten tabs, tab `shown` (1-based) shown.
fn ten_tabs(shown: usize) -> AppState {
    laid_out(|state| {
        for id in 2..=10 {
            state.layouts.new_tab(SessionId(1), entry(id));
        }
        state.layouts.go_to_tab(SessionId(1), shown);
    })
}

#[rstest::rstest]
fn hidden_tabs_on_the_left_are_counted_in_a_chip() {
    // Given ten tabs, the last shown, too many for the bar.
    let state = ten_tabs(10);

    // When drawing a frame.
    let buffer = draw(&state);

    // Then a chip counts the tabs hidden on the left.
    let bar = tab_bar(&buffer);
    assert!(bar.contains(" ← +"), "tab bar was '{bar}'");
}

#[rstest::rstest]
fn hidden_tabs_on_the_right_are_counted_in_a_chip() {
    // Given ten tabs, the first shown, too many for the bar.
    let state = ten_tabs(1);

    // When drawing a frame.
    let buffer = draw(&state);

    // Then a chip counts the tabs hidden on the right.
    let bar = tab_bar(&buffer);
    assert!(bar.contains(" →"), "tab bar was '{bar}'");
}

/// Where `needle` starts in the tab bar, if it's there.
fn find_in_bar(buffer: &Buffer, needle: &str) -> Option<Position> {
    let right = right_of(buffer);
    (right.x..right.right())
        .map(|x| Position::new(x, right.y))
        .find(|at| {
            let rest = Rect::new(at.x, at.y, right.right() - at.x, 1);
            text(buffer, rest).starts_with(needle)
        })
}

/// Where a left click at `at` goes with the keys in the sidebar.
fn click_from_sidebar(hits: &HitMap, at: Position) -> MouseRoute {
    let event = MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: at.x,
        row: at.y,
        modifiers: KeyModifiers::NONE,
    };
    mouse::route(
        event,
        hits,
        Focus::Sidebar,
        None,
        &mut Clicks::default(),
        Instant::now(),
    )
}

/// The hidden tab count in the tab bar's chip that starts with `prefix`.
fn chip_count(buffer: &Buffer, prefix: &str) -> Option<usize> {
    let bar = tab_bar(buffer);
    let (_, rest) = bar.split_once(prefix)?;
    rest.split(' ').next()?.parse().ok()
}

#[rstest::rstest]
fn click_on_a_drawn_tab_shows_it() {
    // Given three tabs of panes 1, 2 and 3, the first shown.
    let state = laid_out(|state| {
        state.layouts.new_tab(SessionId(1), entry(2));
        state.layouts.new_tab(SessionId(1), entry(3));
        state.layouts.go_to_tab(SessionId(1), 1);
    });
    let (buffer, hits) = draw_hits(&state);

    // When clicking where tab 3's label is drawn.
    let route = find_in_bar(&buffer, " 3 ").map(|at| click_from_sidebar(&hits, at));

    // Then tab 3 is shown with the keys in pane 3.
    assert_eq!(
        route,
        Some(MouseRoute::Intents(vec![
            Intent::GoToTab(3),
            Intent::FocusPane(PaneId(3))
        ])),
        "a click lands on the tab drawn there"
    );
}

#[rstest::rstest]
fn click_on_the_drawn_plus_opens_a_tab() {
    // Given two tabs.
    let state = laid_out(|state| state.layouts.new_tab(SessionId(1), entry(2)));
    let (buffer, hits) = draw_hits(&state);

    // When clicking where `+` is drawn.
    let route = find_in_bar(&buffer, "+").map(|at| click_from_sidebar(&hits, at));

    // Then a tab is opened.
    assert_eq!(
        route,
        Some(MouseRoute::Intents(vec![Intent::NewTab])),
        "a click on `+` opens a tab"
    );
}

#[rstest::rstest]
fn click_on_the_drawn_right_chip_shows_the_first_hidden_tab() {
    // Given ten tabs, the first shown, some hidden on the right.
    let (buffer, hits) = draw_hits(&ten_tabs(1));
    let hidden = chip_count(&buffer, " +");

    // When clicking the right chip.
    let route = find_in_bar(&buffer, " +").map(|at| click_from_sidebar(&hits, at));

    // Then the leftmost hidden tab is shown with the keys in its pane.
    let first_hidden = hidden.map(|hidden| 10 - hidden + 1);
    assert_eq!(
        route,
        first_hidden.map(|n| MouseRoute::Intents(vec![
            Intent::GoToTab(n),
            Intent::FocusPane(PaneId(n as i64))
        ])),
        "the right chip shows the nearest hidden tab"
    );
}

#[rstest::rstest]
fn click_on_the_drawn_left_chip_shows_the_last_hidden_tab() {
    // Given ten tabs, the last shown, some hidden on the left.
    let (buffer, hits) = draw_hits(&ten_tabs(10));
    let hidden = chip_count(&buffer, " ← +");

    // When clicking the left chip.
    let route = find_in_bar(&buffer, " ← +").map(|at| click_from_sidebar(&hits, at));

    // Then the rightmost hidden tab is shown with the keys in its pane.
    assert_eq!(
        route,
        hidden.map(|n| MouseRoute::Intents(vec![
            Intent::GoToTab(n),
            Intent::FocusPane(PaneId(n as i64))
        ])),
        "the left chip shows the nearest hidden tab"
    );
}

/// The colour of the top-left corner of the frame at column `x` of the
/// tab body.
fn corner_fg(buffer: &Buffer, x: u16) -> Option<Color> {
    let right = right_of(buffer);
    buffer
        .cell((right.x + x, right.y + 1))
        .filter(|cell| cell.symbol() == "╭")
        .map(|cell| cell.fg)
}

#[rstest::rstest]
fn pane_with_the_keys_has_a_blue_frame() {
    // Given agent 1's pane shown with the keys in it.
    let state = shown(Focus::Pane);

    // When drawing a frame.
    let buffer = draw(&state);

    // Then the pane's frame is blue.
    assert_eq!(corner_fg(&buffer, 0), Some(BLUE), "the lit frame");
}

#[rstest::rstest]
fn focused_pane_while_the_sidebar_has_the_keys_has_a_grey_frame() {
    // Given agent 1's pane shown while the sidebar has the keys.
    let state = shown(Focus::Sidebar);

    // When drawing a frame.
    let buffer = draw(&state);

    // Then the pane's frame is grey.
    assert_eq!(corner_fg(&buffer, 0), Some(COMMENT), "the focused frame");
}

#[rstest::rstest]
fn unfocused_pane_has_a_dim_frame() {
    // Given agent 1's pane split right, the new right pane focused.
    let mut state = laid_out(|state| state.layouts.split(SessionId(1), Split::Right, entry(2)));
    state.focus = Focus::Pane;

    // When drawing a frame.
    let buffer = draw(&state);

    // Then the left pane's frame is dim.
    assert_eq!(corner_fg(&buffer, 0), Some(GUTTER), "the unfocused frame");
}

/// `shown(Focus::Sidebar)` with pane 1 named `server`.
fn named_pane() -> AppState {
    laid_out(|state| {
        state
            .layouts
            .rename_pane(PaneId(1), Some("server".to_owned()));
    })
}

/// `shown(Focus::Sidebar)` with agent 1 no longer running in pane 1.
fn shell_pane() -> AppState {
    let mut state = shown(Focus::Sidebar);
    for agent in state
        .sessions
        .projects
        .iter_mut()
        .flat_map(|project| &mut project.agents)
    {
        agent.pane = None;
    }
    state
}

#[rstest::rstest]
#[case::name(named_pane(), " server ")]
#[case::agent_title(shown(Focus::Sidebar), " Fix the bug ")]
#[case::shell(shell_pane(), " shell ")]
fn frame_title_names_the_pane(#[case] state: AppState, #[case] title: &str) {
    // Given pane 1 with a name, an agent's title, or neither.

    // When drawing a frame.
    let buffer = draw(&state);

    // Then the frame's top edge reads its name, else its agent's title, else shell.
    let right = right_of(&buffer);
    let top = text(&buffer, Rect::new(right.x, right.y + 1, right.width, 1));
    assert!(top.contains(title), "top edge was '{top}'");
}

#[rstest::rstest]
fn zoomed_tab_draws_one_frame() {
    // Given agent 1's pane split right, then zoomed.
    let state = laid_out(|state| {
        state.layouts.split(SessionId(1), Split::Right, entry(2));
        state.layouts.toggle_zoom(SessionId(1));
    });

    // When drawing a frame.
    let buffer = draw(&state);

    // Then the tab body holds a single frame.
    let right = right_of(&buffer);
    let body = text(
        &buffer,
        Rect::new(right.x, right.y + 1, right.width, right.height - 1),
    );
    assert_eq!(body.matches('╭').count(), 1, "body was\n{body}");
}

/// Agent 1's session showing one tab of panes 1 to 4 stacked, pane 3
/// expanded and focused. Pane 1 runs agent 1 ("Fix the bug"), pane 2 is
/// named `api` and pane 4 is a plain shell.
fn stacked() -> AppState {
    laid_out(|state| {
        let tree = TileLayout::from_saved(
            Node::Stack {
                panes: (1..=4).map(PaneId).collect(),
                expanded: PaneId(3),
            },
            PaneId(3),
        );
        let api = PaneEntry {
            name: Some("api".to_owned()),
            ..entry(2)
        };
        state.layouts.insert(
            SessionId(1),
            SessionLayout::restore(
                vec![Tab::restore(None, tree, SwapLayout::Vertical, false)],
                0,
                vec![entry(1), api, entry(3), entry(4)],
                Floats::default(),
            ),
        );
    })
}

#[rstest::rstest]
#[case("│ api")]
#[case("│ Fix the bug")]
#[case("│ shell")]
fn stack_list_names_every_stacked_pane(#[case] row: &str) {
    // Given a stack of a named pane, an agent's pane and shells.
    let state = stacked();

    // When drawing a frame tall enough for every row.
    let buffer = draw_tall(&state, None);

    // Then the list has a row reading its name, else its agent's title, else shell.
    let right = right_side(&buffer);
    assert!(right.contains(row), "right side was\n{right}");
}

#[rstest::rstest]
fn stack_list_marks_the_shown_pane() {
    // Given a stack of four panes, the shell pane 3 shown.
    let state = stacked();

    // When drawing a frame.
    let buffer = draw(&state);

    // Then its row reads `> │ shell`, the `>` outside the bar.
    let right = right_side(&buffer);
    assert!(right.contains("> │ shell"), "right side was\n{right}");
}

/// `stacked()` with pane 2 named `name`.
fn stacked_naming(name: &str) -> AppState {
    let mut state = stacked();
    state.layouts.rename_pane(PaneId(2), Some(name.to_owned()));
    state
}

#[rstest::rstest]
fn stack_list_cuts_long_names() {
    // Given a stacked pane named with 60 letters, wider than the list.
    let state = stacked_naming(&"abcdefghij".repeat(6));

    // When drawing a frame tall enough for every row.
    let buffer = draw_tall(&state, None);

    // Then its row ends in `…`.
    let right = right_side(&buffer);
    let row = right.lines().find(|line| line.contains("│ abcdefghij"));
    assert!(
        row.is_some_and(|row| row.trim_end().ends_with("…│")),
        "right side was\n{right}"
    );
}

#[rstest::rstest]
fn stack_list_has_no_frame() {
    // Given a stack of four panes.
    let state = stacked();

    // When drawing a frame tall enough for every row.
    let buffer = draw_tall(&state, None);

    // Then the body's only frame is the shown pane's.
    let right = right_of(&buffer);
    let body = text(
        &buffer,
        Rect::new(right.x, right.y + 1, right.width, right.height - 1),
    );
    assert_eq!(body.matches('╭').count(), 1, "body was\n{body}");
}

#[rstest::rstest]
fn stack_list_sits_above_the_shown_pane() {
    // Given a stack of four panes, pane 3 shown.
    let state = stacked();

    // When drawing a frame tall enough for every row.
    let buffer = draw_tall(&state, None);

    // Then the first body row is the first stacked pane's, and the shown
    // pane's frame starts under the four rows.
    let right = right_of(&buffer);
    let first = text(&buffer, Rect::new(right.x, right.y + 1, right.width, 1));
    let corner = buffer
        .cell((right.x, right.y + 5))
        .map(|cell| cell.symbol().to_owned());
    assert_eq!(
        (first.trim().to_owned(), corner),
        ("│ Fix the bug │".to_owned(), Some("╭".to_owned())),
        "the list is on top, the shown pane below"
    );
}

#[rstest::rstest]
fn stack_list_rows_have_a_bar_on_each_side() {
    // Given a stack of four panes.
    let state = stacked();

    // When drawing a frame tall enough for every row.
    let buffer = draw_tall(&state, None);

    // Then each of the four list rows starts and ends with a bar, past
    // the shown row's `>`.
    let right = right_of(&buffer);
    let rows: Vec<String> = (1..=4)
        .map(|y| text(&buffer, Rect::new(right.x, right.y + y, right.width, 1)))
        .collect();
    assert!(
        rows.iter()
            .map(|row| row.trim().trim_start_matches('>').trim_start())
            .all(|row| row.starts_with('│') && row.ends_with('│')),
        "list rows were {rows:#?}"
    );
}

#[rstest::rstest]
fn stack_list_is_centred() {
    // Given a stack of four panes.
    let state = stacked();

    // When drawing a frame tall enough for every row.
    let buffer = draw_tall(&state, None);

    // Then the first list row has as much space on its left as on its
    // right, give or take a column.
    let right = right_of(&buffer);
    let row = text(&buffer, Rect::new(right.x, right.y + 1, right.width, 1));
    let left = row.len() - row.trim_start().len();
    let after = row.len() - row.trim_end().len();
    assert!(left.abs_diff(after) <= 1, "row was {row:?}");
}

/// Draws `state` on an 80x8 screen, returning the buffer and the hit map.
fn draw_hits(state: &AppState) -> (Buffer, HitMap) {
    let mut hits = HitMap::default();
    let Ok(mut terminal) = Terminal::new(TestBackend::new(80, 8));
    let keys = Keys::new(keymap(), Scope::SIDEBAR);
    let Ok(_) = terminal.draw(|frame| {
        render(
            frame,
            state,
            &HashMap::new(),
            None,
            None,
            &keys,
            SystemTime::UNIX_EPOCH,
            &TimeZone::UTC,
            BACKGROUND,
            &mut SidebarScroll::default(),
            &mut PickerScroll::default(),
            &mut hits,
            &mut Vec::new(),
        );
    });
    (terminal.backend().buffer().clone(), hits)
}

/// Where a left click at `at` goes with the keys in pane 3.
fn click_in_stack(hits: &HitMap, at: Position) -> MouseRoute {
    let event = MouseEvent {
        kind: MouseEventKind::Down(MouseButton::Left),
        column: at.x,
        row: at.y,
        modifiers: KeyModifiers::NONE,
    };
    mouse::route(
        event,
        hits,
        Focus::Pane,
        Some(PaneId(3)),
        &mut Clicks::default(),
        Instant::now(),
    )
}

#[rstest::rstest]
fn click_on_a_stack_list_row_focuses_its_pane() {
    // Given a stack drawn with pane 3 shown and focused.
    let (buffer, hits) = draw_hits(&stacked());
    let row = find(&buffer, "api");

    // When clicking pane 2's row with the keys in pane 3.
    let route = row.map(|at| click_in_stack(&hits, at));

    // Then pane 2 takes the focus without starting a selection.
    assert_eq!(
        route,
        Some(MouseRoute::Intents(vec![Intent::FocusPane(PaneId(2))])),
        "a click on a list row should focus its pane"
    );
}

/// Agent 1's session showing one tab split right into two stacks: panes
/// 1 and 2 on the left with pane 1 expanded, panes 3 and 4 on the right
/// with pane 3 expanded and focused. Pane 1 runs agent 1 ("Fix the
/// bug"), pane 2 is named `api`, pane 3 is a shell and pane 4 is named
/// `web`.
fn two_stacks() -> AppState {
    laid_out(|state| {
        let tree = TileLayout::from_saved(
            Node::Split {
                split: Split::Right,
                ratio: 0.5,
                first: Box::new(Node::Stack {
                    panes: vec![PaneId(1), PaneId(2)],
                    expanded: PaneId(1),
                }),
                second: Box::new(Node::Stack {
                    panes: vec![PaneId(3), PaneId(4)],
                    expanded: PaneId(3),
                }),
            },
            PaneId(3),
        );
        let api = PaneEntry {
            name: Some("api".to_owned()),
            ..entry(2)
        };
        let web = PaneEntry {
            name: Some("web".to_owned()),
            ..entry(4)
        };
        state.layouts.insert(
            SessionId(1),
            SessionLayout::restore(
                vec![Tab::restore(None, tree, SwapLayout::Vertical, false)],
                0,
                vec![entry(1), api, entry(3), web],
                Floats::default(),
            ),
        );
    })
}

#[rstest::rstest]
fn each_stack_list_marks_its_own_shown_pane() {
    // Given two stacks, pane 1 shown on the left and the shell pane 3 on
    // the right.
    let state = two_stacks();

    // When drawing a frame tall enough for every row.
    let buffer = draw_tall(&state, None);

    // Then each list has a `>` on its own shown pane's row.
    let right = right_side(&buffer);
    assert!(
        right.contains("> │ Fix the bug") && right.contains("> │ shell"),
        "right side was\n{right}"
    );
}

#[rstest::rstest]
#[case("api", PaneId(2))]
#[case("web", PaneId(4))]
fn wheel_down_over_a_stack_list_shows_that_stacks_next_pane(
    #[case] needle: &str,
    #[case] expected: PaneId,
) {
    // Given two stacks drawn, pane 1 shown on the left, pane 3 on the
    // right and focused.
    let (buffer, hits) = draw_hits(&two_stacks());
    let row = find(&buffer, needle);

    // When wheeling down over a row of one of the lists with the keys in
    // pane 3.
    let route = row.map(|at| {
        mouse::route(
            MouseEvent {
                kind: MouseEventKind::ScrollDown,
                column: at.x,
                row: at.y,
                modifiers: KeyModifiers::NONE,
            },
            &hits,
            Focus::Pane,
            Some(PaneId(3)),
            &mut Clicks::default(),
            Instant::now(),
        )
    });

    // Then that stack's pane after its shown one is shown.
    assert_eq!(
        route,
        Some(MouseRoute::Intents(vec![Intent::ShowStacked(expected)])),
        "the wheel over {needle}'s list steps that stack's shown pane"
    );
}

#[rstest::rstest]
fn wheel_down_over_the_drawn_stack_list_shows_the_next_pane() {
    // Given a stack drawn with pane 3 of panes 1 to 4 shown and focused.
    let (buffer, hits) = draw_hits(&stacked());
    let row = find(&buffer, "api");

    // When wheeling down over pane 2's row with the keys in pane 3.
    let route = row.map(|at| {
        mouse::route(
            MouseEvent {
                kind: MouseEventKind::ScrollDown,
                column: at.x,
                row: at.y,
                modifiers: KeyModifiers::NONE,
            },
            &hits,
            Focus::Pane,
            Some(PaneId(3)),
            &mut Clicks::default(),
            Instant::now(),
        )
    });

    // Then pane 4, the one after the shown pane, is shown.
    assert_eq!(
        route,
        Some(MouseRoute::Intents(vec![Intent::ShowStacked(PaneId(4))])),
        "the wheel over the list steps the shown pane"
    );
}

#[rstest::rstest]
fn click_on_the_shown_stack_row_does_nothing() {
    // Given a stack drawn with pane 3 shown and focused.
    let (buffer, hits) = draw_hits(&stacked());
    let row = find(&buffer, "> │ shell").map(|at| Position::new(at.x + 4, at.y));

    // When clicking the shown pane's name.
    let route = row.map(|at| click_in_stack(&hits, at));

    // Then nothing happens.
    assert_eq!(
        route,
        Some(MouseRoute::Nothing),
        "the shown row isn't a click target"
    );
}

#[rstest::rstest]
fn hidden_sidebar_returns_no_layout() {
    // Given a selected agent with the sidebar hidden.
    let state = hidden(selected(Focus::Sidebar));

    // When drawing a frame.
    let Ok(mut terminal) = Terminal::new(TestBackend::new(80, 8));
    let mut sidebar_layout = None;
    let Ok(_) = terminal.draw(|frame| {
        (sidebar_layout, _, _) = render(
            frame,
            &state,
            &HashMap::new(),
            None,
            None,
            &Keys::new(keymap(), Scope::SIDEBAR),
            SystemTime::UNIX_EPOCH,
            &TimeZone::UTC,
            BACKGROUND,
            &mut SidebarScroll::default(),
            &mut PickerScroll::default(),
            &mut HitMap::default(),
            &mut Vec::new(),
        );
    });

    // Then there's no sidebar layout to replace the last drawn one.
    assert_eq!(sidebar_layout, None, "a hidden sidebar isn't laid out");
}

#[rstest::rstest]
fn pane_mode_draws_its_key_box() {
    // Given move mode on in a shown pane.
    let state = AppState {
        pane_mode: Some(PaneMode::Move),
        ..shown(Focus::Pane)
    };

    // When drawing a frame.
    let buffer = draw_tall(&state, None);

    // Then the move key box is drawn.
    let text = text(&buffer, buffer.area);
    assert!(text.contains("╭ MOVE "), "the mode's key box should show");
}

#[rstest::rstest]
fn pane_mode_draws_no_key_box_away_from_the_pane() {
    // Given a resize mode left over with the keys in the sidebar.
    let state = AppState {
        pane_mode: Some(PaneMode::Resize),
        ..shown(Focus::Sidebar)
    };

    // When drawing a frame.
    let buffer = draw_tall(&state, None);

    // Then no mode key box is drawn.
    let text = text(&buffer, buffer.area);
    assert!(
        !text.contains("RESIZE") && !text.contains("esc/⏎ exit"),
        "a mode away from the pane should draw no box"
    );
}

/// Where `state`'s shown float frame was drawn in `buffer`.
fn drawn_float(state: &AppState, buffer: &Buffer) -> Option<Rect> {
    let [_, body] = crate::tabs::areas(right_of(buffer));
    let layout = state.shown_layout()?;
    crate::tabs::placement(state, layout, body)
        .panes
        .into_iter()
        .find(|place| place.floating)
        .map(|place| place.area)
}

#[rstest::rstest]
fn press_on_a_drawn_float_border_starts_a_drag() {
    // Given float 2 drawn over agent 1's pane with the keys.
    let state = laid_out(|state| {
        state.focus = Focus::Pane;
        state.layouts.add_float(SessionId(1), entry(2));
    });
    let (buffer, hits) = draw_hits(&state);
    let frame = drawn_float(&state, &buffer);

    // When pressing its top-left corner, then dragging three cells right.
    let route = frame.map(|frame| {
        let mut clicks = Clicks::default();
        let event = |kind, column| MouseEvent {
            kind,
            column,
            row: frame.y,
            modifiers: KeyModifiers::NONE,
        };
        let mut send = |event| {
            mouse::route(
                event,
                &hits,
                Focus::Pane,
                Some(PaneId(2)),
                &mut clicks,
                Instant::now(),
            )
        };
        send(event(MouseEventKind::Down(MouseButton::Left), frame.x));
        (
            frame,
            send(event(MouseEventKind::Drag(MouseButton::Left), frame.x + 3)),
        )
    });

    // Then the drag moves the float three cells right.
    assert!(
        route.is_some_and(|(frame, route)| route
            == MouseRoute::Intents(vec![Intent::DragFloat {
                pane: PaneId(2),
                x: frame.x + 3,
                y: frame.y,
            }])),
        "a drag of a drawn float's border moves it"
    );
}

#[rstest::rstest]
fn click_on_a_tab_with_floats_shown_keeps_the_keys_in_the_float() {
    // Given two tabs, the first shown, and float 3 shown over them.
    let state = laid_out(|state| {
        state.layouts.new_tab(SessionId(1), entry(2));
        state.layouts.add_float(SessionId(1), entry(3));
        state.layouts.go_to_tab(SessionId(1), 1);
    });
    let (buffer, hits) = draw_hits(&state);

    // When clicking where tab 2's label is drawn.
    let route = find_in_bar(&buffer, " 2 ").map(|at| click_from_sidebar(&hits, at));

    // Then tab 2 is shown with the keys still in the float.
    assert_eq!(
        route,
        Some(MouseRoute::Intents(vec![
            Intent::GoToTab(2),
            Intent::FocusPane(PaneId(3))
        ])),
        "a tab click keeps the floats shown"
    );
}
