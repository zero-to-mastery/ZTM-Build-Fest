export function exportSettings(options = {}) {
  const profile = options.exportProfile || 'custom';
  if (!['custom', 'readme', 'profile', 'repository', 'compact', 'hero', 'wide', 'square', 'portfolio', 'transparent'].includes(profile)) throw new Error('Invalid export profile.');
  return { ...options, ...(['readme', 'repository', 'compact', 'wide'].includes(profile) ? { layout: 'compact' } : ['profile', 'hero', 'square', 'portfolio'].includes(profile) ? { layout: 'atlas' } : {}), exportProfile: profile };
}

export function profileDimensions(profile, height) {
  const dimensions = {
    hero: [900, 560], wide: [900, 320], compact: [900, 180], square: [480, 480],
    portfolio: [1440, Math.round(height * 1.6)],
  };
  const [width, outputHeight] = dimensions[profile] || [900, height];
  const compact = profile === 'compact';
  const wide = profile === 'wide' || ['readme', 'repository'].includes(profile);
  return { width, height: outputHeight, labelFraction: compact ? .3 : wide ? .5 : 1, dustCount: compact ? 12 : wide ? 35 : 85 };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function svgToPNG(svg, scale = Math.min(3, Math.max(2, globalThis.devicePixelRatio || 1))) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('This browser could not rasterize the SVG. Download SVG instead.')); image.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable. Download SVG instead.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export failed. Download SVG instead.')), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}
