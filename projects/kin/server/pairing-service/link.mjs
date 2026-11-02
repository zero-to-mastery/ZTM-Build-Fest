// PairingService: link requests (#99). A member signed in on a trusted phone
// signs a computer in by scanning the computer's QR code and approving with a
// fresh passkey; the computer finishes by typing a 6-digit code shown on the
// phone, which only reaches the computer actually in front of the member.
//
// Flow and rules:
// - The computer creates a request (unauthenticated, rate-limited per client)
//   with its public sync keys and its automatic name. The service keeps a
//   SHA-256 verifier of the request secret, never the secret, and a device ID
//   for the computer chosen by the service. The QR code carries the request
//   ID, the secret and the key fingerprint in a URL fragment.
// - The phone (an Adult's session on a trusted device: the same rule as adding
//   a device) presents the secret and the fingerprint it scanned. The
//   fingerprint must match the stored keys, so the server can't swap them.
//   After a fresh passkey assertion bound to the request, it approves: for a
//   new computer it signs the device certificate (existing certificate path).
//   The phone picks the 6-digit code at random and sends it with a tag: an
//   HMAC binding its own device ID and key to the request, keyed by the code
//   and a nonce only the QR code carries (never sent here). The service keeps
//   only the code's hash and the tag. A correct code from the computer
//   releases which device approved, its fingerprint and the tag; the computer
//   checks the tag with the nonce and the typed code before trusting that
//   device's key (web/device-link.js).
// - The computer completes with the code: three tries, then the request ends.
//   A new computer becomes a trusted device of the approving member and
//   receives retained history; a computer already trusted for that member,
//   with the same keys, gets a new session and a rotated device token, as
//   after a passkey login.
// - Either side can cancel with the secret. Requests are process-local and
//   end on restart, like pairings. Errors about a request are generic: an
//   unknown, expired, cancelled or mismatched request looks the same.
// - Audit events hold IDs and outcomes only. Approval and completion are
//   saved with the household in their own transactions. An end after
//   approval marks its household, and the route saves it once its own
//   transaction is over (flushLinkAudits), so a failure that rolls the route
//   back can't take the audit with it. A household being deleted is never
//   saved again (the store refuses it), and asking to delete one ends its
//   requests. A request that was never approved belongs to no household, so
//   its requested and failed events stay in the in-memory log only.
// - Limits: request creation per client (every request counts) and live
//   requests per client and in all; approval failures per member; wrong codes
//   per client. Link limits keep their own buckets, apart from pairing codes.
//   Behind a proxy, set KIN_TRUSTED_PROXIES, or every client shares one key.
// - A returning computer offers its existing device's keys. If its device
//   cookie names that device, `returning` is true and approval by the same
//   member signs that device back in. Approval as anyone else, or of keys any
//   device already has, is refused: a device's keys are never shared by two
//   devices. Only Adults approve, as for adding a device, so Limited and
//   Temporary members sign back in with their own passkey instead.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { MAX_TRUSTED_DEVICES } from "../identity-limits.mjs";
import { deviceLabel } from "./device-label.mjs";
import { validateDeviceAuthorizationCertificate, validateSyncPublicKeys } from "./devices.mjs";
import { canParticipate, id, PairingError, requireTrustAuthority } from "./shared.mjs";

/** A request waits this long to be approved. */
export const LINK_REQUEST_TTL_MS = 2 * 60_000;
/** After approval, the computer has this long to type the code. */
export const LINK_CODE_TTL_MS = 2 * 60_000;
/** Wrong codes allowed before the request ends. */
export const LINK_CODE_ATTEMPTS = 3;
/** Live (waiting or approved) requests at once, across all clients. */
export const MAX_LINK_REQUESTS = 512;
/** Live requests at once from one client. */
export const MAX_LINK_REQUESTS_PER_CLIENT = 4;
/** A finished or ended request is remembered this long, so the computer's
 * poll can see how it ended. */
const LINK_RETENTION_MS = 60_000;

const LIMITS = Object.freeze({ event: "device_link_rate_limited" });
const live = (request) => ["pending", "approved"].includes(request.state);

const digest = (value) => createHash("sha256").update(String(value)).digest();
const matches = (expected, value) => Boolean(expected) && timingSafeEqual(expected, digest(value));

function unavailable() {
  return new PairingError(
    "link_unavailable",
    "That sign-in request is no longer available. Start again on the computer.",
    410,
  );
}

