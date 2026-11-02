# Assistant provider APIs

Research date: 2026-10-23

## Summary

open.blog can add native server-side adapters for OpenAI, Google Gemini, xAI Grok,
DeepSeek, Mistral, and OpenRouter. All six accept API-key authentication and can return
JSON, but only five provide a direct, provider-controlled JSON Schema mode. OpenRouter
forwards structured-output requests only to compatible upstream endpoints and explicitly
warns that strict enforcement varies by provider.

GitHub should not appear beside those providers. GitHub Models was fully retired on
2026-07-30, including its inference API. GitHub Copilot instead offers an agent-oriented
SDK that runs through Copilot CLI and GitHub authentication; it is not a simple hosted
completion endpoint with an API key. That could become a distinct desktop/agent integration,
but it does not fit open.blog's current native provider contract.

## Recommended initial set

| Admin label | Default model candidate | Endpoint | Credential variable | Structured result |
|---|---|---|---|---|
| OpenAI | `gpt-6-luna` | `POST https://api.openai.com/v1/responses` | `OPENAI_API_KEY` | Native JSON Schema |
| Google Gemini | `gemini-3.8-flash` | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `GEMINI_API_KEY` | Native JSON Schema |
| xAI Grok | `grok-4.7` | `POST https://api.x.ai/v1/responses` | `XAI_API_KEY` | Native JSON Schema |
| DeepSeek | `deepseek-flash` | `POST https://api.deepseek.com/responses` | `DEEPSEEK_API_KEY` | Native JSON Schema |
| Mistral AI | `mistral-small-latest` | `POST https://api.mistral.ai/v1/chat/completions` | `MISTRAL_API_KEY` | Native JSON Schema |
| OpenRouter | no hard-coded model; require selection | `POST https://openrouter.ai/api/v1/chat/completions` | `OPENROUTER_API_KEY` | Routed JSON Schema; endpoint-dependent |

Keep **Custom HTTPS** and the existing **Anthropic Claude** adapter. Use provider names in
the dropdown: “OpenAI” is more accurate than “ChatGPT/Codex,” because ChatGPT and Codex are
product experiences while this integration uses the OpenAI API and a general text model.

## Verified API contracts

### OpenAI

