import { createHash } from 'node:crypto';

export const PUBLICATION_MANIFEST_VERSION = 1;
export const MAX_PUBLICATION_MANIFEST_BYTES = 16 * 1024;
const FORMATS = new Set(['svg', 'html']);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/;

export function sha256Digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function validatePublicationManifest(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, diagnostics: ['manifest must be an object'] };
  const bounded = (field, max = 512) => typeof value[field] === 'string' && value[field].length > 0 && value[field].length <= max;
  if (value.version !== PUBLICATION_MANIFEST_VERSION) errors.push('version must be 1');
  if (!value.source || typeof value.source !== 'object' || Array.isArray(value.source)) errors.push('source must be an object');
  else {
    for (const key of ['identity', 'account', 'configurationDigest', 'evidenceDigest']) {
      const item = value.source[key];
      if (item !== null && item !== undefined && (typeof item !== 'string' || item.length < 1 || item.length > 512)) errors.push(`source.${key} is invalid`);
    }
    if (value.source.identity && !SAFE_ID.test(value.source.identity)) errors.push('source.identity is unsafe');
    if (value.source.account && !/^[a-z\d-]{1,39}$/i.test(value.source.account)) errors.push('source.account is unsafe');
    for (const key of ['configurationDigest', 'evidenceDigest']) if (value.source[key] && !DIGEST.test(value.source[key])) errors.push(`source.${key} is invalid`);
  }
  const parsedDate = typeof value.referenceDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.referenceDate)
    ? new Date(`${value.referenceDate}T00:00:00Z`) : null;
  if (!bounded('referenceDate', 10) || !parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== value.referenceDate) errors.push('referenceDate must be a valid YYYY-MM-DD');
  if (!value.artifact || typeof value.artifact !== 'object' || Array.isArray(value.artifact)) errors.push('artifact must be an object');
  else {
    if (!FORMATS.has(value.artifact.format)) errors.push('artifact.format is unsupported');
    if (typeof value.artifact.filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.(svg|html|png)$/.test(value.artifact.filename)) errors.push('artifact.filename is unsafe');
    if (!DIGEST.test(value.artifact.digest || '')) errors.push('artifact.digest must be SHA-256');
    if (!Number.isSafeInteger(value.artifact.bytes) || value.artifact.bytes < 1 || value.artifact.bytes > 12 * 1024 * 1024) errors.push('artifact.bytes exceeds the supported bound');
    if (value.artifact.format && value.artifact.filename && !value.artifact.filename.toLowerCase().endsWith(`.${value.artifact.format}`)) errors.push('artifact filename extension does not match format');
  }
  if (!value.destination || typeof value.destination !== 'object' || Array.isArray(value.destination)) errors.push('destination must be an object');
  else if (typeof value.destination.identity !== 'string' || !SAFE_ID.test(value.destination.identity)) errors.push('destination.identity is invalid');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) errors.push('revision must be a positive integer');
  if (value.generation !== 'success') errors.push('generation must be success');
  if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 64 || value.diagnostics.some(item => typeof item !== 'string' || item.length > 512)) errors.push('diagnostics must be a bounded string list');
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(value)); }
  catch { errors.push('manifest must be serializable'); }
  if (bytes > MAX_PUBLICATION_MANIFEST_BYTES) errors.push('manifest exceeds 16 KiB');
  return { valid: errors.length === 0, diagnostics: errors };
}

export function createPublicationManifest({ source = {}, referenceDate, format, filename, digest, bytes, destination, revision = 1, diagnostics = [] }) {
  const manifest = {
    version: PUBLICATION_MANIFEST_VERSION,
    source: {
      identity: source.identity ?? null,
      account: source.account ?? null,
      configurationDigest: source.configurationDigest ?? null,
      evidenceDigest: source.evidenceDigest ?? null,
    },
    referenceDate,
    artifact: { format, filename, digest, bytes },
    destination: { identity: destination },
    revision,
    generation: 'success',
    diagnostics,
  };
  const result = validatePublicationManifest(manifest);
  if (!result.valid) throw new Error(`Invalid publication manifest: ${result.diagnostics.join('; ')}`);
  return manifest;
}

