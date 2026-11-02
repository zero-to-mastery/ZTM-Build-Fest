// The Customize look screen's logic (ADR 0256, #350): the plain words and the choices for each
// control, and pure helpers for the unsaved look. A look is an object of choices; a control that is
// absent means "the theme as it is". The server owns every rule (ADR 0248); nothing here accepts
// text, so every value is one of a fixed list of ids or a color from a picker.

export const CONTROL_ORDER = Object.freeze(["palette", "accent", "fontStyle", "textSize", "roundness", "spacing", "pageWidth", "headingWeight"]);

/** Main color swatches: a few friendly colors. Any color can still be chosen with the picker. */
export const ACCENT_SWATCHES = Object.freeze([
  { hex: "#2457d6", name: "Blue" },
  { hex: "#0f766e", name: "Teal" },
  { hex: "#2f7d32", name: "Green" },
  { hex: "#b7791f", name: "Gold" },
  { hex: "#c2410c", name: "Orange" },
  { hex: "#b91c1c", name: "Red" },
  { hex: "#be185d", name: "Pink" },
  { hex: "#6d28d9", name: "Purple" },
  { hex: "#475569", name: "Slate" },
]);

export const DEFAULT_PICKER_COLOR = "#2457d6";

/** The choices of each ladder control, in words. The ids are the server's (`choices` in GET look). */
export const CHOICES = Object.freeze({
  fontStyle: [
    { id: "modern-sans", label: "Modern", hint: "Clean and simple" },
    { id: "classic-serif", label: "Classic", hint: "Like a printed book" },
    { id: "friendly-rounded", label: "Friendly", hint: "Soft and round" },
    { id: "techie-mono", label: "Techie", hint: "Like typed code" },
  ],
  textSize: [
    { id: "small", label: "Small", hint: "Fits more on the screen" },
    { id: "medium", label: "Medium", hint: "A comfortable size" },
    { id: "large", label: "Large", hint: "Easier to read" },
    { id: "extra-large", label: "Extra large", hint: "The easiest to read" },
  ],
  roundness: [
    { id: "square", label: "Square", hint: "Sharp corners" },
    { id: "soft", label: "Soft", hint: "Gently rounded corners" },
    { id: "round", label: "Round", hint: "Very round corners" },
  ],
  spacing: [
    { id: "compact", label: "Tight", hint: "Things sit close together" },
    { id: "comfortable", label: "Comfortable", hint: "A balanced amount of space" },
    { id: "airy", label: "Roomy", hint: "Lots of space around things" },
  ],
  pageWidth: [
    { id: "narrow", label: "Narrow", hint: "Short lines, easy to follow" },
    { id: "medium", label: "Medium", hint: "A balanced width" },
    { id: "wide", label: "Wide", hint: "Uses more of the screen" },
  ],
  headingWeight: [
    { id: "normal", label: "Regular", hint: "Light, calm headings" },
    { id: "bold", label: "Bold", hint: "Strong, clear headings" },
  ],
});

/** The words for each control: its name, a question-free line of help and what "default" means. */
export const CONTROL_TEXT = Object.freeze({
  palette: { label: "Looks", help: "Start from a ready-made look. It sets the colors and the font. You can change anything after." },
  accent: { label: "Main color", help: "Used for links and buttons. Pick a color below, or choose your own." },
  fontStyle: { label: "Font style", help: "The lettering of your whole site." },
  textSize: { label: "Text size", help: "How big the writing is." },
  roundness: { label: "Corners", help: "How round the corners of boxes and buttons are." },
  spacing: { label: "Spacing", help: "How much room there is between things." },
  pageWidth: { label: "Page width", help: "How wide your writing can get on a big screen." },
  headingWeight: { label: "Heading weight", help: "How heavy the headings look." },
});

const KEYS = new Set(CONTROL_ORDER);

/** A look made of just the controls this screen knows, as plain strings. */
export function lookFrom(value) {
  const out = {};
  if (value && typeof value === "object") {
    for (const key of CONTROL_ORDER) if (typeof value[key] === "string" && value[key] !== "" && value[key] !== "theme") out[key] = value[key];
  }
  return out;
}

export function lookSame(a, b) {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

function sorted(look) {
  return CONTROL_ORDER.filter((key) => look && look[key]).map((key) => [key, look[key]]);
}

/** The look with one control chosen. */
export function setControl(look, id, value) {
  if (!KEYS.has(id)) return { ...look };
  return { ...look, [id]: value };
}

/** The look with one control back at the theme's own. */
export function clearControl(look, id) {
  const next = { ...look };
  delete next[id];
  return next;
}

/** A curated look chosen: its palette and font style, and no chosen accent (the look brings its own). */
export function applyCurated(look, curated) {
  const next = { ...look, palette: curated.id };
  if (curated.fontStyle) next.fontStyle = curated.fontStyle;
  delete next.accent;
  return next;
}

/** What a save sends: versioned, with only the chosen controls; `{}` is "the theme as it is". */
export function lookPayload(look) {
  const chosen = sorted(look);
  if (!chosen.length) return {};
  return { version: 1, ...Object.fromEntries(chosen) };
}

/** A lookup of the plain name for a control's value. */
export function valueWords(control, value, looks = []) {
  if (!value) return "";
  if (control === "accent") return ACCENT_SWATCHES.find((swatch) => swatch.hex === value)?.name || value;
  if (control === "palette") return looks.find((item) => item.id === value)?.name || value;
  return (CHOICES[control] || []).find((choice) => choice.id === value)?.label || value;
}

/** A short line saying what is chosen, or that the theme's own is used. */
export function controlSummary(control, look, looks = []) {
  const value = look[control];
  const name = CONTROL_TEXT[control].label.toLowerCase();
  return value ? `Chosen: ${valueWords(control, value, looks)}.` : `Using the theme's own ${name}.`;
}

/** What differs between your look and a newer saved one, in the words the screen uses. */
export function compareLooks(mine, theirs, looks = []) {
  const rows = [];
  for (const control of CONTROL_ORDER) {
    if ((mine[control] || "") === (theirs[control] || "")) continue;
    rows.push({
      control,
      label: CONTROL_TEXT[control].label,
      mine: valueWords(control, mine[control], looks) || "the theme's own",
      theirs: valueWords(control, theirs[control], looks) || "the theme's own",
    });
  }
  return rows;
}

/** Remember a look so it can be undone; the newest are kept. */
export function pushHistory(history, look, limit = 50) {
  const next = [...history, { ...look }];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** The words for a failed request. */
export function lookErrorText(error) {
  if (error && error.status === 401) return "You have been signed out. Sign in again; your changes are kept on this device.";
  const text = error?.data?.error || error?.message;
  return text ? String(text) : "Something went wrong. Your changes are still here.";
}
