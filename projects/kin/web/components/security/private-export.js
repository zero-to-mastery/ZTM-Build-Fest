// "Your private things" under Backup and move (#493: #494, #495): saving the
// member's own export of their private log (journal, Just for me, reminders
// and settings that follow them, and journal photos as space allows), and
// restoring one. Shown only where this device has the member's private
// storage open. The household export and restore beside it never touch any
// of this (private/private-export.js).
// Part of <kin-security>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-security.js lists them).
import { openVault, wipeVaultContents } from "../../security/account-vault.js";
import { refreshVault, vaultApi } from "../../security/account-vault-sync.js";
import { toBase64Url } from "../../security/local-vault.js";
import {
  describePrivateArchive,
  exportPrivateArchive,
  MAX_PRIVATE_EXPORT_BYTES,
  openPrivateArchive,
  privateExportFileName,
  restorePrivateArchive,
} from "../../private/private-export.js";

export class SecurityPrivateExport {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  app() { return this.host.closest("kin-app"); }

  /** The member's open private log, when it can be used here. */
  log() {
    const log = this.app()?.syncCoordinator?.privateLog ?? null;
    return log?.active ? log : null;
  }

  /** The section's part under Backup and move, or nothing. */
  render(parent) {
    if (!this.log()) return;
    const heading = document.createElement("h3");
    heading.textContent = "Your private things";
    const note = document.createElement("p");
    note.className = "security-note";
    note.textContent = "Your journal, your Just for me list, and the reminders and settings that follow you. Household exports never include them. Save your own copy: only you can open it, on your devices or with your account backup code.";
    parent.append(heading, note);
    this.host.button("Save my private things", () => this.host.run(() => this.save()), "", parent);
    this.host.button("Restore my private things", () => this.showRestore(), "", parent);
  }

  /** Builds the file and offers it as a download (#494). */
  async save() {
    const operation = this.host.operation;
    const app = this.app();
    const log = this.log();
    if (!log) throw new Error("Your private things aren't open on this device.");
    this.host.message.textContent = "Saving your private things…";
    const envelopes = (await log.store.eventsFrom(1, 0)).map((row) => row.envelope);
    const blobs = await this.photos(app);
    this.host.assertCurrentOperation(operation);
    const backupCode = await this.backupCode(app, log).catch(() => null);
    let result;
    try {
      result = await exportPrivateArchive({ identity: log.identity, envelopes, memberKey: log.ring.current(), blobs, backupCode });
    } finally {
      backupCode?.vaultKey.fill(0);
      for (const entry of backupCode?.memberKeys ?? []) entry.key.fill(0);
    }
    this.host.assertCurrentOperation(operation);
    const { bytes, header } = result;
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = privateExportFileName(header.exportedAt);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const photos = header.blobCount ? ` and ${header.blobCount.toLocaleString()} journal ${header.blobCount === 1 ? "photo" : "photos"}` : "";
    const left = header.blobsLeftOut
      ? ` ${header.blobsLeftOut.toLocaleString()} journal ${header.blobsLeftOut === 1 ? "photo didn't" : "photos didn't"} fit in the file and ${header.blobsLeftOut === 1 ? "isn't" : "aren't"} included; ${header.blobsLeftOut === 1 ? "it stays" : "they stay"} in your account.`
      : "";
    const opens = header.backupCode
      ? "It opens on your devices, or with your account backup code."
      : "It opens on your devices. Make a backup code to be able to open it without them.";
    this.host.message.textContent = `Saved ${header.eventCount.toLocaleString()} private ${header.eventCount === 1 ? "change" : "changes"}${photos}. ${opens}${left}`;
    this.host.lastPrivateExport = header;
  }

  /** Every journal photo this device can reach: kept here, or fetched. */
  async photos(app) {
    const journal = app.ctx?.journal;
    const blobs = journal?.blobs;
    if (!blobs) return [];
    const wanted = journal.keptRefs?.() ?? new Set();
    const kept = await blobs.store.entries().catch(() => []);
    const found = new Map(kept.filter((entry) => wanted.has(entry.ref)).map((entry) => [entry.ref, entry]));
    for (const ref of wanted) {
      if (found.has(ref)) continue;
      try {
        const fetched = await blobs.client.download(ref);
        if (fetched.ciphertext) found.set(ref, { ref, ciphertext: fetched.ciphertext, storedAt: 0 });
      } catch { /* left out and counted below as not found */ }
    }
    return [...found.values()];
  }

  /** `{ vaultKey, wrapper, memberKeys }` when the member has a backup code
   * and this device holds their vault key; else null. Needs a connection. */
  async backupCode(app, log) {
    const identity = log.identity;
    const vaultKey = await app.household?.syncKeyStore?.accountVaultKey(identity.householdId);
    if (!vaultKey) return null;
    try {
      const download = await vaultApi().download();
      const wrapper = download.wrappers.find((entry) => entry.type === "backup-code");
      if (!wrapper || !download.vault) { vaultKey.fill(0); return null; }
      const contents = await openVault(vaultKey, download.vault.ciphertext, { householdId: identity.householdId, memberId: identity.memberId, version: download.vault.version });
      const memberKeys = contents.memberKeys.map((entry) => ({ ...entry, key: entry.key.slice() }));
      wipeVaultContents(contents);
      return { vaultKey, wrapper: { ...wrapper, wrapped: toBase64Url(wrapper.wrapped) }, memberKeys };
    } catch (error) {
      vaultKey.fill(0);
      throw error;
    }
  }

