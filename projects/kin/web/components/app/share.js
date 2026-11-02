// Sharing into Kin and home-screen shortcuts (#389): once Kin is unlocked,
// offer what another app shared (share-target.js) and run a shortcut's
// action. State stays on the element (`this.app`); app/context.js explains
// the controllers.
import { captureLaunchAction, consumeLaunchAction, consumeShare, sharedText, shortcutLanding } from "../../share-target.js";
import { routeHash } from "../../routes.js";
import { shareDestinations, unavailableLine } from "../../features.js";

export class ShareController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  /** After unlock (session.js): a waiting shortcut action, then a waiting
   * share. Simple view takes no share: it adds nothing (#345). */
  async afterUnlock() {
    const action = consumeLaunchAction();
    const shared = await consumeShare();
    if (!this.ctx.navigation.workspaceReady()) return;
    // A kitchen display (#670) takes no shortcut or share.
    if (this.app.displayMode) {
      if (action || shared) this.ctx.status.setStatus("Sharing into Kin isn't available on a kitchen display.");
      return;
    }
    if (action) this.land(action);
    if (this.app.simpleView) {
      if (shared) this.ctx.status.setStatus("Sharing into Kin isn't available in Simple view.");
      return;
    }
    if (shared) await this.offer(shared);
  }

  /** A shortcut opened while Kin is already running (#472): the address
   * changes in place (hashchange). Unlocked, it lands now; locked, it waits
   * for the unlock like one that started the app. Returns whether the
   * address was a shortcut action. */
  handleLaunchAddress() {
    if (!captureLaunchAction()) return false;
    if (this.ctx.navigation.workspaceReady() && !this.app.displayMode) this.land(consumeLaunchAction());
    return true;
  }

  /** Lands a shortcut action: its page, then Quick add with focus in the
   * title (share-target.js shortcutLanding). A Temporary member stays where
   * the shortcut took them rather than being moved to For you. */
  land(action) {
    const landing = shortcutLanding(action, { simpleView: this.app.simpleView, available: (route) => this.ctx.features.routeAvailable(route) });
    if (!landing) return;
    this.app.sitterLanded = true;
    // A shortcut into a switched-off feature (#625) lands on Today.
    if (landing.unavailable) {
      this.ctx.navigation.navigate("#today");
      this.app.pages?.get("today")?.querySelector("h1")?.focus();
      this.ctx.status.setStatus(unavailableLine(this.ctx.features.blocking(landing.unavailable)));
      return;
    }
    // "New journal entry" (#509): the journal's editor, after unlock.
    if (landing.journal) {
      void this.ctx.journal?.openNewEntry();
      return;
    }
    this.ctx.navigation.navigate(landing.hash);
    if (landing.quickAdd) {
      this.ctx.append.runWorkspaceCommand("quick-add");
      return;
    }
    this.app.pages?.get("today")?.querySelector("h1")?.focus();
    this.ctx.status.setStatus("Adding things isn't available in Simple view, so Kin opened Today.");
  }

  /** Asks where a share should go, then hands it to that kind's dialog. */
  async offer(shared) {
    const { text, body, link } = sharedText(shared);
    const files = (shared.files ?? []).map((file) => ({ name: file.name || "Shared file", size: file.size, type: file.type, load: async () => file }));
    if (!text && !files.length) {
      this.ctx.status.setStatus("Nothing came through to add.");
      return;
    }
    const chat = this.app.chat;
    const chatOpen = this.app.chatAccess !== "none" && chat?.chatRoom && (chat.chatRoom.access ?? "write") === "write";
    // The journal (#508) only where it opens on this device: private, so
    // nothing shared there touches household data.
    const journalOpen = this.ctx.journal?.status() === "ready";
    // Destinations of switched-off features leave the sheet (#625).
    // Family photos (#673) when a photo came through.
    const photos = (shared.files ?? []).filter((file) => /^image\/(jpeg|png|webp)$/.test(file.type ?? ""));
    // A calendar file (#660) can go to the calendar, after a preview.
    const calendarFile = (shared.files ?? []).find((file) => file.type === "text/calendar" || /\.ics$/i.test(file.name ?? "")) ?? null;
    const allowed = shareDestinations(["todo", "shopping", "note", "handoff", ...(chatOpen ? ["chat"] : []), ...(journalOpen ? ["journal"] : []), ...(photos.length ? ["photos"] : []), ...(calendarFile ? ["calendar"] : [])], this.ctx.features.off);
    const sheet = this.app.shareSheet;
    if (!sheet) return;
    const kind = await sheet.choose({ text, link, files, allowed });
    if (!kind) {
      this.ctx.status.setStatus("Nothing was added.");
      return;
    }
    if (kind === "photos") {
      await this.ctx.album.offer(photos);
      return;
    }
    if (kind === "calendar") {
      this.ctx.calendar.openImport({ file: calendarFile });
      return;
    }
    if (kind === "journal") {
      await this.ctx.journal.openNewEntry({ text: body, files: (shared.files ?? []).filter((file) => file.type?.startsWith("image/")) });
      return;
    }
    if (kind === "chat") {
      this.ctx.navigation.navigate(routeHash("updates", "chat"));
      chat.prefill?.({ text: body.length <= 2_000 ? body : text, files: shared.files ?? [] });
      return;
    }
    this.ctx.chatShare.open({
      kind,
      text: kind === "note" ? body : text,
      files,
      audience: "Everyone in your household will see this.",
      opener: null,
    });
  }
}
