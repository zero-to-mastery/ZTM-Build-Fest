// The control panel's settings (ADR 0025 §9, §11; #718). Every change
// needs a fresh confirmation: on this computer a code Kin prints in its
// window and log, through the household's address the admin's passkey or
// password (control-api.js). Each entry in SETTINGS is one change: the
// new-household limit; backups (#721): back up now, the daily time, the
// second folder (#763, on this computer only: `available` and
// `unavailable` are given the API as well) and restore; and updates
// (#722): install now, and automatic updates. An entry without a
// `field` is a button alone; `action` names the button and `done(result)`
// says what happened.
//
// `kinds`, when set, shows only those entries: the setup screen shows
// "restore" alone, for moving a home server to a new computer.
import { el } from "./dom.js";
import { explain } from "./explain.js";
import { countOf, formatDateTime, formatHour } from "./format.js";

const backupsReady = (status) => Array.isArray(status.backups?.backups) && !["restoring", "not-built", "error"].includes(status.backups.state);

export const SETTINGS = [
  {
    kind: "households-limit",
    title: "New households",
    describe: (status) => `People can create up to ${countOf(status.limits?.maxHouseholds ?? 1, "household", "households")} on this home server. Raise it to give, say, grandparents a household of their own here. Invitations into existing households work either way.`,
    available: (status) => !status.limits?.fromEnvironment,
    unavailable: () => explain("control-limit-from-environment"),
    field: (status) => {
      const select = el("select", { id: "control-setting-households-limit", name: "maxHouseholds" });
      const highest = status.limits?.highest ?? 10;
      for (let value = 1; value <= highest; value += 1)
        select.append(el("option", { value: String(value), selected: value === status.limits?.maxHouseholds, text: countOf(value, "household", "households") }));
      return { label: "Households allowed", control: select };
    },
    change: (control) => ({ kind: "households-limit", maxHouseholds: Number(control.value) }),
  },
  {
    kind: "backup-now",
    title: "Back up now",
    describe: () => "Make a backup straight away, as well as the daily one. Kin keeps the 14 newest.",
    available: (status) => backupsReady(status) && status.backups.state !== "off",
    unavailable: (status) => (status.backups?.state === "off" ? "Backups start once this home server is set up." : "Backups aren't available right now."),
    action: "Back up now",
    change: () => ({ kind: "backup-now" }),
    done: (result) => `Backup made: ${formatDateTime(result?.backup?.createdAt)}.`,
  },
  {
    kind: "backup-hour",
    title: "Daily backup time",
    describe: () => "Kin backs up once a day at this time. If the computer is off or asleep then, Kin backs up soon after it starts again.",
    available: (status) => backupsReady(status) && Number.isInteger(status.backups.hour),
    unavailable: () => "Backups aren't available right now.",
    field: (status) => {
      const select = el("select", { id: "control-setting-backup-hour", name: "hour" });
      for (let hour = 0; hour < 24; hour += 1)
        select.append(el("option", { value: String(hour), selected: hour === status.backups.hour, text: formatHour(hour) }));
      return { label: "Back up every day at", control: select };
    },
    change: (control) => ({ kind: "backup-hour", hour: Number(control.value) }),
  },
  {
    // #763: chosen on the home server's own computer only. The copies hold
    // every household's data and the home key, and only that panel is
    // shown the folder's path.
    kind: "backup-copy-folder",
    title: "Copy backups to another folder",
    describe: () => "Kin copies each backup to this folder too, such as a USB drive, so a broken disk doesn't take your backups with it. It keeps the 14 newest there, in a folder called “Kin backups”, and never touches your other files. Leave it empty to stop copying.",
    available: (status, api) => Boolean(api?.loopback) && Boolean(status.backups?.copy) && backupsReady(status),
    unavailable: (status, api) => (api?.loopback ? "Backups aren't available right now." : "Choose this folder on the home server's own computer."),
    field: (status) => {
      const input = el("input", { id: "control-setting-backup-copy-folder", name: "folder", type: "text", value: status.backups.copy.folder ?? "", spellcheck: false, autocomplete: "off" });
      return { label: "Folder, by its full path (such as E:\\ or /media/usb)", control: input };
    },
    change: (control) => ({ kind: "backup-copy-folder", folder: control.value.trim() === "" ? null : control.value.trim() }),
    done: (result) => (result?.folder ? "Kin checks the folder and copies your backups there within a minute." : "Kin doesn't copy backups to another folder now. Copies already there stay."),
  },
  {
    kind: "restore",
    title: "Restore a backup",
    describe: () => "Puts Kin back as it was when the backup was made. Kin stops for a moment and starts again. Anything added since then comes back from people's phones and computers when they next connect, and households deleted since then stay deleted. Kin keeps the data it replaces in its folder.",
    available: (status) => backupsReady(status) && status.backups.backups.length > 0,
    unavailable: (status) => (status.backups?.state === "restoring" ? "Kin is restoring a backup now." : "There's no backup to restore yet."),
    field: (status) => {
      const select = el("select", { id: "control-setting-restore", name: "id" });
      for (const backup of status.backups.backups)
        select.append(el("option", { value: backup.id, text: `${formatDateTime(backup.createdAt)}${backup.reason === "manual" ? " (made by hand)" : ""}` }));
      return { label: "Backup to restore", control: select };
    },
    action: "Restore",
    change: (control) => ({ kind: "restore", id: control.value }),
    done: () => "Kin is starting again to restore the backup. This page comes back by itself in a minute.",
  },
  {
    kind: "update-install",
    title: "Install the update",
    describe: (status) => `Installs Kin ${status.updates.available.version} now. Kin backs up, stops for a moment, and tries the new version for five minutes; it keeps it only if it works, and otherwise goes back to this version and its data.`,
    available: (status) => Boolean(status.updates?.available) && status.updates.available.install !== "manual" && status.updates.state !== "installing",
    unavailable: (status) => (status.updates?.state === "installing" ? "Kin is installing an update now." : "Download the new version from the releases page: this copy of Kin can't update itself."),
    hidden: (status) => !status.updates?.available,
    action: "Install now",
    change: (control, status) => ({ kind: "update-install", version: status.updates.available.version }),
    done: () => "Kin starts installing within a minute. The status above shows how it goes.",
  },
  {
    kind: "auto-update",
    title: "Automatic updates",
    describe: () => "Smaller updates (fixes and new features) can install by themselves at night, after a backup. Bigger ones always wait for you.",
    available: (status) => Boolean(status.updates) && status.updates.state !== "off",
    unavailable: () => "This build of Kin doesn't check for updates.",
    hidden: (status) => !status.updates || status.updates.state === "off",
    field: (status) => {
      const select = el("select", { id: "control-setting-auto-update", name: "enabled" });
      select.append(
        el("option", { value: "on", selected: status.updates.autoUpdate !== false, text: "On: install at night" }),
        el("option", { value: "off", selected: status.updates.autoUpdate === false, text: "Off: wait for me" }));
      return { label: "Smaller updates", control: select };
    },
    change: (control) => ({ kind: "auto-update", enabled: control.value === "on" }),
  },
];

