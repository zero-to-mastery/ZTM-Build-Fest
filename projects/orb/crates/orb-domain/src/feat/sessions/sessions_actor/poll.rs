//! Polling the panes and harnesses, and showing each agent's status and title.

use super::*;

impl SessionsActor {
    /// One whole poll, as the ticker runs it, for tests.
    #[cfg(test)]
    pub(super) async fn poll(&mut self) -> Duration {
        let seen = self.poll_plan().run().await;
        self.poll_seen(seen)
    }

    /// Starts a poll: applies the agents' pane reports, then says what to
    /// ask outside the actor. A harness no pane holds an agent of isn't
    /// asked and counts as running nothing.
    pub(super) fn poll_plan(&mut self) -> Probe {
        self.follow_pane_files();
        let bound = self.bound();
        let known: HashSet<PaneId> = bound.iter().map(|(pane, _)| *pane).collect();
        let (asked, skipped): (Vec<_>, Vec<_>) =
            self.services.harnesses.all().iter().partition(|harness| {
                let id = harness.id();
                self.rows.iter().any(|row| {
                    row.harness == id && row.pane_id.is_some_and(|pane| known.contains(&pane))
                })
            });
        let dirs: HashSet<PathBuf> = bound.into_iter().map(|(_, zmx)| zmx.dir).collect();
        Probe {
            asked: asked.into_iter().cloned().collect(),
            skipped: skipped.iter().map(|harness| harness.id()).collect(),
            dirs: dirs.into_iter().collect(),
            zmx: self.services.zmx.clone(),
            log: self.services.log.clone(),
        }
    }

    /// Shows what the poll saw. A harness that couldn't be asked leaves its
    /// agents as they were; the others still update, and the failure shows
    /// after. Returns how long to wait before the next poll: a second while
    /// any agent pane has a turn underway.
    pub(super) fn poll_seen(&mut self, seen: PollSeen) -> Duration {
        let live = self.live(&seen.listed, &seen.dirs);
        self.apply(&seen.listed, &live);
        if let Some(report) = seen.failure {
            self.fail(&report);
        }
        let app = self.state.read();
        if app.sessions.any_in_progress() {
            FAST_POLL
        } else {
            SLOW_POLL
        }
    }

    /// Applies the agents' reports written since the last poll, oldest first.
    /// A failed save shows on the mode line.
    fn follow_pane_files(&mut self) {
        let mut first_error = None;
        for (pane, report) in self.pane_files.changed() {
            self.pane_reports.insert(
                pane,
                PaneReport {
                    event: report.event,
                    at: report.at,
                },
            );
            if let Err(error) = self.follow_report(pane, &report) {
                first_error.get_or_insert(error);
            }
        }
        if let Some(error) = first_error {
            self.services
                .log
                .error_on_change("poll: pane report", SAVE_FAILED, &error);
            self.report.report(Outcome::Failed(SAVE_FAILED.to_owned()));
        }
    }

