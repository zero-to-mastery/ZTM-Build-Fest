// Linear-size source review: common edges are retained; the changed middle is explicit.
// Avoid quadratic LCS memory on large READMEs.
export function publishDiff(before, after) {
  const a = before.split("\n"),
    b = after.split("\n");
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  const removed = a.slice(start, a.length - end),
    added = b.slice(start, b.length - end);
  const sections = [
    ...new Set([...removed, ...added].filter((l) => /^#{1,6}\s/.test(l))),
  ];
  return {
    added: added.length,
    removed: removed.length,
    sections,
    text:
      before === after
        ? "No source changes."
        : `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@\n${removed.map((l) => "-" + l).join("\n")}\n${added.map((l) => "+" + l).join("\n")}`,
  };
}
