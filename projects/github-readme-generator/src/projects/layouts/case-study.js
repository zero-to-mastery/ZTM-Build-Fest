import { detailed } from "./detailed.js";
import { escapeText } from "../project-output.js";
export function caseStudy(p) {
  return [
    detailed(p),
    ...["problem", "architecture", "challenges", "testing", "outcome"]
      .filter((k) => p[k])
      .map(
        (k) => `#### ${k[0].toUpperCase() + k.slice(1)}\n\n${escapeText(p[k])}`,
      ),
  ].join("\n\n");
}
