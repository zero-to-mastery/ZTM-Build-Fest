// A password account's security settings (ADR 0018, #560-#562, #571-#573):
// the passkey (add it, require password and passkey), the password (change
// it) and the backup code (make, print, replace). Shown in Security once the
// member's account summary is loaded; members without an account keep the
// older passkey-unlock and backup-key sections (views.js).
//
// One flow at a time opens inline under its section, asks for the current
// password (every account change does) and runs as the panel's operation.
// Nothing is required: each is offered calmly here and, at quiet moments,
// on Today (components/app/status.js).
// Part of <kin-security>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-security.js lists them).
import {
  accountSecurity,
  accountState,
  addAccountPasskey,
  changeAccountPassword,
  finishPasskeySetup,
  removeAccountPasskey,
  saveBackupCode,
  setRequireBoth,
} from "../../security/account-security.js";
import { PASSWORD_GUIDANCE, USERNAME_GUIDANCE } from "../../security/account-credentials.js";
import { migrateAccount, migrationProblems, migrationState } from "../../security/account-migration.js";
import { generateBackupCode } from "../../security/backup-code.js";
import { getActiveVault } from "../../security/local-vault.js";
import { passkeyUnlockSupported } from "../../security/passkey-unlock.js";
import { EventStore } from "../../storage/event-store.js";
import { passwordManagerField } from "./protection.js";

export const LOST_PASSKEY_COPY = "If you lose your passkey (a lost phone, a reset password manager), your backup code gets you back in. Without the passkey, the backup code or another device of yours, Kin can't open your account.";
export const BACKUP_CODE_COPY = "Your backup code opens your account on a new device if you lose your password or passkey. Print it or write it down, and keep it somewhere safe at home. Anyone with it and your username can open your account.";