    /// What `report` from `pane` means for the agents:
    /// - `end` of the pane's current conversation: the agent leaves the pane,
    ///   and the pane has nothing to resume;
    /// - anything else names the conversation now in the pane: its agent
    ///   keeps the pane (transcript refreshed), or the current agent takes
    ///   the new id after Claude's `/clear` or pi's `/new`, or the agent
    ///   holding that id moves in, or a new agent starts; the pane's resume
    ///   command then names it.
    ///
    /// Reports from an agent orb has no harness for, or a pane orb has no row
    /// for, are ignored, and so is an `end` from a settled session's pane:
    /// settling ended it, and its agent and resume command stay for the
    /// session to come back.
    fn follow_report(
        &mut self,
        pane: PaneId,
        report: &AgentReport,
    ) -> Result<(), Report<StoreError>> {
        let home = {
            let app = self.state.read();
            pane_home(&app.layouts, &self.unread, pane)
                .map(|(session, entry)| (session, entry.cwd.clone()))
        };
        let Some((session, cwd)) = home else {
            return Ok(());
        };
        let id = HarnessId::new(report.agent.clone());
        let Some(harness) = self.services.harnesses.get(&id).cloned() else {
            return Ok(());
        };
        let sid = report.session_id.as_str();
        let holds = |row: &AgentRow| row.short_id == sid || row.session_id.as_deref() == Some(sid);
        let current = self.rows.iter().position(|row| row.pane_id == Some(pane));
        let settled = self
            .sessions
            .get(&session)
            .is_some_and(|session| session.settled_override == Some(SettledOverride::Settled));
        if report.event == AgentEvent::End && settled {
            return Ok(());
        }
        if report.event == AgentEvent::End {
            let ended = match current.and_then(|i| self.rows.get_mut(i)) {
                Some(row) if holds(row) => {
                    row.pane_id = None;
                    self.store.save_agent(row)?;
                    true
                }
                _ => false,
            };
            return if ended {
                self.set_resume(pane, None)
            } else {
                Ok(())
            };
        }
        self.set_resume(pane, Some(&harness.resume_command(sid)))?;
        let holder = self.rows.iter().position(holds);
        let swaps = current
            .and_then(|i| self.rows.get(i))
            .is_some_and(|row| report.replaces_conversation() && row.harness == id);
        match (current, holder) {
            (Some(i), Some(j)) if i == j => {
                if let Some(row) = self.rows.get_mut(i) {
                    let before = row.clone();
                    take_transcript(row, report.transcript.as_ref());
                    if *row != before {
                        self.store.save_agent(row)?;
                    }
                }
            }
            (Some(i), _) if swaps => {
                if let Some(row) = self.rows.get_mut(i) {
                    take_session(row, sid);
                    row.transcript_path.clone_from(&report.transcript);
                    row.transcript_offset = 0;
                    self.store.save_agent(row)?;
                }
            }
            (current, Some(j)) => {
                let old_pane = self
                    .rows
                    .get(j)
                    .and_then(|row| row.pane_id)
                    .filter(|&old| old != pane);
                self.unbind(current)?;
                if let Some(row) = self.rows.get_mut(j) {
                    row.pane_id = Some(pane);
                    row.orb_session = Some(session);
                    take_session(row, sid);
                    take_transcript(row, report.transcript.as_ref());
                    self.store.save_agent(row)?;
                }
                if let Some(old) = old_pane {
                    self.set_resume(old, None)?;
                }
            }
            (current, None) => {
                self.unbind(current)?;
                self.start_pane_agent(pane, session, cwd, id, report)?;
            }
        }
        Ok(())
    }

    /// Takes the agent at `index` in the rows, if any, out of its pane.
    fn unbind(&mut self, index: Option<usize>) -> Result<(), Report<StoreError>> {
        if let Some(row) = index.and_then(|i| self.rows.get_mut(i)) {
            row.pane_id = None;
            self.store.save_agent(row)?;
        }
        Ok(())
    }

    /// Saves and shows an agent `report` started in `pane` of `session`, in
    /// the project of the pane's session, at the top of its agents.
    fn start_pane_agent(
        &mut self,
        pane: PaneId,
        session: SessionId,
        cwd: PathBuf,
        harness: HarnessId,
        report: &AgentReport,
    ) -> Result<(), Report<StoreError>> {
        let now = now_ms();
        let (id, project_id) = self.store.insert_pane_agent(&NewPaneAgent {
            pane,
            session_id: report.session_id.clone(),
            transcript_path: report.transcript.clone(),
            harness: harness.clone(),
            cwd: cwd.clone(),
            created_at: now,
        })?;
        let row = AgentRow {
            id,
            project_id,
            short_id: report.session_id.clone(),
            session_id: Some(report.session_id.clone()),
            title: None,
            custom_title: None,
            cwd,
            transcript_path: report.transcript.clone(),
            transcript_offset: 0,
            created_at: now,
            turn_started_at: None,
            branch: None,
            last_activity_at: now,
            last_visited_at: now,
            ai_titled: false,
            model: None,
            renamed_title: None,
            harness,
            pane_id: Some(pane),
            orb_session: Some(session),
        };
        let agent = {
            let app = self.state.read();
            unpolled(&self.services, &row, &app.layouts, &self.unread)
        };
        self.rows.push(row);
        if let Some(project) = self
            .state
            .write()
            .sessions
            .projects
            .iter_mut()
            .find(|project| project.id == project_id)
        {
            project.agents.insert(0, agent);
        }
        self.report.changed();
        Ok(())
    }

