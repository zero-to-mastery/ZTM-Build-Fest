import { mountSettingsPanel } from './settings-panel.mjs';

export function mountLookPanel(section, ctx) {
  return mountSettingsPanel(section, ctx, { group: 'look', galleryTitle: 'Theme', controlsTitle: 'Make it yours' });
}
