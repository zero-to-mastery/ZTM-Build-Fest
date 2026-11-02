import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPublicationChange, createPublicationManifest, sha256Digest,
  validatePublicationArtifact, validatePublicationManifest,
} from '../src/publication-integrity.mjs';

function manifest(overrides = {}) {
  const content = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  return createPublicationManifest({
    source: { identity: 'octocat/octocat@abcdef0123456', configurationDigest: sha256Digest('{}'), evidenceDigest: sha256Digest('evidence'), account: 'octocat' },
    referenceDate: '2026-10-11', format: 'svg', filename: 'constellation.svg',
    digest: sha256Digest(content), bytes: content.length, destination: 'octocat/octocat@output', ...overrides,
  });
}

test('publication manifest is bounded, versioned, and keeps identity categories distinct', () => {
  const value = manifest();
  assert.equal(validatePublicationManifest(value).valid, true);
  assert.equal(value.source.identity, 'octocat/octocat@abcdef0123456');
  assert.equal(value.destination.identity, 'octocat/octocat@output');
  assert.equal(validatePublicationManifest({ ...value, version: 99 }).valid, false);
  assert.equal(validatePublicationManifest({ ...value, artifact: { ...value.artifact, filename: '../secret.svg' } }).valid, false);
  assert.equal(validatePublicationManifest({ ...value, artifact: { ...value.artifact, bytes: 13 * 1024 * 1024 } }).valid, false);
});

test('change classification distinguishes source, config, output, invalid and unknown states', () => {
  const base = manifest();
  assert.equal(classifyPublicationChange(base, manifest()), 'unchanged');
  assert.equal(classifyPublicationChange(base, manifest({ source: { ...base.source, identity: 'octocat/octocat@fedcba0123456' } })), 'source-changed');
  assert.equal(classifyPublicationChange(base, manifest({ source: { ...base.source, configurationDigest: sha256Digest('other') } })), 'configuration-changed');
  assert.equal(classifyPublicationChange(base, manifest({ digest: sha256Digest('new artifact') })), 'artifact-changed');
  assert.equal(classifyPublicationChange(base, { ...base, version: 5 }), 'invalid');
  const incomplete = manifest({ source: { identity: null, configurationDigest: null, evidenceDigest: null, account: null } });
  assert.equal(classifyPublicationChange(incomplete, incomplete), 'unknown');
});

test('artifact validation rejects malformed, executable, oversized and policy-free output', () => {
  assert.throws(() => validatePublicationArtifact(Buffer.from('<svg><g></svg>'), { format: 'svg', filename: 'x.svg' }));
  assert.throws(() => validatePublicationArtifact(Buffer.from('<svg><script>alert(1)</script></svg>'), { format: 'svg', filename: 'x.svg' }));
  assert.throws(() => validatePublicationArtifact(Buffer.from('<!doctype html><html></html>'), { format: 'html', filename: 'x.html' }));
  assert.throws(() => validatePublicationArtifact(Buffer.alloc(12 * 1024 * 1024 + 1), { format: 'svg', filename: 'x.svg' }));
  const accessible = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560" viewBox="0 0 900 560" role="img" aria-labelledby="title description"><title id="title">Sky</title><desc id="description">Projects</desc><g/></svg>';
  assert.equal(validatePublicationArtifact(Buffer.from(accessible), { format: 'svg', filename: 'x.svg' }).bytes, Buffer.byteLength(accessible));
});