    /// Saves pane `pane`'s resume command, unless it already has it, and
    /// shows it in the pane's layout entry.
    pub(super) fn set_resume(
        &mut self,
        pane: PaneId,
        resume: Option<&str>,
    ) -> Result<(), Report<StoreError>> {
        let current = {
            let app = self.state.read();
            pane_home(&app.layouts, &self.unread, pane).map(|(_, entry)| entry.resume.clone())
        };
        let Some(current) = current else {
            return Ok(());
        };
        if current.as_deref() != resume {
            self.store.set_pane_resume(pane, resume)?;
            let resume = resume.map(str::to_owned);
            self.state
                .write()
                .layouts
                .remember_resume(pane, resume.clone());
            if let Some(entry) = self
                .unread
                .values_mut()
                .flat_map(|kept| &mut kept.panes)
                .find(|entry| entry.id == pane)
            {
                entry.resume = resume;
            }
        }
        Ok(())
    }

    /// Every pane a saved agent is bound to, with its zmx session.
    pub(super) fn bound(&self) -> Vec<(PaneId, ZmxSession)> {
        let app = self.state.read();
        self.rows
            .iter()
            .filter_map(|row| pane_home(&app.layouts, &self.unread, row.pane_id?))
            .map(|(_, entry)| (entry.id, entry.zmx.clone()))
            .collect()
    }

    /// What the poll sees of the panes agents run in now: each one's zmx
    /// session from its socket dir's listing (a dir not listed leaves its
    /// panes out) and the agents matched to the panes their processes run
    /// under.
    fn live(
        &self,
        listed: &HashMap<HarnessId, Vec<RunningAgent>>,
        dirs: &HashMap<PathBuf, Option<Vec<ZmxEntry>>>,
    ) -> Live {
        let bound = self.bound();
        let sessions: HashMap<PaneId, Option<ZmxEntry>> = bound
            .iter()
            .filter_map(|(pane, zmx)| {
                let entries = dirs.get(zmx.dir.as_path())?.as_ref()?;
                Some((
                    *pane,
                    entries.iter().find(|entry| entry.name == zmx.name).cloned(),
                ))
            })
            .collect();
        let roots: HashMap<u32, PaneId> = sessions
            .iter()
            .filter_map(|(pane, entry)| Some((entry.as_ref()?.pid?, *pane)))
            .collect();
        let agents: Vec<RunningAgent> = listed.values().flatten().cloned().collect();
        Live {
            matched: match_records(&agents, &roots),
            sessions,
        }
    }

