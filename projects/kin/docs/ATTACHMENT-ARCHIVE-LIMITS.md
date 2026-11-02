# Attachment and archive limits

Kin keeps these existing bounded attachment limits aligned across the browser,
local encrypted storage, relay, server storage, and archive validation:

| Limit | Value |
|---|---:|
| Plain attachment | 4 MiB |
| Ciphertext allowance per attachment | 4 MiB + 4096 bytes |
| Attachments per parent | 5 |
| Attachments per household | 64 |
| Aggregate stored attachment ciphertext | 50 MiB |
| Complete encrypted `.kin` archive, including manifest/framing | 160 MiB |
| Protected snapshot serialization used during export/import | 160 MiB |

The aggregate attachment allowance counts ciphertext bytes at the browser and
relay. Archive serialization also accounts for event bytes, base64 representation
of protected binary values, manifest and cryptographic framing. The 160 MiB
archive limit is finite and enforced by both the Rust KARC parser/generator and
the browser's archive and protected-value validation. Import applies the same
framing bound before decrypting or restoring anything. A failed export or
import leaves the existing household history unchanged.

Oversized input is rejected before it can be stored or restored. A household
within the 50 MiB attachment allowance has room for archive representation and
overhead; Kin does not rely on a smaller hidden 64 MiB snapshot limit.

Package format v2 adds bounded event and attachment counts/byte totals to the
authenticated encrypted manifest. It retains KARC v1 framing and the same full
archive limit. Attachment ciphertext and its existing SHA-256 digest remain
inside the authenticated payload; a digest mismatch rejects the whole package.

Package format 3 (refactor Slice 9) keeps these limits and the KARC v1
container, and seals the contents as segments: the context, one per
attachment record, then 256 events per segment. One segment may not exceed
32 MiB. Canonical event records are stored as bytes rather than base64 text,
so the same household makes an archive about 30% smaller.
