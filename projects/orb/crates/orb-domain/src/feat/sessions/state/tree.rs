//! The sidebar's tree: which sessions it lists and where, the rows under
//! each card, and opening what hides the cursor's row.

use super::*;

impl Sessions {
    /// The sessions under `id` at any depth: its colonists, theirs, and so
    /// on, sessions being deleted included. A settled session, and
    /// everything under it, counts only when `settled`.
    #[must_use]
    pub fn below(&self, id: SessionId, settled: bool) -> Vec<SessionId> {
        let mut found: Vec<SessionId> = Vec::new();
        let mut next = vec![id];
        while let Some(parent) = next.pop() {
            let children: Vec<SessionId> = self
                .sessions
                .iter()
                .filter(|session| {
                    session.parent == Some(parent)
                        && (settled || session.settled_at.is_none())
                        && session.id != id
                        && !found.contains(&session.id)
                })
                .map(|session| session.id)
                .collect();
            found.extend(&children);
            next.extend(children);
        }
        found
    }

    /// The unsettled sessions under `id` at any depth, leaving out those
    /// being deleted.
    #[must_use]
    pub fn under(&self, id: SessionId) -> Vec<SessionId> {
        let mut found = self.below(id, false);
        found.retain(|session| !self.deleting.contains(session));
        found
    }

    /// Session `id`'s unsettled colonists, not being deleted, in sidebar
    /// order: pinned (newest pin first), then the rest (newest created or
    /// un-settled first); ties go to the higher id.
    pub fn colonists(&self, id: SessionId) -> Vec<&Session> {
        in_sidebar_order(self.sessions.iter().filter(|session| {
            session.parent == Some(id)
                && session.settled_at.is_none()
                && !self.deleting.contains(&session.id)
        }))
    }

    /// The agent most needing the user among session `id`'s own agents and
    /// those of every session under it; a card's status icon is its.
    pub fn status(&self, id: SessionId) -> Option<&Agent> {
        most_urgent(
            std::iter::once(id)
                .chain(self.under(id))
                .flat_map(|session| self.agents(session)),
        )
    }

    /// Whether one of session `id`'s own agents waits for an approval or an
    /// answer.
    pub fn stuck(&self, id: SessionId) -> bool {
        self.agents(id).iter().any(|agent| {
            matches!(
                agent.status,
                AgentStatus::NeedsApproval | AgentStatus::NeedsInput
            )
        })
    }

    /// Whether the project filter lets the sidebar list session `id`: it
    /// isn't being deleted, and there's no filter, or it's in the filtered
    /// project, or it's under a listed session.
    pub fn listed(&self, id: SessionId) -> bool {
        let Some(filter) = self.filter else {
            return self.session(id).is_some() && !self.deleting.contains(&id);
        };
        // Ids are reused, so a parent link may loop: stop after every session.
        let mut at = id;
        for _ in 0..self.sessions.len() {
            let Some(session) = self.session(at) else {
                return false;
            };
            if self.deleting.contains(&at) {
                return false;
            }
            if session.project == filter {
                return true;
            }
            let Some(parent) = session.parent else {
                return false;
            };
            at = parent;
        }
        false
    }

    /// Whether session `id` sits at the sidebar's top level: it's unsettled,
    /// and it has no parent, or its parent is gone, settled, being deleted
    /// or not listed.
    pub fn top(&self, id: SessionId) -> bool {
        let Some(session) = self.session(id) else {
            return false;
        };
        session.settled_at.is_none()
            && session.parent.is_none_or(|parent| {
                self.session(parent)
                    .is_none_or(|parent| parent.settled_at.is_some())
                    || !self.listed(parent)
            })
    }

    /// Whether colonist `id` shows no agent row: it's not at the top level,
    /// and it has exactly one agent row and no colonists. `⏎` on its card
    /// reaches that agent.
    pub fn hides_one_agent(&self, id: SessionId, layouts: &Layouts) -> bool {
        !self.top(id) && self.agent_rows(id, layouts).len() == 1 && self.colonists(id).is_empty()
    }

    /// Whether a search lists session `id`: no search has text, or it or a
    /// session under it matches. A match's ancestors show as its path.
    pub fn shows_in_search(&self, id: SessionId, layouts: &Layouts) -> bool {
        std::iter::once(id)
            .chain(self.under(id))
            .filter_map(|id| self.session(id))
            .any(|session| self.hits(session, layouts))
    }

    /// Whether `session` matches the search: no search has text, or its
    /// title or the name one of its agent rows shows matches.
    pub(super) fn hits(&self, session: &Session, layouts: &Layouts) -> bool {
        !self.searching()
            || self.title_matches(&self.title(session)).is_some()
            || self
                .agent_rows(session.id, layouts)
                .into_iter()
                .any(|(agent, pane)| {
                    self.title_matches(layouts.agent_name(pane, Some(agent)))
                        .is_some()
                })
    }

