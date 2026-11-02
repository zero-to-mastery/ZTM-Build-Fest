//! Bringing back orb's saved projects, agents, sessions and layouts at start.

use super::*;

impl SessionsActor {
    /// Shows the saved projects and agents, sizes the sidebar as it
    /// was saved, kept within its bounds, filters it to the saved project if
    /// that's still shown and not removed, and selects its first row. Each
    /// project learns whether it is a git repository. The saved jump list comes back
    /// without the rows that no longer exist, and every session's layout comes
    /// back as it was saved. orb's Incognito, Research and Learn projects are
    /// added (or un-removed) first, and Incognito's folder made; each is added
    /// even when another fails.
    #[expect(
        clippy::too_many_lines,
        reason = "brings back every saved piece of the sidebar and layouts in one place"
    )]
    pub(super) fn restore(deps: SessionsActorDeps) -> Self {
        let SessionsActorDeps {
            services,
            state,
            store,
            worktrees_root,
            orb_root,
            incognito_root,
            report,
            integration_missing,
        } = deps;
        if let Err(error) = fs::create_dir_all(&incognito_root) {
            services.log.error(
                &format!(
                    "couldn't make the incognito folder {}",
                    incognito_root.display()
                ),
                &error,
            );
        }
        let added = {
            let now = now_ms();
            std::iter::once((incognito_root.clone(), "Incognito", ProjectKind::Incognito))
                .chain(
                    [FolderKind::Research, FolderKind::Learn]
                        .map(own_folder)
                        .map(|(kind, dir, title)| (orb_root.join(dir), title, kind)),
                )
                .map(|(root, title, kind)| store.add_project(&root, title, kind, now).map(drop))
                .fold(Ok(()), Result::and)
        };
        let RestoredLayouts {
            sessions: session_rows,
            layouts,
            unread,
            error: layouts_error,
        } = restore_layouts(&store, &services, &orb_root);
        let partial_load = layouts_error.is_some();
        let (projects, rows, error) = match store.load() {
            Ok((projects, rows)) => (
                projects,
                rows,
                added
                    .err()
                    .map(|report| save_failed(&services.log, &report)),
            ),
            Err(report) => (
                Vec::new(),
                Vec::new(),
                Some(failed(
                    &services.log,
                    "couldn't load orb's saved sessions",
                    &report,
                )),
            ),
        };
        let error = error.or(layouts_error);
        {
            let mut app = state.write();
            for (session, layout) in layouts {
                app.layouts.insert(session, layout);
            }
        }
        let agents: Vec<Agent> = {
            let app = state.read();
            rows.iter()
                .map(|row| unpolled(&services, row, &app.layouts, &unread))
                .collect()
        };
        let projects: Vec<Project> = projects
            .into_iter()
            .map(|project| Project {
                agents: rows
                    .iter()
                    .zip(&agents)
                    .filter(|(row, _)| row.project_id == project.id)
                    .map(|(_, agent)| agent.clone())
                    .collect(),
                // ponytail: one git call per project at start; cache it if
                // many projects make start-up slow.
                repo: project.kind == ProjectKind::Normal
                    && services.git.project_path(&project.root).is_some(),
                id: project.id,
                title: project.title,
                root: project.root,
                created_at: from_ms(project.created_at),
                removed: project.removed_at.is_some(),
                kind: project.kind,
            })
            .collect();
        let ui = store.ui().unwrap_or_default();
        let filter = ui.project_filter.filter(|&id| {
            projects
                .iter()
                .any(|project| project.id == id && !project.removed)
        });
        let jumps = {
            let saved = store.jumps().unwrap_or_default();
            JumpList::from_saved(
                saved
                    .into_iter()
                    .filter(|&item| exists(&session_rows, item))
                    .collect(),
            )
        };
        {
            let mut guard = state.write();
            let app = &mut *guard;
            app.sidebar.width = ui.sidebar_width.map_or(DEFAULT_WIDTH, clamp_width);
            app.jumps = jumps;
            app.harnesses = services.harnesses.infos();
            let sessions = &mut app.sessions;
            sessions.projects = projects;
            sessions.sessions = {
                let mut shown: Vec<Session> = session_rows.values().map(show_session).collect();
                shown.sort_by_key(|session| session.id.0);
                shown
            };
            sessions.cursor = None;
            sessions.partial_load = partial_load;
            sessions.filter_to(filter, &app.layouts);
        }
        if let Some(error) = error.or_else(|| integration_missing.then(|| NUDGE.to_owned())) {
            report.report(Outcome::Failed(error));
        }
        report.changed();
        Self {
            services,
            state,
            store,
            worktrees_root,
            pane_files: PaneFiles::new(panes_dir(&orb_root)),
            orb_root,
            report,
            poke: Arc::default(),
            rows,
            sessions: session_rows,
            unread,
            pane_reports: HashMap::new(),
        }
    }
}

