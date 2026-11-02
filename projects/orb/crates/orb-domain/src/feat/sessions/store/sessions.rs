//! Saving sessions, their tabs, floats and panes, and reading them back as
//! layouts.

use super::migrate::collect;
use super::*;

impl Store {
    /// Saves a new `kind` session of `project` named `name` in `dir` on
    /// `branch`, made by `parent` when it's a colonist, last active and visited at `now`, with one shell pane in
    /// `dir` and no tab: the caller saves its layout. Returns the session
    /// and its pane.
    ///
    /// # Errors
    ///
    /// Returns an error if `dir` isn't UTF-8, the project doesn't exist, or the
    /// database can't be written.
    pub fn insert_session(
        &self,
        project: ProjectId,
        kind: SessionKind,
        dir: &Path,
        branch: Option<&str>,
        name: Option<&str>,
        parent: Option<SessionId>,
        now: i64,
    ) -> Result<(SessionId, PaneId), Report<StoreError>> {
        let tx = self
            .conn
            .unchecked_transaction()
            .change_context(StoreError)
            .attach("failed to start saving the session")?;
        let session = tx
            .query_row(
                "INSERT INTO sessions
                   (project_id, kind, dir, name, branch, created_at, last_activity_at,
                    last_visited_at, active_tab, parent_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6, 0, ?7) RETURNING id",
                params![
                    project.0,
                    session_kind_text(kind),
                    utf8(dir)?,
                    name,
                    branch,
                    now,
                    parent.map(|id| id.0)
                ],
                |row| row.get(0),
            )
            .map(SessionId)
            .change_context(StoreError)
            .attach("failed to save the session")?;
        let pane = self.insert_pane(session, dir)?;
        tx.commit()
            .change_context(StoreError)
            .attach("failed to commit the session")?;
        Ok((session, pane))
    }

    /// Every saved session, its tabs and floats in order, and every pane.
    ///
    /// # Errors
    ///
    /// Returns an error if the database can't be read.
    pub fn layouts(&self) -> Result<SavedLayouts, Report<StoreError>> {
        let sessions = self
            .query(
                "SELECT id, dir, active_tab, pinned_at, settled_override, settled_at,
                        unsettled_at, last_activity_at, project_id, kind, name, branch,
                        created_at, floats_hand_changed, float_layout, parent_id
                 FROM sessions ORDER BY id",
                |row| {
                    Ok(SessionRow {
                        id: SessionId(row.get(0)?),
                        dir: PathBuf::from(row.get::<_, String>(1)?),
                        active_tab: row.get::<_, Option<usize>>(2)?.unwrap_or(0),
                        pinned_at: row.get(3)?,
                        settled_override: row
                            .get::<_, Option<String>>(4)?
                            .as_deref()
                            .and_then(SettledOverride::parse),
                        settled_at: row.get(5)?,
                        unsettled_at: row.get(6)?,
                        last_activity_at: row.get(7)?,
                        project_id: ProjectId(row.get(8)?),
                        kind: session_kind(&row.get::<_, String>(9)?),
                        name: row.get(10)?,
                        branch: row.get(11)?,
                        created_at: row.get(12)?,
                        floats_hand_changed: row.get(13)?,
                        float_layout: float_layout(&row.get::<_, String>(14)?),
                        parent: row.get::<_, Option<i64>>(15)?.map(SessionId),
                    })
                },
            )
            .attach("failed to load sessions")?;
        let tabs = self
            .query(
                "SELECT session_id, position, name, layout, focus_pane, swap_layout,
                        hand_changed
                 FROM tabs ORDER BY session_id, position",
                |row| {
                    Ok(TabRow {
                        session_id: SessionId(row.get(0)?),
                        position: row.get(1)?,
                        name: row.get(2)?,
                        layout: row.get(3)?,
                        focus_pane: row.get::<_, Option<i64>>(4)?.map(PaneId),
                        swap_layout: swap_layout(&row.get::<_, String>(5)?),
                        hand_changed: row.get(6)?,
                    })
                },
            )
            .attach("failed to load tabs")?;
        let floats = self
            .query(
                "SELECT session_id, position, pane_id, x, y, width, height, pinned
                 FROM floats ORDER BY session_id, position",
                |row| {
                    Ok(FloatRow {
                        session_id: SessionId(row.get(0)?),
                        position: row.get(1)?,
                        pane_id: PaneId(row.get(2)?),
                        rect: FloatRect {
                            x: row.get::<_, f64>(3)? as f32,
                            y: row.get::<_, f64>(4)? as f32,
                            width: row.get::<_, f64>(5)? as f32,
                            height: row.get::<_, f64>(6)? as f32,
                        },
                        pinned: row.get(7)?,
                    })
                },
            )
            .attach("failed to load floats")?;
        let panes = self
            .query(
                "SELECT id, session_id, cwd, zmx_name, zmx_dir, resume, name
                 FROM panes ORDER BY id",
                |row| {
                    Ok(PaneRow {
                        id: PaneId(row.get(0)?),
                        session_id: SessionId(row.get(1)?),
                        cwd: PathBuf::from(row.get::<_, String>(2)?),
                        zmx_name: row.get(3)?,
                        zmx_dir: row.get::<_, Option<String>>(4)?.map(PathBuf::from),
                        resume: row.get(5)?,
                        name: row.get(6)?,
                    })
                },
            )
            .attach("failed to load panes")?;
        Ok(SavedLayouts {
            sessions,
            tabs,
            floats,
            panes,
        })
    }

