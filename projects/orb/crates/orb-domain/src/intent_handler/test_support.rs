//! Fixtures shared by the intent tests of several features.

use crate::feat::git::git_service::GitRef;
use crate::feat::harness::HarnessId;
use crate::feat::jumps::state::JumpList;
use crate::feat::layout::state::{Layouts, SessionLayout, Tab, test_entry};
use crate::feat::layout::tree::Split;
use crate::feat::picker::list::PickerItem;
use crate::feat::picker::state::PickerState;
use crate::feat::sessions::state::{
    Agent, AgentStatus, PaneLaunch, Project, ProjectKind, Search, SessionKind, Sessions,
    SidebarItem, sessions_for,
};
use crate::feat::sidebar::state::{Rename, RenameTarget, SidebarView};
use crate::feat::worktrees::state::{Worktree, Worktrees};
use crate::ids::{AgentId, PaneId, ProjectId, SessionId};
use crate::{AppState, Focus, Intent, IntentHandler, TextInput};
use ratatui::layout::Rect;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Claude's setting row for `value`.
/// `sessions` with the sessions its projects' agents run in.
pub(crate) fn fill(sessions: Sessions) -> Sessions {
    Sessions {
        sessions: sessions_for(&sessions.projects),
        ..sessions
    }
}

/// Agent `id`'s pane: pane `id` of session `id`.
pub(crate) fn launch(id: i64) -> PaneLaunch {
    PaneLaunch {
        pane: PaneId(id),
        session: SessionId(id),
    }
}

pub(crate) fn agent(id: i64, status: AgentStatus) -> Agent {
    Agent {
        last_session: None,
        harness: HarnessId::new("claude"),
        id: AgentId(id),
        title: None,
        cwd: format!("/work/{id}").into(),
        transcript: None,
        status,
        turn_started_at: None,
        pane: Some(launch(id)),
        branch: None,
        created_at: SystemTime::UNIX_EPOCH,
        last_activity_at: SystemTime::UNIX_EPOCH,
        unseen: false,
        model: None,
    }
}

pub(crate) fn at(secs: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(secs)
}

/// Agent `id`, stopped; [`settle`] settles its session.
pub(crate) fn stopped(id: i64) -> Agent {
    agent(id, AgentStatus::Stopped)
}

/// `state` with each session in `ids` settled at second `<id>`.
pub(crate) fn settle(mut state: AppState, ids: &[i64]) -> AppState {
    for session in &mut state.sessions.sessions {
        if ids.contains(&session.id.0) {
            session.settled_at = Some(at(session.id.0.unsigned_abs()));
        }
    }
    state
}

/// One project holding `agents`, with the sidebar's cursor on `cursor`.
/// Unsettled agents with equal times list the higher id first.
/// Each agent with a pane runs in session `<id>`, a tab of that one pane.
pub(crate) fn state_at(agents: Vec<Agent>, cursor: SidebarItem) -> AppState {
    let mut layouts = Layouts::default();
    for pane in agents.iter().filter_map(|agent| agent.pane.as_ref()) {
        layouts.insert(
            SessionId(pane.pane.0),
            SessionLayout::of(test_entry(pane.pane.0)),
        );
    }
    let projects = vec![Project {
        id: ProjectId(1),
        title: "work".into(),
        root: "/work".into(),
        created_at: SystemTime::UNIX_EPOCH,
        removed: false,
        repo: true,
        agents,
        kind: ProjectKind::Normal,
    }];
    AppState {
        layouts,
        sessions: Sessions {
            sessions: sessions_for(&projects),
            projects,
            cursor: Some(cursor),
            ..Sessions::default()
        },
        ..AppState::default()
    }
}

/// One project per title, ids from 1, rooted at `/<title>`, with no
/// agents, all added at the same time.
pub(crate) fn with_projects(titles: &[&str]) -> AppState {
    AppState {
        sessions: fill(Sessions {
            projects: (1..)
                .zip(titles)
                .map(|(id, title)| Project {
                    id: ProjectId(id),
                    title: (*title).to_owned(),
                    root: format!("/{title}").into(),
                    created_at: SystemTime::UNIX_EPOCH,
                    removed: false,
                    repo: true,
                    agents: vec![],
                    kind: ProjectKind::Normal,
                })
                .collect(),
            ..Sessions::default()
        }),
        ..AppState::default()
    }
}

/// One project holding `agents`, with agent `selected` selected.
pub(crate) fn state_with(agents: Vec<Agent>, selected: i64) -> AppState {
    state_at(agents, SidebarItem::Session(SessionId(selected)))
}

