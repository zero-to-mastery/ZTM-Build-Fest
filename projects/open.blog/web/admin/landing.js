// The Landing page builder's model (ADR 0249, #326). Plain data and pure functions with no DOM, so
// the rules can be tested without a browser. The server owns every rule and the canonical form
// (ADR 0245, ADR 0246); nothing here decides what is saved, it only keeps the owner from sending
// what the server is sure to refuse, and says why in plain words. There is deliberately no field
// that takes markup or styling: every section is typed data.

/** Limits the server enforces, repeated so the form can say them before a save (crates/openblog-core/src/landing.rs). */
export const LIMITS = Object.freeze({
  sections: 40,
  heading: 120,
  subheading: 300,
  markdown: 20000,
  label: 60,
  url: 2048,
  alt: 250,
  line: 200,
  answer: 2000,
  latestCount: 50,
  buttons: 6,
  hoursRows: 14,
  socialLinks: 12,
  faqItems: 30,
});

const text = (name, label, extra = {}) => ({ kind: "text", name, label, ...extra });
const address = (name, label, extra = {}) => ({ kind: "url", name, label, ...extra });

const BUTTON_FIELDS = [
  text("label", "What the button says", { required: true, max: LIMITS.label, hint: "Two or three words, such as Read the blog." }),
  address("href", "Where it goes", { required: true, schemes: "links", hint: "A page on your site such as /archive/, a web address starting with https://, or mailto: and tel: links." }),
  { kind: "select", name: "style", label: "How it looks", options: [["primary", "Bold (main button)"], ["secondary", "Quiet (second choice)"]], default: "primary" },
];

/**
 * Every section type an owner can add: its plain name, what it is for, a sample of what it shows and
 * the fields its form has. Order is the order the picker lists them.
 */
