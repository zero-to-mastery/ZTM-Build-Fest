import { mountSettingsPanel } from './settings-panel.mjs';

export function mountLayoutPanel(section, ctx) {
  return mountSettingsPanel(section, ctx, { group: 'layout', galleryTitle: 'Pick a layout', controlsTitle: 'Connections' });
}
