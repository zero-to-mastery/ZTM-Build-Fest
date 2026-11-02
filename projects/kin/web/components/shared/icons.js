// Static, source-controlled SVG markup for the app shell. These strings never
// contain household text, so assigning them through innerHTML is safe.
export const NAV_ICONS = {
  today: '<path d="M3 10.8 12 3l9 7.8"/><path d="M5.5 9.5V20h13V9.5M9.5 20v-6h5v6"/>',
  lists: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  routines: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9a7 7 0 0 1 12-2L20 12M4 12l2.5 5a7 7 0 0 0 12-2"/>',
  updates: '<path d="M8 10h8M8 14h5"/><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4l-3 3-3-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/>',
  household: '<path d="M4 20V9l8-6 8 6v11"/><path d="M9 20v-5h6v5"/><circle cx="12" cy="10.5" r="1.6"/>',
};
export const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>';
export const LOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>';
