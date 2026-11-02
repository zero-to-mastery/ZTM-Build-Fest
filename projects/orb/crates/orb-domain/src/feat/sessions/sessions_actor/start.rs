//! Starting, moving and restoring sessions, worktrees and branches.

use super::*;
use crate::feat::sessions::validator::validate_new_session;

impl SessionsActor {
    /// Runs `git init` in project `id`'s root, then shows the project as a
    /// git repository. A failure shows why.
    pub(super) fn init_git(&mut self, id: ProjectId) {
        let Some(root) = self.project_root(id) else {
            return;
        };
        match self.services.git.init(&root) {
            Ok(()) => {
                if let Some(project) = self
                    .state
                    .write()
                    .sessions
                    .projects
                    .iter_mut()
                    .find(|p| p.id == id)
                {
                    project.repo = true;
                }
                self.report.changed();
            }
            Err(report) => self.report.report(Outcome::Failed(format!(
                "Git initialization failed: {}",
                git_failed(&self.services.log, "git init failed", &report)
            ))),
        }
    }

    /// Ends a session start: stops showing it as starting, reports
    /// `result`'s error, then `opens`, the session it made ready, if any,
    /// and on success polls now. A success reports no recovery, so an error
    /// the start ran into on the way (a layout that didn't save) still shows.
    pub(super) fn end_start(&self, result: Result<(), String>, opens: Option<Opens>) {
        self.state.write().sessions.starting = false;
        let succeeded = result.is_ok();
        if let Err(error) = result {
            self.report.report(Outcome::Failed(error));
        }
        if let Some(Opens { session, if_active }) = opens {
            self.report.report(Outcome::Ready { session, if_active });
        }
        self.report.changed();
        if succeeded {
            self.poke.notify_one();
        }
    }

    /// Makes a session of project `id` in `workspace`, named `name`, with one
    /// tab running a shell, selects it and reports it ready to open while
    /// `if_active`, the session active when the user asked, still is. The
    /// checkout or an existing worktree must still be a folder; a new
    /// worktree is made by the returned job (see [`Work`]), and the session
    /// once its result arrives (see [`Self::worktree_ready`]); the Incognito
    /// project's folder is made first. On failure the reason shows.
    #[must_use]
    pub(super) fn new_session(
        &mut self,
        id: ProjectId,
        workspace: Workspace,
        name: Option<String>,
        if_active: Option<SessionId>,
    ) -> Option<WorktreeJob> {
        self.start_new(id, workspace, name, None, Asker::User(if_active))
    }

    /// Makes a session for an agent, as [`Self::new_session`] does, in
    /// `msg.dir` when set, else project `msg.project`'s checkout or, with
    /// `msg.worktree`, a new worktree from the project's default branch (read
    /// in the worktree job). The session isn't selected or opened; `reply`
    /// gets the session and its first pane once it's made, or why it wasn't.
    /// While another session starts it is refused with
    /// [`ApiStartError::Starting`]; otherwise it marks a session as starting
    /// until it ends.
    #[must_use]
    pub(super) fn api_start(
        &mut self,
        msg: ApiStart,
        reply: Option<ReplySender<ApiStarted>>,
    ) -> Option<WorktreeJob> {
        let claimed = {
            let mut app = self.state.write();
            let free = validate_new_session(&app).is_ok();
            if free {
                app.sessions.starting = true;
            }
            free
        };
        if !claimed {
            if let Some(reply) = reply {
                reply.send(Err(ApiStartError::Starting));
            }
            return None;
        }
        self.report.changed();
        let ApiStart {
            project,
            worktree,
            name,
            parent,
            dir,
        } = msg;
        let asker = Asker::Api(reply);
        let workspace = match (dir, worktree) {
            (Some(dir), _) => Workspace::Existing(dir),
            (None, true) => {
                let Some((root, kind)) = self.project_of(project) else {
                    self.end_new(Err("the project is gone".to_owned()), asker);
                    return None;
                };
                let make = Make::New {
                    base: None,
                    name: name.clone(),
                };
                let start = Start::New {
                    project,
                    kind,
                    name,
                    parent,
                    asker,
                };
                return Some(self.job(root, make, start));
            }
            (None, false) => Workspace::Checkout,
        };
        self.start_new(project, workspace, name, parent, asker)
    }

