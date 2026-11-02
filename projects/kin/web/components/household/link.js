// Signing in on a computer with a phone (#98): the computer's side (#100).
//
// The computer makes its device keys here, asks the service for a sign-in
// request and shows it as a QR code. A member scans it with Kin on a phone
// that is already signed in and approves with a passkey; the phone then
// shows a 6-digit code, and typing it here finishes the sign-in. The code
// only reaches the computer in front of the person, so a QR code shown
// somewhere else can't be completed.
//
// - The QR code also carries a nonce the service never sees. The phone
//   sends, with its random code, a tag binding its own device and key to the
//   request, keyed by the nonce and the code (web/device-link.js). A correct
//   code releases the approving device and the tag; the computer checks the
//   tag with the nonce and the code the person typed, then pins that
//   device's key, so its first sync can verify the household. A tag that
//   doesn't check signs the computer out again.
// - A computer that already has a device in a household offers that
//   device's keys, so a returning computer keeps its device and its history.
//   The service says whether its device cookie names that device; if not,
//   the computer starts again with fresh keys and joins as a new device.
//   "Sign in as someone else" always uses fresh keys (a shared computer).
// - The QR code replaces itself when the request expires, a few times, then
//   stops. Its countdown is plain text: nothing is announced every second.
// - Cancel, Kin locking, the page going away and starting over end the
//   request. Moving to another view in Kin hides this screen without ending
//   it; it then ends with its 2-minute expiry.
//
// Part of <kin-household>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-household.js lists them).
import { currentPlatform, householdDeviceName } from "../../platform.js";
import { deviceKeyFingerprint } from "../../sync/crypto.js";
import { cleanLinkCode, isLinkCode, LINK_CODE_LENGTH, linkNonce, linkTagMatches, signInLink } from "../../device-link.js";

/** How often the computer asks whether the phone has approved. */
export const SIGN_IN_POLL_MS = 2_000;
/** Replacement QR codes shown before the screen stops and asks. */
export const MAX_SIGN_IN_REFRESHES = 4;
/** How long a request waits, and how long the code works once approved, as
 * the service sets them (LINK_REQUEST_TTL_MS, LINK_CODE_TTL_MS). The screen
 * counts down from when it heard, not from the service's clock, which may
 * not agree with this one; the service still decides what has expired. */
export const SIGN_IN_TTL_MS = 2 * 60_000;
/** An expired request the QR code hasn't replaced in this long has ended. */
const STALE_MS = 15_000;

export const SIGN_IN_STEPS = "On your phone, open Kin → People & devices → Add a computer → Scan.";

const ENDED_NOTICE = "This sign-in request ended. Nothing was signed in.";
const UNVERIFIED = "Kin couldn't verify the phone that approved this computer, so it signed this computer out. Start again.";

