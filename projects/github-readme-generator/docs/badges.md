# Badge Studio

Open Badge Studio from the header, or from a saved builder section to preselect that section. Unsaved builder edits should be saved before opening the studio. Logo search uses catalog names, slugs, categories and aliases; custom Simple Icons slugs are also editable. Presets are suggestions, including static Build/Deployment examples; they do not validate live status.

Choose label, message, label/message colors (named or hex), logo/logo color, style, link and meaningful alt text. Light/dark pairs use GitHub-compatible picture/source markup. The main colors control the light variant. Copy Markdown or HTML; plain badges need no HTML. Duplicate creates an editable copy in the composer; insert each desired copy explicitly. Reset starts a fresh badge.

Insertion never replaces a text selection. It appends to a selected badge row or section, or inserts at the remembered cursor. Appending to a non-badge section preserves its generated source as editable custom Markdown. Undo restores the prior draft. Manual Markdown stays available.

Preview images contact Shields.io directly and may fail offline. Generation is local and exports ordinary Markdown/HTML with no README Studio runtime. Shields and Simple Icons provide the badge service and logo names; this app does not proxy them or guarantee GitHub rendering parity.

References: [Shields static badge options and encoding](https://shields.io/badges/static-badge), [Simple Icons](https://simpleicons.org/).

## Collections

Collections live in the local workspace independently of drafts. Create one from Badge Studio, start from an editable collection starter, or save a stack category. In Collections, edit the name, reorder/edit/duplicate/remove badges with buttons, then **Save collection**. Import validates version 1 JSON and assigns a new ID and unique name. Export collection is independent of README export. Changes remain temporary until saved; export is available if browser storage fails.

Choose plain HTML row, centered row, picture wrappers, or a Markdown category heading. Preview desktop, narrow or mobile wrapping; only the first 20 images are previewed for large collections, while export includes all badges. Search supports collection names, badge labels, logos and catalog aliases.

Inserting into a README copies the markup. Inserting through a saved stack block copies badge settings into that stack. Future collection edits never rewrite existing drafts. Save pending stack edits before opening collections.

## Dynamic providers

Open Dynamic badge helpers in Badge Studio. Search by provider or category, enter the configuration, and choose Generate dynamic badge. Typing performs no API requests. The generated badge can be styled, linked, paired for dark mode, and saved to a collection. Label/message fields are hidden because the provider supplies them. Cache seconds is optional and Shields may enforce a higher minimum. Repository suggestions from import/autofill metadata require explicit selection; a profile repository suggestion does not establish that it exists.

| Helper                                           | Inputs                                                      | Suggested destination                             |
| ------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------- |
| GitHub stars/forks/issues/license/latest release | owner/repository                                            | matching repository page                          |
| GitHub Actions                                   | owner/repository, workflow file/name, optional branch/event | workflow Actions page                             |
| npm version/monthly downloads                    | package or @scope/package                                   | npm package page                                  |
| crates.io version/total downloads                | crate name                                                  | crates.io crate page                              |
| PyPI version                                     | package                                                     | PyPI project page                                 |
| Docker version/pulls                             | user/repository; _/name for official images                 | Docker Hub image page                             |
| Netlify                                          | site ID (UUID)                                              | Netlify dashboard; override with your project URL |
| Custom endpoint                                  | public HTTP(S) JSON endpoint                                | endpoint; override as needed                      |

These are URL helpers, not service validators. No workflow existence or badge value is guaranteed. An image can load while containing a provider error message; inspect it. No authentication, proxy or draft upload is involved. Preview requests disclose the configured repository/package/endpoint URL to Shields and normal network metadata to image providers. For custom endpoint badges, Shields fetches the public endpoint; never enter secrets. Offline generation still works, while remote images may fail.

Provider references: [GitHub Actions](https://shields.io/badges/git-hub-actions-workflow-status), [npm](https://shields.io/badges/npm-version), [crates.io](https://shields.io/badges/crates-io-version), [Docker](https://shields.io/badges/docker-image-version), [Netlify](https://shields.io/badges/netlify), [JSON endpoint schema](https://shields.io/badges/endpoint-badge).

## Accessibility, clarity, and reliability

Use concise alt text that names a technology or explains the badge status. Empty or generic “badge” text and repetition next to identical text can make screen-reader output unhelpful. README Health reports advisory categories and section context when available. It detects repeated URLs, similar badge meanings, repeated technologies, repeated GitHub metrics, multiple build badges, more than eight badges in a Markdown row, and more than twenty in a section. Comparisons are heuristics, never automatic removals.

Contrast guidance estimates label/message text against their backgrounds (assuming white text) and logo colors against the configured background. It warns below approximately 4.5:1 for text or 3:1 for logos. Shields rendering, social styles, gradients, automatic text colors and unknown named-color mappings can change results; this is not a WCAG compliance guarantee. Inspect both variants. Any valid markup can still be exported despite accessibility suggestions.

Named CSS/Shields colors and 3/6/8-digit hex input are accepted. Unknown named colors, unsafe URLs and malformed logos are explained before generation. Existing manually written Markdown is never rewritten by these checks or preview sanitization. If clipboard permission is denied, the generated text stays selected in the composer for manual copying.

Collections are included in Download all drafts backup (workspace schema 1, nested badgeCollections schema 1). Restore merge preserves local collections and creates unique IDs/names for collisions; replace requires confirmation and replaces drafts and collections. Individual collection files also use schema 1. Use v0.2.x or newer to restore collection-aware backups: older apps do not understand that field. Collection imports are capped at 5 MB and 1,000 badges; the workspace supports up to 500 collections. A malformed stored collection leaves original storage untouched; readable badges/drafts are recovered into a temporary workspace and original JSON remains downloadable. Export before clearing storage.

Unsaved collection edits prompt before closing. Save is explicit and errors remain visible. An inserted copy does not become a live reference. Collection previews show desktop/narrow/mobile widths and at most twenty remote images, including for 150-badge test cases. Core generation, editing and export work offline after app load; remote previews may fail without retries. Offline reload is not guaranteed.