    /// The work of a new session of project `id` in `workspace`, named
    /// `name`, made by session `parent`, for `asker`; see
    /// [`Self::new_session`].
    fn start_new(
        &mut self,
        id: ProjectId,
        workspace: Workspace,
        name: Option<String>,
        parent: Option<SessionId>,
        asker: Asker,
    ) -> Option<WorktreeJob> {
        let Some((root, kind)) = self.project_of(id) else {
            self.end_new(Err("the project is gone".to_owned()), asker);
            return None;
        };
        if kind == ProjectKind::Incognito
            && let Err(error) = fs::create_dir_all(&root)
        {
            self.end_new(
                Err(failed(&self.services.log, FOLDER_UNMADE, &error)),
                asker,
            );
            return None;
        }
        match workspace {
            Workspace::NewWorktree { base } => {
                let make = Make::New {
                    base: Some(base),
                    name: name.clone(),
                };
                let start = Start::New {
                    project: id,
                    kind,
                    name,
                    parent,
                    asker,
                };
                Some(self.job(root, make, start))
            }
            to => {
                let select = asker.selects();
                let saved = reach(&root, to).and_then(|dir| {
                    let branch = current_branch(&self.services.git, &self.services.log, &dir);
                    self.save_session(id, session_kind(kind), &dir, branch, name, parent, select)
                });
                self.end_new(saved, asker);
                None
            }
        }
    }

    /// Ends a new session's start, `saved` being the session it made or why
    /// not. The user's start shows the error, else reports the session ready
    /// to open (see [`Self::end_start`]); an agent's opens nothing, shows
    /// nothing, and answers the agent with the session and its first pane.
    fn end_new(&mut self, saved: Result<SessionId, String>, asker: Asker) {
        match asker {
            Asker::User(if_active) => {
                let opens = saved
                    .as_ref()
                    .ok()
                    .map(|&session| Opens { session, if_active });
                self.end_start(saved.map(drop), opens);
            }
            Asker::Api(reply) => {
                self.end_start(Ok(()), None);
                let started = saved.and_then(|session| {
                    self.state
                        .read()
                        .layouts
                        .get(session)
                        .and_then(SessionLayout::focused)
                        .map(|pane| (session, pane))
                        .ok_or_else(|| "the new session has no pane".to_owned())
                });
                let started = started.map_err(ApiStartError::Failed);
                if let Some(reply) = reply {
                    reply.send(started);
                }
            }
        }
    }

    /// A job making the worktree `make` of the repository at `repo` for
    /// `start`.
    pub(super) fn job(&self, repo: PathBuf, make: Make, start: Start) -> WorktreeJob {
        WorktreeJob {
            start,
            work: Work {
                services: self.services.clone(),
                state: self.state.clone(),
                report: self.report.clone(),
                worktrees_root: self.worktrees_root.clone(),
                repo,
                make,
            },
        }
    }

    /// Applies a worktree job's result, checking first that its start still
    /// holds. A new session's project must still be there, else its
    /// worktree is removed; a moved session must still exist and still have
    /// had no turn, else its worktree is removed; a restored session must
    /// still exist (a worktree re-added for one that's gone is left for the
    /// sweep). However it ends, the start ends, and the fetch label goes.
    pub(super) fn worktree_ready(&mut self, ready: WorktreeReady) {
        self.state.write().sessions.fetching = None;
        let WorktreeReady { start, made } = ready;
        match start {
            Start::New {
                project,
                kind,
                name,
                parent,
                asker,
            } => {
                let select = asker.selects();
                let saved = made.and_then(|made| {
                    let live = self
                        .state
                        .read()
                        .sessions
                        .project(project)
                        .is_some_and(|project| !project.removed);
                    if !live {
                        self.remove_made(&made, "its project was removed while it was made");
                        return Err("the project is gone".to_owned());
                    }
                    let branch = Some(made.branch.clone());
                    let saved = self.save_session(
                        project,
                        session_kind(kind),
                        &made.path,
                        branch,
                        name,
                        parent,
                        select,
                    );
                    if saved.is_err() {
                        self.remove_made(&made, "new session couldn't be saved");
                    }
                    saved
                });
                self.end_new(saved, asker);
            }
            Start::Move {
                session,
                moving,
                if_active,
            } => {
                let result = made.and_then(|made| {
                    let still = if self.state.read().sessions.deleting.contains(&session) {
                        Err("the session is gone".to_owned())
                    } else {
                        self.moving(session).map(drop)
                    };
                    if still.is_err() {
                        self.remove_made(&made, "its session changed while it was made");
                    }
                    still?;
                    self.move_to(session, &moving, &made.path, Some(&made))
                });
                self.end_start(result, Some(Opens { session, if_active }));
            }
            Start::Restore { session } => {
                let result = made.and_then(|made| {
                    if !self.sessions.contains_key(&session)
                        || self.state.read().sessions.deleting.contains(&session)
                    {
                        return Err("the session is gone".to_owned());
                    }
                    self.show_branch(&made.path, &made.branch)
                });
                let opens = result.is_ok().then_some(Opens {
                    session,
                    if_active: Some(session),
                });
                self.end_start(result, opens);
            }
        }
    }

