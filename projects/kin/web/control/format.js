// Numbers and dates for the control panel, in the reader's own language.

const UNITS = ["bytes", "KB", "MB", "GB", "TB"];

/** 1536 → "1.5 KB"; null → "Not known". Decimal units, as disks are sold. */
export function formatBytes(bytes, locale) {
  if (!Number.isFinite(bytes) || bytes < 0) return "Not known";
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) { value /= 1000; unit += 1; }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${UNITS[unit]}`;
}

/** An ISO time as a date and time, or "Not known". */
export function formatDateTime(iso, locale) {
  const time = Date.parse(iso ?? "");
  if (Number.isNaN(time)) return "Not known";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(time));
}

/** An ISO time as a date, or "Not known". */
export function formatDate(iso, locale) {
  const time = Date.parse(iso ?? "");
  if (Number.isNaN(time)) return "Not known";
  return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(time));
}

/** An hour of the day as a time: 3 → "03:00" (or "3:00 AM"), in the
 * reader's own clock style. */
export function formatHour(hour, locale) {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(2026, 0, 1, hour, 0));
}

/** "3 households", "1 device". */
export function countOf(count, one, many) {
  return `${new Intl.NumberFormat().format(count)} ${count === 1 ? one : many}`;
}

/** A code as the person reads it: "abcde23456" → "ABCDE-23456". */
export function displayCode(text) {
  const code = String(text ?? "").toUpperCase().replace(/[\s-]/g, "");
  return code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}
