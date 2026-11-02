import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createScene, renderSceneHTML, renderSceneSVG, serializeScene } from '../src/core-api.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { browser, openBrowser } from '../scripts/browser-harness.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/scene-svg-v2.json', import.meta.url), 'utf8'));
const repositories = structuredClone(fixture.repositories);
repositories[1].topics = ['tools'];
repositories[3].topics = ['data'];
repositories[0].html_url = 'https://github.com/fixture/project-0';
repositories[0].description = 'First project';
const options = {
  ...fixture.cases[0].options,
  projectFamilies: { art: { label: 'Art lab', members: ['fixture/project-0', 'fixture/project-2'] } },
  projectRelationships: [['fixture/project-0', 'fixture/project-1']],
};
const scene = createScene(fixture.account, repositories, options);
const key = async (cdp, name, code = { Enter: 13, Escape: 27 }[name]) => {
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code, ...(name === 'Enter' ? { text: '\r' } : {}) });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
};

async function exportFile(t, value = scene) {
  const dir = await mkdtemp(join(tmpdir(), 'constellation-focus-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'index.html');
  await writeFile(file, renderSceneHTML(value));
  return pathToFileURL(file).href;
}

test('static SVG stays script-free and unaffected by interactive focus', () => {
  const before = serializeScene(scene);
  const svg = renderSceneSVG(scene);
  assert.doesNotMatch(svg, /<script|data-focus|focus-navigation/);
  renderSceneHTML(scene);
  assert.equal(renderSceneSVG(scene), svg, 'HTML export does not change static SVG output');
  assert.equal(serializeScene(scene), before, 'focus data is derived without mutating the scene');
  const html = renderSceneHTML(scene);
  const graph = JSON.parse(html.match(/<script type="application\/json" id="constellation-navigation">([^<]*)<\/script>/)[1]);
  assert.equal(graph.version, 1);
  assert.ok(graph.nodes.every(node => !node.properties?.description && !node.properties?.url), 'the embedded graph carries identities, not payloads');
});

test('project and relationship focus explain evidence and return to the overview by keyboard', { skip: !browser, timeout: 120000 }, async t => {
  const { evaluate, waitFor, errors, cdp } = await openBrowser(t, await exportFile(t));
  await waitFor('Boolean(document.querySelector("main")?.constellation)');
  const project = id => `[...document.querySelectorAll('.repository')].find(group => group.querySelector('.star')?.dataset.repo === ${JSON.stringify(id)})`;
  await evaluate(`${project('fixture/project-0')}.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  assert.equal(await evaluate('document.querySelector("main").dataset.focus'), 'project');
  assert.deepEqual(await evaluate('document.querySelector("main").constellation.focusState'), {
    mode: 'project', project: 'fixture/project-0', related: null, connections: ['fixture/project-2', 'fixture/project-1'],
  });
  // Unrelated projects are dimmed, never removed; arrangement does not change.
  assert.equal(await evaluate(`${project('fixture/project-3')}.hasAttribute('data-related')`), false);
  assert.equal(await evaluate(`getComputedStyle(${project('fixture/project-3')}).display`), 'inline');
  await waitFor(`Number(getComputedStyle(${project('fixture/project-3')}).opacity) < 0.5`); // after the opacity transition
  assert.equal(await evaluate(`${project('fixture/project-2')}.hasAttribute('data-related')`), true);
  // A drawn edge with no supporting evidence is not emphasized.
  assert.equal(await evaluate(`[...document.querySelectorAll('.shared-language[data-related]')].some(edge => [edge.dataset.from, edge.dataset.to].includes('fixture/project-3'))`), false);
  assert.match(await evaluate('document.querySelector("[data-status]").textContent'), /one\. 2 evidence-backed connections\. Press Escape/);
  const buttons = await evaluate('[...document.querySelectorAll("[data-focus-relationship]")].map(button => [button.dataset.focusRelationship, button.textContent, button.getBoundingClientRect().height])');
  assert.deepEqual(buttons.map(item => item[0]), ['fixture/project-2', 'fixture/project-1']);
  assert.equal(buttons[0][1], 'three — family Art lab · Rust · #art #stars');
  assert.equal(buttons[1][1], 'two — linked by author');
  assert.ok(buttons.every(item => item[2] >= 44), 'connection buttons are touch-sized');
  const node = await evaluate(`(() => { const box = ${project('fixture/project-0')}.getBoundingClientRect(); return [box.width, box.height]; })()`);
  assert.ok(node[0] >= 24 && node[1] >= 24, `project hit target is at least 24px (${node})`);
  assert.equal(await evaluate('document.querySelector("[data-details] a")?.href'), 'https://github.com/fixture/project-0');

  // Relationship focus by keyboard; focus moves to the explanation.
  await evaluate('document.querySelector("[data-focus-relationship]").focus()');
  await key(cdp, 'Enter');
  await waitFor('document.querySelector("main").dataset.focus === "relationship"');
  assert.equal(await evaluate('document.activeElement.hasAttribute("data-focus-heading")'), true);
  assert.equal(await evaluate('document.activeElement.textContent'), 'one ↔ three');
  const reasons = await evaluate('[...document.querySelectorAll(".focus-reasons li")].map(item => item.textContent)');
  assert.deepEqual(reasons, [
    'Same project family, defined by the author: Art lab · author-defined',
    'Shared primary language: Rust · repository metadata',
    'Shared repository topics: art, stars · repository metadata',
  ]);
  assert.match(await evaluate('document.querySelector(".focus-note").textContent'), /not verified dependencies/);
  assert.match(await evaluate('document.querySelector("[data-status]").textContent'), /^one and three: Same project family/);
  const emphasized = await evaluate('[...document.querySelectorAll(".shared-language[data-related]")].map(edge => [edge.dataset.from, edge.dataset.to].sort().join(" "))');
  assert.ok(emphasized.length > 0 && emphasized.every(pair => pair === 'fixture/project-0 fixture/project-2'));
  assert.equal(await evaluate(`${project('fixture/project-1')}.hasAttribute('data-related')`), false, 'relationship focus narrows emphasis to one pair');
  assert.match(await evaluate('location.hash'), /^#focus=fixture%2Fproject-0&focus\.with=fixture%2Fproject-2$/);

  // Escape steps back one level at a time and restores keyboard focus.
  await key(cdp, 'Escape');
  assert.equal(await evaluate('document.querySelector("main").dataset.focus'), 'project');
  assert.equal(await evaluate('document.activeElement.dataset.focusRelationship'), 'fixture/project-2');
  await key(cdp, 'Escape');
  assert.equal(await evaluate('document.querySelector("main").dataset.focus'), 'overview');
  assert.equal(await evaluate('document.activeElement.querySelector(".star")?.dataset.repo'), 'fixture/project-0');
  assert.equal(await evaluate('document.querySelector("svg").hasAttribute("data-interactive-selection")'), false);
  assert.equal(await evaluate('document.querySelector("[data-status]").textContent'), 'Returned to the overview.');
  await key(cdp, 'Escape');
  assert.equal(await evaluate('document.activeElement.querySelector(".star")?.dataset.repo'), 'fixture/project-0', 'Escape in the overview does not move or trap focus');

  // Browser history replays focus states.
  await evaluate('history.back()');
  await waitFor('document.querySelector("main").dataset.focus === "project"');
  await evaluate('history.back()');
  await waitFor('document.querySelector("main").dataset.focus === "relationship"');
  assert.equal(await evaluate('document.querySelector("main").constellation.focusState.related'), 'fixture/project-2');
  await evaluate('history.forward()');
  await waitFor('document.querySelector("main").dataset.focus === "project"');

  // Second degree is loaded on demand and lists only bounded, evidence-backed paths.
  await evaluate('document.querySelector("[data-focus-overview]").click()');
  await evaluate(`${project('fixture/project-1')}.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await evaluate('document.querySelector("[data-second-degree] summary").click()');
  await waitFor('document.querySelectorAll("[data-second-degree] li").length > 0');
  assert.equal(await evaluate('document.querySelector("[data-second-degree] li").textContent'), 'three — via one');
  await evaluate('document.querySelector("[data-second-degree] button").click()');
  assert.equal(await evaluate('document.querySelector("main").constellation.focusState.project'), 'fixture/project-2');
  assert.deepEqual(errors, []);
});

test('shared focus links restore safely and fail closed', { skip: !browser, timeout: 120000 }, async t => {
  const href = await exportFile(t, (() => { const value = structuredClone(scene); value.nodes.find(node => node.id === 'fixture/project-2').metadata.description = '<img src=x onerror="window.injected=true">'; return value; })());
  for (const [hash, expected] of [
    ['#focus=fixture%2Fproject-2', { mode: 'project', project: 'fixture/project-2', related: null }],
    ['#focus=fixture%2Fproject-0&focus.with=fixture%2Fproject-1', { mode: 'relationship', project: 'fixture/project-0', related: 'fixture/project-1' }],
  ]) {
    const { evaluate, waitFor, errors } = await openBrowser(t, href + hash);
    await waitFor('Boolean(document.querySelector("main")?.constellation)');
    const state = await evaluate('document.querySelector("main").constellation.focusState');
    assert.deepEqual({ mode: state.mode, project: state.project, related: state.related }, expected);
    assert.equal(await evaluate('Boolean(window.injected) || Boolean(document.querySelector("[data-details] img"))'), false);
    assert.deepEqual(errors, []);
  }
  for (const hash of [
    '#focus=fixture%2Fremoved',
    '#focus=fixture%2Fproject-0&focus.with=fixture%2Fproject-3',
    `#focus=${encodeURIComponent('<script>window.injected=true</script>')}`,
    `#focus=${'x'.repeat(600)}`,
    '#focus.with=fixture%2Fproject-0',
    '#focus=%E0%A4%A',
    '#focus=',
    '#focus=fixture%2Fproject-0&focus=fixture%2Fproject-2',
    '#focus=fixture%2Fproject-0&focus.with=fixture%2Fproject-2&focus.with=fixture%2Fproject-1',
    `#focus=${'x'.repeat(17000)}`,
    `#focus=fixture%2Fproject-2&pad=${'y'.repeat(17000)}`,
  ]) {
    const { evaluate, waitFor, errors } = await openBrowser(t, href + hash);
    await waitFor('Boolean(document.querySelector("main")?.constellation)');
    assert.equal(await evaluate('document.querySelector("main").constellation.focusState.mode'), 'overview', hash.slice(0, 40));
    assert.match(await evaluate('document.querySelector("[data-status]").textContent'), /Showing the overview\./);
    assert.equal(await evaluate('location.hash'), '', 'the invalid share state is removed from the URL');
    assert.equal(await evaluate('Boolean(window.injected) || Boolean(document.querySelector("main script"))'), false);
    assert.deepEqual(errors, []);
  }
  // Unrelated hash parameters survive both a valid restore and an invalid cleanup.
  for (const [hash, mode, after] of [
    ['#keep=1&focus=fixture%2Fproject-2', 'project', '#keep=1&focus=fixture%2Fproject-2'],
    ['#keep=1&focus=fixture%2Fremoved&focus.with=fixture%2Fproject-0', 'overview', '#keep=1'],
  ]) {
    const { evaluate, waitFor, errors } = await openBrowser(t, href + hash);
    await waitFor('Boolean(document.querySelector("main")?.constellation)');
    assert.equal(await evaluate('document.querySelector("main").constellation.focusState.mode'), mode, hash);
    assert.equal(await evaluate('location.hash'), after, hash);
    assert.deepEqual(errors, []);
  }
  // After an oversized link is cleaned, history holds only real focus states.
  const { evaluate, waitFor, errors, cdp } = await openBrowser(t, `${href}#focus=${'x'.repeat(17000)}`);
  await waitFor('Boolean(document.querySelector("main")?.constellation)');
  assert.equal(await evaluate('location.hash'), '');
  const length = await evaluate('history.length');
  // User-activated clicks, so Chromium keeps the entries for Back/Forward.
  const click = id => cdp('Runtime.evaluate', { userGesture: true, expression: `[...document.querySelectorAll('.repository')].find(group => group.querySelector('.star')?.dataset.repo === ${JSON.stringify(id)}).dispatchEvent(new MouseEvent('click', { bubbles: true }))` });
  await click('fixture/project-1');
  await click('fixture/project-2');
  assert.equal(await evaluate('location.hash'), '#focus=fixture%2Fproject-2');
  assert.equal(await evaluate('history.length'), length + 2, 'cleanup replaced its entry; each user focus change added one');
  await evaluate('history.back()');
  await waitFor('document.querySelector("main").constellation.focusState.project === "fixture/project-1"');
  assert.equal(await evaluate('location.hash'), '#focus=fixture%2Fproject-1');
  await evaluate('history.back()');
  await waitFor('document.querySelector("main").constellation.focusState.mode === "overview"');
  assert.equal(await evaluate('location.hash'), '', 'Back never returns to the oversized link');
  await evaluate('history.forward()');
  await waitFor('document.querySelector("main").constellation.focusState.project === "fixture/project-1"');
  assert.equal(await evaluate('location.hash'), '#focus=fixture%2Fproject-1');
  assert.deepEqual(errors, []);
});

test('reduced motion removes focus transitions', { skip: !browser, timeout: 120000 }, async t => {
  const { evaluate, waitFor, cdp } = await openBrowser(t, await exportFile(t));
  await waitFor('Boolean(document.querySelector("main")?.constellation)');
  assert.notEqual(await evaluate('getComputedStyle(document.querySelector(".repository")).transitionDuration'), '0s');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".repository")).transitionDuration'), '0s');
});

test('<constellation-view> exposes focus, events, history and lifecycle cleanup', { skip: !browser, timeout: 120000 }, async t => {
  const server = createPreviewServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { evaluate, waitFor, errors, cdp } = await openBrowser(t, `${origin}/examples/web-component.html`);
  await waitFor('Boolean(document.querySelector("#view")?.shadowRoot?.querySelector("main")?.constellation)');
  const setup = `(async () => {
    const view = document.createElement('constellation-view');
    view.id = 'focused'; view.setAttribute('history', '');
    window.focusEvents = [];
    view.addEventListener('focus-change', event => window.focusEvents.push(event.detail));
    view.records = ['compiler', 'runtime', 'studio', 'notes'].map((name, i) => ({ name, full_name: 'example/' + name, language: ['Rust', 'Rust', 'TypeScript', 'Go'][i], topics: i < 3 ? ['wasm'] : [], html_url: 'https://github.com/example/' + name }));
    document.body.append(view);
    await view.setConfig({ version: 7, account: 'example', options: { referenceDate: '2026-09-01T00:00:00Z', projectFamilies: { tools: { label: 'Tools', members: ['example/compiler', 'example/runtime'] } }, projectRelationships: [['example/studio', 'example/notes']] } });
    return true;
  })()`;
  await evaluate(setup);
  await waitFor('Boolean(document.querySelector("#focused").shadowRoot.querySelector("main")?.constellation)');
  assert.deepEqual(await evaluate('document.querySelector("#focused").focusState'), { mode: 'overview', project: null, related: null, connections: [] });
  await evaluate('document.querySelector("#focused").focusProject("example/compiler")');
  const state = await evaluate('document.querySelector("#focused").focusState');
  assert.equal(state.mode, 'project');
  assert.deepEqual(state.connections, ['example/runtime', 'example/studio']);
  assert.match(await evaluate('location.hash'), /focused\.focus=example%2Fcompiler/);
  await evaluate('document.querySelector("#focused").focusRelationship("example/compiler", "example/runtime")');
  assert.match(await evaluate('document.querySelector("#focused").shadowRoot.querySelector(".focus-reasons").textContent'), /Same project family, defined by the author: Tools/);
  assert.match(await evaluate(`(() => { try { document.querySelector('#focused').focusRelationship('example/compiler', 'example/notes'); return 'no error'; } catch (error) { return error.message; } })()`), /No evidence-backed relationship/);
  assert.deepEqual(await evaluate('window.focusEvents.map(event => [event.mode, event.projectId, event.relatedId, event.source])'), [
    ['project', 'example/compiler', null, 'api'],
    ['relationship', 'example/compiler', 'example/runtime', 'api'],
  ]);
  // Keyboard Escape inside the shadow root steps back through focus levels.
  await evaluate('document.querySelector("#focused").shadowRoot.querySelector("[data-focus-heading], [data-focus-project]").focus()');
  await key(cdp, 'Escape');
  assert.equal(await evaluate('document.querySelector("#focused").focusState.mode'), 'project');
  await key(cdp, 'Escape');
  assert.equal(await evaluate('document.querySelector("#focused").focusState.mode'), 'overview');
  // The view's own selection API and events remain compatible.
  await evaluate('document.querySelector("#focused").selectNode("example/studio", { focus: false })');
  assert.equal(await evaluate('document.querySelector("#focused").selection.start'), 'example/studio');
  assert.deepEqual(await evaluate('document.querySelector("#focused").focusState.connections'), ['example/compiler', 'example/notes', 'example/runtime']);
  await evaluate('document.querySelector("#focused").returnToOverview()');
  assert.equal(await evaluate('location.hash'), '');
  // Detached views stop following the URL; reattached views follow it again.
  await evaluate('window.detachedView = document.querySelector("#focused"); detachedView.remove(); location.hash = "focused.focus=example%2Fruntime";');
  await new Promise(resolve => setTimeout(resolve, 100));
  await evaluate('document.body.append(detachedView)');
  await waitFor('document.querySelector("#focused").focusState.project === "example/runtime"');
  await evaluate('history.back()');
  await waitFor('document.querySelector("#focused").focusState.mode === "overview"');
  // Views without the history attribute never touch the URL.
  await evaluate('history.replaceState(null, "", location.pathname); document.querySelector("#view").focusProject("example/compiler")');
  assert.equal(await evaluate('location.hash'), '');
  assert.equal(await evaluate('document.querySelector("#view").focusState.project'), 'example/compiler');
  assert.deepEqual(errors, []);
});

test('multiple <constellation-view> elements keep independent focus URL state and fail closed', { skip: !browser, timeout: 120000 }, async t => {
  const server = createPreviewServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { evaluate, waitFor, errors } = await openBrowser(t, `${origin}/examples/web-component.html`);
  await waitFor('Boolean(document.querySelector("#view")?.shadowRoot?.querySelector("main")?.constellation)');
  await evaluate(`(async () => {
    history.replaceState(null, '', '#alpha.focus=example%2Fcompiler&beta.focus=example%2Fremoved&keep=1');
    for (const id of ['alpha', 'beta']) {
      const view = document.createElement('constellation-view');
      view.id = id; view.setAttribute('history', '');
      view.records = ['compiler', 'runtime', 'studio'].map((name, i) => ({ name, full_name: 'example/' + name, language: ['Rust', 'Rust', 'Go'][i], topics: ['wasm'], html_url: 'https://github.com/example/' + name }));
      document.body.append(view);
      await view.setConfig({ version: 7, account: 'example', options: { referenceDate: '2026-09-01T00:00:00Z' } });
    }
    return true;
  })()`);
  const state = id => evaluate(`document.querySelector('#${id}').focusState`);
  await waitFor('document.querySelector("#alpha").focusState.project === "example/compiler"');
  const params = () => evaluate('[...new URLSearchParams(location.hash.slice(1))].map(pair => pair.join("=")).sort()');
  await waitFor('Boolean(document.querySelector("#beta").shadowRoot.querySelector("main")?.constellation) && !location.hash.includes("beta.focus")');
  assert.deepEqual(await params(), ['alpha.focus=example/compiler', 'keep=1']);
  assert.equal((await state('beta')).mode, 'overview', 'a removed project in one view does not affect the other');
  // Focus in one view never rewrites the other's parameter.
  await evaluate('document.querySelector("#beta").focusProject("example/studio")');
  assert.deepEqual(await params(), ['alpha.focus=example/compiler', 'beta.focus=example/studio', 'keep=1']);
  assert.equal((await state('alpha')).project, 'example/compiler');
  // An oversized component-prefixed request fails closed for every view and clears the hash.
  await evaluate(`location.hash = 'alpha.focus=' + 'x'.repeat(17000)`);
  await waitFor('location.hash === ""');
  await waitFor('document.querySelector("#alpha").focusState.mode === "overview" && document.querySelector("#beta").focusState.mode === "overview"');
  assert.match(await evaluate('document.querySelector("#alpha").shadowRoot.querySelector("[data-status]").textContent'), /Showing the overview\./);
  // Back returns to the last real state, which restores both views.
  await evaluate('history.back()');
  await waitFor('document.querySelector("#beta").focusState.project === "example/studio" && document.querySelector("#alpha").focusState.project === "example/compiler"');
  assert.deepEqual(await params(), ['alpha.focus=example/compiler', 'beta.focus=example/studio', 'keep=1']);
  assert.deepEqual(errors, []);
});
