# Mikey’s README constellation

This compact variant matches the charcoal, yellow, and cream palette in [mnichols08/mnichols08](https://github.com/mnichols08/mnichols08/blob/main/README.md). The 900 × 280 image takes about 249 px of height at an 800 px README width, half the height of the original atlas. Both variants use the same layout and repository snapshot.

The adaptive `dist/mnichols08.svg` contains both palettes and follows the viewer’s preference with no toggle. Copy it to `assets/mnichols08.svg` and embed it as a normal Markdown image. Fixed light and dark variants remain available for the `<picture>` alternative below. All variants omit the visible header and left footer; the only footer is the right-aligned `mnichols08/constellation` link.

Suggested placement: immediately after `# Selected Work`, before the case-study introduction. It adds a visual introduction to the work without adding another section or enlarging the already busy profile header.

The initial selection in [mnichols08.json](mnichols08.json) is an editable set of 12 public projects spanning applications, Web Components, and Rust. This is a proposed selection, not GitHub pins. Forks are excluded. Other means no detected languages and is excluded by default; projects with any detected language remain eligible. No languages are inferred from project descriptions. Sprout is not in this account’s public owned-repository response, so it is not represented.

```sh
npm run generate:profile
```

Copy `dist/mnichols08-dark.svg` and `dist/mnichols08-light.svg` into `assets/` in the **profile repository**, then add:

```html
<p align="center">
  <a href="https://github.com/mnichols08?tab=repositories">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="./assets/mnichols08-dark.svg">
      <img src="./assets/mnichols08-light.svg" width="900" alt="Mikey’s project constellation: selected public repositories grouped by primary language.">
    </picture>
  </a>
</p>

Made with [GitHub Constellation](https://github.com/mnichols08/constellation) by [@mnichols08](https://github.com/mnichols08).
```

The whole image links to your repositories. Solid lines connect projects sharing any detected language, including secondary HTML, CSS, and JavaScript. The personal configuration uses `connectionDensity: "all"`, so every real shared-language pair is shown, with decorative bridges disabled. The chart communicates through visible language labels, stars, and accessible descriptions; it does not depend on hover, JavaScript, remote fonts, or per-star clicks. Animation is subtle opacity only and respects reduced-motion preferences. Set `animate` to `false` for a still image. Small collections use short project labels, a spaced star field, and softer secondary links. Visible headers and left footer text remain omitted.

These files are prepared locally. The profile repository has not been modified. Regenerate and copy both files together when updating your selection or repository data. The existing generic daily workflow continues to generate `dist/constellation.svg`; it does not publish this personal pair automatically.