/// How a saved agent looks before its first poll; one whose harness orb
/// doesn't know is Gone.
pub(super) fn unpolled(
    services: &Services,
    row: &AgentRow,
    layouts: &Layouts,
    unread: &HashMap<SessionId, Unread>,
) -> Agent {
    let status = match services.harnesses.get(&row.harness) {
        Some(_) => AgentStatus::Unknown,
        None => AgentStatus::Gone,
    };
    agent(row, status, pane_launch(row, layouts, unread))
}

/// `row`'s pane and its session; `None` for an agent with no pane, or one
/// whose pane no layout or unread tab holds.
pub(super) fn pane_launch(
    row: &AgentRow,
    layouts: &Layouts,
    unread: &HashMap<SessionId, Unread>,
) -> Option<PaneLaunch> {
    let pane = row.pane_id?;
    pane_home(layouts, unread, pane).map(|(session, _)| PaneLaunch { pane, session })
}

/// Pane `pane`'s session and where it runs: as a layout holds it, else as
/// a tab orb couldn't read at start keeps it.
pub(super) fn pane_home<'a>(
    layouts: &'a Layouts,
    unread: &'a HashMap<SessionId, Unread>,
    pane: PaneId,
) -> Option<(SessionId, &'a PaneEntry)> {
    layouts.owner_of(pane).zip(layouts.entry(pane)).or_else(|| {
        unread.iter().find_map(|(&session, kept)| {
            Some((session, kept.panes.iter().find(|entry| entry.id == pane)?))
        })
    })
}

/// Where each of session `id`'s panes runs, in pane order: the ones its
/// layout holds, the ones its unread tabs keep, and the ones no saved tab
/// held at start.
pub(super) fn session_entries(
    layouts: &Layouts,
    unread: &HashMap<SessionId, Unread>,
    id: SessionId,
) -> Vec<PaneEntry> {
    let mut entries: Vec<PaneEntry> = layouts
        .get(id)
        .into_iter()
        .flat_map(SessionLayout::panes)
        .chain(
            unread
                .get(&id)
                .into_iter()
                .flat_map(|kept| kept.panes.iter().chain(&kept.loose)),
        )
        .cloned()
        .collect();
    entries.sort_by_key(|entry| entry.id.0);
    entries
}

/// Where pane `row`'s program runs: its kept zmx session, on a socket dir
/// under orb's folder unless the dir is absolute (orb's pane dir when none),
/// else `orb-p<id>` on orb's pane dir.
pub(super) fn pane_entry(services: &Services, orb_root: &Path, row: &PaneRow) -> PaneEntry {
    let zmx = match &row.zmx_name {
        Some(name) => ZmxSession {
            name: name.clone(),
            dir: row
                .zmx_dir
                .as_ref()
                .map_or_else(|| services.zmx.dir().to_owned(), |dir| orb_root.join(dir)),
        },
        None => services.zmx.session(row.id.zmx_name()),
    };
    PaneEntry {
        id: row.id,
        zmx,
        cwd: row.cwd.clone(),
        name: row.name.clone(),
        resume: row.resume.clone(),
    }
}

/// What the store's saved layouts restore to.
struct RestoredLayouts {
    /// Every saved session.
    sessions: HashMap<SessionId, SessionRow>,
    /// Each session's layout.
    layouts: Vec<(SessionId, SessionLayout)>,
    /// What couldn't be read of each session's layout, kept as saved.
    unread: HashMap<SessionId, Unread>,
    /// Why some or all of them couldn't be read.
    error: Option<String>,
}

