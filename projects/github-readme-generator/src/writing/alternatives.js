export const variants = Object.freeze({
  concise: [
    "Concise",
    "Use compact sentences and prioritize essential information; avoid repetition.",
  ],
  technical: [
    "Technical",
    "Use precise technical terminology and explain relationships supported by the supplied facts.",
  ],
  friendly: [
    "Friendly",
    "Use warm, approachable language and clear explanations, without hype or invented claims.",
  ],
});
export function variantInstruction(id = "") {
  if (!id) return "";
  if (!Object.hasOwn(variants, id))
    throw Error("Choose a supported alternative style.");
  return ` Alternative style: ${variants[id][0]}. ${variants[id][1]}`;
}
export function duplicateAlternatives(items) {
  const seen = new Set();
  return items.some((item) => {
    if (item.status !== "ready") return false;
    const text = item.text.trim();
    if (seen.has(text)) return true;
    seen.add(text);
    return false;
  });
}
// Sequential requests; stop on failure/cancellation, preserving completed work.
export async function generateAlternatives(
  config,
  input,
  { generate, signal, onResult = () => {} },
) {
  const items = Object.entries(variants).map(([id, [label]]) => ({
    id,
    label,
    status: "pending",
    text: "",
  }));
  for (const item of items) {
    if (signal?.aborted) break;
    try {
      const text = await generate(
        config,
        { ...input, variant: item.id },
        { signal },
      );
      if (signal?.aborted) break;
      Object.assign(item, { status: "ready", text });
      onResult(structuredClone(items));
    } catch (error) {
      if (!signal?.aborted) {
        Object.assign(item, { status: "failed", error: error.message });
        onResult(structuredClone(items));
      }
      break;
    }
  }
  for (const item of items)
    if (item.status === "pending") item.status = "not generated";
  return items;
}