export const linkMethods = {
  pruneLinkRequests(now = this.now()) {
    for (const [requestId, request] of this.linkRequests) {
      this.linkState(request);
      if (["done", "ended"].includes(request.state) && request.endedAt + LINK_RETENTION_MS <= now)
        this.linkRequests.delete(requestId);
    }
  },

  /** The request's state, ending it first if it has expired. */
  linkState(request) {
    if (["pending", "approved"].includes(request.state) && request.expiresAt <= this.now())
      this.endLinkRequest(request, "expired");
    return request.state;
  },

  endLinkRequest(request, reason) {
    if (!["pending", "approved"].includes(request.state)) return;
    request.state = "ended";
    request.endedAt = this.now();
    request.codeVerifier = null;
    this.audit("device_link_failed", {
      requestId: request.id,
      ...(request.approval ? { householdId: request.approval.householdId, memberId: request.approval.memberId } : {}),
      reason,
    });
    if (request.approval) this.linkAuditsPending.add(request.approval.householdId);
  },

  /** Saves the households whose requests ended, outside any transaction the
   * caller had open. Households no longer active are skipped: the store
   * refuses them, and their deletion is the record that matters. */
  flushLinkAudits() {
    const households = [...this.linkAuditsPending];
    this.linkAuditsPending.clear();
    for (const householdId of households) {
      const household = this.households.get(householdId);
      if (!household || ["deletion_pending", "deleted"].includes(household.lifecycleState)) continue;
      this.persistHousehold(householdId);
    }
  },

  /** A household's deletion was requested: its requests end with it. */
  endHouseholdLinkRequests(householdId) {
    for (const request of this.linkRequests.values())
      if (request.approval?.householdId === householdId) this.endLinkRequest(request, "household_unavailable");
  },

  /** The request for `requestId` if `secret` is its secret; otherwise the
   * same error as for a request that doesn't exist. */
  linkRequestFor(requestId, secret) {
    this.pruneLinkRequests();
    const request = this.linkRequests.get(String(requestId ?? ""));
    if (!request || typeof secret !== "string" || !matches(request.verifier, secret)) throw unavailable();
    return request;
  },

  /** The computer asks to be signed in. Every request counts against the
   * client's limit, whether or not it is ever approved. */
  createLinkRequest({ syncPublicKeys, deviceLabel: label, deviceToken, rateKey = "unknown" } = {}) {
    const key = `link-create:${rateKey}`;
    this.assertRateAvailable(key, { ...LIMITS, table: this.linkRateBuckets });
    this.recordFailedAttempt(key, { ...LIMITS, table: this.linkRateBuckets });
    this.pruneLinkRequests();
    let total = 0;
    let fromClient = 0;
    for (const request of this.linkRequests.values()) {
      if (!live(request)) continue;
      total += 1;
      if (request.rateKey === rateKey) fromClient += 1;
    }
    if (fromClient >= MAX_LINK_REQUESTS_PER_CLIENT)
      throw new PairingError("rate_limited", "Too many sign-in requests from here. Cancel one, or wait a minute.", 429);
    if (total >= MAX_LINK_REQUESTS)
      throw new PairingError("link_capacity", "Too many sign-in requests right now. Try again in a minute.", 503);
    const keys = validateSyncPublicKeys(syncPublicKeys);
    // The computer's existing device, when its cookie names a trusted device
    // with the keys it offers: a returning computer.
    let existingDeviceId = null;
    if (deviceToken) {
      try {
        const { device } = this.trustedDevice(deviceToken);
        if (device.syncKeyFingerprint === keys.syncKeyFingerprint) existingDeviceId = device.id;
      } catch {
        // Not a trusted device (or no longer one): the computer is new.
      }
    }
    const requestId = id();
    const secret = randomBytes(32).toString("base64url");
    const now = this.now();
    this.linkRequests.set(requestId, {
      id: requestId,
      verifier: digest(secret),
      syncPublicKeys: keys.syncPublicKeys,
      syncKeyFingerprint: keys.syncKeyFingerprint,
      deviceLabel: deviceLabel(label),
      deviceId: id(),
      existingDeviceId,
      rateKey,
      createdAt: now,
      expiresAt: now + LINK_REQUEST_TTL_MS,
      state: "pending",
      attempts: 0,
      codeVerifier: null,
      approval: null,
      endedAt: null,
    });
    this.audit("device_link_requested", { requestId });
    return {
      requestId, secret, fingerprint: keys.syncKeyFingerprint, expiresAt: now + LINK_REQUEST_TTL_MS,
      returning: Boolean(existingDeviceId),
    };
  },

  /** What the computer may learn while it waits: only the state. */
  linkStatus(requestId, secret) {
    const request = this.linkRequestFor(requestId, secret);
    // Nothing about the approver: that is released only by a correct code.
    return { state: this.linkState(request), expiresAt: request.expiresAt };
  },

  /** The device this request signs back in: the computer's existing trusted
   * device, when it belongs to `member` and has the same keys. */
  linkExistingDevice(request, member) {
    if (!request.existingDeviceId) return null;
    const device = request.existingDeviceId && this.devices.get(request.existingDeviceId);
    if (!device || device.revokedAt || device.memberId !== member.id) return null;
    return device.syncKeyFingerprint === request.syncKeyFingerprint ? device : null;
  },

  /** The phone checks a scanned request before approving it. Failures count
   * against the member's limit. */
  linkRequestForApprover(sessionToken, requestId, { secret, fingerprint } = {}) {
    const { member, household } = this.authorize(sessionToken);
    requireTrustAuthority(member, "sign in another device");
    return this.rateLimitedAttempt(`link-approve:${member.id}`, () => {
      const request = this.linkRequestFor(requestId, secret);
      if (this.linkState(request) !== "pending") throw unavailable();
      if (request.syncKeyFingerprint !== String(fingerprint ?? "")) {
        // The keys the service holds aren't the ones the camera saw.
        this.endLinkRequest(request, "fingerprint_mismatch");
        throw new PairingError(
          "link_fingerprint_mismatch",
          "This computer's key doesn't match the code you scanned. Start again on the computer.",
          409,
        );
      }
      const existing = this.linkExistingDevice(request, member);
      if (!existing && this.deviceWithKeys(request.syncKeyFingerprint)) {
        // These keys are another device's: someone else's computer, or a
        // device removed since. Signing it in as a new device would share them.
        this.endLinkRequest(request, "device_taken");
        throw new PairingError(
          "link_device_taken",
          "This computer is already set up for another Kin account. Sign in on it with that account's phone or passkey, or start again on the computer.",
          409,
        );
      }
      if (!existing && this.activeTrustedDeviceCount(household) >= MAX_TRUSTED_DEVICES)
        throw new PairingError("device_limit", "This household reached its trusted-device limit.", 409);
      return {
        requestId: request.id,
        householdId: household.id,
        memberId: member.id,
        deviceId: existing?.id ?? request.deviceId,
        deviceLabel: request.deviceLabel,
        syncPublicKeys: structuredClone(request.syncPublicKeys),
        syncKeyFingerprint: request.syncKeyFingerprint,
        existingDevice: Boolean(existing),
        expiresAt: request.expiresAt,
      };
    }, { ...LIMITS, table: this.linkRateBuckets });
  },

  /** Any device, in any household and revoked or not, that has or had
   * these keys. */
  deviceWithKeys(fingerprint) {
    for (const device of this.devices.values()) {
      if (device.syncKeyFingerprint === fingerprint) return device;
      if (device.syncKeyHistory?.some((entry) => entry.fingerprint === fingerprint)) return device;
    }
    return null;
  },

  /** The phone approves, after the route has verified a fresh passkey
   * assertion bound to this request, with the code the phone derived. */
  approveLinkRequest(sessionToken, requestId, { secret, fingerprint, deviceCertificate, code, tag } = {}) {
    if (typeof code !== "string" || !/^[0-9]{6}$/.test(code) || typeof tag !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(tag))
      throw new PairingError("invalid_request", "Kin could not understand that request.", 400);
    const view = this.linkRequestForApprover(sessionToken, requestId, { secret, fingerprint });
    const { member, household, device: approverDevice } = this.authorize(sessionToken);
    if (!approverDevice.syncKeyFingerprint)
      throw new PairingError("device_sync_key_required", "This device needs its sync key before it can approve a computer.", 409);
    const request = this.linkRequests.get(view.requestId);
    let certificate = null;
    if (!view.existingDevice) {
      certificate = validateDeviceAuthorizationCertificate(deviceCertificate, {
        householdId: household.id,
        memberId: member.id,
        deviceId: request.deviceId,
        claimantPublicKeys: request.syncPublicKeys,
        claimantFingerprint: request.syncKeyFingerprint,
        approverDevice,
      });
    }
    request.state = "approved";
    request.codeVerifier = digest(`${request.id}:${code}`);
    request.expiresAt = this.now() + LINK_CODE_TTL_MS;
    request.approval = {
      householdId: household.id,
      memberId: member.id,
      approverDeviceId: approverDevice.id,
      approverFingerprint: approverDevice.syncKeyFingerprint,
      tag,
      existingDeviceId: view.existingDevice ? view.deviceId : null,
      certificate,
    };
    this.audit("device_link_approved", {
      householdId: household.id,
      requestId: request.id,
      memberId: member.id,
      approverDeviceId: approverDevice.id,
    });
    this.persistHousehold(household.id);
    return { expiresAt: request.expiresAt, deviceLabel: request.deviceLabel, existingDevice: view.existingDevice };
  },

  /** The computer finishes with the code from the phone. Wrong codes count
   * against the client's limit; the third ends the request. */
  completeLinkRequest({ requestId, secret, code, rateKey = "unknown" } = {}) {
    return this.rateLimitedAttempt(`link-complete:${rateKey}`, () => {
      const request = this.linkRequestFor(requestId, secret);
      const state = this.linkState(request);
      if (state === "pending")
        throw new PairingError("link_not_approved", "Approve this computer on your phone first.", 409);
      if (state !== "approved") throw unavailable();
      if (!matches(request.codeVerifier, `${request.id}:${String(code ?? "").trim()}`)) {
        request.attempts += 1;
        if (request.attempts >= LINK_CODE_ATTEMPTS) {
          this.endLinkRequest(request, "code_attempts");
          throw new PairingError("link_code_attempts", "That code didn't match three times. Start again on the computer.", 410);
        }
        const left = LINK_CODE_ATTEMPTS - request.attempts;
        throw new PairingError("link_code_mismatch", `That code didn't match. ${left} ${left === 1 ? "try" : "tries"} left.`, 400);
      }
      // Everything the approval relied on is checked again now.
      const approval = request.approval;
      const member = this.members.get(approval.memberId);
      const household = this.households.get(approval.householdId);
      const approverDevice = this.devices.get(approval.approverDeviceId);
      const fail = (reason, error) => {
        this.endLinkRequest(request, reason);
        throw error;
      };
      if (!household || household.lifecycleState === "deletion_pending" || household.lifecycleState === "deleted")
        fail("household_unavailable", unavailable());
      if (!member?.active || member.householdId !== household.id || !canParticipate(member, this.now()))
        fail("membership_removed", unavailable());
      if (!approverDevice || approverDevice.revokedAt || approverDevice.memberId !== member.id)
        fail("approver_revoked", unavailable());
      let device;
      const newDevice = !approval.existingDeviceId;
      if (!newDevice) {
        device = this.devices.get(approval.existingDeviceId);
        if (!device || device.revokedAt || device.memberId !== member.id) fail("device_revoked", unavailable());
      } else {
        if (this.activeTrustedDeviceCount(household) >= MAX_TRUSTED_DEVICES)
          fail("device_limit", new PairingError("device_limit", "This household reached its trusted-device limit.", 409));
        device = {
          id: request.deviceId,
          memberId: member.id,
          householdId: household.id,
          label: request.deviceLabel,
          trustedAt: this.now(),
          revokedAt: null,
          tokenHash: null,
          syncPublicKeys: request.syncPublicKeys,
          syncKeyFingerprint: request.syncKeyFingerprint,
          deviceAuthorizationCertificate: approval.certificate,
        };
        this.devices.set(device.id, device);
        household.version += 1;
        this.audit("device_trusted", { householdId: household.id, memberId: member.id, deviceId: device.id });
      }
      const deviceToken = this.issueDeviceToken(device);
      const { sessionToken } = this.issueSession(member.id, device.id);
      request.state = "done";
      request.endedAt = this.now();
      request.codeVerifier = null;
      this.audit("device_link_completed", {
        householdId: household.id,
        requestId: request.id,
        memberId: member.id,
        deviceId: device.id,
        newDevice,
      });
      this.persistHousehold(household.id);
      return {
        sessionToken, deviceToken, householdId: household.id, memberId: member.id, deviceId: device.id, newDevice,
        approverDeviceId: approverDevice.id,
        approverFingerprint: approval.approverFingerprint,
        tag: approval.tag,
      };
    }, { ...LIMITS, table: this.linkRateBuckets });
  },

  /** Either side ends the request: the computer that made it, or the phone
   * that scanned it (both hold the secret). */
  cancelLinkRequest(requestId, secret) {
    const request = this.linkRequestFor(requestId, secret);
    this.endLinkRequest(request, "cancelled");
    return { state: this.linkState(request) };
  },
};
