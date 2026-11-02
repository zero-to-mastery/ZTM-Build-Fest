use crate::feat::harness::HarnessId;
use std::path::{Path, PathBuf};

use std::time::UNIX_EPOCH;

use super::{
    PickTarget, PickerKind, PickerState, SessionFilter, expand, hit_label, session_items,
    split_path,
};
use crate::Focus;
use crate::feat::git::git_service::GitRef;
use crate::feat::layout::state::{Layouts, SessionLayout};
use crate::feat::picker::list::PickerItem;
use crate::feat::sessions::state::{
    Agent, AgentStatus, PaneLaunch, Project, ProjectKind, Sessions, layouts_for, sessions_for,
};
use crate::feat::sessions::transcript::Exchange;
use crate::ids::{AgentId, PaneId, ProjectId, SessionId};
use std::time::Duration;

const HOME: &str = "/home/u";

fn names(text: &[&str]) -> Vec<String> {
    text.iter().map(|name| (*name).to_owned()).collect()
}

fn shown_names(picker: &PickerState) -> Vec<String> {
    picker
        .shown()
        .filter_map(|(item, _)| match item {
            PickerItem::Directory { name } => Some(name.clone()),
            _ => None,
        })
        .collect()
}

/// A directory picker at `~/` listing `listing`.
fn browsing(listing: &[&str]) -> PickerState {
    let (mut picker, home) = PickerState::directories(PathBuf::from(HOME), Focus::Sidebar);
    picker.show_directories(&home, names(listing));
    picker
}

fn typing(picker: &mut PickerState, text: &str) -> Option<PathBuf> {
    text.chars().fold(None, |_, ch| picker.insert(ch))
}

#[rstest::rstest]
#[case("~/dev/it", Some(("~/dev/", "it")))]
#[case("/", Some(("/", "")))]
#[case("~", None)]
#[case("dev", None)]
fn split_path_splits_after_the_last_slash(
    #[case] input: &str,
    #[case] expected: Option<(&str, &str)>,
) {
    // Given / When / Then.
    assert_eq!(split_path(input), expected, "split_path({input:?})");
}

#[rstest::rstest]
fn total_counts_items_the_filter_hides() {
    // Given a project picker over two projects, filtered to neither.
    let picker = {
        let project = |id, title: &str| PickerItem::Project {
            id: ProjectId(id),
            title: title.to_owned(),
            root: PathBuf::from("/tmp").join(title),
            kind: ProjectKind::Normal,
        };
        let mut picker =
            PickerState::projects(vec![project(1, "orb"), project(2, "jinn")], Focus::Sidebar);
        picker.insert('z');
        picker
    };

    // When counting its items.
    let total = picker.total();

    // Then both projects count.
    assert_eq!(total, 2, "total should count the hidden items");
}

#[rstest::rstest]
fn expand_resolves_home_without_a_trailing_slash() {
    // Given a directory under `~/`.
    let dir_text = "~/dev/";

    // When expanding it.
    let path = expand(dir_text, Path::new(HOME));

    // Then it is under home, with no trailing slash.
    assert_eq!(
        path.as_os_str(),
        "/home/u/dev",
        "~/dev/ should expand to home/dev"
    );
}

#[rstest::rstest]
fn directory_picker_opens_with_home_typed() {
    // Given / When opening a directory picker.
    let (picker, _) = PickerState::directories(PathBuf::from(HOME), Focus::Sidebar);

    // Then `~/` is typed.
    assert_eq!(picker.input(), "~/", "the picker should open at ~/");
}

#[rstest::rstest]
fn directory_picker_lists_home_first() {
    // Given / When opening a directory picker.
    let (_, to_list) = PickerState::directories(PathBuf::from(HOME), Focus::Sidebar);

    // Then home is the directory to list.
    assert_eq!(to_list, Path::new(HOME), "the picker should list home");
}

#[rstest::rstest]
fn directories_sort_ignoring_case() {
    // Given / When listing directories in mixed case.
    let picker = browsing(&["dev", "Documents", "Applications", "Desktop"]);

    // Then they are alphabetical, ignoring case.
    assert_eq!(
        shown_names(&picker),
        ["Applications", "Desktop", "dev", "Documents"],
        "directories should sort case-insensitively"
    );
}

#[rstest::rstest]
fn hidden_directories_are_hidden_with_nothing_typed() {
    // Given / When listing a dot-directory with nothing after `~/`.
    let picker = browsing(&[".cargo", "dev"]);

    // Then the dot-directory is hidden.
    assert_eq!(
        shown_names(&picker),
        ["dev"],
        "dot-directories should be hidden"
    );
}

#[rstest::rstest]
fn hidden_directories_are_hidden_before_fuzzy_matching() {
    // Given a dot-directory and a directory, both containing "c".
    let mut picker = browsing(&[".cargo", "code"]);

    // When typing "c".
    typing(&mut picker, "c");

    // Then only the visible one matches.
    assert_eq!(
        shown_names(&picker),
        ["code"],
        "`~/c` should not surface `.cargo`"
    );
}

#[rstest::rstest]
fn hidden_directories_show_when_a_dot_is_typed() {
    // Given a listed dot-directory.
    let mut picker = browsing(&[".cargo", "dev"]);

    // When typing ".".
    typing(&mut picker, ".");

    // Then the dot-directory is shown.
    assert_eq!(
        shown_names(&picker),
        [".cargo"],
        "a leading dot should show dot-directories"
    );
}

