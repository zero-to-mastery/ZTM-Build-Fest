// Ending a household or leaving it: deletion, cancelling a pending deletion,
// leaving, and the views shown while a deletion is pending or done.
// Part of <kin-household>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-household.js lists them).
import { freshConfirmation } from "./fresh-confirmation.js";

export class HouseholdLifecycle {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  async deleteHousehold() {
    if (
      !confirm(
        "Delete this household from Kin? Sync stops immediately for all adults and devices. Kin will remove its encrypted relay history and authorization records after 30 days; a household admin can cancel with a passkey before then. This does not erase this browser, offline devices, exported archives, or external backups. After final deletion Kin cannot restore the household.",
      )
    )
      return;
    await this.host.run(async () => {
      const started = await this.host.api("/api/household/deletion/options", {
        method: "POST",
        body: "{}",
      });
      const proof = await freshConfirmation(started, { signal: this.host.connectionAbort.signal });
      const result = await this.host.api("/api/household/deletion/finish", {
        method: "POST",
        body: JSON.stringify({
          flow: started.flow,
          ...proof,
        }),
      });
      this.host.householdLifecycle = {
        state: result.state,
        finalizeAt: result.finalizeAt,
        message: result.message,
      };
      this.host.dispatchEvent(
        new CustomEvent("kin:sync-stop", {
          bubbles: true,
          composed: true,
          detail: { message: result.message },
        }),
      );
      this.host.render();
    });
  }

  async cancelHouseholdDeletion() {
    await this.host.run(async () => {
      const started = await this.host.api(
        "/api/household/deletion/cancel/options",
        { method: "POST", body: "{}" },
      );
      const proof = await freshConfirmation(started, { signal: this.host.connectionAbort.signal });
      const identity = await this.host.api(
        "/api/household/deletion/cancel/finish",
        {
          method: "POST",
          body: JSON.stringify({
            flow: started.flow,
            ...proof,
          }),
        },
      );
      this.host.identity = {
        householdId: identity.householdId,
        memberId: identity.memberId,
        deviceId: identity.deviceId,
      };
      this.host.householdLifecycle = null;
      this.host.syncStatus = await this.host.api("/api/sync/status");
      this.host.dispatchEvent(
        new CustomEvent("kin:sync-enabled", {
          bubbles: true,
          composed: true,
          detail: this.host.identity,
        }),
      );
      this.host.render();
    });
  }

  async leave() {
    if (
      !confirm(
        "Leave this household and revoke access for your devices? This cannot be undone or recovered in this release.",
      )
    )
      return;
    await this.host.run(async () => {
      this.host.message("Confirm with your passkey to leave the household.");
      await this.host.authenticateRemoval(this.host.identity.memberId);
      this.host.identity = null;
      this.host.dispatchEvent(new CustomEvent("kin:lock", { bubbles: true, composed: true, detail: { endSession: true } }));
      location.href = "/";
    });
  }

  renderDeletionPending() {
    const heading = document.createElement("h2");
    heading.textContent = "Household deletion pending";
    this.host.append(heading);
    const status = this.host.text(this.host.householdLifecycle.message);
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    this.host.text(
      "All household sync and new device or member changes are blocked now. Deletion becomes final 30 days after it was requested. Either active adult can cancel before then by authenticating with a trusted device passkey. At finalization, Kin removes its household ciphertext and service authorization records.",
    );
    this.host.text(
      "This does not erase encrypted data already stored in this browser, offline or exported copies, or backups held outside Kin. A device that reconnects while deletion is pending cannot sync.",
    );
    this.host.button("Cancel household deletion with passkey", () =>
      this.cancelHouseholdDeletion(),
    );
  }

  renderDeleted() {
    const heading = document.createElement("h2");
    heading.textContent = "Household deleted";
    this.host.append(heading);
    const status = this.host.text(
      "This household was deleted and can no longer sync.",
    );
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    this.host.text(
      "Kin cannot recover it after final deletion. This browser, offline devices, exported archives, and external backups may still contain copies.",
    );
  }
}
