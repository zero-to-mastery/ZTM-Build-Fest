use orb_domain::feat::harness::HarnessId;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use orb_domain::feat::control::change::Change;
use orb_domain::feat::control::pane_control::PaneRequest;
use orb_domain::feat::control::protocol::ErrorCode;
use orb_domain::feat::layout::state::{Layouts, PaneEntry, SessionLayout};
use orb_domain::feat::layout::tree::Split;
use orb_domain::feat::picker::list::PickerItem;
use orb_domain::feat::picker::state::{PickerState, SessionFilter, session_items, worktree_items};
use orb_domain::feat::sessions::state::{
    Agent, AgentStatus, PaneLaunch, Project, ProjectKind, Session, SessionKind, Sessions,
    SidebarItem,
};
use orb_domain::ids::{AgentId, PaneId, ProjectId, SessionId};
use std::ffi::OsString;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use jiff::tz::TimeZone;
use orb_domain::feat::git::git_service::GitService;
use orb_domain::feat::harness::Harnesses;
use orb_domain::feat::notify::none::NoneNotifier;
use orb_domain::feat::notify::notifier::NotifierService;
use orb_domain::feat::notify::sound::{SoundError, SoundPlayer, SoundService};
use orb_domain::feat::search::search_actor::{SearchActorDeps, spawn_search_actor};
use orb_domain::feat::sessions::sessions_actor::{SessionsActorDeps, spawn_sessions_actor};
use orb_domain::feat::sessions::store::Store;
use orb_domain::feat::sessions::transcript::Role;
use orb_domain::feat::worktrees::state::Worktree;
use orb_domain::feat::worktrees::worktrees_actor::{WorktreesActorDeps, spawn_worktrees_actor};
use orb_domain::feat::zmx::zmx_service::{ZmxService, ZmxSession};
use orb_domain::{
    AppState, Command, Focus, Intent, IntentHandler, Log, Outcome, PaneMode, Reporter, Services,
    SessionsCommand, State,
};
use orb_term::{CellSize, GraphicsSupport, PaneEvent};
use ratatui::crossterm::cursor::SetCursorStyle;
use ratatui::crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::layout::Rect;
use tempfile::TempDir;
use tokio::runtime::Runtime;

use crate::mouse::HitMap;
use crate::outer_terminal::OuterTerminal;
use crate::test_support::{FakeZmx, NoGit, layouts_for, pane, session as session_id, sessions_for};

use super::panes::{
    AttachPlan, ExitOutcome, PaneExit, attach_at_start, attach_or_restore, broken_pane_message,
    classify_exit, clear_detached, closed_in_layouts, exit_outcome, holds_agent, pane_error_after,
    present_at_start, reattachable, resume_plan, stale_sessions, to_drop, to_kill, to_spawn,
};
use super::report::{StartedAttach, show, started_attach};
use super::{
    App, LoopEvent, PREVIEW_EVERY, Toasts, after_pane, cursor_style, handle_mouse_intents,
    list_directories, preview_due, stale_preview,
};

/// Pane `id`, a shell in `orb-p<id>`.
fn entry(id: i64) -> PaneEntry {
    PaneEntry {
        id: PaneId(id),
        zmx: ZmxSession {
            name: format!("orb-p{id}"),
            dir: "/zmx".into(),
        },
        cwd: "/tmp".into(),
        name: None,
        resume: None,
    }
}

/// Session 1 holding panes 1 and 2 side by side.
fn split_session() -> Layouts {
    let mut layouts = Layouts::default();
    layouts.insert(SessionId(1), SessionLayout::of(entry(1)));
    layouts.split(SessionId(1), Split::Right, entry(2));
    layouts
}

#[rstest::rstest]
fn ended_pane_of_an_attached_session_closes_in_its_layout() {
    // Given attached session 1 with panes 1 and 2.
    let mut layouts = split_session();
    let attached = HashSet::from([SessionId(1)]);

    // When pane 2 ends.
    closed_in_layouts(&mut layouts, &attached, &HashSet::from([PaneId(2)]));

    // Then only pane 1 is left in its layout.
    assert_eq!(
        layouts.session_panes(SessionId(1)),
        [PaneId(1)],
        "an attached session's ended pane closes"
    );
}

#[rstest::rstest]
fn ended_pane_of_an_unattached_session_stays_in_its_layout() {
    // Given session 1 with panes 1 and 2, not attached.
    let mut layouts = split_session();

    // When pane 2 ends.
    closed_in_layouts(&mut layouts, &HashSet::new(), &HashSet::from([PaneId(2)]));

    // Then both panes are still in its layout.
    assert_eq!(
        layouts.session_panes(SessionId(1)).len(),
        2,
        "orb killed it, so the layout keeps it"
    );
}

/// Session `id` of project 1, settled at `settled`.
fn session(id: i64, settled: bool) -> Session {
    Session {
        id: SessionId(id),
        project: ProjectId(1),
        kind: SessionKind::Plain,
        dir: "/tmp".into(),
        name: None,
        branch: None,
        created_at: UNIX_EPOCH,
        pinned_at: None,
        settled_at: settled.then_some(UNIX_EPOCH),
        parent: None,
        active_since: UNIX_EPOCH,
        last_activity_at: UNIX_EPOCH,
    }
}

#[rstest::rstest]
#[case::reattached(PaneExit::Respawn, true, ExitOutcome::Reattached)]
#[case::respawn_failed_to_attach(PaneExit::Respawn, false, ExitOutcome::Detached)]
#[case::failed(PaneExit::Failed, false, ExitOutcome::Detached)]
#[case::ended(PaneExit::Ended, false, ExitOutcome::Closed)]
#[case::dropped(PaneExit::Drop, false, ExitOutcome::Dropped)]
fn exit_outcome_after_a_classified_exit(
    #[case] exit: PaneExit,
    #[case] reattached: bool,
    #[case] expected: ExitOutcome,
) {
    assert_eq!(
        exit_outcome(exit, reattached),
        expected,
        "{exit:?} with a new client {reattached}"
    );
}

/// Unsettled session 1 in `dir`, owning pane 1, as start-up sees them.
fn session_in(dir: PathBuf) -> (AppState, Vec<(SessionId, ZmxSession)>) {
    let mut state = AppState::default();
    state.sessions.sessions = vec![Session {
        dir,
        ..session(1, false)
    }];
    (state, vec![(SessionId(1), entry(1).zmx)])
}

#[rstest::rstest]
fn start_counts_a_session_whose_directory_is_there() -> io::Result<()> {
    // Given session 1 whose directory is on disk.
    let dir = tempfile::tempdir()?;
    let (state, panes) = session_in(dir.path().to_owned());

    // When start-up checks which directories are there.
    let present = present_at_start(&state, &panes);

    // Then session 1 counts.
    assert_eq!(
        present,
        HashSet::from([SessionId(1)]),
        "a session whose directory is there counts as present"
    );
    Ok(())
}

#[rstest::rstest]
fn start_leaves_out_a_session_whose_directory_is_gone() -> io::Result<()> {
    // Given session 1 whose directory is gone.
    let dir = tempfile::tempdir()?;
    let (state, panes) = session_in(dir.path().join("gone"));

    // When start-up checks which directories are there.
    let present = present_at_start(&state, &panes);

    // Then session 1 is left out.
    assert!(
        present.is_empty(),
        "a session whose directory is gone isn't present"
    );
    Ok(())
}

#[rstest::rstest]
fn reattach_skips_settled_sessions() {
    // Given unsettled session 1 with pane 1 and settled session 2 with
    // pane 2.
    let mut state = AppState::default();
    state.sessions.sessions = vec![session(1, false), session(2, true)];
    state
        .layouts
        .insert(SessionId(1), SessionLayout::of(entry(1)));
    state
        .layouts
        .insert(SessionId(2), SessionLayout::of(entry(2)));

    // When picking what start-up attaches again.
    let owners: Vec<SessionId> = reattachable(&state)
        .into_iter()
        .map(|(owner, _)| owner)
        .collect();

    // Then only session 1 is.
    assert_eq!(
        owners,
        [SessionId(1)],
        "a settled session's panes stay down"
    );
}

#[rstest::rstest]
#[case::sidebar_block(Focus::Sidebar, None, SetCursorStyle::SteadyBlock)]
#[case::picker_bar(Focus::Picker, None, SetCursorStyle::SteadyBar)]
#[case::rename_bar(Focus::Rename, None, SetCursorStyle::SteadyBar)]
#[case::search_bar(Focus::Search, None, SetCursorStyle::SteadyBar)]
#[case::pane_follows_its_program(
    Focus::Pane,
    Some(SetCursorStyle::BlinkingUnderScore),
    SetCursorStyle::BlinkingUnderScore
)]
fn cursor_shape_follows_where_the_keys_are(
    #[case] focus: Focus,
    #[case] pane: Option<SetCursorStyle>,
    #[case] expected: SetCursorStyle,
) {
    // Given / When choosing the cursor shape in `focus` with the pane's `pane` shape.
    let style = cursor_style(focus, pane);

    // Then it is the shape for that focus.
    assert_eq!(style, expected, "cursor shape in {focus:?}");
}

#[rstest::rstest]
fn preview_of_a_newly_selected_agent_is_due_at_once() {
    // Given agent 1's preview was just read.
    let now = Instant::now();
    let last = Some((AgentId(1), now));

    // When asking when agent 2's preview is due.
    let due = preview_due(last, AgentId(2), now);

    // Then it is due at once.
    assert_eq!(due, now, "another agent's preview should be due at once");
}

#[rstest::rstest]
fn preview_of_the_same_agent_waits_a_second_after_its_last_read() {
    // Given agent 1's preview was read at `read_at`.
    let read_at = Instant::now();
    let last = Some((AgentId(1), read_at));

    // When asking 300 ms later when agent 1's preview is due.
    let asked = read_at + Duration::from_millis(300);
    let due = preview_due(last, AgentId(1), asked);

    // Then it is due a second after the last read, later than the ask.
    assert!(
        due == read_at + PREVIEW_EVERY && due > asked,
        "the same agent should wait a second after its last read, due {due:?}"
    );
}

#[rstest::rstest]
fn preview_of_the_same_agent_is_due_once_a_second_has_passed() {
    // Given agent 1's preview was read at `read_at`.
    let read_at = Instant::now();
    let last = Some((AgentId(1), read_at));

    // When asking a second later when agent 1's preview is due.
    let asked = read_at + PREVIEW_EVERY;
    let due = preview_due(last, AgentId(1), asked);

    // Then it is due by then.
    assert!(
        due <= asked,
        "the same agent should be due once a second has passed"
    );
}

