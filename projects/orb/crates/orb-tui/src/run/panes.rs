//! Pane lifecycle: which panes to attach, drop, kill or spawn as the layouts
//! change, what a pane's exit means, and bringing panes back at start-up with
//! their resume command typed.

use super::*;

/// What `Command::Attach` does for an agent without a live pane.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum AttachPlan {
    /// Start the attach command in the agent's directory.
    Spawn,
    /// The agent's orb worktree is gone: have the sessions actor recreate it.
    Restore,
}

/// Restore when `cwd` is missing and is one of orb's worktrees under
/// `worktrees_root`; otherwise spawn, so a missing directory elsewhere
/// behaves as it always has.
pub(super) fn attach_or_restore(cwd: &Path, worktrees_root: &Path) -> AttachPlan {
    if cwd.is_dir() || !is_orb_worktree(worktrees_root, cwd) {
        AttachPlan::Spawn
    } else {
        AttachPlan::Restore
    }
}

/// Whether pane `id` holds an agent: one runs there, or the pane brings one
/// back. Such a pane tells its child images don't work, so agents look as
/// they always did.
pub(super) fn holds_agent(state: &AppState, id: PaneId) -> bool {
    state.sessions.agent_in(id).is_some()
        || state
            .layouts
            .entry(id)
            .is_some_and(|entry| entry.resume.is_some())
}

/// Each pane of an unsettled session, with its owner and zmx session: what
/// start-up attaches again when zmx still runs it.
pub(super) fn reattachable(state: &AppState) -> Vec<(SessionId, ZmxSession)> {
    state
        .layouts
        .pane_ids()
        .into_iter()
        .filter_map(|id| {
            let owner = state.layouts.owner_of(id)?;
            let unsettled = state
                .sessions
                .session(owner)
                .is_some_and(|session| session.settled_at.is_none());
            unsettled.then(|| Some((owner, state.layouts.entry(id)?.zmx.clone())))?
        })
        .collect()
}

/// Closes each `ended` pane of an `attached` session in its layout; returns
/// the sessions whose layouts changed. Panes of other sessions ended because
/// orb killed them, so their layouts keep them.
pub(super) fn closed_in_layouts(
    layouts: &mut Layouts,
    attached: &HashSet<SessionId>,
    ended: &HashSet<PaneId>,
) -> HashSet<SessionId> {
    let mut edited = HashSet::new();
    for &id in ended {
        match layouts.owner_of(id) {
            Some(owner) if attached.contains(&owner) => {
                layouts.close_pane(id);
                edited.insert(owner);
            }
            _ => {}
        }
    }
    edited
}

/// The panes to drop, given each as (pane, ended): the ended ones, and
/// those no layout holds any more (`keep`).
pub(super) fn to_drop<I>(panes: I, keep: &HashSet<PaneId>) -> Vec<PaneId>
where
    I: IntoIterator<Item = (PaneId, bool)>,
{
    panes
        .into_iter()
        .filter(|&(id, exited)| exited || !keep.contains(&id))
        .map(|(id, _)| id)
        .collect()
}

/// Dropped panes no layout holds any more (`all`) and that didn't end:
/// closed or deleted while running, so their zmx session is killed. A pane
/// still in a layout keeps running for its session's next attach.
pub(super) fn to_kill(
    gone: &[PaneId],
    ended: &HashSet<PaneId>,
    all: &HashSet<PaneId>,
) -> Vec<PaneId> {
    gone.iter()
        .copied()
        .filter(|id| !ended.contains(id) && !all.contains(id))
        .collect()
}

/// Every kept pane without a client in `live`, except the `broken` ones.
pub(super) fn to_spawn<P>(
    keep: &HashSet<PaneId>,
    live: &HashMap<PaneId, P>,
    broken: &HashSet<PaneId>,
) -> Vec<PaneId> {
    keep.iter()
        .copied()
        .filter(|id| !live.contains_key(id) && !broken.contains(id))
        .collect()
}

