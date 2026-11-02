import test from 'node:test';
import assert from 'node:assert/strict';
import { mountFocusHistory } from '../src/interactive-focus.mjs';
import { mountFocusHistory as packagedFocusHistory } from '../packages/core/src/interactive-focus.mjs';

// A minimal window: location and history over one URL, plus event dispatch.
function fakeWindow(href) {
  const win = new EventTarget();
  let url = new URL(href);
  const entries = [];
  win.location = { get href() { return url.href; }, get hash() { return url.hash; } };
  win.history = {
    state: null,
    pushState(_state, _title, next) { entries.push(['push', next]); url = new URL(next); },
    replaceState(_state, _title, next) { entries.push(['replace', next]); url = new URL(next); },
  };
  return { win, entries };
}

function fakeRuntime(projects) {
  const calls = [];
  let state = { mode: 'overview', project: null, related: null };
  return {
    calls,
    get focusState() { return state; },
    restoreFocus(value, options) {
      calls.push([value, options]);
      if (!value.project) { state = { mode: 'overview', project: null, related: null }; return !options.invalid; }
      if (!projects.includes(value.project) || (value.related && !projects.includes(value.related))) return false;
      state = { mode: value.related ? 'relationship' : 'project', project: value.project, related: value.related };
      return true;
    },
  };
}

function mount(href, { key, projects = ['a/one', 'a/two'], implementation = mountFocusHistory } = {}) {
  const { win, entries } = fakeWindow(href);
  const runtime = fakeRuntime(projects);
  const history = implementation(new EventTarget(), { key, runtime: () => runtime, win });
  return { win, entries, runtime, history };
}

const base = 'https://example.test/page.html';

test('an oversized hash is unreadable focus state, not an empty overview', () => {
  for (const hash of [`#focus=${'x'.repeat(17000)}`, `#view.focus=a%2Fone&pad=${'y'.repeat(17000)}`]) {
    const key = hash.startsWith('#view') ? 'view.focus' : 'focus';
    const { history, runtime, win, entries } = mount(base + hash, { key });
    assert.deepEqual(history.read(), { project: null, related: null, invalid: true });
    history.restore();
    assert.deepEqual(runtime.calls[0][1], { source: 'history', invalid: true });
    assert.equal(win.location.href, base, 'the oversized hash is removed rather than re-parsed');
    assert.deepEqual(entries.map(entry => entry[0]), ['replace'], 'cleanup replaces the entry instead of adding history');
  }
});

test('focus parameters are validated before restore and invalid ones are removed', () => {
  for (const hash of ['#focus=', '#focus=a%2Fone&focus=a%2Ftwo', '#focus=a%2Fone&focus.with=a%2Ftwo&focus.with=a%2Fone', '#focus.with=a%2Fone', `#focus=${'x'.repeat(513)}`, '#focus=a%01b']) {
    const { history, win } = mount(`${base}#level=2&${hash.slice(1)}`);
    assert.equal(history.read().invalid, true, hash);
    history.restore();
    assert.equal(win.location.hash, '#level=2', `${hash}: unrelated parameters survive cleanup`);
  }
  for (const hash of ['#focus=a%2Fremoved', '#focus=a%2Fone&focus.with=a%2Fremoved', `#focus=${encodeURIComponent('<script>x</script>')}`, '#focus=%E0%A4%A']) {
    const { history, win, runtime } = mount(`${base}#level=2&${hash.slice(1)}`);
    history.restore();
    assert.equal(runtime.focusState.mode, 'overview', hash);
    assert.equal(win.location.hash, '#level=2', `${hash}: unavailable focus is removed`);
  }
});

test('valid focus restores, keeps unrelated parameters, and applies each navigation once', () => {
  const { history, win, runtime, entries } = mount(`${base}#level=2&focus=a%2Fone&focus.with=a%2Ftwo`);
  assert.deepEqual(history.read(), { project: 'a/one', related: 'a/two', invalid: false });
  win.dispatchEvent(new Event('popstate'));
  win.dispatchEvent(new Event('hashchange'));
  assert.equal(runtime.calls.length, 1, 'popstate and hashchange for one navigation apply once');
  assert.equal(runtime.focusState.mode, 'relationship');
  assert.equal(win.location.hash, '#level=2&focus=a%2Fone&focus.with=a%2Ftwo');
  assert.deepEqual(entries, [], 'a valid restore does not rewrite history');
  history.destroy();
});

test('component keys are independent of each other and of the page key', () => {
  const { win } = fakeWindow(`${base}#first.focus=a%2Fone&second.focus=a%2Fremoved&focus=a%2Ftwo`);
  const runtimes = ['first.focus', 'second.focus'].map(key => {
    const runtime = fakeRuntime(['a/one', 'a/two']);
    mountFocusHistory(new EventTarget(), { key, runtime: () => runtime, win }).restore();
    return runtime;
  });
  assert.equal(runtimes[0].focusState.project, 'a/one');
  assert.equal(runtimes[1].focusState.mode, 'overview');
  assert.equal(win.location.hash, '#first.focus=a%2Fone&focus=a%2Ftwo', 'only the failing component parameters are removed');
});

test('package Core mirrors the source focus history', () => {
  assert.equal(packagedFocusHistory.toString(), mountFocusHistory.toString());
  const { history } = mount(`${base}#focus=${'x'.repeat(17000)}`, { implementation: packagedFocusHistory });
  assert.equal(history.read().invalid, true);
});
