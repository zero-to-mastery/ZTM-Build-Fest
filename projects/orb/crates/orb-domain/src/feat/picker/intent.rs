//! What the picker keys do: opening each picker, moving through its rows,
//! typing into its box, and what picking or removing a row asks for, handed
//! to the feature that owns the row.

use std::path::{Path, PathBuf};

use crate::command::{SearchCommand, SessionsCommand, Workspace, WorktreesCommand};
use crate::feat::git::intent::{
    change_workspace, pick_branch, pick_move_workspace, pick_new_workspace,
};
use crate::feat::pane::intent::show_pane;
use crate::feat::picker::list::PickerItem;
use crate::feat::picker::state::{
    PickTarget, PickerKind, PickerState, SessionFilter, session_items, worktree_items,
};
use crate::feat::picker::validator::{
    DeleteWorktreeError, validate_add_directory, validate_close_listed_agent,
    validate_delete_worktree, validate_open_colonists, validate_open_directory,
    validate_pick_project, validate_pick_session, validate_remove_project,
};
use crate::feat::sessions::intent::new_session;
use crate::feat::sessions::intent::{
    delete_session, filter_to, open_colony_name, pick_project, remove_project, settle_session,
    still_deletable,
};
use crate::feat::sessions::state::Project;
use crate::feat::sessions::state::{ProjectKind, SidebarItem};
use crate::feat::sidebar;
use crate::ids::{AgentId, PaneId, SessionId};
use crate::{AppState, Command, Focus};

/// Opens the new-session picker over orb's projects, most recent first.
pub(crate) fn open_project_picker(state: &mut AppState) -> Vec<Command> {
    let items = state
        .sessions
        .projects_by_recency()
        .into_iter()
        .map(project_item)
        .collect();
    open_picker(state, PickerState::projects(items, state.focus));
    vec![]
}

/// Opens the world picker over the worlds, in worlds order.
pub(crate) fn open_world_picker(state: &mut AppState) -> Vec<Command> {
    let items = state
        .sessions
        .worlds_by_recency()
        .into_iter()
        .map(project_item)
        .collect();
    open_picker(state, PickerState::worlds(items, state.focus));
    vec![]
}

/// Opens the projects screen over orb's projects, most recent first.
pub(crate) fn open_projects(state: &mut AppState) -> Vec<Command> {
    let items = state
        .sessions
        .projects_by_recency()
        .into_iter()
        .map(project_item)
        .collect();
    open_picker(state, PickerState::manage_projects(items, state.focus));
    vec![]
}

/// Opens the worlds screen over Research, Learn and the user's worlds, in
/// worlds order.
pub(crate) fn open_worlds(state: &mut AppState) -> Vec<Command> {
    let items = state
        .sessions
        .worlds_by_recency()
        .into_iter()
        .map(project_item)
        .collect();
    open_picker(state, PickerState::manage_worlds(items, state.focus));
    vec![]
}

/// Opens the session picker, loading the selected row's preview.
pub(crate) fn open_session_picker(state: &mut AppState) -> Vec<Command> {
    let items = session_items(
        &state.sessions,
        &state.layouts,
        SessionFilter::All,
        false,
        None,
    );
    open_picker(state, PickerState::sessions(items, state.focus));
    preview_command(state)
}

/// Opens the Colonists picker on the keyed colony, loading the selected
/// row's preview.
pub(crate) fn open_colonists(state: &mut AppState) -> Vec<Command> {
    let Ok(colony) = validate_open_colonists(state) else {
        return vec![];
    };
    let items = session_items(
        &state.sessions,
        &state.layouts,
        SessionFilter::All,
        false,
        Some(colony),
    );
    open_picker(state, PickerState::colonists(items, colony, state.focus));
    preview_command(state)
}

/// Opens the worktree picker and asks for the worktrees to be re-read.
pub(crate) fn open_worktree_picker(state: &mut AppState) -> Vec<Command> {
    let items = worktree_items(state);
    open_picker(state, PickerState::worktrees(items, state.focus));
    vec![Command::Worktrees(WorktreesCommand::RefreshWorktrees)]
}

