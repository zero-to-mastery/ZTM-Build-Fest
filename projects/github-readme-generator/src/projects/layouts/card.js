import {
  escapeHtml as h,
  projectImage,
  projectLinks,
} from "../project-output.js";
import { buildLinkedBadge } from "../../badges/shields.js";
const buildBadgeHtml = (b) => buildLinkedBadge(b, "html");
export function cardContent(p) {
  const image = projectImage(p);
  const body = [
    p.imagePlacement === "top" && image,
    `<h3>${h([p.emoji, p.name || "Untitled project"].filter(Boolean).join(" "))}</h3>`,
    p.subtitle && `<p>${h(p.subtitle)}</p>`,
    !["top", "side-by-side"].includes(p.imagePlacement) && image,
    p.description && `<p>${h(p.description).replace(/\n/g, "<br>")}</p>`,
    p.projectType && `<p><strong>Type:</strong> ${h(p.projectType)}</p>`,
    p.role && `<p><strong>Role:</strong> ${h(p.role)}</p>`,
    p.status &&
      p.statusStyle !== "hidden" &&
      (p.statusStyle === "badge"
        ? `<p>${buildBadgeHtml({ label: "Status", message: p.status, alt: `Project status: ${p.status}`, color: "555" })}</p>`
        : `<p><strong>Status:</strong> ${h(p.status)}</p>`),
    p.highlights.some((v) => v.title || v.description) &&
      `<ul>${p.highlights
        .filter((v) => v.title || v.description)
        .map(
          (v) =>
            `<li>${v.title ? `<strong>${h(v.title)}:</strong> ` : ""}${h(v.description)}</li>`,
        )
        .join("")}</ul>`,
    p.technologies.length &&
      `<p>${p.technologies.map((t) => (p.technologyStyle === "badges" ? buildBadgeHtml({ ...t, label: t.name, alt: t.name }) : p.technologyStyle === "text" ? h(t.name) : `<code>${h(t.name)}</code>`)).join(" ")}</p>`,
    `<p>${projectLinks(p)
      .map(([n, u]) => `<a href="${h(u)}">${h(n)}</a>`)
      .join(" · ")}</p>`,
    ...["problem", "architecture", "challenges", "testing", "outcome"]
      .filter((k) => p[k])
      .map(
        (k) =>
          `<h4>${h(k[0].toUpperCase() + k.slice(1))}</h4><p>${h(p[k])}</p>`,
      ),
    p.legacyStatusMarkdown && `<p>${h(p.legacyStatusMarkdown)}</p>`,
    p.badges.length &&
      `<p>${p.badges.map((b) => buildBadgeHtml(b)).join(" ")}</p>`,
  ]
    .filter(Boolean)
    .join("\n");
  return p.imagePlacement === "side-by-side" && image
    ? `<table><tr><td valign="top">${image}</td><td valign="top">${body}</td></tr></table>`
    : body;
}
export const card = (p) =>
  `<table>\n<tr><td>\n${cardContent(p)}\n</td></tr>\n</table>`;
