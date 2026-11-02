import { normalizeEmbed, embedMarkdown, typingURL } from "../widgets/embed.js";
import { widgetRegistry } from "../widgets/registry.js";
import {
  validateCollection,
  collectionMarkdown,
} from "../badges/collections.js";
export function fieldValues(raw = {}) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).length > 30
  )
    throw Error("Invalid component field values.");
  const result = {};
  for (const [k, v] of Object.entries(raw)) {
    if (
      !/^[a-z][a-zA-Z0-9_]{0,39}$/.test(k) ||
      ["constructor", "prototype", "__proto__"].includes(k) ||
      typeof v !== "string" ||
      v.length > 10000
    )
      throw Error("Invalid component field value.");
    result[k] = v;
  }
  return result;
}
export function normalizePreset(raw) {
  if (
    !raw ||
    raw.version !== 1 ||
    !["widget", "badges", "fields"].includes(raw.type)
  )
    return null;
  if (raw.type === "fields")
    return { version: 1, type: "fields", values: fieldValues(raw.values) };
  if (raw.type === "badges")
    return {
      version: 1,
      type: "badges",
      collection: validateCollection(raw.collection, { preserveId: true }),
    };
  if (
    raw.provider !== "generic" &&
    !widgetRegistry.some((w) => w.id === raw.provider)
  )
    return null;
  const preset = {
    version: 1,
    type: "widget",
    provider: raw.provider,
    embed: normalizeEmbed(raw.embed),
    credit: raw.credit === true,
  };
  if (raw.provider === "typing" && raw.typing) {
    typingURL(raw.typing);
    preset.typing = {
      lines: String(raw.typing.lines),
      font: String(raw.typing.font || "monospace"),
      size: String(raw.typing.size ?? 20),
      duration: String(raw.typing.duration ?? 5000),
      color: String(raw.typing.color || "36BCF7"),
      center: raw.typing.center === true,
    };
  }
  return preset;
}
export function renderPreset(raw) {
  const p = normalizePreset(raw);
  if (!p) throw Error("Unsupported component preset; keep its raw Markdown.");
  if (p.type === "badges") return collectionMarkdown(p.collection);
  if (p.type === "fields")
    throw Error("Field values need a component template.");
  const w = widgetRegistry.find((w) => w.id === p.provider);
  return (
    embedMarkdown(p.embed) +
    (p.credit && w ? `\n\n[Built with ${w.name}](${w.projectUrl})` : "")
  );
}
