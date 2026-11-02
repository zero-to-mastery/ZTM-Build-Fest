// "Notifications on this device" (#85, #90). Push subscriptions belong to a
// browser, so the switch is per device. The browser's permission prompt
// appears only after "Turn on" is pressed. A push says only that something is
// new: never what, who added it, or how many. Nothing about delivery or
// reading is recorded.
import { currentPlatform } from "../platform.js";

/** Mute choices; the service computes the end on its own clock. */
export const MUTE_CHOICES = Object.freeze([
  ["hour", "Mute for 1 hour"],
  ["night", "Mute for 8 hours"],
  ["indefinite", "Mute until I turn them back on"],
]);

const EXPLANATION = "Notifications go to other household members' opted-in, unmuted devices. Your own devices never receive notifications for changes you make. Notifications say only that something is new; Kin doesn't record delivery, reads, or presence.";

/** Local-only diagnostic copy. Endpoint hosts, URLs, keys and fingerprints
 * deliberately never enter this view. */
export function notificationDeviceChecks({ support, permission, status, now = Date.now(), formatDate = (value) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) }) {
  const permissionText = support === "unsupported" ? "Unavailable in this browser"
    : support === "ios-home-screen" ? "Available after adding Kin to the Home Screen"
    : permission === "granted" ? "Allowed"
    : permission === "denied" ? "Blocked in browser settings"
    : "Not allowed yet";
  const subscriptionText = !status ? "Could not check — check your connection and try again"
    : status.available === false ? "Unavailable on this Kin server"
    : status.subscribed ? "On for this device"
    : "Off for this device";
  let muteText = "Not applicable while notifications are off";
  if (status?.subscribed) {
    if (status.mutedIndefinitely) muteText = "Muted until you turn them back on";
    else if (status.mutedUntil && status.mutedUntil > now) muteText = `Muted until ${formatDate(status.mutedUntil)}`;
    else muteText = "Not muted";
  }
  return [
    ["Browser permission", permissionText],
    ["Kin subscription", subscriptionText],
    ["Mute", muteText],
  ];
}

/** What this browser can do, from plain values (testable without a DOM). */
export function notificationSupport({ hasServiceWorker, hasPushManager, hasNotification, permission, platform }) {
  if (platform?.ios && !platform.standalone) return "ios-home-screen";
  if (!hasServiceWorker || !hasPushManager || !hasNotification) return "unsupported";
  if (permission === "denied") return "blocked";
  return "available";
}

/** The base64url VAPID key as the bytes pushManager.subscribe wants. */
export function applicationServerKey(publicKey) {
  const base64 = publicKey.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (publicKey.length % 4)) % 4);
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

/** The service's short fingerprint of an endpoint (server/push-service.mjs). */
export async function endpointTag(endpoint) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 16);
}

/** Whether a browser subscription was made for these server key bytes. */
export function sameServerKey(subscription, key) {
  const current = subscription?.options?.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((byte, index) => byte === key[index]);
}

async function api(path, init = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.message || "Kin couldn't change notifications."), { code: value.error, status: response.status });
  return value;
}

export class KinNotifications extends HTMLElement {
  connectedCallback() {
    if (!this.firstElementChild) this.build();
  }

  build() {
    this.className = "notification-settings";
    this.setAttribute("role", "group");
    this.setAttribute("aria-labelledby", "notification-settings-heading");
    const heading = document.createElement("h2");
    heading.id = "notification-settings-heading";
    heading.textContent = "Notifications on this device";
    const explanation = document.createElement("p");
    explanation.className = "section-hint";
    explanation.textContent = EXPLANATION;
    this.state = document.createElement("p");
    this.state.className = "notification-state";
    this.checks = document.createElement("dl");
    this.checks.className = "notification-checks";
    this.checkValues = [];
    for (const label of ["Browser permission", "Kin subscription", "Mute"]) {
      const term = document.createElement("dt");
      term.textContent = label;
      const value = document.createElement("dd");
      this.checkValues.push(value);
      this.checks.append(term, value);
    }
    this.actions = document.createElement("div");
    this.actions.className = "appearance-actions";
    const testGuide = document.createElement("details");
    testGuide.className = "notification-test-guide";
    const testSummary = document.createElement("summary");
    testSummary.textContent = "Test with another household member";
    const testIntro = document.createElement("p");
    testIntro.textContent = "Kin doesn't have a manual send button. Test the real private flow with two distinct household members:";
    const steps = document.createElement("ol");
    for (const text of [
      "On the other member's device, open this page and turn notifications on. Make sure it is not muted.",
      "On this device, make a household change and let it sync.",
      'Wait up to two minutes for “Something new in Kin” on the other member\'s device.',
    ]) {
      const item = document.createElement("li");
      item.textContent = text;
      steps.append(item);
    }
    const testNote = document.createElement("p");
    testNote.textContent = "A second device linked to your own member identity is not a valid test: Kin never notifies you about your own changes. Kin also cannot confirm delivery or whether someone read a notification.";
    testGuide.append(testSummary, testIntro, steps, testNote);
    this.feedback = document.createElement("p");
    this.feedback.className = "appearance-feedback";
    this.feedback.setAttribute("role", "status");
    this.feedback.setAttribute("aria-live", "polite");
    this.error = document.createElement("p");
    this.error.className = "field-error";
    this.error.setAttribute("role", "alert");
    this.append(heading, explanation, this.state, this.checks, this.actions, testGuide, this.error, this.feedback);
    this.hidden = true;
  }