/// Opens the search picker and asks for a search of every transcript.
pub(crate) fn open_search(state: &mut AppState) -> Vec<Command> {
    open_picker(state, PickerState::search(state.focus));
    vec![Command::Search(SearchCommand::SearchTranscripts {
        query: String::new(),
    })]
}

/// Opens the project filter: all projects, the worlds in worlds order,
/// Incognito, then the projects most recent first.
pub(crate) fn filter_projects(state: &mut AppState) -> Vec<Command> {
    let items = std::iter::once(PickerItem::AllProjects)
        .chain(
            state
                .sessions
                .worlds_by_recency()
                .into_iter()
                .map(project_item),
        )
        .chain(
            state
                .sessions
                .own_project(ProjectKind::Incognito)
                .map(project_item),
        )
        .chain(
            state
                .sessions
                .projects_by_recency()
                .into_iter()
                .map(project_item),
        )
        .collect();
    let picker = PickerState::project_filter(items, state.sessions.filter, state.focus);
    open_picker(state, picker);
    vec![]
}

/// Opens the directory picker to add a project, over the projects screen when
/// it's open, or to add a world over the worlds screen, and asks for its
/// first listing.
pub(crate) fn add_project(state: &mut AppState) -> Vec<Command> {
    let screen = state.picker.take_if(|open| {
        matches!(
            open.kind(),
            PickerKind::ManageProjects | PickerKind::ManageWorlds
        )
    });
    let (picker, dir) = match &screen {
        Some(list) if *list.kind() == PickerKind::ManageWorlds => {
            PickerState::world_directories(state.home.clone(), state.focus)
        }
        _ => PickerState::directories(state.home.clone(), state.focus),
    };
    let picker = match screen {
        Some(list) => picker.over(list),
        None => picker,
    };
    open_picker(state, picker);
    vec![Command::ListDirectories(dir)]
}

/// Moves the picker's keys into its search box.
pub(crate) fn start_search(state: &mut AppState) -> Vec<Command> {
    if let Some(picker) = &mut state.picker {
        picker.start_search();
    }
    vec![]
}

/// Selects the picker's last row.
pub(crate) fn last(state: &mut AppState) -> Vec<Command> {
    let before = picked(state);
    if let Some(picker) = &mut state.picker {
        picker.last();
    }
    with_preview(state, before, vec![])
}

/// `g` in the picker: the first of `gg`, or the second, selecting the first
/// row.
pub(crate) fn press_g(state: &mut AppState) -> Vec<Command> {
    let before = picked(state);
    if let Some(picker) = &mut state.picker {
        picker.press_g();
    }
    with_preview(state, before, vec![])
}

/// `c` in the session picker's list: shows or hides colonists' agents.
pub(crate) fn toggle_colonists(state: &mut AppState) -> Vec<Command> {
    let before = picked(state);
    if let Some(picker) = &mut state.picker {
        picker.toggle_colonists(&state.sessions, &state.layouts);
    }
    with_preview(state, before, vec![])
}

/// Narrows the session picker by the filter key `pressed`, or widens it
/// again.
pub(crate) fn filter(state: &mut AppState, pressed: SessionFilter) -> Vec<Command> {
    let before = picked(state);
    if let Some(picker) = &mut state.picker {
        picker.set_filter(pressed, &state.sessions, &state.layouts);
    }
    with_preview(state, before, vec![])
}

