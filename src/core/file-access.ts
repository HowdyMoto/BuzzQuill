/**
 * Thin wrapper around the File System Access API (Chrome/Edge) with a
 * graceful anchor-download fallback for browsers that don't support it
 * (Firefox/Safari). When supported, callers can keep the returned
 * FileSystemFileHandle and write back to the same file with no re-prompt.
 */

export interface FilePickerType {
  description: string;
  accept: Record<string, string[]>;
}

/** True when the browser can open/save files in place (secure context required). */
export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

/** Prompt the user to choose a file to open. Returns null if unsupported or cancelled. */
export async function openFilePicker(types: FilePickerType[]): Promise<FileSystemFileHandle | null> {
  if (!supportsFileSystemAccess()) return null;
  try {
    const [handle] = await window.showOpenFilePicker({ types, multiple: false });
    return handle ?? null;
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') return null;
    throw err;
  }
}

/** Prompt the user for a save location. Returns null if unsupported or cancelled. */
export async function saveFilePicker(
  suggestedName: string,
  types: FilePickerType[],
): Promise<FileSystemFileHandle | null> {
  if (!supportsFileSystemAccess()) return null;
  try {
    return await window.showSaveFilePicker({ suggestedName, types });
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') return null;
    throw err;
  }
}

type PermState = 'granted' | 'denied' | 'prompt';
interface HandleWithPerm {
  queryPermission?(d: { mode: 'readwrite' }): Promise<PermState>;
  requestPermission?(d: { mode: 'readwrite' }): Promise<PermState>;
}

/**
 * Ensure we hold READWRITE permission on a file handle before writing.
 *
 * Opening a file (Open dialog / Recent Files) grants only READ — see
 * ui/recent-files.ts, which deliberately asks for 'read' so opening doesn't pop a
 * scary "let this site edit your files?" prompt. Write permission must be acquired
 * separately: `createWritable()` does NOT prompt — on a read-only handle it just
 * throws NotAllowedError — so the FIRST save of an opened file was silently failing
 * and falling back to a "choose a new location" prompt. Requesting 'readwrite' here
 * shows the one expected prompt at the moment the user actually saves. Must run
 * inside a user gesture (Save is triggered by ⌘S / a menu click, which qualifies).
 */
export async function ensureWritePermission(handle: FileSystemFileHandle): Promise<boolean> {
  const h = handle as FileSystemFileHandle & HandleWithPerm;
  try {
    if (!h.queryPermission) return true; // older browsers: no permission gating, write directly
    if (await h.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
    if (h.requestPermission && await h.requestPermission({ mode: 'readwrite' }) === 'granted') return true;
    return false;
  } catch {
    return false;
  }
}

/** Write text or a blob to a handle obtained from a picker. Requests write
 *  permission first so a read-only (just-opened) handle doesn't throw. */
export async function writeHandle(handle: FileSystemFileHandle, contents: string | Blob): Promise<void> {
  if (!(await ensureWritePermission(handle))) {
    throw new DOMException('Permission to write the file was not granted.', 'NotAllowedError');
  }
  const writable = await handle.createWritable();
  await writable.write(contents);
  await writable.close();
}

/** Read a handle's current contents, decoded as an SVG document. */
export async function readHandle(handle: FileSystemFileHandle): Promise<string> {
  return readSvgFile(await handle.getFile());
}

/**
 * Decode an opened SVG file to text, handling the two ways a real `.svg`/`.svgz`
 * on disk defeats a naive `file.text()` (which assumes plain UTF-8):
 *   - gzip-compressed `.svgz` (or a gzipped `.svg`) — inflated via the platform
 *     DecompressionStream;
 *   - a non-UTF-8 encoding — a BOM, or an XML prolog `encoding="…"` declaration
 *     (ISO-8859-1, Windows-1252, UTF-16, …) — decoded with the right TextDecoder.
 */
export async function readSvgFile(file: Blob): Promise<string> {
  let buf = await file.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  // Gzip magic (1f 8b) → it's an .svgz / gzipped .svg; inflate first.
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b && 'DecompressionStream' in globalThis) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = await new Response(stream).arrayBuffer();
  }
  return decodeXmlBytes(buf);
}

/** Decode XML bytes honoring a BOM or an XML-prolog `encoding="…"` declaration. */
function decodeXmlBytes(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(b.subarray(3));      // UTF-8 BOM
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  // Sniff `<?xml … encoding="X"?>` from the ASCII-safe head (the prolog is ASCII).
  const head = new TextDecoder('iso-8859-1').decode(b.subarray(0, 256));
  const m = /<\?xml[^>]*\bencoding=["']([\w-]+)["']/i.exec(head);
  if (m && !/^utf-?8$/i.test(m[1])) {
    try { return new TextDecoder(m[1]).decode(b); } catch { /* unknown label → utf-8 */ }
  }
  return new TextDecoder('utf-8').decode(b);
}

/** Legacy fallback: trigger a browser download (drops into the Downloads folder). */
export function downloadFile(filename: string, contents: string | Blob, mime: string): void {
  const blob = contents instanceof Blob ? contents : new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
