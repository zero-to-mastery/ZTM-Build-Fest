// "Get your map": the one place a design leaves the Studio. A list of five
// plain destinations; each opens a short step inside the same dialog. Every
// output comes from the existing export contracts (workflow, README snippet,
// renderers, share links, config v7); nothing here talks to GitHub.

import { h, icon, announce } from '../../dom.mjs';
import { readmeSnippet, renderWorkflow, installationLinks } from '../../../export.mjs';
import { svgToPNG, downloadBlob } from '../../../export-image.mjs';
import { encodeShare, publicShareBase } from '../../../share-link.mjs';
import { serializeConfig, MAX_CONFIG_BYTES } from '../../../config-schema.mjs';
import { friendlyError } from '../../engine.mjs';

const CHOICES = [
  { id: 'profile', icon: 'github', title: 'Add it to your GitHub profile', desc: 'Updates itself every day.' },
  { id: 'image', icon: 'download', title: 'Download an image', desc: 'SVG or PNG, ready to use anywhere.' },
  { id: 'website', icon: 'sparkle', title: 'Put it on a website', desc: 'An interactive page you can host.' },
  { id: 'link', icon: 'link', title: 'Share a link', desc: 'Anyone can open your design.' },
  { id: 'settings', icon: 'folder', title: 'Save the settings file', desc: 'Back up this design or open one.' },
];
const REPOSITORY = /^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i;
// Same guard the old publishing flow used, widened to the formats offered here.
const SAFE_FILENAME = /^[a-z\d][a-z\d._-]{0,120}\.(svg|png|html|json)$/;
const COPIED_MS = 2000;
const SAVED_MS = 6000;
// A bare repository name ("octo-sky") the visitor probably meant under their account.
const BARE_NAME = /^[a-z\d_.-]+$/i;
const PROBLEMS_URL = 'https://github.com/mnichols08/constellation/blob/main/docs/publishing.md';
// Steps whose output is the current design, so a design that can't be drawn blocks them.
const DESIGN_STEPS = new Set(['profile', 'image', 'website', 'link', 'settings']);

let cssLoaded = false;

