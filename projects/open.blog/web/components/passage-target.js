// Passage targets in the browser (ADRs 0076 and 0077). This module is the
// browser half of the contract in crates/openblog-core/src/passage_target.rs:
// both read the same fixtures (tests/fixtures/passage-targets.json) and must
// agree on every result.
//
// A passage target is the whole post (kind "work"), or names a section anchor
// (the heading id) and either the whole section or a quotation with a little
// context on each side. It is resolved against a post's passage text, given
// here as { revision, sections: [{ anchor?, text, digest? }] }, where each
// text is the section's visible prose (the heading's title and the text up to
// the next heading, without generated markers, labels, code blocks or raw
// HTML). A target resolves to the same text or is reported stale with a
// reason; it never points at different text.
//
// The document is an input: the build computes and publishes the revision, each
// section's text and each section's digest (ADR 0076). This module never
// computes a revision or a digest and never reads the page's DOM; the browser
// maps a reader's selection onto the published text. Sections are named by
// their index, because two sections can share an anchor.
//
// Everything here is a pure function. Nothing is fetched or stored, inputs
// are never changed, and a failure is returned as a value for the one target
// that caused it. Offsets count Unicode code points, as Array.from does.

export const PASSAGE_TARGET_VERSION = 1;
export const MAX_QUOTE_CHARS = 500;
export const MAX_CONTEXT_CHARS = 64;
export const MAX_ANCHOR_CHARS = 200;
export const MAX_SECTION_CHARS = 1_000_000;
export const MAX_TARGET_JSON_BYTES = 16 * 1024;
export const CONTEXT_AGREEMENT_CHARS = 8;

const FIELDS = new Set(["version", "kind", "section", "digest", "exact", "prefix", "suffix", "start"]);

// Unicode White_Space, the set Rust's char::is_whitespace uses.
const WHITE_SPACE_RUN = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;
const isWhiteSpace = (character) => /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u.test(character);

/** Collapse each run of whitespace to one space and trim; nothing else changes. */
export function normalizePassageText(text) {
  let out = String(text).replace(WHITE_SPACE_RUN, " ");
  if (out.startsWith(" ")) out = out.slice(1);
  if (out.endsWith(" ")) out = out.slice(0, -1);
  return out;
}

const CONTINUING = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x05bf, 0x05bf], [0x05c1, 0x05c2],
  [0x05c4, 0x05c5], [0x05c7, 0x05c7], [0x0610, 0x061a], [0x064b, 0x065f], [0x0670, 0x0670],
  [0x06d6, 0x06dc], [0x06df, 0x06e4], [0x06e7, 0x06e8], [0x06ea, 0x06ed], [0x0900, 0x0903],
  [0x093a, 0x093c], [0x093e, 0x094f], [0x0951, 0x0957], [0x0962, 0x0963], [0x0981, 0x0983],
  [0x09bc, 0x09bc], [0x09be, 0x09cd], [0x09d7, 0x09d7], [0x09e2, 0x09e3], [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200c, 0x200d],
  [0x20d0, 0x20ff], [0x302a, 0x302f], [0x3099, 0x309a], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
  [0x1f3fb, 0x1f3ff], [0xe0020, 0xe007f], [0xe0100, 0xe01ef],
];

/**
 * A character that continues the one before it, so a target never begins or
 * ends in front of it: a fixed approximation of grapheme clusters that does
 * not depend on the browser's Unicode tables, so it agrees with the build.
 */
export function isContinuingCharacter(character) {
  const point = character.codePointAt(0);
  return CONTINUING.some(([low, high]) => point >= low && point <= high);
}

const ZWJ = "\u200d";
const isBoundary = (chars, index) =>
  index === 0 || index >= chars.length || (!isContinuingCharacter(chars[index]) && chars[index - 1] !== ZWJ);

const isControl = (character) => {
  const point = character.codePointAt(0);
  return point <= 0x1f || (point >= 0x7f && point <= 0x9f);
};
const isBidiControl = (character) => {
  const point = character.codePointAt(0);
  return (point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069);
};
const isForbidden = (character) => isControl(character) || isBidiControl(character);
const hasLoneSurrogate = (text) => Array.from(text).some((character) => {
  const unit = character.charCodeAt(0);
  return character.length === 1 && unit >= 0xd800 && unit <= 0xdfff;
});

const failure = (code, message) => ({ ok: false, error: { code, message } });
const malformed = (message) => failure("malformed", message);
const isDigest = (value) => /^[0-9a-f]{32}$/.test(value);

