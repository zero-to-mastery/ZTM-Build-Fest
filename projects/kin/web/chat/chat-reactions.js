// Emoji reactions in the chat UI (#127): the quick set, accessible names, and
// the summary a message's chips show. The engine (kin_chat_page) owns the
// rules: one emoji each, last write wins, and a deleted message shows none.

/** The six quick reactions, with the names their chips and buttons carry. */
export const QUICK_REACTIONS = Object.freeze([
  ["👍", "Thumbs up"],
  ["❤️", "Red heart"],
  ["😂", "Face with tears of joy"],
  ["😮", "Face with open mouth"],
  ["😢", "Crying face"],
  ["🙏", "Folded hands"],
]);

/** A name for each emoji the picker table knows (the quick set always). */
export function reactionNames(table = null) {
  const names = new Map(QUICK_REACTIONS);
  for (const category of table?.categories ?? [])
    for (const [emoji, name] of category.emoji)
      if (!names.has(emoji)) names.set(emoji, name.charAt(0).toUpperCase() + name.slice(1));
  return names;
}

/** "Thumbs up, 2 people, including you". */
export function reactionLabel(name, count, mine) {
  return `${name}, ${count} ${count === 1 ? "person" : "people"}${mine ? ", including you" : ""}`;
}

/**
 * The chips of one message: for each emoji, how many, whether `memberId` is
 * among them, the accessible name and the names of who reacted ("You" first).
 */
export function reactionChips(reactions, memberId, { names = null, labelOf = (id) => id } = {}) {
  return (reactions ?? []).map(({ emoji, actors }) => {
    const mine = actors.includes(memberId);
    const who = [...(mine ? ["You"] : []), ...actors.filter((actor) => actor !== memberId).map(labelOf)];
    // A heart typed without its variation selector still has its name.
    const name = names?.get(emoji) ?? names?.get(`${emoji}\uFE0F`) ?? emoji;
    return { emoji, name, count: actors.length, mine, who, label: reactionLabel(name, actors.length, mine) };
  });
}
