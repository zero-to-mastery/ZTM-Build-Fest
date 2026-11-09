import { serializeDocumentation } from "../documentation/sections.js";
import { callout, details, codeSample, columns } from "../styling/blocks.js";
import { present, divider } from "../styling/presentation.js";
import { serializeShowcase } from "../projects/serialize-project.js";
import { safeUrl } from "./url-safety.js";
import {
  EXAMPLE_STATUSES,
  exampleMarker,
  validateExampleProvenance,
} from "../documentation/example-provenance.js";
export { safeUrl } from "./url-safety.js";
export const html = (value = "") =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const text = (value = "") =>
  String(value)
    .replace(/[\\`*_[\]<>#]/g, "\\$&")
    .replace(/\r?\n/g, " ");
const destination = (value, image = false) =>
  safeUrl(value, { image }).replace(/[()\s]/g, (c) => encodeURIComponent(c));
export { buildStaticBadge as badgeUrl } from "../badges/shields.js";
import { buildLinkedBadge } from "../badges/shields.js";
export function picture(s) {
  const size = ["width", "height"]
    .filter((k) => /^\d+$/.test(String(s[k])))
    .map((k) => ` ${k}="${s[k]}"`)
    .join("");
  let result = `<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="${html(safeUrl(s.dark, { image: true }))}">\n  <img src="${html(safeUrl(s.light, { image: true }))}" alt="${html(s.alt)}"${size}>\n</picture>`;
  if (safeUrl(s.link))
    result = `<a href="${html(safeUrl(s.link))}">\n${result}\n</a>`;
  return s.align === "center" ? `<p align="center">\n${result}\n</p>` : result;
}
export const badge = (s) => buildLinkedBadge(s);
export function widget(s) {
  const img = `<img src="${html(safeUrl(s.image, { image: true }))}" alt="${html(s.alt)}">`;
  if (s.align === "center")
    return `<p align="center">${safeUrl(s.link) ? `<a href="${html(safeUrl(s.link))}">${img}</a>` : img}</p>`;
  const md = `![${text(s.alt)}](${destination(s.image, true)})`;
  return safeUrl(s.link) ? `[${md}](${destination(s.link)})` : md;
}
export function social(s) {
  const links = (s.items || []).filter((i) => safeUrl(i.url));
  if (s.style === "footer")
    return `<p align="center">${links.map((i) => `<a href="${html(safeUrl(i.url))}">${html(i.name)}</a>`).join(" · ")}</p>`;
  return links
    .map((i) =>
      s.style === "links"
        ? `[${text(i.name)}](${destination(i.url)})`
        : badge({
            label: i.name,
            logo: i.logo || i.name.toLowerCase(),
            color: "30363d",
            link: i.url,
          }),
    )
    .join(" ");
}
export function project(s) {
  const title = `${s.icon || ""} ${s.name || "Untitled project"}`.trim();
  const links = [
    ["Project", s.url],
    ["Source", s.github],
    ["Live demo", s.demo],
    ...(s.links || []).map((i) => [i.name, i.url]),
  ].filter(([, u]) => safeUrl(u));
  if (s.layout === "card")
    return `<table><tr><td>\n<h3>${html(title)}</h3>\n<p>${html(s.subtitle)}</p>\n<p>${html(s.description)}</p>\n${safeUrl(s.image, { image: true }) ? `<img src="${html(safeUrl(s.image, { image: true }))}" alt="${html(s.name)} screenshot" width="480">` : ""}\n<ul>${(
      s.highlights || ""
    )
      .split("\n")
      .filter(Boolean)
      .map((h) => `<li>${html(h)}</li>`)
      .join(
        "",
      )}</ul>\n<p>${html(s.stack)}</p>\n<p>${links.map(([n, u]) => `<a href="${html(safeUrl(u))}">${html(n)}</a>`).join(" · ")}</p>\n</td></tr></table>\n\n${s.status || ""}`;
  const head = `### ${safeUrl(s.url) ? `[${text(title)}](${destination(s.url)})` : text(title)}\n\n${text(s.subtitle)}\n\n`;
  if (s.layout === "compact") return head + text(s.stack);
  return (
    head +
    [
      s.description,
      safeUrl(s.image, { image: true })
        ? `![${text(s.name)} screenshot](${destination(s.image, true)})`
        : "",
      (s.highlights || "")
        .split("\n")
        .filter(Boolean)
        .map((h) => `- ${h}`)
        .join("\n"),
      s.stack ? `**Built with:** ${text(s.stack)}` : "",
      links.map(([n, u]) => `[${text(n)}](${destination(u)})`).join(" · "),
      s.status,
    ]
      .filter(Boolean)
      .join("\n\n")
  );
}
export function stack(s) {
  const groups = {};
  for (const item of s.items || [])
    (groups[s.headings ? item.category || "Other" : ""] ||= []).push(item);
  return Object.entries(groups)
    .map(
      ([category, items]) =>
        (category ? `### ${text(category)}\n\n` : "") +
        items
          .map((i) =>
            s.style === "text"
              ? text(i.name)
              : s.style === "chips"
                ? `<code>${html(i.name)}</code>`
                : badge({ ...i, label: i.name }),
          )
          .join(s.style === "text" ? ", " : " "),
    )
    .join("\n\n");
}
export const serializeBlock = (b) =>
  b.type === "component"
    ? b.settings.markdown
    : present(serializeContent(b), b);
function serializeContent({ type, settings: s }) {
  if (type.startsWith("doc-")) return serializeDocumentation(type, s);
  switch (type) {
    case "callout":
      return callout(s);
    case "details":
      return details(s);
    case "code":
      return codeSample({
        ...s,
        marker:
          s.exampleProvenance &&
          typeof s.exampleProvenance === "object" &&
          !Array.isArray(s.exampleProvenance) &&
          EXAMPLE_STATUSES.includes(s.exampleProvenance.status) &&
          typeof s.exampleProvenance.basis === "string"
            ? exampleMarker(
                validateExampleProvenance(s.exampleProvenance).status,
                s.code,
              )
            : "",
      });
    case "columns":
      return columns(s);
    case "hero":
      return `# ${text(s.name || "Your Name")}\n\n${s.subtitle || ""}`;
    case "badge":
      return s.presentation?.center
        ? `<p align="center">${buildLinkedBadge(s, "html")}</p>`
        : badge(s);
    case "badges":
      return (
        (s.title ? `## ${text(s.title)}\n\n` : "") +
        (s.presentation?.center
          ? `<p align="center">${(s.items || []).map((b) => buildLinkedBadge(b, "html")).join(" ")}</p>`
          : (s.items || []).map(badge).join(" "))
      );
    case "stack":
      return `## Tech Stack\n\n${stack(s)}`;
    case "social":
    case "contact":
      return social(s);
    case "projects":
      if (s.version === 1) return serializeShowcase(s);
      return `## ${text(s.title || "Selected Projects")}\n\n${(s.items || []).map(project).join("\n\n")}`;
    case "widget":
      return widget(s.presentation?.center ? { ...s, align: "center" } : s);
    case "picture":
      return picture(s.presentation?.center ? { ...s, align: "center" } : s);
    case "divider":
      return divider(s.dividerStyle || "rule", s.presentation?.decoration);
    case "custom":
      return s.markdown || "";
    default:
      return `## ${text(s.title || "About Me")}\n\n${s.body || ""}`;
  }
}
export const serializeBlocks = (blocks) =>
  blocks
    .map((b, i) => (i ? (b.separator ?? "\n\n") : "") + serializeBlock(b))
    .join("");
export const createBlock = (type, settings = {}) => ({
  id: crypto.randomUUID(),
  type,
  settings,
});
