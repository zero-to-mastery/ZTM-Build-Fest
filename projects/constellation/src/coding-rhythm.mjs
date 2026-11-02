import { sanitizeActivityEvents } from './activity.mjs';

export const rhythmWeights = Object.freeze({ push: 1, 'pull-request': .9, release: .8, create: .7, issue: .35, comment: .15 });
export const rhythmDefaults = Object.freeze({ codingRhythm: false, codingRhythmStyle: 'orbit', codingRhythmWindow: '30d', codingRhythmTimezone: 'UTC', codingRhythmDays: 'subtle', codingRhythmAnimate: false, codingRhythmPeakLabel: true, codingRhythmLabels: 'quarters', codingRhythmCelestialMarkers: false, codingRhythmProjectHints: false });

export function resolveRhythmTimezone(value = 'UTC') {
  // A headless runner's local zone says nothing about the developer.
  if (typeof value !== 'string') throw new Error('Invalid coding rhythm timezone.');
  const zone = ['utc', 'local'].includes(value.toLowerCase()) ? 'UTC' : value;
  try { return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone; }
  catch { throw new Error('Invalid coding rhythm timezone. Use UTC or an IANA timezone.'); }
}

export function codingRhythmOptions(options = {}) {
  const result = Object.fromEntries(Object.entries(rhythmDefaults).map(([key, value]) => [key, options[key] ?? value]));
  for (const key of ['codingRhythm', 'codingRhythmAnimate', 'codingRhythmPeakLabel', 'codingRhythmCelestialMarkers', 'codingRhythmProjectHints']) if (typeof result[key] !== 'boolean') throw new Error(`${key} must be boolean.`);
  for (const [key, values] of Object.entries({ codingRhythmStyle: ['orbit', 'active-arc', 'halo', 'hidden'], codingRhythmWindow: ['7d', '14d', '30d'], codingRhythmDays: ['off', 'subtle', 'full'], codingRhythmLabels: ['none', 'quarters', 'cardinal'] })) if (!values.includes(result[key])) throw new Error(`Invalid ${key}.`);
  result.codingRhythmTimezone = resolveRhythmTimezone(result.codingRhythmTimezone);
  return result;
}

export function deriveCodingRhythm(input, options = {}, asOf) {
  const settings = codingRhythmOptions(options);
  const reference = Date.parse(asOf);
  if (!Number.isFinite(reference)) throw new Error('Coding rhythm needs an explicit reference date.');
  const days = Number.parseInt(settings.codingRhythmWindow);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: settings.codingRhythmTimezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
  const buckets = new Map(), projects = new Map();
  let eventCount = 0;
  for (const event of sanitizeActivityEvents(input)) {
    const time = Date.parse(event.createdAt), weight = rhythmWeights[event.kind] || 0;
    if (!weight || time > reference || time < reference - days * 86400000) continue;
    const parts = Object.fromEntries(formatter.formatToParts(new Date(time)).map(part => [part.type, part.value]));
    const hour = Number(parts.hour), day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
    const key = `${parts.year}-${parts.month}-${parts.day}:${hour}`;
    const bucket = buckets.get(key) || { hour, day, weight: 0 };
    bucket.weight += weight; buckets.set(key, bucket); eventCount++;
    if (!projects.has(event.repository)) projects.set(event.repository, new Map());
    const project = projects.get(event.repository);
    project.set(key, { hour, weight: (project.get(key)?.weight || 0) + weight });
  }
  const hourly = Array(24).fill(0), weekday = Array(7).fill(0);
  for (const bucket of buckets.values()) {
    const value = 1 - Math.exp(-bucket.weight);
    hourly[bucket.hour] += value; weekday[bucket.day] += value;
  }
  const normalize = values => values.map(value => Math.max(...values) ? value / Math.max(...values) : 0);
  // Require independent occupied buckets as well as events before claiming a pattern.
  const sufficient = eventCount >= 5 && buckets.size >= 5;
  const peakHour = sufficient ? hourly.indexOf(Math.max(...hourly)) : null;
  const windows = hourly.map((_, start) => Array.from({ length: 4 }, (_, offset) => hourly[(start + offset) % 24]).reduce((a, b) => a + b, 0));
  const start = windows.indexOf(Math.max(...windows));
  const projectHours = Object.fromEntries([...projects].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => {
    const hours = Array(24).fill(0);
    for (const bucket of values.values()) hours[bucket.hour] += 1 - Math.exp(-bucket.weight);
    return [name, hours.indexOf(Math.max(...hours))];
  }));
  return { hourly: normalize(hourly), weekday: normalize(weekday), peakHour, peakWindow: sufficient ? { start, end: (start + 4) % 24 } : null, peakDay: sufficient ? weekday.indexOf(Math.max(...weekday)) : null, eventCount, timezone: settings.codingRhythmTimezone, window: settings.codingRhythmWindow, confidence: sufficient ? Math.round(Math.min(1, buckets.size / 20) * 10) / 10 : 0, projectHours };
}
