// Encrypted household archives: downloading one and restoring from one.
// Part of <kin-security>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-security.js lists them).
import { getActiveVault } from "../../security/local-vault.js";
import { describeHouseholdArchive, discardValidatedHouseholdArchive, exportHouseholdArchive, restoreValidatedHouseholdArchive, validateHouseholdArchive } from "../../security/archive.js";
import { EXPORT_STORAGE_RULE, exportFileName, joinLabels } from "../../security/key-label.js";
import { portableMembershipFromDirectory } from "../../sync/sync-coordinator.js";

export class SecurityArchive {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  async downloadArchive() {
    const operation = this.host.operation;
    const app = this.host.closest("kin-app");
    let portableMembership;
    if (app.syncCoordinator) portableMembership = await app.syncCoordinator.portableMembershipSnapshot();
    else if (app.household?.identity) {
      const response = await fetch("/api/sync/devices", { cache: "no-store" });
      if (!response.ok) throw new Error("Connect to your household before exporting its membership history.");
      portableMembership = portableMembershipFromDirectory((await response.json()).members);
    }
    this.host.assertCurrentOperation(operation);
    this.host.message.textContent = "Preparing your Kin export…";
    const progress = this.progress("Export progress");
    // The chat goes in when the option is shown and checked (#136).
    const option = this.host.chatOption;
    let chat = null;
    if (option?.isConnected && option.checked) chat = await app.chat.room.chatExportPlan().catch(() => null);
    // The fridge always goes in when there is one (#363); it is small.
    const boardRoom = app.syncCoordinator?.board ?? app.fridge?.room ?? null;
    const board = await boardRoom?.exportPlan?.().catch(() => null) ?? null;
    this.host.assertCurrentOperation(operation);
    const report = {};
    let bytes;
    let backupCode = null;
    try {
      backupCode = await this.accountBackupCode(app);
      this.host.assertCurrentOperation(operation);
      bytes = await exportHouseholdArchive({ store: app.store, engine: app.engine, vault: getActiveVault(), portableMembership, chat, board, report, backupCode, onProgress: progress.update });
    } finally {
      progress.remove();
      backupCode?.vaultKey.fill(0);
    }
    this.host.assertCurrentOperation(operation);
    // The name and message come from the export's own header, so they name
    // exactly the key label the restore screen will show for this file.
    const { exportedAt, labels, backupCode: opensWithCode } = await describeHouseholdArchive(bytes, app.engine);
    this.host.assertCurrentOperation(operation);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName(exportedAt, labels[0]);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const left = report.chatBlobsSkipped ? ` ${report.chatBlobsSkipped.toLocaleString()} older chat photos and files didn't fit and were left out; they stay in Kin and in your household's chat.` : "";
    const extras = [report.chatEvents ? "your household chat" : null, report.boardEvents ? "the fridge" : null].filter(Boolean);
    const opens = opensWithCode
      ? `It opens with your account backup code${labels.length ? ` or this device's backup key ${joinLabels(labels)}` : ""}. Store the export and the code in different places.`
      : `It opens with this device's backup key ${joinLabels(labels)}. ${EXPORT_STORAGE_RULE}`;
    this.host.message.textContent = `Kin export prepared${extras.length ? ` with ${extras.join(" and ")}` : ""}. ${opens}${left}`;
  }

  /**
   * The member's account backup code for an export (#572), when they have
   * one and this device holds their vault key: `{ vaultKey, householdId,
   * memberId, wrapper }` (the caller zeroes vaultKey), or null. Reads the
   * code's wrapper from the service, so it needs a connection; a device
   * with its own backup key still exports offline.
   */
  async accountBackupCode(app) {
    const identity = app.household?.identity;
    const store = app.household?.syncKeyStore;
    if (!identity || !store) return null;
    const vaultKey = await store.accountVaultKey(identity.householdId);
    if (!vaultKey) return null;
    try {
      const response = await fetch("/api/account/vault", { cache: "no-store" });
      const value = response.ok ? await response.json() : null;
      const wrapper = value?.wrappers?.find((entry) => entry.type === "backup-code") ?? null;
      if (!wrapper) { vaultKey.fill(0); return null; }
      return { vaultKey, householdId: identity.householdId, memberId: identity.memberId, wrapper };
    } catch {
      vaultKey.fill(0);
      return null;
    }
  }

  // A progress bar after the status message while an archive operation runs.
  // The archive functions report `{ done, total }` events about every 256.
  progress(label) {
    const bar = document.createElement("progress");
    bar.className = "archive-progress";
    bar.max = 1;
    bar.value = 0;
    bar.setAttribute("aria-label", label);
    this.host.message.after(bar);
    return {
      update: ({ done, total }) => { bar.max = Math.max(total, 1); bar.value = done; },
      remove: () => bar.remove(),
    };
  }