/// Forgets the `broken` panes no attached session holds (`keep`), so they
/// get a client again the next time their session is attached.
pub(super) fn clear_detached(broken: &mut HashSet<PaneId>, keep: &HashSet<PaneId>) {
    broken.retain(|id| keep.contains(id));
}

/// The message box text after pane `name` stopped showing.
pub(super) fn broken_pane_message(name: &str) -> String {
    format!("stopped showing pane {name} after an error; it keeps running")
}

/// What to type into each pane about to get a client, given as (pane, its
/// zmx session, its resume command): the resume command, for each pane whose
/// session zmx didn't list, since the attach then makes a fresh shell.
/// `listed` maps each socket dir to the names zmx listed there, or to `None`
/// when it couldn't list it; nothing is typed there, since a live agent
/// would take the text as a prompt. A command with a control character is
/// never typed.
pub(super) fn resume_plan(
    spawning: &[(PaneId, ZmxSession, Option<String>)],
    listed: &HashMap<PathBuf, Option<HashSet<String>>>,
) -> HashMap<PaneId, String> {
    spawning
        .iter()
        .filter_map(|(id, zmx, resume)| {
            let resume = resume.as_ref()?;
            let names = listed.get(&zmx.dir)?.as_ref()?;
            (!names.contains(&zmx.name) && !resume.chars().any(char::is_control))
                .then(|| (*id, resume.clone()))
        })
        .collect()
}

/// The sessions start-up attaches, from `panes` (each pane of an unsettled
/// session, see [`reattachable`]): each with a pane zmx still runs
/// (`running`), so its program shows again, and each whose directory is
/// there (`present`), so panes whose zmx session died while orb was down
/// come back as fresh shells and resume. A session whose directory is gone
/// and that runs nothing waits for `⏎`, which recreates an orb worktree
/// first.
pub(super) fn attach_at_start(
    panes: &[(SessionId, ZmxSession)],
    running: &HashSet<ZmxSession>,
    present: &HashSet<SessionId>,
) -> HashSet<SessionId> {
    panes
        .iter()
        .filter(|(owner, zmx)| running.contains(zmx) || present.contains(owner))
        .map(|(owner, _)| *owner)
        .collect()
}

/// The owners in `panes` whose session's directory is there.
pub(super) fn present_at_start(
    state: &AppState,
    panes: &[(SessionId, ZmxSession)],
) -> HashSet<SessionId> {
    panes
        .iter()
        .map(|(owner, _)| *owner)
        .filter(|owner| {
            state
                .sessions
                .session(*owner)
                .is_some_and(|session| session.dir.is_dir())
        })
        .collect()
}

/// The sessions on orb's pane dir to kill at start: every `orb-p*` name no
/// pane names (`owned`). Other names are left alone, and so is every name
/// after a `partial_load`, since a pane orb couldn't read may own it.
pub(super) fn stale_sessions(
    listed: Vec<String>,
    owned: &HashSet<String>,
    partial_load: bool,
) -> Vec<String> {
    if partial_load {
        return Vec::new();
    }
    listed
        .into_iter()
        .filter(|name| name.starts_with("orb-p") && !owned.contains(name))
        .collect()
}

/// Why a pane's `zmx attach` client exited.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PaneExit {
    /// zmx no longer lists the session: its program ended, so the pane closes.
    Ended,
    /// zmx still lists it, or couldn't say, so only the client died: attach
    /// again.
    Respawn,
    /// The client died again after one respawn: its session detaches, keeping
    /// the pane, and orb says so.
    Failed,
    /// Its session isn't shown: only the client is dropped, keeping the pane
    /// and its program for the session's next attach.
    Drop,
}

