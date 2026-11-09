# Repository README builder

Open **Create → Repository README**, or choose **Build a repository README** from Templates. Profile templates remain available separately.

The repository templates are Web App, Library, CLI, API, npm Package, Rust Crate, Python Package, Game, Open Source, Tutorial, Documentation and Generic. They offer different section structures: a game includes controls and build instructions; a CLI includes commands and flags; a package includes compatibility and usage. Sections are suggestions, not universal requirements.

## From an audit

Choose **Improve README** on an audit result or queue item, or **Improve next** in the attention queue. The builder opens with the audit's manual project-type override, or its automatic suggestion, as the selected template. PWA maps to Web App and Experiment maps to Generic. You can change the template. **Open in Studio** in the queue continues to open the exact original README without templates.

Public repository name, description, homepage, primary language and topics appear in editable fields. Review them, correct them, or clear any optional value. A homepage is not a verified live demo, and language/topics are not claims about proficiency or completeness. Creating the draft confirms the displayed values. No additional metadata requests are made while editing the form.

## Import and match sections

Expand **Import existing README** to choose a UTF-8 file (up to 2 MB), paste Markdown, or use the current draft. File imports retain BOM, Unicode and line endings; pasted text uses browser textarea line endings. Invalid or oversized files leave the prior source intact. Imports are temporary until a new draft is created.

The builder identifies top-level Markdown and HTML headings, including common aliases. Fenced examples, quoted headings, HTML comments and pre/code examples do not count as sections. Matching headings are deselected by default. Related headings are reported as partial evidence; empty and badge-only sections need manual review. Unknown/non-English structures may require manual matching. These are project-type suggestions, not universal requirements or completeness scores.

## Review a merge or replacement

Keep preservation checked to retain the original source verbatim in a Custom Markdown block and append only selected suggestions. Reviewed repository context is optional and off by default for existing READMEs. Deselect every suggestion for an unchanged result. Existing sections are never automatically rewritten.

Choose **Review changes** to inspect both full source panes and the unified diff, then check **I reviewed the diff and approve this exact result**. Approval is tied to the source, output and reviewed settings; editing them invalidates it. This review is required for imported READMEs even when preservation is unchecked to create a replacement. The result is always a new local draft, never a remote write.

**Open existing README unchanged** bypasses templates and keeps exact source. Cancel/Escape creates nothing. The review heading receives keyboard focus; standard dialog focus return and dismissal remain available.

Expand **Responsive rendered preview** for sanitized GitHub-style rendering, light/dark modes and 320px/768px maximum widths. Remote images contact their hosts only when the rendered preview is opened. Preview sanitization never rewrites exported Markdown.

## Complete the documentation

**Create repository README** creates a new local draft and opens the builder. Each section is independently editable and removable, with ordinary Markdown available throughout. In v1.2.1, supported sections open [structured documentation builders](documentation-sections.md); other sections remain Custom Markdown. Unknown commands, setup details, environment values, authentication, versions, license terms and project behavior are never guessed. Generated HTML comments identify writing prompts; replace them with actual project information or remove irrelevant sections. Comments do not render in GitHub's preview, so inspect sections in the editor before publishing.

The reviewed values and selected template are stored in Studio metadata and survive project/backup export. Exported README content is ordinary Markdown/HTML; internal template metadata is not included. No GitHub write occurs in this flow. Existing drafts and the remote repository are untouched.

Text suggestions are escaped and homepage links must use safe HTTP(S) URLs. The generated source preview is a read-only text field, not arbitrary HTML execution. The shared dialog supports Escape, outside-click dismissal, keyboard focus handling and mobile scrolling.

In v1.2.2, new templates select [project-specific documentation builders](project-documentation.md). The Library recommends sections from that template and provides a manual project-type selector without rewriting existing content.
