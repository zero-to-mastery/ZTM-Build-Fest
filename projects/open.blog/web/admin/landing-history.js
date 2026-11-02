// Earlier versions of the landing page (ADR 0264): a disclosure under the sections with the versions the
// server kept, newest first, each with its date and a short summary of what changed, a preview and a
// Restore button. Restoring is an ordinary save made by the server, so it makes a new version and the
// page it replaced stays in the list. Nothing here edits a page; it only asks the server to put one back.

import { el } from "./block-forms.js";

let uid = 0;

const when = (savedAt) => {
  const date = new Date(savedAt);
  return Number.isNaN(date.getTime()) ? String(savedAt || "") : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

/**
 * `call(method, path, options)` is the Admin API. `getRevision()` is the revision the owner is looking at,
 * `hasUnsaved()` whether there are unsaved edits, `onRestored(result)` takes the server's view of the page
 * after a restore, `onConflict(current)` takes a newer page found instead, and `makeFrame()` makes a preview
 * frame like the one beside the sections. Returns `{ element, refresh() }`.
 */
export function buildHistory({ call, getRevision, hasUnsaved, onRestored, onConflict, makeFrame }) {
  const id = `oba-history-${++uid}`;
  const toggle = el("button", { class: "oba-btn", type: "button", "aria-expanded": "false", "aria-controls": id, "data-action": "history" }, "History");
  const status = el("p", { class: "oba-small", role: "status", "aria-live": "polite", "data-history-status": "true" });
  const list = el("ul", { class: "oba-history-list", "aria-label": "Earlier versions of your landing page" });
  const previewSlot = el("div", { class: "oba-history-preview", hidden: true });
  const panel = el(
    "section",
    { class: "oba-history", id, hidden: true, "aria-labelledby": `${id}-title`, "data-history": "true" },
    el("h2", { id: `${id}-title` }, "History"),
    el("p", { class: "oba-small" }, "Every time you save, the page is kept here. Restore puts an older one back; the one you replace stays in the list."),
    status,
    list,
    previewSlot,
  );
  const element = el("div", { class: "oba-history-wrap" }, toggle, panel);
  let open = false;
  let busy = false;
  let frame = null;
  let ticket = 0;

  const say = (text) => {
    status.textContent = text;
  };

  async function preview(version, button) {
    const mine = ++ticket;
    frame ||= makeFrame({ title: "Preview of an earlier version" });
    previewSlot.hidden = false;
    previewSlot.replaceChildren(
      el("h3", {}, `Preview: ${when(version.savedAt)}`),
      el("button", { class: "oba-btn", type: "button", "data-action": "history-close-preview", onClick: () => {
        previewSlot.hidden = true;
        previewSlot.replaceChildren();
        button.focus();
      } }, "Close preview"),
      frame.root,
    );
    frame.layout();
    frame.say("Loading the preview…");
    try {
      const item = await call("GET", `landing/history/item?id=${version.id}`);
      const built = await call("POST", "landing/preview", { json: { page: item.page } });
      if (mine !== ticket) return;
      frame.show(built.previewUrl);
      frame.say("This is how that version looked. Nothing has been changed.");
    } catch {
      if (mine === ticket) frame.say("That version could not be previewed.");
    }
  }

  function ask(version, row, button) {
    row.querySelector(".oba-history-confirm")?.remove();
    const confirm = el(
      "div",
      { class: "oba-history-confirm", role: "group", "aria-label": "Confirm restoring" },
      el("p", {}, "You have changes that are not saved. Restoring replaces them with this version. The last version you saved stays in the list."),
      el("button", { class: "oba-btn oba-btn-primary", type: "button", onClick: () => restore(version, button) }, "Restore anyway"),
      el("button", { class: "oba-btn", type: "button", onClick: () => {
        confirm.remove();
        button.focus();
      } }, "Keep editing"),
    );
    row.append(confirm);
    confirm.querySelector("button").focus();
  }

  async function restore(version, button) {
    if (busy) return;
    busy = true;
    say("Restoring…");
    try {
      const result = await call("POST", "landing/history/restore", { json: { id: version.id, revision: getRevision() } });
      say(`Restored the version from ${when(version.savedAt)}. Your previous version is still in the list.`);
      onRestored(result);
      await load();
      list.querySelector("button")?.focus();
    } catch (error) {
      if (error?.status === 409 && error.data?.conflict) {
        say("Your page was changed somewhere else, so nothing was restored. Choose how to continue above.");
        onConflict?.(error.data.current);
      } else if (error?.data?.newerVersion) {
        say("This page was saved by a newer open.blog, so it was not changed. Update open.blog to restore it.");
      } else {
        say("That version could not be restored. Nothing was changed.");
      }
      button.focus();
    } finally {
      busy = false;
    }
  }

  function draw(data) {
    const versions = Array.isArray(data?.versions) ? data.versions : [];
    list.replaceChildren(
      ...versions.map((version) => {
        const row = el("li", { class: "oba-history-item", "data-version": String(version.id) });
        const date = when(version.savedAt);
        row.append(
          el("span", { class: "oba-history-when" }, date, version.current ? el("strong", { class: "oba-history-current" }, " (current)") : null),
          el("span", { class: "oba-history-summary" }, version.summary || "Saved"),
        );
        const actions = el("span", { class: "oba-history-actions" });
        const previewButton = el("button", { class: "oba-btn", type: "button", "data-action": "history-preview", "aria-label": `Preview the version from ${date}: ${version.summary || "saved"}` }, "Preview");
        previewButton.addEventListener("click", () => preview(version, previewButton));
        actions.append(previewButton);
        if (!version.current) {
          const restoreButton = el("button", { class: "oba-btn", type: "button", "data-action": "history-restore", "aria-label": `Restore the version from ${date}: ${version.summary || "saved"}` }, "Restore");
          restoreButton.addEventListener("click", () => (hasUnsaved() ? ask(version, row, restoreButton) : restore(version, restoreButton)));
          actions.append(restoreButton);
        }
        row.append(actions);
        return row;
      }),
    );
    if (!versions.length) list.append(el("li", { class: "oba-small", "data-history-empty": "true" }, "No earlier versions yet. Your first save will appear here."));
    if (data?.skipped) say(`${data.skipped} saved ${data.skipped === 1 ? "version was" : "versions were"} written by a newer open.blog and ${data.skipped === 1 ? "is" : "are"} left alone.`);
  }

  async function load() {
    try {
      draw(await call("GET", "landing/history"));
    } catch {
      say("The history could not be loaded.");
    }
  }

  toggle.addEventListener("click", async () => {
    open = !open;
    toggle.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
    if (open) {
      say("");
      await load();
    }
  });

  return {
    element,
    /** After a save: show the new version if the list is open; it is loaded fresh each time it is opened. */
    refresh: () => (open ? load() : undefined),
  };
}
