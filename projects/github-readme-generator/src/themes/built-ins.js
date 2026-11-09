import { baseTheme, normalizeTheme } from "./theme-model.js";
const specs = [
  ["GitHub", "0969da", "8250df", "1f2328", "ffffff", "0d1117"],
  ["Monochrome", "444444", "777777", "222222", "ffffff", "111111"],
  ["Nord", "5e81ac", "88c0d0", "2e3440", "eceff4", "2e3440"],
  ["Dracula", "bd93f9", "ff79c6", "282a36", "f8f8f2", "282a36"],
  ["Catppuccin", "8839ef", "cba6f7", "4c4f69", "eff1f5", "1e1e2e"],
  ["Solarized", "268bd2", "2aa198", "586e75", "fdf6e3", "002b36"],
  ["Terminal", "238636", "3fb950", "16351c", "f0fff4", "07140b"],
  ["Workshop", "a84612", "e0a146", "322820", "fff8ed", "201b17"],
  ["Custom", "6558d3", "998ee8", "252137", "ffffff", "191624"],
];
export const builtInThemes = specs.map(
  ([name, accent, accentAlt, foreground, light, dark]) =>
    normalizeTheme({
      ...structuredClone(baseTheme),
      id: name.toLowerCase(),
      name,
      palette: {
        ...baseTheme.palette,
        accent,
        accentAlt,
        foreground,
        backgroundLight: light,
        backgroundDark: dark,
      },
      badges: {
        ...baseTheme.badges,
        lightBackground: accent,
        darkBackground: dark,
      },
      headings: {
        style: ["Workshop", "Terminal"].includes(name)
          ? "emoji-accent"
          : "plain",
        decoration: name === "Terminal" ? "$" : "✦",
      },
      dividers: { style: name === "Workshop" ? "glyph" : "none" },
    }),
);
