import { normalizeComponent } from "./model.js";
export const emptyComponents = () => ({
  version: 1,
  snippets: [],
  favorites: [],
  recents: [],
});
export function validateComponents(value) {
  if (value === undefined) return emptyComponents();
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.snippets) ||
    value.snippets.length > 500
  )
    throw Error(
      "Unsupported component library or more than 500 saved components.",
    );
  const result = emptyComponents(),
    ids = new Set(),
    names = new Set();
  for (const raw of value.snippets) {
    const c = normalizeComponent(raw);
    if (c.id.startsWith("builtin:") || ids.has(c.id))
      c.id = crypto.randomUUID();
    ids.add(c.id);
    const base = c.name;
    let n = 2;
    while (names.has(c.name.toLowerCase()))
      c.name = `${base.slice(0, 108)} (${n++})`;
    names.add(c.name.toLowerCase());
    result.snippets.push(c);
  }
  for (const key of ["favorites", "recents"]) {
    if (
      !Array.isArray(value[key]) ||
      value[key].some((v) => typeof v !== "string" || v.length > 100)
    )
      throw Error("Invalid component preferences.");
    result[key] = [...new Set(value[key])].slice(
      0,
      key === "recents" ? 30 : 1000,
    );
  }
  return result;
}
export function mergeComponents(a, b) {
  a = validateComponents(a);
  b = validateComponents(b);
  return validateComponents({
    version: 1,
    snippets: [...a.snippets, ...b.snippets],
    favorites: [...a.favorites, ...b.favorites],
    recents: [...b.recents, ...a.recents],
  });
}
export function recoverComponents(value) {
  const result = emptyComponents();
  if (value?.version !== 1) return result;
  for (const raw of (Array.isArray(value.snippets) ? value.snippets : []).slice(
    0,
    500,
  )) {
    try {
      result.snippets.push(normalizeComponent(raw));
    } catch {
      /* Keep original recovery bytes. */
    }
  }
  return validateComponents(result);
}
export function favoriteComponent(library, id) {
  const next = validateComponents(library);
  next.favorites = next.favorites.includes(id)
    ? next.favorites.filter((v) => v !== id)
    : [...next.favorites, id];
  return next;
}
export function usedComponent(library, id) {
  const next = validateComponents(library);
  next.recents = [id, ...next.recents.filter((v) => v !== id)].slice(0, 30);
  return next;
}