    /// Updates every saved agent from its pane and transcript, follows its
    /// activity and its session's settle lifecycle, saves the ones that
    /// changed, then shows them all in one write. An agent whose harness
    /// wasn't `listed` (it couldn't be asked) is left as it was; one whose
    /// harness orb doesn't know is Gone.
    fn apply(&mut self, listed: &HashMap<HarnessId, Vec<RunningAgent>>, live: &Live) {
        let now = now_ms();
        let focused = {
            let app = self.state.read();
            match (app.focus, app.focused_agent()) {
                (Focus::Pane, Some(SidebarItem::Agent { pane, .. })) => Some(pane),
                _ => None,
            }
        };
        let owners = self.row_pane_owners();
        let mut statuses = Vec::with_capacity(self.rows.len());
        let mut error = None;
        let mut renamed = Vec::new();
        for row in &mut self.rows {
            let harness = self.services.harnesses.get(&row.harness);
            if harness.is_some() && !listed.contains_key(&row.harness) {
                statuses.push(None);
                continue;
            }
            let Some(status) = status_now(row, harness, live, &self.pane_reports) else {
                statuses.push(None);
                continue;
            };
            let before = row.clone();
            let was_in_progress = row.turn_started_at.is_some();
            let format = harness.map(|harness| harness.as_ref() as &dyn TranscriptFormat);
            let asks_git = update_row(row, status, now, format, &self.services.log);
            if was_in_progress && !status.in_progress() {
                if asks_git
                    && let Some(branch) =
                        current_branch(&self.services.git, &self.services.log, &row.cwd)
                {
                    row.branch = Some(branch);
                }
                if let Some(new) = rename_hex_branch(&self.services.git, &self.worktrees_root, row)
                {
                    renamed.push((row.cwd.clone(), new));
                }
            }
            let in_focus = focused.is_some() && row.pane_id == focused;
            follow_activity(row, status, was_in_progress, in_focus, now);
            if *row != before
                && let Err(report) = self.store.save_agent(row)
            {
                self.services
                    .log
                    .error_on_change("poll: agent save", SAVE_FAILED, &report);
                error = Some(SAVE_FAILED.to_owned());
            }
            statuses.push(Some(status));
        }
        for (cwd, branch) in renamed {
            if let Err(failed) = self.show_branch(&cwd, &branch) {
                error = Some(failed);
            }
        }
        let changed_sessions = self.follow_sessions(&statuses, &owners, now, &mut error);
        let mut notices = Vec::new();
        let changed = {
            let mut guard = self.state.write();
            let app = &mut *guard;
            let sessions = &mut app.sessions;
            let mut changed = false;
            for (row, status) in self
                .rows
                .iter()
                .zip(statuses)
                .filter_map(|(row, status)| Some((row, status?)))
            {
                if let Some(notice) = notice(sessions, row, status) {
                    notices.push(notice);
                }
                if let Some(agent) = agent_mut(sessions, row.id) {
                    changed |= show(
                        agent,
                        row,
                        status,
                        pane_launch(row, &app.layouts, &self.unread),
                    );
                }
            }
            for id in changed_sessions {
                if let (Some(row), Some(shown)) = (
                    self.sessions.get(&id),
                    sessions.sessions.iter_mut().find(|shown| shown.id == id),
                ) {
                    *shown = show_session(row);
                    changed = true;
                }
            }
            changed
        };
        if let Some(error) = error {
            self.report.report(Outcome::Failed(error));
        }
        for notice in notices {
            self.report.report(Outcome::Announce(notice));
        }
        if changed {
            self.report.changed();
        }
    }

    /// The session of each saved agent's pane that a layout or unread tab
    /// holds.
    fn row_pane_owners(&self) -> HashMap<PaneId, SessionId> {
        let app = self.state.read();
        self.rows
            .iter()
            .filter_map(|row| {
                let pane = row.pane_id?;
                pane_home(&app.layouts, &self.unread, pane).map(|(session, _)| (pane, session))
            })
            .collect()
    }

    /// Follows each session's settle lifecycle (see [`follow_session`]) from
    /// its agent agents' polled rows and `statuses` (index-aligned with the
    /// rows; `None` where an agent wasn't polled, which leaves its session as
    /// it was) and `owners` (each row's pane's session), saving the ones that
    /// changed. Sets `error` when a save fails. Returns the sessions that
    /// changed.
    fn follow_sessions(
        &mut self,
        statuses: &[Option<AgentStatus>],
        owners: &HashMap<PaneId, SessionId>,
        now: i64,
        error: &mut Option<String>,
    ) -> Vec<SessionId> {
        let mut changed = Vec::new();
        for session in self.sessions.values_mut() {
            let Some(children) = self
                .rows
                .iter()
                .zip(statuses)
                .filter(|(row, _)| {
                    row.pane_id.and_then(|pane| owners.get(&pane)) == Some(&session.id)
                })
                .map(|(row, status)| Some((row, (*status)?)))
                .collect::<Option<Vec<(&AgentRow, AgentStatus)>>>()
            else {
                continue;
            };
            let latest = children
                .iter()
                .map(|(row, _)| row.last_activity_at)
                .fold(session.last_activity_at, i64::max);
            let in_progress = children.iter().any(|(_, status)| status.in_progress());
            let before = session.clone();
            follow_session(
                session,
                Activity {
                    latest,
                    in_progress,
                },
                now,
            );
            if *session != before {
                if let Err(report) = self.store.save_session(session) {
                    self.services
                        .log
                        .error_on_change("poll: session save", SAVE_FAILED, &report);
                    *error = Some(SAVE_FAILED.to_owned());
                }
                changed.push(session.id);
            }
        }
        changed
    }
}

