# Canonical Test Vectors

**Status:** Single protocol-24 baseline (refactor track, Slice 2). Kin has never shipped to real users, so protocols 1–23, the schema-1 `ITEM_ADDED` payload and their compatibility vectors were removed rather than migrated (owner decision D3). Release notes keep the historical evidence.

## Golden fixtures

`rust/fixtures/golden/*.kine` and `*.kins` are exact protocol-24 request and
projection bytes for five scenarios built through the command path: an empty
household, a household using every command kind, bound pre-sync history with
two devices diverging offline, an expired Pulse in a paused mode, and 400 bulk
Items. They pin canonical event encoding and projection encoding together.
Native Rust (`rust/src/golden_tests.rs`) and the release WASM
(`web/wasm/golden.test.mjs`) must both reproduce them byte for byte.
Regenerating them (`KIN_UPDATE_GOLDEN=1 cargo test golden`) is a deliberate
protocol change and needs its own justification.

Since Slice 6 the WASM test replays a fixture by appending the `.kine`
records to a fresh instance's history and projecting its context; the bytes
are unchanged. The `.kins` files hold a fresh engine instance's first projection, so every
section revision is 1; the WASM test instantiates a new module per fixture for
that reason. Refactor Slice 4 regenerated only the `.kins` files, when the
section table was added. Every `.kine` request stayed byte-identical, so
canonical event bytes did not change. Each new projection was checked to be
exactly the old header, a table of revision-1 entries, and the old body
regrouped into per-domain sections with no other byte changed.

## Common envelope values

IDs are 16-byte values shown as 32 lowercase hexadecimal characters. Unless a
vector overrides a field, events use:

```text
household_id   = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
actor_id       = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
device_id      = cccccccccccccccccccccccccccccccc
event schema   = 2 for ITEM_ADDED, 1 for every other kind
request        = protocol 24, local (zero target household), no bindings
```

Timestamps are signed UTC Unix milliseconds. `local_sequence` is IndexedDB
ordering metadata and is not encoded in any event. Unless a vector says
otherwise, events appear in input order with `local_sequence` and
`logical_time` starting at 1. The `ITEM_ADDED` payload is
`item_id[16] | classification:u8 | reserved[3]=0 | text_length:u32 | text`,
with classification 0 Today, 1 Need, 2 Shopping, 3 Staple. Requests carry an
explicit `as_of` and civil date; [ABI](ABI.md) has the complete layouts.

## Items

**001 — Add item.** `ITEM_ADDED` event `…01`, item `11111111111111111111111111111111`,
timestamp `1760000000000`, text `"Buy milk"`, classification Today. Expected:
one active Today item with that ID, text, creator `bb…` and creation time.

**002 — Multiple items.** Vector 001 plus a second `ITEM_ADDED` (event `…02`,
item `22…`, timestamp `1760000030000`, text `"Restock wipes"`, Need). Expected:
both items in add order.

**003 — Complete item.** Vector 001 then `ITEM_COMPLETED` (event `…02`, logical
time 2) for item `11…`. Expected: status completed.

**004 — Invalid reference.** A lone `ITEM_COMPLETED` for an unknown item.
Expected: status code 4, no projection.

**005 — Duplicate event ID.** Vector 001's exact bytes twice. Expected: one
item (exact duplicates are ignored). The same event ID with different bytes
fails with code 4 and never overwrites.

**006 — Replay determinism.** Replaying Vector 003 repeatedly yields
byte-identical projections. Replay never depends on ambient time, randomness,
map iteration order, the network or the DOM.

**007 — Repeated completion fact.** Vector 003 then a distinct second
`ITEM_COMPLETED`. Expected: replay succeeds and the item stays completed; the
history keeps both facts. (Rust's command validator refuses to create such a
redundant completion, but replay of one that exists is idempotent.)

**008 — Unsupported versions.** A request header with any version other than
24, an `ITEM_ADDED` with schema 1 or 3, or any other kind with schema 2.
Expected: status code 3, no partial result; stored bytes stay untouched.

**009 — Malformed payload.** An `ITEM_ADDED` whose declared text length (5)
exceeds the two text bytes present. Expected: status code 2.

**010 — Household mismatch.** Two local events from different households in
one request. Expected: status code 4; the whole stream is rejected.

**011 — Inert text.** Vector 001 with text `<script>alert("x")</script>`.
Expected: the exact string is preserved, and the browser renders it as text.

**012 — Lifecycle.** A Need item, then `ITEM_COMPLETED`, `ITEM_REOPENED` and
`ITEM_ARCHIVED`. Expected: archived, classification unchanged, all four events
retained.

**013 — Archived item mutation.** Vector 012 followed by any further Item
mutation. Expected: code 4, no partial projection.

**014 — Exact lifecycle payloads.** `ITEM_COMPLETED`, `ITEM_REOPENED` and
`ITEM_ARCHIVED` with payload lengths 0–17 except 16. Expected: code 2.

**015 — Maximum replay.** 10,000 `ITEM_ADDED` events with unique IDs and
alternating classifications. Expected: 10,000 ordered items, a projection below
64 MiB, byte-identical across repeated replays, natively and in WASM.

## Handoff, Talk and Pulse

**016 — Handoff.** Kind 5 adds an unacknowledged Handoff; kind 6 acknowledges
(repeating it is a no-op); kind 7 archives; any later mutation fails with
code 4. Acknowledgement actor and time stay in the source envelope.

**017 — Talk.** Kind 8 adds an open topic; 9 resolves (repeat is a no-op); 10
reopens; 11 archives. Unknown references and archived mutations fail with
code 4.

**018 — Pulse.** Actor A sets Drained at 1000 ms, expiring at 2000 ms. At
`as_of` 1999 it is active; at 2000 and 2001 expired; at 1000 active again
(explicit time, reversible). A later SET replaces A only; CLEAR twice succeeds;
actor B is independent. No expiry event exists.

## Since You Last Looked

**019 — Cursor boundary.** `ITEM_ADDED(1, "Milk")`, `ITEM_COMPLETED(2)`,
`PULSE_SET(3)`, cursor event 1. Expected: one `item-completed` entry (event 2,
text "Milk", no classification), total count 1, through event 3. Pulse has no
entry. A cursor that is not in the stream fails with code 4.

**020 — Entry cap.** Ten meaningful changes, then `PULSE_CLEARED(11)`, no
cursor. Expected: total 10, eight entries (events 3–10 in input order), through
event 11. No actor or timestamp appears in summary records.

## Distributed replay

**021 — Equal logical times.** Events with equal logical times reduce in
`(device_id, event_id)` order regardless of input order; the summary's through
event is the last event in input (arrival) order.

**022 — Identity bindings.** Pre-sync events under placeholder IDs replay as
the bound authenticated identity without changing their canonical bytes. A
placeholder tuple with no binding, a duplicate binding, a binding for another
household, or bindings on a local (zero-target) request fail with code 4.

**023 — Terminal archive.** An archive and a completion of the same Item at the
same logical time from different devices: the Item is archived in every input
order.

## Device names (v1.1)

These vectors are written out by hand in `rust/src/device_name_tests.rs`;
none comes from the production encoders.

**024 — Descriptions and nicknames.** Member 1 describes devices 0x12 and
0x11, member 2 describes 0x21. Device 0x11 nicknames itself "Kitchen phone",
then device 0x12 renames it "Mikey’s phone 📱"; 0x11 describes itself again
as "Chrome on iPhone 17"; member 2 sets and clears a nickname. Expected KDEV
order 0x11, 0x12, 0x21 with 0x11 keeping its newer automatic name and the
later nickname, and no nickname on 0x12 or 0x21.

**025 — Authority without poisoning.** After member 1 describes 0x11, member 2
nicknaming 0x11 or describing 0x11 replays and changes nothing. A history that
starts with member 1 nicknaming an undescribed 0x11 (a member who joined later)
replays with a nickname-only entry owned by member 1; a later description by
member 1 keeps the nickname, one by member 2 replaces the entry. Member 1 can
still rename it by command; member 2 cannot (code 4).

**026 — Canonical names.** An empty name, surrounding whitespace, a newline,
U+202E, U+200B, a leading U+FEFF, a 49-character automatic name and a
33-character nickname all fail decoding with code 2. Forty-eight four-byte
characters (192 bytes) decode; so does a nickname with a zero-width joiner
inside an emoji sequence. A zero target device, a short length field, invalid
UTF-8 and a missing nickname length fail with code 2.

**027 — Not projected.** Replaying an Item with and without a description and
nickname gives identical KINS bytes except the summary's through event ID.

**028 — KDEV layout.** Two devices encode as `"KDEV"`, version 1, reserved 0,
count 2, then for each the device ID, member ID, the two u16 lengths and the
names; the empty table is the 12-byte header with count 0. Held history with
an identity binding names the bound device and member.

