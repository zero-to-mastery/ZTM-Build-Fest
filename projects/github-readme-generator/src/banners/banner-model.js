import { baseTheme, color, normalizeTheme } from "../themes/theme-model.js";
import { derive, cleanOwnership } from "../themes/theme-resolver.js";
export const bannerStyles = [
  "minimal",
  "terminal",
  "grid",
  "constellation",
  "gradient",
  "geometric",
  "code-lines",
  "monochrome",
];
export const bannerSizes = {
  "GitHub Profile Wide": [1200, 320],
  "Compact Header": [1000, 180],
  "Repository Header": [1200, 240],
};
export function themePalette(theme = baseTheme) {
  const p = normalizeTheme(theme).palette;
  return {
    accent: p.accent,
    accentAlt: p.accentAlt,
    foreground: p.foreground,
    muted: p.muted,
    light: p.backgroundLight,
    dark: p.backgroundDark,
    border: p.border,
  };
}
export function newBanner(theme = baseTheme) {
  const value = {
    version: 1,
    name: "Your Name",
    title: "Software developer",
    subtitle: "",
    website: "",
    metadataLine: "",
    width: 1200,
    height: 320,
    alignment: "left",
    pattern: "minimal",
    themeMode: normalizeTheme(theme).pictures.preferThemeAware
      ? "both"
      : "light",
    palette: derive({}, themePalette(theme)),
    showBorder: true,
    showAccent: true,
    seed: "readme-studio",
    alt: "Your Name — Software developer",
    filename: "banner",
    assetDirectory: "assets",
  };
  derive(
    value,
    Object.fromEntries(
      [
        "width",
        "height",
        "alignment",
        "pattern",
        "themeMode",
        "showBorder",
        "showAccent",
        "seed",
      ].map((k) => [k, value[k]]),
    ),
    { reset: true },
  );
  return value;
}
export function normalizeBanner(raw) {
  if (!raw || raw.version !== 1)
    throw Error("Unsupported banner version. Expected version 1.");
  const b = { version: 1 };
  for (const [key, max] of [
    ["name", 80],
    ["title", 100],
    ["subtitle", 140],
    ["website", 100],
    ["metadataLine", 100],
    ["alt", 240],
    ["seed", 80],
    ["filename", 80],
    ["assetDirectory", 120],
  ]) {
    if (
      typeof raw[key] !== "string" ||
      [...raw[key]].length > max ||
      /[\x00-\x08\x0b-\x1f\x7f]/.test(raw[key])
    )
      throw Error(`Invalid ${key}: use at most ${max} characters.`);
    b[key] = raw[key].replace(/[\r\n\t]/g, " ");
  }
  if (!b.alt.trim())
    throw Error(
      "Add meaningful banner alt text before exporting or inserting.",
    );
  for (const [key, min, max] of [
    ["width", 320, 1600],
    ["height", 120, 600],
  ]) {
    const n = Number(raw[key]);
    if (!Number.isInteger(n) || n < min || n > max)
      throw Error(`${key} must be an integer from ${min} to ${max}.`);
    b[key] = n;
  }
  if (
    !bannerStyles.includes(raw.pattern) ||
    !["left", "center", "right"].includes(raw.alignment) ||
    !["light", "dark", "both"].includes(raw.themeMode)
  )
    throw Error("Choose supported banner options.");
  for (const k of ["pattern", "alignment", "themeMode"]) b[k] = raw[k];
  for (const k of ["showBorder", "showAccent"]) {
    if (typeof raw[k] !== "boolean")
      throw Error("Choose border and accent options.");
    b[k] = raw[k];
  }
  b.palette = {};
  for (const k of Object.keys(themePalette()))
    b.palette[k] = color(raw.palette?.[k]);
  if (raw.palette?._theme)
    b.palette._theme = cleanOwnership(raw.palette._theme);
  if (
    !/^[a-z\d_./ -]*$/i.test(b.assetDirectory) ||
    b.assetDirectory.split("/").includes("..") ||
    b.assetDirectory.startsWith("/")
  )
    throw Error(
      "Use a relative asset folder such as assets; parent paths are not supported.",
    );
  if (raw._theme) b._theme = cleanOwnership(raw._theme);
  return b;
}
