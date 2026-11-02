# open.blog publishing

open.blog turns author-owned documents into public works. This language keeps field-specific
publishing behavior distinct from reusable attribution, evidence, and distribution concepts.

## Language

**Document**:
An author-owned source item containing publishing metadata and a body.
_Avoid_: Record, entry

**Post**:
A dated document published into feeds, archives, tags, and optional series.
_Avoid_: Article, story, paper when referring to the shared domain entity

**Content profile**:
The single set of field-specific authoring and publishing semantics selected for a post or
provided by the default.
_Avoid_: Document type, editor type, template

**Publishing capability**:
A reusable authoring or output behavior that can apply across multiple content profiles.
_Avoid_: Profile when the behavior is not mutually exclusive

**Published work**:
The public intellectual or creative work represented by a document, independent of its URL
or presentation.
_Avoid_: Page when identity rather than location is meant

**Interactive demo**:
A publishing capability in which a reader operates a small in-browser model of a mechanism (an
in-memory Git, a simulated network and storage inspector, a live custom element) embedded in a post
with a `demo` fence. It runs only on the canonical page and never stores or sends anything. It is
not a Web sandbox (the reader edits code there) or a Rust Playground (an external service).
_Avoid_: Widget, playground, sandbox when the reader is not writing code

**Demo fallback**:
The Markdown body of a `demo` fence, written by the author. It is the authored meaning of the demo
for every reader who cannot run it (no JavaScript, feed readers, portable and syndicated copies,
where a link to the live version follows it). It is plain Markdown with no raw HTML, no images, and
only absolute https links, and is never generated from the demo's behavior.
_Avoid_: Alt text, caption, placeholder

## Shared publication collaboration

