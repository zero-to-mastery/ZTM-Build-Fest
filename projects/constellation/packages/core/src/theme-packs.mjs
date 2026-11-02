export const THEME_API_VERSION = 2;
export function validateThemePack(pack, { reference = false } = {}) {
  if (!pack || typeof pack !== 'object' || !/^[a-z][a-z\d-]{0,63}$/.test(pack.id || '') || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pack.version || '')) throw new Error('themePack requires an id and an exact release version (major.minor.patch, no leading zeros).');
  if (pack.apiVersion !== undefined && ![1, THEME_API_VERSION].includes(pack.apiVersion)) throw new Error('Unsupported theme API version.');
  if (Object.keys(pack).some(key => !['id', 'version', 'preset', 'apiVersion'].includes(key))) throw new Error('Unknown theme pack field. Use id, version, apiVersion and preset.');
  if (reference && pack.preset === undefined) return pack;
  const preset = pack.preset;
  if (preset && Object.keys(preset).some(key => !['label', 'palette', 'lightPalette', 'transparent', 'glow', 'opacity', 'nodeColorMode', 'nodeShape', 'animate', 'effect'].includes(key))) throw new Error('Theme presets may contain styling only.');
  if (!preset || typeof preset !== 'object' || !Array.isArray(preset.palette) || preset.palette.length !== 5 || preset.palette.some(color => !/^#[a-f\d]{6}$/i.test(color))) throw new Error('Theme pack preset.palette requires five 6-digit hex colors.');
  if (preset.lightPalette && (!Array.isArray(preset.lightPalette) || preset.lightPalette.length !== 5 || preset.lightPalette.some(color => !/^#[a-f\d]{6}$/i.test(color)))) throw new Error('Theme pack lightPalette requires five 6-digit hex colors.');
  if (!Number.isFinite(preset.glow) || preset.glow < 0 || preset.glow > 10 || !Number.isFinite(preset.opacity) || preset.opacity < 0 || preset.opacity > 1) throw new Error('Theme pack glow must be 0–10 and opacity 0–1.');
  return pack;
}

export function renderNodeIcon(descriptor, { x, y, radius }) {
  if (descriptor === undefined || descriptor === null) return '';
  if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.path !== 'string' || descriptor.path.length > 10000 || !/^[MmZzLlHhVvCcSsQqTtAa\d\s.,+eE-]+$/.test(descriptor.path)) throw new Error('A node renderer must return { path } using SVG path commands in a -1..1 coordinate box.');
  if (descriptor.fill !== undefined && !/^#[a-f\d]{6}$/i.test(descriptor.fill)) throw new Error('Node renderer fill must be a 6-digit hex color.');
  return `<path class="plugin-node-icon" d="${descriptor.path}" fill="${descriptor.fill || 'var(--node-color,var(--sky-star))'}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${radius.toFixed(1)})" pointer-events="none"/>`;
}
