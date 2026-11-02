// The first run (#557, #559): at most three screens from opening Kin to
// Today, with no keys and no security choices up front (ADR 0018).
//
//   1. Welcome: start a new household, join one with an invitation, or sign
//      in as an existing member (security/sign-in.js, #568).
//   2. About you: your name, and the household's name (or the invitation code).
//   3. Sign in: a username and a password.
//   -> Today (creating) or waiting for approval (joining).
//
// On the last screen Kin derives the password's keys, makes this device's
// encrypted storage with a password wrapper (no backup key is shown), and
// opens it; the household panel then signs up with the service and creates
// the account vault (household/account.js), while Today is already shown.
// "Set up with a passkey instead" keeps the earlier passkey and backup-key
// setup for people who prefer it.
//
// Set up by someone else (#615): a prepared invitation's link carries the
// key to its card, so it opens on "Hi Rose — your family set this up for
// you", then a password (with Show password; the username is chosen from her
// name), then the wait for the helper's approval, saying who to call.
// Part of <kin-security>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-security.js lists them).
import { prepareSignUp, wipeSignUp } from "../../security/account-setup.js";
import { applyStoredDisplayPrefs, EASY_MODE_KEY, writeDisplayPref } from "../../appearance/display-prefs.js";
import { openCard, randomDigits, suggestUsername } from "../../security/prepared-card.js";
import {
  normalizeUsername,
  PASSWORD_GUIDANCE,
  passwordProblem,
  USERNAME_GUIDANCE,
  usernameProblem,
} from "../../security/account-credentials.js";
import { LocalVault, toBase64Url } from "../../security/local-vault.js";
import { cleanCode, consumeInvitationCode, consumeInvitationKey, PAIR_PATH } from "../../pairing-link.js";
import { currentPlatform, installHelp } from "../../platform.js";
import { EventStore } from "../../storage/event-store.js";
import { installHelpCard } from "../shared/dom.js";
import { MAX_MEMBER_NAME_CHARS, misleadingMemberName } from "../household/member-labels.js";
import { MAX_HOUSEHOLD_NAME_CODE_POINTS } from "../../appearance/household.js";

export const MAX_DISPLAY_NAME = MAX_MEMBER_NAME_CHARS;
export const MAX_HOUSEHOLD_NAME = MAX_HOUSEHOLD_NAME_CODE_POINTS;

/** The one line shown where the password is chosen (ADR 0018 D3 trade-off). */
export const PASSWORD_TRADE_OFF = "Kin can't reset this password. Until you add a passkey or another device, a forgotten password means this household can't be opened.";

/**
 * Checks one screen's answers; returns `{ field: message }` for each problem
 * (empty when all is well). Pure, so the rules are tested without a DOM.
 */