These terms describe private collaboration before publication. They do not replace the public
attribution terms under [Evidence and identity](#evidence-and-identity), and they do not make
collaboration state part of a document or post.

**Shared publication**:
A collaboration effort, identified by a stable opaque publication ID, that brings one or more
ordered source references and one or more ordered participants toward a possible published work.
It is pre-publication state, not another kind of Post or Published work, and one participant is
as valid as two or many.
_Avoid_: Pair, couple, co-authored post, published work before publication

**Shared publication record**:
The private, versioned file that holds one shared publication's title or guiding question, its
ordered source references, its collaboration contract, and its authorization policy together,
outside the content directory. Keeping them in one record is what ties a policy and a contract to
the same publication. Creating, refusing, or revoking a record never changes a Post, Document,
credit, or generated output.
_Avoid_: Draft post, front matter, Post, published work

**Source reference**:
A bounded entry, identified by a stable ID within one shared publication's ordered source
collection, describing material that prompted or informs it: a video, article, podcast, book, or
other source with an author-entered title, an optional original HTTP(S) link, and optional
creator, publisher, date, and (for a book) ISBN. Its provenance records who supplied those values;
provider metadata may only suggest values and never overwrites what an author saved. It is not
automatically evidence cited by the resulting work and does not replace a Citation, Reference,
canonical URL, or Work identifier.
_Avoid_: Citation when there is no in-text pointer, primary source field, provider response

**Public source attribution**:
The approved public subset of a shared publication's first (original) Source reference: its
title, optional link, and type, plus the guiding question. It is published as plain front matter
on the resulting Post and shown as a link beside the work, never as an embed, in the page, feeds,
and portable exports. Participants, contributions, invitations, approvals, source IDs,
provenance, creators, publishers, dates, and ISBNs are not part of it.
_Avoid_: Citation, Source reference (the private entry), Work credit

**Participant**:
A person represented by a stable opaque ID within one shared publication. Participation is bound
to an Admin user and a contributor registry entry only through an explicit publication
authorization binding; it grants no site administration authority and implies neither public
credit nor authorship, so the bound entry is not thereby a Contributor.
_Avoid_: Contributor, Author, Admin user, left participant, right participant

**Publication authorization binding**:
An explicit entry in one shared publication's authorization policy that ties one Admin user and
one contributor registry entry to one participant and gives that participant collaboration roles.
It is the only source of collaboration access. It stops granting anything once its account,
registry key, or participant no longer exists, and it creates no authorship, Work credit, reveal,
or approval. Its identity is fixed: changing a binding changes only its roles, so a binding never
moves to another account or participant.
_Avoid_: Contributor registry entry, login, Work credit, invitation

**Invitation**:
A single-use, expiring offer, scoped to one shared publication, for one named Admin user and
contributor registry entry to join with stated roles. Its token is shown once as a copyable
link, stored only as a hash, and never emailed. Accepting it by the named account adds a new
participant and an explicit publication authorization binding in one write; it never takes over
an existing participant. An invitation grants nothing until accepted.
_Avoid_: Binding (the result of accepting), account creation, email invite

**Member**:
A person whose Admin account holds an explicit binding on one shared publication. Ending a
member's access removes only the binding; the participant and the credit for what they wrote stay.
_Avoid_: User (account administration is separate), contributor (credit, not access)

**Group**:
The members of one shared publication, from one to the participant cap, all admitted through
the same invitation seam with no pair-only path. Two is not a special case.
_Avoid_: Team, organization (out of scope)

**Membership audit**:
A bounded, newest-first record on a shared publication of who invited, revoked, joined, changed
roles, or removed whom and when. It names participants and invitation IDs only, never tokens,
accounts, or prose, and only site owners and coordinators can read it.
_Avoid_: Activity feed, access log

**Publish gate**:
The check that publishing a shared publication needs the publish grant and an approval of the
current revision from every participant who owns a contribution. Site ownership alone never
satisfies it.
_Avoid_: Approval quorum (a separate contract)

**Pair projection**:
A derived, unpersisted view that presents a shared publication with exactly two ordered
participants as first and second UI slots. It reads the ordinary group collections and adds no
state, so changing the group size never requires a migration.
_Avoid_: Pair, couple, left/right fields, author A/B

**Collaboration role**:
A publication-scoped responsibility, such as site owner, coordinator, contributor, editor, or
reader, that a publication authorization binding gives a participant. It permits only the actions
that policy lists for that one shared publication. The `contributor` role means writing one's own
contribution draft, not holding a public Contributor credit, and no role is promoted to a Work
credit role implicitly. Changing a binding or its roles is itself a role-limited action: only a
site owner can grant, revoke, or touch the site owner role, and a publication that has a site
owner always keeps one.
_Avoid_: Work credit, global job title, site-wide Admin permission

**Contribution draft**:
Untrusted Markdown that one participant owns and offers to a shared publication. It stays private
collaboration state, never stored on a Post or Document, until an explicit assembly and
publication path incorporates it, as it appears in an approved collaboration revision, into the
author-owned Document. A draft changes only by appending numbered, immutable revisions, each
identified by a prose-free stamp of contribution, number, author, timestamp, and content digest.
Its owner reads and saves it through Admin; each participant has one, kept in private project storage
(ADR 0017).
_Avoid_: Post, canonical content, public contribution disclosure

**Reveal**:
Permission for an ordered collection of participants to receive one exact revision of a
contribution draft, granted only by a mutual exchange that takes effect for all members at once or
for none. A reveal does not publish the draft, approve an assembly, or imply a two-person exchange. Only the listed
participants may receive the draft; permission to view revealed drafts in general does not widen
that list.
A coordinator-chosen reveal policy (independent, voluntary, all-ready) and each participant's
per-revision readiness decide when an exchange forms (ADR 0018). A publication has one author set, so
voluntary visibility is derived at read time from the active participants' standing offers: each
sees exactly the revision the others currently offer, and nothing is stored or merged.
The Shared reflections draft panel offers a revision only after an explicit confirmation, because a
copy that has been read cannot be recalled (ADR 0019).
_Avoid_: Publication, approval, left-to-right handoff

**Approval**:
One author's affirmative, timestamped consent to publish exactly the content their snapshot is
bound to: their own section revisions (or every section under the whole-piece scope), the author
set, section order, public title and source attribution, and the approval policy (ADR 0020). It
counts only while the recomputed binding still matches, so any covered change invalidates it.
Only the author can give or withdraw it; a site owner or coordinator cannot, and a publish grant
never replaces it; the publish gate checks it again at publication (ADR 0022). It is not an electronic signature, and alone it does not assign public credit.
_Avoid_: Publication, Work credit, timeless consent

**Approval rule**:
The publication's choice of whose approval publication needs: every author (the default), everyone
who wrote, the writers plus named participants, or the writers plus every author holding chosen
roles. Every writer, and everyone named on a synthesis item, always approves; a rule only adds
approvers and never counts, votes or stands in for anyone. A named person who leaves, or a role no
author holds, keeps the piece blocked until the rule changes. Site owners and coordinators change
it against the revision they read, with an explicit confirmation, and a real change clears every
approval. A coordinator may only keep or add required approvers; dropping anyone the rule
requires, even someone who has left, takes a site owner. It is bound into every approval and shown in the combined preview. It never changes who
reads which draft: reveal stays one group (ADR 0052).
_Avoid_: Quorum, vote, approval threshold, reveal group

**Synthesis item**:
An optional statement the authors of a shared reflection make together: an agreement, difference,
question, application or uncertainty, written as untrusted Markdown and attributed in order to one,
some or all authors. No kind is required, an empty synthesis is complete, and disagreement is never
an error. An author can add attributions but removes only their own name (withdrawal). Each item
records which attributed authors approved it, bound to its revision (any change clears them), and
everyone named on an item must approve the piece. Approval binds
to the exact items, order and attribution, and the set stays private until a later step publishes it
(ADR 0024). Contributors write and approve them in Admin through one `EditSynthesis` grant, and
the publish gate waits for every item to be approved by every author it names (ADR 0025).
When the piece publishes, only fully approved items appear, after the authors' sections under
"Continuing the conversation" (ADR 0026).
_Avoid_: Consensus, summary, comment

**Continuing the conversation**:
The published section of a shared reflection holding its approved synthesis items, grouped by kind
(shared takeaways, where we differ, questions, ways to apply, what we are unsure about), each item
headed "Speaking for" the authors it names and anchored by kind and ordinal. It is ordinary Post
Markdown, so it reaches the page, feeds and exports with the rest; it has no heading when nothing
is approved, and it never signals consensus or lists approvers (ADR 0026). Its anchors are
reserved and item headings start at level five (ADR 0027). Portable output carries it with
attribution and stable anchors; summaries stop before it and summary-only feeds omit it (ADR 0028).
_Avoid_: Summary, consensus, comments

**Media moment**:
A participant's located note on one of a shared publication's own sources. It points at the source
reference by id and at a place in it through one to eight notebook Locators: a timestamp or range for
video and audio, and pages, chapters or other textual locators for text. It holds a moment quotation,
a moment observation, or both. The participant who made it always comes from the session. A moment is
private to its owner unless it is proposed for the publication. Even then, another author sees it only
while it is sealed to the owner's draft revision that author may read. Approval binds the exact
moments proposed for the piece, and each owner must approve it (ADR 0062, 0063).
_Avoid_: Annotation, clip, transcript, comment

**Moment quotation**:
Words from the source, stored exactly as quoted and kept short: at most 1,000 characters, never a
transcript. It carries an optional speaker, an optional language, and an explicit quotation rights
status and provenance. It is never the participant's prose (ADR 0062).
_Avoid_: Excerpt when the notebook's passage is meant, observation

**Speaker**:
Who said a moment quotation in the source, as a plain name. It is neither the source attribution nor
the participant who quoted it (ADR 0062).
_Avoid_: Author, creator, participant

**Moment observation**:
The participant's own words about a media moment, written as untrusted Markdown with no raw HTML,
images, headings, footnotes or non-HTTP(S) links (ADR 0062).
_Avoid_: Quotation, note when the notebook's research note is meant

**Quotation rights**:
The participant's own statement of whether a moment quotation may be republished: unknown, brief
quotation, permission, open licence, public domain, or their own words. It is always paired with
provenance: transcribed, copied, or supplied. It is never a legal determination, and a quotation
whose rights are unknown cannot be proposed for the piece (ADR 0062).
_Avoid_: Licence check, clearance, fair use ruling

**Quotation attribution**:
The one line that credits a moment quotation wherever it shows: its speaker when named, the source's
title and kind as the record holds them now, and the moment's location, such as "The host, in Episode
4 (Podcast), from 1:02 to 1:10" (ADR 0065).
_Avoid_: Byline, credit line when the participant is meant

**Rights guidance**:
Neutral text explaining what a quotation rights status states and what helps co-authors review it,
always shown with the statement that the status is the participant's own and that open.blog does not
check rights. It never says that a use is allowed (ADR 0065).
_Avoid_: Legal advice, clearance, permission check

**Rights note**:
The participant's optional one-line note on a moment quotation's rights status, such as who gave
permission or which licence applies. It is covered by the seal and approval, shown to co-authors, and
never published (ADR 0065).
_Avoid_: Licence field, permission record

**Quotation warning**:
Advice about a moment quotation that names no speaker or is longer than the 300-character guide for a
brief quotation. It never judges accuracy and never blocks saving, proposing, approving or publishing
(ADR 0065).
_Avoid_: Error, violation, plagiarism flag

**Moment seal**:
The digest of an owner's proposed media moments, written when the owner offers a draft revision and
tied to that revision. It covers the moments' own content only, never the source's title or link,
and it is written once per revision. Another author sees the owner's proposed moments only while
the seal for the revision they may read still matches them; an edit after the offer stays private
until a newer revision is offered (ADR 0063, 0064).
_Avoid_: Snapshot, lock, approval

**EditMoments**:
The collaboration grant to capture, edit and remove one's own media moments and read the ones other
authors revealed. Contributors hold it for themselves only, because a proposed moment makes its owner
a required approver (ADR 0064).
_Avoid_: EditSynthesis, EditDraft

**Published moment**:
The public projection of an approved media moment: where it is (the source's title and kind and the
location, times read like `1:02`), who noted it (a display name), the quotation's words, language and
quotation attribution, the observation, and the moment link. It has no field for rights, the rights
note, provenance, ids, intent or seals, so none can be published. The gate appends every moment
proposed for the piece, in order, after the rest of the Post under "Moments in the sources"; private
moments never enter (ADR 0066).
_Avoid_: Embed, clip, player, annotation

**Moment link**:
The published link of a moment, derived from its source's stored address and never stored: a link
that starts at the moment where the provider's time parameter is known (YouTube), otherwise the
original link unchanged, and no link at all when the source has no safe address, so the location
stays text. Its label names the source and, when it starts there, the time (ADR 0062, 0066).
_Avoid_: Embed, timestamp URL field

**Moment frame**:
The closed HTML grammar a Post body carries for published moments (`section`, `figure`, `blockquote`
with the quotation's `lang`, `figcaption`, a link paragraph) around each observation's own Markdown.
The page, the preview and portable HTML render it through the production renderer; portable Markdown,
text and `llms-full.txt` read it back exactly and state the same facts without HTML, and the portable
semantic check requires every fact in order (ADR 0067).
_Avoid_: Widget, component, shortcode

**Combined preview**:
The side-effect-free review of the whole piece an author sees before approving: every author's
section in order at its exact latest revision (an author who wrote nothing has no section and
does not block it), each author's approval state (approved, awaiting, or
stale), and whether the piece is complete and ready. A section appears only if the reader may read
that latest revision; every other case is one identical placeholder. An author's proposed media
moments are part of their section: it shows only while they are sealed to the revision shown, and
the moments the reader may see are listed with it (ADR 0064). It opens with a "Preview, not
published" notice, runs no script and loads nothing (ADR 0021).
_Avoid_: Draft view, published page, staging copy

**Publish gate**:
The single operation that turns approved drafts into a Post, for "publish now" and for a scheduled
time falling due. It runs only for a requester holding the publish grant, only while
`ApprovalSet::evaluate` passes against the content as it is at that moment, and writes the Post,
its credits, the private outcome and the rebuilt output as one unit that is undone if any step
fails. A retry changes nothing. A scheduled publication is held in private state, not content, and
passes the gate again when it falls due (ADR 0022). The gate also refuses a piece whose joined page
would differ from the sections as each author previewed them, or carry active markup (ADR 0022).
_Avoid_: Auto-publish, scheduled Post written ahead of approval

**Published shared reflection**:
The Post a publish gate writes, shown as an ordinary Post in every representation: the native page,
portable HTML, Markdown and text, RSS, JSON Feed and the text discovery files. It has no
representation of its own. Every written section appears in participant order, each author who wrote
one is credited in that order, and the shared source and guiding question appear as a plain link
(ADR 0008). Nothing else of the collaboration reaches it: no draft revision, invitation, approval,
account name or publication id (ADR 0023).
_Avoid_: Shared page, collaboration export

**Reflection structure**:
The ordered rounds, round prompts and turns of a shared reflection, plus one chosen Reflection
layout, and the only authority for how it is arranged. A turn names one part of one draft, never a
person, so the structure holds no identity and no gendered or positional field (ADR 0029). A draft
splits into ordered parts at a line that is exactly `<!-- openblog:part -->`; without it a draft is
one part. Once wired, its turn order, round prompts and layout are part of what an author approves
(ADR 0030).
_Avoid_: Left/right, author A/B, theme, template, the contract's region layout

**Reflection layout**:
One of sequential, side-by-side, point-counterpoint, alternating dialogue or roundtable: a
presentation of the same structure. Changing it rewrites no prose, and it never decides identity,
authority or credit. Every layout reads in the one Reading order (ADR 0030). It is not the
collaboration contract's `layout` field, a reserved list of contribution-to-region pairs that nothing
reads and the next contract version drops.
_Avoid_: Role, side, speaker slot, contract layout, region layout

**Arrangement**:
The stored Reflection structure as a coordinator edits it: the chosen layout, the rounds, round
prompts, the order of turns and each turn's optional label. It is private until published,
holds no prose, is saved with a revision check, and is part of what every author approves, so
changing it makes standing approvals stale (ADR 0030, ADR 0031). A reflection with no arrangement
publishes in participant order.
_Avoid_: Template, theme, layout setting

**Turn label**:
An optional short phrase an author-coordinator writes for one turn of an arrangement, such as "Point"
or "Reply". It is public text, bound to approval with the rest of the arrangement, escaped on
output, and shown under the turn's author heading. No layout invents one, and it is dropped with its
turn (ADR 0032).
_Avoid_: Side, role, stance, speaker slot

**Portable reflection**:
The static equivalent of a published reflection in portable HTML, Markdown, text, feeds and llms
output: each round prompt, then every turn under its author's name and optional label, in reading
order, whatever the layout. It carries no placement, class, placeholder or part marker, and the
layout is reported once as a diagnostic instead of lost silently (ADR 0033).
_Avoid_: Layout export, flattened copy

**Part break**:
The line `<!-- openblog:part -->` a writer places in their own draft to start a new part. It is
never rendered or published: the preview, the Post, feeds and exports all drop it (ADR 0031).
_Avoid_: Page break, horizontal rule

**Round prompt**:
The optional public cue or question a round of a reflection structure answers, read once before its
first answer. It is not an editor prompt (ADR 0019), which is a never-stored hint inside the draft
editor, and a round is not an exchange, which means a mutual reveal.
_Avoid_: Editor prompt, exchange

**Reading order**:
The deterministic linear sequence of a reflection structure: rounds, then turns, with each round's
round prompt before its first answer. Shared by every layout. The requester-scoped form shows the
same placeholder for any turn the requester cannot read (ADR 0021); the unscoped form is for the
publish gate only. The portable equivalent can share it once #173 wires it.
_Avoid_: Visual order

**Series placement**:
The optional series reference and position a shared publication carries, written as an ordinary
Post's `series` and `seriesOrder`. It does not create a separate series entity: the site's
existing series supplies name, description, theme, ordering and navigation. It is public, so it is
part of what every author approves (ADR 0038). Site owners and coordinators set it (`PlaceInSeries`) against
its revision, every participant sees it with the reading order it would join, and only site owners
add a new series definition (`CreateSeries`); the list and order come from published posts only
(ADR 0039).
_Avoid_: Series template

**Series definition**:
The site-owned `content/series/<slug>.md` that names a series and describes its recurring premise.
A shared publication never writes one; a site owner may add a new one from its Series panel, and
it is not public until a part is published (ADR 0039).
_Avoid_: Series template

**Collaborative work**:
A published Post whose approved work credits (an explicit credit sidecar) name two or more
authors. A legacy post's default site-author credit, a single author or a secondary role never
make one. It is derived from the credits alone, never from collaboration state (ADR 0040).
_Avoid_: Shared post, joint post

**Collaborative series**:
An ordinary series with at least one collaborative work among its published parts. Only such a
series names its contributors on its page and each part's authors in its navigation; every other
series renders exactly as before, and drafts or scheduled posts never make one (ADR 0040).
_Avoid_: Collaborative-series entity, series template

**Series context**:
What a feed item or portable copy of a published part of a collaborative series states about it:
the series name and canonical link, its place in the published reading order ("Part 2 in the
series", without the number of parts, so a growing series leaves earlier copies unchanged), the
part's authors and the series' contributors. Derived from the public series and approved credits
only; any other post has none and its feeds and copies are unchanged (ADR 0041).
_Avoid_: Series metadata, series membership

**Published assembly**:
The explicit, ordered selection of source references and contribution drafts, as they appear in
one approved collaboration revision, that a publication operation incorporates into canonical
content. It names that
publication-time assembly, not a second stored Post or Published work. Participant order does not
determine public credit; publication resolves credit through the existing Work credit model.
_Avoid_: Collaboration transcript, automatic byline, second Post or canonical document

## Evidence and identity

**Citation**:
An in-text pointer connecting a passage to a reference, written `[@key]` or
`[@key, page 514]`. Its key is the reference's source identifier and its locators are the
notebook's. Only its key, locators and the formatted reference are public; it asserts nothing
about what the source proves.
_Avoid_: Reference, source, footnote, link

**Reference**:
A description or resolvable identifier for a work used as evidence or context. In the
source library, a reference record points at exactly one work, edition, translation, or
witness, never at another reference or a contributor.
_Avoid_: Citation when no in-text pointer is meant; contributor or work credit

**Citation key**:
The source identifier written after `@` in a citation. There is no separate key registry, so a
citation resolves to exactly one source-library record, archived or not, or is reported.
_Avoid_: Cite key table, alias, BibTeX key

**Citation chip**:
How the visual editor shows a citation: one atomic, keyboard-reachable unit that keeps the
citation's exact Markdown and reopens it in the citation picker. It is an editing aid only; the
Markdown file stays canonical. Citation text the editor cannot show as chips exactly as the
scanner reads it stays a protected **Citation text** block instead.
_Avoid_: Footnote marker, link, tag

**Publication Markdown**:
The body every public representation of a post is built from: the authored Markdown, or for a
post that opts in to citations, that body with each citation written as a generated footnote
and the notes appended. The file on disk never changes.
_Avoid_: Export, rendered body

**Citation note**:
A generated, numbered note that publishes a citation: the formatted reference and the
citation's locators, linked from its marker and back. One per distinct citation in the `notes`
style.
_Avoid_: Footnote when an author's own note is meant

**Bibliography**:
The citation style that publishes each cited reference once, numbered in order of first
citation, under References, with locators kept next to the marker in the text.
_Avoid_: References section when the research profile's hand-written list is meant

**Supplement**:
A block quote an author marks `[!supplement kind=... level=...]` in a post that opts in with
`readingModes`, holding extra context beside the article: a definition, context, deeper evidence, a
relationship, a comparison or further reading, or a kind the site does not know. It is the
author's own words in the published post and nothing else can become one. It is never an
alternate article body: the argument, citations and footnotes read the same without it.
_Avoid_: Sidebar, hidden text, alternate version, AI summary

**Reading mode**:
A reader's local choice of how many supplements show: `standard` (none), `guided` (guided ones) or
`deep-dive` (guided and deep-dive ones). It changes visibility only, never the article, and without
script every supplement is shown. A supplement that holds a warning or caution callout is shown in
every mode. The author may name the mode a post opens in; a reader's saved choice comes first.
_Avoid_: Reading level, difficulty, personalised view

**Article boundary**:
What tells a reader which words are the article under every reading mode: each supplement is a bordered group with a visible label and an "End of ... supplement." line, and the reading-mode control says everything outside those boxes is the article. The article itself is never wrapped or relabelled.
_Avoid_: Main text marker, article toggle

**Reading depth**:
The least reading mode that shows a supplement, `guided` or `deep-dive`, written as `level` or
taken from the supplement's kind. A supplement inside another is shown no earlier than the one
holding it.
_Avoid_: Priority, importance, rank

**Reader references**:
The versioned data a citation preview reads: each cited reference once under its citation key,
and each citation with its marker and note ids and its locators, projected from the published
citations and holding only their public description. It lives inline in the page and is never
needed to read it. Only the reference id is stable; marker and note ids are positional for one
revision and are never stored.
_Avoid_: Bibliography data, citation metadata

**Citation endnotes**:
The region at the end of a native post page that holds its generated citation notes under their
heading, announced as endnotes and named by that heading. Following a marker moves focus to its
note, and each note links back to every marker citing it. It never holds the author's own
footnotes.
_Avoid_: Footnotes section, bibliography block

**Citation preview**:
The small panel that opens beside a citation marker, on focus, hover or a first tap, showing the
cited reference's formatted text, the citation's locators and at most one checked outside link
plus the way to the note, all taken from the page's reader references as text. It enhances the
marker, which stays the link to its note, and is never needed to read the post. It repeats what
the author's library says and verifies nothing: not that the source exists or is described
correctly, that its link resolves, that the passage supports the claim, or that the source is
authoritative or may be reused.
_Avoid_: Tooltip, popup, source card

**Citation check**:
An offline finding about a post's citations, in one of four separate classes: syntax (the
citation cannot be read), resolution (its key or locator does not resolve, or an identifier is
left out), completeness (a cited reference lacks a detail its kind usually has) and location
review (a cited location only a person can confirm). It never says whether a source is true,
relevant or supports a claim, and never looks anything up online.
_Avoid_: Verification, fact check, citation score

**Bibliography export**:
A post's cited references as CSL JSON or BibTeX, built only from the public description its
published notes show, with every detail the format cannot carry reported as an omission. It is
derived from the publication projection, not from the private source library export.
_Avoid_: Library export, source export

**Formatted reference**:
The public, plain-text rendering of a reference built only from its bibliographic description
(title, creators, date, identifiers, preserved CSL variables), never from notebook text.
_Avoid_: Bibliography entry when the source-library record is meant; CSL style output

**Work identifier**:
A persistent identifier assigned to a published work, distinct from the page URL where a
copy happens to appear.
_Avoid_: Canonical URL, source URL

**Contributor**:
A person or organization publicly credited for a defined role in a published work.
_Avoid_: Admin user, site account, author when the role is more specific

**Contributor registry entry**:
A person record in the site's contributor registry, keyed by a contributor ID, that a Work credit
can reference. An entry grants no login or access and is not by itself a Contributor: it becomes
one for a published work only when that work's Work credit names it.
_Avoid_: Contributor before any Work credit, Admin user, Participant

**Author**:
A contributor who holds the author relationship for a particular published work.
_Avoid_: Site owner, publisher, or every person acknowledged on the work

**Work credit**:
An ordered relationship between one contributor and one published work, with one or more
explicitly named roles.
_Avoid_: Contributor profile, global job title

**Admin user**:
An authenticated account that signs in to Admin Studio for one site. It proves who is editing; by
itself it grants no public credit, authorship, or participation in a shared publication.
_Avoid_: Contributor, Participant, Author

**Contributor identifier**:
A persistent identifier for a person credited on a work.
_Avoid_: Work identifier, profile URL

**Identifier provenance**:
How a contributor identifier was collected, especially manual entry versus an authenticated
provider workflow.
_Avoid_: Treating syntax validation or a resolvable URL as identity verification

**Organization identifier**:
A persistent identifier for an organization associated with a work or contributor.
_Avoid_: Contributor identifier, organization website

**Evidence guidance**:
Authoring assistance that checks structure and resolvability without rating truth,
authority, peer review, or professional approval.
_Avoid_: Fact checking, evidence score, trust score

**Semantic representation**:
The meaning-bearing content and relationships of a published work, independent of a
particular interface or destination payload.
_Avoid_: Rendered HTML when referring to authored meaning

**Portable representation**:
A destination-neutral or destination-specific projection derived from the canonical
published work without becoming a second editable source of truth.
_Avoid_: A separately authored export document

**Portable fallback**:
A derived, usable representation for a capability that a destination cannot render
natively, with any material semantic loss made explicit.
_Avoid_: Silent omission, decorative placeholder

**Portability level**:
The declared relationship between a capability's semantics and its portable output:
Fully portable, Gracefully transformed, or Canonical-only interaction.
_Avoid_: A quality score or promise that every destination behaves identically

**Semantic loss**:
Meaning, structure, attribution, reference identity, or interaction that a portable
representation cannot preserve.
_Avoid_: Merely different styling

**Raw HTML policy**:
The fixed allowlist the portable projection applies to authored raw HTML: static content
elements are kept, active or destination-hostile markup is removed, unwrapped, or replaced
with a canonical link, and every removal of reader content is reported.
_Avoid_: Sanitizer (a general-purpose API), passing authored HTML through to a destination

**Destination policy**:
Rules for projecting a capability to a particular destination, including its supported
representation, fallback, portability level, and diagnostics.
_Avoid_: Changing the canonical work to satisfy one destination

## Research sources

**Source library**:
An author's private, versioned collection of works, editions, translations, witnesses, and
references reused across research. It is never content and reaches public output only
through an explicit projection.
_Avoid_: Bibliography when the public reference list of one work is meant; database

**Library revision**:
The fingerprint of the source library as stored, which every change must name so that a
change based on an older read is refused instead of overwriting newer work.
_Avoid_: Version, which names the file format; edition

**Archived source**:
A source-library record hidden from everyday lists but kept in place, so records that
point at it still resolve. Archiving is reversible and is not removal.
_Avoid_: Deleted, removed, hidden source

**Import plan**:
The preview of a CSL JSON import: for each item whether it would create, update, leave
unchanged, or conflict with a source, what it keeps, and which fields cannot be stored.
Nothing is written until a plan with no conflicts is applied.
_Avoid_: Dry run when the result of applying it is meant

**Notebook**:
An author's private, versioned collection of quoted passages and research notes that point
into the source library. It is never content and has no public form of its own; research
becomes public only through an explicit projection.
_Avoid_: Source library, bibliography, journal

**Passage**:
An excerpt of one source-library record together with where in it the excerpt sits. A
passage keeps its source for life and holds quoted text, never the author's prose.
_Avoid_: Quote block, citation, annotation

**Quoted excerpt**:
The verbatim text of a passage, stored exactly as quoted and apart from every field of
author prose. It is someone else's words and carries no claim that it is accurate or
permitted to republish.
_Avoid_: Note text, summary, content

**Locator**:
One position inside a source, with a kind such as page, folio, line, canonical reference,
or an `x-` extension kind, and an optional range end. A passage lists several in order for a
compound location.
_Avoid_: Location when the single source-library record location is meant; citation

**Notebook revision**:
The fingerprint of the notebook as stored, which every capture, edit, and removal must name
so that a change based on an older read is refused instead of overwriting newer research.
_Avoid_: Version, which names the file format

**Capture**:
Saving a passage, and optionally a first note about it, into the notebook from Admin without
leaving the draft. It never changes the draft and never publishes anything.
_Avoid_: Clip, import, citation

**Research note**:
The author's own observation or question, linked to passages, sources, or concepts. Always
private; never a quotation, claim, or citation.
_Avoid_: Annotation, comment, reader note

**Archived entry**:
A passage or note the author has set aside. It stays in the notebook file, its links and its
exports, and is left out of lists, search and the open-question count until the author asks for
archived entries. Archiving is reversible and never changes who can see the entry.
_Avoid_: Deleted, hidden, unpublished, private (every entry is private)

**Research bundle**:
The versioned, explicitly requested export of the whole notebook, marked private so tools can
recognise and refuse it in public folders. Importing one previews first and only adds entries
the notebook lacks.
_Avoid_: Backup of the site, publication, CSL export

**Open question**:
A research note of kind question that the author has not marked resolved. A question with no
state written is open. The state is the author's own marking and says nothing about whether an
answer is correct.
_Avoid_: Todo, unanswered claim, knowledge gap

**Backlink**:
An entry in the notebook that points at a passage, a source or a concept, found by reading the
stored notebook rather than from a saved index. A source's backlinks include entries that point
at its editions, translations, witnesses and references.
_Avoid_: Citation, reference, mention

**Source identifier**:
A stable, author-assigned slug naming one source-library record, independent of its title.
Editing a record never changes its kind; the library does not remember removed ids, so
reusing one after removal is the author's responsibility.
_Avoid_: Work identifier, bibliographic identifier, contributor identifier, URL

**Work**:
An intellectual or creative creation recorded in the source library independently of any
edition, translation, or copy of it; also called the original work.
_Avoid_: Published work when this site's own output is meant; book or edition

**Edition**:
One published realization of a work or of a translation, with its own text, pagination,
and publication details.
_Avoid_: Work, copy, version when a manuscript or translation is meant

**Translation**:
A rendering of a work into another language, recorded separately from the work it
translates and from the edition or witness it was made from.
_Avoid_: Edition, language variant

**Witness**:
One particular manuscript, printed copy, recording, or capture that attests a work,
edition, or translation.
_Avoid_: Edition, or source when a specific exemplar is meant

**Bibliographic identifier**:
A scheme-qualified value such as a DOI, ISBN, ISSN, or URL that describes a source-library
record without replacing its source identifier.
_Avoid_: Source identifier; treating syntax checks as proof the identifier resolves

**Source location**:
A scheme-qualified position, such as a page, folio, line, or timestamp, inside the specific
work, edition, translation, or witness a reference points at. In a multi-volume edition or
witness it also names its volume.
_Avoid_: Citation, URL fragment

**Realization chain**:
A record and the records it realizes, followed through `of` up to the work, each keeping its
own kind: a reference, the edition it points into, the translation that edition prints, and the
work. A translation in the chain is never read as an edition or as the original work (ADR 0084).
_Avoid_: Version history, lineage when a revision is meant

**Revision**:
An edition that revises an earlier edition of the same text, recorded with `revises`. A new
translation is never a revision; it is its own translation (ADR 0084).
_Avoid_: Reprint, version, new translation

**Witness identity**:
The repository and shelfmark that identify one held copy. Two witnesses never share both
(ADR 0084).
_Avoid_: Call number alone, CSL archive

**Volume**:
One physical part of an edition or witness that declares several. A page or folio in such a
record must name its volume, because pages restart in each (ADR 0084).
_Avoid_: Issue, part, tome when a separate edition is meant

**Rights declaration**:
The author's own statement of the rights in one version's text, or in an interpretation's text:
a rights status, an optional one-line note and, for an open licence, the licence's name. It is
private and never a legal determination (ADR 0085).
_Avoid_: Licence check, clearance, permission

**Rights status**:
One of unknown, rights reserved, permission, open licence, public domain, or own work, as the
author states it. A version that declares none is unknown, and no version inherits a status
from the work, edition, or translation it comes from (ADR 0085).
_Avoid_: Allowed, cleared, copyright status as a fact

**Attribution certainty**:
How firmly a name is tied to a source or interpretation, as the author records it: stated by the
source, attributed by tradition or scholarship, uncertain, or disputed. Absent means not recorded,
never "stated" by inference (ADR 0086).
_Avoid_: Confidence score, authorship verdict

**Anonymous source**:
A work, edition, translation, or witness whose source names no maker. Names tradition assigns may
still be recorded as attributed, uncertain, or disputed, but never as stated (ADR 0086).
_Avoid_: Unknown author when the creators are simply not filled in

**Interpretation**:
An attributed rendering or reading of one located place in one exact text in the source library,
kept beside the library's records. It is private research, never a source, never cited, and
never a credit (ADR 0087).
_Avoid_: Translation (a published version), annotation, research note, claim

**Rendering**:
An interpretation that translates one located place into another language. It names the edition,
translation, or witness it was made from.
_Avoid_: Translation when the library's published translation record is meant

**Reading**:
An interpretation of what one located place means.
_Avoid_: Claim, evidence, commentary when a library source is meant

**Interpreter**:
Who made an interpretation: a contributor named by registry key, which reuses their identity
without creating a work credit, or anyone else by a descriptive name, each with an optional
attribution certainty. An interpretation with no interpreter is explicitly anonymous (ADR 0087).
_Avoid_: Credit, author, creator

**Passage alignment**:
The author's private record that places in two or more versions or interpretations correspond,
attributed and optionally evidenced. It never says the places mean the same thing and never
treats a version as authoritative (ADR 0088). It is published only once approved, through the
comparison projection (ADR 0092).
_Avoid_: Equivalence, parallel text, translation memory, automatic alignment

**Alignment member**:
One place in a passage alignment: a version and its own locators, optionally the notebook passage
quoting it, or an interpretation aligned as it is. Several members may come from one version, and
a place may belong to several alignments.
_Avoid_: Segment pair, row, one-to-one match

**Absent member**:
An alignment member recording that a version lacks the passage (an omission, a lost leaf, or a
gap), so a missing passage is stated rather than inferred from silence.
_Avoid_: Empty member, null match

**Correspondence**:
How the author reads an alignment's places: corresponding, corresponding in part, or
corresponding but differing. There is deliberately no "equivalent".
_Avoid_: Equivalence, similarity score

**Normalization**:
The author's normalized form of a member's original wording (for example, composed accents or
expanded abbreviations), stored beside and never in place of the passage or interpretation text.
_Avoid_: Correction, the text, cleaned excerpt

**Comparison workspace**:
The Admin research tool that reads one passage alignment as its versions' places side by side or
in a single column, in the author's member order, with original wording exact and normalizations
shown only on request (ADR 0090). It reads and edits alignments, previews what a public page
would show for each place, and records approval; it publishes only through the comparison
projection.
_Avoid_: Parallel text viewer, diff, translation comparison score

**Place identification**:
The visible line on every compared place naming its version (kind and language), its maker in the
version's own role (editor, translator, scribe, or interpreters, with attribution certainty), and
its locator, so a place read or copied alone stays attributed.
_Avoid_: Caption, citation

**Comparison export**:
Copying or downloading the places the author explicitly selected in the comparison workspace,
each with its place identification and rights statement and its wording exactly. Copying waits
for confirmation when a selected version's rights are unchecked or reserved, and a rights status
never means permission. The author's private notes on places are left out unless the author ticks
"Include my notes on places" (ADR 0091).
_Avoid_: Publishing, sharing, licence check

**Comparison projection**:
The one public form of passage comparisons: approved alignments, each reduced to an explicit
allowlist of fields, with every place identified and its wording passed through the rights gate.
The comparison pages and `comparisons.json` are both rendered from it (ADR 0092).
_Avoid_: Public alignments, parallel text export

**Comparison publication switch**:
The site setting `comparisons.publish`. Off by default, when no build reads the alignments file;
on, the build publishes the comparison projection. Each alignment still needs the author's
approval.
_Avoid_: Treating approval alone as publication

**Rights gate**:
The rule that a compared place's wording is published only when the author's rights statement
for its version or interpretation is permission, open licence, public domain, or own work, and the
wording is a brief excerpt (at most 1,000 characters). Otherwise the place is identified and
located, never quoted. It follows the author's declaration and is never a legal judgement.
_Avoid_: Licence check, copyright clearance, fair-use test

**Knowledge Atlas**:
An author's private, versioned map of contextual entries and the attributed relationships between
them. It reaches public output only through an explicit publication projection of approved items.
_Avoid_: Knowledge graph or database; ontology; a source of factual truth

**Contextual entry**:
One person, work, concept, movement, or event in the atlas. Its kind is fixed and decides which
relationships it may join. A concept entry is what a notebook note's concept link resolves to.
_Avoid_: Node, record, tag; treating an edition or translation as a work entry

**Attributed relationship**:
A directed link between two entries that one named party asserts, resting on cited source evidence
and carrying a confidence and an uncertainty note. Its reverse reading is a label, never a second
assertion, and it is never inferred from dates or order.
_Avoid_: Edge or fact; influence inferred from chronology

**Contested relationship**:
A relationship with at least one recorded, attributed disagreement. There is no state that says
scholars agree.
_Avoid_: Consensus, established

**Unsourced draft**:
The explicit state of a relationship that cites no evidence yet. It can be neither strong nor
approved.
_Avoid_: Unverified, low confidence

**Projected relationship**:
An approved relationship whose two entries are both approved, and so the only kind the
publication projection may copy. An approved relationship touching a private entry stays
private and is reported as a notice, never refused.
_Avoid_: Public relationship, approved relationship when a private endpoint is possible

**Dating**:
One party's attributed claim about when one aspect of an atlas entry or relationship happened,
resting on cited evidence (or explicitly unsourced), with a confidence and a note. It is private
until approved and is never a fact.
_Avoid_: Date field, the date of something; a date without who gives it

**Dated aspect**:
What a dating dates: an entry's `span`, a person's `birth`, `death` or `active` period, a work's
`composition` or `publication`, a concept's or movement's `emergence`, or the `span` during which
a relationship held. Only span, active and composition last. The chronology explorer lists one
item's dated aspect (Plato's birth) as one row holding all its competing datings, and its filters
show or hide a whole dated aspect, never one of its datings.
_Avoid_: Event type, role; a timeline bar or merged date range for one aspect

