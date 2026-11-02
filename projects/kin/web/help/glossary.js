// Kin's words, each explained in one plain sentence (#618, ADR 0021). Help
// (help-content.js) shows the ones a page uses under "Words on this page",
// so easy mode never leaves a person with a word they don't know. Pure: no
// DOM.

/** One sentence per term, written for someone who rarely uses apps. */
export const GLOSSARY = Object.freeze({
  household: "The people who share this Kin: your family, or the people you live or work with.",
  admin: "A household admin is a grown-up who can add and remove people and change settings for everyone.",
  sync: "Kin copies your changes to your household's other phones and computers, so everyone sees the same thing.",
  archive: "Putting something away so it no longer shows; it is kept, not thrown out, and can come back.",
  passkey: "A way to sign in with your face, your fingerprint or your phone's screen lock instead of typing a password.",
  "backup key": "A long code you keep somewhere safe, on paper or in a password manager; it gets you back into Kin if you lose your phone.",
  "backup code": "A short code you print or write down; it lets you back in if you forget your password.",
  device: "A phone, tablet or computer.",
  encrypted: "Scrambled so that only your household's own phones and computers can read it.",
  handoff: "A short note that passes something on to a person, such as \"Dog fed at 6\".",
  routine: "Something that comes round again, like bin night, that Kin keeps track of for you.",
  checklist: "A list of steps you can use again and again, like packing for a trip.",
  staple: "Something you buy again and again, like milk; one tap puts it back on the shopping list.",
  area: "A part of your home, such as the kitchen or the car, that things can belong to.",
  pulse: "A quick note about how you're doing right now, which fades after a few hours.",
  pin: "Keeping something at the top of Today so it is easy to find.",
  export: "Saving a copy of your household's things as a file.",
  restore: "Bringing back your household's things from a copy you saved.",
  recovery: "The ways back into Kin when you lose a phone or forget how to sign in.",
  pairing: "Joining a new phone or computer to your household, usually by scanning a code.",
  "private storage": "A place for your own things that only you can open, on all your devices.",
  account: "Your username and password (or passkey), which let you sign in on any device.",
  "simple view": "A very simple layout an admin can turn on for a child.",
  "easy mode": "Bigger text and buttons, with fewer things on the screen at once.",
  "quick add": "The Add button at the top, for writing something down fast from any page.",
  fridge: "A shared drawing board, like the door of a real fridge.",
  sitter: "A babysitter or guest; their page shows only what you choose to leave for them.",
  journal: "Your own diary in Kin; only you can read it.",
});

/**
 * Words that need explaining before easy mode may show them, each mapped to
 * its glossary entry. Matched as whole words, ignoring case.
 */
export const JARGON = Object.freeze({
  admin: "admin", admins: "admin",
  sync: "sync", syncs: "sync", synced: "sync", syncing: "sync",
  archive: "archive", archived: "archive", archives: "archive",
  passkey: "passkey", passkeys: "passkey",
  "backup key": "backup key", "backup code": "backup code",
  device: "device", devices: "device",
  encrypted: "encrypted", encryption: "encrypted", encrypt: "encrypted",
  handoff: "handoff", handoffs: "handoff",
  routine: "routine", routines: "routine",
  checklist: "checklist", checklists: "checklist",
  staple: "staple", staples: "staple",
  area: "area", areas: "area",
  pulse: "pulse",
  pin: "pin", pinned: "pin",
  export: "export",
  restore: "restore",
  recovery: "recovery",
  pairing: "pairing", pair: "pairing",
  "private storage": "private storage",
  "simple view": "simple view",
  "quick add": "quick add",
});

const WORD = /[\p{L}\p{N}]/u;

function hasWord(text, word) {
  const haystack = text.toLocaleLowerCase("en");
  for (let at = haystack.indexOf(word); at !== -1; at = haystack.indexOf(word, at + 1)) {
    const before = at === 0 ? "" : haystack[at - 1];
    const after = haystack[at + word.length] ?? "";
    if (!WORD.test(before) && !WORD.test(after)) return true;
  }
  return false;
}

/** The glossary terms whose words appear in `text`, in glossary order. */
export function jargonIn(text) {
  const found = new Set();
  for (const [word, term] of Object.entries(JARGON)) if (hasWord(String(text ?? ""), word)) found.add(term);
  return Object.keys(GLOSSARY).filter((term) => found.has(term));
}

/** Glossary entries for `terms`, as { term, text }, skipping unknown ones. */
export function glossFor(terms) {
  return terms.filter((term) => Object.hasOwn(GLOSSARY, term)).map((term) => ({ term, text: GLOSSARY[term] }));
}
