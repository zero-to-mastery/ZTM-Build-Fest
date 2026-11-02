// Household features (ADR 0021 §2, #624): the parts of Kin a household
// admin can switch off for everyone. Pure: no DOM, no storage, no network.
//
// Each feature has a stable small number, its bit in the household's
// switched-off set (`off`, an integer). The service names the same bits
// (server/pairing-service/shared.mjs HOUSEHOLD_FEATURE_BITS); the list only
// grows, and a bit is never reused. Today, Lists (To do and Shopping),
// Updates (handoffs) and Household are always on and have no bit.
//
// Off means hidden, never deleted: data stays in the history and comes back
// when the feature is switched on. The service refuses Chat and Fridge
// routes while they are off; the rest is a layout, applied on each device.
//
// `routes` are the canonical routes (routes.js) a feature owns: "page" for a
// whole page, "page/segment" for one segment. A route with owners is
// available while at least one of them is on. Everything else a feature owns
// inside other pages is marked in the DOM with `data-feature="<id>"`, which
// app.css hides while that feature is off.

import { SEGMENTS } from "./routes.js";

const feature = (id, bit, label, description, routes = []) =>
  Object.freeze({ id, bit, label, description, routes: Object.freeze(routes) });

export const FEATURES = Object.freeze([
  feature("chat", 0, "Chat", "One conversation for the whole household, with photos, polls and reactions.", ["updates/chat"]),
  feature("fridge", 1, "Fridge", "A shared board to draw on and hang little notes, like a real fridge door.", ["household/fridge"]),
  feature("meals", 2, "Meals", "Plan the week's meals, keep favourite recipes, and see today's meals on Today.", ["lists/meals"]),
  feature("routines", 3, "Routines", "Things that repeat, like taking the bins out on Tuesday, and reusable checklists.", ["routines"]),
  feature("turns", 4, "Taking turns", "Routines that rotate between people, so everyone knows whose turn it is.", []),
  // This week grew into the Calendar (#661): bit 5 stays the Week view's
  // switch; the Calendar (bit 14) owns the Day and Month views.
  feature("week", 5, "This week", "The next seven days in one list, reached from Today.", ["week/week"]),
  feature("talk", 6, "Talk later", "A list of things to talk about at a calmer moment, from Chat or Updates.", []),
  feature("sections", 7, "Store sections", "Sort the shopping list by the aisles of your shop.", []),
  feature("shopping-mode", 8, "Shopping mode", "A big, simple shopping list to tick off in the shop.", []),
  feature("maintenance", 9, "Maintenance", "When things in the house were last serviced and when they're due next, kept with their reference details.", []),
  feature("notes", 10, "Notes & reference", "Household notes and details like the Wi-Fi name, appliance models and phone numbers.", ["household/notes"]),
  feature("sitter", 11, "Sitter page", "A welcome page for babysitters and guests, with what they need to know.", ["household/sitter", "foryou"]),
  feature("journal", 12, "Journal", "Each person's own private journal. Only they can see it.", ["journal"]),
  feature("mine", 13, "Just for me", "Each person's own private list. Only they can see it.", ["lists/mine"]),
  // The family calendar (#660, ADR 0022 §2): events in each person's
  // colour, the Day and Month views, today's events and countdowns.
  feature("calendar", 14, "Calendar", "Family events in each person's colour, by day, week or month, with countdowns on Today.", ["week/day", "week/month"]),
  // The chore chart (#676, ADR 0022 §6).
  feature("chores", 15, "Chore chart", "The children's jobs for the week with big tick boxes, their points and rewards.", ["chores"]),
  feature("photos", 16, "Family photos", "A shared album of family photos, with a slideshow.", ["household/photos"]),
  // Kitchen display mode (#669, ADR 0022 §4): an adult's device as a wall
  // screen.
  feature("display", 17, "Kitchen display", "Use a tablet on the wall to show today, the week, chores, meals and shopping.", []),
]);

/** The parts that can't be switched off, named for the Features page. */
export const ALWAYS_ON = Object.freeze(["Today", "Lists (To do and Shopping)", "Updates (handoffs)", "Household"]);

export const KNOWN_FEATURE_MASK = FEATURES.reduce((mask, entry) => mask | (2 ** entry.bit), 0);

const BY_ID = new Map(FEATURES.map((entry) => [entry.id, entry]));

export function featureById(id) {
  return BY_ID.get(id) ?? null;
}

/** A switched-off set as delivered by the service or kept on the device:
 * `{ off, revision }` with only known bits, or null when it isn't one. */
export function parseFeatureSet(value) {
  if (!value || typeof value !== "object") return null;
  const { off, revision } = value;
  if (!Number.isSafeInteger(off) || off < 0 || !Number.isSafeInteger(revision) || revision < 0) return null;
  // Bits a newer service knows and this Kin doesn't are left alone: nothing
  // here could show those features anyway.
  return { off: off & KNOWN_FEATURE_MASK, revision };
}

export function isFeatureOn(off, id) {
  const entry = BY_ID.get(id);
  return !entry || ((off ?? 0) & (2 ** entry.bit)) === 0;
}

/** `off` with feature `id` switched on (`on` true) or off. */
export function withFeature(off, id, on) {
  const entry = BY_ID.get(id);
  if (!entry) return off;
  const mask = 2 ** entry.bit;
  return on ? (off & ~mask) : (off | mask);
}

/** The features switched off in `off`, in list order. */
export function offFeatures(off) {
  return FEATURES.filter((entry) => !isFeatureOn(off, entry.id));
}

