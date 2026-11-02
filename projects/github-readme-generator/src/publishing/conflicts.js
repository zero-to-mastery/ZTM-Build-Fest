import { detectSections } from "../markdown/sections.js";
const key = (s) => `${s.level}:${s.title}`;
function resolve(base, local, remote, title) {
  if (local === remote) return { title, content: local };
  if (local === base) return { title, content: remote };
  if (remote === base) return { title, content: local };
  return { title, base, local, remote, conflict: true };
}
export function mergeThreeWay(base, local, remote) {
  const sections = [base, local, remote].map((s) => detectSections(s));
  const keys = sections.map((ss) => ss.map(key));
  // Rename/reorder/add/delete and duplicate headings are deliberately conservative.
  // Never align ambiguous sections by approximate matching.
  if (
    new Set(keys[0]).size !== keys[0].length ||
    keys.some((k) => JSON.stringify(k) !== JSON.stringify(keys[0]))
  )
    return [
      resolve(base, local, remote, "Entire README (section structure changed)"),
    ];
  return sections[0].map((s, i) =>
    resolve(s.source, sections[1][i].source, sections[2][i].source, s.title),
  );
}
export function resolveMerge(parts, decisions) {
  return parts
    .map((part, i) => {
      if (!part.conflict) return part.content;
      const decision = decisions[i];
      if (decision?.choice === "local") return part.local;
      if (decision?.choice === "remote") return part.remote;
      if (decision?.choice === "combine")
        return part.local + "\n\n" + part.remote;
      if (decision?.choice === "manual" && typeof decision.content === "string")
        return decision.content;
      throw new Error(
        "Resolve every conflict explicitly before reviewing the merged README.",
      );
    })
    .join("");
}