/** Lowercase [a-z0-9-] slug so a GitHub login can never shape a path. */
function slug(account) {
  return String(account || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'map';
}

function filename(account, extension) {
  const name = `constellation-${slug(account)}.${extension}`;
  if (!SAFE_FILENAME.test(name)) throw new Error('Could not make a safe file name.');
  return name;
}

function saveFile(content, name, type) {
  downloadBlob(content instanceof Blob ? content : new Blob([content], { type }), name);
}

export function createGetItDialog(ctx) {
  const { store, actions, doc, win } = ctx;
  if (!cssLoaded && !doc.querySelector('link[data-get-it-css]')) {
    doc.head.append(h('link', { rel: 'stylesheet', href: new URL('./get-it.css', import.meta.url).href, 'data-get-it-css': '' }));
  }
  cssLoaded = true;

  let step = null;
  let lastChoice = null;
  let repository = null; // the profile repository the visitor typed, kept across steps
  // The dialog host routes announcements to the open sheet's live region.
  const say = announce;
  let shownState = null; // the map state the open step was built for

  // Rebuild the open step when the map becomes drawable again (after Undo, say)
  // or stops being drawable, so it never offers an export that doesn't match.
  store.subscribe((state, changed) => {
    if (!changed.has('render') || state.dialog !== 'get-it' || !DESIGN_STEPS.has(step)) return;
    if (viewState() !== shownState) go(step);
  });

  // ------------------------------------------------------------- helpers
  function go(next) {
    if (step) lastChoice = step;
    step = next;
    ctx.refreshDialog();
    queueMicrotask(() => {
      const sheet = doc.querySelector('dialog[open]');
      const target = step
        ? sheet?.querySelector('[data-step-heading]')
        : sheet?.querySelector(`[data-choice="${lastChoice}"]`);
      target?.focus();
    });
  }

  function notice(text, tone, { alert = false } = {}) {
    return h('p', { class: 'notice', dataset: tone ? { tone } : undefined, role: alert ? 'alert' : undefined },
      icon(tone === 'success' ? 'check' : 'info', { size: 18 }), h('span', { text }));
  }

  /** A button that copies text, then says "Copied" for a moment. */
  function copyButton(getText, { label = 'Copy', suffix = '', selectTarget, primary = false, size = 'btn-sm' } = {}) {
    const text = h('span', { text: label });
    const glyph = h('span', { class: 'get-it-glyph' }, icon('copy', { size: 16 }));
    let timer = null;
    const button = h('button', {
      class: `btn ${primary ? 'btn-primary' : size}`, type: 'button', 'data-primary': primary || undefined,
      onclick: async () => {
        const value = getText();
        if (!value) return;
        try {
          if (!win.navigator.clipboard?.writeText) throw new Error('No clipboard');
          await win.navigator.clipboard.writeText(value);
          clearTimeout(timer);
          text.textContent = 'Copied';
          glyph.replaceChildren(icon('check', { size: 16 }));
          say('Copied to clipboard');
          timer = setTimeout(() => {
            text.textContent = label;
            glyph.replaceChildren(icon('copy', { size: 16 }));
          }, COPIED_MS);
        } catch {
          // Clipboard blocked: select the text so one keystroke finishes the job.
          const target = selectTarget?.();
          if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
            target.focus();
            target.select();
          } else if (target) {
            const range = doc.createRange();
            range.selectNodeContents(target);
            const selection = win.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            target.focus?.();
          }
          const mac = /Mac|iPhone|iPad/.test(win.navigator.platform || '');
          say(mac ? 'Press Command+C to copy' : 'Press Ctrl+C to copy');
        }
      },
    }, glyph, text, suffix ? h('span', { class: 'visually-hidden', text: ` ${suffix}` }) : null);
    return button;
  }

  /** Read-only code with a Copy button. */
  function codeBox(label, value, suffix = label) {
    const code = h('code', { text: value });
    const pre = h('pre', { tabindex: '0', role: 'region', 'aria-label': label }, code);
    // Visible "Copy", spoken "Copy README snippet": label-in-name stays true.
    const copy = copyButton(() => code.textContent, { selectTarget: () => pre, suffix });
    const set = (text) => { code.textContent = text; copy.disabled = !text; };
    set(value);
    return { element: h('div', { class: 'code-box' }, pre, copy), set };
  }

  function stepFrame(title, intro, ...content) {
    const back = h('button', { class: 'btn btn-ghost btn-sm get-it-back', type: 'button', onclick: () => go(null) }, icon('back', { size: 18 }), 'Back');
    return h('section', { class: 'get-it-step', 'aria-labelledby': 'get-it-step-title' },
      back,
      h('h3', { id: 'get-it-step-title', tabindex: '-1', 'data-step-heading': '', text: title }),
      intro ? h('p', { class: 'get-it-intro', text: intro }) : null,
      ...content);
  }

  const current = () => store.get();
  const render = () => current().render;

  /** 'broken' when the latest settings failed to draw (an older map may still be kept). */
  function mapState() {
    const result = render();
    if (result?.error) return 'broken';
    return result?.svg && result?.scene ? 'ready' : 'missing';
  }

  /** What the open step depends on: only the picture steps wait for a map. */
  function viewState() {
    const state = mapState();
    return state === 'broken' || ['image', 'website'].includes(step) ? state : 'ok';
  }

  /** Shown instead of any export while the settings can't be drawn. */
  function brokenNotice() {
    return [
      notice('Your current settings can’t be drawn. Close this and undo the last change, then try again.', 'error'),
      h('button', {
        class: 'btn btn-primary get-it-undo', type: 'button', 'data-primary': '',
        // The store subscription rebuilds this step once the map draws again.
        onclick: () => actions.undo(),
      }, icon('undo', { size: 18 }), 'Undo the last change'),
    ];
  }

  function needMap() {
    const state = mapState();
    if (state === 'broken') return brokenNotice();
    if (state === 'ready') return null;
    return [notice('Your map isn’t ready yet. Close this and try again in a moment.', 'error')];
  }

  /** A visible "saved" note in the step's status area that clears itself. */
  function savedNotice(status, name) {
    const text = `Saved ${name} to your downloads.`;
    const note = notice(text, 'success');
    status.replaceChildren(note);
    say(text);
    setTimeout(() => { if (note.isConnected) note.remove(); }, SAVED_MS);
  }

  // --------------------------------------------------------------- steps
  function profileStep() {
    const { account, sample, profile, options } = current();
    const title = 'Add it to your GitHub profile';
    if (sample) {
      return stepFrame(title, null,
        notice('Load your own GitHub account to add it to a profile.'),
        h('button', { class: 'btn btn-primary', type: 'button', 'data-primary': '', onclick: () => actions.goHome() }, icon('github', { size: 18 }), 'Load my account'));
    }
    if (mapState() === 'broken') return stepFrame(title, null, ...brokenNotice());
    const organization = profile?.type === 'Organization';
    const fallback = organization ? `${account}/.github` : `${account}/${account}`;
    const input = h('input', {
      class: 'input', id: 'get-it-repo', type: 'text', value: repository || fallback, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false',
      'aria-describedby': 'get-it-repo-help get-it-repo-error', maxlength: '140',
    });
    const error = h('p', { class: 'get-it-error', id: 'get-it-repo-error', hidden: true });
    // One click fixes the most common slip: typing only the repository name.
    const suggestion = h('button', {
      class: 'btn btn-sm get-it-suggest', type: 'button', hidden: true,
      onclick: () => {
        input.value = suggestion.dataset.value;
        update();
        input.focus();
      },
    });
    // The file is long and technical, so it stays folded; copying never needs it open.
    let yaml = '';
    const workflowCode = h('code');
    const workflowPre = h('pre', { tabindex: '0', role: 'region', 'aria-label': 'Workflow file' }, workflowCode);
    const workflowBox = h('details', { class: 'get-it-details' }, h('summary', { text: 'Show the file' }), h('div', { class: 'code-box' }, workflowPre));
    const copyFile = copyButton(() => yaml, { label: 'Copy the file', size: '', selectTarget: () => { workflowBox.open = true; return workflowPre; } });
    const snippet = codeBox('README snippet', '');
    const create = h('a', { class: 'btn btn-primary', 'data-primary': '', target: '_blank', rel: 'noopener noreferrer' }, icon('github', { size: 18 }), h('span', { text: 'Create the file on GitHub' }));
    const tooBig = h('p', { class: 'field-help', hidden: true,
      text: 'Your settings are too big to fill in on GitHub for you. Copy the file, then on GitHub add a new file named .github/workflows/constellation.yml.' });
    const newRepo = h('a', { class: 'get-it-inline-link', target: '_blank', rel: 'noopener noreferrer', text: 'Create it on GitHub' });
    const run = h('a', { class: 'btn', target: '_blank', rel: 'noopener noreferrer' }, h('span', { text: 'Open the Actions page' }), icon('arrowRight', { size: 18 }));
    const where = organization ? 'Paste this into profile/README.md' : 'Paste this into your README';
    const readmePath = organization ? 'profile/README.md' : 'README.md';
    const editReadme = h('a', { class: 'btn', target: '_blank', rel: 'noopener noreferrer' }, icon('github', { size: 18 }), h('span', { text: 'Edit your README on GitHub' }));
    const profileUrl = `https://github.com/${encodeURIComponent(account)}`;

    function disable(link) {
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
    }
    function enable(link, href) {
      link.href = href;
      link.removeAttribute('aria-disabled');
    }
    function invalid(message) {
      error.textContent = message;
      error.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      snippet.set('');
      yaml = '';
      workflowCode.textContent = '';
      copyFile.disabled = true;
      for (const link of [create, run, newRepo, editReadme]) disable(link);
      tooBig.hidden = true;
    }
    function update() {
      const target = input.value.trim();
      repository = input.value;
      const valid = REPOSITORY.test(target) && !['.', '..'].includes(target.split('/')[1]);
      const bare = !valid && BARE_NAME.test(target) && !['.', '..'].includes(target);
      suggestion.hidden = !bare;
      if (bare) {
        suggestion.dataset.value = `${account}/${target}`;
        suggestion.textContent = `Did you mean ${account}/${target}?`;
      }
      if (!valid) {
        invalid(`Enter the repository as owner/name, like ${fallback}.`);
        return;
      }
      try {
        const owner = target.split('/')[0];
        // Name the account explicitly when the file lives under someone else.
        yaml = renderWorkflow(account, options, { filename: 'constellation.svg', sourceAccount: owner.toLowerCase() !== String(account).toLowerCase() });
        const links = installationLinks(target, yaml);
        workflowCode.textContent = yaml;
        snippet.set(readmeSnippet(account, target));
        enable(create, links.install || links.create);
        create.lastElementChild.textContent = links.install ? 'Create the file on GitHub' : 'Create the repository on GitHub';
        tooBig.hidden = Boolean(links.install);
        enable(run, links.actions);
        enable(newRepo, links.create);
        const name = target.split('/')[1];
        enable(editReadme, `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/edit/HEAD/${readmePath}`);
        copyFile.disabled = false;
        error.hidden = true;
        input.removeAttribute('aria-invalid');
      } catch (failure) {
        invalid(friendlyError(failure));
      }
    }
    input.addEventListener('input', update);
    update();

    return stepFrame(title, 'Four steps on GitHub. You only do this once.',
      h('ol', { class: 'steps' },
        h('li', {}, h('div', { class: 'get-it-li' },
          h('h4', { text: 'Add this file to your profile repository' }),
          h('div', { class: 'field' },
            h('label', { class: 'field-label', for: 'get-it-repo', text: 'Repository' }),
            input,
            h('p', { class: 'field-help', id: 'get-it-repo-help' },
              organization
                ? 'An organization’s profile lives in its .github repository. '
                : 'Your profile repository has the same name as your account. ',
              'Don’t have it yet? ', newRepo, '.'),
            error,
            suggestion),
          h('div', { class: 'get-it-row' }, create, copyFile),
          tooBig,
          h('p', { text: 'On GitHub, press the green “Commit changes” button.' }),
          workflowBox)),
        h('li', {}, h('div', { class: 'get-it-li' },
          h('h4', { text: 'Run it once' }),
          h('p', { text: 'On the Actions page, choose “Daily constellation”, then “Run workflow”. It takes about a minute.' }),
          run,
          h('p', {},
            'A green tick means your picture is ready. A red cross means something went wrong — open the run to see why. ',
            h('a', { class: 'get-it-inline-link', href: PROBLEMS_URL, target: '_blank', rel: 'noopener noreferrer', text: 'What can go wrong?' })))),
        h('li', {}, h('div', { class: 'get-it-li' },
          h('h4', { text: where }),
          snippet.element,
          h('p', { class: 'field-help', text: 'The last line credits the tool that made your picture. Keep it if you like, or delete it.' }),
          editReadme,
          h('p', { class: 'field-help', text: 'Paste it anywhere, for example at the top.' }))),
        h('li', {}, h('div', { class: 'get-it-li' },
          h('h4', { text: 'See it on your profile' }),
          h('a', { class: 'btn', href: profileUrl, target: '_blank', rel: 'noopener noreferrer' },
            h('span', { text: organization ? 'Open the organization’s profile' : 'Open your profile' }), icon('arrowRight', { size: 18 }))))),
      notice('Nothing is published until the workflow runs. After that it refreshes every day.'));
  }

  function imageStep() {
    const missing = needMap();
    if (missing) return stepFrame('Download an image', null, ...missing);
    const { account } = current();
    const status = h('div', { class: 'get-it-status' });
    const svgButton = h('button', {
      class: 'btn btn-primary btn-lg btn-block', type: 'button', 'data-primary': '',
      onclick: () => {
        const name = filename(account, 'svg');
        saveFile(render().svg, name, 'image/svg+xml');
        savedNotice(status, name);
      },
    }, icon('download', { size: 20 }), 'Download SVG');
    const pngLabel = h('span', { text: 'Download PNG' });
    let busy = false;
    const pngButton = h('button', {
      class: 'btn btn-lg btn-block', type: 'button',
      onclick: async () => {
        if (busy) return;
        busy = true;
        status.replaceChildren();
        pngButton.setAttribute('aria-busy', 'true');
        pngButton.setAttribute('aria-disabled', 'true');
        pngLabel.textContent = 'Making your PNG…';
        say('Making your PNG');
        try {
          const blob = await svgToPNG(render().svg);
          const name = filename(account, 'png');
          saveFile(blob, name);
          savedNotice(status, name);
        } catch (failure) {
          status.replaceChildren(notice(failure?.message || 'This browser couldn’t make a PNG. Download the SVG instead.', 'error', { alert: true }));
        } finally {
          busy = false;
          pngButton.removeAttribute('aria-busy');
          pngButton.removeAttribute('aria-disabled');
          pngLabel.textContent = 'Download PNG';
        }
      },
    }, icon('download', { size: 20 }), pngLabel);
    return stepFrame('Download an image', null,
      h('div', { class: 'get-it-options' },
        h('div', { class: 'get-it-option' }, svgButton, h('p', { class: 'field-help', text: 'Sharp at any size. Best for websites and READMEs.' })),
        h('div', { class: 'get-it-option' }, pngButton, h('p', { class: 'field-help', text: 'A regular picture for slides, documents and social posts.' }))),
      status);
  }

  function websiteStep() {
    const missing = needMap();
    if (missing) return stepFrame('Put it on a website', null, ...missing);
    const { account, sample } = current();
    const name = sample ? 'Example' : account;
    const status = h('div', { class: 'get-it-status' });
    const fail = (failure, fallback) => status.replaceChildren(notice(failure?.message ? `${fallback} ${failure.message}` : fallback, 'error', { alert: true }));
    const page = h('button', {
      class: 'btn btn-primary btn-lg btn-block', type: 'button', 'data-primary': '',
      onclick: async () => {
        status.replaceChildren();
        try {
          // Loaded on demand: the page bundle carries the whole renderer.
          const { renderSceneHTML } = await import('../../../renderer-html.mjs');
          const html = renderSceneHTML(render().scene, { title: `${name}’s constellation` });
          const file = filename(account, 'html');
          saveFile(html, file, 'text/html;charset=utf-8');
          savedNotice(status, file);
        } catch (failure) {
          fail(failure, 'We couldn’t make the page.');
        }
      },
    }, icon('download', { size: 20 }), 'Download interactive page');

    const svgName = filename(account, 'svg');
    const alt = `${name}’s GitHub projects as a constellation`.replace(/["<>&]/g, '');
    const embed = codeBox('Image code', `<img src="${svgName}" alt="${alt}" width="900">`, 'image code');

    let packing = false;
    const packLabel = h('span', { text: 'Download portfolio package' });
    const pack = h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        if (packing) return;
        packing = true;
        status.replaceChildren();
        pack.setAttribute('aria-busy', 'true');
        pack.setAttribute('aria-disabled', 'true');
        packLabel.textContent = 'Preparing the package…';
        try {
          const [{ createPortfolioArtifact }, { semanticGraphFromScene }] = await Promise.all([
            import('../../../portfolio-artifact.mjs'),
            import('../../../semantic-graph.mjs'),
          ]);
          const scene = render().scene;
          const artifact = await createPortfolioArtifact(semanticGraphFromScene(scene.kind === 'time-lapse' ? scene.latest : scene), { scene });
          // Same single-file container the previous Studio produced.
          const container = JSON.stringify({ format: 'constellation-portfolio-artifact', manifest: artifact.manifest, files: artifact.files });
          const file = `constellation-${slug(account)}-portfolio.json`;
          saveFile(container, file, 'application/json;charset=utf-8');
          savedNotice(status, file);
        } catch (failure) {
          fail(null, 'We couldn’t build the package for this design. The interactive page above still works.');
        } finally {
          packing = false;
          pack.removeAttribute('aria-busy');
          pack.removeAttribute('aria-disabled');
          packLabel.textContent = 'Download portfolio package';
        }
      },
    }, icon('folder', { size: 18 }), packLabel);

    const svgButton = h('button', {
      class: 'btn', type: 'button',
      onclick: () => { saveFile(render().svg, svgName, 'image/svg+xml'); savedNotice(status, svgName); },
    }, icon('download', { size: 18 }), 'Download SVG');

    return stepFrame('Put it on a website', 'One file with your map built in. Visitors can zoom, search and click stars. Upload it to any web host, such as GitHub Pages or Netlify.',
      page,
      status,
      notice('We can’t see your host, so open the page once it’s uploaded to check it works. Upload it again after you change your design.'),
      h('div', { class: 'get-it-section' },
        h('h4', { text: 'Just want the picture?' }),
        h('p', { text: `Download the SVG, upload it next to your page as ${svgName}, then add this where it should appear:` }),
        embed.element,
        svgButton),
      h('div', { class: 'get-it-section' },
        h('h4', { text: 'For a portfolio' }),
        h('p', { text: 'Everything in one file: the page, the image and the data behind your map.' }),
        pack));
  }

  function linkStep() {
    if (mapState() === 'broken') return stepFrame('Share a link', null, ...brokenNotice());
    const { account, options, sample } = current();
    let link = null;
    try {
      link = encodeShare(publicShareBase(win.location.href), account, options);
    } catch {
      link = null;
    }
    if (!link) {
      return stepFrame('Share a link', null,
        notice('This design has too many custom settings to fit in a link. Save the settings file and send that instead.'),
        h('button', { class: 'btn btn-primary', type: 'button', 'data-primary': '', onclick: () => go('settings') }, icon('folder', { size: 18 }), 'Save the settings file instead'));
    }
    const input = h('input', { class: 'input', id: 'get-it-link', type: 'text', readonly: true, value: link, spellcheck: 'false', onfocus: (event) => event.target.select() });
    const copy = copyButton(() => link, { label: 'Copy link', primary: true, selectTarget: () => input });
    // Phones offer their own share sheet; Copy stays the main way.
    const share = typeof win.navigator.share === 'function' ? h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        try {
          await win.navigator.share({ title: `${sample ? 'Example' : account}’s constellation`, url: link });
        } catch (failure) {
          if (failure?.name === 'AbortError') return; // the visitor closed the share sheet
          say('Sharing didn’t work here. Copy the link instead.');
        }
      },
    }, icon('share', { size: 18 }), 'Share…') : null;
    return stepFrame('Share a link', null,
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'get-it-link', text: 'Link to this design' }),
        h('div', { class: 'get-it-link-row' }, input, copy, share),
        h('p', { class: 'field-help', text: 'Anyone with the link sees this design, drawn from the account’s public projects. It never includes a sign-in.' })));
  }

  function settingsStep() {
    const { account, options } = current();
    const broken = mapState() === 'broken';
    const status = h('div', { class: 'get-it-status' });
    const download = h('button', {
      class: 'btn btn-primary btn-lg btn-block', type: 'button', 'data-primary': '',
      onclick: () => {
        status.replaceChildren();
        try {
          const name = filename(account, 'json');
          saveFile(`${serializeConfig(account, options)}\n`, name, 'application/json;charset=utf-8');
          savedNotice(status, name);
        } catch (failure) {
          status.replaceChildren(notice(`We couldn’t save the settings. ${failure.message}`, 'error', { alert: true }));
        }
      },
    }, icon('download', { size: 20 }), 'Download settings file');

    const file = h('input', { type: 'file', accept: '.json,application/json', class: 'visually-hidden', id: 'get-it-file' });
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      file.value = ''; // choosing the same file again should retry
      if (!chosen) return;
      status.replaceChildren();
      if (chosen.size > MAX_CONFIG_BYTES) {
        status.replaceChildren(notice(`That file is too big to be a settings file. The limit is ${Math.round(MAX_CONFIG_BYTES / 1000)} KB.`, 'error', { alert: true }));
        return;
      }
      try {
        const text = await chosen.text();
        actions.applyConfig(text, 'Open settings file');
      } catch (failure) {
        const detail = failure instanceof SyntaxError ? 'It isn’t valid JSON.'
          : /version/i.test(failure?.message || '') ? 'It was made by a version of Constellation this page can’t read.'
            : failure?.message || '';
        status.replaceChildren(notice(`We couldn’t open that settings file. ${detail}`.trim(), 'error', { alert: true }));
        return;
      }
      actions.closeDialog();
      actions.toast('Opened your settings. Undo brings back the previous design.');
    });
    const open = h('label', { class: 'btn btn-lg btn-block get-it-file' }, file, icon('folder', { size: 20 }), h('span', { text: 'Open a settings file' }));

    // A design that can't be drawn isn't saved, but opening a good file still fixes it.
    return stepFrame('Save the settings file', 'A small file with every choice you made. Keep it as a backup, open it here later, or use it with the command-line tool.',
      broken ? brokenNotice() : null,
      h('div', { class: 'get-it-options' },
        broken ? null : h('div', { class: 'get-it-option' }, download, h('p', { class: 'field-help', text: 'Saves this design as a .json file.' })),
        h('div', { class: 'get-it-option' }, open, h('p', { class: 'field-help', text: 'Replaces the current design. Undo brings it back.' }))),
      status);
  }

  function list() {
    return h('div', { class: 'get-it-list' },
      h('p', { class: 'get-it-intro', text: 'Where should your map go?' }),
      h('div', { class: 'choice-list' }, CHOICES.map((choice) => h('button', {
        class: 'choice', type: 'button', 'data-choice': choice.id,
        onclick: () => go(choice.id),
      },
      h('span', { class: 'choice-icon' }, icon(choice.icon, { size: 22 })),
      h('span', { class: 'get-it-choice-text' },
        h('span', { class: 'choice-title', text: choice.title }),
        // A full stop between title and description keeps them two sentences when read aloud.
        h('span', { class: 'visually-hidden', text: '. ' }),
        h('span', { class: 'choice-desc', text: choice.desc })),
      h('span', { class: 'get-it-chevron' }, icon('arrowRight', { size: 18 }))))));
  }

  const STEPS = { profile: profileStep, image: imageStep, website: websiteStep, link: linkStep, settings: settingsStep };

  return {
    title: 'Get your map',
    build() {
      shownState = viewState();
      const content = STEPS[step] ? STEPS[step]() : list();
      return { body: [h('div', { class: 'get-it' }, content)] };
    },
    onClose() {
      step = null;
      lastChoice = null;
    },
  };
}
