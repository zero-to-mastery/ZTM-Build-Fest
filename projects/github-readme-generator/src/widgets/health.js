export function widgetIdentity(url = "") {
  return /(?:readme-typing-svg|github-readme-stats|streak-stats|streak-stats\.demolab|github-readme-activity-graph|(?:^|[/_.-])(?:constellation|metrics|snake)(?:[/_.?-]|$))/i.test(
    url,
  );
}
export function widgetHealth(images = []) {
  const issues = [],
    seen = new Set(),
    groups = new Map();
  for (const image of images) {
    if (!widgetIdentity(image.url)) continue;
    const section = image.section || "README";
    if (seen.has(image.url))
      issues.push({
        category: "Widgets",
        message: `Repeated widget in “${section.slice(0, 80)}”; duplicate images add noise.`,
      });
    seen.add(image.url);
    if (!image.alt?.trim())
      issues.push({
        category: "Widget accessibility",
        message: `Widget in “${section.slice(0, 80)}” needs descriptive alt text so its purpose is accessible.`,
      });
    const group = groups.get(section) || [];
    group.push(image);
    groups.set(section, group);
  }
  for (const [section, group] of groups) {
    if (group.length > 3)
      issues.push({
        category: "Widget layout",
        message: `${group.length} widgets in “${section.slice(0, 80)}”; separate large widget runs with useful context.`,
      });
    const widths = group.map((i) => Number(i.width)).filter(Boolean);
    if (widths.length > 1 && Math.max(...widths) > Math.min(...widths) * 2)
      issues.push({
        category: "Widget layout",
        message: `Mixed widget widths in “${section.slice(0, 80)}”; inspect mobile alignment and wrapping.`,
      });
  }
  return issues.slice(0, 100);
}