function checkText(field, value, max, trimmed) {
  const chars = Array.from(value);
  if (chars.length > max) {
    return failure(field === "exact" ? "quoteTooLong" : "contextTooLong", `\`${field}\` is longer than ${max} characters`);
  }
  if (chars.some(isForbidden)) {
    return failure("forbiddenCharacter", `\`${field}\` holds a control or text-direction character`);
  }
  const spaced = chars.some((c) => isWhiteSpace(c) && c !== " ") || value.includes("  ");
  if (spaced || (trimmed && (value.startsWith(" ") || value.endsWith(" ")))) {
    return failure("notNormalized", `\`${field}\` is not passage text: whitespace must be single spaces`);
  }
  return null;
}

function validate(target) {
  if (target.section !== undefined && target.kind !== "work") {
    const chars = Array.from(target.section);
    if (chars.length === 0 || chars.length > MAX_ANCHOR_CHARS || chars.some((c) => isWhiteSpace(c) || isForbidden(c))) {
      return failure("invalidAnchor", `\`section\` must be a heading id of 1 to ${MAX_ANCHOR_CHARS} characters without spaces`);
    }
  }
  if (target.kind === "work") {
    return target.section === undefined ? null : malformed("a work target has no `section`");
  }
  if (target.kind === "section") {
    if (target.digest !== undefined && !isDigest(target.digest)) {
      return failure("invalidDigest", "`digest` must be 32 lowercase hexadecimal digits");
    }
    return null;
  }
  if (target.exact === "") return failure("emptyQuote", "`exact` must quote some text");
  const problem =
    checkText("exact", target.exact, MAX_QUOTE_CHARS, true) ||
    checkText("prefix", target.prefix, MAX_CONTEXT_CHARS, false) ||
    checkText("suffix", target.suffix, MAX_CONTEXT_CHARS, false);
  if (problem) return problem;
  const first = (text) => Array.from(text)[0];
  const last = (text) => Array.from(text).at(-1);
  const split =
    isContinuingCharacter(first(target.exact)) ||
    last(target.exact) === ZWJ ||
    (target.prefix !== "" && isContinuingCharacter(first(target.prefix))) ||
    (target.suffix !== "" && last(target.suffix) === ZWJ) ||
    (target.prefix !== "" && last(target.prefix) === ZWJ) ||
    (target.suffix !== "" && isContinuingCharacter(first(target.suffix)));
  if (split) {
    return failure("splitCharacter", "a quotation or its context starts or ends inside a character");
  }
  if (target.start > MAX_SECTION_CHARS) return failure("invalidRange", `\`start\` is beyond ${MAX_SECTION_CHARS}`);
  return null;
}

const freeze = (target) => Object.freeze(target);

/**
 * Read a passage target from a parsed JSON value. Returns
 * { ok: true, target } with a new, frozen target, or { ok: false, error }
 * with a code and a message that names the field and never repeats its text.
 * Nothing is repaired, and the value passed in is never changed.
 */
export function readTarget(value) {
  return readValue(value, {});
}

const U64_LIMIT = 2n ** 64n;
const CANONICAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const NUMBER_TOKEN = /\s*:\s*(-?[0-9][0-9.eE+-]*)/y;

/**
 * The raw text of the top-level `version` and `start` values of valid JSON
 * text, so non-canonical integers (1.0, 7e0, -0) can be refused as the build
 * refuses them. A value that is not a number has no token.
 */
function integerTokens(text) {
  const tokens = {};
  let depth = 0;
  let expectKey = false;
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    if (character === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (depth === 1 && expectKey) {
        expectKey = false;
        const key = JSON.parse(text.slice(i, end + 1));
        if (key === "version" || key === "start") {
          NUMBER_TOKEN.lastIndex = end + 1;
          const match = NUMBER_TOKEN.exec(text);
          tokens[key] = match ? match[1] : undefined;
        }
      }
      i = end;
    } else if (character === "{" || character === "[") {
      depth += 1;
      expectKey = depth === 1 && character === "{";
    } else if (character === "}" || character === "]") {
      depth -= 1;
    } else if (character === "," && depth === 1) {
      expectKey = true;
    }
  }
  return tokens;
}

