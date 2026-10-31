// ---------------------------------------------------------------------------
// Google Drive — the browser-only client: an OAuth access token from Google
// Identity Services, and the handful of Drive v3 REST calls the editor needs.
//
// No server anywhere in this path. The token comes straight from Google's popup
// to this page (scope `drive.file`: only files the user picked or the app made),
// lives in memory + sessionStorage for its hour, and is never refreshed in the
// background — GIS has no refresh token in the browser, and asking Google for a
// new one opens a popup, which browsers allow only inside a user gesture. So
// `ensureToken` must be called from a click/keypress handler, and callers treat
// `null` as "the user closed or blocked the sign-in", not as an error.
//
// Drive v3 has no `If-Match`: a conflicting write can only be caught by reading
// `modifiedTime` first and comparing, which `updateFile` does (best-effort
// optimistic concurrency, same policy the old cloud backend had).
// ---------------------------------------------------------------------------

import { GOOGLE_CLIENT_ID, DRIVE_SCOPE, isDriveConfigured } from './google-config';

const GSI_SRC = 'https://accounts.google.com/gsi/client';
const API_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const SVG_MIME = 'image/svg+xml';
const FIELDS = 'id,name,mimeType,modifiedTime';
const TOKEN_KEY = 'bq-drive-token';
const DISCONNECTED_KEY = 'bq-drive-disconnected';
let explicitlyDisconnected = false;
try { explicitlyDisconnected = sessionStorage.getItem(DISCONNECTED_KEY) === '1'; } catch { /* blocked storage */ }
function setDisconnected(value: boolean): void {
  explicitlyDisconnected = value;
  try { if (value) sessionStorage.setItem(DISCONNECTED_KEY, '1'); else sessionStorage.removeItem(DISCONNECTED_KEY); } catch { /* blocked storage */ }
}
/** Treat a token as expired this long before Google does, so a save that starts
 *  at the edge doesn't fail halfway through its upload. */
const EXPIRY_SKEW_MS = 60_000;

/** The token was rejected or missing: the caller should ask the user to reconnect. */
export class DriveAuthError extends Error {}

/** The file changed in Drive after it was opened; `serverModified` is Drive's
 *  current `modifiedTime`, so the caller can offer to overwrite. */
export class DriveConflictError extends Error {
  serverModified: string;
  constructor(serverModified: string) {
    super('The file was changed in Google Drive after it was opened.');
    this.serverModified = serverModified;
  }
}

export interface DriveFile { id: string; name: string; mimeType: string; modifiedTime: string }

// ---- Script loading ---------------------------------------------------------

const scriptLoads = new Map<string, Promise<void>>();

/** Load a third-party script once (the CSP allows exactly these hosts — see
 *  vite.config.ts). Resolves after it has executed; rejects if it fails to load. */
export function loadScript(src: string): Promise<void> {
  let p = scriptLoads.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => { scriptLoads.delete(src); reject(new Error(`Failed to load ${src}`)); };
      document.head.appendChild(s);
    });
    scriptLoads.set(src, p);
  }
  return p;
}

// ---- Token ------------------------------------------------------------------

interface CachedToken { token: string; expiresAt: number }

function readCache(): CachedToken | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<CachedToken>;
    return typeof v.token === 'string' && typeof v.expiresAt === 'number' ? { token: v.token, expiresAt: v.expiresAt } : null;
  } catch { return null; }
}

function writeCache(c: CachedToken | null): void {
  try {
    if (c) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(c));
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* private window / blocked storage — the in-memory copy still works */ }
}

let cached: CachedToken | null = readCache();

const authListeners = new Set<() => void>();
/** Observe connect/disconnect/expiry (menus and the status chip re-render on it). */
export function onDriveAuthChange(fn: () => void): () => void {
  authListeners.add(fn);
  return () => { authListeners.delete(fn); };
}
function notifyAuth(): void { for (const fn of authListeners) fn(); }

function freshToken(): string | null {
  return cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now() ? cached.token : null;
}

