import { safeUrl } from "../markdown/url-safety.js";
export const categories = [
  "Layout",
  "Badges",
  "Social",
  "Stats",
  "Projects",
  "Writing",
  "Activity",
  "Widgets",
  "Contact",
  "Fun",
  "Terminal",
  "GitHub",
  "Utilities",
];
export { escapeHTML } from "./escape.js";
import { escapeHTML } from "./escape.js";
import {
  normalizePreset,
  renderPreset,
} from "../component-instances/preset.js";
export function plain(value, max = 200) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[<>\x00-\x08\x0b-\x1f\x7f]/.test(value)
  )
    throw Error("Use bounded plain text for component metadata.");
  return value;
}
export function normalizeComponent(raw) {
  if (!raw || raw.version !== 1)
    throw Error("Unsupported component version. Expected version 1.");
  if (
    !["structured", "snippet", "widget", "layout", "custom"].includes(raw.kind)
  )
    throw Error("Unsupported component kind.");
  if (typeof raw.template !== "string" || raw.template.length > 1_000_000)
    throw Error("Component Markdown must be text under 1 MB.");
  if (!categories.includes(raw.category))
    throw Error("Choose a supported component category.");
  const name = plain(raw.name, 120).trim();
  if (!name) throw Error("Name your component.");
  if (
    !Array.isArray(raw.tags) ||
    raw.tags.length > 30 ||
    !Array.isArray(raw.fields) ||
    raw.fields.length > 30
  )
    throw Error("Invalid component tags or fields.");
  const keys = new Set();
  const fields = raw.fields.map((f) => {
    if (
      !/^[a-z][a-zA-Z0-9_]{0,39}$/.test(f.key) ||
      ["constructor", "prototype", "__proto__"].includes(f.key) ||
      keys.has(f.key)
    )
      throw Error("Invalid or duplicate field key.");
    keys.add(f.key);
    if (
      !["text", "textarea", "url"].includes(f.type) ||
      !["markdown", "html", "url"].includes(f.context)
    )
      throw Error("Unsupported component field type.");
    const label = plain(f.label, 100).trim();
    if (!label) throw Error("Name each component field.");
    return {
      key: f.key,
      label,
      type: f.type,
      context: f.context,
      default: plain(f.default ?? "", 10000),
    };
  });
  const attribution = raw.attribution
    ? {
        name: plain(raw.attribution.name, 120),
        url: safeUrl(raw.attribution.url),
      }
    : null;
  if (attribution && !/^https?:\/\//.test(attribution.url))
    throw Error("Attribution needs a safe public project URL.");
  if (attribution && !attribution.name.trim())
    throw Error("Name the attributed project.");
  const preset =
    raw.kind !== "custom" && raw.preset ? normalizePreset(raw.preset) : null;
  return {
    ...(preset ? { preset } : {}),
    version: 1,
    id:
      typeof raw.id === "string" && /^[a-z\d:-]{1,100}$/i.test(raw.id)
        ? raw.id
        : crypto.randomUUID(),
    name,
    category: raw.category,
    description: plain(raw.description ?? "", 1000),
    kind: raw.preset && !preset ? "custom" : raw.kind,
    template: raw.template,
    fields,
    tags: raw.tags.map((t) => plain(t, 60)),
    attribution,
    external: raw.external === true,
  };
}
export function componentSource(raw, values = {}) {
  const c = normalizeComponent(raw);
  if (c.preset && c.preset.type !== "fields") return renderPreset(c.preset);
  values = { ...(c.preset?.values || {}), ...values };
  if (c.kind === "custom" || !c.fields.length) return c.template;
  const fields = new Map(c.fields.map((f) => [f.key, f]));
  return c.template.replace(/\{\{([a-z][a-zA-Z0-9_]*)\}\}/g, (token, key) => {
    const f = fields.get(key);
    if (!f) return token;
    const value = String(Object.hasOwn(values, key) ? values[key] : f.default);
    if (value.length > 10000) throw Error(`${f.label} is too long.`);
    if (f.type === "url" || f.context === "url") {
      const url = safeUrl(value);
      if (value && !url) throw Error(`${f.label} needs a safe URL.`);
      return escapeHTML(url.replace(/[()\s]/g, (c) => encodeURIComponent(c)));
    }
    if (f.context === "html") return escapeHTML(value);
    return escapeHTML(value)
      .replace(/[\\`*_[\]#|]/g, "\\$&")
      .replace(/\r?\n/g, " ");
  });
}
export function searchComponents(
  items,
  {
    query = "",
    category = "",
    view = "all",
    favorites = [],
    recents = [],
  } = {},
) {
  const q = query.toLowerCase().trim(),
    words = q.split(/\s+/).filter(Boolean);
  return items
    .filter(
      (c) =>
        (!category || c.category === category) &&
        (view !== "favorites" || favorites.includes(c.id)) &&
        (view !== "recent" || recents.includes(c.id)) &&
        (view !== "saved" || !c.id.startsWith("builtin:")) &&
        words.every((w) =>
          `${c.name} ${c.description} ${c.tags.join(" ")}`
            .toLowerCase()
            .includes(w),
        ),
    )
    .sort((a, b) =>
      view === "recent"
        ? recents.indexOf(a.id) - recents.indexOf(b.id)
        : Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)) ||
          Number(b.name.toLowerCase() === q) -
            Number(a.name.toLowerCase() === q) ||
          Number(b.name.toLowerCase().startsWith(q)) -
            Number(a.name.toLowerCase().startsWith(q)) ||
          a.name.localeCompare(b.name),
    );
}