/// How to treat a pane whose client exited, given whether zmx still `listed`
/// its session (`None` when zmx couldn't be asked), whether it was
/// `respawned` once already, and whether its session is `shown` (on the
/// right side). A pane whose session isn't shown is only dropped, whatever
/// zmx says. Otherwise only a session zmx positively no longer lists has
/// ended.
pub(super) fn classify_exit(listed: Option<bool>, respawned: bool, shown: bool) -> PaneExit {
    match (shown, listed, respawned) {
        (false, _, _) => PaneExit::Drop,
        (true, Some(false), _) => PaneExit::Ended,
        (true, Some(true) | None, false) => PaneExit::Respawn,
        (true, Some(true) | None, true) => PaneExit::Failed,
    }
}

/// What happens to a pane after its client's exit is classified.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ExitOutcome {
    /// A new client attached: the pane stays, marked respawned.
    Reattached,
    /// Its program ended: the pane closes.
    Closed,
    /// No client could attach: its session detaches, keeping the pane, and
    /// the mode line says so.
    Detached,
    /// Its session isn't shown: the client is dropped, and the pane and its
    /// program stay for the session's next attach.
    Dropped,
}

/// The outcome of `exit` once a new client did (`reattached`) or didn't start.
pub(super) fn exit_outcome(exit: PaneExit, reattached: bool) -> ExitOutcome {
    match (exit, reattached) {
        (_, true) => ExitOutcome::Reattached,
        (PaneExit::Ended, false) => ExitOutcome::Closed,
        (PaneExit::Respawn | PaneExit::Failed, false) => ExitOutcome::Detached,
        (PaneExit::Drop, false) => ExitOutcome::Dropped,
    }
}

/// The start screen's pane error once panes are dropped, given for each
/// dropped pane whether its program exited within [`EARLY_EXIT`] of
/// starting and its session's title: `session <title> exited at start`
/// for the first that did (`session exited at start` with no title), else
/// `error` as it was.
pub(super) fn pane_error_after<I>(error: Option<String>, dropped: I) -> Option<String>
where
    I: IntoIterator<Item = (bool, Option<String>)>,
{
    match dropped.into_iter().find(|(early, _)| *early) {
        Some((_, Some(title))) => Some(format!("session {title} exited at start")),
        Some((_, None)) => Some(EXITED_AT_START.to_owned()),
        None => error,
    }
}

impl App {
    /// Drops broken pane `id`'s client (its program keeps running in zmx),
    /// keeps it from getting another while its session stays attached, and
    /// says so in the message box and the log. It keeps its zmx session so
    /// closing it in its layout still ends its program.
    pub(super) fn drop_broken(&mut self, id: PaneId) {
        if self.panes.remove(&id).is_none() {
            return;
        }
        self.respawned.remove(&id);
        self.typing.remove(&id);
        self.broken.insert(id);
        let text = {
            let mut app = self.state.write();
            let app = &mut *app;
            let text = broken_pane_message(app.layouts.agent_name(id, app.sessions.agent_in(id)));
            app.sessions.error = Some(text.clone());
            text
        };
        self.log.line("error", &text);
    }

