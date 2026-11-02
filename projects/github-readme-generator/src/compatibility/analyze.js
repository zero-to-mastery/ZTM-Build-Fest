import { compatibilityRegistry } from "./registry.js";
import { safeUrl } from "../markdown/url-safety.js";
function decodeUrl(value) {
  return value.replace(
    /&(?:#(x[0-9a-f]+|[0-9]+)|colon|Tab|NewLine|amp);?/gi,
    (raw, n) => {
      if (n) {
        const code =
          n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
        return code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : "\ufffd";
      }
      return (
        { "&colon;": ":", "&tab;": "\t", "&newline;": "\n", "&amp;": "&" }[
          raw.toLowerCase()
        ] || raw
      );
    },
  );
}
export function analyzeCompatibility(analysis) {
  const findings = [];
  const add = (
    id,
    behavior,
    what,
    explanation,
    alternative,
    range,
    category = "Compatibility",
  ) => {
    if (findings.length < 1000)
      findings.push({
        id: `${id}:${range.start}`,
        ruleId: id,
        githubBehavior: behavior,
        what,
        explanation,
        suggestedAlternative: alternative,
        sourceRange: range,
        category,
      });
  };
  const pictures = [],
    details = [],
    tables = [];
  const incompletePicture = (p) => {
    if (!p.img)
      add(
        "picture-fallback",
        "Needs review",
        "Picture has no fallback image",
        "A source element alone is not a complete picture. Dark-only sources can leave other readers without an image.",
        "Add one img with src and meaningful alt as the fallback.",
        p.range,
      );
  };
  const incompleteDetails = (d) => {
    if (!d.summary)
      add(
        "details-summary",
        "Needs review",
        "Details has no summary",
        "Readers need a concise label to understand what is collapsed.",
        "Add a summary immediately inside details.",
        d.range,
      );
  };
  for (const node of analysis.htmlBlocks) {
    const { tag, attributes: a, closing, sourceRange: r } = node;
    if (closing) {
      if (tag === "picture") {
        const p = pictures.pop();
        if (p) incompletePicture(p);
      }
      if (tag === "details") {
        const d = details.pop();
        if (d) incompleteDetails(d);
        else
          add(
            "details-close",
            "Needs review",
            "Unmatched closing details",
            "Unbalanced tags can change layout unexpectedly.",
            "Balance the details wrapper.",
            r,
          );
      }
      if (tag === "table") tables.pop();
      continue;
    }
    const rule = compatibilityRegistry.find((rule) => rule.tags.includes(tag));
    if (rule)
      add(
        rule.id,
        rule.githubBehavior,
        `<${tag}> element`,
        rule.explanation,
        rule.suggestedAlternative,
        r,
        rule.category,
      );
    else
      add(
        "unknown-tag",
        "Needs review",
        `Unclassified <${tag}> element`,
        "This tag is outside the documented Studio compatibility examples; no support guarantee is made.",
        "Prefer simple Markdown or verify the final rendering on GitHub.",
        r,
      );
    if (Object.keys(a).some((k) => /^on/i.test(k)))
      add(
        "event-handler",
        "Unsafe",
        "Event-handler attribute",
        "Event attributes can execute scripts and are removed from the preview. GitHub commonly strips them.",
        "Remove event handlers; use ordinary links.",
        r,
        "Security",
      );
    if (a.style !== undefined)
      add(
        "inline-style",
        "Likely stripped",
        "Inline style attribute",
        "GitHub commonly strips inline CSS, so these colors or layout rules may disappear.",
        "Use Markdown or an image asset instead of CSS.",
        r,
      );
    if (a.class !== undefined || a.id !== undefined)
      add(
        "presentation-attributes",
        "Needs review",
        "Class or id attribute",
        "GitHub sanitization may remove or rewrite these attributes. Custom CSS hooks will not work.",
        "Use generated heading anchors and simple semantic structure.",
        r,
      );
    if (tag === "picture") {
      if (pictures.length)
        add(
          "nested-picture",
          "Needs review",
          "Nested picture elements",
          "Nested pictures do not form a normal image fallback structure.",
          "Use separate complete picture elements.",
          r,
        );
      pictures.push({ range: r, img: false });
    }
    if (tag === "img" && pictures.length) pictures.at(-1).img = true;
    if (tag === "source") {
      if (!pictures.length)
        add(
          "source-parent",
          "Needs review",
          "Source outside picture",
          "An image source needs a picture wrapper and fallback image.",
          "Wrap the source and fallback img in picture.",
          r,
        );
      if (!a.srcset)
        add(
          "source-url",
          "Needs review",
          "Source has no srcset",
          "There is no alternate image URL for this source.",
          "Provide a safe image URL in srcset.",
          r,
        );
      if (
        a.media &&
        (/prefers-color-scheme/i.test(a.media)
          ? !/^\s*\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)\s*$/i.test(
              a.media,
            )
          : !/^\([^()]+\)$/.test(a.media))
      )
        add(
          "source-media",
          "Needs review",
          "Review source media syntax",
          "This helper recognizes a simple parenthesized media condition; complex conditions need manual verification.",
          "For theme pairs use (prefers-color-scheme: dark) and an img fallback.",
          r,
        );
      if (
        a.srcset &&
        a.srcset.split(",").some(
          (candidate) =>
            !safeUrl(decodeUrl(candidate.trim().split(/\s+/)[0]), {
              image: true,
            }),
        )
      )
        add(
          "source-unsafe",
          "Unsafe",
          "Unsafe source URL",
          "Studio does not load unsafe image schemes. GitHub may also reject them.",
          "Use an https image or repository-relative asset.",
          r,
          "Security",
        );
    }
    if (tag === "details") {
      if (details.length)
        add(
          "nested-details",
          "Needs review",
          "Nested collapsible sections",
          "Nesting can be valid, but may make mobile navigation confusing.",
          "Keep collapsible sections shallow.",
          r,
        );
      details.push({ range: r, summary: false });
    }
    if (tag === "summary") {
      if (details.length) details.at(-1).summary = true;
      else
        add(
          "summary-parent",
          "Needs review",
          "Summary outside details",
          "A summary without its details wrapper does not provide a reliable disclosure control.",
          "Place summary immediately inside details.",
          r,
        );
    }
    if (tag === "table") {
      if (tables.length)
        add(
          "table-nesting",
          "Needs review",
          "Nested HTML tables",
          "Mobile layout risk: nested tables can cause excessive horizontal scrolling. This is distinct from whether the tag survives sanitization.",
          "Use separate simple tables or sections.",
          r,
          "Layout",
        );
      tables.push({ columns: 0 });
    }
    if (tag === "tr" && tables.length) tables.at(-1).columns = 0;
    if ((tag === "td" || tag === "th") && tables.length) {
      const t = tables.at(-1);
      t.columns++;
      if (t.columns === 7)
        add(
          "table-columns",
          "Needs review",
          "HTML table has more than six columns",
          "Mobile layout risk: many columns may require horizontal scrolling.",
          "Split the table or shorten columns.",
          r,
          "Layout",
        );
    }
    if (
      (tag === "table" || tag === "td" || tag === "th") &&
      (a.width || a.colspan || a.rowspan)
    )
      add(
        "table-complex",
        "Needs review",
        "Fixed or spanning table layout",
        "Mobile layout risk: fixed widths and spans may render differently in GitHub and the Studio preview.",
        "Use a simple table and inspect a narrow preview.",
        r,
        "Layout",
      );
  }
  for (const p of pictures) {
    incompletePicture(p);
    add(
      "picture-close",
      "Needs review",
      "Unclosed picture",
      "Malformed wrappers may be repaired differently by renderers.",
      "Close the picture after its fallback img.",
      p.range,
    );
  }
  for (const d of details) {
    incompleteDetails(d);
    add(
      "details-unclosed",
      "Needs review",
      "Unclosed details",
      "Unbalanced details can hide later content.",
      "Close details after the intended content.",
      d.range,
    );
  }
  for (const image of analysis.images)
    if (!image.alt?.trim())
      add(
        "image-alt",
        "Needs review",
        "Image has missing or empty alt",
        "Informative images need an accessible description; decorative images may intentionally have empty alt.",
        "Describe the image purpose, or confirm it is decorative.",
        image.sourceRange,
        "Accessibility",
      );
  for (const item of [...analysis.links, ...analysis.images]) {
    const image = Object.hasOwn(item, "alt"),
      url = decodeUrl(item.url).trim(),
      r = item.sourceRange;
    if (/^(?:javascript|vbscript):/i.test(url))
      add(
        "url-executable",
        "Unsafe",
        "Executable URL scheme",
        "Script URLs are blocked by Studio preview and are unsafe README links.",
        "Use an https URL, relative path, anchor or mailto link.",
        r,
        "Security",
      );
    else if (/^data:/i.test(url))
      add(
        "url-data",
        "Likely stripped",
        "Inline data URL",
        "Studio blocks data URLs; GitHub may reject embedded data instead of displaying it. This is a preview security policy as well as a compatibility concern.",
        "Commit an image asset and reference its path.",
        r,
      );
    else if (/^blob:/i.test(url))
      add(
        "url-blob",
        "Needs review",
        "Browser-local blob URL",
        "A blob URL belongs to one browser session and is not portable to GitHub. Studio preview blocks it.",
        "Save the file and use a repository-relative path.",
        r,
      );
    else if (!safeUrl(url, { image }))
      add(
        "url-unsafe",
        "Unsafe",
        "Invalid or blocked URL",
        "The preview URL boundary rejects this destination; compatibility cannot make it safe.",
        "Review the scheme and use an ordinary safe URL.",
        r,
        "Security",
      );
    else if (
      image &&
      /^https?:\/\/github\.com\/[^/]+\/[^/]+\/blob\//i.test(url)
    )
      add(
        "github-blob-image",
        "Needs review",
        "GitHub blob-page image URL",
        "This address may return an HTML file page rather than image bytes; preview behavior may differ.",
        "Use a repository-relative image path or the raw image URL.",
        r,
      );
    else if (/^https?:\/\/raw\.githubusercontent\.com\//i.test(url))
      add(
        "raw-github",
        "Likely supported",
        "Raw GitHub asset URL",
        "A raw asset can render as an image, but availability depends on repository visibility and branch/path stability.",
        "Keep the path current or prefer a relative repository asset.",
        r,
      );
    else if (!/^(?:[a-z][\w+.-]*:|\/\/)/i.test(url) && !url.startsWith("#"))
      add(
        "relative-url",
        "Likely supported",
        "Repository-relative URL",
        "GitHub resolves paths relative to the README. Studio needs source context to resolve imported relative URLs.",
        "Keep the asset beside the README or preserve its repository source context.",
        r,
      );
  }
  return findings;
}
