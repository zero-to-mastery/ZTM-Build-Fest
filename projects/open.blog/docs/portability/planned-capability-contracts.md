# Portability gates for planned capabilities

- Status: contract gates only; no planned capability is implemented here
- Issue: [#110](https://github.com/journey-to-code-org/open.blog/issues/110)
- Registry: [planned-capability-contracts.json](./planned-capability-contracts.json)
- Current behavior: [capability-matrix.md](./capability-matrix.md)

The JSON registry is the checklist source of truth. Each defined capability has one
owning story and one unique portability-contract task; implementation issues are linked
for ownership, not re-specified here. The owner story remains responsible for product
behavior, while the contract task owns the portability gate.

| Capability | Owning story | Portability owner | State |
| --- | --- | --- | --- |
| Edition/translation comparisons | [#22](https://github.com/journey-to-code-org/open.blog/issues/22) | [#52](https://github.com/journey-to-code-org/open.blog/issues/52) | Defined |
| Historical timelines | [#23](https://github.com/journey-to-code-org/open.blog/issues/23) | [#56](https://github.com/journey-to-code-org/open.blog/issues/56) | Defined |
| Research workspace publication boundary | [#24](https://github.com/journey-to-code-org/open.blog/issues/24) | [#63](https://github.com/journey-to-code-org/open.blog/issues/63) | Defined |
| Citation/source previews | [#25](https://github.com/journey-to-code-org/open.blog/issues/25) | [#64](https://github.com/journey-to-code-org/open.blog/issues/64) | Defined |
| Guided reading | [#26](https://github.com/journey-to-code-org/open.blog/issues/26) | [#68](https://github.com/journey-to-code-org/open.blog/issues/68) | Defined; implemented (`implementation_status` in the registry, ADRs 0140-0144) |
| Knowledge relationships | [#27](https://github.com/journey-to-code-org/open.blog/issues/27) | [#72](https://github.com/journey-to-code-org/open.blog/issues/72) | Defined |
| Curated reading paths | [#28](https://github.com/journey-to-code-org/open.blog/issues/28) | [#76](https://github.com/journey-to-code-org/open.blog/issues/76) | Defined |
| Passage questions/corrections | [#29](https://github.com/journey-to-code-org/open.blog/issues/29) | [#80](https://github.com/journey-to-code-org/open.blog/issues/80) | Defined |
| Local reader annotations | [#30](https://github.com/journey-to-code-org/open.blog/issues/30) | [#84](https://github.com/journey-to-code-org/open.blog/issues/84) | Defined |
| Scholarly interpretations | [#31](https://github.com/journey-to-code-org/open.blog/issues/31) | [#88](https://github.com/journey-to-code-org/open.blog/issues/88) | Defined |
| Shared source-led reflections | [#144](https://github.com/journey-to-code-org/open.blog/issues/144) | [#158](https://github.com/journey-to-code-org/open.blog/issues/158) | Defined |
| Protected reflection drafts | [#146](https://github.com/journey-to-code-org/open.blog/issues/146) | [#162](https://github.com/journey-to-code-org/open.blog/issues/162) | Defined |
| Third Perspectives | [#201](https://github.com/journey-to-code-org/open.blog/issues/201) | [#222](https://github.com/journey-to-code-org/open.blog/issues/222) | Defined |
| Diagrams | No owning story exists | [#110](https://github.com/journey-to-code-org/open.blog/issues/110) | Blocked; scope guard only |

## Required gate for every defined capability

Before a capability can be called complete, its owner must identify:

1. The substantive authored data and stable identity/provenance it represents.
2. A useful static representation, or an explicit reason that no public fallback is
   appropriate.
3. The ordinary source, passage, or canonical-work link that remains useful without
   interactive behavior.
4. Private/draft, rights-restricted, unapproved, and remote data that must not appear in
   public pages, feeds, search, exports, or provider requests.
5. Tests for semantic preservation, accessible static output, links and anchors,
   Unicode, hostile input, privacy leakage, scoped failures, and unchanged canonical
   data on failure, as relevant to that capability.

The reader-facing fallback-policy work in issues
[#123](https://github.com/journey-to-code-org/open.blog/issues/123) and
[#125](https://github.com/journey-to-code-org/open.blog/issues/125) owns the exact
rendering and interaction policy where applicable. This registry records the minimum
acceptance gate and points to the feature owner; it does not prescribe implementation
internals or create a parallel renderer.

Until a capability's owner ships its portable fallback, the portable HTML projection fails
closed for it: authored content stays visible, a labeled note links to the canonical article,
and private-only state adds nothing (see the
[portable HTML pipeline](./portable-html-pipeline.md#research-attribution-and-planned-structures)).
The label table in `capability.rs` is checked against this registry's ids.

## Shared Perspectives and privacy

The shared-publication contract reuses the source identity in story #144, contributor
identity/credit contracts, and the exact-approved-revision boundary. Protected
contribution drafts in story #146 are not a public representation: they remain absent
from previews, feeds, exports, search, and errors until an exact revision is approved
and published.

Reader questions and corrections remain distinct from research notes and shared
contributor reflections. Hosted submissions must use the shared moderation policy
([#211](https://github.com/journey-to-code-org/open.blog/issues/211)); public output
contains only approved material.

## Unowned diagram scope

The capability matrix found no diagram authoring story, data model, or renderer. The
diagram entry is therefore a blocking guard, not authorization to add syntax or a
renderer. Existing Markdown image and raw-HTML behavior remains unchanged. A future
diagram owner must first define nodes, relationships, labels, evidence, rights, a static
list/table fallback, privacy boundaries, and regression tests.

The registry validator runs with:

```text
node --test tests/portability-contracts.test.mjs
```
