// A dependency-free HTML/CSS/JavaScript lesson runner. Preview documents run
// in an opaque-origin iframe whose CSP blocks external resources and network APIs
// unless the fence opts into `network` or `images`. See docs/specs/web-sandbox-capabilities.md.

import { codeSettings, createCodeEditor } from "./ob-code-editor.js";

const MAX_SOURCE = 100_000;
const MAX_CONSOLE_ENTRIES = 200;
let sandboxSequence = 0;
// Forms fire `submit` (CSP form-action still blocks real submission) and dialogs work.
export const WEB_SANDBOX_PERMISSIONS = "allow-scripts allow-forms allow-modals";
export const WEB_SANDBOX_WARNING = "External resources and network APIs are blocked. Do not enter secrets; code can navigate its own preview.";

export function webSandboxWarning({ network = false, images = false } = {}) {
  const allowed = [network && "may contact external HTTPS services", images && "may load external HTTPS images"].filter(Boolean);
  if (!allowed.length) return WEB_SANDBOX_WARNING;
  return `This preview ${allowed.join(" and ")}; other external resources are blocked. Do not enter secrets; code can navigate its own preview.`;
}

export function webSandboxPolicy({ network = false, images = false } = {}) {
  return [
    "default-src 'none'",
    `img-src data: blob:${images ? " https:" : ""}`,
    "style-src 'unsafe-inline'",
    // Worklets (AudioWorklet) load through script-src; blob: covers code the lesson created.
    // eval and WebAssembly compilation add nothing to what an inline lesson can already do
    // inside its opaque origin, and feature-detection lessons rely on them.
    "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    "worker-src blob:",
    `connect-src data: blob:${network ? " https:" : ""}`,
    "font-src 'none'",
    "media-src data: blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

// Runs first inside the preview: forwards console output and uncaught errors to the
// host page, and gives the opaque origin in-memory Web Storage instead of throwing.
function bootstrap(hostOrigin) {
  return `(() => {
  const host = ${JSON.stringify(hostOrigin)};
  const seen = new WeakSet();
  const show = (value, depth = 0) => {
    if (typeof value === "string") return depth ? JSON.stringify(value) : value;
    if (value === undefined) return "undefined";
    if (typeof value === "function") return "ƒ " + (value.name || "anonymous") + "()";
    if (typeof value === "bigint") return value + "n";
    if (value === null || typeof value !== "object") return String(value);
    // Type tags, not instanceof, so values from other realms format the same way.
    const tag = Object.prototype.toString.call(value).slice(8, -1);
    if (tag === "Error") return value.name + ": " + value.message;
    if (typeof Node !== "undefined" && value instanceof Node) {
      return value.nodeType === 1 ? "<" + value.tagName.toLowerCase() + (value.id ? "#" + value.id : "") + ">" : value.nodeName;
    }
    if (seen.has(value)) return "[Circular]";
    if (depth > 3) return Array.isArray(value) ? "[…]" : "{…}";
    seen.add(value);
    try {
      const item = (child) => { try { return show(child, depth + 1); } catch { return "?"; } };
      if (Array.isArray(value)) return "[" + value.slice(0, 100).map(item).join(", ") + (value.length > 100 ? ", …" : "") + "]";
      if (tag === "Map") return "Map(" + value.size + ") {" + [...value].slice(0, 50).map(([k, v]) => item(k) + " => " + item(v)).join(", ") + "}";
      if (tag === "Set") return "Set(" + value.size + ") {" + [...value].slice(0, 50).map(item).join(", ") + "}";
      if (tag === "Promise") return "Promise {…}";
      const constructor = value.constructor && value.constructor.name;
      const name = constructor && constructor !== "Object" ? constructor + " " : "";
      return name + "{" + Object.keys(value).slice(0, 50).map((key) => key + ": " + item(value[key])).join(", ") + "}";
    } finally {
      seen.delete(value);
    }
  };
  const format = (args) => {
    if (typeof args[0] === "string" && /%[sdifoOc]/.test(args[0])) {
      let rest = args.slice(1);
      const text = args[0].replace(/%([sdifoOc])/g, (match, kind) => {
        if (!rest.length) return match;
        const value = rest.shift();
        if (kind === "c") return "";
        if (kind === "d" || kind === "i") return String(parseInt(value, 10));
        if (kind === "f") return String(Number(value));
        return show(value, kind === "s" ? 0 : 1);
      });
      args = [text, ...rest];
    }
    return args.map((arg) => show(arg)).join(" ").slice(0, 10000);
  };
  const send = (message) => {
    try { parent.postMessage({ obWebSandbox: 1, ...message }, host); } catch {}
  };
  const levels = { log: "log", info: "log", debug: "log", dir: "log", table: "log", trace: "log", warn: "warn", error: "error" };
  for (const [method, level] of Object.entries(levels)) {
    const original = console[method];
    console[method] = (...args) => {
      send({ level, text: format(args) });
      if (typeof original === "function") original.apply(console, args);
    };
  }
  const assert = console.assert;
  console.assert = (condition, ...args) => {
    if (!condition) send({ level: "error", text: "Assertion failed" + (args.length ? ": " + format(args) : "") });
    if (typeof assert === "function") assert.call(console, condition, ...args);
  };
  console.clear = () => send({ clear: true });
  addEventListener("error", (event) => {
    // Browsers report this benign layout notice as an error event; DevTools does not show it.
    if (!event.error && /^ResizeObserver loop/.test(event.message || "")) return;
    send({ level: "error", text: "Uncaught " + (event.error ? show(event.error) : event.message) });
  });
  addEventListener("unhandledrejection", (event) => send({ level: "error", text: "Uncaught (in promise) " + show(event.reason) }));
  addEventListener("securitypolicyviolation", (event) => send({
    level: "warn",
    text: "Blocked by the sandbox: " + (event.effectiveDirective || event.violatedDirective) + (event.blockedURI ? " " + event.blockedURI : ""),
  }));
  const memoryStorage = () => {
    const items = new Map();
    return {
      get length() { return items.size; },
      key: (index) => [...items.keys()][index] ?? null,
      getItem: (key) => (items.has(String(key)) ? items.get(String(key)) : null),
      setItem: (key, value) => { items.set(String(key), String(value)); },
      removeItem: (key) => { items.delete(String(key)); },
      clear: () => items.clear(),
    };
  };
  for (const name of ["localStorage", "sessionStorage"]) {
    try { void window[name]; } catch { Object.defineProperty(window, name, { value: memoryStorage(), configurable: true }); }
  }
})();`;
}

export function parseWebSandbox(source) {
  const files = { html: "", css: "", js: "" };
  let active = null;
  let markers = 0;
  for (const line of String(source || "").replace(/\r\n?/g, "\n").split("\n")) {
    const marker = /^---(html|css|js)\s*$/.exec(line);
    if (marker) {
      active = marker[1];
      markers += 1;
    } else if (active) {
      files[active] += `${files[active] ? "\n" : ""}${line}`;
    }
  }
  if (!markers || !Object.values(files).some((value) => value.trim()) || String(source).length > MAX_SOURCE) return null;
  return files;
}

const inlineScript = (source, type = "") => `<script${type ? ` type="${type}"` : ""}>${source.replace(/<\/script/gi, "<\\/script")}<\/script>`;

export function webSandboxDocument({ html = "", css = "", js = "", module = false, network = false, images = false, libraries = [], hostOrigin = "*" }) {
  const safeCss = css.replace(/<\/style/gi, "<\\/style");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${webSandboxPolicy({ network, images })}">${inlineScript(bootstrap(hostOrigin))}<style>${safeCss}</style></head><body>${html}${libraries.map((source) => inlineScript(source)).join("")}${inlineScript(js, module ? "module" : "")}</body></html>`;
}

// Library files are fetched once per page, same-origin, and inlined into each preview.
const libraryCache = new Map();
const loadLibrary = (url) => {
  if (!libraryCache.has(url)) {
    libraryCache.set(url, fetch(url).then((response) => {
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return response.text();
    }));
  }
  return libraryCache.get(url);
};

// One listener routes preview messages to the console of the frame that sent them.
const consoles = new WeakMap();
if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    const write = event.source && consoles.get(event.source);
    if (write && event.data && event.data.obWebSandbox === 1) write(event.data);
  });
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export class ObWebSandbox extends HTMLElement {
  connectedCallback() {
    if (this.dataset.enhanced) return;
    const pre = this.querySelector("pre");
    const code = pre?.querySelector("code");
    const initial = parseWebSandbox(code?.textContent || "");
    if (!initial) return;
    const instanceId = this.id || `ob-web-sandbox-${++sandboxSequence}`;
    const mode = { module: "module" in this.dataset, network: "network" in this.dataset, images: "images" in this.dataset };
    const libraryUrls = [...(this.querySelectorAll?.("link[data-ob-web-lib]") || [])].map((link) => link.href);
    pre.hidden = true;
    const editors = {};
    const shell = el("div", "ob-web-sandbox-shell");
    const tabs = el("div", "ob-web-sandbox-tabs");
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "Choose code editor");
    const panels = el("div", "ob-web-sandbox-editors");
    const settings = codeSettings(this);
    let active = "html";
    // Only a reader's own action moves focus into an editor; selecting the first tab while the page
    // loads must not, or the browser scrolls to the last example on every page that has one.
    const select = (name, focus = true) => {
      active = name;
      for (const [key, editor] of Object.entries(editors)) {
        editor.shell.hidden = key !== name;
        editor.button.setAttribute("aria-pressed", String(key === name));
      }
      if (focus) editors[name].focus();
    };
    for (const name of ["html", "css", "js"]) {
      const label = name === "js" ? "JavaScript" : name.toUpperCase();
      const button = el("button", "ob-web-sandbox-tab", label);
      button.type = "button";
      const { shell: editorShell, editor, refresh } = createCodeEditor({
        prefix: "ob-web-sandbox",
        language: name,
        label,
        ariaLabel: `Editable ${label}`,
        value: initial[name],
        ...settings,
      });
      editor.id = `${instanceId}-${name}-editor`;
      button.setAttribute("aria-controls", editor.id);
      editor.button = button;
      editor.shell = editorShell;
      editor.refresh = refresh;
      button.addEventListener("click", () => select(name));
      tabs.append(button);
      panels.append(editorShell);
      editors[name] = editor;
    }
    const controls = el("div", "ob-code-editor-controls ob-web-sandbox-controls");
    const run = el("button", "ob-code-editor-run ob-web-sandbox-run", "Run preview");
    const reset = el("button", "ob-web-sandbox-reset", "Reset");
    run.type = reset.type = "button";
    const warning = el("p", "ob-code-editor-note ob-web-sandbox-warning", webSandboxWarning(mode));
    const status = el("p", "ob-code-editor-status ob-web-sandbox-status", "Preview ready.");
    status.setAttribute("role", "status");
    const frame = el("iframe", "ob-web-sandbox-preview");
    frame.title = "Web sandbox preview";
    frame.setAttribute("sandbox", WEB_SANDBOX_PERMISSIONS);
    frame.setAttribute("referrerpolicy", "no-referrer");

    // Console output from the preview, rendered as text and capped.
    const output = el("div", "ob-web-sandbox-console");
    output.hidden = true;
    const outputTitle = el("p", "ob-web-sandbox-console-title", "Console");
    const log = el("ol", "ob-web-sandbox-console-log");
    log.setAttribute("role", "log");
    log.setAttribute("aria-label", "Console output");
    output.append(outputTitle, log);
    let entries = 0;
    const clearConsole = () => {
      entries = 0;
      log.replaceChildren();
      output.hidden = true;
    };
    const writeConsole = ({ clear, level = "log", text = "" }) => {
      if (clear) return clearConsole();
      if (entries > MAX_CONSOLE_ENTRIES) return;
      entries += 1;
      const entry = el("li", `ob-web-sandbox-console-entry ob-web-sandbox-console-${level === "warn" || level === "error" ? level : "log"}`,
        entries > MAX_CONSOLE_ENTRIES ? "Further output omitted." : String(text));
      log.append(entry);
      output.hidden = false;
    };

    let libraries = libraryUrls.length ? null : [];
    const show = () => {
      clearConsole();
      if (frame.contentWindow) consoles.set(frame.contentWindow, writeConsole);
      frame.srcdoc = webSandboxDocument({
        html: editors.html.value,
        css: editors.css.value,
        js: editors.js.value,
        ...mode,
        libraries,
        // A file:// page has the origin "null", which postMessage cannot target.
        hostOrigin: typeof location !== "undefined" && location.origin !== "null" ? location.origin : "*",
      });
      status.textContent = "Preview updated in an isolated sandbox.";
    };
    const render = () => {
      if (libraries) return show();
      status.textContent = "Loading libraries…";
      Promise.all(libraryUrls.map(loadLibrary)).then(
        (sources) => { libraries = sources; show(); },
        (error) => {
          libraries = [];
          show();
          writeConsole({ level: "error", text: `Could not load a library for this example (${error.message}).` });
        },
      );
    };
    run.addEventListener("click", render);
    reset.addEventListener("click", () => {
      for (const name of ["html", "css", "js"]) {
        editors[name].value = initial[name];
        editors[name].refresh();
      }
      render();
      editors[active].focus();
    });
    controls.append(run, reset);
    shell.append(tabs, panels, controls, warning, status, frame, output);
    this.append(shell);
    this.dataset.enhanced = "true";
    select("html", false);
    render();
  }
}

if (!customElements.get("ob-web-sandbox")) customElements.define("ob-web-sandbox", ObWebSandbox);
