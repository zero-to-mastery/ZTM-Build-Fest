// Meals (#333, ADR 0012): the JavaScript side of rust/src/meals.rs.
//
// - Commands (KCMD actions 59–63, and 80–82 for fuller meal plans, #679)
//   carry the event's exact canonical payload, as fridge commands do; Rust
//   decodes it strictly and refuses anything not canonical, so these
//   encoders normalize text exactly as Rust does.
// - KMLS is the meals view (recipes and the meals around today): v1 from
//   `kin_meals` has dinners only, v2 from `kin_meal_plans` every slot and
//   favourites. KMSP is a plan for putting a recipe's, a meal's or a week's
//   ingredients on Shopping (KMPQ v1, or v2 for a slot or a week).
//
// Text rules (Rust `collapse`): runs of Unicode White_Space become one space
// and the ends are trimmed. That is Rust's `char::is_whitespace`, which is
// not JavaScript's `\s` (U+FEFF is not white space; U+0085 is), so the set is
// spelled out.

export const MEAL_COMMANDS = Object.freeze(["save-recipe", "archive-recipe", "set-dinner", "clear-dinner", "set-dinner-cook"]);
export const MEAL_EVENT_KINDS = Object.freeze(["RECIPE_SAVED", "RECIPE_ARCHIVED", "DINNER_SET", "DINNER_CLEARED", "DINNER_COOK_SET"]);
export const FIRST_MEAL_KIND = 59;
// Fuller meal plans (#679, ADR 0022 §7): KCMD actions and kinds 80–82.
export const MEAL_PLAN_COMMANDS = Object.freeze(["set-meal", "clear-meal", "set-recipe-favourite"]);
export const MEAL_PLAN_EVENT_KINDS = Object.freeze(["MEAL_SET", "MEAL_CLEARED", "RECIPE_FAVOURITE_SET"]);
export const FIRST_MEAL_PLAN_KIND = 80;

/** The meals of a day, in the planner's order; the index + 1 is the slot
 * code of kinds 80–81, KMLS v2 and KMPQ v2. Dinner travels on kinds 61–63. */
export const MEAL_SLOTS = Object.freeze(["breakfast", "lunch", "dinner", "snack"]);
const slotCode = (slot) => {
  const code = MEAL_SLOTS.indexOf(slot) + 1;
  if (code < 1) throw new MealFormatError("Kin received an invalid meal.");
  return code;
};
/** A slot that kinds 80–81 carry (every one but dinner). */
const eventSlotCode = (slot) => {
  if (slot === "dinner") throw new MealFormatError("Kin received an invalid meal.");
  return slotCode(slot);
};

export const MAX_RECIPES = 200;
export const MAX_RECIPE_INGREDIENTS = 40;
export const MAX_RECIPE_NAME_CHARS = 80;
export const MAX_RECIPE_NAME_BYTES = 256;
export const MAX_INGREDIENT_CHARS = 120;
export const MAX_INGREDIENT_BYTES = 256;
export const MAX_RECIPE_NOTES_CHARS = 2000;
export const MAX_RECIPE_NOTES_BYTES = 4096;
export const MAX_RECIPE_PAYLOAD_BYTES = 4352;

/** What a Shopping plan does with one ingredient line. */
export const PLAN_OUTCOMES = Object.freeze({ 1: "add", 2: "readd-staple", 3: "already" });

export class MealFormatError extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = "MealFormatError";
    this.detail = detail;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WHITE_SPACE = new RegExp(`[${SPACE}]+`, "gu");
const TRAILING_SPACE = new RegExp(`[${SPACE}]+$`, "u");
const EDGE_SPACE = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu");
const CONTROL = /\p{Cc}/u;
const HEX_ID = /^[a-f0-9]{32}$/;

/** Rust `collapse`: one space between words, nothing at the ends. */
export function collapseText(text) {
  return String(text ?? "").replace(WHITE_SPACE, " ").replace(/^ | $/g, "");
}

const characters = (text) => [...text].length;