**Date expression**:
The one form a dating takes: a point (`at`), a duration (`from`/`to`), a date window
(`notBefore`/`notAfter`), unknown, or a relative dating.
_Avoid_: Date string, parsed date

**Date precision**:
How finely a point is stated: day, month, year, decade or century. A point is read back exactly
as written; nothing rounds, widens or narrows it.
_Avoid_: Accuracy, granularity guessed from text

**Circa**:
A point the party gives as approximate. It is kept beside the point and does not move it.
_Avoid_: Fuzzy date, estimated (when the party did not say so)

**Date window**:
The time inside which something happened, with an inclusive earliest (`notBefore`) and latest
(`notAfter`) point; an open end is what "after" or "before" a date means.
_Avoid_: Range (ambiguous with a duration), terminus as a stored word

**Unknown date**:
A party's explicit statement that a date is unknown. It is never coerced to a point and sorts
after every dated item; having no dating at all simply means undated.
_Avoid_: Null date, year 0, a placeholder year

**Competing datings**:
Two or more datings of the same aspect, by different parties or as one party's alternatives.
They stand side by side in file order; nothing prefers, merges or resolves them.
_Avoid_: Correct date, consensus date, resolved date

**Relative dating**:
A dating that places an aspect before, after or during another entry's aspect. It is the atlas's
only temporal relationship: asserted and cited like any dating, never inferred from absolute
dates, and never a relationship kind or a reason for one.
_Avoid_: Preceded or contemporary-of relationship; order inferred from years

**Calendar policy**:
Years are historical BCE/CE years with no year 0. A month and day may name the calendar they
are stated in (Gregorian or Julian); nothing converts calendars, and points in different
calendars are compared by year only.
_Avoid_: Normalized date, proleptic conversion

**Projected dating**:
An approved, cited dating with no notebook passage whose entry or relationship is published and,
if relative, whose other entry is approved. Anything else stays private and is reported as a
notice, never refused.
_Avoid_: Public date; approved dating when its owner may be private

**Chronology index**:
Every dating of the atlas, private or approved, placed by the entry or relationship it dates, by
aspect and on one timeline, in one deterministic display order that does not depend on file
order. Competing, circa, relative and unknown datings are all kept; nothing is chosen, merged or
linked by closeness in time. It is for the author's tools and is never published.
_Avoid_: Canonical timeline, resolved dates, contemporaries

**Chronology prompt**:
A structural, non-blocking notice that some recorded datings cannot all hold as stated, such as a
death dated before a birth or relative datings ordering two works both ways round. It names
dating ids and their stated values, asks the author to check them against the cited evidence, and
never says which dating is right; only relationships and relative datings someone asserted are
followed across entries.
_Avoid_: Chronology error, conflict resolution, verdict, inferred influence

**Chronology explorer**:
Admin Studio's text view of the chronology index: dated aspects in one display order, grouped by
century, decade or year at the author's choice, with relative datings as sentences and
chronology prompts as checks that link to the dating. It is lists and words only, private to the
author, and never resolves or ranks datings.
_Avoid_: Timeline chart, canonical chronology, zoomable graph

**Atlas projection**:
The one public form of the Knowledge Atlas: approved entries and projected relationships, each
reduced to an explicit allowlist of fields, with the public description of the sources they use.
Both the atlas pages and `atlas.json` are rendered from it, and nothing public reads the private
atlas. Withdrawing approval removes an item from the next build.
_Avoid_: Public atlas export, public graph; filtering the private atlas per surface

**Atlas query projection**:
The bounded, deterministic reading of the atlas projection that components and search use,
`atlas-query.json`: entry previews, relationships in their stored direction with who asserts them,
confidence, standing, uncertainty and sources, and a term lookup. It is derived from the atlas
projection alone, so a query cannot reach anything that is not published, and it is refused whole
over a size bound rather than cut. It is listed in the publication boundary like any projection
(ADRs 0168, 0169).
_Avoid_: Graph API, public search index, a second atlas; querying the private atlas

**Landing page**:
The home page when the site has a `content/landing.json`: an ordered list of landing sections the owner
arranges instead of the fixed intro, post list and series. Without the file the home page is built from
`home.heading`, `home.intro` and `home.showSeries` exactly as before, and the file maps to and from them
losslessly. It is versioned; a file from a newer release is never overwritten (ADR 0245).
_Avoid_: Homepage template, page builder, layout file

**Landing section**:
One typed, validated piece of the landing page (welcome banner, rich text, latest posts, series, featured
post, buttons, image, video, map, opening hours, contact, social links, FAQ, call-out) with a stable id and a
`hidden` flag. It is data the engine renders and escapes. There is no HTML section, and its Markdown is read
with raw HTML disabled, so markup typed into it shows as text (ADR 0245).
_Avoid_: Widget, block, embed, custom HTML

**Piece**:
One of nine small structured things (button, image with caption, video, map, opening hours, contact details,
social links, questions and answers, call-out) added with a form to a post or to the landing page. It is
validated data with one form schema shared by both places; in a post it is Markdown (a `> [!NOTE]` call-out, or a ```` ```piece <kind> ````
fence of `field: value` lines), and a video or map is a privacy-enhanced, lazy, titled
frame with a link beside it that becomes only the link in a portable export (ADR 0253).
_Avoid_: Widget, shortcode, embed code, custom HTML

**Landing page builder**:
The Admin view at `#/landing` where an owner changes the landing page without code: sections are cards with
Edit, Move up, Move down, Hide or Show and Delete buttons, added from a picker that describes each type in
plain words, and edited in a plain form. Nothing is written until Save, a deletion can be undone, and no field
takes HTML or CSS (ADR 0249).
_Avoid_: Page editor, theme editor, drag-and-drop designer

**Landing preview**:
The home page as the build would make it from the sections in the builder, saved or not, shown in a
script-free sandboxed frame in Phone, Tablet and Desktop sizes. It is built in memory by the production
renderer and never writes, saves or publishes (ADR 0250).
_Avoid_: Draft site, staging page, live edit

**Landing draft**:
The unsaved landing page changes the builder keeps on the owner's device (or in memory for the visit when the
device will not keep them), with the revision they were based on. It is offered back as "Restore your unsaved
changes", never applied unasked, and cleared by a save. A save that finds a newer stored page is a choice
between Keep mine, Use the newer version and Compare, never an overwrite (ADR 0252).
_Avoid_: Autosave, backup, sync

**Reading path**:
An author's own ordered list of published posts and Knowledge Atlas entries, kept as
`content/paths/<slug>.json`, with a rationale per step and an author-written transition from each step
to the one before. It is its own content type: it never changes a post or a series, a post may be in
several, and a series is not a step. It is one line of steps with no branches, no repeated target and
no path inside a path; a draft is never published (ADRs 0207-0209).
_Avoid_: Series, playlist, curriculum, learning journey, recommendation

**Path step**:
One place in a reading path: a stable id, a target (a published post or atlas entry), an optional
rationale, prerequisite note, difficulty and `optional` flag, and, after the first, a transition. A step
whose target is not published is left out of the public path and named to the author only, as
the same sentence whether it is a draft, private or missing (ADR 0211).
_Avoid_: Lesson, chapter, module

**Path transition**:
What an author writes to say why a step follows the one before it: required text and a relationship
from a closed list with no default (`next` claims order only). It is about the step it follows, the
nearest earlier step that is not optional. `influenced` joins two atlas entries and is kept only with
a published, uncontested atlas influence from the followed entry to this one; order and dates never
imply it, and a path that would lose a transition is withheld whole (ADR 0210, ADR 0211).
_Avoid_: Link, edge, influence chain

**Path editor**:
Admin Studio's place to curate reading paths (`#/paths`): it offers only published posts and public atlas
entries, marks a step that is no longer published as one readers will not see, requires a relationship and the
author's own reason for every step after the first, reorders by Move up and Move down, and previews the one
public projection. Saves name the revision read and are written atomically in canonical form (ADRs 0213, 0214).
_Avoid_: Path builder, drag-and-drop curation

**Public reading paths**:
The allowlisted, deterministic projection of published paths (`openblog-reading-paths`) that later pages,
discovery and export share, resolved against the published posts and public atlas alone (ADR 0212).
_Avoid_: Path index, recommendation feed

**Path page**:
`/paths/<slug>/`, the static page of one published reading path: an ordered list of its shown steps, each
linking to its post or atlas entry with the author's transition, rationale, previous and next links, and
no JavaScript needed. `/paths/` lists only paths marked listed (ADR 0215).
_Avoid_: Lesson, course, playlist

