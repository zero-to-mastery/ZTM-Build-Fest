import test from "node:test";
import assert from "node:assert/strict";

globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => null, define: () => {} };
const { parseWebSandbox, webSandboxDocument, webSandboxPolicy, webSandboxWarning, WEB_SANDBOX_PERMISSIONS, WEB_SANDBOX_WARNING } = await import("../../web/components/ob-web-sandbox.js");

test("web sandbox parses bounded HTML CSS and JavaScript sections", () => {
  assert.deepEqual(parseWebSandbox("---html\n<button>Go</button>\n---css\nbutton { color: red; }\n---js\nconsole.log('go')"), {
    html: "<button>Go</button>", css: "button { color: red; }", js: "console.log('go')",
  });
  assert.equal(parseWebSandbox("plain source"), null);
  assert.equal(parseWebSandbox(`---html\n${"x".repeat(100001)}`), null);
});

test("web sandbox preview stays opaque-origin and blocks external resources by default", () => {
  // No allow-same-origin: the preview never shares the blog's origin, cookies, or storage.
  assert.equal(WEB_SANDBOX_PERMISSIONS, "allow-scripts allow-forms allow-modals");
  assert.doesNotMatch(WEB_SANDBOX_PERMISSIONS, /allow-same-origin|allow-popups|allow-top-navigation/);
  assert.match(WEB_SANDBOX_WARNING, /Do not enter secrets/);
  assert.match(WEB_SANDBOX_WARNING, /navigate its own preview/);
  const output = webSandboxDocument({ html: "<h1>Hi</h1>", css: "body{} </style><img>", js: "console.log(1); </script><p>" });
  assert.match(output, /default-src 'none'/);
  assert.match(output, /connect-src data: blob:;/);
  assert.match(output, /img-src data: blob:;/);
  assert.match(output, /form-action 'none'/);
  assert.match(output, /worker-src blob:/);
  assert.match(output, /script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:/);
  assert.doesNotMatch(output, /https:/);
  assert.doesNotMatch(output, /<\/style><img>/i);
  assert.doesNotMatch(output, /<\/script><p>/i);
});

test("network and images are separate opt-ins with their own disclosure", () => {
  assert.match(webSandboxPolicy({ network: true }), /connect-src data: blob: https:/);
  assert.match(webSandboxPolicy({ network: true }), /img-src data: blob:;/);
  assert.match(webSandboxPolicy({ images: true }), /img-src data: blob: https:/);
  assert.match(webSandboxPolicy({ images: true }), /connect-src data: blob:;/);
  assert.equal(webSandboxWarning(), WEB_SANDBOX_WARNING);
  assert.match(webSandboxWarning({ network: true }), /may contact external HTTPS services/);
  assert.match(webSandboxWarning({ images: true }), /may load external HTTPS images/);
  assert.match(webSandboxWarning({ network: true, images: true }), /services and may load external HTTPS images.*Do not enter secrets/);
});

test("the preview runs the bootstrap, then libraries, then the lesson, as a module when asked", () => {
  const output = webSandboxDocument({ js: "await go();", module: true, libraries: ["window.Lib = 1; '</script>'"], hostOrigin: "https://blog.example" });
  const bootstrap = output.indexOf('const host = "https://blog.example"');
  const library = output.indexOf("window.Lib = 1");
  const lesson = output.indexOf('<script type="module">await go();');
  assert.ok(bootstrap > 0 && bootstrap < library && library < lesson, "bootstrap, library, lesson order");
  assert.ok(output.indexOf("Content-Security-Policy") < bootstrap, "the CSP applies before any script");
  assert.doesNotMatch(output, /'<\/script>'/, "library text cannot close its script element");
  assert.doesNotMatch(webSandboxDocument({ js: "go();" }), /type="module"/);
});

test("the bootstrap forwards console output and replaces throwing storage", async () => {
  const output = webSandboxDocument({ hostOrigin: "https://blog.example" });
  const source = output.match(/<script>(\(\(\) => \{[\s\S]*?\}\)\(\);)<\/script>/)[1];
  const sent = [];
  const listeners = {};
  const blocked = () => { throw new Error("SecurityError"); };
  const window = {};
  Object.defineProperty(window, "localStorage", { get: blocked, configurable: true });
  Object.defineProperty(window, "sessionStorage", { get: blocked, configurable: true });
  const context = {
    window,
    console: { log() {}, warn() {}, error() {} },
    parent: { postMessage: (message, origin) => sent.push({ message, origin }) },
    addEventListener: (name, callback) => (listeners[name] = callback),
    Node: class {},
  };
  const vm = await import("node:vm");
  vm.runInNewContext(source, context);
  const circular = { name: "loop" };
  circular.self = circular;
  context.console.log("count:", 3, [1, "two"], circular, new Map([["a", 1]]));
  context.console.warn("%s has %d items", "cart", 4);
  context.console.error(new TypeError("bad"));
  listeners.unhandledrejection({ reason: new Error("nope") });
  listeners.error({ message: "ResizeObserver loop completed with undelivered notifications." });
  assert.deepEqual(sent.map(({ message }) => [message.level, message.text]), [
    ["log", 'count: 3 [1, "two"] {name: "loop", self: [Circular]} Map(1) {"a" => 1}'],
    ["warn", "cart has 4 items"],
    ["error", "TypeError: bad"],
    ["error", "Uncaught (in promise) Error: nope"],
  ]);
  assert.ok(sent.every(({ message, origin }) => message.obWebSandbox === 1 && origin === "https://blog.example"));
  window.localStorage.setItem("theme", "dark");
  assert.equal(window.localStorage.getItem("theme"), "dark");
  assert.equal(window.localStorage.length, 1);
  assert.equal(window.sessionStorage.getItem("theme"), null);
});

test("selecting the first tab while the page loads never moves focus into an editor", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../web/components/ob-web-sandbox.js", import.meta.url), "utf8");
  assert.match(source, /const select = \(name, focus = true\) =>/);
  assert.match(source, /if \(focus\) editors\[name\]\.focus\(\);/);
  assert.match(source, /select\("html", false\);/, "the initial selection does not take focus");
  assert.match(source, /button\.addEventListener\("click", \(\) => select\(name\)\);/, "a reader's own tab click still does");
  assert.equal([...source.matchAll(/\bselect\("html"\)/g)].length, 0);
});
