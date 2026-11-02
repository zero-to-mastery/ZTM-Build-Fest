# Plugin host API v2 and source compatibility

New integrations should use normalized Source API v2 records; see [extension authoring](extension-authoring.md). The Source API v1 examples below remain supported through the compatibility adapter. `json-records` accepts normalized records; `json-feed` preserves legacy id/name feeds. Theme API v2 adds `apiVersion: 2`; built-in `themePacksV2` descriptors retain the same content versions as legacy `themePacks`.

# Sources, themes and node renderers

## Compatibility policy (core 2.x)

`PLUGIN_API_VERSION` is 1. Core 2.x guarantees `createPluginHost`, `registerSource`, `registerThemePack`, `load`, `render`, and `clearCache`; source `id`, `apiVersion`, `load(context)`, optional `renderNode(context)`; loader account/options/signal/fetch arguments; namespaced result IDs; and the documented `{ path, fill? }` renderer descriptor. Theme packs retain `{ id, version, preset }`, with exact release versions and explicit config taking precedence. Changing or removing these contracts requires a new core major version. Additive optional capabilities may ship in minor releases; fixes may ship in patches. Hosts reject unsupported source API versions explicitly. Diagnostic counters and benchmark timings are observational, not layout contracts.

Pack authors version changed preset content independently and retain earlier content versions for saved designs. A pack package release may change packaging without changing the contained content versions. Core does not silently upgrade an exact theme reference.

Run `node examples/plugin-demo.mjs` to create `.dist/plugin-demo.svg` offline. The example imports the separately packaged JSON source and themes, registers a custom path renderer, and combines two source instances with the same local node ID. Use it as a starting template for a source author.

The core exposes `createPluginHost()`. Each host has an isolated registry; it does not discover or execute modules from config strings. Import trusted plugin modules in the application and call `registerSource`. The built-in `json-feed` source accepts `options.items` or an HTTP(S) `options.url` whose response is an array of nodes.

```js
import { createPluginHost } from '@constellation/core';
const host = createPluginHost();
host.registerSource({
  id: 'projects', apiVersion: 1,
  async load({ options, account, signal, fetchImpl }) {
    return [{ id: 'one', name: 'Project one', language: 'Rust', topics: ['tools'] }];
  },
  renderNode({ node }) { return { path: 'M0 -1 L1 0 L0 1 L-1 0 Z', fill: '#ff8800' }; },
});
const options = { plugins: { sources: [{ id: 'work', source: 'projects', options: {} }] } };
const nodes = await host.load(options, { account: 'octocat' });
const svg = host.render('octocat', nodes, options);
```

Every source instance has a unique config `id`. Returned node IDs become `source:instance:encoded-id`; duplicate IDs within an instance produce an error. Different sources can return the same local ID. Source loading and returned nodes have deterministic ordering. Keep each loader deterministic for a given data snapshot; pass cancellation through `signal` and use the supplied `fetchImpl` in tests. GitLab can be implemented through the same loader contract by mapping its public projects to nodes; no GitLab adapter ships here.

Node records require nonempty string `id` and `name`. Optional repository-like metadata includes `language`, `languages` (language-to-byte-count map), `topics` (string array), `stargazers_count`, and ISO date strings such as `created_at` and `updated_at`. Source instances have lowercase letter/digit/hyphen IDs, starting with a letter. Keep credentials in the application's fetch adapter, not in shared config. Loader errors reject the whole load; render only after the promise succeeds. Aborting a signal stops before the next loader and reaches fetch through the adapter.

Test both successful and rejected loads, two instances sharing a local ID, duplicate local IDs, deterministic results with fixed fixtures, and config/share round trips. Applications can combine the returned nodes with GitHub records before calling `host.render`; merged ID collisions are reported. Studio hosts that load external modules must register them explicitly; the CLI/Action bundles the JSON adapter.

Render hooks receive a copied node, SVG coordinates and radius. They return `{ path, fill? }`; paths use a -1..1 coordinate box, and fill is a six-digit hex color. The host retains the interactive node circle and supplies the custom path in its place visually. Arbitrary markup is not accepted. A direct render caller can also provide `nodeRenderer` in the fourth argument.

`packages/source-json` is a standalone reference source package. Its implementation is also bundled in core for CLI/Action use. Configure a feed through `plugins.sources` in the same config-file or config-json paths. Plugins loaded by another application must be registered in that application's host; config strings do not import executable code.

`packages/themes` contains every existing Look preset as a `{ id, version, preset }` theme pack, versioned independently at 1.0.0. Build extension packages with `node scripts/build-extensions.mjs`, then `npm pack ./packages/themes` or `npm pack ./packages/source-json`. Import `themePacks`, register a pack with `host.registerThemePack(pack)`, and set `themePack: { id, version }`. A full pack with its `preset` can also be embedded in a config/share link; exact references to bundled Look packs resolve directly. Explicit config colors and styling retain precedence. A theme pack change does not require changing the core version.