**Path progress**:
A reader's optional marks of which path steps they have read, kept as step targets in their own browser by
`<ob-reading-path>` and nowhere else. It can be reset, never changes what the page says, never counts an
optional step toward finishing and is not sent to anyone (ADR 0215).
_Avoid_: Completion, certificate, enrolment, tracking

**Path discovery**:
The ways a reader or tool finds a published reading path: a "Part of a reading path" link on a post or atlas
entry that is a step of it, an entry in site search, and `paths.json`. All three, and `/paths/` and the
sitemap, include only listed paths; none changes the order of any post, and feeds never carry a path
(ADR 0216).
_Avoid_: Recommendation, related posts, trending

**Path export**:
`openblog paths export`'s single deterministic file of the author's path files, which `openblog paths import`
checks as a whole and writes all-or-nothing, never replacing a different stored path without `--overwrite`
(ADR 0217).
_Avoid_: Backup, sync, migration

**Concept link**:
An author's explicit Markdown link to `atlas:<entry id>` in a post. The build resolves it against
the public atlas projection alone: a published entry becomes an ordinary link to its page, and
anything else (a malformed id, an unknown, unapproved or withdrawn entry, or an atlas that is not
published) becomes the label as plain text with a diagnostic for the author. Prose is never scanned,
so only the occurrences the author links are linked, and a copy that leaves the site keeps the words
without the link (ADR 0172). It is underlined with dots and read as "(atlas entry)" (ADR 0173),
and an `atlas:` link in an image description, a page, a series description or the home introduction
is its label with a warning, never an address.
_Avoid_: Automatic link, auto-link, entity recognition, wiki link

**Entry preview**:
The short card a progressive component shows beside a concept link: the entry's type, the line that
it comes from the author's approved atlas, the first paragraph of its summary, a work's source and
up to two relationships with who asserts them, how firmly and what is uncertain. It reads the public
`atlas-query.json` alone and shows its wording unchanged; without JavaScript, or if the file cannot
be read, the link is an ordinary link to the entry's page (ADR 0174).
_Avoid_: Tooltip, hover card, entry summary popup, atlas widget

**Atlas trail**:
A bounded walk over published relationships from one entry, across either direction, each
relationship crossed once so a cycle ends it. It lists the steps and nothing more: not a path of
influence, a ranking or an inferred relationship (ADR 0170). An entry page renders it as a static
ordered list in which every step shows its relationship in the direction it was stated, which way
the walk crossed it, who asserts it, how firmly, its evidence and its uncertainty, and a step that
returns to an entry already on the trail says so instead of continuing; only script adds filters
(ADR 0175).
_Avoid_: Influence chain, shortest path, recommendation, graph view

**Preview clip**:
The cut of an entry's first summary paragraph, or of a relationship's stated doubt, to the query
projection's text limit, always flagged `previewClipped` or `uncertaintyClipped` so a reader is
sent to the page for the whole (ADR 0169).
_Avoid_: Summary, excerpt without a flag

**Published dating**:
A projected dating as the atlas projection publishes it: who dates what, on which cited evidence,
how firmly and with what note, at the precision stated and read back in words with BCE written
out. Competing published datings appear side by side, in the chronology's one order, and none is
preferred.
_Avoid_: Public date, the date of an entry, resolved date

**Public timeline**:
The `/atlas/` section that lists every published dating as text, by the century in which each
dated aspect's earliest dating begins, with aspects not placed in time listed apart. It reads
completely without JavaScript; its component only filters whole dated aspects and moves focus to
a period. Order on it never means cause or influence.
_Avoid_: Timeline chart, canonical chronology, contemporaries list

**Chronology trail**:
The path a reader follows from one entry to another through published relative datings, one
asserted, attributed and cited step at a time, each linked both ways. Nothing chains steps, infers
an order from dates, or turns a step into a relationship.
_Avoid_: Influence chain, inferred sequence, derived timeline

**Atlas publication switch**:
The site setting `knowledgeAtlas.publish`. Off by default, when no build reads the atlas at all;
on, the build publishes the atlas projection. Item approval is still required for each item.
_Avoid_: Treating approval alone as publication

**Atlas revision**:
The fingerprint of the Knowledge Atlas as stored, which every change must name so that a change
based on an older read is refused instead of overwriting newer work.
_Avoid_: Version, which names the file format

**Relationship explorer**:
The Admin list of one entry's relationships, outgoing and incoming, each read from that entry's
side with who asserts it, its confidence, standing, evidence and uncertainty. It is the complete
interface to the atlas's structure; any drawing could only repeat it.
_Avoid_: Graph view, network map; a picture as the only way to read relationships

**Incident reading**:
How a relationship reads from one of its entries: its kind going out (`authored`), its inverse
label coming in (`authored by`). A label for display, never a second stored assertion.
_Avoid_: Reverse edge, inferred relationship

**Claim**:
A statement made in one draft post, optionally anchored to a UTF-8 byte span of its anchor text.
It is private until the author approves it and carries no truth value.
_Avoid_: Fact, finding; treating a cited sentence as a claim automatically

**Anchor text**:
The text a claim anchor indexes: the post body after a leading byte-order mark and the front
matter are removed, with every CRLF folded to LF and then any leading line breaks dropped, so the
blank line Admin's save writes after the front matter counts for nothing. Offsets are UTF-8 bytes
into it.
_Avoid_: Offsets into the raw file, character or UTF-16 offsets

**Evidence link**:
The author's recorded relation (supports, contradicts or contextualizes) between one claim and one
source, with optional locators and notebook passage, rationale, uncertainty, review state and
provenance. A citation alone is not one.
_Avoid_: Citation, proof, verdict; defaulting a relation to supports

**Projected evidence link**:
An approved link on an approved claim with no private passage and, if it supports the claim, no
private contradicting link beside it. Anything else stays private and is reported as a notice,
never refused, so withdrawing consent is an ordinary edit.
_Avoid_: Public link, approved link when its claim or a contradiction may be private

**Claim anchor check**:
Comparing a claim's recorded span with the current anchor text: verified, moved, stale or
ambiguous. It reports and never repairs.
_Avoid_: Auto-relocation

**Evidence gap**:
A finding about what a claim's record lacks or what only the author can check: no evidence,
contradicting evidence the post may not address, only support for a claim marked uncertain, an
archived source or passage, a missing location or rationale, an unchecked location, an
unreviewed suggestion, or words no longer where they were anchored. It is a prompt with a next
action, in the same finding contract as citation checks, and never a verdict on truth.
_Avoid_: Evidence score, weak claim, unsupported claim, verification

**Saved draft**:
A post's text as stored in its file, which every claim anchor is checked against. Unsaved editor
text never is; the author saves the post before anchoring a claim in new words.
_Avoid_: Editor buffer, live text

**Re-anchor**:
The author choosing a claim's words again in the saved draft, after they moved, went stale or
became ambiguous. Evidence cannot be added to a stale or ambiguous claim until it is re-anchored.
_Avoid_: Auto-fix, relocation by the software

**Claim evidence projection**:
The one public form of a post's claims: approved claims and projected evidence links, each
reduced to an explicit allowlist of fields, with the public description of the sources they cite.
It is published as a section of the post's publication Markdown and as `claim-evidence.json`;
supporting and contradicting evidence sit side by side under each claim and are never combined.
Withdrawing approval removes an item from the next build.
_Avoid_: Public claims export, verdict, fact check; filtering the private claims file per surface

**Claim evidence publication switch**:
The site setting `claimEvidence.publish`. Off by default, when no build reads the claims file and
every post is published as before; on, the build publishes the claim evidence projection. Approval
is still required for each claim and each link.
_Avoid_: Treating approval alone as publication

**Evidence revision note**:
A dated public note, written by the author in a post's front matter (`evidenceRevisions`), saying
how the post's evidence changed, optionally naming one claim. It is versioned with the post, so
removing private research or withdrawing a claim never removes it.
_Avoid_: Changelog entry, correction notice from a reader; storing the note in private research

## Research completeness

These terms describe how every research check is gathered into one contract before publication.
They never describe whether a work is true, credible, agreed or fit to publish.

**Research completeness finding**:
Any finding, notice, prompt or diagnostic of a research check, described in one shape: its owning
validator, check, own code, category, outcome (detected, potential or needs-review), gate, the one
object it is scoped to, related objects, its validator's message and a repair. Mapping into it
changes nothing a check reports or where.
_Avoid_: Readiness score, issue, verdict; renaming a check's code

**Owning validator**:
The one core check function that reports a given check. Every check has exactly one; presentations
such as Admin, the CLI and the readiness report gather findings and own none.
_Avoid_: Treating Admin or a report as a second validator

**Finding category**:
What kind of gap or prompt a finding is (integrity, public boundary, structure, reference,
identifier, version, locator, citation, claim anchor, evidence, provenance, chronology, rights).
Categories group findings and never rank them.
_Avoid_: Severity, priority

**Finding gate**:
What the owning validator does about a finding: advisory (nothing is refused), refuses when
published (a post publishing the citation is refused), withholds (a stale approval leaves one
comparison out of the build and cannot be acknowledged), or refuses (the save or build is
refused). Only deterministic integrity and privacy failures refuse; potential and needs-review
findings are always advisory.
_Avoid_: Blocking review, mandatory resolution

**Research readiness report**:
The one report of what every research check says about the site as the next build would publish
it: the contract's findings in its one order, grouped by what the build refuses and then by
outcome, counted apart, with the author's acknowledgements matched. Admin (What will be public,
What this post makes public, the Research panel beside a draft), `openblog check` (also as
`--json`), `openblog build` and the preview that serves a build all show it with the same codes in
the same order (ADR 0150). It is prompts, never a verdict: it has no score, and only a failure of
a private file the build reads stops a build, before any public file is written.
_Avoid_: Readiness score, pass or fail, completeness percentage

**Finding acknowledgement**:
An author's record that they have considered an advisory finding. It names the finding's key and
fingerprint, never makes the finding resolved, is counted apart from what was found, and goes
stale when what the finding says changes.
_Avoid_: Dismissal, resolution, waiver; acknowledging an integrity or privacy failure

**Finding fingerprint**:
A digest of a finding's validator, code, object, file, id, field, related objects and the
structured facts its validator states for that code (cited keys and locators, source and passage
ids, identifier values, stated dates), never its message, lines or positions, so it changes
exactly when what the finding is about changes and not when text moves or wording is edited.
_Avoid_: Finding id, revision; hashing the message

**Source review**:
The validator that prompts about identifiers two records share or one record holds twice,
version details a citation, passage or record leaves out (a volume, a translator, a witness's
shelfmark), quotations without a narrow location, and posts that cite one source under two
records or several versions of one work. Every prompt is advisory and offline, and none says
whether a source or quotation is accurate.
_Avoid_: Fact check, quotation verification, metadata repair

**Quotation**:
For source review, a citation inside or directly after a block quotation, a citation directly
after quoted words, or a notebook passage. A quotation needs a location in its source; whether
the words are there is only ever for a person to check. A GitHub-style alert is not one.
_Avoid_: Excerpt check, verified quote

**Identifier comparison key**:
The form two identifiers are compared in (a DOI case-folded in its resolver form, an ISBN-10 as
its ISBN-13, a PMCID with its prefix upper-cased). It is only compared, never written back: the
record keeps the identifier as written.
_Avoid_: Normalizing, deduplicating, merging

## Curated research context

These terms describe how an author chooses which already-publishable research context readers are
given. They never describe whether research is true, agreed or fit to publish.

**Curated selection**:
The author's explicit choice of one publishable research item (or their own attributed words about
one), kept in the private `selections.json` with the revision it was made against and the public
fields it lists. A selection is one more projection under the publication boundary: it adds no
approval, and publishes nothing the atlas, comparison and citation projections do not.
_Avoid_: Approval, publishing a note, a second atlas

**Selection kind**:
What a selection selects: reference, contextual entry, relationship, timeline (one dating),
comparison, source annotation or explanation. The kinds keep the research model's distinctions
(work, edition, translation, witness, reference, citation, claim, evidence, interpretation,
contextual entry) apart; selecting a work never selects its versions.
_Avoid_: Treating a reference as a citation, a note as an annotation

**Selected revision**:
The fingerprint of the selected public item and of the public context it brings, recorded when it
was selected. When it no longer matches, the selection is stale and is withheld until the author
checks the item and selects it again.
_Avoid_: Auto-updating a selection, publishing the old version

**Selected fields**:
The public fields a selection lists. Each kind always lists its attribution, uncertainty and
evidence (a relationship always carries who asserts it, how firmly, on what evidence, and who
disputes it); the rest are chosen one by one.
_Avoid_: Dropping a dispute or a doubt to make a selection shorter

**Context item**:
An approved dependency published with a selection so a reader can understand it: a relationship's
endpoint entries and cited sources, a dating's owner, a comparison's versions. It is the minimum
the projections already publish and says which selections need it.
_Avoid_: Publishing everything linked from a selection

**Selection provenance**:
Where the selected metadata came from, as the author states it: authored, imported (from a named
origin) or unrecorded. Never inferred; a detail the source lacks is listed as missing, not filled.
_Avoid_: Defaulting to authored, placeholder values

**Withdrawn selection**:
A selection the author withdrew: the record stays, nothing is published, and selecting it again
records the current revision. Unselecting removes the record. Neither changes the research.
_Avoid_: Deleting research to withdraw it

**Selection requirement**:
A selection that must be published with another (at most 32). A withheld or unknown requirement
withholds the dependant, however far back the chain goes; a cycle withholds every selection on it.
Each failure is scoped to its selection.
_Avoid_: Cascading deletes

**Public source**:
A source that is already public: cited by a published post, or published by the atlas or a
comparison. Only a public source can be selected as a reference or annotated, so selecting never
approves a source the library merely holds.
_Avoid_: Treating a library source as public because it exists

**Selection scope**:
Whom a selection is offered to: named published posts (`posts`), or the whole site when it names
none, with optional `positions` (post slug to place) that order it among each post's items. A post's
order is its own: ordering one post never moves an item in another, even a whole-site item both are
offered. A record without them is for the whole site and unplaced. Only a published post is ever
named in a public value; a draft previews as if it were published, labelled so, and the build does not.
_Avoid_: Naming a draft, ordering by id alone, one number shared by every post

**Selected for readers**:
The section of the draft-side research panel where an author chooses, orders, withdraws and
unselects research context for a post, and previews exactly what readers get. It lives in the
Research panel; it is not a second panel or a second preview.
_Avoid_: A curation page, a second approval

**Selection notice**:
A caveat that travels with a published curated item: a competing dating that is published but not
selected, a selected detail the source lacks, or metadata whose origin is not recorded. A competing
dating is also a `boundary:` warning. Never a judgement of the research.
_Avoid_: Hiding a rival dating, filling in a missing detail

**Portable research context**:
The research-context section as a portable copy (HTML, Markdown, text, feed, syndicated copy) writes it:
labeled sequential sections from the one public curated value, with links to the canonical section and
each item's anchor, and a diagnostic for what the format cannot carry. A copy that would lose a selected
fact is refused for that post alone.

**Curated context file**:
`curated-context.json`: the versioned public data file projected from the one public curated value,
holding each published selection with its attribution, doubt, evidence, provenance and selected
revision, the context it needs, and for each published post its items in that post's order with a
canonical anchor for each. It is written only while the site publishes at least one selection, is
bounded and refused whole when over a bound, and names nothing a reader's tool could query for more
(ADRs 0197, 0200).
_Avoid_: A query API, an export of the selections file

**Research context section**:
The static section of a post's page (`#research-context`) that renders the same public value for readers
without JavaScript: a heading, an ordered list of attributed items with an anchor each (`#curated-` and
the selection id), and a list of what they refer to. Authored text in it is text (ADR 0198).
_Avoid_: A widget, a sidebar, a second page

## Reader participation

These terms describe how readers point at published text, where their feedback came from, and
the one policy that governs everything readers and authors add to a published post (ADRs 0101 to
0104).
Reader data is never research: a notebook **Passage** is an author's excerpt of a source, while a
**Passage target** points into a published post.

**Passage text**:
A post's published prose as a reader can quote it, section by section: the text before the first
heading, then each heading's id with its title and the text up to the next heading. Generated
markers, labels, image alternative text, raw HTML, embed frames, code blocks and the generated
citation notes are not part of it; only whitespace is normalized. The build publishes it as page
data; the browser maps a selection onto it rather than reading the page.
_Avoid_: Plain text, search text, body when the quotable published text is meant

**Passage revision**:
The fingerprint of a post's passage text, written `p1:` and 32 hex digits, whose number names the
text model. Feedback records the passage revision the reader saw.
_Avoid_: Version, commit, notebook revision

