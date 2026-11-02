export const historyDefaults = {
  contributionComet: { enabled: false },
  history: { mode: 'current', year: null, maxHistoricalFrames: 8, timeLapse: { enabled: false, duration: 16, mode: 'grow', loop: true } },
  contributionOrbit: { enabled: false, period: '52w', granularity: 'week', style: 'segments', showCurrent: true, animate: false },
  languageEvolution: { enabled: false, style: 'eras', buckets: 'automatic' },
  stellarAges: { enabled: false, mode: 'appearance', showArchivedRemnants: true, thresholds: { newborn: 90, active: 30, mature: 365, quiet: 180, dormant: 365 } },
  foreignGalaxies: { enabled: false, limit: 8, minimumContribution: 'pr', layout: 'outer' },
};
export const historyFields = [...Object.keys(historyDefaults), 'referenceDate', 'historicalYear', 'timeLapse', 'timeLapseMode', 'timeLapseDuration', 'maxHistoricalFrames', 'languageEvolutionStyle'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function merge(base, value, path) {
  if (value === undefined) return structuredClone(base);
  if (!object(value)) throw new Error(`${path} must be an object.`);
  const result = structuredClone(base);
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(base, key)) throw new Error(`Unknown ${path}.${key}.`);
    if (object(base[key])) result[key] = merge(base[key], entry, `${path}.${key}`);
    else {
      if (base[key] !== null && typeof entry !== typeof base[key]) throw new Error(`Invalid ${path}.${key}.`);
      result[key] = entry;
    }
  }
  return result;
}
export function historyOptions(options = {}) {
  const result = Object.fromEntries(Object.entries(historyDefaults).map(([key, value]) => [key, merge(value, options[key], key)]));
  const h = result.history;
  if (options.historicalYear !== undefined) { h.year = options.historicalYear; h.mode = 'historical'; }
  if (options.timeLapse !== undefined) { if (typeof options.timeLapse !== 'boolean') throw new Error('timeLapse must be boolean.'); h.timeLapse.enabled = options.timeLapse; }
  if (options.timeLapseMode !== undefined) h.timeLapse.mode = options.timeLapseMode;
  if (options.timeLapseDuration !== undefined) h.timeLapse.duration = options.timeLapseDuration;
  if (options.maxHistoricalFrames !== undefined) h.maxHistoricalFrames = options.maxHistoricalFrames;
  if (options.languageEvolutionStyle !== undefined) { result.languageEvolution.style = options.languageEvolutionStyle; result.languageEvolution.enabled = true; }
  if (h.mode === 'time-lapse') h.timeLapse.enabled = true;
  for (const [value, choices] of [[h.mode, ['current', 'historical', 'time-lapse']], [h.timeLapse.mode, ['grow', 'crossfade', 'orbit']], [result.contributionOrbit.period, ['52w']], [result.contributionOrbit.granularity, ['week']], [result.contributionOrbit.style, ['segments', 'dots', 'pulse-ring']], [result.languageEvolution.style, ['rings', 'timeline', 'trails', 'eras']], [result.languageEvolution.buckets, ['automatic', 'yearly', '2-year']], [result.stellarAges.mode, ['appearance', 'color', 'halo', 'subtle']], [result.foreignGalaxies.minimumContribution, ['any', 'issue', 'pr', 'merged-pr', 'code']], [result.foreignGalaxies.layout, ['outer']]]) if (!choices.includes(value)) throw new Error('Invalid history feature setting.');
  if (h.year !== null && (!Number.isInteger(h.year) || h.year < 1970 || h.year > 9998) || h.mode === 'historical' && h.year === null) throw new Error('Historical mode needs a valid year.');
  for (const [value, min, max] of [[h.maxHistoricalFrames, 2, 8], [result.foreignGalaxies.limit, 1, 12], [h.timeLapse.duration, 8, 30]]) if (!Number.isInteger(value) || value < min || value > max) throw new Error('History limit or duration is out of range.');
  const t = result.stellarAges.thresholds;
  if (Object.values(t).some(v => !Number.isFinite(v) || v < 1 || v > 36500) || t.active > t.quiet || t.quiet > t.dormant) throw new Error('Invalid lifecycle thresholds.');
  if (options.referenceDate !== undefined && (typeof options.referenceDate !== 'string' || !Number.isFinite(Date.parse(options.referenceDate)))) throw new Error('referenceDate must be an ISO date.');
  return result;
}
export const needsHistoryEvents = options => !!(options.contributionComet?.enabled || options.contributionOrbit?.enabled || options.foreignGalaxies?.enabled);
