import { getSettings, PROVIDERS, setSettings, type Msg, type Provider, type Reply } from './shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const provider = $<HTMLSelectElement>('provider');
const key = $<HTMLInputElement>('key');
const model = $<HTMLInputElement>('model');
const status = $('status');

function say(text: string, isError = false): void {
  status.textContent = text;
  status.className = isError ? 'error' : '';
}

function syncPlaceholder(): void {
  model.placeholder = PROVIDERS[provider.value as Provider].defaultModel;
}

/** Saves, and asks the browser for access to the chosen provider only. Must run inside a click. */
async function save(): Promise<boolean> {
  const p = provider.value as Provider;
  const granted = await chrome.permissions.request({ origins: [`${PROVIDERS[p].origin}/*`] });
  if (!granted) {
    say(`Access to ${PROVIDERS[p].label} was not allowed, so Simplify cannot work.`, true);
    return false;
  }
  await setSettings({ provider: p, apiKey: key.value.trim(), model: model.value.trim() });
  return true;
}

async function init(): Promise<void> {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    provider.append(new Option(p.label, id));
  }
  const s = await getSettings();
  provider.value = s.provider;
  key.value = s.apiKey;
  model.value = s.model;
  syncPlaceholder();
  provider.addEventListener('change', syncPlaceholder);

  $('save').addEventListener('click', async () => {
    if (await save()) say('Saved.');
  });

  $('test').addEventListener('click', async () => {
    if (!(await save())) return;
    say('Testing…');
    const reply: Reply = await chrome.runtime.sendMessage({ type: 'test-key' } satisfies Msg);
    if (reply.ok) say('Key works.');
    else say(reply.error, true);
  });
}

void init();
