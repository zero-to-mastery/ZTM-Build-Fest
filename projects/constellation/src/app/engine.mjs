// Bridge between the Studio and the Constellation engine. This is the only
// module that talks to GitHub, the Rust/WASM engine and the renderers. Every
// error leaving it is a sentence a visitor can act on.

import { createGitHubSession } from '../github-session.mjs';
import { createGitHubOAuth } from '../github-oauth.mjs';
import { createPreviewFetch, createPreviewData, createPinnedFetch, canRenderPreview } from '../preview-data.mjs';
import { createDataPipeline } from '../pipeline-cache.mjs';
import { createScene, selectRepositories, username as parseUsername } from '../constellation.mjs';
import { renderSceneSVG } from '../renderer-svg.mjs';
import { presetOptions } from '../studio-presets.mjs';
import { composeCSS } from './settings.mjs';
import { applyMotion } from './motion.mjs';
import { visualThemes } from '../themes.mjs';
import { explainNode } from '../evidence.mjs';
import { aggregateActivity } from '../activity.mjs';
import { deriveCodingRhythm } from '../coding-rhythm.mjs';
import { rustAvailable } from '../engine.mjs';

const SAMPLE_ACCOUNT = 'your-universe';
// The Studio's own page colours (app.css --bg), light then dark.
const SEE_THROUGH_BACKDROP = 'svg{background:#f6f7fb!important}@media(prefers-color-scheme:dark){svg{background:#0b0e1a!important}}';
const SAMPLE_GROUPS = {
  TypeScript: ['constellation', 'little-notes', 'orbit-ui', 'weekend-build', 'palette'],
  JavaScript: ['tiny-worlds', 'garden', 'soundwaves', 'daydream'],
  Python: ['stargazer', 'field-notes', 'moonrise'],
  Rust: ['lightbeam', 'wayfinder'],
  CSS: ['soft-shadows', 'nightfall'],
};

function sampleRepositories() {
  return Object.entries(SAMPLE_GROUPS).flatMap(([language, names]) => names.map((name, index) => ({
    name,
    full_name: `${SAMPLE_ACCOUNT}/${name}`,
    html_url: `https://github.com/${SAMPLE_ACCOUNT}/${name}`,
    description: `An example ${language} project.`,
    language,
    languages: { [language]: 1000, ...(['JavaScript', 'TypeScript', 'CSS'].includes(language) ? { HTML: 80, CSS: 60 } : {}) },
    topics: index % 2 ? ['creative-coding'] : ['web', 'tools'],
    stargazers_count: [42, 18, 7, 3, 1][index],
    fork: false,
  }))).map((repo, index) => ({
    ...repo,
    created_at: `${2012 + (index % 15)}-01-01T00:00:00Z`,
    pushed_at: `${index % 4 ? 2025 : 2026}-01-01T00:00:00Z`,
    updated_at: `${index % 4 ? 2025 : 2026}-01-01T00:00:00Z`,
    archived: index === 15,
  }));
}

/** The look a new visitor sees first: readable, colourful, calm. */
export function defaultOptions(account, repositories = [], profile = null) {
  const organization = profile?.type === 'Organization';
  // New skies move gently: twinkling stars and slowly turning rings.
  return applyMotion({
    ...presetOptions('project-map', { accountType: organization ? 'organization' : 'auto' }),
    visualTheme: 'deep-space',
    // True circles; Wide (the engine default, kept for existing designs) is one click away.
    orbitShape: 'round',
    maxRepos: Math.min(45, Math.max(1, repositories.length)),
    includeForks: false,
    legend: false,
  }, 'gentle');
}