export function classifyPublicationChange(previous, next) {
  if (!validatePublicationManifest(next).valid || (previous && !validatePublicationManifest(previous).valid)) return 'invalid';
  if (!previous) return 'unknown';
  if ((previous.source.identity && next.source.identity && previous.source.identity !== next.source.identity) || (previous.source.evidenceDigest && next.source.evidenceDigest && previous.source.evidenceDigest !== next.source.evidenceDigest)) return 'source-changed';
  if ((previous.source.configurationDigest && next.source.configurationDigest && previous.source.configurationDigest !== next.source.configurationDigest) || previous.referenceDate !== next.referenceDate) return 'configuration-changed';
  if (previous.artifact.digest !== next.artifact.digest) return 'artifact-changed';
  if (previous.destination.identity !== next.destination.identity || previous.artifact.format !== next.artifact.format || previous.artifact.filename !== next.artifact.filename) return 'artifact-changed';
  if (!previous.source.identity || !next.source.identity || !previous.source.configurationDigest || !next.source.configurationDigest || !previous.source.evidenceDigest || !next.source.evidenceDigest) return 'unknown';
  return 'unchanged';
}

export function validatePublicationArtifact(bytes, { format, filename }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 12 * 1024 * 1024) throw new Error('Artifact is empty or exceeds the 12 MiB publication limit.');
  if (!FORMATS.has(format) || !new RegExp(`\\.${format}$`, 'i').test(filename)) throw new Error('Artifact format and filename do not match.');
  if (format === 'svg') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg\b[\s\S]*<\/svg>\s*$/i.test(text) || /<(?:script|foreignObject)\b/i.test(text) || /\bon[a-z]+\s*=/i.test(text) || /<!doctype/i.test(text)) throw new Error('SVG artifact failed safe structural validation.');
    const root = text.match(/<svg\b([^>]*)>/i)?.[1] || '';
    if (!/\bxmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(root)) throw new Error('SVG artifact is missing the SVG namespace.');
    const dimension = name => {
      const raw = root.match(new RegExp(`\\b${name}=["']([0-9]+(?:\\.[0-9]+)?)["']`, 'i'))?.[1];
      const number = Number(raw);
      return Number.isFinite(number) && number > 0 && number <= 16384;
    };
    const viewBox = root.match(/\bviewBox=["']([^"']+)["']/i)?.[1]?.trim().split(/[ ,]+/).map(Number);
    if (!dimension('width') || !dimension('height') || !viewBox || viewBox.length !== 4 || viewBox.some(number => !Number.isFinite(number) || Math.abs(number) > 1_000_000) || viewBox[2] <= 0 || viewBox[3] <= 0 || viewBox[2] > 1_000_000 || viewBox[3] > 1_000_000) throw new Error('SVG artifact dimensions are missing or outside the supported bounds.');
    if (!/<title\b[^>]*>[\s\S]*?<\/title>/i.test(text) || !/<desc\b[^>]*>[\s\S]*?<\/desc>/i.test(text) || !/\baria-labelledby=["'][^"']+["']/i.test(root)) throw new Error('SVG artifact is missing its accessible title, description, or title reference.');
    const stack = [];
    let rootCount = 0;
    for (const token of text.matchAll(/<\/?([a-zA-Z][\w:.-]*)\b[^>]*?>/g)) {
      const raw = token[0];
      const name = token[1].toLowerCase();
      if (raw.startsWith('</')) {
        if (stack.pop() !== name) throw new Error('SVG artifact has unbalanced elements.');
      } else {
        if (stack.length === 0 && ++rootCount > 1) throw new Error('SVG artifact has more than one root element.');
        if (stack.length === 0 && name !== 'svg') throw new Error('SVG artifact root must be svg.');
        if (!raw.endsWith('/>')) stack.push(name);
      }
    }
    if (stack.length || rootCount !== 1) throw new Error('SVG artifact has unbalanced elements.');
  }
  if (format === 'html') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!/^\s*<!doctype html>/i.test(text) || !/<meta[^>]+http-equiv=["']Content-Security-Policy["']/i.test(text) || text.length > 12 * 1024 * 1024) throw new Error('HTML artifact is missing its document or Content Security Policy.');
  }
  return { bytes: bytes.byteLength, digest: sha256Digest(bytes) };
}
