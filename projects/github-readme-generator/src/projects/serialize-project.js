import { escapeText } from "./project-output.js";
import { compact } from "./layouts/compact.js";
import { detailed } from "./layouts/detailed.js";
import { featured } from "./layouts/featured.js";
import { card } from "./layouts/card.js";
import { twoColumn } from "./layouts/two-column.js";
import { caseStudy } from "./layouts/case-study.js";
export * from "./project-output.js";
export const layouts = [
  "compact",
  "detailed",
  "featured",
  "card",
  "two-column",
  "case-study",
  "featured-first",
];
export const layoutPresets = {
  Portfolio: "featured-first",
  Technical: "detailed",
  Minimal: "compact",
  Visual: "card",
  "Case Study": "case-study",
};
const serializers = {
  compact,
  detailed,
  featured,
  card,
  "case-study": caseStudy,
};
export function serializeProject(p, layout = p.layout) {
  if (layout === "two-column") return twoColumn([p]);
  if (
    p.imagePlacement === "side-by-side" &&
    !["compact", "card"].includes(layout)
  )
    return card(p);
  return (serializers[layout] || detailed)(p);
}
export function serializeShowcase(s) {
  const content =
    s.layout === "two-column"
      ? twoColumn(s.items)
      : s.items
          .map((p, i) =>
            serializeProject(
              p,
              s.layout === "featured-first"
                ? i === 0
                  ? "featured"
                  : "compact"
                : s.layout,
            ),
          )
          .join("\n\n");
  return `## ${escapeText(s.title || "Selected Projects")}\n\n${content}`;
}
