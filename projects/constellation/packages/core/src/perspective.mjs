export function perspectiveOptions(value = {}) {
  const options = { enabled: false, horizontal: 0, vertical: 25, zoom: 90, animate: false, range: 15, duration: 20, ...value };
  if (typeof options.enabled !== 'boolean' || typeof options.animate !== 'boolean') throw new Error('Perspective toggles must be boolean.');
  for (const [key, min, max] of [['horizontal', -55, 55], ['vertical', 0, 65], ['zoom', 60, 100], ['range', 0, 25], ['duration', 4, 60]]) {
    if (!Number.isFinite(options[key]) || options[key] < min || options[key] > max) throw new Error(`Invalid perspective ${key}.`);
  }
  return options;
}

// Project the graph plane using tilt and foreshortening. Shared transforms keep
// labels, hit targets and independently animated connection endpoints aligned.
export function perspectiveMarkup(options, center, height) {
  if (!options.enabled) return { start: '<g class="perspective-scene">', end: '</g>' };
  const moving = options.animate && options.range > 0;
  const samples = Array.from({ length: moving ? 73 : 1 }, (_, i) => {
    const phase = i * Math.PI * 2 / 72;
    const yaw = Math.max(-75, Math.min(75, options.horizontal + (moving ? Math.sin(phase) * options.range : 0))) * Math.PI / 180;
    const pitch = Math.max(0, Math.min(75, options.vertical + (moving ? (1 - Math.cos(phase)) * options.range / 4 : 0))) * Math.PI / 180;
    const sx = Math.cos(yaw), sy = Math.cos(pitch), shear = Math.sin(yaw) * Math.sin(pitch);
    return { sx, sy, shear, skew: Math.atan(shear / sx) * 180 / Math.PI };
  });
  const halfHeight = Math.max(center - 18, height - 40 - center);
  const fit = options.zoom / 100 / Math.max(1, ...samples.map(sample => sample.sx + Math.abs(sample.shear) * halfHeight / 418));
  const scales = samples.map(sample => `${(sample.sx * fit).toFixed(6)} ${(sample.sy * fit).toFixed(6)}`);
  const skews = samples.map(sample => sample.skew.toFixed(6));
  const animation = (type, values) => moving ? `<animateTransform data-perspective="true" attributeName="transform" type="${type}" values="${values.join(';')}" dur="${options.duration}s" repeatCount="indefinite"/>` : '';
  return {
    start: `<g transform="translate(450 ${center})"><g class="perspective-scale" transform="scale(${scales[0]})">${animation('scale', scales)}<g class="perspective-tilt" transform="skewX(${skews[0]})">${animation('skewX', skews)}<g class="perspective-scene" transform="translate(-450 ${-center})">`,
    end: '</g></g></g></g>',
  };
}