    /// Saves session `row`'s name, branch, pin, settle and activity state.
    ///
    /// # Errors
    ///
    /// Returns an error if the database can't be written.
    pub fn save_session(&self, row: &SessionRow) -> Result<(), Report<StoreError>> {
        self.conn
            .execute(
                "UPDATE sessions SET pinned_at = ?2, settled_override = ?3, settled_at = ?4,
                        unsettled_at = ?5, last_activity_at = ?6, name = ?7, branch = ?8
                 WHERE id = ?1",
                params![
                    row.id.0,
                    row.pinned_at,
                    row.settled_override.map(SettledOverride::as_str),
                    row.settled_at,
                    row.unsettled_at,
                    row.last_activity_at,
                    row.name,
                    row.branch,
                ],
            )
            .change_context(StoreError)
            .attach("failed to save the session")?;
        Ok(())
    }

    /// Moves `session` to `dir` on `branch`: its row's directory and branch,
    /// and every one of its panes' directories.
    ///
    /// # Errors
    ///
    /// Returns an error if `dir` isn't UTF-8 or the database can't be written.
    pub fn move_session(
        &self,
        session: SessionId,
        dir: &Path,
        branch: Option<&str>,
    ) -> Result<(), Report<StoreError>> {
        let dir = utf8(dir)?;
        let tx = self
            .conn
            .unchecked_transaction()
            .change_context(StoreError)
            .attach("failed to start moving the session")?;
        tx.execute(
            "UPDATE sessions SET dir = ?2, branch = ?3 WHERE id = ?1",
            params![session.0, dir, branch],
        )
        .and_then(|_| {
            tx.execute(
                "UPDATE panes SET cwd = ?2 WHERE session_id = ?1",
                params![session.0, dir],
            )
        })
        .change_context(StoreError)
        .attach("failed to move the session")?;
        tx.commit()
            .change_context(StoreError)
            .attach("failed to commit the session's move")
    }

    /// Saves a new pane running a shell in `cwd` in `session`.
    ///
    /// # Errors
    ///
    /// Returns an error if `cwd` isn't UTF-8, the session doesn't exist, or
    /// the database can't be written.
    pub fn insert_pane(
        &self,
        session: SessionId,
        cwd: &Path,
    ) -> Result<PaneId, Report<StoreError>> {
        self.conn
            .query_row(
                "INSERT INTO panes (session_id, cwd) VALUES (?1, ?2) RETURNING id",
                params![session.0, utf8(cwd)?],
                |row| row.get(0),
            )
            .map(PaneId)
            .change_context(StoreError)
            .attach("failed to save the pane")
    }

