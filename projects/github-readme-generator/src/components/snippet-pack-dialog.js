import { html } from "../markdown/serialize.js";
import { render } from "../markdown/render.js";
import {
  PACK_LIMIT,
  validatePack,
  exportPack,
  packChoices,
  packCollisions,
  choiceMarkdown,
  packItems,
  packTrustReview,
} from "../snippets/pack-schema.js";
import { examplePacks } from "../snippets/example-packs.js";
export class SnippetPackDialog extends HTMLElement {
  connectedCallback() {
    this.configure({}, null);
  }
  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }
  status(message) {
    this.querySelector(".pack-status").textContent = message;
  }
  configure(data, draft) {
    this.data = data;
    this.choices = packChoices(data, draft);
    this.innerHTML = `<h1>Portable snippet packs</h1><p>Share ordinary JSON files in a repository, gist or message. Imported Markdown is untrusted; previews are sanitized. Relative images may need their original repository assets.</p><details open><summary>Export a pack</summary>${[
      ["name", "Pack name", "My README Kit"],
      ["description", "Pack description", ""],
      ["author", "Pack author", ""],
      ["homepage", "Pack homepage", ""],
      ["license", "Pack license note", ""],
    ]
      .map(
        ([k, l, v]) =>
          `<label>${l}<input data-pack-meta="${k}" value="${v}"></label>`,
      )
      .join(
        "",
      )}<button data-select-pack>Select all export items</button><button data-clear-pack>Clear export selection</button><div class="pack-choices">${this.choices.map((c, i) => `<label><input type="checkbox" data-pack-choice="${i}">${html(c.name)} (${html(c.kind)})</label>`).join("") || "<p>No saved snippets or draft sections yet.</p>"}</div><button data-export-pack>Download selected pack</button><button data-backup-snippets>Download all reusable snippets backup</button></details><details open><summary>Import a pack</summary><label>Snippet pack file<input data-pack-file type="file" accept="application/json,.json"></label><label>Snippet pack JSON<textarea data-pack-json rows="5" aria-label="Snippet pack JSON"></textarea></label><button data-review-pack>Review snippet pack</button><label>Example pack<select data-example-pack aria-label="Example pack">${examplePacks.map((p, i) => `<option value="${i}">${html(p.name)}</option>`).join("")}</select></label><button data-load-example>Review example pack</button><div class="pack-review"></div></details><p class="pack-status" role="status"></p>`;
    this.querySelector("[data-select-pack]").onclick = () =>
      this.querySelectorAll("[data-pack-choice]").forEach(
        (c) => (c.checked = true),
      );
    this.querySelector("[data-clear-pack]").onclick = () =>
      this.querySelectorAll("[data-pack-choice]").forEach(
        (c) => (c.checked = false),
      );
    this.querySelector("[data-export-pack]").onclick = () => this.export(false);
    this.querySelector("[data-backup-snippets]").onclick = () =>
      this.export(true);
    this.querySelector("[data-review-pack]").onclick = () =>
      this.review(this.querySelector("[data-pack-json]").value, {
        source: "Pasted JSON",
      });
    this.querySelector("[data-load-example]").onclick = () =>
      this.review(
        examplePacks[Number(this.querySelector("[data-example-pack]").value)],
        {
          source: `Bundled example: ${examplePacks[Number(this.querySelector("[data-example-pack]").value)].name}`,
        },
      );
    this.querySelector("[data-pack-json]").oninput = () => {
      this.pending = null;
      this.querySelector(".pack-review").replaceChildren();
    };
    this.querySelector("[data-pack-file]").onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        if (file.size > PACK_LIMIT)
          throw Error("Snippet packs are limited to 10 MB.");
        const text = await file.text();
        if (!this.isConnected) return;
        this.querySelector("[data-pack-json]").value = text;
        this.review(text, { source: file.name });
      } catch (error) {
        this.status(error.message);
      }
    };
  }
  export(all) {
    try {
      const meta = Object.fromEntries(
        [...this.querySelectorAll("[data-pack-meta]")].map((e) => [
          e.dataset.packMeta,
          e.value,
        ]),
      );
      const choices = all
        ? this.choices.filter((c) => !c.key.startsWith("block:"))
        : [...this.querySelectorAll("[data-pack-choice]:checked")].map(
            (e) => this.choices[Number(e.dataset.packChoice)],
          );
      if (!choices.length)
        throw Error("Select at least one snippet or badge collection.");
      const pack = exportPack(
        meta,
        choices.filter((c) => c.component).map((c) => c.component),
        choices.filter((c) => c.collection).map((c) => c.collection),
      );
      this.emit("visual-download", {
        content: JSON.stringify(pack, null, 2),
        name: pack.name + ".snippets.json",
        type: "application/json",
      });
      this.status("Snippet pack downloaded.");
    } catch (e) {
      this.status(e.message);
    }
  }
  review(input, provenance = {}) {
    this.pending = null;
    const area = this.querySelector(".pack-review");
    try {
      const pack = validatePack(input);
      this.pending = pack;
      const collisions = packCollisions(this.data, pack);
      const items = packItems(pack);
      const trust = packTrustReview(pack, provenance);
      area.innerHTML = `<h2 tabindex="-1">Import ${html(pack.name)}</h2><p>${html(pack.description)}</p><p>Version ${pack.version}${pack.migratedFrom ? ` · migrated from version ${pack.migratedFrom}` : ""} · ${pack.snippets.length} snippets · ${pack.extensions.length} extension manifests (${pack.extensions.reduce((total, manifest) => total + manifest.entries.length, 0)} entries) · ${pack.badgeCollections.length} badge collections</p><section aria-labelledby="pack-trust-title"><h3 id="pack-trust-title">Import trust review</h3><p>Source: ${html(trust.provenance.source)} · Author: ${html(trust.provenance.author)}</p><p>Claimed extension publishers: ${html(trust.publishers.map((publisher) => `${publisher.name} — ${publisher.url}`).join(", ") || "None")}</p><p>Declared inert capabilities: ${html(trust.capabilities.join(", ") || "None")}. Extension manifests cannot load or evaluate scripts.</p><p>${trust.externalUrls.length} external URLs. Opening a rendered preview or following a listed link may contact these hosts; importing does not.</p><ul data-pack-urls>${trust.externalUrls.map((url) => `<li><code>${html(url)}</code></li>`).join("") || "<li>None</li>"}</ul></section><p>License note: ${html(pack.license || "Not specified")}</p>${pack.homepage ? `<a href="${html(pack.homepage)}" target="_blank" rel="noopener noreferrer">Pack homepage</a>` : ""}<p>${collisions.length} existing collisions. Duplicate entries within the pack also use the selected policy.</p><ul>${collisions.map((c) => `<li>${html(c.name)} → ${html(c.matches.join(", "))}</li>`).join("")}</ul><label>Collision policy<select data-pack-mode aria-label="Collision policy"><option value="keep">Keep both (default)</option><option value="replace">Replace matching saved items</option><option value="skip">Skip conflicting items</option></select></label><label>Preview pack item<select data-pack-item aria-label="Preview pack item">${items.map((item, i) => `<option value="${i}">${html(item.name)} (${html(item.kind)})</option>`).join("")}</select></label><button data-preview-pack>Render item preview (contacts image hosts)</button><label>Pack item Markdown<textarea data-pack-source aria-label="Pack item Markdown" readonly rows="5"></textarea></label><div class="pack-item-preview markdown-body"></div><button data-import-pack class="primary">Import reviewed pack</button><button data-cancel-pack>Cancel import</button>`;
      const source = () => {
        const index = Number(area.querySelector("[data-pack-item]").value),
          choice = items[index];
        return choice ? choiceMarkdown(choice) : "";
      };
      area.querySelector("[data-pack-source]").value = source();
      area.querySelector("[data-pack-item]").onchange = () => {
        area.querySelector("[data-pack-source]").value = source();
        area.querySelector(".pack-item-preview").replaceChildren();
      };
      area.querySelector("[data-preview-pack]").onclick = () =>
        (area.querySelector(".pack-item-preview").innerHTML = render(source()));
      area.querySelector("[data-import-pack]").onclick = () => {
        const mode = area.querySelector("[data-pack-mode]").value;
        if (
          mode === "replace" &&
          !confirm(
            "Replace matching saved reusable items? Export a backup first if you need the prior versions.",
          )
        )
          return;
        this.emit("snippet-pack-import", { pack: this.pending, mode });
      };
      area.querySelector("[data-cancel-pack]").onclick = () => {
        this.pending = null;
        area.replaceChildren();
        this.querySelector("[data-review-pack]").focus();
      };
      area.querySelector("h2").focus();
    } catch (e) {
      area.replaceChildren();
      this.status(e.message);
    }
  }
}
customElements.define("snippet-pack-dialog", SnippetPackDialog);