    /// Classifies each pane whose client exit arrived (see [`classify_exit`]):
    /// attaches a dead client again once, and on a second death detaches its
    /// session, keeping the pane and its program, and puts `couldn't reattach
    /// to zmx session <name>` on the mode line. A pane whose session isn't
    /// shown any more isn't listed or attached again; reconcile drops its
    /// client and keeps the pane and its program. Returns the panes to close.
    /// An exit from a pane already replaced or dropped is ignored.
    fn classify_exits(&mut self) -> HashSet<PaneId> {
        let mut ended = HashSet::new();
        for id in mem::take(&mut self.exited) {
            if !self.panes.get(&id).is_some_and(Pane::has_exited) {
                continue;
            }
            let Some((session, cwd)) = self.pane_launch(id) else {
                ended.insert(id);
                continue;
            };
            let shown = {
                let app = self.state.read();
                app.layouts
                    .owner_of(id)
                    .is_some_and(|owner| app.attached.contains(&owner))
            };
            let listed = if shown {
                self.zmx
                    .list(&session.dir)
                    .inspect_err(|report| {
                        self.log.error(
                            &format!("couldn't list zmx sessions on {}", session.dir.display()),
                            report,
                        );
                    })
                    .ok()
                    .map(|entries| entries.iter().any(|entry| entry.name == session.name))
            } else {
                None
            };
            let exit = classify_exit(listed, self.respawned.contains(&id), shown);
            let respawned = match exit {
                PaneExit::Respawn => self.spawn_pane(id, &session, &cwd),
                PaneExit::Ended | PaneExit::Failed | PaneExit::Drop => None,
            };
            match (exit_outcome(exit, respawned.is_some()), respawned) {
                (ExitOutcome::Reattached, Some(pane)) => {
                    if self.focused_pane == Some(id) {
                        pane.focus(true);
                    }
                    self.panes.insert(id, pane);
                    self.pane_sessions.insert(id, session.clone());
                    self.respawned.insert(id);
                }
                (ExitOutcome::Closed, _) => {
                    ended.insert(id);
                }
                (ExitOutcome::Dropped, _) => {}
                (ExitOutcome::Detached | ExitOutcome::Reattached, _) => {
                    let mut app = self.state.write();
                    if let Some(owner) = app.layouts.owner_of(id) {
                        app.attached.remove(&owner);
                    }
                    app.sessions.error =
                        Some(format!("couldn't reattach to zmx session {}", session.name));
                }
            }
        }
        ended
    }

    /// Drops the panes whose program ended or whose client died for good
    /// (see [`Self::classify_exits`]) and those of sessions no longer
    /// attached, which ends their `zmx attach` client. A pane of an attached
    /// session that ended closes in its layout, which is saved; a session
    /// whose layout emptied leaves `attached`. A dropped pane no layout holds
    /// any more that didn't end is killed with `zmx kill`; a broken pane no
    /// layout holds any more is killed too. A pane that ended
    /// within [`EARLY_EXIT`] of starting leaves `session <title> exited at
    /// start` on the start screen, and that line in the log. Every pane of an attached session gets a client;
    /// when one can't start, its session leaves `attached` and `couldn't
    /// start zmx attach` shows on the start screen. A pane holding an agent
    /// (see [`holds_agent`]) stops answering image questions before the
    /// agent's resume command is typed. If the keys were in a pane and no
    /// layout is shown any more, they go to the sidebar.
    pub(super) fn reconcile(&mut self) {
        let ended = self.classify_exits();
        let (keep, all, edited, titles) = {
            let mut app = self.state.write();
            let app = &mut *app;
            let titles: HashMap<PaneId, String> = self
                .panes
                .iter()
                .filter(|(_, pane)| pane.exited_early(EARLY_EXIT))
                .filter_map(|(id, _)| {
                    app.layouts
                        .owner_of(*id)
                        .and_then(|owner| app.sessions.session(owner))
                        .map(|session| (*id, app.sessions.title(session)))
                })
                .collect();
            let edited = closed_in_layouts(&mut app.layouts, &app.attached, &ended);
            app.attached
                .retain(|owner| app.layouts.get(*owner).is_some());
            let keep: HashSet<PaneId> = app
                .attached
                .iter()
                .flat_map(|owner| app.layouts.session_panes(*owner))
                .collect();
            (keep, app.layouts.pane_ids(), edited, titles)
        };
        for owner in edited {
            self.execute(&Command::Sessions(SessionsCommand::SaveLayout(owner)));
        }
        let gone = to_drop(self.panes.keys().map(|id| (*id, ended.contains(id))), &keep);
        let early_exit = pane_error_after(
            None,
            gone.iter().filter_map(|id| {
                self.panes
                    .get(id)
                    .map(|pane| (pane.exited_early(EARLY_EXIT), titles.get(id).cloned()))
            }),
        );
        if let Some(text) = &early_exit {
            self.log.line("error", text);
        }
        self.pane_error = early_exit.or_else(|| self.pane_error.take());
        for id in to_kill(&gone, &ended, &all) {
            if let Some(session) = self.pane_sessions.get(&id) {
                self.zmx.kill(session, "closed in its layout");
            }
        }
        for id in &gone {
            self.panes.remove(id);
            self.pane_sessions.remove(id);
            self.respawned.remove(id);
            self.typing.remove(id);
        }
        let unbroken: Vec<PaneId> = self
            .broken
            .iter()
            .copied()
            .filter(|id| !keep.contains(id))
            .collect();
        for id in to_kill(&unbroken, &HashSet::new(), &all) {
            if let Some(session) = self.pane_sessions.get(&id) {
                self.zmx.kill(session, "closed in its layout");
            }
        }
        for id in &unbroken {
            self.pane_sessions.remove(id);
        }
        clear_detached(&mut self.broken, &keep);
        let spawning = to_spawn(&keep, &self.panes, &self.broken);
        let plan = self.plan_resumes(&spawning);
        self.typing.extend(plan);
        for id in spawning {
            let spawned = self.pane_launch(id).and_then(|(session, cwd)| {
                self.spawn_pane(id, &session, &cwd)
                    .map(|pane| (pane, session))
            });
            match spawned {
                Some((pane, session)) => {
                    if self.focused_pane == Some(id) {
                        pane.focus(true);
                    }
                    self.panes.insert(id, pane);
                    self.pane_sessions.insert(id, session);
                }
                None => {
                    self.typing.remove(&id);
                    self.pane_error = Some("couldn't start zmx attach".to_owned());
                    let mut app = self.state.write();
                    if let Some(owner) = app.layouts.owner_of(id) {
                        app.attached.remove(&owner);
                    }
                }
            }
        }
        self.quiet_agent_panes();
        let mut app = self.state.write();
        if app.focus == Focus::Pane && app.shown_layout().is_none() {
            app.focus = after_pane(app.focus);
        }
    }

