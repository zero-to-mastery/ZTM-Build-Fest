//! Saving, loading and removing projects.

use super::*;

impl Store {
    /// Saves the project rooted at `root` unless one is already saved there,
    /// which keeps its title and creation time and is no longer removed. An
    /// existing root takes a Research or Learn kind, but adding it as Normal
    /// keeps the kind it had. The same root always gets the same id.
    ///
    /// # Errors
    ///
    /// Returns an error if `root` isn't UTF-8 or the database can't be written.
    pub fn add_project(
        &self,
        root: &Path,
        title: &str,
        kind: ProjectKind,
        now_ms: i64,
    ) -> Result<ProjectId, Report<StoreError>> {
        self.conn
            .query_row(
                "INSERT INTO projects (root, title, created_at, kind) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (root) DO UPDATE SET
                   removed_at = NULL, kind = COALESCE(excluded.kind, kind)
                 RETURNING id",
                params![utf8(root)?, title, now_ms, project_kind_text(kind)],
                |row| row.get(0),
            )
            .map(ProjectId)
            .change_context(StoreError)
            .attach("failed to save the project")
    }

    /// Marks the project removed at `now_ms`. Its sessions stay.
    ///
    /// # Errors
    ///
    /// Returns an error if the database can't be written.
    pub fn remove_project(
        &self,
        project: ProjectId,
        now_ms: i64,
    ) -> Result<(), Report<StoreError>> {
        self.conn
            .execute(
                "UPDATE projects SET removed_at = ?2 WHERE id = ?1",
                params![project.0, now_ms],
            )
            .change_context(StoreError)
            .attach("failed to mark the project removed")?;
        Ok(())
    }
}

pub(super) fn project_row(row: &Row<'_>) -> rusqlite::Result<ProjectRow> {
    Ok(ProjectRow {
        id: ProjectId(row.get(0)?),
        root: PathBuf::from(row.get::<_, String>(1)?),
        title: row.get(2)?,
        created_at: row.get(3)?,
        removed_at: row.get(4)?,
        kind: project_kind(row.get::<_, Option<String>>(5)?.as_deref()),
    })
}

/// How a project's kind is saved; Normal is `NULL`.
fn project_kind_text(kind: ProjectKind) -> Option<&'static str> {
    match kind {
        ProjectKind::Normal => None,
        ProjectKind::Research => Some("research"),
        ProjectKind::Learn => Some("learn"),
        ProjectKind::Incognito => Some("incognito"),
        ProjectKind::SharedWorld => Some("shared-world"),
        ProjectKind::FreshWorld => Some("fresh-world"),
    }
}

/// A saved project kind; `NULL` or unknown text loads as Normal.
fn project_kind(text: Option<&str>) -> ProjectKind {
    match text {
        Some("research") => ProjectKind::Research,
        Some("learn") => ProjectKind::Learn,
        Some("incognito") => ProjectKind::Incognito,
        Some("shared-world") => ProjectKind::SharedWorld,
        Some("fresh-world") => ProjectKind::FreshWorld,
        _ => ProjectKind::Normal,
    }
}