#[rstest::rstest]
fn stale_preview_leaves_the_search_picker_alone() -> io::Result<()> {
    // Given agent 1 with a transcript on disk, and the search picker
    // showing a hit in it.
    let dir = tempfile::tempdir()?;
    let transcript = dir.path().join("1.jsonl");
    fs::write(&transcript, "{}\n")?;
    let state = AppState {
        sessions: Sessions {
            projects: vec![Project {
                id: ProjectId(1),
                title: "orb".to_owned(),
                root: PathBuf::from("/repo"),
                created_at: UNIX_EPOCH,
                agents: vec![Agent {
                    last_session: None,
                    harness: HarnessId::new("claude"),
                    id: AgentId(1),
                    title: None,
                    cwd: "/tmp".into(),
                    transcript: Some(transcript.clone()),
                    status: AgentStatus::Idle,
                    turn_started_at: None,
                    pane: None,
                    branch: None,
                    created_at: UNIX_EPOCH,
                    last_activity_at: UNIX_EPOCH,
                    unseen: false,
                    model: None,
                }],
                repo: true,
                removed: false,
                kind: ProjectKind::Normal,
            }],
            ..Sessions::default()
        },
        picker: Some({
            let mut picker = PickerState::search(Focus::Sidebar);
            picker.show_hits(
                "",
                vec![PickerItem::Hit {
                    id: 1,
                    agent: AgentId(1),
                    label: "orb/fix".to_owned(),
                    split: 4,
                    snippet: "the parser".to_owned(),
                    lit: vec![],
                    text_lit: vec![],
                    path: transcript,
                    prompt_offset: 0,
                }],
                false,
            );
            picker
        }),
        ..AppState::default()
    };

    // When checking for a stale session preview.
    let stale = stale_preview(&state);

    // Then there is none to read.
    assert!(stale.is_none(), "search previews come from the index");
    Ok(())
}

#[rstest::rstest]
fn list_directories_keeps_directories_and_links_to_them() -> io::Result<()> {
    // Given a directory holding a file, a directory, and a link to it.
    let dir = tempfile::tempdir()?;
    fs::write(dir.path().join("notes.txt"), "")?;
    fs::create_dir_all(dir.path().join("dev"))?;
    symlink(dir.path().join("dev"), dir.path().join("linked"))?;

    // When listing its subdirectories.
    let names = {
        let mut names = list_directories(dir.path());
        names.sort();
        names
    };

    // Then the directory and the link are listed, not the file.
    assert_eq!(names, ["dev", "linked"], "the listed subdirectories");
    Ok(())
}

#[rstest::rstest]
#[case(Focus::Pane, Focus::Sidebar)]
#[case(Focus::Sidebar, Focus::Sidebar)]
#[case(Focus::Picker, Focus::Picker)]
fn keys_leave_a_gone_pane_for_the_sidebar_only_from_the_pane(
    #[case] focus: Focus,
    #[case] expected: Focus,
) {
    // Given / When / Then only a pane focus moves to the sidebar once the
    // pane is gone.
    assert_eq!(
        after_pane(focus),
        expected,
        "focus after the pane goes from {focus:?}"
    );
}

#[rstest::rstest]
fn ready_session_opens_while_the_same_session_is_active() {
    // Given session 1 restored while it was active, the cursor having
    // moved to another row meanwhile, and it still active.
    let active = Some(SessionId(1));

    // When deciding what to do in the sidebar.
    let decision = started_attach(active, active, Focus::Sidebar, false);

    // Then orb opens it, taking the keys into the pane.
    assert_eq!(
        decision,
        StartedAttach::Attach { keep_keys: false },
        "glancing around the sidebar shouldn't cancel the open"
    );
}

#[rstest::rstest]
fn ready_session_is_dropped_after_another_session_opened() {
    // Given a session asked for while session 1 was active, and session 2
    // opened since.

    // When deciding what to do.
    let decision = started_attach(
        Some(SessionId(1)),
        Some(SessionId(2)),
        Focus::Sidebar,
        false,
    );

    // Then it is dropped.
    assert_eq!(
        decision,
        StartedAttach::Drop,
        "opening another session meanwhile cancels the open"
    );
}

#[rstest::rstest]
fn new_session_opens_when_nothing_was_active_and_still_isnt() {
    // Given a new session asked for with nothing active, and still nothing.

    // When deciding what to do.
    let decision = started_attach(None, None, Focus::Sidebar, false);

    // Then it opens.
    assert_eq!(
        decision,
        StartedAttach::Attach { keep_keys: false },
        "a new session opens when the user opened nothing else"
    );
}

#[rstest::rstest]
#[case(Focus::Picker)]
#[case(Focus::Rename)]
#[case(Focus::Search)]
fn ready_session_waits_while_typing(#[case] focus: Focus) {
    // Given session 1 ready while it is still active, e.g. while a picker
    // has the keys.
    let active = Some(SessionId(1));

    // When deciding what to do in `focus`.
    let decision = started_attach(active, active, focus, false);

    // Then it waits instead of being dropped.
    assert_eq!(
        decision,
        StartedAttach::Wait,
        "the open should wait in {focus:?}"
    );
}

#[rstest::rstest]
fn ready_session_opens_at_once_from_a_pane() {
    // Given session 1 ready while it is still active and the keys are in a
    // pane.
    let active = Some(SessionId(1));

    // When deciding what to do in the pane.
    let decision = started_attach(active, active, Focus::Pane, false);

    // Then orb opens it, taking the keys into its pane.
    assert_eq!(
        decision,
        StartedAttach::Attach { keep_keys: false },
        "being in a pane shouldn't hold the open back"
    );
}

#[rstest::rstest]
fn waited_ready_session_opens_once_the_keys_are_back() {
    // Given session 1 waited while the user was in a picker, and it is
    // still active.
    let active = Some(SessionId(1));

    // When deciding what to do once the keys are back in the sidebar.
    let decision = started_attach(active, active, Focus::Sidebar, true);

    // Then orb opens it and leaves the keys there.
    assert_eq!(
        decision,
        StartedAttach::Attach { keep_keys: true },
        "a waited open should keep the keys where they came back to"
    );
}

#[rstest::rstest]
fn waited_ready_session_takes_the_keys_when_they_come_back_to_a_pane() {
    // Given session 1 waited while the user was in a picker, and it is
    // still active.
    let active = Some(SessionId(1));

    // When deciding what to do once the keys are back in a pane.
    let decision = started_attach(active, active, Focus::Pane, true);

    // Then orb opens it, taking the keys into its pane.
    assert_eq!(
        decision,
        StartedAttach::Attach { keep_keys: false },
        "a waited open coming back to a pane should take the keys"
    );
}

/// Shows `outcome` in `state` with an empty message box, now.
fn shown(outcome: Outcome, state: &mut AppState) {
    show(outcome, state, &mut Toasts::default(), Instant::now());
}

/// The search picker with "ab" typed, listing nothing yet.
fn search_typed_ab() -> AppState {
    let mut picker = PickerState::search(Focus::Sidebar);
    let _ = picker.insert('a');
    let _ = picker.insert('b');
    AppState {
        picker: Some(picker),
        ..AppState::default()
    }
}

/// A hit row in agent 1.
fn hit(id: i64) -> PickerItem {
    PickerItem::Hit {
        id,
        agent: AgentId(1),
        label: "orb/fix".to_owned(),
        split: 4,
        snippet: "the parser".to_owned(),
        lit: vec![],
        text_lit: vec![],
        path: PathBuf::from("/t/1.jsonl"),
        prompt_offset: 0,
    }
}

/// How many rows the open picker lists.
fn listed(state: &AppState) -> Option<usize> {
    state.picker.as_ref().map(|picker| picker.shown().count())
}

#[rstest::rstest]
fn stale_search_rows_are_dropped() {
    // Given the search picker with "ab" typed.
    let mut state = search_typed_ab();

    // When rows for the older query "a" arrive.
    shown(
        Outcome::Hits {
            query: "a".to_owned(),
            items: vec![hit(1)],
            overflow: false,
        },
        &mut state,
    );

    // Then the picker lists nothing.
    assert_eq!(
        listed(&state),
        Some(0),
        "rows for a query no longer typed shouldn't show"
    );
}

#[rstest::rstest]
fn current_search_rows_are_shown() {
    // Given the search picker with "ab" typed.
    let mut state = search_typed_ab();

    // When rows for "ab" arrive.
    shown(
        Outcome::Hits {
            query: "ab".to_owned(),
            items: vec![hit(1)],
            overflow: false,
        },
        &mut state,
    );

    // Then the picker lists them.
    assert_eq!(
        listed(&state),
        Some(1),
        "rows for the typed query should show"
    );
}

/// The search picker listing hits 1 and 2, with hit 1 selected.
fn search_listing_two_hits() -> AppState {
    let mut picker = PickerState::search(Focus::Sidebar);
    picker.show_hits("", vec![hit(1), hit(2)], false);
    AppState {
        picker: Some(picker),
        ..AppState::default()
    }
}

/// A one-message exchange.
fn exchange() -> Vec<(i64, Role, String)> {
    vec![(1, Role::User, "fix the parser".to_owned())]
}

/// The hit the open picker previews.
fn previewed(state: &AppState) -> Option<i64> {
    state
        .picker
        .as_ref()
        .and_then(PickerState::search_preview)
        .map(|preview| preview.hit)
}

#[rstest::rstest]
fn stale_search_preview_is_dropped() {
    // Given the search picker with hit 1 selected.
    let mut state = search_listing_two_hits();

    // When the preview of hit 2, selected earlier, arrives.
    shown(
        Outcome::HitPreview {
            hit: 2,
            messages: exchange(),
        },
        &mut state,
    );

    // Then nothing is previewed.
    assert_eq!(
        previewed(&state),
        None,
        "a preview for a row no longer selected shouldn't show"
    );
}

#[rstest::rstest]
fn current_search_preview_is_shown() {
    // Given the search picker with hit 1 selected.
    let mut state = search_listing_two_hits();

    // When the preview of hit 1 arrives.
    shown(
        Outcome::HitPreview {
            hit: 1,
            messages: exchange(),
        },
        &mut state,
    );

    // Then hit 1 is previewed.
    assert_eq!(
        previewed(&state),
        Some(1),
        "the selected row's preview should show"
    );
}

/// An unused, not yet read worktree at `path`.
fn worktree_at(path: &str) -> Worktree {
    Worktree {
        path: PathBuf::from(path),
        repo: None,
        facts: None,
        size_kb: None,
    }
}

#[rstest::rstest]
fn worktrees_changed_relists_the_open_worktree_picker() {
    // Given the worktree picker over two worktrees, "orb" typed and the
    // second row selected, then a third worktree listed.
    let mut state = AppState::default();
    state.worktrees.list = vec![worktree_at("/w/orb/a1"), worktree_at("/w/orb/b2")];
    state.picker = Some({
        let mut picker = PickerState::worktrees(worktree_items(&state), Focus::Sidebar);
        for ch in ['o', 'r', 'b'] {
            let _ = picker.insert(ch);
        }
        picker.next();
        picker
    });
    state.worktrees.list.push(worktree_at("/w/orb/c3"));

    // When the worktrees actor reports the new list.
    shown(Outcome::WorktreesChanged, &mut state);

    // Then the picker lists all three, keeping the typed text and the
    // selected worktree.
    let picker = state.picker.as_ref();
    assert_eq!(
        (
            picker.map(|picker| picker.shown().count()),
            picker.map(PickerState::input),
            picker.and_then(PickerState::selected_worktree),
        ),
        (Some(3), Some("orb"), Some(Path::new("/w/orb/b2"))),
        "a rescan should re-list the open worktree picker as the user left it"
    );
}