#[rstest::rstest]
fn edit_within_the_directory_lists_nothing() {
    // Given a directory picker at `~/`.
    let mut picker = browsing(&["dev"]);

    // When typing a filter.
    let to_list = picker.insert('d');

    // Then nothing needs listing.
    assert_eq!(to_list, None, "the directory didn't change");
}

#[rstest::rstest]
fn backspace_past_a_slash_lists_the_parent() {
    // Given `~/dev/` typed.
    let mut picker = browsing(&["dev"]);
    typing(&mut picker, "dev/");

    // When deleting the `/`.
    let to_list = picker.backspace();

    // Then home is listed again.
    assert_eq!(
        to_list,
        Some(PathBuf::from(HOME)),
        "going up should list the parent"
    );
}

#[rstest::rstest]
fn stale_listing_is_ignored() {
    // Given a directory picker at `~/`.
    let (mut picker, _) = PickerState::directories(PathBuf::from(HOME), Focus::Sidebar);

    // When a listing arrives for another directory.
    picker.show_directories(Path::new("/elsewhere"), names(&["x"]));

    // Then nothing is shown.
    assert!(
        shown_names(&picker).is_empty(),
        "a stale listing should be ignored"
    );
}

#[rstest::rstest]
fn open_directory_types_its_path() {
    // Given `dev` selected at `~/`.
    let mut picker = browsing(&["dev"]);

    // When opening it.
    picker.open_directory();

    // Then its path is typed.
    assert_eq!(picker.input(), "~/dev/", "Tab should type the directory");
}

#[rstest::rstest]
fn open_directory_lists_it() {
    // Given `dev` selected at `~/`.
    let mut picker = browsing(&["dev"]);

    // When opening it.
    let to_list = picker.open_directory();

    // Then it is the directory to list.
    assert_eq!(
        to_list,
        Some(PathBuf::from("/home/u/dev")),
        "Tab should list the directory"
    );
}

#[rstest::rstest]
fn directory_to_add_is_the_selected_directory() {
    // Given `dev` selected at `~/`.
    let picker = browsing(&["dev"]);

    // When asking what `⏎` adds.
    let added = picker.directory_to_add();

    // Then it is `dev` under home.
    assert_eq!(
        added,
        Some(PathBuf::from("/home/u/dev")),
        "⏎ should add the selected directory"
    );
}

#[rstest::rstest]
fn directory_to_add_is_the_typed_directory_when_empty() {
    // Given `~/dev/` typed and listed with no subdirectories.
    let mut picker = browsing(&["dev"]);
    let dev = typing(&mut picker, "dev/").unwrap_or_default();
    picker.show_directories(&dev, Vec::new());

    // When asking what `⏎` adds.
    let added = picker.directory_to_add();

    // Then it is the typed directory.
    assert_eq!(
        added,
        Some(PathBuf::from("/home/u/dev")),
        "⏎ should add the typed directory"
    );
}

#[rstest::rstest]
fn directory_to_add_is_none_for_an_unmatched_filter() {
    // Given a filter that matches no directory.
    let mut picker = browsing(&["dev"]);
    typing(&mut picker, "zz");

    // When asking what `⏎` adds.
    let added = picker.directory_to_add();

    // Then there is nothing to add.
    assert_eq!(added, None, "an unmatched filter adds nothing");
}

const CWD: &str = "/work";

/// Local branch `feat`, checked out in another worktree.
fn feat_elsewhere() -> GitRef {
    GitRef {
        name: "feat".to_owned(),
        remote: false,
        current: false,
        default: false,
        worktree: Some(PathBuf::from("/wt/feat")),
    }
}

/// Whether each shown branch row is disabled.
fn disabled_rows(picker: &PickerState) -> Vec<bool> {
    picker
        .shown()
        .filter_map(|(item, _)| match item {
            PickerItem::Branch(row) => Some(row.disabled),
            _ => None,
        })
        .collect()
}

/// Session 1's branch picker in [`CWD`], showing `refs`.
fn branches_listing(unstarted: bool, refs: Vec<GitRef>) -> PickerState {
    let mut picker =
        PickerState::branches(SessionId(1), CWD.into(), unstarted, None, Focus::Sidebar);
    picker.show_branches(Path::new(CWD), refs);
    picker
}

#[rstest::rstest]
fn branch_elsewhere_is_disabled_after_the_first_prompt() {
    // Given / When listing a branch checked out elsewhere for a prompted agent.
    let picker = branches_listing(false, vec![feat_elsewhere()]);

    // Then its row is disabled.
    assert_eq!(
        disabled_rows(&picker),
        [true],
        "a prompted agent can't follow a branch into another worktree"
    );
}

#[rstest::rstest]
fn branch_elsewhere_is_enabled_before_the_first_prompt() {
    // Given / When listing a branch checked out elsewhere for a prompt-less agent.
    let picker = branches_listing(true, vec![feat_elsewhere()]);

    // Then its row is enabled.
    assert_eq!(
        disabled_rows(&picker),
        [false],
        "a prompt-less agent can move to the branch's worktree"
    );
}

