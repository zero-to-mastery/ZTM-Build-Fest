import { h } from '../../dom.mjs';
import { settingsFor } from '../../settings.mjs';
import { createControl } from '../controls.mjs';
import { createGallery } from '../gallery.mjs';

/**
 * A panel of one group's essential settings. If the group has a gallery
 * setting it goes first, as the big visual choice.
 */
export function mountSettingsPanel(section, ctx, { group, galleryTitle, controlsTitle }) {
  const { store, engine } = ctx;
  const essentials = settingsFor(group, 'essential');
  const galleries = essentials.filter((s) => s.control.type === 'gallery').map((s) => createGallery(s, ctx));
  const controls = essentials.filter((s) => s.control.type !== 'gallery').map((s) => createControl(s, ctx));

  section.append(
    ...galleries.map((g) => h('section', { class: 'panel-section' }, galleryTitle ? h('h3', { text: galleryTitle }) : null, g.element)),
    controls.length ? h('section', { class: 'panel-section' }, controlsTitle ? h('h3', { text: controlsTitle }) : null, h('div', { class: 'setting-list' }, controls.map((c) => c.element))) : null,
  );

  const sync = (state, changed) => {
    if (!(changed.has('options') || changed.has('repositories') || changed.has('screen'))) return;
    for (const gallery of galleries) gallery.sync(state, changed);
    for (const control of controls) control.sync(state.options, { signedIn: engine.signedIn, repositories: state.repositories });
  };
  sync(store.get(), new Set(['options']));
  return store.subscribe(sync);
}