    /// Stops every pane holding an agent (see [`holds_agent`]) from
    /// answering image questions.
    // ponytail: stays off for the pane's life once it held an agent; turn it
    // back on when its agent goes if a browser in such a pane matters.
    fn quiet_agent_panes(&self) {
        let app = self.state.read();
        for (id, pane) in &self.panes {
            if holds_agent(&app, *id) {
                pane.answer_graphics(false);
            }
        }
    }

    /// [`resume_plan`] for `spawning`, listing once each socket dir that
    /// holds a pane with a resume command.
    fn plan_resumes(&self, spawning: &[PaneId]) -> HashMap<PaneId, String> {
        let spawning: Vec<(PaneId, ZmxSession, Option<String>)> = {
            let state = self.state.read();
            spawning
                .iter()
                .filter_map(|&id| {
                    let entry = state.layouts.entry(id)?;
                    Some((id, entry.zmx.clone(), entry.resume.clone()))
                })
                .collect()
        };
        let listed = spawning
            .iter()
            .filter(|(_, _, resume)| resume.is_some())
            .map(|(_, zmx, _)| zmx.dir.clone())
            .collect::<HashSet<PathBuf>>()
            .into_iter()
            .map(|dir| {
                let names = self
                    .zmx
                    .list(&dir)
                    .inspect_err(|report| {
                        self.log.error(
                            &format!("couldn't list zmx sessions on {}", dir.display()),
                            report,
                        );
                    })
                    .ok()
                    .map(|entries| entries.into_iter().map(|entry| entry.name).collect());
                (dir, names)
            })
            .collect();
        resume_plan(&spawning, &listed)
    }

    /// Types pane `id`'s waiting resume command, once, now that its client
    /// printed: zmx's `session "…" created` banner comes before the shell
    /// starts, and the shell reads the line at its first prompt.
    pub(super) fn type_resume(&mut self, id: PaneId) {
        if let Some(line) = self.typing.remove(&id)
            && let Some(pane) = self.panes.get(&id)
        {
            pane.type_line(&line);
        }
    }

