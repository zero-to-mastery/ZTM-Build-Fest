# Project-specific documentation builders

The builder Library recommends documentation sections for the repository template used by the draft. **Documentation project type** lets you choose a different set. npm/Python packages use the Library/package recommendations; PWA uses Web App. Unsupported types use Generic, with all sections available.

Changing this selector saves a draft-specific preference and is undoable. It does not rewrite source, change existing fields or claim the project was conclusively classified. Recommended sections appear first; other builders remain available below them. New repository templates use the specialized structures, while existing drafts keep their original blocks and Markdown.

For a set of separate files such as `README.md`, `CONTRIBUTING.md`, `SECURITY.md` and project-specific references, use [Documentation suites](documentation-suites.md). Suite choices begin empty and create independent local documents only after exact review; section builders here continue to shape one document.

## Available builders

| Project type    | Documentation tools                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI             | Installation; CLI Reference with command syntax, commands, examples and rows for flags, aliases, accepted values and descriptions; configuration |
| API             | Setup; API Endpoint with authentication guidance, method/path, parameter rows, request and response examples; environment variables              |
| Library/package | Installation; Library Guide with import statement, basic example, API surface and compatibility; examples and contributing                       |
| Game            | Gameplay objectives/rules/progression; control input/action/device rows; local-running steps; screenshots; save/data behavior                    |
| Rust crate      | Cargo.toml dependency snippet, feature list, Rust example and compatibility notes; features/examples; docs.rs and crates.io links                |
| Web app         | Demo link/instructions/limitations, screenshots, setup, environment variables, architecture, testing and deployment                              |

## CLI and API

Commands and syntax are literal fenced examples, never executed. Enter the actual commands and accepted flag values. Empty fields do not guess behavior.

Every structured command or code field, including a Code Sample block, also has [example provenance](example-provenance.md): Verified, User-confirmed or Placeholder. New examples start as Placeholder, while Verified requires a local note describing the check or evidence. Editing example text resets an older claim to Placeholder. The exported inert marker survives copy/export; the private note does not. Existing and imported examples are never run or silently reclassified; unmarked fences are surfaced for explicit review.

An API Endpoint section describes one endpoint. Duplicate it for another endpoint, then edit the independent settings. Parameter rows have name, location, required flag, type and description. Required defaults to unchecked and is explicitly controlled. Authentication guidance and examples should use placeholders such as `YOUR_API_TOKEN`, never real credentials. Request and response examples are fenced as HTTP text; their validity is not tested against a live service.

## Libraries and Rust crates

Library Guide has an optional example-language field so imports and examples can use the appropriate code fence. Document the actual public API and tested compatibility; Studio does not infer supported versions from repository language.

Cargo Dependency accepts the actual TOML dependency snippet, feature names and Rust example. No package version, feature availability or registry lookup is invented. Crate Links accepts HTTP(S) URLs for docs.rs and crates.io; users may supply hosted documentation alternatives. URLs are validated for safety, not fetched or certified as reachable.

## Games, screenshots and web demos

Game controls use structured input/action/device rows. Save and Data Behavior covers location, what is saved and when, reset/deletion, backup, portability and privacy. No autosave, cloud persistence or data-loss claim is generated automatically. Local-running instructions reuse Quick Start's prerequisites, steps, commands and expected result.

Screenshots accepts multiple repository-relative paths or safe image URLs, meaningful alt text and optional captions. Missing alt text or unsafe URLs prevent saving the generated section until corrected. Commit local image assets yourself; Studio does not upload them. Remote previews contact their image hosts. Spaces and parentheses in image paths are encoded for Markdown, and captions remain literal text.

Demo URLs, instructions and limitations are supplied by the user. The builder does not check availability or imply that a demo is current. Web-app setup, environment, architecture, testing and deployment reuse the [common documentation builders](documentation-sections.md).

## Editing and portability

Structured rows support keyboard reorder, duplicate and remove actions, capped at 200 per section. Settings remain in Studio project files and workspace backups. README export remains ordinary Markdown with headings, tables, links, images and code fences. Manual source editing retains the existing Custom Markdown/undo behavior. Older section types and previously created templates remain supported without automatic conversion.
