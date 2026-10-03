// Synthetic late WebAuthn completions exercise lifecycle cancellation; actual
// credential verification is tested separately with a virtual authenticator.
export async function householdLifecycleChecks(recovery) {
  const app = document.querySelector('kin-app');
  let checks = 0;
  const check = (ok, message) => { if (!ok) throw new Error(message); checks++; };
  const wait = async predicate => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Household lifecycle fixture did not reach its gate.');
  };
  const originalFetch = globalThis.fetch;
  const originalGet = navigator.credentials.get;
  let releaseCredential;
  let finishRequests = 0;
  let pendingRequested = false;
  let aborted = false;
  const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  globalThis.fetch = async (path, options) => {
    if (path === '/api/login/options') return new Response(JSON.stringify({ flow: 'fixture', publicKey: {
      challenge: encode(crypto.getRandomValues(new Uint8Array(32))), rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: 'AQ' }], userVerification: 'required',
    } }), { status: 200 });
    if (path === '/api/login/finish') { finishRequests++; return new Response('{}', { status: 200 }); }
    if (path === '/api/lifecycle-pending') {
      pendingRequested = true;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          aborted = true; reject(new DOMException('Disconnected', 'AbortError'));
        }, { once: true });
      });
    }
    return originalFetch(path, options);
  };
  navigator.credentials.get = () => new Promise(resolve => { releaseCredential = resolve; });
  try {
    const oldHousehold = app.household;
    const oldVault = oldHousehold.connectionVault;
    const pendingLogin = oldHousehold.login();
    await wait(() => Boolean(releaseCredential));
    app.lockHousehold();
    await app.security.run(() => app.security.unlockRecovery(recovery));
    check(app.store && app.household !== oldHousehold && app.vault !== oldVault, 'new unlock owns a fresh household controller and vault: ' + JSON.stringify({store:!!app.store, fresh:app.household!==oldHousehold, vault:app.vault!==oldVault, error:app.security.alert?.textContent,phase:app.security.phase}));
    releaseCredential({ id: 'AQ', type: 'public-key', response: {
      clientDataJSON: new Uint8Array([1]).buffer, authenticatorData: new Uint8Array([1]).buffer,
      signature: new Uint8Array([1]).buffer, userHandle: null,
    } });
    await pendingLogin;
    check(finishRequests === 0, 'detached credential completion must never send login/finish under a new vault');
    check(oldHousehold.connectionAbort.signal.aborted && app.security.phase === 'unlocked', 'stale action stays cancelled without disturbing the fresh unlock');

    const controller = app.household;
    const pendingFetch = controller.api('/api/lifecycle-pending').then(() => false, () => true);
    await wait(() => pendingRequested);
    app.lockHousehold();
    check(await pendingFetch && aborted, 'disconnect aborts the in-flight household fetch');
    await app.security.run(() => app.security.unlockRecovery(recovery));

    const fresh = app.household;
    const originalEpoch = app.vault.checkSecurityEpoch;
    let attempted = 0;
    app.vault.checkSecurityEpoch = async () => { throw new Error('Durable lock changed'); };
    globalThis.fetch = async (...args) => { attempted++; return originalFetch(...args); };
    let denied = false;
    try { await fresh.api('/api/lifecycle-denied'); } catch { denied = true; }
    finally { app.vault.checkSecurityEpoch = originalEpoch; }
    check(denied && attempted === 0, 'durable lock check rejects before household network access');

    const currentApp = document.querySelector('kin-app');
    const currentVault = currentApp.vault;
    currentApp.handlePeerMessage({ data: { type: 'household-locked', lockEpoch: currentVault.securityEpoch } });
    check(currentApp.vault === currentVault && !currentVault.locked, 'delayed peer notification at the current epoch cannot revoke a fresh unlock');
    currentApp.handlePeerMessage({ data: { type: 'household-locked', lockEpoch: currentVault.securityEpoch + 1 } });
    check(currentApp.vault === null && currentVault.locked, 'newer peer lock epoch revokes the active household');
    await currentApp.security.run(() => currentApp.security.unlockRecovery(recovery));
  } finally {
    globalThis.fetch = originalFetch;
    navigator.credentials.get = originalGet;
  }
  return { checks };
}
