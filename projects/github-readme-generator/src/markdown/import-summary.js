import { visitTokens } from "./visit-tokens.js";
import { marked } from "marked";
import { analyze } from "./compatibility.js";
import { detectSections } from "./sections.js";
export function importSummary(markdown) {
  const result = analyze(markdown);
  let details = 0,
    htmlLinks = 0;
  visitTokens(marked.lexer(markdown), (t) => {
    if (t.type === "html") {
      const source = t.raw.replace(/<!--[\s\S]*?-->/g, "");
      details += (source.match(/<details\b/gi) || []).length;
      htmlLinks += (source.match(/<a\b[^>]*\bhref\s*=/gi) || []).length;
    }
  });
  return {
    ...result,
    linkCount: result.links.length + htmlLinks,
    details,
    sections: detectSections(markdown),
  };
}
