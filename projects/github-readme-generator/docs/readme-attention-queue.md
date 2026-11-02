# README Attention Queue

Open **GitHub → README Attention Queue**, or switch to it inside **README audit**. Load public repositories, select them and audit their root READMEs. Documentation under another directory may still exist; inspect the audit evidence and repository when root documentation is missing. Only successful assessments can enter the queue; network failures are **not assessed**, not missing documentation. Include forks or archived repositories in the audit first if you want to review them.

## Descriptive priorities

This is a work queue, not a README quality score or developer ranking. Priority combines the current project-type assessment with repository activity:

| Priority         | Rule                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------- |
| High attention   | Non-archived, pushed within 30 days, and README is missing, stub or minimal               |
| Medium attention | Other repositories with thin documentation or undetected key project-type topics          |
| Low attention    | Archived, or last push more than 180 whole days ago, with documentation attention signals |

Unknown or future push dates do not imply activity. A repository without thin documentation or key topic gaps is omitted. A substantive short Experiment is therefore not nagged just because it lacks optional findings. Stars and forks cannot turn an archived project into High attention or change its documentation classification.

Every entry shows the README state, push/archive evidence and relevant gaps, such as **Game controls not detected. Commonly useful for this project type.** Missing signals are advisory: they are not universally required sections or proof that information is absent.

Key topic subsets of the existing type profiles are:

| Type                                      | Queue topics                                                |
| ----------------------------------------- | ----------------------------------------------------------- |
| Web App                                   | Overview, screenshot/demo, setup, configuration             |
| Library                                   | Overview, installation, usage, API, examples                |
| CLI                                       | Installation, commands, flags/options, examples             |
| API                                       | Setup, authentication, endpoints, sample requests/responses |
| npm Package / Rust Crate / Python Package | Overview, installation, usage, API                          |
| Game                                      | Overview, controls, setup, gameplay, build                  |
| PWA                                       | Overview, setup, offline behavior                           |
| Documentation                             | Overview, navigation                                        |
| Open Source Project                       | Overview, setup, usage, contributing                        |
| Tutorial                                  | Overview, prerequisites, learning steps                     |
| Experiment                                | Overview only                                               |
| Generic Repository                        | Overview, setup, usage                                      |

Within each tier, ordering is deterministic: active first, then missing/stub/minimal/basic/detailed/documentation-heavy state, then presence of public-interest signals (any stars, forks or homepage), then most recent push, then canonical repository name. Ten and ten thousand stars provide the same interest signal; these are not numeric quality points. Homepage presence does not prove a live demo works. Pinned/featured repositories and releases are not available from this audit's public repository listing and are not fetched or assumed.

## Filters and actions

Filters combine: High/Medium/Low, missing only, active only, archived exclude/include/only, language, project type, minimum stars and pushed within 30/90/180/365 days. The default queue excludes archived entries and hides deferred items. **Reset queue filters** restores those defaults. The queue renders 25 items per page and supports the audit's loaded repository set up to 1,000.

- **Improve next** opens the repository README builder for the first non-deferred candidate matching current filters. Each queue item also has **Improve README** for that same reviewed-template flow.
- **Open in Studio** opens that repository's exact source in a new local draft. A missing README starts blank. Opening is not a completion signal and does not write to GitHub.
- **Ignore for now** hides the item for seven days, or until a different known README revision is fetched.
- **Mark intentionally minimal** hides that README revision without an expiry. It requires a valid GitHub blob SHA or confirmed missing root README; unavailable revisions need another audit.
- Choose **Deferred items** or **All attention items** to review hidden candidates. **Return to queue** removes the decision explicitly.

Each item also has an [Improvement plan](repository-auditing.md#improvement-plans) disclosure with the evidence behind each Recommendation. The queue and plans read the same key topic subset from each project type.

- **Skip** in a plan never changes the queue.
- **Dismiss for this README revision** persists that decision on this device and removes the gap or finding from the item's reasons and eligibility check while the same README revision is current. If nothing else needs attention, the item leaves the queue and focus returns to the queue heading. The count line adds **· N recommendations dismissed**. A newly fetched README revision makes the dismissal stale; **Restore** in the plan (also available from Audit results) removes the saved dismissal explicitly.
- A missing, stub or minimal README cannot be dismissed, so High attention is never dropped silently. Use **Mark intentionally minimal** in the item or the plan instead.
- A dismissal applies only to the README revision it was made against. It survives reloads on this device; after a fresh audit observes a different README revision, the saved dismissal is shown as stale and no longer hides the Recommendation.

The type dropdown remains in **Audit results**. Changing it updates queue evidence from cached facts without another request.

## Changes, persistence and recovery

Decisions are local to this browser and scoped to canonical owner/repository names. They survive reloads and account switches. An unchanged README stays intentionally minimal even if the repository has another push, more stars, or a different suggested project type. A different README blob revision (or creation/deletion of the README) makes it eligible again if attention signals remain.

Changes can only be detected after fetching them. **Fetch fresh README content** rechecks completed audits; loading the repository list again refreshes activity metadata after the session cache expires. Queue order is recalculated on interaction/view refresh, not through background polling. Existing rate limits, five-minute cache behavior and partial failures still apply.

New decisions use the separate `readme-studio:audit-decisions:v1` storage key, capped at 5,000 repositories and 100 dismissals per repository. It contains only canonical repository identifiers, project type IDs, revision markers, finding identities, decision kinds and expiry times. While that key is absent, valid `readme-studio:attention:v1` preferences are converted in memory and copied into the new key on the first successful decision write; the legacy bytes are never changed or deleted. Decisions are not included in Studio project or all-drafts workspace exports. Clearing this browser's data removes them.

Malformed/future-version decisions, including malformed legacy attention data before migration, are left untouched and block new writes. Queue review and source opening still work. Download the named recovery data before explicitly starting fresh in the new key; legacy data and draft storage are unaffected. If a save fails, the queue says the decision was not applied and keeps the candidate visible. No successful persistence is claimed when browser storage is unavailable or full.

## Verification

Unit fixtures cover deterministic order, explanations, all filters, unknown activity, archived/high-interest repositories, appropriate experiments, 1,000 candidates, SHA/missing transitions, ignore expiry, account scoping, corruption, duplicate identities and write failures. Browser fixtures cover keyboard/mobile controls, source-preserving actions, persisted suppression across reload, changed README reappearance, type overrides, recovery and bounded pages. Network responses are synthetic.

See [repository audit hardening](audit-hardening.md) for conservative placeholder/history findings, optional link checks, retry policy and large-account limits.

In v1.2.0, Improve README / Improve next opens the [repository README builder](repository-builder.md) with an appropriate template and reviewed metadata. Open in Studio still preserves the exact original source.
