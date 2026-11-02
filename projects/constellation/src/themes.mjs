import { validateThemePack } from './theme-packs.mjs';
// Themes only supply visual defaults. Explicit configuration always wins.
export const visualThemes = {
  constellation: { label: 'Constellation (original)', lightPalette: ['#f7f8fc', '#18213a', '#395bbe', '#aab6d3', '#966500'], palette: ['#080e20', '#e6edff', '#9ab9ff', '#3e537e', '#f6d99b'], glow: 2, opacity: .13, nodeColorMode: 'custom' },
  mnix: { label: 'Mnix (adaptive, transparent)', transparent: true, lightPalette: ['#fafaf3', '#202516', '#595600', '#838d66', '#8b8500'], palette: ['#111111', '#f3f3f4', '#e3de13', '#555a38', '#e3de13'], glow: 2, opacity: .13, nodeColorMode: 'custom' },
  'github-dark': { label: 'GitHub Dark', palette: ['#0d1117', '#c9d1d9', '#58a6ff', '#30363d', '#79c0ff'], glow: 1, opacity: .28 },
  'deep-space': { label: 'Deep Space', palette: ['#080c24', '#dce6ff', '#a78bfa', '#53619c', '#93c5fd'], glow: 3, opacity: .24 },
  terminal: { label: 'Terminal Green', palette: ['#071409', '#a8f0a0', '#39d353', '#245c32', '#56f584'], glow: 1.5, opacity: .2, nodeShape: 'square', animate: false },
  solarized: { label: 'Solarized', palette: ['#002b36', '#93a1a1', '#b58900', '#586e75', '#2aa198'], glow: 0, opacity: .3, animate: false },
  dracula: { label: 'Dracula', palette: ['#282a36', '#f8f8f2', '#ff79c6', '#6272a4', '#bd93f9'], glow: 2, opacity: .27 },
  synthwave: { label: 'Synthwave', palette: ['#170d30', '#f9d5ff', '#ff4fd8', '#62359e', '#51e5ff'], glow: 3, opacity: .26, nodeShape: 'diamond' },
  monochrome: { label: 'Monochrome', palette: ['#111111', '#eeeeee', '#cccccc', '#777777', '#ffffff'], glow: 0, opacity: .25, animate: false },
  contribution: { label: 'Contribution Graph', palette: ['#0d1117', '#c9d1d9', '#39d353', '#21452c', '#26a641'], glow: 0, opacity: .16, nodeColorMode: 'contribution', nodeShape: 'square', animate: false },
  rustacean: { label: 'Rustacean', palette: ['#221712', '#f3dccb', '#f29964', '#92674e', '#dea584'], glow: 1, opacity: .24, nodeShape: 'hexagon' },
  javascript: { label: 'JavaScript Yellow', palette: ['#191909', '#fffbd6', '#f1e05a', '#777340', '#f7df1e'], glow: 1, opacity: .2 },
  sudo: { label: 'sudo', palette: ['#061109', '#b8ffbe', '#39ff72', '#28633c', '#66ff99'], glow: 2, opacity: .18, nodeShape: 'square', effect: 'scanlines', animate: false },
  chingu: { label: 'Chingu', transparent: true, lightPalette: ['#ecfdf5', '#064e3b', '#047857', '#059669', '#047857'], palette: ['#064e3b', '#ecfdf5', '#34d399', '#059669', '#a7f3d0'], glow: 1.5, opacity: .24, nodeColorMode: 'custom' },
  'code-the-dream': { label: 'Code the Dream', transparent: true, lightPalette: ['#f1f2f2', '#12284c', '#c43d20', '#677b98', '#c43d20'], palette: ['#12284c', '#f1f2f2', '#ff5c35', '#677b98', '#f3c300'], glow: 1, opacity: .26, nodeColorMode: 'custom' },
};

export function themePalettes(preset) {
  const palette = values => Object.fromEntries(['background', 'foreground', 'accent', 'line', 'star'].map((key, i) => [key, values[i]]));
  return { light: palette(preset.lightPalette || preset.palette), dark: palette(preset.palette) };
}

export function resolveTheme(options = {}) {
  if (options.themePack) validateThemePack(options.themePack, { reference: true });
  const id = options.themePack?.id || options.visualTheme || (visualThemes[options.theme] ? options.theme : null);
  if (!id || (id === 'custom' && !options.themePack)) return options;
  const preset = options.themePack?.preset || (options.themePack && options.themePack.version !== '1.0.0' ? null : visualThemes[id]);
  if (!preset) throw new Error('Unknown visual theme.');
  const { label, palette, lightPalette, transparent, glow, opacity, ...defaults } = preset;
  const colors = Object.fromEntries(['background', 'foreground', 'accent', 'line', 'star'].map((key, i) => [key, palette[i]]));
  const palettes = themePalettes(preset);
  const variables = values => Object.entries({ ...values, ...options.colors }).map(([key, value]) => `--sky-${key}:${value}`).join(';');
  const adaptiveCSS = lightPalette ? `svg{${variables(palettes.light)}}@media(prefers-color-scheme:dark){svg{${variables(palettes.dark)}}}` : '';
  return { ...defaults, ...options, transparentTheme: !!transparent, theme: lightPalette ? 'auto' : visualThemes[options.theme] ? 'midnight' : options.theme || 'midnight',
    colors: { ...colors, ...options.colors },
    css: `${adaptiveCSS}svg{background:${transparent ? 'transparent' : 'var(--sky-background)'}}.star{filter:drop-shadow(0 0 ${glow}px var(--node-color,var(--sky-star)))}.shared-language[data-emphasis="secondary"]{opacity:${opacity}}\n${options.css || ''}` };
}
