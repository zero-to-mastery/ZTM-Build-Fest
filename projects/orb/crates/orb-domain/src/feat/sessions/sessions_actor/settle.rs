//! Pinning, renaming, settling and deleting sessions, and killing their panes.

use super::*;
use crate::feat::sessions::validator::{COLONIST_WORKING, SETTLE_IN_PROGRESS};

impl SessionsActor {
    /// Pins session `id`; pinning a settled session un-settles it.
    pub(super) fn pin_session(&mut self, id: SessionId) {
        self.edit_session(id, |row, now| {
            row.pinned_at = row.pinned_at.or(Some(now));
            if row.settled_override == Some(SettledOverride::Settled) {
                unsettle_session_row(row, now);
            }
        });
    }

    pub(super) fn unpin_session(&mut self, id: SessionId) {
        self.edit_session(id, |row, _| row.pinned_at = None);
    }

    /// Gives session `id` the user's name; `None` goes back to its agents'
    /// or directory's.
    pub(super) fn rename_session(&mut self, id: SessionId, name: Option<String>) {
        self.edit_session(id, |row, _| row.name = name);
    }

    /// Session `id`'s panes: the ones its layout holds and the ones its
    /// unread tabs keep.
    pub(super) fn session_pane_ids(&self, id: SessionId) -> HashSet<PaneId> {
        let app = self.state.read();
        session_entries(&app.layouts, &self.unread, id)
            .into_iter()
            .map(|entry| entry.id)
            .collect()
    }

    /// The saved agents running in session `id`'s panes.
    pub(super) fn session_rows(&self, id: SessionId) -> impl Iterator<Item = &AgentRow> {
        let panes = self.session_pane_ids(id);
        self.rows
            .iter()
            .filter(move |row| row.pane_id.is_some_and(|pane| panes.contains(&pane)))
    }

    /// Settles session `id` unless one of its agent panes has a turn
    /// underway (a turn that started after the key press wins), then kills
    /// every pane, keeping its tabs, layout and each pane's resume command.
    pub(super) fn settle_session(&mut self, id: SessionId) {
        self.settle_all(vec![id]);
    }

    /// Settles session `id` and every unsettled session under it, or none
    /// of them while any has a turn underway.
    pub(super) fn settle_with_colonists(&mut self, id: SessionId) {
        let under = self.state.read().sessions.under(id);
        self.settle_all(std::iter::once(id).chain(under).collect());
    }

    /// Settles every session in `ids`, unless one has a turn underway: then
    /// none, and the message box says why, as the key press would.
    fn settle_all(&mut self, ids: Vec<SessionId>) {
        let working = |id| {
            self.session_rows(id)
                .any(|row| self.status(row.id).is_some_and(AgentStatus::in_progress))
        };
        let refusal = match ids.split_first() {
            Some((&first, _)) if working(first) => Some(SETTLE_IN_PROGRESS),
            Some((_, under)) if under.iter().any(|&id| working(id)) => Some(COLONIST_WORKING),
            _ => None,
        };
        if let Some(why) = refusal {
            self.report.report(Outcome::Failed(why.to_owned()));
            return;
        }
        for id in ids {
            self.edit_session(id, settle_session_row);
            self.kill_panes(id, "session settled");
        }
    }

    pub(super) fn unsettle_session(&mut self, id: SessionId) {
        self.edit_session(id, unsettle_session_row);
    }

    /// Marks the latest turn of the agent in pane `pane` seen.
    pub(super) fn visit(&mut self, pane: PaneId) {
        let unseen = self
            .rows
            .iter()
            .find(|row| row.pane_id == Some(pane) && row.last_activity_at > row.last_visited_at)
            .map(|row| row.id);
        if let Some(agent) = unseen {
            self.edit(agent, |row, now| row.last_visited_at = now);
        }
    }

    /// Deletes pane `pane`'s report file (one already gone is fine; any other
    /// failure is logged) and forgets its latest report.
    pub(super) fn forget_pane_report(&mut self, pane: PaneId) {
        if let Err(error) = fs::remove_file(self.pane_files.file(pane))
            && error.kind() != io::ErrorKind::NotFound
        {
            self.services.log.error(
                &format!("couldn't remove pane {}'s report file", pane.0),
                &error,
            );
        }
        self.pane_reports.remove(&pane);
    }

