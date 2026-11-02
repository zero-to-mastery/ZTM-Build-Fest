# Personal Appearance contract

**Candidate:** `v0.46.0` on `feat/kin-personal-appearance`, stacked from PR
#42 (`feat/kin-workspace-ux`) at `dadd92b023190e5a9f3844b7737541152b4dbc6f`.
PR #42 remains an independent, open dependency; this work does not approve,
merge, or alter its commits. v0.42-v0.45 already name other roadmap scopes,
so v0.46.0 is the next unclaimed minor candidate.

## Scope and ownership

Appearance is a protected, device-local preference for one authenticated Kin
member in one local household vault. Its owner key is the trusted member ID
from the opened event store, bound to the vault ID; names, email addresses,
household-only IDs, and caller-supplied identity are never ownership evidence.
If that binding is unavailable or mismatched, Kin uses its default appearance.

The versioned appearance record and processed background are encrypted with
the existing local-vault primitives in a dedicated IndexedDB store. They do
not create household events, attachment records, relay traffic, activity,
catch-up entries, notifications, analytics, URLs, logs, or portable exports.
There is no cross-device synchronization in this release.

## Interaction and precedence

System, Light, and Dark are independent of the color source. System follows
the live operating-system preference; explicit modes do not. Editing previews
immediately but does not persist until **Save changes**. **Cancel** restores
the last committed record. **Reset to Kin default** stages System, Kin default
color, and no image, and becomes durable only after Save. Navigation retains
the draft for the unlocked session. Lock, logout, vault replacement, or member
switch discards it before any next owner is loaded.

Color state keeps a remembered manual choice, an extracted image seed, and an
active source. Kin default applies with no explicit choice. Selecting the first
background while automatic/default is active selects its derived seed;
replacing that image updates the seed only while the image source remains
active. A preset or custom seed becomes the manual override. **Use background
colors** explicitly returns to the current extracted seed. Removing an image
keeps a manual seed, or restores the remembered manual choice/default when the
image source was active. Mode switches preserve all color and image state.

## Image processing

Accepted inputs are decoded JPEG, PNG, and WebP only. Limits are 12 MiB input,
32 megapixels decoded, 2560 pixels on the normalized longest edge, and 3 MiB
for the newly encoded static WebP/JPEG representation. SVG, PDF, remote URLs,
animation, original metadata, filenames, paths, and original bytes are not
stored.

Processing uses native image decoding and canvas off the render path. The
normalized image is sampled through a fixed 32×32 canvas. Fully transparent
pixels are ignored; remaining RGB values are quantized to 4-bit channels.
The bucket with the largest population wins, with the lowest numeric bucket as
the stable tie-break. Its population-weighted RGB mean is the seed. A fully
transparent/unusable sample falls back safely to Kin default with an explicit
message. Extraction runs once per selected image.

Each selection has an owner/session generation and request generation. A later
selection, removal, manual choice, cancel/reset, lock, or owner switch makes
older decode/extraction/save results ineligible to change the UI. Temporary
bitmaps, canvases, and object URLs are released. A replacement record is a
single protected write, so the previous committed image remains if encoding,
encryption, quota, or transaction commit fails.

## Palette and lifecycle

The chosen seed generates coordinated light and dark tokens for backgrounds,
surfaces, text, muted text, boundaries, accents, focus, selection, and header
navigation. Semantic danger and warning tokens remain separate. Token helpers
enforce the documented text/control contrast targets for their actual paired
surfaces; this is focused token verification, not an accessibility
certification.

Signed-out and locked UI always uses Kin defaults. Lock/logout removes applied
tokens and background, revokes object URLs, invalidates work, and clears
decrypted/draft state. Root rotation re-encrypts the local personal store under
the replacement root. Portable recovery/export and a replacement vault do not
carry device-local appearance; this intentional reset prevents preferences
from becoming shared household data and never blocks Kin startup.
