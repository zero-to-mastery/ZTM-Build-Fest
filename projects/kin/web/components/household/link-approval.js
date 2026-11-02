// Signing in on a computer with a phone (#98): the phone's side (#101).
//
// People & devices → Add a computer opens Kin's scanner. It accepts only a
// computer's sign-in link for this Kin (/link#r=…&s=…&f=…). The phone then
// shows what it is about to approve: the computer's automatic name, that it
// will be signed in as you, and the warning to approve only a computer in
// front of you. Approve runs a fresh passkey ceremony; for a new computer the
// phone signs its device certificate with its own device key (the existing
// certificate path) and pins the computer's key, which the camera read from
// the computer's own screen. The phone picks the 6-digit code at random and
// sends it with a tag binding its own device and key to the request, keyed by
// the code and the QR code's nonce, which the service never sees
// (web/device-link.js). It shows the code to type on the computer; with the
// right code the computer receives the tag, checks it, and pins this phone's
// key. "Done" follows once the computer has finished. A sync follows, so
// the phone provisions the household's keys for the new device
// (recipient-bound, as for any device an Adult adds).
//
// Only reachable while Kin is unlocked: this part lives in the household
// panel, which locking removes, and the scanner stops its camera when it
// goes. Leaving, cancelling or locking ends the request with the service.
//
// Part of <kin-household>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-household.js lists them).
import { createDeviceAuthorizationCertificate, deviceKeyFingerprint } from "../../sync/crypto.js";
import { linkTag, newLinkCode, signInRequest } from "../../device-link.js";
import { invitationCode } from "../../pairing-link.js";
import { freshConfirmation } from "./fresh-confirmation.js";
import { SIGN_IN_TTL_MS } from "./link.js";

export const APPROVE_WARNING = "Only approve a computer that's in front of you.";
/** How often the phone checks whether the computer has finished. */
export const APPROVAL_POLL_MS = 2_000;

const NOT_SIGN_IN = "That isn't a computer's sign-in code. On the computer, choose Sign in with your phone, then scan the code it shows.";
const INVITATION = "That's a household invitation, not a computer's sign-in code. Scan the code on the computer you're signing in.";
const NO_TYPING = "Signing in a computer needs its QR code. If your camera can't read it, sign in on the computer with your passkey, or add it with Add my device.";

