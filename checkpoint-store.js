const databaseName = 'warcraft2-tidewater-checkpoint:' + new URL('./', import.meta.url).pathname;
const storeName = 'battle';
const slot = 'continue';
const maxBytes = 4 * 1024 * 1024;

export function checkpointKey(world) {
  if (world?.scenario) return 'scenario:' + world.scenario.id + ':' + world.scenario.seed;
  if (Number.isInteger(world?.mission?.id)) return 'campaign:' + world.mission.id;
  return null;
}

export function createCheckpointStore() {
  let database;

  function open() {
    database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          database = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    }).catch(error => {
      database = undefined;
      throw error;
    });
    return database;
  }

  async function run(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = action(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function read(key) {
    if (!key) return null;
    const value = await run('readonly', store => store.get(slot));
    if (value?.key !== key || !(value.bytes instanceof Uint8Array) ||
        !value.bytes.length || value.bytes.length > maxBytes) return null;
    return value;
  }

  async function write(key, bytes, camera) {
    if (!key || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > maxBytes) return;
    await run('readwrite', store => store.put({key, bytes, camera}, slot));
  }

  const clear = () => run('readwrite', store => store.delete(slot));
  return {read, write, clear};
}
