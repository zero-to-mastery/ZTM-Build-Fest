import { analyzeDocument } from "../analysis/analyze.js";
import { parseSource } from "../analysis/source.js";
import {
  documentationFacts,
  namesTopic,
  suggestProjectType,
} from "./project-types.js";
import { safeUrl } from "../markdown/url-safety.js";

import { placeholderFindings } from "./signals.js";

const words = (text) =>
  text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
const htmlText = (text) =>
  text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(
      /<(script|style|pre|code|svg|h[1-6])\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      " ",
    )
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:#\d+|#x[\da-f]+|[a-z]+);/gi, " ");
function inline(tokens = []) {
  let ignored = 0;
  return tokens
    .map((t) => {
      if (t.type === "html") {
        for (const tag of t.raw.matchAll(
          /<(\/)?(code|pre|script|style|svg)\b[^>]*>/gi,
        ))
          ignored = Math.max(0, ignored + (tag[1] ? -1 : 1));
        return " ";
      }
      if (ignored) return " ";
      if (["image", "code", "codespan"].includes(t.type)) return " ";
      if (t.tokens) return inline(t.tokens);
      return t.type === "html" ? htmlText(t.raw) : t.text || " ";
    })
    .join(" ");
}
function prose(tokens, out = []) {
  for (const t of tokens) {
    if (t.type === "paragraph" || (t.type === "text" && t.tokens))
      out.push(inline(t.tokens));
    else if (t.type === "html") out.push(htmlText(t.raw));
    else if (t.type === "list")
      for (const item of t.items) prose(item.tokens || [], out);
    else if (t.type === "blockquote") prose(t.tokens || [], out);
  }
  return out.filter((text) => words(text).length);
}

// Link text or address that names documentation. "API" counts in link text
// only, because an API's own address is not documentation.
const docsLabel =
  /\b(?:docs?|documentation|api|reference|manual|wiki|guides?)\b/i;
const docsUrl =
  /\b(?:docs?|documentation|reference|manual|wiki|guides?)\b|readthedocs|docs\.rs|pkg\.go\.dev/i;

// Explainable rules, not a score. Activity and popularity never affect the state.
export function classifyReadme(source, repo = {}) {
  if (source === null)
    return {
      state: "missing",
      evidence: ["GitHub reports no README", "README needs attention"],
      metrics: null,
      documentation: {},
      suggestion: suggestProjectType(repo),
    };
  if (typeof source !== "string")
    throw Error("README source must be text or confirmed missing.");
  const analysisSource = source.replace(/^\ufeff/, "");
  const analysis = analyzeDocument(analysisSource);
  const paragraphs = prose(parseSource(analysisSource).tokens);
  const body = paragraphs.join(" ");
  const meaningfulWords = words(body).length;
  const substantive = paragraphs.filter(
    (p) =>
      words(p).length >= 12 &&
      new Set(words(p).map((w) => w.toLowerCase())).size >= 6,
  ).length;
  // Heading labels alone (e.g. empty Setup/Usage scaffolding) are not evidence.
  const setupPattern =
    /\b(install(?:ation|ing)?|setup|set up|getting started|prerequisites?|requirements?)\b/i;
  const usagePattern =
    /\b(usage|how to use|quick ?start|controls|running|run the|use the|examples?)\b/i;
  const sections = analysis.headings.map((heading, i) => {
    const section = analysisSource.slice(
      heading.sourceRange.end,
      analysis.headings[i + 1]?.sourceRange.start ?? analysisSource.length,
    );
    const parsed = parseSource(section);
    return {
      title: heading.title,
      populated:
        words(prose(parsed.tokens).join(" ")).length >= 6 ||
        parsed.nodes.some(
          ({ token }) => token.type === "code" && token.text?.trim(),
        ),
    };
  });
  const sectionHas = (pattern) =>
    sections.some(
      (section) => section.populated && pattern.test(section.title),
    );
  const setup =
    sectionHas(setupPattern) ||
    /\b(?:install|set up|requires)\b[^.!?\n]{8,}/i.test(body);
  const usage =
    sectionHas(usagePattern) ||
    /\b(?:run the|use the|usage:)\b[^.!?\n]{8,}/i.test(body);
  const projectLinks = analysis.links.filter(
    (l) =>
      l.kind !== "anchor" &&
      l.kind !== "mailto" &&
      safeUrl(l.url) &&
      !/!\[|<img\b/i.test(l.raw),
  );
  const links = projectLinks.length;
  const supportingImages = analysis.images.filter(
    (image) =>
      !image.badge && !image.widget && safeUrl(image.url, { image: true }),
  ).length;
  const metrics = {
    characters: source.length,
    bytes:
      analysis.stats.bytes + (source.length !== analysisSource.length ? 3 : 0),
    meaningfulWords,
    headings: analysis.headings.length,
    substantiveParagraphs: substantive,
    images: analysis.images.length,
    supportingImages,
    badges: analysis.badges.length,
    codeExamples: analysis.codeBlocks.length,
    projectLinks: links,
    documentationLinks: projectLinks.filter(
      (l) => docsLabel.test(l.label || "") || docsUrl.test(l.url),
    ).length,
    // Headings using any English topic term; none suggests another language.
    topicHeadings: analysis.headings.filter(
      ({ title }) =>
        namesTopic(title) ||
        setupPattern.test(title) ||
        usagePattern.test(title),
    ).length,
    setup,
    usage,
  };
  let state = "minimal";
  if (!substantive || meaningfulWords < 20) state = "stub";
  else if (
    meaningfulWords >= 1200 &&
    metrics.headings >= 8 &&
    substantive >= 6 &&
    setup &&
    usage &&
    (metrics.codeExamples >= 4 || links >= 4 || supportingImages >= 4)
  )
    state = "documentation-heavy";
  else if (
    meaningfulWords >= 250 &&
    metrics.headings >= 3 &&
    substantive >= 3 &&
    setup &&
    usage &&
    (metrics.codeExamples > 0 || links > 0 || supportingImages > 0)
  )
    state = "detailed";
  else if (
    meaningfulWords >= 80 &&
    substantive >= 2 &&
    (setup ||
      usage ||
      (metrics.headings >= 2 && (links > 0 || supportingImages > 0)))
  )
    state = "basic";
  const evidence = [
    `${meaningfulWords} meaningful prose words · ${source.length} source characters`,
    `${metrics.headings} headings · ${substantive} substantive prose passages`,
    substantive ? "Overview/prose present" : "No substantive prose detected",
    setup ? "Setup-like information detected" : "Missing setup information",
    usage
      ? "Usage-like information detected"
      : "No usage/controls information detected",
    `${metrics.images} images (${metrics.badges} badges) · ${metrics.codeExamples} code examples · ${links} project/documentation links`,
  ];
  if (["stub", "minimal"].includes(state))
    evidence.push("README needs attention");
  return {
    state,
    evidence,
    metrics,
    findings: placeholderFindings(
      body,
      parseSource(analysisSource)
        .tokens.filter((t) => t.type === "heading")
        .map((t) => inline(t.tokens))
        .join(" "),
    ),
    documentation: documentationFacts(metrics, sectionHas),
    suggestion: suggestProjectType(repo, body),
  };
}
