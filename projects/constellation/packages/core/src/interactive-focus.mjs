// Shareable focus: mirrors the interactive runtime's focus state into bounded URL
// hash parameters and restores it on load and Back/Forward. Navigation state stays
// out of config and scenes. Dependency-free: standalone HTML embeds this source.
export function mountFocusHistory(target, { key = 'focus', runtime = () => target.constellation, win = window } = {}) {
  const abort = new AbortController();
  const withKey = `${key}.with`, limit = 512, hashLimit = 16384;
  const valid = value => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
  // A hash beyond the bound is never parsed: it is unreadable, not an empty overview.
  const params = text => { if (text.length > hashLimit) return null; try { return new URLSearchParams(text.slice(1)); } catch { return null; } };
  const invalid = { project: null, related: null, invalid: true };
  function read() {
    const hash = params(win.location.hash);
    if (!hash) return invalid;
    const projects = hash.getAll(key), related = hash.getAll(withKey);
    if (!projects.length) return { project: null, related: null, invalid: related.length > 0 };
    // Duplicate parameters are ambiguous, so they fail closed rather than picking one.
    if (projects.length > 1 || related.length > 1 || !valid(projects[0]) || (related.length && !valid(related[0]))) return invalid;
    return { project: projects[0], related: related[0] ?? null, invalid: false };
  }
  function urlFor(state) {
    // An unreadable hash is dropped whole instead of being carried into the next entry.
    const url = new URL(win.location.href), hash = params(url.hash) || new URLSearchParams();
    hash.delete(key); hash.delete(withKey);
    if (state.project) hash.set(key, state.project);
    if (state.project && state.related) hash.set(withKey, state.related);
    const text = hash.toString();
    url.hash = text ? `#${text}` : '';
    return url.href;
  }
  function write(state, mode) {
    const next = urlFor(state);
    if (next === win.location.href) return;
    try { win.history[mode === 'push' ? 'pushState' : 'replaceState'](win.history.state, '', next); } catch { /* Focus still works where history is unavailable. */ }
  }
  function restore() {
    const state = read(), active = runtime();
    if (!active?.restoreFocus) return;
    // Hash navigation fires both popstate and hashchange; apply each state once.
    const current = active.focusState;
    if (!state.invalid && current && current.project === state.project && (current.related || null) === state.related) return;
    const applied = active.restoreFocus(state, { source: 'history', invalid: state.invalid });
    // An unavailable project leaves an understandable overview and a clean URL.
    if (!applied && (state.project || state.invalid)) write({ project: null }, 'replace');
  }
  target.addEventListener('focus-change', event => {
    const detail = event.detail || {};
    if (detail.source === 'history') return;
    write({ project: detail.projectId || null, related: detail.relatedId || null }, detail.source === 'user' ? 'push' : 'replace');
  }, { signal: abort.signal });
  win.addEventListener('popstate', restore, { signal: abort.signal });
  win.addEventListener('hashchange', restore, { signal: abort.signal });
  return { restore, read, shareURL: () => urlFor(runtime()?.focusState || {}), destroy: () => abort.abort() };
}

// Adds the focus API to a <constellation-view>-style element whose shadow root
// hosts the interactive runtime. Kept in Core so the component entry stays within
// its size budget. URL history is opt-in through the existing `history` attribute
// and a unique element ID, and uses the `<id>.focus` hash parameter.
export function installFocusAPI(View) {
  const runtime = view => view.shadowRoot?.querySelector('main')?.constellation;
  const active = view => {
    const value = runtime(view);
    if (!value) throw new Error('Constellation view is not ready.');
    if (!value.focusProject) throw new Error('The active scene does not support focus.');
    return value;
  };
  for (const [name, method] of Object.entries({
    focusProject(id, options) { return active(this).focusProject(id, options); },
    focusRelationship(projectId, relatedId) { return active(this).focusRelationship(projectId, relatedId); },
    returnToOverview() { return active(this).returnToOverview(); },
  })) Object.defineProperty(View.prototype, name, { value: method, configurable: true, writable: true });
  Object.defineProperty(View.prototype, 'focusState', {
    configurable: true,
    get() { return runtime(this)?.focusState || { mode: 'overview', project: null, related: null, connections: [] }; },
  });
  const connected = View.prototype.connectedCallback, disconnected = View.prototype.disconnectedCallback;
  const histories = new WeakMap();
  const snapshots = new WeakMap(), pending = new WeakMap();
  View.prototype.connectedCallback = function () {
    const snapshot = snapshots.get(this);
    if (snapshot?.project) {
      const controller = new AbortController(); pending.set(this, controller);
      this.addEventListener('scene-ready', () => {
        const value = runtime(this);
        try {
          if (snapshot.related && value?.focusRelationship) value.focusRelationship(snapshot.project, snapshot.related);
          else value?.focusProject?.(snapshot.project, { focus: false });
        } catch { /* A replacement scene may no longer contain the saved identity. */ }
        snapshots.delete(this); pending.delete(this);
      }, { once: true, signal: controller.signal });
    }
    if (this.hasAttribute('history') && this.id && !histories.has(this)) {
      const abort = new AbortController();
      const history = mountFocusHistory(this, { key: `${this.id}.focus`, runtime: () => runtime(this) });
      // Restore after the first render of each connection; later renders keep user focus.
      this.addEventListener('scene-ready', () => history.restore(), { signal: abort.signal });
      histories.set(this, () => { abort.abort(); history.destroy(); });
    }
    return connected?.call(this);
  };
  View.prototype.disconnectedCallback = function () {
    const state = runtime(this)?.focusState;
    if (state?.project) snapshots.set(this, { project: state.project, related: state.related || null });
    pending.get(this)?.abort(); pending.delete(this);
    histories.get(this)?.(); histories.delete(this);
    return disconnected?.call(this);
  };
}