**Section digest**:
The fingerprint of one section's passage text, so a target for a whole section can tell an
unchanged section from an edited one.
_Avoid_: Section id, hash of the Markdown

**Passage target**:
A durable, versioned pointer at published text: the whole post, or a section anchor (the heading
id) and either the whole section, optionally with its digest, or a quotation of at most 500
characters with up to 64 characters of context on each side and a position hint. Never a
positional element id.
_Avoid_: Passage (the notebook term), anchor, highlight, marker id, selector when the whole
target is meant

**Target resolution**:
The outcome of reading a passage target against the current passage text: current (seen at this
revision, text in place), re-anchored (the identical text found again, uniquely, as the same
passage) or stale with a reason. It never points at text the reader did not quote.
_Avoid_: Fuzzy match, retargeting, best guess

**Feedback provenance**:
Where one piece of reader feedback came from: the published work, the passage revision the
reader saw, the passage target, when the reader saw it by their own clock, when the site received
it, the channel and the reader's attribution choice. Reader data, never a research note.
_Avoid_: Metadata, submission log, research note, audit trail when moderation decisions are meant

**Reader attribution**:
The name a reader optionally gives with feedback and their explicit agreement to show it. Without
that agreement the name is private to moderation; anonymous is the default.
_Avoid_: Author, contributor, credit, account

**Suggestion credit**:
The name a suggestion's reader agreed to be credited by for the text as it stands (ADR 0167): bound to
the text revision they agreed it for, so a clarification that changes the text or a changed consent
leaves it unoffered until they agree again by their receipt. It is shown only in Admin's link view and
nothing publishes it; withdrawal and retention remove it.
_Avoid_: Public credit, Work credit, thanks

**Public provenance**:
The only public form of feedback provenance: the work, the revision seen, the day received,
whether the passage is stale, its section, the quoted text only while it is still published, and
a name only with consent.
_Avoid_: Feedback export, moderation record

**Feedback kind**:
What a reader says they are offering about a passage: a question, a suggested source, a suggested
correction or another interpretation. The reader's stated intent, never a verdict: a suggested
correction is not a correction until an author decides.
_Avoid_: Correction (for a submission), category, vote, rating

**Feedback submission**:
What a reader sends: the kind, the work, the passage revision seen, the passage target, the text,
the kind's details (a source link, suggested wording) and the reader's attribution choice. Nothing
else about the reader.
_Avoid_: Comment, message, report

**Scholarly feedback record**:
A received submission: its kind, text and details with the feedback provenance, including when the
receiver got it and by which channel. Reader data, never research, and never published except
through its public projection after moderation.
_Avoid_: Comment row, research note, correction

**Hosted feedback transport**:
The optional, opt-in path that carries feedback submissions to the site's hosted function and
stores them pending moderation. Without it, the canonical page and a copy-and-send fallback
remain.
_Avoid_: Feedback service, comment system, backend when the opt-in path is meant

**Passage data**:
A post's passage text as page data, built by the build: the work, the passage revision and each
section's index, anchor, heading title, text and digest, in one inert JSON element. Only an open
post on a site that opts in to feedback carries it; the browser maps selections onto it and never
re-derives text from the page (ADRs 0076, 0082).
_Avoid_: Page text, DOM text, scraped text

**Feedback region**:
The section after a post's navigation where a reader sends a passage-specific note. Its static
text tells a reader without JavaScript how to name a passage and reach the author; the feedback
form enhances it, and a failed submission falls back to a copy of the note to send (ADR 0082).
_Avoid_: Comment box, discussion when the hosted comments are meant

**Feedback moderation**:
A moderator's decision about one feedback item, taken in the moderation inbox: approve, ask to
clarify, reject or remove with a reason, or reopen, in the participation policy's state names
(pending, clarification, approved, rejected, removed, withdrawn). Each change names the state and
version the moderator saw and is recorded as an audit event; approval never edits the post (ADRs
0083, 0105).
_Avoid_: Accepting a correction, verdict, review when a moderation decision is meant

**Passage check**:
What a moderator sees about a feedback item's passage before acting: current, re-anchored after
the post changed, stale with its reason, or no post at that address. Approving anything but a
current passage needs the moderator to confirm the check they read (ADR 0083).
_Avoid_: Fuzzy match, auto-fix

**Published reader feedback**:
The public part of approved feedback, kept in `reader-feedback.json` in the content folder: the
kind, text, details, target and revision seen, the days received and approved, a name only with
consent, and the author's response. Shown on the post's canonical page only, through the public
provenance; portable copies and feeds carry a labelled link instead (ADR 0083).
_Avoid_: Comments, feedback export, moderation record

**Participation kind**:
One entry in the closed registry of ways to participate: comment, question, suggested source,
suggested correction, another interpretation, Third Perspective, author response, abuse report or
future suggestion. Each has fixed rules: who creates it, what it targets, whether an approved item may
be shown (a future suggestion's approval admits it to the editors' queue instead), and whether a
moderator may ask its submitter to clarify. Every kind but comments starts `off`.
_Avoid_: Comment type, feedback type, category (a Third Perspective prompt), channel

**Participation mode**:
How one kind behaves on one post: `hidden` (nothing shown or accepted), `locked` (approved items
shown, nothing accepted) or `open` (approved items shown, new items accepted pending moderation).
The comment modes, applied to every kind; resolved from the site setting and the post's front
matter by one resolver.
_Avoid_: Comment policy when a kind other than comments is meant, visibility, status

**Site participation setting**:
A kind's value in `participation.kinds`: `off`, `follow-comments`, or the default mode for posts
that do not name the kind. `off` cannot be overridden by a post.
_Avoid_: Feature flag, opt-in when the per-post mode is meant

**Participation item**:
One stored submission of any kind, with its moderation state, version, revision and the text it
carries. Reader data, never research and never an author's contribution.
_Avoid_: Comment (unless the kind is comment), post, contribution, message

**Moderation state**:
Where an item is: pending, clarification requested, approved, rejected, removed or withdrawn.
Every item starts pending; only approved, at its current revision, can be public.
_Avoid_: Status when the comment column's three values are meant, published, visible

**Clarification request**:
A moderator's request, with a reason and only with the submitter's clarification consent, that a
submitter revise an item. The revision it asks about is never approved or published, even after
the item is rejected, expires or is reopened (reopening returns it to clarification); only the
answer, which replaces the text as a new revision and returns to pending, can be. Never sent by
e-mail.
_Avoid_: Reply, comment thread, rejection with feedback

**Clarification consent**:
A submitter's agreement, given when submitting, to be asked to clarify. Without it a moderator can
only approve or reject.
_Avoid_: Contact consent, publication consent, feature consent

**Removal**:
Taking an approved item out of public view, with a reason, by a moderator or by an upheld abuse
report. Distinct from rejection (never approved) and withdrawal (by the submitter).
_Avoid_: Deletion, purge, unpublish when retention is meant

**Withdrawal**:
A submitter taking back their own item, pending, in clarification or approved. Final: a withdrawn
item is never reopened, and its text is purged at once.
_Avoid_: Removal, retraction by the author, consent change for display only

**Abuse report**:
A reader's report that a public item is abusive. Never public, never counted, and never changes
its target by itself; upholding it removes the target in the same decision or changes nothing.
_Avoid_: Flag, vote, downvote, complaint

**Author response**:
An author's public reply to one approved item, written by the site Admin, a coordinator or a
contributing author of the work. A response to a published note is stored with it in
`reader-feedback.json` and shown under it (ADR 0083); a response kept as its own participation
item starts pending like everything else. Replying sends nothing to the reader.
_Avoid_: Revision note, correction, comment by the author, reply notification

**Captcha challenge**:
The optional human check a reader passes before commenting on a hosted site (ADR 0322). The browser loads
the provider's script only when the reader first clicks or types in the comment form; the server, never
the browser, decides whether the result is valid. It guards comment submission only, never reading,
reports or analytics, and the local `openblog serve` comment store does not use it.
_Avoid_: Captcha (for the pass), bot check, login

**Session pass**:
A signed, stateless proof that one captcha challenge was passed for this site, valid for 30 minutes by
default (`OPENBLOG_CAPTCHA_SESSION_TTL_SECONDS`). The browser keeps it in `sessionStorage`, so it ends with the
tab. It is not a reader identity and authorizes nothing except comment submissions on the same site; with
`every-comment` scope none is issued. Passes cannot be individually revoked: rotate the signing secret.
_Avoid_: Session, token (that is the provider's single-use challenge result), cookie, login

**Moderator**:
The site Admin, or a coordinator for the works of their publications. Contributing authors read
and respond but do not moderate; readers act only on their own items as submitters.
_Avoid_: Admin user when a publication coordinator is meant, editor, owner

**Site Admin (moderation)**:
The hosted moderation token, or an Admin session acting on a work outside every shared publication
in which that account holds a binding. On a shared work a bound co-writer is that publication's
coordinator (site owners included) or contributing author instead. Only the site Admin and the
submitter see a reader's private name.
_Avoid_: Admin user, site owner (a publication role), owner

**Reason code**:
The ground for a moderation decision, such as spam, abusive, personal data, off topic, duplicate,
rights, unclear or needs source. Never a verdict on whether a reader was right.
_Avoid_: Verdict, label, rating, "incorrect"

**Moderation audit event**:
The private record of one submission, transition or purge: item, kind, action, states, actor role,
the Admin account where there is one, reason, time, revision and version. It never holds text or
anything identifying a reader, and it outlives purged text.
_Avoid_: Feedback provenance, log line, history of the text

**Participation retention**:
How long moderation keeps what it does not publish: pending and clarification items expire,
rejected and removed text and upheld abuse reports are purged after a period, withdrawn text at
once, and audit events last longer than any text. Comments are covered only once the site sets
`participation.retention` itself.
_Avoid_: Archive, backup, analytics retention

**Moderation inbox**:
Admin's one list of every hosted participation item, comments and passage feedback today, by
state and kind, oldest first. Each item is shown, and offered the decisions the one policy accepts
now, for the role the signed-in account has on that item's work; an item it may not see is left
out and never counted (ADR 0105).
_Avoid_: Comment moderation, Reader feedback view, queue when the whole inbox is meant

**Inbox decision**:
Approve, ask to clarify, reject, remove or reopen one item, naming the state and version the
moderator loaded. Admin and the hosted function each decide it with the same rules before one
conditional write records it with its audit event (ADR 0105).
_Avoid_: Status change, bulk action, verdict

**Reader receipt**:
A random secret the hosted function returns once when it takes a reader's note, kept only as its
digest. Holding it is the only proof of submission: with it the reader reads the note, agrees to
be asked to clarify, answers a clarification request, or withdraws the note. Comments and abuse
reports get none (ADR 0107).
_Avoid_: Account, login, confirmation e-mail, ticket number

**Deletion request**:
A request that an item's text, details and name be deleted now, by its submitter's receipt (which
withdraws an open or approved note first) or by the site Admin on an item already closed. Only the
state and an audit trail without text remain (ADR 0107).
_Avoid_: Delete row, unpublish, removal

**Purge**:
Overwriting an item's text, details and reader name, setting when it happened and raising its
version, with a `purge-content` audit event. A purged item is never approved again and takes no
further decision.
_Avoid_: Delete, archive, redact when the text is kept

**Retention run**:
The site Admin's confirmed application of `participation.retention`: a dry run lists what would
expire or be purged and how many audit events are old enough, then the run applies exactly the
items still due as they were. Never scheduled, and never touches comments unless the site set
retention itself (ADR 0108).
_Avoid_: Cron job, cleanup script, automatic purge

**Engagement protection**:
The opt-in hosted schema and switch (`supabase/protection.sql`, `OPENBLOG_PROTECTION_ENABLED`) that
add receipts, stored abuse reports, purging and the retention run, with replay bounds, all
additive and rolled back by `protection-rollback.sql` (ADR 0108).
_Avoid_: Security mode, hardening flag

**Inbox schema**:
The hosted columns, comment audit table and conditional moderation functions every inbox decision
needs, added by `supabase/moderation.sql` and `supabase/feedback.sql` and switched on with
`OPENBLOG_MODERATION_ENABLED`. Without it the inbox offers only what the older schema can store
(ADR 0106).
_Avoid_: Migration (it is additive and optional), new comment system

**Evidence submission**:
A suggested source or suggested correction (the two evidence kinds), optionally with an evidence
block naming the published claim, evidence link, citation or source it concerns. Reader data and
the reader's statement, never evaluated and never a correction until the author decides
(ADR 0116).
_Avoid_: Correction, evidence link, citation, fact check

**Evidence block**:
The `evidence` member of a version 2 feedback submission: the claim, evidence link, citation and
offered source a reader names by the site's public ids, with locators and the reader's stance.
Never an A4 evidence link and never copied into research.
_Avoid_: Evidence (for the author's evidence links), vote, endorsement

**Published references**:
The claims, evidence links and sources one post publishes, the things a reader's evidence block is
checked against (an offered source is checked against the sources the whole site publishes). A
reference outside them reads only as not published here, never as private.
_Avoid_: Claims file, Source Library lookup

**Correction decision**:
The author's recorded conclusion about one evidence submission: an outcome linked to the item,
the post's revision note and, where relevant, the claim evidence link the author recorded. Separate
from moderation; it never edits the post and never changes the reader's record (ADR 0117).
_Avoid_: Moderation, approval, verdict, fact check

**Decision outcome**:
Accepted as a correction, accepted as a clarification, accepted as evidence (each in full or in
part), declined with the author's reason, or already addressed. Only accepted as a correction makes
anything a correction.
_Avoid_: Verdict, rating, true or false

**Decision log**:
Every correction decision about one item, oldest first and numbered from 1. A new decision names
how many it saw and supersedes the last without removing it.
_Avoid_: Overwriting a decision, audit trail when moderation events are meant

**Item standing**:
How a reader's item reads to readers and editors: a question, another interpretation, a proposed source,
a challenged citation or a possible error until the author decides, then the outcome in force. It
depends on the kind, the evidence block and the decision only, never on counts.
_Avoid_: Standing on its own (it collides with claim and relationship standing), status
(moderation), score, consensus

**Public decision**:
The public form of an item's decision in force (outcome, extent, reason, rationale, revision note,
published claim evidence, day), shown only while the reader's item is itself public, and naming
neither the reader nor who decided.
_Avoid_: Correction notice for a private submission, decision export

**Evidence choices**:
What a post's feedback form lets a reader name in an evidence block: the post's published claims
and their published evidence links, the sources it publishes and the sources the site publishes,
each by id and public label. Built from public output only, so a reader picks and never types an id
(ADR 0118).
_Avoid_: Claim search, source lookup

**Duplicate cue**:
A link, on an inbox card, to another item on the same page about the same post that points at the
same passage or names the same claim, evidence link or source. A reason to read them together,
never a count and never a reason to decide.
_Avoid_: Vote, tally, merge

**Record decision**:
The inbox's action for a correction decision, offered beside moderation to the site Admin and the
work's coordinator where the policy and the hosted store allow. It points at a revision note and an
evidence link recorded separately and never edits the post (ADR 0118).
_Avoid_: Approve, publish, correct

**Published outcome**:
What a published suggested source or correction came to, on the post's canonical page and in its
portable copies: the author's decision with its day and rationale, the revision the note was about,
the post's own revision note that records the change and the evidence link the author recorded,
each linked only while the post still publishes it. Carried in `reader-feedback.json` (version 2)
beside the note, and never with who decided or the reader's words in a portable copy (ADR 0119).
_Avoid_: Fact check, verdict, correction notice for a private submission

**Unresolved suggestion**:
A published suggested source or correction the author has not decided, shown, on a site that takes
evidence, as a reader's suggestion and not a settled correction.
_Avoid_: Pending (moderation), disputed, contested

## Admin workspace

**Workspace preferences**:
One admin login's private, schema-versioned presentation choices for Admin Studio: preset,
optional-tool order and visibility, density, and default writing mode. They never change a
document, site configuration, or any public or exported output.
_Avoid_: Settings or configuration when site-wide `openblog.json` behavior is meant

**Workspace preset**:
A named starting arrangement of optional tools (Simple, Guided, Advanced) or Custom, where the
admin chooses each optional tool's visibility. Every preset keeps every capability reachable.
_Avoid_: Mode or role; a preset never grants or removes permissions

**Essential control**:
An Admin control no workspace preference can hide or reorder: Write, Site preview, Settings,
save state, publish status, conflicts, privacy notices, approvals, and blocking validation.
_Avoid_: Default tool, pinned tool

**Research workspace**:
The one Admin destination for an author's research: the Workflow, Sources, Notebook, Atlas and
Compare panels under `#/research/`, with Claims and the Draft beside them (ADR 0120). Its earlier
routes redirect into it. It changes where research is reached, never what is stored or published.
_Avoid_: Research tools, research mode

**Workspace panel**:
One place in the research workspace an author switches between: a research panel or the draft
being written. Each has one canonical address and one visibility label.
_Avoid_: Tab, page, pane (a pane is one view inside the editor)

**Workflow panel**:
The research workspace's first panel and empty state: the steps from a first source to a cited
draft, each saying whether it is done. It reads and never writes.
_Avoid_: Dashboard, onboarding wizard

**Visibility label**:
The words, repeated in data, that say whether a workspace panel is private research (nothing in
it is public because it exists) or publishable (readers see it once it is published).
_Avoid_: Public, shared; a label states what publishing does, not who may read the files

**Kept panel**:
A workspace panel with unsaved changes that the Admin set aside in memory, instead of discarding,
while the author opened another panel; reopening it restores it exactly (ADR 0121). Kept panels
are discarded, after asking, when the author leaves the workspace or signs out, and survive an
expired session only for the same user's next sign-in in that page.
_Avoid_: Autosave, draft recovery; nothing is written anywhere

**Draft-side research panel**:
The narrow, non-modal panel beside a post's writing surface that searches the author's research
and inserts from it: a quotation with its checked citation, a citation, a context link or a
converted note (ADR 0122). It writes nothing but the unsaved draft.
_Avoid_: Research sidebar, inspector

**Context link**:
A link inserted into a draft to a published atlas entry, its published dating, or a published
comparison. It exists only for a page the next build publishes; anything private or unpublished
has no address to link (ADR 0122).
_Avoid_: Reference, related link; a citation names a source, a context link names a page

**Note conversion**:
The author's explicit step that puts a private research note into a draft as their own words,
after confirming it becomes part of the post. It is the only way a note reaches a draft (ADR 0122).
_Avoid_: Publishing a note, copying a note

**Research review before publication**:
What the research checks already say about a post, gathered when the author publishes or
schedules a research or cited post, or asks for it in Evidence Studio: grouped by what blocks the
build, then by outcome, each finding linked to its line, field or research object (ADR 0123). It
uses the research-completeness contract's finding shape and has no score.
_Avoid_: Readiness score, publication check, approval, quality gate

**Blocking finding**:
A finding in the review whose validator refuses the build that would publish the post: a citation
it cannot publish, or an integrity or privacy failure of a private file it reads. Only blocking
findings stop publishing, and they cannot be acknowledged; every other finding is advisory.
_Avoid_: Error, failure, must-fix warning

**Context link check**:
The check that each context link in a post names a page the next build publishes, owned by
`context_links` and reported as `context-link-unpublished` (ADR 0123). A missing page is a gap to
repair, never a privacy failure.
_Avoid_: Broken link check, link validation

**Publication boundary**:
The line between private research and what the public site carries. Nothing crosses it because it
exists: only what a projection publishes, and only the fields that projection copies, are public
(ADR 0125). The build checks its output against it before writing anything: structure refuses, text only
warns outside a projection's machine data.
_Avoid_: Visibility filter, export rules, privacy setting

**What will be public**:
The preview of the publication boundary, for the whole site or one post: what each research
projection publishes, with the fields it copies, what it withholds and why, and what is never
published. It is built from the same projection values the build writes (ADR 0125).
_Avoid_: Publication report, readiness, manifest score

**Withheld reason**:
The rule of a projection that keeps an item, or one field of a published item, private: the
projection is off, the item is not approved, an unsourced draft, a notebook passage, an unpublished
dependency, private contradiction, an unpublished post, a stale approval, an unsafe web address, a
private identifier, the version's rights, length, moved anchor words, or an unpublished page. It is
never a judgement of the research.
_Avoid_: Rejection, error, failed check

**Stale approval**:
An approval that no longer holds because what it rests on changed after it was given: today, an
approved comparison whose notebook passage was re-located after the alignment was saved approved,
which the alignments file records as a fingerprint of the passage's locators. Only a recorded
fingerprint that no longer matches withholds; an approval made before the record existed never
does. The item alone is withheld and named, and the author checks it and chooses *Checked -
approve again*; saving it any other way keeps the recorded places, and the finding cannot be
acknowledged while it withholds (ADR 0125).
_Avoid_: Expired approval, invalid comparison

**Unsafe web address**:
A source's web address the boundary never publishes: not plain `http` or `https`, carrying
credentials, naming a private or local network host (including numeric, mapped, compatible,
6to4, NAT64 and site-local forms), or carrying a query parameter, or a `name=value` fragment
parameter, whose name has a word like key, token, signature or secret (`author` and `sortKey`
do not).
Only the address is withheld; the rest of the reference is published.
_Avoid_: Broken link, invalid URL

**Private text guard**:
The build's heuristic check for text of a private research file in what it publishes. Text is
compared as shingles of six consecutive normalised words, so wrapping, markup, entities, case and
punctuation do not hide it, and generated text is cut at published titles, headings, tag, series
and navigation names, so listing them is no match. What is allowed is the text of the published
posts and pages, the approved projections and the site's own configuration, never a draft. A hit
in a projection's machine data (the atlas, comparisons and claim-evidence JSON, a page's citation
data) refuses the build; a hit anywhere else (pages, feeds, search, static, theme and front-end
files, a portable Markdown export) is a `boundary:` warning naming the output, the file, the
record and the field, never the text, and saying to remove it from the public file or keep it.
Private text of fewer than six words is not guarded by text (ADR 0125).
_Avoid_: Leak scanner, content filter