export function firstRunProblems(step, mode, draft) {
  const problems = {};
  if (step === "about") {
    if (!draft.name?.trim()) problems.name = "Enter your name.";
    else if ([...draft.name.trim()].length > MAX_DISPLAY_NAME) problems.name = `Use at most ${MAX_DISPLAY_NAME} characters.`;
    else if (misleadingMemberName(draft.name)) problems.name = "Choose a name other than \u201cYou\u201d.";
    if (mode === "create" && [...(draft.household ?? "").trim()].length > MAX_HOUSEHOLD_NAME)
      problems.household = `Use at most ${MAX_HOUSEHOLD_NAME} characters.`;
    if (mode === "join" && String(draft.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").length !== 8)
      problems.code = "Enter the 8-character invitation code, like F7KM-Q2DX.";
  }
  if (step === "account") {
    const username = normalizeUsername(draft.username ?? "");
    if (!username) problems.username = usernameProblem(draft.username ?? "");
    const password = passwordProblem(draft.password ?? "", { username });
    if (password) problems.password = password;
  }
  return problems;
}

export class SecurityFirstRun {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
    this.state = null;
  }

  /** Starts over. An invitation link (/pair#code=…) opens on "Join your
   * household" with its code filled in; the code is taken only here, when
   * this device has nothing set up yet. */
  reset() {
    const joining = location.pathname === PAIR_PATH;
    const code = joining ? consumeInvitationCode() : "";
    // A prepared invitation's link (#615) also carries the key to its card.
    const key = joining ? consumeInvitationKey() : "";
    // Kept across re-renders (an error re-renders the panel), so nothing
    // typed is lost; the password lives only in memory, only until setup.
    this.state = { step: joining ? (code && key ? "opening" : "about") : "welcome", mode: joining ? "join" : null,
      draft: { name: "", household: "", code, username: "", password: "" }, problems: {}, prepared: null, showPassword: false };
    if (this.state.step === "opening") void this.openPrepared(this.state, key);
  }

  /**
   * Opens a prepared invitation (#615): asks the service about the code, and
   * opens the card with the link's key. With the card: "Hi Rose", then the
   * password. Without it (an ordinary or unreadable invitation): the usual
   * join screen, with the code filled in. Either way a prepared invitation
   * that asks for easy mode turns it on here, so setup is already easy.
   */
  async openPrepared(state, key) {
    const answer = await this.ask("/api/account/invitation", { code: cleanCode(state.draft.code) });
    if (this.state !== state) return;
    if (!answer) { state.step = "about"; return this.host.render(); }
    if (!answer.ok) {
      state.step = "about";
      state.problems = { code: `${answer.message} Ask the person who gave it to you to make a new one.` };
      return this.host.render();
    }
    const prepared = answer.value.prepared ?? null;
    if (prepared?.easyMode) this.turnOnEasyMode();
    const card = prepared ? await openCard(prepared.card, key) : null;
    if (this.state !== state) return;
    if (!card) { state.step = "about"; return this.host.render(); }
    state.prepared = { ...card, easyMode: Boolean(prepared.easyMode), memberKind: prepared.memberKind, expiresAt: prepared.expiresAt };
    state.draft.name = card.name;
    state.draft.username = suggestUsername(card.name, randomDigits());
    state.suggested = state.draft.username;
    state.step = "hello";
    this.host.render();
  }

  /** Easy mode from a prepared invitation: on this device at once (the
   * synced setting follows once the member's private storage opens,
   * app/private-prefs.js seeds it from this device). */
  turnOnEasyMode() {
    writeDisplayPref(EASY_MODE_KEY, "on");
    applyStoredDisplayPrefs();
    // The app's own easy mode (its marker and trimmed navigation), which is
    // already built behind this screen.
    this.host.closest?.("kin-app")?.ctx?.easy?.apply?.();
  }

  go(step, mode = this.state.mode) {
    this.state.step = step;
    this.state.mode = mode;
    this.state.problems = {};
    this.host.render();
  }

  render() {
    if (!this.state) this.reset();
    const { step } = this.state;
    this.host.dataset.firstRunStep = step;
    if (step === "opening") return this.renderOpening();
    if (step === "hello") return this.renderHello();
    if (step === "about") return this.renderAbout();
    if (step === "account") return this.renderAccount();
    return this.renderWelcome();
  }

  renderOpening() {
    this.host.heading.textContent = "Opening your invitation";
    const line = this.host.text("One moment…");
    line.setAttribute("role", "status");
  }

  /** "Hi Rose — your family set this up for you" (#615). */
  renderHello() {
    const { prepared } = this.state;
    this.host.heading.textContent = `Hi ${prepared.name} — your family set this up for you`;
    this.progress(1);
    this.host.text(`${prepared.helper} made Kin ready for you. Kin is where your family keeps lists, plans and messages. All you need to do is choose a password.`);
    if (prepared.note) {
      const note = this.host.text(`“${prepared.note}” — ${prepared.helper}`);
      note.className = "first-run-note";
    }
    const row = document.createElement("div");
    row.className = "first-run-actions";
    const go = document.createElement("button");
    go.type = "button";
    go.className = "primary-action";
    go.textContent = "Continue";
    go.addEventListener("click", () => this.go("account"));
    row.append(go);
    this.host.append(row);
    this.callLine();
    queueMicrotask(() => go.focus());
  }

  /** "If you get stuck, call Mikey." on every prepared screen. */
  callLine() {
    const helper = this.state?.prepared?.helper;
    if (!helper) return null;
    const line = this.host.text(`If you get stuck, call ${helper}.`);
    line.className = "first-run-call";
    return line;
  }

  renderWelcome() {
    this.host.heading.textContent = "Welcome to Kin";
    this.host.text("A private place for your household's lists, plans and messages.");
    const install = installHelp(currentPlatform());
    if (install) installHelpCard(install, { parent: this.host });
    const choices = document.createElement("div");
    choices.className = "household-choices first-run-choices";
    choices.append(
      this.choice("Start a new household", "Nobody in your household uses Kin yet.", () => this.go("about", "create"), "primary-action"),
      this.choice("I have an invitation", "Someone in your household invited you.", () => this.go("about", "join")),
      // A member on a new phone or a wiped browser (#568).
      this.choice("Sign in", "You already use Kin, on another device or one you lost.", () => this.ctx.signIn.start()),
    );
    this.host.append(choices);
    const other = this.host.text("Prefer a passkey, adding a device you already use, or signing in with your phone?");
    other.className = "household-choice-hint";
    this.host.button("Set up with a passkey instead", () => { this.host.legacySetup = true; this.host.render(); }, "secondary");
  }

  choice(label, hint, action, className = "") {
    const wrapper = document.createElement("div");
    wrapper.className = "household-choice";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (className) button.className = className;
    button.addEventListener("click", action);
    const text = document.createElement("p");
    text.className = "household-choice-hint";
    text.textContent = hint;
    wrapper.append(button, text);
    return wrapper;
  }

  renderAbout() {
    const create = this.state.mode === "create";
    this.host.heading.textContent = create ? "Start your household" : "Join your household";
    this.progress(1);
    const form = this.form(() => this.next());
    this.field(form, { key: "name", label: "Your name", autocomplete: "name", hint: "How your household sees you. You can change it later." });
    if (create)
      this.field(form, { key: "household", label: "Household name (optional)", autocomplete: "off", hint: "For example, The Lees or Our Home." });
    else
      this.field(form, { key: "code", label: "Invitation code", autocomplete: "one-time-code", hint: "From the person who invited you. Capital letters and dashes don't matter.", maxLength: 9 });
    this.actions(form, "Continue");
    this.host.append(form);
    this.focusFirst(form);
  }

  renderAccount() {
    const create = this.state.mode === "create";
    const prepared = this.state.prepared;
    this.host.heading.textContent = prepared ? "Choose a password" : "Choose how you'll sign in";
    this.progress(2);
    this.host.text(prepared
      ? "Your username is below; Kin chose it from your name, and you can change it. With your password, it opens Kin on another phone or computer."
      : "You'll use these to open Kin, here and on your other devices.");
    const form = this.form(() => this.submit());
    this.field(form, { key: "username", label: "Username", autocomplete: "username", hint: `${USERNAME_GUIDANCE}`, spellcheck: false, autocapitalize: "none" });
    this.field(form, { key: "password", label: "Password", type: this.state.showPassword ? "text" : "password", autocomplete: "new-password",
      hint: prepared ? `${PASSWORD_GUIDANCE} Write it down and keep it somewhere safe.` : PASSWORD_GUIDANCE,
      after: (input) => this.showPasswordToggle(input) });
    const tradeOff = document.createElement("p");
    tradeOff.className = "security-note";
    tradeOff.textContent = PASSWORD_TRADE_OFF;
    form.append(tradeOff);
    this.actions(form, create ? "Create household" : prepared ? "Continue" : "Join household");
    this.host.append(form);
    this.callLine();
    this.focusFirst(form);
  }

  /** "Show password" (#615): a pressed button that shows what was typed, so
   * nobody has to type it twice; kept while the screen re-renders. */
  showPasswordToggle(input) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "secondary show-password";
    toggle.setAttribute("aria-controls", input.id);
    const update = () => {
      toggle.textContent = this.state.showPassword ? "Hide password" : "Show password";
      toggle.setAttribute("aria-pressed", String(this.state.showPassword));
      input.type = this.state.showPassword ? "text" : "password";
    };
    toggle.addEventListener("click", () => {
      this.state.showPassword = !this.state.showPassword;
      update();
      input.focus();
    });
    update();
    return toggle;
  }

  progress(index) {
    const line = this.host.text(`Step ${index} of 2`);
    line.className = "first-run-progress";
  }

  form(onSubmit) {
    const form = document.createElement("form");
    form.className = "first-run-form";
    form.noValidate = true;
    form.setAttribute("aria-labelledby", "security-heading");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      onSubmit();
    });
    return form;
  }

  field(form, { key, label, type = "text", autocomplete, hint = "", maxLength = null, spellcheck = null, autocapitalize = null, after = null }) {
    const id = `first-run-${key}`;
    const wrapper = document.createElement("div");
    wrapper.className = "first-run-field";
    const caption = document.createElement("label");
    caption.htmlFor = id;
    caption.textContent = label;
    const input = document.createElement("input");
    input.id = id;
    input.name = key;
    input.type = type;
    input.autocomplete = autocomplete;
    input.value = this.state.draft[key] ?? "";
    if (maxLength) input.maxLength = maxLength;
    if (spellcheck !== null) input.spellcheck = spellcheck;
    if (autocapitalize) input.setAttribute("autocapitalize", autocapitalize);
    if (key !== "household") input.required = true;
    input.addEventListener("input", () => { this.state.draft[key] = input.value; });
    const described = [];
    // A control that belongs right after the field (Show password).
    const extra = after ? [after(input)] : [];
    if (hint) {
      const help = document.createElement("p");
      help.id = `${id}-hint`;
      help.className = "security-note";
      help.textContent = hint;
      described.push(help.id);
      wrapper.append(caption, input, ...extra, help);
    } else wrapper.append(caption, input, ...extra);
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

  actions(form, label) {
    const row = document.createElement("div");
    row.className = "first-run-actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "primary-action";
    submit.textContent = label;
    const back = document.createElement("button");
    back.type = "button";
    back.className = "secondary";
    back.textContent = "Back";
    back.addEventListener("click", () => this.go(this.state.step === "account" ? (this.state.prepared ? "hello" : "about") : "welcome"));
    row.append(submit, back);
    form.append(row);
  }

  /** Focuses the first field with a problem, or the first field. */
  focusFirst(form) {
    const target = form.querySelector?.('[aria-invalid="true"]') ?? form.querySelector?.("input");
    queueMicrotask(() => target?.focus());
  }

  showProblems(problems) {
    this.state.problems = problems;
    this.host.render();
  }

  async next() {
    const problems = firstRunProblems("about", this.state.mode, this.state.draft);
    if (Object.keys(problems).length) return this.showProblems(problems);
    if (this.state.mode === "join") {
      // A wrong code is said here, before a password is chosen.
      const answer = await this.ask("/api/account/invitation", { code: cleanCode(this.state.draft.code) });
      if (!answer) return;
      if (!answer.ok) return this.showProblems({ code: answer.message });
      if (answer.value.purpose !== "adult")
        return this.showProblems({ code: "This code adds a device to an existing member. Go back and choose Set up with a passkey instead." });
      // A prepared invitation typed by hand (no card key): its easy mode
      // still applies (#615).
      if (answer.value.prepared?.easyMode) this.turnOnEasyMode();
    }
    this.go("account");
  }

  /** Posts to the service before anything exists locally. Resolves to
   * `{ ok, value, message }`, or null after reporting no connection. */
  async ask(path, body) {
    let response;
    try {
      response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    } catch {
      this.host.alert.textContent = "Kin can't reach your household service right now. Check your connection and try again.";
      return null;
    }
    const value = await response.json().catch(() => ({}));
    return { ok: response.ok, value, message: value.message ?? "Kin couldn't check that. Try again." };
  }

  async submit() {
    const problems = firstRunProblems("account", this.state.mode, this.state.draft);
    if (Object.keys(problems).length) return this.showProblems(problems);
    if (this.host.busy) return;
    let available = await this.ask("/api/account/username", { username: this.state.draft.username });
    // The username Kin chose from their name (#615) is chosen again, quietly,
    // if someone already has it.
    for (let tries = 0; this.state.prepared && available?.ok && !available.value.available &&
        this.state.draft.username === this.state.suggested && tries < 3; tries += 1) {
      this.state.draft.username = this.state.suggested = suggestUsername(this.state.prepared.name, randomDigits());
      available = await this.ask("/api/account/username", { username: this.state.draft.username });
    }
    if (!available) return;
    if (!available.ok) return this.showProblems({ username: available.message });
    if (!available.value.available) return this.showProblems({ username: "That username is taken. Try another." });
    await this.host.run(() => this.establish());
  }

  /**
   * Makes this device's encrypted storage from the password and opens it,
   * then hands the sign-up to the application (security.services) to finish
   * with the service once the household panel is up.
   */
  async establish() {
    const operation = this.host.operation;
    const { mode, draft } = this.state;
    this.host.message.textContent = "Setting up your household on this device…";
    const signUp = await prepareSignUp({ username: draft.username, password: draft.password });
    let vault;
    try {
      this.host.assertCurrentOperation(operation);
      ({ vault } = await LocalVault.createWithPassword(signUp.localKek,
        { salt: toBase64Url(signUp.salt), iterations: signUp.iterations, username: signUp.username }));
      signUp.localKek.fill(0);
      this.host.assertCurrentOperation(operation);
      await EventStore.prepareSecurity(vault.manifest);
      this.host.assertCurrentOperation(operation);
      this.host.manifest = await EventStore.securityStatus();
    } catch (error) {
      vault?.lock();
      wipeSignUp(signUp);
      throw error;
    }
    const pending = {
      mode,
      displayName: draft.name.trim(),
      householdName: draft.household.trim(),
      code: mode === "join" ? cleanCode(draft.code) : null,
      signUp,
      // Set up by someone else (#615): their name, for the waiting screen
      // and "who to call".
      prepared: this.state.prepared ? { name: this.state.prepared.name, helper: this.state.prepared.helper } : null,
    };
    // The typed password is no longer needed: its keys are.
    draft.password = "";
    this.state = null;
    await this.ctx.unlock.finishUnlock(vault, operation);
    this.host.services?.completeFirstRun?.(pending);
  }
}
