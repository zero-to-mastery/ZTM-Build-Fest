import { validateBadge } from "../badges/collections.js";
export const projectTypes = [
  "Full-Stack Application",
  "CLI Tool",
  "Library",
  "Game",
  "PWA",
  "Open Source",
  "Team Project",
  "API",
  "Developer Tool",
];
export const roles = [
  "Solo Developer",
  "Frontend Developer",
  "Backend Developer",
  "Project Lead",
  "Testing Lead",
  "Contributor",
];
export const statuses = [
  "Active",
  "Maintained",
  "Experimental",
  "Archived",
  "In Development",
  "Completed",
];
const str = (v, fallback = "") => (typeof v === "string" ? v : fallback);
export function normalizeProject(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Invalid project entry. Original Markdown remains available.",
    );
  const p = { schemaVersion: 1, id: str(value.id) || crypto.randomUUID() };
  for (const key of [
    "name",
    "subtitle",
    "description",
    "role",
    "projectType",
    "status",
    "imageAlt",
    "imageLink",
    "imageWidth",
    "problem",
    "architecture",
    "challenges",
    "testing",
    "outcome",
    "darkImageUrl",
  ])
    p[key] = str(value[key]);
  p.emoji = str(value.emoji, value.icon);
  p.repositoryUrl = str(value.repositoryUrl, value.github);
  p.liveUrl = str(value.liveUrl, value.demo);
  p.caseStudyUrl = str(value.caseStudyUrl);
  p.imageUrl = str(value.imageUrl, value.image);
  p.imageAlign = value.imageAlign === "center" ? "center" : "left";
  p.statusStyle = ["text", "badge", "hidden"].includes(value.statusStyle)
    ? value.statusStyle
    : "text";
  p.technologyStyle = ["chips", "badges", "text"].includes(
    value.technologyStyle,
  )
    ? value.technologyStyle
    : "chips";
  p.layout = str(value.layout, "detailed");
  p.imagePlacement = str(value.imagePlacement, "below-title");
  p.highlights = Array.isArray(value.highlights)
    ? value.highlights.map((h) =>
        typeof h === "string"
          ? { title: "", description: h }
          : { title: str(h?.title), description: str(h?.description) },
      )
    : str(value.highlights)
        .split(/\r?\n/)
        .filter(Boolean)
        .map((description) => ({ title: "", description }));
  const technologies = Array.isArray(value.technologies)
    ? value.technologies
    : str(value.stack)
        .split(/[,·|]/)
        .map((s) => s.trim())
        .filter(Boolean);
  p.technologies = technologies.map((t) =>
    typeof t === "string"
      ? { name: t }
      : {
          name: str(t?.name),
          logo: str(t?.logo || t?.shieldsLogo),
          brandColor: str(t?.brandColor),
          id: str(t?.id),
        },
  );
  p.links = (Array.isArray(value.links) ? value.links : []).map((l) => ({
    name: str(l?.name),
    url: str(l?.url),
  }));
  if (value.url && !p.links.some((l) => l.url === value.url))
    p.links.unshift({ name: "Project", url: str(value.url) });
  p.badges = (Array.isArray(value.badges) ? value.badges : []).map(
    validateBadge,
  );
  p.metadata =
    value.metadata &&
    typeof value.metadata === "object" &&
    !Array.isArray(value.metadata)
      ? structuredClone(value.metadata)
      : {};
  p.legacyStatusMarkdown = str(value.legacyStatusMarkdown);
  if (value.schemaVersion !== 1 && value.status) {
    p.legacyStatusMarkdown = str(value.status);
    p.status = "";
  }
  return p;
}
export function normalizeShowcase(settings = {}) {
  if (!Array.isArray(settings.items))
    throw new Error(
      "Project entries could not be read. Keep the original Markdown.",
    );
  const ids = new Set();
  const items = settings.items.map((value) => {
    const p = normalizeProject(value);
    if (ids.has(p.id)) p.id = crypto.randomUUID();
    ids.add(p.id);
    return p;
  });
  return {
    version: 1,
    title: str(settings.title, "Selected Projects"),
    layout: str(settings.layout, "detailed"),
    items,
    ...(settings.presentation
      ? { presentation: structuredClone(settings.presentation) }
      : {}),
  };
}