/// What one poll saw of the panes agents run in.
struct Live {
    /// Each bound pane's zmx session, `None` when it isn't running. A pane
    /// whose socket dir couldn't be listed is missing.
    sessions: HashMap<PaneId, Option<ZmxEntry>>,
    /// The status of each pane an agent's process runs under.
    matched: HashMap<PaneId, AgentStatus>,
}

/// What a saved agent is doing now, if this poll can tell: Gone for a
/// harness orb doesn't know; Stopped with no pane; else its pane's status
/// (see [`pane_status`]). `None` (left as it was) when its pane's socket dir
/// couldn't be listed.
fn status_now(
    row: &AgentRow,
    harness: Option<&Arc<dyn Harness>>,
    live: &Live,
    reports: &HashMap<PaneId, PaneReport>,
) -> Option<AgentStatus> {
    let Some(harness) = harness else {
        return Some(AgentStatus::Gone);
    };
    let Some(pane) = row.pane_id else {
        return Some(AgentStatus::Stopped);
    };
    let running = live.sessions.get(&pane)?;
    Some(pane_status(
        running.as_ref(),
        harness.reports_status(),
        reports.get(&pane).copied(),
        live.matched.get(&pane).copied(),
    ))
}

/// Follows a polled row's activity, given its `status` now and whether a
/// turn was underway before this poll:
/// - a turn that ended is the agent's latest activity;
/// - the latest turn of the agent whose pane has the keys is seen.
///
/// Settling and un-settling are its session's (see [`follow_session`]).
fn follow_activity(
    row: &mut AgentRow,
    status: AgentStatus,
    was_in_progress: bool,
    in_focus: bool,
    now: i64,
) {
    if was_in_progress && !status.in_progress() {
        row.last_activity_at = now;
    }
    if in_focus && row.last_activity_at > row.last_visited_at {
        row.last_visited_at = now;
    }
}

/// What a poll saw of a session's agent panes.
#[derive(Debug, Clone, Copy)]
struct Activity {
    /// The latest turn activity in it, its own or any agent pane's.
    latest: i64,
    /// Whether any agent pane has a turn underway.
    in_progress: bool,
}

/// Follows a session's settle lifecycle from `activity`: the latest activity
/// becomes the session's, and a turn underway un-settles it and ends its
/// kept-active mark.
fn follow_session(row: &mut SessionRow, activity: Activity, now: i64) {
    row.last_activity_at = activity.latest;
    if activity.in_progress
        && let Some(settled_override) = row.settled_override
    {
        if settled_override == SettledOverride::Settled {
            row.unsettled_at = Some(now);
        }
        row.settled_override = None;
        row.settled_at = None;
    }
}

/// The shown agent with id `id`.
pub(super) fn agent_mut(sessions: &mut Sessions, id: AgentId) -> Option<&mut Agent> {
    sessions
        .projects
        .iter_mut()
        .flat_map(|project| &mut project.agents)
        .find(|agent| agent.id == id)
}

