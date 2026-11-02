// Easy mode's navigation (#617, ADR 0021): which destinations and segments
// stay on screen. Pure: no DOM; storage is passed in.
//
// Easy mode keeps the everyday places: Today, Lists (To do and Shopping),
// Updates (Handoffs and Chat) and the Household overview. Anything else the
// person opened in the last two weeks stays too, so nothing they use goes
// away; everything else is still one tap away from the Household overview
// and Search. The page being shown is always kept. Only route names are
// remembered (`kin.easy-recent` in this browser's local storage), never what
// was on the page, and only as a presentation hint.

/** The setting's words in Identity & appearance (#617). */
export const EASY_MODE_COPY = Object.freeze({
  label: "Easy mode: bigger text and buttons, fewer things on screen",
  hint: "Every button gets a word, and after each change a line at the bottom lets you undo it. Places you haven't used for two weeks are tucked away; the Household page still lists everything.",
  on: "Easy mode is on.",
  off: "Easy mode is off.",
});

export const EASY_RECENT_KEY = "kin.easy-recent";
/** How long a visit keeps a place in easy mode's navigation. */
export const EASY_RECENT_MS = 14 * 24 * 60 * 60_000;
/** At most this many places are remembered. */
export const EASY_RECENT_LIMIT = 24;

/** The places easy mode always shows: primary destinations, and each
 * destination's segments. */
export const EASY_CORE = Object.freeze({
  pages: Object.freeze(["today", "lists", "updates", "household"]),
  segments: Object.freeze({
    lists: Object.freeze(["todo", "shopping"]),
    routines: Object.freeze(["all"]),
    // The Calendar (#661): Week and Day; Month waits until it is used.
    week: Object.freeze(["week", "day"]),
    updates: Object.freeze(["handoffs", "chat"]),
    // Family photos (#673) stay on hand: it's for grandparents too.
    household: Object.freeze(["hub", "photos"]),
  }),
});

const ROUTE = /^[a-z]{1,16}(?:\/[a-z]{1,16})?$/;

/** The remembered visits, newest first: [{ route, at }]. Unreadable or odd
 * entries are dropped. */
export function readRecent(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(EASY_RECENT_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => typeof entry?.route === "string" && ROUTE.test(entry.route) && Number.isSafeInteger(entry.at))
      .slice(0, EASY_RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** Keeps the visits; false when this browser won't keep them. */
export function writeRecent(recent, storage = globalThis.localStorage) {
  try {
    storage.setItem(EASY_RECENT_KEY, JSON.stringify(recent));
    return true;
  } catch {
    return false;
  }
}

/** The visits after opening `route` (a canonical route) at `now`: newest
 * first, one entry per route, old and surplus ones dropped. */
export function noteVisit(recent, route, now) {
  if (!ROUTE.test(route)) return recent;
  const kept = recent.filter((entry) => entry.route !== route && now - entry.at < EASY_RECENT_MS);
  return [{ route, at: now }, ...kept].slice(0, EASY_RECENT_LIMIT);
}

/**
 * What easy mode shows: `pages` (a Set of primary destination ids) and
 * `segments` ({ page → Set of segment ids }), from the core places, the
 * recent visits and `current` (the route on screen, { page, segment }).
 */
export function easyNavigation(recent, now, current = null) {
  const pages = new Set(EASY_CORE.pages);
  const segments = Object.fromEntries(Object.entries(EASY_CORE.segments).map(([page, ids]) => [page, new Set(ids)]));
  const keep = (page, segment) => {
    pages.add(page);
    if (segment) (segments[page] ??= new Set()).add(segment);
  };
  for (const entry of recent) {
    if (now - entry.at >= EASY_RECENT_MS) continue;
    const [page, segment] = entry.route.split("/");
    keep(page, segment ?? null);
  }
  if (current?.page) keep(current.page, current.segment ?? null);
  return { pages, segments };
}