/// A key the picker's box takes, which the rename box and the sidebar
/// search take too while they have the keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PickerKey {
    /// Types a character.
    Input(char),
    /// Deletes the grapheme before the cursor.
    Backspace,
    /// Deletes the word before the cursor.
    DeleteWord,
    /// Moves the cursor one grapheme left.
    CursorLeft,
    /// Moves the cursor one grapheme right.
    CursorRight,
    /// Moves the cursor to this grapheme (a click).
    CursorTo(usize),
    /// Selects the next row or match.
    Next,
    /// Selects the previous row or match.
    Prev,
    /// Moves the selection half a page down.
    HalfPageDown,
    /// Moves the selection half a page up.
    HalfPageUp,
    /// Picks the selected row, saves the name, or ends the search.
    Confirm,
    /// Browses into the selected directory.
    Open,
    /// Closes without picking.
    Cancel,
    /// Asks to remove the highlighted row.
    Remove,
    /// Selects the shown row at this index (a click).
    SelectRow(usize),
    /// Selects the next row, stopping on the last (the wheel).
    WheelNext,
    /// Selects the previous row, stopping on the first (the wheel).
    WheelPrev,
}

/// A key for the picker's box: the rename box or the sidebar search take it
/// while they have the keys; otherwise the open picker does.
pub(crate) fn key(state: &mut AppState, key: PickerKey) -> Vec<Command> {
    match state.focus {
        Focus::Rename => sidebar::intent::rename_key(key, state),
        Focus::Search => sidebar::intent::search_key(key, state),
        _ => match key {
            PickerKey::Input(ch) => input(state, ch),
            PickerKey::Backspace => backspace(state),
            PickerKey::DeleteWord => delete_word(state),
            PickerKey::CursorLeft => cursor_left(state),
            PickerKey::CursorRight => cursor_right(state),
            PickerKey::CursorTo(index) => cursor_to(state, index),
            PickerKey::Next => next(state),
            PickerKey::Prev => prev(state),
            PickerKey::HalfPageDown => half_page_down(state),
            PickerKey::HalfPageUp => half_page_up(state),
            PickerKey::SelectRow(index) => select_row(state, index),
            PickerKey::WheelNext => wheel_next(state),
            PickerKey::WheelPrev => wheel_prev(state),
            PickerKey::Open => open(state),
            PickerKey::Confirm => confirm(state),
            PickerKey::Cancel => cancel(state),
            PickerKey::Remove => remove(state),
        },
    }
}

/// `Esc` in the picker: leaves its search box while the keys are in it,
/// else goes back to the list under it, or closes it.
fn cancel(state: &mut AppState) -> Vec<Command> {
    match &mut state.picker {
        Some(picker) if picker.searching() => picker.leave_search(),
        _ => back_to_list(state, false),
    }
    vec![]
}

/// Types `ch` into the picker's box.
fn input(state: &mut AppState, ch: char) -> Vec<Command> {
    let before = picked(state);
    let commands = list(state.picker.as_mut().and_then(|p| p.insert(ch)));
    let commands = with_preview(state, before, commands);
    with_search(state, commands)
}

/// Deletes the character before the picker box's cursor.
fn backspace(state: &mut AppState) -> Vec<Command> {
    let before = picked(state);
    let commands = list(state.picker.as_mut().and_then(PickerState::backspace));
    let commands = with_preview(state, before, commands);
    with_search(state, commands)
}

/// Deletes the word before the picker box's cursor.
fn delete_word(state: &mut AppState) -> Vec<Command> {
    let before = picked(state);
    let commands = list(state.picker.as_mut().and_then(PickerState::delete_word));
    let commands = with_preview(state, before, commands);
    with_search(state, commands)
}

/// Moves the picker box's cursor left.
fn cursor_left(state: &mut AppState) -> Vec<Command> {
    if let Some(picker) = &mut state.picker {
        picker.cursor_left();
    }
    vec![]
}

/// Moves the picker box's cursor right.
fn cursor_right(state: &mut AppState) -> Vec<Command> {
    if let Some(picker) = &mut state.picker {
        picker.cursor_right();
    }
    vec![]
}

/// Puts the picker box's cursor at `index`, moving the keys into the box.
fn cursor_to(state: &mut AppState, index: usize) -> Vec<Command> {
    if let Some(picker) = &mut state.picker {
        picker.start_search();
        picker.cursor_to(index);
    }
    vec![]
}