/// Project `id` titled `title`, with one agent last active `secs`
/// seconds after the epoch.
fn project_active_at(id: i64, title: &str, secs: u64) -> Project {
    Project {
        id: ProjectId(id),
        title: title.to_owned(),
        root: PathBuf::from(format!("/{title}")),
        created_at: UNIX_EPOCH,
        agents: vec![Agent {
            last_session: None,
            harness: HarnessId::new("claude"),
            id: AgentId(id),
            title: None,
            cwd: PathBuf::from(format!("/{title}")),
            transcript: None,
            status: AgentStatus::Idle,
            turn_started_at: None,
            pane: None,
            branch: None,
            created_at: UNIX_EPOCH,
            last_activity_at: UNIX_EPOCH + Duration::from_secs(secs),
            unseen: false,
            model: None,
        }],
        repo: true,
        removed: false,
        kind: ProjectKind::Normal,
    }
}

/// Alpha (active at 20 s) and beta (at 10 s), with `opened` handled.
fn alpha_and_beta_after(opened: &Intent) -> AppState {
    let mut state = AppState {
        sessions: Sessions {
            projects: vec![
                project_active_at(1, "alpha", 20),
                project_active_at(2, "beta", 10),
            ],
            ..Sessions::default()
        },
        ..AppState::default()
    };
    IntentHandler::handle(opened, &mut state);
    state
}

/// Beta's agent gets busier than alpha's.
fn make_beta_busier(state: &mut AppState) {
    if let Some(beta) = state.sessions.projects.get_mut(1) {
        for agent in &mut beta.agents {
            agent.last_activity_at = UNIX_EPOCH + Duration::from_secs(30);
        }
    }
}

/// The project titles the open picker lists, in order.
fn titles(state: &AppState) -> Vec<String> {
    state
        .picker
        .iter()
        .flat_map(PickerState::shown)
        .filter_map(|(item, _)| match item {
            PickerItem::Project { title, .. } => Some(title.clone()),
            _ => None,
        })
        .collect()
}

#[rstest::rstest]
fn any_report_resorts_the_open_projects_screen() {
    // Given the projects screen listing alpha then beta, and beta now
    // the busier.
    let mut state = alpha_and_beta_after(&Intent::OpenProjects);
    make_beta_busier(&mut state);

    // When a plain change is reported.
    shown(Outcome::Changed, &mut state);

    // Then beta is listed first.
    assert_eq!(
        titles(&state),
        vec!["beta".to_owned(), "alpha".to_owned()],
        "the projects screen should keep its recency order live"
    );
}

#[rstest::rstest]
fn report_leaves_projects_alone_when_the_screen_is_closed() {
    // Given the new-session project picker (not the projects screen)
    // listing alpha then beta, and beta now the busier.
    let mut state = alpha_and_beta_after(&Intent::NewSession);
    make_beta_busier(&mut state);

    // When a plain change is reported.
    shown(Outcome::Changed, &mut state);

    // Then the picker still lists alpha first.
    assert_eq!(
        titles(&state),
        vec!["alpha".to_owned(), "beta".to_owned()],
        "a report shouldn't re-list projects while the projects screen is closed"
    );
}

#[rstest::rstest]
fn to_drop_takes_an_exited_pane() {
    // Given pane 1 exited and pane 2 alive, both in a layout.
    let keep = HashSet::from([PaneId(1), PaneId(2)]);

    // When choosing the panes to drop.
    let dropped = to_drop([(PaneId(1), true), (PaneId(2), false)], &keep);

    // Then only the exited pane goes.
    assert_eq!(dropped, vec![PaneId(1)], "the exited pane is dropped");
}

#[rstest::rstest]
fn to_drop_takes_a_pane_in_no_layout() {
    // Given live pane 1 that no layout holds.
    let keep = HashSet::new();

    // When choosing the panes to drop.
    let dropped = to_drop([(PaneId(1), false)], &keep);

    // Then the pane goes.
    assert_eq!(dropped, vec![PaneId(1)], "a pane in no layout is dropped");
}

#[rstest::rstest]
fn to_drop_keeps_a_live_pane_in_a_layout() {
    // Given live pane 1 held by a layout.
    let keep = HashSet::from([PaneId(1)]);

    // When choosing the panes to drop.
    let dropped = to_drop([(PaneId(1), false)], &keep);

    // Then nothing goes.
    assert!(
        dropped.is_empty(),
        "a live pane in a layout stays, got {dropped:?}"
    );
}

#[rstest::rstest]
fn to_kill_takes_a_dropped_pane_no_layout_holds() {
    // Given pane 7 dropped while running, in no layout any more.
    let gone = [PaneId(7)];

    // When choosing the zmx sessions to kill.
    let killed = to_kill(&gone, &HashSet::new(), &HashSet::new());

    // Then its session is killed.
    assert_eq!(killed, vec![PaneId(7)], "a closed pane's program is killed");
}

#[rstest::rstest]
fn to_kill_leaves_a_dropped_pane_still_in_a_layout() {
    // Given pane 7 dropped by a detach, still in its session's layout.
    let gone = [PaneId(7)];

    // When choosing the zmx sessions to kill.
    let killed = to_kill(&gone, &HashSet::new(), &HashSet::from([PaneId(7)]));

    // Then its program keeps running.
    assert!(killed.is_empty(), "a laid-out pane outlives its detach");
}

#[rstest::rstest]
fn to_kill_leaves_a_pane_that_ended() {
    // Given pane 7 dropped because its program ended.
    let gone = [PaneId(7)];

    // When choosing the zmx sessions to kill.
    let killed = to_kill(&gone, &HashSet::from([PaneId(7)]), &HashSet::new());

    // Then nothing is killed.
    assert!(killed.is_empty(), "an ended pane has nothing to kill");
}

#[rstest::rstest]
fn to_spawn_takes_every_kept_pane_without_a_client() {
    // Given kept panes 7 and 8, pane 8 with a client.
    let keep = HashSet::from([PaneId(7), PaneId(8)]);
    let live: HashMap<PaneId, &str> = HashMap::from([(PaneId(8), "client")]);

    // When choosing the panes to start.
    let spawned = to_spawn(&keep, &live, &HashSet::new());

    // Then pane 7 gets a client.
    assert_eq!(
        spawned,
        vec![PaneId(7)],
        "a kept pane without a client starts"
    );
}

#[rstest::rstest]
fn broken_pane_is_not_reconnected() {
    // Given kept panes 7 and 8, neither with a client, pane 8 broken.
    let keep = HashSet::from([PaneId(7), PaneId(8)]);
    let live: HashMap<PaneId, &str> = HashMap::new();
    let broken = HashSet::from([PaneId(8)]);

    // When choosing the panes to start.
    let spawned = to_spawn(&keep, &live, &broken);

    // Then only pane 7 gets a client.
    assert_eq!(spawned, vec![PaneId(7)], "a broken pane gets no new client");
}

#[rstest::rstest]
fn broken_mark_clears_when_its_session_detaches() {
    // Given broken pane 7 whose session is no longer attached.
    let mut broken = HashSet::from([PaneId(7)]);

    // When clearing marks against the kept panes.
    clear_detached(&mut broken, &HashSet::new());

    // Then pane 7 is no longer marked broken.
    assert!(broken.is_empty(), "a detached session's broken mark clears");
}

#[rstest::rstest]
fn broken_pane_message_names_the_pane() {
    // Given a pane named claude.
    // When building the broken-pane message.
    let text = broken_pane_message("claude");

    // Then it names the pane and says it keeps running.
    assert_eq!(
        text, "stopped showing pane claude after an error; it keeps running",
        "the message names the broken pane"
    );
}

/// Pane `id` about to get a client, in `orb-p<id>` on `/zmx`, with
/// `resume` as its resume command.
fn spawning(id: i64, resume: Option<&str>) -> (PaneId, ZmxSession, Option<String>) {
    (
        PaneId(id),
        ZmxSession {
            name: format!("orb-p{id}"),
            dir: "/zmx".into(),
        },
        resume.map(str::to_owned),
    )
}

/// zmx listing `names` on `/zmx`.
fn zmx_lists(names: &[&str]) -> HashMap<PathBuf, Option<HashSet<String>>> {
    HashMap::from([(
        PathBuf::from("/zmx"),
        Some(names.iter().map(|name| (*name).to_owned()).collect()),
    )])
}

#[rstest::rstest]
fn resume_plan_types_a_panes_resume_when_zmx_no_longer_runs_it() {
    // Given pane 1 resuming aa, and zmx running nothing on its dir.
    let panes = [spawning(1, Some("claude --resume aa"))];

    // When planning what to type.
    let plan = resume_plan(&panes, &zmx_lists(&[]));

    // Then pane 1's fresh shell gets its resume command.
    assert_eq!(
        plan,
        HashMap::from([(PaneId(1), "claude --resume aa".to_owned())]),
        "a fresh shell resumes its pane's conversation"
    );
}

#[rstest::rstest]
fn resume_plan_types_nothing_into_a_running_session() {
    // Given pane 1 resuming aa, and zmx still running orb-p1.
    let panes = [spawning(1, Some("claude --resume aa"))];

    // When planning what to type.
    let plan = resume_plan(&panes, &zmx_lists(&["orb-p1"]));

    // Then nothing is typed.
    assert!(
        plan.is_empty(),
        "a running program must not get the command"
    );
}

#[rstest::rstest]
fn resume_plan_types_nothing_into_a_pane_without_a_resume_command() {
    // Given pane 1 with nothing to resume, and zmx running nothing.
    let panes = [spawning(1, None)];

    // When planning what to type.
    let plan = resume_plan(&panes, &zmx_lists(&[]));

    // Then nothing is typed.
    assert!(plan.is_empty(), "a plain shell stays plain");
}

#[rstest::rstest]
fn resume_plan_types_nothing_where_zmx_couldnt_list() {
    // Given pane 1 resuming aa, and zmx failing to list its dir.
    let panes = [spawning(1, Some("claude --resume aa"))];
    let listed = HashMap::from([(PathBuf::from("/zmx"), None)]);

    // When planning what to type.
    let plan = resume_plan(&panes, &listed);

    // Then nothing is typed.
    assert!(plan.is_empty(), "an unknown session might be running");
}

#[rstest::rstest]
fn resume_plan_never_types_a_command_with_a_control_character() {
    // Given pane 1 whose resume command holds a newline.
    let panes = [spawning(1, Some("claude --resume aa\nrm -rf ~"))];

    // When planning what to type.
    let plan = resume_plan(&panes, &zmx_lists(&[]));

    // Then nothing is typed.
    assert!(
        plan.is_empty(),
        "a control character could run a second command"
    );
}