function remaining(expiresAt) {
  const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export class HouseholdLinkApproval {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
    /** null while closed; otherwise { step: "scan" | "review" | "code" |
     * "done" | "ended", scanned, view, code, expiresAt, notice }. */
    this.flow = null;
    this.ticker = null;
    this.poller = null;
    this.status = null;
    this.focusNext = null;
  }

  get open() {
    return Boolean(this.flow);
  }

  /** Add a computer: opens the scanner. */
  start() {
    this.stop();
    this.flow = { step: "scan", notice: "" };
    this.focusNext = "heading";
    this.host.render();
  }

  /** Back to People & devices, ending any request still open. */
  close() {
    this.release();
    this.stop();
    this.flow = null;
    this.host.render();
  }

  /** Kin locked or the panel went away. */
  abandon() {
    this.release();
    this.stop();
    this.flow = null;
  }

  stop() {
    clearInterval(this.ticker);
    clearTimeout(this.poller);
    this.ticker = null;
    this.poller = null;
  }

  /** Ends the scanned request with the service while it can still be used. */
  release(scanned = this.flow?.scanned) {
    if (!scanned || ["done", "ended"].includes(this.flow?.step)) return Promise.resolve();
    return fetch(`/api/link/requests/${scanned.requestId}`, {
      method: "DELETE",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: scanned.secret }),
    }).catch(() => {});
  }

  /** Back to the scanner with a notice. */
  rescan(notice) {
    this.flow = { step: "scan", notice };
    this.focusNext = "heading";
    this.host.render();
  }

  /** The scanner read a Kin link. */
  async scanned(url) {
    const request = signInRequest(url, location.origin);
    if (!request) return this.rescan(invitationCode(url) ? INVITATION : NOT_SIGN_IN);
    if (this.host.busy) return this.rescan("Kin was still finishing something else. Scan the code again.");
    await this.host.run(async () => {
      let started;
      try {
        started = await this.options(request);
      } catch (error) {
        // A refusal about the request ends it; anything else (the network,
        // say) leaves it for another try.
        if (/^link_|^rate_limited$/.test(error?.code ?? "")) return this.end(this.explain(error), request);
        return this.rescan(error?.message ? `${error.message} Scan the code again.` : "Kin couldn't reach the service. Scan the code again.");
      }
      const view = started.request;
      // Defense in depth: approve only for this phone's own member.
      if (view?.householdId !== this.host.identity.householdId || view?.memberId !== this.host.identity.memberId)
        return this.end("Kin couldn't confirm who this computer would sign in as. It was not approved.", request);
      this.flow = { step: "review", scanned: request, view, notice: "" };
      this.focusNext = "heading";
      this.host.render();
    });
  }

  options(request) {
    return this.host.api(`/api/link/requests/${request.requestId}/approve/options`, {
      method: "POST",
      body: JSON.stringify({ secret: request.secret, fingerprint: request.fingerprint }),
    });
  }

  /** Words for a refusal the person can act on. */
  explain(error) {
    if (error?.code === "link_unavailable")
      return "That sign-in code has expired or was already used. On the computer, show a new code and scan it again.";
    return error?.message || "Kin couldn't approve that computer.";
  }

  /** Approve: a fresh passkey, then the certificate, then the code. */
  async approve() {
    const flow = this.flow;
    if (flow?.step !== "review") return;
    await this.host.run(async () => {
      const { scanned } = flow;
      let approved;
      let view;
      let code;
      let tag;
      try {
        // A fresh challenge: the review screen may have waited a while.
        const started = await this.options(scanned);
        view = started.request;
        if (view?.householdId !== this.host.identity.householdId || view?.memberId !== this.host.identity.memberId)
          throw new Error("Kin couldn't confirm who this computer would sign in as. It was not approved.");
        // Every check that could refuse runs before the passkey prompt.
        await this.ctx.api.openSyncKeyStore();
        const own = await this.host.syncKeyStore.getDevice(this.host.identity.deviceId);
        // Mid key change, the service may still hold this device's earlier
        // key, and the computer would check the tag against that one.
        if (own?.pendingTransition)
          throw new Error("This device is finishing a key update. Wait for it to sync, then try again. The computer was not approved.");
        const issuerFingerprint = await deviceKeyFingerprint(own.publicKeys);
        if (issuerFingerprint !== this.host.localFingerprint)
          throw new Error("This device's local sync key changed. The computer was not approved.");
        code = newLinkCode();
        tag = await linkTag({
          nonce: scanned.nonce, code, requestId: scanned.requestId,
          approverDeviceId: this.host.identity.deviceId, approverFingerprint: issuerFingerprint,
          computerFingerprint: scanned.fingerprint,
        });
        // The keys must be the ones the camera saw on the computer.
        if (!view.existingDevice && (await deviceKeyFingerprint(view.syncPublicKeys)) !== scanned.fingerprint)
          throw new Error("The computer's key doesn't match the code you scanned. The computer was not approved.");
        const proof = await freshConfirmation(started, { signal: this.host.connectionAbort.signal });
        let deviceCertificate;
        if (!view.existingDevice) {
          deviceCertificate = await createDeviceAuthorizationCertificate({
            householdId: view.householdId,
            memberId: view.memberId,
            deviceId: view.deviceId,
            issuerDeviceId: this.host.identity.deviceId,
            issuerFingerprint,
            publicKeys: view.syncPublicKeys,
            signingKey: own.keys.signingPrivateKey,
          });
        }
        approved = await this.host.api(`/api/link/requests/${scanned.requestId}/approve/finish`, {
          method: "POST",
          body: JSON.stringify({
            flow: started.flow,
            ...proof,
            secret: scanned.secret,
            fingerprint: scanned.fingerprint,
            deviceCertificate,
            code,
            tag,
          }),
        });
      } catch (error) {
        if (this.flow !== flow) return;
        if (["NotAllowedError", "AbortError"].includes(error?.name)) {
          // The passkey prompt was dismissed: the request is still open.
          flow.notice = "The passkey was unavailable or the request was cancelled. The computer was not approved.";
          this.host.render();
          return;
        }
        return this.end(this.explain(error), scanned);
      }
      if (this.flow !== flow) return;
      if (!view.existingDevice) {
        // Pin the key the camera read, so sync trusts nothing else for it.
        // If that fails, end the request rather than leave it approved with
        // no code on screen.
        try {
          await this.host.syncKeyStore.pinTrustedDevice({
            householdId: view.householdId,
            memberId: view.memberId,
            deviceId: view.deviceId,
            publicKeys: view.syncPublicKeys,
            fingerprint: view.syncKeyFingerprint,
          });
        } catch {
          return this.end("Kin couldn't save the computer's key on this phone, so the sign-in was cancelled. Nothing was signed in.", scanned);
        }
      }
      // Counted on this phone's clock (the service's may differ), as on the computer.
      this.flow = { step: "code", scanned, view, code, expiresAt: Date.now() + SIGN_IN_TTL_MS, notice: "" };
      this.focusNext = "heading";
      this.host.render();
    });
  }

  /** Cancel on the review or code step: ends the request. */
  cancel() {
    this.close();
  }

  end(notice, scanned = this.flow?.scanned) {
    this.release(scanned);
    this.stop();
    this.flow = { step: "ended", notice };
    this.focusNext = "heading";
    this.host.render();
  }

  schedulePoll() {
    clearTimeout(this.poller);
    this.poller = setTimeout(() => this.poll(), APPROVAL_POLL_MS);
  }

  /** While the code is shown: has the computer finished? */
  async poll() {
    const flow = this.flow;
    if (flow?.step !== "code") return;
    let status;
    try {
      status = await this.host.api(`/api/link/requests/${flow.scanned.requestId}/status`, {
        method: "POST",
        body: JSON.stringify({ secret: flow.scanned.secret }),
      });
    } catch (error) {
      if (this.flow !== flow) return;
      if (error.code === "link_unavailable") return this.end("The sign-in ended before the computer finished. Nothing was signed in.");
      return this.schedulePoll();
    }
    if (this.flow !== flow) return;
    if (status.state === "done") {
      this.stop();
      this.flow = { step: "done", view: flow.view, notice: "" };
      this.focusNext = "heading";
      this.host.render();
      // Provision the household's keys for the new device.
      this.ctx.api.requestSync();
      return;
    }
    if (status.state === "ended") return this.end("The sign-in ended before the computer finished. Nothing was signed in.");
    this.schedulePoll();
  }

  heading(text) {
    const heading = document.createElement("h3");
    heading.className = "link-approval-heading";
    heading.tabIndex = -1;
    heading.textContent = text;
    this.host.append(heading);
    return heading;
  }

  render() {
    clearInterval(this.ticker);
    this.ticker = null;
    const flow = this.flow;
    const status = document.createElement("p");
    status.className = "link-approval-status";
    status.setAttribute("role", "status");
    this.status = status;
    let heading;
    if (flow.step === "scan") {
      heading = this.heading("Add a computer");
      this.host.text("On the computer, open Kin and choose Sign in with your phone. Then scan the code it shows.");
      status.textContent = flow.notice;
      this.host.append(status);
      const scanner = document.createElement("kin-qr-scanner");
      scanner.className = "link-approval-scanner";
      scanner.addEventListener("kin-qr-scan", (event) => this.scanned(event.detail.url));
      scanner.addEventListener("kin-qr-manual", () => {
        this.flow = { step: "scan", notice: NO_TYPING };
        this.focusNext = "heading";
        this.host.render();
      });
      scanner.addEventListener("kin-qr-cancel", () => this.close());
      this.host.append(scanner);
      this.host.button("Back", () => this.close(), "secondary");
    } else if (flow.step === "review") {
      const { view } = flow;
      heading = this.heading("Approve this computer?");
      const name = document.createElement("p");
      name.className = "link-approval-device";
      name.textContent = view.deviceLabel || "A computer";
      this.host.append(name);
      this.host.text(view.existingDevice
        ? "It will be signed in as you. It's already one of your devices, so it keeps its place in your devices."
        : "It will be signed in as you and become one of your devices, with the household's history.");
      const warning = document.createElement("p");
      warning.className = "link-approval-warning";
      const strong = document.createElement("strong");
      strong.textContent = APPROVE_WARNING;
      warning.append(strong);
      this.host.append(warning);
      status.textContent = flow.notice;
      this.host.append(status);
      const actions = document.createElement("div");
      actions.className = "pairing-actions";
      actions.append(
        this.host.makeButton("Approve with passkey", () => this.approve(), "primary-action"),
        this.host.makeButton("Cancel", () => this.cancel(), "secondary"),
      );
      this.host.append(actions);
    } else if (flow.step === "code") {
      heading = this.heading("Type this code on the computer");
      // Not a live region: the digits are shown, and read out one by one.
      const code = document.createElement("p");
      code.className = "link-approval-code";
      const digits = document.createElement("span");
      digits.setAttribute("aria-hidden", "true");
      digits.textContent = flow.code;
      const spoken = document.createElement("span");
      spoken.className = "visually-hidden";
      spoken.textContent = `Code ${[...flow.code].join(" ")}`;
      code.append(digits, spoken);
      this.host.append(code);
      this.host.text(`Only type it on ${flow.view.deviceLabel ? `“${flow.view.deviceLabel}”` : "the computer"}, the one in front of you.`);
      const countdown = document.createElement("p");
      countdown.className = "link-approval-countdown";
      this.host.append(countdown, status);
      const update = () => {
        if (this.flow !== flow) return clearInterval(this.ticker);
        countdown.textContent = `The code works for ${remaining(flow.expiresAt)}`;
      };
      update();
      this.ticker = setInterval(update, 1000);
      this.host.button("Cancel", () => this.cancel(), "secondary");
      this.schedulePoll();
    } else if (flow.step === "done") {
      heading = this.heading("The computer is signed in");
      this.host.text(`${flow.view?.deviceLabel || "The computer"} is signed in as you. It appears in your trusted devices.`);
      this.host.append(status);
      this.host.button("Done", () => this.close(), "primary-action");
    } else {
      heading = this.heading("Add a computer");
      this.host.text(flow.notice);
      this.host.append(status);
      this.host.button("Scan again", () => this.start());
      this.host.button("Done", () => this.close(), "secondary");
    }
    const target = this.focusNext === "heading" ? heading : null;
    this.focusNext = null;
    // Now, not on the next frame: a background window may not paint frames.
    target?.focus();
  }
}