/// Selects the picker's next row.
fn next(state: &mut AppState) -> Vec<Command> {
    let before = picked(state);
    if let Some(picker) = &mut state.picker {
        picker.next();
    }
    with_preview(state, before, vec![])
}

/// Selects the picker's previous row.
fn prev(state: &mut AppState) -> Vec<Command> {
    let before = picked(state);
    if let Some(picker) = &mut state.picker {
        picker.prev();
    }
    with_preview(state, before, vec![])
}

/// Moves the picker's selection half a page down.
fn half_page_down(state: &mut AppState) -> Vec<Command> {
    let before = picked(state);
    if let Some(picker) = &mut state.picker {
        picker.half_page_down();
    }
    with_preview(state, before, vec![])
}

/// Moves the picker's selection half a page up.
fn half_page_up(state: &mut AppState) -> Vec<Command> {
    let before = picked(state);
    if let Some(picker) = &mut state.picker {
        picker.half_page_up();
    }
    with_preview(state, before, vec![])
}

/// Selects the picker's row `index`.
fn select_row(state: &mut AppState, index: usize) -> Vec<Command> {
    let before = picked(state);
    if let Some(picker) = &mut state.picker {
        picker.select_row(index);
    }
    with_preview(state, before, vec![])
}

/// The wheel down in the picker: selects the row below.
fn wheel_next(state: &mut AppState) -> Vec<Command> {
    let before = picked(state);
    if let Some(picker) = &mut state.picker {
        picker.select_below();
    }
    with_preview(state, before, vec![])
}

/// The wheel up in the picker: selects the row above.
fn wheel_prev(state: &mut AppState) -> Vec<Command> {
    let before = picked(state);
    if let Some(picker) = &mut state.picker {
        picker.select_above();
    }
    with_preview(state, before, vec![])
}

/// Opens the directory picker's selected directory.
fn open(state: &mut AppState) -> Vec<Command> {
    match validate_open_directory(state) {
        Ok(()) => list(state.picker.as_mut().and_then(PickerState::open_directory)),
        Err(_) => vec![],
    }
}

