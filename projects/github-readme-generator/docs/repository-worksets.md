# Repository worksets

Repository worksets are named, opt-in lists for maintainers who handle related repositories. Open **Save → Repository worksets**, choose repositories already represented by targeted workspace documents, optionally add other `owner/repository` identities, and save the set locally.

Worksets do not fetch repository data, change Markdown, publish, or retain tokens. They store only a bounded name and canonical repository identifiers. A workspace holds at most 50 worksets and each set at most 100 repositories.

## Local availability

When a workset is opened, README Studio compares its repository identities with the current targets of local workspace documents:

- **Available locally** repositories list every matching document. Opening one only switches to that saved document.
- **Missing locally** means no current document target matches. The repository stays in the workset; README Studio neither fetches nor creates anything automatically.

Changing a document target changes this view the next time the workset opens. Worksets do not retain document IDs, branches, paths, source, or account data.

## Portable backup and migration

Download the selected workset to create a version-1 JSON file containing its name and repository identifiers. Imports are limited to 250 KB and must be reviewed and confirmed before they are saved. Existing worksets remain; duplicate names receive a numeric suffix.

README Studio can migrate the earlier version-0 portable shape (`title` and `repos`) during reviewed import. Future or malformed versions are rejected without changing local worksets. Worksets also travel in all-drafts workspace backups: Replace uses the backup library and Merge keeps both libraries with safe new identities and names. They are not included in Studio projects, draft backups, or README exports.
