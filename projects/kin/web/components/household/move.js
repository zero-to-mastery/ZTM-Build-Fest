// Moving the household to a home server (ADR 0026, #737, #738), and what
// every member sees on the old address once it moves.
// Part of <kin-household>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-household.js lists them).
//
// The admin's screen shows who can sign in at the new address (a password
// or a backup code; passkeys belong to this address), asks for the home
// server's address and the move code its control panel printed, confirms
// with a fresh passkey or password, and follows the move. Once it moved,
// the household panel shows where to go; an admin can undo the move for a
// day, or close the old household.
import { confirmWith, freshConfirmation } from "./fresh-confirmation.js";
import { memberLabels, misleadingMemberName } from "./member-labels.js";

const POLL_MS = 2_000;

/** Plain words for every code a move can end with. */
export const MOVE_MESSAGES = Object.freeze({
  "move-address-invalid": "Type the home server's address, such as fern.home.kin.journeytocode.io.",
  "move-address-refused": "That address leads to a private or local network. Use the home server's public address, shown in its control panel.",
  "move-unreachable": "Kin couldn't reach the home server. Check that it shows Connected in its control panel, then try again.",
  "move-timeout": "The home server took too long to answer. Try again.",
  "move-not-kin": "That address didn't answer as a Kin home server. Check the address in its control panel.",
  "move-code-wrong": "That move code isn't right. Check it in the home server's window or log.",
  "move-code-expired": "That move code has expired. Get a new one in the home server's control panel.",
  "move-code-locked": "Too many wrong tries. Get a new move code in the home server's control panel.",
  "move-code-none": "That move code was already used. Get a new one in the home server's control panel.",
  "move-code-malformed": "A move code is 10 letters and digits, like ABCDE-23456.",
  "move-busy": "The home server is taking another household right now. Try again later.",
  "move-too-large": "This household is larger than the home server takes (4 GB).",
  "move-no-space": "The home server's disk doesn't have room for this household.",
  "move-household-limit": "The home server's household limit is reached. Raise it in its control panel, under New households.",
  "move-newer": "The home server runs an older Kin. Update it, then try again.",
  "move-invalid": "The home server couldn't open what arrived. Try again.",
  "move-clash": "The home server already has this household, or one of its members or devices.",
  "move-username-taken": "Someone on the home server already uses one of this household's usernames.",
  "move-checksum": "The household arrived damaged. Try again.",
  "move-interrupted": "Kin restarted while sending the household, so it stayed here. Try again.",
  "move_no_ready_admin": "At least one household admin needs a password or a backup code to sign in at the new address.",
  "move_exists": "This household is already moving or has moved.",
  "move_undo_expired": "A move can be undone only within a day of it.",
});

export const moveMessage = (code) => MOVE_MESSAGES[code] ?? "The move didn't work. Nothing changed here; try again.";

const READY_WORDS = { password: "can sign in with their password", "backup-code": "can sign in with their backup code" };

