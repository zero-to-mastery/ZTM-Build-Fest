//! Adding panes and saving layouts, the sidebar and the jump list.

use super::*;

impl SessionsActor {
    /// Adds a shell pane in `session`'s directory where `placement` says: in
    /// the shown tab re-tiled by pane count unless it was changed by hand,
    /// splitting the focused pane, in a new tab, or as a float. A session with no layout
    /// (its last pane closed) gets a first tab of that shell from
    /// [`Placement::Tab`] and is reported ready to open once it's saved; the other
    /// placements do nothing there. Then saves the layout. A pane that can't
    /// be saved shows why.
    pub(super) fn add_pane(&mut self, session: SessionId, placement: Placement) {
        let Some(dir) = self.sessions.get(&session).map(|row| row.dir.clone()) else {
            return;
        };
        let first = self.state.read().layouts.get(session).is_none();
        if first && !matches!(placement, Placement::Tab) {
            return;
        }
        let entry = match self.shell_entry(session, dir) {
            Ok(entry) => entry,
            Err(error) => return self.report.report(Outcome::Failed(error)),
        };
        {
            let mut app = self.state.write();
            match placement {
                Placement::Tile => app.layouts.add_tiled(session, entry),
                Placement::Split(split) => app.layouts.split(session, split, entry),
                Placement::Stack => app.layouts.stack(session, entry),
                Placement::Tab if first => app.layouts.insert(session, SessionLayout::of(entry)),
                Placement::Tab => app.layouts.new_tab(session, entry),
                Placement::Float => app.layouts.add_float(session, entry),
            }
        }
        self.save_layout(session);
        self.report.changed();
        if first {
            // Entering the session asked for this tab, so it is the active one.
            self.report.report(Outcome::Ready {
                session,
                if_active: Some(session),
            });
        }
    }

    /// Adds a shell pane in `session`'s directory where an agent asked,
    /// leaving the shown tab, the focus and whether the floats show as they
    /// were, then saves the layout. Never reports the session ready. Replies
    /// with the new pane, or why there is none: the session is gone or has no
    /// layout, the pane to split or stack isn't in one of its tabs, or the
    /// pane couldn't be saved.
    pub(super) fn add_pane_at(&mut self, add: &ApiAdd) -> Result<PaneId, String> {
        let &ApiAdd { session, place } = add;
        let Some(dir) = self.sessions.get(&session).map(|row| row.dir.clone()) else {
            return Err(format!("no session {}", session.0));
        };
        if self.state.read().layouts.get(session).is_none() {
            return Err(format!("session {} has no panes", session.0));
        }
        let entry = self.shell_entry(session, dir)?;
        let id = entry.id;
        let placed = {
            let mut app = self.state.write();
            match place {
                ApiPlace::Split { at, split } => app.layouts.split_at(session, at, split, entry),
                ApiPlace::Stack { at } => app.layouts.stack_at(session, at, entry),
                ApiPlace::Tab => app.layouts.new_tab_keeping_shown(session, entry),
                ApiPlace::Float => app.layouts.add_float_hidden(session, entry),
            }
        };
        // An unplaced pane's row is dropped by the save: no tab or float holds it.
        self.save_layout(session);
        self.report.changed();
        match (placed, place) {
            (true, _) => Ok(id),
            (false, ApiPlace::Split { at, .. } | ApiPlace::Stack { at }) => {
                Err(format!("pane {} is gone", at.0))
            }
            (false, ApiPlace::Tab | ApiPlace::Float) => {
                Err(format!("session {} has no panes", session.0))
            }
        }
    }

    /// Saves a new shell pane row for `session` running in `dir`, and how
    /// it runs; on a store failure, the logged message for the user.
    fn shell_entry(&self, session: SessionId, dir: PathBuf) -> Result<PaneEntry, String> {
        let id = self
            .store
            .insert_pane(session, &dir)
            .map_err(|report| save_failed(&self.services.log, &report))?;
        let row = PaneRow {
            id,
            session_id: session,
            cwd: dir,
            zmx_name: None,
            zmx_dir: None,
            resume: None,
            name: None,
        };
        Ok(pane_entry(&self.services, &self.orb_root, &row))
    }