function dropToken(): void {
  if (!cached) return;
  cached = null;
  writeCache(null);
  notifyAuth();
}

/** Connected = holding a token that is still good for at least a minute. */
export function isDriveConnected(): boolean { return freshToken() !== null; }
/** Expired credentials can still be disconnected locally. */
export function canDisconnectDrive(): boolean { return cached !== null; }

let requesting = false;
let revoking = false;
let authGeneration = 0;

let tokenClient: google.accounts.oauth2.TokenClient | null = null;
let inFlight: ((r: google.accounts.oauth2.TokenResponse | null) => void) | null = null;

async function client(): Promise<google.accounts.oauth2.TokenClient> {
  if (tokenClient) return tokenClient;
  await loadScript(GSI_SRC);
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    include_granted_scopes: false,
    callback: (r) => { const done = inFlight; inFlight = null; done?.(r); },
    error_callback: () => { const done = inFlight; inFlight = null; done?.(null); },
  });
  return tokenClient;
}

/**
 * A usable access token, prompting Google if the cached one is missing or about
 * to expire. CALL FROM A USER GESTURE: a prompt is a popup (it closes itself at
 * once when the user already has a Google session), and outside a gesture the
 * browser blocks it. Resolves null when the user closed or blocked the prompt,
 * when Drive isn't configured, or when another prompt is already up.
 */
export async function ensureToken(explicitConnect = false): Promise<string | null> {
  if (explicitlyDisconnected && !explicitConnect) return null;
  if (revoking) return null;
  const have = freshToken();
  if (have) return have;
  if (!isDriveConfigured || requesting) return null;
  requesting = true; // reserve before awaiting the script loader
  const generation = authGeneration;
  try {
    const tc = await client();
    if (generation !== authGeneration) return null;
    const r = await new Promise<google.accounts.oauth2.TokenResponse | null>((resolve) => {
      inFlight = resolve;
      tc.requestAccessToken({ prompt: '' });
    });
    if (!r?.access_token) return null;
    if (generation !== authGeneration) {
      // A sign-in completed after Disconnect. Never restore that authority.
      google.accounts.oauth2.revoke(r.access_token);
      return null;
    }
    const ttlMs = (Number(r.expires_in) || 3600) * 1000;
    setDisconnected(false);
    cached = { token: r.access_token, expiresAt: Date.now() + ttlMs };
    writeCache(cached);
    notifyAuth();
    return cached.token;
  } finally { requesting = false; inFlight = null; }
}

/** Forget local authority immediately; report provider revocation truthfully.
 * A reload restores the token but not the SDK/client, so load GIS explicitly. */
export async function revokeToken(): Promise<boolean> {
  const token = cached?.token ?? null;
  ++authGeneration;
  setDisconnected(true);
  dropToken();
  if (!token) return false;
  revoking = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      (async () => {
        await loadScript(GSI_SRC);
        return new Promise<boolean>((resolve) => {
          google.accounts.oauth2.revoke(token, r => resolve(r?.successful === true));
        });
      })(),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 10_000); }),
    ]);
    return result;
  } catch { return false; }
  finally { clearTimeout(timer); revoking = false; }
}

// ---- REST -------------------------------------------------------------------

async function errorMessage(res: Response): Promise<string> {
  try {
    const j = await res.json() as { error?: { message?: string } };
    return j.error?.message ?? `${res.status} ${res.statusText}`;
  } catch { return `${res.status} ${res.statusText}`; }
}

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = freshToken();
  if (!token) throw new DriveAuthError('Not connected to Google Drive.');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    dropToken(); // Google says it's dead — don't keep presenting it
    throw new DriveAuthError('Google Drive sign-in expired.');
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  return res;
}

const q = (id: string) => encodeURIComponent(id);

export async function getFileMeta(id: string): Promise<DriveFile> {
  const res = await driveFetch(`${API_BASE}/files/${q(id)}?fields=${FIELDS}&supportsAllDrives=true`);
  return res.json() as Promise<DriveFile>;
}

