# Documentation section builders

Open the builder's **Library** tab and select a documentation section. All sections can be added to any draft, edited again, reordered, duplicated, copied or removed. **Generated Markdown & preview** lets you inspect the output before saving. Cancel leaves the draft unchanged.

The 18 section types are:

| Section               | Structured fields                                                                   |
| --------------------- | ----------------------------------------------------------------------------------- |
| Overview              | Purpose, audience, scope and limitations                                            |
| Features              | Feature list, notes                                                                 |
| Installation          | Package manager, install command, prerequisites, additional notes                   |
| Quick Start           | Prerequisites, steps, commands, expected result                                     |
| Usage                 | Instructions, commands, expected behavior                                           |
| Configuration         | File location, options, example, notes                                              |
| Environment Variables | Name, required flag, description and example-placeholder rows; notes                |
| Commands              | Commands, flags/options, examples, notes                                            |
| API                   | Overview, authentication guidance, endpoints/symbols, request and response examples |
| Examples              | Description, language, code, expected result                                        |
| Architecture          | Overview, components, data flow, decisions                                          |
| Testing               | Commands, test types, coverage notes                                                |
| Deployment            | Target, prerequisites, commands, verification/rollback                              |
| Troubleshooting       | Symptoms, possible causes, solutions, support                                       |
| Contributing          | Setup, workflow, checks, guidelines                                                 |
| Security              | Private reporting instructions, supported versions, policy/scope                    |
| License               | Confirmed license name, license-file path, notes                                    |
| Roadmap               | Planned work, current progress, scope/timing notes                                  |

Fields begin empty. Supply verified project facts; the builder does not guess install commands, prerequisites, coverage, credentials, promises or license terms. Empty sections contain a writing comment that does not render in preview. Remove irrelevant sections or complete their fields before publishing.

## Installation and Testing

Package manager is a free-text field, so it can describe any supported tool. The install command is independent: selecting or entering a manager does not invent a package name or command. Commands are serialized in fenced code blocks and are never executed. Code containing backticks gets a longer surrounding fence so it remains literal.

Testing accepts multiline commands, one test type per line and free-form coverage notes. It does not report measured test coverage or imply that a test suite passed.

## Environment Variables

Choose **Add environment variable**, then fill in the name, required checkbox, description and example placeholder. Use a conventional identifier such as `API_TOKEN` or `PORT`; letters, digits and underscores are supported, with no leading digit. Required is explicit and defaults to unchecked.

Use `YOUR_API_TOKEN`, a descriptive placeholder or a non-secret example such as `3000`. Never paste real passwords, keys or tokens into the builder. Keep real credentials outside version control and document placeholders in `.env.example`. The UI and generated README both include this guidance. This is not a secret vault or a guaranteed secret detector; text you enter can be saved locally and exported.

Rows have keyboard-accessible move up/down, duplicate and remove controls. Up to 200 rows are supported. Table cells escape Markdown/HTML delimiters and line breaks so descriptions cannot accidentally create additional columns. The preview is sanitized by the existing Markdown renderer.

## Templates, portability and manual editing

New repository templates use these builders for matching section names, including Setup → Installation, Purpose → Overview, Environment → Environment Variables and How to run → Quick Start. Original headings are retained. Unsupported template sections remain Custom Markdown. Existing drafts and v1.2.0 Custom Markdown sections are not automatically converted or rewritten.

Structured settings remain in Studio project/backup data. Exported README files contain ordinary headings, lists, tables and code fences, with no Studio runtime dependency. Undo/redo works through the existing draft history. Editing the whole README manually follows the existing raw-edit behavior: source is preserved as Custom Markdown, and Undo can restore the structured version. Unknown future section settings fall back to the stored Markdown when a project is imported.

The 18 common builders remain available alongside the [project-specific forms](project-documentation.md) introduced in v1.2.2. New templates use specialized structures where appropriate; previously saved templates retain their original sections.