#[rstest::rstest]
fn stale_branch_listing_is_ignored() {
    // Given a branch picker in `/work`.
    let mut picker = branches_listing(true, vec![]);

    // When refs listed in another directory arrive.
    picker.show_branches(Path::new("/elsewhere"), vec![feat_elsewhere()]);

    // Then nothing is shown.
    assert_eq!(
        picker.shown().count(),
        0,
        "a listing for another directory should be ignored"
    );
}

/// The worktree picker's row for `orb/<name>`, matched also on `extra`.
fn worktree_row(name: &str, extra: &str) -> PickerItem {
    PickerItem::Worktree {
        path: PathBuf::from("/wt/orb").join(name),
        label: format!("orb/{name}"),
        split: 4,
        extra: extra.to_owned(),
    }
}

/// The paths of the shown worktree rows, in order.
fn shown_worktrees(picker: &PickerState) -> Vec<PathBuf> {
    picker
        .shown()
        .filter_map(|(item, _)| match item {
            PickerItem::Worktree { path, .. } => Some(path.clone()),
            _ => None,
        })
        .collect()
}

#[rstest::rstest]
fn show_worktrees_lists_a_worktree_that_appeared() {
    // Given a worktree picker showing alpha.
    let mut picker = PickerState::worktrees(vec![worktree_row("alpha", "")], Focus::Sidebar);

    // When a rescan lists alpha and beta.
    picker.show_worktrees(vec![worktree_row("alpha", ""), worktree_row("beta", "")]);

    // Then both are shown.
    assert_eq!(
        shown_worktrees(&picker),
        [
            PathBuf::from("/wt/orb/alpha"),
            PathBuf::from("/wt/orb/beta")
        ],
        "a new worktree should show without reopening the picker"
    );
}

#[rstest::rstest]
fn show_worktrees_keeps_the_typed_filter() {
    // Given a worktree picker filtered by "beta".
    let mut picker = PickerState::worktrees(
        vec![worktree_row("alpha", ""), worktree_row("beta", "")],
        Focus::Sidebar,
    );
    "beta".chars().for_each(|ch| {
        picker.insert(ch);
    });

    // When a rescan lists alpha, beta and gamma.
    picker.show_worktrees(vec![
        worktree_row("alpha", ""),
        worktree_row("beta", ""),
        worktree_row("gamma", ""),
    ]);

    // Then only beta is shown.
    assert_eq!(
        shown_worktrees(&picker),
        [PathBuf::from("/wt/orb/beta")],
        "a rescan should keep the typed filter"
    );
}

#[rstest::rstest]
fn show_worktrees_keeps_the_selected_path() {
    // Given a worktree picker with beta selected.
    let mut picker = PickerState::worktrees(
        vec![worktree_row("alpha", ""), worktree_row("beta", "")],
        Focus::Sidebar,
    );
    picker.list.select(&worktree_row("beta", ""));

    // When a rescan lists a new first row and beta with its branch known.
    picker.show_worktrees(vec![
        worktree_row("aaa", ""),
        worktree_row("alpha", ""),
        worktree_row("beta", "main"),
    ]);

    // Then beta is still selected.
    assert_eq!(
        picker.selected_worktree(),
        Some(Path::new("/wt/orb/beta")),
        "a rescan should keep the selected worktree"
    );
}

#[rstest::rstest]
fn show_worktrees_leaves_another_picker_alone() {
    // Given a project picker showing nothing.
    let mut picker = PickerState::projects(Vec::new(), Focus::Sidebar);

    // When a rescan lists a worktree.
    picker.show_worktrees(vec![worktree_row("alpha", "")]);

    // Then it still shows nothing.
    assert_eq!(
        picker.shown().count(),
        0,
        "only the worktree picker should take a rescan"
    );
}

#[rstest::rstest]
fn show_projects_leaves_another_picker_alone() {
    // Given a project picker showing nothing.
    let mut picker = PickerState::projects(Vec::new(), Focus::Sidebar);

    // When the projects are re-listed.
    picker.show_projects(vec![PickerItem::Project {
        id: ProjectId(1),
        title: "alpha".to_owned(),
        root: PathBuf::from("/alpha"),
        kind: ProjectKind::Normal,
    }]);

    // Then it still shows nothing.
    assert_eq!(
        picker.shown().count(),
        0,
        "only the projects screen should re-list projects"
    );
}

/// Local branch `name`, the default branch when `default`.
fn local(name: &str, default: bool) -> GitRef {
    GitRef {
        name: name.to_owned(),
        remote: false,
        current: false,
        default,
        worktree: None,
    }
}

/// Project 1's base picker for a new worktree of [`CWD`], showing `refs`.
fn base_listing(refs: Vec<GitRef>) -> PickerState {
    let mut picker = PickerState::base(
        PickTarget::New {
            project: ProjectId(1),
            name: None,
        },
        CWD.into(),
        Focus::Sidebar,
    );
    picker.show_branches(Path::new(CWD), refs);
    picker
}

