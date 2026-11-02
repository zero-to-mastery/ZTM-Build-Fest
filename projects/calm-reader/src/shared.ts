export type ProfileId = 'dyslexia' | 'adhd' | 'calm';
export type Provider = 'anthropic' | 'openai';

export interface Prefs {
  enabled: boolean;
  profile: ProfileId;
  disabledHosts: string[];
}

export interface Settings {
  provider: Provider;
  apiKey: string;
  model: string;
}

export const DEFAULT_PREFS: Prefs = { enabled: false, profile: 'dyslexia', disabledHosts: [] };

export const PROVIDERS: Record<Provider, { label: string; origin: string; defaultModel: string }> = {
  anthropic: { label: 'Anthropic', origin: 'https://api.anthropic.com', defaultModel: 'claude-haiku-5-5' },
  openai: { label: 'OpenAI', origin: 'https://api.openai.com', defaultModel: 'gpt-4o-mini' },
};

export const DEFAULT_SETTINGS: Settings = { provider: 'anthropic', apiKey: '', model: '' };

export const PROFILES: { id: ProfileId; label: string; blurb: string }[] = [
  { id: 'dyslexia', label: 'Dyslexia', blurb: 'Clear font, wider spacing, warm background' },
  { id: 'adhd', label: 'ADHD', blurb: 'Narrow column, bigger text, hides pop-ups' },
  { id: 'calm', label: 'Calm', blurb: 'Muted colours, no motion, no ads or pop-ups' },
];

export async function getPrefs(): Promise<Prefs> {
  const r = await chrome.storage.local.get('prefs');
  return { ...DEFAULT_PREFS, ...(r.prefs ?? {}) };
}

export async function setPrefs(patch: Partial<Prefs>): Promise<void> {
  await chrome.storage.local.set({ prefs: { ...(await getPrefs()), ...patch } });
}

export async function getSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) };
}

export async function setSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ settings: s });
}

// Messages. 'simplify-page' goes popup -> content script.
// 'simplify' and 'test-key' go to the background service worker.
export type Msg = { type: 'simplify-page' } | { type: 'simplify'; text: string } | { type: 'test-key' };
export type Reply = { ok: true; text: string } | { ok: false; error: string };