  support() {
    return notificationSupport({
      hasServiceWorker: "serviceWorker" in navigator,
      hasPushManager: typeof PushManager !== "undefined",
      hasNotification: typeof Notification !== "undefined",
      permission: typeof Notification !== "undefined" ? Notification.permission : "default",
      platform: currentPlatform(),
    });
  }

  /** Loads this device's state from the service. Hidden until this browser
   * is a trusted device of a household (the API refuses otherwise). */
  async refresh({ identity = true } = {}) {
    if (!this.firstElementChild) this.build();
    // A press in progress owns the state; refresh once it has finished.
    if (this.busy) { this.refreshPending = { identity }; return; }
    const generation = (this.generation = (this.generation ?? 0) + 1);
    const activeElement = typeof document === "undefined" ? null : document.activeElement;
    const restoreRetryFocus = activeElement?.dataset?.notificationAction === "retry" &&
      this.actions?.contains?.(activeElement);
    // Only a household device has anything to ask the service about.
    if (!identity) { this.hidden = true; return; }
    let status;
    try {
      status = await api("/api/push/subscription");
    } catch {
      if (generation === this.generation) {
        this.status = null;
        this.hidden = false;
        this.render();
        this.error.textContent = "Kin couldn't check notification settings for this device. Check your connection and try again.";
        if (restoreRetryFocus) this.actions.querySelector("button")?.focus();
      }
      return;
    }
    if (generation !== this.generation) return;
    this.status = status;
    this.hidden = false;
    this.render();
    if (restoreRetryFocus) {
      this.feedback.textContent = "Notification settings updated.";
      const focusTarget = this.actions.querySelector("button") ?? this.state;
      if (focusTarget === this.state) focusTarget.setAttribute("tabindex", "-1");
      focusTarget.focus();
    }
    // Kept so a press can wait for a repair's request to land first.
    const repair = this.repair(generation);
    (this.repairs ??= new Set()).add(repair);
    void repair.finally(() => this.repairs.delete(repair));
  }

  /** Keeps the service's copy in step with this browser's subscription,
   * without a prompt: a browser may replace its subscription while Kin is
   * closed (the service worker's own update can fail once the session has
   * expired). A subscription the browser no longer holds (site data cleared)
   * is never revived silently: the service forgets it and the section shows
   * Off, so turning notifications back on is always the person's choice. */
  async repair(generation) {
    const status = this.status;
    if (!status?.subscribed || this.support() !== "available" || Notification.permission !== "granted") return;
    // Any press (turn off, mute) or newer refresh supersedes this repair: it
    // re-checks before every step that changes something.
    const stale = () => generation !== this.generation || this.busy;
    try {
      const registration = await navigator.serviceWorker.ready;
      const { publicKey } = await api("/api/push/vapid-public-key");
      if (stale()) return;
      const key = applicationServerKey(publicKey);
      let subscription = await registration.pushManager.getSubscription();
      if (stale()) return;
      if (!subscription) {
        const updated = await api("/api/push/subscription", { method: "DELETE", body: "{}" });
        if (!stale()) { this.status = updated; this.render(); }
        return;
      }
      // A subscription made for other server keys would only be refused,
      // even when the service holds the same endpoint. The browser still
      // holds one, so the person's "on" stands: replace it.
      if (!sameServerKey(subscription, key)) {
        // Once the old one is gone this runs to the end, even if a press
        // lands meanwhile: presses wait for repairs, so a mute or turn-off
        // then applies to the replacement rather than to nothing.
        await subscription.unsubscribe();
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      } else if ((await endpointTag(subscription.endpoint)) === status.endpointTag || stale()) return;
      const { endpoint, keys } = subscription.toJSON();
      const updated = await api("/api/push/subscription", { method: "PUT", body: JSON.stringify({ endpoint, keys }) });
      if (!stale()) { this.status = updated; this.render(); }
    } catch {
      // Left as it is; the next refresh tries again.
    }
  }