    /// Saves a new `kind` session of project `project` named `name` in `dir`
    /// on `branch` with one tab of one shell pane, saved through the layout
    /// save, shows it and, when `select`, selects it. `parent` is the session
    /// that made it, dropped when that session is gone or being deleted
    /// (session ids are reused). Returns its id; the error is the message box
    /// text.
    pub(super) fn save_session(
        &mut self,
        project: ProjectId,
        kind: SessionKind,
        dir: &Path,
        branch: Option<String>,
        name: Option<String>,
        parent: Option<SessionId>,
        select: bool,
    ) -> Result<SessionId, String> {
        let parent = parent.filter(|&parent| {
            let app = self.state.read();
            app.sessions.session(parent).is_some() && !app.sessions.deleting.contains(&parent)
        });
        let now = now_ms();
        let (id, pane) = self
            .store
            .insert_session(
                project,
                kind,
                dir,
                branch.as_deref(),
                name.as_deref(),
                parent,
                now,
            )
            .map_err(|report| failed(&self.services.log, NEW_SESSION_UNSAVED, &report))?;
        let row = SessionRow {
            id,
            project_id: project,
            kind,
            parent,
            name,
            branch,
            created_at: now,
            dir: dir.to_owned(),
            active_tab: 0,
            float_layout: FloatLayout::Staggered,
            floats_hand_changed: false,
            pinned_at: None,
            settled_override: None,
            settled_at: None,
            unsettled_at: None,
            last_activity_at: now,
        };
        let pane = PaneRow {
            id: pane,
            session_id: id,
            cwd: dir.to_owned(),
            zmx_name: None,
            zmx_dir: None,
            resume: None,
            name: None,
        };
        let entry = pane_entry(&self.services, &self.orb_root, &pane);
        {
            let mut app = self.state.write();
            app.layouts.insert(id, SessionLayout::of(entry));
            let sessions = &mut app.sessions;
            sessions.sessions.push(show_session(&row));
            if select {
                sessions.cursor = Some(SidebarItem::Session(id));
            }
        }
        self.sessions.insert(id, row);
        self.save_layout(id);
        Ok(id)
    }

    /// Project `id`'s root and kind, if it still exists.
    fn project_of(&self, id: ProjectId) -> Option<(PathBuf, ProjectKind)> {
        self.state
            .read()
            .sessions
            .project(id)
            .map(|project| (project.root.clone(), project.kind))
    }

    /// Moves session `id`, which has had no agent turn, to `to`: the
    /// checkout, an existing worktree, or a new one made by the returned job
    /// (moved to once its result arrives, see [`Self::worktree_ready`]).
    /// Saves the session and its panes at the new directory, kills every
    /// pane, unbinds the agents in them and clears their resume commands,
    /// and points the layout at the new directory. The worktree it left is
    /// removed with its branch when orb made it and no other session uses it
    /// (git refuses one with changes). However it ends, the session is
    /// reported ready to open again while `if_active`, the session active
    /// when the user asked, still is; opening it starts a fresh shell in each
    /// pane. A session that has had a turn, or a target that can't be
    /// reached, stays where it was with the reason shown.
    #[must_use]
    pub(super) fn change_workspace(
        &mut self,
        id: SessionId,
        to: Workspace,
        if_active: Option<SessionId>,
    ) -> Option<WorktreeJob> {
        match (self.moving(id), to) {
            (Ok(moving), Workspace::NewWorktree { base }) => {
                let make = Make::New {
                    base: Some(base),
                    name: moving.name.clone(),
                };
                let repo = moving.root.clone();
                Some(self.job(
                    repo,
                    make,
                    Start::Move {
                        session: id,
                        moving,
                        if_active,
                    },
                ))
            }
            (moving, to) => {
                self.move_here(id, moving, to, if_active);
                None
            }
        }
    }

