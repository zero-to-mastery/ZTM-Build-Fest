// Reviewed drift remediation turns the findings of one Drift check into
// line-level Fix proposals. It is pure: proposals are built from the exact
// Source that was checked, every change is approved one at a time by the
// author, and applying refuses any Source that differs from the checked one
// (a conflict), so later manual edits are never overwritten. Nothing here
// writes to GitHub, storage or the Store; publishing stays a separate,
// explicitly reviewed action.
//
// Only observed mismatches and uncertain findings become proposals. Unknown
// results and matches never do. A finding's `fix` (from `evaluateDrift`) is a
// suggestion; when it cannot be placed unambiguously on its line the proposal
// starts as the unchanged line for the author to edit.

export const REMEDIABLE = Object.freeze(["mismatch", "uncertain"]);

export class DriftConflict extends Error {
  constructor(message) {
    super(message);
    this.name = "DriftConflict";
  }
}

// The Source's lines with their offsets. Line endings (`\r\n`, `\r` or `\n`,
// numbered as the Drift check numbers them) stay out of `text`, so replacing
// a line never changes its ending or any other line.
export function sourceLines(source) {
  const lines = [],
    pattern = /\r\n|\r|\n/g;
  let start = 0,
    match;
  while ((match = pattern.exec(source))) {
    lines.push({
      start,
      end: match.index,
      eol: match[0],
      text: source.slice(start, match.index),
    });
    start = match.index + match[0].length;
  }
  lines.push({
    start,
    end: source.length,
    eol: "",
    text: source.slice(start),
  });
  return lines;
}

