// The fridge's relay (#317, ADR 0011): encrypted board events in a stream of
// their own (event-stream.mjs), apart from household events and chat.
//
// Board events are sealed under the household key epoch like household
// events: everyone in the household may see the fridge. They carry no push
// notification (the fridge never notifies), only the live hint other devices
// sync on. Who may draw is the household admin's to say (#323): Adults
// always draw; Limited and Temporary members draw, look only, or have no
// access, as the policy says.
import { PairingError, boardAccess } from "./pairing-service.mjs";
import { DeviceWindow } from "./chat-limits.mjs";
import { EventStream, memoryStreamMethods, streamStorage } from "./event-stream.mjs";

/** Most board events a household keeps (Rust's MAX_BOARD_EVENT_COUNT). */
export const MAX_HOUSEHOLD_BOARD_EVENTS = 250_000;
/** Most board events one pull returns. */
export const MAX_BOARD_PULL = 200;
/** Most board events one device may send in a minute: strokes go on pen-up
 * and a long one is split, so a quick scribbler stays well inside this. */
export const BOARD_EVENTS_PER_MINUTE = 240;

const WORDS = Object.freeze({
  batchInvalid: "That fridge batch is invalid.",
  batchTooLarge: "That fridge batch is too large.",
  duplicate: "A fridge event conflicts with one already received.",
  logicalTime: "That fridge change is outside Kin's supported event-order range.",
  sequenceGap: "This device must send its earlier fridge changes first.",
  fullCode: "board_limit", full: "This household's fridge is full.",
  conflictCode: "board_relay_conflict", conflict: "The fridge changed meanwhile; retry.",
  cursor: "Kin could not continue from that fridge position.",
});

export class BoardRelayService {
  constructor({ syncService, store = null }) {
    this.syncService = syncService;
    this.storage = store ?? memoryStreamMethods("board", { conflictCode: WORDS.conflictCode, conflictMessage: WORDS.conflict });
    this.stream = new EventStream({
      syncService, storage: streamStorage(this.storage, "board"), maxEvents: MAX_HOUSEHOLD_BOARD_EVENTS, maxPull: MAX_BOARD_PULL,
      window: new DeviceWindow({ limit: BOARD_EVENTS_PER_MINUTE, windowMs: 60_000, now: () => syncService.now() }),
      rateLimited: () => new PairingError("board_rate_limited", "Too many fridge changes too fast. Kin will try again in a moment.", 429),
      hint: (householdId, auth) => syncService.liveService?.eventsAccepted(householdId, auth.device.id),
      words: WORDS,
    });
  }

  /** What the fridge policy lets this member do: "read" (status, pulls) or
   * "write" (pushes). A member who can't take part has no access. */
  assertCanUse(auth, need = "read") {
    const access = boardAccess(auth.member, auth.household, this.syncService.now());
    if (access === "none")
      throw new PairingError("board_unavailable", "The fridge isn't available to you in this household.", 403);
    if (need === "write" && access !== "write")
      throw new PairingError("board_read_only", "Your household has set the fridge to look only for you.", 403);
  }

  push(auth, envelopes) {
    this.assertCanUse(auth, "write");
    const sync = this.syncService.state(auth.household.id);
    if (!sync.enabled)
      throw new PairingError("board_sync_unavailable", "The fridge is unavailable until household sync is set up.", 409);
    if (sync.rotationPending)
      throw new PairingError("sync_rotation_pending", "The fridge is paused until key access is updated.", 409);
    return this.stream.push(auth, envelopes, sync);
  }

  status(auth) {
    this.assertCanUse(auth);
    return this.stream.status(auth);
  }

  pull(auth, cursorValue = "", limitValue = String(MAX_BOARD_PULL)) {
    this.assertCanUse(auth);
    return this.stream.pull(auth, cursorValue, limitValue);
  }

  /** The household's board event use. */
  eventUsage(auth) {
    return { events: this.storage.boardRelayState(auth.household.id).eventCount, eventLimit: MAX_HOUSEHOLD_BOARD_EVENTS };
  }

  /** In-memory mode only: the durable store purges with the household. */
  forgetHousehold(householdId) {
    this.storage.forgetHousehold?.(householdId);
  }
}
