// Moving a household to a home server, on the server it leaves (ADR 0026,
// #738). A household admin, with a fresh passkey or password, gives the
// home server's address and the move code its operator read there; this
// service freezes the household, builds its move package
// (move-package.mjs), sends it (move-sender.mjs) and, once the home server
// confirms, marks it moved: every session is refused with the new address
// (PairingService.assertNotMoved). A failed send unfreezes it.
//
// After the move, an admin can undo it for a day (the household is in use
// here again; the home server keeps its copy) or close the household with
// the existing deletion. The service can't see sign-ins at the new address,
// so the old app reminds admins to close it after a week (`remindAt`).
//
// The move's state is durable (durable-store/household-moves.mjs); the
// progress and the last failure live in memory. A send cut short by a
// restart leaves the household in use here, with "move-interrupted".
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { MOVING_WRAPPER_TYPES, buildMovePackage } from "./move-package.mjs";
import { MoveSender, MoveSendError, moveOrigin } from "./move-sender.mjs";
import { PairingError } from "./pairing-service.mjs";

export const UNDO_WINDOW_MS = 24 * 60 * 60_000;
export const REMIND_AFTER_MS = 7 * 24 * 60 * 60_000;

/** A package can be gigabytes: hashed as it streams. */
async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export class HouseholdMoves {
  /**
   * @param {object} options
   * @param {import("./pairing-service.mjs").PairingService} options.service
   * @param {import("./durable-store.mjs").DurableStore} options.store
   * @param {string} options.workDirectory  where packages are built (in the data directory)
   * @param {string} options.origin  this service's own origin (a move can't go to itself)
   * @param {(householdId: string) => void} [options.revalidate]  closes live connections
   */
  constructor({ service, store, workDirectory, origin, sender = new MoveSender(), revalidate = () => {}, now = Date.now, log = () => {} }) {
    Object.assign(this, { service, store, workDirectory, origin, sender, revalidate, now, log });
    this.jobs = new Map();
    for (const move of [...service.householdMoves.values()]) {
      if (move.state !== "sending") continue;
      store.removeHouseholdMove(move.householdId);
      service.householdMoves.delete(move.householdId);
      this.jobs.set(move.householdId, { lastError: { code: "move-interrupted", at: new Date(now()).toISOString() } });
      log({ event: "household_move_interrupted" });
    }
  }

  /**
   * Who can sign in at the new address (ADR 0026 §4): a member whose vault
   * has a password or backup-code wrapper. By member ID; the page shows
   * names from the household's own history.
   */
  readiness(householdId) {
    const household = this.service.households.get(householdId);
    const types = new Map();
    for (const { member_id: memberId, type } of this.store.db.prepare("SELECT member_id, type FROM account_vault_wrappers WHERE household_id = ?").all(householdId)) {
      if (!types.has(memberId)) types.set(memberId, new Set());
      types.get(memberId).add(type);
    }
    const members = [];
    for (const memberId of household?.members ?? []) {
      const member = this.service.members.get(memberId);
      if (!member?.active) continue;
      const wrappers = types.get(memberId) ?? new Set();
      members.push({
        memberId,
        kind: member.kind ?? "adult",
        admin: Boolean(member.householdAdmin),
        account: wrappers.size > 0,
        ready: MOVING_WRAPPER_TYPES.find((type) => wrappers.has(type)) ?? null,
      });
    }
    return { members, canStart: members.some((member) => member.admin && member.ready) };
  }

  /** The move's state for the admin's page. */
  status(householdId) {
    const move = this.service.householdMoves.get(householdId);
    const job = this.jobs.get(householdId);
    const iso = (time) => (Number.isFinite(time) ? new Date(time).toISOString() : null);
    return {
      state: move?.state ?? "none",
      targetOrigin: move?.targetOrigin ?? null,
      startedAt: iso(move?.startedAt),
      movedAt: iso(move?.movedAt),
      undoUntil: move?.state === "moved" ? iso(move.movedAt + UNDO_WINDOW_MS) : null,
      remindAt: move?.state === "moved" ? iso(move.movedAt + REMIND_AFTER_MS) : null,
      progress: move?.state === "sending" && job?.size ? { sent: job.sent ?? 0, size: job.size } : null,
      lastError: move ? null : job?.lastError ?? null,
    };
  }

  /** Checks a move before the admin confirms it; returns the origin. */
  check(householdId, address) {
    const household = this.service.households.get(householdId);
    if (!household || household.lifecycleState !== "active") throw new PairingError("move_not_active", "Only a household in use can move.", 409);
    if (this.service.householdMoves.has(householdId)) throw new PairingError("move_exists", "This household is already moving or has moved.", 409);
    if (!this.readiness(householdId).canStart)
      throw new PairingError("move_no_ready_admin", "At least one household admin needs a password or a backup code to sign in at the new address.", 409);
    let origin;
    try { origin = moveOrigin(address); } catch (error) { throw new PairingError(error.code, error.message, 400); }
    if (origin === this.origin) throw new PairingError("move-address-invalid", "That is this server's own address.", 400);
    return origin;
  }

  /** Freezes the household and starts sending it. Returns the status. */
  start({ householdId, memberId, address, code }) {
    const targetOrigin = this.check(householdId, address);
    if (typeof code !== "string" || code.length > 40) throw new PairingError("move-code-malformed", "Type the move code the home server printed.", 400);
    const move = this.store.putHouseholdMove({ householdId, state: "sending", targetOrigin, startedByMemberId: memberId, startedAt: this.now() });
    this.service.householdMoves.set(householdId, move);
    this.revalidate(householdId);
    const job = { sent: 0, size: 0, lastError: null };
    this.jobs.set(householdId, job);
    this.log({ event: "household_move_started" });
    job.running = this.#send(householdId, move, code, job);
    return this.status(householdId);
  }

  async #send(householdId, move, code, job) {
    mkdirSync(this.workDirectory, { recursive: true, mode: 0o700 });
    const path = join(this.workDirectory, `move-${householdId}-${this.now()}.sqlite`);
    try {
      const summary = buildMovePackage(this.store, householdId, path);
      job.size = statSync(path).size;
      const receipt = await this.sender.send({
        origin: move.targetOrigin, code, path, size: job.size, sha256: await sha256File(path),
        onProgress: (sent) => { job.sent = sent; },
      });
      if (receipt.householdId !== summary.householdId) throw new MoveSendError("move-not-kin", "The home server confirmed another household.");
      const moved = this.store.putHouseholdMove({ ...move, state: "moved", movedAt: this.now() });
      this.service.householdMoves.set(householdId, moved);
      this.revalidate(householdId);
      this.log({ event: "household_move_finished", members: receipt.members });
    } catch (error) {
      // Not moved: the household is in use here again, as it was.
      this.store.removeHouseholdMove(householdId);
      this.service.householdMoves.delete(householdId);
      const code = typeof error?.code === "string" && /^[a-z0-9_-]{1,64}$/.test(error.code) ? error.code : "move-failed";
      job.lastError = { code, at: new Date(this.now()).toISOString(), ...(Number.isInteger(error?.attemptsLeft) ? { attemptsLeft: error.attemptsLeft } : {}) };
      this.log({ event: "household_move_failed", code });
    } finally {
      rmSync(path, { force: true });
    }
  }

  /** Within a day of the move, puts the household back in use here. */
  undo(householdId) {
    const move = this.service.householdMoves.get(householdId);
    if (move?.state !== "moved") throw new PairingError("move_undo_unavailable", "There is no move to undo.", 409);
    if (this.now() >= move.movedAt + UNDO_WINDOW_MS) throw new PairingError("move_undo_expired", "A move can be undone only within a day.", 409);
    this.store.removeHouseholdMove(householdId);
    this.service.householdMoves.delete(householdId);
    this.jobs.delete(householdId);
    this.log({ event: "household_move_undone" });
    return this.status(householdId);
  }
}
