import { setViewport } from "./cdp-viewport.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Drives the real attachment journey on a phone-sized viewport over CDP.
// The row's Add photo button is tapped with a synthesized touch, the browser's
// own file-chooser request is observed (Page.fileChooserOpened), the file is
// supplied the way a native picker supplies it (DOM.setFileInputFiles), and
// the page is then checked for feedback, the tile under the right item, the
// thumbnail, the viewer, navigation, a stale sync refresh, Details toggling,
// lock/unlock, an unsupported file, a cancelled picker, and isolation from
// other items. Installed-PWA and physical-camera behaviour cannot run here and
// stay on the manual device checklist in the release record.
export async function attachmentUploadRegressions(client, { recovery, visit, scratch }) {
  const page = (fn, ...args) => client.evaluate(`(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(",")})`);
  const passed = [];
  const check = (condition, message) => { assert.ok(condition, message); passed.push(message); };
  const evidenceDir = join(dirname(fileURLToPath(import.meta.url)), "../target/ux-screenshots");
  await mkdir(evidenceDir, { recursive: true });
  const screenshot = async (name) => {
    const { data } = await client.send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(evidenceDir, `regression-${name}.png`), Buffer.from(data, "base64"));
  };
  await client.send("DOM.enable");
  await client.send("Page.setInterceptFileChooserDialog", { enabled: true });
  await setViewport(client, { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  try {
    // Fixtures: a genuine JPEG encoded by the browser itself, and a text file.
    const jpegBase64 = await page(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 480;
      const context = canvas.getContext("2d");
      context.fillStyle = "#285c49"; context.fillRect(0, 0, 640, 480);
      context.fillStyle = "#f4e7d8"; context.fillRect(80, 80, 480, 320);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    });
    const jpegPath = join(scratch, "fridge-shelf.jpg");
    await writeFile(jpegPath, Buffer.from(jpegBase64, "base64"));
    const textPath = join(scratch, "notes.txt");
    await writeFile(textPath, "not a photo\n");

    await visit("lists/shopping");
    const { itemId, otherId } = await page(async () => {
      const app = document.querySelector("kin-app");
      const idle = async () => { for (let i = 0; (app.busy || app.refreshing || app.pendingRefresh || app.wakePending) && i < 400; i++) await new Promise((r) => setTimeout(r, 10)); };
      const add = async (text) => {
        const composer = app.shopping.querySelector("kin-compose");
        composer.input.value = text; composer.form.requestSubmit(); await idle();
        return app.state.items.find((item) => item.text === text).itemId;
      };
      // Progress phases are recorded from the same module instance the app uses.
      const progress = await import("/attachments/attachment-progress.js");
      window.__kinProgressLog = [];
      progress.subscribeAttachmentProgress((key, value) => window.__kinProgressLog.push([key, value?.phase ?? null, value?.message ?? null]));
      return { itemId: await add("Fridge shelf photo"), otherId: await add("Unrelated oats") };
    });

    const geometry = (id) => page((itemId) => {
      const app = document.querySelector("kin-app");
      const button = app.shopping.querySelector(`.item-attach-button[data-item-id="${itemId}"]`);
      if (!button) return null;
      button.scrollIntoView({ block: "center" });
      const rect = button.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      return {
        x, y, height: rect.height, hidden: Boolean(button.closest("[hidden]")), label: button.getAttribute("aria-label"), text: button.textContent,
        detailsHidden: app.selection?.itemId !== itemId, topmost: document.elementFromPoint(x, y) === button,
        rowInputs: app.shopping.querySelectorAll('kin-item input[type="file"]').length, appInputs: app.querySelectorAll('input[type="file"]').length,
        disabled: button.disabled,
      };
    }, id);
    const tapChooser = async (id) => {
      const target = await geometry(id);
      assert.ok(target, "the item row renders an Add photo button");
      check(!target.hidden && target.detailsHidden !== false && target.height >= 44 && target.topmost && !target.disabled,
        "Add photo is visible on the row without opening Details, is a 44px target, and is not covered");
      const chooser = client.once("Page.fileChooserOpened", 5_000);
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: target.x, y: target.y }] });
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      const opened = await chooser;
      const { object } = await client.send("DOM.resolveNode", { backendNodeId: opened.backendNodeId });
      const owner = await client.send("Runtime.callFunctionOn", {
        objectId: object.objectId, returnByValue: true,
        functionDeclaration: "function(){ const app=document.querySelector('kin-app'); return { isAppInput: this===app.attachmentInput, accept: this.accept, target: app.attachmentTarget?.parentId ?? null }; }",
      });
      check(opened.mode === "selectSingle" && owner.result.value.isAppInput && owner.result.value.target === id &&
        owner.result.value.accept === "image/jpeg,image/png,image/webp,application/pdf",
        "a real touch on Add photo makes the browser open its file chooser for the app-owned input, targeting this item");
      return { opened, target };
    };

    // 1. Tap, let the list re-render while the picker is "open", then choose a JPEG.
    const first = await tapChooser(itemId);
    check(first.target.label === `Add a photo or file to Fridge shelf photo` && first.target.text === "Add photo" && first.target.rowInputs === 0 && first.target.appInputs === 1,
      "rows carry one labelled button each and the only file input belongs to the app");
    await page(() => { const app = document.querySelector("kin-app"); app.ctx.render.renderState(); return app.attachmentTarget?.parentId; });
    await client.send("DOM.setFileInputFiles", { files: [jpegPath], backendNodeId: first.opened.backendNodeId });
    const saved = await page(async (itemId, otherId) => {
      const app = document.querySelector("kin-app");
      for (let i = 0; i < 400 && !(app.attachmentRows.some((row) => row.parentId === itemId) && !app.busy); i++) await new Promise((r) => setTimeout(r, 25));
      const row = app.attachmentRows.find((entry) => entry.parentId === itemId) ?? null;
      // The row carries a compact thumbnail strip; name, kind and state are in
      // the detail view's full tile. Open and close it first: closing re-renders
      // the list, so row elements are queried afterwards.
      app.ctx.detail.openItemDetail(itemId);
      const fullTile = app.detail.querySelector(".attachment-tile") ?? null;
      const detailResult = { name: fullTile?.querySelector(".attachment-name")?.textContent ?? null, meta: fullTile?.querySelector(".attachment-meta")?.textContent ?? null };
      app.ctx.detail.closeItemDetail({ restoreFocus: false });
      const item = [...app.shopping.querySelectorAll("kin-item")].find((node) => node.record?.itemId === itemId);
      const other = [...app.shopping.querySelectorAll("kin-item")].find((node) => node.record?.itemId === otherId);
      const tile = item?.querySelector(".attachment-tile") ?? null;
      const stored = (await app.store.loadAttachments()).find((entry) => entry.attachment_id === row?.attachmentId) ?? null;
      const binding = app.state.attachments.find((entry) => entry.attachmentId === row?.attachmentId) ?? null;
      return {
        row, phases: window.__kinProgressLog.map(([, phase]) => phase), messages: window.__kinProgressLog.map(([, , message]) => message),
        status: item?.querySelector(".attachment-status")?.textContent ?? null, statusPhase: item?.querySelector(".attachment-status")?.dataset.phase ?? null,
        tileVisible: Boolean(tile) && !tile.closest("[hidden]") && tile.getClientRects().length > 0,
        name: detailResult.name, meta: detailResult.meta,
        thumb: Boolean(tile?.querySelector(".attachment-thumb")), thumbLabel: tile?.querySelector(".attachment-thumb")?.getAttribute("aria-label") ?? null,
        otherTiles: other?.querySelectorAll(".attachment-tile").length ?? -1,
        otherRows: app.attachmentRows.filter((entry) => entry.parentId === otherId).length, alert: app.alert.hidden ? null : app.alert.textContent,
        stored: stored ? { state: stored.state, sealed: Boolean(stored.localSealed), ciphertext: Boolean(stored.ciphertext) } : null,
        binding: binding ? { parentKind: binding.parentKind, parentId: binding.parentId, removed: binding.removed } : null,
        focused: document.activeElement?.className ?? null,
      };
    }, itemId, otherId);
    check(saved.row?.name === "fridge-shelf.jpg" && saved.row.type === "image/jpeg" && saved.row.state === "queued",
      `the chosen JPEG becomes an attachment row with its name, type and state: ${JSON.stringify(saved.row)}`);
    check(saved.phases.slice(0, 3).join(">") === "preparing>saving>saved" && saved.messages[0] === "Preparing photo…" && saved.messages[1] === "Saving securely…",
      `feedback moves through preparing, saving and saved: ${JSON.stringify(saved.messages)}`);
    check(saved.status === "fridge-shelf.jpg is saved on this device." && saved.statusPhase === "saved",
      `the row shows the saved confirmation after the list re-rendered: ${saved.status}`);
    check(saved.stored?.state === "queued" && saved.stored.sealed && !saved.stored.ciphertext && saved.binding?.parentKind === "item" && saved.binding.parentId === itemId && saved.binding.removed === false,
      `protected bytes are stored under this device's vault and a canonical binding names the item: ${JSON.stringify([saved.stored, saved.binding])}`);
    check(saved.tileVisible && saved.thumb && saved.thumbLabel === "View fridge-shelf.jpg (Photo, Saved here, waiting to sync)",
      `a compact thumbnail appears under the item on the row, named and stated for assistive technology: ${saved.thumbLabel}`);
    check(saved.name === "fridge-shelf.jpg" && saved.meta.includes("Photo") && saved.meta.includes("Saved here"),
      `the detail view's full tile shows the name, kind and local/sync state: ${saved.meta}`);
    check(saved.otherTiles === 0 && saved.otherRows === 0 && saved.alert === null, "the unrelated item receives nothing and no error is shown");

    // 2. Thumbnail decode and the viewer.
    const viewer = await page(async (itemId) => {
      const app = document.querySelector("kin-app");
      const item = () => [...app.shopping.querySelectorAll("kin-item")].find((node) => node.record?.itemId === itemId);
      const thumb = () => item().querySelector(".attachment-thumb");
      thumb().scrollIntoView({ block: "center" });
      const wait = async (condition) => { for (let i = 0; i < 400 && !condition(); i++) await new Promise((r) => setTimeout(r, 25)); return condition(); };
      const decoded = await wait(() => thumb()?.querySelector("img")?.src.startsWith("blob:"));
      const img = thumb().querySelector("img");
      const loaded = await wait(() => img.complete && img.naturalWidth > 0);
      const bounded = img.naturalWidth <= 192 && img.naturalHeight <= 192 && img.naturalWidth > 0;
      const tilesHost = item().querySelector("kin-attachments");
      const diagnostics = { src: img.src.slice(0, 12), hidden: img.hidden, natural: [img.naturalWidth, img.naturalHeight], connected: img.isConnected, tiles: item().querySelectorAll(".attachment-tile").length, previewCache: Boolean(app.attachmentPreviews), alert: app.alert.textContent, unavailable: thumb().classList.contains("attachment-thumb-unavailable"), pending: app.attachmentPreviews?.pending.size, entries: [...(app.attachmentPreviews?.entries.entries() ?? [])].map(([key, value]) => [key.slice(0, 6), value === null ? "failed" : Boolean(value?.url)]), hostProvider: typeof tilesHost?.previewProvider, lazy: tilesHost?.lazyViews?.size, loader: typeof thumb().__kinLoadPreview, rect: thumb().getBoundingClientRect().toJSON(), inner: [innerWidth, innerHeight] };
      thumb().click();
      const opened = await wait(() => app.viewer.open);
      const viewerSrc = app.viewer.viewerImage.src, title = app.viewer.viewerTitle.textContent;
      const closeFocused = document.activeElement === app.viewer.querySelector(".attachment-viewer-close");
      app.viewer.querySelector(".attachment-viewer-close").click();
      const closed = await wait(() => !app.viewer.open && app.viewerUrl === null);
      const focusBack = document.activeElement === thumb();
      const focusInfo = focusBack ? null : { active: document.activeElement?.outerHTML?.slice(0, 160) ?? null, thumbConnected: thumb()?.isConnected, sameTile: document.activeElement?.dataset?.attachmentId === thumb()?.dataset?.attachmentId, viewerOpener: app.viewerOpener === null, progress: item().querySelector(".attachment-status")?.textContent ?? null };
      return { decoded, loaded, bounded, diagnostics, opened, viewerSrc: viewerSrc.startsWith("blob:"), title, closeFocused, closed, focusBack, focusInfo };
    }, itemId);
    check(viewer.decoded && viewer.loaded && viewer.bounded, `the JPEG renders as a bounded thumbnail once the tile is on screen: ${JSON.stringify(viewer)}`);
    check(viewer.opened && viewer.viewerSrc && viewer.title === "fridge-shelf.jpg" && viewer.closeFocused, "tapping the thumbnail opens the image viewer with the file name and focuses Close");
    check(viewer.closed && viewer.focusBack, `closing the viewer releases the image and returns focus to the thumbnail: ${JSON.stringify(viewer.focusInfo)}`);

    // Escape belongs to the topmost viewer. Exercise actual native dialog
    // cancellation by sending keyboard input through CDP, including a refresh
    // while the viewer is open.
    const escape = async () => {
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    };
    await page(async (itemId) => {
      const app = document.querySelector("kin-app"); app.ctx.detail.openItemDetail(itemId);
      app.detail.stepInput.value = "viewer preserves this draft";
      app.detail.querySelector(".attachment-thumb").click();
      for (let i = 0; i < 400 && !app.viewer.open; i++) await new Promise((r) => setTimeout(r, 10));
      if (!app.viewer.open) throw Error("viewer did not open above mobile details");
      app.ctx.render.renderState();
    }, itemId);
    await escape();
    const mobileEscape = await page(async (itemId) => {
      const app = document.querySelector("kin-app");
      // The dialog's close event, which releases the image, is a later task.
      for (let i = 0; i < 200 && (app.viewer.open || app.viewerUrl); i++) await new Promise((r) => setTimeout(r, 10));
      return { viewer: app.viewer.open, url: app.viewerUrl, selection: app.selection?.itemId, sheet: app.detailSheet.open,
        draft: app.detail.stepInput?.value, focusInDetail: app.detail.contains(document.activeElement), id: itemId };
    }, itemId);
    check(!mobileEscape.viewer && mobileEscape.url === null && mobileEscape.selection === itemId && mobileEscape.sheet &&
      mobileEscape.draft === "viewer preserves this draft" && mobileEscape.focusInDetail,
      `phone: native Escape closes only the viewer above the modal sheet, preserving selection, draft, URL cleanup and focus (${JSON.stringify(mobileEscape)})`);
    await screenshot("viewer-escape-mobile-preserved");
    await escape();
    const mobileClosed = await page(async () => {
      const app = document.querySelector("kin-app");
      for (let i = 0; i < 200 && app.detailSheet.open; i++) await new Promise((r) => setTimeout(r, 10));
      return { selection: app.selection, sheet: app.detailSheet.open, viewer: app.viewer.open, url: app.viewerUrl,
        focus: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.className ?? "" };
    });
    check(!mobileClosed.selection && !mobileClosed.sheet && !mobileClosed.viewer && mobileClosed.url === null,
      "phone: the next native Escape closes details through the sheet path after the viewer is already gone");

    await setViewport(client, { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await page((itemId) => { const app = document.querySelector("kin-app"); app.ctx.detail.openItemDetail(itemId); app.detail.stepInput.value = "desktop viewer draft"; app.detail.querySelector(".attachment-thumb").click(); }, itemId);
    await page(async () => { const app = document.querySelector("kin-app"); for (let i = 0; i < 400 && !app.viewer.open; i++) await new Promise((r) => setTimeout(r, 10)); if (!app.viewer.open) throw Error("desktop viewer did not open"); app.ctx.render.renderState(); });
    await escape();
    const desktopViewerClosed = await page(async (itemId) => {
      const app = document.querySelector("kin-app"); for (let i = 0; i < 200 && (app.viewer.open || app.viewerUrl); i++) await new Promise((r) => setTimeout(r, 10));
      return { viewer: app.viewer.open, url: app.viewerUrl, selection: app.selection?.itemId ?? null, draft: app.detail.stepInput?.value ?? null,
        connected: app.detail.isConnected, active: document.activeElement?.className ?? null, id: itemId };
    }, itemId);
    check(!desktopViewerClosed.viewer && !desktopViewerClosed.url && desktopViewerClosed.selection === itemId &&
      desktopViewerClosed.draft === "desktop viewer draft" && desktopViewerClosed.connected,
      `desktop: Escape closes the viewer after a rerender while details and their draft remain selected (${JSON.stringify(desktopViewerClosed)})`);
    await screenshot("viewer-escape-desktop-preserved");
    await escape();
    const desktopDetailsClosed = await page(() => { const app = document.querySelector("kin-app"); return app.selection === null && !app.detail.isConnected; });
    check(desktopDetailsClosed, "desktop: a second Escape closes the underlying detail and restores the list context");
    await setViewport(client, { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

    // 3. Details toggling, navigation, a stale sync refresh, and lock/unlock keep the attachment.
    await visit("today");
    await visit("lists");
    const kept = await page(async (itemId) => {
      const app = document.querySelector("kin-app");
      const item = () => [...app.shopping.querySelectorAll("kin-item")].find((node) => node.record?.itemId === itemId);
      const tile = () => item()?.querySelector(".attachment-tile");
      const afterNavigation = Boolean(tile());
      const toggle = () => app.shopping.querySelector(`.item-details-button[data-item-id="${itemId}"]`);
      toggle().click(); const whileOpen = Boolean(tile()) && app.selection?.itemId === itemId && app.detail.querySelectorAll(".attachment-add").length === 1 && app.querySelectorAll('input[type="file"]').length === 1;
      app.detail.querySelector(".item-detail-close").click(); const afterClose = Boolean(tile()) && app.selection === null;
      const before = app.attachmentRows.length;
      app.ctx.sync.handleSyncState({ state: "syncing", attachmentRows: [] });
      const afterStale = app.attachmentRows.length === before && Boolean(tile());
      return { afterNavigation, whileOpen, afterClose, afterStale };
    }, itemId);
    check(kept.afterNavigation, "navigating to Today and back keeps the tile");
    check(kept.whileOpen && kept.afterClose, "opening and closing details neither hides the row thumbnail nor duplicates the file control");
    check(kept.afterStale, "a sync refresh computed before the save cannot drop the newer attachment row");
    const relocked = await page(async (itemId, recovery) => {
      const app = document.querySelector("kin-app");
      app.ctx.session.lockHousehold();
      await app.lockBarrier;
      const lockedState = { rows: app.attachmentRows.length, previews: app.attachmentPreviews, target: app.attachmentTarget, progress: window.__kinProgressLog.at(-1)?.[1] ?? null };
      await app.security.run(() => app.security.unlockRecovery(recovery));
      const wait = async (condition) => { for (let i = 0; i < 400 && !condition(); i++) await new Promise((r) => setTimeout(r, 25)); return condition(); };
      await wait(() => app.store && !app.busy && app.attachmentRows.some((row) => row.parentId === itemId));
      location.hash = "#lists/shopping"; app.ctx.navigation.showPageFromLocation();
      const item = () => [...app.shopping.querySelectorAll("kin-item")].find((node) => node.record?.itemId === itemId);
      const thumb = () => item()?.querySelector(".attachment-thumb");
      const tileBack = await wait(() => Boolean(thumb()));
      thumb()?.scrollIntoView({ block: "center" });
      // Headless Chromium does not consistently deliver IntersectionObserver
      // after a same-task scripted scroll. Exercise the component's existing
      // next-frame visibility fallback deterministically without bypassing
      // encrypted blob loading or thumbnail generation.
      item()?.querySelector("kin-attachments")?.loadVisiblePreviews();
      const decoded = await wait(() => thumb()?.querySelector("img")?.src.startsWith("blob:"));
      return { ...lockedState, tileBack, decoded, rows: app.attachmentRows.filter((row) => row.parentId === itemId).length };
    }, itemId, recovery);
    check(relocked.previews === null && relocked.target === null && relocked.progress === null, "locking drops previews, any pending picker target, and progress text");
    check(relocked.tileBack && relocked.decoded && relocked.rows === 1, "after unlocking, the attachment is restored from encrypted storage with its thumbnail");

    // 4. An unsupported file is refused with a reason, and nothing is created.
    const second = await tapChooser(itemId);
    await client.send("DOM.setFileInputFiles", { files: [textPath], backendNodeId: second.opened.backendNodeId });
    const refused = await page(async (itemId) => {
      const app = document.querySelector("kin-app");
      const item = () => [...app.shopping.querySelectorAll("kin-item")].find((node) => node.record?.itemId === itemId);
      for (let i = 0; i < 200 && !item()?.querySelector('.attachment-status[data-phase="error"]'); i++) await new Promise((r) => setTimeout(r, 25));
      const status = item()?.querySelector(".attachment-status");
      await new Promise((r) => setTimeout(r, 300));
      return { text: status?.textContent ?? null, role: status?.getAttribute("role"), stillThere: Boolean(item()?.querySelector('.attachment-status[data-phase="error"]')), rows: app.attachmentRows.filter((row) => row.parentId === itemId).length, tiles: item().querySelectorAll(".attachment-tile").length, alert: app.alert.hidden ? null : app.alert.textContent, stored: (await app.store.loadAttachments()).length };
    }, itemId);
    check(refused.text?.includes("Kin can't attach this kind of file (text/plain)") && refused.text.includes("Choose a JPEG, PNG or WebP photo, or a PDF") && refused.role === "alert",
      `an unsupported file is refused with an actionable reason: ${refused.text}`);
    check(refused.stillThere && refused.alert === refused.text, "the refusal stays visible on the row and in the app alert");
    check(refused.rows === 1 && refused.tiles === 1 && refused.stored === 1, "a refused file creates no row, tile or stored record");

    // 5. Cancelling the picker creates nothing and leaves no pending target.
    const third = await tapChooser(itemId);
    const cancelled = await page(async (itemId) => {
      const app = document.querySelector("kin-app");
      const pendingBefore = app.attachmentTarget?.parentId ?? null;
      app.attachmentInput.dispatchEvent(new Event("cancel"));
      const clearedByCancel = app.attachmentTarget === null;
      app.attachmentInput.dispatchEvent(new Event("change"));
      await new Promise((r) => setTimeout(r, 200));
      return { pendingBefore, clearedByCancel, rows: app.attachmentRows.length, lastPhase: window.__kinProgressLog.at(-1)?.[1] ?? null, busy: app.busy };
    }, itemId);
    check(third.opened.backendNodeId && cancelled.pendingBefore === itemId && cancelled.clearedByCancel, "cancelling the picker clears the pending item");
    check(cancelled.rows === 1 && !cancelled.busy && cancelled.lastPhase === "error", "a cancelled or empty selection creates no attachment and starts no save");

    return `PASS mobile attachment journey (${passed.length} checks): row button, native chooser, JPEG save with feedback, tile and thumbnail, viewer, navigation, stale refresh, Details, lock/unlock, unsupported file, cancel, isolation`;
  } finally {
    await client.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
    await client.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await client.send("DOM.disable").catch(() => {});
  }
}

// When run directly, delegate to the shared real-browser fixture so this
// command cannot silently do nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const executable = process.argv[2];
  if (!executable) {
    console.error("Usage: node scripts/attachment-upload-regression.mjs <browser executable>");
    process.exitCode = 2;
  } else {
    const runner = join(dirname(fileURLToPath(import.meta.url)), "browser-regression.mjs");
    const result = spawnSync(process.execPath, [runner, executable], { stdio: "inherit", windowsHide: true });
    process.exitCode = result.status ?? 1;
  }
}
