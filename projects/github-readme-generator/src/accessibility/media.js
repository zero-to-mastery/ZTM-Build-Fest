const genericAlt =
  /^(?:(?:profile|repository|github|readme)\s+)?(?:image|banner|header|logo|picture|photo|graphic|screenshot)(?:\s+(?:image|banner|header))?(?:\s+of)?$/i;

export function altTextQuality(value) {
  const alt = typeof value === "string" ? value.trim() : "";
  if (!alt) return "missing";
  return genericAlt.test(alt) ? "generic" : "descriptive";
}
