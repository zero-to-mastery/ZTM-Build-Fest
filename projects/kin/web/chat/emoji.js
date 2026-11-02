// Emoji in chat (#113). Emoji are ordinary Unicode text: the OS emoji
// keyboard already types them, the picker inserts them, and the OS font draws
// them. Nothing here fetches images or outside data.
//
// emoji.json is the picker's hand-curated table (about 330 common emoji in a
// few categories, each with a short name used as its accessible name).

/** A grapheme (user-perceived character) that is one emoji as systems draw
 * them: a recommended emoji (RGI, Unicode's list of emoji fonts support)
 * where the browser knows that property, else a pictograph shown as an
 * emoji: one with emoji presentation, or with a variation selector, skin
 * tone, joiner or keycap, or a flag. A text symbol on its own (©, ™, ✔
 * without U+FE0F) and unassigned code points are not emoji here. */
let RGI = null;
try { RGI = new RegExp("^\\p{RGI_Emoji}$", "v"); } catch { /* no v flag: fallback below */ }
const EMOJI_PARTS = /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200D\uFE0F\u20E3]+$/u;
const PRESENTED = /\p{Emoji_Presentation}|\uFE0F|\u20E3|\u200D|\p{Emoji_Modifier}|\p{Regional_Indicator}{2}|\u{E007F}/u;

export function isEmojiGrapheme(segment) {
  return RGI ? RGI.test(segment) : isEmojiGraphemeFallback(segment);
}

/** The fallback rule, exported for tests of browsers without the v flag. */
export function isEmojiGraphemeFallback(segment) {
  return EMOJI_PARTS.test(segment) && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(segment) && PRESENTED.test(segment);
}

let segmenter = null;
function graphemes(text) {
  segmenter ??= typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  if (segmenter) return [...segmenter.segment(text)].map((entry) => entry.segment);
  // Without Intl.Segmenter, code points: an emoji made of several (a skin
  // tone, a family) then counts as more than one, or as text.
  return [...text];
}

/** How many emoji a message is, when it is only emoji (whitespace aside):
 * 1–3 such messages render larger. 0 when it holds anything else; counting
 * stops past `limit`. */
export function emojiOnlyCount(text, limit = 3) {
  if (typeof text !== "string" || text.length > 200) return 0;
  let count = 0;
  for (const segment of graphemes(text)) {
    if (/^\s+$/u.test(segment)) continue;
    if (!isEmojiGrapheme(segment)) return 0;
    count += 1;
    if (count > limit) return count;
  }
  return count;
}

/** Checks the picker table's shape; returns it, or throws. */
export function validateEmojiTable(table) {
  const invalid = () => new Error("Kin couldn't read its emoji table.");
  if (table?.version !== 1 || !Array.isArray(table.categories) || !table.categories.length) throw invalid();
  for (const category of table.categories) {
    if (typeof category.id !== "string" || typeof category.label !== "string" || !Array.isArray(category.emoji) || !category.emoji.length) throw invalid();
    for (const entry of category.emoji)
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[1] !== "string" || !entry[1] || emojiOnlyCount(entry[0], 1) !== 1) throw invalid();
  }
  return table;
}

let loading = null;
/** The picker table, fetched once from the app (the offline shell caches it). */
export function loadEmojiTable({ fetch: fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  loading ??= fetchImpl(new URL("./emoji.json", import.meta.url))
    .then((response) => {
      if (!response.ok) throw new Error("Kin couldn't load its emoji.");
      return response.json();
    })
    .then(validateEmojiTable)
    .catch((error) => {
      loading = null;
      throw error;
    });
  return loading;
}
