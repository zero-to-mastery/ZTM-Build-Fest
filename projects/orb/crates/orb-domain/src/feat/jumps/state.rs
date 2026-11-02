//! The jump list: the sidebar rows the user jumped between, and where
//! `<C-[>`/`<C-]>` last landed among them.

use crate::feat::sessions::state::SidebarItem;

/// How many rows the jump list keeps.
pub const JUMP_LIMIT: usize = 20;

/// The rows the user jumped between, oldest first, each at most once, and
/// the one the last `<C-[>`/`<C-]>` landed on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JumpList {
    /// Oldest first; at most [`JUMP_LIMIT`], never the Settled header nor a
    /// colonists row.
    entries: Vec<SidebarItem>,
    /// The entry the last `<C-[>`/`<C-]>` landed on; `None` while the user
    /// isn't moving through the list.
    at: Option<usize>,
}

impl JumpList {
    /// A list of `items`, oldest first, as saved: the newest
    /// [`JUMP_LIMIT`], each once, without the Settled header or colonists
    /// rows.
    #[must_use]
    pub fn from_saved(items: Vec<SidebarItem>) -> Self {
        let mut list = Self::default();
        for item in items {
            list.record(item);
        }
        list
    }

    /// The rows, oldest first.
    #[must_use]
    pub fn entries(&self) -> &[SidebarItem] {
        &self.entries
    }

    /// Adds `item` as the newest row, moving it there if it's already
    /// listed and dropping the oldest past [`JUMP_LIMIT`]. The Settled header
    /// and colonists rows are never added.
    pub fn record(&mut self, item: SidebarItem) {
        if matches!(item, SidebarItem::SettledShelf | SidebarItem::Colonists(_)) {
            return;
        }
        self.entries.retain(|&entry| entry != item);
        self.entries.push(item);
        let over = self.entries.len().saturating_sub(JUMP_LIMIT);
        self.entries.drain(..over);
        self.at = None;
    }

    /// Records entering `item`'s pane, unless it's the row the last
    /// `<C-[>`/`<C-]>` landed on, or an agent of the session it landed on:
    /// coming back into that pane keeps the place in the list, so `<C-]>`
    /// still goes forward. Returns whether it recorded.
    pub fn enter(&mut self, item: SidebarItem) -> bool {
        let browsing = match (self.at.and_then(|at| self.entries.get(at)), item) {
            (Some(&landed), _) if landed == item => true,
            (Some(&SidebarItem::Session(landed)), SidebarItem::Agent { session, .. }) => {
                landed == session
            }
            _ => false,
        };
        if !browsing {
            self.record(item);
        }
        !browsing
    }

    /// Records a jump: the row it left, then the row it landed on.
    pub fn jump(&mut self, from: Option<SidebarItem>, to: Option<SidebarItem>) {
        for item in [from, to].into_iter().flatten() {
            self.record(item);
        }
    }

    /// Where [`back`](Self::back) would land from `current`: the nearest
    /// older row that's `reachable` and isn't `current`.
    pub fn peek_back<F>(&self, current: Option<SidebarItem>, reachable: F) -> Option<SidebarItem>
    where
        F: Fn(SidebarItem) -> bool,
    {
        let list = self.seen_from(current);
        let end = list.at.unwrap_or(list.entries.len());
        list.entries
            .get(..end)?
            .iter()
            .rev()
            .copied()
            .find(|&entry| Some(entry) != current && reachable(entry))
    }

    /// Where [`forward`](Self::forward) would land from `current`: the
    /// nearest newer row that's `reachable` and isn't `current`; nothing
    /// unless a `<C-[>` went back first.
    pub fn peek_forward<F>(&self, current: Option<SidebarItem>, reachable: F) -> Option<SidebarItem>
    where
        F: Fn(SidebarItem) -> bool,
    {
        self.entries
            .get(self.at? + 1..)?
            .iter()
            .copied()
            .find(|&entry| Some(entry) != current && reachable(entry))
    }

    /// `<C-[>`: the nearest older `reachable` row other than `current`. The
    /// first one records `current`, so `<C-]>` can come back to it. With no
    /// such row, nothing changes.
    pub fn back<F>(&mut self, current: Option<SidebarItem>, reachable: F) -> Option<SidebarItem>
    where
        F: Fn(SidebarItem) -> bool,
    {
        let target = self.peek_back(current, reachable)?;
        *self = self.seen_from(current);
        self.land(target);
        Some(target)
    }