/// Sessions 1–3 with agents 1–3 (statuses `statuses`), the cursor on
/// session 1: 1 a colony, 2 its colonist, 3 a colonist of 2.
pub(crate) fn colony_with_colonists(statuses: [AgentStatus; 3]) -> AppState {
    let agents = (1..)
        .zip(statuses)
        .map(|(id, status)| agent(id, status))
        .collect();
    let mut state = state_with(agents, 1);
    for session in &mut state.sessions.sessions {
        match session.id.0 {
            1 => session.kind = SessionKind::Colony,
            id => session.parent = Some(SessionId(id - 1)),
        }
    }
    state
}

/// Agent `id`, idle and prompt-less, in the project's root `/work`.
pub(crate) fn in_root(id: i64) -> Agent {
    Agent {
        cwd: "/work".into(),
        ..agent(id, AgentStatus::Idle)
    }
}

/// The workspace picker opened on session 1 of `agents`.
pub(crate) fn choosing_workspace(agents: Vec<Agent>) -> AppState {
    let mut state = AppState {
        focus: Focus::Sidebar,
        ..state_with(agents, 1)
    };
    IntentHandler::handle(&Intent::ChangeWorkspace, &mut state);
    state
}

pub(crate) fn workspace_labels(state: &AppState) -> Vec<String> {
    state
        .picker
        .iter()
        .flat_map(PickerState::shown)
        .filter_map(|(item, _)| match item {
            PickerItem::Workspace(choice) => Some(choice.label()),
            _ => None,
        })
        .collect()
}

/// orb focused on `focus`, with the sidebar `width` columns wide and
/// `hidden` or not.
pub(crate) fn laid_out(focus: Focus, width: u16, hidden: bool) -> AppState {
    AppState {
        focus,
        sidebar: SidebarView {
            width,
            hidden,
            ..SidebarView::default()
        },
        ..AppState::default()
    }
}

/// Session 1 not attached, its agent row (pane 1, in tab 1) under the
/// cursor, while a second tab of pane 60 is shown.
pub(crate) fn on_agent_in_another_tab() -> AppState {
    let mut state = state_with(vec![agent(1, AgentStatus::Idle)], 1);
    state.layouts.new_tab(SessionId(1), test_entry(60));
    state.sessions.cursor = Some(SidebarItem::Agent {
        session: SessionId(1),
        pane: PaneId(1),
    });
    state
}

/// Keys going to agent 1's attached, active session.
pub(crate) fn attached() -> AppState {
    let mut state = AppState {
        focus: Focus::Pane,
        attached: HashSet::from([SessionId(1)]),
        ..state_with(vec![agent(1, AgentStatus::Idle)], 1)
    };
    state.sessions.enter(SessionId(1));
    state
}

/// Agents 1 and 2 in the sidebar with those in `attached` attached and
/// agent `selected` selected.
pub(crate) fn left_pane(attached: &[i64], selected: i64) -> AppState {
    AppState {
        focus: Focus::Sidebar,
        attached: attached.iter().copied().map(SessionId).collect(),
        ..state_with(
            vec![agent(1, AgentStatus::Idle), agent(2, AgentStatus::Idle)],
            selected,
        )
    }
}

/// Local branch `name`, checked out in `worktree` if any.
pub(crate) fn branch(name: &str, current: bool, worktree: Option<&str>) -> GitRef {
    GitRef {
        name: name.to_owned(),
        remote: false,
        current,
        default: false,
        worktree: worktree.map(PathBuf::from),
    }
}

/// The picker row for project `id` of [`with_projects`].
pub(crate) fn project_row(id: i64, title: &str) -> PickerItem {
    PickerItem::Project {
        id: ProjectId(id),
        title: title.to_owned(),
        root: format!("/{title}").into(),
        kind: ProjectKind::Normal,
    }
}

/// Projects alpha (1) and beta (2), holding idle agents 11 and 21 (21
/// listed first), the sidebar filtered to `filter`, cursor on `cursor`.
pub(crate) fn two_projects(filter: Option<i64>, cursor: SidebarItem) -> AppState {
    let mut state = with_projects(&["alpha", "beta"]);
    for (project, id) in state.sessions.projects.iter_mut().zip([11, 21]) {
        project.agents = vec![agent(id, AgentStatus::Idle)];
    }
    state.sessions.sessions = sessions_for(&state.sessions.projects);
    state.sessions.filter = filter.map(ProjectId);
    state.sessions.cursor = Some(cursor);
    state
}

/// [`two_projects`] with the projects screen opened from the sidebar.
pub(crate) fn managing(filter: Option<i64>, cursor: SidebarItem) -> AppState {
    let mut state = two_projects(filter, cursor);
    IntentHandler::handle(&Intent::OpenProjects, &mut state);
    state
}

/// Highlights `item` in the open picker.
pub(crate) fn highlight(state: &mut AppState, item: &PickerItem) {
    if let Some(picker) = &mut state.picker {
        picker.select(item);
    }
}

