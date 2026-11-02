# Storyteller

The storyteller picks the next event the way an AI storyteller paces a colony: it reads the colony's wealth, raises the threat scale on a steady curve, and alternates big events with quiet stretches so the learner rebuilds before the next hit. It never asks the learner what they want next.

## Wealth

Wealth is computed from `learning-records/` frontmatter, per unit, every session. Each record contributes its challenge's weight when `outcome: pass`, and zero when `outcome: fail`. A failing record also marks its unit **weak** until a later record on the same unit passes.

| Challenge | Weight |
| --- | --- |
| recall | 1 |
| sceptic | 2 |
| prediction | 2 |
| raid | 3 |
| design | 4 |
| transfer | 4 |

A unit is **owned** at weight 5 or more with no open weak mark. Colony wealth is the sum over units.

## Tiers

| Tier | Event | Draws on |
| --- | --- | --- |
| Quiet | Read a new unit: pretest, the learner reads, tutor dialogue, teach-back. | One unread unit. |
| Minor incident | One `recall`, `sceptic` or `prediction` challenge. Short. | One read unit, preferring the weakest. |
| Raid | One `raid` challenge on the proving ground. | Two or three read units at once. |
| Major threat | One `design` or `transfer` challenge with the tutor playing a hostile reviewer. | Owned units. |

## Cadence

Evaluate in order; the first rule that applies wins.

1. **A weak unit that failed in the last two events is re-attacked now,** with a varied challenge of the same kind. Deliberate practice repeats the failed move with refinement until it is clean. This rule outranks everything below.
2. **The event after a major threat is quiet.** Always.
3. **The event after a raid is quiet or a minor incident,** never another raid.
4. **No weak unit is left unraided.** With two or more read units and no raid in the last two events, raid, and include the weakest unit in the mix.
5. **A major threat fires when colony wealth is at least 12 and the last threat was four or more events ago.**
6. **A minor incident fires when the last two events were quiet.** Pick the oldest passed record's unit for the recall, so spacing emerges from cadence.
7. **Otherwise quiet:** the next unread unit in `SYLLABUS.md` order.

## Difficulty

Read from `MISSION.md`.

- **Losing is fun** (default): every challenge is pitched one step past the learner's demonstrated level. The weakest record is the first target. A pass requires the full bar in `.learn/CHALLENGES.md` with no partial credit. Rule 1 re-attacks up to three times before the storyteller backs off to a quiet event on that unit.
- **Strive to survive**: partial credit on raids is recorded as `outcome: fail` but with a half-weight note; rule 1 re-attacks once.
- **Community builder**: rules 4 and 5 fire only when the learner asks.

## Choosing the mix

Threat type follows what the colony owns. A raid or threat draws its units from passed records, so interleaving happens without the learner noticing. The weakest unit is always in the mix; the lowest-wealth room gets raided.

## Announcing

One line before the event: the tier, the units in play, and the pass bar. The learner can refuse with an override argument; a refused event is logged in `EVENTS.md` as `skipped`.