/// Session 1 with pane 1 bringing back `resume`, and project alpha whose
/// agent runs in pane 1 when `agent_row`.
fn pane_1_with(agent_row: bool, resume: Option<&str>) -> AppState {
    let mut project = project_active_at(1, "alpha", 0);
    for agent in &mut project.agents {
        agent.pane = agent_row.then_some(PaneLaunch {
            pane: PaneId(1),
            session: SessionId(1),
        });
    }
    let mut layouts = Layouts::default();
    layouts.insert(
        SessionId(1),
        SessionLayout::of(PaneEntry {
            resume: resume.map(str::to_owned),
            ..entry(1)
        }),
    );
    AppState {
        sessions: Sessions {
            projects: vec![project],
            ..Sessions::default()
        },
        layouts,
        ..AppState::default()
    }
}

#[rstest::rstest]
#[case::plain_shell(false, None, false)]
#[case::agent_running(true, None, true)]
#[case::agent_to_bring_back(false, Some("pi --session-id aa"), true)]
fn pane_holds_an_agent_when_one_runs_or_comes_back_there(
    #[case] agent_row: bool,
    #[case] resume: Option<&str>,
    #[case] expected: bool,
) {
    // Given pane 1 with or without an agent row and a resume command.
    let state = pane_1_with(agent_row, resume);

    // When asking whether it holds an agent.
    let held = holds_agent(&state, PaneId(1));

    // Then it does exactly when an agent runs or comes back there.
    assert_eq!(held, expected, "pane 1 holds an agent");
}

/// Session 1's pane 1, in `orb-p1` on `/zmx`.
fn start_pane() -> [(SessionId, ZmxSession); 1] {
    [(
        SessionId(1),
        ZmxSession {
            name: "orb-p1".into(),
            dir: "/zmx".into(),
        },
    )]
}

#[rstest::rstest]
fn start_attaches_a_session_whose_panes_all_died() {
    // Given session 1's directory there and its pane no longer running.
    let panes = start_pane();

    // When choosing what to attach at start.
    let owners = attach_at_start(&panes, &HashSet::new(), &HashSet::from([SessionId(1)]));

    // Then session 1 is attached.
    assert_eq!(
        owners,
        HashSet::from([SessionId(1)]),
        "dead panes come back as fresh shells"
    );
}

#[rstest::rstest]
fn start_attaches_a_session_with_a_running_pane_whose_directory_is_gone() {
    // Given session 1's pane still running and its directory gone.
    let panes = start_pane();
    let running = HashSet::from([panes[0].1.clone()]);

    // When choosing what to attach at start.
    let owners = attach_at_start(&panes, &running, &HashSet::new());

    // Then session 1 is attached.
    assert_eq!(
        owners,
        HashSet::from([SessionId(1)]),
        "a running program shows again"
    );
}

#[rstest::rstest]
fn start_leaves_a_session_with_its_directory_gone_and_nothing_running() {
    // Given session 1's directory gone and nothing of it running.
    let panes = start_pane();

    // When choosing what to attach at start.
    let owners = attach_at_start(&panes, &HashSet::new(), &HashSet::new());

    // Then session 1 waits for ⏎.
    assert!(owners.is_empty(), "⏎ recreates its worktree first");
}

#[rstest::rstest]
fn stale_sessions_takes_old_agent_and_split_names() {
    // Given zmx listing phase-era names no pane owns.
    let listed = vec!["orb-p3".to_owned(), "orb-p-1".to_owned()];

    // When choosing what to kill.
    let stale = stale_sessions(listed, &HashSet::new(), false);

    // Then both are killed.
    assert_eq!(
        stale,
        vec!["orb-p3".to_owned(), "orb-p-1".to_owned()],
        "leftover agent and split sessions go"
    );
}

#[rstest::rstest]
fn stale_sessions_spares_a_pane_rows_session() {
    // Given zmx listing orb-p12, which pane 12 owns.
    let listed = vec!["orb-p12".to_owned()];

    // When choosing what to kill.
    let stale = stale_sessions(listed, &HashSet::from(["orb-p12".to_owned()]), false);

    // Then nothing is killed.
    assert!(stale.is_empty(), "a pane's own session stays");
}

#[rstest::rstest]
fn stale_sessions_kills_nothing_after_a_partial_load() {
    // Given zmx listing an orb-p* name no loaded pane owns, after saved
    // layouts orb couldn't all read.
    let listed = vec!["orb-p7".to_owned()];

    // When choosing what to kill.
    let stale = stale_sessions(listed, &HashSet::new(), true);

    // Then nothing is killed.
    assert!(stale.is_empty(), "a pane orb couldn't read may own it");
}

#[rstest::rstest]
fn stale_sessions_kills_nothing_when_zmx_lists_nothing() {
    // Given zmx listing nothing, as when its list fails at start.
    let listed = Vec::new();

    // When choosing what to kill.
    let stale = stale_sessions(listed, &HashSet::new(), false);

    // Then nothing is killed.
    assert!(stale.is_empty(), "a failed list kills nothing");
}

#[rstest::rstest]
fn stale_sessions_spares_names_without_the_orb_p_prefix() {
    // Given zmx listing a session orb didn't name.
    let listed = vec!["work".to_owned()];

    // When choosing what to kill.
    let stale = stale_sessions(listed, &HashSet::new(), false);

    // Then it is left alone.
    assert!(stale.is_empty(), "only orb-p* sessions are orb's");
}

#[rstest::rstest]
#[case::ended(Some(false), false, PaneExit::Ended)]
#[case::ended_after_a_respawn(Some(false), true, PaneExit::Ended)]
#[case::client_died(Some(true), false, PaneExit::Respawn)]
#[case::client_died_again(Some(true), true, PaneExit::Failed)]
#[case::zmx_unknown(None, false, PaneExit::Respawn)]
#[case::zmx_unknown_again(None, true, PaneExit::Failed)]
fn pane_exit_is_classified_by_zmx_listing_and_an_earlier_respawn(
    #[case] listed: Option<bool>,
    #[case] respawned: bool,
    #[case] expected: PaneExit,
) {
    // Given / When a pane of a shown session's client exits, zmx
    // `listed` its session or not, and the pane was `respawned` once or
    // not.
    let exit = classify_exit(listed, respawned, true);

    // Then the exit is `expected`.
    assert_eq!(exit, expected, "listed {listed:?}, respawned {respawned}");
}

#[rstest::rstest]
#[case::ended(Some(false), false)]
#[case::ended_after_a_respawn(Some(false), true)]
#[case::client_died(Some(true), false)]
#[case::client_died_again(Some(true), true)]
#[case::zmx_unknown(None, false)]
#[case::zmx_unknown_again(None, true)]
fn pane_exit_of_a_session_not_shown_is_dropped(
    #[case] listed: Option<bool>,
    #[case] respawned: bool,
) {
    // Given / When a pane of a session that isn't shown has its client
    // exit, zmx `listed` its session or not, and the pane was
    // `respawned` once or not.
    let exit = classify_exit(listed, respawned, false);

    // Then only its client is dropped.
    assert_eq!(
        exit,
        PaneExit::Drop,
        "listed {listed:?}, respawned {respawned}"
    );
}

#[rstest::rstest]
fn early_exit_names_the_session() {
    // Given no pane error.
    let error = None;

    // When one of the dropped panes, of session `orb-tui`, exited early.
    let error = pane_error_after(error, [(false, None), (true, Some("orb-tui".to_owned()))]);

    // Then the start screen names the session that exited at start.
    assert_eq!(
        error.as_deref(),
        Some("session orb-tui exited at start"),
        "an early exit names its session"
    );
}

#[rstest::rstest]
fn early_exit_of_an_untitled_session_says_session_exited_at_start() {
    // Given no pane error.
    let error = None;

    // When a dropped pane with no session title exited early.
    let error = pane_error_after(error, [(true, None)]);

    // Then the start screen says the session exited at start.
    assert_eq!(
        error.as_deref(),
        Some("session exited at start"),
        "an untitled early exit keeps the plain text"
    );
}

#[rstest::rstest]
fn later_exit_keeps_the_pane_error() {
    // Given an existing pane error.
    let error = Some("couldn't start the attach command".to_owned());

    // When the only dropped pane exited later.
    let error = pane_error_after(error, [(false, None)]);

    // Then the pane error is unchanged.
    assert_eq!(
        error.as_deref(),
        Some("couldn't start the attach command"),
        "a later exit leaves the pane error as is"
    );
}

#[rstest::rstest]
fn attach_spawns_in_an_existing_worktree() -> io::Result<()> {
    // Given an orb worktree that is on disk.
    let root = tempfile::tempdir()?;
    let cwd = root.path().join("orb/orb-1a2b3c4d");
    fs::create_dir_all(&cwd)?;

    // When deciding how to attach to it.
    let plan = attach_or_restore(&cwd, root.path());

    // Then its panes start in it.
    assert_eq!(plan, AttachPlan::Spawn, "an existing worktree spawns");
    Ok(())
}

#[rstest::rstest]
fn attach_restores_a_missing_orb_worktree() -> io::Result<()> {
    // Given an orb worktree whose directory is gone.
    let root = tempfile::tempdir()?;
    let cwd = root.path().join("orb/orb-1a2b3c4d");

    // When deciding how to attach to it.
    let plan = attach_or_restore(&cwd, root.path());

    // Then the sessions actor recreates it.
    assert_eq!(plan, AttachPlan::Restore, "a missing orb worktree restores");
    Ok(())
}

#[rstest::rstest]
fn attach_spawns_for_a_missing_directory_outside_orbs_worktrees() -> io::Result<()> {
    // Given a missing directory outside orb's worktrees root.
    let root = tempfile::tempdir()?;
    let other = tempfile::tempdir()?;
    let cwd = other.path().join("gone");

    // When deciding how to attach to it.
    let plan = attach_or_restore(&cwd, root.path());

    // Then its panes start as they always have.
    assert_eq!(
        plan,
        AttachPlan::Spawn,
        "a directory orb didn't make spawns"
    );
    Ok(())
}

#[rstest::rstest]
fn mouse_intents_end_the_pane_mode() {
    // Given move mode on in a pane.
    let state = State::new(AppState {
        focus: Focus::Pane,
        pane_mode: Some(PaneMode::Move),
        ..AppState::default()
    });

    // When a click runs its intents.
    handle_mouse_intents(&state, &[Intent::GoToTab(1)], |_| {});

    // Then no mode is on.
    assert_eq!(state.read().pane_mode(), None, "a click ends the mode");
}

/// An `App` over fakes, for loop tests: its actors run on their own
/// runtime over an in-memory store and a state of their own, reporting
/// on the loop's channel; panes attach with the given command in a temp
/// dir; zmx is `zmx`.
struct LoopTest {
    app: App,
    state: State,
    zmx: Arc<FakeZmx>,
    rx: Receiver<LoopEvent>,
    /// The panes' cwd, the sessions' dir and the actors' roots.
    dir: TempDir,
    /// Dropped after the app.
    runtime: Runtime,
}

