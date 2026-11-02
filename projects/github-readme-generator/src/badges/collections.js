import { buildLinkedBadge, buildPictureBadge } from "./shields.js";
import { logos, technologyBadge } from "./badge-model.js";
export const collectionStyles = ["plain", "centered", "pictures", "category"];
const escape = (s) =>
  String(s)
    .replace(/[\\`*_[\]<>#]/g, "\\$&")
    .replace(/[\r\n]/g, " ");
export function validateBadge(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Each badge must be an object.");
  const badge = {};
  for (const k of [
    "name",
    "label",
    "message",
    "logo",
    "logoColor",
    "labelColor",
    "color",
    "style",
    "link",
    "alt",
    "darkColor",
    "darkLogoColor",
    "lightUrl",
    "darkUrl",
    "category",
    "cacheSeconds",
  ]) {
    if (value[k] === undefined) continue;
    if (typeof value[k] !== "string" || value[k].length > 4096)
      throw new Error(`Invalid badge field: ${k}.`);
    badge[k] = value[k];
  }
  if (!badge.label && !badge.name && !badge.lightUrl)
    throw new Error("A badge needs a name, label, or image URL.");
  if (value._theme && typeof value._theme === "object") {
    const keys = [
      "style",
      "color",
      "darkColor",
      "labelColor",
      "logoColor",
      "darkLogoColor",
    ];
    badge._theme = {
      derived: Object.fromEntries(
        keys
          .filter((k) => typeof value._theme.derived?.[k] === "string")
          .map((k) => [k, value._theme.derived[k]]),
      ),
      overrides: keys.filter((k) => value._theme.overrides?.includes(k)),
    };
  }
  buildLinkedBadge(badge);
  return badge;
}
export function validateCollection(value, { preserveId = false } = {}) {
  if (value?.version !== 1 || value.type !== "badge-collection")
    throw new Error("Unsupported badge collection. Expected version 1.");
  if (
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 120
  )
    throw new Error("Use a collection name between 1 and 120 characters.");
  if (!Array.isArray(value.badges) || value.badges.length > 1000)
    throw new Error("A collection supports up to 1,000 badges.");
  return {
    version: 1,
    type: "badge-collection",
    id:
      preserveId &&
      typeof value.id === "string" &&
      /^[a-z\d-]{1,80}$/i.test(value.id)
        ? value.id
        : crypto.randomUUID(),
    name: value.name.trim(),
    style: collectionStyles.includes(value.style) ? value.style : "plain",
    badges: value.badges.map(validateBadge),
  };
}
export function validateCollections(value = { version: 1, items: [] }) {
  if (
    value?.version !== 1 ||
    !Array.isArray(value.items) ||
    value.items.length > 500
  )
    throw new Error(
      "Invalid saved badge collections (expected version 1, up to 500 collections).",
    );
  const items = [];
  for (const entry of value.items) {
    const c = validateCollection(entry, { preserveId: true });
    if (items.some((i) => i.id === c.id)) c.id = crypto.randomUUID();
    c.name = collectionName(c.name, items);
    items.push(c);
  }
  return { version: 1, items };
}
export function collectionName(name, items) {
  let next = name,
    n = 2;
  while (items.some((i) => i.name === next))
    next = `${name.slice(0, 110)} (${n++})`;
  return next;
}
export function collectionMarkdown(c) {
  if (c.style === "category")
    return `## ${escape(c.name)}\n\n${c.badges.map((b) => buildLinkedBadge(b)).join(" ")}`;
  return `<p${c.style === "centered" ? ' align="center"' : ""}>\n${c.badges.map((b) => (c.style === "pictures" ? buildPictureBadge(b) : buildLinkedBadge(b, "html"))).join("\n")}\n</p>`;
}
export function searchCollections(items, query) {
  const q = query.trim().toLowerCase();
  return items.filter((c) =>
    [
      c.name,
      ...c.badges.flatMap((b) => [
        b.name,
        b.label,
        b.logo,
        ...(logos.find((t) => t.shieldsLogo === b.logo)?.aliases || []),
      ]),
    ].some((v) =>
      String(v || "")
        .toLowerCase()
        .includes(q),
    ),
  );
}
export const starterNames = [
  "Frontend",
  "Backend",
  "Testing",
  "DevOps",
  "Databases",
  "Cloud",
  "Social",
  "Deployment",
  "Currently Learning",
];
export function starterCollection(name) {
  let entries = logos.filter((t) => t.category === name).slice(0, 6);
  if (name === "Currently Learning")
    entries = logos.filter((t) => ["rust", "wasm"].includes(t.id));
  if (name === "Deployment")
    entries = logos.filter((t) =>
      ["netlify", "vercel", "docker"].includes(t.id),
    );
  const badges =
    name === "Social"
      ? [
          {
            label: "GitHub",
            logo: "github",
            color: "181717",
            alt: "GitHub profile",
            style: "flat",
          },
        ]
      : entries.map(technologyBadge);
  return validateCollection({
    version: 1,
    type: "badge-collection",
    name,
    style: "category",
    badges,
  });
}

export function recoverCollections(data) {
  const recovered = [];
  if (data?.version !== 1 || !Array.isArray(data.items))
    return { version: 1, items: [] };
  for (const entry of data.items.slice(0, 500)) {
    try {
      recovered.push(validateCollection(entry, { preserveId: true }));
    } catch {
      if (!entry || !Array.isArray(entry.badges)) continue;
      const badges = [];
      for (const b of entry.badges.slice(0, 1000)) {
        try {
          badges.push(validateBadge(b));
        } catch {
          /* Original JSON remains available in recovery export. */
        }
      }
      if (badges.length)
        recovered.push(
          validateCollection({
            version: 1,
            type: "badge-collection",
            name:
              typeof entry.name === "string"
                ? entry.name.slice(0, 110) || "Recovered collection"
                : "Recovered collection",
            badges,
          }),
        );
    }
  }
  return validateCollections({ version: 1, items: recovered });
}
