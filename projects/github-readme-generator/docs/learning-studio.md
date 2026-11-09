# Learning studio

Learning studio is an optional, local writing practice surface. Open **Review → Learning studio**, choose the closest project type, and work in the same Markdown editor used for the README. Lessons are skippable and never insert, rewrite, publish, or score the document.

## Guided lessons

Profile, CLI, library, API, and game tracks each contain three short tasks. A task reports one of three evidence states:

- **Observed** means exactly one related heading was found. It does not verify the section's claims, commands, links, or runtime behavior.
- **Not detected** means no related heading was found. The topic may be absent, named differently, or intentionally covered elsewhere.
- **Unknown** means more than one heading could match, so the tool will not guess which section is authoritative.

Choose **Practice in Markdown editor** to focus and select the observed heading. When no exact heading exists, the editor opens at the end of the source. Nothing is inserted; write only facts you can verify. If the README changes while Learning studio is open, its older practice target is rejected.

## Annotated examples

The before-and-after examples demonstrate setup, smallest-useful-example, and troubleshooting patterns. They are synthetic and contain visible placeholders such as `[verified command]` and `[observed error]`. The annotations explain the writing decision; the examples are never applied to the README and must not be treated as project evidence.

## Checklist progress and portability

Each project type has a reusable three-item checklist. Progress is content-free browser state keyed to the local document and project type; it contains document identity, checklist item IDs, and update time, but no README text. The store is versioned, bounded to 50 document/type records, and rejects malformed data. A failed save restores the last displayed selection and leaves the previous record unchanged.

Use **Download ordinary Markdown checklist** at any time. The exported task list works without README Studio and includes a reminder to verify project-specific facts. Checklist progress is separate from workspace backups, so export it before clearing browser storage if you need a durable copy.

## Offline and accessibility behavior

The feature is loaded on demand from the installed application and makes no network request. After the production app and its lazy tools have been cached, it works offline. Controls use native labels and buttons, changes are announced through a status region, practice returns focus to the real editor, and the dialog reflows at 320 CSS pixels. Automated Chromium, Firefox, and WebKit checks cover these contracts but are not assistive-technology certification.