function readValue(value, tokens) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return malformed("a passage target must be a JSON object");
  }
  // An integer is a whole number the build can hold as an unsigned 64-bit
  // value, written without a fraction, exponent or sign. Anything else is
  // malformed; a larger version than ours is unsupported.
  const versionToken = tokens.version;
  const version = value.version;
  const versionBig =
    versionToken !== undefined
      ? CANONICAL_INTEGER.test(versionToken) && BigInt(versionToken) < U64_LIMIT ? BigInt(versionToken) : null
      : Number.isInteger(version) && version >= 0 && version < 2 ** 64 ? BigInt(version) : null;
  if (versionBig === null) return malformed("a passage target needs `version` 1");
  if (versionBig > BigInt(PASSAGE_TARGET_VERSION)) {
    return failure("unsupportedVersion", `this passage target is version ${versionBig}, newer than the version ${PASSAGE_TARGET_VERSION} this open.blog reads`);
  }
  if (versionBig !== BigInt(PASSAGE_TARGET_VERSION)) return malformed("a passage target needs `version` 1");
  const wrongShape = malformed("a passage target has a field this version does not define, or a field of the wrong type");
  const keys = Object.keys(value);
  if (keys.some((key) => !FIELDS.has(key))) return wrongShape;
  const text = (key) => value[key] === undefined || value[key] === null || (typeof value[key] === "string" && !hasLoneSurrogate(value[key]));
  if (typeof value.kind !== "string" || hasLoneSurrogate(value.kind) || !["section", "digest", "exact", "prefix", "suffix"].every(text)) return wrongShape;
  const start = value.start;
  if (start !== undefined && start !== null) {
    const startToken = tokens.start;
    const holdable =
      startToken !== undefined
        ? CANONICAL_INTEGER.test(startToken) && BigInt(startToken) < U64_LIMIT
        : Number.isInteger(start) && start >= 0 && start < 2 ** 64;
    if (!holdable) return wrongShape;
  }
  const given = (key) => value[key] !== undefined && value[key] !== null;
  const target = { version: PASSAGE_TARGET_VERSION, kind: value.kind };
  if (given("section")) target.section = value.section;
  if (value.kind === "work") {
    if (["section", "digest", "exact", "prefix", "suffix", "start"].some(given)) {
      return malformed("a work target has no section or selector fields");
    }
  } else if (value.kind === "section") {
    if (["exact", "prefix", "suffix", "start"].some(given)) return malformed("a section target has no quotation fields");
    if (given("digest")) target.digest = value.digest;
  } else if (value.kind === "quote") {
    if (!["exact", "prefix", "suffix", "start"].every(given)) {
      return malformed("a quote target needs `exact`, `prefix`, `suffix` and `start`");
    }
    if (given("digest")) return malformed("a quote target has no `digest`");
    if (start > MAX_SECTION_CHARS) return failure("invalidRange", `\`start\` is beyond ${MAX_SECTION_CHARS}`);
    Object.assign(target, { exact: value.exact, prefix: value.prefix, suffix: value.suffix, start });
  } else {
    return malformed("`kind` must be `work`, `section` or `quote`");
  }
  return validate(target) || { ok: true, target: freeze(target) };
}

