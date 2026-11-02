// Orbits are drawn wide by default (about 2:1) so a map fills a README banner.
// Round orbits use the same reach sideways as up and down: true circles.
export const ORBIT_SHAPES = ['wide', 'round'];

export const roundOrbits = (options = {}) => options.orbitShape === 'round';

/** Horizontal reach for a vertical reach of `spreadY`; `wide` is the banner reach. */
export const orbitSpreadX = (options, spreadY, wide = 368) => (roundOrbits(options) ? spreadY : wide);