## Third Perspectives

Readers' own reflections on published works (ADRs 0109 to 0115). They extend the one reader
participation seam as the kind `third-perspective`; they never join the authors' work.

**Reader reflection**:
A reader's own interpretation of a published work, in whatever stage it is: a private draft, a
submitted copy or an approved response. Reader data, never research, never an author's
contribution and never a work credit.
_Avoid_: Comment, review, reply, contribution

**Third Perspective**:
A reader reflection on a shared reflection or a post, about the whole work or one section,
offered for publication. Public only with the reader's consent and a moderator's approval of that
exact text and consent, attributed as the reader chooses or anonymously, and always shown as a
reader's, never as one of the authors' perspectives or as a vote between them.
_Avoid_: Third author, verdict, rebuttal, side, comment

**Response category**:
An optional prompt a reader may pick to frame a reflection: another reading, a connection, from
experience, a question, or putting it to use. It describes the kind of thought, never its worth
or which author it sides with; a reflection without one is complete.
_Avoid_: Rating, score, vote, stance, agree or disagree

**Local reflection**:
A reader's private draft on their own device. It has no id, provenance, consent or moderation
state, and the site holds nothing of it until the reader submits it.
_Avoid_: Pending submission, saved comment

**Submitted copy**:
The site's private copy of a submitted reflection: its current text and revision, its provenance,
its intake and the reader's consent history. Visible only to moderation and the submitter.
_Avoid_: Published reflection, response

**Approved response**:
The one public form of an approved submitted copy, for the canonical page only: the work and
section it is about, whether that section has changed, whether the reader read an earlier
revision, the optional category, the text, the day received and a name only with consent. Never
in the Post, its credits, feeds or portable exports.
_Avoid_: Comment, author perspective, featured reflection

**Featured reflection**:
An approved response an editor chose to feature, covered by the reader's separate feature consent
for that approved revision (Feature consent). Editorial, never chosen by counts, rank or reactions,
and never a consensus claim (RD14, ADR 0176 to 0181). Shown in the Community section with its
provenance and the editors' note, from a Feature record.
_Avoid_: Top reflection, most liked, endorsed reflection

**Submission consent**:
One immutable, numbered record of what a reader agreed to: publication on the canonical page,
the name and whether to show it, being asked to clarify, and which revision may be featured.
Narrowing applies at once, even when the history is nearly full (room is kept for it and for
revocation); showing a name, or another name, is accepted only before a moderator decides;
revoking publication is a final withdrawal.
_Avoid_: Terms acceptance, checkbox state, approval

**Intake**:
How a submitted copy can be acted for: the digest of the private receipt a hosted submitter
holds, or the Admin user who entered a reader's message by hand. Never the receipt itself and
never public. A manual copy has no submitter: revoking it is an Admin removal with an immediate
purge, and it cannot be clarified.
_Avoid_: Account, login, contact details

**Moderation provenance**:
Everything moderation keeps about where a copy came from, whatever the reader shows publicly:
the work and revision read, the target, when it was received, the channel, the name as given and
the intake. Anonymous display never makes it anonymous.
_Avoid_: Public provenance, identity verification

**Moderation decision**:
A moderator's transition of an item in the one moderation state machine, with its private audit
event. Approving a Third Perspective also binds the text revision and the consent record the
moderator reviewed, and always names the moderator.
_Avoid_: Vote, verdict, ruling on who is right

**Continuation**:
A typed link from an approved response to a later published work that took it up (RD15). It never
edits the reflection and never implies that the reflection caused, or is endorsed by, the new work.
_Avoid_: Reply chain, thread, follow-up comment

**Third Perspective region**:
The "Offer a Third Perspective" section of a post where the kind is open: static text that says
how to write to the author without JavaScript, replaced by the form that asks for the reader's
consent explicitly and sends through the hosted service only where it issues receipts. When the
service cannot take it, or the reader does not agree to publish, the reflection is offered as
text to copy and send instead (ADR 0114).
_Avoid_: Comment box, rating widget, reply form

**Perspective consent record**:
A Submission consent as a hosted row keeps it: one numbered entry of `details.consents`, the last
one in effect. A reader changes it only through their receipt, which appends a record and raises
the row's version; an approval stores the number of the record it covered (ADR 0113).
_Avoid_: Consent flag, clarification column

**Published Third Perspective**:
The public part of an approved Third Perspective, kept in `third-perspectives.json` in the content
folder: the post and work, the revision and target the reader wrote about, the optional prompt,
the text, the days received and approved, and a name only while the approved and current consent
show it and it matches no credited name. Written by Admin only while the one projection shows the
copy, re-projected on every build under the kind's published mode, shown on the canonical page
only; portable copies, feeds and `llms` files carry a labelled link instead (ADR 0115).
_Avoid_: Comment, reader feedback, moderation record, export

**Reflection status**:
What a reader learns of their own Third Perspective through its private receipt, and nothing
else: waiting for review (never published), asked to clarify, approved and shown as a reader's
reflection, approved but not shown, not published, or withdrawn. Looked up by the receipt alone,
so it cannot enumerate anyone else's reflection (ADR 0115).
_Avoid_: Public queue, submission list, tracking id

**Attributed section**:
One author's section of a published shared reflection, named by that author's public contributor id
(the registry key in the post's committed credits sidecar), its place among that author's sections
and the digest of its text, never by a side, lane or column. Its anchor is
`ob-by-{contributor}-{nth}`, an ordinary Third Perspective section target, and `ob-by-` is reserved:
no heading takes it. Read from the committed body and credits alone, never from private records
(ADR 0126).
_Avoid_: Left author, right author, column, nth turn on the page

**Attributed target**:
What a Third Perspective about an attributed section stores: the reserved anchor and the required
digest, as one ordinary section target. Resolved by author and text against the sections as
published now: current (perhaps moved), or stale as changed-or-removed, author-absent or
ambiguous, and never pointed at other words or another author (ADR 0127).
_Avoid_: Permalink to a position, retargeting, nearest section

**Author response permission**:
The one grant, `RespondAsAuthor`, that lets a contributor answer a Third Perspective about their
own attributed section: the contributor role on the participant whose binding names the section's
public contributor id, with account, registry key and participant all still current. A contributor
registry entry alone, a coordinator, a site owner, an editor and the moderation token never hold it;
they may moderate the answer but not write it, and nobody approves their own answer (ADR 0128).
_Avoid_: Registry access, author role, impersonation, reply right

**Conversation (on a section)**:
The reader's Third Perspectives about one attributed section, and the author's approved response to
each, shown on the post inside that section's own turn, after the author's words: a labelled
`<aside>` of static HTML (headings h3 to h5, the reader's reflection and the author's response as
separate articles told apart by their headings and labels), at most five reflections per section
(the rest stay in the "Third Perspectives" list, each shown once), with a button that folds a long
one only when script runs. It never changes the author's words, is never ranked or counted, and only
the canonical page carries it (ADRs 0137 to 0139).
_Avoid_: Comment thread, discussion, replies, nested thread

**Published answer**:
An approved author response as `third-perspectives.json` stores it, under the reflection it answers
(`answer`, file version 2 only while one exists): the hosted row's id, the contributor registry key,
the published name, the text and two days, never the participant, the account or a moderator. The
page shows it only where the one rule says so: it and its reflection public in their kinds' modes,
and the responder the contributor the reflection's section is credited to (ADR 0137).
_Avoid_: Reply record, stored answer

**Author section list**:
The build's list of a shared reflection's author sections in its Third Perspective region, written
only where the site opens author responses on the post and the committed body and credits pair: each
section by its anchor, contributor, place, author's published name, first words and digest. A reader
chooses from it by author and place, never by a side (ADR 0131).
_Avoid_: Left/right column picker, section by position

**Answer request**:
The one request Admin sends the hosted function to store an author's answer: the work, the parent
as Admin saw it, the text, and the responder `admit_response` confirmed (public handle, published
name, standing; private participant binding and account). The function reads it strictly, reads the
parent from its own store and stores one pending row; it never holds the private record (ADRs 0132,
0133).
_Avoid_: Reply post, author comment, browser-built answer

**Author answer**:
A response written under that grant: the author's own words as a pending `author-response` that
stores its responder, named by the name the section is published under, shown only while it and the
Third Perspective it answers are both public and its stored responder is the section's contributor,
and never nested or sent to the reader (ADR 0129, 0130).
_Avoid_: Reply thread, discussion, notification

**Feature consent**:
A reader's separate agreement, recorded as `featureRevision` in their Submission consent, that an
editor may feature exactly one text revision of their approved reflection. It is not implied by
approval, by agreeing to publish or by showing a name; it is bound to the revision (and, in a
Feature record, to a digest of the text), so a clarification that changes the text leaves it behind
until the reader explicitly agrees again for the text they see: a change to anything else (a name, being
asked to clarify) carries it forward unchanged and never renews it. Declining takes effect at once; revoking publication ends it for good
(ADR 0176, 0177).
_Avoid_: Terms acceptance, blanket permission, approval

**Feature record**:
An editor's selection of a published reflection, kept as a reference in `community-perspectives.json`:
its id and post, the text revision agreed, a digest of that text, the day featured and an
optional editors' note. It holds none of the reader's words, no name and no editor's name; the page
reads the words and the name from the published reflection, so a name the reader hides is dropped by
republishing that reflection. A reflection has at most one record (ADR 0176, 0177, 0181).
_Avoid_: Copy of a reflection, featured flag, ranking entry

**Community section**:
The one section of a post's canonical page, `ob-community-perspectives`, after the Third Perspectives,
that shows features with the fixed notice that selection is an editorial choice and not a vote or a
consensus. It never counts, ranks or orders by anything but the day featured, and is absent when
nothing is featured (ADR 0180). It is headed "Community perspectives" and is static HTML built from the
one projection, with each item under an `ob-feature-<id>` anchor; portable copies and feeds carry only the
canonical link (ADR 0184).
_Avoid_: Top reflections, community voice, leaderboard

**Feature take-off**:
A feature stops showing and its record is removed because the source is gone, the copy is deleted or
withdrawn, it is no longer approved, the reader declined, the text or name no longer matches what was
agreed. A lost source article only hides it, and restoring the article restores it. It leaves no public
tombstone and no audit action in the hosted store; copies already published may remain (ADR 0178, 0179,
0183). Admin takes one off by choice or when its banner says it must come off.
_Avoid_: Removal notice, tombstone, retraction banner

## Future suggestions

What a reader sends the editors for possible future work (ADRs 0152 to 0157). One more participation
kind, `future-suggestion`, in the one policy; private to the editors and never public.

**Future suggestion**:
A reader's question, text, video, audio recording or other source offered to the editors for
possible future work, with an optional public link, bibliographic hints, a series or article it is
about, the reader's chosen display name and optional contact. Untrusted reader text: it is never a
source, citation, claim or research note, and never public in any state.
_Avoid_: Request, submission to the library, tip, vote, feature request

**Suggestion type**:
What is suggested: a question (words only), a text, a video, an audio recording or another source.
A closed set that describes the form of the thing, never its worth.
_Avoid_: Category, genre, priority

**Editors' queue**:
The private list of future suggestions an editor has accepted. Approving a future suggestion admits
it here and publishes nothing; it is kept while accepted and leaves only when an editor closes it,
the reader withdraws it or retention purges it after it is closed. What is kept is the idea: its
contact and unpublished name are cleared after `closedDays`, or when it is linked to future work
(ADRs 0152, 0155).
_Avoid_: Published suggestions, backlog, roadmap, public wishlist

**Editorial interest**:
All that accepting a future suggestion means: the editors are interested in exploring it. Not
agreement, checking, endorsement, rights clearance or a promise to publish (ADR 0156).
_Avoid_: Approval of the claim, endorsement, verified, cleared

**Suggestion hints**:
The reader's own statement of a suggested source's title, creators, year, publisher and identifiers,
checked for shape only and never fetched or verified. Never a stable source identifier or a citation
(ADR 0153).
_Avoid_: Metadata, source record, citation

**Suggestion contact**:
An optional e-mail address a reader gives with their agreement to be contacted about one
suggestion. Private to the site Admin and the submitter, excluded from audit events, conversions,
library candidates, research notes and debug output, cleared by retention while the suggestion is
kept, and never used by the system to send anything (ADR 0155).
_Avoid_: Subscription, mailing list, account email

**Private identity clearing**:
The retention step (`scrub-identity`) that removes a kept, accepted suggestion's contact and any name
the reader did not agree to show, once `closedDays` have passed since approval or, at the next
retention run, when an author has linked it to future work; it changes nothing else and keeps the
links. A name the reader agreed to show stays (ADRs 0155, 0163).
_Avoid_: Purge, anonymising the idea, deleting the suggestion

**Suggestion standing**:
Where a suggestion is with the editors (received, waiting for the reader, editors are interested,
linked to future work, linked to future work and now closed, not taken forward, withdrawn), derived
from the moderation state and any conversion and never stored as a state of its own. Closing a
suggestion that was already linked is not a decline (ADR 0156).
_Avoid_: Status, ranking, score, popularity

**Duplicate suggestion group**:
Suggestions that share any source key: a DOI by its name whether bare, `doi:` or a resolver link, an
ISBN-10 and its ISBN-13 as one, an ISSN without its hyphen, or the link without scheme, `www.`,
fragment, trailing slash and tracking parameters. Shown to editors as lists of ids so they can be
handled together, only among items that editor may see. Never a count or a signal of demand
(ADR 0156).
_Avoid_: Most requested, trending, vote count

**Conversion**:
A recorded link from an accepted suggestion to a draft, series or Source Library record an author
made from it: the target's id, when and which Admin account recorded it, and nothing of the reader.
Recording one creates nothing, is kept in the row's `details` as `conversions` (no schema change,
at most eight, none twice) with an audit event `convert`, and is never opened or checked
(ADRs 0157, 0162).
_Avoid_: Import, promotion, automatic episode

