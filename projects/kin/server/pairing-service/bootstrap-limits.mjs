// Limits on creating households (issue #157). Bootstrap is the one
// unauthenticated way to make durable state, so it is limited per client
// (server/client-key.mjs) and the operator can cap or close it:
//
// - KIN_ALLOW_NEW_HOUSEHOLDS=false refuses every new household, for a server
//   whose family's household already exists.
// - KIN_MAX_HOUSEHOLDS=<n> refuses a new household once n exist. Deleted
//   households don't count.
//
// Both default to the earlier behaviour: creation open, no cap. Neither ever
// touches an existing household; they only gate `bootstrap`.
import { PairingError } from "./shared.mjs";

/** Successful bootstraps allowed per client key in one window. */
export const BOOTSTRAP_LIMIT = 3;
export const BOOTSTRAP_WINDOW_MS = 60 * 60_000;

export const HOUSEHOLD_CREATION_CLOSED = "This Kin server isn't accepting new households.";

/** Parses the two operator settings. Throws code `household_policy_invalid`. */
export function parseHouseholdPolicy({ allowNewHouseholds, maxHouseholds } = {}) {
  const invalid = (message) =>
    Object.assign(new Error(message), { code: "household_policy_invalid" });
  let allowNew = true;
  if (typeof allowNewHouseholds === "boolean") allowNew = allowNewHouseholds;
  else if (allowNewHouseholds !== undefined && allowNewHouseholds !== null && allowNewHouseholds !== "") {
    const value = String(allowNewHouseholds).trim().toLowerCase();
    if (["true", "1", "yes"].includes(value)) allowNew = true;
    else if (["false", "0", "no"].includes(value)) allowNew = false;
    else throw invalid(`KIN_ALLOW_NEW_HOUSEHOLDS must be true or false; "${allowNewHouseholds}" is neither.`);
  }
  let max = null;
  if (typeof maxHouseholds === "number") max = maxHouseholds;
  else if (maxHouseholds !== undefined && maxHouseholds !== null && String(maxHouseholds).trim() !== "") {
    const text = String(maxHouseholds).trim();
    if (!/^\d+$/.test(text)) throw invalid(`KIN_MAX_HOUSEHOLDS must be a whole number; "${maxHouseholds}" is not one.`);
    max = Number(text);
  }
  if (max !== null && !Number.isSafeInteger(max)) throw invalid("KIN_MAX_HOUSEHOLDS must be a whole number.");
  if (max !== null && max < 0) throw invalid("KIN_MAX_HOUSEHOLDS must not be negative.");
  return Object.freeze({ allowNew, maxHouseholds: max });
}

const closed = () => new PairingError("household_creation_closed", HOUSEHOLD_CREATION_CLOSED, 403);

export const bootstrapLimitMethods = {
  /** Households that count toward KIN_MAX_HOUSEHOLDS. */
  countLiveHouseholds() {
    let count = 0;
    for (const household of this.households.values())
      if (household.lifecycleState !== "deleted") count += 1;
    return count;
  },

  pruneBootstrapBuckets() {
    const cutoff = this.now() - BOOTSTRAP_WINDOW_MS;
    for (const [key, values] of this.bootstrapBuckets) {
      const active = values.filter((at) => at > cutoff);
      if (active.length) this.bootstrapBuckets.set(key, active);
      else this.bootstrapBuckets.delete(key);
    }
  },

  /**
   * Refuses a new household when creation is closed, the cap is reached, or
   * `rateKey` has used its allowance. Called when the passkey ceremony starts
   * (so the person isn't asked for a passkey first) and again in bootstrap.
   * Without a rateKey (direct service calls) only the operator policy applies.
   */
  assertBootstrapAllowed(rateKey) {
    const policy = this.householdPolicy;
    if (!policy.allowNew) {
      this.audit("household_creation_refused", { reason: "closed" });
      throw closed();
    }
    if (policy.maxHouseholds !== null && this.countLiveHouseholds() >= policy.maxHouseholds) {
      this.audit("household_creation_refused", { reason: "cap" });
      throw closed();
    }
    if (rateKey === undefined) return;
    this.pruneBootstrapBuckets();
    const bucket = this.bootstrapBuckets.get(rateKey);
    // As with pairing codes, a client that couldn't be charged must not get
    // through: a full table refuses new clients.
    if ((!bucket && this.bootstrapBuckets.size >= this.maxRateBuckets) ||
        (bucket?.length ?? 0) >= BOOTSTRAP_LIMIT) {
      this.audit("household_creation_rate_limited");
      throw new PairingError(
        "rate_limited",
        "Too many households were created from this network recently. Try again in an hour.",
        429,
      );
    }
  },

  recordBootstrap(rateKey) {
    if (rateKey === undefined) return;
    const bucket = this.bootstrapBuckets.get(rateKey);
    if (bucket) bucket.push(this.now());
    else this.bootstrapBuckets.set(rateKey, [this.now()]);
  },
};