function singleLine(text, maxChars, maxBytes, label) {
  const value = collapseText(text);
  if (!value) throw new MealFormatError(`${label} can't be empty.`);
  if (characters(value) > maxChars || encoder.encode(value).length > maxBytes)
    throw new MealFormatError(`${label} can be at most ${maxChars} characters.`);
  if (CONTROL.test(value)) throw new MealFormatError(`${label} can only hold plain text.`);
  return value;
}

export const normalizeRecipeName = (name) => singleLine(name, MAX_RECIPE_NAME_CHARS, MAX_RECIPE_NAME_BYTES, "A recipe name");
export const normalizeDinnerName = (name) => singleLine(name, MAX_RECIPE_NAME_CHARS, MAX_RECIPE_NAME_BYTES, "A dinner");
/** A planned meal's name (kind 80), with the same rules as a dinner's. */
export const normalizeMealName = (name) => singleLine(name, MAX_RECIPE_NAME_CHARS, MAX_RECIPE_NAME_BYTES, "A meal");
export const normalizeIngredient = (text) => singleLine(text, MAX_INGREDIENT_CHARS, MAX_INGREDIENT_BYTES, "An ingredient");

/** Rust `normalize_notes`: lines kept, CRLF as LF, trailing spaces gone. */
export function normalizeNotes(notes) {
  const text = String(notes ?? "").replace(/\r\n/g, "\n").split("\n")
    .map((line) => line.replace(TRAILING_SPACE, "")).join("\n").replace(EDGE_SPACE, "");
  if (characters(text) > MAX_RECIPE_NOTES_CHARS || encoder.encode(text).length > MAX_RECIPE_NOTES_BYTES)
    throw new MealFormatError(`Notes can be at most ${MAX_RECIPE_NOTES_CHARS} characters.`);
  if ([...text].some((character) => character !== "\n" && CONTROL.test(character)))
    throw new MealFormatError("Notes can only hold plain text.");
  return text;
}

/**
 * The editor's "Ingredients (one per line)" text as ingredient lines: blank
 * lines drop; a line that is too long throws, naming its line number.
 * `previous` (the saved ingredients) keeps each line's staple link while its
 * text is unchanged.
 */
export function ingredientsFromText(text, previous = []) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const ingredients = [];
  lines.forEach((line, index) => {
    if (!collapseText(line)) return;
    let value;
    try { value = normalizeIngredient(line); }
    catch (error) { throw new MealFormatError(`Line ${index + 1}: ${error.message}`, { line: index + 1 }); }
    // A line typed twice is kept once (case aside); Rust accepts either.
    if (ingredients.some((entry) => entry.text.toLowerCase() === value.toLowerCase())) return;
    const kept = previous.find((entry) => entry.text === value && entry.stapleId);
    ingredients.push({ text: value, stapleId: kept?.stapleId ?? null });
  });
  if (ingredients.length > MAX_RECIPE_INGREDIENTS)
    throw new MealFormatError(`A recipe can have at most ${MAX_RECIPE_INGREDIENTS} ingredients.`);
  return ingredients;
}

/** A recipe's canonical form, or a MealFormatError naming what to fix. */
export function normalizeRecipe({ name, ingredients = [], notes = "" }) {
  const recipe = {
    name: normalizeRecipeName(name),
    ingredients: ingredients.map((ingredient, index) => {
      if (ingredient.stapleId != null && (!HEX_ID.test(ingredient.stapleId) || /^0+$/.test(ingredient.stapleId)))
        throw new MealFormatError("Kin received an invalid staple.");
      try { return { text: normalizeIngredient(ingredient.text), stapleId: ingredient.stapleId ?? null }; }
      catch (error) { throw new MealFormatError(`Line ${index + 1}: ${error.message}`, { line: index + 1 }); }
    }),
    notes: normalizeNotes(notes),
  };
  if (recipe.ingredients.length > MAX_RECIPE_INGREDIENTS)
    throw new MealFormatError(`A recipe can have at most ${MAX_RECIPE_INGREDIENTS} ingredients.`);
  if (recipePayloadLength(recipe) > MAX_RECIPE_PAYLOAD_BYTES)
    throw new MealFormatError("This recipe is too long to save. Shorten its notes or ingredients.");
  return recipe;
}