/// Brings a saved agent up to date with `status`: the turn stamp, and the
/// title and branch from any new transcript lines, read in its harness's
/// `format`. Returns whether a scan ran and named no branch, which leaves
/// the branch to git.
fn update_row(
    row: &mut AgentRow,
    status: AgentStatus,
    now_ms: i64,
    format: Option<&dyn TranscriptFormat>,
    log: &Log,
) -> bool {
    row.turn_started_at = status
        .in_progress()
        .then(|| row.turn_started_at.unwrap_or(now_ms));
    let (Some(session_id), Some(format)) = (&row.session_id, format) else {
        return false;
    };
    if row.transcript_path.is_none() {
        row.transcript_path = format.locate(&row.cwd, session_id);
    }
    let previous = Scan {
        title: row.title.clone(),
        custom_title: row.custom_title.clone(),
        branch: row.branch.clone(),
        ai_titled: row.ai_titled,
        offset: row.transcript_offset,
    };
    let Some(path) = row.transcript_path.as_deref() else {
        return false;
    };
    let scan = match format.scan(path, row.transcript_offset, &previous) {
        Ok(scan) => scan,
        Err(report) => {
            log.error_on_change(
                &format!("transcript scan {}", row.id.0),
                &unreadable_transcript(row.id, path),
                &report,
            );
            return false;
        }
    };
    // A new `/rename` replaces the orb name; the harness re-writing its old
    // name doesn't.
    if scan.custom_title != row.custom_title {
        row.renamed_title = None;
    }
    row.title = scan.title;
    row.custom_title = scan.custom_title;
    row.ai_titled |= scan.ai_titled;
    row.transcript_offset = scan.offset;
    match scan.branch {
        Some(branch) => {
            row.branch = Some(branch);
            false
        }
        None => true,
    }
}

/// Makes `row` the agent of conversation `session_id`.
fn take_session(row: &mut AgentRow, session_id: &str) {
    session_id.clone_into(&mut row.short_id);
    row.session_id = Some(session_id.to_owned());
}

/// Points `row` at `transcript` when the report names a different one, read
/// from its start.
fn take_transcript(row: &mut AgentRow, transcript: Option<&PathBuf>) {
    if let Some(path) = transcript
        && row.transcript_path.as_ref() != Some(path)
    {
        row.transcript_path = Some(path.clone());
        row.transcript_offset = 0;
    }
}

/// Shows a saved agent and `status` on `agent`, its pane run as `pane`.
/// Returns whether anything visible changed.
pub(super) fn show(
    agent: &mut Agent,
    row: &AgentRow,
    status: AgentStatus,
    pane: Option<PaneLaunch>,
) -> bool {
    let shown = self::agent(row, status, pane);
    let changed = *agent != shown;
    *agent = shown;
    changed
}

/// Why an agent that was `old` and is now `new` needs the user, if it does:
/// a turn ended, or the session started waiting for an approval or an answer. A
/// agent not polled since orb started never does, so states that existed at
/// launch don't notify.
pub(super) fn notice_kind(old: AgentStatus, new: AgentStatus) -> Option<NoticeKind> {
    match (old, new) {
        (AgentStatus::Unknown, _) => None,
        (old, AgentStatus::Idle) if old.in_progress() => Some(NoticeKind::Finished),
        (old, AgentStatus::NeedsApproval) if old != AgentStatus::NeedsApproval => {
            Some(NoticeKind::NeedsApproval)
        }
        (old, AgentStatus::NeedsInput) if old != AgentStatus::NeedsInput => {
            Some(NoticeKind::NeedsInput)
        }
        _ => None,
    }
}

/// The notice for the saved agent `row` now being `status`, if its shown
/// status changes in a way that needs the user; never for an agent being
/// deleted. The title is the row's, already updated by this poll.
pub(super) fn notice(sessions: &Sessions, row: &AgentRow, status: AgentStatus) -> Option<Notice> {
    let (project, agent) = sessions.projects.iter().find_map(|project| {
        project
            .agents
            .iter()
            .find(|agent| agent.id == row.id)
            .map(|agent| (project, agent))
    })?;
    if sessions.is_deleting(agent) {
        return None;
    }
    Some(Notice {
        agent: row.id,
        kind: notice_kind(agent.status, status)?,
        project: project.title.clone(),
        title: display_title(row).unwrap_or_else(|| NEW_AGENT.to_owned()),
    })
}

/// The title the sidebar shows: the user's `r` name, else their `/rename`,
/// else the transcript's.
pub(super) fn display_title(row: &AgentRow) -> Option<String> {
    row.renamed_title
        .clone()
        .or_else(|| row.custom_title.clone())
        .or_else(|| row.title.clone())
}
