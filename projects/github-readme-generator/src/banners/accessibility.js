import { contrastRatio } from "../badges/contrast.js";
import { altTextQuality } from "../accessibility/media.js";

function altDiagnostic(value) {
  const quality = altTextQuality(value);
  if (quality === "missing")
    return {
      level: "error",
      message: "Alt text is required for an informative banner.",
    };
  if (quality === "generic")
    return {
      level: "warning",
      message:
        "Alt text is present but generic. Describe the identity or purpose conveyed by the banner.",
    };
  return {
    level: "pass",
    message: "Alt text is present and descriptive enough for review.",
  };
}

function contrastDiagnostic(mode, role, foreground, background) {
  const ratio = contrastRatio(foreground, background);
  if (ratio === null)
    return {
      mode,
      role,
      level: "unknown",
      ratio: null,
      message: "Contrast cannot be estimated until both colors are valid.",
    };
  const level = ratio >= 4.5 ? "pass" : "warning";
  return {
    mode,
    role,
    level,
    ratio,
    message:
      level === "pass"
        ? "Passes the conservative 4.5:1 text target."
        : "Review readability; this is below the conservative 4.5:1 text target.",
  };
}

export function bannerAccessibility(value = {}) {
  const palette = value.palette || {},
    modes =
      value.themeMode === "light"
        ? ["light"]
        : value.themeMode === "dark"
          ? ["dark"]
          : ["light", "dark"],
    contrast = [];
  for (const mode of modes) {
    const background = palette[mode],
      primary = mode === "dark" ? "f8fafc" : palette.foreground,
      accent = value.pattern === "monochrome" ? primary : palette.accent,
      muted = mode === "dark" ? "cbd5e1" : palette.muted;
    if (value.name || value.subtitle)
      contrast.push(
        contrastDiagnostic(mode, "Primary text", primary, background),
      );
    if (value.title)
      contrast.push(
        contrastDiagnostic(mode, "Accent/title text", accent, background),
      );
    if (value.website || value.metadataLine)
      contrast.push(
        contrastDiagnostic(mode, "Muted metadata", muted, background),
      );
  }
  return {
    alt: altDiagnostic(value.alt),
    contrast,
    motion:
      "The generated SVG preview is static and contains no animation or scripted motion.",
  };
}
