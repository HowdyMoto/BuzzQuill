import { type RasterAsset, collectAssets } from './raster-assets';
import type { ViewState } from './canvas';
import type { DocSource } from './doc-source';

/**
 * Session restore — persist the open documents so the user's work comes back on
 * the next app load without manually re-opening anything. Each tab is stored as
 * its serialized SVG (the same lossless round-trip the tab manager already uses
 * for tab switching), plus per-tab title/view/selection and its source (see
 * core/doc-source.ts) — a local file handle is structured-cloneable, like Recent
 * Files — so ⌘S on a restored document keeps writing to the same file instead of
 * prompting for a brand-new one. Undo history is still dropped (it resets on
 * load); content — the actual work — is what round-trips here.
 *
 * Stored in its own IndexedDB database (not `localStorage`) because a document's
 * serialized SVG easily exceeds the ~5MB localStorage quota. Kept separate from
 * the Recent Files DB so their schema versions never have to be coordinated.
 */

export interface SessionTab {
  title: string;
  /** Serialized document SVG, or null for a blank untouched (default-frame) tab. */
  svg: string | null;
  view: ViewState | null;
  selection: string[];
  /** Where the document lives, so Save keeps writing to the same file after a
   *  reload. Absent on pre-DocSource records (normalized by migrateTab). */
  source?: DocSource;
  /** @deprecated pre-DocSource records only — read by migrateTab, never written. */
  fileHandle?: FileSystemFileHandle | null;
  /** The tab's content has an unwritable copy on disk (opened or saved without a
   *  handle) — so a clean tab is safe to close. Absent in older sessions. */
  diskCopy?: boolean;
  /** @deprecated the tether to the removed cloud backend. Ignored by migrateTab:
   *  such a tab comes back with no source (its title is kept), never written. */
  cloudDoc?: unknown;
  /** The tab held UNSAVED changes when this snapshot was taken — its saved
   *  copy (if any) is stale, and the only copy of those edits is this snapshot.
   *  Restored tabs come back "clean" (no reload nag; the session store is the
   *  durable copy while the tab stays open), but the close guard must still know
   *  the delta exists, or closing the tab silently discards it (issue #178).
   *  Absent on older sessions (treated as false). */
  unsavedDelta?: boolean;
}

export interface Session {
  assets?: RasterAsset[];
  assetIds?: string[];
  tabs: SessionTab[];
  activeIndex: number;
}

const DB_NAME = 'buzzquill-session-v2';
const STORE = 'session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // GC dead instance records after 30 days

