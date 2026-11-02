# Guided start

Guided start is the first screen of a new workspace. It asks what you want to do first, keeps every earlier way to begin and says plainly where your work is kept. It opens by itself only when this browser has no saved workspace. When a saved workspace exists but cannot be read, Guided start does not open by itself, so the recovery notice (**Download original recovery data**, **Restore backup**) stays usable. Reopen it at any time from **Create → Guided start** or by searching for "Guided start" with `Ctrl/Cmd+K`.

## Choose a goal

Step 1 offers three goals:

| Goal                            | What happens next                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Write my profile README**     | Start from a profile template, Autofill from GitHub, or Start a blank profile README.                                        |
| **Write a repository README**   | Build a repository README, Import existing README (a GitHub repository or a local file), or Start a blank repository README. |
| **Audit my repository READMEs** | Open README audit. It reads your public repositories from GitHub, so it needs a connection.                                  |

Choosing a goal shows step 2 in the same dialog and moves keyboard focus to its heading. **Back** returns to step 1 with focus on the goal you chose. Every option in step 2 opens that tool's normal flow, with its usual review and Undo; the blank options create an empty document in the Profile or Repositories group without a GitHub target. Escape or an outside click closes Guided start at either step and returns focus as other dialogs do.

Your goal is saved in this browser's workspace when you choose it. It never changes a document. When you reopen Guided start, your current goal is marked ("Your current goal") and focused. A saved goal never opens a dialog by itself. After you start from a template, an import, the audit or a blank document, the [Next steps](next-steps.md) panel suggests what to do next.

### Offline

When the browser reports that it is offline, **Open README audit** stays visible and focusable but is marked unavailable (`aria-disabled`), with the reason read as its description. Activating it does nothing, even if the connection returns while step 2 is open. Step 2 then offers **Import existing README** (local files work offline) and **Start a blank repository README** instead. Reopen Guided start once you are back online to open the audit. The profile and repository goals work offline, apart from options that read GitHub (Autofill and GitHub import), which report their own network errors.

## Other ways to start

The Start paths from earlier versions stay in step 1 under their existing names: **Start from a template**, **Autofill from GitHub**, **Import GitHub README** (the import dialog also accepts local files and Studio backups), **Open Studio project**, **Start blank** and **Explore the sample profile**. On first run the sample profile is already open, so Explore closes the dialog; when Guided start is reopened later it adds a fresh copy of the sample.

**Restore a backup** opens the existing restore dialog, so an author whose browser data was cleared can get a downloaded all-drafts backup back from the first screen. The dialog validates the file before anything changes, and a damaged file changes nothing. A merge restore opens the backup's own active draft; see [Editing and recovery](editing.md).

## Where your work is kept

Guided start always shows the Locality statement:

- Drafts are saved only in this browser. They are not encrypted and clearing site data removes them, so download a backup (**Manage drafts → Download all drafts backup**) to keep a copy.
- GitHub is contacted only when you choose a GitHub action: import, autofill, audit, repository lookup, refresh and link checks, evidence and drift checks, or publishing. Link checks also contact the sites your links point to. Analysis runs in this browser: your Markdown is sent only when you publish it, or when you review and send text to the optional Writing assistant's provider. Images and badges in the preview load from their own sites.

The GitHub line names every flow listed under [Network requests](privacy.md#network-requests); Guided start itself makes no request.

- Nothing is published without its own review.

When browser storage is blocked, the first line instead says this is a temporary workspace that lasts only until the tab closes. When the saved workspace could not be read, it says the original is left untouched, that **Download original recovery data** keeps it, and that new drafts stay in memory until a backup is restored. In both cases the goal you choose stays in memory only. The statement links to the [privacy notes](privacy.md).

## What is saved, and where

The goal is stored in an optional `guide` field of the version-1 workspace (ADR 0004): `{ "version": 1, "goal": null | "profile" | "repository" | "audit", "nextSteps": true }`. It is not a workspace setting, so it is not copied into Studio projects.

| Where                                     | Contains the goal?                                                  |
| ----------------------------------------- | ------------------------------------------------------------------- |
| Browser storage and storage recovery      | Yes                                                                 |
| Download all drafts backup                | Yes. A replace restore uses the backup's goal; a merge keeps yours. |
| Studio project (`.readme-studio.json`)    | No, including embedded libraries and saved preferences              |
| Download draft backup (single-draft JSON) | No                                                                  |
| Export README / Copy Markdown             | No                                                                  |

A workspace from an earlier version gets the default (no goal). An unknown goal reads as no goal. Any other `guide` that is not version 1, whether written by a newer version (another `version`) or malformed (for example `null`, a string, a list or an object without `version`), is kept unchanged if it is at most 1 KB of JSON and an all-drafts backup can carry it unchanged (no deeper than the backup allows and no credential-named key such as `token` or `session`); it is treated as no goal until you choose again. One that is larger, or that a backup could not carry unchanged, is replaced by the default. Guided start adds no network request, telemetry or storage key of its own.
