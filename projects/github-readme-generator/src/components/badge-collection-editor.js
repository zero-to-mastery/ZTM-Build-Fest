import { badgeWarnings, previewWidths } from "../badges/duplicates.js";
import { badgeImages } from "../badges/shields.js";
import { html } from "../markdown/serialize.js";
import { render } from "../markdown/render.js";
import {
  validateCollection,
  collectionName,
  collectionMarkdown,
  collectionStyles,
  searchCollections,
  starterNames,
  starterCollection,
} from "../badges/collections.js";
import "./badge-studio.js";
export class BadgeCollectionEditor extends HTMLElement {
  connectedCallback() {
    this.items ||= [];
    this.draw();
  }
  isDirty() {
    return (
      this.initial !== JSON.stringify(this.items) ||
      !!this.querySelector(".collection-composer badge-studio")
    );
  }
  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }
  draw() {
    const c = this.items.find((i) => i.id === this.selected);
    this.innerHTML = `<h1>Badge collections</h1><p>Saved separately from drafts. Inserted badges are independent copies.</p><label>Search collections<input data-collection-search value="${html(this.search || "")}"></label><div class="collection-list"></div><div class="row-actions"><button data-new-collection>Create collection</button><label>Collection starter<select data-starter>${starterNames.map((n) => `<option>${n}</option>`).join("")}</select></label><button data-add-starter>Use starter</button></div><label>Import collection JSON<input type="file" accept=".json,application/json" data-collection-file></label><p role="status" data-collection-status></p>${
      c
        ? `<label>Collection name<input data-collection-name maxlength="120" value="${html(c.name)}"></label><label>Collection output<select data-collection-style>${collectionStyles.map((s) => `<option ${s === c.style ? "selected" : ""}>${s}</option>`).join("")}</select></label><div class="row-actions"><button data-save-collection>Save collection</button><button data-duplicate-collection>Duplicate collection</button><button data-delete-collection>Delete collection</button><button data-export-collection>Export collection</button><button data-insert-collection>Insert collection into README</button></div><p class="hint">${c.badges.length} badges${c.badges.length > 8 ? " · Long row: consider splitting into categories." : ""}</p><ol class="collection-badges">${c.badges
            .map(
              (b, i) =>
                `<li><span>${html(b.label || b.name || b.alt || "Badge")}</span><div class="row-actions">${[
                  ["up", "Move up"],
                  ["down", "Move down"],
                  ["edit", "Edit badge"],
                  ["duplicate", "Duplicate badge"],
                  ["remove", "Remove badge"],
                ]
                  .map(
                    ([a, n]) =>
                      `<button data-collection-row="${a}" data-index="${i}" aria-label="${n} ${i + 1}" ${(a === "up" && i === 0) || (a === "down" && i === c.badges.length - 1) ? "disabled" : ""}>${n}</button>`,
                  )
                  .join("")}</div></li>`,
            )
            .join(
              "",
            )}</ol><button data-add-collection-badge>Add badge to collection</button><div class="collection-composer"></div><label>Collection preview width<select data-collection-width>${Object.entries(
            previewWidths,
          )
            .map(
              ([name, width]) =>
                `<option value="${width}">${name[0].toUpperCase() + name.slice(1)}</option>`,
            )
            .join(
              "",
            )}</select></label><div class="collection-advice"></div><div class="collection-preview markdown-body"></div>`
        : ""
    }`;
    if (this.componentMode) {
      this.setAttribute("data-component-mode", "true");
      this.querySelector("h1").textContent = "Badge row settings";
      this.querySelector("p").textContent =
        "Independent badges for this README component. Use Save component changes below to apply.";
      for (const selector of [
        "[data-collection-search]",
        "[data-starter]",
        "[data-collection-file]",
      ])
        this.querySelector(selector)
          ?.closest("label")
          .setAttribute("hidden", "");
      this.querySelector(".collection-list").hidden = true;
      for (const el of this.querySelectorAll(
        "[data-new-collection],[data-add-starter],[data-save-collection],[data-duplicate-collection],[data-delete-collection],[data-insert-collection]",
      ))
        el.hidden = true;
    }
    this.list();
    this.querySelector("[data-collection-search]").oninput = (e) => {
      this.search = e.target.value;
      this.list();
    };
    this.querySelector("[data-new-collection]").onclick = () =>
      this.add({
        version: 1,
        type: "badge-collection",
        name: "My collection",
        badges: [],
      });
    this.querySelector("[data-add-starter]").onclick = () =>
      this.add(starterCollection(this.querySelector("[data-starter]").value));
    this.querySelector("[data-collection-file]").onchange = async (e) => {
      try {
        const f = e.target.files[0];
        if (!f) return;
        if (f.size > 5_000_000) throw new Error("Collection exceeds 5 MB.");
        const raw = await f.text();
        if (!this.isConnected) return;
        this.add(validateCollection(JSON.parse(raw)));
        this.status("Collection imported. Save collection to keep it.");
      } catch (error) {
        this.status(error.message);
      }
    };
    if (!c) return;
    this.querySelector("[data-collection-name]").oninput = (e) =>
      (c.name = e.target.value);
    this.querySelector("[data-collection-style]").onchange = (e) => {
      c.style = e.target.value;
      this.preview();
    };
    this.querySelector("[data-save-collection]").onclick = () => {
      try {
        this.items = this.items.map((i) =>
          validateCollection(i, { preserveId: true }),
        );
        this.emit("collections-save", this.items);
      } catch (e) {
        this.status(e.message);
      }
    };
    this.querySelector("[data-duplicate-collection]").onclick = () =>
      this.add(c);
    this.querySelector("[data-delete-collection]").onclick = () => {
      if (
        !confirm(
          `Delete collection “${c.name}”? Existing README content is unchanged. Save collections to keep this deletion.`,
        )
      )
        return;
      this.items = this.items.filter((i) => i.id !== c.id);
      this.selected = this.items[0]?.id;
      this.draw();
      this.emit("collections-save", this.items);
      this.querySelector("[data-new-collection]").focus();
    };
    this.querySelector("[data-export-collection]").onclick = () => {
      try {
        this.emit(
          "collection-export",
          validateCollection(c, { preserveId: true }),
        );
      } catch (e) {
        this.status(e.message);
      }
    };
    this.querySelector("[data-insert-collection]").onclick = () => {
      try {
        this.emit(
          "collection-insert",
          validateCollection(c, { preserveId: true }),
        );
      } catch (e) {
        this.status(e.message);
      }
    };
    this.querySelector("[data-add-collection-badge]").onclick = () =>
      this.compose();
    this.querySelectorAll("[data-collection-row]").forEach(
      (b) =>
        (b.onclick = () => {
          const i = Number(b.dataset.index),
            a = b.dataset.collectionRow;
          if (a === "edit") {
            this.compose(i);
            return;
          }
          let next = i;
          if (a === "remove") c.badges.splice(i, 1);
          if (a === "duplicate")
            c.badges.splice(i + 1, 0, structuredClone(c.badges[i]));
          if (a === "up" || a === "down") {
            next = i + (a === "up" ? -1 : 1);
            [c.badges[i], c.badges[next]] = [c.badges[next], c.badges[i]];
          }
          this.draw();
          (
            this.querySelector(
              `[data-index="${Math.min(next, c.badges.length - 1)}"]:not(:disabled)`,
            ) || this.querySelector("[data-add-collection-badge]")
          ).focus();
        }),
    );
    this.querySelector("[data-collection-width]").onchange = () =>
      this.preview();
    this.preview();
  }
  status(message) {
    this.querySelector("[data-collection-status]").textContent = message;
  }
  list() {
    this.querySelector(".collection-list").innerHTML =
      searchCollections(this.items, this.search || "")
        .map(
          (c) =>
            `<button data-collection-id="${html(c.id)}" aria-pressed="${c.id === this.selected}">${html(c.name)}</button>`,
        )
        .join("") || "No saved collections.";
    this.querySelectorAll("[data-collection-id]").forEach(
      (b) =>
        (b.onclick = () => {
          this.selected = b.dataset.collectionId;
          this.draw();
          this.querySelector("[data-collection-name]").focus();
        }),
    );
  }
  add(value) {
    const c = validateCollection(value);
    c.name = collectionName(c.name, this.items);
    this.items.push(c);
    this.selected = c.id;
    this.draw();
    this.querySelector("[data-collection-name]").focus();
  }
  compose(index) {
    const c = this.items.find((i) => i.id === this.selected),
      area = this.querySelector(".collection-composer");
    area.innerHTML = "<badge-studio></badge-studio>";
    const studio = area.firstElementChild;
    studio.collectionMode = true;
    if (index !== undefined) studio.badge = c.badges[index];
    else studio.draw();
    studio.querySelector(".badge-insertion").hidden = true;
    studio.querySelector("[data-insert-badge]").textContent =
      "Use badge in collection";
    studio.addEventListener("badge-insert", (e) => {
      e.stopPropagation();
      if (index === undefined) c.badges.push(e.detail.badge);
      else c.badges[index] = e.detail.badge;
      this.draw();
      this.querySelector(
        this.componentMode
          ? "[data-add-collection-badge]"
          : "[data-save-collection]",
      ).focus();
    });
    studio.querySelector("input").focus();
  }
  preview() {
    const c = this.items.find((i) => i.id === this.selected),
      el = this.querySelector(".collection-preview");
    el.style.maxWidth =
      this.querySelector("[data-collection-width]").value + "px";
    const warnings = badgeWarnings(
      c.badges.map((b) => ({
        url: badgeImages(b).light,
        alt: b.alt,
        section: c.name,
      })),
    );
    this.querySelector(".collection-advice").innerHTML = warnings
      .map(
        (i) =>
          `<p><strong>${html(i.category)}:</strong> ${html(i.message)}</p>`,
      )
      .join("");
    el.innerHTML = render(
      collectionMarkdown({ ...c, badges: c.badges.slice(0, 20) }),
    );
    el.querySelectorAll("img").forEach((i) => {
      i.loading = "lazy";
    });
    if (c.badges.length > 20)
      el.insertAdjacentHTML(
        "beforeend",
        "<p>Preview limited to the first 20 badges. Export includes every badge.</p>",
      );
  }
}
customElements.define("badge-collection-editor", BadgeCollectionEditor);