    /// Saves `session`'s tabs, floats, active tab and pane names as the app
    /// state has them, after them the tabs and panes orb couldn't read at
    /// start as they were saved; panes no tab or float holds any more are
    /// deleted from the store, each with its report file. A session whose layout emptied, or kept only floats, gets a
    /// new shell tab in its directory instead, saved in turn; nothing happens
    /// for one that is gone or being deleted.
    pub(super) fn save_layout(&mut self, session: SessionId) {
        let saved = {
            let app = self.state.read();
            app.layouts
                .get(session)
                .filter(|layout| !layout.tabs().is_empty())
                .map(|layout| {
                    let tabs: Vec<TabRow> = layout
                        .tabs()
                        .iter()
                        .enumerate()
                        .map(|(position, tab)| TabRow {
                            session_id: session,
                            position,
                            name: tab.name().map(str::to_owned),
                            layout: tab.layout_json(),
                            focus_pane: Some(tab.focused()),
                            swap_layout: tab.swap_layout(),
                            hand_changed: tab.hand_changed(),
                        })
                        .collect();
                    let names: Vec<(PaneId, Option<String>)> = layout
                        .panes()
                        .map(|entry| (entry.id, entry.name.clone()))
                        .collect();
                    let floats: Vec<FloatRow> = layout
                        .floats()
                        .all()
                        .iter()
                        .enumerate()
                        .map(|(position, float)| FloatRow {
                            session_id: session,
                            position,
                            pane_id: float.pane,
                            rect: float.rect,
                            pinned: float.pinned,
                        })
                        .collect();
                    let floats = SessionFloats {
                        rows: floats,
                        layout: layout.floats().layout(),
                        hand_changed: layout.floats().hand_changed(),
                    };
                    (tabs, floats, layout.active(), names)
                })
        };
        let Some((mut tabs, floats, active, mut names)) = saved else {
            let deleting = self.state.read().sessions.deleting.contains(&session);
            if self.sessions.contains_key(&session) && !deleting {
                self.add_pane(session, Placement::Tab);
            }
            return;
        };
        if let Some(unread) = self.unread.get(&session) {
            let read = tabs.len();
            tabs.extend(unread.tabs.iter().enumerate().map(|(i, tab)| TabRow {
                position: read + i,
                ..tab.clone()
            }));
            names.extend(
                unread
                    .panes
                    .iter()
                    .map(|entry| (entry.id, entry.name.clone())),
            );
        }
        match self
            .store
            .save_layout(session, active, &tabs, &floats, &names)
        {
            Ok(dropped) => {
                for pane in dropped {
                    self.services.log.line(
                        "delete",
                        &format!("pane row {} (session {})", pane.0, session.0),
                    );
                    for row in self.rows.iter_mut().filter(|row| row.pane_id == Some(pane)) {
                        row.pane_id = None;
                    }
                    self.forget_pane_report(pane);
                }
            }
            Err(report) => {
                let error = save_failed(&self.services.log, &report);
                self.report.report(Outcome::Failed(error));
            }
        }
    }

    pub(super) fn save_ui(&self) {
        let ui = {
            let app = self.state.read();
            Ui {
                sidebar_width: Some(app.sidebar.width),
                project_filter: app.sessions.filter,
            }
        };
        if let Err(report) = self.store.save_ui(&ui) {
            let error = save_failed(&self.services.log, &report);
            self.report.report(Outcome::Failed(error));
        }
    }

    /// Saves the jump list, showing why if it can't.
    pub(super) fn save_jumps(&self) {
        let jumps = self.state.read().jumps.entries().to_vec();
        if let Err(report) = self.store.save_jumps(&jumps) {
            let error = save_failed(&self.services.log, &report);
            self.report.report(Outcome::Failed(error));
        }
    }
}