/// Handles `intent` to open its `No`/`Yes` confirm, then highlights `Yes`.
pub(crate) fn answer_yes(intent: &Intent, state: &mut AppState) {
    IntentHandler::handle(intent, state);
    highlight(state, &PickerItem::Confirm(true));
}

/// [`managing`], then `d` on alpha.
pub(crate) fn removing_alpha(filter: Option<i64>, cursor: SidebarItem) -> AppState {
    let mut state = managing(filter, cursor);
    highlight(&mut state, &project_row(1, "alpha"));
    IntentHandler::handle(&Intent::PickerRemove, &mut state);
    state
}

pub(crate) fn on_agent(id: i64) -> SidebarItem {
    SidebarItem::Session(SessionId(id))
}

/// The agent row of pane `pane` in session `session`.
pub(crate) fn agent_row(session: i64, pane: i64) -> SidebarItem {
    SidebarItem::Agent {
        session: SessionId(session),
        pane: PaneId(pane),
    }
}

/// Alpha (1) and orb's Incognito project (2), nothing selected.
pub(crate) fn incognito() -> AppState {
    let mut state = with_projects(&["alpha", "incognito"]);
    for project in state.sessions.projects.iter_mut().skip(1) {
        project.kind = ProjectKind::Incognito;
        project.repo = false;
    }
    state
}

/// Agent 1, titled `title`, selected in the sidebar.
pub(crate) fn titled(title: Option<&str>) -> AppState {
    state_with(
        vec![Agent {
            title: title.map(str::to_owned),
            ..agent(1, AgentStatus::Idle)
        }],
        1,
    )
}

/// Agent 1 selected, with the rename box open on it holding `text`.
pub(crate) fn renaming(text: &str) -> AppState {
    AppState {
        focus: Focus::Rename,
        rename: Some(Rename {
            target: RenameTarget::Session(SessionId(1)),
            input: TextInput::new(text),
            creating: false,
        }),
        ..titled(Some("Fix the sidebar"))
    }
}

/// The text in the open rename box, if it's open.
pub(crate) fn rename_text(state: &AppState) -> Option<&str> {
    state.rename.as_ref().map(|rename| rename.input.text())
}

/// "fix login bug" (1), "add dark mode" (2) and "fix logout" (3), listed
/// 3, 2, 1, with the cursor on agent 2.
pub(crate) fn three_titles() -> AppState {
    let agents = [
        (1, "fix login bug"),
        (2, "add dark mode"),
        (3, "fix logout"),
    ]
    .map(|(id, title)| Agent {
        title: Some(title.to_owned()),
        ..agent(id, AgentStatus::Idle)
    })
    .into();
    state_with(agents, 2)
}

/// `three_titles`, searching for `text` from agent 2, with the cursor
/// on `cursor`.
pub(crate) fn searching(text: &str, cursor: Option<i64>) -> AppState {
    let mut state = three_titles();
    state.focus = Focus::Search;
    state.sessions.search = Some(Search {
        input: TextInput::new(text),
        return_to: Some(SidebarItem::Session(SessionId(2))),
    });
    state.sessions.cursor = cursor.map(|id| SidebarItem::Session(SessionId(id)));
    state
}

/// Agents 1 and 2 (listed 2, 1) with the cursor on agent 2, the keys
/// in `focus`, the agents in `attached` attached, and `jumps` listed,
/// oldest first; agent 2's session is active when the keys are in a
/// pane.
pub(crate) fn jumping(focus: Focus, attached: &[i64], jumps: &[SidebarItem]) -> AppState {
    let mut state = AppState {
        focus,
        attached: attached.iter().copied().map(SessionId).collect(),
        jumps: JumpList::from_saved(jumps.to_vec()),
        ..state_with(
            vec![agent(1, AgentStatus::Idle), agent(2, AgentStatus::Idle)],
            2,
        )
    };
    if focus == Focus::Pane {
        state.sessions.enter(SessionId(2));
    }
    state
}

/// `state` with the session picker opened from its focus.
pub(crate) fn open_sessions(mut state: AppState) -> AppState {
    IntentHandler::handle(&Intent::OpenSessionPicker, &mut state);
    state
}

/// `agent` titled `title`.
pub(crate) fn named(agent: Agent, title: &str) -> Agent {
    Agent {
        title: Some(title.into()),
        ..agent
    }
}

/// The session picker opened on agent 2 of [`jumping`], listing 2, 1,
/// with agent 1 highlighted.
pub(crate) fn picking_agent_1() -> AppState {
    let mut state = open_sessions(jumping(Focus::Sidebar, &[], &[]));
    IntentHandler::handle(&Intent::PickerNext, &mut state);
    state
}

