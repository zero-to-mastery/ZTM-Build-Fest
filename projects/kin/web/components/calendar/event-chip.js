// One calendar occurrence drawn as a chip (#661): the person's colour as a
// small bar of swatches, the title, when, and who by name — colour is
// never the only signal. Shared by the Day, Week and Month views, Today
// and (later) the kitchen display. Household text only ever goes in
// through textContent.
import { colourClass } from "../../calendar/member-colours.js";
import { occurrenceLabel, peopleText, sourceText, whenText } from "../../calendar/calendar-layout.js";

/**
 * `people` is { labelOf(memberId), colourOf(memberId) }. The chip is a
 * button that asks to open the event (`kin:calendar-open-event`) unless it
 * is read-only (an outside calendar's) or `open` is false.
 */
export function eventChip(placed, date, people, { open = true, compact = false, extraClass = "" } = {}) {
  const { occurrence } = placed;
  const interactive = open && !placed.readonly;
  const chip = document.createElement(interactive ? "button" : "div");
  chip.className = `cal-event${compact ? " cal-event-compact" : ""}${extraClass ? ` ${extraClass}` : ""}`;
  if (interactive) chip.type = "button";
  chip.dataset.key = placed.key;
  if (occurrence.eventId) chip.dataset.eventId = occurrence.eventId;
  chip.dataset.date = String(date);
  if (occurrence.cancelled) chip.classList.add("cal-event-cancelled");
  if (placed.readonly) chip.classList.add("cal-event-outside");
  chip.setAttribute("aria-label", occurrenceLabel(placed, date, people.labelOf));
  chip.append(swatches(occurrence.attendees, people));
  const body = document.createElement("span");
  body.className = "cal-event-body";
  const title = document.createElement("span");
  title.className = "cal-event-title";
  title.textContent = occurrence.title;
  const when = document.createElement("span");
  when.className = "cal-event-when";
  when.textContent = whenText(placed, date);
  const who = document.createElement("span");
  who.className = "cal-event-who";
  who.textContent = peopleText(occurrence.attendees, people.labelOf);
  body.append(title, when, who);
  // An outside calendar's occurrence (#668) says where it comes from.
  if (placed.readonly) {
    const source = document.createElement("span");
    source.className = "cal-event-source";
    source.textContent = sourceText(occurrence);
    body.append(source);
  }
  if (occurrence.place && !compact) {
    const place = document.createElement("span");
    place.className = "cal-event-place";
    place.textContent = occurrence.place;
    body.append(place);
  }
  chip.append(body);
  if (interactive) {
    chip.addEventListener("click", () => chip.dispatchEvent(new CustomEvent("kin:calendar-open-event", {
      bubbles: true, composed: true, detail: { placed, date, opener: chip },
    })));
  }
  return chip;
}

/** The colour bar: one swatch per attendee (at most four), or a neutral
 * one for "Everyone". Hidden from assistive technology: the names say it. */
export function swatches(attendees, people) {
  const bar = document.createElement("span");
  bar.className = "cal-swatches";
  bar.setAttribute("aria-hidden", "true");
  const ids = (attendees ?? []).slice(0, 4);
  if (!ids.length) {
    const swatch = document.createElement("span");
    swatch.className = "cal-swatch cal-swatch-everyone";
    bar.append(swatch);
  }
  for (const id of ids) {
    const swatch = document.createElement("span");
    swatch.className = `cal-swatch ${colourClass(people.colourOf(id))}`;
    bar.append(swatch);
  }
  return bar;
}

/** A quiet line for something else that falls on a day: a meal, a dated
 * item or a routine. Items open their details. */
export function extraLine(entry) {
  const row = document.createElement("li");
  row.className = `cal-extra cal-extra-${entry.kind}`;
  if (entry.itemId) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cal-extra-open";
    button.textContent = entry.text;
    if (entry.meta) button.setAttribute("aria-label", `${entry.text}, ${entry.meta}`);
    button.addEventListener("click", () => button.dispatchEvent(new CustomEvent("kin:open-item", {
      bubbles: true, composed: true, detail: { itemId: entry.itemId, opener: button },
    })));
    row.append(button);
  } else {
    const text = document.createElement("span");
    text.className = "cal-extra-text";
    text.textContent = entry.text;
    row.append(text);
  }
  if (entry.meta) {
    const meta = document.createElement("span");
    meta.className = "cal-extra-meta";
    meta.textContent = entry.meta;
    row.append(meta);
  }
  return row;
}