const WORD = /[\p{L}\p{N}_]/u,
  // Characters that continue a word, path or URL. A match right after one
  // is part of a longer token: `guide.md` inside `docs/guide.md`,
  // `myguide.md` or `../guide.md`, or `#setup` inside `docs/x.md#setup`.
  JOINED = /[\p{L}\p{N}_\-./\\~%@+#?&:]/u,
  AFTER = /[\p{L}\p{N}_:-]/u,
  // Separators that join a longer path or URL when more of it follows
  // (`docs/guide.md#x`, `guide.md.bak`); at the end of a token they are
  // punctuation (`See docs/guide.md.`).
  SEPARATOR = /[/.\\#?%@~+]/;
// Whether the `=` or `,` just before `at` joins a longer URL: a query value
// (`view?file=docs/guide.md`) or a comma inside a URL
// (`example.com/x,docs/guide.md`). An HTML attribute (`href=docs/x.md`), a
// command option (`--config=docs/x.md`) or a comma in prose does not.
function joinedBy(text, at) {
  const mark = text[at - 1];
  if (mark === ",") return JOINED.test(text[at - 2] || "");
  if (mark !== "=") return false;
  const run = text.slice(0, at - 1).match(/[^\s"'(<[`]*$/)[0];
  return /[?&#/:;]/.test(run);
}
// Where `find` occurs in `text` as a whole token: not inside a longer word,
// path or URL. So `lint` is not found in `lint:fix`, `guide.md` not in
// `myguide.md` or `docs/guide.md`, `docs/guide.md` not in
// `other/docs/guide.md` or another URL's query (`?file=docs/guide.md`), and
// `#setup` not in `docs/x.md#setup`. A suggestion therefore lands only on
// its own claim, never on a longer, different link, path or anchor that
// shares its text.
export function occurrences(text, find) {
  const found = [];
  if (!find) return found;
  for (
    let at = text.indexOf(find);
    at !== -1;
    at = text.indexOf(find, at + 1)
  ) {
    const end = at + find.length,
      prev = text[at - 1] || "",
      next = text[end] || "";
    if (JOINED.test(prev) || joinedBy(text, at)) continue;
    // A find ending in a word character or a separator (`docs/`) is part
    // of a longer token when the name goes on (`docs/setup.md`).
    const last = find.at(-1);
    if ((WORD.test(last) || SEPARATOR.test(last)) && AFTER.test(next)) continue;
    if (SEPARATOR.test(next) && JOINED.test(text[end + 1] || "")) continue;
    found.push(at);
  }
  return found;
}

// Applies one suggested fix to a line, or returns null when it cannot be
// placed: `find` is absent, or `once` is set and `find` occurs more than once.
// Otherwise every whole occurrence is replaced (the same broken link written
// twice on a line is the same claim).
export function placeFix(text, fix) {
  if (!fix?.find || typeof fix.replace !== "string" || fix.find === fix.replace)
    return null;
  const found = occurrences(text, fix.find);
  if (!found.length || (fix.once && found.length > 1)) return null;
  let out = text;
  for (const at of found.reverse())
    out = out.slice(0, at) + fix.replace + out.slice(at + fix.find.length);
  return out;
}

// One proposal per Source line that has at least one observed mismatch or
// uncertain finding, in line order. `before` is the line as checked and
// `suggested` the line with every placeable suggestion applied (equal to
// `before` when there is none). Findings keep their evidence: message,
// evidence file, Baseline annotation and whether a suggestion was placed.
export function driftProposals(source, result) {
  const lines = sourceLines(String(source ?? ""));
  const byLine = new Map(),
    applied = new Map();
  let unplaced = 0;
  for (const item of result?.results || []) {
    if (!REMEDIABLE.includes(item.status)) continue;
    const line = lines[item.line - 1];
    if (!Number.isInteger(item.line) || !line) {
      unplaced++;
      continue;
    }
    if (!byLine.has(item.line))
      byLine.set(item.line, {
        id: `line-${item.line}`,
        line: item.line,
        before: line.text,
        suggested: line.text,
        status: "uncertain",
        findings: [],
      });
    const proposal = byLine.get(item.line);
    if (item.status === "mismatch") proposal.status = "mismatch";
    const placed = item.fix ? placeFix(proposal.suggested, item.fix) : null;
    if (placed !== null) proposal.suggested = placed;
    // The same correction found twice on a line (a path written as a code
    // span and as a link) is placed by the first finding, which replaces
    // every occurrence, so the second one is already in the suggested line.
    const key = item.fix
      ? JSON.stringify([item.fix.find, item.fix.replace])
      : "";
    const covered =
      placed === null && !!key && !!applied.get(item.line)?.has(key);
    if (placed !== null && key)
      applied.set(item.line, (applied.get(item.line) || new Set()).add(key));
    proposal.findings.push({
      id: item.id,
      status: item.status,
      category: item.category,
      text: item.text,
      message: item.message,
      evidencePath: item.evidencePath || "",
      ...(item.baseline ? { baseline: item.baseline } : {}),
      suggestion: item.fix
        ? {
            find: item.fix.find,
            replace: item.fix.replace,
            placed: placed !== null || covered,
          }
        : null,
    });
  }
  const proposals = [...byLine.values()].sort((a, b) => a.line - b.line);
  const notes = [];
  if (unplaced)
    notes.push(
      `${unplaced} finding(s) could not be matched to a line of this Markdown and have no proposal.`,
    );
  const excluded = (result?.results || []).filter(
    (item) => !REMEDIABLE.includes(item.status),
  ).length;
  return { proposals, notes, excluded };
}

// The checked Source with `changes` ({ line, before, after }) applied. Each
// change must name a distinct line whose text is still exactly `before`;
// unchanged entries are ignored. Line breaks typed into `after` take the
// line's own ending, so a CRLF document stays CRLF. Throws DriftConflict
// when a change no longer fits the Source.
export function previewDriftChanges(source, changes) {
  const lines = sourceLines(source);
  const fallback = lines.find((line) => line.eol)?.eol || "\n";
  const seen = new Set(),
    edits = [];
  for (const change of changes || []) {
    const line = Number.isInteger(change?.line) && lines[change.line - 1];
    if (!line)
      throw new DriftConflict(
        `Line ${change?.line} is not in the checked Markdown.`,
      );
    if (seen.has(change.line))
      throw new DriftConflict(`Line ${change.line} has more than one change.`);
    seen.add(change.line);
    if (typeof change.after !== "string" || typeof change.before !== "string")
      throw new TypeError("A change needs before and after text.");
    if (line.text !== change.before)
      throw new DriftConflict(
        `Line ${change.line} no longer matches the reviewed text.`,
      );
    if (change.after === change.before) continue;
    edits.push({
      ...line,
      after: change.after.replace(/\r\n|\r|\n/g, line.eol || fallback),
    });
  }
  let markdown = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    markdown =
      markdown.slice(0, edit.start) + edit.after + markdown.slice(edit.end);
  return { markdown, applied: edits.length };
}

// Applies approved changes only when the current Source is exactly the one
// that was checked. Any other edit since the check, anywhere in the
// document, is a conflict: nothing is applied and the author re-runs the
// check, so manual edits are never overwritten by a stale proposal.
export function applyDriftProposals(checked, current, changes) {
  if (typeof checked !== "string" || current !== checked)
    throw new DriftConflict(
      "Your Markdown changed since the drift check, so the reviewed changes were not applied. Run the drift check again to review fixes for the current Markdown.",
    );
  const result = previewDriftChanges(checked, changes);
  if (!result.applied)
    throw Error("No approved change differs from the current Markdown.");
  return result;
}

// Whether applying could change the draft's structure, not only its
// Markdown. Applying records the new Markdown as manual source (Store.raw),
// which detaches the builder sections, components and generated or autofilled
// content whose lines change: they become Custom Markdown (ADR epic63-01).
// Untouched sections keep their ownership. Undo restores them.
export function convertsBuilder(draft) {
  const blocks = draft?.blocks || [];
  if (!blocks.length) return false;
  const [only] = blocks;
  return !(
    blocks.length === 1 &&
    only.type === "custom" &&
    !only.sharedComponent &&
    !only.githubGenerated &&
    !only.profileAutofill
  );
}
