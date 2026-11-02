# Interpretation comparisons

An interpretation comparison sets several readings of one subject side by side. It records who holds
each reading and how firmly, points at the evidence you already keep, and optionally adds beginner,
student and scholarly explanations. It never rules between readings. Nothing on a comparison page
says a reading is verified, correct, the consensus or the most authoritative: open.blog does not know
that, and a page that claimed it would be claiming more than you can show.

Publishing is opt-in. See [Interpretation comparisons](configuration.md#interpretation-comparisons)
for the `interpretations.publish` switch and [Author an interpretation comparison](admin.md#author-an-interpretation-comparison)
for the Admin form. The decisions are recorded in
[ADR 0226](adr/0226-a-comparison-is-its-own-public-content-type-and-one-versioned-file.md) and the ADRs
after it.

## Attribution

Every reading says who held it. Choose one of:

- **A named person, school or tradition.** Use the name readers would know.
- **A source in your library.** The page shows the source's public description, and only while a
  published, approved evidence link cites that source.
- **Unknown author,** with a description such as "An anonymous twelfth-century commentator". Anonymous is
  a legitimate answer. Leaving the attribution out is not: a reading without an attribution is refused.

Do not attribute a reading to someone because it sounds like them. If you are inferring it, say so with
the certainty field (stated, attributed, uncertain or disputed) and the uncertainty note. A reading attributed to a source
the site does not publish is left off the page, and the build tells you which item, never why.

## Uncertainty

Each reading can carry an uncertainty note: what the text does not say, what is disputed, what the
evidence cannot settle. Write one whenever the reading goes beyond its evidence. Evidence is a pointer
to a link or a source and place, never a quotation, and it can be missing: a save never fails for
missing evidence, so honest uncertainty can always be recorded. Relations between readings (differs
from, agrees with, builds on, responds to) describe how the readings relate, not which is right.

## Audience explanations

Beginner, student and scholarly explanations are supplements for one audience. They never replace your
prose, and every level sits on the page as a section reachable by link without JavaScript. The level
selector only narrows what is shown, never the evidence, and printing shows every level. An explanation
adds no evidence of its own: any evidence it lists must already be cited by the reading it explains, and
the page shows evidence only beside the readings.

An explanation may also carry `authors` (up to five display names), a one-line `prerequisite` such as
"The first section of the article", the `modes` it serves (`guided`, `deep-dive`; leave out for all), a
`language` and `translationOf` naming the explanation it translates, and a `revision` number of your own.
The prerequisite is advice and the page says the article can be read without it. To retire an
explanation, add `"withdrawn": {"at": "<time>", "reason": "<note for you>"}`: it leaves every public
output, the reason is never shown, and its level is free for a replacement. See
[ADR 0234](adr/0234-an-explanation-states-its-authors-prerequisite-modes-and-withdrawal-and-one-explanation-serves-every-mode.md).

## AI drafts and your responsibility

If an AI tool drafted a reading or an explanation, mark it as such and name the tool. It stays a draft
and no reader sees it until you read it and press **Approve this exact text**. The approval is bound to
those exact words: edit them (for a reading, also its attribution, uncertainty note or language) and it is
withdrawn. A published page labels the text "Drafted with AI" and says the author approved it; your
Admin login name is never shown. The approval is your statement that you read the text, checked it against the
evidence and take responsibility for it. It is not a verification by open.blog. Treat AI output, imported
files and anything copied from the web as untrusted until you have read it.

Approval is recorded by the Admin action only. A hand edit of the JSON can add an approval line, and the
build does not check who wrote it (see
[ADR 0231](adr/0231-comparisons-are-edited-in-admin-with-an-approve-action-that-only-the-server-can-give.md)),
so keep the files under review like any other source.

## What stays private

The files in `content/comparisons` hold drafts and unapproved text beside what is published, so they are
never copied into the site. A page is built only from the public projection: approved text, evidence
that your site already publishes, and source descriptions your published posts could cite. A draft
comparison, an unapproved or stale AI draft, a note you keep in the file, a private source and an
evidence link you have not approved appear on no page, in no search result and in no data file.
Admin's **What will be public** lists the comparisons the next build publishes.

## Accessibility

A comparison page is static HTML first: readings are headings and lists, levels are sections with
anchors, and the page works with no JavaScript. The selector is keyboard operable with named controls,
uses no animation and does not overflow a narrow screen.

## Portable copies

`openblog_core::comparison_portable::portable_comparison` produces HTML, Markdown and plain-text copies of
a published comparison. The build writes them as `portable.html`, `portable.md` and `portable.txt` beside
the page of every comparison that has explanations (ADR 0236). Feeds and Admin export do not carry them yet. Every approved explanation level is a
labelled supplemental section with its authors, prerequisite, language, revision, AI label and approval
statement, and each copy links to the canonical page. The level selector and the reading-mode filter do
not travel, so every approved explanation appears; the copy's diagnostics say so. A copy that lost a
level, an AI label or the canonical link is reported as an error and stops the build.
