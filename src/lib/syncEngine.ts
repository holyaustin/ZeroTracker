import { createSyncEngine as create, BATCH_SIZE } from "../../packages/shared/src/syncEngine";
import type { Engine, DeviceEvent, SyncState } from "../../packages/shared/src/syncEngine";
import * as idb from "./offlineQueue";

export { BATCH_SIZE };
export type { Engine, DeviceEvent, SyncState };

/** Web flavour of the shared engine: events are queued in IndexedDB. */
export const createSyncEngine = (o: Omit<Parameters<typeof create>[0], "store">) => create({ store: idb, ...o });
