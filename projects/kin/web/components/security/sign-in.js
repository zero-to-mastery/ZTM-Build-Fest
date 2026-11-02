// Signing in on a new device (#568, #569): from a browser with no Kin on it,
// a member signs in with their username and password (or a passkey), opens
// their account vault, and says which device this is:
//
//   1. Sign in: username and password, "Sign in with a passkey", or "Use my
//      backup code" (#572). (A member who requires both confirms with the
//      passkey next.)
//   2. Which device is this? "Add this as a new device", or "This replaces
//      <one of my devices>" (that device is signed out for good).
//   3. After a backup code only: choose a new password (#572). It replaces
//      the old one when the device registers.
//   -> this device's storage is made (a password wrapper; for a
//      passkey-only sign-in a passkey wrapper, with a backup key for this
//      device only when the account has no backup code), and the household
//      panel registers the device and installs the keys
//      (household/account.js provisionNewDevice), while Today shows.
//
// Pairing from another device (the passkey setup) stays available.
// Part of <kin-security>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-security.js lists them).
import { PASSWORD_GUIDANCE, USERNAME_GUIDANCE, normalizeUsername, usernameProblem } from "../../security/account-credentials.js";
import { LocalVault, localPasswordKek, randomRecoverySecret, toBase64Url } from "../../security/local-vault.js";
import {
  deviceChoiceProblem,
  downloadSignInVault,
  newPasswordForBackupCode,
  openSignInVault,
  signInRequest,
  signInWithBackupCode,
  signInWithPasskey,
  signInWithPassword,
  wipeSignIn,
} from "../../security/new-device.js";
import { EventStore } from "../../storage/event-store.js";
import { CARRIED_OVER_ORIGIN } from "../household/carried-over.js";

export const REPLACE_WARNING = "The device you choose is signed out for good: it can't open your household again, even if it turns up. Choose this only for a device that's lost, broken or wiped.";

