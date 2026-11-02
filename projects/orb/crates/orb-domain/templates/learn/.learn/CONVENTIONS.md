# Conventions

The file formats every thread in a Learn group reads and writes. The orchestrator (`AGENTS.md`) owns all of them; the saboteur writes only `raids/`.

## MISSION.md

```md
# Mission: {Topic}

## Why
{1-3 sentences. The concrete real-world goal. What changes in the learner's work when they have this skill? "To understand X" is not a why; push for the outcome.}

## Success looks like
- {A specific, observable thing the learner will be able to do}
- {Another}

## Difficulty
{Losing is fun | Strive to survive | Community builder. Default: Losing is fun. Read by STORYTELLER.md.}

## Proving ground
{The real repository, system or arena where raids happen. A path or a name. Every raid runs here.}

## Constraints
- {Time, budget, prior commitments, learning preferences}

## Out of scope
- {Adjacent topics the learner explicitly isn't chasing now}
```

- One mission per group. Two unrelated topics are two groups.
- Concrete over abstract: "cut INP on the checkout page below 200 ms" beats "get better at performance".
- If the learner can't say why, interview before writing anything. A bad mission is worse than none.
- When the goal moves, update this file and write a learning record for the shift. Confirm with the learner first.
- Keep it to one screen.

## SYLLABUS.md

Written by the ingest script, or by hand for a topic with no single source.

```md
# Syllabus: {Source or topic}

Status: `unread` | `read` | `weak` | `owned`.

| Unit | Title | Words | Status |
| --- | --- | --- | --- |
| `source/03-intro-to-initial-load-performance.md` | Intro to Initial Load Performance | 6118 | unread |
```

- `read`: the quiet event ran. `weak`: the latest record on the unit failed. `owned`: wealth 5 or more with no open weak mark (STORYTELLER).
- A hand-written syllabus leaves Words empty and names each unit by what the learner will be able to do.

## EVENTS.md

One row per thread, appended at thread start with outcome `open` and finished at thread end.

```md
| Date | Tier | Units | Outcome |
| --- | --- | --- | --- |
| 2026-10-05 | quiet | 03 | read |
| 2026-10-07 | incident:recall | 03 | fail |
| 2026-10-07 | raid | 03,05 | open |
```

Outcomes: `read` for a quiet event, `pass` or `fail` for a challenge, `skipped` when the learner refused the event, `open` while a thread is running.

## learning-records/NNNN-slug.md

A learning record is evidence that a challenge was attempted. It is the unit of wealth the storyteller reads, so the frontmatter is mandatory and exact.

```md
---
unit: 05-spas-and-introducing-inp
challenge: raid          # recall | sceptic | prediction | raid | design | transfer | prior
outcome: pass            # pass | fail
date: 2026-10-04
---

# {Short title: what was proven, or what was lost}

{1-3 sentences: what the learner did, and what it shows they can now do, or cannot yet do.}

## Evidence
{What the learner produced. For a raid: before and after measurements. For recall: the gap list. For design: the decision and the attack it survived or fell to.}

## Next
{Only on a fail: the specific sub-skill the storyteller re-attacks. One line.}
```

- One record per challenge attempted, pass or fail. A fail is content: it tells the storyteller where to aim.
- Coverage is never evidence. Reading a unit, or hearing it explained, writes nothing here.
- `challenge: prior` records knowledge the learner brought in ("I already use the Profiler daily"). Weight 1, and it counts as read, so the storyteller can raid it.
- Numbering continues from the highest existing file.
- A later pass on the same unit clears an earlier fail's weak mark. Leave old records as they are.

## RESOURCES.md

```md
# {Topic} Resources

## Knowledge
- Book: _{Title}_ by {Author} (local file, ingested into `source/`).
  The primary source. Use for: everything in `SYLLABUS.md`.
- [{Article or docs page}]({url})
  {One line: what it covers and when to reach for it.}

## Wisdom (Communities)
- [{Forum, chat or local group}]({url})
  {One line: what it's good for.}

## Gaps
- {An area the mission needs that no listed resource covers}
```

- High-trust only: primary sources, recognised experts, well-moderated communities.
- Annotate every entry. A bare link is useless in three months.
- Prune ruthlessly. Five sharp sources beat thirty mediocre ones.
- Record a learner's wish for no communities here, so later threads stop proposing them.

## GLOSSARY.md

```md
# {Topic} Glossary

## Terms
**{Term}**:
{One or two sentences defining what it is, not what it does.}
_Avoid_: {aliases the group retires}
```

- Add a term only once the learner has used it correctly. The glossary records compressed knowledge; it isn't a dictionary to learn from.
- Be opinionated: one word per concept, the rest listed as aliases to avoid.
- Use the glossary's own terms inside definitions.
- Revise in place as understanding deepens.

## raids/R<n>.md

Written by the saboteur (`.claude/agents/saboteur.md`), which holds the format. The orchestrator opens it only after the learner declares a fix.

## reference/*.html

One self-contained, printable HTML card per owned unit: the compressed essence, not the lesson. Syntax and snippets for code, a flowchart for a procedure, a glossary slice for nomenclature. Link the primary source section each item came from.
