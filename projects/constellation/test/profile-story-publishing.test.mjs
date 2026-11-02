import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScene } from '../src/constellation.mjs';
import { semanticGraphFromScene } from '../src/semantic-graph.mjs';
import { generateStoryCandidates, recommendStoryCandidate } from '../src/story-candidates.mjs';
import { renderProfileStorySVG } from '../src/profile-story-export.mjs';
import { renderWorkflow } from '../src/export.mjs';

test('workflow story inputs and CLI SVG match both actual Profile Story exports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'constellation-story-publish-'));
  try {
    const repositories = Array.from({ length: 16 }, (_, i) => ({
      name: `r${i}`, full_name: `alice/r${i}`, language: i % 2 ? 'Rust' : 'HTML',
      topics: [i % 2 ? 'tools' : 'web'], created_at: '2020-01-01',
      updated_at: '2026-10-01', private: false,
    }));
    const fixture = join(directory, 'repositories.json');
    await writeFile(fixture, JSON.stringify(repositories));
    const options = {
      layout: 'atlas', maxRepos: 100, showOther: true, seedMode: 'account',
      referenceDate: '2026-10-11T00:00:00Z', arrangement: 'rings',
      projectShowcase: { 'alice/r0': { role: 'featured', priority: 1 } },
      labelPositions: { 'alice/r0': { x: 400, y: 200 } },
      starPositions: { 'alice/r0': { x: 400, y: 190 } },
    };
    const config = join(directory, 'config.json');
    await writeFile(config, JSON.stringify(options));
    const scene = createScene('alice', repositories, { ...options, accountData: { login: 'alice', type: 'User' }, generatedAt: options.referenceDate });
    const candidates = generateStoryCandidates(semanticGraphFromScene(scene), scene.presentation.options);
    const candidate = recommendStoryCandidate(candidates);
    for (const width of [480, 900]) {
      const expected = renderProfileStorySVG(candidate, width);
      const output = join(directory, `${width}.svg`);
      execFileSync(process.execPath, ['src/cli.mjs', '--username', 'alice', '--fixture', fixture, '--config', config, '--story', 'auto', '--target-width', String(width), '--reference-date', options.referenceDate, '--output', output], { encoding: 'utf8' });
      const actual = await readFile(output, 'utf8');
      assert.equal(actual.trim(), expected.trim());
      assert.match(actual, /aria-labelledby=/);
      assert.match(actual, /<desc/);
      assert.equal((actual.match(/<circle class="star[^"]*"[^>]*data-kind="repository"/g) || []).length, 12);
    }
    const workflow = renderWorkflow('alice', options, { story: 'auto', targetWidth: 480, sourceAccount: true });
    assert.match(workflow, /story: 'auto'/);
    assert.match(workflow, /target-width: '480'/);
    assert.match(workflow, /username: 'alice'/);
    assert.throws(() => renderWorkflow('alice', {}, { story: 'code', targetWidth: 480 }));
    assert.throws(() => renderProfileStorySVG(candidate, 100));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
