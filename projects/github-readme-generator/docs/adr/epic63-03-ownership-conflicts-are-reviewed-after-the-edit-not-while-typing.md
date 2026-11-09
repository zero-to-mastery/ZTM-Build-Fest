# Ownership conflicts are reviewed after the edit, never while typing

> **Status: accepted and implemented by story #78 in v1.9.7.**

An ambiguous visual or raw edit could be resolved in two places. One is at the keystroke, with a modal asking "detach this component?". The other is afterwards, by detaching immediately (ADR epic63-01) and offering an explicit review later. A modal during typing would steal focus from the editor, break autosave and Undo granularity, and make the author answer a question about text they have not finished writing. We chose the second.

Ownership review opens in exactly three cases: a builder form or component customizer is saved for a Block that changed or detached after the form opened; the author chooses **Review** on a Detachment record; or the author restores a Restorable record. It shows Original, Proposed and a unified diff through the shared inert `source-diff` surface. **Keep my Markdown** is the default and Escape choice and changes nothing. **Use visual version** checks the whole-draft snapshot, then applies one `Store.blocks` edit (one Undo step) that replaces only that Block and clears its record. If the draft changed while the dialog was open, nothing is applied and the comparison is refreshed.

We never restore generated, shared, profile or banner ownership from the review. Those owners have their own reviewed recreate flows, and restoring them here would bypass their stale-source checks.
