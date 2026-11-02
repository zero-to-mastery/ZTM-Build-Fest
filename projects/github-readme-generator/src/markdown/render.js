import { marked } from "marked";
import hljs from "highlight.js/lib/common";
import { sanitize } from "./sanitize.js";
import {
  resolveImageUrl,
  resolveLinkUrl,
  resolveSrcset,
  isRelativeUrl,
} from "./resolve-urls.js";
marked.use({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const language = (lang || "").split(" ")[0];
      const value = hljs.getLanguage(language)
        ? hljs.highlight(text, { language }).value
        : text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
      return `<pre><code class="hljs">${value}</code></pre>`;
    },
  },
});
export function render(markdown, { sourceContext = null } = {}) {
  const template = document.createElement("template");
  template.innerHTML = sanitize(marked.parse(markdown));
  template.content.querySelectorAll("a[href]").forEach((a) => {
    const href = resolveLinkUrl(a.getAttribute("href"), sourceContext);
    if (href) {
      a.setAttribute("href", href);
      if (href.startsWith("#")) {
        a.removeAttribute("target");
        a.removeAttribute("rel");
      }
    } else {
      a.removeAttribute("href");
      a.title =
        "This relative or unsafe link cannot be opened from this preview.";
    }
  });
  template.content.querySelectorAll("img[src]").forEach((img) => {
    const raw = img.getAttribute("src"),
      src = resolveImageUrl(raw, sourceContext);
    if (src) img.setAttribute("src", src);
    else {
      img.removeAttribute("src");
      if (isRelativeUrl(raw)) {
        const note = document.createElement("span");
        note.className = "unresolved-image";
        note.textContent = `Relative image cannot be previewed from this ${sourceContext?.type === "mixed" ? "mixed-source" : "local"} import: ${raw}`;
        img.after(note);
      }
    }
  });
  template.content.querySelectorAll("[srcset]").forEach((el) => {
    const value = resolveSrcset(el.getAttribute("srcset"), sourceContext);
    if (value) el.setAttribute("srcset", value);
    else el.removeAttribute("srcset");
  });
  return template.innerHTML;
}
