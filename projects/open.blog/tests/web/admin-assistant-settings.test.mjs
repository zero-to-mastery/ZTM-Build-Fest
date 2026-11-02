import test from "node:test";
import assert from "node:assert/strict";

import { ASSISTANT_PROVIDERS, Editor, assistantStatusPresentation } from "../../web/admin/admin.js";

test("provider settings load and replace a write-only credential without revealing it", async () => {
  const calls = [];
  let reads = 0;
  const app = {
    meta: { quizGeneration: false },
    api: {
      call: async (method, path, request) => {
        calls.push({ method, path, request });
        if (method === "GET") {
          reads += 1;
          return {
            provider: "custom-https",
            generationEndpoint: "https://assistant.example/generate",
            model: "writer-v1",
            etag: `revision-${reads}`,
            credential: { configured: true, source: "private" },
          };
        }
        return {
          provider: request.json.provider,
          generationEndpoint: request.json.generationEndpoint,
          model: request.json.model,
          etag: "revision-2",
          credential: { configured: true, source: "private" },
        };
      },
    },
  };
  const editor = new Editor(app, { kind: "posts", fields: {} });
  editor.ui = {
    assistantSettingsProvider: { value: "custom-https" },
    assistantEndpointField: { hidden: false },
    assistantSettingsStatus: { textContent: "" },
    assistantSettingsEndpoint: { value: "" },
    assistantSettingsModel: { value: "" },
    assistantSettingsCredential: { value: "" },
    assistantSettingsSave: { disabled: false },
    assistantSettingsClear: { disabled: false },
  };
  editor.loadAssistantStatus = async () => ({ configured: true, capabilities: { knowledgeChecks: true, codeInteractions: true } });

  await editor.loadAssistantSettings();
  assert.equal(editor.ui.assistantSettingsEndpoint.value, "https://assistant.example/generate");
  assert.equal(editor.ui.assistantSettingsModel.value, "writer-v1");
  assert.equal(editor.ui.assistantSettingsCredential.value, "");
  assert.match(editor.ui.assistantSettingsStatus.textContent, /private credential is saved/i);
  assert.equal(editor.ui.assistantSettingsClear.disabled, false);

  editor.ui.assistantSettingsCredential.value = "replacement-secret";
  await editor.saveAssistantSettings("save");
  assert.deepEqual(calls[1], {
    method: "PUT",
    path: "assistant/settings",
    request: {
      json: {
        provider: "custom-https",
        generationEndpoint: "https://assistant.example/generate",
        model: "writer-v1",
        etag: "revision-1",
        credentialAction: "replace",
        credential: "replacement-secret",
      },
    },
  });
  assert.equal(editor.ui.assistantSettingsCredential.value, "");
  assert.equal(editor.ui.assistantSettingsSave.disabled, false);
  assert.equal(editor.ui.assistantSettingsClear.disabled, false);
  assert.equal(app.meta.quizGeneration, true, "knowledge-check generation becomes available without reloading Admin");
  assert.equal(app.meta.codeInteractionGeneration, true, "runnable-code generation becomes available without reloading Admin");
});

test("selecting Anthropic hides the custom endpoint and supplies a useful model default", () => {
  const editor = new Editor({ api: {} }, { kind: "posts", fields: {} });
  editor.ui = {
    assistantSettingsProvider: { value: "anthropic" },
    assistantSettingsEndpoint: { disabled: false },
    assistantEndpointField: { hidden: false },
    assistantSettingsModel: { value: "" },
  };

  editor.updateAssistantProviderFields();

  assert.equal(editor.ui.assistantEndpointField.hidden, true);
  assert.equal(editor.ui.assistantSettingsEndpoint.disabled, true);
  assert.equal(editor.ui.assistantSettingsModel.value, "claude-sonnet-5-5");
});

test("switching from a custom provider replaces its model with the Claude default", () => {
  const editor = new Editor({ api: {} }, { kind: "posts", fields: {} });
  editor.ui = {
    assistantSettingsProvider: { value: "anthropic" },
    assistantSettingsEndpoint: { disabled: false },
    assistantEndpointField: { hidden: false },
    assistantSettingsModel: { value: "writer-v1" },
  };

  editor.updateAssistantProviderFields(true);

  assert.equal(editor.ui.assistantSettingsModel.value, "claude-sonnet-5-5");
});