/// `⏎` in the picker: does what picking the selected row means for that
/// picker's kind.
#[expect(clippy::too_many_lines, reason = "one arm per picker kind")]
fn confirm(state: &mut AppState) -> Vec<Command> {
    match state.picker.as_ref().map(PickerState::kind) {
        Some(&PickerKind::Workspace {
            target: PickTarget::Move(session),
        }) => {
            let choice = close_picker(state)
                .as_ref()
                .and_then(PickerState::selected)
                .cloned();
            pick_move_workspace(state, session, choice)
        }
        Some(PickerKind::Workspace {
            target: PickTarget::New { project, name },
        }) => {
            let (project, name) = (*project, name.clone());
            let choice = close_picker(state)
                .as_ref()
                .and_then(PickerState::selected)
                .cloned();
            pick_new_workspace(state, project, name, choice)
        }
        Some(PickerKind::Base {
            target: PickTarget::New { project, name },
            ..
        }) => {
            let (project, name) = (*project, name.clone());
            match close_picker(state).as_ref().and_then(PickerState::selected) {
                Some(PickerItem::Branch(row)) => {
                    let base = row.git_ref.name.clone();
                    new_session(state, project, Workspace::NewWorktree { base }, name)
                }
                _ => vec![],
            }
        }
        Some(&PickerKind::Base {
            target: PickTarget::Move(session),
            ..
        }) => match close_picker(state).as_ref().and_then(PickerState::selected) {
            Some(PickerItem::Branch(row)) => {
                let base = row.git_ref.name.clone();
                change_workspace(state, session, Workspace::NewWorktree { base })
            }
            _ => vec![],
        },
        Some(&PickerKind::InitGit { project }) => {
            match close_picker(state).as_ref().and_then(PickerState::selected) {
                Some(PickerItem::InitGit) => {
                    vec![Command::Sessions(SessionsCommand::InitGit(project))]
                }
                _ => vec![],
            }
        }
        Some(&PickerKind::RemoveProject { project }) => {
            let yes = state.picker.as_ref().and_then(PickerState::selected)
                == Some(&PickerItem::Confirm(true));
            back_to_list(state, yes);
            if yes {
                remove_project(state, project)
            } else {
                vec![]
            }
        }
        Some(&PickerKind::SettleSession { session }) => {
            match close_picker(state).as_ref().and_then(PickerState::selected) {
                Some(PickerItem::Confirm(true) | PickerItem::Covers { colonists: false }) => {
                    settle_session(state, session, false)
                }
                Some(PickerItem::Covers { colonists: true }) => {
                    settle_session(state, session, true)
                }
                _ => vec![],
            }
        }
        Some(&PickerKind::DeleteSession { session, .. }) => {
            match close_picker(state).as_ref().and_then(PickerState::selected) {
                Some(PickerItem::Confirm(true) | PickerItem::Covers { colonists: false })
                    if still_deletable(state, SidebarItem::Session(session)) =>
                {
                    delete_session(state, session, false)
                }
                Some(PickerItem::Covers { colonists: true })
                    if still_deletable(state, SidebarItem::Session(session)) =>
                {
                    delete_session(state, session, true)
                }
                _ => vec![],
            }
        }
        Some(&PickerKind::ClosePane { pane, session })
            if state.picker.as_ref().and_then(PickerState::under).is_some() =>
        {
            leave_close_listed_agent(state, session, pane)
        }
        Some(&PickerKind::ClosePane { pane, session }) => {
            match close_picker(state).as_ref().and_then(PickerState::selected) {
                Some(PickerItem::Confirm(true))
                    if state.sessions.selected_agent(&state.layouts) == Some((session, pane)) =>
                {
                    close_agent_pane(state, session, pane)
                }
                _ => vec![],
            }
        }
        Some(PickerKind::ProjectFilter) => {
            match close_picker(state).as_ref().and_then(PickerState::selected) {
                Some(PickerItem::AllProjects) => filter_to(state, None),
                Some(&PickerItem::Project { id, .. }) => filter_to(state, Some(id)),
                _ => vec![],
            }
        }
        Some(PickerKind::Branches { .. }) => close_picker(state)
            .map(|picker| pick_branch(state, &picker))
            .unwrap_or_default(),
        Some(PickerKind::Sessions { .. }) => {
            let valid = validate_pick_session(state);
            let agent = close_picker(state).and_then(|picker| picker.selected_agent());
            match (valid, agent) {
                (Ok(()), Some((session, pane))) => pick_agent(state, session, pane),
                _ => vec![],
            }
        }
        Some(PickerKind::Search { .. }) => {
            let valid = validate_pick_session(state);
            let session =
                close_picker(state).and_then(|picker| picker.picked_session(&state.sessions));
            match (valid, session) {
                (Ok(()), Some(session)) => pick_session(state, session),
                _ => vec![],
            }
        }
        Some(PickerKind::Worktrees) => vec![],
        Some(PickerKind::DeleteWorktree { .. }) => leave_delete_worktree(state),
        Some(PickerKind::Directories { world: true, .. }) => pick_world_root(state),
        Some(PickerKind::WorldKind { root }) => {
            let root = root.clone();
            let kind = match state.picker.as_ref().and_then(PickerState::selected) {
                Some(&PickerItem::WorldKind { fresh: true }) => Some(ProjectKind::FreshWorld),
                Some(&PickerItem::WorldKind { fresh: false }) => Some(ProjectKind::SharedWorld),
                _ => None,
            };
            back_to_list(state, false);
            kind.map(|kind| Command::Sessions(SessionsCommand::AddWorld { root, kind }))
                .into_iter()
                .collect()
        }
        Some(PickerKind::Worlds | PickerKind::ManageWorlds) => {
            let valid = validate_pick_project(state);
            match (
                valid,
                close_picker(state).as_ref().and_then(PickerState::selected),
            ) {
                (Ok(()), Some(&PickerItem::Project { id, .. })) => open_colony_name(state, id),
                _ => vec![],
            }
        }
        _ => match (validate_pick_project(state), validate_add_directory(state)) {
            (Ok(()), _) => match close_picker(state).as_ref().and_then(PickerState::selected) {
                Some(&PickerItem::Project { id, .. }) => pick_project(state, id),
                _ => vec![],
            },
            (_, Ok(())) => {
                let dir = state
                    .picker
                    .as_ref()
                    .and_then(PickerState::directory_to_add);
                back_to_list(state, false);
                dir.map(SessionsCommand::AddProject)
                    .map(Command::Sessions)
                    .into_iter()
                    .collect()
            }
            _ => vec![],
        },
    }
}

