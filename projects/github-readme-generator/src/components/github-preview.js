import { render } from "../markdown/render.js";
import { documentSegments, contextKey } from "../markdown/source-context.js";
export class GithubPreview extends HTMLElement {
  connectedCallback() {
    this.innerHTML =
      '<article class="markdown-body" aria-label="README preview"></article>';
    this.addEventListener("click", (event) => {
      const link = event.target.closest('a[href^="#"]');
      if (!link) return;
      event.preventDefault();
      let id;
      try {
        id = decodeURIComponent(link.getAttribute("href").slice(1));
      } catch {
        return;
      }
      const target = [...this.querySelectorAll("[id]")].find(
        (el) => el.id === id,
      );
      target?.scrollIntoView({ block: "start" });
    });
  }
  set value(markdown) {
    try {
      this.querySelector("article").innerHTML =
        render(markdown) ||
        '<div class="empty-preview"><h2>A blank page. A fresh start.</h2><p>Add a Hero or About Me section from Build, or start typing Markdown.</p></div>';
      this.applyTheme();
      this.anchors();
    } catch {
      this.failure();
    }
  }
  set draft(draft) {
    try {
      if (!draft.markdown) {
        this.value = "";
        return;
      }
      const groups = [];
      for (const segment of documentSegments(draft)) {
        const last = groups.at(-1);
        if (
          last &&
          contextKey(last.sourceContext) === contextKey(segment.sourceContext)
        )
          last.source += segment.source;
        else groups.push({ ...segment });
      }
      this.querySelector("article").innerHTML = groups
        .map((s) => render(s.source, { sourceContext: s.sourceContext }))
        .join("");
      this.applyTheme();
      this.anchors();
    } catch {
      this.failure();
    }
  }
  failure() {
    this.querySelector("article").innerHTML =
      '<p role="alert">Preview could not be rendered. Your Markdown is preserved; you can keep editing or export it.</p>';
  }
  anchors() {
    const seen = new Set();
    const nextSuffix = new Map();
    this.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
      const slug = h.textContent
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s/g, "-");
      let id = slug,
        n = nextSuffix.get(slug) || 0;
      while (seen.has(id)) id = `${slug}-${++n}`;
      nextSuffix.set(slug, n);
      h.id = id;
      seen.add(id);
    });
  }
  applyTheme() {
    const dark = this.closest(".preview-paper")?.dataset.theme === "dark";
    this.querySelectorAll("source[media]").forEach((s) => {
      if (/prefers-color-scheme/.test(s.media)) {
        s.dataset.originalMedia = s.media;
      }
      const media = s.dataset.originalMedia;
      if (media) s.media = media.includes("dark") === dark ? "all" : "not all";
    });
  }
}
customElements.define("github-preview", GithubPreview);
