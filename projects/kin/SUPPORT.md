# Support

Kin is a volunteer project built for the ZTM Build Fest. Questions and
reports are read, but there is no staffed support channel, support contract
or guaranteed response time. The current release is v1.6.0 — Kin for
Everyone (`kin-v1.6.0`, 2026-10-21).

## First, the docs

- Running it on your computer: [the README](README.md#run-kin-locally).
- Running it on a server: [SELF-HOSTING](docs/SELF-HOSTING.md), then
  [deploy/](deploy/README.md) for Docker Compose or
  [deploy/railway/](deploy/railway/README.md) for Railway.
- What a screen does: the Help button on every screen inside Kin, or
  [UX](docs/UX.md).
- Everything else: the [documentation map](docs/README.md).

## Where to ask

Kin lives inside the ZTM Build Fest repository, so use that repository's
issues and put `Kin:` at the start of the title.

| For | Use |
| --- | --- |
| A reproducible bug | The [bug report form](.github/ISSUE_TEMPLATE/bug_report.yml), or **Report a problem** inside Kin (also available from the lock screen) |
| Trouble running your own server | The [self-hosting form](.github/ISSUE_TEMPLATE/self_hosting.yml) |
| A proposal | The [feature proposal form](.github/ISSUE_TEMPLATE/feature_request.yml), or **Suggest something** inside Kin (household admins) |
| A security problem | [SECURITY](SECURITY.md). Never a public issue. |
| A conduct concern | [CODE_OF_CONDUCT](CODE_OF_CONDUCT.md) |

GitHub does not apply nested issue forms automatically; if the form does not
appear, copy its headings into a plain issue.

## What to include

The release or commit (the Report a problem preview inside Kin shows the
version), your operating
system and browser (or that it is the installed app), the smallest steps that
reproduce it, what you expected and what happened, and any error text with
household details removed. For a self-hosting problem, add how you run Kin
(Compose, Railway or Node directly), the `KIN_*` settings with secrets
removed, and the `service_ready` or `startup_failed` log line.

Never attach real household messages, names, passwords, passkeys, tokens,
recovery keys or browser-storage dumps. Reports from inside Kin already strip
household text; a screenshot is sent only if you choose one.