fn loop_app(zmx: FakeZmx, attach: fn(&ZmxSession) -> Vec<OsString>) -> io::Result<LoopTest> {
    let dir = tempfile::tempdir()?;
    let runtime = Runtime::new()?;
    let store = Store::open_in_memory().map_err(|report| io::Error::other(report.to_string()))?;
    let git = GitService::new(Arc::new(NoGit), Log::default());
    let (tx, rx) = mpsc::channel();
    let (sessions, worktrees, search) = {
        let _context = runtime.enter();
        let report = {
            let tx = tx.clone();
            Reporter::new(move |outcome| {
                let _ = tx.send(LoopEvent::Reported(outcome));
            })
        };
        let sessions = spawn_sessions_actor(SessionsActorDeps {
            services: Services {
                harnesses: Harnesses::new(vec![]),
                git: git.clone(),
                zmx: ZmxService::new(
                    Arc::new(FakeZmx::listing("")),
                    dir.path().join("zmx"),
                    Log::default(),
                ),
                log: Log::default(),
            },
            state: State::default(),
            store,
            worktrees_root: dir.path().join("worktrees"),
            orb_root: dir.path().join("orb"),
            incognito_root: dir.path().join("incognito"),
            report: report.clone(),
            integration_missing: false,
        });
        let worktrees = spawn_worktrees_actor(WorktreesActorDeps {
            git: git.clone(),
            state: State::default(),
            worktrees_root: dir.path().join("worktrees"),
            report: report.clone(),
            sweep_every: Duration::from_secs(3600),
        });
        let search = spawn_search_actor(SearchActorDeps {
            state: State::default(),
            harnesses: Harnesses::new(vec![]),
            index_path: dir.path().join("search.sqlite"),
            report,
            log: Log::default(),
        });
        (sessions, worktrees, search)
    };
    runtime.block_on(sessions.wait_for_startup());
    let zmx = Arc::new(zmx);
    let state = State::default();
    let mut app = App::new(
        state.clone(),
        sessions,
        worktrees,
        dir.path().join("worktrees"),
        search,
        git,
        Harnesses::new(vec![]),
        Vec::new(),
        ZmxService::new(zmx.clone(), dir.path().join("zmx"), Log::default()),
        attach,
        NotifierService::new(Arc::new(NoneNotifier)),
        SoundService::silent(),
        Log::default(),
        tx,
        TimeZone::UTC,
        OuterTerminal::default(),
    );
    app.measure(Rect::new(0, 0, 120, 40), CellSize::default());
    Ok(LoopTest {
        app,
        state,
        zmx,
        rx,
        dir,
        runtime,
    })
}

/// A client that exits at once.
fn exits_at_once(_: &ZmxSession) -> Vec<OsString> {
    ["/bin/sh", "-c", "exit 0"].map(OsString::from).to_vec()
}

/// A client that keeps running.
fn keeps_running(_: &ZmxSession) -> Vec<OsString> {
    ["/bin/sh", "-c", "/bin/sleep 30"]
        .map(OsString::from)
        .to_vec()
}

/// How many clients [`counted_exit_at_once`] started.
static COUNTED_ATTACHES: AtomicUsize = AtomicUsize::new(0);

/// A client that exits at once, counted in [`COUNTED_ATTACHES`].
fn counted_exit_at_once(session: &ZmxSession) -> Vec<OsString> {
    COUNTED_ATTACHES.fetch_add(1, Ordering::SeqCst);
    exits_at_once(session)
}

impl LoopTest {
    /// Pane `id` in the test's dir, attaching to its own zmx session.
    fn entry(&self, id: PaneId) -> PaneEntry {
        PaneEntry {
            id,
            zmx: ZmxSession {
                name: id.zmx_name(),
                dir: "/zmx".into(),
            },
            cwd: self.dir.path().to_owned(),
            name: None,
            resume: None,
        }
    }

    /// Attached session 1 in the test's dir, holding `panes` side by
    /// side; each gets its client.
    fn attach(&mut self, panes: &[PaneId]) {
        {
            let mut state = self.state.write();
            state.sessions.sessions = vec![Session {
                id: session_id(1),
                dir: self.dir.path().to_owned(),
                ..session(1, false)
            }];
            for (at, id) in panes.iter().enumerate() {
                let entry = self.entry(*id);
                match at {
                    0 => state
                        .layouts
                        .insert(session_id(1), SessionLayout::of(entry)),
                    _ => state.layouts.split(session_id(1), Split::Right, entry),
                }
            }
            state.attached.insert(session_id(1));
        }
        self.app.reconcile();
    }

    /// Handles the loop's events, for up to five seconds, until it has
    /// handled pane `id`'s output; whether it did.
    fn handle_until_output(&mut self, id: PaneId) -> io::Result<bool> {
        let deadline = Instant::now() + Duration::from_secs(5);
        while let Ok(event) = self
            .rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            let output = matches!(event, LoopEvent::Pane(pane, PaneEvent::Output) if pane == id);
            self.app.handle(event, &mut io::sink())?;
            if output {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Waits up to five seconds for pane `id`'s client to exit.
    fn exit_of(&self, id: PaneId) -> Option<LoopEvent> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match self
                .rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(LoopEvent::Pane(pane, PaneEvent::Exited)) if pane == id => {
                    return Some(LoopEvent::Pane(pane, PaneEvent::Exited));
                }
                Ok(_) => {}
                Err(_) => return None,
            }
        }
    }
}

#[rstest::rstest]
fn entering_a_gone_worktree_while_a_start_runs_asks_for_no_restore() -> io::Result<()> {
    // Given a session start in flight, and session 1 whose orb worktree
    // is gone.
    let mut test = loop_app(FakeZmx::listing(""), exits_at_once)?;
    {
        let mut state = test.state.write();
        state.sessions.starting = true;
        state.sessions.sessions = vec![Session {
            id: session_id(1),
            dir: test.dir.path().join("worktrees/orb/orb-1a2b3c4d"),
            ..session(1, false)
        }];
    }

    // When the loop attaches session 1, as `⏎` on its row asks, and the
    // sessions worker has handled what it was sent.
    test.app.execute(&Command::Attach(session_id(1)));
    let sessions = test.app.sessions.clone();
    test.runtime
        .block_on(async move { sessions.ask(SessionsCommand::SaveUi).await })
        .map_err(|error| io::Error::other(format!("{error:?}")))?;

    // Then the worker reports no failure: no second restore ran.
    let failures: Vec<String> = test
        .rx
        .try_iter()
        .filter_map(|event| match event {
            LoopEvent::Reported(Outcome::Failed(error)) => Some(error),
            _ => None,
        })
        .collect();
    assert_eq!(
        failures,
        Vec::<String>::new(),
        "a restore should wait for the start in flight"
    );
    Ok(())
}

#[rstest::rstest]
fn exited_client_with_unlistable_zmx_keeps_its_pane() -> io::Result<()> {
    // Given zmx that can't list, and pane 1 whose client exits at once.
    let mut test = loop_app(FakeZmx::failing("boom"), exits_at_once)?;
    test.attach(&[pane(1)]);

    // When its exit arrives and the loop goes round.
    let event = test
        .exit_of(pane(1))
        .ok_or_else(|| io::Error::other("pane 1's client didn't exit within 5 s"))?;
    test.app.handle(event, &mut io::sink())?;
    test.app.reconcile();

    // Then the pane is still in its layout.
    assert!(
        test.state.read().layouts.pane_ids().contains(&pane(1)),
        "an exit zmx can't explain keeps the pane"
    );
    Ok(())
}

#[rstest::rstest]
fn dead_pane_of_a_session_not_shown_is_not_attached_again() -> io::Result<()> {
    // Given zmx that can't list, pane 1 whose client exits at once, and
    // its session taken off the right side.
    let mut test = loop_app(FakeZmx::failing("boom"), counted_exit_at_once)?;
    test.attach(&[pane(1)]);
    test.state.write().attached.remove(&session_id(1));

    // When its exit arrives and the loop goes round.
    let event = test
        .exit_of(pane(1))
        .ok_or_else(|| io::Error::other("pane 1's client didn't exit within 5 s"))?;
    test.app.handle(event, &mut io::sink())?;
    test.app.reconcile();

    // Then no second client was started.
    assert_eq!(
        COUNTED_ATTACHES.load(Ordering::SeqCst),
        1,
        "a dead client of a session not shown is not attached again"
    );
    Ok(())
}

#[rstest::rstest]
fn pane_closed_in_its_layout_is_killed_once() -> io::Result<()> {
    // Given zmx listing nothing, and running panes 1 and 2.
    let mut test = loop_app(FakeZmx::listing(""), keeps_running)?;
    test.attach(&[pane(1), pane(2)]);

    // When pane 2 closes in its layout and the loop goes round twice.
    test.state.write().layouts.close_pane(pane(2));
    test.app.reconcile();
    test.app.reconcile();

    // Then its zmx session is killed once.
    assert_eq!(
        test.zmx.killed(),
        [pane(2).zmx_name()],
        "a closed pane's session is killed once"
    );
    Ok(())
}

#[rstest::rstest]
fn closed_broken_pane_is_killed() -> io::Result<()> {
    // Given running panes 1 and 2, and pane 2 stopped showing after an error.
    let mut test = loop_app(FakeZmx::listing(""), keeps_running)?;
    test.attach(&[pane(1), pane(2)]);
    test.app
        .handle(LoopEvent::Pane(pane(2), PaneEvent::Broken), &mut io::sink())?;

    // When pane 2 closes in its layout and the loop goes round.
    test.state.write().layouts.close_pane(pane(2));
    test.app.reconcile();

    // Then its zmx session is killed.
    assert_eq!(
        test.zmx.killed(),
        [pane(2).zmx_name()],
        "a closed broken pane's session is killed"
    );
    Ok(())
}

#[rstest::rstest]
fn a_quit_event_ends_the_loop() -> io::Result<()> {
    // Given a loop with nothing open.
    let mut test = loop_app(FakeZmx::listing(""), keeps_running)?;

    // When a quit event arrives, as a signal sends it.
    test.app.handle(LoopEvent::Quit, &mut io::sink())?;

    // Then the loop's quit flag is set, so it ends after its next draw.
    assert!(
        test.state.read().should_quit,
        "a quit event should end the loop"
    );
    Ok(())
}

#[rstest::rstest]
fn deadline_wakes_the_loop_for_a_pending_preview_read() -> io::Result<()> {
    // Given the session picker on agent 1, its preview just read, and
    // its transcript grown since.
    let mut test = loop_app(FakeZmx::listing(""), keeps_running)?;
    let transcript = test.dir.path().join("1.jsonl");
    fs::write(&transcript, "{}\n")?;
    {
        let mut state = test.state.write();
        let projects = vec![Project {
            id: ProjectId(1),
            title: "orb".to_owned(),
            root: PathBuf::from("/repo"),
            created_at: UNIX_EPOCH,
            agents: vec![Agent {
                last_session: None,
                harness: HarnessId::new("claude"),
                id: AgentId(1),
                title: None,
                cwd: "/tmp".into(),
                transcript: Some(transcript.clone()),
                status: AgentStatus::Idle,
                turn_started_at: None,
                pane: Some(PaneLaunch {
                    pane: PaneId(1),
                    session: SessionId(1),
                }),
                branch: None,
                created_at: UNIX_EPOCH,
                last_activity_at: UNIX_EPOCH,
                unseen: false,
                model: None,
            }],
            repo: true,
            removed: false,
            kind: ProjectKind::Normal,
        }];
        state.sessions = Sessions {
            sessions: sessions_for(&projects),
            projects,
            ..Sessions::default()
        };
        state.picker = Some(PickerState::sessions(
            session_items(
                &state.sessions,
                &layouts_for(&state.sessions.projects),
                SessionFilter::All,
                false,
                None,
            ),
            Focus::Sidebar,
        ));
    }
    test.app.load_preview(AgentId(1), &transcript);
    let read_at = Instant::now();
    fs::write(&transcript, "{}\n{}\n")?;

    // When asking when the loop must wake.
    let deadline = test.app.deadline();

    // Then it wakes within a second of the read, for the next one.
    assert!(
        deadline.is_some_and(|due| read_at < due && due <= read_at + PREVIEW_EVERY),
        "a pending preview read should wake the loop within a second, got {deadline:?}"
    );
    Ok(())
}