export class HouseholdMove {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  /** Display names by member ID, from the household's own history. */
  async #names(members) {
    const labels = memberLabels(members.map((member) => ({ id: member.memberId, kind: member.kind, active: true, current: member.memberId === this.host.identity?.memberId })), this.host.identity?.memberId);
    try {
      for (const { memberId, preferredName } of await this.host.memberNames?.load?.() ?? [])
        if (preferredName && !misleadingMemberName(preferredName)) labels.set(memberId, memberId === this.host.identity?.memberId ? `${preferredName} (you)` : preferredName);
    } catch { /* the generic labels will do */ }
    return labels;
  }

  /** The admin's screen: readiness, then the address and the code. */
  async show() {
    clearTimeout(this.host.poll);
    clearInterval(this.host.timer);
    const generation = this.host.viewGeneration = (this.host.viewGeneration ?? 0) + 1;
    await this.host.run(async () => {
      const { readiness, move } = await this.host.api("/api/household/move");
      if (this.host.viewGeneration !== generation) return;
      if (move.state === "sending") return this.#following(generation);
      this.host.replaceChildren();
      const heading = document.createElement("h2");
      heading.textContent = "Move to a home server";
      this.host.append(heading);
      this.host.text("Move this household to a Kin home server: a computer at home that runs Kin. Everyone keeps their account and everything in Kin. Each person then signs in at the new address with their username and password, or their backup code, and adds a new passkey there: passkeys belong to this address.");
      if (move.lastError) this.host.message(moveMessage(move.lastError.code) + (Number.isInteger(move.lastError.attemptsLeft) ? ` ${move.lastError.attemptsLeft} more ${move.lastError.attemptsLeft === 1 ? "try" : "tries"} with that code.` : ""), true);
      const labels = await this.#names(readiness.members);
      const section = document.createElement("section");
      const title = document.createElement("h3");
      title.textContent = "Who can sign in there";
      const list = document.createElement("ul");
      list.className = "move-readiness";
      for (const member of readiness.members) {
        const item = document.createElement("li");
        item.dataset.memberId = member.memberId;
        item.dataset.ready = member.ready ? "yes" : "no";
        const name = labels.get(member.memberId) ?? "A member";
        item.textContent = member.ready
          ? `${name} ${READY_WORDS[member.ready]}.`
          : member.account
            ? `${name} has only a passkey. Ask them to save a backup code first (Security › Backup code), or re-join with an invitation after the move.`
            : `${name} has no account yet, so they re-join with an invitation after the move.`;
        list.append(item);
      }
      section.append(title, list);
      this.host.append(section);
      if (!readiness.canStart) {
        this.host.text("At least one household admin needs a password or a backup code before the household can move, so somebody can sign in at the new address.");
        this.host.append(this.host.makeButton("Back", () => this.ctx.membership.showHousehold(), "secondary"));
        return;
      }
      this.host.append(this.#form(), this.host.makeButton("Back", () => this.ctx.membership.showHousehold(), "secondary"));
    });
  }

  #form() {
    const form = document.createElement("form");
    form.className = "move-form";
    const field = (id, label, hint, attributes) => {
      const wrapper = document.createElement("p");
      const labelElement = document.createElement("label");
      labelElement.htmlFor = id;
      labelElement.textContent = label;
      const input = Object.assign(document.createElement("input"), { id, required: true, autocomplete: "off", spellcheck: false, ...attributes });
      const hintElement = document.createElement("span");
      hintElement.className = "hint";
      hintElement.id = `${id}-hint`;
      hintElement.textContent = hint;
      input.setAttribute("aria-describedby", hintElement.id);
      wrapper.append(labelElement, input, hintElement);
      return { wrapper, input };
    };
    const address = field("move-address", "Home server's address", "Shown in its control panel, such as fern.home.kin.journeytocode.io.", { type: "text", inputMode: "url" });
    const code = field("move-code", "Move code", "In the home server's control panel, choose Get a move code; Kin prints it in its window and log.", { type: "text", autocapitalize: "characters", maxLength: 11 });
    const submit = Object.assign(document.createElement("button"), { type: "submit", textContent: "Move the household" });
    form.append(address.wrapper, code.wrapper, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.start(address.input.value, code.input.value);
    });
    return form;
  }

  /** Confirms freshly, starts the move, and follows it. */
  async start(address, code) {
    if (!confirm(`Move this household to ${address.trim()}? While it moves, nobody can make changes. Afterwards everyone signs in there, and this address stops syncing (an admin can undo the move for a day).`)) return;
    let failed = false;
    await this.host.run(async () => {
      try {
        const started = await this.host.api("/api/household/move/options", { method: "POST", body: JSON.stringify({ address }) });
        this.host.message(`Confirm the move with ${confirmWith(started)}.`);
        const proof = await freshConfirmation(started, { signal: this.host.connectionAbort.signal });
        await this.host.api("/api/household/move/finish", { method: "POST", body: JSON.stringify({ flow: started.flow, code, ...proof }) });
      } catch (error) {
        if (MOVE_MESSAGES[error.code]) { failed = true; this.host.message(moveMessage(error.code), true); return; }
        throw error;
      }
    });
    if (!failed) await this.#following(this.host.viewGeneration);
  }

  /** While the household goes: progress, until it moved or came back. */
  async #following(generation) {
    this.host.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = "Moving the household";
    this.host.append(heading);
    const status = this.host.text("Sending the household to the home server…");
    status.setAttribute("role", "status");
    const tick = async () => {
      if (this.host.viewGeneration !== generation) return;
      let state;
      try { state = await this.host.api("/api/household/move"); } catch (error) {
        // Once it moved, this session is refused: the status says where.
        if (error.code === "household_moved") return this.host.load();
        this.host.poll = setTimeout(tick, POLL_MS);
        return;
      }
      const { move } = state;
      if (move.state === "sending") {
        const progress = move.progress;
        status.textContent = progress?.size ? `Sending the household to the home server: ${Math.floor((progress.sent / progress.size) * 100)}%.` : "Getting the household ready to send…";
        this.host.poll = setTimeout(tick, POLL_MS);
        return;
      }
      if (move.state === "moved") return this.host.load();
      // Not moved: show why, on the move screen.
      return this.show();
    };
    this.host.poll = setTimeout(tick, POLL_MS);
  }

  /** Every member, on the old address, while the household is moving. */
  renderMoving() {
    const heading = document.createElement("h2");
    heading.textContent = "Your household is moving";
    this.host.append(heading);
    const status = this.host.text(`Your household is moving to ${this.host.householdLifecycle.movedTo}. Changes wait until it's done; this takes a few minutes.`);
    status.setAttribute("role", "status");
    clearTimeout(this.host.poll);
    this.host.poll = setTimeout(() => this.host.load(), POLL_MS * 5);
  }

  /** Every member, on the old address, once the household moved. */
  renderMoved() {
    const lifecycle = this.host.householdLifecycle;
    const heading = document.createElement("h2");
    heading.textContent = "Your household moved";
    this.host.append(heading);
    const status = this.host.text(`Your household moved to ${lifecycle.movedTo}. Everything in Kin is there now, and this address no longer syncs.`);
    status.setAttribute("role", "status");
    const link = Object.assign(document.createElement("a"), { href: lifecycle.movedTo, className: "primary-action move-open", textContent: `Open ${lifecycle.movedTo}`, rel: "noopener" });
    this.host.append(link);
    const steps = document.createElement("ol");
    for (const text of [
      `Open ${lifecycle.movedTo} on this device.`,
      "Sign in with your username and password, or your backup code, and choose Add this as a new device.",
      "Add a passkey there when Kin offers: your passkey for this address doesn't work at the new one.",
      "Install Kin from the new address, and remove this one from your home screen.",
    ]) steps.append(Object.assign(document.createElement("li"), { textContent: text }));
    this.host.append(steps);
    this.host.text("No password or backup code? Ask a household admin to send you an invitation from the new address.");
    this.host.text("Anything you changed on this device while it was offline, and that never reached the household before it moved, is still only here: export the household (Security › Backup and move) if you want a copy.");
    if (!lifecycle.admin) return;
    const now = Date.now();
    if (Date.parse(lifecycle.remindAt) <= now)
      this.host.text("It's been a week since the move. Once everyone is signing in at the new address, close the household here.");
    if (Date.parse(lifecycle.undoUntil) > now)
      this.host.append(this.host.makeButton(`Undo the move (until ${new Date(lifecycle.undoUntil).toLocaleString()})`, () => this.undo(), "secondary"));
    this.host.append(this.host.makeButton("Close the household here", () => this.close(), "danger"));
  }

  async #afterMove(action, path) {
    await this.host.run(async () => {
      const started = await this.host.api(`/api/household/move/${path}/options`, { method: "POST", body: "{}" });
      this.host.message(`Confirm with ${confirmWith(started)} to ${action}.`);
      const proof = await freshConfirmation(started, { signal: this.host.connectionAbort.signal });
      const result = await this.host.api(`/api/household/move/${path}/finish`, { method: "POST", body: JSON.stringify({ flow: started.flow, ...proof }) });
      if (path === "close") {
        this.host.householdLifecycle = { state: "deletion_pending", finalizeAt: result.finalizeAt, message: result.message };
        this.host.render();
      } else {
        // In use here again: sign in on this device as usual.
        location.reload();
      }
    });
  }

  undo() {
    if (!confirm("Undo the move? The household is used at this address again. The home server keeps its copy: remove it there yourself, and anything added there since the move stays there.")) return Promise.resolve();
    return this.#afterMove("undo the move", "undo");
  }

  close() {
    if (!confirm("Close the household at this address? Do this once everyone is signing in at the new address. Kin deletes its copy here after 30 days.")) return Promise.resolve();
    return this.#afterMove("close the household here", "close");
  }
}
