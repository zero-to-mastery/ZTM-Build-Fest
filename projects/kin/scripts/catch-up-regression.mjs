import assert from "node:assert/strict";

export async function catchUpRegressions() {
  const app = document.querySelector("kin-app");
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const idle = async () => {
    for (let attempt = 0; app.busy && attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    check(!app.busy, "catch-up operation returns to idle");
  };
  const count = async () => (await app.store.loadEvents()).length;
  const context = async () => app.store.ensureContext();
  const writeContext = async (value) => {
    const transaction = app.store.database.transaction(
      "local_context",
      "readwrite",
    );
    transaction.objectStore("local_context").put(value);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
    });
  };
  const readContext = async () => {
    const transaction = app.store.database.transaction(
      "local_context",
      "readonly",
    );
    const request = transaction
      .objectStore("local_context")
      .get("installation");
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };
  const resetCursor = async () => {
    const existing = await context();
    delete existing.last_looked_event_id;
    delete existing.last_looked_local_sequence;
    delete existing.last_looked_at;
    await writeContext(existing);
  };
  const makeBoundary = (snapshot) => ({
    eventId: snapshot.through.eventId,
    localSequence: snapshot.through.localSequence,
    snapshotThroughEventId: snapshot.through.eventId,
    snapshotThroughLocalSequence: snapshot.through.localSequence,
  });

  let rows = await app.store.loadEvents();
  let localContext = await context();
  const historyCount = rows.length;
  const logicalTime = localContext.next_logical_time;
  const oldTail = rows.at(-1);
  await resetCursor();
  const initialized = await context();
  check(
    initialized.last_looked_local_sequence === oldTail.local_sequence &&
      [...initialized.last_looked_event_id].every(
        (byte, index) => byte === oldTail.event_id[index],
      ),
    "legacy context initializes caught up through existing history",
  );
  check(
    initialized.next_logical_time === logicalTime &&
      (await count()) === historyCount,
    "first-run initialization does not mutate events or logical time",
  );
  await app.refreshFromEvents();
  check(
    app.state.summary.totalCount === 0 &&
      app.catchUp.empty.textContent === "You're caught up.",
    "existing history does not flood the first summary",
  );

  await resetCursor();
  rows = await app.store.loadEvents();
  const initializationTail = rows.at(-1);
  const initialization = app.store.ensureContext();
  const concurrentAppend = app.store.append(
    {
      type: "add",
      text: "Initialization race addition",
      classification: "need",
    },
    app.engine,
  );
  const [initializedContext, appendResult] = await Promise.all([
    initialization,
    concurrentAppend,
  ]);
  check(
    initializedContext.last_looked_local_sequence ===
      initializationTail.local_sequence,
    "initialization captures the pre-append transaction boundary",
  );
  check(
    appendResult.state.summary.totalCount === 1 &&
      appendResult.state.summary.entries[0].text ===
        "Initialization race addition",
    "an append ordered after initialization remains unseen",
  );
  const handoff = await app.store.append(
    { type: "add-handoff", text: "Diaper bag summary" },
    app.engine,
  );
  const handoffId = handoff.state.handoffs.at(-1).handoffId;
  await app.store.append(
    { type: "acknowledge-handoff", handoffId },
    app.engine,
  );
  const talk = await app.store.append(
    { type: "add-talk", text: "Weekend plans summary" },
    app.engine,
  );
  const talkId = talk.state.talks.at(-1).talkId;
  await app.store.append({ type: "resolve-talk", talkId }, app.engine);
  const pulseTime = Date.now();
  const pulse = await app.store.append(
    {
      type: "set-pulse",
      value: "drained",
      timestamp: pulseTime,
      expiresAt: pulseTime + 3_600_000,
    },
    app.engine,
  );
  await app.refreshFromEvents();
  check(
    app.state.summary.totalCount === 5 &&
      app.state.summary.entries.map((entry) => entry.kind).join(",") ===
        "item-added,handoff-added,handoff-acknowledged,talk-added,talk-resolved",
    "Item, Handoff, and Talk changes are summarized while Pulse is excluded",
  );
  check(
    app.catchUp.list.textContent.includes("Diaper bag summary acknowledged") &&
      app.catchUp.list.textContent.includes("Weekend plans summary resolved") &&
      app.state.summary.throughEventId === pulse.snapshotBoundary.eventId,
    "neutral wording is shown and Pulse may define the through-boundary",
  );

  const renderedBoundary = structuredClone(app.snapshotBoundary);
  const beforeArrivalCount = await count();
  const lateAppend = await app.store.append(
    { type: "add", text: "Arrived after render", classification: "today" },
    app.engine,
  );
  check(
    lateAppend.snapshotBoundary.localSequence >
      renderedBoundary.localSequence &&
      app.snapshotBoundary.localSequence === renderedBoundary.localSequence,
    "rendered boundary stays frozen when a later event arrives",
  );
  const beforeCatchUpCounter = (await context()).next_logical_time;
  app.catchUp.button.click();
  await idle();
  localContext = await context();
  const renderedEventId = Uint8Array.from(
    renderedBoundary.eventId.match(/../g),
    (value) => Number.parseInt(value, 16),
  );
  check(
    localContext.last_looked_local_sequence ===
      renderedBoundary.localSequence &&
      [...localContext.last_looked_event_id].every(
        (byte, index) => byte === renderedEventId[index],
      ),
    "Caught up advances only through the rendered snapshot boundary",
  );
  check(
    app.state.summary.totalCount === 1 &&
      app.state.summary.entries[0].text === "Arrived after render",
    "an event after the rendered boundary remains unseen",
  );
  check(
    (await count()) === beforeArrivalCount + 1 &&
      (await context()).next_logical_time === beforeCatchUpCounter,
    "marking caught up writes no event and advances no logical counter",
  );

  const staleSnapshot = await app.store.getCatchUpState();
  const staleBoundary = makeBoundary(staleSnapshot);
  await app.store.append(
    { type: "add", text: "Newer tab boundary", classification: "need" },
    app.engine,
  );
  const newerSnapshot = await app.store.getCatchUpState();
  const newerBoundary = makeBoundary(newerSnapshot);
  let beyondSnapshotRejected = false;
  try {
    await app.store.markCaughtUpThrough({
      ...newerBoundary,
      snapshotThroughEventId: staleBoundary.snapshotThroughEventId,
      snapshotThroughLocalSequence: staleBoundary.snapshotThroughLocalSequence,
    });
  } catch {
    beyondSnapshotRejected = true;
  }
  check(
    beyondSnapshotRejected,
    "cursor cannot advance beyond its known snapshot tail",
  );
  const monotonicCount = await count();
  const monotonicCounter = (await context()).next_logical_time;
  const advanced = await app.store.markCaughtUpThrough(newerBoundary);
  const stale = await app.store.markCaughtUpThrough(staleBoundary);
  const afterStaleWrite = await context();
  const newerEventId = Uint8Array.from(
    newerBoundary.eventId.match(/../g),
    (value) => Number.parseInt(value, 16),
  );
  check(
    advanced.advanced && !stale.advanced,
    "newer tab advances while stale tab is a no-op",
  );
  check(
    afterStaleWrite.last_looked_local_sequence ===
      newerBoundary.localSequence &&
      afterStaleWrite.last_looked_event_id &&
      [...afterStaleWrite.last_looked_event_id].every(
        (byte, index) => byte === newerEventId[index],
      ),
    "stale catch-up request cannot move the local cursor backward",
  );
  check(
    (await count()) === monotonicCount &&
      afterStaleWrite.next_logical_time === monotonicCounter,
    "monotonic cursor updates do not touch canonical events or logical time",
  );
  await app.refreshFromEvents();

  for (let index = 0; index < 10; index += 1) {
    await app.store.append(
      { type: "add", text: `Bounded change ${index}`, classification: "need" },
      app.engine,
    );
  }
  await app.refreshFromEvents();
  check(
    app.state.summary.entries.length === 8 &&
      app.state.summary.totalCount === 10,
    "summary caps visible records at eight and retains the total count",
  );
  check(
    app.catchUp.list.firstElementChild.textContent ===
      "Bounded change 2 added to Needs" &&
      app.catchUp.list.lastElementChild.textContent ===
        "Bounded change 9 added to Needs" &&
      app.catchUp.omitted.textContent === "2 earlier changes",
    "bounded entries preserve order and report omitted earlier changes",
  );
  check(
    app.state.summary.entries.every(
      (entry) =>
        Object.keys(entry).sort().join(",") ===
        "classification,entityKind,eventId,kind,text",
    ),
    "summary records contain no actor attribution or per-event timestamps",
  );
  check(
    app.catchUp.section.tagName === "SECTION" &&
      app.catchUp.heading.tagName === "H2" &&
      app.catchUp.list.tagName === "UL" &&
      [...app.catchUp.list.children].every((entry) => entry.tagName === "LI") &&
      app.catchUp.button.textContent === "Caught up" &&
      app.catchUp.button.getBoundingClientRect().height >= 48 &&
      app.catchUp.querySelector("time") === null,
    "summary uses semantic list markup, a named 48px control, and no entry timestamps",
  );

  const beforeAcknowledgementCount = await count();
  const beforeAcknowledgementCounter = (await context()).next_logical_time;
  app.catchUp.button.focus();
  app.catchUp.button.click();
  await idle();
  let finalSnapshot = await app.store.getCatchUpState();
  check(
    app.state.summary.totalCount === 0 &&
      app.catchUp.empty.textContent === "You're caught up.",
    "bounded snapshot catch-up covers omitted changes and shows the empty state",
  );
  check(
    document.activeElement === app.catchUp.heading,
    "focus moves to the summary heading when Caught up hides its button",
  );
  check(
    (await count()) === beforeAcknowledgementCount &&
      (await context()).next_logical_time === beforeAcknowledgementCounter,
    "explicit acknowledgement writes only local view state",
  );
  const validContext = await context();
  await writeContext({
    ...validContext,
    last_looked_event_id: new Uint8Array(16).fill(0xff),
  });
  let invalidBoundaryRejected = false;
  try {
    await app.store.getCatchUpState();
  } catch {
    invalidBoundaryRejected = true;
  }
  const invalidBoundary = await readContext();
  check(
    invalidBoundaryRejected &&
      [...invalidBoundary.last_looked_event_id].every((byte) => byte === 0xff),
    "mismatched local cursor fails closed and is not overwritten",
  );

  const partialContext = { ...validContext };
  delete partialContext.last_looked_local_sequence;
  await writeContext(partialContext);
  let partialMetadataRejected = false;
  try {
    await app.store.ensureContext();
  } catch {
    partialMetadataRejected = true;
  }
  const persistedPartialContext = await readContext();
  check(
    partialMetadataRejected &&
      !Object.prototype.hasOwnProperty.call(
        persistedPartialContext,
        "last_looked_local_sequence",
      ),
    "partial local cursor metadata fails closed and is not initialized over",
  );
  await writeContext(validContext);
  await app.refreshFromEvents();

  const addPendingChange = async (text) => {
    await app.store.append(
      { type: "add", text, classification: "need" },
      app.engine,
    );
    await app.refreshFromEvents();
  };
  const originalBroadcast = app.broadcastViewStateChange.bind(app);
  let cursorBroadcasts = 0;
  app.broadcastViewStateChange = () => {
    cursorBroadcasts += 1;
    originalBroadcast();
  };
  await addPendingChange("Catch-up quota recovery");
  const quotaCursor = await context();
  const quotaCount = await count();
  const quotaCounter = quotaCursor.next_logical_time;
  const quotaSummary = JSON.stringify(app.state.summary);
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, ...args) {
    if (
      this.name === "local_context" &&
      value?.key === "installation" && value.protected_version === 1
    ) {
      throw new DOMException("Synthetic quota", "QuotaExceededError");
    }
    return originalPut.call(this, value, ...args);
  };
  try {
    app.catchUp.button.click();
    await idle();
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
  let afterFailure = await context();
  check(
    !app.alert.hidden &&
      app.retryAction &&
      afterFailure.last_looked_local_sequence ===
        quotaCursor.last_looked_local_sequence &&
      (await count()) === quotaCount &&
      afterFailure.next_logical_time === quotaCounter &&
      JSON.stringify(app.state.summary) === quotaSummary,
    "quota failure preserves cursor, events, logical counter, and rendered summary",
  );
  check(cursorBroadcasts === 0, "failed quota write does not broadcast a commit");
  app.retryButton.click();
  await idle();
  check(cursorBroadcasts === 1, "quota retry broadcasts its committed write");
  afterFailure = await context();
  check(
    afterFailure.last_looked_local_sequence ===
      app.snapshotBoundary.localSequence && app.state.summary.totalCount === 0,
    "explicit retry commits the captured catch-up boundary after quota recovery",
  );

  cursorBroadcasts = 0;
  await addPendingChange("Catch-up abort recovery");
  const abortCursor = await context();
  const abortCount = await count();
  const abortCounter = abortCursor.next_logical_time;
  IDBObjectStore.prototype.put = function (value, ...args) {
    const transaction = this.transaction;
    const request = originalPut.call(this, value, ...args);
    if (
      this.name === "local_context" &&
      value?.key === "installation" && value.protected_version === 1
    ) {
      request.addEventListener("success", () => transaction.abort());
    }
    return request;
  };
  try {
    app.catchUp.button.click();
    await idle();
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
  const afterAbort = await context();
  check(
    !app.alert.hidden &&
      afterAbort.last_looked_local_sequence ===
        abortCursor.last_looked_local_sequence &&
      (await count()) === abortCount &&
      afterAbort.next_logical_time === abortCounter,
    "aborted cursor transaction preserves the previous local state",
  );
  check(cursorBroadcasts === 0, "aborted write does not broadcast a commit");
  app.retryButton.click();
  await idle();

  check(cursorBroadcasts === 1, "abort retry broadcasts its committed write");
  app.broadcastViewStateChange = originalBroadcast;
  await addPendingChange("Catch-up refresh recovery");
  const refreshCursor = await context();
  const refreshSummary = JSON.stringify(app.state.summary);
  const originalSnapshotRead = app.store.getCatchUpState.bind(app.store);
  app.store.getCatchUpState = async () => {
    throw new Error("Synthetic catch-up refresh failure");
  };
  try {
    await app.refreshFromEvents();
    await app.refreshFromEvents();
  } finally {
    app.store.getCatchUpState = originalSnapshotRead;
  }
  check(
    !app.alert.hidden &&
      app.retryAction === app.retryRefresh &&
      (await context()).last_looked_local_sequence ===
        refreshCursor.last_looked_local_sequence &&
      JSON.stringify(app.state.summary) === refreshSummary,
    "repeated snapshot-read failures preserve cursor and displayed summary",
  );
  app.retryButton.click();
  await idle();
  check(
    app.retryAction === null &&
      (await context()).last_looked_local_sequence ===
        refreshCursor.last_looked_local_sequence,
    "refresh retry recovers the canonical summary without advancing the cursor",
  );

  await app.store.append(
    { type: "add", text: "Catch-up reconnect pending", classification: "need" },
    app.engine,
  );
  await app.refreshFromEvents();
  const pendingBoundary = structuredClone(app.snapshotBoundary);
  const pendingCount = await count();
  const pendingCounter = (await context()).next_logical_time;
  const mark = app.store.markCaughtUpThrough.bind(app.store);
  let releaseMark;
  const markGate = new Promise((resolve) => {
    releaseMark = resolve;
  });
  app.store.markCaughtUpThrough = async (boundary) => {
    await markGate;
    return mark(boundary);
  };
  app.catchUp.button.focus();
  app.catchUp.button.click();
  check(
    app.busy && app.main.getAttribute("aria-busy") === "true",
    "catch-up write exposes busy state",
  );
  try {
    app.handlePeerMessage({ data: { type: "view-state-changed" } });
    check(app.busy && app.pendingRefresh, "peer refresh does not unlock pending catch-up write");
  } finally {
    releaseMark();
    app.store.markCaughtUpThrough = mark;
  }
  await idle();
  await app.refreshFromEvents();
  const afterReconnect = await context();
  check(
    afterReconnect.last_looked_local_sequence ===
      pendingBoundary.localSequence &&
      (await count()) === pendingCount &&
      afterReconnect.next_logical_time === pendingCounter &&
      app.state.summary.totalCount === 0,
    "pending caught-up write commits once through its frozen boundary before peer refresh",
  );

  await app.store.append(
    {
      type: "add",
      text: "Summary remains visible during Pulse expiry",
      classification: "need",
    },
    app.engine,
  );
  await app.refreshFromEvents();
  const visibleSummary = structuredClone(app.state.summary);
  const pulseStartedAt = Date.now();
  await app.savePulse({
    type: "set-pulse",
    value: "okay",
    timestamp: pulseStartedAt,
    expiresAt: pulseStartedAt + 250,
  });
  const pulseEventCount = await count();
  const pulseDeadline = Date.now() + 3000;
  while (
    app.state.pulses[0]?.status !== "expired" &&
    Date.now() < pulseDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const pulseExpired = app.state.pulses[0]?.status === "expired";
  const summaryStayedVisible =
    JSON.stringify({
      entries: app.state.summary.entries,
      totalCount: app.state.summary.totalCount,
    }) ===
    JSON.stringify({
      entries: visibleSummary.entries,
      totalCount: visibleSummary.totalCount,
    });
  const pulseTimerEventCount = await count();
  check(
    pulseExpired &&
      summaryStayedVisible &&
      pulseTimerEventCount === pulseEventCount,
    `Pulse timer preserves the visible summary without adding history: ${JSON.stringify(
      {
        pulseExpired,
        summaryStayedVisible,
        pulseEventCountUnchanged: pulseTimerEventCount === pulseEventCount,
      },
    )}`,
  );
  await app.savePulse({ type: "clear-pulse" });

  finalSnapshot = await app.store.getCatchUpState();
  sessionStorage.setItem(
    "kin.test.catchUpCursor",
    JSON.stringify(finalSnapshot.cursor),
  );
  return "PASS first-run initialization, append race, frozen boundary, monotonic tabs, cap/omission, and event-free catch-up";
}

export async function catchUpPeerRegressions(first, second, until) {
  await first.evaluate(`document.querySelector('kin-app').handleAddItem({
    detail: { text: 'Cross-tab catch-up change', classification: 'need' }
  })`);
  await until(() =>
    second.evaluate(`document.querySelector('kin-app').state.summary.entries.some(
    entry => entry.text === 'Cross-tab catch-up change'
  )`),
  );
  await second.evaluate(`window.catchUpMessages=[];
    window.catchUpListener=event=>window.catchUpMessages.push(event.data);
    document.querySelector('kin-app').channel.addEventListener('message',window.catchUpListener);`);
  await first.evaluate(
    `document.querySelector('kin-app').catchUp.button.focus()`,
  );
  for (const type of ["keyDown", "keyUp"]) {
    await first.send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      ...(type === "keyDown" ? { text: "\r" } : {}),
    });
  }
  await until(() =>
    second.evaluate(`(() => {
    const app=document.querySelector('kin-app');
    return app.state.summary.totalCount===0 && app.catchUpCursor.localSequence===app.snapshotBoundary?.localSequence;
  })()`),
  );
  assert.deepEqual(
    await second.evaluate("window.catchUpMessages"),
    [{ type: "view-state-changed" }],
    "catch-up BroadcastChannel marker contains no cursor or household content",
  );
  assert.equal(
    await first.evaluate(
      `document.activeElement===document.querySelector('kin-app').catchUp.heading`,
    ),
    true,
    "keyboard catch-up restores focus to the summary heading",
  );
  assert.equal(
    await second.evaluate(
      `document.querySelector('kin-app').catchUp.empty.textContent`,
    ),
    "You're caught up.",
  );
  await second.evaluate(`document.querySelector('kin-app').channel.removeEventListener(
    'message',window.catchUpListener
  )`);

  await first.evaluate(`document.querySelector('kin-app').handleAddItem({
    detail: { text: 'Committed cursor refresh recovery', classification: 'need' }
  })`);
  await until(() => second.evaluate(`document.querySelector('kin-app').state.summary.entries.some(
    entry => entry.text === 'Committed cursor refresh recovery'
  )`));
  await second.evaluate(`window.catchUpMessages=[];
    document.querySelector('kin-app').channel.addEventListener('message',window.catchUpListener);`);
  try {
    await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app');
      window.commitRecovery={
        read:app.store.getCatchUpState.bind(app.store),
        mark:app.store.markCaughtUpThrough.bind(app.store),
        state:JSON.stringify(app.state),
        rendered:app.catchUp.list.textContent,
        boundary:structuredClone(app.snapshotBoundary),
        cursor:structuredClone(app.catchUpCursor),
        writes:0,
      };
      const saved=window.commitRecovery;
      app.store.markCaughtUpThrough=async boundary=>{
        saved.writes++;
        return saved.mark(boundary);
      };
      app.store.getCatchUpState=async()=>{
        throw new Error('Synthetic post-commit snapshot failure');
      };
      await app.handleCaughtUp();
    })()`);
    await until(() => second.evaluate(`window.catchUpMessages.length===1 &&
      document.querySelector('kin-app').state.summary.totalCount===0`));
    assert.deepEqual(await second.evaluate('window.catchUpMessages'), [
      { type: 'view-state-changed' },
    ]);
    assert.equal(await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app'), saved=window.commitRecovery;
      const snapshot=await saved.read();
      return snapshot.cursor.localSequence===saved.boundary.localSequence &&
        snapshot.cursor.localSequence>saved.cursor.localSequence &&
        JSON.stringify(app.state)===saved.state &&
        app.catchUp.list.textContent===saved.rendered &&
        JSON.stringify(app.snapshotBoundary)===JSON.stringify(saved.boundary) &&
        JSON.stringify(app.catchUpCursor)===JSON.stringify(saved.cursor) &&
        !app.alert.hidden && app.alert.textContent.includes('position was saved') &&
        !app.retryButton.hidden && app.retryAction===app.retryRefresh && saved.writes===1;
    })()`), true, 'committed cursor survives reload failure while local projection and refresh retry are preserved');
    await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app'), saved=window.commitRecovery;
      await app.store.append({type:'add',text:'Unseen after committed cursor',classification:'need'},app.engine);
      app.store.getCatchUpState=saved.read;
      app.retryButton.click();
    })()`);
    await until(() => first.evaluate(`!document.querySelector('kin-app').busy`));
    assert.equal(await first.evaluate(`(async()=>{
      const app=document.querySelector('kin-app'), saved=window.commitRecovery;
      const snapshot=await saved.read();
      return saved.writes===1 && app.retryAction===null && app.alert.hidden &&
        snapshot.cursor.localSequence===saved.boundary.localSequence &&
        app.catchUpCursor.localSequence===snapshot.cursor.localSequence &&
        app.state.summary.totalCount===1 &&
        app.state.summary.entries[0].text==='Unseen after committed cursor' &&
        app.catchUp.list.textContent.includes('Unseen after committed cursor');
    })()`), true, 'retry reloads canonical state without another cursor write or hiding later events');
    assert.deepEqual(await second.evaluate('window.catchUpMessages'), [
      { type: 'view-state-changed' },
    ], 'refresh retry does not broadcast another cursor commit');
  } finally {
    await first.evaluate(`(()=>{
      const app=document.querySelector('kin-app'), saved=window.commitRecovery;
      app.store.getCatchUpState=saved.read;
      app.store.markCaughtUpThrough=saved.mark;
      delete window.commitRecovery;
    })()`);
    await second.evaluate(`document.querySelector('kin-app').channel.removeEventListener(
      'message',window.catchUpListener
    )`);
  }
  await first.evaluate("document.querySelector('kin-app').handleCaughtUp()");
  await until(() => second.evaluate("document.querySelector('kin-app').state.summary.totalCount===0"));
  console.log('PASS committed cursor with failed refresh preserves local summary, invalidates peers, and retries without writing');

  await first.evaluate(`document.querySelector('kin-app').handleAddItem({
    detail: { text: 'Missed cursor notification', classification: 'need' }
  })`);
  await until(() =>
    second.evaluate(`document.querySelector('kin-app').state.summary.entries.some(
    entry => entry.text === 'Missed cursor notification'
  )`),
  );
  await second.evaluate(`(()=>{
    const app=document.querySelector('kin-app');
    app.channel.removeEventListener('message',app.onPeerMessage);
  })()`);
  await first.evaluate(
    `document.querySelector('kin-app').catchUp.button.click()`,
  );
  await until(() =>
    first.evaluate(
      `document.querySelector('kin-app').state.summary.totalCount===0`,
    ),
  );
  assert.equal(
    await second.evaluate(
      `document.querySelector('kin-app').state.summary.totalCount`,
    ),
    1,
    "a tab that missed view-state invalidation keeps its old local projection until recovery",
  );
  await second.evaluate(
    `document.dispatchEvent(new Event('visibilitychange'))`,
  );
  await until(() =>
    second.evaluate(
      `document.querySelector('kin-app').state.summary.totalCount===0`,
    ),
  );
  await second.evaluate(`(()=>{
    const app=document.querySelector('kin-app');
    app.channel.addEventListener('message',app.onPeerMessage);
  })()`);

  const readBoundary = async (client) =>
    client.evaluate(`(async()=>{
    const snapshot=await document.querySelector('kin-app').store.getCatchUpState();
    return {
      eventId:snapshot.through.eventId,
      localSequence:snapshot.through.localSequence,
      snapshotThroughEventId:snapshot.through.eventId,
      snapshotThroughLocalSequence:snapshot.through.localSequence,
    };
  })()`);
  const appendChange = async (client, text) =>
    client.evaluate(`(async()=>{
    const app=document.querySelector('kin-app');
    await app.store.append({type:'add',text:${JSON.stringify(text)},classification:'need'},app.engine);
  })()`);
  const markBoundary = async (client, boundary) =>
    client.evaluate(
      `document.querySelector('kin-app').store.markCaughtUpThrough(${JSON.stringify(boundary)})`,
    );
  const readCursor = async (client) =>
    client.evaluate(`(async()=>{
    const cursor=(await document.querySelector('kin-app').store.getCatchUpState()).cursor;
    return cursor;
  })()`);

  const olderA = await readBoundary(first);
  await appendChange(first, "Second tab newer boundary");
  const newerB = await readBoundary(second);
  await markBoundary(second, newerB);
  await markBoundary(first, olderA);
  assert.deepEqual(await readCursor(first), await readCursor(second));
  assert.equal((await readCursor(first)).localSequence, newerB.localSequence);

  const olderB = await readBoundary(second);
  await appendChange(second, "First tab newer boundary");
  const newerA = await readBoundary(first);
  await markBoundary(first, olderB);
  await markBoundary(second, newerA);
  assert.deepEqual(await readCursor(first), await readCursor(second));
  assert.equal((await readCursor(second)).localSequence, newerA.localSequence);
  await first.evaluate("document.querySelector('kin-app').refreshFromEvents()");
  await second.evaluate(
    "document.querySelector('kin-app').refreshFromEvents()",
  );
  console.log(
    "PASS content-free cross-tab invalidation, missed-notification recovery, and both stale/new cursor write orders",
  );
}
