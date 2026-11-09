import { marked } from "marked";
export const normalizeHeading = (value) =>
  value
    .replace(/<[^>]*>|[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
export function classifySection(title, level = 0) {
  const t = normalizeHeading(title);
  if (/^(about|about me|who am i)$/.test(t)) return "about";
  if (
    /^(technical stack|tech stack|technology stack|skills|tech|technologies)$/.test(
      t,
    )
  )
    return "stack";
  if (
    /^(projects|selected work|selected projects|featured projects|work)$/.test(
      t,
    )
  )
    return "projects";
  if (/^(writing|blog|articles|writing notes|recent posts)$/.test(t))
    return "writing";
  if (/^(contact|let s connect|connect|social links)$/.test(t))
    return "contact";
  if (/^(learning|currently learning|current learning)$/.test(t))
    return "learning";
  if (/^(stats|widgets|github stats|activity|contributions)$/.test(t))
    return "widgets";
  if (level === 1 && /^(hi|hello|hey|welcome|your name)\b/.test(t))
    return "hero";
  return "custom";
}
// Map the lexer's normalized line endings back to untouched source offsets.
export function sourceTokens(markdown) {
  const offsets = [];
  let normalized = "";
  for (let i = 0; i < markdown.length; i++) {
    offsets.push(i);
    if (markdown[i] === "\r") {
      normalized += "\n";
      if (markdown[i + 1] === "\n") i++;
    } else normalized += markdown[i];
  }
  offsets.push(markdown.length);
  let cursor = 0;
  return marked.lexer(normalized).map((token) => {
    const start = cursor;
    cursor += (token.raw || "").length;
    return {
      token,
      start: offsets[start] ?? markdown.length,
      end: offsets[cursor] ?? markdown.length,
    };
  });
}
export function detectSections(markdown, { levels = [1, 2] } = {}) {
  const entries = sourceTokens(markdown)
    .filter(
      ({ token }) => token.type === "heading" && levels.includes(token.depth),
    )
    .map(({ token, start, end }) => ({
      title: token.text,
      level: token.depth,
      kind: classifySection(token.text, token.depth),
      start,
      bodyStart: end,
    }));
  if (!entries.length || entries[0].start > 0)
    entries.unshift({
      title: entries.length ? "Preamble" : "Untitled content",
      level: 0,
      kind: "custom",
      start: 0,
      bodyStart: 0,
    });
  return entries.map((entry, i) => {
    const end = entries[i + 1]?.start ?? markdown.length;
    return {
      ...entry,
      end,
      source: markdown.slice(entry.start, end),
      body: markdown.slice(entry.bodyStart, end),
    };
  });
}
export const parseSections = (markdown) =>
  detectSections(markdown).map((s) => s.source);