  /** The restore form (#495): a file, and the backup code only if asked. */
  showRestore() {
    if (this.host.busy) return;
    this.host.render();
    this.host.heading.textContent = "Restore my private things";
    this.host.text("Choose a file you saved with “Save my private things”. Kin adds what isn't here yet; nothing is duplicated, and nothing of your household changes.");
    const form = document.createElement("form");
    form.className = "private-restore";
    const fileLabel = document.createElement("label");
    const file = document.createElement("input");
    Object.assign(file, { id: "private-export-file", type: "file", accept: ".kinp", required: true });
    file.setAttribute("aria-describedby", "private-export-about security-alert");
    fileLabel.htmlFor = file.id;
    fileLabel.textContent = "Your private things file";
    const about = document.createElement("p");
    about.id = "private-export-about";
    about.className = "security-note";
    about.setAttribute("role", "status");
    about.hidden = true;
    const codeRow = document.createElement("div");
    codeRow.hidden = true;
    const codeLabel = document.createElement("label");
    const code = document.createElement("input");
    Object.assign(code, { id: "private-export-code", type: "password", autocomplete: "off", spellcheck: false });
    code.setAttribute("aria-describedby", "private-export-code-hint security-alert");
    codeLabel.htmlFor = code.id;
    codeLabel.textContent = "Account backup code";
    const codeHint = document.createElement("p");
    codeHint.id = "private-export-code-hint";
    codeHint.className = "security-note";
    codeHint.textContent = "Only needed if this device doesn't hold the key the file was saved with.";
    codeRow.append(codeLabel, code, codeHint);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "primary-action";
    submit.textContent = "Restore";
    file.addEventListener("change", () => {
      about.hidden = true;
      const selected = file.files[0];
      if (!selected) return;
      void selected.arrayBuffer().then((buffer) => {
        const described = describePrivateArchive(new Uint8Array(buffer));
        const made = new Date(described.exportedAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
        about.textContent = `Saved on ${made}: ${described.eventCount.toLocaleString()} private changes and ${described.blobCount.toLocaleString()} journal photos.`;
      }).catch((error) => { about.textContent = error?.userMessage ?? "Kin couldn't read this file."; })
        .finally(() => { if (about.isConnected) about.hidden = false; });
    });
    form.append(fileLabel, file, about, codeRow, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const selected = file.files[0];
      const typed = code.value;
      code.value = "";
      void this.host.run(async () => {
        try {
          await this.restore(selected, typed);
        } catch (error) {
          if (error?.code === "private_export_needs_code") { codeRow.hidden = false; queueMicrotask(() => code.focus()); }
          throw error;
        }
      });
    });
    this.host.append(form);
    this.host.button("Cancel", () => this.host.render());
    file.focus();
  }

  async restore(selected, typed = "") {
    const operation = this.host.operation;
    const app = this.app();
    const log = this.log();
    if (!log) throw new Error("Your private things aren't open on this device.");
    if (!selected) throw new Error("Choose your private things file.");
    if (selected.size > MAX_PRIVATE_EXPORT_BYTES) throw new Error("That file is larger than a Kin export of private things can be.");
    this.host.message.textContent = "Opening your file…";
    const bytes = new Uint8Array(await selected.arrayBuffer());
    const opened = await openPrivateArchive(bytes, { identity: log.identity, code: typed || null,
      memberKey: async (epoch) => (log.ring.revokedThrough(epoch) === null ? null : log.ring.key(epoch)) });
    this.host.assertCurrentOperation(operation);
    this.host.message.textContent = "Restoring your private things…";
    const restored = await restorePrivateArchive({
      opened, log, blobStore: app.ctx?.journal?.blobs?.store ?? null,
      addMemberKeys: (memberKeys) => this.addMemberKeys(app, log, memberKeys),
    });
    this.host.assertCurrentOperation(operation);
    void app.syncCoordinator?.syncNow?.();
    this.host.render();
    this.host.message.textContent = restored.added
      ? `Restored ${restored.added.toLocaleString()} private ${restored.added === 1 ? "change" : "changes"}${restored.alreadyHere ? `; ${restored.alreadyHere.toLocaleString()} were already here` : ""}.${restored.blobsAdded ? ` ${restored.blobsAdded.toLocaleString()} journal photos are back too.` : ""}`
      : "Everything in this file is already here. Nothing was duplicated.";
    this.host.lastPrivateRestore = restored;
  }

  /** Epochs the backup code opened that this member's vault doesn't hold:
   * merged into the vault from this device, then read again. */
  async addMemberKeys(app, log, memberKeys) {
    const identity = log.identity;
    const vaultKey = await app.household?.syncKeyStore?.accountVaultKey(identity.householdId);
    if (!vaultKey) throw new Error("This device doesn't hold your account's keys, so it can't restore this file.");
    const local = { memberKeys: memberKeys.map((entry) => ({ ...entry, key: entry.key.slice() })) };
    try {
      await refreshVault({ api: vaultApi(), vaultKey, householdId: identity.householdId, memberId: identity.memberId, local });
    } finally {
      vaultKey.fill(0);
      wipeVaultContents(local);
    }
    await log.ring.load();
  }
}
