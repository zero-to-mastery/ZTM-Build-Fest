import { profileSnapshot } from "../github/suggestions.js";
import {
  createBlock,
  serializeBlock,
  serializeBlocks,
  html,
  text,
} from "../markdown/serialize.js";
import { template } from "../data/templates.js";
const literal = (value) => text(html(value));
const defaultAbout = template("Minimal").find((b) => b.type === "about")
  .settings.body;
const defaultIntro = template("Minimal")[0].settings.subtitle;
export const profileOptions = {
  identity: true,
  bio: true,
  links: true,
  stats: true,
  projects: false,
  languages: false,
  avatar: false,
};
export function profileStats(p) {
  const rows = [
    ["Public repositories", p.publicRepos],
    ["Followers", p.followers],
    ["Following", p.following],
    ["Public gists", p.publicGists],
  ];
  if (p.complete || p.fetchedRepos > 0)
    rows.push(
      [
        `Stars on ${p.complete ? "" : "fetched "}non-fork repositories`,
        p.stars,
      ],
      [
        `Forks of ${p.complete ? "" : "fetched "}non-fork repositories`,
        p.forks,
      ],
    );
  return [
    ...rows
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([label, value]) => `- **${label}:** ${value}`),
    p.joined ? `- **On GitHub since:** ${p.joined}` : "",
    `\n_Public snapshot from [@${p.login}](${p.url}), ${p.fetchedAt.slice(0, 10)}. Refresh in README Studio to update._`,
    !p.complete
      ? "\n_Repository totals are incomplete; only fetched repositories are included._"
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
// Only explicit placeholders are replaced. Ordinary names and usernames are never guessed.
export function replaceProfilePlaceholders(value, p, key = "") {
  if (Array.isArray(value))
    return value.map((v) => replaceProfilePlaceholders(v, p, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        replaceProfilePlaceholders(v, p, k),
      ]),
    );
  if (typeof value !== "string") return value;
  const name = [
    "markdown",
    "body",
    "subtitle",
    "description",
    "highlights",
    "status",
  ].includes(key)
    ? literal(p.name)
    : p.name;
  return value
    .replace(/\{\{\s*(?:name|display_name)\s*\}\}|\bYour Name\b/g, () => name)
    .replace(/\{\{\s*username\s*\}\}/g, () => p.login)
    .replace(
      /(https:\/\/github\.com\/)your-name(?=[/\s)#?"']|$)/g,
      (_, prefix) => prefix + p.login,
    );
}
export function autofillProfile(draft, p, options = profileOptions) {
  const opts = { ...profileOptions, ...options };
  const blocks = structuredClone(draft.blocks);
  const metadata = structuredClone(draft.metadata || {});
  const previous = metadata.githubProfile;
  const preserved = [];
  const managed = (kind, type, settings) => {
    const existing = blocks.find((b) => b.profileAutofill?.kind === kind);
    if (existing) {
      if (serializeBlock(existing) !== existing.profileAutofill.markdown) {
        preserved.push(kind);
        return;
      }
      if (settings.title)
        settings.title =
          existing.settings.title ??
          (existing.type === "projects" ? "Selected Projects" : settings.title);
      existing.type = type;
      existing.settings = settings;
      existing.profileAutofill.markdown = serializeBlock(existing);
      return;
    }
    // Manual Markdown edits relinquish ownership; don't append the same generated section again.
    // An empty entry is a section whose text was left out of a download.
    const prior = previous?.sections?.[kind];
    if (typeof prior === "string") {
      preserved.push(kind);
      return;
    }
    const b = createBlock(type, settings);
    b.profileAutofill = { kind, markdown: serializeBlock(b) };
    blocks.push(b);
  };
  if (opts.identity && !blocks.length)
    blocks.push(
      createBlock("hero", {
        name: "Your Name",
        subtitle: "",
      }),
    );
  if (opts.bio) {
    const hero = blocks.find(
      (b) =>
        b.type === "hero" &&
        (b.profileIntro
          ? b.profileIntro.value === b.settings.subtitle
          : !b.settings.subtitle || b.settings.subtitle === defaultIntro),
    );
    if (hero && (p.bio || hero.profileIntro)) {
      hero.settings.subtitle = literal(p.bio);
      hero.profileIntro = { value: hero.settings.subtitle };
    }
    const about = blocks.find(
      (b) =>
        b.type === "about" &&
        !b.profileAutofill &&
        (!b.settings.body || b.settings.body === defaultAbout),
    );
    const body = [
      p.bio,
      p.company ? `Company: ${p.company}` : "",
      p.location ? `Location: ${p.location}` : "",
    ]
      .filter(Boolean)
      .map(literal)
      .join("\n\n");
    if (about && body) {
      about.settings.body = body;
      about.profileAutofill = { kind: "bio", markdown: serializeBlock(about) };
    } else if (body || blocks.some((b) => b.profileAutofill?.kind === "bio"))
      managed("bio", "about", { title: "About Me", body });
  }
  if (opts.identity) {
    for (const b of blocks) {
      const owned =
        b.profileAutofill && serializeBlock(b) === b.profileAutofill.markdown;
      const prior = new Map(
        (Array.isArray(b.profileIdentity) ? b.profileIdentity : [])
          .filter(
            (record) =>
              record &&
              Array.isArray(record.path) &&
              typeof record.source === "string" &&
              typeof record.value === "string",
          )
          .map((record) => [JSON.stringify(record.path), record]),
      );
      const records = [];
      const visit = (value, path = []) => {
        if (Array.isArray(value))
          return value.map((item, i) => visit(item, [...path, i]));
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
              key,
              visit(item, [...path, key]),
            ]),
          );
        if (typeof value !== "string") return value;
        const record = prior.get(JSON.stringify(path));
        const source = record?.value === value ? record.source : value;
        const next = replaceProfilePlaceholders(source, p, path.at(-1));
        if (next !== source) records.push({ path, source, value: next });
        return next;
      };
      b.settings = visit(b.settings);
      if (records.length) b.profileIdentity = records;
      else delete b.profileIdentity;
      if (owned) b.profileAutofill.markdown = serializeBlock(b);
    }
  }
  if (opts.links) {
    const editedKinds = new Set();
    const items = [
      { name: "GitHub", url: p.url },
      ...(p.website ? [{ name: "Portfolio", url: p.website }] : []),
      ...(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)
        ? [{ name: "Email", url: `mailto:${p.email}` }]
        : []),
      ...(/^[\w]{1,15}$/.test(p.twitter)
        ? [{ name: "X / Twitter", url: `https://x.com/${p.twitter}` }]
        : []),
    ];
    // Replace only known sample links; keep custom contact destinations.
    for (const b of blocks.filter((b) =>
      ["social", "contact"].includes(b.type),
    )) {
      const records = [];
      b.settings.items = b.settings.items.map((i, index) => {
        const oldRecord = (
          Array.isArray(b.profileLinks) ? b.profileLinks : []
        ).find((r) => r?.index === index);
        const prior = (
          Array.isArray(b.profileLinks) ? b.profileLinks : []
        ).find(
          (r) => r?.index === index && r.name === i.name && r.value === i.url,
        );
        const identity = (
          Array.isArray(b.profileIdentity) ? b.profileIdentity : []
        ).some(
          (r) =>
            JSON.stringify(r?.path) ===
              JSON.stringify(["items", index, "url"]) &&
            r.value === i.url &&
            r.source === "https://github.com/your-name",
        );
        if (oldRecord && !prior && !identity) editedKinds.add(oldRecord.kind);
        const kind =
          prior?.kind ||
          (i.url === "https://example.com"
            ? "website"
            : i.url === "https://github.com/your-name" || identity
              ? "github"
              : null);
        if (!kind) return i;
        const url = kind === "website" ? p.website : p.url;
        if (!url && !prior) return i;
        records.push({ index, kind, name: i.name, value: url });
        return { ...i, url };
      });
      if (records.length) b.profileLinks = records;
      else delete b.profileLinks;
    }
    const existingUrls = new Set(
      blocks
        .filter(
          (b) =>
            ["social", "contact"].includes(b.type) &&
            b.profileAutofill?.kind !== "links",
        )
        .flatMap((b) => b.settings.items.map((i) => i.url)),
    );
    const missing = items.filter(
      (i) =>
        !(i.name === "Portfolio" && editedKinds.has("website")) &&
        !(i.name === "GitHub" && editedKinds.has("github")) &&
        !existingUrls.has(i.url) &&
        !blocks.some(
          (b) => b.type === "custom" && b.settings.markdown.includes(i.url),
        ),
    );
    if (
      missing.length ||
      blocks.some((b) => b.profileAutofill?.kind === "links")
    )
      managed("links", "social", { style: "links", items: missing });
  }
  if (opts.stats)
    managed("stats", "about", {
      title: "GitHub at a Glance",
      body: profileStats(p),
    });
  if (opts.projects && p.projects.length) {
    const sampleSettings = template("Minimal").find(
      (b) => b.type === "projects",
    ).settings;
    const sample = blocks.find(
      (b) =>
        b.type === "projects" &&
        JSON.stringify(b.settings) ===
          JSON.stringify(
            opts.identity
              ? replaceProfilePlaceholders(sampleSettings, p)
              : sampleSettings,
          ),
    );
    if (sample) {
      sample.settings.items = structuredClone(p.projects);
      sample.profileAutofill = {
        kind: "projects",
        markdown: serializeBlock(sample),
      };
    } else
      managed("projects", "projects", {
        title: "Public Projects",
        items: structuredClone(p.projects),
      });
  }
  if (opts.languages && p.languages.length)
    managed("languages", "about", {
      title: "Languages in My Public Repositories",
      body:
        p.languages
          .map(
            (l) =>
              `- ${literal(l.name)} — primary language in ${l.repositories} ${l.repositories === 1 ? "repository" : "repositories"}`,
          )
          .join("\n") +
        "\n\n_Based on " +
        (p.complete ? "public" : "fetched public") +
        " non-fork repositories; not a measure of proficiency or code volume._",
    });
  if (opts.avatar && p.avatar)
    managed("avatar", "widget", {
      image: p.avatar,
      link: p.url,
      alt: `${p.name}'s GitHub avatar`,
      align: "left",
    });
  metadata.githubProfile = {
    snapshot: profileSnapshot(p),
    repositories: structuredClone(
      p.repositories || previous?.repositories || [],
    ),
    login: p.login,
    fetchedAt: p.fetchedAt,
    sections: {
      ...previous?.sections,
      ...Object.fromEntries(
        blocks
          .filter((b) => b.profileAutofill)
          .map((b) => [b.profileAutofill.kind, b.profileAutofill.markdown]),
      ),
    },
  };
  return { blocks, markdown: serializeBlocks(blocks), metadata, preserved };
}