    /// Deletes every unsettled session under session `id`, then `id` itself
    /// (the list is read before the first delete clears their links), and
    /// hands back the folder removals they leave.
    #[must_use]
    pub(super) fn delete_with_colonists(&mut self, id: SessionId) -> Vec<RemoveFolder> {
        let colonists = self.state.read().sessions.below(id, false);
        colonists
            .into_iter()
            .chain(std::iter::once(id))
            .filter_map(|session| self.delete_session(session))
            .collect()
    }

    /// Deletes session `id`: kills every pane, then its tabs, panes, agents
    /// (ended ones included) and row, and forgets them. The sessions it made
    /// become top-level. A fresh-world colony's folder that is orb's own is
    /// handed back for removal beside the actor's queue.
    /// Claude transcripts, pi session files and worktrees stay. However it
    /// ends, the session is no longer hidden as being deleted.
    #[must_use]
    pub(super) fn delete_session(&mut self, id: SessionId) -> Option<RemoveFolder> {
        self.kill_panes(id, "session deleted");
        let folder = self.colony_folder(id);
        let agents: Vec<AgentId> = self
            .session_rows(id)
            .chain(self.rows.iter().filter(|row| row.orb_session == Some(id)))
            .map(|row| row.id)
            .collect();
        let panes: Vec<PaneId> = {
            let app = self.state.read();
            session_entries(&app.layouts, &self.unread, id)
                .into_iter()
                .map(|entry| entry.id)
                .collect()
        };
        let deleted = self.store.delete_session(id);
        {
            let what = format!(
                "session {} with agents {:?} and panes {:?}",
                id.0,
                sorted_ids(agents.iter().map(|agent| agent.0)),
                sorted_ids(panes.iter().map(|pane| pane.0))
            );
            match &deleted {
                Ok(()) => self.services.log.line("delete", &format!("{what}: ok")),
                Err(report) => self
                    .services
                    .log
                    .error(&format!("delete {what}: failed"), report),
            }
        }
        self.rows.retain(|row| !agents.contains(&row.id));
        for pane in panes {
            self.forget_pane_report(pane);
        }
        self.sessions.remove(&id);
        for row in self
            .sessions
            .values_mut()
            .filter(|row| row.parent == Some(id))
        {
            row.parent = None;
        }
        self.unread.remove(&id);
        {
            let mut app = self.state.write();
            app.layouts.remove(id);
            app.attached.remove(&id);
            let sessions = &mut app.sessions;
            sessions.sessions.retain(|session| session.id != id);
            for session in sessions
                .sessions
                .iter_mut()
                .filter(|session| session.parent == Some(id))
            {
                session.parent = None;
            }
            for project in &mut sessions.projects {
                project.agents.retain(|agent| !agents.contains(&agent.id));
            }
            sessions.deleting.remove(&id);
        }
        match deleted {
            Err(report) => {
                let error = save_failed(&self.services.log, &report);
                self.report.report(Outcome::Failed(error));
            }
            Ok(()) => self.report.changed(),
        }
        folder.map(|dir| self.remove_folder(dir))
    }

    /// A job that removes `dir` beside the actor's queue.
    pub(super) fn remove_folder(&self, dir: PathBuf) -> RemoveFolder {
        RemoveFolder {
            dir,
            log: self.services.log.clone(),
            report: self.report.clone(),
        }
    }