/** The file's bytes (`alt=media`). Returned as a Blob so SVG and PDF share a path
 *  and the SVG decoder (gzip / charset sniffing in core/file-access.ts) applies. */
export async function downloadFile(id: string): Promise<Blob> {
  const res = await driveFetch(`${API_BASE}/files/${q(id)}?alt=media&supportsAllDrives=true`);
  return res.blob();
}

/** One multipart/related body: a JSON metadata part, then the file content. */
function multipart(meta: Record<string, unknown>, content: string, mime: string): { body: string; contentType: string } {
  const boundary = `bq_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(meta),
    `--${boundary}`,
    `Content-Type: ${mime}; charset=UTF-8`,
    '',
    content,
    `--${boundary}--`,
  ].join('\r\n');
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

/** Reuse an accessible root folder; drive.file does not expose arbitrary folders.
 * Coalesce concurrent first saves within this page, but re-query on later saves
 * so deleted/moved folders and changed Google accounts cannot leave stale IDs. */
let folderLookup: { token: string; promise: Promise<string> } | null = null;
function defaultFolder(token: string): Promise<string> {
  if (folderLookup?.token === token) return folderLookup.promise;
  const assertAccount = () => {
    if (freshToken() !== token) throw new DriveAuthError('Google Drive connection changed. Save again after reconnecting.');
  };
  const promise = (async () => {
    assertAccount();
    const query = "name = 'BuzzQuill' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false";
    const params = new URLSearchParams({ q: query, spaces: 'drive', fields: 'files(id)', pageSize: '1', orderBy: 'createdTime' });
    const response = await driveFetch(`${API_BASE}/files?${params}`);
    const result = await response.json() as { files: { id: string }[] };
    assertAccount();
    if (result.files[0]?.id) return result.files[0].id;
    const created = await driveFetch(`${API_BASE}/files?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'BuzzQuill', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] }),
    });
    const folder = await created.json() as { id: string };
    assertAccount();
    if (!folder.id) throw new Error('Google Drive did not return a folder ID.');
    return folder.id;
  })();
  folderLookup = { token, promise };
  const clear = () => { if (folderLookup?.promise === promise) folderLookup = null; };
  void promise.then(clear, clear);
  return promise;
}

/** New SVGs go into My Drive/BuzzQuill; overwrites never move existing files. */
export async function createFile(name: string, svg: string): Promise<DriveFile> {
  const token = freshToken();
  if (!token) throw new DriveAuthError('Connect Google Drive to save.');
  const folderId = await defaultFolder(token);
  if (freshToken() !== token) throw new DriveAuthError('Google Drive connection changed. Save again after reconnecting.');
  const { body, contentType } = multipart({ name, mimeType: SVG_MIME, parents: [folderId] }, svg, SVG_MIME);
  const res = await driveFetch(`${UPLOAD_BASE}/files?uploadType=multipart&fields=${FIELDS}&supportsAllDrives=true`, {
    method: 'POST', headers: { 'Content-Type': contentType }, body,
  });
  return res.json() as Promise<DriveFile>;
}

/**
 * Overwrite an existing file's content. With `expectModified` (the `modifiedTime`
 * we last read or wrote), the file is checked first and a mismatch throws
 * {@link DriveConflictError} without writing — Drive v3 has no atomic precondition,
 * so this is the best available guard against clobbering an edit made elsewhere.
 */
export async function updateFile(id: string, svg: string, expectModified?: string | null): Promise<DriveFile> {
  if (expectModified) {
    const current = await getFileMeta(id);
    if (current.modifiedTime !== expectModified) throw new DriveConflictError(current.modifiedTime);
  }
  const { body, contentType } = multipart({}, svg, SVG_MIME);
  const res = await driveFetch(`${UPLOAD_BASE}/files/${q(id)}?uploadType=multipart&fields=${FIELDS}&supportsAllDrives=true`, {
    method: 'PATCH', headers: { 'Content-Type': contentType }, body,
  });
  return res.json() as Promise<DriveFile>;
}
