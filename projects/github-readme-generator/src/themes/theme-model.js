import { styles } from "../badges/shields.js";
export const headingStyles = [
  "plain",
  "emoji-accent",
  "minimal-prefix",
  "terminal-prompt",
  "centered",
  "divider-heading",
];
export const dividerStyles = ["none", "rule", "glyph", "ascii", "dots"];
export const paletteKeys = [
  "accent",
  "accentAlt",
  "foreground",
  "muted",
  "backgroundLight",
  "backgroundDark",
  "border",
  "success",
  "warning",
];
export const baseTheme = {
  version: 1,
  id: "github",
  name: "GitHub",
  palette: {
    accent: "0969da",
    accentAlt: "8250df",
    foreground: "1f2328",
    muted: "59636e",
    backgroundLight: "ffffff",
    backgroundDark: "0d1117",
    border: "d1d9e0",
    success: "1a7f37",
    warning: "9a6700",
  },
  badges: {
    style: "flat",
    lightBackground: "0969da",
    darkBackground: "1f6feb",
    logoTreatment: "white",
  },
  headings: { style: "plain", decoration: "✦" },
  dividers: { style: "none" },
  pictures: { preferThemeAware: true },
};
export function color(value) {
  if (typeof value !== "string" || !/^#?[a-f\d]{6}$/i.test(value))
    throw Error("Use a six-digit hex color, such as #0969da.");
  return value.replace(/^#/, "").toLowerCase();
}
export function safeName(value, max = 120) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[<>\x00-\x1f\x7f]/.test(value)
  )
    throw Error("Use plain text without markup or control characters.");
  return value.trim();
}
export function normalizeTheme(value = baseTheme) {
  if (!value || value.version !== 1)
    throw Error("Unsupported theme version. Expected version 1.");
  const t = {
    version: 1,
    id:
      typeof value.id === "string" && /^[a-z\d-]{1,80}$/i.test(value.id)
        ? value.id
        : crypto.randomUUID(),
    name: safeName(value.name),
    palette: {},
    badges: {},
    headings: {},
    dividers: {},
    pictures: {},
  };
  for (const key of paletteKeys) t.palette[key] = color(value.palette?.[key]);
  if (!styles.includes(value.badges?.style))
    throw Error("Choose a supported badge style.");
  t.badges = {
    style: value.badges.style,
    lightBackground: color(value.badges.lightBackground),
    darkBackground: color(value.badges.darkBackground),
    logoTreatment: value.badges.logoTreatment,
  };
  if (!["white", "black", "accent"].includes(t.badges.logoTreatment))
    throw Error("Choose white, black, or accent logos.");
  if (
    !headingStyles.includes(value.headings?.style) ||
    !dividerStyles.includes(value.dividers?.style)
  )
    throw Error("Choose supported heading and divider styles.");
  t.headings = {
    style: value.headings.style,
    decoration: safeName(value.headings.decoration, 16),
  };
  t.dividers = { style: value.dividers.style };
  if (typeof value.pictures?.preferThemeAware !== "boolean")
    throw Error("Choose whether to prefer light/dark pairs.");
  t.pictures = { preferThemeAware: value.pictures.preferThemeAware };
  return t;
}