/// `⏎` in the directory picker for a world: the `Add <name> as` pick over
/// the worlds screen, for the highlighted or typed directory.
fn pick_world_root(state: &mut AppState) -> Vec<Command> {
    let root = validate_add_directory(state).ok().and_then(|()| {
        state
            .picker
            .as_ref()
            .and_then(PickerState::directory_to_add)
    });
    let Some(root) = root else { return vec![] };
    back_to_list(state, false);
    if let Some(list) = state.picker.take() {
        let return_to = list.return_to();
        state.picker = Some(PickerState::world_kind(root, return_to).over(list));
    }
    vec![]
}

/// `d` in the picker: the delete-worktree confirm, the close-agent confirm,
/// or the remove-project confirm, by the list's kind.
fn remove(state: &mut AppState) -> Vec<Command> {
    match state.picker.as_ref().map(PickerState::kind) {
        Some(PickerKind::Worktrees) => ask_delete_worktree(state),
        Some(PickerKind::Sessions { .. }) => ask_close_listed_agent(state),
        _ => match (
            validate_remove_project(state),
            state.picker.as_ref().and_then(PickerState::selected),
        ) {
            (Ok(()), Some(&PickerItem::Project { id, .. })) => {
                if let Some(list) = state.picker.take() {
                    let return_to = list.return_to();
                    state.picker = Some(PickerState::remove_project(id, return_to).over(list));
                }
                vec![]
            }
            _ => vec![],
        },
    }
}

/// Asks the frontend to list `dir` into the directory picker, if there is one.
fn list(dir: Option<PathBuf>) -> Vec<Command> {
    dir.map(Command::ListDirectories).into_iter().collect()
}

/// The open picker's selected agent, and the selected hit's id when the row
/// is a search hit.
pub(crate) fn picked(state: &AppState) -> (Option<AgentId>, Option<i64>) {
    let picker = state.picker.as_ref();
    (
        picker.and_then(PickerState::selected_agent_id),
        picker
            .and_then(PickerState::selected_hit)
            .map(|(id, ..)| id),
    )
}

/// `commands`, then [`preview_command`] when the picker's selected agent or
/// hit is no longer `before`.
fn with_preview(
    state: &mut AppState,
    before: (Option<AgentId>, Option<i64>),
    commands: Vec<Command>,
) -> Vec<Command> {
    if picked(state) == before {
        return commands;
    }
    commands.into_iter().chain(preview_command(state)).collect()
}

/// `commands`, then a search for the typed text while the search picker is
/// open.
fn with_search(state: &AppState, commands: Vec<Command>) -> Vec<Command> {
    let query = state.picker.as_ref().and_then(PickerState::search_query);
    commands
        .into_iter()
        .chain(query.map(|query| {
            Command::Search(SearchCommand::SearchTranscripts {
                query: query.to_owned(),
            })
        }))
        .collect()
}

