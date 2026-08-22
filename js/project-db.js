const DB_NAME = 'paperpilot-v4';
const DB_VERSION = 1;
const STORE = 'kv';
const SNAPSHOT_KEY = 'project-store';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('browser_no_indexeddb'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb_open_failed'));
  });
  return dbPromise;
}

function tx(storeMode, run) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const trx = db.transaction(STORE, storeMode);
    const store = trx.objectStore(STORE);
    const req = run(store);
    trx.oncomplete = () => resolve(req?.result);
    trx.onerror = () => reject(trx.error || req?.error || new Error('idb_tx_failed'));
    trx.onabort = () => reject(trx.error || new Error('idb_tx_aborted'));
  }));
}

export async function loadProjectSnapshot() {
  try {
    return await tx('readonly', store => store.get(SNAPSHOT_KEY)) || null;
  } catch {
    return null;
  }
}

export async function saveProjectSnapshot(snapshot) {
  return tx('readwrite', store =>
    store.put({ key: SNAPSHOT_KEY, ...snapshot, savedAt: new Date().toISOString() }));
}

export async function clearProjectSnapshot() {
  return tx('readwrite', store => store.delete(SNAPSHOT_KEY));
}
