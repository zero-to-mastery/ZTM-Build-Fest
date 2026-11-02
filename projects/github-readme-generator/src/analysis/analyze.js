import { parseSource, attributes } from "./source.js";
import { safeUrl } from "../markdown/url-safety.js";
import { badgeIdentity } from "../badges/duplicates.js";
import { widgetIdentity } from "../widgets/health.js";
import { altTextQuality } from "../accessibility/media.js";
import {
  documentStats,
  wordCount,
  coreHeadings,
  jsCore,
} from "./js-fallback.js";
export { documentStats } from "./js-fallback.js";
export function linkKind(url) {
  if (url.startsWith("#")) return "anchor";
  if (/^mailto:/i.test(url)) return "mailto";
  if (!/^(?:[a-z][\w+.-]*:|\/\/)/i.test(url)) return "relative";
  try {
    return new URL(url, "https://readme.invalid").hostname === "github.com"
      ? "GitHub"
      : "external";
  } catch {
    return "absolute";
  }
}
export function analyzeDocument(markdown, { core = jsCore } = {}) {
  const parsed = parseSource(markdown),
    result = {
      version: 1,
      stats: null,
      headings: [],
      links: [],
      images: [],
      badges: [],
      widgets: [],
      codeBlocks: [],
      htmlBlocks: [],
      sections: [],
      issues: [],
      tables: [],
      rules: [],
    };
  const issue = (
    id,
    category,
    message,
    reason,
    sourceRange,
    severity = "warning",
    suggestedAction,
  ) => {
    if (result.issues.length < 1000)
      result.issues.push({
        id: `${id}:${sourceRange?.start ?? 0}`,
        ruleId: id,
        category,
        severity,
        message,
        reason,
        sourceRange,
        suggestedAction,
      });
  };
  for (const node of parsed.nodes) {
    const { token: t, sourceRange } = node;
    if (t.type === "heading")
      result.headings.push({
        title: t.text.replace(/<[^>]*>/g, ""),
        level: t.depth,
        syntax: "markdown",
        raw: t.raw,
        sourceRange,
      });
    if (t.type === "link")
      result.links.push({
        label: t.text,
        url: t.href,
        kind: linkKind(t.href),
        syntax: "markdown",
        raw: t.raw,
        sourceRange,
      });
    if (t.type === "image")
      result.images.push({
        alt: t.text,
        url: t.href,
        syntax: "markdown",
        raw: t.raw,
        sourceRange,
      });
    if (t.type === "code")
      result.codeBlocks.push({ language: t.lang || "", sourceRange });
    if (t.type === "hr") result.rules.push({ raw: t.raw, sourceRange });
    if (t.type === "table")
      result.tables.push({ columns: t.header.length, sourceRange });
    if (t.type === "html") {
      const clean = t.raw.replace(/<!--[\s\S]*?(?:-->|$)/g, (s) =>
        s.replace(/[^\n]/g, " "),
      );
      for (const m of clean.matchAll(
        /<\/?([a-z][\w-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
      )) {
        const raw = m[0],
          tag = m[1].toLowerCase(),
          a = attributes(raw),
          r = parsed.range(
            node.start + m.index,
            node.start + m.index + raw.length,
            sourceRange.approximate,
          ),
          closing = raw.startsWith("</");
        result.htmlBlocks.push({
          tag,
          attributes: a,
          closing,
          raw,
          sourceRange: r,
        });
        if (closing) continue;
        if (tag === "img")
          result.images.push({
            alt: a.alt,
            missingAlt: !Object.hasOwn(a, "alt"),
            url: a.src || "",
            width: a.width,
            syntax: "html",
            raw,
            sourceRange: r,
          });
        const after = parsed.normalized.slice(
          node.start + m.index + raw.length,
        );
        if (tag === "a" && a.href !== undefined) {
          const body = after.split(/<\/a>/i)[0],
            label = body
              .replace(/<img\b[^>]*>/gi, (s) => attributes(s).alt || "")
              .replace(/<[^>]*>/g, "");
          result.links.push({
            label,
            url: a.href,
            kind: linkKind(a.href),
            syntax: "html",
            raw,
            sourceRange: r,
          });
        }
        if (/^h[1-6]$/.test(tag)) {
          const match = after.match(
              new RegExp("^([\\s\\S]*?)</" + tag + ">", "i"),
            ),
            title = (match?.[1] || "").replace(/<[^>]*>/g, "");
          const range = match
            ? parsed.range(
                node.start + m.index,
                node.start + m.index + raw.length + match[0].length,
                r.approximate,
              )
            : { ...r, approximate: true };
          result.headings.push({
            title,
            level: Number(tag[1]),
            syntax: "html",
            raw,
            sourceRange: range,
          });
        }
      }
    }
  }
  result.headings.sort((a, b) => a.sourceRange.start - b.sourceRange.start);
  const coreResult = core.analyze(markdown, coreHeadings(result.headings));
  result.stats = coreResult.stats;
  result.engine = core.engine;
  const seenHeadings = new Set();
  let h1 = 0;
  const skips = new Map(coreResult.headingSkips.map((s) => [s.index, s]));
  for (const [index, heading] of result.headings.entries()) {
    const { title, level, sourceRange } = heading;
    if (level === 1 && ++h1 > 1)
      issue(
        "multiple-h1",
        "Structure",
        "Multiple H1 headings",
        "Consider whether several top-level titles help navigation; multiple H1s are not automatically invalid.",
        sourceRange,
        "info",
      );
    if (skips.has(index))
      issue(
        "heading-skip",
        "Structure",
        `Heading level jumps from H${skips.get(index).previous} to H${level}`,
        "A consistent hierarchy helps readers navigate the document.",
        sourceRange,
        "warning",
        "headings",
      );
    if (!title.trim())
      issue(
        "heading-empty",
        "Structure",
        "Empty heading",
        "A heading with no label provides no navigation context.",
        sourceRange,
        "warning",
        "empty",
      );
    if (title.length > 120)
      issue(
        "heading-long",
        "Structure",
        "Extremely long heading",
        "Long headings can be difficult to scan, particularly on narrow screens.",
        sourceRange,
        "info",
      );
    if (level > 4)
      issue(
        "heading-deep",
        "Structure",
        "Deep heading hierarchy",
        "Review whether this much nesting is useful in a README.",
        sourceRange,
        "info",
      );
    const key = title.trim().toLowerCase();
    if (seenHeadings.has(key))
      issue(
        "heading-duplicate",
        "Structure",
        "Repeated heading",
        "Repeated titles can make navigation and anchors less clear.",
        sourceRange,
        "info",
      );
    seenHeadings.add(key);
  }
  const seenLinks = new Set();
  for (const link of result.links) {
    const { url, sourceRange } = link;
    if (!link.label.trim())
      issue(
        "link-label",
        "Accessibility",
        "Link has no text label",
        "Give links meaningful text or an image with descriptive alt text.",
        sourceRange,
      );
    if (!safeUrl(url) || /[\x00-\x1f]/.test(url))
      issue(
        "unsafe-url",
        "Security",
        "Unsafe or empty URL",
        "Preview blocks dangerous schemes; source export remains unchanged.",
        sourceRange,
      );
    else if (
      link.kind !== "relative" &&
      link.kind !== "anchor" &&
      link.kind !== "mailto"
    ) {
      try {
        new URL(url.replace(/&amp;/g, "&"));
      } catch {
        issue(
          "malformed-url",
          "Compatibility",
          "Malformed absolute URL",
          "Review URL syntax; no network validation was performed.",
          sourceRange,
        );
      }
    }
    if (/example\.(?:com|org)|your[-_](?:name|repo)|USERNAME/.test(url))
      issue(
        "placeholder-url",
        "Structure",
        "Possible placeholder URL",
        "This URL resembles a sample value. Confirm it is intentional.",
        sourceRange,
        "info",
      );
    if (seenLinks.has(url))
      issue(
        "repeated-link",
        "Clutter",
        "Repeated link destination",
        "Repeated navigation may be intentional; review redundancy.",
        sourceRange,
        "info",
      );
    seenLinks.add(url);
  }
  const seenImages = new Set(),
    rows = new Map();
  let run = [];
  for (const image of result.images) {
    const { url, sourceRange } = image;
    image.badge = !!badgeIdentity(url);
    image.widget = widgetIdentity(url);
    image.decorative = /divider|spacer|decoration/i.test(url);
    image.external = /^(?:https?:)?\/\//i.test(url);
    if (image.badge) result.badges.push(image);
    if (image.widget) result.widgets.push(image);
    if (
      image.widget &&
      (!run.length ||
        !markdown.slice(run.at(-1).sourceRange.end, sourceRange.start).trim())
    )
      run.push(image);
    else run = image.widget ? [image] : [];
    if (run.length === 4)
      issue(
        "consecutive-widgets",
        "Clutter",
        "Several consecutive widgets",
        "Heuristic: large remote widgets can dominate the page; review mobile preview.",
        run[0].sourceRange,
        "info",
      );
    if (!image.alt?.trim())
      issue(
        "image-alt",
        "Accessibility",
        image.missingAlt
          ? "Image is missing alt text"
          : "Image has empty alt text",
        image.decorative
          ? "An empty alt may be appropriate for purely decorative images. Confirm intent."
          : "Describe informative images; intentionally decorative images may have empty alt text.",
        sourceRange,
        "warning",
        "alt",
      );
    else if (!image.decorative && altTextQuality(image.alt) === "generic")
      issue(
        "image-alt-quality",
        "Accessibility",
        "Image alt text is generic",
        "Describe the image's identity or purpose instead of naming only the media type.",
        sourceRange,
        "warning",
        "alt",
      );
    if (!safeUrl(url, { image: true }))
      issue(
        "unsafe-image",
        "Security",
        "Unsafe or missing image URL",
        "The preview will not load this source.",
        sourceRange,
      );
    if (image.width)
      issue(
        "fixed-image",
        "Layout",
        `Fixed image width: ${image.width}`,
        "Declared width is not a measurement of the remote image. Check narrow preview.",
        sourceRange,
        Number(image.width) > 900 ? "warning" : "info",
      );
    if (seenImages.has(url))
      issue(
        image.widget
          ? "duplicate-widget"
          : image.badge
            ? "duplicate-badge"
            : "duplicate-image",
        "Clutter",
        "Repeated " +
          (image.widget ? "widget" : image.badge ? "badge" : "image"),
        "Identical image URLs may create redundant visual content.",
        sourceRange,
        "info",
      );
    seenImages.add(url);
    if (image.widget)
      issue(
        "widget-host",
        "Compatibility",
        "Widget depends on a remote host",
        "Availability and rendering depend on its provider. Analysis makes no network requests.",
        sourceRange,
        "info",
      );
    if (image.badge) {
      const row = rows.get(sourceRange.line) || [];
      row.push(image);
      rows.set(sourceRange.line, row);
    }
  }
  for (const row of rows.values())
    if (row.length > 8)
      issue(
        "badge-row",
        "Layout",
        `${row.length} badges on one source line`,
        "Heuristic: this row may wrap awkwardly on narrow screens.",
        row[0].sourceRange,
      );
  const security = new Set(["script", "object", "embed"]),
    unsupported = new Set([
      "iframe",
      "style",
      "form",
      "input",
      "button",
      "video",
      "audio",
    ]);
  let tables = 0;
  for (const node of result.htmlBlocks) {
    const { tag, attributes: a, sourceRange } = node;
    if (tag === "table") {
      tables += node.closing ? -1 : 1;
      if (tables > 1)
        issue(
          "nested-table",
          "Layout",
          "Nested HTML tables",
          "Heuristic: nested layouts can be difficult to read on mobile.",
          sourceRange,
        );
      tables = Math.max(0, tables);
    }
    if (node.closing) continue;
    if (security.has(tag))
      issue(
        "html-" + tag,
        "Security",
        `Unsafe <${tag}> element`,
        "Interactive or executable embedded content is not a safe README preview feature.",
        sourceRange,
        "warning",
        "unsafe",
      );
    if (unsupported.has(tag))
      issue(
        "html-" + tag,
        "Compatibility",
        `Review <${tag}> compatibility`,
        "GitHub commonly strips or ignores this kind of content. Prefer Markdown or an image/link.",
        sourceRange,
        "warning",
        "unsafe",
      );
    if (Object.keys(a).some((k) => /^on/i.test(k)))
      issue(
        "html-events",
        "Security",
        "HTML event attribute",
        "Event handlers execute scripts and are removed from preview.",
        sourceRange,
      );
    if (a.style)
      issue(
        "html-style",
        "Compatibility",
        "Inline CSS styling",
        "GitHub commonly removes custom styling. Use ordinary Markdown presentation.",
        sourceRange,
      );
    if (
      a.align === "center" &&
      markdown.slice(sourceRange.end, sourceRange.end + 5000).split(/<\/p>/i)[0]
        .length > 2000
    )
      issue(
        "large-center",
        "Layout",
        "Possibly large centered section",
        "Heuristic: long centered text can be harder to scan.",
        sourceRange,
        "info",
      );
  }
  for (const table of result.tables)
    if (table.columns > 6)
      issue(
        "table-wide",
        "Layout",
        `Table has ${table.columns} columns`,
        "Heuristic: wide tables may require horizontal scrolling on mobile.",
        table.sourceRange,
      );
  const decorated = result.headings.filter((h) =>
    /^[✦◆◇•→›⌘_$>]/u.test(h.title),
  );
  if (decorated.length > 8)
    issue(
      "decorative-headings",
      "Clutter",
      "Many decorative headings",
      "Heuristic: repeated accents can make navigation harder to scan.",
      decorated[0].sourceRange,
      "info",
    );
  const starts = [
    {
      title: "Introduction",
      level: 0,
      sourceRange: { start: 0, end: 0, line: 1, column: 1, approximate: false },
    },
    ...result.headings,
  ];
  result.sections = starts.map((h, i) => {
    const end = coreResult.sections[i].end,
      body = markdown.slice(h.sourceRange.end, end);
    return {
      title: h.title,
      level: h.level,
      sourceRange: { ...h.sourceRange, end },
      length: end - h.sourceRange.start,
      words: wordCount(body),
      badgeCount: 0,
      imageCount: 0,
      linkCount: 0,
      codeCount: 0,
      widgetCount: 0,
      empty: !body.trim(),
    };
  });
  const assign = (items, key) => {
    let index = 0;
    for (const item of [...items].sort(
      (a, b) => a.sourceRange.start - b.sourceRange.start,
    )) {
      while (
        index + 1 < result.sections.length &&
        result.sections[index + 1].sourceRange.start <= item.sourceRange.start
      )
        index++;
      result.sections[index][key]++;
    }
  };
  assign(result.images, "imageCount");
  assign(result.badges, "badgeCount");
  assign(result.links, "linkCount");
  assign(result.codeBlocks, "codeCount");
  assign(result.widgets, "widgetCount");
  for (const section of result.sections) {
    const r = section.sourceRange;
    if (section.level && section.empty)
      issue(
        "section-empty",
        "Structure",
        "Heading-only section",
        "There is no content before the next heading. This may be an intentional group heading.",
        r,
        "info",
        "empty",
      );
    if (section.length > 20000)
      issue(
        "section-large",
        "Structure",
        "Very large section",
        "Heuristic: consider splitting a long section for navigation.",
        r,
        "info",
      );
    if (section.badgeCount > 25)
      issue(
        "section-badges",
        "Clutter",
        "Dozens of badges in one section",
        "Heuristic: a dense badge collection can distract from the surrounding text.",
        r,
        "info",
      );
    if (section.widgetCount > 3)
      issue(
        "section-widgets",
        "Clutter",
        "Widget-heavy section",
        "Heuristic: several remote widgets may dominate the section.",
        r,
        "info",
      );
  }
  if (result.rules.length > 8)
    issue(
      "separators",
      "Clutter",
      "Many horizontal rules",
      "Review repeated separators and excessive fragmentation.",
      result.rules[0].sourceRange,
      "info",
      "separators",
    );
  if (result.sections.filter((s) => s.empty).length > 10)
    issue(
      "fragmentation",
      "Clutter",
      "Many heading-only sections",
      "Heuristic: the document may be overly fragmented.",
      result.headings[0]?.sourceRange,
      "info",
    );
  Object.assign(
    result.stats,
    Object.fromEntries(
      [
        "headings",
        "links",
        "images",
        "badges",
        "widgets",
        "codeBlocks",
        "sections",
      ].map((k) => [k, result[k].length]),
    ),
  );
  return result;
}
