export function documentStats(markdown) {
  return {
    lines: markdown.split(/\r\n|\r|\n/).length,
    words: wordCount(markdown),
    characters: markdown.length,
    bytes: new TextEncoder().encode(markdown).length,
  };
}
export function wordCount(markdown) {
  return markdown.trim() ? markdown.trim().split(/\s+/u).length : 0;
}
export function coreHeadings(headings) {
  return headings.map((h) => ({
    level: h.level,
    start: h.sourceRange.start,
    end: h.sourceRange.end,
  }));
}
export function analyzeCore(
  markdown,
  headings,
  stats = documentStats(markdown),
) {
  const starts = [{ start: 0, end: 0 }, ...headings];
  let previous = 0;
  return {
    stats,
    sections: starts.map((h, i) => ({
      start: h.start,
      bodyStart: h.end,
      end: starts[i + 1]?.start ?? markdown.length,
    })),
    headingSkips: headings.flatMap((h, index) => {
      const out =
        previous && h.level > previous + 1
          ? [{ index, previous, level: h.level }]
          : [];
      previous = h.level;
      return out;
    }),
  };
}
export const jsCore = { engine: "JavaScript", analyze: analyzeCore };
