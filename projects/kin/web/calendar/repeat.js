// Repeats in the event editor (#662): the engine's RRULE subset
// (kin-calendar.js `repeat`) as choices a person understands, and back.
// Pure: no DOM.
//
// - Every day, every week (on chosen weekdays), every month (on a day of
//   the month, the nth weekday, the last weekday or the last day), every
//   year; with "every N" and an end after a number of times or on a date.
// - Monthly and yearly choices come from the start date: an event on
//   Tuesday 13 October can repeat "on day 13", "on the second Tuesday" or
//   (13 Oct isn't the last Tuesday) not "on the last Tuesday".
import { addDays, civilParts, daysInMonth, weekday } from "./calendar-time.js";
import { dayLabel, weekdayNames } from "./calendar-layout.js";

export const FREQUENCY_CHOICES = Object.freeze([
  Object.freeze({ value: "", label: "Doesn't repeat" }),
  Object.freeze({ value: "daily", label: "Every day" }),
  Object.freeze({ value: "weekly", label: "Every week" }),
  Object.freeze({ value: "monthly", label: "Every month" }),
  Object.freeze({ value: "yearly", label: "Every year" }),
]);

const ORDINALS = ["first", "second", "third", "fourth", "fifth"];
const UNITS = { daily: ["day", "days"], weekly: ["week", "weeks"], monthly: ["month", "months"], yearly: ["year", "years"] };

/** Which occurrence of its weekday `date` is in its month: 1–5. */
export function nthWeekdayOf(date) {
  return Math.floor((civilParts(date).day - 1) / 7) + 1;
}

/** Whether `date` is the last of its weekday in its month. */
export function isLastWeekdayOf(date) {
  return civilParts(addDays(date, 7)).month !== civilParts(date).month;
}

/** Whether `date` is the last day of its month. */
export function isLastDayOf(date) {
  const { year, month, day } = civilParts(date);
  return day === daysInMonth(year, month);
}

/**
 * The ways a monthly (or yearly) repeat can follow `start`:
 * [{ id, label, rule }] where `rule` is the part of a repeat that picks the
 * day ({ monthDay } or { nth, weekday }).
 */
export function monthlyChoices(start) {
  const { day } = civilParts(start);
  const name = weekdayNames()[weekday(start)];
  const choices = [{ id: "day", label: `On day ${day}`, rule: { monthDay: day } }];
  const nth = nthWeekdayOf(start);
  if (nth <= 4) choices.push({ id: "nth", label: `On the ${ORDINALS[nth - 1]} ${name}`, rule: { nth, weekday: weekday(start) } });
  if (isLastWeekdayOf(start)) choices.push({ id: "last-weekday", label: `On the last ${name}`, rule: { nth: -1, weekday: weekday(start) } });
  if (isLastDayOf(start)) choices.push({ id: "last-day", label: "On the last day of the month", rule: { monthDay: -1 } });
  return choices;
}

/** Which monthly choice a saved repeat uses, or "day" when none fits. */
export function monthlyChoiceOf(repeat, start) {
  const found = monthlyChoices(start).find(({ rule }) =>
    (rule.monthDay != null && rule.monthDay === repeat?.monthDay) ||
    (rule.nth != null && rule.nth === repeat?.nth && rule.weekday === repeat?.weekday));
  return found?.id ?? "day";
}

/**
 * A repeat from the editor's choices:
 * { frequency, interval, weekdays, monthly (a monthlyChoices id), end
 *   ("never" | "count" | "until"), count, until }, for an event starting
 * on `start`. Null for "doesn't repeat".
 */
export function repeatFromChoices(choices, start) {
  const frequency = choices?.frequency || "";
  if (!frequency) return null;
  const repeat = { frequency, interval: Math.max(1, Math.trunc(Number(choices.interval) || 1)) };
  if (frequency === "weekly") {
    const days = [...new Set(choices.weekdays ?? [])].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort();
    repeat.weekdays = days.length ? days : [weekday(start)];
  }
  if (frequency === "monthly" || frequency === "yearly") {
    const choice = monthlyChoices(start).find((entry) => entry.id === choices.monthly) ?? monthlyChoices(start)[0];
    Object.assign(repeat, choice.rule);
  }
  if (choices.end === "count") repeat.count = Math.max(1, Math.trunc(Number(choices.count) || 1));
  if (choices.end === "until" && choices.until) repeat.until = choices.until;
  return repeat;
}

/** The editor's choices for a saved repeat (inverse of repeatFromChoices). */
export function choicesFromRepeat(repeat, start) {
  if (!repeat) return { frequency: "", interval: 1, weekdays: [weekday(start)], monthly: "day", end: "never", count: 10, until: null };
  return {
    frequency: repeat.frequency,
    interval: repeat.interval ?? 1,
    weekdays: repeat.weekdays?.length ? [...repeat.weekdays] : [weekday(start)],
    monthly: monthlyChoiceOf(repeat, start),
    end: repeat.count ? "count" : repeat.until ? "until" : "never",
    count: repeat.count ?? 10,
    until: repeat.until ?? null,
  };
}

function listText(words) {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** A repeat in words: "Every week on Monday and Wednesday, 10 times",
 * "Every 2 months on the second Tuesday, until 3 December 2026". */
export function describeRepeat(repeat, start) {
  if (!repeat) return "Doesn't repeat";
  const [one, many] = UNITS[repeat.frequency] ?? ["time", "times"];
  const interval = repeat.interval ?? 1;
  let text = interval === 1 ? `Every ${one}` : `Every ${interval} ${many}`;
  if (repeat.frequency === "weekly") {
    const names = weekdayNames();
    const days = repeat.weekdays ?? [];
    text += days.length === 7 ? " on every day" : ` on ${listText(days.map((day) => names[day]))}`;
  }
  if (repeat.frequency === "monthly" || repeat.frequency === "yearly") {
    const names = weekdayNames();
    if (repeat.nth != null) text += ` on the ${repeat.nth === -1 ? "last" : ORDINALS[repeat.nth - 1]} ${names[repeat.weekday]}`;
    else if (repeat.monthDay === -1) text += " on the last day";
    else if (repeat.frequency === "monthly" && repeat.monthDay) text += ` on day ${repeat.monthDay}`;
    if (repeat.frequency === "yearly") text += ` in ${new Date(Date.UTC(2000, civilParts(start).month - 1, 1)).toLocaleDateString(undefined, { month: "long", timeZone: "UTC" })}`;
  }
  if (repeat.count) text += repeat.count === 1 ? ", once" : `, ${repeat.count} times`;
  if (repeat.until) text += `, until ${dayLabel(repeat.until, { year: true })}`;
  return text;
}