    /// Moves session `id` to `to`, the checkout or an existing worktree,
    /// when `moving` says it can move, then ends the start, reporting the
    /// session ready to open again while `if_active` still is the active
    /// session.
    fn move_here(
        &mut self,
        id: SessionId,
        moving: Result<Moving, String>,
        to: Workspace,
        if_active: Option<SessionId>,
    ) {
        let result = moving.and_then(|moving| {
            let dir = reach(&moving.root, to)?;
            self.move_to(id, &moving, &dir, None)
        });
        self.end_start(
            result,
            Some(Opens {
                session: id,
                if_active,
            }),
        );
    }

    /// Where session `id` is, if it can still move: it exists, its project
    /// does, and it has had no agent turn. The error is the message box
    /// text.
    pub(super) fn moving(&self, id: SessionId) -> Result<Moving, String> {
        let (project, old_dir, old_branch, name) = self
            .sessions
            .get(&id)
            .map(|row| {
                let (dir, branch, name) = (row.dir.clone(), row.branch.clone(), row.name.clone());
                (row.project_id, dir, branch, name)
            })
            .ok_or_else(|| "the session is gone".to_owned())?;
        let (root, _) = self
            .project_of(project)
            .ok_or_else(|| "the project is gone".to_owned())?;
        if self.state.read().sessions.turned(id) {
            let workspace = if old_dir == root {
                "Local checkout"
            } else {
                "Worktree"
            };
            return Err(format!("Workspace locked · {workspace}"));
        }
        Ok(Moving {
            root,
            old_dir,
            old_branch,
            name,
        })
    }

    /// The work of a move of session `id` from where `moving` says to `dir`,
    /// where orb `made` a worktree if it did, up to reporting it ready.
    fn move_to(
        &mut self,
        id: SessionId,
        moving: &Moving,
        dir: &Path,
        made: Option<&MadeWorktree>,
    ) -> Result<(), String> {
        let branch = made.map_or_else(
            || current_branch(&self.services.git, &self.services.log, dir),
            |made| Some(made.branch.clone()),
        );
        if let Err(report) = self.store.move_session(id, dir, branch.as_deref()) {
            if let Some(made) = made {
                self.remove_made(made, "workspace change couldn't be saved");
            }
            return Err(save_failed(&self.services.log, &report));
        }
        self.kill_panes(id, "session moved to another workspace");
        let panes: Vec<PaneId> = {
            let app = self.state.read();
            session_entries(&app.layouts, &self.unread, id)
                .into_iter()
                .map(|entry| entry.id)
                .collect()
        };
        let mut saved = Ok(());
        let mut unbound = Vec::new();
        for &pane in &panes {
            for row in self.rows.iter_mut().filter(|row| row.pane_id == Some(pane)) {
                row.pane_id = None;
                unbound.push(row.id);
                if let Err(report) = self.store.save_agent(row) {
                    saved = Err(save_failed(&self.services.log, &report));
                }
            }
            if let Err(report) = self.set_resume(pane, None) {
                saved = Err(save_failed(&self.services.log, &report));
            }
        }
        for entry in self
            .unread
            .get_mut(&id)
            .into_iter()
            .flat_map(|kept| &mut kept.panes)
        {
            dir.clone_into(&mut entry.cwd);
        }
        let shown = self.sessions.get_mut(&id).map(|row| {
            dir.clone_into(&mut row.dir);
            row.branch.clone_from(&branch);
            show_session(row)
        });
        {
            let mut guard = self.state.write();
            let app = &mut *guard;
            app.layouts.move_session(id, dir);
            let sessions = &mut app.sessions;
            if let (Some(shown), Some(session)) = (
                shown,
                sessions
                    .sessions
                    .iter_mut()
                    .find(|session| session.id == id),
            ) {
                *session = shown;
            }
            for row in self.rows.iter().filter(|row| unbound.contains(&row.id)) {
                if let Some(agent) = agent_mut(sessions, row.id) {
                    let status = agent.status;
                    show(
                        agent,
                        row,
                        status,
                        pane_launch(row, &app.layouts, &self.unread),
                    );
                }
            }
        }
        self.remove_left(&moving.root, &moving.old_dir, moving.old_branch.clone());
        saved
    }

