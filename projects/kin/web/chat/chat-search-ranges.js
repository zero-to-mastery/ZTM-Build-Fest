// Match ranges from the engine's chat search (#124) are UTF-8 byte offsets
// into a message's text. Showing them needs string indexes: this converts,
// and builds text nodes and <mark> elements, never HTML.

/**
 * Converts byte ranges of the whole text to [start, end) string indexes in
 * `excerpt`, which starts `excerptOffset` bytes into the text. Ranges
 * outside the excerpt are dropped; one that runs past its end is cut.
 */
export function excerptRanges(excerpt, excerptOffset, ranges) {
  const out = [];
  // Cumulative byte offset at each string index we visit, walking once.
  let index = 0;
  let bytes = 0;
  const at = (target) => {
    while (index < excerpt.length && bytes < target) {
      const code = excerpt.codePointAt(index);
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      index += code > 0xffff ? 2 : 1;
    }
    return bytes === target ? index : null;
  };
  for (const [start, end] of [...ranges].sort((left, right) => left[0] - right[0])) {
    const from = start - excerptOffset;
    if (from < 0) continue;
    const first = at(from);
    if (first === null) continue;
    const last = at(end - excerptOffset);
    out.push([first, last === null ? excerpt.length : last]);
  }
  return out.filter(([from, to]) => to > from);
}

/** `text` as text nodes and <mark> elements around the string `ranges`. */
export function markedNodes(text, ranges) {
  const nodes = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor || end > text.length) continue;
    if (start > cursor) nodes.push(document.createTextNode(text.slice(cursor, start)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(start, end);
    nodes.push(mark);
    cursor = end;
  }
  if (cursor < text.length || !nodes.length) nodes.push(document.createTextNode(text.slice(cursor)));
  return nodes;
}

/**
 * Highlights `ranges` (string indexes) in the text node of `element`
 * through the CSS Custom Highlight API: no markup is touched. Returns a
 * function that removes the highlight. A browser without the API gets no
 * highlight (the row is still scrolled to and marked).
 */
export function highlightRanges(element, ranges, name = "chat-search") {
  const registry = globalThis.CSS?.highlights;
  const Highlight = globalThis.Highlight;
  if (!registry || !Highlight) return () => {};
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const spans = [];
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    spans.push({ node, from: offset, to: offset + node.length });
    offset += node.length;
  }
  const found = [];
  for (const [start, end] of ranges) {
    const first = spans.find((span) => start >= span.from && start < span.to);
    const last = spans.find((span) => end > span.from && end <= span.to);
    if (!first || !last) continue;
    const range = document.createRange();
    range.setStart(first.node, start - first.from);
    range.setEnd(last.node, end - last.from);
    found.push(range);
  }
  if (!found.length) return () => {};
  const highlight = new Highlight(...found);
  registry.set(name, highlight);
  return () => {
    if (registry.get(name) === highlight) registry.delete(name);
  };
}