export function friendlyError(error, { localAuth = false } = {}) {
  const message = String(error?.message || error || '');
  if (error instanceof TypeError || /Failed to fetch|NetworkError|internetdisconnected/i.test(message)) {
    return 'We couldn’t reach GitHub. Check your connection and try again.';
  }
  // Status codes arrive as "(403)" or "(HTTP 403)" depending on the request path.
  if (/request limit|rate limit|\b(403|429)\b/i.test(message)) {
    return localAuth
      ? 'GitHub’s limit for your local token has been reached. Try again after it resets.'
      : 'GitHub has paused requests from this browser for a while. Sign in with GitHub to keep going, or try again later.';
  }
  if (/\b404\b|not found|could not find/i.test(message)) return 'We couldn’t find that GitHub account. Check the spelling and try again.';
  if (/Enter a GitHub username/i.test(message)) return 'Enter a GitHub username, like “octocat”.';
  if (/No pinned projects/i.test(message)) return 'This account hasn’t pinned any projects on its GitHub profile.';
  if (/No public projects|empty/i.test(message)) return 'This account doesn’t have any public projects yet.';
  if (/rejected your local token|\b401\b/i.test(message)) return 'GitHub rejected the token. Sign in again.';
  return message || 'Something went wrong. Try again.';
}

