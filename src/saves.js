// Local world saves in IndexedDB (per browser). Falls back to memory if IndexedDB is unavailable.
const DB = 'ironfield', STORE = 'saves';
let dbp = null;
const mem = new Map();

function open() {
  if (dbp) return dbp;
  dbp = new Promise(res => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  });
  return dbp;
}
function tx(db, mode) { return db.transaction(STORE, mode).objectStore(STORE); }
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function listSaves() {
  const db = await open();
  let all;
  if (!db) all = [...mem.values()];
  else all = await req(tx(db, 'readonly').getAll());
  return all.map(s => ({ id: s.id, name: s.name, tick: s.tick, date: s.date, size: s.bytes ? s.bytes.length : 0 })).sort((a, b) => b.date - a.date);
}
export async function putSave(rec) {
  const db = await open();
  if (!db) { mem.set(rec.id, rec); return; }
  await req(tx(db, 'readwrite').put(rec));
}
export async function getSave(id) {
  const db = await open();
  if (!db) return mem.get(id);
  return req(tx(db, 'readonly').get(id));
}
export async function deleteSave(id) {
  const db = await open();
  if (!db) { mem.delete(id); return; }
  await req(tx(db, 'readwrite').delete(id));
}
