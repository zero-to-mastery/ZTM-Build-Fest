export const KIN_DEFAULT_SEED = "#984D38";

export const APPEARANCE_PRESETS = Object.freeze([
  ["default", "Kin default", KIN_DEFAULT_SEED],
  ["forest", "Forest", "#397052"],
  ["ocean", "Ocean", "#256A91"],
  ["teal", "Teal", "#16756F"],
  ["plum", "Plum", "#74507D"],
  ["rose", "Rose", "#A14F68"],
  ["amber", "Amber", "#9A6418"],
  ["slate", "Slate", "#596675"],
].map(([id, name, seed]) => Object.freeze({ id, name, seed })));

export function normalizeHex(value) {
  const text = String(value ?? "").trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(text) ? text : null;
}

export function contrastRatio(left, right) {
  const luminance = (hex) => {
    const rgb = hexToRgb(hex).map((channel) => channel / 255)
      .map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
    return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
  };
  const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (high + .05) / (low + .05);
}

export function paletteForSeed(seed, mode) {
  const normalized = normalizeHex(seed) ?? KIN_DEFAULT_SEED;
  if (normalized === KIN_DEFAULT_SEED) return kinDefaultPalette(mode);
  const [h, s] = rgbToHsl(hexToRgb(normalized));
  const dark = mode === "dark";
  const neutralSaturation = Math.min(dark ? 18 : 16, Math.max(5, s * .18));
  const bg = hslHex(h, neutralSaturation, dark ? 10 : 96);
  const surface = hslHex(h, neutralSaturation, dark ? 15 : 99);
  const secondary = hslHex(h, neutralSaturation + 3, dark ? 21 : 93);
  const ink = dark ? "#F7F5F2" : "#252321";
  const muted = readableMuted(dark ? hslHex(h, 8, 70) : hslHex(h, 9, 42), surface, 4.5, dark);
  const line = hslHex(h, neutralSaturation + 2, dark ? 31 : 80);
  const lineStrong = readableBoundary(h, Math.min(30, s * .28 + 8), [surface, bg], dark);
  const accent = readableAccent(h, Math.max(36, Math.min(78, s)), surface, dark);
  const accentInk = bestText(accent);
  const accentSoft = mixHex(accent, surface, dark ? .72 : .82);
  const header = hslHex(h, Math.max(22, Math.min(52, s * .65)), dark ? 17 : 30);
  return Object.freeze({
    "bg": bg, "surface": surface, "surface-secondary": secondary,
    "ink": ink, "ink-muted": muted, "line": line, "line-strong": lineStrong,
    "accent": accent, "accent-ink": accentInk, "accent-soft": accentSoft,
    "header-bg": header, "header-ink": bestText(header),
    "header-muted": mixHex(bestText(header), header, .22),
  });
}

function kinDefaultPalette(mode) {
  return Object.freeze(mode === "dark" ? {
    "bg": "#171d19", "surface": "#242b26", "surface-secondary": "#303a33",
    "ink": "#f3eae2", "ink-muted": "#c3b3a7", "line": "#475149", "line-strong": "#879589",
    "accent": "#e19a7e", "accent-ink": "#281b17", "accent-soft": "#49332b",
    "header-bg": "#29352d", "header-ink": "#fff4eb", "header-muted": "#d7c9bd",
  } : {
    "bg": "#f3f1e9", "surface": "#fffdfa", "surface-secondary": "#f1e8de",
    "ink": "#342d29", "ink-muted": "#766b63", "line": "#e2d1c4", "line-strong": "#9f806d",
    "accent": "#984d38", "accent-ink": "#fffaf6", "accent-soft": "#f1ded2",
    "header-bg": "#684033", "header-ink": "#fff9f3", "header-muted": "#ead2c2",
  });
}

export function paletteCss(tokens) {
  return `:root[data-kin-appearance] {${Object.entries(tokens).map(([name, value]) => `--${name}:${value};`).join("")}}`;
}

function readableAccent(h, s, surface, dark) {
  const candidates = dark ? [68, 74, 62, 80, 56] : [38, 32, 44, 27, 49];
  return candidates.map((l) => hslHex(h, s, l)).find((value) => contrastRatio(value, surface) >= 4.5) ?? (dark ? "#FFFFFF" : "#000000");
}

function readableMuted(initial, surface, target, dark) {
  if (contrastRatio(initial, surface) >= target) return initial;
  for (const lightness of dark ? [74, 78, 82] : [38, 34, 30]) {
    const value = hslHex(0, 0, lightness);
    if (contrastRatio(value, surface) >= target) return value;
  }
  return dark ? "#FFFFFF" : "#000000";
}

function readableBoundary(hue, saturation, backgrounds, dark) {
  const lightnesses = dark ? [53, 58, 63, 68, 73, 78] : [55, 50, 45, 40, 35, 30];
  return lightnesses.map((lightness) => hslHex(hue, saturation, lightness))
    .find((value) => backgrounds.every((background) => contrastRatio(value, background) >= 3.1)) ?? (dark ? "#FFFFFF" : "#000000");
}

function bestText(background) {
  return contrastRatio("#FFFFFF", background) >= contrastRatio("#171412", background) ? "#FFFFFF" : "#171412";
}

function hexToRgb(hex) {
  const value = Number.parseInt(normalizeHex(hex).slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHsl([r8, g8, b8]) {
  const [r, g, b] = [r8, g8, b8].map((value) => value / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let h = 0;
  if (delta) h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  h = (h * 60 + 360) % 360;
  const l = (max + min) / 2;
  const s = delta ? delta / (1 - Math.abs(2 * l - 1)) : 0;
  return [h, s * 100, l * 100];
}

function hslHex(h, s, l) {
  const saturation = Math.max(0, Math.min(100, s)) / 100;
  const lightness = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = lightness - c / 2;
  let rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${rgb.map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function mixHex(foreground, background, backgroundWeight) {
  const fg = hexToRgb(foreground), bg = hexToRgb(background);
  return `#${fg.map((channel, index) => Math.round(channel * (1 - backgroundWeight) + bg[index] * backgroundWeight).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