export function createEngine({
  win = globalThis.window,
  doc = globalThis.document,
  fetchImpl = globalThis.fetch?.bind(globalThis),
} = {}) {
  let sessionStore;
  try { sessionStore = win?.sessionStorage; } catch {}
  const meta = (name) => doc?.querySelector(`meta[name="${name}"]`)?.content || '';
  const proxyBase = meta('constellation-api');
  const localAuth = meta('constellation-auth') === 'authenticated';
  const listeners = new Set();
  const session = createGitHubSession({ fetchImpl, onChange: (profile) => { for (const fn of listeners) fn(profile); } });
  const previewFetch = createPreviewFetch({ proxyBase, fetchImpl, session, storage: sessionStore, localAuth });
  const access = previewFetch.access;
  const pipeline = createDataPipeline();
  const data = createPreviewData({
    storage: sessionStore,
    fetchImpl: previewFetch,
    fetchPinned: createPinnedFetch({ proxyBase, fetchImpl, session, localAuth }),
  });
  const clientId = meta('constellation-oauth-client');
  const exchangeUrl = meta('constellation-oauth-exchange');
  // GitHub sends people back only to the app's registered callback, and the
  // exchange answers only that origin. A copy served anywhere else (a local
  // preview, a fork) can't complete sign-in, so it doesn't offer it. With no
  // registered callback given, any address is assumed to work.
  const registered = meta('constellation-oauth-redirect');
  const here = win ? win.location.origin + win.location.pathname : '';
  const atRegistered = !registered || here === registered || here === `${registered}index.html`;
  const oauth = createGitHubOAuth({
    clientId,
    exchangeUrl,
    redirectUri: registered || here,
    storage: sessionStore,
  });
  const local = win ? ['localhost', '127.0.0.1'].includes(win.location.hostname) : false;
  const loadedAt = new Map();

  function activityInputs(account, repositories, options, generatedAt, sample) {
    if (sample) return {};
    const snapshot = data.activity(account);
    if (!snapshot) return {};
    return {
      historyData: snapshot,
      activityData: aggregateActivity(snapshot.events, selectRepositories(repositories, options), options, snapshot.asOf),
      codingRhythmData: deriveCodingRhythm(snapshot.events, options, options.activityMetricDate || snapshot.asOf),
    };
  }

  return {
    rustAvailable,
    access,
    get signedIn() { return Boolean(session.profile) || localAuth; },
    get viewer() { return session.profile || null; },
    onSessionChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    signIn: {
      /** True when the hosted OAuth exchange is configured for this deployment. */
      configured: Boolean(clientId && exchangeUrl && atRegistered),
      /** A personal token can be pasted only on a local preview. */
      tokenAllowed: local,
      local: localAuth,
      async begin() { return oauth.begin(); },
      async complete(href) {
        const token = await oauth.complete(href);
        return token ? session.signIn(token) : null;
      },
      async withToken(token) { return session.signIn(token); },
      /** Abandon a sign-in still being checked, so it can't complete silently. */
      cancel() { session.cancelSignIn(); },
      signOut() {
        oauth.cancel();
        session.signOut();
        previewFetch.requestCache?.clear();
      },
    },

    parseUsername,

    sample() {
      return { account: SAMPLE_ACCOUNT, repositories: sampleRepositories(), profile: { login: SAMPLE_ACCOUNT, type: 'User' } };
    },

    /** Load an account's public projects. Throws friendly errors. */
    /** repoSource: 'all' public projects, or 'pinned' (signed in). */
    async load(input, { refresh = false, onProgress, repoSource = 'all' } = {}) {
      let account;
      try { account = parseUsername(input); } catch (error) { throw new Error(friendlyError(error)); }
      try {
        const options = defaultOptions(account);
        const repositories = await data.load(account, { ...options, maxRepos: 100, includeForks: true, repoSource }, {
          refresh,
          onProgress,
          activity: false,
        });
        if (!repositories?.length) throw new Error(repoSource === 'pinned' ? 'No pinned projects' : 'No public projects');
        const profile = data.profile(account) || { login: account, type: 'User' };
        const canonical = profile.login || account;
        loadedAt.set(canonical.toLowerCase(), new Date().toISOString());
        return { account: canonical, repositories, profile };
      } catch (error) {
        throw new Error(friendlyError(error, { localAuth }));
      }
    },

    /** Fetch recent public activity on demand (signed-in only). */
    async loadActivity(account) {
      if (!access.capabilities.activity) throw new Error('Sign in with GitHub to load recent activity.');
      try { return await data.loadActivity(account, false); }
      catch (error) { throw new Error(friendlyError(error, { localAuth })); }
    },

    /** A message when public requests are paused, else null. */
    rateLimitMessage() {
      const limit = previewFetch.requestCache?.publicRateLimit?.();
      if (!limit?.stopped) return null;
      return 'GitHub has paused requests from this browser for a while. Your current map still works; sign in to load more.';
    },

    /**
     * Build the scene and SVG for the current design. Synchronous and pure for
     * the same inputs; generatedAt is fixed per loaded account so edits never
     * reshuffle the sky.
     */
    render(account, repositories, options, { sample = false, generatedAt } = {}) {
      const at = generatedAt || loadedAt.get(String(account).toLowerCase()) || '2026-01-01T00:00:00.000Z';
      const diagnostics = [];
      const full = {
        ...options,
        // Share links drop the derived css; rebuild it so they draw the same.
        ...(options.visualStyle || options.customCSS !== undefined ? { css: composeCSS(options) } : {}),
        accountData: sample ? undefined : data.profile(account),
        organizationData: sample ? undefined : data.organization(account),
        ...activityInputs(account, repositories, options, at, sample),
        generatedAt: at,
      };
      if (!sample && !canRenderPreview(repositories, full, access, { allowPrimaryLanguages: true })) {
        throw new Error('Nothing matches these settings. Include more projects or loosen the filters.');
      }
      let scene;
      try {
        scene = createScene(account, repositories, full, { pipeline, onDiagnostic: (d) => diagnostics.push(d) });
      } catch (error) {
        throw new Error(`This combination can’t be drawn: ${error.message}`);
      }
      const svg = renderSceneSVG(scene);
      return { scene, svg, diagnostics };
    },

    /** A small, still preview of `options` for gallery cards. */
    thumbnail(account, repositories, options, { sample = false } = {}) {
      const still = {
        ...options,
        animate: false,
        starlightAnimate: false,
        activityAnimate: false,
        legend: false,
        semanticLegend: false,
        ringAnimation: { ...(options.ringAnimation || {}), enabled: false },
        floatingAnimation: { ...(options.floatingAnimation || {}), enabled: false },
        perspective: { ...(options.perspective || {}), animate: false },
        maxRepos: Math.min(options.maxRepos || 30, 30),
      };
      // The "Generated … UTC" stamp matters on a published image, not a preview card.
      let svg = this.render(account, repositories, still, { sample }).svg.replace(/<text class="generated-at"[^>]*>[^<]*<\/text>/, '');
      // See-through themes take their backdrop from wherever they're shown (a
      // README is light or dark), so preview them on the page's own background.
      if (visualThemes[options.visualTheme]?.transparent) {
        svg = svg.replace('<style>', `<style>${SEE_THROUGH_BACKDROP}`);
      }
      return svg;
    },

    explain(scene, nodeId) {
      const target = scene?.kind === 'time-lapse' ? scene.latest : scene;
      try { return explainNode(target, nodeId); } catch { return null; }
    },
  };
}
