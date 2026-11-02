// Family photos (#673, #674, #675) in the browser, through the real store,
// engine and encrypted attachment pipeline: Household › Family photos adds
// two photos with a caption, the grid shows their thumbnails, the viewer
// opens one, removing it offers Undo and Undo brings it back, the slideshow
// (<kin-photo-frame>) shows a photo with its caption and who added it, pauses
// while the page is hidden and closes on a tap, and a photo shared into Kin
// or added from Chat opens the add dialog. Pickers never add a second
// persistent file input.
export async function photoAlbumRegressions() {
  const app = document.querySelector("kin-app");
  const check = (condition, message, detail) => {
    if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const until = async (test, message) => {
    for (let index = 0; index < 900; index++) { if (await test()) return; await frame(); }
    check(false, message);
  };
  const idle = () => until(() => !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending, "the album work settles");
  const photoFile = async (name, colour) => {
    const canvas = document.createElement("canvas");
    canvas.width = 800; canvas.height = 600;
    const context = canvas.getContext("2d");
    context.fillStyle = colour; context.fillRect(0, 0, 800, 600);
    context.fillStyle = "#fff"; context.fillRect(200, 150, 400, 300);
    const type = name.endsWith(".png") ? "image/png" : "image/jpeg";
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
    return new File([blob], name, { type });
  };
  const fileInputs = () => app.querySelectorAll('input[type="file"]:not(.album-picker)').length;
  const inputsBefore = fileInputs();
  const tag = crypto.randomUUID().slice(0, 6);

  // The page, from the Household overview.
  app.ctx.navigation.navigate("#household");
  await until(() => app.querySelector('.hub-link[href="#household/photos"]'), "the Household overview links to Family photos");
  app.ctx.navigation.navigate("#household/photos");
  const album = app.albumView;
  await until(() => album?.isConnected && album.getClientRects().length > 0, "Family photos shows");
  const before = (await app.store.album()).photos.length;

  // Add two photos, one with a caption.
  album.openAdd([await photoFile(`beach-${tag}.jpg`, "#2a6f97"), await photoFile(`cake-${tag}.png`, "#c0392b")], { opener: album.addButton });
  check(album.addDialog.open, "the add dialog opens");
  const captions = [...album.addDialog.querySelectorAll(".album-caption-input")];
  check(captions.length === 2, "one caption per photo", captions.length);
  check(captions.every((input) => input.labels?.[0]?.textContent), "each caption has a label");
  check(album.addSubmit.textContent === "Add 2 photos", "the button says how many", album.addSubmit.textContent);
  captions[0].value = `  Beach ${tag} `;
  album.addSubmit.click();
  await until(() => !album.addDialog.open, "the photos are added");
  await idle();
  const saved = await app.store.album();
  check(saved.photos.length === before + 2, "both photos are in the album", saved.photos.length);
  const [cake, beach] = saved.photos;
  check(beach.caption === `Beach ${tag}` && cake.caption === "", "the caption is trimmed; the other has none", [beach.caption, cake.caption]);
  check(/^a1b0[a-f0-9]{28}$/.test(beach.attachmentId), "the image is an album attachment", beach.attachmentId);
  check(beach.addedBy === (app.syncCoordinator?.identity?.memberId ?? app.store.actorId), "who added it is recorded");

  // The grid, newest first, with thumbnails and labels.
  const tileOf = (photo) => album.querySelector(`.album-tile[data-photo-id="${photo.photoId}"]`);
  await until(() => tileOf(beach) && tileOf(cake), "the grid shows both photos");
  const tiles = [...album.querySelectorAll(".album-tile")].map((tile) => tile.dataset.photoId);
  check(tiles.indexOf(cake.photoId) < tiles.indexOf(beach.photoId), "newest first");
  const beachButton = tileOf(beach).querySelector(".album-thumb");
  check(beachButton.getAttribute("aria-label") === `Open “Beach ${tag}”, added by You`, "the tile names the photo and who added it", beachButton.getAttribute("aria-label"));
  check(beachButton.getBoundingClientRect().height >= 44, "the tile is big enough to tap");
  beachButton.scrollIntoView({ block: "center" });
  await until(() => !tileOf(beach).querySelector("img").hidden && tileOf(beach).querySelector("img").getAttribute("src"), "the thumbnail shows");
  check(document.documentElement.scrollWidth <= innerWidth, "nothing scrolls sideways");

  // The viewer.
  beachButton.click();
  await until(() => album.viewer.open && album.viewerImage.getAttribute("src"), "the viewer opens the photo");
  check(album.viewerTitle.textContent === `Beach ${tag}`, "the viewer shows the caption", album.viewerTitle.textContent);
  check(album.viewerMeta.textContent.startsWith("Added by You"), "and who added it", album.viewerMeta.textContent);
  check(!album.removeButton.hidden, "whoever added it may remove it");
  // The viewer image decodes asynchronously (decoding="async", a blob URL), so
  // wait for it rather than checking once; a broken image never gets a width.
  await until(() => album.viewerImage.complete && album.viewerImage.naturalWidth > 0, "the image decodes");

  // Remove, then Undo.
  album.removeButton.click();
  await until(() => !album.viewer.open, "removing closes the viewer");
  await idle();
  await until(() => !tileOf(beach), "the photo leaves the grid");
  check((await app.store.album()).removed.some((entry) => entry.photoId === beach.photoId), "the removal is recorded");
  const undo = app.ctx.undo;
  check(!undo.toast.hidden && undo.toastAction.textContent === "Undo", "Undo is offered", undo.toastText.textContent);
  await until(() => !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending && !undo.running, "Kin is idle before Undo");
  undo.toastAction.click();
  await until(() => !undo.running && !app.busy, "Undo finishes");
  let restored = null;
  for (let tries = 0; tries < 300 && !restored; tries++) {
    restored = (await app.store.album()).photos.find((photo) => photo.attachmentId === beach.attachmentId) ?? null;
    if (!restored) await frame();
  }
  check(restored, "Undo brings the photo back", { status: app.status?.textContent, alert: app.querySelector("[role=alert]")?.textContent, toast: undo.toastText.textContent });
  check(restored.photoId !== beach.photoId && restored.caption === `Beach ${tag}`, "under a new photo ID, with its caption", restored);
  await until(() => tileOf(restored), "it is back in the grid");

  // The slideshow. The test browser may report its page as hidden (a
  // background tab), so visibility is set here and given back at the end.
  let pageHidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => pageHidden });
  album.slideshowButton.click();
  const showing = () => album.frame.querySelector(".photo-frame-slide.is-showing");
  await until(() => album.slideshow.open && showing()?.querySelector("img")?.getAttribute("src"), "the slideshow shows a photo");
  check(album.frame.getAttribute("role") === "region" && album.frame.getAttribute("aria-roledescription") === "slideshow", "the frame is a labelled slideshow region");
  check(showing().querySelector(".photo-frame-added-by").textContent === "Added by You", "the frame says who added it", showing().textContent);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Reduced motion makes every transition next to instant (app.css).
  const fade = Number.parseFloat(getComputedStyle(showing()).transitionDuration);
  check(reduce ? fade <= 0.01 : fade >= 1, "it crossfades, except with reduced motion", { reduce, fade });
  check(album.frame.querySelector(".photo-frame-pause")?.getAttribute("aria-pressed") === "false", "Pause is offered");
  // Hidden page: it pauses; shown again: it carries on.
  pageHidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  check(album.frame.timer === 0, "hidden pauses the slideshow");
  pageHidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  check(album.frame.timer !== 0, "visible again, it carries on");
  // A tap returns.
  album.frame.querySelector(".photo-frame-stage").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await until(() => !album.slideshow.open, "a tap closes the slideshow");
  await until(() => document.activeElement === album.slideshowButton, "focus returns to Slideshow");
  check(album.frame.urls.every((url) => url === null), "the slideshow lets go of its images");
  delete document.hidden;

  // Share sheet: a shared photo can go to Family photos.
  app.ctx.navigation.navigate("#today");
  // Which code opens the add dialog, for a failure report.
  const opens = [];
  const openAdd = album.openAdd;
  album.openAdd = function (...args) { opens.push(new Error().stack.split("\n").slice(2, 5).join(" | ")); return openAdd.apply(this, args); };
  const dialogState = () => ({
    opens, open: album.addDialog.open, modal: album.addDialog.matches(":modal"), inert: Boolean(album.addCancel.closest("[inert]")),
    dialogs: [...document.querySelectorAll("dialog[open]")].map((dialog) => dialog.className), active: document.activeElement?.className,
  });
  const sharing = app.ctx.share.offer({ title: "", text: "", url: "", files: [await photoFile(`shared-${tag}.jpg`, "#16a085")] });
  await until(() => app.shareSheet?.isOpen, "the share sheet opens");
  const destination = app.shareSheet.querySelector('button[data-kind="photos"]');
  check(destination?.textContent === "Add to family photos", "the share sheet offers Family photos");
  destination.click();
  await sharing;
  await until(() => album.addDialog.open && album.addDialog.querySelectorAll(".album-add-row").length === 1, "a shared photo opens the add dialog on Family photos");
  check(app.route?.canonical === "household/photos", "on the Family photos page", app.route);
  // The dialog sits inside the app's controls, which are disabled while Kin is busy.
  await idle();
  album.addCancel.click();
  for (let index = 0; index < 300 && album.addDialog.open; index++) await frame();
  check(!album.addDialog.open, "Cancel closes the add dialog (share)", dialogState());

  // Chat: "Add to the family photos" on a photo opens the same dialog.
  app.onChatToRecord(new CustomEvent("kin:chat-to-record", { detail: { kind: "photos", opener: null, files: [{ name: `chat-${tag}.jpg`, type: "image/jpeg", size: 1, load: () => photoFile(`chat-${tag}.jpg`, "#8e44ad") }] } }));
  await until(() => album.addDialog.open && album.addDialog.querySelectorAll(".album-add-row").length === 1, "a chat photo opens the add dialog");
  // The dialog sits inside the app's controls, which are disabled while Kin is busy.
  await idle();
  album.addCancel.click();
  for (let index = 0; index < 300 && album.addDialog.open; index++) await frame();
  check(!album.addDialog.open, "Cancel closes the add dialog (chat)", dialogState());
  album.openAdd = openAdd;
  check(fileInputs() === inputsBefore, "no persistent file input was added", { before: inputsBefore, after: fileInputs() });

  // Tidy up.
  await idle();
  for (const photo of (await app.store.album()).photos.filter((entry) => [cake.attachmentId, beach.attachmentId].includes(entry.attachmentId))) {
    const result = await app.ctx.album.remove(photo);
    check(result.ok, "the test photos are removed", result);
    await idle();
  }
  app.ctx.undo.clear();
  // Let the sync passes these changes started finish, so their re-render
  // doesn't land in the middle of the next regression.
  await app.syncCoordinator?.syncNow?.();
  await app.syncCoordinator?.syncNow?.();
  await idle();
  app.ctx.navigation.navigate("#today");
  const open = [...document.querySelectorAll("dialog[open]")].map((dialog) => dialog.className);
  check(open.length === 0, "no dialog is left open", open);
  const probe = document.createElement("input");
  app.pages.get("today").append(probe);
  probe.focus();
  const focused = document.activeElement === probe;
  probe.remove();
  check(focused && !app.busy && !app.controlFieldset?.disabled, "focus still moves", { busy: app.busy, fieldset: app.controlFieldset?.disabled, hasFocus: document.hasFocus(), active: document.activeElement?.outerHTML?.slice(0, 120), inert: [...document.querySelectorAll("[inert]")].map((node) => node.tagName + "." + node.className) });
  return "PASS family photos: added with captions, thumbnails, viewer, remove with Undo, slideshow (crossfade, pause when hidden, tap returns), share sheet and chat (#673)";
}