/// Asks for the picker's selected row to be read into its preview: a search
/// hit's exchange from the search index, or an agent's transcript. With
/// nothing selected, or an agent with no transcript yet, it clears the
/// preview instead and asks for nothing.
fn preview_command(state: &mut AppState) -> Vec<Command> {
    let Some(picker) = &mut state.picker else {
        return vec![];
    };
    if let Some((hit, path, prompt_offset)) = picker.selected_hit() {
        return vec![Command::Search(SearchCommand::LoadSearchPreview {
            hit,
            path: path.to_owned(),
            prompt_offset,
        })];
    }
    let load = picker.selected_agent_id().and_then(|id| {
        let agent = state.sessions.all_agents().find(|agent| agent.id == id)?;
        Some((id, agent.transcript.clone()?))
    });
    match load {
        Some((agent, transcript)) => vec![Command::LoadPreview { agent, transcript }],
        None => {
            picker.clear_preview();
            vec![]
        }
    }
}

/// Closes the picker and gives the keys back to where it was opened from.
fn close_picker(state: &mut AppState) -> Option<PickerState> {
    let picker = state.picker.take()?;
    state.focus = picker.return_to();
    Some(picker)
}

/// Swaps the open picker for the list it was opened over, dropping the
/// selected row when `drop_row`; the keys stay in the picker. With no list
/// under it, closes it and gives the keys back.
fn back_to_list(state: &mut AppState, drop_row: bool) {
    let Some(confirm) = state.picker.take() else {
        return;
    };
    let return_to = confirm.return_to();
    match confirm.back() {
        Some(mut list) => {
            if drop_row {
                list.remove_selected_row();
            }
            state.picker = Some(list);
        }
        None => state.focus = return_to,
    }
}

/// Puts the cursor on `cursor`, records the move from `from` (where a jump
/// starts, read before the pick changes anything) as a jump to `jump_to` and
/// attaches its session. Staying on the same row isn't a jump.
pub(crate) fn pick(
    state: &mut AppState,
    from: Option<SidebarItem>,
    cursor: SidebarItem,
    jump_to: SidebarItem,
) -> Vec<Command> {
    state.sessions.cursor = Some(cursor);
    let mut commands = if from == Some(cursor) || from == Some(jump_to) {
        vec![]
    } else {
        state.jumps.jump(from, Some(jump_to));
        vec![Command::Sessions(SessionsCommand::SaveJumps)]
    };
    commands.extend(show_pane(state));
    commands
}

/// Jumps to `session`, picked in the search picker: puts the cursor on it
/// and attaches like `⏎` on its row, recording the move as a jump to the
/// agent in its focused pane, else its card.
fn pick_session(state: &mut AppState, session: SessionId) -> Vec<Command> {
    let from = state.jump_from();
    let entry = state.entry_row(session);
    pick(state, from, SidebarItem::Session(session), entry)
}

/// Jumps to agent `pane` of `session`, picked in the session picker: shows
/// the pane in its tab, puts the cursor on its agent row and moves the keys
/// into it like `⏎` on that row, recording the move as a jump to the agent.
fn pick_agent(state: &mut AppState, session: SessionId, pane: PaneId) -> Vec<Command> {
    let from = state.jump_from();
    state.layouts.reveal(session, pane);
    let agent = SidebarItem::Agent { session, pane };
    let mut commands = pick(state, from, agent, agent);
    commands.push(Command::Sessions(SessionsCommand::SaveLayout(session)));
    commands
}

/// Closes agent pane `pane` of `session`, answered `Yes` in its confirm:
/// the tab it leaves re-tiles unless it was changed by hand, a cursor on that
/// agent's row goes to the session's card, and the layout is saved (the frontend kills the
/// pane's program; a session whose last pane closed gets a new shell when
/// its layout is saved).
fn close_agent_pane(state: &mut AppState, session: SessionId, pane: PaneId) -> Vec<Command> {
    state.layouts.close_pane(pane);
    if state.sessions.cursor == Some(SidebarItem::Agent { session, pane }) {
        state.sessions.cursor = Some(SidebarItem::Session(session));
    }
    vec![Command::Sessions(SessionsCommand::SaveLayout(session))]
}