    /// The sidebar's rows, as a tree. The top level holds the unsettled
    /// sessions with no parent, or whose parent is settled, gone or not
    /// listed: pinned (newest pin first), then active (newest created or
    /// un-settled first). Each card is followed by its agent rows (unless
    /// it's folded, or it's a colonist with one agent and no colonists),
    /// then by its colonists row when it has colonists, then by those
    /// colonists: all of them when the row is open; only the stuck ones,
    /// with each folded session on the way as a dim path line, when it's
    /// folded. Then, if any is settled, the shelf header and the settled
    /// sessions (newest settle first); a collapsed shelf still lists the
    /// cursor's settled session. Ties go to the higher id. Sessions being
    /// deleted aren't listed. While a project filter is set, only that
    /// project's sessions and the sessions under them are. While a search
    /// has text, only the sessions that match it by title or an agent row's
    /// name are, with their ancestors as the way to them: every colonists
    /// row on the way reads as open, a match lists all its agent rows (a
    /// folded card's too) and an ancestor shown only for the way lists
    /// none; settled matches show even while the shelf is closed, the shelf
    /// header only when one matches, reading as open.
    pub fn sidebar(&self, layouts: &Layouts) -> Vec<SidebarRow<'_>> {
        let mut rows: Vec<SidebarRow<'_>> = Vec::new();
        let tops = self.sessions.iter().filter(|session| {
            self.listed(session.id)
                && self.top(session.id)
                && self.shows_in_search(session.id, layouts)
        });
        for session in in_sidebar_order(tops) {
            self.emit_card(session, &Spot::top(), false, layouts, &mut rows);
        }
        let settled = self.settled_listed(layouts);
        if !settled.is_empty() {
            let open = self.shelf_open || self.searching();
            rows.push(SidebarRow::ShelfHeader {
                count: settled.len(),
                open,
            });
            rows.extend(
                settled
                    .into_iter()
                    .filter(|(_, session)| {
                        open || self.cursor == Some(SidebarItem::Session(session.id))
                    })
                    .map(|(project, session)| SidebarRow::Settled { project, session }),
            );
        }
        rows
    }

    /// Pushes `session`'s card at `spot`, then what hangs under it: its
    /// agent rows and its colonists row with what that shows, or, for a
    /// session on the way to a stuck colonist (`stuck_only`), just the
    /// colonists that are stuck or have a stuck session under them. A
    /// session whose project is gone isn't listed.
    fn emit_card<'a>(
        &'a self,
        session: &'a Session,
        spot: &Spot,
        stuck_only: bool,
        layouts: &Layouts,
        rows: &mut Vec<SidebarRow<'a>>,
    ) {
        let Some(project) = self.project(session.project) else {
            return;
        };
        let id = session.id;
        rows.push(SidebarRow::Card {
            project,
            session,
            depth: spot.depth,
            rails: spot.rails.clone(),
            last: spot.last,
            path: stuck_only && !self.stuck(id),
        });
        if stuck_only {
            let stuck = self.stuck_colonists(id);
            let count = stuck.len();
            for (at, colonist) in stuck.into_iter().enumerate() {
                self.emit_card(colonist, &spot.child(at + 1 == count), true, layouts, rows);
            }
            return;
        }
        let agents = if self.hides_agents(id)
            || self.hides_one_agent(id, layouts)
            || !self.hits(session, layouts)
        {
            Vec::new()
        } else {
            self.agent_rows(id, layouts)
        };
        let colonists_row = self
            .colonists(id)
            .iter()
            .any(|colonist| self.shows_in_search(colonist.id, layouts));
        let count = agents.len() + usize::from(colonists_row);
        for (at, (agent, pane)) in agents.into_iter().enumerate() {
            let child = spot.child(at + 1 == count);
            rows.push(SidebarRow::Agent {
                session,
                agent,
                pane,
                depth: child.depth,
                rails: child.rails,
                last: child.last,
            });
        }
        if colonists_row {
            self.emit_colonists(session, &spot.child(true), layouts, rows);
        }
    }

    /// Pushes the colonists row under `session` at `spot`, then: while a
    /// search has text, each colonist that shows in it; while the row is
    /// open, each colonist; while it's folded, each colonist that's stuck
    /// or has a stuck session under it, on the way to those only.
    fn emit_colonists<'a>(
        &'a self,
        session: &'a Session,
        spot: &Spot,
        layouts: &Layouts,
        rows: &mut Vec<SidebarRow<'a>>,
    ) {
        let id = session.id;
        let open = self.colonists_open.contains(&id);
        let (shown, stuck_only) = match (self.searching(), open) {
            (true, _) => (
                self.colonists(id)
                    .into_iter()
                    .filter(|colonist| self.shows_in_search(colonist.id, layouts))
                    .collect(),
                false,
            ),
            (false, true) => (self.colonists(id), false),
            (false, false) => (self.stuck_colonists(id), true),
        };
        rows.push(SidebarRow::Colonists {
            session,
            depth: spot.depth,
            rails: spot.rails.clone(),
            last: spot.last,
            open: open || self.searching(),
        });
        let count = shown.len();
        for (at, colonist) in shown.into_iter().enumerate() {
            self.emit_card(
                colonist,
                &spot.child(at + 1 == count),
                stuck_only,
                layouts,
                rows,
            );
        }
    }

    /// Session `id`'s colonists that are stuck or have a stuck session
    /// under them, in sidebar order.
    fn stuck_colonists(&self, id: SessionId) -> Vec<&Session> {
        self.colonists(id)
            .into_iter()
            .filter(|colonist| {
                self.stuck(colonist.id)
                    || self
                        .under(colonist.id)
                        .into_iter()
                        .any(|below| self.stuck(below))
            })
            .collect()
    }

    /// The settled sessions the sidebar may list, newest settle first (ties
    /// to the higher id), with their projects: listed by the project filter
    /// and matching the search.
    pub(super) fn settled_listed(&self, layouts: &Layouts) -> Vec<(&Project, &Session)> {
        let mut settled: Vec<(&Project, &Session)> = self
            .sessions
            .iter()
            .filter(|session| {
                session.settled_at.is_some()
                    && self.listed(session.id)
                    && self.hits(session, layouts)
            })
            .filter_map(|session| Some((self.project(session.project)?, session)))
            .collect();
        settled.sort_by_key(|(_, session)| Reverse((session.settled_at, session.id.0)));
        settled
    }

    /// Opens what hides the cursor's row, unless a search has text: a
    /// hidden one-agent colonist's agent row moves the cursor to its card,
    /// another hidden agent row unfolds its card, and every colonists row
    /// above the row's session opens. A listed row (a stuck colonist under a
    /// folded colonists row included) opens nothing.
    pub fn reveal_cursor(&mut self, layouts: &Layouts) {
        let Some(item) = self.cursor else {
            return;
        };
        if self.searching() || self.items(layouts).contains(&item) {
            return;
        }
        let mut at = match item {
            SidebarItem::Agent { session, .. } if self.hides_one_agent(session, layouts) => {
                self.cursor = Some(SidebarItem::Session(session));
                session
            }
            SidebarItem::Agent { session, .. } => {
                self.unfold(session);
                session
            }
            SidebarItem::Session(id) | SidebarItem::Colonists(id) => id,
            SidebarItem::SettledShelf => return,
        };
        // Ids are reused, so a parent link may loop: stop after every session.
        for _ in 0..self.sessions.len() {
            let parent = match self.session(at) {
                Some(session) if !self.top(at) && session.settled_at.is_none() => session.parent,
                _ => None,
            };
            let Some(parent) = parent else {
                return;
            };
            self.colonists_open.insert(parent);
            at = parent;
        }
    }
}