function recipePayloadLength({ name, ingredients, notes }) {
  return 2 + encoder.encode(name).length + 2 +
    ingredients.reduce((total, line) => total + 4 + (line.stapleId ? 16 : 0) + 2 + encoder.encode(line.text).length, 0) +
    2 + encoder.encode(notes).length;
}

const hexBytes = (hex, what) => {
  if (typeof hex !== "string" || !HEX_ID.test(hex) || /^0+$/.test(hex)) throw new MealFormatError(`Kin received an invalid ${what}.`);
  return Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));
};
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** A civil date "YYYY-MM-DD" (or a YYYYMMDD number) as its u32 encoding. */
export function encodeDate(value) {
  const match = typeof value === "number" ? /^(\d{4})(\d{2})(\d{2})$/.exec(String(value)) : /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) throw new MealFormatError("Kin received an invalid date.");
  const [year, month, day] = match.slice(1).map(Number);
  // setUTCFullYear, because Date.UTC reads years 0–99 as 1900–1999.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  if (year < 1 || probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day)
    throw new MealFormatError("Kin received an invalid date.");
  return year * 10_000 + month * 100 + day;
}

/** YYYYMMDD as "YYYY-MM-DD". */
export const dateText = (encoded) => `${String(Math.floor(encoded / 10_000)).padStart(4, "0")}-${String(Math.floor(encoded / 100) % 100).padStart(2, "0")}-${String(encoded % 100).padStart(2, "0")}`;

class Writer {
  constructor() { this.parts = []; this.length = 0; }
  bytes(value) { this.parts.push(value); this.length += value.length; }
  u8(value) { this.bytes(Uint8Array.of(value)); }
  u16(value) { this.bytes(Uint8Array.of(value & 0xff, value >> 8)); }
  u32(value) { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value, true); this.bytes(out); }
  text(value) { const bytes = encoder.encode(value); this.u16(bytes.length); this.bytes(bytes); }
  optionalId(hex, what) {
    if (hex == null) { this.bytes(new Uint8Array(4)); return; }
    this.bytes(Uint8Array.of(1, 0, 0, 0));
    this.bytes(hexBytes(hex, what));
  }
  done() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) { out.set(part, at); at += part.length; }
    return out;
  }
}

/** The canonical payload of a meals command (rust/src/meals.rs). */
export function encodeMealPayload(command) {
  const out = new Writer();
  switch (command?.type) {
    case "save-recipe": {
      const recipe = normalizeRecipe(command);
      out.bytes(hexBytes(command.recipeId, "recipe"));
      out.text(recipe.name);
      out.u8(recipe.ingredients.length);
      out.u8(0);
      for (const line of recipe.ingredients) {
        out.optionalId(line.stapleId, "staple");
        out.text(line.text);
      }
      out.text(recipe.notes);
      break;
    }
    case "archive-recipe":
      out.bytes(hexBytes(command.recipeId, "recipe"));
      break;
    case "set-dinner":
      out.u32(encodeDate(command.date));
      out.optionalId(command.recipeId ?? null, "recipe");
      out.text(normalizeDinnerName(command.name));
      break;
    case "clear-dinner":
      out.u32(encodeDate(command.date));
      break;
    case "set-dinner-cook":
      out.u32(encodeDate(command.date));
      out.optionalId(command.memberId ?? null, "member");
      break;
    case "set-meal":
      out.u32(encodeDate(command.date));
      out.bytes(Uint8Array.of(eventSlotCode(command.slot), 0, 0, 0));
      out.optionalId(command.recipeId ?? null, "recipe");
      out.text(normalizeMealName(command.name));
      break;
    case "clear-meal":
      out.u32(encodeDate(command.date));
      out.bytes(Uint8Array.of(eventSlotCode(command.slot), 0, 0, 0));
      break;
    case "set-recipe-favourite":
      if (typeof command.favourite !== "boolean") throw new MealFormatError("Kin received an invalid meals change.");
      out.bytes(hexBytes(command.recipeId, "recipe"));
      out.bytes(Uint8Array.of(command.favourite ? 1 : 0, 0, 0, 0));
      break;
    default:
      throw new MealFormatError("Kin received an invalid meals change.");
  }
  return out.done();
}

