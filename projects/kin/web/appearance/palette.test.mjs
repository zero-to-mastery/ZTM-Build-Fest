import test from "node:test";
import assert from "node:assert/strict";
import { APPEARANCE_PRESETS, contrastRatio, normalizeHex, paletteForSeed } from "./palette.js";

test("custom colors accept only normalized RRGGBB values", () => {
  assert.equal(normalizeHex(" #1a2b3c "), "#1A2B3C");
  for (const invalid of ["#123", "red", "url(x)", "#123456; color:red", ""]) assert.equal(normalizeHex(invalid), null);
});

test("presets are named, unique, and include the current Kin default", () => {
  assert.equal(APPEARANCE_PRESETS[0].name, "Kin default");
  assert.equal(new Set(APPEARANCE_PRESETS.map(({ seed }) => seed)).size, APPEARANCE_PRESETS.length);
});

test("extreme and neutral seeds generate readable paired tokens", () => {
  for (const seed of ["#000000", "#FFFFFF", "#808080", "#FF0000", "#00FF00", "#0000FF"]) {
    for (const mode of ["light", "dark"]) {
      const palette = paletteForSeed(seed, mode);
      assert.ok(contrastRatio(palette.ink, palette.surface) >= 4.5, `${seed} ${mode} ink`);
      assert.ok(contrastRatio(palette["ink-muted"], palette.surface) >= 4.5, `${seed} ${mode} muted`);
      assert.ok(contrastRatio(palette["accent-ink"], palette.accent) >= 4.5, `${seed} ${mode} accent`);
      assert.ok(contrastRatio(palette["header-ink"], palette["header-bg"]) >= 4.5, `${seed} ${mode} header`);
    }
  }
});

test("essential control boundaries meet non-text contrast in every palette", () => {
  const seeds = [...APPEARANCE_PRESETS.map(({ seed }) => seed), "#000000", "#FFFFFF", "#808080", "#FF0000", "#00FF00", "#0000FF"];
  for (const seed of seeds) {
    for (const mode of ["light", "dark"]) {
      const palette = paletteForSeed(seed, mode);
      for (const adjacent of ["surface", "bg"]) {
        assert.ok(contrastRatio(palette["line-strong"], palette[adjacent]) >= 3, `${seed} ${mode} control boundary on ${adjacent}`);
      }
    }
  }
});
