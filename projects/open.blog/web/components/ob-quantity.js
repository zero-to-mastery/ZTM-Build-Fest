// Amounts and durations in recipe text, for <ob-recipe>. No DOM access, so it
// is tested under Node (tests/web/quantity.test.mjs).
//
//   findQuantity("1 1/2 cups flour") -> { start, end, values: [1.5], ... }
//   scaleQuantity(found, 2)          -> "3"
//   findDurations("Bake 20-25 minutes") -> [{ index, length, seconds: 1200 }]

const UNICODE_FRACTIONS = {
  "½": 1 / 2, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 1 / 4, "¾": 3 / 4, "⅕": 1 / 5, "⅖": 2 / 5,
  "⅗": 3 / 5, "⅘": 4 / 5, "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8,
};
const FR = Object.keys(UNICODE_FRACTIONS).join("");
const SLASH = "[/⁄]"; // "/" or U+2044 FRACTION SLASH, common in pasted recipes

// One amount, most specific first: "1-1/2" (US), "1 1/2", "1½", "1 ½", "1/2",
// "½", "1,000" (digit grouping), "1.5", "1,5", "12".
const AMOUNT =
  `(?:\\d+-\\d+${SLASH}\\d+|\\d+\\s+\\d+${SLASH}\\d+|\\d+\\s?[${FR}]|\\d+${SLASH}\\d+|[${FR}]` +
  `|\\d{1,3}(?:,\\d{3})+(?![\\d,])|\\d+(?:[.,]\\d+)?)`;
// An amount or a range at the very start of an ingredient line. The amount
// must end the number: "3rd" is not a quantity, "400g" is.
const LEADING = new RegExp(`^(\\s*)(${AMOUNT})(?:(\\s*(?:-|–|—|to)\\s*)(${AMOUNT}))?(?![\\d/⁄.,])`);
// A second measure after the first one's unit: "12 oz / 340 g", "1 cup (240 ml)".
// Not after a container ("1 can (400 g)": the can size is fixed), not when
// followed by "each", and not a compound measure ("1 lb 2 oz").
const CONTAINERS = "cans?|tins?|jars?|packages?|packets?|packs?|bags?|box(?:es)?|bottles?|cartons?|sticks?|blocks?|pouch(?:es)?|containers?|tubs?";
const ALSO = new RegExp(
  `^(\\s*(?!(?:${CONTAINERS})\\b)[A-Za-z][A-Za-z.]*\\s*(?:/|\\(|or\\b)\\s*)(${AMOUNT})(?:(\\s*(?:-|–|—|to)\\s*)(${AMOUNT}))?` +
    `(?=\\s*[A-Za-zµ]+(?![A-Za-zµ])\\.?(?!\\s*\\d)(?!\\s+each\\b))`,
  "i",
);
const METRIC = /^(?:g|kg|mg|gr|grams?|kilos?|kilograms?|ml|l|dl|cl|litres?|liters?|millilitres?|milliliters?)\b/i;

/** The value of one amount as written, or NaN. */
export function parseAmount(raw) {
  const s = raw.trim().replace(/⁄/g, "/");
  let m = /^(\d+)[-\s]+(\d+)\/(\d+)$/.exec(s);
  if (m) return Number(m[3]) === 0 ? NaN : Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = new RegExp(`^(\\d+)\\s?([${FR}])$`).exec(s);
  if (m) return Number(m[1]) + UNICODE_FRACTIONS[m[2]];
  m = /^(\d+)\/(\d+)$/.exec(s);
  if (m) return Number(m[2]) === 0 ? NaN : Number(m[1]) / Number(m[2]);
  if (s in UNICODE_FRACTIONS) return UNICODE_FRACTIONS[s];
  if (/^\d{1,3}(,\d{3})+$/.test(s)) return Number(s.replace(/,/g, ""));
  return Number(s.replace(",", "."));
}

/** One quantity at `pos` matched by `re`: values and how they were written. */
function quantityAt(text, pos, re) {
  const m = re.exec(text.slice(pos));
  if (!m) return null;
  const [all, lead, first, sep, second] = m;
  const values = [parseAmount(first)];
  if (second !== undefined) values.push(parseAmount(second));
  if (values.some((v) => !Number.isFinite(v) || v <= 0)) return null;
  const written = first + (second || "");
  const grouped = /\d,\d{3}(?!\d)/.test(written) && !/\d,\d{1,2}(?!\d)/.test(written);
  const end = pos + all.length;
  const unit = (/^\s*([A-Za-zµ]+)/.exec(text.slice(end)) || [])[1] || "";
  return {
    start: pos + lead.length,
    end,
    values,
    separator: sep || "",
    fractions: new RegExp(`${SLASH}|[${FR}]`).test(written),
    decimals: !grouped && /\d[.,]\d/.test(written),
    comma: !grouped && /\d,\d/.test(written),
    grouped,
    metric: METRIC.test(unit),
  };
}

/**
 * The quantity at the start of `text`: where it is, its value(s), and how it
 * was written (so the scaled amount keeps the style). `also` is a second
 * measure in another unit ("12 oz / 340 g"). Null when the line does not
 * start with a number ("Salt, to taste").
 */
export function findQuantity(text) {
  const first = quantityAt(text, 0, LEADING);
  if (!first) return null;
  const also = quantityAt(text, first.end, ALSO);
  return also ? { ...first, also } : first;
}