/** What, in the status, the settings show: they redraw only when it changes. */
const shown = (status) => JSON.stringify([
  status?.limits, status?.backups?.state === "restoring", status?.backups?.hour, status?.backups?.backups?.map((backup) => backup.id), status?.backups?.copy?.folder,
  status?.updates?.state === "installing", status?.updates?.state === "off", status?.updates?.autoUpdate, status?.updates?.available?.version, status?.updates?.available?.install,
]);

export class KinControlSettings extends HTMLElement {
  #status = null;

  constructor() {
    super();
    this.api = null;
    this.busy = false;
    this.pending = null;
    this.kinds = null;
    this.heading = "Settings";
  }

  get status() { return this.#status; }
  set status(value) {
    const before = this.#status;
    this.#status = value;
    // Redraw only when a setting's value changed, and never under a change
    // someone is confirming.
    if (before === null || (!this.busy && !this.pending && shown(before) !== shown(value))) this.render();
  }

  render() {
    const status = this.#status;
    if (!status) { this.replaceChildren(); return; }
    // A change's own result redraws the settings (a new backup to restore):
    // what was just said, and where focus was, stay.
    this.message ??= el("p", { className: "control-message", role: "status" });
    const focused = this.contains?.(document.activeElement) ? document.activeElement.closest?.("[data-setting]")?.dataset.setting : null;
    const settings = SETTINGS.filter((setting) => (!this.kinds || this.kinds.includes(setting.kind)) && !setting.hidden?.(status));
    this.replaceChildren(
      el("h2", { id: this.kinds ? `control-settings-title-${this.kinds.join("-")}` : "control-settings-title", text: this.heading }),
      el("p", { className: "control-muted", text: this.api?.loopback
        ? "Each change asks for a confirmation code that Kin prints in its window and log on this computer."
        : "Each change asks you to confirm with your passkey or password." }),
      ...settings.map((setting) => this.#setting(setting, status)),
      this.message,
    );
    if (focused) this.querySelector(`[data-setting="${focused}"] button`)?.focus();
  }

  #setting(setting, status) {
    const section = el("section", { className: "control-card", "data-setting": setting.kind, "aria-labelledby": `setting-${setting.kind}` },
      el("h3", { id: `setting-${setting.kind}`, text: setting.title }),
      el("p", { text: setting.describe(status) }));
    if (!setting.available(status, this.api)) {
      section.append(el("p", { className: "control-muted", text: setting.unavailable(status, this.api) }));
      return section;
    }
    const { label, control } = setting.field?.(status) ?? {};
    const save = el("button", { type: "submit", className: "primary-action", text: setting.action ?? "Save" });
    const form = el("form", { className: "control-form", onsubmit: (event) => { event.preventDefault(); this.save(setting.change(control, this.#status), save, form, setting.done); } },
      ...(control ? [el("label", { for: control.id, text: label }), control] : []),
      el("div", { className: "control-actions" }, save));
    section.append(form);
    return section;
  }

  #say(text, alert = false) {
    this.message.setAttribute("role", alert ? "alert" : "status");
    this.message.textContent = text;
  }

  /** Saves `change` after a fresh confirmation. On this computer that is
   * a printed code, asked for in a small form under the setting. */
  async save(change, button, form, done = () => "Saved.") {
    if (this.busy) return;
    if (this.api.loopback) { await this.#askForCode(change, form, done); return; }
    this.busy = true;
    button.disabled = true;
    this.#say("Confirm the change when Kin asks.");
    try {
      this.#say(done(await this.api.change(change)));
      this.dispatchEvent(new CustomEvent("changed", { bubbles: true }));
    } catch (error) {
      this.#say(error?.name === "NotAllowedError" ? "Cancelled. Nothing changed." : explain(error.code), true);
    } finally {
      this.busy = false;
      button.disabled = false;
    }
  }

  async #askForCode(change, form, done) {
    try {
      await this.api.post("confirm-code");
    } catch (error) {
      if (error.code !== "control-code-too-soon") { this.#say(explain(error.code), true); return; }
    }
    this.pending = change;
    form.parentNode?.querySelector?.(".control-confirm")?.remove();
    const input = el("input", { id: `control-confirm-${change.kind}`, type: "text", autocomplete: "one-time-code", autocapitalize: "characters", spellcheck: false, required: true, maxLength: 11 });
    const confirm = el("button", { type: "submit", className: "primary-action", text: "Confirm" });
    const cancel = el("button", { type: "button", className: "secondary", text: "Cancel", onclick: () => { this.pending = null; box.remove(); this.#say("Cancelled. Nothing changed."); } });
    const box = el("form", { className: "control-form control-confirm", onsubmit: async (event) => {
      event.preventDefault();
      if (this.busy) return;
      this.busy = true;
      confirm.disabled = true;
      try {
        const result = await this.api.change(this.pending, { code: input.value });
        this.pending = null;
        box.remove();
        this.#say(done(result));
        this.dispatchEvent(new CustomEvent("changed", { bubbles: true }));
      } catch (error) {
        this.#say(`${explain(error.code)}${Number.isInteger(error.attemptsLeft) ? ` ${error.attemptsLeft} more ${error.attemptsLeft === 1 ? "try" : "tries"}.` : ""}`, true);
        input.focus();
      } finally {
        this.busy = false;
        confirm.disabled = false;
      }
    } },
      el("label", { for: input.id, text: "Confirmation code" }),
      el("p", { className: "control-hint", text: "Kin printed it in its window and log on this computer just now." }),
      input,
      el("div", { className: "control-actions" }, confirm, cancel));
    if (typeof form.after === "function") form.after(box);
    else form.parentNode?.append(box);
    input.focus();
  }
}

if (!customElements.get("kin-control-settings")) customElements.define("kin-control-settings", KinControlSettings);
