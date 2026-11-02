import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
export const browser = process.env.CONSTELLATION_BROWSER || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => existsSync(path));

// Cold Chrome starts on hosted runners can exceed 15 seconds. Browser tests
// allow 120 seconds overall, leaving time for their assertions after startup.
export async function waitForDevToolsPort(path, { isRunning = () => true, timeoutMs = 60000, pollIntervalMs = 100, readPortFile = readFile } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isRunning()) {
    try {
      // Chrome creates this file before writing it. Require a complete, valid
      // port line so an empty or partial write cannot end the startup wait.
      const match = /^(\d+)\r?\n/.exec(await readPortFile(path, 'utf8'));
      if (match && Number(match[1]) > 0 && Number(match[1]) <= 65535) return match[1];
    } catch (error) {
      // Windows can temporarily deny reads while Chrome creates the file.
      if (!['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
    }
    await delay(pollIntervalMs);
  }
}


export async function openBrowser(t, url) {
  const profile = await mkdtemp(join(tmpdir(), 'constellation-browser-'));
  // Hosted Linux runners restrict Chrome's namespace sandbox. This isolated
  // test browser only loads our localhost fixtures and uses a disposable profile.
  const runnerArgs = process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
  const env = { ...process.env };
  if (process.platform === 'linux') {
    env.XDG_CACHE_HOME = join(profile, 'cache');
    env.XDG_CONFIG_HOME = join(profile, 'config');
    await mkdir(env.XDG_CACHE_HOME, { recursive: true });
    await mkdir(env.XDG_CONFIG_HOME, { recursive: true });
  }
  const child = spawn(browser, ['--headless=new', ...runnerArgs, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let launchError = '', diagnostics = '';
  child.on('error', error => { launchError = error.message; });
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
  let socket, cdp;
  t.after(async () => {
    if (cdp) try { await cdp('Browser.close'); } catch {}
    socket?.close();
    if (child.exitCode === null && child.signalCode === null && !launchError) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      let timer;
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    for (let i = 0; i < 20; i++) { try { await rm(profile, { recursive: true, force: true }); break; } catch { await delay(100); } }
  });
  const port = await waitForDevToolsPort(join(profile, 'DevToolsActivePort'), {
    isRunning: () => !launchError && child.exitCode === null && child.signalCode === null,
  });
  assert.ok(port, `Chromium did not start: ${launchError || diagnostics || 'DevTools port unavailable'}`);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let next = 0; const pending = new Map(), errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const item = pending.get(message.id); if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result);
  });
  cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject, timer: setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000) }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? {sessionId} : {}) })); });
  const evaluate = async expression => { const value = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text); return value.result.value; };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Page.navigate', { url });
  const waitFor = async (expression, timeoutMs = 10000) => { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(100); } throw Error('Browser condition timed out: '+expression); };
  return { cdp, evaluate, errors, waitFor };
}