/// The message for saved layouts that couldn't all be read, with `report`'s
/// reason: its attachments and the errors under its own, outermost first.
fn unread_message<C>(report: &Report<C>) -> String
where
    C: Send + Sync + 'static,
{
    let reason: Vec<String> = report
        .frames()
        .filter_map(|frame| match frame.kind() {
            FrameKind::Attachment(AttachmentKind::Printable(printable)) => {
                Some(printable.to_string())
            }
            FrameKind::Context(context) if !frame.is::<C>() => Some(context.to_string()),
            _ => None,
        })
        .collect();
    format!(
        "couldn't fully read orb's saved layouts ({}); orb keeps what it couldn't read",
        reason.join(": ")
    )
}

/// Every saved session's layout: its tabs by position, each in its saved swap
/// layout with its mark, focused on its saved pane (else its first), showing
/// its saved tab, its floats hidden in their saved places with their mark, with where each
/// pane runs. A tab whose tree doesn't read is left out, and so is a session
/// left with no tab; both are kept in `unread`, and so is each pane no read
/// tab or float holds. Nothing comes back when the store can't be read.
fn restore_layouts(store: &Store, services: &Services, orb_root: &Path) -> RestoredLayouts {
    let saved = match store.layouts() {
        Ok(saved) => saved,
        Err(report) => {
            services
                .log
                .error("couldn't fully read orb's saved layouts", &report);
            return RestoredLayouts {
                sessions: HashMap::new(),
                layouts: Vec::new(),
                unread: HashMap::new(),
                error: Some(unread_message(&report)),
            };
        }
    };
    let mut error = None;
    let mut unread: HashMap<SessionId, Unread> = HashMap::new();
    let layouts = saved
        .sessions
        .iter()
        .filter_map(|session| {
            let tabs: Vec<Tab> = saved
                .tabs
                .iter()
                .filter(|tab| tab.session_id == session.id)
                .filter_map(|tab| {
                    let focus = tab.focus_pane.unwrap_or(PaneId(0));
                    match TileLayout::from_json(&tab.layout, focus) {
                        Ok(tree) => Some(Tab::restore(
                            tab.name.clone(),
                            tree,
                            tab.swap_layout,
                            tab.hand_changed,
                        )),
                        Err(report) => {
                            services
                                .log
                                .error("couldn't fully read orb's saved layouts", &report);
                            error.get_or_insert_with(|| unread_message(&report));
                            unread.entry(session.id).or_default().tabs.push(tab.clone());
                            None
                        }
                    }
                })
                .collect();
            let panes: Vec<PaneEntry> = saved
                .panes
                .iter()
                .filter(|pane| pane.session_id == session.id)
                .map(|pane| pane_entry(services, orb_root, pane))
                .collect();
            let layout = (!tabs.is_empty()).then(|| {
                let floats = Floats::restore(
                    saved
                        .floats
                        .iter()
                        .filter(|row| row.session_id == session.id)
                        .map(|row| Float {
                            pane: row.pane_id,
                            rect: row.rect,
                            pinned: row.pinned,
                        })
                        .collect(),
                    session.float_layout,
                    session.floats_hand_changed,
                );
                SessionLayout::restore(tabs, session.active_tab, panes.clone(), floats)
            });
            let not_held: Vec<PaneEntry> = panes
                .iter()
                .filter(|kept| {
                    layout
                        .as_ref()
                        .is_none_or(|layout| !layout.panes().any(|entry| entry.id == kept.id))
                })
                .cloned()
                .collect();
            if !not_held.is_empty() {
                let kept = unread.entry(session.id).or_default();
                if kept.tabs.is_empty() {
                    kept.loose = not_held;
                } else {
                    kept.panes = not_held;
                }
            }
            Some((session.id, layout?))
        })
        .collect();
    RestoredLayouts {
        sessions: saved
            .sessions
            .into_iter()
            .map(|row| (row.id, row))
            .collect(),
        layouts,
        unread,
        error,
    }
}