/// `d` in the session picker's list: the sidebar agent row's close confirm
/// over the list.
fn ask_close_listed_agent(state: &mut AppState) -> Vec<Command> {
    let (Ok(()), Some((session, pane))) = (
        validate_close_listed_agent(state),
        state.picker.as_ref().and_then(PickerState::selected_agent),
    ) else {
        return vec![];
    };
    if let Some(list) = state.picker.take() {
        let return_to = list.return_to();
        state.picker = Some(PickerState::close_pane(pane, session, return_to).over(list));
    }
    vec![]
}

/// Ends the close confirm over the session picker: `Yes` on a pane that
/// still runs one of the session's agents closes it and goes back to the
/// list without its row, loading the new selection's preview; anything else
/// goes back to the list as it was.
fn leave_close_listed_agent(
    state: &mut AppState,
    session: SessionId,
    pane: PaneId,
) -> Vec<Command> {
    let yes = state.picker.as_ref().and_then(PickerState::selected)
        == Some(&PickerItem::Confirm(true))
        && state.sessions.runs_agent(session, pane, &state.layouts);
    back_to_list(state, yes);
    if !yes {
        return vec![];
    }
    let mut commands = close_agent_pane(state, session, pane);
    commands.extend(preview_command(state));
    commands
}

/// `d` in the worktree picker's list: the `No`/`Yes` confirm over the list, or
/// on an attached or mid-turn row, why it can't be deleted on the mode line.
fn ask_delete_worktree(state: &mut AppState) -> Vec<Command> {
    let why = match validate_delete_worktree(state) {
        Ok(()) => None,
        Err(DeleteWorktreeError::Attached) => Some("an agent in it is attached"),
        Err(DeleteWorktreeError::MidTurn) => Some("an agent in it is mid-turn"),
        Err(DeleteWorktreeError::NoPicker | DeleteWorktreeError::NoSelection) => return vec![],
    };
    let Some(path) = state
        .picker
        .as_ref()
        .and_then(PickerState::selected_worktree)
        .map(Path::to_path_buf)
    else {
        return vec![];
    };
    match why {
        Some(why) => {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            state.sessions.error = Some(format!("can't delete {name}: {why}"));
        }
        None => {
            let dirty = state
                .worktrees
                .list
                .iter()
                .find(|worktree| worktree.path == path)
                .and_then(|worktree| worktree.facts.as_ref())
                .is_some_and(|facts| facts.changes > 0);
            if let Some(list) = state.picker.take() {
                state.picker = Some(PickerState::delete_worktree(list, path, dirty));
            }
        }
    }
    vec![]
}

/// Ends the delete-worktree confirm: `Yes` returns `DeleteWorktree` for its
/// path, and either answer goes back to the list, without the row on `Yes`.
fn leave_delete_worktree(state: &mut AppState) -> Vec<Command> {
    let Some(picker) = &state.picker else {
        return vec![];
    };
    let delete = match (picker.kind(), picker.selected()) {
        (PickerKind::DeleteWorktree { path, .. }, Some(PickerItem::Confirm(true))) => {
            Some(path.clone())
        }
        _ => None,
    };
    back_to_list(state, delete.is_some());
    delete
        .map(|path| Command::Worktrees(WorktreesCommand::DeleteWorktree { path }))
        .into_iter()
        .collect()
}

/// The picker row for `project`.
pub(crate) fn project_item(project: &Project) -> PickerItem {
    PickerItem::Project {
        id: project.id,
        title: project.title.clone(),
        root: project.root.clone(),
        kind: project.kind,
    }
}

/// Opens `picker` and gives it the keys.
pub(crate) fn open_picker(state: &mut AppState, picker: PickerState) {
    state.picker = Some(picker);
    state.focus = Focus::Picker;
}

#[cfg(test)]
mod tests;
