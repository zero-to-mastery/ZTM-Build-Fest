import { instanceBlock } from "../component-instances/ownership.js";
import { createBlock } from "../markdown/serialize.js";
export function insertion(
  draft,
  markdown,
  { position = "append", blockId, cursor = 0, instance } = {},
) {
  if (position === "cursor") {
    const at = Math.max(
      0,
      Math.min(Number(cursor) || 0, draft.markdown.length),
    );
    return {
      markdown:
        draft.markdown.slice(0, at) +
        "\n\n" +
        markdown +
        "\n\n" +
        draft.markdown.slice(at),
    };
  }
  const blocks = structuredClone(draft.blocks),
    block = instance
      ? instanceBlock(instance)
      : createBlock("custom", { markdown });
  if (position === "append") blocks.push(block);
  else {
    const index = blocks.findIndex((b) => b.id === blockId);
    if (index < 0 || !["before", "after"].includes(position))
      throw Error("Select an existing insertion section.");
    blocks.splice(index + (position === "after" ? 1 : 0), 0, block);
  }
  return { blocks };
}
