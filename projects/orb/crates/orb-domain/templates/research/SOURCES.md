# Sources registry

Where each kind of data lives, how to get it, and what can go wrong.

- **Orchestrator:** update this whenever a source is discovered, confirmed or changes.
- **Agents:** read the gotchas before using a source. Report new findings in your return; don't edit this file.

Entry format:

```
## <name>
- What:
- Where:
- Access: .env <VAR> | CLI | MCP <server> | user export | user screenshot
- Gotchas:
- Last confirmed: <date>
```

## Code repos

Ask the user for a repo's path the first time it's needed, then record it here. Reading a repo outside this folder goes through Claude's permission prompt.

| Repo | Path | Owns |
|---|---|---|
