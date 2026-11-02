# Audience review

Open **Review → Audience review** to inspect the active README from an end-user, recruiter, contributor or maintainer perspective. The analysis runs in the browser and uses populated headings as limited evidence. It does not score the README or its author, verify claims and commands, contact GitHub, or publish anything.

## Reader perspectives

Each perspective shows a short set of topics with one of three states:

- **Observed** means a populated, recognized heading was found. It does not prove the section is complete or correct.
- **Not detected** means the analyzer understood some of the structure but did not recognize that topic. The topic may use different wording or appear inside another section.
- **Unknown** means the structure could not be interpreted confidently. Unknown is never treated as absent.

The checks are prompts for human review, not universal requirements. They deliberately contain no numeric score, ranking, hiring judgment or claim about developer skill.

## First-visit checklist

Choose Game, CLI, Library or API for a project-specific checklist. The checklist identifies likely first-use topics such as controls, installation, minimal usage, authentication or sample requests. Whether setup steps actually work always remains **Unknown** because static Markdown analysis does not execute commands, inspect credentials or start services.

## Information hierarchy

Audience review may propose an H2 order when the source has a conservative, unambiguous structure: distinct headings, at least two distinct recognized topic roles and no more than one H1. Repeated headings, repeated roles, missing structure and other ambiguity are refused rather than guessed.

The proposal moves complete, exact source slices. It does not rewrite headings or section bodies. Current source, proposed source and a unified diff remain visible before approval. Changing the perspective clears approval; a draft change makes the proposal stale and blocks it. Applying the reviewed order creates one local Undo checkpoint, may turn changed builder-owned sections into Custom Markdown, and never writes to GitHub. Undo restores the prior source and ownership.

The lazy review bundle is part of the production offline cache, so it remains available after the app has installed successfully and the origin later becomes unavailable.
