export const EXAMPLE_STATUSES = Object.freeze([
  "verified",
  "user-confirmed",
  "placeholder",
]);
export const EXAMPLE_MARKER_LIMIT = 500;
export const EXAMPLE_SOURCE_LIMIT = 750_000;

export function validateExampleProvenance(value) {
  if (
    !value ||
    !EXAMPLE_STATUSES.includes(value.status) ||
    typeof value.basis !== "string" ||
    value.basis.length > 500 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.basis)
  )
    throw Error("Choose a valid example status and verification note.");
  const basis = value.basis.trim();
  if (value.status === "verified" && !basis)
    throw Error("Verified examples need a verification note or evidence.");
  return { status: value.status, basis };
}

export function exampleFingerprint(value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(
    String(value).replace(/\r\n?/g, "\n"),
  )) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export const exampleMarker = (status, content) => {
  if (!EXAMPLE_STATUSES.includes(status))
    throw Error("Choose a valid example status.");
  return `<!-- readme-studio-example: ${status}${content === undefined ? "" : ` content=${exampleFingerprint(content)}`} -->`;
};

export function readableExampleProvenance(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !EXAMPLE_STATUSES.includes(value.status) ||
    typeof value.basis !== "string"
  )
    return null;
  try {
    return validateExampleProvenance(value);
  } catch {
    return null;
  }
}

export function inspectExampleMarkers(source) {
  const text = String(source);
  if (new TextEncoder().encode(text).byteLength > EXAMPLE_SOURCE_LIMIT)
    return {
      checked: 0,
      counts: { verified: 0, "user-confirmed": 0, placeholder: 0 },
      issues: [],
      truncatedMarkers: 0,
      truncatedSource: true,
    };
  const records = [];
  const markerPattern =
    /<!--\s*readme-studio-example:\s*([^\s>]+)(?:\s+content=([0-9a-f]{16}))?\s*-->/gi;
  const process = (tokens) => {
    let pending = [];
    const flushOrphans = () => {
      records.push(
        ...pending.map(({ status }) => ({ kind: "orphan-marker", status })),
      );
      pending = [];
    };
    for (const token of tokens || []) {
      if (token.type === "html") {
        const claims = [...String(token.text).matchAll(markerPattern)].map(
          (match) => ({
            status: match[1].trim().toLowerCase(),
            fingerprint: match[2]?.toLowerCase() || "",
          }),
        );
        const remainder = String(token.text).replace(markerPattern, "").trim();
        if (claims.length && !remainder) {
          pending.push(...claims);
          continue;
        }
      }
      if (token.type === "code") {
        const claims = pending;
        pending = [];
        if (!claims.length) records.push({ kind: "unclassified" });
        else if (claims.length > 1)
          records.push({
            kind: "duplicate-marker",
            statuses: claims.map((claim) => claim.status),
          });
        else
          records.push({
            kind: "classified",
            ...claims[0],
            actualFingerprint: exampleFingerprint(token.text),
          });
        continue;
      }
      if (token.type !== "space" && pending.length) flushOrphans();
      if (token.type === "blockquote") process(token.tokens);
      if (token.type === "list")
        for (const item of token.items || []) process(item.tokens);
    }
    if (pending.length) flushOrphans();
  };
  process(marked.lexer(text));
  const visible = records.slice(0, EXAMPLE_MARKER_LIMIT);
  const counts = { verified: 0, "user-confirmed": 0, placeholder: 0 };
  const issues = [];
  for (const record of visible) {
    if (record.kind !== "classified") {
      issues.push(record);
      continue;
    }
    const { status } = record;
    if (!EXAMPLE_STATUSES.includes(status))
      issues.push({ kind: "invalid-marker", status });
    else {
      counts[status]++;
      if (status === "placeholder")
        issues.push({ kind: "placeholder", status });
      else if (!record.fingerprint)
        issues.push({ kind: "unbound-marker", status });
      else if (record.fingerprint !== record.actualFingerprint)
        issues.push({ kind: "stale-provenance", status });
    }
  }
  return {
    checked: visible.length,
    counts,
    issues,
    truncatedMarkers: Math.max(records.length - visible.length, 0),
    truncatedSource: false,
  };
}
import { marked } from "marked";
