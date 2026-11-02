import { marked } from "marked";
import { visitTokens } from "../markdown/visit-tokens.js";
export function componentHealth(blocks = []) {
  const issues = [],
    seen = new Set();
  let widgets = 0,
    centered = 0;
  for (const [index, b] of blocks.entries()) {
    if (b.type !== "component") continue;
    const c = b.settings?.instance?.component,
      key = b.settings?.markdown || "";
    if (seen.has(key))
      issues.push({
        category: "Components",
        message: `Repeated component near section ${index + 1}; repeated content may obscure useful information.`,
      });
    seen.add(key);
    if (c?.kind === "widget") widgets++;
    let markup = "";
    visitTokens(marked.lexer(key), (t) => {
      if (t.type === "html") markup += t.text.replace(/<!--[\s\S]*?-->/g, "");
    });
    if (/align="center"/.test(markup)) centered++;
    const depth = { details: 0, table: 0 };
    let nested = false;
    for (const match of markup.matchAll(/<(\/?)(details|table)\b[^>]*>/gi)) {
      const key = match[2].toLowerCase();
      if (match[1]) depth[key] = Math.max(0, depth[key] - 1);
      else if (++depth[key] > 1) nested = true;
    }
    if (nested)
      issues.push({
        category: "Component layout",
        message: `Nested layout near section ${index + 1}; GitHub/mobile rendering may be awkward. Prefer a simpler structure.`,
      });
  }
  if (widgets > 3)
    issues.push({
      category: "Components",
      message: `${widgets} widget components; consider reducing repeated stats and adding context between large images.`,
    });
  if (centered > 3)
    issues.push({
      category: "Component layout",
      message: `${centered} centered components; left-aligned prose may be easier to scan.`,
    });
  return issues.slice(0, 100);
}