function remaining(expiresAt) {
  const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export class HouseholdLink {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
    /** The request on screen: { requestId, secret, fingerprint, nonce,
     * expiresAt, state, keys: "existing" | "pending", deviceId, fresh,
     * refreshes }. */
    this.request = null;
    this.ended = null;
    this.lastKeys = null;
    this.starting = false;
    this.countdown = null;
    this.ticker = null;
    this.poller = null;
    this.focusNext = null;
    /** Status text waits this long after a render, so screen readers hear a
     * region that already exists change. */
    this.announceDelay = 100;
    this.onPageHide = () => this.release(this.request);
  }

  /** Opens the screen and starts a request; `fresh` offers new keys even on
   * a computer that has a device (someone else signing in). */
  async begin({ fresh = false } = {}) {
    this.release(this.request);
    this.stop();
    this.request = null;
    this.ended = null;
    this.starting = true;
    this.focusNext = "heading";
    globalThis.removeEventListener?.("pagehide", this.onPageHide);
    globalThis.addEventListener?.("pagehide", this.onPageHide);
    this.host.render();
    await this.host.run(async () => {
      try {
        this.request = await this.create({ fresh });
      } finally {
        // Shown before any failure's message, which render() would clear.
        this.starting = false;
        this.focusNext = this.request ? "heading" : null;
        this.host.render();
      }
    });
    this.starting = false;
  }

  /** A new request for this computer, with the keys it should offer. */
  async create({ refreshes = 0, fresh = false } = {}) {
    const store = await this.ctx.api.openSyncKeyStore();
    const returning = fresh ? null : await store.latestBoundDevice();
    const pending = () => store.getOrCreatePendingDevice();
    const ask = (syncPublicKeys) => this.host.api("/api/link/requests", {
      method: "POST",
      body: JSON.stringify({ syncPublicKeys, deviceLabel: householdDeviceName(currentPlatform()) }),
    });
    let offered = returning ?? (await pending());
    let created = await ask(offered.publicKeys);
    let keys = returning ? "existing" : "pending";
    if (returning && !created.returning) {
      // Its device cookie doesn't name that device (signed out elsewhere,
      // removed, or cookies cleared): join as a new device with fresh keys.
      await this.release(created);
      offered = await pending();
      created = await ask(offered.publicKeys);
      keys = "pending";
    }
    if (created.fingerprint !== offered.fingerprint) {
      this.release(created);
      throw new Error("The service answered for keys this computer didn't offer. Nothing was signed in.");
    }
    return {
      requestId: created.requestId,
      secret: created.secret,
      fingerprint: created.fingerprint,
      nonce: linkNonce(),
      expiresAt: Date.now() + SIGN_IN_TTL_MS,
      state: "pending",
      keys,
      deviceId: keys === "existing" ? returning.deviceId : null,
      fresh,
      refreshes,
    };
  }

  /** The QR code's replacement once a request expires unscanned. */
  async refresh() {
    const current = this.request;
    if (!current || current.state !== "pending" || current.refreshes >= MAX_SIGN_IN_REFRESHES) return null;
    // The phone may have approved in the last moments: never cancel that.
    const status = await this.requestStatus(current).catch(() => null);
    if (this.request !== current) return null;
    if (status?.state === "approved") {
      this.approved(current, status);
      return null;
    }
    // Ended first, so the service's per-client cap never counts it.
    await this.release(current);
    const next = await this.create({ refreshes: current.refreshes + 1, fresh: current.fresh });
    if (this.request !== current) {
      this.release(next);
      return null;
    }
    this.request = next;
    this.schedulePoll();
    return { value: this.link(next), code: "", expiresAt: next.expiresAt };
  }

  link(request) {
    return signInLink(location.origin, request);
  }

  requestStatus(request) {
    return this.host.api(`/api/link/requests/${request.requestId}/status`, {
      method: "POST",
      body: JSON.stringify({ secret: request.secret }),
    });
  }

  /** Ends a request with the service, best effort (keepalive survives the
   * page going away). */
  release(request) {
    if (!request?.requestId || !request.secret) return Promise.resolve();
    return fetch(`/api/link/requests/${request.requestId}`, {
      method: "DELETE",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: request.secret }),
    }).catch(() => {});
  }

  /** Cancel: ends the request and returns to the choices. */
  cancel() {
    this.release(this.request);
    this.stop();
    this.request = null;
    this.ended = null;
    globalThis.removeEventListener?.("pagehide", this.onPageHide);
    this.host.startIntent(null);
  }

  /** Kin locked or the element left the page. */
  abandon() {
    this.release(this.request);
    this.stop();
    this.request = null;
    globalThis.removeEventListener?.("pagehide", this.onPageHide);
  }

  stop() {
    clearInterval(this.ticker);
    clearTimeout(this.poller);
    this.ticker = null;
    this.poller = null;
  }

  end(notice = ENDED_NOTICE) {
    this.release(this.request);
    this.lastKeys = this.request?.keys ?? this.lastKeys;
    this.stop();
    this.request = null;
    this.ended = notice;
    this.focusNext = "heading";
    this.host.render();
  }

  schedulePoll() {
    clearTimeout(this.poller);
    this.poller = setTimeout(() => this.poll(), SIGN_IN_POLL_MS);
  }

  async poll() {
    const request = this.request;
    if (!request || !this.host.isConnected) return;
    // An unscanned request that ran out is the QR code's to replace; one it
    // hasn't replaced (the code isn't on screen) has simply ended.
    const lapsed = request.state === "pending" && request.expiresAt <= Date.now();
    if (lapsed && request.expiresAt + STALE_MS <= Date.now())
      return this.end("The sign-in code expired. Nothing was signed in.");
    let status;
    try {
      status = await this.requestStatus(request);
    } catch (error) {
      if (this.request !== request) return;
      if (error.code === "link_unavailable") return lapsed ? this.schedulePoll() : this.end();
      return this.schedulePoll();
    }
    if (this.request !== request) return;
    if (status.state === "approved" && request.state === "pending") return this.approved(request, status);
    if (status.state === "ended") return lapsed ? this.schedulePoll() : this.end();
    if (status.state === "done") return;
    this.schedulePoll();
  }

  /** The phone approved: ask for the code. */
  approved(request, status) {
    request.state = "approved";
    request.expiresAt = Date.now() + SIGN_IN_TTL_MS;
    this.focusNext = "code";
    this.host.render();
    this.announce("Your phone approved this computer. Type the 6-digit code it shows.");
  }

  announce(text) {
    const status = this.status;
    if (!status) return;
    const show = () => { if (this.status === status) status.textContent = text; };
    // Cleared first, so the same words said twice are announced twice.
    status.textContent = "";
    if (this.announceDelay > 0) setTimeout(show, this.announceDelay);
    else show();
  }

  wrongCode(message) {
    if (this.field) {
      this.field.value = "";
      this.field.focus();
    }
    this.announce(message);
  }

  async complete(code) {
    const request = this.request;
    if (!request || request.state !== "approved") return;
    const digits = cleanLinkCode(code);
    if (!isLinkCode(digits)) {
      this.announce(`Type all ${LINK_CODE_LENGTH} digits from your phone.`);
      this.field?.focus();
      return;
    }
    await this.host.run(async () => {
      if (request.keys === "pending") {
        const local = await this.host.syncKeyStore.getDevice("pending");
        if (local?.fingerprint !== request.fingerprint)
          return this.end("This computer's keys changed while it was signing in, perhaps in another tab. Nothing was signed in.");
      }
      let result;
      try {
        result = await this.host.api(`/api/link/requests/${request.requestId}/complete`, {
          method: "POST",
          body: JSON.stringify({ secret: request.secret, code: digits }),
        });
      } catch (error) {
        if (this.request !== request) return;
        if (error.code === "link_code_mismatch") return this.wrongCode(`${error.message} Check the code on your phone and type it again.`);
        if (error.code === "link_code_attempts")
          return this.end("That code was wrong too many times, so the sign-in request ended. Nothing was signed in.");
        if (error.code === "link_unavailable") return this.end(ENDED_NOTICE);
        throw error;
      }
      this.stop();
      this.request = null;
      globalThis.removeEventListener?.("pagehide", this.onPageHide);
      // The approving device the service names must be the one the phone's
      // tag binds to this code and this QR code's nonce.
      const tagged = await linkTagMatches(result.tag, {
        nonce: request.nonce, code: digits, requestId: request.requestId,
        approverDeviceId: result.approverDeviceId, approverFingerprint: result.approverFingerprint,
        computerFingerprint: request.fingerprint,
      });
      const matches = tagged &&
        (result.newDevice ? request.keys === "pending" : request.keys === "existing" && result.deviceId === request.deviceId);
      if (!matches) {
        // The service now trusts those pending keys as a device; never offer
        // them again, or every later attempt would look like a return.
        if (result.newDevice) await this.host.syncKeyStore.discardPendingDevice().catch(() => {});
        return this.signOut(UNVERIFIED);
      }
      if (result.newDevice)
        await this.host.syncKeyStore.bindPendingDevice({
          deviceId: result.deviceId, householdId: result.householdId, memberId: result.memberId,
        });
      // Any failure to pin (the directory unreachable, say) signs out too:
      // a computer without the pin couldn't sync.
      const pinned = await this.pinApprover(request, result).catch(() => false);
      if (!pinned) return this.signOut(UNVERIFIED);
      if (result.newDevice) {
        // A new device starts Kin afresh, as after joining with a code.
        location.href = "/";
        return;
      }
      this.host.intent = null;
      history.replaceState(null, "", "/");
      await this.host.load();
    });
  }

  /** Pins the approving phone's key, after checking that the directory's
   * copy is the key the phone's tag named. Sync then verifies the household
   * from it. */
  async pinApprover(request, result) {
    const { devices } = await this.host.api("/api/sync/devices");
    const approver = devices.find((device) => device.deviceId === result.approverDeviceId);
    if (!approver?.publicKeys || approver.memberId !== result.memberId ||
        (await deviceKeyFingerprint(approver.publicKeys)) !== result.approverFingerprint)
      return false;
    const store = this.host.syncKeyStore;
    // A returning computer may have pinned it before, perhaps under an
    // earlier key; sync checks that pin against the key history.
    if (await store.getPinnedDevice(result.householdId, approver.deviceId)) return true;
    await store.pinTrustedDevice({
      householdId: result.householdId,
      memberId: approver.memberId,
      deviceId: approver.deviceId,
      publicKeys: approver.publicKeys,
      fingerprint: result.approverFingerprint,
    });
    return true;
  }

  async signOut(message) {
    await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
    throw new Error(message);
  }

  /** The screen, for whichever step the request is at. */
  render() {
    clearInterval(this.ticker);
    this.ticker = null;
    const heading = document.createElement("h3");
    heading.className = "sign-in-heading";
    heading.tabIndex = -1;
    heading.textContent = "Sign in with your phone";
    const status = document.createElement("p");
    status.className = "sign-in-status";
    status.setAttribute("role", "status");
    this.status = status;
    this.field = null;
    this.host.append(heading);
    const request = this.request;
    if (!request) {
      if (this.ended) {
        this.host.text(this.ended);
        this.host.append(status);
        this.host.button("Show a new code", () => this.begin());
        // On a shared computer, the device it offered may be someone else's.
        if (this.lastKeys === "existing")
          this.host.button("Sign in as someone else", () => this.begin({ fresh: true }), "secondary");
      } else {
        this.host.text(this.starting ? "Getting a sign-in code…" : "Kin couldn't get a sign-in code.");
        this.host.append(status);
        if (!this.starting) this.host.button("Try again", () => this.begin());
      }
      this.host.button("Back", () => this.cancel(), "secondary");
      this.applyFocus(heading);
      return;
    }
    if (request.state === "approved") {
      this.host.text("Your phone approved this computer. Type the 6-digit code shown on your phone.");
      const form = document.createElement("form");
      form.className = "sign-in-code";
      const label = document.createElement("label");
      label.textContent = "6-digit code";
      const input = document.createElement("input");
      input.name = "code";
      input.inputMode = "numeric";
      input.autocomplete = "one-time-code";
      // Room for "123 456" or "123-456"; the digits are what count.
      input.maxLength = LINK_CODE_LENGTH + 3;
      input.required = true;
      label.append(input);
      this.field = input;
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "primary-action";
      submit.textContent = "Sign in";
      form.append(label, submit);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        this.complete(input.value);
      });
      this.host.append(form);
      this.countdown = this.host.text("");
      this.countdown.className = "sign-in-countdown";
      this.host.append(status);
      this.host.button("Cancel", () => this.cancel(), "secondary");
      this.tick();
      this.applyFocus(heading, input);
      this.schedulePoll();
      return;
    }
    this.host.text(SIGN_IN_STEPS);
    this.host.text("Then approve on your phone and type the 6-digit code it shows here. Only a phone where you're already signed in can approve.");
    const qr = document.createElement("kin-qr");
    qr.className = "sign-in-qr";
    qr.label = "QR code to sign in on this computer. Scan it with Kin on your phone.";
    qr.expiredMessage = "This sign-in code expired.";
    qr.code = "";
    qr.refresh = () => this.refresh();
    qr.value = this.link(request);
    qr.expiresAt = request.expiresAt;
    qr.addEventListener("kin-qr-expired", () => {
      if (this.request?.state === "pending") this.end("The sign-in code expired. Nothing was signed in.");
    });
    this.host.append(qr);
    this.countdown = this.host.text("");
    this.countdown.className = "sign-in-countdown";
    this.host.append(status);
    this.host.button("Cancel", () => this.cancel(), "secondary");
    this.tick();
    this.applyFocus(heading);
    this.schedulePoll();
  }

  /** The visible countdown, updated every second without announcing. */
  tick() {
    const update = () => {
      if (!this.request || !this.countdown) return this.stopTicker();
      this.countdown.textContent = this.request.state === "approved"
        ? `The code works for ${remaining(this.request.expiresAt)}`
        : `This code changes in ${remaining(this.request.expiresAt)}`;
    };
    update();
    this.ticker = setInterval(update, 1000);
  }

  stopTicker() {
    clearInterval(this.ticker);
    this.ticker = null;
  }

  /** Focus moves now, not on the next frame: a background window may not
   * paint frames, and the elements are already in place. */
  applyFocus(heading, field) {
    const target = this.focusNext === "code" ? field : this.focusNext === "heading" ? heading : null;
    this.focusNext = null;
    target?.focus();
  }
}