    /// Removes the orb worktree at `old_dir`, a session just left, and its
    /// branch (the session's `old_branch`, else orb's `orb/<hex>` for it),
    /// unless another session still uses it; git refuses one with changes,
    /// or a branch that isn't merged.
    fn remove_left(&self, root: &Path, old_dir: &Path, old_branch: Option<String>) {
        if !is_orb_worktree(&self.worktrees_root, old_dir)
            || self.sessions.values().any(|row| row.dir == old_dir)
        {
            return;
        }
        let git = &self.services.git;
        let why = "left behind by a workspace change";
        if git.remove_worktree(root, old_dir, false, why).is_ok()
            && let Some(branch) = old_branch.or_else(|| hex_branch(&self.worktrees_root, old_dir))
        {
            git.delete_branch(root, &branch, false, why);
        }
    }

    /// Removes a worktree orb just made, and its branch, discarding anything
    /// in them.
    fn remove_made(&self, made: &MadeWorktree, why: &str) {
        let git = &self.services.git;
        if git
            .remove_worktree(&made.repo, &made.path, true, why)
            .is_ok()
        {
            git.delete_branch(&made.repo, &made.branch, true, why);
        }
    }

    /// Recreates session `id`'s worktree at its path through the returned
    /// job (see [`Work`]) and reports the session ready to open once its
    /// result arrives (see [`Self::worktree_ready`]), ending the start the
    /// frontend marked. Entering the session asked for the restore, so it
    /// opens while it is still the active one. A directory that is back
    /// already needs nothing. On failure, git's reason shows and nothing
    /// opens.
    #[must_use]
    pub(super) fn restore_worktree(&mut self, id: SessionId) -> Option<WorktreeJob> {
        let Some((root, cwd, branches)) = self.restore_target(id) else {
            self.end_start(Err("the session is gone".to_owned()), None);
            return None;
        };
        if cwd.is_dir() {
            let opens = Opens {
                session: id,
                if_active: Some(id),
            };
            self.end_start(Ok(()), Some(opens));
            return None;
        }
        if branches.is_empty() {
            self.end_start(Err("couldn't tell the worktree's branch".to_owned()), None);
            return None;
        }
        let make = Make::Again { cwd, branches };
        Some(self.job(root, make, Start::Restore { session: id }))
    }

    /// Session `id`'s project root, its directory, and the branches its
    /// worktree may have been on, likeliest first: the session's recorded
    /// branch, then its agents', else orb's `orb/<hex>` for the directory.
    fn restore_target(&self, id: SessionId) -> Option<(PathBuf, PathBuf, Vec<String>)> {
        let session = self.sessions.get(&id)?;
        let mut branches: Vec<String> = session.branch.iter().cloned().collect();
        let panes = self.session_pane_ids(id);
        for row in self
            .rows
            .iter()
            .filter(|row| row.pane_id.is_some_and(|pane| panes.contains(&pane)))
        {
            if let Some(branch) = &row.branch
                && !branches.contains(branch)
            {
                branches.push(branch.clone());
            }
        }
        if branches.is_empty() {
            branches.extend(hex_branch(&self.worktrees_root, &session.dir));
        }
        Some((
            self.project_root(session.project_id)?,
            session.dir.clone(),
            branches,
        ))
    }