export const SECTION_CATALOG = Object.freeze([
  {
    type: "welcome",
    label: "Welcome banner",
    icon: "\u{1F44B}",
    description: "A big welcome with a button.",
    sample: "Welcome to my blog. Stories about gardens and tea. [Read the blog]",
    blank: () => ({ heading: "Welcome to my blog", subheading: "A short line about what you write." }),
    fields: [
      text("heading", "Welcome heading", { required: true, max: LIMITS.heading }),
      text("subheading", "A line underneath", { max: LIMITS.subheading }),
      {
        kind: "group", name: "image", label: "Picture", addLabel: "Add a picture", removeLabel: "Remove the picture",
        blank: () => ({ src: "", alt: "" }),
        fields: [
          address("src", "Picture address", { required: true, schemes: "pictures", hint: "A picture on your site such as /images/me.jpg, or an address starting with https://." }),
          text("alt", "Describe the picture", { required: true, max: LIMITS.alt, hint: "For people who cannot see it. Say what is in the picture." }),
        ],
      },
      { kind: "group", name: "button", label: "Button", addLabel: "Add a button", removeLabel: "Remove the button", blank: () => ({ label: "Read the blog", href: "/archive/", style: "primary" }), fields: BUTTON_FIELDS },
    ],
  },
  {
    type: "rich-text",
    label: "Text",
    icon: "\u{1F4DD}",
    description: "A few paragraphs about you or your blog.",
    sample: "About this blog. I write about slow living, with lists and links.",
    blank: () => ({ markdown: "Write something about you or your blog." }),
    fields: [{ kind: "richtext", name: "markdown", label: "Your text", max: LIMITS.markdown, hint: "Use the buttons above the text for headings, bold, italic, links, lists, quotes and pictures. Anything you type is shown as written; it is never run as code." }],
  },
  {
    type: "latest-posts",
    label: "Latest posts",
    icon: "\u{1F4F0}",
    description: "Your newest posts, kept up to date for you.",
    sample: "Latest posts: Tea in spring, A week of bread, Notes on paper.",
    blank: () => ({ heading: "Latest posts" }),
    fields: [
      text("heading", "Heading", { required: true, max: LIMITS.heading }),
      { kind: "number", name: "count", label: "How many posts", optional: true, min: 1, max: LIMITS.latestCount, integer: true, hint: "Leave empty to show the usual number for your blog." },
    ],
  },
  {
    type: "series",
    label: "Series",
    icon: "\u{1F4DA}",
    description: "Your series of posts, as cards.",
    sample: "Series: The Garden Diary (6 posts).",
    blank: () => ({ heading: "Series" }),
    fields: [text("heading", "Heading", { required: true, max: LIMITS.heading })],
  },
  {
    type: "featured-post",
    label: "Featured post",
    icon: "⭐",
    description: "One post you want everyone to read first.",
    sample: "Start here: How I got started.",
    blank: () => ({ post: "", heading: "Start here" }),
    fields: [
      { kind: "post", name: "post", label: "Which post", required: true },
      text("heading", "Heading above it", { max: LIMITS.heading, hint: "Optional." }),
    ],
  },
  {
    type: "buttons",
    label: "Buttons",
    icon: "\u{1F518}",
    description: "A row of big buttons to the places you want people to go.",
    sample: "[Read the blog] [Email me]",
    blank: () => ({ items: [{ label: "Read the blog", href: "/archive/", style: "primary" }] }),
    fields: [{ kind: "list", name: "items", label: "Buttons", itemLabel: "Button", addLabel: "Add another button", max: LIMITS.buttons, blank: () => ({ label: "", href: "", style: "primary" }), fields: BUTTON_FIELDS }],
  },
  {
    type: "image",
    label: "Picture",
    icon: "\u{1F5BC}",
    description: "One picture with a caption.",
    sample: "A photo of the shop front. Caption: Open since 1998.",
    blank: () => ({ src: "", alt: "", caption: "" }),
    fields: [
      address("src", "Picture address", { required: true, schemes: "pictures", hint: "A picture on your site such as /images/shop.jpg, or an address starting with https://." }),
      text("alt", "Describe the picture", { required: true, max: LIMITS.alt, hint: "For people who cannot see it. Say what is in the picture." }),
      text("caption", "Caption", { max: LIMITS.line, hint: "Optional." }),
    ],
  },
  {
    type: "video",
    label: "Video",
    icon: "\u{1F3AC}",
    description: "A link to a YouTube or Vimeo video.",
    sample: "Watch: A short tour on YouTube.",
    blank: () => ({ provider: "youtube", video: "", title: "" }),
    fields: [
      { kind: "select", name: "provider", label: "Where the video is", options: [["youtube", "YouTube"], ["vimeo", "Vimeo"]], default: "youtube" },
      text("video", "Video code", { required: true, hint: "The last part of the video's address: for youtube.com/watch?v=dQw4w9WgXcQ it is dQw4w9WgXcQ." }),
      text("title", "What the video is", { required: true, max: LIMITS.line }),
    ],
  },
  {
    type: "map",
    label: "Map",
    icon: "\u{1F4CD}",
    description: "Where to find you, as a link to a map.",
    sample: "12 High Street (open in OpenStreetMap).",
    blank: () => ({ provider: "openstreetmap", label: "", lat: null, lon: null }),
    fields: [
      text("label", "Place name or address", { required: true, max: LIMITS.line }),
      { kind: "number", name: "lat", label: "Latitude", required: true, min: -90, max: 90, step: "any", hint: "A number from -90 to 90, such as 51.5072." },
      { kind: "number", name: "lon", label: "Longitude", required: true, min: -180, max: 180, step: "any", hint: "A number from -180 to 180, such as -0.1276." },
    ],
  },
  {
    type: "opening-hours",
    label: "Opening hours",
    icon: "\u{1F552}",
    description: "When you are open.",
    sample: "Monday to Friday 9am to 5pm. Weekend closed.",
    blank: () => ({ rows: [{ days: "Monday to Friday", hours: "9am to 5pm" }] }),
    fields: [
      { kind: "list", name: "rows", label: "Opening times", itemLabel: "Time", addLabel: "Add another time", max: LIMITS.hoursRows, blank: () => ({ days: "", hours: "" }), fields: [text("days", "Days", { required: true, max: LIMITS.label, hint: "Such as Monday to Friday." }), text("hours", "Hours", { required: true, max: LIMITS.label, hint: "Such as 9am to 5pm, or Closed." })] },
      text("note", "A note underneath", { max: LIMITS.line, hint: "Optional, such as Closed on holidays." }),
    ],
  },
  {
    type: "contact",
    label: "Contact details",
    icon: "✉",
    description: "An email, a phone number or an address.",
    sample: "me@example.com, +1 555 010 0100.",
    blank: () => ({ email: "", phone: "", address: "" }),
    fields: [
      { kind: "email", name: "email", label: "Email", max: LIMITS.line, hint: "Fill in at least one of the three." },
      { kind: "tel", name: "phone", label: "Phone number", max: LIMITS.label },
      text("address", "Address", { max: LIMITS.line }),
    ],
  },
  {
    type: "social-links",
    label: "Social links",
    icon: "\u{1F517}",
    description: "Links to your profiles elsewhere.",
    sample: "Mastodon, Bluesky, GitHub.",
    blank: () => ({ items: [{ label: "", href: "" }] }),
    fields: [{ kind: "list", name: "items", label: "Links", itemLabel: "Link", addLabel: "Add another link", max: LIMITS.socialLinks, blank: () => ({ label: "", href: "" }), fields: [text("label", "Name", { required: true, max: LIMITS.label, hint: "Such as Mastodon." }), address("href", "Address", { required: true, schemes: "https", hint: "Starts with https://." })] }],
  },
  {
    type: "faq",
    label: "Questions and answers",
    icon: "❓",
    description: "Answers to what people often ask.",
    sample: "Is it free? Yes, always.",
    blank: () => ({ items: [{ question: "", answer: "" }] }),
    fields: [{ kind: "list", name: "items", label: "Questions", itemLabel: "Question", addLabel: "Add another question", max: LIMITS.faqItems, blank: () => ({ question: "", answer: "" }), fields: [text("question", "Question", { required: true, max: LIMITS.line }), { kind: "textarea", name: "answer", label: "Answer", required: true, max: LIMITS.answer, rows: 4 }] }],
  },
  {
    type: "callout",
    label: "Notice",
    icon: "\u{1F4E3}",
    description: "A highlighted note, such as news or a warning.",
    sample: "Heads up: open late on Fridays.",
    blank: () => ({ tone: "info", title: "", body: "Write your note here." }),
    fields: [
      { kind: "select", name: "tone", label: "What kind of note", options: [["info", "Information"], ["success", "Good news"], ["warning", "Warning"]], default: "info" },
      text("title", "Title", { max: LIMITS.label, hint: "Optional." }),
      { kind: "textarea", name: "body", label: "The note", required: true, max: LIMITS.answer, rows: 4 },
    ],
  },
  {
    type: "business-facts",
    label: "Business facts",
    icon: "\u{1F3E2}",
    description: "Your name, phone, hours, license and insurance, kept in one place.",
    sample: "Maple Falls Flooring, (360) 555-0142, open Monday to Friday. Licensed and insured.",
    blank: () => ({ heading: "Contact and hours" }),
    fields: [text("heading", "Heading", { required: true, max: LIMITS.heading, hint: "The facts themselves are set once under Settings, then Business facts. Nothing is shown here until you have." })],
  },
]);