    /// `<C-]>`: the nearest newer `reachable` row other than `current`,
    /// after a `<C-[>`. With no such row, nothing changes.
    pub fn forward<F>(&mut self, current: Option<SidebarItem>, reachable: F) -> Option<SidebarItem>
    where
        F: Fn(SidebarItem) -> bool,
    {
        let target = self.peek_forward(current, reachable)?;
        self.land(target);
        Some(target)
    }

    /// Drops `item`, a row that no longer exists, and for a session also
    /// its agent rows. Removing the row the last jump landed on ends the
    /// move through the list.
    pub fn remove(&mut self, item: SidebarItem) {
        let gone = |entry: &SidebarItem| match (item, *entry) {
            (SidebarItem::Session(id), SidebarItem::Agent { session, .. }) => session == id,
            _ => *entry == item,
        };
        self.at = self
            .at
            .filter(|&at| !self.entries.get(at).is_some_and(gone))
            .map(|at| at - self.entries.iter().take(at).filter(|e| gone(e)).count());
        self.entries.retain(|entry| !gone(entry));
    }

    /// The list as a `<C-[>` from `current` sees it: with `current`
    /// recorded as the newest row unless a `<C-[>` already went back.
    fn seen_from(&self, current: Option<SidebarItem>) -> Self {
        let mut list = self.clone();
        if let (None, Some(current)) = (self.at, current) {
            list.record(current);
        }
        list
    }

    /// Marks `target`, a listed row, as the one the last jump landed on.
    fn land(&mut self, target: SidebarItem) {
        self.at = self.entries.iter().position(|&entry| entry == target);
    }
}

#[cfg(test)]
mod tests {
    use super::{JUMP_LIMIT, JumpList};
    use crate::feat::sessions::state::SidebarItem;
    use crate::ids::{PaneId, SessionId};

    fn on(id: i64) -> SidebarItem {
        SidebarItem::Session(SessionId(id))
    }

    /// The agent row of pane `pane` in session `session`.
    fn agent(session: i64, pane: i64) -> SidebarItem {
        SidebarItem::Agent {
            session: SessionId(session),
            pane: PaneId(pane),
        }
    }

    /// A list holding agents `ids`, oldest first.
    fn list_of(ids: &[i64]) -> JumpList {
        JumpList::from_saved(ids.iter().copied().map(on).collect())
    }

    fn anywhere(_: SidebarItem) -> bool {
        true
    }

    #[rstest::rstest]
    fn recording_past_the_limit_drops_the_oldest() {
        // Given a full list of agents 1 to 20.
        let mut list = list_of(&(1..=20).collect::<Vec<_>>());

        // When recording a 21st row.
        list.record(on(21));

        // Then agent 1 is gone and 20 rows remain.
        assert_eq!(
            (list.entries().len(), list.entries().first().copied()),
            (JUMP_LIMIT, Some(on(2))),
            "the oldest row should drop off"
        );
    }

    #[rstest::rstest]
    fn recording_a_listed_row_moves_it_to_the_newest() {
        // Given agents 1, 2 and 3.
        let mut list = list_of(&[1, 2, 3]);

        // When recording agent 1 again.
        list.record(on(1));

        // Then it's the newest, listed once.
        assert_eq!(
            list.entries(),
            [on(2), on(3), on(1)],
            "a listed row should move to the newest slot"
        );
    }

    #[rstest::rstest]
    fn recording_the_settled_header_changes_nothing() {
        // Given agents 1 and 2.
        let mut list = list_of(&[1, 2]);

        // When recording the Settled header.
        list.record(SidebarItem::SettledShelf);

        // Then the list is unchanged.
        assert_eq!(list, list_of(&[1, 2]), "the header is never a jump");
    }

    #[rstest::rstest]
    fn record_skips_a_colonists_row() {
        // Given agents 1 and 2.
        let mut list = list_of(&[1, 2]);

        // When recording session 1's colonists row.
        list.record(SidebarItem::Colonists(SessionId(1)));

        // Then the list is unchanged.
        assert_eq!(list, list_of(&[1, 2]), "a colonists row is never a jump");
    }

    #[rstest::rstest]
    fn back_then_forward_returns_to_the_starting_row() {
        // Given agents 1 and 2, with the cursor on agent 3.
        let mut list = list_of(&[1, 2]);
        let back = list.back(Some(on(3)), anywhere);

        // When going forward from where back landed.
        let forward = list.forward(back, anywhere);

        // Then it's back on agent 3.
        assert_eq!(forward, Some(on(3)), "<C-]> should undo <C-[>");
    }

    #[rstest::rstest]
    fn back_skips_an_unreachable_row() {
        // Given agents 1 and 2, with agent 2 unreachable.
        let mut list = list_of(&[1, 2]);

        // When going back from agent 3.
        let target = list.back(Some(on(3)), |item| item != on(2));

        // Then it lands on agent 1.
        assert_eq!(target, Some(on(1)), "unreachable rows should be skipped");
    }

