import {
  componentSource,
  normalizeComponent,
  plain,
} from "../components-library/model.js";
import { marked } from "marked";
import { safeUrl } from "../markdown/url-safety.js";
import { visitTokens } from "../markdown/visit-tokens.js";

export const EXTENSION_CAPABILITIES = [
  "render-markdown",
  "field-input",
  "external-media",
];
const envelopeKeys = new Set([
  "version",
  "type",
  "name",
  "description",
  "publisher",
  "capabilities",
  "entries",
]);
const executableKey = /^(?:code|eval|handler|module|script|srcdoc|on[a-z]+)$/i;
const activeElements = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "form",
  "style",
]);
const unsafeScheme = /^(?:javascript|vbscript|data):/i;
const looseExternalUrl =
  /\bhttps?:[^\s<>"')\]]+|(?:^|[\s(])(?:\/\/|\\\\)[^\s<>"')\]]+/gi;

export function decodeHtmlEntities(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = String(value)
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return textarea.value;
}

function urlSinkValues(template) {
  const sinks = [];
  visitTokens(marked.lexer(String(template)), (token) => {
    if (["link", "image"].includes(token.type) && token.href)
      sinks.push(token.href);
    if (token.type !== "html") return;
    for (const pattern of [
      /\b(?:href|src|srcset|poster|background|action|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      /\burl\(([^)]*)\)/gi,
    ])
      for (const match of token.raw.matchAll(pattern))
        sinks.push(match.slice(1).find(Boolean) || "");
  });
  return sinks;
}

function urlSinkFieldKeys(template) {
  return new Set(
    urlSinkValues(template).flatMap((sink) =>
      [...sink.matchAll(/\{\{([a-z][a-zA-Z0-9_]*)\}\}/g)].map(
        (match) => match[1],
      ),
    ),
  );
}

function compactUrl(value) {
  return decodeHtmlEntities(value)
    .trim()
    .replace(/[\x00-\x20\x7f]+/g, "");
}

function parseExternalUrl(value) {
  const compact = compactUrl(value);
  const absolute = compact.match(/^(https?):[\\/]*(.+)$/i);
  const protocolRelative = compact.match(/^[\\/]{2,}(.+)$/);
  if (!absolute && !protocolRelative) return null;
  const candidate = absolute
    ? `${absolute[1].toLowerCase()}://${absolute[2].replaceAll("\\", "/")}`
    : `https://${protocolRelative[1].replaceAll("\\", "/")}`;
  try {
    const parsed = new URL(candidate);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

function canonicalExternalUrl(value) {
  const parsed = parseExternalUrl(value);
  if (!parsed) return "";
  parsed.username = "";
  parsed.password = "";
  return parsed.href;
}

export function externalUrlsFromMarkup(value) {
  const source = String(value);
  const candidates = [...urlSinkValues(source)];
  visitTokens(marked.lexer(source), (token) => {
    if (token.type !== "text") return;
    for (const match of token.raw.matchAll(looseExternalUrl))
      candidates.push(match[0].trim());
  });
  return [...new Set(candidates.map(canonicalExternalUrl).filter(Boolean))];
}

function includesUnsafeContent(value) {
  const source = String(value);
  let active = false;
  visitTokens(marked.lexer(source), (token) => {
    if (active || token.type !== "html") return;
    const template = document.createElement("template");
    template.innerHTML = token.raw;
    active = [...template.content.querySelectorAll("*")].some(
      (element) =>
        activeElements.has(element.localName) ||
        [...element.attributes].some((attribute) =>
          /^on[a-z]+$/i.test(attribute.name),
        ),
    );
  });
  if (active) return true;
  return urlSinkValues(source).some((sink) => {
    const external = parseExternalUrl(sink);
    return (
      unsafeScheme.test(compactUrl(sink)) ||
      Boolean(external?.username || external?.password)
    );
  });
}

function rejectExecutableShape(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (executableKey.test(key))
      throw Error(
        `Extension manifests cannot include executable “${key}” fields.`,
      );
    rejectExecutableShape(nested);
  }
}

export function validateExtensionManifest(raw) {
  if (
    !raw ||
    raw.version !== 1 ||
    raw.type !== "readme-studio-extension-manifest"
  )
    throw Error("Expected a version-1 README Studio extension manifest.");
  rejectExecutableShape(raw);
  for (const key of Object.keys(raw))
    if (!envelopeKeys.has(key))
      throw Error(`Unsupported extension manifest field “${key}”.`);
  const name = plain(raw.name, 120).trim();
  if (!name) throw Error("Name the extension manifest.");
  if (
    !Array.isArray(raw.capabilities) ||
    !raw.capabilities.length ||
    raw.capabilities.length > EXTENSION_CAPABILITIES.length
  )
    throw Error("Declare one or more supported extension capabilities.");
  const capabilities = [...new Set(raw.capabilities)];
  if (
    capabilities.some(
      (capability) => !EXTENSION_CAPABILITIES.includes(capability),
    ) ||
    !capabilities.includes("render-markdown")
  )
    throw Error(
      "Extension manifests may use only declared inert capabilities.",
    );
  if (
    !Array.isArray(raw.entries) ||
    !raw.entries.length ||
    raw.entries.length > 100
  )
    throw Error("Extension manifests support 1 to 100 entries.");
  const publisherName = plain(raw.publisher?.name ?? "", 120).trim();
  const publisherUrl = safeUrl(raw.publisher?.url ?? "", { relative: false });
  if (!publisherName || !/^https:\/\//i.test(publisherUrl))
    throw Error("Extensions need a named publisher with a safe HTTPS URL.");
  const ids = new Set();
  const entries = raw.entries.map((entry) => {
    if (includesUnsafeContent(entry?.template || ""))
      throw Error(
        "Extension templates cannot include executable markup or URLs.",
      );
    const component = normalizeComponent({
      ...entry,
      external: true,
      attribution: entry.attribution || {
        name: publisherName,
        url: publisherUrl,
      },
    });
    const renderedDefaults = componentSource(component);
    if (includesUnsafeContent(renderedDefaults))
      throw Error(
        "Extension templates cannot include executable markup or URLs.",
      );
    if (component.fields.length && !capabilities.includes("field-input"))
      throw Error("Declare field-input before using extension fields.");
    const fields = new Map(component.fields.map((field) => [field.key, field]));
    for (const key of urlSinkFieldKeys(component.template)) {
      const field = fields.get(key);
      if (field && field.type !== "url" && field.context !== "url")
        throw Error("URL placeholders must use a URL field and context.");
    }
    if (
      (externalUrlsFromMarkup(renderedDefaults).length ||
        component.fields.some(
          (field) => field.type === "url" || field.context === "url",
        )) &&
      !capabilities.includes("external-media")
    )
      throw Error("Declare external-media before using remote URLs.");
    if (ids.has(component.id))
      throw Error("Extension entry IDs must be unique.");
    ids.add(component.id);
    return component;
  });
  return {
    version: 1,
    type: "readme-studio-extension-manifest",
    name,
    description: plain(raw.description ?? "", 1000),
    publisher: { name: publisherName, url: publisherUrl },
    capabilities,
    entries,
  };
}

export function renderExtension(raw, entryId, values = {}) {
  const manifest = validateExtensionManifest(raw);
  const entry = manifest.entries.find((candidate) => candidate.id === entryId);
  if (!entry) throw Error("Choose an extension entry from this manifest.");
  return componentSource(entry, values);
}
