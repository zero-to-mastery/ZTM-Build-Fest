import { renderCredit } from './github-mark.mjs';
import { composeLayers } from './scene-layers.mjs';
import { renderStarfield, renderClassicDust, starfieldOptions, starfieldCSS } from './starfield.mjs';
import { profileDimensions } from './export-image.mjs';
import { historyLayers, historyCSS } from './history/history-svg.mjs';
import { renderCodingRhythm, codingRhythmCSS } from './coding-rhythm-svg.mjs';
import { codingRhythmOptions } from './coding-rhythm.mjs';

// Adapt the established sky to the temporal viewport, outside its projection.
// This is a viewport fit, never a temporal camera/world matrix.
export function temporalSceneLayers(scene, viewBox = scene.viewport.viewBox) {
  const options = scene.presentation.options, sky = starfieldOptions(options.starfield);
  const transparent = options.transparentTheme || options.exportProfile === 'transparent';
  const { dustCount } = profileDimensions(options.exportProfile, 560);
  const [x, y, width, height] = viewBox;
  const fit = `translate(${x} ${y}) scale(${width / 900} ${height / 560})`;
  const stars = renderStarfield(scene.metadata.seed, sky, { detail: dustCount / 85, animate: options.animate !== false, transparent });
  const dust = sky.mode === 'classic' ? `<g class="dust" aria-hidden="true" pointer-events="none" transform="${fit}">${renderClassicDust(options.seedMode ? scene.metadata.seed : scene.metadata.account, { count: dustCount })}</g>` : '';
  const dimensions = { centerY: 270, spreadY: 192, height: 560, legend: options.legend };
  const events = historyLayers(scene.metadata.account, scene.presentation.repositories || [], options, dimensions);
  const rhythm = codingRhythmOptions(options);
  rhythm.codingRhythmAnimate &&= options.animate !== false;
  const summary = events.markup + renderCodingRhythm(options.codingRhythmData, rhythm, dimensions);
  return {
    credit: `<g transform="translate(${x} ${y}) scale(${width / 900})">${renderCredit({ right: 900, bottom: height * 900 / width })}</g>`,
    css: `.credit{font-size:9px;opacity:.65;fill:var(--sky-accent);text-anchor:end}.dust{fill:var(--sky-foreground)}${starfieldCSS}${historyCSS}${codingRhythmCSS}`,
    underlay: composeLayers(scene, 'underlay', { annotations: `<g data-temporal-summary="" transform="${fit}"><title>Account observations at the reference date; not historical activity for each year.</title>${summary}</g>` }),
    backdrop: composeLayers(scene, 'backdrop', {
      background: transparent ? '' : `<rect class="background" x="${x}" y="${y}" width="${width}" height="${height}" fill="var(--sky-background)"/>`,
      starfield: stars ? `<g data-starfield-backdrop="" transform="${fit}">${stars}</g>` : '',
    }),
    world: composeLayers(scene, 'world', { starfield: dust }),
  };
}