**Editorial outcome**:
How the editors dealt with a suggestion: held (accepted, not linked), converted (linked, even if
since closed), declined (rejected before it was accepted) or closed (accepted, then removed without a
link). Derived from the moderation state and the links and never stored; undecided and withdrawn
suggestions have none. Never a verdict on the idea (ADR 0163).
_Avoid_: Priority, score, status of the idea

**Receipt standing**:
What a reader's receipt says of their own suggestion: its stage and one honest sentence in the words
of the acceptance notice, with a link described as a record and not a promise. Never a rank, a count,
a promise to publish or what it was linked to (ADR 0163).
_Avoid_: Progress, ranking, roadmap position

**Library candidate**:
The unverified link and hints of an accepted suggestion, offered to its author to copy into a
Source Library record they choose to make. Never the reader's words, name or contact, and never
written to the library by the system (ADR 0157).
_Avoid_: Imported source, pending source, library suggestion

**Suggestion form**:
The one region on a post where the kind is `open`: a progressive Web Component with native controls
that sends a suggestion through the hosted feedback route where the site issues receipts, and
otherwise (offline, closed, off, failing, or no service at all) prepares it to copy and send to the
site's feedback contact. A static site with no service shows only that contact (ADRs 0158, 0159).
_Avoid_: Wishlist, request box, voting widget

**Suggestion route**:
`POST /feedback` with a `future-suggestion` body and the page as the request's `work`, behind
`OPENBLOG_SUGGESTIONS_ENABLED` and the loosened `openblog_feedback_passage_complete` check. Always
pending, with a receipt, five an hour per client, and the same suggestion once an hour (ADR 0158).
_Avoid_: Suggestion endpoint, tip line

**Research note export**:
The author's own, explicit copy of an accepted suggestion into a note of the private research
notebook: labelled unverified reader text with the page it came from, the reader's words and what
they said about the source as quoted statements, and no name, contact or time. It creates no passage,
source, draft or link and changes nothing about the suggestion (ADR 0160).
_Avoid_: Import, conversion, promotion to the library

**Interpretation comparison**:
An author's own public side-by-side of two or more attributed readings of one subject, kept as
`content/comparisons/<slug>.json`, with neutral author-written relations between them and optional
audience explanations. It is its own content type, not a source-library interpretation (which is
private) and not a series. It never rules on which reading is right and has no verdict, score, rank,
consensus or preferred field; a file that holds one is refused (ADRs 0226, 0227).
_Avoid_: Debate, ranking, consensus view, fact check, versus page

**Attributed interpretation**:
One reading inside a comparison: who held it (a named person or tradition, a library source, or an
explicitly anonymous author), its statement, the author's uncertainty note, evidence references and
origin. It may be a translation of another reading of the same comparison. Attribution is required and
its certainty is the author's own (ADR 0227).
_Avoid_: Opinion, take, answer, theory

**Audience explanation**:
An author-written supplement to a comparison or one reading, for one fixed level (`beginner`, `student`,
`scholarly`), one per level per subject. It never replaces canonical prose and is never evidence; the
public value always says it is supplemental (ADR 0228). It may also state its authors, a
prerequisite (advice, never a gate), the reading modes it serves, a language and the explanation it
translates, and it can be withdrawn without being deleted (ADR 0234). On a comparison page the reader's reading mode narrows only explanations that name modes, and standard shows every one (ADR 0235). A portable copy (HTML, Markdown, text) makes every approved level a labelled supplemental section with a canonical link, and is checked against the public value (ADR 0236).
_Avoid_: Simplified version, rewrite, reading level setting, personalisation

**AI draft**:
Text whose `origin` the author states as drafted by a tool. It is labelled as such wherever it appears
and is published only after a person's approval of its exact text; nothing here calls a model
(ADR 0229).
_Avoid_: AI answer, generated explanation, automatic summary

**Comparison approval**:
A person's recorded statement (`by`, `at`, `digest`) that they read exactly this text and accept it.
The digest binds it to the text, so editing the text makes the approval stale until it is given again
(ADR 0229). In Admin only the Approve action records one: a save can keep an approval but never add or
change it, and editing the text withdraws it (ADR 0231).
_Avoid_: Sign-off flag, reviewed, verified

**Level selector**:
The optional control on a published comparison that narrows which explanation level section is shown.
Every level is a section of the page whatever the control does, the quoted evidence sits outside them,
and the control stores nothing (ADR 0232).
_Avoid_: Reading level setting, personalisation, difficulty toggle

## Continuations

How a later work links back to the reader questions that came before it (ADRs 0218 to 0225). Ordinary
links are the whole feature; updates are an optional extra.

**Continuation**:
An editor's typed link from one approved question, reflection or source suggestion to a later published
work that takes it up, kept in `continuations.json` as ids and canonical paths and never a reader's
words, name or contact. It shows only while the submission is approved and both pages are published,
and it never says the submission caused the work or that anyone endorses it. Built into the canonical page
of both ends as a static list of links and managed by the site Admin (ADR 0224).
_Avoid_: Reply, answer, credit, inspiration, trackback

**Continuation relation**:
How the later work relates to the earlier submission: takes up, revisits or uses a suggested source. A
closed set that describes the link and never its worth.
_Avoid_: Reason, cause, impact

**Update subscription**:
A reader's optional, explicit request to be told when later work continues one page's questions or one
series. Off by default and offered only where a site turned it on and the hosted service is reachable;
otherwise the page offers links only. The address is private, kept only while active, never in static
output or analytics, and erased by unsubscribing. Nothing in open.blog sends the update itself: a site plugs in a mail provider and a hosted store, and
with neither the page offers links only (ADRs 0222, 0225).
_Avoid_: Newsletter, follow, mailing list, tracking

**Double opt-in**:
The two steps that start a subscription: a request stores a pending record only after a confirmation
message was sent, and a single-use link in it, followed within 48 hours, makes it active. A late or
unused request is erased. Every request is answered alike so the answer never reveals who is
subscribed (ADR 0225).
_Avoid_: Verification, activation email

**Reader annotation document**:
One versioned JSON document (`openblog.reader-annotations`) holding a reader's highlights, notes, saved
sources and reading trails, kept in that reader's own browser. It is reader-private, never public, never
read by the build, Admin or a hosted service, and unrelated to the author's research notebook (ADRs 0237,
0240).
_Avoid_: Research notebook, comments, bookmarks file

**Highlight**:
A reader's marked quotation in a published work: a passage target of the quoted text with its context,
the passage revision the reader saw and a time, and no words of the reader's own. Its stale state is
worked out when it is read, not stored (ADR 0238).
_Avoid_: Citation, claim, quote of record

**Reader note**:
A reader's own private text attached to a quotation, a section or a whole work. Left out of an export
unless the reader includes it, and never a research note or a comment (ADRs 0237, 0239).
_Avoid_: Comment, research note, feedback

**Saved source**:
A source a reader keeps in their annotation document: a title and either an http(s) link or a work on a
site, with an optional note. A linked source also records the work it was found in (`from`). It is not an
entry in the source library or a reference (ADRs 0237, 0242).
_Avoid_: Reference, source library entry, bibliography

**Reading trail**:
A reader's own ordered line of up to 200 highlights, notes and saved sources, each once. Unlike an
author's reading path it is private, local, built by hand and implies no relationship between steps (ADRs 0240, 0242).
_Avoid_: Reading path, history

**Trail panel**:
The second part of a post offered by a site that turns on `readerAnnotations`: "Your reading trails and saved
sources", where a reader saves this post or a reference it cites, starts trails by hand, orders them, and
removes one thing or everything. Nothing is recorded as a reader reads; it holds only what the reader added,
in their browser (ADR 0242).
_Avoid_: History, recently read, tracking

**Reading-trail export**:
The file a reader downloads from the trail panel: the annotation document and nothing else, with the text of
their own notes left out unless they chose to include it, and a sentence before the download saying what it holds.
Nothing is uploaded (ADRs 0239, 0243).
_Avoid_: Backup, sync, share

**Import preview**:
What the trail panel shows after a reader chooses a file and before anything is saved: what would be added, what is
already saved, records that share an id but differ (the reader chooses which version stays), and imported highlights
on the post being read that no longer match its text. A file that fails validation is refused whole (ADR 0243).
_Avoid_: Restore, merge dialog

**Annotation switch**:
The reader's own setting, kept in their browser, that turns highlights, notes, saved sources and trails off on a
site without removing what is saved. Erasing is separate and removes the data (ADR 0243).
_Avoid_: Disable (a site setting), opt-out

**Annotation privacy scope**:
The statement every annotation document and export carries: `reader-private`, and whether the reader's own
note text is `included` or `omitted`. It is checked, so a file cannot claim to omit notes while holding
them (ADR 0239).
_Avoid_: Visibility, sharing setting

**Annotation region**:
The part of a post, offered only by a site that turns on `readerAnnotations`, where a reader makes and manages
their own highlights and notes. It carries no annotation: the build publishes only its static text, the post's
passage text and a script, and what the reader keeps stays in their browser (ADR 0241).
_Avoid_: Comments section, annotation feed

**Moved annotation**:
A reader's highlight whose words were found again, in the same or another section, because the post changed
since it was saved. It is shown as moved and painted at the new place; an annotation whose words cannot be found
is stale and stays listed with its reason, never silently moved (ADRs 0238, 0241).
_Avoid_: Updated highlight, repaired highlight

**Reflection snapshot**:
One of a reader's own readings of a work or a section of it, kept in the reader-annotation document on
their device with the revision of the page they read and an optional label they chose. Its words never
change; it is private, never public and never a submitted copy (ADR 0244).
_Avoid_: Draft, saved comment, journal entry

**Interpretation history**:
The line of a reader's reflection snapshots on one work, each following the one before it. It claims
nothing about what changed or why (ADR 0244).
_Avoid_: Belief profile, reading log

**Submission record**:
A line on a reflection snapshot saying the reader sent a copy, when and by which channel. It is not the
copy, not a receipt, and not a sign the snapshot is public (ADR 0244).
_Avoid_: Receipt, publication status

## Site look

**Look**:
The owner's choices for how the site feels: an accent color, a curated palette, a font style, a text
size, roundness, spacing, page width and heading weight. Every choice is a closed option or a strict
hex color, stored versioned under `appearance` in `openblog.json`, and compiled only into allowlisted
`--ob-*` tokens. No look means the theme as it is (ADR 0248).
_Avoid_: Custom CSS, theme editor, skin

**Look control**:
One of the eight choices a look holds. A theme lists the ones it honors in `customizable`; Admin shows
only those and says kindly why the rest are missing (ADR 0248).
_Avoid_: Setting, style option

**Customizable token**:
One of the allowlisted `--ob-*` design tokens (colors, font families, text scale, radii, spacing, page and
reading width, heading weight) that a look may set, grouped under the eight look controls. A theme opts a
control in with `customizable` in `theme.json`; the owner's compiled block layers over the theme's tokens and
before its extra stylesheets, and nothing outside the allowlist can be set (ADR 0248).
_Avoid_: CSS variable override, theme setting, style

**Customize look**:
The Admin screen (`#/look`, beside Appearance) where an owner changes the look by tapping looks, swatches
and sample cards, with a live preview of the home page built from the unsaved look in light or dark. It has
no field that takes text; Back to theme default undoes one control, Reset everything clears the look, and
Undo takes back the last change (ADR 0256).
_Avoid_: Theme editor, style editor

**Curated look**:
A named, ready-made combination of palette and font style (Calm, Warm, Bold, Night, Garden, Paper,
Ocean, Sunset), pre-checked for readable contrast in light and dark. It is data, not a theme: applying
one fills in the look, and resetting returns exactly to the theme default (ADR 0248).
_Avoid_: Theme, template, preset theme

## Landing text

**Text section**:
The landing page's rich text section (`rich-text`), written in the Visual editor's word-processor surface
with a toolbar of words (Paragraph, Heading, Bold, Italic, Link, Bulleted list, Numbered list, Quote, Image,
Undo, Redo) and stored as inert Markdown. It has no Markdown toggle, no HTML view, and no control that
accepts markup; a picture needs a description (ADR 0257).
_Avoid_: HTML block, WYSIWYG box, Markdown field

**Clean paste**:
Pasting from Word, Google Docs or a web page into a Visual surface. The clipboard HTML is converted by an
allowlist into the editor's own Markdown (headings, bold, italic, links, lists, quotes, pictures that have a
description) and everything else is dropped; Ctrl/Cmd+Shift+V pastes plain text instead (ADR 0260).
_Avoid_: Paste with formatting, HTML paste

**Suggestions**:
The plain-language content checks under the landing Text section and the post editor's toolbar: a picture
without a description, a link that says "click here", an empty link, a skipped heading level, a very long
paragraph, shouting in capitals, an `http://` address. Each is one sentence, a "Fix it" button where a fix is
safe and touches only its own place; they never block saving (ADR 0262).
_Avoid_: Errors, validation, lint

**Raw HTML in Markdown mode**:
HTML tags an owner types in a post's Markdown. They are kept and rendered as written, existing posts are never
rewritten, and the suggestions note them without blocking. Visual mode, pasting, pieces, looks and the landing
page cannot create them (ADR 0263).
_Avoid_: HTML mode, unsafe HTML

**Landing history**:
The last twenty pages the Admin saved, each kept as one small file under `.openblog/private/landing-history/`
(never published, fed, exported or committed), listed by date with a one-sentence summary in the Landing page
view. Restoring one is an ordinary save that keeps the page it replaces (ADR 0264).
_Avoid_: Backups, revisions, undo

## Landing starters

**Starter layout**:
A ready-made list of sample landing sections (Welcome, Small business, Portfolio, Newsletter) or an empty page
(Start from scratch), chosen in the Landing page builder. It is plain section data with every stand-in sentence
marked "Sample", it is applied like any other unsaved edit, it can be undone, and it never replaces existing
sections without asking (ADR 0258).
_Avoid_: Template, theme, preset

**Landing tour**:
The optional three-step introduction to the Landing page builder: a labelled region in the page with Next,
Back, Skip the tour and Finish the tour, closed also by Escape. Once closed in any way it is never shown
again for that account on that device (ADR 0259).
_Avoid_: Onboarding wizard, walkthrough modal, coach marks