    #[rstest::rstest]
    fn back_skips_the_current_row() {
        // Given agents 1 and 2, with the cursor on agent 2.
        let mut list = list_of(&[1, 2]);

        // When going back.
        let target = list.back(Some(on(2)), anywhere);

        // Then it lands on agent 1.
        assert_eq!(target, Some(on(1)), "<C-[> should never land in place");
    }

    #[rstest::rstest]
    fn forward_while_not_moving_through_the_list_finds_nothing() {
        // Given agents 1 and 2, and no <C-[> yet.
        let mut list = list_of(&[1, 2]);

        // When going forward.
        let target = list.forward(Some(on(2)), anywhere);

        // Then there's nowhere to go.
        assert_eq!(target, None, "<C-]> needs a <C-[> first");
    }

    #[rstest::rstest]
    fn back_without_an_older_row_changes_nothing() {
        // Given only agent 1, with the cursor on it.
        let mut list = list_of(&[1]);

        // When going back.
        list.back(Some(on(1)), anywhere);

        // Then the list is unchanged.
        assert_eq!(list, list_of(&[1]), "a failed <C-[> should change nothing");
    }

    #[rstest::rstest]
    fn back_from_an_unlisted_row_skips_the_row_recording_it_drops() {
        // Given a full list of agents 1 to 20, with only agent 1 reachable.
        let mut list = list_of(&(1..=20).collect::<Vec<_>>());

        // When going back from unlisted agent 21.
        let target = list.back(Some(on(21)), |item| item == on(1));

        // Then there's nowhere to go: recording agent 21 drops agent 1.
        assert_eq!(target, None, "<C-[> must not land on a dropped row");
    }

    #[rstest::rstest]
    fn entering_the_row_back_landed_on_keeps_forward() {
        // Given agents 1 and 2, gone back from agent 3 to agent 2.
        let mut list = list_of(&[1, 2]);
        list.back(Some(on(3)), anywhere);

        // When entering agent 2's pane again.
        list.enter(on(2));

        // Then going forward from agent 2 still lands on agent 3.
        assert_eq!(
            list.forward(Some(on(2)), anywhere),
            Some(on(3)),
            "re-entering the landed row should keep <C-]>"
        );
    }

    #[rstest::rstest]
    fn entering_an_agent_of_the_landed_session_records_nothing() {
        // Given agents 1 and 2, gone back from agent 3 to agent 2's card.
        let mut list = list_of(&[1, 2]);
        list.back(Some(on(3)), anywhere);

        // When entering agent 2's session through its agent in pane 2.
        let recorded = list.enter(agent(2, 2));

        // Then nothing is recorded.
        assert!(
            !recorded,
            "an agent of the landed session is the same place in the list"
        );
    }

    #[rstest::rstest]
    fn removing_a_session_drops_its_agent_rows() {
        // Given agent 1's card, its agents in panes 1 and 5, and agent 2.
        let mut list = JumpList::from_saved(vec![on(1), agent(1, 1), on(2), agent(1, 5)]);

        // When removing agent 1's session.
        list.remove(on(1));

        // Then only agent 2 remains.
        assert_eq!(
            list.entries(),
            [on(2)],
            "a deleted session's agent rows should go with it"
        );
    }

    #[rstest::rstest]
    fn remove_drops_the_row() {
        // Given agents 1, 2 and 3.
        let mut list = list_of(&[1, 2, 3]);

        // When removing agent 2.
        list.remove(on(2));

        // Then agents 1 and 3 remain.
        assert_eq!(list.entries(), [on(1), on(3)], "the deleted row should go");
    }

    #[rstest::rstest]
    fn removing_an_older_row_keeps_the_place_in_the_list() {
        // Given agents 1, 2 and 3, gone back from agent 4 to agent 3.
        let mut list = list_of(&[1, 2, 3]);
        list.back(Some(on(4)), anywhere);

        // When removing agent 1.
        list.remove(on(1));

        // Then going forward from agent 3 still lands on agent 4.
        assert_eq!(
            list.forward(Some(on(3)), anywhere),
            Some(on(4)),
            "<C-]> should still undo the <C-[>"
        );
    }

    #[rstest::rstest]
    fn from_saved_drops_the_settled_header() {
        // Given a saved list holding the Settled header between two agents.
        let saved = vec![on(1), SidebarItem::SettledShelf, on(2)];

        // When restoring it.
        let list = JumpList::from_saved(saved);

        // Then only the agents are listed.
        assert_eq!(list.entries(), [on(1), on(2)], "the header is never kept");
    }
}