    /// Checks `git_ref` out in `cwd` and shows the branch there. Refused while
    /// a turn is underway in it. Returns the branch checked out, if it was.
    fn check_out_in(&mut self, cwd: &Path, git_ref: &GitRef) -> Option<String> {
        let result = if self.busy_in(cwd) {
            Err(BUSY_DIRECTORY.to_owned())
        } else {
            match self.services.git.checkout(cwd, git_ref) {
                Ok(local) => self.show_branch(cwd, &local).map(|()| local),
                Err(report) => Err(git_failed(&self.services.log, "checkout failed", &report)),
            }
        };
        let (checked_out, error) = match result {
            Ok(local) => (Some(local), None),
            Err(error) => (None, Some(error)),
        };
        self.report.error(error);
        self.report.changed();
        checked_out
    }

    /// Checks `git_ref` out for session `id`: in its directory, or with
    /// `to_root` in its project's checkout, moving the session there; the
    /// moved session opens while `if_active` is still the active session.
    pub(super) fn switch_branch(
        &mut self,
        id: SessionId,
        git_ref: &GitRef,
        to_root: bool,
        if_active: Option<SessionId>,
    ) {
        match self.sessions.get(&id).map(|row| row.dir.clone()) {
            _ if to_root => self.switch_to_root(id, git_ref, if_active),
            Some(dir) => {
                let _ = self.check_out_in(&dir, git_ref);
            }
            None => {}
        }
    }

    /// Checks `git_ref` out in the project's checkout and moves session
    /// `id`, which has had no agent turn, there from its worktree. Refused
    /// while a turn is underway in the checkout. However it ends, the
    /// session opens again while `if_active` is still the active session.
    fn switch_to_root(&mut self, id: SessionId, git_ref: &GitRef, if_active: Option<SessionId>) {
        let root = self
            .sessions
            .get(&id)
            .and_then(|row| self.project_root(row.project_id));
        let Some(root) = root else {
            return self.end_start(Err("the session is gone".to_owned()), None);
        };
        if self.state.read().sessions.turned(id) {
            let moving = self.moving(id);
            return self.move_here(id, moving, Workspace::Checkout, if_active);
        }
        let opens = Opens {
            session: id,
            if_active,
        };
        if self.busy_in(&root) {
            return self.end_start(Err(BUSY_DIRECTORY.to_owned()), Some(opens));
        }
        match self.services.git.checkout(&root, git_ref) {
            Ok(local) => {
                let _ = self.show_branch(&root, &local);
                let moving = self.moving(id);
                self.move_here(id, moving, Workspace::Checkout, if_active);
            }
            Err(report) => {
                let shown = git_failed(&self.services.log, "checkout failed", &report);
                self.end_start(Err(shown), Some(opens));
            }
        }
    }

    /// Saves and shows `branch` on every agent and every session in `cwd`.
    /// The saves run before the state is locked.
    pub(super) fn show_branch(&mut self, cwd: &Path, branch: &str) -> Result<(), String> {
        let mut saved = Ok(());
        for row in self.rows.iter_mut().filter(|row| row.cwd == cwd) {
            row.branch = Some(branch.to_owned());
            if let Err(report) = self.store.save_agent(row) {
                saved = Err(save_failed(&self.services.log, &report));
            }
        }
        for row in self.sessions.values_mut().filter(|row| row.dir == cwd) {
            row.branch = Some(branch.to_owned());
            if let Err(report) = self.store.save_session(row) {
                saved = Err(save_failed(&self.services.log, &report));
            }
        }
        let mut guard = self.state.write();
        let app = &mut *guard;
        for row in self.rows.iter().filter(|row| row.cwd == cwd) {
            if let Some(agent) = agent_mut(&mut app.sessions, row.id) {
                let status = agent.status;
                show(
                    agent,
                    row,
                    status,
                    pane_launch(row, &app.layouts, &self.unread),
                );
            }
        }
        for row in self.sessions.values().filter(|row| row.dir == cwd) {
            if let Some(shown) = app.sessions.sessions.iter_mut().find(|s| s.id == row.id) {
                *shown = show_session(row);
            }
        }
        saved
    }

    /// Whether a turn is underway in any agent in `cwd`.
    fn busy_in(&self, cwd: &Path) -> bool {
        self.state
            .read()
            .sessions
            .all_agents()
            .any(|agent| agent.cwd == cwd && agent.status.in_progress())
    }
}

