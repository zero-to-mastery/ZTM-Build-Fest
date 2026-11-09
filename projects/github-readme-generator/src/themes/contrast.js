import { contrastRatio } from "../badges/contrast.js";
export function themeWarnings(t) {
  const pairs = [
    ["Light badge / white text", t.badges.lightBackground, "ffffff"],
    ["Dark badge / white text", t.badges.darkBackground, "ffffff"],
    ["Accent / foreground", t.palette.accent, t.palette.foreground],
  ];
  return pairs
    .filter(([, a, b]) => contrastRatio(a, b) < 4.5)
    .map(
      ([label, a, b]) =>
        `${label}: approximate contrast ${contrastRatio(a, b).toFixed(1)}:1. Review readability; remote badge rendering is not a WCAG guarantee.`,
    );
}