/** Features off in `after` that were on in `before`. */
export function newlyOff(before, after) {
  return FEATURES.filter((entry) => isFeatureOn(before, entry.id) && !isFeatureOn(after, entry.id));
}

/** The features that own a route: `route` is a canonical route string
 * ("week", "lists/meals") or a resolved route ({ page, segment }). */
export function routeOwners(route) {
  const page = typeof route === "string" ? route.split("/")[0] : route?.page;
  const segment = typeof route === "string" ? route.split("/")[1] ?? null : route?.segment ?? null;
  const canonical = segment ? `${page}/${segment}` : page;
  return FEATURES.filter((entry) => entry.routes.some((owned) => owned === canonical || owned === page));
}

/** Whether a route is available with `off` switched off: it has no owner,
 * or one of its owners is on. A whole page with segments ("week") is
 * available while any of its segments is. The generic hook navigation,
 * Help and the other destinations ask (ADR 0021). */
export function routeAvailable(route, off) {
  const page = typeof route === "string" ? route.split("/")[0] : route?.page;
  const segment = typeof route === "string" ? route.split("/")[1] ?? null : route?.segment ?? null;
  const owners = routeOwners(route);
  if (!segment && owners.length === 0 && SEGMENTS[page])
    return SEGMENTS[page].some((entry) => routeAvailable({ page, segment: entry.id }, off));
  return owners.length === 0 || owners.some((entry) => isFeatureOn(off, entry.id));
}

/** The first segment of `page` that is available, or null. */
export function firstAvailableSegment(page, off) {
  return (SEGMENTS[page] ?? []).find((entry) => routeAvailable({ page, segment: entry.id }, off))?.id ?? null;
}

/** The switched-off feature that makes a route unavailable, or null. */
export function blockingFeature(route, off) {
  if (routeAvailable(route, off)) return null;
  const page = typeof route === "string" ? route.split("/")[0] : route?.page;
  const pageOwners = FEATURES.filter((entry) => entry.routes.some((owned) => owned.split("/")[0] === page));
  return routeOwners(route)[0] ?? pageOwners[0] ?? null;
}

/** Joins labels the way a person would say them: "Meals", "Meals and
 * Fridge", "Meals, Fridge and Journal". */
export function joinLabels(labels) {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/** The calm one-time line for members when features disappear. */
export function turnedOffNote(features) {
  if (!features.length) return "";
  const names = joinLabels(features.map((entry) => entry.label));
  return `Your household turned off ${names}. Nothing was deleted; a household admin can turn ${features.length === 1 ? "it" : "them"} back on under Household › Features.`;
}

/** The line after a route into a switched-off feature opened Today. */
export function unavailableLine(entry) {
  return entry ? `${entry.label} is turned off in your household, so Kin opened Today.` : "";
}

const NONE = Object.freeze([]);

/** This week's days (kin_week) without what switched-off features add:
 * dinners (Meals), routines (Routines), maintenance due (Maintenance, or
 * Notes & reference) and private items (Just for me). */
export function filterWeekDays(days, off) {
  if (!Array.isArray(days)) return [];
  const meals = isFeatureOn(off, "meals"), routines = isFeatureOn(off, "routines");
  const maintenance = isFeatureOn(off, "maintenance") && isFeatureOn(off, "notes"), mine = isFeatureOn(off, "mine");
  if (meals && routines && maintenance && mine) return days;
  return days.map((day) => ({
    ...day,
    meals: meals ? day.meals : NONE,
    routines: routines ? day.routines : NONE,
    maintenance: maintenance ? day.maintenance : NONE,
    ...(day.privateItems ? { privateItems: mine ? day.privateItems : NONE } : {}),
  }));
}

/** The household records Search may show (kin-search `household`): Talk
 * later's topics, notes and reference records, and maintenance leave with
 * their features. Unchanged arrays are passed through as they are, so the
 * search view's identity checks still skip work. */
export function searchableHousehold(household, off) {
  const notes = isFeatureOn(off, "notes");
  return {
    ...household,
    talks: isFeatureOn(off, "talk") ? household.talks : NONE,
    notes: notes ? household.notes : NONE,
    referenceRecords: notes ? household.referenceRecords : NONE,
    maintenanceEvents: notes && isFeatureOn(off, "maintenance") ? household.maintenanceEvents : NONE,
  };
}

/** Share sheet destinations (kin-share-sheet kinds) without switched-off
 * features: "chat" (Chat), "note" (Notes & reference), "journal",
 * "calendar" (an .ics file, #660), "photos" (Family photos, #673). */
export function shareDestinations(allowed, off) {
  const owners = { chat: "chat", note: "notes", journal: "journal", calendar: "calendar", photos: "photos" };
  return new Set([...allowed].filter((kind) => !owners[kind] || isFeatureOn(off, owners[kind])));
}

/** Command palette entries without switched-off features: a command may
 * name the `feature` it belongs to. */
export function availableCommands(commands, off) {
  return commands.filter((command) => !command.feature || isFeatureOn(off, command.feature));
}

/** Chat message actions without switched-off features: Talk later's,
 * "Save as a note" and "Add to the family photos". */
export function hiddenChatActions(off) {
  const hidden = [];
  if (!isFeatureOn(off, "talk")) hidden.push("talk-later", "talk-resolve", "talk-reopen");
  if (!isFeatureOn(off, "notes")) hidden.push("to-note");
  if (!isFeatureOn(off, "photos")) hidden.push("to-photos");
  return hidden;
}

/** The value of `data-kin-features-off` on the document: the ids of the
 * switched-off features, space separated, for app.css. */
export function featuresAttribute(off) {
  return offFeatures(off).map((entry) => entry.id).join(" ");
}
