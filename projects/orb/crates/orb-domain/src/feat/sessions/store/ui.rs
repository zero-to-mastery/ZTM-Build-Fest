//! Saving and loading the layout settings and the jump list.

use super::*;

impl Store {
    /// How the user last left orb's layout; defaults if never saved.
    ///
    /// # Errors
    ///
    /// Returns an error if the database can't be read.
    pub fn ui(&self) -> Result<Ui, Report<StoreError>> {
        self.conn
            .query_row(
                "SELECT sidebar_width, project_filter FROM ui WHERE id = 1",
                [],
                ui_row,
            )
            .optional()
            .map(Option::unwrap_or_default)
            .change_context(StoreError)
            .attach("failed to read the layout settings")
    }

    /// Saves how the user left orb's layout, replacing what was saved.
    ///
    /// # Errors
    ///
    /// Returns an error if the filtered project doesn't exist or the database
    /// can't be written.
    pub fn save_ui(&self, ui: &Ui) -> Result<(), Report<StoreError>> {
        self.conn
            .execute(
                "INSERT INTO ui (id, sidebar_width, project_filter) VALUES (1, ?1, ?2)
                 ON CONFLICT (id) DO UPDATE SET sidebar_width = excluded.sidebar_width,
                                                project_filter = excluded.project_filter",
                params![ui.sidebar_width, ui.project_filter.map(|project| project.0)],
            )
            .change_context(StoreError)
            .attach("failed to save the layout settings")?;
        Ok(())
    }

    /// The saved jump list's rows, oldest first; a row of an unknown kind, or
    /// an agent row whose pane is gone, is skipped.
    ///
    /// # Errors
    ///
    /// Returns an error if the database can't be read.
    pub fn jumps(&self) -> Result<Vec<SidebarItem>, Report<StoreError>> {
        let rows = self
            .query(
                "SELECT j.kind, j.item_id, p.session_id FROM jumps j
                 LEFT JOIN panes p ON j.kind = 'agent' AND p.id = j.item_id
                 ORDER BY j.position",
                |row| {
                    Ok(jump_item(
                        &row.get::<_, String>(0)?,
                        row.get(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .attach("failed to read the jump list")?;
        Ok(rows.into_iter().flatten().collect())
    }

    /// Saves the jump list's rows, oldest first, replacing what was saved.
    /// The Settled header is never saved.
    ///
    /// # Errors
    ///
    /// Returns an error if the database can't be written.
    pub fn save_jumps(&self, items: &[SidebarItem]) -> Result<(), Report<StoreError>> {
        let tx = self
            .conn
            .unchecked_transaction()
            .change_context(StoreError)
            .attach("failed to start saving the jump list")?;
        tx.execute("DELETE FROM jumps", [])
            .change_context(StoreError)
            .attach("failed to clear the saved jump list")?;
        for (position, (kind, id)) in items.iter().filter_map(|&item| jump_kind(item)).enumerate() {
            tx.execute(
                "INSERT INTO jumps (position, kind, item_id) VALUES (?1, ?2, ?3)",
                params![position, kind, id],
            )
            .change_context(StoreError)
            .attach("failed to save a jump")?;
        }
        tx.commit()
            .change_context(StoreError)
            .attach("failed to commit the jump list")
    }
}

/// The layout settings; a width beyond `u16` loads as the nearest bound.
fn ui_row(row: &Row<'_>) -> rusqlite::Result<Ui> {
    Ok(Ui {
        sidebar_width: row
            .get::<_, Option<i64>>(0)?
            .map(|width| u16::try_from(width.max(0)).unwrap_or(u16::MAX)),
        project_filter: row.get::<_, Option<i64>>(1)?.map(ProjectId),
    })
}

/// How a jump-list row is saved: its kind and id (an agent by its pane); the
/// Settled header and colonists rows aren't.
fn jump_kind(item: SidebarItem) -> Option<(&'static str, i64)> {
    match item {
        SidebarItem::Session(id) => Some(("session", id.0)),
        SidebarItem::Agent { pane, .. } => Some(("agent", pane.0)),
        SidebarItem::SettledShelf | SidebarItem::Colonists(_) => None,
    }
}

/// The jump-list row saved as `kind` and `id`; an agent row needs its pane's
/// `session`. `None` for an unknown kind or an agent whose pane is gone.
fn jump_item(kind: &str, id: i64, session: Option<i64>) -> Option<SidebarItem> {
    match kind {
        "session" => Some(SidebarItem::Session(SessionId(id))),
        "agent" => Some(SidebarItem::Agent {
            session: SessionId(session?),
            pane: PaneId(id),
        }),
        _ => None,
    }
}
