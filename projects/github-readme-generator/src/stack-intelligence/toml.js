// A bounded, non-executing TOML reader for dependency declarations.
// Unknown value syntax is rejected when a consumer requests that value.
export function splitOutside(text, separator = ",") {
  const parts = [];
  let start = 0,
    quote = "",
    escaped = false,
    depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\" && quote === '"') escaped = true;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quote || depth !== 0) throw Error("Unbalanced manifest value.");
  parts.push(text.slice(start).trim());
  return parts;
}
export function tomlValue(raw, depth = 0) {
  if (depth > 12) throw Error("Manifest nesting exceeds the analysis limit.");
  raw = raw.trim();
  if (raw.startsWith('"""') || raw.startsWith("'''"))
    throw Error("Multiline dependency values are not supported.");
  if (raw.startsWith('"')) {
    const value = JSON.parse(raw);
    if (typeof value !== "string") throw Error("Expected a string.");
    return value;
  }
  if (/^'[^']*'$/.test(raw)) return raw.slice(1, -1);
  if (raw === "true" || raw === "false") return raw === "true";
  if (/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith("[") && raw.endsWith("]"))
    return splitOutside(raw.slice(1, -1))
      .filter(Boolean)
      .map((v) => tomlValue(v, depth + 1));
  if (raw.startsWith("{") && raw.endsWith("}")) {
    const entries = splitOutside(raw.slice(1, -1))
      .filter(Boolean)
      .map((pair) => {
        const at = pair.indexOf("=");
        if (at < 1) throw Error("Invalid inline dependency table.");
        return [
          tomlKey(pair.slice(0, at))[0],
          tomlValue(pair.slice(at + 1), depth + 1),
        ];
      });
    if (new Set(entries.map(([key]) => key)).size !== entries.length)
      throw Error("Duplicate dependency key.");
    return Object.fromEntries(entries);
  }
  throw Error("Unsupported dependency value syntax.");
}
function tomlKey(raw) {
  return splitOutside(raw.trim(), ".").map((part) => {
    if (part.length > 1000)
      throw Error("Manifest key exceeds the analysis limit.");
    if (/^[A-Za-z0-9_-]+$/.test(part)) return part;
    const value = tomlValue(part);
    if (typeof value !== "string") throw Error("Invalid manifest key.");
    return value;
  });
}
export function tomlRecords(source) {
  const statements = [];
  let buffer = "",
    quote = "",
    triple = false,
    escaped = false,
    comment = false,
    depth = 0,
    line = 1,
    start = 1;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (comment) {
      if (c !== "\n") continue;
      comment = false;
    }
    if (quote) {
      buffer += c;
      if (escaped) escaped = false;
      else if (c === "\\" && quote === '"') escaped = true;
      else if (
        c === quote &&
        (!triple || source.slice(i, i + 3) === quote.repeat(3))
      ) {
        if (triple) {
          buffer += quote.repeat(2);
          i += 2;
        }
        quote = "";
        triple = false;
      }
    } else if (c === "#") {
      comment = true;
      continue;
    } else if (c === '"' || c === "'") {
      quote = c;
      triple = source.slice(i, i + 3) === c.repeat(3);
      buffer += c;
      if (triple) {
        buffer += c.repeat(2);
        i += 2;
      }
    } else if (c === "\n" && depth === 0) {
      if (buffer.trim()) statements.push({ raw: buffer.trim(), line: start });
      buffer = "";
      start = line + 1;
    } else {
      buffer += c;
      if (c === "[" || c === "{") depth++;
      if (c === "]" || c === "}") depth--;
      if (depth < 0) throw Error("Unbalanced TOML.");
    }
    if (c === "\n") line++;
  }
  if (quote || depth !== 0) throw Error("Unterminated TOML value.");
  if (buffer.trim()) statements.push({ raw: buffer.trim(), line: start });
  let path = [];
  const records = [],
    seen = new Set();
  for (const statement of statements) {
    const raw = statement.raw;
    if (raw.startsWith("[[")) {
      path = ["__array_table__"];
      continue;
    }
    if (raw.startsWith("[") && raw.endsWith("]")) {
      path = tomlKey(raw.slice(1, -1));
      continue;
    }
    const parts = splitOutside(raw, "=");
    if (parts.length < 2) throw Error("Unsupported TOML statement.");
    const key = tomlKey(parts.shift());
    const full = [...path, ...key],
      identity = JSON.stringify(full);
    if (seen.has(identity) && path[0] !== "__array_table__")
      throw Error("Duplicate TOML declaration.");
    seen.add(identity);
    records.push({ path: full, raw: parts.join("="), line: statement.line });
  }
  return records;
}
