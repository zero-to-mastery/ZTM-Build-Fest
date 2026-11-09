import { serializeBlock } from "./serialize.js";
export const contextForBlock = (block, metadata = {}) =>
  Object.hasOwn(block, "sourceContext")
    ? block.sourceContext
    : metadata.importSource || null;
export const contextKey = (c) =>
  c
    ? JSON.stringify([c.type, c.owner, c.repository, c.ref, c.readmePath])
    : "null";
export function documentSegments(draft) {
  let start = 0;
  return draft.blocks.map((block, index) => {
    const separator = index ? (block.separator ?? "\n\n") : "";
    const source = separator + serializeBlock(block);
    const entry = {
      source,
      start,
      // Where the Block's own text begins, after its Seam.
      contentStart: start + separator.length,
      end: start + source.length,
      sourceContext: contextForBlock(block, draft.metadata),
    };
    start = entry.end;
    return entry;
  });
}
export function uniformContext(draft) {
  const contexts = documentSegments(draft).map((s) => s.sourceContext);
  return contexts.every((c) => contextKey(c) === contextKey(contexts[0]))
    ? contexts[0] || null
    : { type: "mixed" };
}