    /// Kills every `orb-p*` session on orb's pane dir that no pane names
    /// (see [`stale_sessions`]), then attaches every unsettled session whose
    /// directory is there or that has a pane zmx still runs (see
    /// [`attach_at_start`]) and gives its panes their clients, so programs
    /// left running when orb quit show again and panes whose zmx session died
    /// while orb was down come back with their agents resumed (see
    /// [`resume_plan`]). Each socket dir the panes use is listed once; a dir
    /// zmx can't list brings no running program back. orb calls this after
    /// its first frame, so the screen shows while panes reconnect.
    pub(super) fn reattach_live(&mut self) {
        let owned: HashSet<String> = {
            let state = self.state.read();
            state
                .layouts
                .pane_ids()
                .into_iter()
                .filter_map(|id| state.layouts.entry(id))
                .filter(|entry| entry.zmx.dir == self.zmx.dir())
                .map(|entry| entry.zmx.name.clone())
                .collect()
        };
        let listed = self
            .zmx
            .list(self.zmx.dir())
            .inspect_err(|report| {
                self.log.error(
                    &format!("couldn't list zmx sessions on {}", self.zmx.dir().display()),
                    report,
                );
            })
            .unwrap_or_default()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        let partial_load = self.state.read().sessions.partial_load;
        for name in stale_sessions(listed, &owned, partial_load) {
            self.zmx
                .kill(&self.zmx.session(name), "no pane names it at start");
        }
        let panes = reattachable(&self.state.read());
        let running: HashSet<ZmxSession> = {
            let dirs: HashSet<&Path> = panes.iter().map(|(_, zmx)| zmx.dir.as_path()).collect();
            dirs.into_iter()
                .flat_map(|dir| {
                    self.zmx
                        .list(dir)
                        .inspect_err(|report| {
                            self.log.error(
                                &format!("couldn't list zmx sessions on {}", dir.display()),
                                report,
                            );
                        })
                        .unwrap_or_default()
                        .into_iter()
                        .map(move |entry| ZmxSession {
                            name: entry.name,
                            dir: dir.to_owned(),
                        })
                })
                .collect()
        };
        let present = present_at_start(&self.state.read(), &panes);
        let owners = attach_at_start(&panes, &running, &present);
        self.state.write().attached.extend(owners);
        self.reconcile();
    }

    /// Where pane `id` runs, as its layout says: its zmx session and its
    /// directory. `None` once no layout holds it.
    fn pane_launch(&self, id: PaneId) -> Option<(ZmxSession, PathBuf)> {
        let state = self.state.read();
        let entry = state.layouts.entry(id)?;
        Some((entry.zmx.clone(), entry.cwd.clone()))
    }

    /// Runs the attach command on `session` for pane `id`, in `cwd`, which starts
    /// the user's shell when zmx makes the session,
    /// sized to the inside of its frame in the shown layout (else to the
    /// inside of a frame over the whole pane area),
    /// with orb's child environment and the pane's `ORB_PANE_ID`; `None` if
    /// it can't start.
    fn spawn_pane(&self, id: PaneId, session: &ZmxSession, cwd: &Path) -> Option<Pane> {
        let tx = self.tx.clone();
        let command = PaneCommand {
            argv: (self.attach)(session),
            cwd: cwd.to_owned(),
            env: pane_env(&self.env, id),
            graphics: self.outer.graphics,
            colors: Some(PaneColors {
                foreground: self.outer.foreground.unwrap_or(FG),
                background: self.outer.orb_background(),
                palette: self.outer.palette,
            }),
        };
        let area = {
            let state = self.state.read();
            state
                .shown_layout()
                .and_then(|layout| {
                    tabs::placement(&state, layout, self.pane_area)
                        .panes
                        .into_iter()
                        .find(|place| place.pane == id)
                })
                .map_or(self.pane_area.inner(Margin::new(1, 1)), |place| {
                    place.content()
                })
        };
        Pane::spawn(&command, PaneSize::new(area, self.cell), move |event| {
            let _ = tx.send(LoopEvent::Pane(id, event));
        })
        .inspect_err(|report| {
            self.log.error(
                &format!("couldn't start zmx attach for {}", session.name),
                report,
            );
        })
        .ok()
    }
}
