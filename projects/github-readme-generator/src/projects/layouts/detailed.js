import {
  escapeText,
  projectImage,
  projectStatus,
  projectTechnologies,
  projectLinks,
  destination,
} from "../project-output.js";
import { buildLinkedBadge } from "../../badges/shields.js";
export function detailed(p, level = 3) {
  return [
    p.imagePlacement === "top" && projectImage(p),
    `${"#".repeat(level)} ${escapeText([p.emoji, p.name || "Untitled project"].filter(Boolean).join(" "))}`,
    p.subtitle && escapeText(p.subtitle),
    p.imagePlacement !== "top" && projectImage(p),
    p.description && escapeText(p.description),
    p.projectType && `**Type:** ${escapeText(p.projectType)}`,
    p.role && `**Role:** ${escapeText(p.role)}`,
    projectStatus(p),
    p.highlights
      .filter((h) => h.title || h.description)
      .map(
        (h) =>
          `- ${h.title ? `**${escapeText(h.title)}:** ` : ""}${escapeText(h.description).replace(/\n/g, "\n  ")}`,
      )
      .join("\n"),
    projectTechnologies(p),
    projectLinks(p)
      .map(([name, url]) => `[${escapeText(name)}](${destination(url)})`)
      .join(" · "),
    p.badges.map((b) => buildLinkedBadge(b)).join(" "),
    p.legacyStatusMarkdown,
  ]
    .filter(Boolean)
    .join("\n\n");
}
