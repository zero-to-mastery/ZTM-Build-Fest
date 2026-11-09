# Batch recovery is a local journal, not an outbox

Interrupted multi-repository work needs durable progress without creating an automatic remote-work queue. The batch schema therefore advances to version 2 while accepting and migrating version-1 queues.

The journal is capped at 500 allowlisted events. Decisions record only action, item index and time. A successful open additionally records the local document ID, canonical target identity and fingerprint of the exact local Source. README content, credentials, errors and publish instructions are excluded.

Recovery compares each checkpoint with the current local workspace and reports matching, changed, missing, target-changed or not-yet-opened. The comparison performs no network request and no mutation. Each successful open is saved before the next begins, so partial progress survives interruption. Failed or cancelled fetches leave the item pending and retain already opened documents.

The journal cannot replay publishing. GitHub writes remain in the separate single-document publishing workflow, which requires fresh remote reads, a reviewed change set and explicit approval.
