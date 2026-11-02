// The Studio's single source of truth. Views read state and call commands;
// they never read the DOM back as state. Configuration changes are recorded
// for Undo/Redo; everything else (screen, status, selection) is not.

const HISTORY_LIMIT = 100;
// Successive changes to the same setting within this window (a slider drag)
// collapse into one Undo step.
const COALESCE_MS = 700;

export function createStore(initial = {}, { now = () => Date.now() } = {}) {
  let state = {
    screen: 'home',
    account: null,
    sample: false,
    repositories: [],
    profile: null,
    options: {},
    panel: 'look',
    selected: null,
    dialog: null,
    busy: false,
    status: null,
    render: null,
    // The star being moved with the keyboard (move mode), or null.
    moving: null,
    ...initial,
  };
  const past = [];
  const future = [];
  let lastKey = null;
  let lastAt = 0;
  const listeners = new Set();

  const emit = (changed) => {
    for (const listener of [...listeners]) listener(state, changed);
  };

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** UI state only. Never use for configuration options. */
    update(patch) {
      if ('options' in patch) throw new Error('Use setOptions to change configuration.');
      const changed = Object.keys(patch).filter((key) => state[key] !== patch[key]);
      if (!changed.length) return;
      state = { ...state, ...patch };
      emit(new Set(changed));
    },
    /**
     * Change configuration options and record an Undo step.
     * next: a new options object, or a function (options) => options.
     * key: identifies the setting so slider drags coalesce into one step.
     */
    setOptions(next, { key = null, label = 'Change' } = {}) {
      const before = state.options;
      const after = typeof next === 'function' ? next(structuredClone(before)) : next;
      if (!after || typeof after !== 'object') throw new Error('Options must be an object.');
      if (JSON.stringify(after) === JSON.stringify(before)) return false;
      const time = now();
      const coalesce = key !== null && key === lastKey && time - lastAt < COALESCE_MS && past.length;
      if (!coalesce) {
        past.push({ options: before, label });
        if (past.length > HISTORY_LIMIT) past.shift();
      }
      future.length = 0;
      lastKey = key;
      lastAt = time;
      state = { ...state, options: after };
      emit(new Set(['options', 'history']));
      return true;
    },
    /** Replace options without an Undo step (loading an account, opening a saved design). */
    resetOptions(options, patch = {}) {
      past.length = 0;
      future.length = 0;
      lastKey = null;
      state = { ...state, ...patch, options };
      // 'reset' tells listeners this was a wholesale replacement, not an edit.
      emit(new Set(['options', 'history', 'reset', ...Object.keys(patch)]));
    },
    undo() {
      const step = past.pop();
      if (!step) return null;
      future.push({ options: state.options, label: step.label });
      lastKey = null;
      state = { ...state, options: step.options };
      emit(new Set(['options', 'history']));
      return step.label;
    },
    redo() {
      const step = future.pop();
      if (!step) return null;
      past.push({ options: state.options, label: step.label });
      lastKey = null;
      state = { ...state, options: step.options };
      emit(new Set(['options', 'history']));
      return step.label;
    },
    history: () => ({
      canUndo: past.length > 0,
      canRedo: future.length > 0,
      undoLabel: past.at(-1)?.label ?? null,
      redoLabel: future.at(-1)?.label ?? null,
    }),
  };
}
