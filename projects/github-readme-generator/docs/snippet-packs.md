# Portable snippet packs

Open **Snippet packs** to select saved snippets, saved badge collections, or copies of current draft sections. Project, widget, layout and other draft sections export as exact Custom Markdown snippets in v0.5.2; supported component definitions may retain editable template fields. Original drafts remain unchanged. Supply a pack name, description, optional author, HTTP(S) homepage and license note, then Download selected pack. Download all reusable snippets backup exports saved reusable snippets and badge collections, excluding draft-only sections.

Packs are ordinary versioned JSON files:

```json
{
  "version": 2,
  "type": "readme-studio-snippet-pack",
  "name": "My GitHub Profile Kit",
  "description": "Reusable source",
  "author": "Optional author",
  "homepage": "https://example.com",
  "license": "Optional license note",
  "snippets": [],
  "extensions": [],
  "badgeCollections": []
}
```

Each snippet uses the version-1 component model described in [Components](components.md). New exports use pack version 2. Version-1 packs migrate in memory to version 2 without changing reusable source; the imported file is never rewritten. Future versions are rejected. The importer accepts up to 10 MB, 500 combined snippets and extension entries, 50 extension manifests and 500 badge collections. Optional `extensions` and `badgeCollections` default to empty. Arbitrary Markdown/HTML in ordinary snippets is preserved as source; metadata is bounded plain text, URLs are validated, and no template is evaluated as code. Pack license notes are user-provided descriptions, not a license verification service.

Version-2 packs may contain declarative extension manifests. A manifest names an HTTPS publisher, declares only the inert capabilities `render-markdown`, `field-input` and `external-media`, and contains 1–100 normal component definitions. `render-markdown` is required; `field-input` is required when an entry exposes fields; and `external-media` is required for static remote URLs or URL fields, including ones whose default is empty. Script/module/eval/handler fields, event attributes, plain or entity-obfuscated executable URL schemes and active HTML such as `script`, `iframe`, `object`, `embed`, `form` or `style` are rejected recursively. README Studio renders an accepted entry through the existing component interpolator and sanitized Markdown preview; it does not import JavaScript, fetch a module, execute a hook or grant browser APIs.

Import a file or paste JSON, then Review snippet pack. Before import, the trust review shows the file/paste provenance, claimed author, declared capabilities and every discovered external HTTP(S) URL. It also shows name, metadata, counts, existing collisions and item source. Import itself performs no network request and does not change the current draft. Explicit Render item preview sanitizes Markdown; remote images may contact their hosts. Four editable examples are included: Minimal Profile Kit, Open Source Kit, Terminal Kit and Developer Showcase Kit. They contain placeholders, not personal data or live provider configuration.

The collision policy applies to all conflicts, including repeated entries inside a pack:

- **Keep both** (default): preserve existing items, assign new IDs when needed and add numbered name suffixes.
- **Replace**: requires confirmation and replaces a matching saved item while retaining its ID. If an incoming ID and name match two different saved items, replacement is rejected; choose Keep both or Skip.
- **Skip**: ignore conflicting incoming entries and preserve local items.

Cancel import changes nothing. Import writes reusable snippets and badge collections atomically before updating in-memory saved state. A failed save leaves the current library intact and the review available. Imported items join Component Library and all-drafts backups; restoring that workspace retains favorites/recents too. Pack files contain reusable content and file metadata, not workspace preferences. They can be committed to GitHub, attached to a repository, shared in a gist or sent directly. README Studio needs no sharing backend or accounts. Relative assets still need to accompany the README in its target repository.

Configured component presets (v0.5.3) use an optional version-1 `preset` within the existing component schema: field values, widget embed/helper settings, or a badge collection. They travel in the same pack format. Older plain/custom snippets remain valid. Each preset retains a usable Markdown/default-field fallback; an unknown preset type/version becomes Custom Markdown on import. Known unsafe/malformed supported configurations fail validation. Current draft component choices retain their preset only while stored source matches generated settings; modified source exports as an exact raw snippet.
