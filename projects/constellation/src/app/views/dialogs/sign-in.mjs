// "Sign in with GitHub": hosted OAuth when this copy is configured for it, a
// personal token on a local preview, or a plain explanation when neither is
// possible. Signing in is always optional; the token lives only in the engine's
// in-memory session. This module reads it from the field once, clears the
// field at once, and never writes it anywhere else.

import { h, icon } from '../../dom.mjs';

const EXPLANATION = 'Without signing in you can map any public account. Signing in lets Constellation read your pinned projects, every language in each project, and your recent activity.';
const PRIVACY = 'Your sign-in stays in this tab only. It is never saved, shared, or put in your map.';
const TOKEN_HELP = 'Read-only public access is enough. The token is kept in memory and cleared when you close this tab.';
const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

let stylesheetAdded = false;

export function createSignInDialog(ctx) {
  const { store, engine, actions, win, doc } = ctx;
  if (!stylesheetAdded) {
    stylesheetAdded = true;
    doc.head.append(h('link', { rel: 'stylesheet', href: new URL('./sign-in.css', import.meta.url).href }));
  }

  // Bumped on close so a check that finishes after the visitor walked away
  // never navigates or writes into a dialog that is no longer theirs.
  let generation = 0;
  let tokenInput = null;
  let message = null;

  function say(text, tone) {
    if (!message) return;
    message.replaceChildren();
    if (!text) return;
    message.append(tone === 'error'
      ? h('p', { class: 'notice', role: 'alert', dataset: { tone: 'error' } }, icon('info', { size: 18 }), h('span', { text }))
      : h('p', { class: 'field-help', text }));
  }

  function intro() {
    return [
      h('p', { class: 'sign-in-lede', text: EXPLANATION }),
      h('p', { class: 'notice' }, icon('eyeOff', { size: 18 }), h('span', { text: PRIVACY })),
    ];
  }

  // a) Already signed in.
  function signedIn(viewer) {
    const login = viewer.login;
    return {
      body: [
        h('p', { class: 'notice', dataset: { tone: 'success' } }, icon('github', { size: 18 }), h('span', { text: `Signed in as @${login}` })),
        ...intro(),
      ],
      foot: [
        h('button', {
          class: 'btn', type: 'button',
          onclick: () => {
            engine.signIn.signOut();
            actions.toast('Signed out.');
            ctx.refreshDialog?.();
          },
        }, 'Sign out'),
        h('button', {
          class: 'btn btn-primary', type: 'button', 'data-primary': true,
          onclick: () => {
            actions.closeDialog();
            actions.openAccount(login);
          },
        }, 'Show my sky'),
      ],
    };
  }

  // b) The local preview server already authenticates every request.
  // e) Nothing to sign into on this copy.
  function nothingToDo(text) {
    return {
      body: [h('p', { class: 'notice' }, icon('info', { size: 18 }), h('span', { text })), ...intro()],
      foot: [h('button', { class: 'btn btn-primary', type: 'button', 'data-primary': true, onclick: () => actions.closeDialog() }, 'Got it')],
    };
  }

  // c) Hosted OAuth: hand the visitor to GitHub, which sends them back here.
  function oauthButton() {
    const button = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', 'data-primary': true }, icon('github', { size: 20 }), 'Continue with GitHub');
    button.addEventListener('click', async () => {
      button.disabled = true;
      say('Opening GitHub…');
      try {
        const url = await engine.signIn.begin();
        win.location.assign(url);
      } catch (error) {
        say(error?.message || 'We couldn’t start sign-in. Try again.', 'error');
        button.disabled = false;
      }
    });
    return button;
  }

  // d) Local preview only: paste a personal access token.
  function tokenForm({ primary, open }) {
    const id = 'sign-in-token';
    const helpId = 'sign-in-token-help';
    const field = tokenInput = h('input', {
      id, class: 'input', type: 'password',
      // Browsers ignore autocomplete=off on password fields and offer to save
      // them; a one-time code is never saved, and password managers are told to skip it.
      autocomplete: 'one-time-code', autocapitalize: 'none', spellcheck: 'false', 'data-1p-ignore': '', 'data-lpignore': 'true',
      'aria-describedby': helpId,
    });
    const submit = h('button', primary
      ? { class: 'btn btn-primary', type: 'submit', 'data-primary': true }
      : { class: 'btn', type: 'submit' }, 'Sign in');
    const form = h('form', { class: 'sign-in-form', novalidate: true },
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: id, text: 'Personal access token' }),
        tokenInput,
        h('p', { class: 'field-help', id: helpId, text: TOKEN_HELP })),
      // Without OAuth, errors belong next to the field they are about.
      primary ? message : null,
      h('div', { class: 'sign-in-actions' },
        h('a', { href: NEW_TOKEN_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Create a token on GitHub'),
        submit));

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const input = field;
      let token = input.value;
      // Clear first: the secret must not sit in the DOM while GitHub answers.
      input.value = '';
      const run = ++generation;
      submit.disabled = true;
      say('Checking your token with GitHub…');
      let profile = null;
      try {
        profile = await engine.signIn.withToken(token);
      } catch (error) {
        token = '';
        if (run !== generation) return;
        submit.disabled = false;
        say(error?.message || 'GitHub could not check this token. Try again.', 'error');
        input.focus();
        return;
      }
      token = '';
      if (!profile) return; // A newer attempt replaced this one.
      actions.toast(`Signed in as @${profile.login}.`);
      if (run !== generation) return;
      actions.closeDialog();
      // Nothing on screen yet: their own sky is the obvious next step.
      if (!store.get().account) actions.openAccount(profile.login);
    });

    // Hide the form outright while collapsed: a closed <details> still lays
    // out its content in some engines, and hidden keeps the one primary honest.
    form.hidden = !open;
    const details = h('details', { class: 'sign-in-token', open },
      h('summary', {}, 'Use a personal access token (local only)'),
      form);
    details.addEventListener('toggle', () => {
      form.hidden = !details.open;
      if (!details.open) field.value = '';
    });
    return details;
  }

  return {
    title: 'Sign in with GitHub',
    build() {
      tokenInput = null;
      message = h('div', { class: 'sign-in-message', 'aria-live': 'polite' });
      const viewer = engine.viewer;
      if (viewer?.login) return signedIn(viewer);
      if (engine.signIn.local) return nothingToDo('This local preview is already using your GitHub token from .env.');
      const { configured, tokenAllowed } = engine.signIn;
      if (!configured && !tokenAllowed) {
        return nothingToDo('Sign-in isn’t set up on this copy of Constellation. You can still map any public account.');
      }
      return {
        body: [
          ...intro(),
          configured ? oauthButton() : null,
          // Without OAuth the token is the only way in, so show it open.
          tokenAllowed ? tokenForm({ primary: !configured, open: !configured }) : null,
          configured ? message : null,
        ],
      };
    },
    onClose() {
      generation++;
      engine.signIn.cancel();
      if (tokenInput) tokenInput.value = '';
      say('');
    },
  };
}
