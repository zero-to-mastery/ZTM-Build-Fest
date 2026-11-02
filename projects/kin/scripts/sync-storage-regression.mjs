export async function syncStorageRegressions(client) {
  const result = await client.evaluate(`(async()=>{
    const app=document.querySelector('kin-app');
    const {EventStore}=await import('/storage/event-store.js');
    const {EVENT_STORE_DEFINITIONS}=await import('/storage/event-store.js');
    const {encryptedDatabase}=await import('/storage/encrypted-idb.js');
    const {getActiveVault}=await import('/security/local-vault.js');
    const {SyncKeyStore}=await import('/sync/key-store.js');
    const {loadCachedHouseholdSettings}=await import('/sync/sync-coordinator.js');
    const {createHouseholdEpochKey,restoreHouseholdEpochKey}=await import('/sync/crypto.js');
    const {encryptHouseholdSettings,decryptHouseholdSettings}=await import('/appearance/household.js');
    const {DEFAULT_APPEARANCE}=await import('/appearance/store.js');
    const {encodeAddedRecord,encodeCompletedRecord,idFromHex,idToHex}=await import('/wasm/kin-engine.js');
    const keyStore=await SyncKeyStore.open();
    const pendingDevice=await keyStore.getOrCreatePendingDevice();
    const keyHousehold='12'.repeat(16);
    const cachedIdentity={householdId:keyHousehold,memberId:'15'.repeat(16),deviceId:'16'.repeat(16)};
    const pinnedPeer={householdId:keyHousehold,memberId:'13'.repeat(16),deviceId:'14'.repeat(16),publicKeys:pendingDevice.publicKeys,fingerprint:pendingDevice.fingerprint};
    await keyStore.pinTrustedDevice(pinnedPeer);
    const epochMaterial=await createHouseholdEpochKey({
      householdId:keyHousehold,
      keyEpoch:1,
      deviceKeys:pendingDevice.keys,
    });
    await keyStore.saveEpoch({householdId:keyHousehold,keyEpoch:1,...epochMaterial});
    const sharedValue={version:1,revision:0,name:'Offline Home',appearance:{...DEFAULT_APPEARANCE,owner:'household'}};
    const encryptedSettings=await encryptHouseholdSettings(sharedValue,{householdId:keyHousehold,keyEpoch:1,householdKey:epochMaterial.householdKey});
    let settingsBinary=''; for(const byte of encryptedSettings.ciphertext) settingsBinary+=String.fromCharCode(byte);
    const settingsRecord={householdId:keyHousehold,revision:1,keyEpoch:1,ciphertext:btoa(settingsBinary).split('+').join('-').split('/').join('_').replace(/=+$/,''),digest:encryptedSettings.digest};
    await keyStore.cacheHouseholdSettings(settingsRecord);
    await keyStore.bindPendingDevice(cachedIdentity);
    const conflictingEpochMaterial=await createHouseholdEpochKey({
      householdId:keyHousehold,
      keyEpoch:1,
      deviceKeys:pendingDevice.keys,
    });
    if(conflictingEpochMaterial.fingerprint===epochMaterial.fingerprint)
      throw Error('Distinct epoch key material received the same fingerprint');
    let conflictingEpochRejected=false;
    try{
      await keyStore.saveEpoch({householdId:keyHousehold,keyEpoch:1,...conflictingEpochMaterial});
    }catch(error){
      conflictingEpochRejected=error?.message==='Kin found conflicting key material for this household epoch.';
    }
    if(!conflictingEpochRejected)
      throw Error('Conflicting household epoch key material was not rejected');
    keyStore.close();
    const reopenedKeyStore=await SyncKeyStore.open();
    const reopenedDevice=await reopenedKeyStore.getDevice(cachedIdentity.deviceId);
    const reopenedPin=await reopenedKeyStore.getPinnedDevice(keyHousehold,pinnedPeer.deviceId);
    const reopenedEpoch=await reopenedKeyStore.getEpoch(keyHousehold,1);
    const reopenedSettings=await reopenedKeyStore.getCachedHouseholdSettings(keyHousehold);
    const restoredSettings=await decryptHouseholdSettings(reopenedSettings,{householdId:keyHousehold,householdKey:reopenedEpoch.householdKey});
    const startupSettings=await loadCachedHouseholdSettings(cachedIdentity,{keyStore:reopenedKeyStore});
    const restoredHouseholdKey=await restoreHouseholdEpochKey({
      sealed:reopenedEpoch.sealed,
      deviceKeys:reopenedDevice.keys,
    });
    if(reopenedDevice.keys.agreementPrivateKey.extractable ||
       reopenedDevice.keys.signingPrivateKey.extractable ||
       restoredHouseholdKey.extractable!==false ||
      reopenedEpoch.fingerprint!==epochMaterial.fingerprint ||
      reopenedPin?.fingerprint!==pendingDevice.fingerprint || restoredSettings.name!=='Offline Home' || startupSettings.name!=='Offline Home')
      throw Error('IndexedDB did not preserve non-extractable key material safely');
    if(await reopenedKeyStore.getCachedHouseholdSettings('34'.repeat(16))!==null)
      throw Error('Household settings leaked across household identities');
    const newer={...reopenedSettings,revision:2,digest:'a'.repeat(64),ciphertext:'AQ'};
    await reopenedKeyStore.cacheHouseholdSettings(newer);
    if((await reopenedKeyStore.cacheHouseholdSettings(reopenedSettings)).revision!==2)
      throw Error('An older household settings revision replaced a newer cache');
    let malformedRejected=false;
    try{await reopenedKeyStore.cacheHouseholdSettings({...newer,householdId:'wrong'});}catch{malformedRejected=true;}
    if(!malformedRejected) throw Error('Malformed cached household settings were accepted');
    let tamperedRejected=false;
    try{await decryptHouseholdSettings(newer,{householdId:keyHousehold,householdKey:reopenedEpoch.householdKey});}catch{tamperedRejected=true;}
    if(!tamperedRejected) throw Error('Tampered cached household settings were accepted');
    reopenedKeyStore.close();
    await new Promise((resolve,reject)=>{
      const request=indexedDB.deleteDatabase('kin-crypto-keys');
      request.onsuccess=resolve;
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(Error('Crypto key fixture database remained open'));
    });
    const databaseName='kin-sync-fixture';
    await new Promise((resolve,reject)=>{
      const request=indexedDB.deleteDatabase(databaseName);
      request.onsuccess=resolve;
      request.onerror=()=>reject(request.error);
    });
    const database=await new Promise((resolve,reject)=>{
      const request=indexedDB.open(databaseName,2);
      request.onupgradeneeded=()=>{
        const db=request.result;
        const events=db.createObjectStore('events',{keyPath:'local_sequence',autoIncrement:true});
        events.createIndex('event_id','event_id',{unique:true});
        db.createObjectStore('local_context',{keyPath:'key'});
        db.createObjectStore('sync_state',{keyPath:'key'});
        db.createObjectStore('sync_outbox',{keyPath:'event_id'});
        db.createObjectStore('sync_bindings',{keyPath:'legacy_key'});
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    const store=new EventStore(encryptedDatabase(database,getActiveVault(),EVENT_STORE_DEFINITIONS));
    const context=await store.ensureContext();
    store.actorId=idToHex(context.actor_id);
    await store.append({type:'add',text:'Legacy local event',classification:'need'},app.engine);
    const before=await store.loadEvents();
    const originalBytes=new Uint8Array(before[0].encoded_event).slice();
    const identity={
      householdId:'11'.repeat(16),
      memberId:'22'.repeat(16),
      deviceId:'33'.repeat(16),
    };
    const binding={
      legacyHouseholdId:idToHex(before[0].household_id),
      legacyActorId:idToHex(before[0].actor_id),
      legacyDeviceId:idToHex(before[0].device_id),
      householdId:identity.householdId,
      actorId:identity.memberId,
      deviceId:identity.deviceId,
    };
    const remoteBinding={
      legacyHouseholdId:'88'.repeat(16),
      legacyActorId:'99'.repeat(16),
      legacyDeviceId:'aa'.repeat(16),
      householdId:identity.householdId,
      actorId:'77'.repeat(16),
      deviceId:'66'.repeat(16),
    };
    const remoteBindingEnvelope={deviceId:remoteBinding.deviceId,keyEpoch:1,eventId:'bb'.repeat(16),ciphertext:'remote-signed-control'};
    const initial=await store.initializeSync({
      identity,
      serverStatus:{currentEpoch:1,pendingEpoch:null,rotationPending:false},
      identityBindings:[{binding:remoteBinding,envelope:remoteBindingEnvelope}],
      legacyBindingEnvelope:{version:1,ciphertext:'opaque-test-control'},
    });
    const migrated=await store.loadEvents();
    if(migrated.length!==1 || new Uint8Array(migrated[0].encoded_event).some((byte,index)=>byte!==originalBytes[index]))
      throw Error('Sync initialization rewrote canonical local event bytes');
    if(initial.syncIdentity.bindings.length!==2 || !initial.syncIdentity.bindings.some(binding=>binding.deviceId===identity.deviceId))
      throw Error('Legacy identity mapping was not installed');
    const localBindings=await store.getPendingBindings();
    if(localBindings.length!==1 || localBindings[0].deviceId!==identity.deviceId)
      throw Error('A remote signed identity binding was incorrectly queued for upload');
    const alreadyRelayed=await store.commitRemoteBatch({
      received:[{encodedEvent:before[0].encoded_event}],
      nextCursor:'AAAAAAAAAAE',
      engine:app.engine,
    });
    const remoteDuplicates=await store.getRemoteDuplicateOutbox();
    if(alreadyRelayed.added!==0 || remoteDuplicates.length!==1 || remoteDuplicates[0].event_id!==idToHex(before[0].event_id))
      throw Error('A stale restored event already on the relay was not marked for deduplicated catch-up');
    const keyRequest=await store.getProvisioningRequest('77'.repeat(16),2);
    const retriedKeyRequest=await store.getProvisioningRequest('77'.repeat(16),2);
    if(keyRequest.requestId!==retriedKeyRequest.requestId)
      throw Error('Provisioning request ID changed across retry');
    const keyPackage={grantId:'cc'.repeat(16),wrappedKey:'cached-wrapped-key'};
    await store.updateProvisioningRequest(keyRequest.requestId,{package:keyPackage});
    await store.updateProvisioningRequest(keyRequest.requestId,{accepted:true});
    const restoredKeyRequest=await store.getProvisioningRequest('77'.repeat(16),2);
    if(!restoredKeyRequest.accepted || JSON.stringify(restoredKeyRequest.package)!==JSON.stringify(keyPackage))
      throw Error('Pending provisioning package was not retained exactly');
    let pending=await store.getPendingOutbox();
    if(pending.length!==1 || pending[0].keyEpoch!==1 || new Uint8Array(pending[0].canonical_event).some((byte,index)=>byte!==originalBytes[index]))
      throw Error('Canonical migration bytes were not durably queued');

    const envelope={
      protocolVersion:1,envelopeVersion:1,eventId:idToHex(before[0].event_id),
      householdId:identity.householdId,deviceId:identity.deviceId,deviceSequence:1,
      logicalTime:String(before[0].logical_time),keyEpoch:1,nonce:'AAAAAAAAAAAAAAAA',
      ciphertext:'AAAAAAAAAAAAAAAAAAAAAA',signature:'A'.repeat(86),
    };
    await store.storeOutboxEnvelope(envelope.eventId,envelope,1);
    await store.storeOutboxEnvelope(envelope.eventId,envelope,1);
    let conflictingRetry=false;
    try{
      await store.storeOutboxEnvelope(envelope.eventId,{...envelope,ciphertext:'BBBBBBBBBBBBBBBBBBBBBB'},1);
    }catch{conflictingRetry=true;}
    if(!conflictingRetry) throw Error('A new randomized retry replaced the persisted envelope');
    await store.markOutboxAccepted(envelope.eventId,'AAAAAAAAAAE');
    if((await store.getPendingOutbox()).length!==0)
      throw Error('Acknowledged outbox event remained pending');

    let snapshot=await store.getCatchUpState();
    await store.markCaughtUpThrough({
      eventId:snapshot.through.eventId,
      localSequence:snapshot.through.localSequence,
      snapshotThroughEventId:snapshot.through.eventId,
      snapshotThroughLocalSequence:snapshot.through.localSequence,
    });
    const uiCursorBefore=(await store.getCatchUpState()).cursor.eventId;
    const remoteLater=encodeAddedRecord({
      eventId:idFromHex('66'.repeat(16)),
      householdId:idFromHex(identity.householdId),
      actorId:idFromHex(identity.memberId),
      deviceId:idFromHex(identity.deviceId),
      timestamp:2,
      logicalTime:2n,
      itemId:idFromHex('77'.repeat(16)),
      text:'Remote later tie-break',
    });
    const remoteEarlier=encodeAddedRecord({
      eventId:idFromHex('44'.repeat(16)),
      householdId:idFromHex(identity.householdId),
      actorId:idFromHex(identity.memberId),
      deviceId:idFromHex(identity.deviceId),
      timestamp:2,
      logicalTime:2n,
      itemId:idFromHex('55'.repeat(16)),
      text:'Remote earlier tie-break',
    });
    const committed=await store.commitRemoteBatch({
      received:[{encodedEvent:remoteLater},{encodedEvent:remoteEarlier}],
      nextCursor:'AAAAAAAAAAI',
      engine:app.engine,
    });
    if(committed.added!==2 || committed.state.items.length!==3)
      throw Error('Remote event was not persisted and replayed atomically');
    if(committed.state.items[1].text!=='Remote earlier tie-break' || committed.state.items[2].text!=='Remote later tie-break')
      throw Error('Equal-time remote state did not use the stable event-ID tie-break');
    if(committed.state.summary.throughEventId!=='66'.repeat(16))
      throw Error('Catch-up summary did not follow the stable equal-time replay order');
    snapshot=await store.getCatchUpState();
    if(snapshot.cursor.eventId!==uiCursorBefore)
      throw Error('Transport cursor corrupted the catch-up acknowledgement cursor');
    if(!committed.state.summary.entries.some(entry=>entry.text==='Remote earlier tie-break') ||
       !committed.state.summary.entries.some(entry=>entry.text==='Remote later tie-break'))
      throw Error('Committed remote event did not enter the catch-up summary');
    const replay=await store.commitRemoteBatch({
      received:[{encodedEvent:remoteLater},{encodedEvent:remoteEarlier}],
      nextCursor:'AAAAAAAAAAI',
      engine:app.engine,
    });
    if(replay.added!==0 || (await store.loadEvents()).length!==3)
      throw Error('Crash-safe redelivery duplicated a canonical event');
    // #153: a completion delivered a page before its item is kept encrypted
    // and applied automatically once the item arrives.
    const lateItem={householdId:idFromHex(identity.householdId),actorId:idFromHex(identity.memberId),deviceId:idFromHex(identity.deviceId),itemId:idFromHex('5a'.repeat(16))};
    const earlyCompletion=encodeCompletedRecord({...lateItem,eventId:idFromHex('5c'.repeat(16)),timestamp:4,logicalTime:4n});
    const lateAdd=encodeAddedRecord({...lateItem,eventId:idFromHex('5b'.repeat(16)),timestamp:3,logicalTime:3n,text:'Arrives after its completion'});
    const early=await store.commitRemoteBatch({received:[{encodedEvent:earlyCompletion}],nextCursor:'AAAAAAAAAAJ',engine:app.engine});
    const kept=(await store.getSyncState()).quarantine;
    if(early.added!==0 || early.quarantined!==1 || kept?.length!==1 || kept[0].eventId!=='5c'.repeat(16) || kept[0].reason!=='not-applicable')
      throw Error('An early completion was not kept for retry');
    const rawSyncState=await new Promise((resolve,reject)=>{
      const request=database.transaction('sync_state').objectStore('sync_state').get('active');
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
    if('quarantine' in rawSyncState || JSON.stringify(rawSyncState).includes('5c'.repeat(16)))
      throw Error('Quarantined events were stored without encryption');
    const late=await store.commitRemoteBatch({received:[{encodedEvent:lateAdd}],nextCursor:'AAAAAAAAAAK',engine:app.engine});
    const lateState=await store.getSyncState();
    if(late.added!==2 || late.quarantined!==0 || lateState.quarantine.length!==0 ||
       late.state.items.find(item=>item.text==='Arrives after its completion')?.status!=='completed')
      throw Error('A kept completion was not applied once its item arrived');
    let rollbackRejected=false;
    try{
      await store.commitRemoteBatch({received:[],nextCursor:'',engine:app.engine});
    }catch{rollbackRejected=true;}
    if(!rollbackRejected) throw Error('A lower transport cursor was accepted');
    if(!await store.requeueAfterRelayReset('AAAAAAAAAAA'))
      throw Error('Relay reset was not detected from the cursor high-water mark');
    pending=await store.getPendingOutbox();
    if(pending.length!==1 || JSON.stringify(pending[0].envelope)!==JSON.stringify(envelope))
      throw Error('Relay reset did not reuse the exact accepted envelope');
    if(database.version!==2) throw Error('The sync database migration version is not 2');
    store.close();
    await new Promise((resolve,reject)=>{
      const request=indexedDB.deleteDatabase(databaseName);
      request.onsuccess=resolve;
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(Error('Sync fixture database remained open'));
    });
    return {version:database.version,localBytesPreserved:true,cursorSeparated:true,duplicateAdded:replay.added,offlineSettings:true,quarantineRetried:true};
  })()`);
  if (
    !result.localBytesPreserved ||
    !result.cursorSeparated ||
    result.duplicateAdded !== 0 || !result.offlineSettings || !result.quarantineRetried
  )
    throw new Error(`Sync storage fixture failed: ${JSON.stringify(result)}`);
  console.log(
    "PASS sync migration preserves canonical bytes, retries exact envelopes, commits remote replay/cursor atomically, retries quarantined events, and keeps catch-up separate",
  );
}