/// Up to two seconds for the log at `path` to hold `text`; what it holds.
fn log_holding(path: &Path, text: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let content = fs::read_to_string(path).unwrap_or_default();
        if content.contains(text) || Instant::now() >= deadline {
            return content;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[rstest::rstest]
fn a_command_for_a_stopped_actor_is_logged() -> io::Result<()> {
    // Given a loop whose search actor has stopped, and a log.
    let mut test = loop_app(FakeZmx::listing(""), exits_at_once)?;
    let path = test.dir.path().join("orb.log");
    test.app.log = Log::new(path.clone());
    let search = test.app.search.clone();
    test.runtime.block_on(async move {
        let _ = search.stop_gracefully().await;
        search.wait_for_shutdown().await;
    });

    // When the loop sends it a search.
    test.app.execute(&Command::Search(
        orb_domain::SearchCommand::SearchTranscripts { query: "x".into() },
    ));

    // Then the log says which command couldn't be sent, and to which actor.
    let content = fs::read_to_string(&path)?;
    assert!(
        content.contains("couldn't send SearchTranscripts to the search actor"),
        "the lost command should be logged, got {content:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn a_lost_search_does_not_log_its_text() -> io::Result<()> {
    // Given a loop whose search actor has stopped, and a log.
    let mut test = loop_app(FakeZmx::listing(""), exits_at_once)?;
    let path = test.dir.path().join("orb.log");
    test.app.log = Log::new(path.clone());
    let search = test.app.search.clone();
    test.runtime.block_on(async move {
        let _ = search.stop_gracefully().await;
        search.wait_for_shutdown().await;
    });

    // When the loop sends it a search for some private words.
    test.app.execute(&Command::Search(
        orb_domain::SearchCommand::SearchTranscripts {
            query: "private words".into(),
        },
    ));

    // Then the log line leaves the searched text out.
    let content = fs::read_to_string(&path)?;
    assert!(
        !content.is_empty() && !content.contains("private words"),
        "the lost search should be logged without its text, got {content:?}"
    );
    Ok(())
}

/// A harness whose transcripts can't be read.
struct UnreadableHarness;

impl orb_domain::feat::harness::TranscriptFormat for UnreadableHarness {
    fn locate(&self, _: &Path, _: &str) -> Option<PathBuf> {
        None
    }
    fn scan(
        &self,
        _: &Path,
        _: u64,
        _: &orb_domain::feat::harness::Scan,
    ) -> io::Result<orb_domain::feat::harness::Scan> {
        Err(io::Error::other("unreadable"))
    }
    fn exchanges(
        &self,
        _: &Path,
    ) -> io::Result<(u64, Vec<orb_domain::feat::sessions::transcript::Exchange>)> {
        Err(io::Error::other("unreadable"))
    }
    fn messages(
        &self,
        _: &Path,
        _: u64,
        _: u64,
    ) -> io::Result<orb_domain::feat::sessions::transcript::MessageRead> {
        Err(io::Error::other("unreadable"))
    }
}

impl orb_domain::feat::harness::Harness for UnreadableHarness {
    fn name(&self) -> &'static str {
        "unreadable"
    }
    fn id(&self) -> HarnessId {
        HarnessId::new("claude")
    }
    fn label(&self) -> &'static str {
        "claude"
    }
    fn info(&self) -> orb_domain::feat::harness::HarnessInfo {
        orb_domain::feat::harness::HarnessInfo {
            id: self.id(),
            label: "claude".to_owned(),
            icon: None,
        }
    }
    fn resume_command(&self, session_id: &str) -> String {
        format!("claude --resume {session_id}")
    }
}

#[rstest::rstest]
fn an_unreadable_preview_is_logged() -> io::Result<()> {
    // Given agent 1 of a harness that can't read its transcript, and a log.
    let mut test = loop_app(FakeZmx::listing(""), exits_at_once)?;
    let path = test.dir.path().join("orb.log");
    test.app.log = Log::new(path.clone());
    test.app.harnesses = Harnesses::new(vec![Arc::new(UnreadableHarness)]);
    let transcript = test.dir.path().join("1.jsonl");
    test.state.write().sessions.projects = vec![Project {
        id: ProjectId(1),
        title: "orb".to_owned(),
        root: PathBuf::from("/repo"),
        created_at: UNIX_EPOCH,
        agents: vec![Agent {
            last_session: None,
            harness: HarnessId::new("claude"),
            id: AgentId(1),
            title: None,
            cwd: "/tmp".into(),
            transcript: Some(transcript.clone()),
            status: AgentStatus::Idle,
            turn_started_at: None,
            pane: None,
            branch: None,
            created_at: UNIX_EPOCH,
            last_activity_at: UNIX_EPOCH,
            unseen: false,
            model: None,
        }],
        repo: true,
        removed: false,
        kind: ProjectKind::Normal,
    }];

    // When the loop loads its preview.
    test.app.execute(&Command::LoadPreview {
        agent: AgentId(1),
        transcript,
    });

    // Then the log says the agent's transcript couldn't be read, and why.
    let content = fs::read_to_string(&path)?;
    assert!(
        content.contains("couldn't read agent 1's transcript") && content.contains("unreadable"),
        "the failed preview read should be logged, got {content:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn unreadable_previews_of_two_agents_are_each_logged_once() -> io::Result<()> {
    // Given agents 1 and 2 of a harness that can't read their transcripts,
    // and a log.
    let mut test = loop_app(FakeZmx::listing(""), exits_at_once)?;
    let path = test.dir.path().join("orb.log");
    test.app.log = Log::new(path.clone());
    test.app.harnesses = Harnesses::new(vec![Arc::new(UnreadableHarness)]);
    let transcript = test.dir.path().join("1.jsonl");
    let agent = Agent {
        last_session: None,
        harness: HarnessId::new("claude"),
        id: AgentId(1),
        title: None,
        cwd: "/tmp".into(),
        transcript: Some(transcript.clone()),
        status: AgentStatus::Idle,
        turn_started_at: None,
        pane: None,
        branch: None,
        created_at: UNIX_EPOCH,
        last_activity_at: UNIX_EPOCH,
        unseen: false,
        model: None,
    };
    test.state.write().sessions.projects = vec![Project {
        id: ProjectId(1),
        title: "orb".to_owned(),
        root: PathBuf::from("/repo"),
        created_at: UNIX_EPOCH,
        agents: vec![
            Agent {
                id: AgentId(2),
                ..agent.clone()
            },
            agent,
        ],
        repo: true,
        removed: false,
        kind: ProjectKind::Normal,
    }];

    // When the loop loads the two previews in turn, twice.
    for id in [1, 2, 1, 2] {
        test.app.execute(&Command::LoadPreview {
            agent: AgentId(id),
            transcript: transcript.clone(),
        });
    }

    // Then each agent's failure is logged once.
    let content = fs::read_to_string(&path)?;
    assert_eq!(
        content.matches("couldn't read agent").count(),
        2,
        "each agent's failed preview read should be logged once, got {content:?}"
    );
    Ok(())
}

/// A desktop whose notifications always fail.
struct FailingNotifier;

impl orb_domain::feat::notify::notifier::Notifier for FailingNotifier {
    fn name(&self) -> &'static str {
        "failing"
    }
    fn notify(
        &self,
        _: &str,
        _: &str,
        _: orb_domain::feat::notify::notifier::Urgency,
        _: AgentId,
    ) -> Result<(), error_stack::Report<orb_domain::feat::notify::notifier::NotifyError>> {
        Err(
            error_stack::Report::new(orb_domain::feat::notify::notifier::NotifyError)
                .attach("no notification server"),
        )
    }
}

#[rstest::rstest]
fn a_failed_desktop_notification_is_logged() -> io::Result<()> {
    // Given an unfocused orb whose desktop notifications fail, and a log.
    let mut test = loop_app(FakeZmx::listing(""), exits_at_once)?;
    let path = test.dir.path().join("orb.log");
    test.app.log = Log::new(path.clone());
    test.app.notifier = NotifierService::new(Arc::new(FailingNotifier));
    test.app.focused = false;

    // When a status change is announced.
    test.app.apply(Outcome::Announce(
        orb_domain::feat::sessions::state::Notice {
            agent: AgentId(1),
            kind: orb_domain::feat::sessions::state::NoticeKind::Finished,
            project: "orb".to_owned(),
            title: "Fix it".to_owned(),
        },
    ));

    // Then the log says the notification couldn't be sent.
    let content = log_holding(&path, "couldn't send a desktop notification");
    assert!(
        content.contains("couldn't send a desktop notification"),
        "the failed notification should be logged, got {content:?}"
    );
    Ok(())
}

/// A player that sends each file it plays down a channel.
struct RecordingPlayer(mpsc::Sender<PathBuf>);

impl SoundPlayer for RecordingPlayer {
    fn name(&self) -> &'static str {
        "recording"
    }

    fn play(&self, file: &Path) -> Result<(), error_stack::Report<SoundError>> {
        let _ = self.0.send(file.to_owned());
        Ok(())
    }
}

/// A player that never plays.
struct FailingPlayer;

impl SoundPlayer for FailingPlayer {
    fn name(&self) -> &'static str {
        "failing"
    }

    fn play(&self, _: &Path) -> Result<(), error_stack::Report<SoundError>> {
        Err(error_stack::Report::new(SoundError).attach("no audio player"))
    }
}

/// Gives `test` a recording player of `done.mp3` and `request.mp3`, and
/// the files it plays.
fn recording_sounds(test: &mut LoopTest) -> mpsc::Receiver<PathBuf> {
    let (tx, played) = mpsc::channel();
    test.app.sounds = SoundService::new(
        Arc::new(RecordingPlayer(tx)),
        PathBuf::from("done.mp3"),
        PathBuf::from("request.mp3"),
    );
    played
}

