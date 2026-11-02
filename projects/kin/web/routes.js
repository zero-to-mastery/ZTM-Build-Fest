// Hash-route resolution for the unlocked shell. Pure: no DOM, no history.
// Canonical routes are `page` or `page/segment`; legacy hashes alias onto them
// so bookmarks and in-app links from earlier releases keep working.

export const PRIMARY_DESTINATIONS = Object.freeze([
  Object.freeze({ id: "today", label: "Today" }),
  Object.freeze({ id: "lists", label: "Lists" }),
  Object.freeze({ id: "routines", label: "Routines" }),
  Object.freeze({ id: "updates", label: "Updates" }),
  Object.freeze({ id: "household", label: "Household" }),
]);

// Segments are presentation groupings over existing records; the first entry
// is the default when a page is requested without one.
export const SEGMENTS = Object.freeze({
  lists: Object.freeze([
    Object.freeze({ id: "todo", label: "To do", classification: "need" }),
    Object.freeze({ id: "shopping", label: "Shopping", classification: "shopping" }),
    Object.freeze({ id: "staples", label: "Staples", classification: "staple" }),
    Object.freeze({ id: "meals", label: "Meals" }),
    // Just for me (#510): this member's private list; only they see it.
    Object.freeze({ id: "mine", label: "Just for me" }),
  ]),
  routines: Object.freeze([
    Object.freeze({ id: "all", label: "Routines" }),
    Object.freeze({ id: "checklists", label: "Reusable checklists" }),
  ]),
  updates: Object.freeze([
    Object.freeze({ id: "handoffs", label: "Handoffs" }),
    Object.freeze({ id: "chat", label: "Chat" }),
  ]),
  // The Calendar (#661, ADR 0022 §2): This week grew into it. Its views
  // are segments; Week (This week's list) is the default, so `#week` still
  // opens it.
  week: Object.freeze([
    Object.freeze({ id: "week", label: "Week" }),
    Object.freeze({ id: "day", label: "Day" }),
    Object.freeze({ id: "month", label: "Month" }),
  ]),
  household: Object.freeze([
    Object.freeze({ id: "hub", label: "Household" }),
    // The family fridge (#317): a shared drawing board.
    Object.freeze({ id: "fridge", label: "Fridge" }),
    // Family photos (#673): the household's album and its slideshow.
    Object.freeze({ id: "photos", label: "Family photos" }),
    Object.freeze({ id: "notes", label: "Notes & reference" }),
    // The sitter page (#441): what a babysitter or guest sees first.
    Object.freeze({ id: "sitter", label: "For the sitter" }),
    Object.freeze({ id: "areas", label: "Areas & status" }),
    Object.freeze({ id: "people", label: "People & devices" }),
    Object.freeze({ id: "privacy", label: "Privacy & recovery" }),
    Object.freeze({ id: "appearance", label: "Identity & appearance" }),
    // Household features (#626, ADR 0021): what the household switched off.
    Object.freeze({ id: "features", label: "Features" }),
  ]),
});

const PAGE_TITLES = Object.freeze({
  today: "Today",
  lists: "Lists",
  routines: "Routines",
  updates: "Updates",
  household: "Household",
  search: "Search",
  // This week (#416), grown into the Calendar (#661): reached from Today;
  // it marks Today in the navigation. There is no sixth destination.
  week: "Calendar",
  // The chore chart (#676): reached from Today (and Simple view); it marks
  // Today in the navigation.
  chores: "Chore chart",
  // For you (#441): a Temporary member's landing page; it marks Today.
  foryou: "For you",
  // A member's journal (#497): reached from Household (the More place), not
  // a sixth destination; it marks Household.
  journal: "Journal",
});

/** Every page a route can name (primary destinations and the pages reached
 * from them). Help (#621) has a topic for each page and segment. */
export const ROUTE_PAGES = Object.freeze(Object.keys(PAGE_TITLES));

