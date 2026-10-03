# UX

**Status:** Current through v0.7.4 Routine Stale-Action Correctness; Today, Needs, Handoff, Talk, Pulse and Since You Last Looked are implemented locally. The catch-up summary is bounded and never attributes changes to people.

## Primary question

The main experience should answer:

> What does our household need to know right now?

The home view should make useful context scannable and keep capture close at hand. Avoid turning household communication into administration.

## Current home hierarchy

The implemented view presents Since You Last Looked first, followed by Today and Needs as separate sections with active and completed items grouped within each. The catch-up summary is bounded to eight entries and omits per-entry timestamps and actor attribution. Archived Items are omitted. Handoff follows with dedicated capture, needs-attention context, and recent acknowledged context; archived rows are hidden. Talk follows with one short topic field and Open/Resolved groups, newest additions first. Resolve/Reopen change workflow state; Archive hides the topic while retaining its history.

## Future home concepts

```text
KIN

Today
────────────────────
Pediatrician — 2:30 PM
Trash tonight

Needs
────────────────────
□ Buy milk
□ Restock wipes

Handoff
────────────────────
Benjamin ate at 12:15
Diaper bag needs wipes

From me
────────────────────
Need about 30 minutes to decompress tonight.
```

This is an example of possible content hierarchy, not a final visual design or implemented screen.

## Add something

Capture is short and forgiving. The current form accepts text and defaults classification to Needs; a native selector can place it in Today with one additional action:

```text
+ Add

What should we remember?

> buy milk

[ Needs ] [ Today ]
```

The target interaction is:

```text
tap
type a few words
tap
done
```

The two classifications are fixed. Do not add category management or require more metadata.

## Handoff

Handoff currently captures one short text entry and prioritizes unacknowledged context. Acknowledged entries stay in Recent until archived, newest additions first. There is no history browser or time-based expiry. The following earlier structured example is illustrative content only; it is not implemented categories or child records:

```text
Kid
✓ Ate
✓ Changed
! Need wipes

House
✓ Dishwasher running

FYI
Grandma called.
```

The receiver should be able to understand what matters without reconstructing a long message thread. Acknowledgement confirms receipt without claiming a named person saw it, agreement, approval, completion, or responsibility. The current form has one short text field, with no categories or structured child records.

## Talk

Talk is for capturing a topic that matters without forcing the conversation to happen immediately:

```text
Talk about:
Weekend plans
```

Talk uses one short topic field. Resolve, Reopen and Archive manage workflow only. No agreement, objective solution or partner confirmation is implied. Structured conversations, compromise/boundary forms, chat and counseling are excluded.

## Pulse

Pulse is a current, lightweight capacity signal. The fixed labels are:

```text
Good
Okay
Drained
Rough day
Need quiet
```

It is context, not a mood score, diagnosis, historical ranking, or prompt to infer intent. Choose a fixed value and 1, 4 or 8 hours, then Set pulse. Active context shows Until time, Change and Clear; expired shows “No current pulse.” No countdown, arbitrary text, acknowledgement or history.

## Since You Last Looked

The current summary shows up to eight meaningful Item, Handoff, and Talk changes since this browser installation's explicit local cursor. It reports an omitted-change count, excludes Pulse and has one explicit Caught up action. The cursor advances only through the frozen upper boundary represented by the rendered snapshot; opening Kin never advances it.

```text
Since 8:14 AM

Buy milk added to Needs
Electric bill handled
Weekend plans added to Talk
2 earlier changes

[ Caught up ]
```

Entries have no actor attribution or individual timestamps. This is a household-change summary, not a timeline, history browser, read receipt, or member-view tracker. Empty text is “You're caught up.” Marking the summary writes only local installation metadata.

## Interaction constraints

- Keep routine capture short; allow more detail only when useful.
- Make status and responsibility legible without scoring people.
- Design for small screens, interruptions, and one-handed use.
- Make accessibility part of implementation, not a later polish pass.
- Prefer calm, neutral language; do not imply fault when something is incomplete.
