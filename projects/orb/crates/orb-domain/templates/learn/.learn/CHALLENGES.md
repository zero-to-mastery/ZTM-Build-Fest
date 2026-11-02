# Challenges

Every challenge demands production and ends on a pass bar. The tutor grades against `source/`; the proving ground grades raids by measurement. Feedback is immediate and names the specific gap. Difficulty lives in the bar, never in withheld feedback.

## Quiet event protocol

Not a challenge and writes no record, but it is where units become readable for later attacks.

1. **Pretest.** Before the learner reads, ask three to five open questions the unit answers. Wrong guesses are the unit's learning targets; keep them in `NOTES.md` for the teach-back.
2. **Read.** The learner reads `source/<unit>.md` themselves. Wait.
3. **Dialogue.** Tutor voice, one move per turn, working through the unit's expectations. Start from the pretest misses.
4. **Teach-back.** The learner explains the unit from memory. List every expectation they missed against the source. The unit becomes `read` in `SYLLABUS.md` regardless; the miss list is the first target for a minor incident.

## recall (weight 1)

Free recall of one unit with the source closed. "Write everything you remember about X." No prompts during the attempt.

**Pass bar:** every core expectation of the unit present and correct. One missing expectation is a fail, and the record's Evidence lists exactly which.

## sceptic (weight 2)

The learner explains one concept; the tutor plays a senior engineer who does not buy it and attacks each vague word. "Faster how? Measured where? What would make that false?"

**Pass bar:** the learner defends the claim with mechanism, in their own words, through three rounds of attack without retreating to vocabulary. A retreat ("it's just more performant") is a fail.

## prediction (weight 2)

Show the learner an artefact from the proving ground before revealing its behaviour: a component and its trace, a bundle manifest, a query, a design sketch. They predict the outcome and the mechanism. Then reveal and compare.

**Pass bar:** the prediction matches on both outcome and mechanism. Right outcome with wrong mechanism is a fail.

## raid (weight 3)

The saboteur subagent plants a specific regression from the units in play into a fresh branch of the proving ground, or the storyteller picks an existing real problem there. The learner finds it and fixes it using the units' tools, with no hints. Pass or fail is measured.

**Pass bar:** the measurement moves in the direction the units predict, by an amount the learner stated before fixing, and the learner names which unit's idea did the work. The plant and its baseline live in `raids/R<n>.md`, written by the saboteur and read only after the learner declares a fix, so the fix is verified against a number you didn't know while coaching.

## design (weight 4)

A constrained scenario tied to the mission. "Ten million rows, reads dominate 50 to 1, must survive a region failure. Choose and defend." Then the tutor changes one constraint and attacks the design again.

**Pass bar:** the learner's decision survives the constraint flip, or they correctly identify what breaks and what they would change. Defending the original design after it has broken is a fail.

## transfer (weight 4)

Apply a unit's idea somewhere the source never went: the mission's domain is swapped for an unrelated one, or the idea is applied to a different layer of the stack. If the learner can only reproduce the source's own example, they do not own the idea.

**Pass bar:** a working mapping of the mechanism onto the new domain, with the one place the analogy breaks named by the learner.

## Varying a re-attack

Rule 1 of the storyteller repeats a failed challenge with refinement. Same kind, same unit, different surface: a new scenario for design, a new plant for a raid, a differently ordered expectation list for recall. The sub-skill named in the failed record's Next line is the thing the variation must exercise.
