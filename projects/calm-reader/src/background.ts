import { callModel, SIMPLIFY_SYSTEM } from './provider';
import { getSettings, type Msg, type Reply } from './shared';

// Roughly 3,000 words. Longer text is cut and the user is told.
const MAX_CHARS = 18000;

async function handle(msg: Msg): Promise<Reply> {
  try {
    const settings = await getSettings();
    if (msg.type === 'simplify') {
      const cut = msg.text.length > MAX_CHARS;
      const text = cut ? msg.text.slice(0, MAX_CHARS) : msg.text;
      const out = await callModel(settings, SIMPLIFY_SYSTEM, `<text>\n${text}\n</text>`, 2048);
      return {
        ok: true,
        text: cut ? `${out}\n\n(The page was long, so only the first part was simplified.)` : out,
      };
    }
    if (msg.type === 'test-key') {
      await callModel(settings, 'Reply with the single word: ok', 'ping', 16);
      return { ok: true, text: 'Key works.' };
    }
    return { ok: false, error: 'Unknown request.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Something went wrong.' };
  }
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if (msg.type !== 'simplify' && msg.type !== 'test-key') return false;
  handle(msg).then(sendResponse);
  return true; // keep the channel open for the async reply
});
