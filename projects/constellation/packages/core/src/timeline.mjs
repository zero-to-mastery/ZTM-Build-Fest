import { createScene } from './constellation.mjs';
import { historicalSnapshot } from './history/historical-snapshot.mjs';
import { normalizeRecords, toGraphRecords } from './data-pipeline.mjs';
import { createTemporalStack } from './temporal-stack.mjs';

export const TIMELINE_VERSION = 1;
const date = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Timeline dates must be ISO date strings.');
  return new Date(value).toISOString();
};
export function temporalMetadata(records) {
  records = toGraphRecords(normalizeRecords(records, { deferIdentityCheck: true }).records);
  const optional = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? date(value) : null;
  return records.filter(record => record.private !== true).map(record => ({
    id: record.full_name || record.id,
    created: optional(record.created_at), updated: optional(record.updated_at),
    releases: (Array.isArray(record.releases) ? record.releases : []).map(release => optional(release.published_at)).filter(Boolean).sort(),
    activitySnapshots: (Array.isArray(record.activitySnapshots) ? record.activitySnapshots : []).filter(snapshot => optional(snapshot.date) && snapshot.metrics && typeof snapshot.metrics === 'object' && !Array.isArray(snapshot.metrics) && Object.values(snapshot.metrics).every(Number.isFinite)).map(snapshot => ({ date: date(snapshot.date), metrics: structuredClone(snapshot.metrics) })).sort((a, b) => a.date.localeCompare(b.date)),
  })).filter(record => typeof record.id === 'string').sort((a, b) => a.id.localeCompare(b.id));
}

export function createTimeline(account, records, options = {}, definition = {}, runtime = {}) {
  if (options.arrangement === 'temporal-stack' || options.temporalStack?.enabled) return createTemporalStack(account, records, { ...options, timeline: definition }, runtime);
  if (!definition || typeof definition !== 'object' || Array.isArray(definition) || Object.keys(definition).some(key => !['referenceDate', 'dates', 'snapshots'].includes(key))) throw new Error('Invalid timeline definition.');
  const referenceDate = date(definition.referenceDate || options.referenceDate);
  records = toGraphRecords(normalizeRecords(records, { deferIdentityCheck: true, signal: runtime.signal }).records);
  const settings = { ...options, historicalYear: undefined, timeline: undefined, timeLapse: false, history: { ...options.history, mode: 'current', timeLapse: { ...options.history?.timeLapse, enabled: false } }, referenceDate };
  let entries;
  if (definition.snapshots !== undefined) {
    if (definition.dates !== undefined || !Array.isArray(definition.snapshots)) throw new Error('Use either timeline snapshots or dates.');
    entries = definition.snapshots.map(snapshot => {
      if (!snapshot || !Array.isArray(snapshot.records)) throw new Error('Each historical snapshot needs records.');
      return { date: date(snapshot.date), evidence: 'snapshot', records: snapshot.records };
    });
  } else {
    const dates = definition.dates || [...new Set(temporalMetadata(records).map(record => record.created).filter(Boolean))];
    if (!Array.isArray(dates)) throw new Error('Timeline dates must be an array.');
    entries = dates.map(value => { const time = date(value); return { date: time, evidence: 'current-metadata', records: historicalSnapshot(records, Date.parse(time)) }; });
  }
  entries = entries.filter(entry => entry.date !== referenceDate);
  entries.push({ date: referenceDate, evidence: 'current', records });
  entries.sort((a, b) => a.date.localeCompare(b.date));
  if (entries.length > 64 || entries.some((entry, i) => entry.date > referenceDate || i > 0 && entry.date === entries[i - 1].date)) throw new Error('Timeline requires at most 64 unique dates at or before its reference date.');
  let totalNodes = 0;
  const frames = entries.map(entry => {
    runtime.signal?.throwIfAborted();
    const scene = createScene(account, entry.records, { ...settings, referenceDate: entry.date, generatedAt: entry.date }, runtime);
    totalNodes += scene.nodes.length;
    if (totalNodes > 16384) throw new Error('Timeline exceeds 16,384 aggregate frame nodes. Reduce snapshots or graph size.');
    return { id: entry.date, date: entry.date, evidence: entry.evidence, scene };
  });
  return { ...structuredClone(frames.at(-1).scene), timeline: { version: TIMELINE_VERSION, referenceDate, metadata: temporalMetadata(records), frames } };
}