## Item pictures and my things today (Simple view, #344)

These vectors are written out by hand in `rust/src/simple_tests.rs`.

**039 — Emoji payload.** Item 7 with "🧦", "👩‍🍳", "🇬🇧" and none round-trip;
the payload is the item ID, `01 00 00 00` and the emoji's u16 length and
bytes, or `00 00 00 00` when cleared. A non-zero reserved flag byte, a
trailing byte, text after a clear, a zero item ID, and "a", "🧦🧦", "" or "x🧦"
fail with code 2.

**040 — Set, change, clear.** Adding item 1 and setting "🪥" then "🦷" works;
the same emoji again, an unknown item and an archived item fail (code 4).
KIEM reports only the unarchived item: `"KIEM"`, `01 00`, `00 00`, count 1,
item 1, length 4, "🦷". An emoji event for an item the history lacks replays
and isn't reported.

**041 — My things today (20261003).** For the child: item 3 planned
20261001, item 1 planned 20261003, undated item 2, then routines "Bins out"
(open) and "Feed the fish" (done). Not listed: an item planned 20261010, a
completed, an archived and a Staple item, and other members' things. After
item 2 is unassigned and the mode is Vacation, only items 3 and 1 remain.
KMTD encodes an item as `01 00 00 00`, its ID and a zero date; KMTQ with
version 2 fails with code 3, a zero member or a short query with code 2.

## Store sections (#411)

These vectors are written out by hand in `rust/src/shopping_section_tests.rs`;
section and item IDs are `numbered_id(n)`. JavaScript mirrors 046, 047 and
050 in `web/wasm/kin-sections.test.mjs` and `abi-ownership.test.mjs`.

**046 — List payload.** Sections 1 "Produce" and 2 "Dairy" encode as
`02 00 00 00`, section 1, `07 00` "Produce", section 2, `05 00` "Dairy"; the
empty list is `00 00 00 00`. Thirty sections and a 40-byte name ("é" × 20)
encode. A non-zero reserved byte, a trailing or missing byte, a count that
disagrees with the entries, 31 sections, a repeated or zero ID, and the names
" Dairy", "Dairy ", "", " ", "a\u{7}b" or 41 × "x" fail with code 2. "Dairy"
and "dairy" together decode (a command rule, not a format rule).

**047 — Item payload.** Item 7 in section 2 is item 7's ID then section 2's
(32 bytes); cleared, the section is 16 zero bytes. 31 or 33 bytes, or a zero
item ID, fail with code 2.

**048 — List rules.** Setting the empty list on a new household fails (code 4,
no change); setting "Produce", "Dairy" works; the same list again, or a list
with "Dairy" and "DAIRY", fails with code 4; a repeated ID, " Produce ", a
41-byte name or 31 sections fail with code 2. Reordering and renaming are
changes; the empty list then clears it.

**049 — Item rules.** With Milk (item 1) and sections 1 "Produce" and 2
"Dairy": an unknown item, unknown section 5, or clearing a section that isn't
set fails (code 4); Milk in Dairy works, again fails. An archived item fails
whether set or cleared. When the list becomes just "Produce", Milk shows none;
clearing it, or setting Dairy, fails; setting Produce works. Replay keeps an
item section naming a section never listed, or an item it lacks, and shows
none; listing that section ID later shows the item in it. Of two lists made
from the same history, the later in replay order wins.

**050 — KSHS.** Items 1 Milk (Dairy), 2 Apples (Produce), 3 Batteries (none)
and 4 (Produce, then archived), with the list "Dairy" (section 2), "Produce"
(section 1): `"KSHS"`, `01 00`, `00 00`, count 2, section 2, `05 00` "Dairy",
section 1, `07 00` "Produce", item count 2, item 1 + section 2, item 2 +
section 1. An empty history is `"KSHS"`, `01 00 00 00` and two zero counts.

## Taking turns on routines (#429)

These vectors are written out by hand in `rust/src/rotation_tests.rs`; the
routine is `numbered_id(20)` ("Bins out", daily from 2026-10-03) and the
members Alex, Sam and Jo are 16 bytes of `01`, `02` and `03`. JavaScript
mirrors 051, 052 and 055 in `web/wasm/kin-rotations.test.mjs` and
`abi-ownership.test.mjs`.

**051 — Rotation payload.** Alex, Sam, Jo with Sam's turn is the routine ID,
`03 01 00 00`, then the three member IDs (68 bytes); ending is the routine ID
and `00 00 00 00`. Twelve members with index 11 decode. One member, thirteen,
a repeat, a zero member, index 2 of two, index 1 with no list, a zero
routine, a non-zero reserved byte, a trailing or missing byte, or a count
that disagrees with the members fail with code 2.

**052 — Turn payload.** The routine ID then Sam's (32 bytes). 31 or 33
bytes, a zero member or a zero routine fail with code 2.

**053 — Rotation rules.** Ending with no rotation, an unknown routine, or the
same rotation again fails (code 4); a repeat, one member or an index past the
list fails with code 2. Alex, Sam, Jo at index 1 makes Sam current, Jo next
and Sam the owner; reordering or moving the index is a change. While it
rotates, an owner change fails (code 4). Ending it leaves the last current
member (Alex) the owner, which can then change as usual. An archived routine
takes neither a rotation, an end nor a turn.

**054 — The turn passes when it's done.** Alex, Sam, Jo from Alex: completing
the 3rd makes Sam current; reopening the 3rd makes Alex current again.
Completing the 3rd, 4th and 5th comes back to Alex. Reopening the 4th (not
the one that passed it) changes nothing; reopening the 5th makes Jo current;
completing and reopening the 4th passes it to Alex and back. A day nobody
completes keeps Jo's turn. After a completion passes it to Alex, a turn set to
Jo and then reopening that occurrence keeps Jo. Two devices completing the
same occurrence move the turn once, in either arrival order. Of a turn to Jo
(device `33`), a completion (device `11`) and a new list Alex, Sam (device
`22`) at the same logical time, replay order gives Alex current with the turn
to Jo ignored; an owner change from a device that hadn't seen the rotation is
ignored.

**055 — KRRS.** Bins out rotating Sam, Alex, Jo at index 2, routine 22
rotating then archived, routine 23 rotating then ended, routine 21 never
rotating: `"KRRS"`, `01 00`, `00 00`, count 1, routine 20, `03 02 00 00`, Sam,
Alex, Jo. An empty history is `"KRRS"`, `01 00 00 00` and a zero count.
## The sitter page (#442)

These vectors are written out by hand in `rust/src/sitter_tests.rs`; record
IDs are `numbered_id(n)`, and the household has note 1 "Bedtime", reference
record 2 "Grandma" and routine 3 "Feed the cat". JavaScript mirrors 060, 063
and 064 in `web/wasm/kin-sitter.test.mjs` and `abi-ownership.test.mjs`.

**060 — Page payload.** Note 1, reference record 2 and routine 3 with the
intro "Bed by 8.\nThanks!" encode as `03 00 00 00`, then `01 00 00 00` +
note 1, `02 00 00 00` + record 2, `03 00 00 00` + routine 3, then `11 00` and
the intro (83 bytes). The empty page is six zero bytes. Thirty entries, a
500-byte intro ("é" × 250) and the same ID as a note and as a routine encode.
A non-zero reserved byte in the count or an entry, an entry kind 0, 4 or 255,
a trailing or missing byte, a count that disagrees with the entries, 31
entries, an entry twice, a zero ID, invalid UTF-8, and the intros " Hi",
"Hi ", "\nHi", "Hi\n", " ", "a\u{7}b", "a\r\nb", "a\tb" or 501 × "x" fail
with code 2.

**061 — Page rules.** Setting the empty page on a new household fails
(code 4, no change), as do an unknown note, reference record or routine 9,
and note 1 named as a routine. The full page with intro "Bed by 8." works;
the same page again fails (code 4); an entry twice, " Bed by 8." or 31
entries fail with code 2. Reordering, a new intro and dropping entries are
changes and replace the page whole. An archived note or reference record
can't be added (code 4); the empty page then clears it.

**062 — Replay.** With note 4 "Wi-Fi" and the page note 4, routine 3, note 1,
record 2: after note 1 and routine 3 are archived the page reads note 4,
record 2, and the event keeps all four. A page naming note 50, which the
history lacks, replays and skips it; once note 50 is created it shows, in
the page's order. Of two pages made from the same history, the later in
replay order wins.

**063 — KCMD.** Action 70 carries the payload as its text with zero entity,
date, option and expiry; a 30-entry page with a 500-byte intro fits; a
non-zero entity, date, option or expiry, an untrimmed intro or an empty text
fail.