/// Answers the name box that asked for a new session, if it's still waiting:
/// closes it once the session is `made`, else leaves it open with its text
/// for another try.
pub(super) fn answer_name_box(app: &mut AppState, made: bool) {
    match (&mut app.rename, made) {
        (Some(rename), false) if rename.creating => rename.creating = false,
        (Some(rename), true) if rename.creating => {
            app.rename = None;
            if app.focus == Focus::Rename {
                app.focus = Focus::Sidebar;
            }
        }
        _ => {}
    }
}

/// Renames the `orb/<hex>` branch of the orb worktree `row` is in to
/// `orb/<slug>` of its title, once the harness or the user titled it. The old name
/// stays when that branch already exists or git refuses. Returns the new name
/// when it renamed.
pub(super) fn rename_hex_branch(
    git: &GitService,
    worktrees_root: &Path,
    row: &mut AgentRow,
) -> Option<String> {
    if let Some(old) = hex_branch(worktrees_root, &row.cwd)
        && row.branch.as_deref() == Some(old.as_str())
        && (row.renamed_title.is_some() || row.custom_title.is_some() || row.ai_titled)
        && let Some(new) = display_title(row)
            .as_deref()
            .and_then(slug)
            .map(|slug| format!("orb/{slug}"))
        && !git.branch_exists(&row.cwd, &new)
        && git.rename_branch(&row.cwd, &old, &new).is_ok()
    {
        row.branch = Some(new.clone());
        return Some(new);
    }
    None
}

/// The branch checked out in `cwd`, if git can tell. A failed read in a
/// git repository is logged, once per folder until its text changes; a
/// folder outside git has no branch, so its failure isn't logged.
pub(super) fn current_branch(git: &GitService, log: &Log, cwd: &Path) -> Option<String> {
    let refs = match git.refs(cwd) {
        Ok(refs) => refs,
        Err(_) if git.project_path(cwd).is_none() => return None,
        Err(report) => {
            log.error_on_change(
                &format!("branch read {}", cwd.display()),
                &format!("couldn't read the branch in {}", cwd.display()),
                &report,
            );
            return None;
        }
    };
    refs.into_iter()
        .find(|git_ref| git_ref.current)
        .map(|git_ref| git_ref.name)
}

/// Where `to` is under the project rooted at `root`: the checkout or an
/// existing worktree, which must still be a folder. A new worktree is made
/// by a [`WorktreeJob`] instead. The error is the message box text.
pub(super) fn reach(root: &Path, to: Workspace) -> Result<PathBuf, String> {
    match to {
        Workspace::Checkout if root.is_dir() => Ok(root.to_owned()),
        Workspace::Checkout => Err(format!(
            "project folder no longer exists: {}",
            root.display()
        )),
        Workspace::Existing(path) if path.is_dir() => Ok(path),
        Workspace::Existing(path) => Err(format!("worktree no longer exists: {}", path.display())),
        Workspace::NewWorktree { .. } => Err(WORKTREE_UNMADE.to_owned()),
    }
}

impl WorktreeJob {
    /// Runs the job beside the actor's queue and posts its result back to
    /// `actor`; a job that dies posts a failure, so its start always ends.
    pub(super) fn spawn(self, actor: ActorRef<SessionsActor>) {
        let Self { start, work } = self;
        let log = work.services.log.clone();
        tokio::spawn(async move {
            let made = tokio::task::spawn_blocking(move || work.run())
                .await
                .unwrap_or_else(|error| {
                    log.error("worktree job", &error);
                    Err(WORKTREE_UNMADE.to_owned())
                });
            let path = made.as_ref().ok().map(|made| made.path.clone());
            if actor.tell(WorktreeReady { start, made }).await.is_err()
                && let Some(path) = path
            {
                log.line(
                    "worktree",
                    &format!("made for a start that never finished: {}", path.display()),
                );
            }
        });
    }
}

impl Work {
    /// Makes the worktree. The error is the message box text.
    pub(super) fn run(self) -> Result<MadeWorktree, String> {
        let log = &self.services.log;
        match &self.make {
            Make::New { base, name } => {
                let base = match base {
                    Some(base) => base.clone(),
                    None => self
                        .services
                        .git
                        .default_branch(&self.repo)
                        .map_err(|report| {
                            git_failed(log, "default branch for a new session", &report)
                        })?,
                };
                let branch = name
                    .as_deref()
                    .and_then(slug)
                    .map(|slug| format!("orb/{slug}"))
                    .filter(|branch| !self.services.git.branch_exists(&self.repo, branch));
                self.add_worktree(&base, branch.as_deref())
                    .map_err(|report| git_failed(log, WORKTREE_UNMADE, &report))
            }
            Make::Again { cwd, branches } => self
                .add_again(cwd, branches)
                .map_err(|report| git_failed(log, "couldn't recreate the worktree", &report)),
        }
    }

