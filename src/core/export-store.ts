/**
 * Remembered export destination — so exporting a frame's targets doesn't re-prompt
 * for a folder every single time. A FileSystemDirectoryHandle is structured-
 * cloneable (like the local file handles the session store already persists), so it
 * round-trips through IndexedDB and survives a reload; the browser still gates
 * re-use behind a one-click permission grant on the first export after a reload.
 *
 * Kept in its own tiny DB so its schema never has to coordinate with the session or
 * recent-files stores.
 */

const DB_NAME = 'buzzquill-export';
const STORE = 'handles';
const KEY = 'export-dir';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Fast path within a session (avoids an IndexedDB round-trip and a re-grant once
// permission has already been established this session).
let sessionDir: FileSystemDirectoryHandle | null = null;

async function idbGet(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch { return null; }
}

async function idbPut(handle: FileSystemDirectoryHandle | null): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      if (handle) store.put(handle, KEY); else store.delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* not persisted — folder memory just won't survive reload */ }
}

type PermState = 'granted' | 'denied' | 'prompt';
interface HandleWithPerm extends FileSystemDirectoryHandle {
  queryPermission?(d: { mode: 'readwrite' }): Promise<PermState>;
  requestPermission?(d: { mode: 'readwrite' }): Promise<PermState>;
}

/** Ensure readwrite permission on a handle. `request:true` may prompt (one click) —
 *  only valid inside a user gesture. */
async function ensurePermission(handle: HandleWithPerm, request: boolean): Promise<boolean> {
  try {
    if (!handle.queryPermission) return true; // older impls: no permission gating
    let p = await handle.queryPermission({ mode: 'readwrite' });
    if (p === 'granted') return true;
    if (p === 'prompt' && request && handle.requestPermission) p = await handle.requestPermission({ mode: 'readwrite' });
    return p === 'granted';
  } catch { return false; }
}

/** The remembered export folder if it's usable right now (permission granted), else
 *  null. Call inside a click handler — it may show a one-click permission prompt. */
export async function getRememberedExportDir(): Promise<FileSystemDirectoryHandle | null> {
  const handle = sessionDir ?? await idbGet();
  if (!handle) return null;
  if (!await ensurePermission(handle as HandleWithPerm, true)) return null;
  sessionDir = handle;
  return handle;
}

/** Remember a folder as the export destination (this session + persisted). */
export async function rememberExportDir(handle: FileSystemDirectoryHandle): Promise<void> {
  sessionDir = handle;
  await idbPut(handle);
}

/** The remembered folder's display name, without prompting for permission. null if
 *  none is remembered. NOTE a drive root reports an EMPTY name (''), which is not the
 *  same as "no folder" — use {@link hasRememberedExportDir} to tell them apart. */
export async function rememberedExportDirName(): Promise<string | null> {
  const handle = sessionDir ?? await idbGet();
  return handle ? handle.name : null;
}

/** True when ANY export folder is remembered — named or not — without prompting for
 *  permission. A drive root has an empty name, so callers can't rely on the name
 *  being truthy to know a folder is set; this is the reliable presence check. */
export async function hasRememberedExportDir(): Promise<boolean> {
  return (sessionDir ?? await idbGet()) != null;
}

/** Forget the remembered export folder. */
export async function forgetExportDir(): Promise<void> {
  sessionDir = null;
  await idbPut(null);
}
