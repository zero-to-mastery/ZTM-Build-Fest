# Documentation suites

Use **Documents → Create documentation suite** to prepare several related project documents together. Choose a project type, then explicitly select only the files the project needs. Nothing is selected automatically.

Each choice has a fixed relative path and an editable starting Markdown prompt. The prompts ask the maintainer to describe verified project details; they do not invent commands, contact addresses, API behavior or deployment steps. Available suites cover generic projects, CLIs, APIs, libraries/packages, games and web apps. A suite may include up to eight files.

## Review and creation

**Review exact suite** shows every selected path and its complete starting Markdown. Editing a selection or its Markdown invalidates that review. Creation requires a separate confirmation that every path and source was reviewed.

The whole reviewed batch is validated and written to browser storage before the workspace changes. A changed workspace, duplicate suite path, document-limit conflict, invalid manifest or storage failure creates nothing. Existing documents and their source stay unchanged.

Created files are independent **Local documents**. Their intended path and suite project type remain in workspace metadata and survive reloads and backups, but never enter exported Markdown. Suite creation makes no network request and does not publish. Repository association and GitHub publishing remain separate, explicitly reviewed workflows.

Those intended paths also let the local [cross-document link check](document-link-checks.md) resolve navigation among suite files and detect old links after a path moves.

## Choosing a small suite

Treat the project-type list as a menu, not a compliance checklist. Leave out contribution, security, support, architecture or deployment files when the project does not need them. Starting Markdown is guidance to replace with verified project information before sharing.