**064 — KSIT.** With note 4 "Gone" archived after the page routine 3, note 4,
record 2, note 1 with intro "Hi": `"KSIT"`, `01 00`, `00 00`, count 3, then
`03 00 00 00` + routine 3, `02 00 00 00` + record 2, `01 00 00 00` + note 1,
then `02 00` "Hi". An empty history is `"KSIT"`, `01 00 00 00`, a zero count
and a zero intro length.

## The family album (#673)

Written out by hand in `rust/src/album_tests.rs`: household `aa` × 16, Sam
`01` × 16 and Alex `02` × 16, photo IDs `numbered_id(n)` and album
attachment IDs `a1 b0` followed by `n` as u32 little-endian and ten zero
bytes. Event `n` in a test household has timestamp 1,791,475,200,000 + 1000 +
n. The numbers start at 175 to stay clear of the other family-hub stories'
vectors. JavaScript mirrors 175 and 179 in `web/wasm/kin-album.test.mjs` and
`abi-ownership.test.mjs`.

**175 — Payloads.** Photo 1 with attachment 1 and the caption "Grandma's
80th" encodes as photo 1, `a1 b0 01 00 00 00` + ten zero bytes, `0e 00` and
the caption (48 bytes); with no caption it is 34 bytes. A 200-byte caption
("é" × 100) encodes. Kind 76 is the photo ID alone (16 bytes). The captions
" Hi", "Hi ", "\nHi", "a\nb", "a\tb", "a\u{7}b", " " and 201 × "x", a zero
photo ID, an attachment without the `a1 b0` prefix or the prefix followed by
zeros, a short or trailing byte, a missing caption length, invalid UTF-8, a
zero or 15- or 17-byte removal, and another kind fail with code 2.

**176 — Rules.** After Sam adds photo 1 (attachment 1, "Beach") and Alex
photo 2: photo 1 again (with attachment 3) or attachment 1 again (as photo 3)
fail with code 4, " x" with code 2, and removing photo 9 with code 4. Alex
removes photo 1; removing it again fails (code 4), so does adding photo 1
back, but photo 4 with attachment 1 and "Beach" works. The album is then
photo 2 (added by Alex at +1002) and photo 4 (Sam), and photo 1 is the one
recent removal (at +1003).

**177 — Limit.** 500 photos fit; the 501st fails with code 4 until one is
removed. Two adds made from the same 499-photo history both pass their
command checks, but together they fail replay with code 4.

**178 — Replay.** Two removals of photo 1 made from the same history replay
as one: the album is empty with one removal. A removal of a photo the
history never added fails replay (code 4). After 70 photos are each added
and removed, the removals kept are photos 7–70 (64). A zero actor or device
fails replay.

**179 — KCMD and KALB.** Actions 75 and 76 carry the payloads as their text
with zero entity, date, option and expiry; an untrimmed caption or an empty
removal fails. After Sam adds photo 1 ("Beach"), Alex photo 2 (no caption),
Sam photo 3 ("Zoo") and Alex removes photo 1: `"KALB"`, `01 00`, `00 00`,
photo count 2, removal count 1, then photo 3 (attachment 3, Sam, +1003,
`03 00` "Zoo"), photo 2 (attachment 2, Alex, +1002, `00 00`), then photo 1,
attachment 1 and +1004. An empty history is `"KALB"`, `01 00 00 00` and two
zero counts (16 bytes).
## The family calendar (#656)

These vectors are written out by hand in `rust/src/calendar_tests.rs`; event
IDs are `numbered_id(n)`, Alex is 16 bytes of `01` and Sam of `02`, and the
context's date is 2026-10-03. JavaScript mirrors 140, 141, 146 and 147 in
`web/wasm/kin-calendar.test.mjs` and `abi-ownership.test.mjs`;
`web/wasm/calendar-engine.test.mjs` runs them through the built engine.

**140 — Event payload (kind 71).** "Swimming", event 7, Tuesdays and
Thursdays 17:30–18:15 in Europe/London from 2026-10-06, ten times, Alex and
Sam, place "Leisure centre", notes "Bring goggles.\nTowels at the desk.",
source UID "swim-1@example.com": event 7, `04 02 00 00`, start date, `1a 04`
(1050), `47 04` (1095), end date, rule `02 00 0a 00 01 00 0a 00` and eight
zero bytes, 24 zero bytes, Alex, Sam, then the five texts. An all-day
countdown linked to series 9 has flags `0b`, zero minutes and the series ID
and original date at 48. The largest event (200-byte title, 200-byte place,
2,000-byte notes, 16 attendees, a 64-byte zone, a 255-byte UID, 366 days)
encodes. Code 2: a zero ID; titles "", " Swim", "Swim ", "a\tb", "a\nb" or
201 bytes; a 201-byte or untrimmed place; 2,001-byte notes or "a\r\nb",
"a \nb", "\na", "a\u{7}"; attendees out of order, twice, zero or 17; a
256-byte or untrimmed UID; the zones "Europe//London", "/Europe",
"Europe/", "Europe London", "Zürich" or 65 bytes; an end before the start;
367 days; a weekly rule with no or an eighth weekday; interval 0 or 1,001;
weekdays on a daily rule; a monthly rule without a day, or day 0, 32 or -2,
or the 6th weekday; weekday 7; count 0 or 1,001; until before the start; an
event linked to itself. Decoding also fails on an unknown flag, a reserved
byte, an attendee count that disagrees, frequency 5, by 3, a rule's reserved
byte, series bytes without the flag, minutes on an all-day event, rule bytes
without the flag, a trailing or missing byte, both a count and an until, and
invalid UTF-8.

**141 — Cancel, restore and colour (kinds 72–74).** Cancelling Thursday
2026-10-08 17:30 of event 7 is event 7, `01 00 00 00`, the date, `1a 04`,
`00 00` (28 bytes); the same bytes as kind 73 restore it; the whole series is
event 7, `02` and eleven zero bytes. Colour 11 is `0b 00 00 00`; `ff 00 00
00` is back to the default. Code 2: 27 or 29 bytes, scope 0 or 3, a reserved
byte, minute 1,440, 2026-02-30, a date on the series, a zero event, colour
12 or 254, a reserved colour byte, three bytes, and kind 75.

**142 — Command rules (code 4).** Saving the same event again; cancelling
Wednesday 10-07, 10-08 at 17:31 or 11-10 (past the tenth); cancelling an
unknown event; cancelling an occurrence twice; restoring a series that isn't
cancelled or an occurrence twice; linking to a date that isn't an
occurrence, to an event that doesn't repeat, or to an unknown series;
cancelling a cancelled series, or an occurrence of it; editing a cancelled
series or an event linked to one; clearing a colour never set or setting
the same colour. A linked event (late swimming, 10-08 18:30) is hidden while
its series is cancelled and back when it is restored. Alex and Sam may both
choose colour 3; each sets only their own. Attendees need not be known
members. Past 2,000 events a 2,001st replays as a no-op and is refused as a
command, while an existing event can still be edited.

**143 — Repeats.** Every 3 days from 2024-02-27, five times: 02-27, 03-01,
03-04, 03-07, 03-10. Mon/Wed/Fri from Tuesday 2026-10-06 until 10-14: 10-06,
10-07, 10-09, 10-12, 10-14. Every other week on Sunday and Monday from
Sunday 2026-10-04, six times: with WKST Sunday 10-04, 10-05, 10-18, 10-19,
11-01, 11-02; with Monday 10-04, 10-12, 10-18, 10-26, 11-01, 11-09. Monthly
on the 31st from 2026-01-31: 01-31, 03-31, 05-31, 07-31, 08-31. The last day
from 2024-01-31: 01-31, 02-29, 03-31, 04-30. The second Tuesday from
2026-10-13: 10-13, 11-10, 12-08. The last Friday from 2026-10-30: 10-30,
11-27, 12-25, 2027-01-29. The fifth Monday from 2026-11-30 to 2027-06-30:
11-30, 03-29, 05-31. February 29 yearly: 2024, 2028, 2032. The fourth
Thursday of November: 2026-11-26, 2027-11-25, 2028-11-23, 2029-11-22. The
15th monthly from 2026-10-07, three times: 10-07, 10-15, 11-15 (the start
counts). Every 7 days from 1990-01-01 read 2026-10-01 to 10-14: 10-05,
10-12. Monthly from 9999-12-01 stops at the end of the calendar. Weekly
rules agree with a day-by-day reading for three starts, four weekday sets,
intervals 1–3 and both week starts, in any window.

