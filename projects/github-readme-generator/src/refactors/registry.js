import { analyzeDocument } from "../analysis/analyze.js";
import { parseSource } from "../analysis/source.js";
import { safeUrl } from "../markdown/url-safety.js";
import { html } from "../markdown/serialize.js";
import { badgeIdentity } from "../badges/duplicates.js";
const precise = (r) => r && !r.approximate;
const patch = (source, start, end, after) => ({
  start,
  end,
  before: source.slice(start, end),
  after,
});
function context(source) {
  const analysis = analyzeDocument(source),
    parsed = parseSource(source),
    top = new Set(parsed.tokens),
    nodes = parsed.nodes.filter((n) => top.has(n.token));
  const protectedRanges = analysis.codeBlocks.map((n) => n.sourceRange);
  let active = null;
  for (const node of analysis.htmlBlocks) {
    if (active) {
      if (node.closing && node.tag === active.tag) {
        protectedRanges.push({
          start: active.sourceRange.start,
          end: node.sourceRange.end,
          tag: active.tag,
          closed: true,
          approximate:
            active.sourceRange.approximate || node.sourceRange.approximate,
        });
        active = null;
      }
    } else if (
      !node.closing &&
      ["script", "style", "iframe", "textarea"].includes(node.tag)
    )
      active = node;
  }
  if (active)
    protectedRanges.push({
      start: active.sourceRange.start,
      end: source.length,
      tag: active.tag,
      closed: false,
    });
  return { analysis, nodes, protectedRanges };
}
function headingEdits(source, { analysis, nodes }) {
  const starts = new Set(
      nodes
        .filter((n) => n.token.type === "heading")
        .map((n) => n.sourceRange.start),
    ),
    edits = [];
  let previous = 0;
  for (const h of analysis.headings) {
    let level = h.level;
    const raw = source.slice(h.sourceRange.start, h.sourceRange.end),
      match = raw.match(/^( {0,3})(#{1,6})(?=\s|$)/);
    if (
      previous &&
      level > previous + 1 &&
      h.syntax === "markdown" &&
      precise(h.sourceRange) &&
      starts.has(h.sourceRange.start) &&
      match
    ) {
      level = previous + 1;
      edits.push(
        patch(
          source,
          h.sourceRange.start + match[1].length,
          h.sourceRange.start + match[1].length + match[2].length,
          "#".repeat(level),
        ),
      );
    }
    previous = level;
  }
  return edits;
}
function altEdits(source, { analysis }) {
  const edits = [];
  for (const image of analysis.images) {
    const r = image.sourceRange;
    if (!precise(r) || image.alt?.trim()) continue;
    const raw = source.slice(r.start, r.end);
    if (image.syntax === "markdown") {
      const match = raw.match(/^!\[\s*\]/);
      if (match)
        edits.push(
          patch(
            source,
            r.start + 2,
            r.start + match[0].length - 1,
            "TODO: describe image",
          ),
        );
    } else {
      if ([...raw.matchAll(/\balt\s*=/gi)].length > 1) continue;
      const match = /\balt\s*=\s*(["'])\s*\1/i.exec(raw);
      if (match) {
        const quote = match[0].indexOf(match[1]);
        edits.push(
          patch(
            source,
            r.start + match.index + quote + 1,
            r.start + match.index + match[0].length - 1,
            "TODO: describe image",
          ),
        );
      } else if (image.missingAlt) {
        const end = raw.match(/\s*\/?\s*>$/);
        if (end)
          edits.push(
            patch(
              source,
              r.start + end.index,
              r.start + end.index,
              ' alt="TODO: describe image"',
            ),
          );
      }
    }
  }
  return edits;
}
function simpleImage(source, image) {
  if (image.syntax !== "markdown" || !precise(image.sourceRange)) return null;
  const raw = source.slice(image.sourceRange.start, image.sourceRange.end);
  return /^!\[[^\]\\\r\n]*\]\([^\s()]+\)$/.test(raw) &&
    safeUrl(image.url, { image: true })
    ? raw
    : null;
}
function pictureEdits(source, { analysis }) {
  const edits = [];
  const nl = source.includes("\r\n")
    ? "\r\n"
    : source.includes("\r")
      ? "\r"
      : "\n";
  for (let i = 0; i + 1 < analysis.images.length; i++) {
    const a = analysis.images[i],
      b = analysis.images[i + 1];
    if (
      !simpleImage(source, a) ||
      !simpleImage(source, b) ||
      a.alt !== b.alt ||
      !a.alt?.trim()
    )
      continue;
    const light = [a, b].find((x) => x.url.endsWith("#gh-light-mode-only")),
      dark = [a, b].find((x) => x.url.endsWith("#gh-dark-mode-only"));
    if (!light || !dark) continue;
    const start = a.sourceRange.start,
      end = b.sourceRange.end,
      before = source.slice(
        Math.max(
          source.lastIndexOf("\n", start - 1),
          source.lastIndexOf("\r", start - 1),
        ) + 1,
        start,
      ),
      lineEnds = [source.indexOf("\n", end), source.indexOf("\r", end)].filter(
        (n) => n >= 0,
      ),
      after = source.slice(
        end,
        lineEnds.length ? Math.min(...lineEnds) : source.length,
      ),
      gap = source.slice(a.sourceRange.end, b.sourceRange.start);
    if (before.trim() || after.trim() || !/^\s+$/.test(gap)) continue;
    const image = `<picture>${nl}  <source media="(prefers-color-scheme: dark)" srcset="${html(dark.url.replace(/#gh-dark-mode-only$/, ""))}">${nl}  <img src="${html(light.url.replace(/#gh-light-mode-only$/, ""))}" alt="${html(light.alt)}">${nl}</picture>`;
    edits.push(patch(source, start, end, image));
    i++;
  }
  return edits;
}
function badgeEdits(source, { nodes }, options) {
  const edits = [];
  for (const node of nodes) {
    if (node.token.type !== "paragraph" || !precise(node.sourceRange)) continue;
    const tokens = node.token.tokens || [],
      badges = [];
    let valid = true;
    for (const token of tokens) {
      if (token.type === "text" && !token.raw.trim()) continue;
      let image = token,
        link = "";
      if (token.type === "link" && token.tokens?.length === 1) {
        image = token.tokens[0];
        link = token.href;
        if (!safeUrl(link)) valid = false;
      }
      if (
        image.type !== "image" ||
        !badgeIdentity(image.href) ||
        !safeUrl(image.href, { image: true }) ||
        /[\r\n]/.test(token.raw)
      ) {
        valid = false;
        break;
      }
      badges.push({
        raw: token.raw,
        url: image.href,
        alt: image.text,
        link,
        title: image.title,
        linkTitle: token.type === "link" ? token.title : null,
      });
    }
    if (!valid || badges.length < 2) continue;
    const raw = source.slice(node.sourceRange.start, node.sourceRange.end),
      ending = raw.match(/\s*$/)[0];
    let after;
    if (options.badgeMode === "center" || options.badgeMode === "paragraph") {
      const images = badges
        .map((b) => {
          const img = `<img src="${html(b.url)}" alt="${html(b.alt)}"${b.title ? ` title="${html(b.title)}"` : ""}>`;
          return b.link
            ? `<a href="${html(b.link)}"${b.linkTitle ? ` title="${html(b.linkTitle)}"` : ""}>${img}</a>`
            : img;
        })
        .join(" ");
      after =
        `<p${options.badgeMode === "center" ? ' align="center"' : ""}>${images}</p>` +
        ending;
    } else after = badges.map((b) => b.raw).join(" ") + ending;
    edits.push(
      patch(source, node.sourceRange.start, node.sourceRange.end, after),
    );
  }
  return edits;
}
function separatorEdits(source, { analysis, nodes }) {
  const starts = new Set(
    nodes.filter((n) => n.token.type === "hr").map((n) => n.sourceRange.start),
  );
  const rules = analysis.rules.filter(
      (r) => precise(r.sourceRange) && starts.has(r.sourceRange.start),
    ),
    edits = [];
  for (let i = 1; i < rules.length; i++) {
    const prev = rules[i - 1].sourceRange,
      r = rules[i].sourceRange;
    if (!source.slice(prev.end, r.start).trim())
      edits.push(patch(source, r.start, r.end, ""));
  }
  return edits;
}
function emptyEdits(source, { analysis, nodes }) {
  const sections = new Map(
    analysis.sections
      .filter((s) => s.level)
      .map((s) => [s.sourceRange.start, s]),
  );
  const starts = new Set(
      nodes
        .filter((n) => n.token.type === "heading")
        .map((n) => n.sourceRange.start),
    ),
    edits = [];
  for (const h of analysis.headings) {
    const r = h.sourceRange;
    if (!precise(r) || !starts.has(r.start)) continue;
    const section = sections.get(r.start);
    if (section?.empty)
      edits.push(patch(source, r.start, section.sourceRange.end, ""));
    else if (!h.title.trim()) edits.push(patch(source, r.start, r.end, ""));
  }
  return edits;
}
function pairedNodes(analysis, tags) {
  const stacks = new Map(),
    pairs = [];
  for (const n of analysis.htmlBlocks) {
    if (!tags.includes(n.tag) || !precise(n.sourceRange)) continue;
    const stack = stacks.get(n.tag) || [];
    if (n.closing) {
      const open = stack.pop();
      if (open) pairs.push({ open, close: n });
    } else stack.push(n);
    stacks.set(n.tag, stack);
  }
  return pairs;
}
function unsafeEdits(source, { analysis, protectedRanges }) {
  const paired = pairedNodes(analysis, ["object", "form", "button", "select"]);
  const voidTags = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  const balanced = (pair) => {
    if (["script", "style", "iframe", "textarea"].includes(pair.open.tag))
      return true;
    const stack = [];
    for (const node of analysis.htmlBlocks) {
      if (
        node.sourceRange.start < pair.open.sourceRange.start ||
        node.sourceRange.end > pair.close.sourceRange.end
      )
        continue;
      if (voidTags.has(node.tag) || /\/\s*>$/.test(node.raw)) continue;
      if (node.closing) {
        if (stack.pop() !== node.tag) return false;
      } else stack.push(node.tag);
    }
    return stack.length === 0;
  };
  let ranges = paired.filter(balanced).map((p) => ({
    start: p.open.sourceRange.start,
    end: p.close.sourceRange.end,
  }));
  ranges.push(
    ...protectedRanges.filter((r) => r.tag && r.closed && !r.approximate),
  );
  for (const n of analysis.htmlBlocks)
    if (
      !n.closing &&
      precise(n.sourceRange) &&
      (["input", "embed"].includes(n.tag) ||
        (n.tag === "link" && n.attributes.rel?.toLowerCase() === "stylesheet"))
    )
      ranges.push(n.sourceRange);
  ranges = ranges.filter(
    (r, i) =>
      !ranges.some(
        (outer, j) => j !== i && outer.start <= r.start && outer.end >= r.end,
      ),
  );
  return ranges.map((r) => patch(source, r.start, r.end, ""));
}
function centerEdits(source, { analysis }) {
  const edits = [];
  for (const { open, close } of pairedNodes(analysis, ["center"])) {
    const inner = source.slice(open.sourceRange.end, close.sourceRange.start);
    if (
      !/^<center\s*>$/i.test(open.raw) ||
      /\r?\n\s*\r?\n/.test(inner) ||
      /<\/?(?!a\b|img\b|br\b|strong\b|em\b|code\b|kbd\b|sup\b|sub\b)[a-z]/i.test(
        inner,
      )
    )
      continue;
    edits.push(
      patch(
        source,
        open.sourceRange.start,
        open.sourceRange.end,
        '<p align="center">',
      ),
      patch(source, close.sourceRange.start, close.sourceRange.end, "</p>"),
    );
  }
  return edits;
}
function normalizedUrl(raw, image = false) {
  const value = raw.trim();
  if (!safeUrl(value, { image })) return raw;
  return value.replace(
    /^(https?):\/\/(?:www\.)?github\.com(?=\/|$)/i,
    (_, scheme) => scheme.toLowerCase() + "://github.com",
  );
}
function linkEdits(source, { analysis }) {
  const edits = [],
    seen = new Set();
  for (const item of [...analysis.links, ...analysis.images]) {
    const r = item.sourceRange;
    if (!precise(r)) continue;
    const raw = source.slice(r.start, r.end),
      image = Object.hasOwn(item, "alt");
    let start, end, value;
    if (item.syntax === "html") {
      const attribute = image ? "src" : "href",
        regex = new RegExp(
          "\\b" + attribute + "\\s*=\\s*([\"\\'])(.*?)\\1",
          "i",
        ),
        m = regex.exec(raw);
      if (!m) continue;
      value = m[2];
      start = r.start + m.index + m[0].indexOf(m[1]) + 1;
      end = start + value.length;
    } else {
      const m = /^!?\[[^\]\r\n]*\]\((<[^>]*>|[^)\s]+)\)$/.exec(raw);
      if (m) {
        const angle = m[1].startsWith("<");
        value = angle ? m[1].slice(1, -1) : m[1];
        start = r.start + raw.indexOf("](") + 2 + (angle ? 1 : 0);
        end = start + value.length;
      } else if (/^<https?:\/\/[^>]+>$/i.test(raw)) {
        value = raw.slice(1, -1);
        start = r.start + 1;
        end = r.end - 1;
      } else continue;
    }
    const key = start + ":" + end;
    if (seen.has(key)) continue;
    seen.add(key);
    const after = normalizedUrl(value, image);
    if (after !== value) edits.push(patch(source, start, end, after));
  }
  return edits;
}
const definition = (id, title, description, collect) => ({
  id,
  title,
  description,
  collect,
  applicable(source, analysis) {
    const ctx = context(source);
    if (analysis?.headings) ctx.analysis = analysis;
    return protectedEdits(source, ctx, collect(source, ctx, {}), id).length > 0;
  },
  transform(source, options = {}) {
    return planRefactors(source, [id], options);
  },
});
export const refactorRegistry = [
  definition(
    "headings",
    "Normalize heading hierarchy",
    "Reduce skipped ATX heading levels without renaming headings. Nested or approximate matches are skipped.",
    headingEdits,
  ),
  definition(
    "alt",
    "Add alt-text placeholders",
    "Insert TODO: describe image for missing or empty alt. Replace each TODO with your own description; decorative images may not need one.",
    altEdits,
  ),
  definition(
    "pictures",
    "Convert simple light/dark pairs",
    "Convert adjacent standalone Markdown images with matching alt and GitHub light/dark suffixes into picture markup.",
    pictureEdits,
  ),
  definition(
    "badges",
    "Consolidate badge rows",
    "Normalize spacing or wrap a simple Markdown badge row. Preserve badge order and links.",
    badgeEdits,
  ),
  definition(
    "separators",
    "Remove redundant separators",
    "Keep the first rule in each consecutive group; preserve its style.",
    separatorEdits,
  ),
  definition(
    "empty",
    "Remove empty headings and sections",
    "Remove top-level heading-only sections, which may be intentional group headings. Review carefully.",
    emptyEdits,
  ),
  definition(
    "unsafe",
    "Remove unsafe or unsupported HTML blocks",
    "Remove recognized complete script, style, iframe, object and form/control blocks. This is not a replacement for preview sanitization.",
    unsafeEdits,
  ),
  definition(
    "center",
    "Convert simple center wrappers",
    'Convert a plain center wrapper with inline content to p align="center". Skip complex nested layouts.',
    centerEdits,
  ),
  definition(
    "links",
    "Normalize simple URL forms",
    "Trim quoted URL whitespace and normalize GitHub host/protocol casing and www. Keep paths, fragments and query strings unchanged.",
    linkEdits,
  ),
];
function protectedEdits(source, ctx, edits, id) {
  return edits.filter(
    (e) =>
      e.before !== e.after &&
      !ctx.protectedRanges.some(
        (r) =>
          e.start < r.end &&
          e.end > r.start &&
          !(id === "unsafe" && e.start <= r.start && e.end >= r.end),
      ),
  );
}
export function refactorCatalog(source, options = {}) {
  const ctx = context(source);
  return refactorRegistry.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    count: protectedEdits(source, ctx, r.collect(source, ctx, options), r.id)
      .length,
  }));
}
export function applyEdits(source, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end),
    changes = [];
  let cursor = 0,
    output = "",
    delta = 0;
  const sourceMapping = [];
  for (const edit of sorted) {
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      edit.start < 0 ||
      edit.end < edit.start ||
      edit.end > source.length ||
      typeof edit.after !== "string" ||
      source.slice(edit.start, edit.end) !== edit.before
    )
      throw Error(
        "Source changed or an edit range is invalid. Reopen the review.",
      );
    const previous = changes.at(-1);
    if (
      previous &&
      (edit.start < previous.end || edit.start === previous.start)
    )
      throw Error(
        "Selected refactors overlap. Apply them sequentially and review each diff.",
      );
    output += source.slice(cursor, edit.start) + edit.after;
    sourceMapping.push({
      oldStart: edit.start,
      oldEnd: edit.end,
      newStart: edit.start + delta,
      newEnd: edit.start + delta + edit.after.length,
    });
    delta += edit.after.length - (edit.end - edit.start);
    cursor = edit.end;
    changes.push(edit);
  }
  return { newMarkdown: output + source.slice(cursor), changes, sourceMapping };
}
export function planRefactors(source, ids, options = {}) {
  const ctx = context(source),
    edits = [];
  for (const id of [...new Set(ids)]) {
    const r = refactorRegistry.find((r) => r.id === id);
    if (!r) throw Error("Unknown refactor");
    edits.push(
      ...protectedEdits(source, ctx, r.collect(source, ctx, options), id).map(
        (e) => ({ ...e, id, title: r.title }),
      ),
    );
  }
  return applyEdits(source, edits);
}
export function refactorDiff(plan) {
  return plan.changes
    .map(
      (c) =>
        `@@ source offsets ${c.start}–${c.end}: ${c.title} @@\n${c.before
          .split(/\r\n|\r|\n/)
          .map((line) => "- " + line)
          .join("\n")}\n${c.after
          .split(/\r\n|\r|\n/)
          .map((line) => "+ " + line)
          .join("\n")}`,
    )
    .join("\n\n");
}