export class SecurityAccount {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
    this.security = null;
    this.loading = null;
    // The open flow: null, or { kind, ... } (kind: "add-passkey",
    // "finish-passkey", "require-both", "change-password", "backup-code").
    this.flow = null;
  }

  app() { return this.host.closest("kin-app"); }

  identity() { return this.app()?.household?.identity ?? null; }

  /** The summary, when it is this signed-in member's and they have an account. */
  ready() {
    const identity = this.identity();
    return Boolean(identity && this.security && this.security.memberId === identity.memberId && accountState(this.security).account);
  }

  state() { return accountState(this.security); }

  /** "invite", "finish", "done" or null (account-migration.js). */
  migration() {
    const identity = this.identity();
    if (!identity || this.security?.memberId !== identity.memberId) return null;
    const state = migrationState(this.security, { holdsVaultKey: this.security.deviceHoldsVaultKey === true });
    // "Finish here" is for a device set up the old way (a backup key, no
    // password unlock): a device the first run or a sign-in set up is
    // already the account's, even while its vault is still being made.
    const manifest = getActiveVault()?.manifest ?? this.host.manifest;
    const oldWay = !(manifest?.wrappers ?? []).some((wrapper) => wrapper.type === "password") && !manifest?.accountRecovery;
    return state === "finish" && !oldWay ? null : state;
  }

  /** Loads (or reloads) the account summary; re-renders the settings once it
   * arrives. Errors leave the older sections in place. */
  refresh({ render = true } = {}) {
    const identity = this.identity();
    if (!identity) return Promise.resolve(null);
    // Every signed-in device asks: a member set up the old way (passkey and
    // backup key) is invited to move to an account (#575), and a device of a
    // member who moved on another device is offered to finish here. Only a
    // device that keeps the vault key changes the account (accountState).
    this.loading ??= Promise.all([this.holdsVaultKey(identity), accountSecurity()]).then(([holds, security]) => {
      this.security = { ...security, memberId: identity.memberId, deviceHoldsVaultKey: holds };
      const app = this.app();
      if (app) app.accountSecurity = this.security;
      if (render && this.host.phase === "unlocked" && !this.host.busy && !this.flow) this.host.render();
      app?.ctx?.status?.renderOnboarding?.();
      return this.security;
    }, () => null).finally(() => { this.loading = null; });
    return this.loading;
  }

  async holdsVaultKey(identity) {
    // Right after an unlock the household panel may still be opening its
    // key store; ask once it has.
    await this.app()?.household?.loaded?.catch?.(() => {});
    const vaultKey = await this.app()?.household?.syncKeyStore?.accountVaultKey?.(identity.householdId).catch(() => null);
    vaultKey?.fill(0);
    return Boolean(vaultKey);
  }

  /** Opens a flow (from Today's cards or a settings button). `details` go
   * with it (the passkey "remove-passkey" names). */
  async start(kind, details = {}) {
    const moving = kind === "migrate";
    if (!this.ready() && !(moving && this.migration())) await this.refresh({ render: false });
    if (moving ? !["invite", "finish"].includes(this.migration()) : !this.ready()) return false;
    this.wipeFlow();
    this.flow = { kind, ...details };
    if (kind === "backup-code") Object.assign(this.flow, await generateBackupCode());
    this.host.render();
    queueMicrotask(() => {
      const target = this.host.querySelector(`[data-account-flow="${kind}"] input:not([tabindex="-1"]), [data-account-flow="${kind}"] button`);
      target?.focus();
      target?.scrollIntoView?.({ block: "center" });
    });
    return true;
  }

  close() {
    this.wipeFlow();
    this.host.render();
  }

  wipeFlow() {
    this.flow?.bytes?.fill(0);
    this.flow = null;
  }

  // ---- Sections ------------------------------------------------------------

  renderPasskeySection() {
    const state = this.state();
    const section = this.host.section("Passkey");
    section.dataset.accountSection = "passkey";
    const supported = passkeyUnlockSupported();
    const status = document.createElement("p");
    status.className = "security-status";
    status.dataset.passkeyUnlock = state.passkey ? "on" : "off";
    status.textContent = state.requireBoth
      ? "On — signing in on a new device asks for your password and your passkey."
      : state.passkey
        ? "On — your passkey signs you in on a new device by itself."
        : state.passkeyNeedsSetup
          ? "Your passkey doesn't open your account on a new device yet."
          : "Off — you sign in with your password.";
    section.append(status);
    if (!state.passkey && !state.passkeyNeedsSetup) {
      this.note(section, "Add a passkey and your face, fingerprint or screen lock signs you in, here and on a new device. Once it's added, your password alone no longer opens your account on a new device, so a stolen copy of Kin's service can't be used to guess it.");
      if (supported) this.flowButton(section, "add-passkey", "Add a passkey", "primary-action");
    } else if (state.passkeyNeedsSetup) {
      this.note(section, "Set it up again so it can sign you in on a new device.");
      if (supported) this.flowButton(section, "finish-passkey", "Set up my passkey");
    } else {
      const local = (this.host.manifest?.wrappers ?? []).some((wrapper) => wrapper.type === "prf");
      this.note(section, local ? "It also unlocks Kin on this device." : "It doesn't unlock Kin on this device yet.");
      if (!local && supported)
        this.host.button("Unlock this device with my passkey", () => this.host.run(() => this.host.addPasskey()), "", section);
      // Require password and passkey (#562): off by default.
      const row = document.createElement("div");
      row.className = "security-chat-option";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.id = "require-password-and-passkey";
      box.checked = state.requireBoth;
      box.setAttribute("aria-describedby", "require-both-hint");
      const label = document.createElement("label");
      label.htmlFor = box.id;
      label.textContent = "Require password and passkey";
      box.addEventListener("change", () => {
        const on = box.checked;
        box.checked = state.requireBoth;
        void this.start("require-both").then(() => { if (this.flow) this.flow.on = on; this.host.render(); });
      });
      row.append(box, label);
      const hint = this.note(section, state.requireBoth
        ? "Your passkey alone can't open your account. Turn this off to let it sign you in by itself again."
        : "Off: your passkey alone signs you in on a new device. On: it asks for your password too, so someone who gets into the account that syncs your passkey still can't open Kin.");
      hint.id = "require-both-hint";
      section.append(row, hint);
    }
    this.note(section, state.backupCode ? LOST_PASSKEY_COPY : `${LOST_PASSKEY_COPY} Make a backup code below.`);
    if (["add-passkey", "finish-passkey", "require-both"].includes(this.flow?.kind)) this.renderPasswordFlow(section);
    this.renderPasskeyList(section, state);
  }

  /** Each of the account's passkeys, with "Remove this passkey" (#592
   * follow-up). Removing one never leaves the account without a way in:
   * the password stays, and the last passkey's going brings back the
   * password's own way into the vault. */
  renderPasskeyList(section, state) {
    if (!state.passkeys.length) return;
    const local = new Set((this.host.manifest?.wrappers ?? []).filter((wrapper) => wrapper.type === "prf").map((wrapper) => wrapper.credentialId));
    const list = document.createElement("ul");
    list.className = "account-passkeys";
    state.passkeys.forEach((credentialId, index) => {
      const item = document.createElement("li");
      item.dataset.credentialId = credentialId;
      const name = document.createElement("span");
      name.textContent = `${state.passkeys.length === 1 ? "Your passkey" : `Passkey ${index + 1}`}${local.has(credentialId) ? " (unlocks this device)" : ""}`;
      item.append(name, " ");
      const remove = this.host.button(state.passkeys.length === 1 ? "Remove this passkey" : `Remove passkey ${index + 1}`,
        () => void this.start("remove-passkey", { credentialId }), "", item);
      remove.dataset.removePasskey = credentialId;
      list.append(item);
      if (this.flow?.kind === "remove-passkey" && this.flow.credentialId === credentialId) this.renderRemovePasskey(item, state, local.has(credentialId));
    });
    section.append(list);
  }

  renderRemovePasskey(parent, state, unlocksHere) {
    const { credentialId } = this.flow;
    const last = state.passkeys.length === 1;
    const form = this.form("remove-passkey", () => {
      const password = input.value;
      input.value = "";
      void this.runFlow("remove-passkey", (context) => this.removePasskey(password, credentialId, context));
    });
    const lead = document.createElement("p");
    lead.textContent = last
      ? "Your passkey will stop signing you in. Your password signs you in on a new device again, until you add another passkey."
      : "This passkey will stop signing you in. Your password and your other passkeys keep working.";
    form.prepend(lead);
    // Taking an unlock away from this device locks Kin (like removing any
    // unlock path), so it's said before.
    if (unlocksHere) this.note(form, this.host.manifest?.wrappers?.some((wrapper) => wrapper.type === "recovery" || wrapper.type === "password")
      ? "It also stops unlocking Kin on this device, and Kin locks once it's done."
      : "It also stops unlocking Kin on this device: Kin locks once it's done, and your password unlocks it from then on.");
    const input = this.passwordField(form, { id: "account-password-remove-passkey", label: "Your password" });
    this.actions(form, "Remove passkey");
    parent.append(form);
  }

  /** "Your account" for a member set up the old way (#575): a calm offer to
   * choose a username and password, or, when the account exists but this
   * device doesn't hold its keys, to finish here. Nothing is required. */
  renderMigrationSection() {
    const state = this.migration();
    if (!["invite", "finish"].includes(state)) return false;
    const section = this.host.section("Your account");
    section.dataset.accountSection = "migrate";
    const status = document.createElement("p");
    status.className = "security-status";
    status.textContent = state === "invite"
      ? "You unlock Kin with your passkey and this device's backup key."
      : `Your account${this.security.username ? ` (${this.security.username})` : ""} is set up, but not on this device yet.`;
    section.append(status);
    this.note(section, state === "invite"
      ? "Choose a username and password so you can sign in on your other devices, including a new phone. Your passkey and this device's backup key keep working."
      : "Enter your password to use your account here too: this device then keeps your account's keys, and your password unlocks it.");
    if (this.flow?.kind === "migrate") this.renderMigration(section, state);
    else this.flowButton(section, "migrate", state === "invite" ? "Choose a username and password" : "Use my account here", "primary-action");
    return true;
  }

  renderMigration(section, state) {
    const form = this.form("migrate", () => {
      if (state === "invite") {
        const problems = migrationProblems({ username: username.value, password: password.value, again: again.value });
        const first = Object.values(problems)[0];
        if (first) return this.host.error(new Error(first));
      }
      const values = { username: username?.value ?? "", password: password.value };
      password.value = "";
      if (again) again.value = "";
      void this.runMigration(values);
    });
    let username = null;
    let again = null;
    if (state === "invite") {
      // The username a password manager saves with the new password.
      form.querySelector('input[autocomplete="username"]')?.remove();
      const caption = document.createElement("label");
      caption.htmlFor = "account-migrate-username";
      caption.textContent = "Username";
      username = document.createElement("input");
      Object.assign(username, { id: "account-migrate-username", type: "text", autocomplete: "username", required: true, spellcheck: false });
      username.setAttribute("autocapitalize", "none");
      const hint = this.note(form, USERNAME_GUIDANCE);
      hint.id = "account-migrate-username-hint";
      username.setAttribute("aria-describedby", `${hint.id} security-alert`);
      form.append(caption, username, hint);
    }
    const password = this.passwordField(form, state === "invite"
      ? { id: "account-migrate-password", label: "Password", autocomplete: "new-password", hint: PASSWORD_GUIDANCE }
      : { id: "account-migrate-password", label: "Your password" });
    if (state === "invite") {
      again = this.passwordField(form, { id: "account-migrate-password-again", label: "Password again", autocomplete: "new-password" });
      this.note(form, "Kin can't reset this password. Next, confirm with your passkey.");
    }
    this.actions(form, state === "invite" ? "Set up my account" : "Use my account here");
    section.append(form);
  }

  /** Runs the move (account-migration.js) as the panel's operation. */
  async runMigration({ username, password }) {
    const app = this.app();
    const identity = this.identity();
    const household = app?.household;
    await this.host.run(async (operation) => {
      const keyStore = household?.syncKeyStore;
      if (!identity || !keyStore) throw new Error("Connect to your household first, then set up your account.");
      const localVault = getActiveVault();
      const steps = { password: "Confirming with your passkey…", vault: "Making your account's key vault…", endorse: "Getting your account ready for new devices…", local: "Letting your password unlock this device…" };
      const { manifest, wrapper } = await migrateAccount({
        username, password, security: this.security, identity, keyStore, localVault,
        endorse: () => household.account.ensureCertificationEndorsement(identity),
        signal: this.host.operationAbort.signal,
        onStep: (step) => { if (operation === this.host.operation) this.host.message.textContent = this.security?.password && step === "password" ? "Checking your password…" : steps[step]; },
      });
      if (manifest) await this.saveManifest(manifest, localVault);
      this.host.assertCurrentOperation(operation);
      // The vault follows new epoch keys from now on, and private storage opens.
      void household.account.keeper?.update().catch(() => {});
      void app.syncCoordinator?.syncNow?.();
      this.wipeFlow();
      await this.refresh({ render: false });
      this.host.assertCurrentOperation(operation);
      this.host.render();
      this.host.message.textContent = wrapper === "passkey"
        ? "Your account is ready. On another device, sign in with your username and your passkey. Your password unlocks this device too."
        : "Your account is ready. On another device, sign in with your username and password.";
      this.host.dispatchEvent(new CustomEvent("kin:security-changed", { bubbles: true, composed: true }));
    });
  }

  renderPasswordActions(section) {
    if (this.flow?.kind === "change-password") return this.renderChangePassword(section);
    this.flowButton(section, "change-password", "Change password");
  }

  renderBackupCodeSection() {
    const state = this.state();
    const section = this.host.section("Backup code");
    section.dataset.accountSection = "backup-code";
    const status = document.createElement("p");
    status.className = "security-status";
    status.dataset.passkeyUnlock = state.backupCode ? "on" : "off";
    status.textContent = state.backupCode
      ? `You have a backup code${state.backupCodeMadeAt ? `, made ${new Date(state.backupCodeMadeAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}` : ""}.`
      : "You don't have a backup code yet.";
    section.append(status);
    this.note(section, BACKUP_CODE_COPY);
    if (state.backupCode) this.note(section, "It also opens the exports you make, so you no longer need a backup key for each device. A new code replaces this one: the old one stops working at once.");
    if (this.flow?.kind === "backup-code") return this.renderBackupCode(section);
    this.flowButton(section, "backup-code", state.backupCode ? "Make a new backup code" : "Make a backup code", state.backupCode ? "" : "primary-action");
  }

  // ---- Flows -----------------------------------------------------------------

  flowButton(section, kind, label, className = "") {
    return this.host.button(label, () => void this.start(kind), className, section);
  }

  note(parent, value) {
    const line = document.createElement("p");
    line.className = "security-note";
    line.textContent = value;
    parent.append(line);
    return line;
  }

  /** A form with the account's (hidden) username for password managers. */
  form(kind, onSubmit) {
    const form = document.createElement("form");
    form.className = "account-flow";
    form.dataset.accountFlow = kind;
    form.append(passwordManagerField("text", "username", this.security?.username ?? ""));
    form.addEventListener("submit", (event) => { event.preventDefault(); onSubmit(form); });
    return form;
  }

  passwordField(form, { id, label, autocomplete = "current-password", hint = "" }) {
    const caption = document.createElement("label");
    caption.htmlFor = id;
    caption.textContent = label;
    const input = document.createElement("input");
    Object.assign(input, { id, type: "password", autocomplete, required: true, spellcheck: false });
    const described = ["security-alert"];
    form.append(caption, input);
    if (hint) {
      const help = this.note(form, hint);
      help.id = `${id}-hint`;
      described.unshift(help.id);
    }
    input.setAttribute("aria-describedby", described.join(" "));
    return input;
  }

  actions(form, label) {
    const row = document.createElement("div");
    row.className = "first-run-actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "primary-action";
    submit.textContent = label;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.close());
    row.append(submit, cancel);
    form.append(row);
  }

  /** Adding, finishing, or require-both on/off: the password, then the passkey. */
  renderPasswordFlow(section) {
    const { kind } = this.flow;
    const on = this.flow.on ?? !this.state().requireBoth;
    const form = this.form(kind, () => {
      const password = input.value;
      input.value = "";
      void this.runFlow(kind, (context) => {
        if (kind === "add-passkey") return this.addPasskey(password, context);
        if (kind === "finish-passkey") return finishPasskeySetup({ password, ...context });
        return setRequireBoth({ on, password, ...context });
      });
    });
    const lead = document.createElement("p");
    lead.textContent = kind === "add-passkey"
      ? "Enter your password, then follow your device's prompt to make the passkey."
      : kind === "finish-passkey"
        ? "Enter your password, then use your passkey."
        : on ? "To require both, enter your password, then use your passkey." : "To let your passkey sign you in by itself again, enter your password, then use your passkey.";
    form.prepend(lead);
    const input = this.passwordField(form, { id: `account-password-${kind}`, label: "Your password" });
    this.actions(form, kind === "add-passkey" ? "Add passkey" : kind === "finish-passkey" ? "Set up passkey" : on ? "Require both" : "Turn off");
    section.append(form);
  }

  renderChangePassword(section) {
    const form = this.form("change-password", () => {
      const current = currentInput.value;
      const next = nextInput.value;
      const again = againInput.value;
      if (next !== again) return this.host.error(new Error("The new passwords don't match. Type the same new password twice."));
      for (const input of [currentInput, nextInput, againInput]) input.value = "";
      void this.runFlow("change-password", (context) => this.changePassword(current, next, context));
    });
    const currentInput = this.passwordField(form, { id: "account-current-password", label: "Current password" });
    const nextInput = this.passwordField(form, { id: "account-new-password", label: "New password", autocomplete: "new-password", hint: PASSWORD_GUIDANCE });
    const againInput = this.passwordField(form, { id: "account-new-password-again", label: "New password again", autocomplete: "new-password" });
    if (this.state().requireBoth) this.note(form, "Your account asks for your password and your passkey, so you'll use your passkey too.");
    this.note(form, "Your other devices ask for the new password the next time they unlock with a connection; until then, offline, they still open with the old one.");
    this.actions(form, "Change password");
    section.append(form);
  }

  /** The code, a print view and, once saved, the password to turn it on (#573). */
  renderBackupCode(section) {
    const { text } = this.flow;
    const card = document.createElement("div");
    card.className = "backup-code-card";
    card.id = "backup-code-print";
    const title = document.createElement("p");
    title.className = "backup-code-title";
    title.textContent = `Kin backup code${this.security?.username ? ` for ${this.security.username}` : ""}`;
    const code = document.createElement("p");
    code.className = "backup-code";
    code.setAttribute("translate", "no");
    code.setAttribute("aria-label", `Backup code: ${text.split("-").join(", ")}`);
    for (const group of text.split("-")) {
      const part = document.createElement("span");
      part.textContent = group;
      code.append(part, " ");
    }
    const keep = document.createElement("p");
    keep.className = "security-note";
    keep.textContent = "Keep this somewhere safe at home. With your username, it opens your Kin account on a new device and opens your exports. Kin can't show it again.";
    card.append(title, code, keep);
    section.append(card);
    const tools = document.createElement("div");
    tools.className = "first-run-actions";
    this.host.button("Print", () => this.print(), "", tools);
    if (navigator.clipboard?.writeText) this.host.button("Copy", async () => {
      try {
        await navigator.clipboard.writeText(text);
        this.host.message.textContent = "Backup code copied. Paste it somewhere safe, then clear your clipboard.";
      } catch { this.host.message.textContent = "Copy is unavailable. Print the code or write it down."; }
    }, "", tools);
    section.append(tools);
    const form = this.form("backup-code", () => {
      if (!saved.checked) return this.host.error(new Error("Print or save the code first, then tick the box."));
      const password = input.value;
      input.value = "";
      void this.runFlow("backup-code", (context) => this.saveCode(password, context));
    });
    const savedLabel = document.createElement("label");
    savedLabel.className = "recovery-saved";
    const saved = document.createElement("input");
    saved.type = "checkbox";
    saved.id = "backup-code-saved";
    savedLabel.append(saved, " I've printed this code or saved it somewhere safe.");
    form.append(savedLabel);
    const input = this.passwordField(form, { id: "account-password-backup-code", label: "Your password", hint: this.state().backupCode ? "Turning this code on stops your old code working." : "" });
    this.actions(form, "Turn on this code");
    section.append(form);
  }

  /** Prints only the code card (styles/app.css, @media print). */
  print() {
    document.documentElement.classList.add("printing-backup-code");
    const done = () => { document.documentElement.classList.remove("printing-backup-code"); globalThis.removeEventListener("afterprint", done); };
    globalThis.addEventListener("afterprint", done);
    try { globalThis.print(); } finally { setTimeout(done, 1000); }
  }

  /**
   * Runs one account change as the panel's operation, with this device's
   * VK and identity. Afterwards the summary reloads and the settings say
   * what changed; an error stays on the form (the panel's alert).
   */
  async runFlow(kind, change) {
    const app = this.app();
    const identity = this.identity();
    await this.host.run(async (operation) => {
      const store = app?.household?.syncKeyStore;
      const vaultKey = identity ? await store?.accountVaultKey(identity.householdId) : null;
      if (!vaultKey) throw new Error("This device doesn't hold your account's keys, so it can't change how your account opens. Use the device you set Kin up on.");
      try {
        this.host.message.textContent = kind === "change-password" ? "Changing your password…" : "Working…";
        await change({ security: this.security, identity, vaultKey, signal: this.host.operationAbort.signal });
      } finally {
        vaultKey.fill(0);
      }
      this.host.assertCurrentOperation(operation);
      this.wipeFlow();
      await this.refresh({ render: false });
      this.host.assertCurrentOperation(operation);
      this.host.render();
      this.host.message.textContent = {
        "add-passkey": "Passkey added. It signs you in on a new device, and your password alone no longer does.",
        "finish-passkey": "Your passkey signs you in on a new device again.",
        "require-both": this.state().requireBoth ? "Signing in on a new device now asks for your password and your passkey." : "Your passkey signs you in on a new device by itself again.",
        "change-password": "Password changed. Use the new one from now on.",
        "remove-passkey": "Passkey removed. It no longer signs you in.",
        "backup-code": "Your backup code is on. Keep it somewhere safe.",
      }[kind];
      this.host.dispatchEvent(new CustomEvent("kin:security-changed", { bubbles: true, composed: true }));
    });
  }

  async addPasskey(password, context) {
    const vault = getActiveVault();
    const { manifest } = await addAccountPasskey({ password, localVault: vault, ...context });
    if (manifest) await this.saveManifest(manifest, vault);
  }

  async changePassword(current, next, context) {
    const vault = getActiveVault();
    const manifest = await changeAccountPassword({ current, next, localVault: vault, ...context });
    if (manifest) await this.saveManifest(manifest, vault);
  }

  async removePasskey(password, credentialId, context) {
    const vault = getActiveVault();
    const manifest = await removeAccountPasskey({ password, credentialId, localVault: vault, ...context });
    if (manifest) await this.saveManifest(manifest, vault);
  }

  async saveCode(password, context) {
    await saveBackupCode({ password, codeBytes: this.flow.bytes, ...context });
  }

  async saveManifest(manifest, vault) {
    try {
      await EventStore.updateSecurityManifest(manifest, vault);
    } finally {
      // Removing an unlock path locks Kin (the security epoch moves on); the
      // lock screen then shows what this device unlocks with now.
      this.host.manifest = await EventStore.securityStatus().catch(() => this.host.manifest);
      if (this.host.phase === "locked" && !this.host.passwordChange) this.host.render();
    }
  }
}
