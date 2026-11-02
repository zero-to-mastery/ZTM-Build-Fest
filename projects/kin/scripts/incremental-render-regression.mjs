// Incremental rendering (refactor Slice 4): a peer refresh reuses decoded
// projection sections whose revision did not change, and components given the
// same arrays do not re-render. Two real tabs; the second is the peer.

/** Runs with both tabs unlocked on Today. */
export async function incrementalRenderPeerRegressions(first, second, until) {
  const idle = "(() => { const app = document.querySelector('kin-app'); return !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending; })()";
  await until(() => second.evaluate(idle));
  await second.evaluate(`(() => {
    const app = document.querySelector('kin-app');
    window.renderProbe = { items: app.state.items, row: app.needs.querySelector('kin-item') ?? app.today.querySelector('kin-item'),
      handoffs: app.state.handoffs };
    return Boolean(window.renderProbe.row);
  })()`);

  // A Handoff changes the Handoffs and summary sections only.
  await first.evaluate("document.querySelector('kin-app').ctx.conversations.handleAddHandoff({ detail: { text: 'Incremental render Handoff' } })");
  await until(() => second.evaluate(`(() => {
    const app = document.querySelector('kin-app');
    return !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending && app.state.handoffs.some((row) => row.text === 'Incremental render Handoff');
  })()`));
  const handoff = await second.evaluate(`(() => {
    const app = document.querySelector('kin-app');
    return { itemsReused: app.state.items === window.renderProbe.items, rowKept: window.renderProbe.row.isConnected,
      handoffsNew: app.state.handoffs !== window.renderProbe.handoffs,
      listed: [...app.handoffs.querySelectorAll('li')].some((row) => row.textContent.includes('Incremental render Handoff')) };
  })()`);
  if (!handoff.itemsReused || !handoff.rowKept || !handoff.handoffsNew || !handoff.listed)
    throw new Error(`a Handoff refresh must reuse Items and keep their rows: ${JSON.stringify(handoff)}`);

  // An Item changes the Items section: the lists render the new Item.
  await first.evaluate("document.querySelector('kin-app').ctx.items.handleAddItem({ detail: { text: 'Incremental render Item', classification: 'need' } })");
  await until(() => second.evaluate(`(() => {
    const app = document.querySelector('kin-app');
    return !app.busy && !app.refreshing && !app.pendingRefresh && !app.wakePending && app.state.items.some((item) => item.text === 'Incremental render Item');
  })()`));
  const item = await second.evaluate(`(async () => {
    const app = document.querySelector('kin-app');
    const { decodeProjection } = await import('/wasm/kin-engine.js');
    const { projectionContext } = await import('/browser-time.js');
    // The incrementally decoded state equals a full decode of the same bytes.
    // (A second engine would replace the page's shared codec, so none is made.)
    const snapshot = await app.store.getCatchUpState();
    const { asOf, civilDate } = projectionContext();
    const args = [snapshot.events, asOf, snapshot.cursor.eventId, civilDate, snapshot.syncIdentity];
    const incremental = app.engine.applyEvents(...args);
    const full = decodeProjection(app.engine.projectionBytes(...args));
    const equal = JSON.stringify(incremental) === JSON.stringify(full);
    return { itemsNew: app.state.items !== window.renderProbe.items, equal,
      rendered: [...app.needs.querySelectorAll('kin-item')].some((row) => row.textContent.includes('Incremental render Item')) };
  })()`);
  if (!item.itemsNew || !item.rendered || !item.equal)
    throw new Error(`an Item refresh must decode and render Items, equal to a full decode: ${JSON.stringify(item)}`);
  await second.evaluate("delete window.renderProbe");
  console.log("PASS peer refresh reuses unchanged projection sections, keeps their rendered rows, and equals a full decode");
}
