import { mountSettingsPanel } from './settings-panel.mjs';

export function mountDetailsPanel(section, ctx) {
  return mountSettingsPanel(section, ctx, { group: 'details', controlsTitle: 'What stars show' });
}
