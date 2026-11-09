import {
  escapeText,
  projectTechnologies,
  projectLinks,
  destination,
} from "../project-output.js";
export function compact(p) {
  return [
    `### ${escapeText([p.emoji, p.name || "Untitled project"].filter(Boolean).join(" "))}`,
    escapeText(p.description),
    projectTechnologies(p),
    projectLinks(p)
      .map(([n, u]) => `[${escapeText(n)}](${destination(u)})`)
      .join(" · "),
  ]
    .filter(Boolean)
    .join("\n\n");
}
