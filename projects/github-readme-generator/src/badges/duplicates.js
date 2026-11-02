export const previewWidths = { desktop: 900, narrow: 640, mobile: 320 };
export function badgeIdentity(raw) {
  try {
    const u = new URL(raw.replace(/&amp;/g, "&"));
    if (
      u.hostname !== "img.shields.io" &&
      !/\/badge(?:s)?[/.]/i.test(u.pathname)
    )
      return null;
    u.hash = "";
    u.searchParams.sort();
    const url = u.href;
    const logo = u.searchParams.get("logo")?.toLowerCase();
    const path = decodeURIComponent(u.pathname).toLowerCase();
    const dynamic = path.match(
      /^\/github\/(stars|forks|issues|license|v\/release|actions\/workflow\/status)\/(.+)/,
    );
    const semantic = dynamic
      ? `${dynamic[1]}:${dynamic[2]}`
      : path.startsWith("/badge/")
        ? logo
          ? `technology:${logo}`
          : path.replace(/-[^-]+$/, "")
        : path;
    return {
      url,
      semantic,
      technology: path.startsWith("/badge/") ? logo : "",
      build: /actions\/workflow|\/netlify\//.test(path),
      stat:
        dynamic && ["stars", "forks", "issues"].includes(dynamic[1])
          ? dynamic[1]
          : "",
    };
  } catch {
    return null;
  }
}
export function badgeWarnings(images) {
  const issues = [],
    urls = new Set(),
    semantics = new Set(),
    tech = new Set(),
    stats = new Map(),
    sections = new Map();
  let builds = 0;
  const messages = new Set();
  const add = (category, message) => {
    if (!messages.has(message) && issues.length < 100) {
      messages.add(message);
      issues.push({ category, message });
    }
  };
  for (const image of images) {
    const id = badgeIdentity(image.url);
    if (!id) continue;
    const where = image.section ? ` in “${image.section.slice(0, 80)}”` : "";
    const alt = String(image.alt || "").trim();
    if (!alt || /^(?:badge|image|logo|status)$/i.test(alt))
      add(
        "Badge accessibility",
        `Use meaningful badge alt text${where}; screen readers need its purpose or technology.`,
      );
    if (image.nearby && image.nearby.trim().toLowerCase() === alt.toLowerCase())
      add(
        "Badge accessibility",
        `Badge alt text repeats nearby text${where}; avoid redundant announcements.`,
      );
    if (urls.has(id.url))
      add(
        "Badge duplicates",
        `Repeated badge URL${where}; consider keeping one copy.`,
      );
    else if (semantics.has(id.semantic))
      add(
        "Badge duplicates",
        `Semantically similar badges${where}; different styling may repeat the same information.`,
      );
    if (id.technology && tech.has(id.technology))
      add(
        "Badge duplicates",
        `Repeated technology (${id.technology})${where}; consider one badge per technology.`,
      );
    urls.add(id.url);
    semantics.add(id.semantic);
    if (id.technology) tech.add(id.technology);
    if (id.stat) stats.set(id.stat, (stats.get(id.stat) || 0) + 1);
    if (id.build) builds++;
    const section = image.section || "README";
    sections.set(section, (sections.get(section) || 0) + 1);
  }
  for (const [section, count] of sections)
    if (count > 20)
      add(
        "Badge clutter",
        `${count} badges in “${section.slice(0, 80)}”; consider smaller categories so important content stays visible.`,
      );
  if ([...stats.values()].some((n) => n > 1))
    add(
      "Badge clutter",
      "Multiple GitHub statistic badges repeat a metric; consider keeping only useful comparisons.",
    );
  if (builds > 1)
    add(
      "Badge clutter",
      "Multiple build/deployment badges may repeat status; keep distinct workflows clearly labeled.",
    );
  return issues;
}