/// A row's place in the sidebar's tree.
struct Spot {
    /// How many levels down it sits; a top-level card is 0.
    depth: usize,
    /// Whether each level above it carries a guide line down past it.
    rails: Vec<bool>,
    /// Whether it's its parent's last child.
    last: bool,
}

impl Spot {
    /// A top-level card's spot.
    fn top() -> Self {
        Self {
            depth: 0,
            rails: Vec::new(),
            last: true,
        }
    }

    /// The spot of a child of this row's, `last` among its siblings. A
    /// top-level row passes no guide line down.
    fn child(&self, last: bool) -> Self {
        let rails = match self.depth {
            0 => Vec::new(),
            _ => {
                let mut rails = self.rails.clone();
                rails.push(!self.last);
                rails
            }
        };
        Self {
            depth: self.depth + 1,
            rails,
            last,
        }
    }
}

/// `sessions` in sidebar order: pinned (newest pin first), then the rest
/// (newest created or un-settled first); ties go to the higher id.
fn in_sidebar_order<'a, I>(sessions: I) -> Vec<&'a Session>
where
    I: IntoIterator<Item = &'a Session>,
{
    let (mut pinned, mut active): (Vec<&Session>, Vec<&Session>) = sessions
        .into_iter()
        .partition(|session| session.pinned_at.is_some());
    pinned.sort_by_key(|session| Reverse((session.pinned_at, session.id.0)));
    active.sort_by_key(|session| Reverse((session.active_since, session.id.0)));
    pinned.extend(active);
    pinned
}