/** The KCMD action (event kind) of a meals command type, or -1. */
export function mealCommandKind(type) {
  const meal = MEAL_COMMANDS.indexOf(type);
  if (meal >= 0) return FIRST_MEAL_KIND + meal;
  const plan = MEAL_PLAN_COMMANDS.indexOf(type);
  return plan >= 0 ? FIRST_MEAL_PLAN_KIND + plan : -1;
}

/** A KCMD packet for a meals command: the 128-byte header (identity and
 * logical time as for every command) with the payload as its text. */
export function encodeMealIntent(command, identity) {
  const kind = mealCommandKind(command?.type);
  if (kind < 0) throw new MealFormatError("Kin received an invalid meals change.");
  const payload = encodeMealPayload(command);
  const packet = new Uint8Array(128 + payload.length);
  const view = new DataView(packet.buffer);
  packet.set([75, 67, 77, 68, 1, 0, 0, 0]);
  view.setUint16(8, kind, true);
  // Identity IDs come as hex or as 16 bytes, as for every household command.
  const identityId = (value, what) => (value instanceof Uint8Array && value.length === 16 && value.some(Boolean) ? value : hexBytes(value, what));
  packet.set(identityId(identity.eventId, "event"), 12);
  packet.set(identityId(identity.householdId, "household"), 28);
  packet.set(identityId(identity.actorId, "member"), 44);
  packet.set(identityId(identity.deviceId, "device"), 60);
  if (!Number.isSafeInteger(identity.timestamp)) throw new MealFormatError("Kin received an invalid time.");
  view.setBigInt64(76, BigInt(identity.timestamp), true);
  const logicalTime = BigInt(identity.logicalTime);
  if (logicalTime <= 0n) throw new MealFormatError("Kin received an invalid event order.");
  view.setBigUint64(84, logicalTime, true);
  view.setUint32(124, payload.length, true);
  packet.set(payload, 128);
  return packet;
}

/** A plan query for a recipe ({ recipeId }) or a date's dinner ({ date }),
 * as KMPQ v1; for a date's meal in another slot ({ date, slot }) or the
 * seven days from a date ({ week }), as KMPQ v2 (#679). The KINE context
 * follows it. */
export function encodePlanQuery(source) {
  const out = new Uint8Array(32);
  out.set([75, 77, 80, 81, 1, 0, 0, 0]);
  const view = new DataView(out.buffer);
  if (source?.recipeId) {
    out[8] = 1;
    out.set(hexBytes(source.recipeId, "recipe"), 12);
  } else if (source?.week) {
    out[4] = 2;
    out[8] = 4;
    view.setUint32(28, encodeDate(source.week), true);
  } else if (source?.slot && source.slot !== "dinner") {
    out[4] = 2;
    out[8] = 3;
    out[9] = slotCode(source.slot);
    view.setUint32(28, encodeDate(source.date), true);
  } else {
    out[8] = 2;
    view.setUint32(28, encodeDate(source?.date), true);
  }
  return out;
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = 0;
  }
  need(count) { if (this.at + count > this.bytes.length) throw new MealFormatError("Kin received invalid meals."); }
  u8() { this.need(1); return this.bytes[this.at++]; }
  u16() { this.need(2); const value = this.view.getUint16(this.at, true); this.at += 2; return value; }
  u32() { this.need(4); const value = this.view.getUint32(this.at, true); this.at += 4; return value; }
  id() { this.need(16); const value = toHex(this.bytes.subarray(this.at, this.at + 16)); this.at += 16; return /^0+$/.test(value) ? null : value; }
  text() { const length = this.u16(); this.need(length); const value = decoder.decode(this.bytes.subarray(this.at, this.at + length)); this.at += length; return value; }
  skip(count) { this.need(count); this.at += count; }
  /** Reads the 8-byte header; returns the version, one of `versions`. */
  header(magic, versions = [1]) {
    this.need(8);
    const version = this.view.getUint16(4, true);
    if (String.fromCharCode(...this.bytes.subarray(0, 4)) !== magic || !versions.includes(version) || this.view.getUint16(6, true) !== 0) throw new MealFormatError("Kin received invalid meals.");
    this.at = 8;
    return version;
  }
  end() { if (this.at !== this.bytes.length) throw new MealFormatError("Kin received invalid meals."); }
}