test("native providers expose friendly labels and provider-specific model defaults", () => {
  const expected = {
    "open-ai": "gpt-6-luna",
    gemini: "gemini-3.8-flash",
    xai: "grok-4.7",
    "deep-seek": "deepseek-flash",
    mistral: "mistral-small-latest",
    "open-router": "",
  };
  for (const [provider, defaultModel] of Object.entries(expected)) {
    const editor = new Editor({ api: {} }, { kind: "posts", fields: {} });
    editor.ui = {
      assistantSettingsProvider: { value: provider },
      assistantSettingsEndpoint: { disabled: false },
      assistantEndpointField: { hidden: false },
      assistantSettingsModel: { value: "old-provider-model" },
    };
    editor.updateAssistantProviderFields(true);
    assert.equal(editor.ui.assistantSettingsEndpoint.disabled, true);
    assert.equal(editor.ui.assistantEndpointField.hidden, true);
    assert.equal(editor.ui.assistantSettingsModel.value, defaultModel);
  }
  assert.equal(ASSISTANT_PROVIDERS["open-router"].label, "OpenRouter");
  assert.equal(assistantStatusPresentation({ providerType: "open-ai" }).providerType, "OpenAI");
});

test("environment precedence is announced and clearing never submits a credential", async () => {
  let submitted;
  const editor = new Editor(
    {
      api: {
        call: async (method, path, request) => {
          if (method === "PUT") submitted = request.json;
          return method === "GET"
            ? { provider: "custom-https", generationEndpoint: "", model: "", etag: "revision-1", credential: { configured: true, source: "environment" } }
            : { etag: "revision-2", credential: { configured: true, source: "environment" } };
        },
      },
    },
    { kind: "posts", fields: {} },
  );
  editor.ui = {
    assistantSettingsProvider: { value: "custom-https" },
    assistantEndpointField: { hidden: false },
    assistantSettingsStatus: { textContent: "" },
    assistantSettingsEndpoint: { value: "" },
    assistantSettingsModel: { value: "" },
    assistantSettingsCredential: { value: "must-not-be-sent" },
    assistantSettingsSave: { disabled: false },
    assistantSettingsClear: { disabled: false },
  };
  editor.loadAssistantStatus = async () => {};
  await editor.loadAssistantSettings();
  assert.match(editor.ui.assistantSettingsStatus.textContent, /environment credential takes precedence/i);
  assert.equal(editor.ui.assistantSettingsClear.disabled, true);
  await editor.saveAssistantSettings("clear");
  assert.equal(submitted.credentialAction, "clear");
  assert.equal("credential" in submitted, false);
  assert.equal(editor.ui.assistantSettingsClear.disabled, true);
});

test("provider status failures leave a clear unavailable state", async () => {
  const editor = new Editor(
    { api: { call: async () => { throw new Error("offline"); } } },
    { kind: "posts", fields: {} },
  );
  editor.ui = {
    assistantStatus: { textContent: "" },
    assistantStatusBadge: { textContent: "Checking…", dataset: { tone: "loading" } },
  };
  editor.renderAssistantReviewSummary = () => {};

  assert.equal(await editor.loadAssistantStatus(), null);
  assert.equal(editor.ui.assistantStatusBadge.textContent, "Unavailable");
  assert.equal(editor.ui.assistantStatusBadge.dataset.tone, "invalid");
  assert.match(editor.ui.assistantStatus.textContent, /could not be loaded/i);
});

test("removing a write-only credential requires explicit confirmation", async () => {
  let submitted = false;
  let prompt = "";
  const editor = new Editor(
    { api: { call: async () => { submitted = true; return {}; } } },
    { kind: "posts", fields: {} },
  );
  editor.assistantCredentialSource = "environment";
  editor.saveAssistantSettings = async (action) => {
    assert.equal(action, "clear");
    submitted = true;
  };
  const originalConfirm = globalThis.confirm;
  try {
    globalThis.confirm = (message) => {
      prompt = message;
      return false;
    };
    await editor.clearAssistantCredential();
    assert.equal(submitted, false);
    assert.match(prompt, /permanently remove/i);
    assert.match(prompt, /environment credential will remain active/i);

    globalThis.confirm = () => true;
    await editor.clearAssistantCredential();
    assert.equal(submitted, true);
  } finally {
    globalThis.confirm = originalConfirm;
  }
});
