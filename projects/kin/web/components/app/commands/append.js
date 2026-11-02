// The single command append path and its retry, focus and error handling.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { routeHash } from "../../../routes.js";
import { SITTER_PAGE_FORBIDDEN, canChangeSitterPage } from "../../../wasm/kin-sitter.js";
import { ALBUM_REMOVE_FORBIDDEN, canRemoveAlbumPhoto } from "../../../wasm/kin-album.js";
import { CHORES_FORBIDDEN, JOIN_FORBIDDEN } from "../../../wasm/kin-chores.js";

export class AppendCommands {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  async appendCommand(command) {
    // The sitter page is Adult-only (#442, ADR 0017). Rust can't tell member
    // kinds apart, so every append passes here first. A device with no server
    // membership is its own Adult; a synced one whose status hasn't arrived
    // yet is refused until it has.
    if (command?.type === "set-sitter-page" &&
      !canChangeSitterPage(this.app.householdStatus?.memberKind ?? (this.app.hasLocalSyncBinding ? null : "adult")))
      throw Object.assign(new Error(SITTER_PAGE_FORBIDDEN), { code: "forbidden", userMessage: SITTER_PAGE_FORBIDDEN });
    // The chore chart (#676): points and rewards are for Adults, joining for
    // an Adult while a household admin allows adults. Rust can't tell.
    if (typeof command?.type === "string" && command.type.startsWith("set-chore") && this.ctx.chores && !this.ctx.chores.allows(command.type)) {
      const message = command.type === "set-chore-chart-joined" ? JOIN_FORBIDDEN : CHORES_FORBIDDEN;
      throw Object.assign(new Error(message), { code: "forbidden", userMessage: message });
    }
    const session = this.ctx.session.captureSession();
    this.ctx.session.assertCurrentSession(session);
    // A family photo (#673, ADR 0022 §5) is removed by whoever added it or a
    // household admin. Rust knows who added it but not who is an admin, so
    // the album is read here first; a device with no server membership is
    // its own admin.
    if (command?.type === "remove-album-photo") {
      const album = await session.store.album();
      this.ctx.session.assertCurrentSession(session);
      const photo = album.photos.find((entry) => entry.photoId === command.photoId) ?? null;
      const allowed = canRemoveAlbumPhoto(photo, {
        memberId: this.app.syncCoordinator?.identity?.memberId ?? null,
        admin: this.app.householdAdmin === true,
        local: !this.app.hasLocalSyncBinding,
      });
      // A photo that's already gone is Rust's to refuse (code 4).
      if (photo && !allowed)
        throw Object.assign(new Error(ALBUM_REMOVE_FORBIDDEN), { code: "forbidden", userMessage: ALBUM_REMOVE_FORBIDDEN });
    }
    // A new change replaces the undo toast (#315); undo itself keeps it.
    this.ctx.undo?.beforeChange();
    const result = await session.store.append(command, session.engine);
    this.ctx.session.assertCurrentSession(session);
    this.app.state = result.state;
    this.app.snapshotBoundary = result.snapshotBoundary;
    void this.app.syncCoordinator?.syncNow();
  }
  // The allowlisted command ids map onto the same methods the visible
  // navigation, Search link, and Quick add button use.
  runWorkspaceCommand(id, { opener = null } = {}) {
    if (!this.ctx.navigation.workspaceReady()) return;
    switch (id) {
      case "today":
        this.ctx.navigation.navigate("#today");
        this.app.pages.get("today")?.querySelector("h1")?.focus();
        return;
      case "todo":
      case "shopping":
        this.ctx.navigation.navigate(routeHash("lists", id));
        this.app.segmentNavs.get("lists")?.focusCurrent();
        return;
      case "search":
        this.ctx.navigation.navigate("#search");
        this.app.search.focusInput?.();
        return;
      case "quick-add":
        if (this.app.quickAdd.isDisabled) {
          this.ctx.status.setStatus("Quick add is available again once Kin finishes saving.");
          this.restoreCommandFocus(opener);
          return;
        }
        this.app.quickAdd.open({ opener, fallback: () => this.app.main.querySelector(".app-view:not([hidden]) h1") });
        return;
      case "shortcuts":
        this.app.commandGeneration = this.app.securityGeneration;
        this.app.commandPalette.openHelp({ opener });
        return;
    }
  }
  restoreCommandFocus(opener) {
    if (!this.ctx.navigation.workspaceReady()) return;
    if (opener?.isConnected && !opener.closest("[hidden], [inert]") && opener.getClientRects().length) opener.focus();
    else this.app.main.querySelector(".app-view:not([hidden]) h1")?.focus();
  }
  showDetailActionError(itemId, message, retry, intent = null) {
    if (!this.app.detail) { this.ctx.status.showAlert(message, retry, intent); return; }
    this.app.detail.setFeedback(itemId, { itemId, message, retry, intent });
    if (this.app.selection) this.ctx.detail.feedDetail();
  }
}
