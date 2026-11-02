import { createAtlasState, createAtlasHistory, navigateAtlasToGroup, navigateAtlasToProject, navigateAtlasToStructure, atlasBreadcrumbs, resolveAtlasContext, serializeAtlasState, parseAtlasState, semanticGraphFingerprint } from '@constellation/core';
import { parseSemanticGraph, serializeSemanticGraph } from '@constellation/core';

export class AtlasNavigation {
  #graph = null; #state = null; #history = null; #projectGraph = null;
  get state() { return this.#state && structuredClone(this.#state); }
  get graph() { return this.#graph; }
  get projectGraph() { return this.#projectGraph; }
  get breadcrumbs() { return this.#graph && this.#state ? atlasBreadcrumbs(this.#state, this.#graph, this.#projectGraph) : []; }
  get context() { return this.#graph && this.#state ? resolveAtlasContext(this.#state, this.#graph, this.#projectGraph) : null; }
  get canBack() { return Boolean(this.#history?.canBack); }
  get canForward() { return Boolean(this.#history?.canForward); }
  get shareState() { return this.#state ? serializeAtlasState(this.#state) : null; }
  setGraph(graph) {
    const next = graph?.subject?.kind === 'developer' ? graph : null;
    const developerChanged = next && this.#graph && next.subject.id !== this.#graph.subject.id;
    const sameTruth = next && this.#graph && semanticGraphFingerprint(next) === semanticGraphFingerprint(this.#graph);
    this.#graph = next;
    if (!next) { this.#state = null; this.#history = null; this.#projectGraph = null; return; }
    if (!this.#state || !this.#history) {
      this.#state = createAtlasState(next); this.#history = createAtlasHistory(this.#state); this.#projectGraph = null; return;
    }
    if (developerChanged) {
      this.#state = createAtlasState(next); this.#history = createAtlasHistory(this.#state); this.#projectGraph = null;
      return;
    }
    if (!sameTruth) this.#projectGraph = null;
    this.#state = this.#history.reconcile(this.#state, next, this.#projectGraph);
  }
  navigateGroup(id, render, changed) { return this.#commit(navigateAtlasToGroup(this.#state, this.#graph, id), render, changed); }
  navigateProject(id, render, changed) { return this.#commit(navigateAtlasToProject(this.#state, this.#graph, id), render, changed); }
  navigateBreadcrumbs(crumbs, render, changed) {
    let next = createAtlasState(this.#graph);
    for (const item of crumbs.slice(1)) next = item.level === 'group' ? navigateAtlasToGroup(next, this.#graph, item.id)
      : item.level === 'project' ? navigateAtlasToProject(next, this.#graph, item.id)
        : item.level === 'structure' ? navigateAtlasToStructure(next, this.#graph, this.#projectGraph, item.id) : next;
    return this.#commit(next, render, changed);
  }
  navigateStructure(graph, nodeId, render, changed) {
    const checked = parseSemanticGraph(serializeSemanticGraph(graph));
    const next = navigateAtlasToStructure(this.#state, this.#graph, checked, nodeId), previous = this.#projectGraph;
    this.#projectGraph = checked;
    const result = this.#commit(next, render, changed);
    if (!result) this.#projectGraph = previous;
    return result;
  }
  loadShare(value, graph, render, changed) {
    const checked = graph ? parseSemanticGraph(serializeSemanticGraph(graph)) : null;
    const next = parseAtlasState(value, this.#graph, checked), previous = this.#projectGraph;
    this.#projectGraph = checked;
    const result = this.#commit(next, render, changed);
    if (!result) this.#projectGraph = previous;
    return result;
  }
  back(render, changed) { return this.#travel('back', render, changed); }
  forward(render, changed) { return this.#travel('forward', render, changed); }
  #travel(direction, render, changed) {
    if (!this.#history || (direction === 'back' ? !this.#history.canBack : !this.#history.canForward)) return false;
    const previous = this.#state; let succeeded = false;
    const target = this.#history.transact(direction, candidate => {
      this.#state = candidate;
      try { succeeded = render() !== false; return succeeded; }
      catch { succeeded = false; return false; }
      finally { if (!succeeded) this.#state = previous; }
    });
    if (!target) return false;
    changed?.({ state: this.state, breadcrumbs: this.breadcrumbs, context: this.context, shareState: this.shareState });
    return true;
  }
  #commit(next, render, changed, push = true) {
    if (!this.#graph || !next) return false;
    const previous = this.#state; this.#state = next;
    let rendered = false;
    try { rendered = render() !== false; } catch { rendered = false; }
    if (!rendered) { this.#state = previous; return false; }
    if (push) this.#history?.push(next);
    changed?.({ state: this.state, breadcrumbs: this.breadcrumbs, context: this.context, shareState: this.shareState });
    return true;
  }
}

export function installAtlasAPI(componentClass) {
  const handlers = instance => instance._atlasHandlers();
  const connected = new WeakSet();
  const onConnect = componentClass.prototype.connectedCallback;
  const onAttributeChange = componentClass.prototype.attributeChangedCallback;
  componentClass.prototype.connectedCallback = function() { connected.add(this); return onConnect.call(this); };
  componentClass.prototype.attributeChangedCallback = function(name, previous, value) {
    // Upgrading an element already in the document reports its parsed src before
    // connectedCallback loads it. Detached elements keep last-write precedence.
    if (name === 'src' && previous === null && this.isConnected && !connected.has(this)) return;
    return onAttributeChange.call(this, name, previous, value);
  };
  Object.defineProperties(componentClass.prototype, {
    atlasState: { get() { return this._atlasNavigation.state; } },
    atlasBreadcrumbs: { get() { return this._atlasNavigation.breadcrumbs; } },
    atlasContext: { get() { return this._atlasNavigation.context; } },
    atlasCanBack: { get() { return this._atlasNavigation.canBack; } },
    atlasCanForward: { get() { return this._atlasNavigation.canForward; } },
    atlasShareState: { get() { return this._atlasNavigation.shareState; } },
    navigateAtlasGroup: { value(id) { const h = handlers(this); return this._atlasNavigation.navigateGroup(id, h.render, h.changed); } },
    navigateAtlasProject: { value(id) { const h = handlers(this); return this._atlasNavigation.navigateProject(id, h.render, h.changed); } },
    navigateAtlasStructure: { value(graph, id) { const h = handlers(this); return this._atlasNavigation.navigateStructure(graph, id, h.render, h.changed); } },
    atlasBack: { value() { const h = handlers(this); return this._atlasNavigation.back(h.render, h.changed); } },
    atlasForward: { value() { const h = handlers(this); return this._atlasNavigation.forward(h.render, h.changed); } },
    loadAtlasShareState: { value(value, graph = null) { const h = handlers(this); return this._atlasNavigation.loadShare(value, graph, h.render, h.changed); } },
  });
}

export function renderAtlasChrome(document, controller, actions) {
  const nav = document.createElement('nav'); nav.setAttribute('aria-label', 'Developer Atlas');
  nav.style.cssText = 'display:flex;align-items:center;gap:.35rem;overflow-x:auto;padding:.5rem 0;white-space:nowrap;min-width:0;scrollbar-width:thin';
  const focusCurrent = () => { if (actions.focus) actions.focus(); else { const root = nav.closest('main'); (root?.querySelector('[aria-current="location"]') || root?.querySelector('[aria-label="Atlas context"] h2'))?.focus?.({ preventScroll: true }); } };
  const travel = direction => { if ((direction === 'back' ? actions.back() : actions.forward?.()) !== false) focusCurrent(); };
  nav.addEventListener('keydown', event => { if (event.key === 'Escape' && controller.canBack) { event.preventDefault(); travel('back'); } });
  const back = document.createElement('button'); back.type = 'button'; back.textContent = '← Back'; back.disabled = !controller.canBack; back.setAttribute('aria-label', 'Back in Developer Atlas'); back.addEventListener('click', () => travel('back')); nav.append(back);
  const forward = document.createElement('button'); forward.type = 'button'; forward.textContent = 'Forward →'; forward.disabled = !controller.canForward; forward.setAttribute('aria-label', 'Forward in Developer Atlas'); forward.addEventListener('click', () => travel('forward')); nav.append(forward);
  const crumbs = controller.breadcrumbs;
  const status = document.createElement('span'); status.dataset.atlasStatus = ''; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)'; nav.append(status);
  crumbs.forEach((crumb, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = crumb.label; button.title = crumb.label; button.style.cssText = 'min-height:2.75rem;max-width:min(18rem,45vw);overflow:hidden;text-overflow:ellipsis;flex:0 0 auto'; button.setAttribute('aria-label', `Open ${crumb.level}: ${crumb.label}`);
    if (index === crumbs.length - 1) button.setAttribute('aria-current', 'location');
    button.addEventListener('click', () => { if (actions.crumb(crumbs.slice(0, index + 1)) !== false) focusCurrent(); });
    nav.append(button);
    if (index < crumbs.length - 1) { const separator = document.createElement('span'); separator.textContent = '›'; separator.setAttribute('aria-hidden', 'true'); nav.append(separator); }
  });
  const panel = document.createElement('section'); panel.setAttribute('aria-label', 'Atlas context'); panel.style.cssText = 'border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:.5rem;padding:.75rem;margin:.25rem 0 .75rem';
  const context = controller.context, heading = document.createElement('h2'); heading.tabIndex = -1; heading.style.cssText = 'font:600 1rem/1.4 system-ui;margin:0 0 .4rem'; heading.textContent = context?.subject?.label || crumbs.at(-1)?.label || 'Developer'; panel.append(heading);
  const detail = document.createElement('p'); detail.style.cssText = 'font:.875rem/1.5 system-ui;margin:.2rem 0 .55rem;opacity:.85';
  if (context?.level === 'group') detail.textContent = `${context.provenance === 'user' ? 'User-authored' : 'Derived'} group · ${context.members.length} projects · ${(context.basis || []).join(', ') || 'Canonical Semantic Group'}`;
  else if (context?.level === 'project') detail.textContent = [context.subject?.properties?.description, context.subject?.properties?.language, ...(context.subject?.properties?.topics || [])].filter(Boolean).join(' · ') || 'Project details from the imported Semantic Graph.';
  else if (context?.level === 'structure') detail.textContent = context.subject ? `${context.subject.kind} · ${context.subject.properties?.path || context.subject.label}` : 'Structural detail is not included in this portable graph.';
  else detail.textContent = 'Explore the canonical Semantic Groups and projects in this graph.';
  panel.append(detail);
  if (context?.level === 'project' && context.groups?.length) { const p = document.createElement('p'); p.style.cssText = detail.style.cssText; p.textContent = `Group membership: ${context.groups.map(group => `${group.label} (${group.provenance})`).join(' · ')}`; panel.append(p); }
  if (context?.level === 'project' && context.owner) { const p = document.createElement('p'); p.style.cssText = detail.style.cssText; p.textContent = 'Repository-owner relationship is recorded in the graph.'; panel.append(p); }
  if (context?.relationships?.length) { const names = new Map((controller.graph?.nodes || []).map(node => [node.id, node.label])); const p = document.createElement('p'); p.style.cssText = detail.style.cssText; p.textContent = context.level === 'group' ? `${context.relationships.length} explicit project relationships among these members.` : `Project relationships: ${context.relationships.map(edge => names.get(edge.from === context.subject?.id ? edge.to : edge.from)).filter(Boolean).join(', ')}`; panel.append(p); }
  const entries = context?.level === 'developer' ? [...(context.groups || []).map(item => ({ kind: 'group', id: item.id, label: item.label, provenance: item.provenance })), ...(context.projects || []).slice(0, 100).map(item => ({ kind: 'project', id: item.id, label: item.label }))]
    : context?.level === 'group' ? (context.members || []).slice(0, 100).map(item => ({ kind: 'project', id: item.id, label: item.label }))
      : context?.level === 'structure' ? (context.children || []).map(item => ({ kind: 'structure', id: item.id, label: item.properties?.path || item.label })) : [];
  if (entries.length) {
    const list = document.createElement('div'); list.style.cssText = 'display:flex;flex-wrap:wrap;gap:.4rem';
    for (const entry of entries) { const button = document.createElement('button'); button.type = 'button'; button.style.cssText = 'min-height:2.75rem;max-width:100%;overflow-wrap:anywhere'; button.textContent = entry.kind === 'group' ? `Explore ${entry.label} · ${entry.provenance}` : `Explore ${entry.label}`; button.addEventListener('click', () => { const result = entry.kind === 'group' ? actions.group(entry.id) : entry.kind === 'structure' ? actions.structure(entry.id) : actions.project(entry.id); if (result !== false) focusCurrent(); }); list.append(button); }
    panel.append(list);
  }
  if (context?.level === 'project' && !context.structureAvailable) { const note = document.createElement('p'); note.setAttribute('role', 'note'); note.textContent = 'Structural detail is not included in this portable graph.'; panel.append(note); }
  if (context?.evidence?.length) { const note = document.createElement('p'); note.style.cssText = detail.style.cssText; note.textContent = `Evidence: ${context.evidence.map(item => item.value).join(' · ')}`; panel.append(note); }
  return { nav, panel };
}
