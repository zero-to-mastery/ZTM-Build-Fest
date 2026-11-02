// Busy state, status and alert messages, onboarding prompts and app-update notices.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { passkeyUnlockSupported } from "../../security/passkey-unlock.js";
import {
  ACCOUNT_MIGRATE_OFFER_DISMISSED_KEY,
  ACCOUNT_PASSKEY_OFFER_DISMISSED_KEY,
  BACKUP_CODE_OFFER_DISMISSED_KEY,
  accountOffer,
  dismissOffer,
  dismissOfferAt,
  dismissPasskeySuggestion,
  migrationOffer,
  offerDismissed,
  offerDismissedAt,
  passkeyOffer,
  passkeySuggestionDismissed,
} from "../../security/backup-key-entry.js";
import { accountState } from "../../security/account-security.js";
import { recordDiagnostic } from "../../diagnostics/ring-buffer.js";

export class StatusController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  setBusy(isBusy) {
    this.app.busy = isBusy;
    if (!this.app.isConnected) return;
    this.ctx.render.updateCalendarExportButton();
    this.app.main.setAttribute("aria-busy", String(isBusy));
    const controlsDisabled = isBusy || !this.app.store;
    if (isBusy) {
      this.app.detail?.deferFocusedControl?.();
      this.app.chat?.deferFocusedControl?.();
      this.app.meals?.deferFocusedControl?.();
      this.app.simpleToday?.deferFocusedControl?.();
    }
    this.app.controlFieldset.disabled = controlsDisabled;
    // Header controls and a phone detail sheet live outside the fieldset.
    this.app.quickAdd.disabled = isBusy || !this.app.store;
    if (this.app.detail?.closest(".detail-sheet")) this.app.detail.disabled = controlsDisabled;
    if (this.app.lockButton) this.app.lockButton.disabled = isBusy;
    if (this.app.shoppingMode) this.app.shoppingMode.disabled = controlsDisabled;
    if (this.app.calendar) this.app.calendar.disabled = controlsDisabled;
    else if (this.app.week) this.app.week.disabled = controlsDisabled;
    if (this.app.choreChart) this.app.choreChart.disabled = controlsDisabled;
    if (this.app.sitterEditor) this.app.sitterEditor.disabled = controlsDisabled;
    this.app.albumView?.update?.({ disabled: controlsDisabled });
    this.app.retryButton.disabled = isBusy;
    if (!controlsDisabled) {
      for (const component of [this.app.today, this.app.needs, this.app.shopping, this.app.staples, this.app.areas, this.app.notes, this.app.detail, this.app.chat, this.app.meals, this.app.simpleToday])
        component?.settleDeferredFocus?.();
    }
  }
  setStatus(message) {
    this.app.status.textContent = message;
    clearTimeout(this.app.statusTimer);
    this.app.status.removeAttribute("data-stale");
    if (message) this.app.statusTimer = setTimeout(() => this.app.status.setAttribute("data-stale", "true"), 6_000);
    this.ctx.undo?.syncStatus();
  }
  clearAlert() {
    this.app.feedback?.classList.remove("app-feedback-inline");
    this.app.alert.textContent = "";
    this.app.alert.hidden = true;
    this.app.retryButton.hidden = true;
    if (this.app.reportButton) this.app.reportButton.hidden = true;
    this.app.retryAction = null;
    this.app.retryIntent = null;
    this.app.suspendedRetry = null;
  }
  showAlert(message, retryAction = null, retryIntent = null) {
    if (!this.app.vault || this.app.vault.locked) return;
    this.app.alert.textContent = message;
    this.app.alert.hidden = false;
    this.app.retryAction = retryAction;
    this.app.retryIntent = retryIntent;
    this.app.retryButton.hidden = typeof retryAction !== "function";
    // Every error message offers a report (ADR 0021 §3); the buffer notes
    // that one was shown, never its words.
    if (this.app.reportButton) this.app.reportButton.hidden = false;
    recordDiagnostic("alert_shown");
  }
  showUpdateNotice() {
    if (this.app.updateNotice) this.app.updateNotice.hidden = false;
  }
  // The onboarding card on Today explains the next step until the device has a
  // household and a passkey; every action it offers is the ordinary flow.
  hasHouseholdContent() {
    const state = this.app.state;
    return Boolean(state && [
      "items", "handoffs", "talks", "pulses", "routines", "areas", "notes",
      "playbooks", "referenceRecords", "maintenanceEvents",
    ].some((field) => state[field]?.length));
  }
  updateOnboardingDensity() {
    // The first useful thing added: a password account's passkey card
    // (#562) can show now, so the card is drawn again, once.
    const content = this.hasHouseholdContent();
    const firstContent = content && this.contentSeen === false;
    this.contentSeen = content;
    if (firstContent && this.app.accountSecurity?.password && !this.app.onboarding?.dataset.firstRun) {
      this.renderOnboarding();
      return;
    }
    const card = this.app.onboarding;
    const details = card?.querySelector(".onboarding-details");
    if (!details) return;
    const compact = this.hasHouseholdContent();
    const previous = details.dataset.compact;
    if (previous !== String(compact)) details.open = !compact;
    details.dataset.compact = String(compact);
    card.classList.toggle("onboarding-compact", compact);
    const page = this.app.pages?.get("today");
    page?.classList.toggle("compact-onboarding", compact);
    if (page && this.app.today?.parentElement === page) {
      if (compact && this.app.today.nextElementSibling !== card) this.app.today.after(card);
      else if (!compact && this.app.today.previousElementSibling !== card) this.app.today.before(card);
    }
  }
  renderOnboarding() {
    const card = this.app.onboarding;
    if (!card || !this.app.vault || this.app.vault.locked) return;
    card.replaceChildren();
    delete card.dataset.passkeyOffer;
    delete card.dataset.accountOffer;
    delete card.dataset.firstRun;
    card.classList.remove("onboarding-compact");
    const todayPage = this.app.pages?.get("today");
    todayPage?.classList.remove("compact-onboarding");
    if (todayPage && this.app.today?.parentElement === todayPage) this.app.today.before(card);
    const status = this.app.householdStatus;
    const passkeys = this.app.security?.passkeyWrappers?.length ?? 0;
    const heading = document.createElement("h2");
    const goTo = (intent) => {
      this.ctx.navigation.navigate("#household/people");
      this.app.household?.startIntent?.(intent);
    };
    // The first run signing up with the service (#557): one calm line, or
    // what went wrong with a way to fix it and try again.
    if (this.app.firstRun) return this.renderFirstRun(card, heading);
    if (status?.lifecycle === "moved" || status?.lifecycle === "moving") return this.renderMoved(card, heading, status);
    if (status && !status.identity && !status.claimState && status.lifecycle !== "deleted" && status.lifecycle !== "deletion_pending") {
      const details = document.createElement("details");
      details.className = "onboarding-details";
      const summary = document.createElement("summary");
      summary.textContent = "Join or set up your household";
      heading.textContent = "Get started";
      const intro = document.createElement("p");
      intro.textContent = "Kin is ready on this device. Join your family\u0027s existing household, or start a new one if nobody has set it up yet.";
      const choices = document.createElement("div");
      choices.className = "household-choices";
      for (const [label, intent, className] of [
        ["Start a new household", "create", "primary-action"],
        ["Join my household", "join", ""],
        ["Add my device", "device", ""],
        ["Sign in using my phone", "phone", ""],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        if (className) button.className = className;
        button.addEventListener("click", () => goTo(intent));
        choices.append(button);
      }
      const note = document.createElement("p");
      note.className = "section-hint";
      note.textContent = "You can keep using Kin on this device meanwhile; everything stays encrypted here.";
      details.append(summary, heading, intro, choices, note);
      card.append(details);
      card.hidden = false;
      this.updateOnboardingDensity();
      return;
    }
    if (status?.claimState === "Claimed" || status?.claimState === "Confirmed") {
      heading.textContent = status.claimState === "Confirmed" ? "Almost there" : "Waiting for approval";
      const intro = document.createElement("p");
      intro.textContent = status.claimState === "Confirmed"
        ? "Your device was approved. Open Household → People & devices to compare the device key and finish activating this device."
        : "This device needs approval from an existing household member. Keep Kin open on both devices and compare the device keys together.";
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "Open People & devices";
      open.addEventListener("click", () => { this.ctx.navigation.navigate("#household/people"); this.app.household?.scrollIntoView?.({ block: "start" }); });
      card.append(heading, intro, open);
      card.hidden = false;
      return;
    }
    // Passkey unlock, offered once it can work: the device is signed in to a
    // household (enrolment asks the identity service) and online. Right after
    // setup it is setup's next step (#577); after a backup-key unlock it is a
    // one-time suggestion this device remembers dismissing (#579).
    // A member who signed up with a password has no passkey yet for
    // passkey unlock to use; adding one is a later step (ADR 0018).
    const passwordAccount = (this.app.security?.manifest?.wrappers ?? []).some((wrapper) => wrapper.type === "password");
    const offer = !passwordAccount && passkeyOffer({
      identity: Boolean(status?.identity),
      passkeys,
      supported: passkeyUnlockSupported(),
      online: !this.app.offline && navigator.onLine !== false,
      justSetUp: Boolean(this.app.security?.justSetUp),
      sessionDismissed: Boolean(this.app.passkeyPromptDismissed),
      suggestionDismissed: passkeySuggestionDismissed(),
    });
    if (offer) {
      card.dataset.passkeyOffer = offer;
      heading.textContent = offer === "setup"
        ? "Unlock with your face, fingerprint or screen lock next time?"
        : "Skip the backup key next time?";
      const intro = document.createElement("p");
      intro.textContent = offer === "setup"
        ? "Kin can use a passkey on this device instead of the long backup key. The backup key still works if you need it."
        : "Turn on passkey unlock so your face, fingerprint or screen lock opens Kin on this device. Your backup key still works if you need it.";
      const turnOn = document.createElement("button");
      turnOn.type = "button";
      turnOn.className = "primary-action";
      turnOn.textContent = offer === "setup" ? "Turn on" : "Turn on passkey unlock";
      turnOn.addEventListener("click", async () => {
        turnOn.disabled = true;
        try {
          await this.app.security.run(() => this.app.security.addPasskey());
          if (this.app.security.alert.textContent) {
            // Never a dead end: say what happened and carry on without it.
            this.app.passkeyPromptDismissed = true;
            this.showAlert(`Passkey unlock didn't turn on. ${this.app.security.alert.textContent} You can try again under More → Security.`);
          } else this.ctx.status.setStatus("Passkey unlock is on for this device.");
        } finally { this.renderOnboarding(); }
      });
      const later = document.createElement("button");
      later.type = "button";
      later.textContent = "Not now";
      later.addEventListener("click", () => {
        this.app.passkeyPromptDismissed = true;
        if (offer === "suggestion") dismissPasskeySuggestion();
        this.renderOnboarding();
      });
      card.append(heading, intro, turnOn, later);
      card.hidden = false;
      return;
    }
    // A password account's calm offers (#562/#573): add a passkey after the
    // first useful action, a backup code after the first week. Each is one
    // dismissible card and opens its step under Security.
    if (status?.identity && this.renderAccountOffer(card, heading)) return;
    // The connection and optional passkey prompts take priority. Once a new
    // household is ready, offer one real first action rather than a tutorial.
    // No sample household events or persisted activity-tracking flag is added.
    if (status?.identity && this.app.state && !this.hasHouseholdContent() && !this.app.firstActionWelcomeDismissed) {
      heading.textContent = "Welcome home";
      const intro = document.createElement("p");
      intro.textContent = "Kin helps your household keep track of tasks, shopping, and things to share. Start by adding one thing you'd like to remember.";
      const start = document.createElement("button");
      start.type = "button";
      start.className = "primary-action";
      start.textContent = "Add something";
      start.addEventListener("click", () => this.app.compose?.input?.focus());
      const later = document.createElement("button");
      later.type = "button";
      later.textContent = "Not now";
      later.addEventListener("click", () => {
        this.app.firstActionWelcomeDismissed = true;
        this.renderOnboarding();
      });
      card.append(heading, intro, start, later);
      card.hidden = false;
      return;
    }
    card.hidden = true;
  }

  /** The household moved, or is moving, to a home server (ADR 0026,
   * #737): where to go, in plain words; details in the household panel. */
  renderMoved(card, heading, status) {
    const moved = status.lifecycle === "moved";
    heading.textContent = moved ? "Your household moved" : "Your household is moving";
    const intro = document.createElement("p");
    intro.setAttribute("role", "status");
    intro.textContent = moved
      ? `It's at ${status.movedTo} now. Open it there and sign in with your username and password, or your backup code; then add a passkey there.`
      : `It's moving to ${status.movedTo}. Changes wait until it's done; this takes a few minutes.`;
    card.append(heading, intro);
    if (!moved || !status.movedTo) return;
    const actions = document.createElement("p");
    actions.className = "onboarding-actions";
    const open = Object.assign(document.createElement("a"), { href: status.movedTo, className: "primary-action move-open", textContent: `Open ${status.movedTo}`, rel: "noopener" });
    const more = Object.assign(document.createElement("a"), { href: "#household/people", className: "link-button", textContent: "More about the move" });
    actions.append(open, more);
    card.append(actions);
  }
  /** Today's account card, if one is due; false when none is shown. The
   * account summary loads once per unlock (security/account.js refresh,
   * which renders this again when it arrives). */
  renderAccountOffer(card, heading) {
    const account = this.app.security?.account;
    const security = this.app.accountSecurity;
    const state = security ? accountState(security) : null;
    // Loaded once per unlock; again (at most every 10 seconds) while a
    // password member's vault isn't there yet (the first run makes it).
    const stale = !security || (security.password && !security.vault);
    if (stale && account && !account.loading && Date.now() - (this.accountAttemptedAt ?? 0) > 10_000) {
      this.accountAttemptedAt = Date.now();
      void account.refresh({ render: false });
    }
    if (!security) return false;
    if (this.renderMigrationOffer(card, heading, account)) return true;
    const offer = accountOffer({
      state,
      supported: passkeyUnlockSupported(),
      online: !this.app.offline && navigator.onLine !== false,
      hasContent: this.hasHouseholdContent(),
      sessionDismissed: Boolean(this.app.accountOfferDismissed),
      dismissed: { passkey: offerDismissed(ACCOUNT_PASSKEY_OFFER_DISMISSED_KEY), backupCode: offerDismissed(BACKUP_CODE_OFFER_DISMISSED_KEY) },
    });
    if (!offer) return false;
    card.dataset.accountOffer = offer;
    heading.textContent = offer === "account-passkey" ? "Sign in with your face or fingerprint?" : "Save a backup code?";
    const intro = document.createElement("p");
    intro.textContent = offer === "account-passkey"
      ? "Add a passkey and your face, fingerprint or screen lock signs you in, on this device and on a new one. It also keeps your account safer: your password alone no longer opens it on a new device."
      : "A backup code gets you back into Kin if you ever lose your password or passkey. Print it or write it down; it takes a minute.";
    const go = document.createElement("button");
    go.type = "button";
    go.className = "primary-action";
    go.textContent = offer === "account-passkey" ? "Add a passkey" : "Make a backup code";
    go.addEventListener("click", () => {
      this.ctx.navigation.navigate("#household/privacy");
      void this.app.security?.account?.start(offer === "account-passkey" ? "add-passkey" : "backup-code");
    });
    const later = document.createElement("button");
    later.type = "button";
    later.textContent = "Not now";
    later.addEventListener("click", () => {
      this.app.accountOfferDismissed = true;
      dismissOffer(offer === "account-passkey" ? ACCOUNT_PASSKEY_OFFER_DISMISSED_KEY : BACKUP_CODE_OFFER_DISMISSED_KEY);
      this.renderOnboarding();
    });
    card.append(heading, intro, go, later);
    card.hidden = false;
    return true;
  }

  /** The calm invitation to move to an account (#575), or to finish the
   * move on this device; false when none is due. "Set up" opens the step
   * under Security; "Not now" puts it away for a week. */
  renderMigrationOffer(card, heading, account) {
    const offer = migrationOffer({
      migration: account?.migration?.() ?? null,
      online: !this.app.offline && navigator.onLine !== false,
      sessionDismissed: Boolean(this.app.migrationOfferDismissed),
      dismissedAt: offerDismissedAt(ACCOUNT_MIGRATE_OFFER_DISMISSED_KEY),
    });
    if (!offer) return false;
    card.dataset.accountOffer = offer;
    heading.textContent = offer === "account-migrate" ? "Sign in on your other devices?" : "Use your account on this device?";
    const intro = document.createElement("p");
    intro.textContent = offer === "account-migrate"
      ? "Choose a username and password so you can sign in on your other devices. Your passkey and backup key keep working; nothing else changes."
      : "Your account is set up on another device. Enter your password here once, and this device uses it too.";
    const go = document.createElement("button");
    go.type = "button";
    go.className = "primary-action";
    go.textContent = offer === "account-migrate" ? "Set up" : "Use my account here";
    go.addEventListener("click", () => {
      this.ctx.navigation.navigate("#household/privacy");
      void this.app.security?.account?.start("migrate");
    });
    const later = document.createElement("button");
    later.type = "button";
    later.textContent = "Not now";
    later.addEventListener("click", () => {
      this.app.migrationOfferDismissed = true;
      dismissOfferAt(ACCOUNT_MIGRATE_OFFER_DISMISSED_KEY);
      this.renderOnboarding();
    });
    card.append(heading, intro, go, later);
    card.hidden = false;
    return true;
  }

  renderFirstRun(card, heading) {
    const { state, error, pending } = this.app.firstRun;
    card.dataset.firstRun = state;
    if (state === "working") {
      heading.textContent = pending.mode === "join" ? "Sending your request…"
        : pending.mode === "sign-in" ? "Setting up this device…" : "Setting up your household…";
      const intro = document.createElement("p");
      intro.textContent = "This takes a moment. You can look around meanwhile.";
      card.append(heading, intro);
      card.hidden = false;
      return;
    }
    heading.textContent = pending.mode === "join" ? "Your request wasn't sent"
      : pending.mode === "sign-in" ? "This device isn't set up yet" : "Your household isn't set up yet";
    const intro = document.createElement("p");
    intro.setAttribute("role", "alert");
    intro.textContent = error?.message || "Kin couldn't reach your household service.";
    const form = document.createElement("form");
    form.className = "first-run-retry";
    let field = null;
    const fix = error?.code === "username_taken" || error?.code === "username_invalid" ? "username"
      : pending.mode === "join" && ["invalid_code", "pairing_expired", "pairing_revoked", "pairing_used", "pairing_claimed"].includes(error?.code) ? "code" : null;
    if (fix) {
      const label = document.createElement("label");
      label.htmlFor = `first-run-retry-${fix}`;
      label.textContent = fix === "username" ? "Choose another username" : "Invitation code";
      field = document.createElement("input");
      field.id = label.htmlFor;
      field.required = true;
      field.autocomplete = fix === "username" ? "username" : "one-time-code";
      if (fix === "code") field.maxLength = 9;
      form.append(label, field);
    }
    const retry = document.createElement("button");
    retry.type = "submit";
    retry.className = "primary-action";
    retry.textContent = "Try again";
    form.append(retry);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = field?.value.trim() ?? "";
      if (field && !value) return field.focus();
      void this.ctx.firstRun.retry(fix === "username" ? { username: value.toLowerCase() } : fix === "code" ? { code: value } : {});
    });
    card.append(heading, intro, form);
    // Set up by someone else (#615): who to call.
    if (pending.prepared?.helper) {
      const call = document.createElement("p");
      call.className = "first-run-call";
      call.textContent = `If you get stuck, call ${pending.prepared.helper}.`;
      card.append(call);
    }
    card.hidden = false;
  }

  // Registers the offline shell worker; an installed update shows a calm notice.
  registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.addEventListener("message", this.app.onServiceWorkerMessage);
    navigator.serviceWorker.addEventListener("controllerchange", this.app.onControllerChange);
    const release = document.querySelector('meta[name="kin-version"]')?.content;
    void navigator.serviceWorker.register(`/service-worker.js?v=${encodeURIComponent(release ?? "")}`).then((registration) => {
      this.app.updateRegistration = registration;
      if (registration.waiting && navigator.serviceWorker.controller) this.showUpdateNotice();
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) this.showUpdateNotice();
        });
      });
    }).catch(() => {
      // Online use still follows the same security boundary without offline cache.
    });
    // A load that began while the worker installed is not one of the pages
    // the worker claims when it activates, so it would stay uncontrolled
    // and could not start offline until its next load (#770). Ask for it.
    // The worker claims only a page of its own release, so files never mix.
    void navigator.serviceWorker.ready.then((registration) => {
      if (!navigator.serviceWorker.controller) registration.active?.postMessage({ type: "KIN_CLAIM", release });
    });
  }
}