    /// Saves `session`'s tabs and its floats, replacing the ones it had, the
    /// position of its active tab, its float layout and whether its floats
    /// were changed by hand, and the names of `panes`, which are every pane
    /// its tabs and floats hold. Its other panes are deleted, and a
    /// agent running in one of them no longer has a pane. Returns the
    /// deleted panes.
    ///
    /// # Errors
    ///
    /// Returns an error if the session doesn't exist or the database can't be
    /// written.
    pub fn save_layout(
        &self,
        session: SessionId,
        active_tab: usize,
        tabs: &[TabRow],
        floats: &SessionFloats,
        panes: &[(PaneId, Option<String>)],
    ) -> Result<Vec<PaneId>, Report<StoreError>> {
        let tx = self
            .conn
            .unchecked_transaction()
            .change_context(StoreError)
            .attach("failed to start saving the layout")?;
        let dropped = (|| {
            tx.execute("DELETE FROM tabs WHERE session_id = ?1", [session.0])?;
            for tab in tabs {
                tx.execute(
                    "INSERT INTO tabs (session_id, position, name, layout, focus_pane,
                                       swap_layout, hand_changed)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        session.0,
                        tab.position,
                        tab.name,
                        tab.layout,
                        tab.focus_pane.map(|pane| pane.0),
                        swap_layout_text(tab.swap_layout),
                        tab.hand_changed
                    ],
                )?;
            }
            tx.execute("DELETE FROM floats WHERE session_id = ?1", [session.0])?;
            for float in &floats.rows {
                tx.execute(
                    "INSERT INTO floats (session_id, position, pane_id, x, y, width, height,
                                         pinned)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        session.0,
                        float.position,
                        float.pane_id.0,
                        f64::from(float.rect.x),
                        f64::from(float.rect.y),
                        f64::from(float.rect.width),
                        f64::from(float.rect.height),
                        float.pinned
                    ],
                )?;
            }
            tx.execute(
                "UPDATE sessions SET active_tab = ?2, floats_hand_changed = ?3, float_layout = ?4
                 WHERE id = ?1",
                params![
                    session.0,
                    active_tab,
                    floats.hand_changed,
                    float_layout_text(floats.layout)
                ],
            )?;
            for (pane, name) in panes {
                tx.execute(
                    "UPDATE panes SET name = ?3 WHERE id = ?1 AND session_id = ?2",
                    params![pane.0, session.0, name],
                )?;
            }
            let held: Vec<PaneId> = panes.iter().map(|(pane, _)| *pane).collect();
            let dropped: Vec<PaneId> = collect(
                &tx,
                "SELECT id FROM panes WHERE session_id = ?1 ORDER BY id",
                [session.0],
                |row| row.get(0).map(PaneId),
            )?
            .into_iter()
            .filter(|pane| !held.contains(pane))
            .collect();
            for pane in &dropped {
                tx.execute(
                    "UPDATE threads SET pane_id = NULL WHERE pane_id = ?1",
                    [pane.0],
                )?;
                tx.execute("DELETE FROM panes WHERE id = ?1", [pane.0])?;
            }
            Ok::<_, rusqlite::Error>(dropped)
        })()
        .change_context(StoreError)
        .attach("failed to save the layout")?;
        tx.commit()
            .change_context(StoreError)
            .attach("failed to commit the layout")?;
        Ok(dropped)
    }

    /// Deletes `session` with its tabs, floats and panes, and the agents that run
    /// or ran in it, and clears the parent of the sessions it made.
    ///
    /// # Errors
    ///
    /// Returns an error if the database can't be written.
    pub fn delete_session(&self, session: SessionId) -> Result<(), Report<StoreError>> {
        let tx = self
            .conn
            .unchecked_transaction()
            .change_context(StoreError)
            .attach("failed to start deleting the session")?;
        [
            "DELETE FROM threads
              WHERE orb_session_id = ?1
                 OR pane_id IN (SELECT id FROM panes WHERE session_id = ?1)",
            "DELETE FROM tabs WHERE session_id = ?1",
            "DELETE FROM floats WHERE session_id = ?1",
            "DELETE FROM panes WHERE session_id = ?1",
            "UPDATE sessions SET parent_id = NULL WHERE parent_id = ?1",
            "DELETE FROM sessions WHERE id = ?1",
        ]
        .into_iter()
        .try_for_each(|sql| tx.execute(sql, [session.0]).map(drop))
        .change_context(StoreError)
        .attach("failed to delete the session")?;
        tx.commit()
            .change_context(StoreError)
            .attach("failed to commit deleting the session")
    }
}

/// How session kind `kind` is saved.
fn session_kind_text(kind: SessionKind) -> &'static str {
    match kind {
        SessionKind::Plain => "plain",
        SessionKind::Colony => "colony",
        SessionKind::Incognito => "incognito",
    }
}

/// The session kind saved as `text`; anything orb doesn't know is Plain.
fn session_kind(text: &str) -> SessionKind {
    match text {
        "colony" | "research" | "learn" => SessionKind::Colony,
        "incognito" => SessionKind::Incognito,
        _ => SessionKind::Plain,
    }
}

/// How a tab's swap layout is saved.
fn swap_layout_text(layout: SwapLayout) -> &'static str {
    match layout {
        SwapLayout::Base => "base",
        SwapLayout::Vertical => "vertical",
        SwapLayout::Horizontal => "horizontal",
        SwapLayout::Stacked => "stacked",
        SwapLayout::HalfStacked => "half-stacked",
    }
}

/// The swap layout saved as `text`; anything orb doesn't know is vertical,
/// as tabs saved before swap layouts load.
fn swap_layout(text: &str) -> SwapLayout {
    match text {
        "base" => SwapLayout::Base,
        "horizontal" => SwapLayout::Horizontal,
        "stacked" => SwapLayout::Stacked,
        "half-stacked" => SwapLayout::HalfStacked,
        _ => SwapLayout::Vertical,
    }
}

/// How a session's float layout is saved.
fn float_layout_text(layout: FloatLayout) -> &'static str {
    match layout {
        FloatLayout::Staggered => "staggered",
        FloatLayout::Enlarged => "enlarged",
        FloatLayout::Spread => "spread",
    }
}

/// The float layout saved as `text`; anything orb doesn't know is staggered.
fn float_layout(text: &str) -> FloatLayout {
    match text {
        "enlarged" => FloatLayout::Enlarged,
        "spread" => FloatLayout::Spread,
        _ => FloatLayout::Staggered,
    }
}
