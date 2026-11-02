import {
  starterCollection,
  collectionMarkdown,
} from "../badges/collections.js";
import { normalizeComponent } from "./model.js";
import { snippets as widgets } from "../data/snippets.js";
const defaults = {
  title: "About me",
  body: "I build useful things.",
  url: "https://example.com",
  image: "https://example.com/image.svg",
  alt: "Project preview",
  left: "Selected work",
  right: "Currently learning",
  summary: "More details",
  name: "Your Name",
  email: "mailto:hello@example.com",
  handle: "your-name",
  quote: "Make something useful.",
  article: "How I built it",
  stack: "JavaScript · Rust",
};
const definitions = [
  [
    "centered",
    "Centered section",
    "Layout",
    '<h2 align="center">{{title}}</h2>\n<p align="center">{{body}}</p>',
    ["alignment", "center"],
  ],
  [
    "left",
    "Left-aligned section",
    "Layout",
    "## {{title}}\n\n{{body}}",
    ["section", "heading"],
  ],
  ["divider", "Divider section", "Layout", "## {{title}}\n\n---", ["rule"]],
  [
    "columns",
    "Two-column table",
    "Layout",
    "<table><tr><td>{{left}}</td><td>{{right}}</td></tr></table>",
    ["table", "columns"],
  ],
  [
    "details",
    "Collapsible details",
    "Layout",
    "<details>\n<summary>{{summary}}</summary>\n\n{{body}}\n\n</details>",
    ["collapse", "faq"],
  ],
  [
    "image-text",
    "Image and text",
    "Layout",
    '<img src="{{image}}" alt="{{alt}}" width="320">\n\n{{body}}',
    ["image"],
  ],
  [
    "linked-image",
    "Linked image",
    "Layout",
    '<a href="{{url}}"><img src="{{image}}" alt="{{alt}}"></a>',
    ["image", "link"],
  ],
  [
    "technology-row",
    "Technology row",
    "Badges",
    "![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black) ![Rust](https://img.shields.io/badge/Rust-000000?logo=rust)",
    ["stack", "skills"],
  ],
  [
    "social-row",
    "Social badge row",
    "Social",
    "[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github)]({{url}})",
    ["badges", "contact"],
  ],
  [
    "deployment-row",
    "Deployment row",
    "Badges",
    "[![Website](https://img.shields.io/badge/Website-online-1a7f37)]({{url}})",
    ["deploy", "hosting"],
  ],
  [
    "ci-row",
    "CI row",
    "Badges",
    "[![CI](https://img.shields.io/badge/CI-configure%20workflow-59636e)]({{url}})",
    ["build", "actions", "placeholder"],
  ],
  [
    "compact-project",
    "Compact project",
    "Projects",
    "### [{{title}}]({{url}})\n\n{{stack}}",
    ["project", "compact"],
  ],
  [
    "detailed-project",
    "Detailed project",
    "Projects",
    "### [{{title}}]({{url}})\n\n{{body}}\n\n**Stack:** {{stack}}",
    ["project", "details"],
  ],
  [
    "featured-project",
    "Featured project",
    "Projects",
    "## Featured: [{{title}}]({{url}})\n\n{{body}}\n\n![{{alt}}]({{image}})",
    ["showcase"],
  ],
  [
    "project-card",
    "Project card",
    "Projects",
    '<table><tr><td><h3>{{title}}</h3><p>{{body}}</p><a href="{{url}}">View project</a></td></tr></table>',
    ["card", "table"],
  ],
  [
    "article",
    "Featured article",
    "Writing",
    "### [{{article}}]({{url}})\n\n{{body}}",
    ["blog", "post"],
  ],
  [
    "recent-posts",
    "Recent posts placeholder",
    "Writing",
    "## Recent posts\n\n- [{{article}}]({{url}})\n\n<!-- Update these links manually. -->",
    ["rss", "blog", "placeholder"],
  ],
  [
    "blog-links",
    "Blog links",
    "Writing",
    "## Writing\n\n[Read my blog]({{url}})",
    ["posts", "blog"],
  ],
  [
    "contact-line",
    "Centered contact line",
    "Contact",
    '<p align="center"><a href="{{url}}">Website</a> · <a href="{{email}}">Email</a></p>',
    ["social", "contact"],
  ],
  [
    "contact-badges",
    "Contact badges",
    "Contact",
    "[![Email](https://img.shields.io/badge/Email-contact-0969da)]({{email}})",
    ["contact", "badges"],
  ],
  [
    "availability",
    "Availability line",
    "Contact",
    "**Available for:** {{body}}",
    ["work", "contact"],
  ],
  [
    "typing-intro",
    "Typing intro placeholder",
    "Fun",
    "![{{alt}}]({{image}})\n\n<!-- Configure a typing image at the upstream project before publishing. -->",
    ["typing", "animated", "placeholder"],
  ],
  [
    "terminal-intro",
    "Terminal intro",
    "Terminal",
    "```text\n$ whoami\nYour Name — developer\n$ echo Hello, world!\n```",
    ["ascii", "terminal", "fun"],
  ],
  [
    "terminal-heading",
    "Terminal heading",
    "Terminal",
    "## $ {{title}}",
    ["terminal", "prompt"],
  ],
  [
    "terminal-contact",
    "Terminal contact",
    "Terminal",
    "**$ contact** → [{{name}}]({{url}})",
    ["terminal", "contact"],
  ],
  ["quote", "Quote block", "Fun", "> {{quote}}", ["quote", "callout"]],
  [
    "checklist",
    "Checklist",
    "Utilities",
    "- [ ] First task\n- [ ] Next task",
    ["tasks", "list"],
  ],
];
export const builtInComponents = definitions.map(
  ([id, name, category, template, tags]) =>
    normalizeComponent({
      version: 1,
      id: `builtin:${id}`,
      name,
      category,
      description: `${name} starter. Inspect and customize before inserting.`,
      kind: category === "Layout" ? "layout" : "structured",
      template,
      tags,
      external: /https:\/\/img.shields/.test(template),
      fields: [
        ...new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])),
      ].map((key) => ({
        key,
        label: key[0].toUpperCase() + key.slice(1),
        type: ["url", "image", "email"].includes(key) ? "url" : "text",
        context: ["url", "image", "email"].includes(key)
          ? "url"
          : template.includes("<")
            ? "html"
            : "markdown",
        default: defaults[key] || "Your text",
      })),
    }),
);
for (const w of widgets)
  builtInComponents.push(
    normalizeComponent({
      version: 1,
      id: `builtin:widget-${w.id}`,
      name: w.name + " embed",
      category: ["stats", "streak"].includes(w.id)
        ? "Stats"
        : ["snake", "activity"].includes(w.id)
          ? "Activity"
          : w.id === "constellation"
            ? "GitHub"
            : "Widgets",
      description: w.instructions,
      kind: "widget",
      template: '<p align="center"><img src="{{image}}" alt="{{alt}}"></p>',
      fields: [
        {
          key: "image",
          label: "Image URL",
          type: "url",
          context: "url",
          default: "https://example.com/your-output.svg",
        },
        {
          key: "alt",
          label: "Alt text",
          type: "text",
          context: "html",
          default: w.name,
        },
      ],
      tags: ["widget", w.id, "github"],
      external: true,
      attribution: { name: w.name, url: w.projectUrl },
    }),
  );
for (const [id, starter] of [
  ["technology-row", "Frontend"],
  ["social-row", "Social"],
  ["contact-badges", "Social"],
  ["deployment-row", "Deployment"],
  ["ci-row", "Testing"],
]) {
  const c = builtInComponents.find((c) => c.id === `builtin:${id}`),
    collection = starterCollection(starter);
  collection.id = `starter-${id}`;
  collection.name = c.name;
  collection.style = "plain";
  if (id === "ci-row")
    collection.badges = [
      {
        label: "CI",
        message: "configure workflow",
        color: "59636e",
        alt: "CI workflow setup",
        style: "flat",
      },
    ];
  if (id === "contact-badges")
    collection.badges = [
      {
        label: "Email",
        message: "contact",
        color: "0969da",
        alt: "Email contact",
        style: "flat",
        link: "mailto:hello@example.com",
      },
    ];
  c.preset = { version: 1, type: "badges", collection };
  c.fields = [];
  c.template = collectionMarkdown(collection);
}
export const componentCatalog = (library) => [
  ...builtInComponents.map((c) => structuredClone(c)),
  ...(library?.snippets || []).map((c) => structuredClone(c)),
];
