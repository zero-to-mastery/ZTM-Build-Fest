// Mentions in the composer and in message text (#130). Text stays plain: a
// mention is a literal "@Label" in it, and the event carries who it meant.

const WORD = /[\p{L}\p{N}_]/u;

/** The "@query" being typed at `caret`, or null: `{ start, query }`. */
export function activeMention(text, caret) {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && WORD.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /\s/u.test(query)) return null;
  return { start: at, query };
}

/** Options whose label starts with the query (case-insensitive), "everyone" included. */
export function mentionOptions(people, query) {
  const needle = query.toLocaleLowerCase();
  const all = [...people, { id: "everyone", label: "everyone", everyone: true }];
  return all.filter((option) => option.label.toLocaleLowerCase().startsWith(needle));
}

/** Whether `label` appears as "@label" in `text` as a whole mention. */
export function mentionAt(text, index, label) {
  if (!text.startsWith(`@${label}`, index)) return false;
  if (index > 0 && WORD.test(text[index - 1])) return false;
  const end = index + 1 + label.length;
  return end >= text.length || !WORD.test(text[end]);
}

/**
 * Splits `text` into plain and mention pieces for the given `{ id, label }`
 * entries (and "everyone" when asked): [{ text, mention }].
 */
export function splitMentions(text, entries, everyone) {
  const labels = [...entries.map((entry) => entry.label), ...(everyone ? ["everyone"] : [])]
    .filter(Boolean).sort((left, right) => right.length - left.length);
  const pieces = [];
  let plain = 0, index = 0;
  while (index < text.length) {
    const at = text.indexOf("@", index);
    if (at < 0) break;
    const label = labels.find((candidate) => mentionAt(text, at, candidate));
    if (label === undefined) { index = at + 1; continue; }
    if (at > plain) pieces.push({ text: text.slice(plain, at), mention: false });
    pieces.push({ text: `@${label}`, mention: true });
    plain = index = at + 1 + label.length;
  }
  if (plain < text.length) pieces.push({ text: text.slice(plain), mention: false });
  return pieces;
}

/**
 * The mentions to send: the chosen people (a label→id map) whose "@label" is
 * still in `text`, and whether "@everyone" is.
 */
export function resolveMentions(text, chosen, everyone) {
  const members = new Set();
  for (const [label, id] of chosen) {
    for (let at = text.indexOf(`@${label}`); at >= 0; at = text.indexOf(`@${label}`, at + 1)) {
      if (mentionAt(text, at, label)) { members.add(id); break; }
    }
  }
  let all = false;
  if (everyone) for (let at = text.indexOf("@everyone"); at >= 0; at = text.indexOf("@everyone", at + 1)) {
    if (mentionAt(text, at, "everyone")) { all = true; break; }
  }
  return { everyone: all, members: [...members].sort().slice(0, 20) };
}