    /// Kills the panes zmx still lists for every settled session, listing
    /// each socket dir once, in pane order; each session with a pane to kill
    /// leaves the right side first. A dir zmx can't list kills nothing.
    pub(super) fn kill_settled(&self) {
        let zmx: Vec<(SessionId, ZmxSession)> = {
            let app = self.state.read();
            let mut entries: Vec<(SessionId, PaneEntry)> = self
                .sessions
                .values()
                .filter(|session| session.settled_override == Some(SettledOverride::Settled))
                .flat_map(|session| {
                    session_entries(&app.layouts, &self.unread, session.id)
                        .into_iter()
                        .map(|entry| (session.id, entry))
                })
                .collect();
            entries.sort_by_key(|(_, entry)| entry.id.0);
            entries
                .into_iter()
                .map(|(session, entry)| (session, entry.zmx))
                .collect()
        };
        let listed: HashMap<&Path, Vec<ZmxEntry>> = zmx
            .iter()
            .map(|(_, session)| session.dir.as_path())
            .collect::<HashSet<&Path>>()
            .into_iter()
            .map(|dir| {
                let listed = self
                    .services
                    .zmx
                    .list(dir)
                    .inspect_err(|report| {
                        self.services.log.error(
                            &format!("couldn't list zmx sessions on {}", dir.display()),
                            report,
                        );
                    })
                    .unwrap_or_default();
                (dir, listed)
            })
            .collect();
        let running: Vec<&(SessionId, ZmxSession)> = zmx
            .iter()
            .filter(|(_, session)| {
                listed
                    .get(session.dir.as_path())
                    .is_some_and(|entries| entries.iter().any(|entry| entry.name == session.name))
            })
            .collect();
        self.state
            .write()
            .attached
            .retain(|shown| !running.iter().any(|(owner, _)| owner == shown));
        for (_, session) in running {
            self.services.zmx.kill(session, "session settled");
        }
    }

    /// Takes session `id` off the right side, then runs `zmx kill` on each
    /// of its panes in pane order; each kill is logged with `why`. The state
    /// lock is released before the first kill.
    pub(super) fn kill_panes(&self, id: SessionId, why: &str) {
        let zmx: Vec<ZmxSession> = {
            let mut app = self.state.write();
            app.attached.remove(&id);
            session_entries(&app.layouts, &self.unread, id)
                .into_iter()
                .map(|entry| entry.zmx)
                .collect()
        };
        for session in &zmx {
            self.services.zmx.kill(session, why);
        }
    }

    /// Session `id`'s folder when it is a colony in a fresh world and the
    /// folder is in that world's colonies folder: deleting the session
    /// removes it, even while another session still runs in it.
    fn colony_folder(&self, id: SessionId) -> Option<PathBuf> {
        let row = self.sessions.get(&id)?;
        let colonies = self
            .state
            .read()
            .sessions
            .project(row.project_id)
            .and_then(|project| world_dirs(&self.orb_root, project));
        let (SessionKind::Colony, Some(WorldDirs::Fresh { colonies, .. })) = (row.kind, colonies)
        else {
            return None;
        };
        (row.dir.parent() == Some(colonies.as_path())).then(|| row.dir.clone())
    }
}

impl RemoveFolder {
    /// Removes the folder (already gone is fine); a failure is logged and
    /// shown as `couldn't remove the folder`.
    pub(super) fn run(self) {
        match fs::remove_dir_all(&self.dir) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                let shown = failed(&self.log, FOLDER_UNREMOVED, &error);
                self.report.report(Outcome::Failed(shown));
            }
        }
    }

    /// Runs the removal on a blocking thread; a job that dies is logged.
    pub(super) fn spawn(self) {
        let log = self.log.clone();
        tokio::spawn(async move {
            if let Err(error) = tokio::task::spawn_blocking(move || self.run()).await {
                log.error("folder removal", &error);
            }
        });
    }
}

/// Settles session `row` onto the shelf as of `at`, unpinning it.
pub(super) fn settle_session_row(row: &mut SessionRow, at: i64) {
    row.settled_override = Some(SettledOverride::Settled);
    row.settled_at = Some(at);
    row.unsettled_at = None;
    row.pinned_at = None;
}

/// Un-settles session `row` and keeps it active until its next turn
/// activity. It re-enters Active at `now` unless it was already kept active.
fn unsettle_session_row(row: &mut SessionRow, now: i64) {
    if row.settled_override != Some(SettledOverride::Active) {
        row.unsettled_at = Some(now);
    }
    row.settled_override = Some(SettledOverride::Active);
    row.settled_at = None;
}
