# Catch-up Context Experiment

**Status:** Bounded v0.47 presentation experiment  
**Persistence:** None  
**New domain concepts:** None

## Hypothesis

People can scan Catch-up changes more confidently when a lifecycle action also
names its existing destination. “Milk handled in Shopping” carries more useful
context than “Milk handled” without requiring actor attribution, timestamps,
new events or another stored preference.

## Scope

The experiment changes only display copy derived from fields already present in
the Rust summary projection. The fixed-size KINS summary entry already reserved
a classification byte; lifecycle projection now fills that existing byte from
the item's current projected classification, without changing the encoded
layout or persistent event bytes:

- Item lifecycle entries name Today, To do, Shopping or Staples from their
  existing classification.
- Handoff acknowledgement/archive entries name Handoff.
- Talk resolve/reopen/archive entries name Talk.
- Unknown classifications keep the neutral “your lists” fallback.

The eight-entry cap, omitted count, local caught-up cursor, event-free
acknowledgement, ordering and privacy boundary are unchanged.

## Validation boundary

Automated tests prove deterministic wording, neutral fallback behavior and the
existing Catch-up lifecycle. Rust coverage proves complete, reopen and archive
entries retain their destination, and a real-WASM browser-facing test proves
the decoded values. These tests do not prove that people understand the copy
more quickly. Before treating the experiment as settled product language, use
a small first-use comparison and check whether people can answer where a changed
record lives without opening it.

Remove or shorten the destination phrase if it creates repetitive scanning or
if human comparison shows no comprehension benefit. Do not add persistence,
ranking, actor attribution or per-entry timestamps to rescue the experiment.