// Legacy destinations and tabs from earlier releases.
const ALIASES = Object.freeze({
  handoff: "updates/handoffs",
  "handoff/handoffs": "updates/handoffs",
  // Talk moved into Chat's To talk about list (#312); see TOPIC_ALIASES.
  handoffs: "updates/handoffs",
  more: "household",
  "more/notes": "household/notes",
  "more/areas": "household/areas",
  "more/people": "household/people",
  "more/privacy": "household/privacy",
  "more/security": "household/privacy",
  "more/appearance": "household/appearance",
  "more/household": "household/people",
  needs: "lists/todo",
  "lists/needs": "lists/todo",
  "lists/need": "lists/todo",
  "lists/staple": "lists/staples",
  "household/security": "household/privacy",
  "household/household": "household/people",
  "routines/playbooks": "routines/checklists",
});

// Links to the former Talk tab (#312, ADR 0014) open Chat with its To talk
// about list; the route carries `topics: true`.
const TOPIC_ALIASES = new Set(["talk", "handoff/talk", "updates/talk"]);

/** Dispatched on window when the visible page or segment changes. In-app
 * navigation uses history.pushState and hides views rather than removing
 * them, so neither hashchange nor disconnection signals it. */
export const ROUTE_CHANGE_EVENT = "kin-route-change";

export function routeHash(page, segment = null) {
  const segments = SEGMENTS[page];
  if (!segments) return `#${page}`;
  const chosen = segments.find((entry) => entry.id === segment) ?? segments[0];
  // The hub and the first list are the page's default and stay short.
  if (chosen === segments[0] && (page === "household" || page === "routines" || page === "week")) return `#${page}`;
  return `#${page}/${chosen.id}`;
}

/** Simple view's destinations (#345, ADR 0013), by route. */
export const SIMPLE_ROUTES = Object.freeze({
  today: Object.freeze({ page: "today", label: "Today" }),
  chat: Object.freeze({ page: "updates", segment: "chat", label: "Chat" }),
  fridge: Object.freeze({ page: "household", segment: "fridge", label: "Fridge" }),
  // The chore chart (#676), reached from Simple view's Today.
  chores: Object.freeze({ page: "chores", label: "Chore chart" }),
});

/**
 * Simple view's allowlist: Today, Updates › Chat when `chat` is true,
 * Household › Fridge when `fridge` is true and the chore chart when `chores`
 * is true. Every other hash, alias, search link and `/pair` resolves to Today.
 */
export function resolveSimpleRoute(location = {}, { chat = false, fridge = false, chores = false } = {}) {
  const route = resolveRoute(location);
  // An old Talk link isn't Chat: Simple view has no To talk about list.
  const allowed = (chat && route.page === "updates" && route.segment === "chat" && !route.topics) ||
    (fridge && route.page === "household" && route.segment === "fridge") ||
    (chores && route.page === "chores");
  return allowed ? route : resolveRoute({ hash: "#today" });
}

export function resolveRoute({ hash = "", pathname = "/" } = {}) {
  let requested = String(hash ?? "").replace(/^#/, "").replace(/\/+$/, "").toLowerCase();
  // An invitation link's fragment (#code=…) is not a route. pairing-link.js
  // takes it as the app loads; this keeps /pair on the join screen even so.
  if (pathname === "/pair" && /^code=/.test(requested)) requested = "";
  if (!requested && pathname === "/pair") requested = "household/people";
  const topics = TOPIC_ALIASES.has(requested);
  if (topics) requested = "updates/chat";
  requested = ALIASES[requested] ?? requested;
  const [pageCandidate, segmentCandidate] = requested.split("/");
  const page = PAGE_TITLES[pageCandidate] ? pageCandidate : "today";
  const segments = SEGMENTS[page] ?? null;
  const segment = segments
    ? (segments.find((entry) => entry.id === segmentCandidate) ?? segments[0]).id
    : null;
  const canonical = segments ? `${page}/${segment}` : page;
  // Search is reachable from every page; it marks no primary destination.
  const destination = page === "search" ? null : page === "week" || page === "foryou" || page === "chores" ? "today" : page === "journal" ? "household" : page;
  return { page, segment, canonical, destination, title: PAGE_TITLES[page], hash: segments ? routeHash(page, segment) : `#${page}`, ...(topics ? { topics: true } : {}) };
}

export function listSegmentForClassification(classification) {
  if (classification === "today") return "todo";
  return SEGMENTS.lists.find((entry) => entry.classification && entry.classification === classification)?.id ?? "todo";
}