export class SecuritySignIn {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
    this.state = null;
  }

  start() {
    this.reset();
    this.host.signingIn = true;
    this.host.render();
  }

  reset() {
    if (this.state) this.wipe();
    this.state = { step: "credentials", draft: { username: "", password: "", code: "", newPassword: "", newPasswordAgain: "" }, problems: {}, choice: "new" };
  }

  wipe() {
    const state = this.state;
    if (!state) return;
    wipeSignIn(state.opened);
    state.passwordKey?.fill(0);
    state.prfOutput?.fill(0);
    state.codeBytes?.fill(0);
    state.opened = null;
    state.passwordKey = null;
    state.prfOutput = null;
    state.codeBytes = null;
  }

  /** Back to the welcome screen; the service forgets the sign-in too. */
  cancel() {
    this.wipe();
    this.state = null;
    this.host.signingIn = false;
    void signInRequest("/api/account/sign-in/cancel").catch(() => {});
    this.host.render();
  }

  render() {
    if (!this.state) this.reset();
    this.host.dataset.firstRunStep = `sign-in-${this.state.step}`;
    if (this.state.step === "passkey") return this.renderPasskeyStep();
    if (this.state.step === "device") return this.renderDevice();
    if (this.state.step === "backup") return this.renderBackup();
    if (this.state.step === "backup-code") return this.renderBackupCode();
    if (this.state.step === "new-password") return this.renderNewPassword();
    return this.renderCredentials();
  }

  renderCredentials() {
    this.host.heading.textContent = "Sign in to your household";
    this.host.text("Use the username and password you chose when you set up Kin.");
    const form = this.form(() => this.submitPassword());
    this.field(form, { key: "username", label: "Username", autocomplete: "username", hint: USERNAME_GUIDANCE, spellcheck: false, autocapitalize: "none" });
    this.field(form, { key: "password", label: "Password", type: "password", autocomplete: "current-password" });
    this.actions(form, "Sign in", () => this.cancel());
    this.host.append(form);
    const other = this.host.text("Added a passkey to your account? Enter your username, then:");
    other.className = "household-choice-hint";
    this.host.button("Sign in with a passkey", () => {
      // The service finds the account's passkeys by its username.
      if (!normalizeUsername(this.state.draft.username)) return this.showProblems({ username: "Enter your username first, then choose Sign in with a passkey." });
      void this.host.run(() => this.submitPasskey());
    }, "secondary");
    const lost = this.host.text("Lost your password or passkey?");
    lost.className = "household-choice-hint";
    this.host.button("Use my backup code", () => { this.state.step = "backup-code"; this.state.problems = {}; this.host.render(); }, "secondary");
    this.focusFirst(form);
  }

  /** The third way in (#572): username and the account backup code. */
  renderBackupCode() {
    this.host.heading.textContent = "Sign in with your backup code";
    this.host.text("Enter your username and the backup code you printed or saved. You'll choose a new password next.");
    const form = this.form(() => this.submitBackupCode());
    this.field(form, { key: "username", label: "Username", autocomplete: "username", hint: USERNAME_GUIDANCE, spellcheck: false, autocapitalize: "none" });
    this.field(form, { key: "code", label: "Backup code", autocomplete: "off", hint: "8 groups of 7 letters and numbers. Dashes and spaces don't matter.", spellcheck: false, autocapitalize: "characters" });
    this.actions(form, "Continue", () => { this.state.step = "credentials"; this.state.draft.code = ""; this.state.problems = {}; this.host.render(); });
    this.host.append(form);
    this.focusFirst(form);
  }

  /** After a backup code: a new password, required (#572). */
  renderNewPassword() {
    this.host.heading.textContent = "Choose a new password";
    this.host.text(`Signed in as ${this.state.view.username} with your backup code. Choose a new password: it replaces your old one, and you'll use it to unlock Kin here.`);
    const form = this.form(() => this.submitNewPassword());
    const account = document.createElement("input");
    Object.assign(account, { type: "text", autocomplete: "username", value: this.state.view.username ?? "", tabIndex: -1, className: "visually-hidden" });
    account.setAttribute("aria-hidden", "true");
    form.append(account);
    this.field(form, { key: "newPassword", label: "New password", type: "password", autocomplete: "new-password", hint: PASSWORD_GUIDANCE });
    this.field(form, { key: "newPasswordAgain", label: "New password again", type: "password", autocomplete: "new-password" });
    this.actions(form, "Continue", () => this.cancel(), "Cancel");
    this.host.append(form);
    this.focusFirst(form);
  }

  renderPasskeyStep() {
    this.host.heading.textContent = "Confirm with your passkey";
    this.host.text("Your account asks for your password and your passkey. Your password matched; now use your passkey.");
    this.host.button("Use my passkey", () => void this.host.run(() => this.submitPasskey()), "primary-action");
    this.host.button("Cancel", () => this.cancel(), "secondary");
    queueMicrotask(() => this.host.querySelector("button")?.focus());
  }

  renderDevice() {
    const { view } = this.state;
    this.host.heading.textContent = "Which device is this?";
    this.host.text(`Signed in as ${view.username}.`);
    const form = this.form(() => this.submitDevice());
    const fieldset = document.createElement("fieldset");
    fieldset.className = "device-choice";
    const legend = document.createElement("legend");
    legend.textContent = "Which device is this?";
    legend.className = "visually-hidden";
    fieldset.append(legend);
    const warning = document.createElement("p");
    warning.id = "device-choice-warning";
    warning.className = "security-note";
    warning.textContent = REPLACE_WARNING;
    const option = (value, text, hint = "") => {
      const label = document.createElement("label");
      label.className = "device-choice-option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "device-choice";
      input.value = value;
      input.checked = this.state.choice === value;
      input.addEventListener("change", () => { this.state.choice = value; this.state.problems = {}; warning.hidden = value === "new"; });
      if (value !== "new") input.setAttribute("aria-describedby", warning.id);
      label.append(input, ` ${text}`);
      if (hint) {
        const small = document.createElement("span");
        small.className = "household-choice-hint";
        small.textContent = ` ${hint}`;
        label.append(small);
      }
      fieldset.append(label);
      return input;
    };
    option("new", "Add this as a new device");
    // A device carried over from the old address (#780) stays a choice: it
    // may well be the one this replaces. It says where it came from, as
    // People & devices does.
    for (const device of view.devices) {
      const added = `added ${new Date(device.trustedAt).toLocaleDateString()}`;
      option(`replace:${device.deviceId}`, `This replaces ${device.label}`, device.carriedOver === true ? `${added} · ${CARRIED_OVER_ORIGIN}` : added);
    }
    warning.hidden = this.state.choice === "new";
    fieldset.append(warning);
    form.append(fieldset);
    if (this.state.problems.device) {
      const error = document.createElement("p");
      error.className = "field-error";
      error.id = "device-choice-error";
      error.textContent = this.state.problems.device;
      fieldset.setAttribute("aria-describedby", error.id);
      form.append(error);
    }
    this.actions(form, "Continue", () => this.cancel(), "Cancel");
    this.host.append(form);
    queueMicrotask(() => form.querySelector("input:checked")?.focus());
  }

  renderBackup() {
    // Only after a passkey-only sign-in: this device has no password to
    // protect its storage with, so it gets a passkey wrapper and, as the way
    // back in if the passkey is ever unavailable here, a backup key.
    this.host.heading.textContent = "Save a backup key for this device";
    this.host.text("You signed in with a passkey, so this device is protected by it. This backup key opens Kin on this device if the passkey ever can't. Save it somewhere safe, like a password manager.");
    const output = document.createElement("code");
    output.className = "recovery-key";
    output.textContent = this.state.recoverySecret;
    this.host.append(output);
    const form = this.form(() => {
      if (!form.querySelector("#sign-in-backup-saved").checked) return this.host.error(new Error("Save the backup key first, then tick the box."));
      void this.host.run(() => this.establish());
    });
    const saved = document.createElement("label");
    saved.className = "recovery-saved";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = "sign-in-backup-saved";
    saved.append(box, " I've saved this key somewhere safe.");
    form.append(saved);
    this.actions(form, "Continue", () => this.cancel(), "Cancel");
    this.host.append(form);
  }

  async submitPassword() {
    const { username, password } = this.state.draft;
    const problems = {};
    if (!normalizeUsername(username)) problems.username = usernameProblem(username);
    if (!password) problems.password = "Enter your password.";
    if (Object.keys(problems).length) return this.showProblems(problems);
    await this.host.run(async () => {
      this.host.message.textContent = "Signing in…";
      // A wrong password, or an account that signs in with its passkey,
      // is said in the alert line; the form keeps what was typed.
      const signedIn = await signInWithPassword({ username, password });
      this.state.draft.password = "";
      Object.assign(this.state, { passwordKey: signedIn.passwordKey, salt: signedIn.salt, iterations: signedIn.iterations, username: signedIn.username });
      if (signedIn.view.needsPasskey) {
        this.state.view = signedIn.view;
        this.state.step = "passkey";
        this.host.render();
        return;
      }
      await this.openVault(signedIn.view, { method: "password" });
    });
  }

  async submitPasskey() {
    const { view, prfOutput, credentialId } = await signInWithPasskey({ username: this.state.draft.username, signal: this.host.operationAbort.signal });
    this.state.prfOutput = prfOutput;
    this.state.credentialId = credentialId;
    await this.openVault(view, { method: view.method, credentialId });
  }

  async submitBackupCode() {
    const { username, code } = this.state.draft;
    const problems = {};
    if (!normalizeUsername(username)) problems.username = usernameProblem(username);
    if (!code.trim()) problems.code = "Enter your backup code.";
    if (Object.keys(problems).length) return this.showProblems(problems);
    await this.host.run(async () => {
      this.host.message.textContent = "Checking your backup code…";
      const signedIn = await signInWithBackupCode({ username, code });
      this.state.draft.code = "";
      this.state.codeBytes = signedIn.codeBytes;
      await this.openVault(signedIn.view, { method: "backup-code" });
    });
  }

  async openVault(view, { method, credentialId = null }) {
    this.host.message.textContent = "Opening your account…";
    const download = await downloadSignInVault();
    if (!download.certificationEndorsement)
      throw new Error("Your account isn't ready to add devices this way yet. Open Kin on one of your devices once, then try again.");
    this.state.opened = await openSignInVault({ download, method, credentialId, passwordKey: this.state.passwordKey, prfOutput: this.state.prfOutput,
      codeBytes: this.state.codeBytes, householdId: view.householdId, memberId: view.memberId });
    // The code has done its job: it opened the vault.
    this.state.codeBytes?.fill(0);
    Object.assign(this.state, { view, endorsement: download.certificationEndorsement, others: download.others, accountBackupCode: download.backupCode,
      step: "device", choice: "new", problems: {} });
    this.host.message.textContent = "";
    this.host.render();
  }

  submitDevice() {
    const replaceDeviceId = this.state.choice.startsWith("replace:") ? this.state.choice.slice(8) : null;
    const problem = deviceChoiceProblem(this.state.view, replaceDeviceId);
    if (problem) return this.showProblems({ device: problem });
    this.state.replaceDeviceId = replaceDeviceId;
    if (this.state.view.method === "backup-code") {
      this.state.step = "new-password";
      this.state.problems = {};
      this.host.render();
      return;
    }
    // A passkey alone: a backup key for this device only when the account
    // has no backup code (#572); otherwise the account is the way back.
    if (!this.state.passwordKey && !this.state.accountBackupCode) {
      this.state.recoverySecret = randomRecoverySecret();
      this.state.step = "backup";
      this.host.render();
      return;
    }
    void this.host.run(() => this.establish());
  }

  async submitNewPassword() {
    const { newPassword, newPasswordAgain } = this.state.draft;
    if (newPassword !== newPasswordAgain) return this.showProblems({ newPasswordAgain: "The passwords don't match. Type the same new password twice." });
    await this.host.run(async () => {
      this.host.message.textContent = "Setting your new password…";
      const { view, opened, others } = this.state;
      let prepared;
      try {
        prepared = await newPasswordForBackupCode({ password: newPassword, username: view.username, opened, others,
          householdId: view.householdId, memberId: view.memberId });
      } catch (error) {
        this.host.message.textContent = "";
        if (error?.code === "password_rejected") return this.showProblems({ newPassword: error.userMessage ?? error.message });
        throw error;
      }
      Object.assign(this.state.draft, { newPassword: "", newPasswordAgain: "" });
      Object.assign(this.state, { passwordKey: prepared.passwordKey, salt: prepared.salt, iterations: prepared.iterations,
        username: view.username, registration: prepared.body });
      await this.establish();
    });
  }

  /**
   * Makes this device's encrypted storage and opens it, then hands the rest
   * to the household panel (security.services.completeFirstRun). A password
   * sign-in protects it with the password (unlocks offline, like the first
   * run); a passkey-only one with that passkey and a backup key.
   */
  async establish() {
    const operation = this.host.operation;
    const state = this.state;
    this.host.message.textContent = "Setting up this device…";
    let vault;
    try {
      if (state.passwordKey) {
        const kek = await localPasswordKek(state.passwordKey);
        try {
          ({ vault } = await LocalVault.createWithPassword(kek, { salt: toBase64Url(state.salt), iterations: state.iterations, username: state.username }));
        } finally { kek.fill(0); }
      } else if (state.accountBackupCode) {
        // The account has a backup code: the passkey protects this device,
        // and no per-device backup key is made (#572).
        ({ vault } = await LocalVault.createWithPasskey(state.prfOutput, { credentialId: state.credentialId, prfSalt: state.opened.wrapper.params.prfSalt }));
      } else {
        ({ vault } = await LocalVault.create(state.recoverySecret));
        const wrapper = await vault.createWrapper(state.prfOutput, { type: "prf", credentialId: state.credentialId,
          prfSalt: state.opened.wrapper.params.prfSalt });
        vault.manifest = { ...vault.manifest, wrappers: [...vault.manifest.wrappers, wrapper] };
        state.recoverySecret = "";
      }
      this.host.assertCurrentOperation(operation);
      await EventStore.prepareSecurity(vault.manifest);
      this.host.assertCurrentOperation(operation);
      this.host.manifest = await EventStore.securityStatus();
    } catch (error) {
      vault?.lock();
      throw error;
    }
    const pending = { mode: "sign-in", signIn: { view: state.view, opened: state.opened, endorsement: state.endorsement, replaceDeviceId: state.replaceDeviceId,
      // A backup-code sign-in's new password and vault change (#572) go with the registration.
      registration: state.registration ?? null } };
    // The vault key and contents now belong to the pending provisioning.
    state.opened = null;
    this.wipe();
    this.state = null;
    this.host.signingIn = false;
    await this.ctx.unlock.finishUnlock(vault, operation);
    this.host.services?.completeFirstRun?.(pending);
  }

  // ---- Small form helpers (the first run's look) ----------------------------

  form(onSubmit) {
    const form = document.createElement("form");
    form.className = "first-run-form";
    form.noValidate = true;
    form.setAttribute("aria-labelledby", "security-heading");
    form.addEventListener("submit", (event) => { event.preventDefault(); onSubmit(); });
    return form;
  }

  field(form, { key, label, type = "text", autocomplete, hint = "", spellcheck = null, autocapitalize = null }) {
    const id = `sign-in-${key}`;
    const wrapper = document.createElement("div");
    wrapper.className = "first-run-field";
    const caption = document.createElement("label");
    caption.htmlFor = id;
    caption.textContent = label;
    const input = document.createElement("input");
    Object.assign(input, { id, name: key, type, autocomplete, required: true, value: this.state.draft[key] ?? "" });
    if (spellcheck !== null) input.spellcheck = spellcheck;
    if (autocapitalize) input.setAttribute("autocapitalize", autocapitalize);
    input.addEventListener("input", () => { this.state.draft[key] = input.value; });
    wrapper.append(caption, input);
    const described = [];
    if (hint) {
      const help = document.createElement("p");
      help.id = `${id}-hint`;
      help.className = "security-note";
      help.textContent = hint;
      described.push(help.id);
      wrapper.append(help);
    }
    const problem = this.state.problems[key];
    if (problem) {
      const error = document.createElement("p");
      error.id = `${id}-error`;
      error.className = "field-error";
      error.textContent = problem;
      described.push(error.id);
      input.setAttribute("aria-invalid", "true");
      wrapper.append(error);
    }
    if (described.length) input.setAttribute("aria-describedby", described.join(" "));
    form.append(wrapper);
    return input;
  }

  actions(form, label, back, backLabel = "Back") {
    const row = document.createElement("div");
    row.className = "first-run-actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "primary-action";
    submit.textContent = label;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = backLabel;
    cancel.addEventListener("click", back);
    row.append(submit, cancel);
    form.append(row);
  }

  focusFirst(form) {
    const target = form.querySelector('[aria-invalid="true"]') ?? form.querySelector("input");
    queueMicrotask(() => target?.focus());
  }

  showProblems(problems) {
    this.state.problems = problems;
    this.host.render();
  }
}
