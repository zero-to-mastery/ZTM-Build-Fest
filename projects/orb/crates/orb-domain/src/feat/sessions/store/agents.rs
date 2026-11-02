//! Saving and loading agents.

use super::*;

impl Store {
    /// Saves an agent running in `row.pane`, in the project of that pane's
    /// session, last active and visited when created. Returns it and its
    /// project.
    ///
    /// # Errors
    ///
    /// Returns an error if a path isn't UTF-8, the pane doesn't exist, the id
    /// is already an agent's short id, or the database can't be written.
    pub fn insert_pane_agent(
        &self,
        row: &NewPaneAgent,
    ) -> Result<(AgentId, ProjectId), Report<StoreError>> {
        let transcript_path = row.transcript_path.as_deref().map(utf8).transpose()?;
        self.conn
            .query_row(
                "INSERT INTO threads
                   (project_id, short_id, session_id, cwd, transcript_path, created_at,
                    last_activity_at, last_visited_at, harness, pane_id, orb_session_id)
                 SELECT s.project_id, ?2, ?2, ?3, ?4, ?5, ?5, ?5, ?6, p.id, s.id
                   FROM panes p JOIN sessions s ON s.id = p.session_id
                  WHERE p.id = ?1
                 RETURNING id, project_id",
                params![
                    row.pane.0,
                    row.session_id,
                    utf8(&row.cwd)?,
                    transcript_path,
                    row.created_at,
                    row.harness.as_str(),
                ],
                |found| Ok((AgentId(found.get(0)?), ProjectId(found.get(1)?))),
            )
            .change_context(StoreError)
            .attach("failed to save the pane's agent")
    }

    /// Sets the command typed into pane `pane`'s fresh shell; `None` = none.
    ///
    /// # Errors
    ///
    /// Returns an error if the database can't be written.
    pub fn set_pane_resume(
        &self,
        pane: PaneId,
        resume: Option<&str>,
    ) -> Result<(), Report<StoreError>> {
        self.conn
            .execute(
                "UPDATE panes SET resume = ?2 WHERE id = ?1",
                params![pane.0, resume],
            )
            .change_context(StoreError)
            .attach("failed to save the pane's resume command")?;
        Ok(())
    }

    /// Updates everything about an agent that changes after it's created: its
    /// session and directory (an agent can move to another workspace), titles,
    /// branch, transcript position, turn start, activity and visit stamps,
    /// and the pane it runs in. Its model stays as inserted.
    ///
    /// # Errors
    ///
    /// Returns an error if the cwd or transcript path isn't UTF-8, the short
    /// id belongs to another agent, or the database can't be written.
    pub fn save_agent(&self, row: &AgentRow) -> Result<(), Report<StoreError>> {
        let transcript_path = row.transcript_path.as_deref().map(utf8).transpose()?;
        self.conn
            .execute(
                "UPDATE threads SET session_id = ?2, title = ?3, transcript_path = ?4,
                        transcript_offset = ?5, turn_started_at = ?6, custom_title = ?7,
                        branch = ?8, last_activity_at = ?9, last_visited_at = ?10,
                        short_id = ?11, cwd = ?12, ai_titled = ?13, renamed_title = ?14,
                        pane_id = ?15, orb_session_id = ?16
                 WHERE id = ?1",
                params![
                    row.id.0,
                    row.session_id,
                    row.title,
                    transcript_path,
                    row.transcript_offset,
                    row.turn_started_at,
                    row.custom_title,
                    row.branch,
                    row.last_activity_at,
                    row.last_visited_at,
                    row.short_id,
                    utf8(&row.cwd)?,
                    row.ai_titled,
                    row.renamed_title,
                    row.pane_id.map(|pane| pane.0),
                    row.orb_session.map(|session| session.0),
                ],
            )
            .change_context(StoreError)
            .attach("failed to update the agent")?;
        Ok(())
    }
}

pub(super) fn agent_row(row: &Row<'_>) -> rusqlite::Result<AgentRow> {
    Ok(AgentRow {
        id: AgentId(row.get(0)?),
        project_id: ProjectId(row.get(1)?),
        short_id: row.get(2)?,
        session_id: row.get(3)?,
        title: row.get(4)?,
        custom_title: row.get(10)?,
        cwd: PathBuf::from(row.get::<_, String>(5)?),
        transcript_path: row.get::<_, Option<String>>(6)?.map(PathBuf::from),
        transcript_offset: row.get(7)?,
        created_at: row.get(8)?,
        turn_started_at: row.get(9)?,
        branch: row.get(11)?,
        last_activity_at: row.get(12)?,
        last_visited_at: row.get(13)?,
        ai_titled: row.get(14)?,
        model: row.get(15)?,
        renamed_title: row.get(16)?,
        harness: HarnessId::new(row.get::<_, String>(17)?),
        pane_id: row.get::<_, Option<i64>>(18)?.map(PaneId),
        orb_session: row.get::<_, Option<i64>>(19)?.map(SessionId),
    })
}
