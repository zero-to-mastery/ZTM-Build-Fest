# Principles

These principles are constraints for product decisions, architecture, and future implementation.

## Kin coordinates. It does not judge.

Kin must not assign blame, decide who is right, score spouses, rank household contribution, or diagnose relationship problems. It should make coordination easier without presenting itself as an authority on a relationship.

## Privacy by default

Household information is personal. Minimize what is collected, exposed, retained, and shared. Prefer local processing and storage where practical, and make the consequences of future sharing understandable.

## Fast input wins

A simple household note should not require a complicated form. Prefer a short path from intent to capture and completion. Ask for additional structure only when it provides clear everyday value.

## Daily usefulness over novelty

A feature that looks impressive but is rarely used is lower priority than a small feature that reliably helps a household every day. Every feature should answer the tired-parent test: would someone holding a child actually use it?

## Family first

Features should reduce friction, not introduce competition. Household coordination is shared work, not a contest between members.

## No surveillance

Kin must not become a covert tracking or monitoring system. Do not infer or expose member activity in a way that turns ordinary household coordination into surveillance. Sharing and presence must be understandable and intentional.

## No gamified marriage

No spouse scores, leaderboards, streak pressure, chore points, or comparative contribution percentages. Kin must not use competitive mechanics to pressure household members.

## Native platform first

Prefer standard browser capabilities and Rust standard-library features before adding external dependencies. Dependencies are not inherently bad; they must solve a demonstrated problem worth their cost. See [Architecture](ARCHITECTURE.md).

## Explicit non-goals

Kin is not intended to be:

- Couples therapy or a relationship counselor
- A marriage score, relationship judge, or conflict-prevention guarantee
- A chore competition or contribution-measurement system
- A social network or public sharing platform
- A covert tracking or monitoring tool
- An enterprise task manager or generic calendar replacement
- An AI system that interprets household members or processes household content by default