- The Responses endpoint is `POST https://api.openai.com/v1/responses` and authenticates
  with `Authorization: Bearer $OPENAI_API_KEY`
  ([create response](https://developers.openai.com/api/reference/resources/responses/methods/create),
  [authentication](https://developers.openai.com/api/reference/overview#authentication)).
- Structured output belongs at
  `text.format = {"type":"json_schema","name":"...","schema":{...},"strict":true}`.
  The API guarantees schema adherence for supported models, subject to documented refusal
  and incomplete-response cases
  ([structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)).
- Extract the JSON string from the `output` item whose type is `message`, then its `content`
  item whose type is `output_text`; SDK `output_text` helpers merely aggregate those items
  ([Responses example](https://developers.openai.com/api/reference/resources/responses/methods/create)).
- OpenAI currently presents Astra, Sol, and Luna as its main model tiers; Luna is described
  as the efficient choice for focused, high-volume work. `gpt-6-luna` is therefore the most
  proportionate default for repeated blog review, while the model field should remain
  editable
  ([model selection](https://developers.openai.com/api/docs/guides/model-selection)).

### Google Gemini

- The direct content endpoint is
  `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`.
  Requests authenticate with the `x-goog-api-key` header; Google advises that production
  browser clients should call through a backend so the key is not exposed
  ([API reference](https://ai.google.dev/api),
  [API-key security](https://ai.google.dev/gemini-api/docs/api-key#security-and-secret-management)).
- For `generateContent`, structured output is configured in the generation configuration
  as JSON output plus a JSON Schema. The current REST documentation uses
  `generationConfig.responseFormat.text.mimeType = "APPLICATION_JSON"` and a `schema`;
  Gemini supports a documented subset of JSON Schema and still requires application-side
  semantic validation
  ([structured outputs](https://ai.google.dev/gemini-api/docs/structured-output),
  [generation configuration](https://ai.google.dev/api/generate-content#v1beta.GenerationConfig)).
- Extract text from `candidates[0].content.parts[*].text`. The standard response is a
  `GenerateContentResponse` containing candidates, each with content and parts
  ([text generation response](https://ai.google.dev/gemini-api/docs/generate-content/text-generation#response-body-structure)).
- `gemini-3.8-flash` is the current stable Flash identifier and Google recommends current
  Flash models for new projects
  ([models](https://ai.google.dev/gemini-api/docs/models),
  [2026 release notes](https://ai.google.dev/gemini-api/docs/changelog)).

### xAI Grok

- The Responses endpoint is `POST https://api.x.ai/v1/responses`, authenticated with
  `Authorization: Bearer $XAI_API_KEY`; the current official example uses `grok-4.7`
  ([Responses API](https://docs.x.ai/developers/rest-api-reference/inference/responses),
  [API overview](https://docs.x.ai/developers/rest-api-reference/inference)).
- Structured output uses the OpenAI Responses shape:
  `text.format = {"type":"json_schema","name":"...","schema":{...},"strict":true}`.
  xAI says supported schema features are guaranteed
  ([structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)).
- Extract the `text` from the `output` item with `type: "message"`, then the content item
  with `type: "output_text"`; reasoning may appear as a separate output item and must not
  be parsed as the result
  ([Responses response object](https://docs.x.ai/developers/rest-api-reference/inference/responses),
  [structured-output extraction example](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)).

### DeepSeek

- DeepSeek's OpenAI-format base URL is `https://api.deepseek.com`; authentication is HTTP
  Bearer. The native Responses call is `POST /responses`
  ([authentication](https://api-docs.deepseek.com/api/deepseek-api/),
  [Responses API](https://api-docs.deepseek.com/api/create-response/)).
- The current model identifiers are `deepseek-flash` and `deepseek-v4-pro`. Flash is the
  lower-cost, high-throughput candidate and supports the Responses API
  ([models and pricing](https://api-docs.deepseek.com/quick_start/pricing/),
  [list models](https://api-docs.deepseek.com/api/list-models/)).
- The Responses API supports
  `text.format = {"type":"json_schema","name":"...","schema":{...}}` as well as plain
  JSON mode. Extract the result from `output[]` `message` items and their `output_text`
  content; reasoning is a separate item
  ([Responses request and response](https://api-docs.deepseek.com/api/create-response/)).
- The older Chat Completions JSON mode guarantees valid JSON but not schema adherence and
  may occasionally return empty content. Prefer Responses JSON Schema mode for open.blog
  ([JSON output](https://api-docs.deepseek.com/guides/json_mode/)).

### Mistral AI

- Chat completions use `POST https://api.mistral.ai/v1/chat/completions` with
  `Authorization: Bearer $MISTRAL_API_KEY`
  ([chat API](https://docs.mistral.ai/api),
  [first API request](https://docs.mistral.ai/getting-started/quickstarts/developer/first-api-request)).
- `response_format.type = "json_schema"` guarantees JSON following the supplied schema.
  The raw result is `choices[0].message.content`
  ([chat API response format](https://docs.mistral.ai/api),
  [custom structured outputs](https://docs.mistral.ai/studio/conversations/structured-output/custom)).
- `mistral-small-latest` is documented as the fast, cost-effective general model. The
  editable model field lets users choose `mistral-medium-latest` or a pinned version when
  quality or reproducibility matters. Mistral warns that `-latest` aliases may receive
  silent model and pricing changes
  ([model choices](https://docs.mistral.ai/vibe/code/cli/configuration),
  [model lifecycle](https://docs.mistral.ai/inference/model-lifecycle)).

### OpenRouter

- Chat completions use `POST https://openrouter.ai/api/v1/chat/completions` and Bearer
  authentication. `HTTP-Referer` and `X-Title` are optional attribution headers. A normal
  response returns text in `choices[0].message.content`
  ([chat completion reference](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request),
  [developer quickstart](https://openrouter.ai/developers)).
- Structured output uses the OpenAI Chat Completions
  `response_format.json_schema` shape. Support is determined per upstream endpoint, can
  change, and strict enforcement varies by provider. Send `provider.require_parameters:
  true` so routing is restricted to endpoints that accept the requested schema
  ([structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)).
- Do not hard-code a default model slug. OpenRouter is valuable precisely as a model router;
  its model catalog exposes current models and filtering, while model availability and
  endpoint capabilities change independently
  ([models API](https://openrouter.ai/docs/api/api-reference/models/get-models)).

### GitHub Copilot and GitHub Models

- GitHub Models is not available: GitHub states that its playground, model catalog,
  inference API, and BYOK support were fully retired on 2026-07-30. GitHub also states that
  Models was separate from Copilot
  ([GitHub Models retirement](https://docs.github.com/en/github-models)).
- GitHub's supported programmatic path is the Copilot SDK. It embeds the Copilot CLI agent
  runtime, communicates with it over JSON-RPC, and authenticates through an interactive
  signed-in user, GitHub OAuth App, GitHub tokens, server-to-server organization policy, or
  BYOK. Standard Copilot-backed use requires a Copilot subscription
  ([Copilot SDK repository](https://github.com/github/copilot-sdk),
  [Copilot SDK authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)).
- GitHub's REST Copilot endpoints manage seats, policies, agents, and usage; they are not a
  general text-inference API
  ([Copilot REST endpoints](https://docs.github.com/en/rest/copilot)).

## Engineering recommendations

These are recommendations, not provider claims:

1. Implement one shared **OpenAI Responses-compatible** adapter for OpenAI, xAI, and
   DeepSeek, parameterized by fixed origin, credential name, and safe public error label.
   Keep each provider as a distinct enum value so credentials remain destination-bound.
2. Implement dedicated Gemini and Mistral adapters because their request and response
   envelopes differ.
3. Implement OpenRouter through Chat Completions and set `provider.require_parameters` to
   `true`. Clearly label it as a routed third-party service and require an explicit model.
4. Preserve the existing post-response semantic validators. Schema conformance guarantees
   shape, not correct evidence offsets, grounded claims, or appropriate review findings.
5. Store provider credentials only in the existing server-side credential store or
   provider-specific environment variables. Never return keys to Admin or persist them in
   `openblog.json`.
6. Fetch provider model lists only as a later enhancement. The first version should offer
   an editable model field with a documented default; live catalogs add network, caching,
   authentication, and model-capability reconciliation work.
7. Exclude GitHub from this release. If demand emerges, design a separate “Copilot SDK”
   integration around GitHub OAuth, subscription/organization policy, CLI lifecycle, and
   agent permissions rather than pretending it is another API-key provider.

