import { safeUrl } from "../markdown/url-safety.js";
import { buildLinkedBadge } from "../badges/shields.js";
export const escapeHtml = (s = "") =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const escapeText = (s = "") =>
  String(s).replace(/[\\`*_[\]<>#|]/g, "\\$&");
export const destination = (s, image = false) =>
  safeUrl(s, { image }).replace(
    /[()\s<>"'`]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
export const projectLinks = (p) =>
  [
    ["Repository", p.repositoryUrl],
    ["Live Demo", p.liveUrl],
    ["Case Study", p.caseStudyUrl],
    ...p.links.map((l) => [l.name, l.url]),
  ].filter(([name, url]) => name && safeUrl(url));
export function projectImage(p) {
  if (!safeUrl(p.imageUrl, { image: true }) || p.imagePlacement === "hidden")
    return "";
  const width = /^\d{1,4}$/.test(p.imageWidth)
    ? ` width="${Math.min(1200, Number(p.imageWidth))}"`
    : "";
  let result = `<img src="${escapeHtml(safeUrl(p.imageUrl, { image: true }))}" alt="${escapeHtml(p.imageAlt)}"${width}>`;
  if (safeUrl(p.darkImageUrl, { image: true }))
    result = `<picture>\n<source media="(prefers-color-scheme: dark)" srcset="${escapeHtml(safeUrl(p.darkImageUrl, { image: true }))}">\n${result}\n</picture>`;
  if (safeUrl(p.imageLink))
    result = `<a href="${escapeHtml(safeUrl(p.imageLink))}">${result}</a>`;
  return p.imageAlign === "center" ? `<p align="center">${result}</p>` : result;
}
export function projectTechnologies(p) {
  return p.technologies
    .filter((t) => t.name)
    .map((t) =>
      p.technologyStyle === "badges"
        ? buildLinkedBadge({ ...t, label: t.name, alt: t.name })
        : p.technologyStyle === "text"
          ? escapeText(t.name)
          : `<code>${escapeHtml(t.name)}</code>`,
    )
    .join(p.technologyStyle === "text" ? ", " : " ");
}
export function projectStatus(p) {
  return !p.status || p.statusStyle === "hidden"
    ? ""
    : p.statusStyle === "badge"
      ? buildLinkedBadge({
          label: "Status",
          message: p.status,
          alt: `Project status: ${p.status}`,
          color: "555",
        })
      : `**Status:** ${escapeText(p.status)}`;
}