const BY_TYPE = new Map(SECTION_CATALOG.map((entry) => [entry.type, entry]));

/** The catalog entry for a type, or a stand-in for a type this version does not know. */
export function sectionInfo(type) {
  return BY_TYPE.get(type) || { type, label: "Unknown section", icon: "❓", description: "A section this version does not know.", sample: "", fields: [], blank: () => ({}) };
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clean = (value) => (typeof value === "string" ? value.trim() : "");
const shorten = (value, length = 80) => {
  const flat = String(value || "").replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};

/** The plain-language name a card shows: the type's own name. */
export function sectionTitle(section) {
  return sectionInfo(section?.type).label;
}

/** One line saying what the section holds right now, for its card. */
export function sectionSummary(section) {
  if (!isObject(section)) return "";
  const first = (...values) => values.map(clean).find(Boolean) || "";
  switch (section.type) {
    case "welcome":
      return shorten(first(section.heading, section.subheading)) || "No heading yet";
    case "rich-text":
      return shorten(first(section.markdown)) || "No text yet";
    case "latest-posts":
      return `${shorten(first(section.heading)) || "No heading yet"}${Number.isInteger(section.count) ? ` (${section.count} ${section.count === 1 ? "post" : "posts"})` : ""}`;
    case "series":
      return shorten(first(section.heading)) || "No heading yet";
    case "featured-post":
      return section.post ? `Post: ${section.post}` : "No post chosen yet";
    case "buttons":
      return summaryList(section.items, (item) => clean(item?.label), "button", "No buttons yet");
    case "image":
      return shorten(first(section.caption, section.alt, section.src)) || "No picture yet";
    case "video":
      return shorten(first(section.title)) || "No video yet";
    case "map":
      return shorten(first(section.label)) || "No place yet";
    case "opening-hours":
      return summaryList(section.rows, (row) => clean(row?.days), "time", "No times yet");
    case "contact":
      return shorten(first(section.email, section.phone, section.address)) || "No details yet";
    case "social-links":
      return summaryList(section.items, (item) => clean(item?.label), "link", "No links yet");
    case "faq":
      return summaryList(section.items, (item) => clean(item?.question), "question", "No questions yet");
    case "callout":
      return shorten(first(section.title, section.body)) || "No note yet";
    case "business-facts":
      return shorten(first(section.heading)) || "No heading yet";
    default:
      return "";
  }
}

function summaryList(items, name, noun, empty) {
  const list = Array.isArray(items) ? items : [];
  const names = list.map(name).filter(Boolean);
  if (!list.length) return empty;
  const count = `${list.length} ${noun}${list.length === 1 ? "" : "s"}`;
  return names.length ? `${count}: ${shorten(names.join(", "), 60)}` : count;
}

// ---------------------------------------------------------------- the page and its operations

/** A page from what the server sent, or a new empty one. The whole value is copied: fields this version does not know travel back unchanged. */
export function pageFrom(page) {
  const source = isObject(page) ? structuredClone(page) : {};
  delete source.format;
  delete source.version;
  return { ...source, sections: Array.isArray(source.sections) ? source.sections : [] };
}

/** The same page, for comparing against the saved one. */
export function pageSame(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** An id for a new section of a type that no other section has: `welcome`, `welcome-2`, ... */
export function uniqueId(type, sections) {
  const taken = new Set(sections.map((section) => section.id));
  if (!taken.has(type)) return type;
  for (let n = 2; ; n += 1) if (!taken.has(`${type}-${n}`)) return `${type}-${n}`;
}

/** A new section of a type, with a starting text that is safe to leave as it is where there is one. */
export function newSection(type, sections) {
  const info = sectionInfo(type);
  return { id: uniqueId(type, sections), type, ...info.blank() };
}

/** `sections` with a new one added after position `index` (at the end when omitted). Returns the new list and the new section. */
export function addSection(sections, type, index = sections.length) {
  if (sections.length >= LIMITS.sections) return { sections, added: null, full: true };
  const added = newSection(type, sections);
  const at = Math.max(0, Math.min(sections.length, index));
  return { sections: [...sections.slice(0, at), added, ...sections.slice(at)], added, full: false };
}

/** Move one section up or down by `step` (-1 or 1). Returns the same list when it cannot move. */
export function moveSection(sections, id, step) {
  const from = sections.findIndex((section) => section.id === id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= sections.length) return { sections, from, to: from };
  const next = [...sections];
  [next[from], next[to]] = [next[to], next[from]];
  return { sections: next, from, to };
}

/** Hide or show one section. A hidden section is kept and never shown to visitors. */
export function setHidden(sections, id, hidden) {
  return sections.map((section) => {
    if (section.id !== id) return section;
    const next = { ...section };
    if (hidden) next.hidden = true;
    else delete next.hidden;
    return next;
  });
}

/** Take one section out, remembering where it was so Undo can put it back in the same place. */
export function removeSection(sections, id) {
  const index = sections.findIndex((section) => section.id === id);
  if (index < 0) return { sections, removed: null };
  return { sections: sections.filter((_, i) => i !== index), removed: { section: sections[index], index } };
}

/** Put a removed section back where it was. If its id has been taken meanwhile it gets a new one. */
export function restoreSection(sections, removed) {
  if (!removed) return sections;
  const section = sections.some((other) => other.id === removed.section.id) ? { ...removed.section, id: uniqueId(removed.section.type, sections) } : removed.section;
  const at = Math.max(0, Math.min(sections.length, removed.index));
  return [...sections.slice(0, at), section, ...sections.slice(at)];
}

// ---------------------------------------------------------------- starter layouts (ADR 0258, #338)

const SAMPLE_NOTE = "This is a sample layout. Every sentence marked as a sample is a stand-in: replace it with your own words, then choose Save. Delete this note when you are done.";

/**
 * Ready-made starting points. Each is only a list of sections (the same typed data the builder
 * saves), never markup. `build({ posts })` returns fresh sections every time; `posts` are the
 * owner's published posts, so a featured post is only offered when there is one to feature.
 */
export const STARTERS = Object.freeze([
  {
    id: "welcome",
    label: "Welcome",
    description: "A friendly welcome, a few words about you and your newest posts.",
    build: () => [
      { id: "sample-note", type: "callout", tone: "info", title: "Sample layout", body: SAMPLE_NOTE },
      { id: "welcome", type: "welcome", heading: "Welcome to my blog", subheading: "Sample: a short line about what you write and who it is for.", button: { label: "Read the blog", href: "/archive/", style: "primary" } },
      { id: "about", type: "rich-text", markdown: "Sample: Hello, I am glad you are here. Write two or three sentences about yourself and why you write." },
      { id: "latest", type: "latest-posts", heading: "Latest posts" },
    ],
  },
  {
    id: "small-business",
    label: "Small business",
    description: "When you are open, how to reach you and where to find you.",
    build: () => [
      { id: "sample-note", type: "callout", tone: "info", title: "Sample layout", body: SAMPLE_NOTE },
      { id: "welcome", type: "welcome", heading: "Welcome to Sample Shop", subheading: "Sample: one line about what you sell or do." },
      { id: "hours", type: "opening-hours", rows: [{ days: "Monday to Friday", hours: "9am to 5pm" }, { days: "Saturday", hours: "10am to 2pm" }, { days: "Sunday", hours: "Closed" }], note: "Sample times: change them to your own." },
      { id: "contact", type: "contact", email: "you@example.com", phone: "+1 555 010 0100", address: "Sample: 12 High Street" },
      { id: "map", type: "map", provider: "openstreetmap", label: "Sample: 12 High Street", lat: 51.5072, lon: -0.1276 },
    ],
  },
  {
    id: "portfolio",
    label: "Portfolio",
    description: "Show one thing you are proud of, and where people can find you.",
    build: ({ posts = [] } = {}) => [
      { id: "sample-note", type: "callout", tone: "info", title: "Sample layout", body: SAMPLE_NOTE },
      { id: "welcome", type: "welcome", heading: "Hello, I am Sample Name", subheading: "Sample: what you make, in one line." },
      posts.length
        ? { id: "featured", type: "featured-post", post: posts[0].slug, heading: "Start here" }
        : { id: "latest", type: "latest-posts", heading: "My latest work", count: 3 },
      { id: "links", type: "buttons", items: [{ label: "See all my work", href: "/archive/", style: "primary" }, { label: "Email me", href: "mailto:you@example.com", style: "secondary" }] },
      { id: "social", type: "social-links", items: [{ label: "Sample profile", href: "https://example.com/you" }] },
    ],
  },
  {
    id: "newsletter",
    label: "Newsletter",
    description: "Invite people to follow along, with your newest posts underneath.",
    build: () => [
      { id: "sample-note", type: "callout", tone: "info", title: "Sample layout", body: SAMPLE_NOTE },
      { id: "welcome", type: "welcome", heading: "Get every new post", subheading: "Sample: say what readers will get and how often.", button: { label: "Follow along", href: "/rss.xml", style: "primary" } },
      { id: "about", type: "rich-text", markdown: "Sample: Tell people what each issue holds. Keep it short and kind." },
      { id: "latest", type: "latest-posts", heading: "Recent issues" },
    ],
  },
]);

/** The starter with this id, or null. */
export function starterById(id) {
  return STARTERS.find((starter) => starter.id === id) || null;
}

/** The sections of a starter, new each time. `scratch` is an empty page. */
export function starterSections(id, context = {}) {
  if (id === "scratch") return [];
  const starter = starterById(id);
  return starter ? starter.build(context) : [];
}

/** Whether choosing a layout would replace sections the owner already has, and so needs a yes first. */
export function replacingNeedsConfirm(sections, { exists = false, dirty = false } = {}) {
  return sections.length > 0 && (exists || dirty);
}

/** A page with its sections swapped for a layout, keeping everything else the page holds. The old sections are returned so Undo can bring them back. */
export function applyLayout(page, sections) {
  return { page: { ...page, sections }, previous: page.sections };
}

// ---------------------------------------------------------------- plain words, empty states and the tour (ADR 0259, #339)

/** The short list of words the page uses, for the Help part. Technical terms appear only here, in brackets. */
export const GLOSSARY = Object.freeze([
  { term: "Section", meaning: "One part of your landing page, such as a welcome, some text or a row of buttons. Sections are shown one after another from top to bottom." },
  { term: "Layout", meaning: "A ready-made set of sections to start from. It comes with sample words for you to replace." },
  { term: "Hide", meaning: "Keep a section but do not show it to visitors. You can show it again later." },
  { term: "Preview", meaning: "Shows your page the way visitors will see it, before you save. Nothing is changed." },
  { term: "Save", meaning: "Keeps your changes. Your site does not change for visitors until you publish." },
  { term: "Publish (make it live)", meaning: "Puts your saved page on your site so visitors can see it." },
  { term: "Web address", meaning: "Where something is on the internet, such as https://example.com (also called a URL). A page on your own site starts with a single /, such as /archive/." },
  { term: "Picture description", meaning: "A sentence that says what is in a picture, for people who cannot see it (also called alt text)." },
]);

/** What the page says when there is nothing in it yet. */
export const EMPTY_STATE_TEXT = "Your page has no sections yet. Choose a ready-made layout to start from, or choose Add a section to build it one piece at a time.";

/** The three steps of the optional tour. Plain text only. */
export const TOUR_STEPS = Object.freeze([
  Object.freeze({ title: "Your page is a list of sections", body: "Each card is one section of your landing page. Visitors see them one after another, from the top. Choose Add a section, or a ready-made layout, to fill the page." }),
  Object.freeze({ title: "Change a section", body: "Choose Edit on a card to change its words. Use Move up and Move down to put sections in a new order. Hide keeps a section but does not show it. Delete can always be undone." }),
  Object.freeze({ title: "See it, keep it, make it live", body: "Preview shows your page the way visitors will see it. Save keeps your changes. Publish (make it live) puts your saved page on your site. Nothing changes for visitors until you publish." }),
]);

const memoryTour = new Set();

/**
 * Remembers that the tour was dismissed: on this device when storage works, and for the life of the
 * page when it does not (every access is guarded, as for drafts). Once dismissed it never shows again.
 */
export function createTourStore(key, storage = () => globalThis.localStorage) {
  return {
    dismissed() {
      if (memoryTour.has(key)) return true;
      try {
        return storage()?.getItem(key) === "done";
      } catch {
        return false;
      }
    },
    dismiss() {
      memoryTour.add(key);
      try {
        storage()?.setItem(key, "done");
      } catch {
        // The page remembers it until it is closed.
      }
    },
  };
}

// ---------------------------------------------------------------- checking, in plain words

const SCHEMES = {
  links: ["https", "mailto", "tel"],
  pictures: ["https"],
  https: ["https"],
};

/** What is wrong with an address, in plain words, or "" when it is fine. */
export function addressProblem(value, schemes = "links") {
  const v = String(value ?? "");
  if (!v.trim()) return "";
  if (v !== v.trim() || /[\s\u0000-\u001f]/u.test(v)) return "An address cannot contain spaces. Remove them, or copy the address again.";
  if (v.includes("\\")) return "An address cannot contain a backslash. Use a forward slash (/) instead.";
  if (v.startsWith("//")) return "Start the address with https://, or with a single / for a page on your site.";
  const relative = v.startsWith("/") || v.startsWith("#");
  if (relative) return schemes === "https" ? "Start the address with https://." : "";
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(v)?.[1]?.toLowerCase();
  if (!scheme) return schemes === "https" ? "Start the address with https://." : "";
  if (scheme === "http") return "Use https:// rather than http://.";
  if (!(SCHEMES[schemes] || SCHEMES.links).includes(scheme)) return `Addresses starting with ${scheme}: are not allowed here. Use one that starts with https://.`;
  if (scheme === "https" && !/^https:\/\/[^/?#]+/i.test(v)) return "Add the site's name after https://.";
  if (scheme === "tel" && !/^tel:[0-9+().-]+$/i.test(v)) return "A tel: link holds only a phone number. Use digits, spaces and + - . ( ).";
  if (scheme === "mailto" && !/^mailto:[^?]+/i.test(v)) return "Add an email address after mailto:.";
  return "";
}

/** What is wrong with one field's value, in plain words, or "". */
export function fieldProblem(spec, value) {
  const empty = value === undefined || value === null || (typeof value === "string" && !value.trim());
  const name = spec.label.toLowerCase();
  if (spec.kind === "number") {
    if (empty) return spec.required ? `Enter a number for ${name}.` : "";
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return `${spec.label} must be a number. Type digits only, such as 12.`;
    if (spec.integer && !Number.isInteger(n)) return `${spec.label} must be a whole number. Remove the decimal point.`;
    if (spec.min !== undefined && n < spec.min) return `${spec.label} must be at least ${spec.min}. Enter ${spec.min} or more.`;
    if (spec.max !== undefined && n > spec.max) return `${spec.label} can be at most ${spec.max}. Enter ${spec.max} or less.`;
    return "";
  }
  if (spec.kind === "select") return "";
  if (spec.kind === "post") return empty ? "Choose a post." : "";
  if (empty) return spec.required ? `${spec.label} is needed. Fill it in before you save.` : "";
  const str = String(value);
  if (/[\u0000-\u001f]/u.test(str) && spec.kind !== "textarea" && spec.kind !== "richtext") return `${spec.label} must be on one line. Remove the line breaks.`;
  if (spec.max && [...str].length > spec.max) return `${spec.label} is ${[...str].length} characters; the most is ${spec.max}. Shorten it by ${[...str].length - spec.max}.`;
  if (spec.kind === "url") return addressProblem(str, spec.schemes);
  if (spec.kind === "email") {
    const at = str.indexOf("@");
    const domain = str.slice(at + 1);
    if (at < 1 || !domain.includes(".") || domain.startsWith(".") || domain.endsWith(".") || /[\s<>"'&,;]/.test(str)) return "That does not look like an email address. Write it like name@example.com.";
  }
  if (spec.kind === "tel") {
    const digits = (str.match(/\d/g) || []).length;
    if (!/^[0-9+().\- ]+$/.test(str) || digits < 3 || digits > 20) return "A phone number holds digits, spaces and + - . ( ). Remove any other characters.";
  }
  return "";
}

/** The kind-specific rule the field specs cannot say: a video code has the provider's shape. */
function sectionRules(section) {
  const problems = [];
  if (section.type === "video") {
    const id = String(section.video ?? "");
    const ok = section.provider === "vimeo" ? /^[0-9]{1,12}$/.test(id) : /^[A-Za-z0-9_-]{11}$/.test(id);
    if (id.trim() && !ok) problems.push({ path: "video", message: section.provider === "vimeo" ? "A Vimeo video code is digits only, such as 76979871. Copy the number at the end of the video's address." : "A YouTube video code is 11 letters, digits, - or _. Copy it from the end of the video's address." });
  }
  if (section.type === "rich-text" && /!\[\s*\]\(/.test(String(section.markdown ?? ""))) {
    problems.push({ path: "markdown", message: "Every picture needs a description. Remove the picture and add it again with the Image button, then describe it." });
  }
  if (section.type === "contact" && !clean(section.email) && !clean(section.phone) && !clean(section.address)) {
    problems.push({ path: "email", message: "Add an email, a phone number or an address." });
  }
  if (section.type === "featured-post" && section.post && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(section.post)) {
    problems.push({ path: "post", message: "Choose one of your posts." });
  }
  return problems;
}

function checkFields(specs, data, prefix, out) {
  const object = isObject(data) ? data : {};
  for (const spec of specs) {
    const path = prefix ? `${prefix}.${spec.name}` : spec.name;
    if (spec.kind === "group") {
      if (isObject(object[spec.name])) checkFields(spec.fields, object[spec.name], path, out);
    } else if (spec.kind === "list") {
      const items = Array.isArray(object[spec.name]) ? object[spec.name] : [];
      if (!items.length) out.push({ path, message: `Add at least one ${spec.itemLabel.toLowerCase()}.` });
      items.forEach((item, i) => checkFields(spec.fields, item, `${path}.${i}`, out));
    } else {
      const message = fieldProblem(spec, object[spec.name]);
      if (message) out.push({ path, message });
    }
  }
}

/** Every problem with one section: `{ path, message }`, where `path` names the field (`button.href`, `items.0.label`). */
export function sectionProblems(section) {
  const out = [];
  if (!isObject(section)) return [{ path: "", message: "This section cannot be read. Delete it and add it again." }];
  const info = BY_TYPE.get(section.type);
  if (!info) return [{ path: "", message: "This version of open.blog does not know this kind of section. It is kept, but it cannot be edited here. You can leave it, hide it or delete it." }];
  checkFields(info.fields, section, "", out);
  for (const extra of sectionRules(section)) if (!out.some((p) => p.path === extra.path)) out.push(extra);
  return out;
}

/** Problems for the whole page by section id, for sections that need attention. */
export function pageProblems(page) {
  const byId = new Map();
  for (const section of page.sections) {
    const problems = sectionProblems(section);
    if (problems.length) byId.set(section.id, problems);
  }
  return byId;
}

/** The server's list of problems, grouped by section id. A problem about the whole page is under `""`. */
export function serverProblemsBySection(problems) {
  const byId = new Map();
  for (const problem of Array.isArray(problems) ? problems : []) {
    const key = typeof problem?.section === "string" ? problem.section : "";
    const list = byId.get(key) || [];
    list.push(String(problem?.message || problem?.text || "This could not be saved."));
    byId.set(key, list);
  }
  return byId;
}

// ---------------------------------------------------------------- the payload

function tidy(value) {
  if (Array.isArray(value)) return value.map(tidy);
  if (!isObject(value)) return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner === undefined || inner === null) continue;
    out[key] = tidy(inner);
  }
  return out;
}

/**
 * What is sent to the server: the page without empty optional values. A number a form left blank
 * is dropped, never sent as text. With `leaveOut`, sections that have problems are omitted (a
 * preview shows the rest and says so).
 */
export function pagePayload(page, { leaveOut = false } = {}) {
  const sections = leaveOut ? page.sections.filter((section) => !sectionProblems(section).length) : page.sections;
  return tidy({ ...page, sections });
}

/** Parse what an owner typed into a number field: a number, or `null` when blank, or the text when it is not a number. */
export function parseNumberInput(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

/** A plain-language account of a failed request. */
export function landingErrorText(error) {
  if (error?.status === 401) return "Your session has ended. Sign in again; your changes are kept on this device.";
  if (error?.status === 409 && error?.data?.newerVersion) return "This page was written by a newer version of open.blog, so it cannot be changed from here. Update open.blog, then try again.";
  if (error?.status === 409) return "The page was changed somewhere else since you opened it. Choose what to do with your changes.";
  if (error?.status === 413) return "The page is too big to save. Remove some text or some sections, then save again.";
  if (error?.status === 422) return error.message || "Some sections need attention before this can be saved. Look for the sections marked as needing attention.";
  if (error?.status === 403) return "That change was refused. Reload the page and try again.";
  if (typeof error?.status !== "number") return "Could not reach the server. Your changes are kept on this device. Try again when your connection is back.";
  return error?.message || "That did not work. Check your connection and try again.";
}

// ---------------------------------------------------------------- preview sizes (ADR 0250, #327)

/** The three sizes of the preview. Widths are what a visitor's screen is; the frame is scaled down to fit. */
export const PREVIEW_SIZES = Object.freeze([
  Object.freeze({ id: "phone", label: "Phone", width: 375, height: 667 }),
  Object.freeze({ id: "tablet", label: "Tablet", width: 768, height: 1024 }),
  Object.freeze({ id: "desktop", label: "Desktop", width: 1280, height: 800 }),
]);

/** A preview size by id; the phone when the id is not one. */
export function previewSize(id) {
  return PREVIEW_SIZES.find((size) => size.id === id) || PREVIEW_SIZES[0];
}

/** How much to shrink a frame of `width` so it fits `available` pixels. Never enlarges. */
export function previewScale(available, width) {
  if (!(available > 0) || !(width > 0)) return 1;
  return Math.min(1, available / width);
}

/** What the preview says when some sections are left out because they are not complete yet. */
export function previewLeftOutText(count) {
  if (!count) return "";
  return count === 1 ? "1 section needs attention and is left out of this preview. Open it and fix what is marked to see it here." : `${count} sections need attention and are left out of this preview. Open them and fix what is marked to see them here.`;
}

// ---------------------------------------------------------------- never losing work (ADR 0252, #329)

const DRAFT_VERSION = 1;
const memoryDrafts = new Map();

/**
 * A local draft of the unsaved page: kept on this device when storage works and in memory for the
 * life of the page when it does not (storage can be blocked, full or unavailable, and every access
 * is guarded). A draft records the revision it was based on, so restoring it and saving it is
 * checked against what is stored now like any other save. `storage` is a function so a browser
 * that throws on access is handled where it is read.
 */
export function createDraftStore(key, storage = () => globalThis.localStorage, isContent = (page) => Array.isArray(page.sections)) {
  let blocked = false;
  const read = () => {
    try {
      const text = storage()?.getItem(key);
      return text ? JSON.parse(text) : null;
    } catch {
      blocked = true;
      return null;
    }
  };
  const valid = (record) => isObject(record) && record.v === DRAFT_VERSION && (record.base === null || typeof record.base === "string") && isObject(record.page) && isContent(record.page);
  return {
    /** Whether the draft only lives in memory because the device would not keep it. */
    get inMemoryOnly() {
      return blocked;
    },
    load() {
      const stored = read();
      if (valid(stored)) return stored;
      return memoryDrafts.get(key) || null;
    },
    save(page, base, now = new Date()) {
      const record = { v: DRAFT_VERSION, base: base ?? null, page: structuredClone(page), savedAt: now.toISOString() };
      memoryDrafts.set(key, record);
      try {
        storage().setItem(key, JSON.stringify(record));
        blocked = false;
      } catch {
        blocked = true;
      }
      return record;
    },
    clear() {
      memoryDrafts.delete(key);
      try {
        storage()?.removeItem(key);
      } catch {
        blocked = true;
      }
    },
  };
}

/** The text of a stored time for a person ("12:30"), or "" if it is not a time. */
export function draftTimeText(savedAt) {
  const date = new Date(savedAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Names the fields of a section that differ between two copies of it, in the words the form uses. */
function changedFields(mine, theirs) {
  const info = sectionInfo(mine?.type || theirs?.type);
  const labels = new Map(info.fields.map((field) => [field.name, field.label]));
  const keys = new Set([...Object.keys(mine || {}), ...Object.keys(theirs || {})]);
  const out = [];
  for (const key of keys) {
    if (key === "id") continue;
    if (JSON.stringify(mine?.[key] ?? null) !== JSON.stringify(theirs?.[key] ?? null)) out.push(key === "hidden" ? "shown or hidden" : (labels.get(key) || key).toLowerCase());
  }
  return out;
}

/**
 * What differs between your page and the newer stored one, section by section, in plain words, for
 * the Compare choice. Sections are matched by id. Each row has the section's name, what each side
 * holds, and which parts differ; `order` says whether the sections that both have are in a different
 * order.
 */
export function compareSections(mine, theirs) {
  const mineList = Array.isArray(mine) ? mine : [];
  const theirList = Array.isArray(theirs) ? theirs : [];
  const theirById = new Map(theirList.map((section) => [section.id, section]));
  const mineById = new Map(mineList.map((section) => [section.id, section]));
  const rows = [];
  for (const section of mineList) {
    const other = theirById.get(section.id);
    if (!other) rows.push({ id: section.id, title: sectionTitle(section), status: "only-mine", mine: sectionSummary(section), theirs: "", changed: [] });
    else if (JSON.stringify(section) !== JSON.stringify(other)) rows.push({ id: section.id, title: sectionTitle(section), status: "different", mine: sectionSummary(section), theirs: sectionSummary(other), changed: changedFields(section, other) });
  }
  for (const section of theirList) {
    if (!mineById.has(section.id)) rows.push({ id: section.id, title: sectionTitle(section), status: "only-theirs", mine: "", theirs: sectionSummary(section), changed: [] });
  }
  const shared = (list, other) => list.filter((section) => other.has(section.id)).map((section) => section.id).join(",");
  return { rows, order: shared(mineList, theirById) !== shared(theirList, mineById) };
}