/** Read a passage target from JSON text of at most MAX_TARGET_JSON_BYTES. */
export function readTargetJson(text) {
  if (new TextEncoder().encode(String(text)).length > MAX_TARGET_JSON_BYTES) {
    return failure("tooLarge", `a passage target is larger than ${MAX_TARGET_JSON_BYTES} bytes`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return malformed("a passage target is not valid JSON");
  }
  return readValue(value, integerTokens(String(text)));
}

/**
 * Read a passage target nested in a larger JSON document: `value` is the
 * parsed target and `text` its exact JSON source, so `version` and `start`
 * are checked as written, as the build checks them. No size limit applies;
 * the enclosing document has its own.
 */
export function readTargetSource(value, text) {
  return readValue(value, integerTokens(String(text)));
}

/** The target for the whole post: no section and no selector. */
export function createWorkTarget() {
  return freeze({ version: PASSAGE_TARGET_VERSION, kind: "work" });
}

const sectionChars = (document) => document.sections.map((section) => Array.from(normalizePassageText(section.text)));
const anchorOf = (section) => (section.anchor === undefined || section.anchor === null ? undefined : section.anchor);

/**
 * A quotation target for code points start..end of section `index`, with up
 * to MAX_CONTEXT_CHARS of context on each side cut at character boundaries.
 * Spaces at either end are left out; a range inside a character is refused.
 */
export function createQuoteTarget(document, index, start, end) {
  const section = document.sections[index];
  if (!section) return failure("invalidRange", "there is no such section");
  const chars = Array.from(normalizePassageText(section.text));
  if (!(Number.isSafeInteger(start) && Number.isSafeInteger(end)) || start < 0 || start > end || end > chars.length) {
    return failure("invalidRange", "the selection is outside the section");
  }
  while (start < end && chars[start] === " ") start += 1;
  while (end > start && chars[end - 1] === " ") end -= 1;
  if (start === end) return failure("emptyQuote", "the selection holds no text");
  if (!isBoundary(chars, start) || !isBoundary(chars, end)) {
    return failure("splitCharacter", "the selection starts or ends inside a character");
  }
  let prefixStart = Math.max(0, start - MAX_CONTEXT_CHARS);
  while (!isBoundary(chars, prefixStart)) prefixStart += 1;
  let suffixEnd = Math.min(chars.length, end + MAX_CONTEXT_CHARS);
  while (!isBoundary(chars, suffixEnd)) suffixEnd -= 1;
  const target = { version: PASSAGE_TARGET_VERSION, kind: "quote" };
  const anchor = anchorOf(section);
  if (anchor !== undefined) target.section = anchor;
  Object.assign(target, {
    exact: chars.slice(start, end).join(""),
    prefix: chars.slice(prefixStart, start).join(""),
    suffix: chars.slice(end, suffixEnd).join(""),
    start,
  });
  return validate(target) || { ok: true, target: freeze(target) };
}

const location = (document, chars, index, start, end, state) => {
  const result = { state };
  const anchor = anchorOf(document.sections[index]);
  if (anchor !== undefined) result.section = anchor;
  result.index = index;
  result.start = start;
  result.end = end;
  return result;
};

const commonSuffix = (wanted, text) => {
  let count = 0;
  while (count < wanted.length && count < text.length && wanted[wanted.length - 1 - count] === text[text.length - 1 - count]) count += 1;
  return count;
};
const commonPrefix = (wanted, text, from) => {
  let count = 0;
  while (count < wanted.length && from + count < text.length && wanted[count] === text[from + count]) count += 1;
  return count;
};
const sameRun = (chars, from, run) => run.every((character, offset) => chars[from + offset] === character);

/**
 * Resolve a valid target (from readTarget) against a document. `seen` is the
 * revision the reader saw, when known. Returns
 * { state: "current" | "reanchored", section?, index, start, end } or
 * { state: "stale", reason, sectionPresent }. `index` is the section's
 * position in the document, the unambiguous name for it (anchors can repeat);
 * a work target has no section, so it has no index and the empty range 0..0.
 */
export function resolveTarget(target, document, seen) {
  if (target.kind === "work") return { state: "current", start: 0, end: 0 };
  const chars = sectionChars(document);
  const sameRevision = typeof seen === "string" && seen === document.revision;
  const named = document.sections.map((section, index) => (anchorOf(section) === target.section ? index : -1)).filter((index) => index >= 0);
  const stale = (reason) => ({ state: "stale", reason, sectionPresent: named.length > 0 });
  const whole = (index, state) => location(document, chars, index, 0, chars[index].length, state);

  if (target.kind === "section") {
    if (target.digest === undefined) {
      if (named.length === 0) return stale("sectionRemoved");
      if (named.length > 1) return stale("ambiguous");
      return sameRevision ? whole(named[0], "current") : stale("unverified");
    }
    const sameText = document.sections.map((section, index) => (section.digest === target.digest ? index : -1)).filter((index) => index >= 0);
    const unchanged = sameText.filter((index) => named.includes(index));
    if (unchanged.length === 1) return whole(unchanged[0], sameRevision ? "current" : "reanchored");
    if (unchanged.length > 1) return stale("ambiguous");
    if (sameText.length === 1) return whole(sameText[0], "reanchored");
    if (sameText.length > 1) return stale("ambiguous");
    return stale(named.length === 0 ? "sectionRemoved" : "sectionChanged");
  }

  const exact = Array.from(target.exact);
  const prefix = Array.from(target.prefix);
  const suffix = Array.from(target.suffix);
  if (sameRevision) {
    for (const index of named) {
      const text = chars[index];
      const end = target.start + exact.length;
      if (
        end <= text.length &&
        sameRun(text, target.start, exact) &&
        commonSuffix(prefix, text.slice(0, target.start)) === prefix.length &&
        commonPrefix(suffix, text, end) === suffix.length &&
        isBoundary(text, target.start) &&
        isBoundary(text, end)
      ) {
        return location(document, chars, index, target.start, end, "current");
      }
    }
  }
  let found = false;
  let best = null;
  let tied = false;
  const agrees = (common, wanted, atEdge) => (wanted === 0 ? atEdge : common >= Math.min(wanted, CONTEXT_AGREEMENT_CHARS));
  chars.forEach((text, index) => {
    for (let start = 0; start + exact.length <= text.length; start += 1) {
      const end = start + exact.length;
      if (!sameRun(text, start, exact) || !isBoundary(text, start) || !isBoundary(text, end)) continue;
      found = true;
      const before = commonSuffix(prefix, text.slice(0, start));
      const after = commonPrefix(suffix, text, end);
      if (!agrees(before, prefix.length, start === 0) && !agrees(after, suffix.length, end === text.length)) continue;
      const score = [before + after, named.includes(index) ? 1 : 0];
      const compare = best ? score[0] - best.score[0] || score[1] - best.score[1] : 1;
      if (compare > 0) {
        best = { score, index, start };
        tied = false;
      } else if (compare === 0) {
        tied = true;
      }
    }
  });
  if (best && tied) return stale("ambiguous");
  if (best) return location(document, chars, best.index, best.start, best.start + exact.length, "reanchored");
  return stale(found ? "contextChanged" : "quoteNotFound");
}