#[rstest::rstest]
fn base_picker_lists_the_default_branch_first() {
    // Given / When listing two branches before the default one.
    let picker = base_listing(vec![
        local("feat", false),
        local("fix", false),
        local("main", true),
    ]);

    // Then the default branch comes first, the rest in order.
    let names: Vec<&str> = picker
        .shown()
        .filter_map(|(item, _)| match item {
            PickerItem::Branch(row) => Some(row.git_ref.name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        names,
        ["main", "feat", "fix"],
        "the default branch should lead the base picker"
    );
}

#[rstest::rstest]
fn base_picker_disables_no_branch() {
    // Given / When listing a branch checked out in another worktree.
    let picker = base_listing(vec![local("main", true), feat_elsewhere()]);

    // Then no row is disabled.
    assert_eq!(
        disabled_rows(&picker),
        [false, false],
        "any branch can be a new worktree's base"
    );
}

#[rstest::rstest]
fn remove_project_confirm_lists_no_then_yes() {
    // Given / When opening the confirm for removing project 1.
    let picker = PickerState::remove_project(ProjectId(1), Focus::Sidebar);

    // Then it lists No, then Yes.
    let rows: Vec<&PickerItem> = picker.shown().map(|(item, _)| item).collect();
    assert_eq!(
        rows,
        vec![&PickerItem::Confirm(false), &PickerItem::Confirm(true)],
        "the confirm's rows"
    );
}

#[rstest::rstest]
fn remove_project_confirm_selects_no() {
    // Given / When opening the confirm for removing project 1.
    let picker = PickerState::remove_project(ProjectId(1), Focus::Sidebar);

    // Then No is highlighted, so ⏎ alone removes nothing.
    assert_eq!(
        picker.selected(),
        Some(&PickerItem::Confirm(false)),
        "No should be the default"
    );
}

#[rstest::rstest]
fn settle_session_confirm_starts_on_no() {
    // Given / When opening the confirm for settling session 9.
    let picker = PickerState::settle_session(SessionId(9), false, Focus::Sidebar);

    // Then No is highlighted, so ⏎ alone settles nothing.
    assert_eq!(
        picker.selected(),
        Some(&PickerItem::Confirm(false)),
        "No should be the default"
    );
}

/// The session picker over sessions 1 (`work/alpha`) and 2
/// (`work/zulu`), each previewing its own agent, with session 1
/// selected.
fn two_agent_picker() -> PickerState {
    let row = |id, title: &str| PickerItem::Session {
        id: SessionId(id),
        agent: AgentId(id),
        pane: PaneId(id),
        label: format!("work/{title}"),
        split: 5,
        settled: false,
    };
    PickerState::sessions(vec![row(1, "alpha"), row(2, "zulu")], Focus::Sidebar)
}

fn reply(text: &str) -> Vec<Exchange> {
    vec![Exchange {
        reply: Some((text.to_owned(), None)),
        ..Exchange::default()
    }]
}

#[rstest::rstest]
fn show_preview_for_the_selected_agent_is_shown() {
    // Given the session picker with agent 1 selected.
    let mut picker = two_agent_picker();

    // When showing a preview read from agent 1's transcript.
    picker.show_preview(AgentId(1), 10, reply("Done"));

    // Then the picker's preview is that read.
    assert_eq!(
        picker
            .preview()
            .map(|preview| (preview.agent, preview.len, preview.exchanges.clone())),
        Some((AgentId(1), 10, reply("Done"))),
        "the selected agent's preview should be shown"
    );
}

#[rstest::rstest]
fn show_preview_for_an_agent_no_longer_selected_is_dropped() {
    // Given the session picker moved from agent 1 to agent 2.
    let mut picker = two_agent_picker();
    picker.next();

    // When a late read for agent 1 arrives.
    picker.show_preview(AgentId(1), 10, reply("Done"));

    // Then no preview is shown.
    assert!(
        picker.preview().is_none(),
        "a read for an old selection should be dropped"
    );
}

#[rstest::rstest]
#[case::unread(None, true)]
#[case::same(Some(10), false)]
#[case::grown(Some(5), true)]
fn wants_preview_when_the_read_length_differs(
    #[case] read_at: Option<u64>,
    #[case] expected: bool,
) {
    // Given the session picker on agent 1, its preview read at `read_at`.
    let mut picker = two_agent_picker();
    if let Some(len) = read_at {
        picker.show_preview(AgentId(1), len, vec![]);
    }

    // When asking whether a 10-byte transcript needs reading.
    let wants = picker.wants_preview(10);

    // Then it does only when the read length differs.
    assert_eq!(wants, expected, "preview read at {read_at:?}");
}

/// A hit row with message id `id` in agent `agent`.
fn hit(id: i64, agent: i64) -> PickerItem {
    PickerItem::Hit {
        id,
        agent: AgentId(agent),
        label: format!("orb/agent-{agent}"),
        split: 4,
        snippet: "the IntentHandler match".to_owned(),
        lit: Vec::new(),
        text_lit: Vec::new(),
        path: PathBuf::from(format!("/t/{agent}.jsonl")),
        prompt_offset: 0,
    }
}

/// The search picker, with nothing typed, listing `items`.
fn searching(items: Vec<PickerItem>) -> PickerState {
    let mut picker = PickerState::search(Focus::Sidebar);
    picker.show_hits("", items, false);
    picker
}

fn hit_ids(picker: &PickerState) -> Vec<i64> {
    picker
        .shown()
        .filter_map(|(item, _)| match item {
            PickerItem::Hit { id, .. } => Some(*id),
            _ => None,
        })
        .collect()
}

#[rstest::rstest]
fn selected_agent_is_the_selected_hits_agent() {
    // Given the search picker over a hit in agent 7.
    let picker = searching(vec![hit(1, 7)]);

    // When asking for the selected agent.
    let agent = picker.selected_agent_id();

    // Then it is the hit's agent.
    assert_eq!(agent, Some(AgentId(7)), "a hit should select its agent");
}

#[rstest::rstest]
fn typing_in_the_search_picker_keeps_its_rows_and_selection() {
    // Given the search picker over two hits, the second selected.
    let mut picker = searching(vec![hit(1, 7), hit(2, 8)]);
    picker.next();

    // When typing a character.
    picker.insert('x');

    // Then the rows and the selection are untouched.
    assert_eq!(
        (hit_ids(&picker), picker.selection()),
        (vec![1, 2], 1),
        "typing should neither refilter nor reselect hits"
    );
}

#[rstest::rstest]
fn show_hits_for_a_query_no_longer_typed_is_ignored() {
    // Given the search picker with `ab` typed.
    let mut picker = searching(Vec::new());
    picker.insert('a');
    picker.insert('b');

    // When the hits for `a` arrive.
    picker.show_hits("a", vec![hit(1, 7)], false);

    // Then nothing is listed.
    assert_eq!(picker.total(), 0, "a stale result should be ignored");
}

/// Agent `id` titled `title`, in session `id`, its last chat at second
/// `secs`.
fn agent(id: i64, title: &str, secs: u64) -> Agent {
    let at = UNIX_EPOCH + Duration::from_secs(secs);
    Agent {
        harness: HarnessId::new("claude"),
        id: AgentId(id),
        title: Some(title.to_owned()),
        cwd: PathBuf::from(format!("/code/{id}")),
        transcript: None,
        status: AgentStatus::Idle,
        turn_started_at: None,
        pane: Some(PaneLaunch {
            pane: PaneId(id),
            session: SessionId(id),
        }),
        last_session: Some(SessionId(id)),
        branch: None,
        created_at: UNIX_EPOCH,
        last_activity_at: at,
        unseen: false,
        model: None,
    }
}

/// Project `orb` holding `agents`, each in its own session.
fn orb_sessions(agents: Vec<Agent>) -> Sessions {
    let projects = vec![Project {
        id: ProjectId(1),
        title: "orb".to_owned(),
        root: PathBuf::from("/code/orb"),
        created_at: UNIX_EPOCH,
        agents,
        repo: true,
        removed: false,
        kind: ProjectKind::Normal,
    }];
    Sessions {
        sessions: sessions_for(&projects),
        projects,
        ..Sessions::default()
    }
}

/// The session ids of `items`, in order.
fn session_ids(items: &[PickerItem]) -> Vec<SessionId> {
    items
        .iter()
        .filter_map(|item| match item {
            PickerItem::Session { id, .. } => Some(*id),
            _ => None,
        })
        .collect()
}

/// The agent ids of `items`, in order.
fn agent_ids(items: &[PickerItem]) -> Vec<AgentId> {
    items
        .iter()
        .filter_map(|item| match item {
            PickerItem::Session { agent, .. } => Some(*agent),
            _ => None,
        })
        .collect()
}

/// `agent`, moved into pane `agent`'s id of session `session`.
fn in_session(agent: Agent, session: i64) -> Agent {
    Agent {
        pane: Some(PaneLaunch {
            pane: PaneId(agent.id.0),
            session: SessionId(session),
        }),
        last_session: Some(SessionId(session)),
        ..agent
    }
}

/// Session 1 running agents 1 (`api`, idle, chatting at second 10) and
/// 2 (`ui`, working, chatting at second 20).
fn two_agents() -> Sessions {
    orb_sessions(vec![
        agent(1, "api", 10),
        in_session(with_status(agent(2, "ui", 20), AgentStatus::Working), 1),
    ])
}

#[rstest::rstest]
fn session_with_two_agents_lists_two_rows() {
    // Given session 1 running two agents.
    let sessions = two_agents();

    // When listing the session picker's rows.
    let items = session_items(
        &sessions,
        &layouts_for(&sessions.projects),
        SessionFilter::All,
        false,
        None,
    );

    // Then each agent has a row.
    assert_eq!(items.len(), 2, "one row per agent");
}

#[rstest::rstest]
fn shell_only_session_lists_no_row() {
    // Given session 1 with only a shell left.
    let mut sessions = orb_sessions(vec![agent(1, "api", 10)]);
    for project in &mut sessions.projects {
        project.agents.clear();
    }

    // When listing the session picker's rows.
    let items = session_items(
        &sessions,
        &layouts_for(&sessions.projects),
        SessionFilter::All,
        false,
        None,
    );

    // Then nothing is listed.
    assert!(items.is_empty(), "a session without agents has no row");
}

/// The label of `items`' first row.
fn first_label(items: &[PickerItem]) -> Option<&str> {
    match items.first() {
        Some(PickerItem::Session { label, .. }) => Some(label),
        _ => None,
    }
}

#[rstest::rstest]
fn agent_row_is_labelled_project_session_and_agent() {
    // Given agent `fix` in session `auth` of project `work`.
    let mut sessions = orb_sessions(vec![agent(1, "fix", 10)]);
    for project in &mut sessions.projects {
        project.title = "work".to_owned();
    }
    for session in &mut sessions.sessions {
        session.name = Some("auth".to_owned());
    }

    // When listing the session picker's rows.
    let items = session_items(
        &sessions,
        &layouts_for(&sessions.projects),
        SessionFilter::All,
        false,
        None,
    );

    // Then its row is `work/auth/fix`.
    assert_eq!(
        first_label(&items),
        Some("work/auth/fix"),
        "a row names its project, session and agent"
    );
}

#[rstest::rstest]
fn agent_row_ends_in_its_panes_name() {
    // Given agent `fix` in pane 1, which the user named `api`.
    let sessions = orb_sessions(vec![agent(1, "fix", 10)]);
    let layouts = {
        let mut layouts = Layouts::default();
        layouts.insert(
            SessionId(1),
            SessionLayout::of(crate::feat::layout::state::test_entry(1)),
        );
        layouts.rename_pane(PaneId(1), Some("api".to_owned()));
        layouts
    };

    // When listing the session picker's rows.
    let items = session_items(&sessions, &layouts, SessionFilter::All, false, None);

    // Then its row ends in the pane's name.
    assert!(
        first_label(&items).is_some_and(|label| label.ends_with("/api")),
        "a named pane's row ends in its name: {:?}",
        first_label(&items)
    );
}

#[rstest::rstest]
fn untitled_agent_row_ends_in_new_agent() {
    // Given an untitled agent in an unnamed pane.
    let sessions = orb_sessions(vec![Agent {
        title: None,
        ..agent(1, "fix", 10)
    }]);

    // When listing the session picker's rows.
    let items = session_items(
        &sessions,
        &layouts_for(&sessions.projects),
        SessionFilter::All,
        false,
        None,
    );

    // Then its row ends in `New agent`.
    assert!(
        first_label(&items).is_some_and(|label| label.ends_with("/New agent")),
        "an untitled agent's row ends in New agent: {:?}",
        first_label(&items)
    );
}

#[rstest::rstest]
fn agent_rows_list_newest_chat_first() {
    // Given session 1, agent 2 chatting after agent 1.
    let sessions = two_agents();

    // When listing the session picker's rows.
    let items = session_items(
        &sessions,
        &layouts_for(&sessions.projects),
        SessionFilter::All,
        false,
        None,
    );

    // Then agent 2 comes first.
    assert_eq!(
        agent_ids(&items),
        vec![AgentId(2), AgentId(1)],
        "the newest chat should lead"
    );
}

#[rstest::rstest]
fn working_filter_leaves_out_an_idle_sibling() {
    // Given session 1 running idle agent 1 and working agent 2.
    let sessions = two_agents();

    // When listing the rows under Working.
    let items = session_items(
        &sessions,
        &layouts_for(&sessions.projects),
        SessionFilter::Working,
        false,
        None,
    );

    // Then only agent 2 is listed.
    assert_eq!(
        agent_ids(&items),
        vec![AgentId(2)],
        "only the working agent should be listed"
    );
}

#[rstest::rstest]
fn idle_filter_lists_an_idle_agent_beside_a_working_sibling() {
    // Given session 1 running idle agent 1 and working agent 2.
    let sessions = two_agents();

    // When listing the rows under Idle.
    let items = session_items(
        &sessions,
        &layouts_for(&sessions.projects),
        SessionFilter::Idle,
        false,
        None,
    );

    // Then agent 1 is listed.
    assert_eq!(
        agent_ids(&items),
        vec![AgentId(1)],
        "the idle agent should be listed by its own status"
    );
}

#[rstest::rstest]
fn settled_filter_lists_a_settled_sessions_agents() {
    // Given settled session 1 running two agents.
    let mut sessions = two_agents();
    for session in &mut sessions.sessions {
        session.settled_at = Some(UNIX_EPOCH + Duration::from_secs(30));
    }

    // When listing the rows under Settled.
    let items = session_items(
        &sessions,
        &layouts_for(&sessions.projects),
        SessionFilter::Settled,
        false,
        None,
    );

    // Then both agents are listed.
    assert_eq!(
        agent_ids(&items),
        vec![AgentId(2), AgentId(1)],
        "a settled session's agents should all be listed"
    );
}

#[rstest::rstest]
fn typing_a_session_name_shows_only_its_agents() {
    // Given session `auth` running agents 1 and 2, and session `ui`
    // running agent 3.
    let mut sessions = orb_sessions(vec![
        agent(1, "fix", 10),
        in_session(agent(2, "lint", 20), 1),
        agent(3, "api", 30),
    ]);
    for session in &mut sessions.sessions {
        session.name = Some(
            if session.id == SessionId(1) {
                "auth"
            } else {
                "ui"
            }
            .to_owned(),
        );
    }
    let mut picker = PickerState::sessions(
        session_items(
            &sessions,
            &layouts_for(&sessions.projects),
            SessionFilter::All,
            false,
            None,
        ),
        Focus::Sidebar,
    );

    // When typing `auth`.
    for ch in ['a', 'u', 't', 'h'] {
        picker.insert(ch);
    }

    // Then only `auth`'s agents are shown.
    let shown: Vec<PickerItem> = picker.shown().map(|(item, _)| item.clone()).collect();
    assert_eq!(
        agent_ids(&shown),
        vec![AgentId(2), AgentId(1)],
        "only the typed session's agents should show"
    );
}

#[rstest::rstest]
fn selected_agent_is_the_rows_session_and_pane() {
    // Given the session picker on session 1's agent in pane 1.
    let picker = two_agent_picker();

    // When asking for the selected agent.
    let agent = picker.selected_agent();

    // Then it is session 1's pane 1.
    assert_eq!(
        agent,
        Some((SessionId(1), PaneId(1))),
        "an agent row selects its session and pane"
    );
}

#[rstest::rstest]
#[case::all(SessionFilter::All, vec![SessionId(1)])]
#[case::settled(SessionFilter::Settled, vec![SessionId(2)])]
fn session_items_list_settled_sessions_only_under_settled(
    #[case] filter: SessionFilter,
    #[case] expected: Vec<SessionId>,
) {
    // Given session 1 and settled session 2.
    let mut sessions = orb_sessions(vec![agent(1, "api", 10), agent(2, "ui", 20)]);
    if let Some(session) = sessions.sessions.get_mut(1) {
        session.settled_at = Some(UNIX_EPOCH + Duration::from_secs(20));
    }

    // When listing the rows under `filter`.
    let items = session_items(
        &sessions,
        &layouts_for(&sessions.projects),
        filter,
        false,
        None,
    );

    // Then the settled session shows only under Settled, alone.
    assert_eq!(session_ids(&items), expected, "filter: {filter:?}");
}

/// `agent` with status `status`.
fn with_status(agent: Agent, status: AgentStatus) -> Agent {
    Agent { status, ..agent }
}

#[rstest::rstest]
#[case::approval_blocked(AgentStatus::NeedsApproval, SessionFilter::Blocked, true)]
#[case::input_blocked(AgentStatus::NeedsInput, SessionFilter::Blocked, true)]
#[case::working(AgentStatus::Working, SessionFilter::Working, true)]
#[case::idle(AgentStatus::Idle, SessionFilter::Idle, true)]
#[case::unknown_idle(AgentStatus::Unknown, SessionFilter::Idle, true)]
#[case::idle_not_working(AgentStatus::Idle, SessionFilter::Working, false)]
#[case::working_not_blocked(AgentStatus::Working, SessionFilter::Blocked, false)]
#[case::failed_not_blocked(AgentStatus::Failed, SessionFilter::Blocked, false)]
#[case::failed_not_working(AgentStatus::Failed, SessionFilter::Working, false)]
#[case::failed_not_idle(AgentStatus::Failed, SessionFilter::Idle, false)]
#[case::failed_all(AgentStatus::Failed, SessionFilter::All, true)]
#[case::stopped_not_blocked(AgentStatus::Stopped, SessionFilter::Blocked, false)]
#[case::stopped_not_working(AgentStatus::Stopped, SessionFilter::Working, false)]
#[case::stopped_not_idle(AgentStatus::Stopped, SessionFilter::Idle, false)]
#[case::stopped_all(AgentStatus::Stopped, SessionFilter::All, true)]
#[case::gone_not_blocked(AgentStatus::Gone, SessionFilter::Blocked, false)]
#[case::gone_not_working(AgentStatus::Gone, SessionFilter::Working, false)]
#[case::gone_not_idle(AgentStatus::Gone, SessionFilter::Idle, false)]
#[case::gone_all(AgentStatus::Gone, SessionFilter::All, true)]
fn session_items_filter_by_status(
    #[case] status: AgentStatus,
    #[case] filter: SessionFilter,
    #[case] listed: bool,
) {
    // Given session 1, its agent `status`.
    let sessions = orb_sessions(vec![with_status(agent(1, "api", 10), status)]);

    // When listing the rows under `filter`.
    let items = session_items(
        &sessions,
        &layouts_for(&sessions.projects),
        filter,
        false,
        None,
    );

    // Then the session is listed only when the filter lets it through.
    assert_eq!(
        !items.is_empty(),
        listed,
        "{status:?} under {filter:?} listed"
    );
}

#[rstest::rstest]
fn set_filter_twice_goes_back_to_all() {
    // Given the session picker filtered to working agents.
    let sessions = orb_sessions(vec![agent(1, "api", 10)]);
    let mut picker = PickerState::sessions(
        session_items(
            &sessions,
            &layouts_for(&sessions.projects),
            SessionFilter::All,
            false,
            None,
        ),
        Focus::Sidebar,
    );
    picker.set_filter(
        SessionFilter::Working,
        &sessions,
        &layouts_for(&sessions.projects),
    );

    // When setting the working filter again.
    picker.set_filter(
        SessionFilter::Working,
        &sessions,
        &layouts_for(&sessions.projects),
    );

    // Then the picker is back on all.
    assert_eq!(
        picker.kind(),
        &PickerKind::Sessions {
            filter: SessionFilter::All,
            colonists: false,
            scope: None
        },
        "the same filter twice should go back to all"
    );
}

#[rstest::rstest]
fn set_filter_keeps_the_typed_text() {
    // Given the session picker over `api` and `ui`, with `api` typed.
    let sessions = orb_sessions(vec![agent(1, "api", 10), agent(2, "ui", 20)]);
    let mut picker = PickerState::sessions(
        session_items(
            &sessions,
            &layouts_for(&sessions.projects),
            SessionFilter::All,
            false,
            None,
        ),
        Focus::Sidebar,
    );
    for ch in ['a', 'p', 'i'] {
        picker.insert(ch);
    }

    // When filtering to idle agents.
    picker.set_filter(
        SessionFilter::Idle,
        &sessions,
        &layouts_for(&sessions.projects),
    );

    // Then the typed text stays.
    assert_eq!(
        picker.input(),
        "api",
        "filtering should keep the typed text"
    );
}

#[rstest::rstest]
fn set_filter_in_another_picker_changes_nothing() {
    // Given the worktree picker over no rows.
    let sessions = orb_sessions(vec![agent(1, "api", 10)]);
    let mut picker = PickerState::worktrees(vec![], Focus::Sidebar);

    // When filtering to settled agents.
    picker.set_filter(
        SessionFilter::Settled,
        &sessions,
        &layouts_for(&sessions.projects),
    );

    // Then it is still the empty worktree picker.
    assert_eq!(
        (picker.kind(), picker.total()),
        (&PickerKind::Worktrees, 0),
        "other pickers should ignore the filter"
    );
}

#[rstest::rstest]
fn session_row_previews_its_agent() {
    // Given session 1 running agent 1.
    let sessions = orb_sessions(vec![agent(1, "api", 10)]);

    // When opening the session picker over its rows.
    let picker = PickerState::sessions(
        session_items(
            &sessions,
            &layouts_for(&sessions.projects),
            SessionFilter::All,
            false,
            None,
        ),
        Focus::Sidebar,
    );

    // Then the selected row previews agent 1.
    assert_eq!(
        picker.selected_agent_id(),
        Some(AgentId(1)),
        "a session row should preview its agent"
    );
}

#[rstest::rstest]
fn hit_label_names_an_agents_session() {
    // Given agent 1 in session 1, which the user named `login`.
    let mut sessions = orb_sessions(vec![agent(1, "api", 10)]);
    if let Some(session) = sessions.sessions.first_mut() {
        session.name = Some("login".to_owned());
    }

    // When labelling a hit in agent 1.
    let label = sessions
        .projects
        .first()
        .zip(sessions.all_agents().next())
        .map(|(project, agent)| hit_label(&sessions, project, agent));

    // Then the session names it and the title starts after its slash.
    assert_eq!(
        label,
        Some(("orb/login".to_owned(), 4)),
        "a hit should be labelled by its session"
    );
}

#[rstest::rstest]
fn hit_label_falls_back_to_the_agents_title() {
    // Given agent 1 that never ran in a session.
    let sessions = orb_sessions(vec![Agent {
        pane: None,
        last_session: None,
        ..agent(1, "api", 10)
    }]);

    // When labelling a hit in agent 1.
    let label = sessions
        .projects
        .first()
        .zip(sessions.all_agents().next())
        .map(|(project, agent)| hit_label(&sessions, project, agent));

    // Then the agent's title names it.
    assert_eq!(
        label,
        Some(("orb/api".to_owned(), 4)),
        "a hit without a session should be labelled by its agent"
    );
}

#[rstest::rstest]
fn picked_session_of_a_hit_is_its_ended_agents_session() {
    // Given agent 1 that ended in session 1, and the search picker over a
    // hit in it.
    let sessions = {
        let mut sessions = orb_sessions(vec![agent(1, "api", 10)]);
        if let Some(agent) = sessions
            .projects
            .first_mut()
            .and_then(|p| p.agents.first_mut())
        {
            agent.pane = None;
        }
        sessions
    };
    let picker = searching(vec![hit(1, 1)]);

    // When asking which session the pick opens.
    let session = picker.picked_session(&sessions);

    // Then it is the session the agent ran in.
    assert_eq!(
        session,
        Some(SessionId(1)),
        "a hit on an ended agent should open its session"
    );
}

fn other_picker(which: &str) -> PickerState {
    match which {
        "projects" => PickerState::projects(vec![], Focus::Sidebar),
        "project_filter" => PickerState::project_filter(vec![], None, Focus::Sidebar),
        "remove_project" => PickerState::remove_project(ProjectId(1), Focus::Sidebar),
        "directories" => PickerState::directories(PathBuf::from("/home"), Focus::Sidebar).0,
        _ => PickerState::search(Focus::Sidebar),
    }
}

#[rstest::rstest]
#[case::worktrees(PickerState::worktrees(vec![], Focus::Sidebar))]
#[case::sessions(PickerState::sessions(vec![], Focus::Sidebar))]
#[case::manage_projects(PickerState::manage_projects(vec![], Focus::Sidebar))]
fn list_mode_pickers_open_listing(#[case] picker: PickerState) {
    // Given / When opening a list-mode picker.

    // Then it is in list mode.
    assert!(picker.listing(), "the picker should open in list mode");
}

#[rstest::rstest]
#[case("projects")]
#[case("project_filter")]
#[case("remove_project")]
#[case("directories")]
#[case("search")]
fn other_pickers_never_list(#[case] which: &str) {
    // Given / When opening a picker without list mode.
    let picker = other_picker(which);

    // Then it is not in list mode.
    assert!(!picker.listing(), "the {which} picker should not list");
}

#[rstest::rstest]
#[case("projects")]
#[case("project_filter")]
#[case("remove_project")]
#[case("directories")]
#[case("search")]
fn other_pickers_ignore_start_search(#[case] which: &str) {
    // Given a picker without list mode.
    let mut picker = other_picker(which);

    // When starting a search.
    picker.start_search();

    // Then it is not in a list-mode picker's search mode.
    assert!(!picker.searching(), "the {which} picker should not search");
}
