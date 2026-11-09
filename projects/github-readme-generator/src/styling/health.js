import { marked } from "marked";
import { visitTokens } from "../markdown/visit-tokens.js";
const nestedDetails = (body) => {
  let found = false;
  visitTokens(marked.lexer(body || ""), (t) => {
    if (
      t.type === "html" &&
      /<details\b/i.test(t.text.replace(/<!--[\s\S]*?(?:-->|$)/g, ""))
    )
      found = true;
  });
  return found;
};
export function stylingHealth(blocks) {
  const items = blocks.filter((b) => b.type !== "custom"),
    issues = [],
    add = (message) => issues.push({ category: "Layout", message });
  const count = (test) => items.filter(test).length;
  if (
    count(
      (b) =>
        b.settings.presentation?.center ||
        b.settings.presentation?.heading === "centered",
    ) > 3
  )
    add(
      "Many centered sections can make scanning long prose harder. Prefer left alignment for detailed content.",
    );
  if (
    count(
      (b) =>
        b.type === "divider" ||
        (b.settings.presentation?.divider &&
          b.settings.presentation.divider !== "none"),
    ) > 5
  )
    add("Many decorative dividers interrupt reading. Consider reducing them.");
  if (count((b) => b.settings.presentation?.heading === "terminal-prompt") > 3)
    add(
      "Repeated terminal-prompt headings may add visual noise. Reserve them for relevant sections.",
    );
  const glyphs = items
    .filter((b) => b.settings.presentation?.heading === "emoji-accent")
    .map((b) => b.settings.presentation.decoration);
  if (glyphs.some((g) => glyphs.filter((v) => v === g).length > 5))
    add(
      "A decorative glyph repeats across many sections. Consider using fewer accents.",
    );
  for (const b of items) {
    if (b.type === "columns")
      add(
        "Two-column section: tables may scroll on narrow screens. Preview mobile wrapping and keep content short.",
      );
    if (
      b.type === "columns" &&
      (b.settings.leftBody || "").length + (b.settings.rightBody || "").length >
        1600
    )
      add(
        "A large table layout may be difficult to scan on mobile. Consider linear sections.",
      );
    if (b.type === "details" && nestedDetails(b.settings.body))
      add(
        "Nested details can make content difficult to discover. Prefer separate collapsible sections.",
      );
  }
  return issues;
}
