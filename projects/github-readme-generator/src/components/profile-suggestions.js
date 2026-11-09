import { suggestions, profileLinks } from "../github/suggestions.js";
import { html as h, social } from "../markdown/serialize.js";
export class ProfileSuggestions extends HTMLElement {
  configure(draft) {
    this.draft = structuredClone(draft);
    this.draw();
  }
  draw() {
    this.items = suggestions(this.draft);
    this.innerHTML = `<h1>Profile Intelligence</h1><p>Local, explainable authoring opportunities from loaded public data. Nothing is fetched or applied automatically. Technical accessibility and compatibility issues remain in README Health.</p>${!this.draft.metadata?.githubProfile?.snapshot ? "<p>Run GitHub Autofill to load public profile links. Existing repository context can still be used.</p>" : ""}<div>${this.items.map((s, i) => `<article><h2>${h(s.title)}</h2><p>${h(s.reason)}</p><button data-open="${i}">${s.action === "contact" ? "Review public links" : "Open builder"}</button><button data-dismiss="${i}" aria-label="Dismiss ${h(s.title)}">Dismiss</button></article>`).join("") || "<p>No undismissed content opportunities for this context.</p>"}</div><div data-links hidden></div><button data-reset>Reset dismissed suggestions</button><p role="status"></p>`;
    this.querySelectorAll("[data-dismiss]").forEach(
      (b) =>
        (b.onclick = () =>
          this.dispatchEvent(
            new CustomEvent("suggestion-dismiss", {
              bubbles: true,
              detail: this.items[Number(b.dataset.dismiss)],
            }),
          )),
    );
    this.querySelector("[data-reset]").onclick = () =>
      this.dispatchEvent(
        new CustomEvent("suggestion-reset", { bubbles: true }),
      );
    this.querySelectorAll("[data-open]").forEach(
      (b) =>
        (b.onclick = () => {
          const s = this.items[Number(b.dataset.open)];
          if (s.action === "contact") {
            this.reviewLinks();
            return;
          }
          this.dispatchEvent(
            new CustomEvent("suggestion-open", {
              bubbles: true,
              detail: s.action,
            }),
          );
        }),
    );
  }
  reviewLinks() {
    const links = profileLinks(this.draft.metadata.githubProfile?.snapshot);
    const el = this.querySelector("[data-links]");
    el.hidden = false;
    el.innerHTML = `<h2>Review public contact links</h2>${links.map((l, i) => `<label class="check"><input type="checkbox" data-link="${i}" checked>${h(l.name)}: ${h(l.url)}</label>`).join("")}<label>Contact Markdown<textarea readonly aria-label="Contact Markdown"></textarea></label><button data-add-links>Add selected links</button>`;
    const update = () => {
      this.links = [...el.querySelectorAll("[data-link]:checked")].map(
        (i) => links[Number(i.dataset.link)],
      );
      el.querySelector("textarea").value = social({
        style: "links",
        items: this.links,
      });
    };
    el.onchange = update;
    update();
    el.querySelector("[data-add-links]").onclick = () =>
      this.dispatchEvent(
        new CustomEvent("suggestion-links", {
          bubbles: true,
          detail: { links: this.links, snapshot: JSON.stringify(this.draft) },
        }),
      );
    el.querySelector("input")?.focus();
  }
}
customElements.define("profile-suggestions", ProfileSuggestions);
