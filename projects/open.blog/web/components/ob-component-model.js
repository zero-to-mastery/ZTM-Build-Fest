// Pure model behind <ob-component-lab>. It owns the shadow template the demo component really
// uses (so the source the reader sees is the source that runs), turns the reader's choices into
// light DOM markup and page CSS, and explains what the browser does with them.

export const TONES = ["info", "success", "warn"];

export const defaults = {
  tone: "info", collapsed: false,
  title: true, body: true, footer: false,
  accent: "#3b82f6", radius: 12, padding: 16,
  pageCss: false, partCss: false,
};

const clamp = (value, low, high, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(high, Math.max(low, Math.round(number))) : fallback;
};

export function normalize(input = {}) {
  const merged = { ...defaults, ...input };
  return {
    tone: TONES.includes(merged.tone) ? merged.tone : defaults.tone,
    collapsed: Boolean(merged.collapsed),
    title: Boolean(merged.title), body: Boolean(merged.body), footer: Boolean(merged.footer),
    accent: /^#[0-9a-f]{6}$/i.test(merged.accent) ? merged.accent.toLowerCase() : defaults.accent,
    radius: clamp(merged.radius, 0, 32, defaults.radius),
    padding: clamp(merged.padding, 4, 40, defaults.padding),
    pageCss: Boolean(merged.pageCss), partCss: Boolean(merged.partCss),
  };
}

export const shadowStyle = `:host { display: block; --card-accent: #888; --card-radius: 12px; --card-pad: 16px; }
article { padding: var(--card-pad); border: 3px solid var(--card-accent); border-radius: var(--card-radius); }
:host([tone="warn"]) article { border-style: dashed; }
:host([tone="success"]) article { border-style: double; }
:host([collapsed]) .body { display: none; }
.tone { margin: 0 0 .5rem; font: 700 .75rem monospace; text-transform: uppercase; }
footer { margin-top: .75rem; font-size: .85em; }
::slotted([slot="title"]) { margin: 0 0 .5rem; }`;

export const shadowBody = `<article part="card">
  <p class="tone"></p>
  <header><slot name="title">Untitled (slot fallback)</slot></header>
  <div class="body"><slot>No body (slot fallback)</slot></div>
  <footer part="footer"><slot name="footer">Default footer (slot fallback)</slot></footer>
</article>`;

export const tag = "ob-lab-card";

export function lightChildren(config) {
  const { title, body, footer } = normalize(config);
  return [
    title && '<h4 slot="title">Reusable card</h4>',
    body && "<p>Anything you put between the tags lands in the default slot.</p>",
    footer && '<small slot="footer">Footer supplied by the page</small>',
  ].filter(Boolean);
}

// Attributes as [name, value] pairs (value null for a boolean attribute) plus inline style parts.
export function hostAttributes(config) {
  const c = normalize(config);
  const attrs = [["tone", c.tone]];
  if (c.collapsed) attrs.push(["collapsed", null]);
  const style = [];
  if (c.accent !== defaults.accent) style.push(`--card-accent: ${c.accent}`);
  if (c.radius !== defaults.radius) style.push(`--card-radius: ${c.radius}px`);
  if (c.padding !== defaults.padding) style.push(`--card-pad: ${c.padding}px`);
  return { attrs, style };
}

// The reader's markup, as they would write it in a page.
export function lightMarkup(config) {
  const { attrs, style } = hostAttributes(config);
  const written = attrs.map(([name, value]) => (value === null ? name : `${name}="${value}"`));
  if (style.length) written.push(`style="${style.join("; ")}"`);
  const open = [tag, ...written].join(" ");
  const children = lightChildren(config).map((child) => `  ${child}`);
  return children.length ? `<${open}>\n${children.join("\n")}\n</${tag}>` : `<${open}></${tag}>`;
}

// Rules the page writes against the component. The element scopes them to the lab's stage.
export function pageRules(config) {
  const c = normalize(config);
  const rules = [];
  if (c.pageCss) {
    rules.push(`${tag} h4, ${tag} p, ${tag} small { color: #d6336c; }`);
    rules.push(`${tag} .tone, ${tag} footer { color: #d6336c; }`);
  }
  if (c.partCss) rules.push(`${tag}::part(footer) { font-style: italic; text-decoration: underline; }`);
  return rules;
}

export function notes(config) {
  const c = normalize(config);
  const out = [];
  out.push(`tone="${c.tone}" is an attribute. The component watches it (attributeChangedCallback) and its :host([tone]) rule restyles the border from inside.`);
  if (c.collapsed) out.push("collapsed is a boolean attribute: present means true. :host([collapsed]) hides the default slot's wrapper, but the paragraph is still a light DOM child.");
  if (!c.title) out.push('No element has slot="title", so the slot shows its fallback content.');
  if (!c.body) out.push("Nothing is left for the default slot, so it shows its fallback content.");
  if (!c.footer) out.push("No element has slot=\"footer\", so the slot shows its fallback content, the shadow tree's own footer text.");
  if (c.accent !== defaults.accent || c.radius !== defaults.radius || c.padding !== defaults.padding) {
    out.push("CSS custom properties inherit through the shadow boundary. That is the supported way to let the page tune a component's styling.");
  }
  if (c.pageCss) {
    out.push("Page CSS recolors the slotted text (light DOM, the page owns it) but not the shadow tree's own .tone label or default footer text. Selectors cannot cross the boundary.");
  }
  if (c.partCss) out.push('::part(footer) reaches into the shadow tree because the component exposed it with part="footer". Only parts are reachable.');
  return out;
}