  render() {
    const support = this.support();
    const status = this.status;
    this.actions.replaceChildren();
    this.error.textContent = "";
    const permission = typeof Notification === "undefined" ? "unavailable" : Notification.permission;
    const checks = notificationDeviceChecks({ support, permission, status });
    checks.forEach(([, value], index) => { if (this.checkValues?.[index]) this.checkValues[index].textContent = value; });
    const messages = {
      unsupported: "This browser can't show Kin notifications.",
      "ios-home-screen": "Add Kin to your Home Screen to get notifications. On iPhone and iPad, only the Home Screen app can receive them.",
      blocked: "Notifications are blocked for Kin in this browser's settings. Allow notifications for this site there, then come back to turn them on.",
    };
    if (!status) {
      this.state.textContent = "Kin couldn't check notification settings for this device. Check your connection and try again.";
      const retry = this.button("Try again", () => this.refresh());
      retry.dataset.notificationAction = "retry";
      this.actions.append(retry);
      return;
    }
    if (status.available === false) {
      this.state.textContent = "Notifications aren't set up on this Kin server yet. Ask the person who runs this server to configure them.";
      return;
    }
    if (support !== "available" && !status.subscribed) {
      this.state.textContent = messages[support];
      return;
    }
    if (!status.subscribed) {
      this.state.textContent = "Off.";
      this.actions.append(this.button("Turn on notifications", () => this.turnOn(), "primary-action"));
      return;
    }
    // A timed mute that has ended shows as On, and the page re-renders when
    // it ends rather than leaving "Muted until" on screen.
    clearTimeout(this.unmuteTimer);
    const remaining = status.mutedUntil ? status.mutedUntil - Date.now() : 0;
    if (remaining > 0 && remaining < 2 ** 31 - 1) this.unmuteTimer = setTimeout(function ended() {
      if (!this.isConnected) return;
      if (this.busy) this.unmuteTimer = setTimeout(ended.bind(this), 1000);
      else this.render();
    }.bind(this), remaining + 500);
    const muted = status.mutedIndefinitely || remaining > 0;
    this.state.textContent = !muted ? "On."
      : status.mutedIndefinitely ? "Muted until you turn them back on."
      : `Muted until ${new Date(status.mutedUntil).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.`;
    // Separate buttons, not a select: each choice is one deliberate press.
    if (muted) this.actions.append(this.button("Unmute", () => this.mute(null)));
    else for (const [choice, text] of MUTE_CHOICES) this.actions.append(this.button(text, () => this.mute(choice)));
    this.actions.append(this.button("Turn off notifications", () => this.turnOff()));
  }

  button(text, action, className = "") {
    const value = document.createElement("button");
    value.type = "button";
    value.textContent = text;
    value.className = className;
    value.addEventListener("click", () => void this.run(action));
    return value;
  }

  async run(action) {
    if (this.busy) return;
    this.busy = true;
    // Supersedes any refresh or repair still in flight, and lets a repair's
    // request in flight land first so this press's request comes after it.
    this.generation = (this.generation ?? 0) + 1;
    for (const control of this.querySelectorAll("button")) control.disabled = true;
    this.error.textContent = "";
    try {
      // Awaited only while one is running: "Turn on" must reach the
      // permission prompt without an await, or some browsers drop the press.
      if (this.repairs?.size) await Promise.allSettled([...this.repairs]);
      await action();
    } catch (error) {
      this.render();
      this.error.textContent = error.message || "Kin couldn't change notifications.";
    } finally {
      this.busy = false;
      // Anything started during the press is discarded.
      this.generation += 1;
      for (const control of this.querySelectorAll("button")) control.disabled = false;
      const pending = this.refreshPending;
      this.refreshPending = null;
      if (pending) void this.refresh(pending);
    }
  }

  async turnOn() {
    // The permission prompt comes only from this press.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      this.render();
      this.error.textContent = permission === "denied"
        ? "Notifications are blocked for Kin in this browser's settings. Allow them for this site, then try again."
        : "Notifications stay off. Press Turn on again when you're ready.";
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const { publicKey } = await api("/api/push/vapid-public-key");
    const key = applicationServerKey(publicKey);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !sameServerKey(subscription, key)) { await subscription.unsubscribe(); subscription = null; }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const { endpoint, keys } = subscription.toJSON();
    try {
      this.status = await api("/api/push/subscription", { method: "PUT", body: JSON.stringify({ endpoint, keys }) });
    } catch (error) {
      // The service refused it: don't leave a browser subscription behind.
      await subscription.unsubscribe().catch(() => {});
      throw error;
    }
    this.render();
    this.feedback.textContent = "Notifications are on for this device.";
  }

  async turnOff() {
    const registration = await navigator.serviceWorker?.ready;
    await (await registration?.pushManager.getSubscription())?.unsubscribe();
    this.status = await api("/api/push/subscription", { method: "DELETE", body: "{}" });
    this.render();
    this.feedback.textContent = "Notifications are off for this device.";
    this.querySelector("button")?.focus();
  }

  async mute(choice) {
    this.status = await api("/api/push/mute", { method: "PUT", body: JSON.stringify({ choice }) });
    this.render();
    this.feedback.textContent = choice === null ? "Notifications are back on." : this.state.textContent;
    this.querySelector("button")?.focus();
  }
}

customElements.define("kin-notifications", KinNotifications);
