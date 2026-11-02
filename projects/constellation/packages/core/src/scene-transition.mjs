// DOM-only interpolation of already computed scenes; no layout or graph algorithms.
export function replaceInteractiveSVG(canvas, markup, previous, next, { duration = 300 } = {}) {
  // A canonical project can have many temporal occurrences. The ordinary
  // one-node-per-ID interpolator must not collapse those identities.
  if (previous?.temporalStack || next.temporalStack) {
    canvas.innerHTML = markup;
    return () => {};
  }
  const oldSVG = canvas.querySelector('svg');
  const oldGroups = new Map([...oldSVG?.querySelectorAll('.repository') || []].map(group => [group.querySelector('.star')?.dataset.repo, group]));
  const oldNodes = new Map((previous?.nodes || []).map(node => [node.id, node]));
  const oldColors = new Map([...oldGroups].map(([id, group]) => [id, getComputedStyle(group.querySelector('.star')).fill]));
  const nextNodes = new Map(next.nodes.map(node => [node.id, node]));
  const focused = canvas.getRootNode().activeElement?.querySelector?.('.star')?.dataset.repo;
  const template = document.createElement('template'); template.innerHTML = markup;
  const svg = template.content.querySelector('svg');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const animate = previous && duration > 0 && !motion.matches;
  const animations = [], ghosts = [], colors = [];
  for (const target of [...svg.querySelectorAll('.repository')]) {
    const id = target.querySelector('.star')?.dataset.repo, old = oldGroups.get(id);
    let group = target;
    if (old) {
      for (const attribute of [...old.attributes]) old.removeAttribute(attribute.name);
      for (const attribute of [...target.attributes]) old.setAttribute(attribute.name, attribute.value);
      old.replaceChildren(...target.childNodes); target.replaceWith(old); group = old;
      oldGroups.delete(id);
    }
    const from = oldNodes.get(id)?.geometry, to = nextNodes.get(id)?.geometry;
    if (animate && group.animate && to) {
      if (oldColors.has(id)) colors.push({ star: group.querySelector('.star'), from: oldColors.get(id) });
      const opacity = nextNodes.get(id).style.opacity ?? 1;
      const initial = from ? { transform: `translate(${from.x - to.x}px,${from.y - to.y}px) scale(${to.radius ? from.radius / to.radius : 1})`, opacity: oldNodes.get(id).style.opacity ?? 1 } : { transform: 'scale(.7)', opacity: 0 };
      group.style.transformOrigin = `${to.x}px ${to.y}px`;
      animations.push(group.animate([initial, { transform: 'translate(0,0) scale(1)', opacity }], { duration, easing: 'ease-out' }));
    }
  }
  if (animate) for (const group of oldGroups.values()) {
    const ghost = group.cloneNode(true); ghost.removeAttribute('id'); ghost.setAttribute('aria-hidden', 'true'); ghost.setAttribute('tabindex', '-1'); ghost.style.pointerEvents = 'none';
    ghost.classList.remove('repository'); ghost.classList.add('departing-node');
    for (const star of ghost.querySelectorAll('.star')) { star.classList.remove('star'); star.removeAttribute('data-repo'); }
    svg.append(ghost); ghosts.push(ghost);
    animations.push(ghost.animate([{ opacity: .8 }, { opacity: 0 }], { duration, easing: 'ease-out', fill: 'forwards' }));
  }
  canvas.replaceChildren(svg);
  for (const { star, from } of colors) animations.push(star.animate([{ fill: from }, { fill: getComputedStyle(star).fill }], { duration, easing: 'ease-out' }));
  if (focused) [...svg.querySelectorAll('.repository')].find(group => group.querySelector('.star')?.dataset.repo === focused)?.focus();
  const cleanup = () => { for (const animation of animations) animation.cancel(); for (const ghost of ghosts) ghost.remove(); motion.removeEventListener('change', changed); };
  const changed = event => { if (event.matches) cleanup(); };
  motion.addEventListener('change', changed);
  Promise.allSettled(animations.map(animation => animation.finished)).then(cleanup);
  return cleanup;
}

export function transitionCamera(runtime, from, to, { duration = 300 } = {}) {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  if (motion.matches || duration <= 0) { runtime.setCamera(to); return () => {}; }
  const started = performance.now(); let frame;
  const cleanup = () => { cancelAnimationFrame(frame); motion.removeEventListener('change', changed); };
  const changed = event => { if (event.matches) { cleanup(); runtime.setCamera(to); } };
  motion.addEventListener('change', changed);
  const tick = now => {
    const progress = Math.min(1, (now - started) / duration), eased = 1 - (1 - progress) ** 3;
    runtime.setCamera(to.map((value, i) => from[i] + (value - from[i]) * eased));
    if (progress < 1) frame = requestAnimationFrame(tick); else cleanup();
  };
  runtime.setCamera(from); frame = requestAnimationFrame(tick);
  return cleanup;
}
