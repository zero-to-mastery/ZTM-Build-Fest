import { getPrefs, PROFILES, setPrefs, type Msg } from './shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function hostOf(url?: string): string | null {
  try {
    const u = new URL(url ?? '');
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null;
  } catch {
    return null;
  }
}

async function init(): Promise<void> {
  const prefs = await getPrefs();
  const tab = await activeTab();
  const host = hostOf(tab?.url);

  const enabled = $<HTMLInputElement>('enabled');
  enabled.checked = prefs.enabled;
  enabled.addEventListener('change', () => void setPrefs({ enabled: enabled.checked }));

  const group = $('profiles');
  for (const p of PROFILES) {
    const label = document.createElement('label');
    label.className = 'choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'profile';
    input.value = p.id;
    input.checked = prefs.profile === p.id;
    input.addEventListener('change', () => void setPrefs({ profile: p.id }));
    const text = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = p.label;
    const blurb = document.createElement('small');
    blurb.textContent = p.blurb;
    text.append(name, blurb);
    label.append(input, text);
    group.append(label);
  }

  const site = $<HTMLInputElement>('site-off');
  if (host) {
    $('site-label').textContent = `Off on ${host}`;
    site.checked = prefs.disabledHosts.includes(host);
    site.addEventListener('change', async () => {
      const current = (await getPrefs()).disabledHosts.filter((h) => h !== host);
      if (site.checked) current.push(host);
      await setPrefs({ disabledHosts: current });
    });
  } else {
    $('site-row').hidden = true;
  }

  const status = $('status');
  $('simplify').addEventListener('click', async () => {
    if (!tab?.id || !host) {
      status.textContent = 'Simplify only works on normal web pages.';
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'simplify-page' } satisfies Msg);
      window.close();
    } catch {
      status.textContent = 'Reload this page, then try again.';
    }
  });

  $('settings').addEventListener('click', (e) => {
    e.preventDefault();
    void chrome.runtime.openOptionsPage();
  });
}

void init();