const NICE = [
  [0, ""], [1 / 8, "⅛"], [1 / 6, "⅙"], [1 / 4, "¼"], [1 / 3, "⅓"], [3 / 8, "⅜"], [1 / 2, "½"],
  [5 / 8, "⅝"], [2 / 3, "⅔"], [3 / 4, "¾"], [5 / 6, "⅚"], [7 / 8, "⅞"], [1, ""],
];

/** A cook-friendly fraction: the nearest eighth, sixth, quarter or third. */
function asFraction(n) {
  let whole = Math.floor(n);
  let best = NICE[0];
  for (const candidate of NICE) {
    if (Math.abs(n - whole - candidate[0]) < Math.abs(n - whole - best[0])) best = candidate;
  }
  if (best[0] === 1) whole += 1;
  if (whole === 0 && best[0] === 0) return null; // too small for a kitchen fraction
  return (whole ? String(whole) : "") + best[1];
}

function asDecimal(n, { comma, grouped, metric }) {
  // Grams and millilitres are weighed, not divided: whole numbers from 10 up.
  const digits = n >= 100 || (metric && n >= 10) ? 0 : n >= 5 ? 1 : 2;
  let text = String(Number(n.toFixed(digits)));
  if (Number(text) === 0) text = String(Number(n.toPrecision(1))); // never 0 for a real amount
  if (grouped && n >= 1000) text = Math.round(n).toLocaleString("en-US");
  return comma ? text.replace(".", ",") : text;
}

/**
 * Format an amount the way a cook would read it. Fractions stay fractions
 * (rounded to eighths, sixths, quarters or thirds), decimals and metric
 * amounts stay decimals, and whole numbers become fractions only while small
 * (1½ eggs) and decimals once larger.
 */
export function formatAmount(n, { fractions = false, decimals = false, comma = false, grouped = false, metric = false, mode } = {}) {
  const style = mode || (decimals || metric ? "decimal" : fractions || n < 5 ? "fraction" : "decimal");
  if (style === "fraction") {
    const f = asFraction(n);
    if (f !== null) return f;
  }
  return asDecimal(n, { comma, grouped, metric });
}

/** One quantity's text after multiplying by `factor`. The style is chosen
 * once for the whole quantity, so both ends of a range read the same way. */
function scaleOne(q, factor) {
  const values = q.values.map((v) => v * factor);
  const max = Math.max(...values);
  let mode = q.decimals || q.metric ? "decimal" : q.fractions || max < 5 ? "fraction" : "decimal";
  // If any end is too small for a kitchen fraction, use decimals for all ends.
  if (mode === "fraction" && values.some((v) => asFraction(v) === null)) mode = "decimal";
  const texts = values.map((v) => formatAmount(v, { ...q, mode }));
  // A range whose ends round to the same amount reads as that amount.
  if (texts.length === 2 && texts[0] === texts[1]) return texts[0];
  return texts.join(q.separator || "");
}

/** The quantity's text after multiplying by `factor`. */
export function scaleQuantity(found, factor) {
  return scaleOne(found, factor);
}

/** The second measure's text after scaling, or null when there is none. */
export function scaleAlso(found, factor) {
  return found.also ? scaleOne(found.also, factor) : null;
}

// ---------- Durations for step timers ----------

const UNIT_SECONDS = { h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, min: 60, mins: 60, minute: 60, minutes: 60, sec: 1, secs: 1, second: 1, seconds: 1 };
const DUR_NUM = `(?:\\d+-\\d+${SLASH}\\d+|\\d+\\s+\\d+${SLASH}\\d+|\\d+\\s?[${FR}]|\\d+${SLASH}\\d+|\\d+(?:[.,]\\d+)?|[${FR}])`;
const DURATION = new RegExp(`(${DUR_NUM})(?:\\s*(?:-|–|—|to)\\s*(${DUR_NUM}))?\\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\\b`, "gi");

/**
 * Durations in a step: "10 minutes", "10-12 mins", "1 1/2 hours",
 * "1 hour 30 minutes", "2 minutes 30 seconds", "½ hour". A range starts the
 * timer at its shorter end, so nothing overcooks. Returns
 * [{ index, length, seconds }] in order.
 */
export function findDurations(text) {
  const found = [];
  DURATION.lastIndex = 0;
  let m;
  while ((m = DURATION.exec(text))) {
    const unit = UNIT_SECONDS[m[3].toLowerCase()];
    const seconds = Math.round(parseAmount(m[1]) * unit);
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    const prev = found[found.length - 1];
    const gap = prev ? text.slice(prev.index + prev.length, m.index) : null;
    // "1 hour 30 minutes", "1 hr. 20 min.", "2 hours, 15 minutes and 30
    // seconds": one timer.
    if (prev && prev.unit > unit && /^\.?\s*,?\s*(?:and\s*)?$/i.test(gap)) {
      prev.length = m.index + m[0].length - prev.index;
      prev.seconds += seconds;
      prev.unit = unit;
      continue;
    }
    // "45 minutes to 1 hour": a range across units starts at its shorter end.
    if (prev && prev.unit < unit && /^\s*(?:-|–|—|to)\s*$/i.test(gap)) {
      prev.length = m.index + m[0].length - prev.index;
      prev.unit = unit;
      continue;
    }
    found.push({ index: m.index, length: m[0].length, seconds, unit });
  }
  return found.map(({ index, length, seconds }) => ({ index, length, seconds }));
}

/** 75 -> "1:15"; 3725 -> "1:02:05". */
export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