// Per-instance key so two open app instances (tabs/windows) never overwrite each
// other's session — the old single fixed key meant last-writer-wins, silently
// dropping the other instance's unsaved tabs from restore (#183). Backed by
// sessionStorage: the id is REUSED across reloads of the same tab (so records don't
// accumulate one-per-reload) but is DISTINCT for a separately-opened tab/window (so
// their sessions stay isolated). Falls back to a fresh in-memory id where
// sessionStorage is unavailable (e.g. some private-browsing modes).
const INSTANCE_ID: string = (() => {
  const mint = () =>
    (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `inst-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const existing = sessionStorage.getItem('bq-session-instance');
    if (existing) return existing;
    const id = mint();
    sessionStorage.setItem('bq-session-instance', id);
    return id;
  } catch {
    return mint();
  }
})();

interface StoredRecord { session: Session; updatedAt: number; }

/** Coerce a stored value into a {session, updatedAt} record. New records already
 *  have that shape; a legacy single-'current' value is a raw Session (has `.tabs`)
 *  and is dated oldest so any real per-instance record wins the restore. */
function coerce(value: unknown): StoredRecord | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (Array.isArray(v.tabs)) return { session: normalize(value as Session), updatedAt: 0 };
  if (v.session && typeof v.updatedAt === 'number') return { session: normalize(v.session as Session), updatedAt: v.updatedAt };
  return null;
}

function normalize(session: Session): Session {
  return { ...session, tabs: (session.tabs ?? []).map(migrateTab) };
}

/** Bring a stored tab up to the current shape. Records written before DocSource
 *  carried a bare `fileHandle` (→ a local source) and possibly a `cloudDoc` tether
 *  to the retired cloud backend (→ no source; the content and title are kept, so
 *  the work is still there — Save simply asks where to put it). Pure, exported for
 *  the unit test. */
export function migrateTab(st: SessionTab): SessionTab {
  const { fileHandle, cloudDoc: _cloud, ...rest } = st;
  const source: DocSource = st.source !== undefined ? st.source : (fileHandle ? { kind: 'local', handle: fileHandle } : null);
  return { ...rest, source };
}

function openDB(name = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('assets')) req.result.createObjectStore('assets', { keyPath: 'id' });
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
    req.onerror = () => reject(req.error);
  });
}

let pendingSession: Session | null = null;
let writer: Promise<void> | null = null;
export function saveSession(session: Session): Promise<void> {
  pendingSession = session;
  if (!writer) writer = drainSessions().finally(() => { writer = null; });
  return writer;
}
async function drainSessions(): Promise<void> {
  while (pendingSession) {
    const session = pendingSession; pendingSession = null;
    let db: IDBDatabase | undefined;
    try {
      db = await openDB();
      const { assets = [], ...compact } = session;
      const record: StoredRecord = { session: { ...compact, assetIds: assets.map(a => a.id) }, updatedAt: Date.now() };
      await new Promise<void>((resolve, reject) => {
        const tx = db!.transaction([STORE, 'assets'], 'readwrite');
        const store = tx.objectStore('assets');
        for (const asset of assets) {
          const request = store.getKey(asset.id);
          request.onsuccess = () => { if (request.result === undefined) store.put(asset); };
        }
        tx.objectStore(STORE).put(record, INSTANCE_ID);
        const referenced = new Set<string>();
        const sessions = tx.objectStore(STORE).openCursor();
        sessions.onsuccess = () => {
          const cursor = sessions.result;
          if (cursor) {
            const value = coerce(cursor.value);
            for (const id of value?.session.assetIds ?? []) referenced.add(id);
            cursor.continue();
          } else {
            const keys = store.openKeyCursor();
            keys.onsuccess = () => { const key = keys.result; if (key) { if (!referenced.has(String(key.key))) store.delete(key.key); key.continue(); } };
          }
        };
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
    } catch { /* Keep live assets usable even when session storage is unavailable. */ }
    finally { db?.close(); collectAssets(); }
  }
}

export async function loadSession(): Promise<Session | null> {
  return await loadFromDatabase(DB_NAME) ?? await loadFromDatabase('buzzquill-session');
}
async function loadFromDatabase(name: string): Promise<Session | null> {
  try {
    const db = await openDB(name);
    return await new Promise<Session | null>((resolve, reject) => {
      const tx = db.transaction(db.objectStoreNames.contains('assets') ? [STORE, 'assets'] : [STORE], 'readwrite'); // rw so we can GC dead records in the same pass
      const store = tx.objectStore(STORE);
      const req = store.openCursor();
      let best: StoredRecord | null = null;
      let bestKey: IDBValidKey | null = null;
      const cutoff = Date.now() - MAX_AGE_MS;
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          const rec = coerce(cur.value);
          if (rec && (!best || rec.updatedAt >= best.updatedAt)) { best = rec; bestKey = cur.key; }
          cur.continue();
          return;
        }
        // Restore the most recently written session (the instance the user last
        // touched); crucially we NEVER delete another instance's record here, so a
        // still-open second instance can always recover its own work.
        if (!best) resolve(null);
        else {
          const selected = best.session; const loaded: RasterAsset[] = [];
          const ids = selected.assetIds ?? [];
          if (!ids.length) resolve(selected);
          let left = ids.length;
          for (const id of ids) {
            const request = tx.objectStore('assets').get(id);
            request.onsuccess = () => {
              if (request.result) loaded.push(request.result);
              if (!--left) resolve({ ...selected, assets: loaded });
            };
            request.onerror = () => reject(request.error);
          }
        }
        // Best-effort GC of stale OTHER-instance records, so reloads don't grow the
        // store forever. Never touches this instance's slot or the one just chosen.
        const g = store.openCursor();
        g.onsuccess = () => {
          const c = g.result;
          if (!c) return;
          const rec = coerce(c.value);
          if (rec && rec.updatedAt < cutoff && c.key !== INSTANCE_ID && c.key !== bestKey) c.delete();
          c.continue();
        };
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Debounced scheduling — coalesce the frequent onStateChange calls into one
// write per idle window, and serialize the session lazily (inside the timer) so
// a burst of edits doesn't repeatedly walk the DOM.
// ---------------------------------------------------------------------------

const SAVE_DELAY_MS = 1000;
let saveTimer: number | null = null;
/** Builds the session when the write fires; null = "not now" (the document holds
 *  something uncommitted, like a live preview) — the write is skipped, and the
 *  change that ends that state schedules a fresh one. */
type SessionGetter = () => Session | null;
let pending: SessionGetter | null = null;

export function scheduleSessionSave(getSession: SessionGetter): void {
  pending = getSession;
  if (saveTimer !== null) return; // a write is already queued; it'll use the latest getter
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    const fn = pending;
    pending = null;
    const session = fn?.();
    if (session) void saveSession(session);
  }, SAVE_DELAY_MS);
}

/** Write immediately (best-effort) — for page-hide/unload, where the debounce
 *  window may not elapse. Fires the pending write now rather than on a timer. */
export function flushSessionSave(getSession: SessionGetter): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  pending = null;
  const session = getSession();
  if (session) void saveSession(session);
}