const STAPLE_STATUS = ["none", "active", "archived"];

/**
 * KMLS as { recipes, dinners, meals }: recipes in the order first saved,
 * with each ingredient's staple status and (v2) whether it's a favourite;
 * dinners ascending by date, the name as shown, and the cook's member ID (or
 * null). `meals` holds every slot by date then slot ({ date, slot, recipeId,
 * cookId, name }, slot one of MEAL_SLOTS); from v1 it is just the dinners.
 */
export function decodeMeals(bytes) {
  const read = new Reader(bytes);
  const version = read.header("KMLS", [1, 2]);
  const recipeCount = read.u32(), mealCount = read.u32();
  const recipes = [];
  for (let index = 0; index < recipeCount; index += 1) {
    const recipeId = read.id();
    const name = read.text();
    const count = read.u8();
    // v1: three reserved bytes; v2: favourite flags, then two reserved.
    const flags = read.u8();
    if (read.u16() !== 0 || (version === 1 ? flags !== 0 : flags > 1)) throw new MealFormatError("Kin received invalid meals.");
    const ingredients = [];
    for (let line = 0; line < count; line += 1) {
      const status = STAPLE_STATUS[read.u8()];
      read.skip(3);
      const stapleId = read.id();
      if (!status) throw new MealFormatError("Kin received invalid meals.");
      ingredients.push({ text: read.text(), stapleId, staple: status });
    }
    recipes.push({ recipeId, name, ingredients, notes: read.text(), favourite: flags === 1 });
  }
  const meals = [];
  for (let index = 0; index < mealCount; index += 1) {
    const date = dateText(read.u32());
    let slot = "dinner", flags;
    if (version === 1) {
      flags = read.u8();
      read.skip(3);
    } else {
      slot = MEAL_SLOTS[read.u8() - 1];
      flags = read.u8();
      read.skip(2);
      if (!slot) throw new MealFormatError("Kin received invalid meals.");
    }
    const recipeId = read.id();
    const cookId = read.id();
    meals.push({ date, slot, recipeId: flags & 1 ? recipeId : null, cookId: flags & 2 ? cookId : null, name: read.text() });
  }
  read.end();
  const dinners = meals.filter((meal) => meal.slot === "dinner").map(({ slot: _slot, ...dinner }) => dinner);
  return { recipes, dinners, meals };
}

/** KMSP v1 as [{ outcome: "add" | "readd-staple" | "already", text, stapleId }]. */
export function decodePlan(bytes) {
  const read = new Reader(bytes);
  read.header("KMSP");
  const count = read.u32();
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    const outcome = PLAN_OUTCOMES[read.u8()];
    read.skip(3);
    const stapleId = read.id();
    if (!outcome) throw new MealFormatError("Kin received an invalid plan.");
    lines.push({ outcome, text: read.text(), stapleId });
  }
  read.end();
  return lines;
}

/**
 * The words for what adding ingredients did, from the plan's outcomes:
 * "Added 4 · Re-added 2 Staples (Milk, Eggs) · Already on Shopping 1 (Bread)".
 */
export function planSummary(lines) {
  const added = lines.filter((line) => line.outcome === "add");
  const staples = lines.filter((line) => line.outcome === "readd-staple");
  const listed = lines.filter((line) => line.outcome === "already");
  const named = (group) => (group.length ? ` (${group.slice(0, 3).map((line) => line.text).join(", ")}${group.length > 3 ? ", …" : ""})` : "");
  const parts = [];
  if (added.length) parts.push(`Added ${added.length}`);
  if (staples.length) parts.push(`Re-added ${staples.length} ${staples.length === 1 ? "Staple" : "Staples"}${named(staples)}`);
  if (listed.length) parts.push(`Already on Shopping ${listed.length}${named(listed)}`);
  if (!parts.length) return "This recipe has no ingredients to add.";
  return parts.join(" · ");
}