**144 — Local time across daylight saving.** Church, Sundays 09:00 in
Europe/London from 2026-10-18, read 2026-10-24 to 2027-04-04: 24
occurrences, all at minute 540, including 10-25 and 2027-03-28. A night
shift 23:30–01:00 in America/New_York from 10-31, three times: ends 11-01,
11-02, 11-03 at 01:00. 11-01 alone shows two shifts; a film ending exactly
at midnight doesn't show the next day.

**145 — Replay.** Of two saves of event 7 made from the same history, the
later in replay order wins. A cancel of event 40's 10-12 occurrence that
arrives before event 40 (weekly Mondays from 10-05) applies once it arrives:
10-05 and 10-19 show, and with cancelled ones 10-12 too, marked.

**146 — KCMD.** Actions 71–74 carry the payload as their text with zero
entity, date, option and expiry; the largest event fits; a non-zero entity,
date, option or expiry, an empty payload or colour 12 fail.

**147 — KCAL.** Bins (event 1, all-day Mondays from 10-05; 10-12 cancelled),
Dentist (event 2, 10-06 10:00–10:30 Europe/London, Sam), Trip (event 3,
all-day countdown 12-24 to 12-27), Alex's colour 2, item 50 "Pay rent" on
10-07 and dinner "Tacos" on 10-06, read 10-05 to 10-11: `"KCAL"`, `01 00
00 00`, the two dates, 2026-10-03, flags `10 00 00 00`, counts 1, 3, 2, 1, 0,
1; the countdown (event index 2, 12-24, flags `03`, 12-27); Alex and `02 00
00 00`; the three events in ID order (Bins with one cancelled start, 10-12);
occurrences Bins 10-05 (flags `01`) and Dentist 10-06 10:00–10:30; the item
(classification 0, no owner); the dinner (slot 4, no recipe or cook,
"Tacos"). Read 10-12 alone with flags 3: three events, one occurrence. An
empty history is the 48-byte header with zero counts and flags and 20 zero
bytes.

**148 — Bounds.** A query backwards, over 400 days, with flag 4 or on
2026-02-30 fails (code 2); 400 days works; version 2 is code 3. Twenty
daily events over 400 days keep the earliest 5,000 occurrences (through
2026-09-07), sorted, and KCAL sets flag bit 0. A weekly routine created
2026-10-03 opens on 10-03 (current), 10-05, 10-12 and 10-19; a yearly
countdown on March 1 is next on 2027-03-01, and cancelling that one leaves
none within 400 days of 2026-10-03.

## iCalendar import (#666)

These vectors are in `rust/src/ical_tests.rs`, which holds three realistic
exports written for Kin (Google, Apple and Outlook shaped).
`web/wasm/kin-calendar.test.mjs` mirrors 155 and
`web/wasm/calendar-engine.test.mjs` imports a file end to end.

**150 — Google.** CRLF, a folded DESCRIPTION, a VTIMEZONE and a VALARM (whose
DESCRIPTION is not the event's): Swimming, Tue/Thu 17:30–18:15
Europe/London, WKST Sunday, ten times, EXDATE 10-13, place "Leisure Centre,
High Street"; an override moving 10-15 to 18:30 (series 0, original 10-15
17:30); a cancelled override on 10-20 that becomes an EXDATE; an all-day trip
12-24 with DTEND 12-28 (exclusive: last day 12-27); a yearly birthday (March
1); a call in UTC. Five events, nothing skipped, name "Family".

**151 — Apple.** LF only, Apple's own properties (a quoted parameter with a
colon): Piano lesson, first Monday monthly in America/New_York; Thanksgiving,
yearly fourth Thursday of November; Park run, floating 07:00 for 45 minutes
(not flagged); Brunch with a Mozilla-style TZID read as Europe/Paris.

**152 — Outlook.** Quoted Windows zone names: School board,
"Eastern Standard Time" (America/New_York), monthly BYDAY=TU;BYSETPOS=2 six
times, EXDATE 11-10; "Customized Time Zone" is floating and flagged;
School run in "W. Europe Standard Time" (Europe/Berlin) on weekdays until
2026-10-30; a "(UTC-08:00) Pacific Time (US & Canada)" display name.

