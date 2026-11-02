// The kitchen display's panels (#671, ADR 0022 §4), as data. Pure: no DOM,
// no storage, no network.
//
// Each panel is one record:
// - `id`: stable, also its `data-panel` in the page;
// - `component`: the custom element that draws it (the display controller
//   makes or reuses one per id; app/display.js PANEL_ELEMENTS);
// - `region`: the named grid area it stacks in (REGIONS below; app.css's
//   display.css places the regions for portrait and landscape);
// - `featureId`: the household feature it needs (web/features.js), or null
//   for one that is always there; a switched-off feature takes its panel
//   away;
// - `size`: "s", "m" or "l", how much of its region it may grow into;
// - `label`: the region's accessible name.
//
// This list is the seam a future add-on (#688) can use: an add-on would
// contribute a record of the same shape. Nothing loads add-ons today;
// `validPanel` is the check one would have to pass.
//
// What the display never shows (ADR 0022 §4) has no panel at all: the
// adult's journal, Just for me, reminders, Search, admin actions, Household
// settings and Chat composition.

export const REGIONS = Object.freeze(["week", "now", "chores", "lists", "board"]);
export const SIZES = Object.freeze(["s", "m", "l"]);

const panel = (id, component, region, featureId, size, label) => Object.freeze({ id, component, region, featureId, size, label });

export const PANELS = Object.freeze([
  // Today's events and the next countdown, and the week strip (#660).
  panel("today", "kin-calendar-today", "now", "calendar", "m", "Today"),
  panel("week", "kin-calendar", "week", "calendar", "l", "This week"),
  // Today's meals, dinner first (#333, #679).
  panel("meals", "kin-tonight", "now", "meals", "s", "Today's meals"),
  // Recent messages, read-only (Chat composition never shows here).
  panel("chat", "kin-display-chat", "now", "chat", "s", "Recent messages"),
  // Each child's chore chart in their colour (#676).
  panel("chores", "kin-chore-chart", "chores", "chores", "l", "Chore chart"),
  // The shopping list is always on (ADR 0021).
  panel("shopping", "kin-display-shopping", "lists", null, "m", "Shopping"),
  // The family fridge (#317).
  panel("fridge", "kin-fridge", "board", "fridge", "l", "Fridge"),
]);

/** Whether `value` is a panel record this display can place. */
export function validPanel(value) {
  return Boolean(value) && typeof value === "object" &&
    typeof value.id === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value.id) &&
    typeof value.component === "string" && /^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(value.component) &&
    REGIONS.includes(value.region) && SIZES.includes(value.size) &&
    (value.featureId === null || typeof value.featureId === "string") &&
    typeof value.label === "string" && value.label.length > 0 && value.label.length <= 60;
}

/**
 * The panels to show, in list order: valid ones whose feature is on (`isOn`
 * as FeaturesController.isOn), without ids listed in `unavailable` (Chat
 * when this member has no access, for example), and each id once.
 */
export function visiblePanels(panels = PANELS, { isOn = () => true, unavailable = [] } = {}) {
  const seen = new Set();
  const skip = new Set(unavailable);
  return panels.filter((entry) => {
    if (!validPanel(entry) || seen.has(entry.id) || skip.has(entry.id)) return false;
    seen.add(entry.id);
    return entry.featureId === null || isOn(entry.featureId) !== false;
  });
}

/** The visible panels by region, every region present (empty ones too), in
 * REGIONS order: Map region → [panel]. */
export function panelsByRegion(panels) {
  const regions = new Map(REGIONS.map((region) => [region, []]));
  for (const entry of panels) regions.get(entry.region)?.push(entry);
  return regions;
}

/** "portrait" or "landscape" for a viewport. A square screen counts as
 * landscape. */
export function orientationOf(width, height) {
  return Number(height) > Number(width) ? "portrait" : "landscape";
}
