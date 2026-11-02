import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { browser, openBrowser } from '../scripts/browser-harness.mjs';
import { createScene } from '../src/constellation.mjs';
import { semanticGraphFromScene } from '../src/semantic-graph.mjs';
import { generateStoryCandidates } from '../src/story-candidates.mjs';
import { renderSceneSVG } from '../src/renderer-svg.mjs';
import { labelOwnershipRecords, labelOwnershipShowcase as ownershipShowcase } from './fixtures/story-label-ownership.mjs';

test('static Profile Story labels, pathways, and legends fit in real 480px and 900px browsers', {
  skip: !browser && 'Set CONSTELLATION_BROWSER to a Chromium executable.',
  timeout: 120000,
}, async t => {
  const records = Array.from({ length: 12 }, (_, index) => ({
    full_name: `visual/story-${String(index).padStart(2, '0')}`,
    name: index < 3 ? `Featured system ${index}` : `Long project title ${index}`,
    language: ['Rust', 'JavaScript', 'Python'][index % 3],
    topics: [`area-${index % 3}`, `tools-${index % 2}`],
  }));
  const showcase = Object.fromEntries(records.slice(0, 6).map((repo, index) => [repo.full_name, { role: index < 3 ? 'featured' : 'supporting', priority: index + 1 }]));
  const graph = semanticGraphFromScene(createScene('visual', records, {
    nodeMode: 'repositories', showOther: true, projectShowcase: showcase,
    seed: 'story-clarity-browser', theme: 'light',
  }));
  const candidate = generateStoryCandidates(graph, { projectShowcase: showcase, seed: 'story-clarity-browser' }).find(item => item.id === 'projects');
  const responses = new Map();
  for (const width of [480, 900]) for (const theme of ['light', 'midnight']) {
    const scene = { ...candidate.scene, presentation: { ...candidate.scene.presentation, options: { ...candidate.scene.presentation.options, exportProfile: 'readme', theme } } };
    const svg = renderSceneSVG(scene, { targetWidth: width });
    assert.doesNotMatch(svg, /<script\b/i, 'essential meaning is static SVG');
    responses.set(`/${width}/${theme}`, svg);
  }
  const server = createServer((request, response) => {
    const svg = responses.get(new URL(request.url, 'http://localhost').pathname);
    response.writeHead(svg ? 200 : 404, { 'content-type': 'image/svg+xml; charset=utf-8' });
    response.end(svg || 'missing');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { cdp, evaluate, errors } = await openBrowser(t, `${base}/480/light`);
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  const browserData = [];
  for (const width of [480, 900]) for (const theme of ['light', 'midnight']) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: `${base}/${width}/${theme}` });
    for (let i = 0; i < 100; i++) {
      if (await evaluate('Boolean(document.querySelector("svg")?.querySelector(".star"))')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const report = await evaluate(`(() => {
      const svg=document.querySelector('svg');
      if (!svg) return null;
      const rect=svg.getBoundingClientRect();
      const labels=[...svg.querySelectorAll('text.repo-label')].filter(el=>getComputedStyle(el).display!=='none').map(el=>({id:el.dataset.repo, role:el.dataset.role||'', r:(()=>{const b=el.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height}})()}));
      const featured=labels.filter(x=>x.role==='featured');
      const overlaps=[];
      for(let i=0;i<featured.length;i++)for(let j=i+1;j<featured.length;j++){const a=featured[i].r,b=featured[j].r;if(a.x<b.right&&b.x<a.right&&a.y<b.bottom&&b.y<a.bottom)overlaps.push([featured[i].id,featured[j].id])}
      const legend=svg.querySelector('.story-relationship-legend')?.getBoundingClientRect();
      const paths=[...svg.querySelectorAll('path[data-relationship-type]')];
      return {width:rect.width,height:rect.height,projectCount:svg.querySelectorAll('circle.star[data-kind="repository"]').length,labels,featuredCount:featured.length,featuredOverlaps:overlaps,labelsInside:labels.every(x=>x.r.x>=rect.x-1&&x.r.right<=rect.right+1&&x.r.y>=rect.y-1&&x.r.bottom<=rect.bottom+1),legendInside:!legend||(legend.left>=rect.left-1&&legend.right<=rect.right+1&&legend.top>=rect.top-1&&legend.bottom<=rect.bottom+1),relationshipTypes:[...new Set(paths.map(x=>x.dataset.relationshipType))],styles:[...new Set(paths.map(x=>getComputedStyle(x).strokeDasharray))],pathCount:paths.length,hasPathTitles:paths.every(x=>!!x.querySelector('title')?.textContent)};
    })()`);
    assert.ok(report, `SVG did not load for ${width}px ${theme}`);
    assert.equal(report.width, width);
    assert.equal(report.projectCount, 12, 'the bounded story keeps project identities');
    assert.ok(report.featuredCount >= 3, 'featured labels remain visible');
    assert.deepEqual(report.featuredOverlaps, [], 'featured labels do not collide');
    assert.equal(report.labelsInside, true, 'visible project labels fit in the SVG viewport');
    assert.equal(report.legendInside, true, 'relationship legend stays in the SVG viewport');
    assert.ok(report.pathCount > 0 && report.hasPathTitles, 'every pathway keeps accessible evidence titles');
    if (report.relationshipTypes.length > 1) assert.ok(report.styles.length > 1, 'relationship types use distinct line patterns');
    browserData.push({ width, theme, report });
  }
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reduced = await evaluate('({labels:document.querySelectorAll("svg text.repo-label").length,paths:document.querySelectorAll("svg path[data-relationship-type]").length})');
  assert.ok(reduced.labels >= 3 && reduced.paths > 0, 'reduced motion preserves static story information');
  assert.deepEqual(errors, []);
  assert.equal(browserData.length, 4);
});

test('compact label ownership survives real 480px and 900px browser rendering', {
  skip: !browser && 'Set CONSTELLATION_BROWSER to a Chromium executable.',
  timeout: 120000,
}, async t => {
  const referenceDate = '2026-10-01T00:00:00Z';
  const manual = { 'owner/project-02': { x: 600, y: 120 }, 'owner/project-10': { x: 150, y: 420 } };
  const hiddenLabels = ['owner/project-00'];
  const candidateFor = records => {
    const graph = semanticGraphFromScene(createScene('owner', records, { nodeMode: 'repositories', showOther: true, projectShowcase: ownershipShowcase, seed: 'ownership-browser', theme: 'light', referenceDate }));
    return generateStoryCandidates(graph, { projectShowcase: ownershipShowcase, seed: 'ownership-browser', referenceDate, labelPositions: manual, hiddenLabels }).find(item => item.id === 'projects');
  };
  const candidate = candidateFor(labelOwnershipRecords);
  assert.equal(candidateFor([...labelOwnershipRecords].reverse()).sceneFingerprint, candidate.sceneFingerprint, 'reordered inputs select the same story');
  const responses = new Map();
  for (const width of [480, 900]) for (const theme of ['light', 'midnight']) {
    const scene = { ...candidate.scene, presentation: { ...candidate.scene.presentation, options: { ...candidate.scene.presentation.options, exportProfile: 'readme', theme } } };
    responses.set(`/${width}/${theme}`, renderSceneSVG(scene, { targetWidth: width }));
  }
  const server = createServer((request, response) => {
    const svg = responses.get(new URL(request.url, 'http://localhost').pathname);
    response.writeHead(svg ? 200 : 404, { 'content-type': 'image/svg+xml; charset=utf-8' });
    response.end(svg || 'missing');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { cdp, evaluate, errors } = await openBrowser(t, `${base}/480/light`);
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  const identities = new Map();
  for (const width of [480, 900]) for (const theme of ['light', 'midnight']) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: `${base}/${width}/${theme}` });
    // Measure only the committed, fully parsed document after fonts settle.
    for (let i = 0; i < 100; i++) {
      if (await evaluate(`location.pathname==='/${width}/${theme}'&&document.readyState==='complete'&&Boolean(document.querySelector('.star'))`)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await evaluate('document.fonts.ready.then(() => true)');
    const report = await evaluate(`(() => {
      const svg=document.documentElement;
      if (svg.localName!=='svg' || document.querySelector('parsererror')) return null;
      const rect=svg.getBoundingClientRect();
      const inside=b=>b.left>=rect.left-1&&b.right<=rect.right+1&&b.top>=rect.top-1&&b.bottom<=rect.bottom+1;
      const labels=[...svg.querySelectorAll('text.repo-label')].map(el=>{const b=el.getBoundingClientRect();return {box:[b.left-rect.left,b.top-rect.top,rect.right-b.right,rect.bottom-b.bottom].map(Math.round),id:el.dataset.repo,role:el.dataset.role||'',shown:getComputedStyle(el).display!=='none'&&b.width>0&&b.height>0,inside:inside(b)}});
      const legend=svg.querySelector('.story-relationship-legend');
      const paths=[...svg.querySelectorAll('path[data-relationship-type]')];
      const stars=[...svg.querySelectorAll('circle.star[data-kind="repository"]')];
      return {width:rect.width,labels,projects:stars.map(x=>x.dataset.repo).sort(),
        starTitles:stars.every(x=>!!x.closest('g')?.querySelector('title')?.textContent),
        title:!!svg.querySelector('title')?.textContent,legendInside:!legend||inside(legend.getBoundingClientRect()),
        pathCount:paths.length,pathTitles:paths.every(x=>!!x.querySelector('title')?.textContent)};
    })()`);
    assert.ok(report, `${width}px ${theme} is valid SVG`);
    assert.equal(report.width, width);
    const shown = new Set(report.labels.filter(x => x.shown).map(x => x.id));
    for (const id of Object.keys(manual)) assert.ok(shown.has(id), `${width}px ${theme}: manual label ${id} is present`);
    for (const id of hiddenLabels) assert.equal(shown.has(id), false, `${width}px ${theme}: ${id} stays hidden`);
    const automatic = report.labels.filter(x => x.shown && !Object.hasOwn(manual, x.id));
    assert.deepEqual(automatic.filter(x => !x.inside).map(x => `${x.id} margins ${x.box.join(',')}`), [], `${width}px ${theme}: automatic labels stay inside the viewBox`);
    assert.equal(report.legendInside, true, `${width}px ${theme}: legend stays inside the viewBox`);
    const rankedAutomatic = Object.keys(ownershipShowcase).filter(id => !Object.hasOwn(manual, id) && !hiddenLabels.includes(id));
    const ordinaryShown = automatic.filter(x => !ownershipShowcase[x.id]);
    if (width === 480) {
      assert.ok(automatic.length <= 8, 'compact budget bounds automatic labels only');
      // Seven featured/supporting automatic labels leave one slot; ordinary IDs fill it in stable order.
      assert.ok(rankedAutomatic.length + ordinaryShown.length <= 8, `${width}px ${theme}: featured and supporting labels outrank ordinary labels`);
      assert.equal(shown.has('owner/project-11'), false, 'ordinary labels beyond the budget are automatically suppressed');
    }
    assert.ok(Object.entries(ownershipShowcase).filter(([id, item]) => item.role === 'featured' && !hiddenLabels.includes(id)).some(([id]) => shown.has(id)), 'featured labels remain visible');
    assert.equal(report.projects.length, 12, `${width}px ${theme}: every selected project node remains`);
    assert.equal(report.starTitles && report.title, true, 'accessibility titles remain');
    assert.ok(report.pathCount > 0 && report.pathTitles, 'relationship evidence titles remain');
    identities.set(`${width}/${theme}`, report.projects.join('|'));
  }
  assert.equal(new Set(identities.values()).size, 1, 'project identities match across widths and themes');
  assert.deepEqual(errors, []);
});
