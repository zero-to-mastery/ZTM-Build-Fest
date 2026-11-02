const encoder = new TextEncoder();
const MAX_CALENDAR_EVENTS = 10_000;
const MAX_CALENDAR_BYTES = 16 * 1024 * 1024;

export function createCalendarExport(items, exportedAt = new Date()) {
  if (!Array.isArray(items)) {
    throw new TypeError("Calendar export requires an Item list.");
  }
  if (!(exportedAt instanceof Date) || !Number.isFinite(exportedAt.getTime())) {
    throw new TypeError("Calendar export requires a valid timestamp.");
  }
  if (exportedAt.getUTCFullYear() < 1 || exportedAt.getUTCFullYear() > 9999) {
    throw new RangeError("Calendar export timestamp must use a four-digit year.");
  }

  const planned = items
    .filter((item) => item.status === "active" && item.planningDate != null)
    .sort((left, right) =>
      left.planningDate - right.planningDate ||
      left.itemId.localeCompare(right.itemId),
    );
  if (planned.length > MAX_CALENDAR_EVENTS) {
    throw new RangeError("Calendar export exceeds the 10,000-Item limit.");
  }

  const lines = [];
  let bytes = 0;
  const appendLine = (line) => {
    bytes += encoder.encode(line).length + 2;
    if (bytes > MAX_CALENDAR_BYTES) {
      throw new RangeError("Calendar export exceeds the 16 MiB file limit.");
    }
    lines.push(line);
  };
  for (const line of [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Kin//Planned Items//EN",
    "CALSCALE:GREGORIAN",
  ]) appendLine(line);
  const stamp = exportedAt.toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");

  for (const item of planned) {
    if (typeof item.itemId !== "string" || typeof item.text !== "string") {
      throw new TypeError("Calendar export encountered an invalid Item.");
    }
    for (const line of [
      "BEGIN:VEVENT",
      `UID:kin-${identityHex(item.itemId)}@kin.local`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${formatCivilDate(item.planningDate)}`,
      "DURATION:P1D",
      `SUMMARY:${escapeText(item.text)}`,
      "END:VEVENT",
    ]) appendLine(foldLine(line));
  }

  appendLine("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

function formatCivilDate(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 99_991_231) {
    throw new RangeError("Calendar export encountered an invalid planning date.");
  }
  const date = String(value).padStart(8, "0");
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]) {
    throw new RangeError("Calendar export encountered an invalid planning date.");
  }
  return date;
}

// RFC 5545 TEXT allows no control characters except horizontal tab. Line
// breaks (including NEL and the Unicode line/paragraph separators) become an
// escaped newline; every other C0/C1 control and DEL is dropped.
function escapeText(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, "\\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

function foldLine(line) {
  let result = "";
  let segment = "";
  let octets = 0;
  for (const character of line) {
    const codepoint = character.codePointAt(0);
    const size = codepoint <= 0x7f ? 1
      : codepoint <= 0x7ff ? 2
        : codepoint <= 0xffff ? 3 : 4;
    if (octets + size > 75) {
      result += `${segment}\r\n `;
      segment = "";
      octets = 1;
    }
    segment += character;
    octets += size;
  }
  return result + segment;
}

function identityHex(value) {
  return [...encoder.encode(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