**Landing Help words**:
The short list under "Help: what the words on this page mean" in the Landing page builder, explaining
section, layout, hide, preview, save, publish (make it live), web address and picture description. Technical
terms appear only there, in brackets (ADR 0259).
_Avoid_: Glossary page, documentation

## Voice samples

**Voice prompt**:
One short writing invitation from a versioned catalog, with a genre, a suggested length and the standing rule
"write it the way you would say it" (stored once for the whole catalog, not per prompt). Prompts have stable
kebab-case ids (ADR 0266, ADR 0268).
_Avoid_: Writing prompt, exercise, question

**Prompt pack**:
A named group of voice prompts for one genre (teaching, stories, opinions, reviews, people, craft, humor,
expertise, everyday life, openings and endings). A site can add prompts and hide whole packs without forking
the bundled catalog (ADR 0268).
_Avoid_: Category, deck, topic

**Voice session**:
One timed sitting: a draw of three prompts, one choice, a bounded writing window and a locked rough draft.
Its only state is the private record `.openblog/private/voice/session.json`, which lets any surface resume
with the original deadline; there is one per site, and the record is removed when the session is locked or
scrapped (ADR 0267).
_Avoid_: Quiz, exercise, writing sprint

**Voice sample**:
One stored answer to one voice prompt at one stage, `rough` or `polished`. The rough stage is immutable once
its session ends: nothing, including spell-check, autocorrect, AI and any save path, rewrites it, and the
store refuses to. A voice sample is Assistant context, not a Post, so it is never published, built into the
site, fed or exported as content (a **Voice export** carries private samples only with `--include-private`)
(ADR 0266).
_Avoid_: Draft post, writing sample, entry

**Rough draft**:
The `rough` stage of a voice sample: the author's unedited words, typos included, written against the clock
and then locked. It can be read, moved between portable and private, or erased by the author, and never edited.
_Avoid_: First draft, raw draft

**Polished draft**:
The `polished` stage of a voice sample: the author's own revision of one rough draft, named by `roughOf`. It is
author-owned and editable; an AI tool may propose changes to it but never applies them (ADR 0266).
_Avoid_: Final draft, edited version

**Voice gap**:
Something the author's voice material cannot yet show: a pack or prompt with no sample, a prompt with only a
rough draft, or a guide trait marked `(one sample)`. It is computed by the core from the catalog, the library
and the saved guide, in catalog order, and is not AI (ADR 0281).
_Avoid_: Weakness, missing score

**Promotion**:
Making a post draft (`draft: true`) from a polished draft: a copy, never a move, so the sample stays where it
is. It refuses a rough draft and a slug a post already uses, and it is one store function that the CLI and
Admin both call (ADR 0270).
_Avoid_: Publish, convert

**Voice guide**:
A Markdown description of how the author writes, built from quoted sample evidence, approved by the author and
used as Assistant context. The provider proposes it from selected samples; every trait carries a short quote
that occurs word for word in a named sample, and a trait that rests on one sample says `(one sample)` until a
second shows it. It is saved only when the author approves it, to `assistant/context/voice.md` or its private
mirror, and is context to compare against, never a source of instructions (ADR 0279, ADR 0281).
_Avoid_: Style guide, persona, system prompt

**Guide merge**:
How a proposed voice guide meets the saved one (ADR 0288). The server reads the saved guide back into traits
and free text. A saved trait the proposal does not address is **kept** word for word. A trait the proposal
changes (named by `replaces`, or by the same statement) is a **change**: both texts are shown and the author
picks one before saving. New traits are **added**. Free text outside the trait format stays where it was. A
kept quote is checked again against its sample and flagged, not dropped, when the quote or the sample is gone.
_Avoid_: Overwrite, regenerate

**Passage review**:
An Assistant review of one bounded passage rather than the whole document: the author's **selection**, or the
**section** around the cursor (heading to next heading). The request carries the passage's code-point offsets,
the document travels for context, findings must lie inside the passage, and a skill must declare that scope.
`voice-match` reviews only passages (ADR 0290).
_Avoid_: Partial review, snippet review

**Guide move**:
Moving the voice guide between `assistant/context/voice.md` and `.openblog/private/context/voice.md` in one
step. The file is copied, the copy is checked, and only then is the original removed, under the content
transaction lock and the voice store lock. A move refuses links and never overwrites. A guide that quotes private
samples, or cannot be read, never moves to portable. Previewed by default (`openblog voice guide --move`,
**Make private** / **Make portable** in Admin) and reversible (ADR 0289).
_Avoid_: Save as, copy

**Voice export**:
One JSON file (`openblog-voice-export`, version 1) holding voice sample files and the voice guide exactly as stored,
each tagged with the folder it came from. It leaves private material out unless the author asks, and an import
checks every item, previews what it would write and then writes all of it or none. An import keeps each item's
folder, never replaces a rough draft, and never lets a guide that quotes private samples into the portable
folder (ADR 0284).
_Avoid_: Backup, sync

**Voice erase**:
Removing every voice sample (both folders), the session record, the guide and leftover editor files in one
all-or-nothing step, after a listed confirmation, and then checking again that nothing remains. The guide's
location is named in one place, `voice_store::guide_paths` (ADR 0283).
_Avoid_: Reset, wipe, delete account

## Trades

**Business facts**:
The one `business` block in `openblog.json`: legal and display name, trade, phone (E.164), email, hours per
weekday with closed days, license number and issuer, an insured flag, accepted kinds of payment and the founding
year. Every page, the footer, the Landing page's Business facts section and the `LocalBusiness` structured data
read it, so nothing contradicts itself. Unset means nothing changes; it never holds anything about customers
(ADR 0305).
_Avoid_: Company profile, contact details (they are one part)

**Job**:
A dated Post using the `job` content profile that records one piece of completed work: trade, service, place,
problem, what was found, what was done, result, media. A job is a post, so feeds, tags, series and export treat
it like any other (ADR 0285).
_Avoid_: Project, case study, ticket

**Job scaffold**:
The four `##` headings a new job starts with (`Problem`, `What we found`, `What we did`, `Result`), written once in
core and placed by Admin's Job mode or `openblog new --profile job`. They are ordinary Markdown; nothing is
locked (ADR 0287).
_Avoid_: Template, form body

**Before and after pair**:
Two pictures of the same thing, written as a `compare` fence with a required description for each, an optional
caption and a label ("Before" and "After" by default). Any post may hold one. The page shows a comparison
control; feeds, syndicated copies and exports show two captioned figures. Reported as the `before-after`
capability (ADR 0316).
_Avoid_: Slider, image diff, gallery

**Capture**:
Photos and a few lines gathered on site in Admin's Capture
view (`#/capture`) and saved as one unpublished job draft: the Job form's own keys, the job scaffold, the notes
under its first heading and the photos after it. A capture is not a new kind of content; it is a faster way into
a job post. The view remembers the last trade, service and eight towns on the device (ADR 0296).
_Avoid_: Quick post, field note

**Capture id**:
A random 128-bit id, 32 lowercase hex digits, made when a capture is started. It is the idempotency key: the
server saves the draft and each photo at most once per id, so a replay never makes a second draft (ADR 0297).
_Avoid_: Draft id, session id

**Capture queue**:
The captures a device has saved locally, in IndexedDB, while they wait to be sent. Each record is a versioned
format (`v: 1`) with fixed bounds on captures, photos, notes and bytes; nothing is dropped silently and nothing
outside the bounds is stored (ADR 0297).
_Avoid_: Outbox, sync

**Voice note**:
A recording of at most three minutes and 8 MB made in the Capture view with the browser's recorder, started only
by a tap, kept on the author's server as private media beside the capture and never published. It is sent to a
provider only when the author asks to transcribe it and has seen the disclosure (ADR 0298, ADR 0302).
_Avoid_: Dictation

**Transcript**:
The words of a voice note, made by a provider that takes audio or by a local engine, on the author's request. It is
untrusted text: kept privately beside the note, cleaned and bounded by the core, and put into the Notes box made
plain for the author to edit. It is never a draft, never published and never treated as instructions (ADR 0302).
_Avoid_: Caption, dictation

**Job draft**:
A title, a one-sentence description and the four scaffold sections written by the Assistant (`job-draft` task)
from the author's notes and, if selected, their voice guide. It is plain text under a strict schema with no place
for any `job` field, checked whole by the core, and only ever a proposal: nothing is saved or published until the
author applies it and saves (ADR 0303).
_Avoid_: AI post, generated post

**Service**:
One offering a business sells, kept as a Markdown file in the `services/` collection with an `id`, a name, a
one-sentence summary, what is included, a starting price band, a typical timeline, and FAQs. A job's `service`
names one of them by id; once a site has any service, a job naming an unknown id is refused with the known ids
listed. The price band is the jobs' cost band, a label and never a quote (ADR 0311). A site with services gets a
`/services/` index and a page per service with `Service` structured data, and `FAQPage` data only for a service
that has questions (ADR 0312). `openblog new --profile service` and Admin's Services screen write them (ADR 0313).
_Avoid_: Product, category

**Service area**:
A town and region the business serves, kept in the versioned `serviceAreas` list in `openblog.json` (ADR 0314)
and rendered as pages and structured data. It has a town, a region formatted from a bundled list, and an optional
one-line note about the reach; nothing finer than a town is ever stored. A job is "in" an area when its
`place.town` and `place.region` match, and its area page shows the job's title, link and date only (ADR 0315);
an area with no jobs says its work is not yet posted rather than filling the page.
_Avoid_: Location (ambiguous with a job's place)

**Before/after pair**:
A publishing capability that shows two images of the same subject with captions, rendered as a comparison on
the canonical page and as two captioned images everywhere else.
_Avoid_: Slider, gallery

**Quote request**:
A bounded inbound message from a prospective customer, stored server-side with explicit export and erase. It
is not a lead pipeline, a booking or an estimate.
_Avoid_: Lead, booking, ticket

**Proof**:
A review or testimonial saved as a provenance-tracked snapshot and optionally linked to a job.
_Avoid_: Rating (the number alone), social proof

**Social publishing**:
An optional, off-by-default outward announcement of an already-published canonical post to a connected LinkedIn
identity or Facebook Page, on a schedule. It never replaces the post or cross-posting. Everything about it is
server-side; builds and exports do not know it exists.
_Avoid_: Syndication (a full copy of the article on another platform)

**Site scope**:
The one site a social deployment acts for, taken from the server's `OPENBLOG_SITE_ID` and never from a request.
Every social row carries it and every query is filtered by it.
_Avoid_: Tenant, owner, namespace when the server's choice is meant

**Social actor**:
The signed-in Admin user the Rust Admin names to the hosted social function, or `@worker` for the scheduled
worker. It is an audit attribution; the role is decided by which server key authenticated the call.
_Avoid_: User, owner

**Social account**:
A connected LinkedIn identity or Facebook Page that a site may announce to. It is stored per site; its credentials
are never part of the account row. Disconnecting keeps the row for history.
_Avoid_: Profile, channel

**Scheduled social post**:
One queued announcement of one canonical post to one social account, with a time, a lease while a worker holds it
and an idempotency key. It is `published` only with the provider's own response id.
_Avoid_: Syndicated copy, job

**Announcement**:
One scheduled social post seen from the author's side: a caption for one account, a link to one already-public
canonical post, and a UTC time. It can be changed or canceled only while it is `scheduled`, before a worker claims
it. A cross-posted article, a draft and a post dated in the future cannot be announced.
_Avoid_: Syndicated copy, campaign

**Schedule instant**:
The time of an announcement: a full RFC 3339 date and time that names its zone, stored as UTC to the second. The
author's time zone says how it was chosen and is not stored.
_Avoid_: Local time, publish date (a post's own date)

**Social screen**:
The Admin tab (`#/announcements`) where an author composes, previews, schedules, edits and cancels announcements. It exists
only when social publishing is set up, talks only to Admin's own routes, and shows times in the author's zone.
_Avoid_: Social dashboard, composer (the form is one part of the screen)

**Delivery attempt**:
One recorded try to deliver a scheduled social post, with its outcome (`published`, `failed` or `unknown`) and a
redacted error. Attempts are added and finished, never deleted.
_Avoid_: Retry (a later attempt)

**Delivery error**:
What a provider adapter throws when a delivery try did not end in a confirmed, named post: `transient` (the request
certainly never left), `rate-limited` (with the provider's wait), `rejected`, `auth`, or `uncertain` (it may have
posted). Only `transient` and `rate-limited` are retried; `uncertain` is looked up, never re-sent. It carries a fixed
sentence and the HTTP status, never the provider's words.
_Avoid_: Publish result (an earlier draft's status object), response (the provider's own reply)

**Credential envelope**:
The encrypted form of a social account's provider tokens: AES-256-GCM ciphertext plus a wrapped data key, bound to
one site and account, openable only with a key from `OPENBLOG_SOCIAL_TOKEN_KEYS` that is never in the database.
_Avoid_: Vault secret, encrypted token column

**Refresh lease**:
A short claim on one account's credential that lets exactly one caller exchange its refresh token, so concurrent
refreshes cannot burn a rotating refresh token.
_Avoid_: Lock

**Social connection**:
One author's OAuth handshake with one provider, from the authorization URL to a finished or failed outcome. It
holds a hash of a single-use state, never the state, and keeps the provider's tokens sealed only until the
author chooses a destination or the attempt ends.
_Avoid_: Login, session

**OAuth state**:
The unguessable single-use value that ties a provider's redirect back to the connection an authorized Admin
started. It is the callback's only proof, since the callback carries no key.
_Avoid_: Nonce, CSRF token (the Admin CSRF token is a different thing)

**Destination**:
Where a connected account may actually post: a LinkedIn member or organization, or a Facebook Page. It is offered
only when the provider confirmed the permission and the person's role; otherwise it is listed with the reason and
cannot be chosen.
_Avoid_: Channel, target (a cross-posting target is a different thing)

**Reconnect**:
A new handshake for an existing social account that can finish only for the same provider identity, replacing its
credential and clearing its needs-reauth flag.
_Avoid_: Refresh (a silent token renewal), re-add

**Connected accounts screen**:
The Admin page (`#/social`) where an author connects, reviews, reconnects and disconnects social accounts. It shows
only what the Admin server rebuilt from the hosted function's reply, and appears in the navigation only when the
Admin server has social settings.
_Avoid_: Integrations, social settings

**Claim**:
The atomic step in which a worker takes a due scheduled social post: one database function moves it to `claimed`
under a lease, raises its attempt count and version, and opens the attempt row, skipping any row another claim has
locked. A claim and an author's edit or cancel exclude each other.
_Avoid_: Pick up, dequeue

**Lease**:
The time until which one worker may deliver a claimed post. When it runs out, the post is reaped: back to the queue if
the provider was never called, `unknown` if it might have been.
_Avoid_: Lock, timeout

**Sending mark**:
The stamp on a delivery attempt (`sending_at`) made just before the provider call, and only while the lease is valid.
It separates "nothing was sent" from "it may have been sent", which decides whether an expired lease is retried or
becomes an unknown outcome.
_Avoid_: Heartbeat

**Delivery worker**:
The hosted function (`/api/social-worker`) that runs one bounded batch: it claims due scheduled social posts, delivers
each through its provider's adapter, and records the outcome. Only the worker key may call it, and pg_cron and pg_net
wake it from the database with the key kept in Vault.
_Avoid_: Cron job (that only wakes it), publisher

**Provider adapter**:
The one narrow interface the delivery worker calls a social provider through: `publish` returns the provider's own post
id only on confirmed success or throws a typed delivery error; `reconcile` optionally looks a post up. It is given a
caption, a link, an idempotency key and one access token, nothing else of ours, and is tested against fakes. One is
registered only for a provider the deployment configured; LinkedIn has no lookup, Facebook looks at the Page's own posts.
_Avoid_: Driver, integration, publisher

**Unknown outcome**:
The state of a delivery attempt that may have reached the provider and was not confirmed (a timeout, a dropped
connection, a 5xx, an unreadable answer, a crash, a success that could not be recorded). It is never sent again by the
worker; the adapter's lookup, then the author, settles it as posted or not posted.
_Avoid_: Pending, failed (a failure certainly did not post)

**Reconciliation**:
The delivery worker's look at an unknown outcome through the provider adapter's optional lookup, on a widening
schedule, ending in published, failed (`not-delivered`) or, when it cannot tell, review by a person.
_Avoid_: Retry (a retry sends again)

**Dead letter**:
A scheduled social post that used up its attempts and is `failed` with `attempts-exhausted`. It keeps its history and
can be retried by hand, with a fresh allowance of attempts.
_Avoid_: Error queue

**Account pause**:
The time until which a rate-limited social account sends nothing, for any of its posts, so one limit is not hit again by
the next announcement.
_Avoid_: Cooldown, ban
