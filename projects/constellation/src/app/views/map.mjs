import { h, icon, announce } from '../dom.mjs';
import { mountLabelEditor } from '../../label-editor.mjs';
import { visualThemes } from '../../themes.mjs';
import { starsMove } from '../motion.mjs';

const HINT_KEY = 'constellation:map-hint-seen';
const HELP_ID = 'map-help';
const HELP_TEXT = 'Arrow keys move between stars. Enter opens details.';
const ARROWS = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
// A touch target of at least 44 CSS px (WCAG 2.5.5), whatever the map's scale.
const TOUCH_RADIUS = 22;
const EXTRA_STYLE = `
.generated-at{display:none}
.repository{cursor:pointer}
.repository.is-selected .star{stroke:var(--sky-foreground);stroke-width:1.4}
.repository.is-selected .star-halo{opacity:.55}
.repository:focus-visible .star{stroke:var(--sky-accent);stroke-width:1.6}
.repository.is-moving .star{stroke:var(--sky-accent);stroke-width:2;stroke-dasharray:3 2}
.repository.is-moving .star-halo{opacity:.6}
.repository:focus-visible{outline:none}
.repo-label{cursor:pointer}
:host([data-coarse]) .repo-label{pointer-events:auto}
.map-help{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;

function movedOptions(options, repo, pair) {
  const ringPlacements = { ...options.ringPlacements, ...pair.ringPlacements };
  for (const [id, point] of Object.entries(ringPlacements)) if (point === null) delete ringPlacements[id];
  return {
    ...options,
    ...(pair.ringPlacements ? { ringPlacements } : {}),
    starPositions: { ...options.starPositions, ...pair.placements, [repo]: pair.star },
    labelOffsets: { ...options.labelOffsets, ...pair.offsets },
  };
}

const repoOf = (group) => group?.querySelector('.star')?.dataset.repo || null;
const centre = (group) => {
  const box = (group.querySelector('.star') || group).getBoundingClientRect();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/**
 * The nearest star in a direction: candidates must lie ahead (within a 45°
 * cone first, then the whole half-plane), scored by distance with sideways
 * drift counting double. Returns null when nothing lies that way.
 */
function nearestInDirection(from, groups, [dx, dy]) {
  const origin = centre(from);
  let best = null;
  for (const wide of [false, true]) {
    for (const group of groups) {
      if (group === from) continue;
      const point = centre(group);
      const ahead = (point.x - origin.x) * dx + (point.y - origin.y) * dy;
      const side = Math.abs((point.x - origin.x) * dy - (point.y - origin.y) * dx);
      if (ahead <= 2 || (!wide && side > ahead)) continue;
      const score = ahead + side * 2;
      if (!best || score < best.score) best = { group, score };
    }
    if (best) return best.group;
  }
  return null;
}

export function mountMap(stage, { store, engine, actions, win, doc = win.document }) {
  const host = h('div', { class: 'stage-map', 'data-map': '' });
  const message = h('div', { class: 'stage-message', hidden: true, role: 'alert' });
  let hintSeen = false;
  try { hintSeen = win.localStorage.getItem(HINT_KEY) === '1'; } catch {}
  const coarse = win.matchMedia?.('(pointer: coarse)');
  const isCoarse = () => Boolean(coarse?.matches);
  const hint = h('p', { class: 'stage-hint', hidden: hintSeen });
  stage.append(host, message, hint);

  let lastSvg = null;
  let focusAfter = null;
  // The star that takes the map's single Tab stop when nothing is selected.
  let current = null;
  let remounting = false;
  let movedWhileMoving = false;
  let listening = false;
  let keyboard = false;
  let locked = false;

  // ------------------------------------------------------------- the hint
  function drawHint() {
    hint.textContent = keyboard ? 'Press Enter on a star to see why it’s there.'
      : `${isCoarse() ? 'Tap' : 'Click'} a star to see why it’s there. Drag to move it.`;
  }
  function dismissHint() {
    if (hint.hidden) return;
    hint.hidden = true;
    try { win.localStorage.setItem(HINT_KEY, '1'); } catch {}
  }
  win.addEventListener('keydown', (event) => {
    if (keyboard || event.ctrlKey || event.metaKey || event.altKey) return;
    if (['Tab', 'Enter', ' ', 'Home', 'End', ...Object.keys(ARROWS)].includes(event.key)) { keyboard = true; drawHint(); }
  }, true);
  win.addEventListener('pointerdown', () => { if (keyboard) { keyboard = false; drawHint(); } }, true);
  drawHint();

  // ------------------------------------------------------------- the stars
  const groups = () => [...(host.shadowRoot?.querySelectorAll('.repository') || [])];
  const groupFor = (id) => groups().find((group) => repoOf(group) === id) || null;
  const nameOf = (id) => store.get().repositories.find((r) => r.full_name === id)?.name
    || groupFor(id)?.querySelector('.star')?.dataset.label || String(id || '').split('/').pop();

  /** Roving tabindex: exactly one star is in the Tab order. */
  function rove(target) {
    const all = groups();
    const chosen = target || all[0] || null;
    for (const group of all) group.tabIndex = group === chosen ? 0 : -1;
    if (chosen) current = repoOf(chosen);
  }
  function tabStop() {
    const { selected, moving } = store.get();
    return groupFor(moving) || groupFor(selected) || groupFor(current) || groups()[0] || null;
  }
  function focusStar(group) {
    if (!group) return;
    rove(group);
    group.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------ move mode
  function startMoving(id) {
    const group = groupFor(id);
    if (!group) return;
    if (locked) {
      store.update({ moving: null });
      announce('Stars can’t be moved while Spinning rings or Floating stars is on.');
      return;
    }
    movedWhileMoving = false;
    for (const g of groups()) g.classList.toggle('is-moving', g === group);
    focusStar(group);
    announce(`Moving ${nameOf(id)}. Use arrow keys, then Enter.`);
  }
  function stopMoving({ quiet = false } = {}) {
    const id = store.get().moving;
    if (!id) return;
    store.update({ moving: null });
    for (const g of groups()) g.classList.remove('is-moving');
    if (!quiet) announce(movedWhileMoving ? `Moved ${nameOf(id)}.` : `${nameOf(id)} stays where it was.`);
  }

  // One set of listeners on the shadow root, which outlives every redraw.
  function listen(root) {
    if (listening) return;
    listening = true;
    // Capture phase: the label editor moves a star on arrow keys, so arrows
    // are stopped here unless the visitor asked to move this star.
    root.addEventListener('keydown', (event) => {
      const group = event.target.closest?.('.repository');
      if (!group) return;
      const id = repoOf(group);
      const { moving } = store.get();
      if (moving && moving === id) {
        if (event.key === 'Enter' || event.key === 'Escape' || event.key === ' ') {
          event.preventDefault();
          event.stopImmediatePropagation();
          stopMoving();
        } else if (event.key === 'Tab') stopMoving();
        return;
      }
      if (moving) stopMoving({ quiet: true });
      const all = groups();
      let next = null;
      if (ARROWS[event.key]) {
        next = nearestInDirection(group, all, ARROWS[event.key]);
        // Nothing lies that way: fall back to document order.
        if (!next) {
          const index = all.indexOf(group);
          next = all[index + ((event.key === 'ArrowRight' || event.key === 'ArrowDown') ? 1 : -1)] || null;
        }
      } else if (event.key === 'Home') next = all[0];
      else if (event.key === 'End') next = all.at(-1);
      else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopImmediatePropagation();
        dismissHint();
        actions.select(id);
        return;
      } else return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (next) focusStar(next);
    }, true);
    root.addEventListener('focusin', (event) => {
      const group = event.target.closest?.('.repository');
      if (!group) return;
      const { moving } = store.get();
      if (moving && moving !== repoOf(group)) stopMoving({ quiet: true });
      rove(group);
    });
    root.addEventListener('focusout', (event) => {
      if (remounting || !store.get().moving) return;
      if (event.relatedTarget && root.contains(event.relatedTarget)) return;
      // A redraw removes the focused star for a moment; only a real move away ends moving.
      queueMicrotask(() => { if (!remounting && !root.activeElement) stopMoving(); });
    });
    // Tapping or clicking open sky closes the star card.
    root.addEventListener('click', (event) => {
      if (event.target.closest?.('.repository, .repo-label, a')) return;
      if (store.get().selected) actions.select(null);
    });
  }

  /** On touch screens every star gets an invisible 44 px target. */
  function sizeHits() {
    const root = host.shadowRoot;
    if (!root) return;
    const touch = isCoarse();
    host.toggleAttribute('data-coarse', touch);
    if (!touch) return;
    for (const group of groups()) {
      const star = group.querySelector('.star');
      let hit = group.querySelector('.star-hit');
      if (!hit) {
        // A locked map (spinning rings, floating stars) has no editor targets.
        hit = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
        hit.setAttribute('class', 'star-hit');
        hit.setAttribute('cx', star.getAttribute('cx'));
        hit.setAttribute('cy', star.getAttribute('cy'));
        group.append(hit);
      }
      const matrix = hit.getScreenCTM?.();
      const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 0;
      if (scale > 0) hit.setAttribute('r', (TOUCH_RADIUS / scale).toFixed(2));
    }
  }
  new ResizeObserver(() => sizeHits()).observe(host);
  coarse?.addEventListener?.('change', () => { drawHint(); sizeHits(); });

  function decorate() {
    const root = host.shadowRoot;
    if (!root) return;
    listen(root);
    root.append(h('style', { text: EXTRA_STYLE }), h('p', { class: 'map-help', id: HELP_ID, text: HELP_TEXT }));
    const { selected, moving } = store.get();
    // The exported SVG's description explains the encoding in engine terms.
    // In the Studio, describe the map in plain words instead.
    const svg = root.querySelector('svg');
    if (svg) {
      const count = new Set(groups().map(repoOf)).size;
      svg.removeAttribute('aria-labelledby');
      svg.setAttribute('aria-label', `Your map: ${count} ${count === 1 ? 'project' : 'projects'}`);
      svg.setAttribute('aria-describedby', HELP_ID);
    }
    // Only the stars are keyboard stops. Names stay mouse-only handles, and
    // the credit link is reachable from Get it, not from inside the map.
    for (const element of root.querySelectorAll('svg [tabindex]:not(.repository)')) element.setAttribute('tabindex', '-1');
    for (const link of root.querySelectorAll('svg a')) {
      link.setAttribute('tabindex', '-1');
      link.setAttribute('aria-hidden', 'true');
    }
    for (const label of root.querySelectorAll('.repo-label')) {
      label.removeAttribute('role');
      label.removeAttribute('aria-label');
      label.setAttribute('aria-hidden', 'true');
      const id = label.dataset.repo;
      // A name is part of its star's target, so a tap on it opens the card.
      if (id) label.addEventListener('click', () => { dismissHint(); actions.select(id); });
    }
    for (const group of groups()) {
      const star = group.querySelector('.star');
      const id = star?.dataset.repo;
      if (!id) continue;
      const name = star.dataset.label || id.split('/').pop();
      group.setAttribute('role', 'button');
      group.setAttribute('aria-label', actions.isFeatured(id) ? `${name}, featured` : name);
      group.classList.toggle('is-selected', id === selected);
      group.classList.toggle('is-moving', id === moving);
      group.addEventListener('click', () => {
        actions.select(id);
        dismissHint();
      });
    }
    rove(tabStop());
    sizeHits();
    const target = focusAfter ? groupFor(focusAfter) : null;
    focusAfter = null;
    if (target) focusStar(target);
  }

  function mount(svg) {
    const { options, account, repositories, sample } = store.get();
    // Only stars that themselves move (floating, or riding spinning rings) are locked.
    locked = starsMove(options);
    remounting = true;
    try {
      mountLabelEditor(
        host,
        svg,
        (repo, pair) => {
          focusAfter = repo;
          if (store.get().moving === repo) movedWhileMoving = true;
          // Every arrow press of one move shares a key, so Undo takes it back in one step.
          actions.changeOptions((o) => movedOptions(o, repo, pair), `Move ${nameOf(repo)}`, `move:${repo}`);
        },
        (repo, pair) => engine.render(account, repositories, movedOptions(store.get().options, repo, pair), { sample }).svg,
        locked,
        Boolean(options.snapToRings),
      );
      decorate();
    } finally {
      remounting = false;
    }
  }

  store.subscribe((state, changed) => {
    // See-through themes take their backdrop from where they're shown (a light
    // or dark README); show them on the page's own background, not the dark stage.
    if (changed.has('options')) stage.toggleAttribute('data-see-through', Boolean(visualThemes[state.options.visualTheme]?.transparent));
    if (changed.has('render') && state.render) {
      const { svg, error } = state.render;
      if (svg && svg !== lastSvg) {
        // Keep keyboard focus on the same star across redraws.
        const active = host.shadowRoot?.activeElement;
        if (active && !focusAfter) focusAfter = repoOf(active.closest?.('.repository'));
        lastSvg = svg;
        mount(svg);
      }
      message.hidden = !error;
      if (error) {
        message.replaceChildren(
          icon('info', { size: 28 }),
          h('p', { text: error }),
          store.history().canUndo ? h('button', { class: 'btn', type: 'button', onclick: () => actions.undo() }, icon('undo', { size: 18 }), 'Undo the last change') : null,
        );
        // The previous map stays underneath, dimmed, so nothing disappears.
        host.style.opacity = svg ? '.25' : '0';
      } else {
        host.style.opacity = '';
      }
    }
    if (changed.has('selected') && host.shadowRoot) {
      for (const group of groups()) group.classList.toggle('is-selected', repoOf(group) === state.selected);
      if (state.selected && groupFor(state.selected)) rove(groupFor(state.selected));
    }
    if (changed.has('options') && host.shadowRoot) {
      // Featuring changes a star's name before the redraw lands.
      for (const group of groups()) {
        const id = repoOf(group);
        const name = group.querySelector('.star')?.dataset.label || id?.split('/').pop();
        if (id) group.setAttribute('aria-label', actions.isFeatured(id) ? `${name}, featured` : name);
      }
    }
    if (changed.has('moving') && state.moving) startMoving(state.moving);
    if (changed.has('screen') && state.screen !== 'studio') {
      lastSvg = null;
      current = null;
      if (state.moving) store.update({ moving: null });
      host.shadowRoot?.replaceChildren();
    }
  });
}
