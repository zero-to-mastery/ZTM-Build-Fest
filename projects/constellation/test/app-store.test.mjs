import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/app/store.mjs';

test('setOptions records undo steps and redo replays them', () => {
  const store = createStore({ options: { a: 1 } });
  store.setOptions((o) => ({ ...o, a: 2 }), { label: 'Theme' });
  store.setOptions((o) => ({ ...o, a: 3 }), { label: 'Layout' });
  assert.deepEqual(store.history(), { canUndo: true, canRedo: false, undoLabel: 'Layout', redoLabel: null });
  assert.equal(store.undo(), 'Layout');
  assert.equal(store.get().options.a, 2);
  assert.equal(store.undo(), 'Theme');
  assert.equal(store.get().options.a, 1);
  assert.equal(store.undo(), null);
  assert.equal(store.redo(), 'Theme');
  assert.equal(store.get().options.a, 2);
});

test('a new change clears redo', () => {
  const store = createStore({ options: { a: 1 } });
  store.setOptions({ a: 2 });
  store.undo();
  store.setOptions({ a: 5 });
  assert.equal(store.history().canRedo, false);
});

test('repeated changes to one setting within the window coalesce', () => {
  let time = 0;
  const store = createStore({ options: { glow: 0 } }, { now: () => time });
  for (let i = 1; i <= 10; i++) { time += 50; store.setOptions({ glow: i }, { key: 'glow' }); }
  store.undo();
  assert.equal(store.get().options.glow, 0, 'one undo reverts the whole drag');
  time += 5000;
  store.setOptions({ glow: 1 }, { key: 'glow' });
  time += 5000;
  store.setOptions({ glow: 2 }, { key: 'glow' });
  store.undo();
  assert.equal(store.get().options.glow, 1, 'separate drags are separate steps');
});

test('identical options are not recorded', () => {
  const store = createStore({ options: { a: 1 } });
  assert.equal(store.setOptions({ a: 1 }), false);
  assert.equal(store.history().canUndo, false);
});

test('resetOptions clears history; update refuses options', () => {
  const store = createStore({ options: { a: 1 } });
  store.setOptions({ a: 2 });
  store.resetOptions({ a: 9 }, { account: 'octo' });
  assert.equal(store.history().canUndo, false);
  assert.equal(store.get().account, 'octo');
  assert.throws(() => store.update({ options: {} }), /setOptions/);
});

test('subscribers receive the changed keys', () => {
  const store = createStore();
  const seen = [];
  const stop = store.subscribe((state, changed) => seen.push([...changed]));
  store.update({ panel: 'layout' });
  store.update({ panel: 'layout' });
  store.setOptions({ x: 1 });
  stop();
  store.update({ panel: 'look' });
  assert.deepEqual(seen, [['panel'], ['options', 'history']]);
});

test('history is bounded', () => {
  const store = createStore({ options: { n: 0 } });
  for (let i = 1; i <= 150; i++) store.setOptions({ n: i });
  let undos = 0;
  while (store.undo()) undos++;
  assert.equal(undos, 100);
});