/// Agent 1 running in pane 1 of shown session 1: in the shown tab when
/// `in_shown_tab`, else in a tab behind the shown one.
fn watching_agent(test: &LoopTest, in_shown_tab: bool) {
    let mut state = test.state.write();
    let projects = vec![Project {
        id: ProjectId(1),
        title: "orb".to_owned(),
        root: PathBuf::from("/repo"),
        created_at: UNIX_EPOCH,
        agents: vec![Agent {
            last_session: None,
            harness: HarnessId::new("claude"),
            id: AgentId(1),
            title: None,
            cwd: "/tmp".into(),
            transcript: None,
            status: AgentStatus::Idle,
            turn_started_at: None,
            pane: Some(PaneLaunch {
                pane: PaneId(1),
                session: SessionId(1),
            }),
            branch: None,
            created_at: UNIX_EPOCH,
            last_activity_at: UNIX_EPOCH,
            unseen: false,
            model: None,
        }],
        repo: true,
        removed: false,
        kind: ProjectKind::Normal,
    }];
    state.sessions = Sessions {
        sessions: sessions_for(&projects),
        projects,
        ..Sessions::default()
    };
    state
        .layouts
        .insert(SessionId(1), SessionLayout::of(entry(1)));
    if !in_shown_tab {
        state.layouts.new_tab(SessionId(1), entry(2));
    }
    state.attached.insert(SessionId(1));
    state.sessions.enter(SessionId(1));
}

/// Agent 1's notice of `kind`.
fn notice_of(kind: orb_domain::feat::sessions::state::NoticeKind) -> Outcome {
    Outcome::Announce(orb_domain::feat::sessions::state::Notice {
        agent: AgentId(1),
        kind,
        project: "orb".to_owned(),
        title: "Fix it".to_owned(),
    })
}

#[rstest::rstest]
fn a_finished_turn_being_watched_plays_nothing() -> io::Result<()> {
    // Given a focused orb showing agent 1's pane.
    let mut test = loop_app(FakeZmx::listing(""), exits_at_once)?;
    let played = recording_sounds(&mut test);
    watching_agent(&test, true);

    // When agent 1 finishes a turn.
    test.app.apply(notice_of(
        orb_domain::feat::sessions::state::NoticeKind::Finished,
    ));

    // Then no sound plays.
    let sound = played.recv_timeout(Duration::from_millis(300)).ok();
    assert_eq!(sound, None, "a watched finish should be silent");
    Ok(())
}

#[rstest::rstest]
fn a_finished_turn_in_another_tab_plays_done() -> io::Result<()> {
    // Given a focused orb with agent 1's pane in a tab behind the shown one.
    let mut test = loop_app(FakeZmx::listing(""), exits_at_once)?;
    let played = recording_sounds(&mut test);
    watching_agent(&test, false);

    // When agent 1 finishes a turn.
    test.app.apply(notice_of(
        orb_domain::feat::sessions::state::NoticeKind::Finished,
    ));

    // Then the done sound plays.
    let sound = played.recv_timeout(Duration::from_secs(5)).ok();
    assert_eq!(
        sound,
        Some(PathBuf::from("done.mp3")),
        "a finish off screen plays done"
    );
    Ok(())
}

#[rstest::rstest]
fn an_approval_being_watched_plays_request() -> io::Result<()> {
    // Given a focused orb showing agent 1's pane.
    let mut test = loop_app(FakeZmx::listing(""), exits_at_once)?;
    let played = recording_sounds(&mut test);
    watching_agent(&test, true);

    // When agent 1 starts needing an approval.
    test.app.apply(notice_of(
        orb_domain::feat::sessions::state::NoticeKind::NeedsApproval,
    ));

    // Then the request sound plays.
    let sound = played.recv_timeout(Duration::from_secs(5)).ok();
    assert_eq!(
        sound,
        Some(PathBuf::from("request.mp3")),
        "a request always plays"
    );
    Ok(())
}

