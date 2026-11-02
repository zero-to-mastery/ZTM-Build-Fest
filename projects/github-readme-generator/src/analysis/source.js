import { marked } from "marked";
let cached;
export function parseSource(source) {
  if (cached?.source === source) return cached;
  const map = new Uint32Array(source.length + 1),
    chars = [];
  let n = 0;
  for (let i = 0; i < source.length; i++) {
    map[n++] = i;
    if (source[i] === "\r") {
      chars.push("\n");
      if (source[i + 1] === "\n") i++;
    } else chars.push(source[i]);
  }
  map[n] = source.length;
  const normalized = chars.join(""),
    tokens = marked.lexer(normalized),
    nodes = [],
    lines = [0];
  for (let i = 0; i < source.length; i++)
    if (source[i] === "\n" || (source[i] === "\r" && source[i + 1] !== "\n"))
      lines.push(i + 1);
  const range = (start, end, approximate = false) => {
    const offset = map[Math.min(start, n)],
      finish = map[Math.min(end, n)];
    let lo = 0,
      hi = lines.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid] <= offset) lo = mid;
      else hi = mid;
    }
    return {
      start: offset,
      end: finish,
      line: lo + 1,
      column: offset - lines[lo] + 1,
      approximate,
    };
  };
  const stack = [
    { tokens, index: 0, cursor: 0, end: normalized.length, approximate: false },
  ];
  while (stack.length) {
    const f = stack.at(-1);
    if (f.index >= f.tokens.length) {
      stack.pop();
      continue;
    }
    const t = f.tokens[f.index++];
    let start =
      typeof t.raw === "string" ? normalized.indexOf(t.raw, f.cursor) : -1;
    const approx =
      f.approximate || start < 0 || start + (t.raw?.length || 0) > f.end;
    if (approx) start = f.cursor;
    const end = Math.min(f.end, start + (t.raw?.length || t.text?.length || 0));
    nodes.push({
      token: t,
      start,
      end,
      sourceRange: range(start, end, approx),
    });
    f.cursor = end;
    let children = t.tokens;
    if (t.type === "list") children = t.items;
    if (t.type === "table")
      children = [...t.header, ...t.rows.flat()].flatMap((c) => c.tokens || []);
    if (children?.length)
      stack.push({
        tokens: children,
        index: 0,
        cursor: start,
        end,
        approximate: approx,
      });
  }
  cached = { source, normalized, tokens, nodes, range };
  return cached;
}
export function attributes(raw) {
  const out = Object.create(null);
  for (const m of raw.matchAll(
    /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
  ))
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}
