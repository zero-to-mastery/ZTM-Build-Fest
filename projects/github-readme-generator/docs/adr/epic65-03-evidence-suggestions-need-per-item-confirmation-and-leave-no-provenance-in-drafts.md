# Evidence suggestions need per-item confirmation and leave no provenance in drafts

Implemented in v1.9.11.

In Stack-to-README review, every selected Command suggestion and Technology claim needs its own Confirmation before **Review exact diff** is enabled. Editing an item's Markdown clears its Confirmation. The existing whole-diff approval still follows. Provenance is shown for each suggestion before selection, but after insertion the draft holds only the ordinary Custom Markdown blocks the author approved. No provenance, basis or scan metadata goes into the Markdown, block settings, draft metadata, backups or portable projects.

We rejected relying on the single diff approval, because one checkbox over many commands lets a conventional but wrong command (for example `npm install` in a pnpm repository) through unread. We rejected storing provenance with inserted blocks or as hidden comments, because it would add a schema field that has to survive manual edits, imports and merges, and hidden comments would break the guarantee that exported Markdown has no application metadata. We accepted that a later reader of the draft cannot see where a sentence came from, in exchange for lossless, metadata-free Markdown and no draft schema change.