#[rstest::rstest]
fn a_sound_that_cant_play_is_logged() -> io::Result<()> {
    // Given an orb whose sounds can't play, and a log.
    let mut test = loop_app(FakeZmx::listing(""), exits_at_once)?;
    let path = test.dir.path().join("orb.log");
    test.app.log = Log::new(path.clone());
    test.app.sounds = SoundService::new(
        Arc::new(FailingPlayer),
        PathBuf::from("done.mp3"),
        PathBuf::from("request.mp3"),
    );

    // When agent 1 starts needing an approval.
    test.app.apply(notice_of(
        orb_domain::feat::sessions::state::NoticeKind::NeedsApproval,
    ));

    // Then the log says the sound couldn't play.
    let content = log_holding(&path, "couldn't play a sound");
    assert!(
        content.contains("couldn't play a sound"),
        "the failed sound should be logged, got {content:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn refused_change_answers_the_caller_and_not_the_message_box() -> io::Result<()> {
    // Given the loop, and an agent asking it to close pane 99, which no
    // session holds.
    let mut test = loop_app(FakeZmx::listing(""), exits_at_once)?;
    let (tx, rx) = mpsc::channel();
    let close = PaneRequest::Change(Change::ClosePane(PaneId(99)));

    // When the loop handles the request and ends its turn.
    test.app
        .handle(LoopEvent::Control(close, tx), &mut io::sink())?;
    test.app.take_error();

    // Then the agent hears not_found and the message box shows nothing.
    let answer = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(io::Error::other)?;
    assert_eq!(
        (
            answer.map_err(|error| error.code),
            test.app.toasts.shown(Instant::now()).is_none(),
        ),
        (Err(ErrorCode::NotFound), true),
        "a refusal goes back to the agent, not to the user"
    );
    Ok(())
}

#[rstest::rstest]
fn read_of_a_pane_added_this_turn_reaches_it() -> io::Result<()> {
    // Given attached session 1 whose pane 1 was just added, before the loop
    // gave it a client.
    let mut test = loop_app(FakeZmx::listing(""), keeps_running)?;
    {
        let entry = test.entry(PaneId(1));
        let mut state = test.state.write();
        state.sessions.sessions = vec![Session {
            id: session_id(1),
            dir: test.dir.path().to_owned(),
            ..session(1, false)
        }];
        state
            .layouts
            .insert(session_id(1), SessionLayout::of(entry));
        state.attached.insert(session_id(1));
    }
    let (tx, rx) = mpsc::channel();

    // When an agent reads pane 1 in the same turn.
    let read = PaneRequest::Read {
        pane: PaneId(1),
        lines: 0,
    };
    test.app
        .handle(LoopEvent::Control(read, tx), &mut io::sink())?;

    // Then the read reaches the pane instead of finding no live pane.
    let answer = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(io::Error::other)?;
    assert!(
        answer.is_ok(),
        "a pane added this turn should be reachable, got {answer:?}"
    );
    Ok(())
}

/// A client that prints `ready`, then writes what's typed into it to
/// `typed`.
fn prints_then_records(_: &ZmxSession) -> Vec<OsString> {
    ["/bin/sh", "-c", "printf ready; /bin/cat > typed"]
        .map(OsString::from)
        .to_vec()
}

/// A client that prints nothing of its own and writes what's typed into it
/// to `typed`.
fn records_silently(_: &ZmxSession) -> Vec<OsString> {
    ["/bin/sh", "-c", "/bin/cat > typed"]
        .map(OsString::from)
        .to_vec()
}

#[rstest::rstest]
fn agent_run_types_the_line_and_enter_into_the_pane() -> io::Result<()> {
    // Given attached pane 1 whose client has printed.
    let mut test = loop_app(FakeZmx::listing(""), prints_then_records)?;
    test.attach(&[PaneId(1)]);
    test.handle_until_output(PaneId(1))?;
    let (tx, _rx) = mpsc::channel();

    // When an agent runs `just test` in pane 1.
    let run = PaneRequest::Run {
        pane: PaneId(1),
        line: "just test".into(),
    };
    test.app
        .handle(LoopEvent::Control(run, tx), &mut io::sink())?;

    // Then the line and Enter reach the program in the pane.
    let typed = log_holding(&test.dir.path().join("typed"), "just test\n");
    assert_eq!(typed, "just test\n", "the line is typed and entered");
    Ok(())
}

#[rstest::rstest]
fn agent_run_into_a_silent_pane_waits_for_its_output() -> io::Result<()> {
    // Given attached pane 1 whose client hasn't printed anything.
    let mut test = loop_app(FakeZmx::listing(""), records_silently)?;
    test.attach(&[PaneId(1)]);
    let (tx, _rx) = mpsc::channel();

    // When an agent runs `late` in it, then pastes a line that makes it
    // print (the echo of `early`).
    let run = PaneRequest::Run {
        pane: PaneId(1),
        line: "late".into(),
    };
    let send = PaneRequest::Send {
        pane: PaneId(1),
        text: "early\n".into(),
    };
    test.app
        .handle(LoopEvent::Control(run, tx.clone()), &mut io::sink())?;
    test.app
        .handle(LoopEvent::Control(send, tx), &mut io::sink())?;
    test.handle_until_output(PaneId(1))?;

    // Then the run is typed only after that first output.
    let typed = log_holding(&test.dir.path().join("typed"), "late");
    assert_eq!(
        typed, "early\nlate\n",
        "a run into a silent pane waits for its first output"
    );
    Ok(())
}

#[rstest::rstest]
fn pane_io_without_a_client_is_not_found() -> io::Result<()> {
    // Given a loop with nothing attached.
    let mut test = loop_app(FakeZmx::listing(""), keeps_running)?;
    let (tx, rx) = mpsc::channel();

    // When an agent reads pane 7.
    let read = PaneRequest::Read {
        pane: PaneId(7),
        lines: 0,
    };
    test.app
        .handle(LoopEvent::Control(read, tx), &mut io::sink())?;

    // Then it is refused with not_found.
    let answer = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(io::Error::other)?;
    assert_eq!(
        answer.map_err(|error| error.code),
        Err(ErrorCode::NotFound),
        "a pane with no client has no live pane"
    );
    Ok(())
}

#[rstest::rstest]
fn agent_prompt_pastes_the_text_then_presses_enter() -> io::Result<()> {
    // Given attached pane 1 whose client has printed.
    let mut test = loop_app(FakeZmx::listing(""), prints_then_records)?;
    test.attach(&[PaneId(1)]);
    test.handle_until_output(PaneId(1))?;
    let (tx, _rx) = mpsc::channel();

    // When an agent prompts pane 1 with `hello`.
    let prompt = PaneRequest::Prompt {
        pane: PaneId(1),
        text: "hello".into(),
    };
    test.app
        .handle(LoopEvent::Control(prompt, tx), &mut io::sink())?;

    // Then the text and Enter reach the program in the pane.
    let typed = log_holding(&test.dir.path().join("typed"), "hello\n");
    assert_eq!(typed, "hello\n", "the prompt is pasted and entered");
    Ok(())
}

#[rstest::rstest]
fn agent_launch_into_a_pane_with_a_waiting_line_is_pane_busy() -> io::Result<()> {
    // Given attached pane 1, silent so far, with a run of `first` waiting to
    // be typed.
    let mut test = loop_app(FakeZmx::listing(""), records_silently)?;
    test.attach(&[PaneId(1)]);
    let run = PaneRequest::Run {
        pane: PaneId(1),
        line: "first".into(),
    };
    let (run_tx, _run_rx) = mpsc::channel();
    test.app
        .handle(LoopEvent::Control(run, run_tx), &mut io::sink())?;
    let (tx, rx) = mpsc::channel();

    // When an agent starts an agent in pane 1.
    let launch = PaneRequest::Launch {
        pane: PaneId(1),
        line: "claude".into(),
    };
    test.app
        .handle(LoopEvent::Control(launch, tx), &mut io::sink())?;

    // Then the start is refused as pane_busy.
    let answer = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(io::Error::other)?;
    assert_eq!(
        answer.map_err(|error| error.code),
        Err(ErrorCode::PaneBusy),
        "a pane with a line waiting can't start an agent"
    );
    Ok(())
}

/// A client that asks for kitty flags 3 (disambiguate, event types), then
/// writes the raw bytes typed into it to `typed`.
fn records_raw_with_event_types(_: &ZmxSession) -> Vec<OsString> {
    [
        "/bin/sh",
        "-c",
        "/bin/stty raw -echo; printf '\\033[>3u'; exec /bin/cat > typed",
    ]
    .map(OsString::from)
    .to_vec()
}

/// A loop with attached pane 1 running [`records_raw_with_event_types`],
/// its flags set, and the keys in it.
fn keys_in_a_raw_pane() -> io::Result<LoopTest> {
    let mut test = loop_app(FakeZmx::listing(""), records_raw_with_event_types)?;
    test.attach(&[PaneId(1)]);
    test.handle_until_output(PaneId(1))?;
    {
        let mut state = test.state.write();
        state.sessions.enter(session_id(1));
        state.focus = Focus::Pane;
    }
    Ok(test)
}

/// `code` with `modifiers` as the outer terminal reports its `kind`.
fn key_input(code: KeyCode, modifiers: KeyModifiers, kind: KeyEventKind) -> LoopEvent {
    LoopEvent::Input(Event::Key(KeyEvent::new_with_kind(code, modifiers, kind)))
}

#[rstest::rstest]
fn release_of_a_forwarded_key_reaches_its_pane() -> io::Result<()> {
    // Given the keys in a pane whose program asked for event types.
    let mut test = keys_in_a_raw_pane()?;

    // When Ctrl+x is pressed and released.
    for kind in [KeyEventKind::Press, KeyEventKind::Release] {
        test.app.handle(
            key_input(KeyCode::Char('x'), KeyModifiers::CONTROL, kind),
            &mut io::sink(),
        )?;
    }

    // Then the program gets the press and the release.
    let typed = log_holding(&test.dir.path().join("typed"), "\x1b[120;5:3u");
    assert_eq!(
        typed, "\x1b[120;5u\x1b[120;5:3u",
        "a forwarded key's release follows its press"
    );
    Ok(())
}

#[rstest::rstest]
fn release_of_a_key_orb_took_never_reaches_the_pane() -> io::Result<()> {
    // Given the keys in a pane whose program asked for event types.
    let mut test = keys_in_a_raw_pane()?;

    // When `<C-]>` (a jump, orb's own) is pressed and released, then `z`
    // is pressed.
    for kind in [KeyEventKind::Press, KeyEventKind::Release] {
        test.app.handle(
            key_input(KeyCode::Char(']'), KeyModifiers::CONTROL, kind),
            &mut io::sink(),
        )?;
    }
    test.app.handle(
        key_input(KeyCode::Char('z'), KeyModifiers::NONE, KeyEventKind::Press),
        &mut io::sink(),
    )?;

    // Then the program gets only `z`.
    let typed = log_holding(&test.dir.path().join("typed"), "z");
    assert_eq!(typed, "z", "the release of orb's key stays with orb");
    Ok(())
}

#[rstest::rstest]
fn release_in_the_sidebar_moves_nothing() -> io::Result<()> {
    // Given the sidebar's cursor on the first of two session cards.
    let mut test = loop_app(FakeZmx::listing(""), keeps_running)?;
    {
        let mut state = test.state.write();
        state.sessions.projects = vec![project_active_at(1, "alpha", 20)];
        state.sessions.sessions = vec![session(1, false), session(2, false)];
        state.sessions.cursor = Some(SidebarItem::Session(SessionId(2)));
        state.focus = Focus::Sidebar;
    }

    // When a release of `j` arrives.
    test.app.handle(
        key_input(
            KeyCode::Char('j'),
            KeyModifiers::NONE,
            KeyEventKind::Release,
        ),
        &mut io::sink(),
    )?;

    // Then the cursor stays where it was.
    assert_eq!(
        test.state.read().sessions.cursor,
        Some(SidebarItem::Session(SessionId(2))),
        "a release runs none of orb's keys"
    );
    Ok(())
}

/// Where [`pixel_mouse_pane`] has pane 1 drawn: right of a 30-column
/// sidebar, below the tab bar's line.
const PIXEL_PANE: Rect = Rect::new(30, 1, 90, 39);

/// A loop in kitty with 10 by 20 pixel cells and the keys in attached pane
/// 1, which runs `attach` and was drawn at [`PIXEL_PANE`], its program
/// reading the mouse or not.
fn pixel_mouse_pane(
    attach: fn(&ZmxSession) -> Vec<OsString>,
    reads_mouse: bool,
) -> io::Result<LoopTest> {
    let mut test = loop_app(FakeZmx::listing(""), attach)?;
    test.app.outer = OuterTerminal {
        graphics: GraphicsSupport::Kitty { transient: true },
        ..OuterTerminal::default()
    };
    test.app.measure(
        Rect::new(0, 0, 120, 40),
        CellSize {
            width: 10,
            height: 20,
        },
    );
    test.attach(&[PaneId(1)]);
    test.handle_until_output(PaneId(1))?;
    {
        let mut state = test.state.write();
        state.sessions.enter(session_id(1));
        state.focus = Focus::Pane;
    }
    test.app.hits = {
        let mut hits = HitMap::new(Rect::new(0, 0, 30, 40), Rect::new(30, 0, 90, 40));
        hits.record_pane(PIXEL_PANE, PaneId(1), reads_mouse);
        hits
    };
    Ok(test)
}

/// A mouse `kind` at kitty's pixel (`x`, `y`), as crossterm reads it: one
/// less on each coordinate.
fn pixel_mouse(kind: MouseEventKind, x: u16, y: u16) -> LoopEvent {
    LoopEvent::Input(Event::Mouse(MouseEvent {
        kind,
        column: x - 1,
        row: y - 1,
        modifiers: KeyModifiers::NONE,
    }))
}

/// A client that prints `hello world` and keeps running.
fn says_hello(_: &ZmxSession) -> Vec<OsString> {
    ["/bin/sh", "-c", "printf 'hello world'; exec /bin/sleep 30"]
        .map(OsString::from)
        .to_vec()
}

/// `hello` going to the clipboard.
const HELLO_COPIED: &str = "\x1b]52;c;aGVsbG8=\x07";

/// [`pixel_mouse_pane`] over [`says_hello`], with `hello` selected by a
/// press on the pane's first cell and a drag up onto the tab bar's line,
/// which left the window's top: kitty's release there can't be read.
fn hello_dragged_out_of_the_top(out: &mut Vec<u8>) -> io::Result<LoopTest> {
    let mut test = pixel_mouse_pane(says_hello, false)?;
    test.app.handle(
        pixel_mouse(MouseEventKind::Down(MouseButton::Left), 305, 25),
        out,
    )?;
    test.app.handle(
        pixel_mouse(MouseEventKind::Drag(MouseButton::Left), 355, 5),
        out,
    )?;
    Ok(test)
}

#[rstest::rstest]
fn selection_whose_release_was_lost_is_copied_once_the_mouse_moves() -> io::Result<()> {
    // Given `hello` selected by a drag out of the window's top.
    let mut out = Vec::new();
    let mut test = hello_dragged_out_of_the_top(&mut out)?;

    // When the mouse moves back in with no button held.
    test.app
        .handle(pixel_mouse(MouseEventKind::Moved, 605, 405), &mut out)?;

    // Then `hello` goes to the clipboard.
    assert!(
        String::from_utf8_lossy(&out).contains(HELLO_COPIED),
        "a lost release should still copy the selection"
    );
    Ok(())
}

#[rstest::rstest]
fn selection_whose_release_was_lost_is_copied_once_orb_loses_focus() -> io::Result<()> {
    // Given `hello` selected by a drag out of the window's top.
    let mut out = Vec::new();
    let mut test = hello_dragged_out_of_the_top(&mut out)?;

    // When another window takes the focus.
    test.app
        .handle(LoopEvent::Input(Event::FocusLost), &mut out)?;

    // Then `hello` goes to the clipboard.
    assert!(
        String::from_utf8_lossy(&out).contains(HELLO_COPIED),
        "a lost release should copy the selection before the focus leaves"
    );
    Ok(())
}

#[rstest::rstest]
fn selection_released_in_the_window_is_copied_once() -> io::Result<()> {
    // Given `hello` selected by a drag within the pane and released there.
    let mut out = Vec::new();
    let mut test = pixel_mouse_pane(says_hello, false)?;
    for (kind, x) in [
        (MouseEventKind::Down(MouseButton::Left), 305),
        (MouseEventKind::Drag(MouseButton::Left), 355),
        (MouseEventKind::Up(MouseButton::Left), 355),
    ] {
        test.app.handle(pixel_mouse(kind, x, 25), &mut out)?;
    }

    // When the mouse then moves with no button held.
    test.app
        .handle(pixel_mouse(MouseEventKind::Moved, 605, 405), &mut out)?;

    // Then only the release copied it.
    assert_eq!(
        String::from_utf8_lossy(&out).matches("\x1b]52;").count(),
        1,
        "a drag ends once"
    );
    Ok(())
}

/// A client that asks for mouse clicks in SGR cells, then writes the raw
/// bytes it gets to `typed`.
fn records_clicks(_: &ZmxSession) -> Vec<OsString> {
    [
        "/bin/sh",
        "-c",
        "/bin/stty raw -echo; printf '\\033[?1000h\\033[?1006h'; exec /bin/cat > typed",
    ]
    .map(OsString::from)
    .to_vec()
}

#[rstest::rstest]
fn program_gets_a_release_lost_above_the_window_on_its_top_line() -> io::Result<()> {
    // Given a press on a mouse-reading program at its cell (5, 1), dragged
    // up onto the tab bar's line and out of the window's top.
    let mut test = pixel_mouse_pane(records_clicks, true)?;
    test.app.handle(
        pixel_mouse(MouseEventKind::Down(MouseButton::Left), 355, 45),
        &mut io::sink(),
    )?;
    test.app.handle(
        pixel_mouse(MouseEventKind::Drag(MouseButton::Left), 355, 5),
        &mut io::sink(),
    )?;

    // When the mouse moves back in with no button held.
    test.app.handle(
        pixel_mouse(MouseEventKind::Moved, 605, 405),
        &mut io::sink(),
    )?;

    // Then the program gets its release, kept to its top line.
    let typed = log_holding(&test.dir.path().join("typed"), "\x1b[<0;6;1m");
    assert_eq!(
        typed, "\x1b[<0;6;2M\x1b[<0;6;1m",
        "a program that got the press gets its release"
    );
    Ok(())
}
