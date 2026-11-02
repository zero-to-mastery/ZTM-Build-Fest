# JSON feed source

Import `jsonFeedSource` from `@constellation/source-json`. It implements source API version 1. Core hosts already register it as `json-feed`; to customize its renderer, register a copy with a different plugin ID.

`load({ options, fetchImpl, signal })` returns `options.items` when supplied, otherwise fetches `options.url` over HTTP(S). Feeds contain an array of objects with nonempty string `id` and `name`. Optional metadata: `language` (string), `languages` (byte counts by language), `topics` (strings), `stargazers_count` (number), and repository dates. IDs need only be unique within a configured source instance; the host namespaces them.

Use an injected fetch function and inline items to test without network access. HTTP failures, malformed feeds and duplicate local IDs are errors. A host must explicitly register executable plugins; a JSON config does not import modules.
