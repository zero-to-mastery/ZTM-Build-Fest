// The identity service: households, members, devices, sessions and the
// pairing ceremonies that add them. This file holds the PairingService core
// (state, audit, persistence, rate limits). Its method groups live in
// pairing-service/ and are attached below with addMethods, by flow stage:
// sessions.mjs (bootstrap, sessions, reauthentication), create.mjs (stage 1:
// an adult creates a pairing), claim.mjs (stage 2: the new device claims it),
// approve.mjs (stage 3: approval or revocation), then devices.mjs,
// membership.mjs, lifecycle.mjs, link.mjs (phone-approved sign-in, #99) and
// passwords.mjs (username and password sign-in, #558), new-device.mjs
// (signing in on a device with no cookie, #568) and account.mjs (a member's
// passkey and password changes, #560/#571). shared.mjs holds the constants, errors
// and member-kind rules; its public names are re-exported here.
import { createHmac, randomBytes } from "node:crypto";
import { addMethods } from "./mixins.mjs";
import { accountMethods } from "./pairing-service/account.mjs";
import { approveMethods } from "./pairing-service/approve.mjs";
import { bootstrapLimitMethods, parseHouseholdPolicy } from "./pairing-service/bootstrap-limits.mjs";
import { claimMethods } from "./pairing-service/claim.mjs";
import { createMethods } from "./pairing-service/create.mjs";
import { deviceLabel } from "./pairing-service/device-label.mjs";
import { deviceMethods } from "./pairing-service/devices.mjs";
import { lifecycleMethods } from "./pairing-service/lifecycle.mjs";
import { linkMethods } from "./pairing-service/link.mjs";
import { membershipMethods } from "./pairing-service/membership.mjs";
import { newDeviceMethods } from "./pairing-service/new-device.mjs";
import { passwordMethods } from "./pairing-service/passwords.mjs";
import { sessionMethods } from "./pairing-service/sessions.mjs";
import {
  MAX_RATE_BUCKETS,
  normalizeCode,
  PairingError,
  RATE_LIMIT,
  RATE_WINDOW_MS,
} from "./pairing-service/shared.mjs";

export {
  canManageTrust,
  canParticipate,
  boardAccess,
  boardPolicyOf,
  chatAccess,
  chatPolicyOf,
  CHAT_ACCESS,
  choreChartOf,
  featureOff,
  featuresOf,
  HOUSEHOLD_FEATURE_BITS,
  KNOWN_FEATURE_MASK,
  privateAccess,
  privatePolicyOf,
  CLAIM_TTL_MS,
  isHouseholdAdmin,
  isTemporaryMember,
  MAX_CODE_ATTEMPTS,
  MAX_RATE_BUCKETS,
  MEMBER_KINDS,
  normalizeCode,
  normalizeMemberKind,
  PAIRING_CODE_ALPHABET,
  PAIRING_TTL_MS,
  PairingError,
  RATE_LIMIT,
  RATE_WINDOW_MS,
  requireHouseholdAdmin,
  requireTrustAuthority,
  SESSION_TTL_MS,
  TERMINAL_PAIRING_RETENTION_MS,
} from "./pairing-service/shared.mjs";
export { MAX_ACTIVE_MEMBERS, MAX_TRUSTED_DEVICES } from "./identity-limits.mjs";
export { PASSWORD_ATTEMPTS, PASSWORD_WINDOW_MS, SIGN_IN_FAILED, USERNAME_CHECKS } from "./pairing-service/passwords.mjs";
export { NEW_DEVICE_TTL_MS, NEW_DEVICE_DOWNLOADS, NEW_DEVICE_SIGN_INS_PER_MEMBER } from "./pairing-service/new-device.mjs";
export { LINK_CODE_ATTEMPTS, LINK_CODE_TTL_MS, LINK_REQUEST_TTL_MS, MAX_LINK_REQUESTS, MAX_LINK_REQUESTS_PER_CLIENT } from "./pairing-service/link.mjs";
export {
  BOOTSTRAP_LIMIT,
  BOOTSTRAP_WINDOW_MS,
  HOUSEHOLD_CREATION_CLOSED,
  parseHouseholdPolicy,
} from "./pairing-service/bootstrap-limits.mjs";

