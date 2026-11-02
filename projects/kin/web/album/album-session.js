// Opens this device's family-album store (#673) for an unlocked event store:
// one database per household on this device, named by the event store's own
// household ID (album-store.js). Null where IndexedDB isn't available.
import { AlbumBlobStore } from "./album-store.js";

export async function openAlbumStore(store, options = {}) {
  const householdId = store?.localHouseholdId;
  if (typeof householdId !== "string") return null;
  try {
    return await AlbumBlobStore.open(householdId, options);
  } catch {
    return null;
  }
}
