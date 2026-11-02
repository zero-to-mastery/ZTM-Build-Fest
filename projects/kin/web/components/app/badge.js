// The count on the app icon (#476, #478): recomputed after every render (so
// on sync, completion and every other change) and whenever Chat's unread
// count moves (reading); cleared when Kin locks or the member signs out.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { appBadgeCount, appBadgeSupported, readAppBadgeChoice, writeAppBadgeChoice } from "../../app-badge.js";
import { setAppBadge } from "../../chat/chat-badge.js";

export class BadgeController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.choice = readAppBadgeChoice();
    // The last number given to the browser, so an unchanged count isn't sent
    // again on every render. null: unknown (Kin just started).
    this.shown = null;
  }

  supported() {
    return appBadgeSupported();
  }

  /** The setting changed (<kin-app-badge>). */
  setChoice(value) {
    this.choice = value;
    const kept = writeAppBadgeChoice(value);
    this.update();
    return kept;
  }

  /** Puts the current count on the icon. While locked there's nothing
   * decrypted to count: the icon keeps whatever the lock left (cleared, or
   * the last count when Kin was closed). */
  update() {
    if (!this.supported() || !this.app.vault || this.app.vault.locked || !this.app.state) return;
    const count = appBadgeCount({
      choice: this.choice,
      unread: this.app.chatUnread?.count ?? 0,
      state: this.app.state,
      memberId: this.ctx.detail.responsibilityContext().memberId,
      civilDate: this.ctx.navigation.currentCivilDate(),
    });
    if (count === this.shown) return;
    this.shown = count;
    setAppBadge(count);
  }

  /** On lock and sign-out: no count outside an unlocked Kin. */
  clear() {
    if (!this.supported()) return;
    this.shown = 0;
    setAppBadge(0);
  }
}
