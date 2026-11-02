## Template rules (delete this section when writing)

The audience is engineers and product people, so use plain words and short sentences.

**The report is the premise ledger, told as a story.**

- Each chapter corrects one contradicted or partial premise.
- Order chapters by how much each correction changes the decision. The metric-definition premise usually goes first, because every later number depends on it.
- The chapter title is the correction: "The 25% that wasn't", "The long tail nobody can cache", "The refetch backfires".
- Evidence (decompositions, ceilings, simulations) goes inside the chapter whose premise it settles. There are no standalone method chapters.
- Premises that held get one line each in "What held up".
- Findings that don't correct a premise (e.g. "Meet the bots") go after the premise chapters.

**Numbers**

- Numbers go in tables, not paragraphs.
- Every number carries its window at least once per chapter, e.g. "(Aug 25 to Sep 23)".
- Every number has an evidence comment right after it: `<!-- E-code-3 -->`. It's invisible when rendered, and the audit checks it.
- Say what kind of number it is:
  - ceilings say "up to";
  - estimates say how they were estimated;
  - code-traced numbers say "from code, not measured".
- Never rank a ceiling against an estimate without saying so.

**Style**

- Bold the one sentence per chapter that a skimmer must not miss.
- End every chapter with a `> **Takeaway:**` line.
- Drop sections that don't apply. Don't pad.

---

# <Title: plain question or finding>

# <Correction 1: the premise that changes the decision most>
<!-- P# -->

Write this in four beats, as prose rather than labels:

1. **What was assumed.** State it the way it was originally claimed, and name its source (previous doc, dashboard, ticket, the ask itself).
2. **Why it doesn't hold.** Give the evidence, e.g. a decomposition table, a ceiling or a simulation. If a ceiling is load-bearing, show that two independent methods agree.
3. **What's actually true.** State it with numbers and windows.
4. **What this changes for the decision.** This is the takeaway.

> **Takeaway:**

# <Correction 2 …>

Repeat the four beats, one chapter per contradicted or partial premise.

# What held up

- **<premise>:** verified. One line of evidence. <!-- E-… -->

# <Findings that aren't premise corrections, e.g. "Meet the bots">

> **Takeaway:**

# What actually moves the needle

| Change | Saves per day (<window>) | Evidence | Effort |
|---|---|---|---|
| | **up to X** | ceiling | |
| | X (low to high) | estimate | |
| *For comparison: <the originally proposed plan>* | | | |

> **Takeaway:**

# Might be worth doing

For each item, explain why it's worth doing and why it isn't in the main list.

# If <another goal> is what we want

Optional. For example, speed instead of origin load.

# Decisions and tickets

| # | Decision | Who decides | Our recommendation | Impact per day |
|---|---|---|---|---|

# Open questions that could change a decision

Required when the round cap was hit. Otherwise, drop this section.

| Question | Plausible range | Decision it could flip | Cheapest way to settle |
|---|---|---|---|

# Found along the way

# Rejected / parked

- **<option>:** rejected or parked. Give the reason, with the number. <!-- E-… -->

# Appendix

### A. <Mechanism, e.g. a code trace of what one request does>

### B. <How the system and its metrics work>

Definitions, and vendor semantics marked as verified or not.

### C. Method

For each chapter: data, window, corrections, validation.

### D. Reproduce it yourself

Commands from `scripts/`, with the env vars they need and the UTC ↔ local conversion.

### E. Premise ledger (final)

| Premise | Type | Status | Chapter | Evidence |
|---|---|---|---|---|

### Caveats
