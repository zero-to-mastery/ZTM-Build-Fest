// Plain-language content checks (ADR 0262): a pure checker shared by the landing Text section and the post
// editor. It reads Markdown and returns short sentences, each with the exact place it is about and, where a fix
// is safe, a fix that changes only that place. Warnings never block saving; this file knows nothing about
// saving. Malformed, empty and oversized input never throws.

export const CHECK_LIMITS = Object.freeze({ characters: 400_000, issues: 40, longParagraphWords: 150 });

const VAGUE = new Set(["click here", "click", "here", "this", "this link", "link", "read more", "more", "learn more", "click this", "click here to read more", "tap here"]);

/** Ranges of fenced code blocks, so nothing inside code is checked. */
function fencedRanges(text) {
  const ranges = [];
  let open = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!open) open = { start: offset, marker: fence[1][0], size: fence[1].length };
      else if (fence[1][0] === open.marker && fence[1].length >= open.size && /^ {0,3}[`~]+\s*$/.test(line)) {
        ranges.push([open.start, offset + line.length]);
        open = null;
      }
    }
    offset += line.length + 1;
  }
  if (open) ranges.push([open.start, text.length]);
  return ranges;
}

/** Ranges of inline code spans. */
function codeRanges(text) {
  const ranges = [];
  for (const match of text.matchAll(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g)) ranges.push([match.index, match.index + match[0].length]);
  return ranges;
}

const words = (text) => (String(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
const visibleText = (line) =>
  line
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .trim();

/** Whether a web address is plain http that is worth upgrading (a local address is left alone). */
function insecure(url) {
  return /^http:\/\//i.test(url) && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(url);
}

/**
 * Check Markdown. Each issue is `{ id, rule, message, start, end, fix }` where `start`/`end` is the place the
 * message is about and `fix`, when there is one, is `{ kind, label, ... }` (see `applyFix`).
 * Options: `html` also reports HTML tags (for Markdown a post accepts), `headingBase` is the level of the page's
 * own title (default 1).
 */
export function checkMarkdown(markdown, options = {}) {
  if (typeof markdown !== "string" || !markdown.trim()) return [];
  const text = markdown.slice(0, CHECK_LIMITS.characters).replace(/\r\n?/g, "\n");
  const fenced = fencedRanges(text);
  const code = codeRanges(text);
  const inFence = (at) => fenced.some(([from, to]) => at >= from && at < to);
  const inCode = (at) => inFence(at) || code.some(([from, to]) => at >= from && at < to);
  const issues = [];
  const add = (rule, message, start, end, fix = null) => {
    if (issues.length < CHECK_LIMITS.issues) issues.push({ id: `${rule}:${start}`, rule, message, start, end, fix });
  };

  // A fix remembers the words just around its place, so it cannot land somewhere else if the text moved.
  const fix = (kind, label, at, extra = {}) => ({ kind, label, at, expect: text.slice(at[0], at[1]), before: text.slice(Math.max(0, at[0] - 8), at[0]), after: text.slice(at[1], at[1] + 8), ...extra });

  // ----- pictures, links and addresses
  for (const match of text.matchAll(/(!?)\[([^\]\n]*)\]\(\s*([^)\s\n]*)((?:\s+"[^"\n]*")?)\s*\)/g)) {
    if (inCode(match.index)) continue;
    const image = match[1] === "!";
    const label = match[2];
    const url = match[3];
    const labelStart = match.index + match[1].length + 1;
    const labelEnd = labelStart + label.length;
    if (image && !label.trim()) {
      add("picture-description", "A picture has no description. People who cannot see it will not know what it shows.", match.index, match.index + match[0].length, fix("describe", "Describe it", [labelStart, labelEnd], { prompt: "What does the picture show?" }));
    } else if (!image && !label.trim()) {
      add("empty-link", "A link has no words, so it cannot be read or tapped by name.", match.index, match.index + match[0].length, fix("describe", "Add words", [labelStart, labelEnd], { prompt: "What should the link say?" }));
    } else if (!image && VAGUE.has(label.trim().toLowerCase().replace(/[.!:]+$/, ""))) {
      add("vague-link", `The link "${label.trim()}" does not say where it goes. Words that name the place are easier to follow.`, match.index, match.index + match[0].length, fix("describe", "Change the words", [labelStart, labelEnd], { prompt: "What should the link say?" }));
    }
    if (!image && !url) add("empty-address", "A link has no address, so it goes nowhere.", match.index, match.index + match[0].length);
    if (insecure(url)) {
      const at = match.index + match[0].indexOf(url);
      add("insecure-address", "This address starts with http://, which is not secure. Most sites also work with https://.", at, at + url.length, fix("https", "Use https", [at, at + 4]));
    }
  }
  for (const match of text.matchAll(/<(http:\/\/[^>\s]+)>/gi)) {
    if (inCode(match.index) || !insecure(match[1])) continue;
    const at = match.index + 1;
    add("insecure-address", "This address starts with http://, which is not secure. Most sites also work with https://.", at, at + match[1].length, fix("https", "Use https", [at, at + 4]));
  }

  // ----- headings
  let previous = options.headingBase || 1;
  let offset = 0;
  const paragraphs = [];
  let paragraph = null;
  const closeParagraph = () => {
    if (paragraph) paragraphs.push(paragraph);
    paragraph = null;
  };
  for (const line of text.split("\n")) {
    const at = offset;
    offset += line.length + 1;
    if (inFence(at)) {
      closeParagraph();
      continue;
    }
    const heading = /^( {0,3})(#{1,6})[ \t]+(.*?)[ \t#]*$/.exec(line);
    if (heading) {
      closeParagraph();
      const level = heading[2].length;
      if (level > previous + 1) {
        const from = at + heading[1].length;
        add("heading-skip", `This heading jumps from level ${previous} to level ${level}. Headings read best one step at a time.`, from, from + level, fix("heading", `Make it a level ${previous + 1} heading`, [from, from + level], { replace: "#".repeat(previous + 1) }));
      }
      previous = level;
      const title = heading[3];
      if (shouting(title)) add("all-caps", "This heading is all in capital letters, which can feel like shouting and is harder to read.", at, at + line.length);
      continue;
    }
    const plain = /^\s*$/.test(line);
    const structural = /^\s*(?:[-*+]\s|\d+[.)]\s|>|\|)/.test(line) || /^\s*<[a-z/!]/i.test(line);
    if (plain || structural) {
      closeParagraph();
      if (structural && /^\s*(?:>|[-*+]\s|\d+[.)]\s)/.test(line) && shouting(visibleText(line.replace(/^\s*(?:>|[-*+]\s|\d+[.)]\s)\s*/, ""))))
        add("all-caps", "This is all in capital letters, which can feel like shouting and is harder to read.", at, at + line.length);
      continue;
    }
    if (!paragraph) paragraph = { start: at, end: at + line.length, text: line };
    else {
      paragraph.end = at + line.length;
      paragraph.text += `\n${line}`;
    }
  }
  closeParagraph();
  for (const item of paragraphs) {
    const count = words(visibleText(item.text));
    if (count > CHECK_LIMITS.longParagraphWords) add("long-paragraph", `This paragraph is ${count} words long. Shorter paragraphs are easier to read, especially on a phone.`, item.start, item.end);
    if (shouting(visibleText(item.text))) add("all-caps", "This is all in capital letters, which can feel like shouting and is harder to read.", item.start, item.end);
  }

  // ----- tags (Markdown a post accepts)
  if (options.html) {
    for (const match of text.matchAll(/<\/?[a-z][a-z0-9-]*(?:\s[^<>\n]*)?>/gi)) {
      if (inCode(match.index) || /^<(?:https?:|mailto:)/i.test(match[0])) continue;
      add("html", "This has an HTML tag in it. It is kept and shown as written, but the Visual editor cannot change it.", match.index, match.index + match[0].length);
      break;
    }
  }
  return issues.sort((a, b) => a.start - b.start);
}

/** Three or more real words, every letter of them a capital: an acronym or two does not count. */
function shouting(text) {
  const found = String(text).match(/[\p{L}][\p{L}'’-]+/gu) || [];
  if (found.length < 4) return false;
  const letters = found.join("");
  return letters.length >= 15 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

/**
 * Apply one issue's fix to the Markdown. `answer` is the owner's words for a "describe" fix. Only the issue's own
 * place is changed, and only if the text there is still what the check saw; otherwise nothing changes.
 * Returns `{ markdown, changed }`.
 */
export function applyFix(markdown, issue, answer = "") {
  const fix = issue?.fix;
  const source = typeof markdown === "string" ? markdown.replace(/\r\n?/g, "\n") : "";
  const unchanged = { markdown: typeof markdown === "string" ? markdown : "", changed: false };
  if (!fix || !Array.isArray(fix.at)) return unchanged;
  const [from, to] = fix.at;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > source.length) return unchanged;
  if (source.slice(from, to) !== fix.expect || source.slice(Math.max(0, from - 8), from) !== fix.before || source.slice(to, to + 8) !== fix.after) return unchanged;
  let insert;
  if (fix.kind === "https") insert = "https";
  else if (fix.kind === "heading") insert = fix.replace;
  else if (fix.kind === "describe") {
    insert = String(answer).replace(/\s+/g, " ").replace(/[\[\]\\*_`<>]/g, "").trim().slice(0, 200);
    if (!insert) return unchanged;
  } else return unchanged;
  if (typeof insert !== "string") return unchanged;
  return { markdown: source.slice(0, from) + insert + source.slice(to), changed: true };
}

/** One plain sentence about how many things were found, for a polite announcement. */
export function checksSummary(issues) {
  const count = Array.isArray(issues) ? issues.length : 0;
  if (!count) return "No suggestions. Nothing to fix.";
  return count === 1 ? "1 suggestion for this text." : `${count} suggestions for this text.`;
}