/// Closes agent 1's pane, leaving it last in session 1.
pub(crate) fn close_agent_1s_pane(state: &mut AppState) {
    for agent in state
        .sessions
        .projects
        .iter_mut()
        .flat_map(|project| project.agents.iter_mut())
        .filter(|agent| agent.id == AgentId(1))
    {
        agent.pane = None;
        agent.last_session = Some(SessionId(1));
    }
}

pub(crate) const USED: &str = "/home/u/.orb/worktrees/work/orb-ffff";

pub(crate) const ORPHAN: &str = "/home/u/.orb/worktrees/work/orb-0000";

/// Agent 1 running in worktree `USED`, and a clean orphan worktree
/// `ORPHAN` that sorts before it by path.
pub(crate) fn worktree_state() -> AppState {
    let worktree = |path: &str| Worktree {
        path: path.into(),
        repo: Some("/work".into()),
        facts: None,
        size_kb: None,
    };
    AppState {
        worktrees: Worktrees {
            list: vec![worktree(ORPHAN), worktree(USED)],
        },
        ..state_at(
            vec![Agent {
                cwd: USED.into(),
                ..agent(1, AgentStatus::Idle)
            }],
            SidebarItem::Session(SessionId(1)),
        )
    }
}

/// The open picker's selected worktree row.
pub(crate) fn picked_worktree(state: &AppState) -> Option<PathBuf> {
    state
        .picker
        .as_ref()
        .and_then(PickerState::selected_worktree)
        .map(Path::to_path_buf)
}

/// The worktree picker opened over orb's worktrees, then `intents`
/// handled.
pub(crate) fn worktree_picker_after(intents: &[Intent]) -> AppState {
    let mut state = worktree_state();
    IntentHandler::handle(&Intent::OpenWorktreePicker, &mut state);
    for intent in intents {
        IntentHandler::handle(intent, &mut state);
    }
    state
}

/// Agent 1 selected, attached and active, shown in session 1's one-tab
/// layout over an 80×24 body, with the keys at `focus`.
pub(crate) fn with_layout(focus: Focus) -> AppState {
    let mut state = AppState {
        focus,
        attached: HashSet::from([SessionId(1)]),
        ..state_with(vec![agent(1, AgentStatus::Idle)], 1)
    };
    state.sessions.enter(SessionId(1));
    state.layouts.fit_to(Rect::new(0, 0, 80, 24));
    state
}

/// `with_layout(Focus::Pane)` split right once: agent 1's pane on
/// the left, shell pane 50 on the right with the focus.
pub(crate) fn split_layout() -> AppState {
    let mut state = with_layout(Focus::Pane);
    state
        .layouts
        .split(SessionId(1), Split::Right, test_entry(50));
    state
}

pub(crate) fn shown_focus(state: &AppState) -> Option<PaneId> {
    state.shown_layout().and_then(SessionLayout::focused)
}

/// Session 1 attached, active and shown over an 80×24 body, running agent 1
/// in pane 1 and agent 2 in pane 2 split off to its right, with pane 2
/// focused, the cursor on session 1's card and the keys in the pane.
pub(crate) fn two_agents() -> AppState {
    let mut state = AppState {
        focus: Focus::Pane,
        attached: HashSet::from([SessionId(1)]),
        ..state_with(
            vec![
                agent(1, AgentStatus::Idle),
                Agent {
                    pane: Some(PaneLaunch {
                        pane: PaneId(2),
                        session: SessionId(1),
                    }),
                    ..agent(2, AgentStatus::Idle)
                },
            ],
            1,
        )
    };
    state.layouts = {
        let mut layouts = Layouts::default();
        layouts.insert(SessionId(1), SessionLayout::of(test_entry(1)));
        layouts.split(SessionId(1), Split::Right, test_entry(2));
        layouts.fit_to(Rect::new(0, 0, 80, 24));
        layouts
    };
    state.sessions.enter(SessionId(1));
    state
}

/// [`two_agents`] with the keys in the sidebar, the cursor on `cursor`
/// and `jumps` listed, oldest first.
pub(crate) fn two_agents_from_sidebar(cursor: SidebarItem, jumps: &[SidebarItem]) -> AppState {
    let mut state = two_agents();
    state.focus = Focus::Sidebar;
    state.sessions.cursor = Some(cursor);
    state.jumps = JumpList::from_saved(jumps.to_vec());
    state
}

pub(crate) fn shown_tab_name(state: &AppState) -> Option<String> {
    state
        .shown_layout()
        .and_then(SessionLayout::active_tab)
        .and_then(Tab::name)
        .map(str::to_owned)
}

/// [`left_pane`] with session 1 active.
pub(crate) fn left_pane_showing_1(attached: &[i64], selected: i64) -> AppState {
    let mut state = left_pane(attached, selected);
    state.sessions.enter(SessionId(1));
    state
}
