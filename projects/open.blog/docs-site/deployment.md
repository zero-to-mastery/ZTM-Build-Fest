---
title: GitHub Pages Deployment
nav_order: 6
---

# GitHub Pages Deployment

This repository now includes a dedicated documentation deploy workflow at:

- `.github/workflows/docs-pages.yml`

## How it works

1. Builds Jekyll docs from `docs-site/`.
2. Uploads artifact to GitHub Pages.
3. Deploys to the repository's configured Pages site.

## Trigger conditions

- Pushes that modify `docs-site/**`.
- Manual dispatch from GitHub Actions.

## GitHub configuration

In repository settings:

1. Open **Settings → Pages**.
2. Set source to **GitHub Actions**.

## Local preview options

You can preview by using a local Jekyll environment, or by reviewing Markdown and navigation structure in pull requests before deploy.