**153 — Rule mapping.** From Tuesday 2026-10-13: DAILY;INTERVAL=2;UNTIL;
DAILY;BYDAY=MO,WE (weekly); WEEKLY (the start's weekday); MONTHLY;
BYMONTHDAY=-1; MONTHLY (the 13th); lower-case `byday=-1fr`; YEARLY in
October on the 13th; an UNTIL before the start (the start). Unsupported and
imported as the first occurrence, flagged: HOURLY, an ordinal on WEEKLY,
DAILY;INTERVAL=2;BYDAY, two month days, two weekdays monthly, a 6th
weekday, YEARLY in another month, BYYEARDAY, BYHOUR, COUNT 0 or 1,001, COUNT
with UNTIL, INTERVAL 0, a repeated part, a bad WKST, no FREQ, an X- part,
"FREQ" and "". Zones: IANA names (quoted, inside a path), UTC/GMT, Etc/GMT+12,
Windows names in any case, an Outlook display name; "Customized Time Zone",
"Mars/Olympus" and "" are not understood.

**154 — Malformed input.** Every truncation and 2,000 random byte changes of
each sample, and random bytes up to 20,000, parse without failing, and every
event they give is a valid kind-71 payload. An unterminated event counts;
events without a usable DTSTART are skipped; an event nested 40 deep is
skipped; lines without a colon, an unclosed quote and stray END lines are
ignored; escapes `\\`, `\;`, `\,`, `\N` and a lone `\`; invalid UTF-8 becomes
U+FFFD; a BOM is skipped; long text is shortened at a character boundary
(flagged); a two-year all-day event becomes 366 days (flagged, and untitled);
a negative DURATION is zero; a repeated UID is skipped; an override without
its series stands alone; EXDATEs that name no occurrence are dropped.
More than 2 MB is code 5; 5,001 events give 5,000, flagged, one skipped.

**155 — KICS.** "Kids", Bins (all-day Mondays from 10-05, EXDATE 10-12) and
an override moving 10-19 to 10-20: `"KICS"`, `01 00 00 00`, count 2, 0
skipped, flags 0, `04 00` "Kids"; Bins: flags 0, series `ff ff ff ff`, eight
zero bytes, one EXDATE, payload length, 10-12 with minute 0, the payload
(zero ID); the override: flags `08`, series 0, original 10-19 minute 0, no
EXDATE, the payload. A payload given an ID decodes as kind 71; with a zero
ID it doesn't. A file with nothing in it is the 22-byte header.
## Fuller meal plans (#679)

These vectors are written out by hand in `rust/src/meals_tests.rs`
(`meal_plan_test_vectors` and the tests beside it); recipe IDs are
`numbered_id(n)` and 2026-10-05 is `8d 28 35 01`. JavaScript mirrors 180–182,
184 and 185 in `web/wasm/kin-meals.test.mjs`, and the engine round trip in
`meals-engine.test.mjs`. Numbered from 180 to stay clear of the other
family-hub kinds.

**180 — Meal payload (kind 80).** Lunch on 2026-10-05, one-off "Soup": the
date, `02 00 00 00`, `00 00 00 00`, `04 00` "Soup" (18 bytes). Breakfast from
recipe 7 "Porridge": the date, `01 00 00 00`, `01 00 00 00` + recipe 7, `08 00`
"Porridge". Slot 3 (dinner), 0 or 5, a non-zero reserved byte, a trailing
byte, " Soup" and a zero recipe fail with code 2.

**181 — Meal cleared (kind 81).** The snack on 2026-10-05: the date and
`04 00 00 00` (8 bytes). Slots 0, 3 and 5 and `01 00 01 00` fail with code 2.

**182 — Favourite (kind 82).** Recipe 7 then `01 00 00 00` (on) or
`00 00 00 00` (off), 20 bytes. A flag of 2, a trailing byte or a zero recipe
fail with code 2.

**183 — Rules.** Breakfast from recipe 1 "Porridge", lunch "Leftovers" and
dinner "Curry" on 2026-10-05: the same breakfast again, a recipe under an old
name, an unknown recipe and clearing an empty snack fail (code 4); clearing
lunch leaves breakfast and dinner, and clearing dinner (kind 62) leaves
breakfast. Once recipe 1 is archived it can't be planned or unfavourited, and
the planned breakfast keeps reading "Porridge". A favourite twice, an
unfavourite of a recipe that isn't one and a favourite of an unknown recipe
fail (code 4). Replay ignores a favourite or a snack naming recipe 9, which
the history lacks. Two lunches for one date from the same history converge
on the later in replay order.

**184 — KMLS v2.** Recipe 7 "Oats" (a favourite, no ingredients, no notes)
and a breakfast of it on 2026-10-05: `"KMLS"`, `02 00`, `00 00`, recipe count
1, meal count 1; recipe 7, `04 00` "Oats", `00 01 00 00`, `00 00`; then
`8d 28 35 01`, `01 01 00 00`, recipe 7, 16 zero bytes, `04 00` "Oats". An empty
history is `"KMLS"`, `02 00 00 00` and two zero counts. KMLS v1 of the same
history lists no meals, since it has no dinner.

**185 — KMPQ v2.** Lunch on 2026-10-05 is `"KMPQ"`, `02 00`, `00 00`, `03 02
00 00`, 16 zero bytes, the date; the week from 2026-10-05 is the same with
`04 00 00 00`; a dinner query stays v1 (`01 00 … 02 00 00 00`). Over
breakfasts of Porridge (Oats, Milk linked to a Staple) on 5 and 6 October,
lunch of Sandwiches (Bread, Cheese) on the 5th, dinner of Mac and cheese
(cheese, Pasta) on the 7th, a one-off snack on the 8th and a snack on the
12th, with Bread on Shopping, the week plans Oats (add), Milk (re-add
staple), Bread (already), Cheese (add, once), Pasta (add). An empty week is
`"KMSP"`, `01 00 00 00` and a zero count. A v1 query for the week or with a
slot, a v2 week with a slot, slot 0 or 5 for source 3, or a week from
9999-12-30 fail with code 2; version 3 fails with code 3; a lunch nobody
planned fails with code 4.

## The chore chart (#676)

Written out by hand in `rust/src/chore_tests.rs`: members `01` × 16 (a
parent), `02` × 16 (Mia), `03` × 16 (Leo); routines and items are
`numbered_id(n)` (30 "Feed the cat", 31 "Bins out", daily from Monday
2026-09-28). The test week's day boundaries are UTC midnights.
`web/wasm/kin-chores.test.mjs` mirrors 085 and 089.

**085 — Payloads.** Points 3 for routine 30: routine 30, `03 00 00 00`.
Mia's reward of 20 for "Movie night": Mia, `14 00`, `00 00`, `0b 00`,
"Movie night"; clearing it: Mia and six zero bytes. A parent joining: the
parent, `01 00 00 00`. Points 11, a zero routine or member, goal 0 with
text, goal 20 with no text, an untrimmed text, goal 1001, 121 bytes of text,
a line break, a non-zero reserved byte, joined 2, a short or long payload
and code 80 fail with code 2. Goal 1000 with "é" × 60 (120 bytes) encodes.

**086 — Settings.** Points 1 on a routine that was never set, points for an
unknown or archived routine, an unchanged value, and clearing a reward that
isn't set fail with code 4. Points 3, then 0, then back to 1 (stored as no
setting); a reward 20 then 25 "Movie night", then cleared.

**087 — Joining.** Joining for another member, leaving before joining and
joining twice fail with code 4, as does one member leaving for another. A
kind-79 event authored by someone other than the member it names replays
with no effect. The member who joined can leave.

**088 — Credit.** Routine 30 is Mia's; Bins out (worth 3) rotates Mia, Leo.
A parent ticks both on Monday: Mia 4 points, Leo 0, and Bins passes to Leo.
Mia's device ticks Bins on Tuesday: Leo 3. Reopening it takes the 3 back and
gives the turn back; ticking again gives them again. Items credit the
item's owner when they are completed, and keep that credit if the item is
reassigned. A completion at Sunday's last instant counts for that week, one
at the next Monday's first instant for the next; with boundaries two hours
earlier, the Sunday one belongs to the next week. Adults are on the chart
only when the query allows adults and they joined. While the mode is
Vacation only done occurrences show.

**089 — KCCQ and KCCD.** Mia owns routine 30 worth 2, with reward 10 "Ice
cream", done on Monday. The query for Monday's week with Mia (child) and
the parent (Adult, not joined), on Tuesday: `"KCCD"`, `01 00 00 00`,
20260928, 20260929, `00 00 00 00`, `01 00`, `01 00`; routine 30, `02 00 00
00`; Mia, `02 00`, points `02 00`, goal `0a 00`, count `07 00`, `09 00`
"Ice cream"; then seven routine-30 chores (`02`, flags, `02 00`, routine
30, date, key = date) for Monday (flags 1, done) to Sunday, Tuesday's flags
2 (today). A query whose start isn't a Monday, whose week doesn't hold the
context's date, with an unknown flag, an empty day or one over 25 hours, a
member twice, a zero member, kind 3 or 33 members fails with code 2;
version 2 is unsupported.

## A member's private log (#489)

Written out by hand in `rust/src/private_tests.rs`: household `aa` × 16,
member Sam `01` × 16 on device `11` × 16, event IDs `numbered_id(n)`, the
timestamp 1,791,475,200,000 + n. `web/wasm/kin-private.test.mjs` mirrors 067.

**065 — Private note (kind 100).** Event 1, logical time 1, note `5a` × 16
with text "Call Mum": header `01 00` `64 00`, then the IDs, timestamp and
logical time, payload length `1c 00 00 00` (20 + 8), then `5a` × 16,
`08 00 00 00` and "Call Mum" (116 bytes in all). It decodes to
`PRIVATE_NOTE_SET` and re-encodes byte for byte. A zero note ID, a length
that doesn't cover the text exactly, a payload under 20 bytes, a tab, invalid
UTF-8 or 2,049 bytes fail with code 2; a line feed, 2,048 bytes and empty
text (removal) decode. Kinds 101, 150 and 199 fail with code 3.

**066 — Logs.** The household, chat and board logs and a KINE request refuse
the note with code 4; the private log refuses an item record with code 4 and
holds at most 50,000 records (the next append fails with code 5). Two
members' notes in one private log fail replay with code 4.

**067 — KPRV.** An empty log is `"KPRV"`, `01 00 00 00`, 16 zero bytes,
count 0, `01 00 00 00` (one section), `01 00 00 00` (section 1) and length
`04 00 00 00`, then a zero note count: 44 bytes. After note 2 "two" (event 1)
and note 1 "one" (event 2), the member is `01` × 16, the count 2, and the
notes section lists note 1 (logical time 2, device `11` × 16, "one") before
note 2. A later note for the same ID replaces it and empty text removes it,
the latest in replay order winning. Sections 12 and 13 (#520) appear only
once the member has a reminder or a setting, so an empty log stays 44 bytes.

## Reminders and settings that follow a member (#520)

Written out by hand in `rust/src/private_prefs_tests.rs`, with the household,
member Sam and event IDs of 065–067; the phone is `11` × 16 and the laptop
`12` × 16. The instant is 2026-10-20 13:00 UTC, 9:00 in New York:
1,792,501,200,000 ms. `web/wasm/kin-prefs.test.mjs` encodes the same
payloads and reads both sections.

**100 — Reminder set (kind 120).** Event 1, logical time 1, item `5a` × 16:
header `01 00` `78 00`, payload length `30 00 00 00` (32 + 16), then `01 00
00 00`, `5a` × 16, the instant (i64 LE), `10 ff` (−240 minutes), `10 00` (16
bytes of zone) and "America/New_York": 136 bytes in all. It decodes to
`REMINDER_SET` and re-encodes byte for byte. A target kind of 0 or 3, a zero
target ID, a non-zero reserved byte, trailing bytes, an instant beyond the
valid range, an offset of −721 or 841, a zone with a space or of 65 bytes
fail with code 2; offsets −720 and 840, a 64-byte zone and an empty zone
decode.

**101 — Reminder cleared (kind 121).** Event 2, item `5a` × 16, reason 3
(dismissed), the same instant: header kind `79 00`, payload `01 03 00 00`,
`5a` × 16, the instant: 116 bytes. Reasons 0 and 4, a 29-byte payload and a
non-zero reserved byte fail with code 2. Replay: "canceled" removes the
item's reminder whatever its instant; "done" and "dismissed" remove it only
while it is set for the instant they name.

**102 — Setting set (kind 130).** Event 3, key 1 (`theme-mode`) "dark":
header kind `82 00`, payload `01 00 04 00` "dark". Key 0 or 256, "Dark",
"sepia" for key 1, a five- or non-hex color, "huge" for key 3 and a 33-byte
value fail with code 2; every listed value of keys 1–7, any token for key 99
and an empty value decode. Codes 122, 129, 131 and 139 fail with code 3.
Replay is last writer wins per key: at equal logical times the laptop
(`12` × 16) wins over the phone (`11` × 16) in every arrival order; an older
logical time never overrides a newer one; empty unsets.

**103 — Convergence and clocks.** Eight records (sets, a move, a stale
dismissal, a canceled routine and settings from both devices) give the same
KPRV in every rotation and reversal of their arrival order. Timestamps a
day fast or an hour slow change nothing: logical time decides.

**104 — Commands.** `kin_private_execute` with KCMD action 120 and the 100
payload returns KCMT whose event is the 100 record and whose projection
length is 0. Then, with code 4: the same set again; a dismissal for another
instant; a clear for a thing with no reminder; a logical time not after the
log's latest; an event ID the log holds; another member; a setting to its
current value; unsetting a key that isn't set. Against the household log the
command fails with code 4; an item action (1) fails with code 3 and a
non-zero entity ID with code 2.

**105 — KPRV sections 12 and 13.** A routine reminder (event 1, Paris,
offset 60) and the item reminder (event 2 from the laptop), then
`text-size` "large" (event 3) and `theme-mode` "dark" (event 4): three
sections; section 12 is `0c 00 00 00` and 4 + 72 + 68 bytes listing the item
(kind 1) before the routine (kind 2), each with its instant, offset, zone
length, logical time, device and zone; section 13 lists key 1 ("dark",
logical time 4, the phone) before key 3 ("large").

**068 — Journal entry (kind 101, #498).** Written out by hand in
`rust/src/journal_tests.rs` and mirrored by `web/wasm/kin-private.test.mjs`:
event 1, logical time 1, entry `5a` × 16 on 2026-10-03 titled "Park", body
"Swings.\nThen cocoa.", one JPEG photo of sealed size 52,000 whose four
32-byte fields are `21`, `22`, `23` and `24` repeated. Header `01 00` `65 00`,
payload length `bb 00 00 00` (187 = 28 + 4 + 19 + 136); the payload is the
entry ID, then `8b 28 35 01` (20261003), `04 00` (title), `01` (one photo),
`00`, `13 00 00 00` (body), "Park", the body, then `01 00 00 00`,
`20 cb 00 00` and the four fields. It decodes to `JOURNAL_ENTRY_CREATED` and
re-encodes byte for byte; kinds 102–104 likewise (103 and 104 are the 16-byte
ID alone). Code 2: a zero ID, a non-zero reserved byte, a length that doesn't
cover the parts exactly, an impossible date, no title, body or photo, a
201-byte title, a title with surrounding white space, a line break or a tab,
a body with a tab or a carriage return or trailing white space, 20,001 body
bytes, invalid UTF-8, eleven photos, photo type 0 or 4, a sealed size of 28
or above 4 MiB + 4 KiB, a non-zero photo reserved byte, a zero key, or one
reference named twice. Kinds 105 and 109 fail with code 3.

**069 — Journal replay, KPRV section 101 and commands.** KPRV has no
section 101 until the member writes an entry (a deleted one keeps it). The first creation
of an ID wins; an edit replaces the content, a delete hides the entry, a
restore shows it again; events for an unknown entry are ignored; another
member's event in the log fails replay with code 4. Section 101 lists live
entries by date descending, then later-created first. `kin_private_execute`
returns KCMT whose event equals the hand-written record; it refuses with code
4 a used entry ID, an unchanged edit, an edit, delete or restore of the wrong
entry, a logical time not after the log's, a reused event ID, another member,
another household or a non-private log, and with code 3 a household kind
or kind 105; 10,001 live entries or more than 32 MiB of live
text fail with code 5.

### Just for me (#510)

Numbered 090–094, apart from the journal's vectors added alongside. Written
out by hand in `rust/src/private_item_tests.rs` with the same household,
member, device, IDs and timestamps as 065–067; `web/wasm/kin-private.test.mjs`
mirrors 092 and 093.

**090 — Private item added (kind 110).** Event 1, logical time 1, item
`5b` × 16, date 20261005, text "Dentist": header `01 00` `6e 00`, payload
length `1f 00 00 00` (16 + 4 + 4 + 7), then `5b` × 16, the date
`8d 28 35 01`, `07 00 00 00` and "Dentist" (119 bytes in all). It decodes to
`PRIVATE_ITEM_ADDED` and re-encodes byte for byte, as does every kind
110–118. A zero ID, an invalid date (20261332), empty text, a line feed or
other control character in the text, invalid UTF-8, 4,097 bytes of text,
trailing bytes, a tab in a note or a 2,049-byte note, a setting byte other
than 0 or 1 or a non-zero reserved byte fail with code 2; 4,096 bytes of
text, a note with line feeds and an empty note decode. Kind 119 fails with
code 3. Every other log and a KINE request refuse kind 110 with code 4.

**091 — Replay.** Items 1 (undated) and 2 (dated 20261010) are added; item 1
is edited and dated 20261003; item 2 is completed, reopened and completed,
and gets the note "A book"; a second add of item 1, a completion of unknown
item 9, and item 3 added then deleted twice follow. Expected: two live items;
item 1 "Call the dentist (Tue)" dated 20261003, open, changed at logical
time 4 (the second add changed nothing); item 2 done with its note; item 3 a
tombstone. Restoring item 3 brings it back as it was; the setting set off
reads off. With 2,000 live items, a further add is ignored, and after one
delete an add and a restore compete for the place: the earlier in replay
order wins. Two members' items in one log fail replay with code 4.

**092 — KPRV section 11.** With no item and no setting, KPRV is exactly 067
(44 bytes, one section). After item 2 "two" dated 20261003 (event 1), item 1
"one" (event 2), the note "n" on item 1 (event 3), item 2 completed (event
4) and item 3 added and deleted (events 5–6): the section count is 2; section
1 is the empty notes section; section 11 has flags 0 and count 2, then item
1 (added at timestamp + 2, changed at 3, no date, open, text 3 and note 1,
"one" "n") and item 2 (changed at 4, date 20261003, done, "two"). A log
holding only the setting set off has section 11 with flags 1 and no items
(60 bytes in all).

**093 — Private commands.** `kin_private_execute` with KCMD action 110,
event `numbered_id(1)`, logical time 1 and the 090 payload, on an empty
private log, returns `KCMT` v1 with the 090 record, its KMET and an empty
projection, and leaves the log empty. The KCMD has `6e 00` at offset 8,
zeros at 92–123 and payload length `1f 00 00 00` at 124.

**094 — Command refusals (code 4).** Adding a known or deleted ID, untrimmed
text or notes, edits, completions, reopenings, dates, notes and settings
that change nothing, changes to unknown or deleted items, deleting a deleted
item, restoring a live one, a logical time not after the log's latest, a
known event ID, another member, another household, any other log, and an
add or restore with 2,000 live items. A household action fails with code 3;
an entity ID in the header or a payload length that doesn't match fails
with code 2.

## Household chat (v1.1)

Chat records are written out by hand in `rust/src/chat_tests.rs`; IDs, blob
refs and keys are distinct byte patterns per message and version.

**030 — Lifecycle.** Member 1 posts message 1 and member 2 posts message 2;
member 1 edits message 1 twice (once from another device) and member 2
deletes message 2. Expected: message 1 edited with the second edit's blob and
key, its edited-at time the second edit's; message 2 deleted with a zero blob
and key; retired blobs message 1 v0, message 1 v1, message 2 v0, in that
order.

**031 — Conflicts change nothing shown.** Against a posted text message and a
posted attachment, each of these leaves the messages and claims unchanged: a
second post of the same ID (by anyone), an edit by another member, an edit
of the attachment (each makes its new blob a retirement candidate), an edit
to the blob the message already has, an edit or deletion of an unknown
message, and a non-admin deletion by another member (none adds a
candidate). Nothing changes a deleted message; an edit after it makes its
blob a candidate.

**032 — Delete beats edit.** An edit and a deletion by the author at the same
logical time, from two devices, in both replay orders: the message ends
deleted with a zero blob, and both blobs it had (the original and the edit's)
are retired.

**033 — Admin claims.** An admin removes member 1's message twice and member
2 claims once. Replay records the claims (the admin once) and leaves the
message live; a page naming the admin, or member 2, shows it removed and
retires its blob; a page naming neither shows it live.

**034 — Separate logs.** The household history refuses a batch holding a
chat record and keeps nothing of it; the chat log refuses a household
record; a whole household KINE request refuses a chat record (code 4).
Chat commands fail against the household history and household commands
against the chat log (code 4).

**035 — KCHP layout.** Four messages (one edited, one attachment removed by
the named admin, one deleted by its author), texts held for two blobs: the
newest three with texts and retired blobs encode byte for byte as ABI.md
describes, and reading the page forgets the retired blobs' texts.

**036 — Long chat.** 100,000 posts, one in ten edited, one in twenty deleted:
the newest page of 50 replays within the test's bound, and the next page
reuses the checkpoint (`History::last_replay_reused`).

**037 — Shown blobs are never retired.** Edits A, B, then A again: the
message shows A and only B is retired. Two messages sharing a blob: deleting
one retires nothing while the other shows it; deleting both retires it once.
Commands refuse both reuses.

**038 — Backdated copies.** A modified client copies member 1's blob into an
earlier-dated post of its own message: both messages show (the copy as its
author's) and nothing is retired. Into an earlier-dated edit of its own
attachment: the blob is a candidate, but member 1's message still shows it,
so it is not retired.

## Talk later topics (#312)

These vectors are written out by hand in `rust/src/chat_topic_tests.rs`,
reusing the chat records above.

**042 — Topic payload.** Message 1 with state 0, 1 and 2 round-trips as kind
65: the message ID, the state and three zero bytes (20 bytes). A trailing or
missing byte, state 3 or 0xFF, a non-zero reserved byte and a zero message ID
fail with code 2; so do KCMD action 65 with option 3, a zero entity ID, a
payload or a date. The household history refuses a topic record.

**043 — Transitions.** Against messages 1–3: resolving or clearing message 1
with no topic fails (code 4); member 2 opens it; opening it again fails;
member 1 resolves it; resolving again fails; it reopens, resolves and clears;
clearing again fails. Message 2 clears from open. Message 99 (unknown) fails.
Message 3, once its author deletes it, fails for every state and its open
topic is gone. On a message a named admin removed, open and resolve fail and
clear succeeds. With 200 topics listed, a 201st open fails until one is
cleared; resolving one at the limit succeeds.

**044 — Tolerant replay.** Latest in log order wins: opened by member 2 then
resolved by member 1 lists message 1 resolved, flagged by member 2, changed by
member 1, in any arrival order. A resolve with no topic lists it resolved; the
same state again changes nothing; a topic on message 9 (unknown), or logged
before its message's post, changes nothing. Cleared then opened again starts
the record over at the end of the list. The author's deletion drops the topic
and a later flag on it changes nothing; an admin's removal keeps the record
but a page naming that admin leaves it out. Replay keeps 200 topics and
ignores the 201st.

**045 — KCHP topics section.** Messages 1–3, a pin on 1, member 2 opens 1,
member 1 opens 2 and resolves 1, member 2 opens 3, member 1 deletes 3. A page
asking for texts, reactions, pins, polls and topics equals the page without
topics followed by: count 2; message 1, `02 00 00 00`, member 2, then its
quote (live text by member 1, index 0, first line "Holiday plans"); message
2, `01 00 00 00`, member 1, then its quote (index 1, no text held). Flag bit 6
is refused.

## Push payload (RFC 8291)

**029 — RFC 8291 Appendix A.** Plaintext "When I grow up, I want to be a
watermelon", application-server private key
`yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw`, user-agent public key
`BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4`,
auth secret `BTBZMqHH6r4Tts7J_aSIgg`, salt `DGv6ra1nlYgDCS1FRnbzlw`.
`encryptPushPayload` must produce the RFC's message exactly, and decrypting
it with the user-agent private key `q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94`
must give the plaintext (`server/push.test.mjs`).

## QR symbols (#94)

The engine's QR encoder (`rust/src/qr/`) must produce the module grid below
for each text and mask, byte mode, level M. Each grid is pinned by the FNV-1a
64 hash of its modules (one byte per module, row-major, no quiet zone). The
reference is python-qrcode 8.x with byte mode forced and `mask_pattern` set,
run once and recorded here; it is not a runtime or build dependency.
`coverage::golden_grids_match_an_independent_encoder_for_every_mask` checks
all of them.

- `01234567`, version 1 (side 21): the ISO/IEC 18004 Annex I example, in byte
  mode. The annex example itself is numeric, so this is its byte-mode
  equivalent.
- `https://kin.example.org/#join=7kq4-zpm2-hr9t-vxb6`, version 4 (side 33).
- `https://kin.example.org/#sign-in=q7tk-2mzp-vx8r-3hdn-4wjb-9cfl-6ygs-zt5m`,
  version 5 (side 37).
- `https://kin.example.org/#v7=` followed by `0123456789abcdef` five times,
  version 7 (side 45), which carries version information.
- `https://kin.example.org/#v10=` followed by `0123456789abcdef` eleven
  times, version 10 (side 57).

| Text | Mask | FNV-1a 64 |
|---|---|---|
| `01234567` | 0–7 | `6ca855685a57b68d` `d3a2a295bf82e0c3` `03266a2fbe5602a3` `e2cffb098f25ae39` `fef5e643e723249b` `e20213afa4307655` `4c91aab4c8c01f95` `ef39ad586b7ebd8f` |
| join link | 0–7 | `92424d5f7ff9a791` `5e761cb029f507e3` `21f4527da7335d8a` `18e017e9e3e71022` `c01aac4b6d43773f` `2aff60efa4dc7421` `9eedae69d11331e6` `31ab0d471c819530` |
| sign-in link | 0–7 | `9050850d9fab18d5` `077723bf125628f3` `76bb94d44063b69f` `7c55179d943c7a85` `532d25518e3545cf` `12bc4b76d93e24be` `524efe1360e99449` `aee5e630353e1e1f` |
| version 7 text | 0–7 | `5b34cdaec1d9bd61` `0e6a1f274c02af4a` `d237884cd26ca547` `8da5669b736d8525` `08a6e8a98fd7136b` `cd1d4ccbeab9f7a9` `7a10146e7cc5a345` `97941fff7077a7d7` |
| version 10 text | 0–7 | `1bf516d39bd37249` `f77dc892ed145b02` `f3d2907f803b734f` `ce259b63f00e8839` `4dedc77efa96692b` `234fcb9d1fb8814d` `2ce91836c8b2447d` `01e5eb08f87c65ab` |

The V4 and V6 grids in `tests.rs` come from the same reference. Their masks
differ from the encoder's lowest-penalty choice, which is still a valid
symbol.

### Decoder frames (#95)

The decoder is checked on synthetic camera frames built in the Rust tests
from encoded symbols, not on stored images, so the corpus is code and can't
drift from the encoder:

- every version 1–10 with every mask, round-tripped (80 frames);
- rotation at every 15° (24 angles), a mild perspective tilt for versions
  2–10 (version 1 has no alignment pattern: the documented limit), and
  perspective with rotation and noise together;
- scale from 3 to 8 pixels per module;
- Gaussian sensor noise (an Irwin–Hall approximation), blur of radius 1 at
  6 pixels per module and radius 2 at 8, and light-on-dark symbols;
- damage up to the Reed–Solomon budget is read, and beyond it is refused or
  detected, never misread;
- adversarial frames: a symbol among finder-like decoys is still read, and
  too many decoys are refused rather than misread;
- the work budget: a clean symbol given too small a budget ends the search
  instead of running on.

[QR-ACCEPTANCE](QR-ACCEPTANCE.md) lists each test by name.
`scripts/qr-regression.mjs` reads a QR code through a real browser camera
(a fake video device) and the engine.

## The KTUN tunnel (#730)

KTUN version 1 is the framing between a home server and a connection relay
([ADR 0025](decisions/0025-kin-at-home.md) §2). Both ends use the one codec,
`relay/ktun.mjs`; `relay/ktun.test.mjs` builds every value below and checks
that this section carries the same hex. Integers are little-endian. Each
frame is a 12-byte header (`type:u8 flags:u8 reserved:u16 stream:u32
length:u32`) and its payload. Hex is wrapped at 64 digits.

Private keys are Ed25519 keys whose 32-byte seed is one repeated byte: the
**home key** is seed `01` × 32, the **new key** seed `02` × 32. Signatures are
Ed25519 (deterministic). The relay's name is `relay.home.test`.

**186 — Preface and HELLO.** The preface is `"KTUN"`, version 1, flags 0.
HELLO with nonce `11` × 32 and the defaults (256 streams, 256 KiB per stream,
4 MiB per tunnel, PING after 25 s, dead after 75 s):

```text
4b54554e01000000
0100000000000000340000001111111111111111111111111111111111111111
11111111111111111111111100010000000004000000400019004b0000000000
```

A preface with version 2, non-zero flags or other magic is refused. HELLO's
reserved field must be zero; windows under 16,384, `maxStreams` 0, or
`idleSeconds` not above `pingSeconds` ≥ 1 are protocol errors.

**187 — Signing in.** The home key's public key, the signed message
`"kin-tunnel-auth/1" 00 "relay.home.test" 00 nonce exporter` for nonce `aa`
× 32 and TLS exporter value `bb` × 32 (in a real tunnel, 32 bytes exported
with label `EXPORTER-kin-tunnel-auth` and no context), its signature, and
AUTH with software version `0x00010600`:

```text
8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c
6b696e2d74756e6e656c2d617574682f310072656c61792e686f6d652e746573
7400aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
aaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
bbbb
ec493467e5400d087b84cfb357a302228979eab44257b05d003e5793c7ad37b6
2578f9558552f402f09966443662ac5e29af9a67a738d5749c0f97a486f0440f
0200000000000000680000008a88e3dd7409f195fd52db2d3cba5d72ca6709bf
1d94121bf3748801b40f6f5cec493467e5400d087b84cfb357a302228979eab4
4257b05d003e5793c7ad37b62578f9558552f402f09966443662ac5e29af9a67
a738d5749c0f97a486f0440f0006010000000000
```

The signature must fail for another relay name or another exporter value.
The home key's own-domain TXT value (base64url SHA-256 of the public key) is
`NHUPmL1Z_PyUbaRaqr6TO-FUpLUJThxKv0KGZQXzyX4`.

**188 — READY.** Names `x.home.test` and `kin.family.test`, then none:

```text
030000000000000020000000020000000b782e686f6d652e746573740f6b696e
2e66616d696c792e74657374
03000000000000000400000000000000
```

Each name is a lowercase host name of 1 to 253 bytes; a non-zero reserved
field, a short list or bytes after the last entry are protocol errors. The
relay sends READY after sign-in and again whenever the names routed to the
tunnel change; each READY replaces the previous list.

**189 — OPEN.** Stream 1 for `x.home.test` from `203.0.113.7` (IPv4 fills
the first 4 address bytes; `::ffff:203.0.113.7` encodes the same), and
stream 2 from `2001:db8::1`:

```text
04000000010000001f000000040b0000cb007107000000000000000000000000
782e686f6d652e74657374
04000000020000001f000000060b000020010db8000000000000000000000001
782e686f6d652e74657374
```

Family other than 4 or 6, a non-zero reserved field, IPv4 with bytes after
the first 4, or a name length that doesn't match are protocol errors.

**190 — DATA, WINDOW and RESET.** DATA on stream 1 carrying `16 03 01`;
an empty DATA with FIN; WINDOW 2 MiB for the tunnel (stream 0) and 128 KiB
for stream 1; RESET of stream 3 with code 0:

```text
050000000100000003000000160301
050100000100000000000000
06000000000000000400000000002000
06000000010000000400000000000200
07000000030000000400000000000000
```

A WINDOW increment of 0 and credit past 2³²−1 are protocol errors.

**191 — PING and GOAWAY.** PING with `01 02 … 08`, its ACK (flag bit 0),
and GOAWAY with last stream 7 and code 3 (replaced by a newer tunnel):

```text
0800000000000000080000000102030405060708
0801000000000000080000000102030405060708
0900000000000000080000000700000003000000
```

**192 — CONTROL.** CLAIM `x.home.test` as request 1; the relay's answer on
success, whose body is the name list now routed to the tunnel; the answer
"name taken" (status 9, no body); SET_CAA request 2 for account
`https://acme.test/acct/1`; CHECK (op 7, #719) request 3 for `x.home.test`:

```text
0a00000000000000140000000100000001000c000b782e686f6d652e74657374
0a00000000000000180000000100000001001000010000000b782e686f6d652e
74657374
0a00000000000000080000000100000001090000
0a000000000000002e00000002000000030026000b782e686f6d652e74657374
180068747470733a2f2f61636d652e746573742f616363742f31
0a00000000000000140000000300000007000c000b782e686f6d652e74657374
```

Request bodies: CLAIM, RELEASE, ADD_DOMAIN, REMOVE_DOMAIN and CHECK carry
`nameLength:u8 name`; SET_CAA adds `uriLength:u16 accountUri` (1 to 512
bytes); TRANSFER adds `newKey:32 signature:64`. Names are full host names
(`x.home.test`, not `x`). A request whose status isn't 0 is a protocol
error; an unknown op or a malformed body is answered with status 1. CHECK
binds nothing: it answers what CLAIM (a name in the zone) or ADD_DOMAIN
(any other name) would, with status 0, 4 (this key already holds a free
name, or too many checks), 6 (an own domain whose `_kin-relay` TXT record
doesn't name this key yet), 9 or 10. A relay that predates CHECK answers
status 1, which the home server reads as "can't check ahead".

**193 — TRANSFER.** The new key's public key, the message
`"kin-tunnel-transfer/1" 00 "x.home.test" 00 oldKey newKey` and the new
key's signature over it:

```text
8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394
6b696e2d74756e6e656c2d7472616e736665722f3100782e686f6d652e746573
74008a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f
6f5c8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9
b394
747c6bed27ac0d4abe631d8995062d6afaf17cd9e2b27c0f475ce3e914719eaf
33cebf2cc575ff9e4db5d72de280c82651a34744c63e9db76b432c08ffe1d20d
```

**Checks every receiver makes (§2).** An unknown type, a flag bit the type
doesn't define (only DATA's FIN and PING's ACK exist), a non-zero reserved
field, a stream number wrong for the type (HELLO, AUTH, READY, PING, GOAWAY
and CONTROL on 0; OPEN, DATA and RESET on 1 or more; WINDOW either), a type
sent the wrong way (HELLO, READY and OPEN only from the relay, AUTH only from
the home server), a payload over 16,384 bytes or of the wrong fixed size are
protocol errors: GOAWAY with code 1, and the tunnel closes. So is DATA past
the credit given, DATA after FIN, and DATA, WINDOW or RESET for a stream
never opened (a stream already finished is ignored, its DATA still counted
against the tunnel's window and given straight back).

**Relay behaviour** (`relay/relay.test.mjs`, on loopback): a tunnel signs in
and a phone's TLS handshake completes with the home server through it; the
relay stops reading a phone whose stream has no credit and resumes on
WINDOW; it sends PING after `pingSeconds` of silence and closes a tunnel
silent for `idleSeconds`; a second tunnel with the same key replaces the
first (GOAWAY 3), and the phones on the old tunnel are closed; near the
stream limit the relay sends GOAWAY 0 and routes new phones only once the
home server reconnects.

## Home server certificates (#723)

The home server's ACME client (`server/acme/`, [HOME-CERTIFICATES](HOME-CERTIFICATES.md))
writes its own DER. `server/acme/der.test.mjs` pins these values. The key is
the ES256 example key of RFC 7515 Appendix A.3 (`x`
`f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU`, `y`
`x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0`, `d`
`jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI`).

- **JWK thumbprint (RFC 7638)** of that key:
  `oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U`, the SHA-256 of
  `{"crv":"P-256","kty":"EC","x":"…","y":"…"}`.
- **CSR.** For the name `fern.home.kin.journeytocode.io` and that key, the
  CertificationRequestInfo is 202 bytes with SHA-256
  `2e822352b116789e6ec7f3a1cd998352c9ac6acd69ebe469633e01758eedfa1a`:
  version 0, subject `CN=fern.home.kin.journeytocode.io` (UTF8String), the
  key's SPKI, and `[0]` holding one extensionRequest attribute with
  subjectAltName `dNSName fern.home.kin.journeytocode.io`. The signature
  algorithm is `30 0a 06 08 2a 86 48 ce 3d 04 03 02` (ecdsa-with-SHA256, no
  parameters); the signature is a DER `ECDSA-Sig-Value` that verifies with
  the key. ECDSA signatures are randomised, so only the signed part is
  pinned.
- **openssl.** `openssl req -verify` accepts generated CSRs (one name, two
  names, a 75-character name that leaves the subject empty) and `openssl
  x509 -text` shows the challenge certificate's
  `1.3.6.1.5.5.7.1.31: critical` extension. Both tests skip when `openssl`
  isn't installed.
- **acmeIdentifier (RFC 8737).** For the key authorization
  `evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA.oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U`
  the SHA-256 is
  `65a26016d215e16034b7633337b91b4a4d2c7d17761998dac51a9a49300aea52` and the
  extension is
  `3031 06082b0601050507011f 0101ff 04220420` followed by that digest.
- **ARI certificate identifier (RFC 9773 §4.1).** The RFC's own example,
  pinned in `server/acme/renewal-info.test.mjs`: authorityKeyIdentifier
  keyIdentifier `69:88:5B:6B:87:46:40:41:E1:B3:7B:84:7B:A0:AE:2C:DE:01:C8:D4`
  and serial number `00:87:65:43:21` (the serialNumber INTEGER's content
  octets, leading zero included; the INTEGER is `02 05 00 87 65 43 21`) give
  `aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE`. The test builds a certificate with
  that AKI extension (`30 16 80 14` followed by the 20 octets) and serial and
  reads the identifier back with Kin's DER reader.
- **DER primitives.** OID 1.3.6.1.5.5.7.1.31 is `06 08 2b 06 01 05 05 07 01
  1f`; INTEGER 128 is `02 02 00 80`; length 300 is `82 01 2c`; 2026-10-22
  08:05:09 UTC is UTCTime `261022080509Z`, and 2050-01-01 is GeneralizedTime
  `20500101000000Z`.