    /// Makes a new worktree on the new branch `branch` (else a new
    /// `orb/<hex>` one), from `base` as origin has it, else as it is
    /// locally. A ref of another remote, like `upstream/x`, is used as it
    /// is.
    pub(super) fn add_worktree(
        &self,
        base: &str,
        branch: Option<&str>,
    ) -> Result<MadeWorktree, Report<GitError>> {
        let (git, repo) = (&self.services.git, &self.repo);
        let base = start_point(git, repo, base, |branch| self.fetch(branch))?;
        let (path, branch) = (0..WORKTREE_NAME_ATTEMPTS)
            .map(|attempt| {
                let hex = hex(attempt);
                (
                    new_worktree_path(&self.worktrees_root, repo, &hex),
                    branch.map_or_else(|| format!("orb/{hex}"), str::to_owned),
                )
            })
            .find(|(path, branch)| !path.exists() && !git.branch_exists(repo, branch))
            .ok_or_else(|| Report::new(GitError).attach("couldn't pick a new worktree name"))?;
        git.add_worktree(repo, &path, &branch, &base)?;
        Ok(MadeWorktree {
            repo: repo.clone(),
            path,
            branch,
        })
    }

    /// Prunes git's record of the missing worktree at `cwd`, then adds it
    /// back on the first of `branches` that still exists, or on the first
    /// made anew from the default branch (as origin has it) when all are
    /// gone.
    fn add_again(&self, cwd: &Path, branches: &[String]) -> Result<MadeWorktree, Report<GitError>> {
        let (git, repo) = (&self.services.git, &self.repo);
        let branch = branches
            .first()
            .ok_or_else(|| Report::new(GitError).attach("couldn't tell the worktree's branch"))?;
        git.prune_worktrees(repo)?;
        let branch = match branches
            .iter()
            .find(|branch| git.branch_exists(repo, branch))
        {
            Some(existing) => {
                git.add_worktree_on(repo, cwd, existing)?;
                existing.clone()
            }
            None => {
                let base = git.default_branch(repo)?;
                let base = start_point(git, repo, &base, |b| self.fetch(b))?;
                git.add_worktree(repo, cwd, branch, &base)?;
                branch.clone()
            }
        };
        Ok(MadeWorktree {
            repo: repo.clone(),
            path: cwd.to_owned(),
            branch,
        })
    }

    /// Fetches `branch` from origin, showing `fetching origin/<branch>…`
    /// while it runs.
    pub(super) fn fetch(&self, branch: &str) -> Result<bool, Report<GitError>> {
        self.state.write().sessions.fetching = Some(format!("origin/{branch}"));
        self.report.changed();
        let fetched = self.services.git.fetch(&self.repo, branch);
        self.state.write().sessions.fetching = None;
        self.report.changed();
        fetched
    }
}

/// The ref a new worktree of `repo` starts from for `base`: `origin/<b>` when
/// the repository has an origin and `origin_has` says it has `b` (a fetch of
/// `b` from origin), else `base` as is.
/// Only `origin/<b>`, a name without `/`, or an existing local branch is
/// looked for on origin; another remote's ref, like `upstream/x`, is used as
/// is.
fn start_point<F>(
    git: &GitService,
    repo: &Path,
    base: &str,
    origin_has: F,
) -> Result<String, Report<GitError>>
where
    F: FnOnce(&str) -> Result<bool, Report<GitError>>,
{
    let on_origin = match base.strip_prefix("origin/") {
        Some(branch) => Some(branch),
        None if !base.contains('/') || git.branch_exists(repo, base) => Some(base),
        None => None,
    };
    Ok(match on_origin {
        Some(branch) if git.has_origin(repo) && origin_has(branch)? => format!("origin/{branch}"),
        _ => base.to_owned(),
    })
}
