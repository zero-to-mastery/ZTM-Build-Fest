import { parseConfig, CONFIG_VERSION } from "./config-schema.mjs";
import { presetOptions } from "./studio-presets.mjs";
import { randomizeDesign } from "./design-randomizer.mjs";

export const MAX_SHARE_LENGTH = 8000;
export const PUBLIC_STUDIO_URL = "https://mnichols08.github.io/constellation/";
export const shareParameters = {
  accountType: "string",
  organizationUser: "string",
  organizationScope: "string",
  organizationView: "string",
  theme: "string",
  visualTheme: "string",
  arrangement: "string",
  accountSun: "string",
  ringMeaning: 'string',
  semanticLegend: 'boolean',
  profileEmphasis: "string",
  layout: "string",
  nodeMode: "string",
  nodeSize: "string",
  nodeColorMode: "string",
  maxRepos: "number",
  minStars: "number",
  sortBy: "string",
  repoQuery: "string",
  repoSource: "string",
  nodeCap: "number",
  simplifyAbove: "number",
  seed: "string",
  seedMode: "string",
  animate: "boolean",
  includeForks: "boolean",
  includeArchived: "boolean",
  codingRhythm: "boolean",
  codingRhythmTimezone: "string",
  historicalYear: "number",
};

export function publicShareBase(base) {
  const url = new URL(base);
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.protocol === "file:"
    ? PUBLIC_STUDIO_URL
    : url.href;
}

export function encodeShare(base, account, options) {
  const payload = parseConfig({ version: CONFIG_VERSION, account, options });
  // The studio's generated CSS is redundant with visualStyle and customCSS.
  if (payload.options.visualStyle && payload.options.customCSS !== undefined)
    delete payload.options.css;
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const encoded = btoa(
    Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const url = new URL(base);
  url.search = "";
  url.hash = "";
  url.searchParams.set("user", payload.account);
  url.searchParams.set("view", encoded);
  // Useful settings stay editable without decoding the complete configuration.
  for (const key of [
    "accountType",
    "organizationUser",
    "arrangement",
    "layout",
    "maxRepos",
    "animate",
  ]) {
    if (payload.options[key] !== undefined)
      url.searchParams.set(key, String(payload.options[key]));
  }
  if (url.href.length > MAX_SHARE_LENGTH)
    throw new Error(
      "This view is too large for a share link. Download config JSON instead.",
    );
  return url.href;
}

export function decodeShare(href) {
  const url = new URL(href);
  const encoded = url.searchParams.get("view");
  const relevant = [
    "user",
    "organization",
    "view",
    "preset",
    "design",
    ...Object.keys(shareParameters),
  ];
  if (!relevant.some((key) => url.searchParams.has(key))) return null;
  if (
    href.length > MAX_SHARE_LENGTH ||
    (encoded !== null && !/^[\w-]+$/.test(encoded))
  )
    throw new Error("Invalid share link.");
  try {
    for (const key of relevant)
      if (url.searchParams.getAll(key).length > 1)
        throw new Error("Duplicate parameter.");
    const user = url.searchParams.get("user"),
      organization = url.searchParams.get("organization");
    const account = organization || user;
    if (!account) throw new Error("An account is required.");
    let options = {};
    if (encoded) {
      const bytes = Uint8Array.from(
        atob(encoded.replaceAll("-", "+").replaceAll("_", "/")),
        (char) => char.charCodeAt(0),
      );
      const result = parseConfig(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (account.toLowerCase() !== result.account.toLowerCase())
        throw new Error("Account mismatch.");
      options = result.options;
    }
    const direct = {};
    for (const [key, type] of Object.entries(shareParameters)) {
      if (!url.searchParams.has(key)) continue;
      const value = url.searchParams.get(key);
      if (type === "boolean" && !["true", "false", "1", "0"].includes(value))
        throw new Error("Invalid boolean.");
      if (type === "number" && !/^\d+$/.test(value))
        throw new Error("Invalid number.");
      direct[key] =
        type === "boolean"
          ? ["true", "1"].includes(value)
          : type === "number"
            ? Number(value)
            : value;
    }
    if (organization) {
      direct.accountType = "organization";
      if (user) direct.organizationUser = user;
    }
    const preset = url.searchParams.get("preset"),
      design = url.searchParams.get("design");
    if (!encoded && !preset && !design)
      options = presetOptions(
        direct.accountType === "organization"
          ? direct.organizationUser
            ? "organization-community"
            : "organization-projects"
          : "project-map",
        direct,
      );
    if (preset) options = presetOptions(preset, { ...options, ...direct });
    if (design) options = { ...options, ...randomizeDesign(design) };
    options = { ...options, ...direct };
    if (direct.theme !== undefined || direct.visualTheme !== undefined) {
      delete options.visualStyle;
      delete options.colors;
      if (direct.visualTheme === undefined) delete options.visualTheme;
    }
    if (direct.seed !== undefined && direct.seedMode === undefined)
      options.seedMode = "custom";
    return parseConfig({ version: CONFIG_VERSION, account, options });
  } catch {
    throw new Error(
      "Unable to restore this share link. Default settings are available.",
    );
  }
}
