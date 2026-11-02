// A household's move to a home server (ADR 0026 §5, #738), kept by the
// server it is moving from. One row per household while it is being sent
// (`sending`, frozen) and after it arrived (`moved`, refusing every session
// and pointing at the new address). Undoing a move removes the row, and the
// household is in use here again. It never travels in a move package
// (server/move-package.mjs lists it as staying).
import { DurableStoreError } from "./shared.mjs";

export const HOUSEHOLD_MOVES_SQL = `
  CREATE TABLE household_moves (
    household_id TEXT PRIMARY KEY REFERENCES households(id),
    state TEXT NOT NULL CHECK (state IN ('sending', 'moved')),
    target_origin TEXT NOT NULL CHECK (length(target_origin) BETWEEN 9 AND 270),
    started_by_member_id TEXT NOT NULL,
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    moved_at INTEGER CHECK (moved_at IS NULL OR moved_at >= started_at),
    CHECK ((state = 'moved') = (moved_at IS NOT NULL))
  );
`;

const fromRow = (row) => Object.freeze({
  householdId: row.household_id,
  state: row.state,
  targetOrigin: row.target_origin,
  startedByMemberId: row.started_by_member_id,
  startedAt: row.started_at,
  movedAt: row.moved_at,
});

export const householdMoveMethods = {
  /** Every household that is moving or moved, by household ID. */
  loadHouseholdMoves() {
    this.assertAvailable();
    return new Map(this.db.prepare("SELECT * FROM household_moves").all().map((row) => [row.household_id, fromRow(row)]));
  },

  /** Records a move: `sending` when it starts, `moved` when it arrived. */
  putHouseholdMove({ householdId, state, targetOrigin, startedByMemberId, startedAt, movedAt = null }) {
    this.assertAvailable();
    return this.transaction(() => {
      if (!this.statements.getHousehold.get(householdId)) throw new DurableStoreError("That household doesn't exist.");
      this.db.prepare(`INSERT INTO household_moves (household_id, state, target_origin, started_by_member_id, started_at, moved_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (household_id) DO UPDATE SET state = excluded.state, target_origin = excluded.target_origin,
          started_by_member_id = excluded.started_by_member_id, started_at = excluded.started_at, moved_at = excluded.moved_at`)
        .run(householdId, state, targetOrigin, startedByMemberId, startedAt, movedAt);
      return fromRow(this.db.prepare("SELECT * FROM household_moves WHERE household_id = ?").get(householdId));
    });
  },

  /** Ends a move record: the household is in use here again. */
  removeHouseholdMove(householdId) {
    this.assertAvailable();
    return this.transaction(() => this.db.prepare("DELETE FROM household_moves WHERE household_id = ?").run(householdId).changes > 0);
  },
};