export class PairingService {
  constructor({
    now = () => Date.now(),
    secret = randomBytes(32),
    maxRateBuckets = MAX_RATE_BUCKETS,
    householdPolicy = parseHouseholdPolicy(),
    store,
  } = {}) {
    this.now = now;
    this.secret = secret;
    this.maxRateBuckets = maxRateBuckets;
    this.store = store;
    store?.finalizeExpiredDeletions(now());
    store?.resetDeviceLabels(deviceLabel);
    const identity = store?.loadIdentity();
    this.households = identity?.households ?? new Map();
    this.members = identity?.members ?? new Map();
    this.credentials = identity?.credentials ?? new Map();
    this.devices = identity?.devices ?? new Map();
    // Households moving, or moved, to a home server (ADR 0026 §5, #738).
    this.householdMoves = store?.loadHouseholdMoves() ?? new Map();
    this.deviceTokens = new Map(
      [...this.devices.values()]
        .filter((device) => device.tokenHash)
        .map((device) => [device.tokenHash, device.id]),
    );
    // Restore durable authority only; restart cancels enrollment and sessions.
    this.pairings = new Map();
    this.codeIndex = new Map();
    this.sessions = new Map();
    this.claimTokens = new Map();
    // Phone-approved sign-in requests (#99): process-local, like pairings.
    this.linkRequests = new Map();
    this.rateBuckets = new Map();
    // Sign-in link limits (#99), apart from the pairing-code limits.
    this.linkRateBuckets = new Map();
    // Households whose link requests ended, saved after the route (#99).
    this.linkAuditsPending = new Set();
    this.bootstrapBuckets = new Map();
    this.householdPolicy = householdPolicy;
    this.events = [];
    // Prepared invitations (#613) are the one kind of pairing a restart
    // keeps, so a printed sheet still works; only for households still in
    // use (deletion purges them anyway).
    const prepared = store?.loadPreparedInvitations?.(now()) ?? [];
    this.restorePreparedPairings(prepared.filter((row) => {
      const household = this.households.get(row.householdId);
      return household && (household.lifecycleState ?? "active") === "active";
    }));
  }

  verifier(code) {
    return createHmac("sha256", this.secret)
      .update(normalizeCode(code))
      .digest("hex");
  }

  audit(type, details = {}) {
    this.events.push({ type, at: this.now(), ...details, persisted: false });
    if (this.events.length > 10_000) this.events.shift();
  }

  persistHousehold(householdId) {
    this.store?.saveIdentityHousehold(householdId, this);
  }

  state(pairing) {
    if (
      ["Pending", "Claimed"].includes(pairing.state) &&
      pairing.expiresAt <= this.now()
    ) {
      pairing.state = "Expired";
      pairing.terminalAt = this.now();
      pairing.version += 1;
      this.retireCode(pairing);
      this.audit("pairing_expired", {
        householdId: pairing.householdId,
        pairingId: pairing.id,
      });
    }
    return pairing.state;
  }

  // Pairing-code guessing limit, per client key (see server/client-key.mjs).
  // Only failed attempts are counted, so a household's own successful
  // claim never spends its budget. Once a client is over the limit every
  // attempt is refused, valid code or not; otherwise the 429 itself would
  // tell a guesser which code is right.
  pruneRateBuckets(table = this.rateBuckets) {
    const cutoff = this.now() - RATE_WINDOW_MS;
    for (const [rateKey, values] of table) {
      const active = values.filter((at) => at > cutoff);
      if (active.length) table.set(rateKey, active);
      else table.delete(rateKey);
    }
  }

  // `table` and `event` let another limit (sign-in links, #99) keep its own
  // buckets, so it can never fill the pairing-code table.
  assertRateAvailable(key, { table = this.rateBuckets, event = "pairing_rate_limited" } = {}) {
    this.pruneRateBuckets(table);
    const bucket = table.get(key);
    // A client that could not be charged for a failure must not get to try
    // at all: refuse a new client before its attempt while the table is
    // full, so no response ever depends on whether its code was right.
    if (
      (!bucket && table.size >= this.maxRateBuckets) ||
      (bucket?.length ?? 0) >= RATE_LIMIT
    ) {
      this.audit(event);
      throw new PairingError(
        "rate_limited",
        "Too many attempts. Wait a minute and try again.",
        429,
      );
    }
  }

  recordFailedAttempt(key, { table = this.rateBuckets, event = "pairing_rate_limited" } = {}) {
    let bucket = table.get(key);
    if (!bucket) {
      if (table.size >= this.maxRateBuckets) {
        this.audit(event);
        throw new PairingError(
          "rate_limited",
          "Too many attempts. Wait a minute and try again.",
          429,
        );
      }
      bucket = [];
      table.set(key, bucket);
    }
    bucket.push(this.now());
  }

  /** Runs one code attempt for `key`, charging the limit only if it fails. */
  rateLimitedAttempt(key, attempt, limits) {
    this.assertRateAvailable(key, limits);
    try {
      return attempt();
    } catch (error) {
      if (error instanceof PairingError && error.code !== "rate_limited")
        this.recordFailedAttempt(key, limits);
      throw error;
    }
  }

}

addMethods(PairingService, bootstrapLimitMethods, sessionMethods, createMethods, claimMethods, approveMethods, deviceMethods, membershipMethods, lifecycleMethods, linkMethods, passwordMethods, newDeviceMethods, accountMethods);
