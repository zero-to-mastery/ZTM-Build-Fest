# Worksets store repository identities, not credentials

Repository worksets are an additive version-1 workspace field containing bounded records of `{ id, name, repositories }`. A repository is a canonical lower-case `owner/repository` identity. Worksets deliberately omit document IDs, branches, paths, Markdown, fetched metadata, account state and credentials.

The application resolves identities against current local document targets only when presenting a workset. This keeps portable files useful across browsers while making missing local documents explicit. Resolution performs no network request and never creates or modifies a document.

Portable imports have their own allowlisted, versioned contract and require a visible review plus confirmation. Version 0 can be migrated from `title`/`repos`; unknown versions fail closed. Workspace merge retains both bounded libraries with regenerated IDs and suffixed colliding names. This favors explicit local recovery over live repository membership or automatic synchronization.
