// Books saved inside the app (the browser's own storage, IndexedDB).
// This is the bookshelf on an iPhone, where there is no Downloads folder to
// look in. Two stores: "meta" (small: name, title, size) and "files" (the book).
'use strict';

const BooksDB = (() => {
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const r = indexedDB.open('epub-reader', 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('meta', { keyPath: 'key' });
          r.result.createObjectStore('files', { keyPath: 'key' });
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    return dbp;
  }
  async function run(stores, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(stores, mode);
      let result;
      fn(t, (v) => { result = v; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Storage was refused.'));
    });
  }
  const req = (r, set) => { r.onsuccess = () => set(r.result); };

  return {
    available: typeof indexedDB !== 'undefined',
    /** All saved books (no file data), newest first. */
    async list() {
      const all = await run(['meta'], 'readonly', (t, set) => req(t.objectStore('meta').getAll(), set));
      return (all || []).sort((a, b) => b.added - a.added);
    },
    /** Save a File. Returns its key. */
    async add(file) {
      const key = `${file.name}|${file.size}`;
      const data = await file.arrayBuffer();
      await run(['meta', 'files'], 'readwrite', (t) => {
        t.objectStore('files').put({ key, data });
        t.objectStore('meta').put({ key, name: file.name, size: file.size, added: Date.now(), title: '' });
      });
      // Ask the phone not to clear our storage when it runs low on space.
      try { await navigator.storage?.persist?.(); } catch { /* not offered */ }
      return key;
    },
    async get(key) {
      const rec = await run(['files'], 'readonly', (t, set) => req(t.objectStore('files').get(key), set));
      if (!rec) throw new Error('That book is no longer saved in this app.');
      return rec.data;
    },
    async setTitle(key, title, author) {
      await run(['meta'], 'readwrite', (t) => {
        const s = t.objectStore('meta');
        const r = s.get(key);
        r.onsuccess = () => { if (r.result) s.put({ ...r.result, title, author: author || '' }); };
      });
    },
    async remove(key) {
      await run(['meta', 'files'], 'readwrite', (t) => {
        t.objectStore('meta').delete(key);
        t.objectStore('files').delete(key);
      });
    },
  };
})();
