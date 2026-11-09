import DOMPurify from "dompurify";
import { safeUrl } from "./url-safety.js";
import { srcsetCandidates } from "./resolve-urls.js";
export function sanitize(markup) {
  const clean = DOMPurify.sanitize(markup, {
    ALLOWED_TAGS: [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "br",
      "hr",
      "a",
      "img",
      "picture",
      "source",
      "details",
      "summary",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "code",
      "em",
      "strong",
      "del",
      "s",
      "kbd",
      "sup",
      "sub",
      "div",
      "span",
      "input",
    ],
    ALLOWED_ATTR: [
      "href",
      "src",
      "srcset",
      "alt",
      "title",
      "width",
      "height",
      "align",
      "media",
      "type",
      "checked",
      "disabled",
      "start",
      "colspan",
      "rowspan",
      "class",
      "open",
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  const template = document.createElement("template");
  template.innerHTML = clean;
  template.content.querySelectorAll("a").forEach((a) => {
    const href = safeUrl(a.getAttribute("href"));
    if (href) a.setAttribute("href", href);
    else a.removeAttribute("href");
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });
  template.content.querySelectorAll("img[src]").forEach((img) => {
    const src = safeUrl(img.getAttribute("src"), { image: true });
    if (src) img.setAttribute("src", src);
    else img.removeAttribute("src");
  });
  template.content.querySelectorAll("[class]").forEach((el) => {
    const classes = [...el.classList].filter((c) =>
      /^(hljs(?:-[\w-]+)?|language-[\w-]+|contains-task-list|task-list-item)$/.test(
        c,
      ),
    );
    if (classes.length) el.className = classes.join(" ");
    else el.removeAttribute("class");
  });
  template.content.querySelectorAll("[srcset]").forEach((el) => {
    const candidates = srcsetCandidates(el.getAttribute("srcset"))
      .map((c) => {
        const url = safeUrl(c.url, { image: true });
        return url ? `${url}${c.descriptor ? " " + c.descriptor : ""}` : "";
      })
      .filter(Boolean);
    if (candidates.length) el.setAttribute("srcset", candidates.join(", "));
    else el.removeAttribute("srcset");
  });
  template.content.querySelectorAll("input").forEach((i) => {
    if (i.type !== "checkbox") i.remove();
    else i.disabled = true;
  });
  return template.innerHTML;
}