  showRestore() {
    if (this.host.busy) return;
    this.host.render();
    this.host.heading.textContent = "Restore household";
    const form = document.createElement("form");
    const file = document.createElement("input");
    file.id = "archive-file"; file.type = "file"; file.accept = ".kin"; file.required = true;
    file.setAttribute("aria-describedby", "security-alert");
    const fileLabel = document.createElement("label"); fileLabel.htmlFor = file.id; fileLabel.textContent = "Kin export";
    const recovery = document.createElement("input");
    recovery.id = "archive-recovery"; recovery.type = "password"; recovery.autocomplete = "off"; recovery.required = true;
    recovery.setAttribute("aria-describedby", "security-alert");
    const recoveryLabel = document.createElement("label"); recoveryLabel.htmlFor = recovery.id; recoveryLabel.textContent = "Backup key or backup code for this export";
    const button = document.createElement("button"); button.type = "submit"; button.textContent = "Check export";
    // Before any key is asked for: when the file was made and which key opens it.
    const about = document.createElement("p");
    about.id = "archive-about"; about.className = "security-note"; about.hidden = true; about.setAttribute("role", "status");
    let describing = 0;
    file.addEventListener("change", () => {
      const selected = file.files[0];
      const attempt = ++describing;
      about.hidden = true;
      about.textContent = "";
      if (!selected) return;
      void (async () => {
        let text;
        try {
          if (selected.size > 160 * 1024 * 1024) throw new Error("Choose a Kin archive no larger than 160 MiB.");
          const described = await describeHouseholdArchive(new Uint8Array(await selected.arrayBuffer()), this.host.closest("kin-app").engine);
          const made = new Date(described.exportedAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
          const key = described.labels.length ? `backup key ${joinLabels(described.labels)} from the device that made it` : "";
          const opens = described.backupCode ? `the account backup code that was current then${key ? `, or with ${key}` : ""}` : key;
          text = `This export was made on ${made} and opens with ${opens}.`;
        } catch (error) {
          text = error?.userMessage ?? "Kin couldn't read this file as a Kin export.";
        }
        if (attempt !== describing || !about.isConnected) return;
        about.textContent = text;
        about.hidden = false;
      })();
    });
    form.append(fileLabel, file, about, recoveryLabel, recovery, button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const selected = file.files[0]; const secret = recovery.value; recovery.value = "";
      void this.host.run(async (operation) => {
        if (!selected || selected.size > 160 * 1024 * 1024) throw new Error("Choose a Kin archive no larger than 160 MiB.");
        const app = this.host.closest("kin-app");
        const engine = app.engine, vault = getActiveVault();
        this.host.message.textContent = "Checking your Kin export…";
        const bytes = new Uint8Array(await selected.arrayBuffer());
        this.host.assertCurrentOperation(operation);
        const checking = this.progress("Export check progress");
        let staged;
        try {
          staged = await validateHouseholdArchive({ bytes, recoverySecret: secret, engine, vault, onProgress: checking.update });
        } finally { checking.remove(); }
        this.host.assertCurrentOperation(operation);
        this.host.restoreStage = staged.stage;
        form.remove();
        const summary = document.createElement("p");
        summary.textContent = `This export is ready to restore (${staged.eventCount} household changes, ${staged.attachmentCount} attachments${staged.chatEventCount ? `, and the household chat: ${staged.chatEventCount.toLocaleString()} chat events and ${staged.chatBlobCount.toLocaleString()} photos, files and messages` : ""}). Restore works on an empty installation or as a no-duplicate check when this same household already contains the export. Device approval and sync access are not included.`;
        const confirm = document.createElement("button");
        confirm.id = "restore-confirm";
        confirm.type = "button";
        confirm.textContent = "Restore household";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        confirm.addEventListener("click", () => void this.host.run(async (confirmOperation) => {
          this.host.message.textContent = "Restoring your household… Keep this tab open.";
          const restoring = this.progress("Restore progress");
          let restored;
          let chatFailed = false;
          try {
            restored = await restoreValidatedHouseholdArchive({ stage: staged.stage, engine, vault, store: app.store, onProgress: restoring.update });
          } catch (error) {
            // The household was written; only its chat could not be (#136).
            if (!error?.householdRestored) throw error;
            restored = { eventCount: 0, alreadyPresent: false, chat: null };
            chatFailed = true;
          } finally { restoring.remove(); }
          this.host.restoreStage = null;
          this.host.assertCurrentOperation(confirmOperation);
          await this.host.services.refreshFromEvents();
          this.host.assertCurrentOperation(confirmOperation);
          // Restored history replaces what reminders pointed at; end them.
          this.host.services.clearReminders();
          this.host.services.broadcastEventChange();
          this.host.render();
          this.host.message.textContent = restored.alreadyPresent
            ? "This household already contains the export's history and attachments. Nothing was duplicated."
            : "Your household is restored on this device. This device still needs household approval before sync can resume.";
          if (restored.chat && !restored.alreadyPresent) this.host.message.textContent += " Its chat will appear in Chat once this device is approved.";
          if (chatFailed) this.host.message.textContent += " The household's chat could not be saved on this device. Restore the same export again to try the chat once more.";
        }));
        cancel.addEventListener("click", () => {
          discardValidatedHouseholdArchive(staged.stage);
          this.host.restoreStage = null;
          summary.remove(); confirm.remove(); cancel.remove();
          this.host.showRestore();
        });
        this.host.append(summary, confirm, cancel);
        confirm.focus();
        this.host.message.textContent = "This export is ready to restore.";
      });
    });
    this.host.append(form);
    this.host.button("Cancel", () => this.host.render());
    file.focus();
  }
}
