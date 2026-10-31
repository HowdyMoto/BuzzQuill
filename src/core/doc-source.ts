// ---------------------------------------------------------------------------
// Document source — WHERE the active document lives, so Save writes back to the
// right place. One value, one writer path: `adoptSource` in ui/project-file.ts
// (every open/save/import that changes identity) and DocumentManager's tab swap,
// which restores a tab's cached source. Nothing else sets it — guarded by
// `guard:doc-source-has-one-writer` in scripts/smoke.mjs.
//
// Deliberately import-free so it sits below both project-file.ts and the
// document manager without creating a cycle. A plain object holding a
// FileSystemFileHandle structured-clones into IndexedDB, so the value round-trips
// through the session store as-is (like Recent Files).
// ---------------------------------------------------------------------------

/** A file the editor holds a (possibly read-only) handle to; Save writes in place. */
export interface LocalSource { kind: 'local'; handle: FileSystemFileHandle }

/** A file in the user's Google Drive (ui/drive.ts). `modifiedTime` is Drive's
 *  stamp as of our last read or write — the baseline a save compares against so
 *  an edit made elsewhere is noticed before it is overwritten. */
export interface DriveSource { kind: 'drive'; fileId: string; name: string; modifiedTime: string | null }

/** Where the active document lives. `null` = never saved anywhere (untitled, a
 *  dropped file, a PDF import, a download) — Save becomes Save As. */
export type DocSource = LocalSource | DriveSource | null;

let current: DocSource = null;

export function getDocSource(): DocSource { return current; }

/** Replace the active document's source. Prefer `adoptSource` (project-file.ts),
 *  which also sets the display name; this raw setter exists for the tab swap. */
export function setDocSource(s: DocSource): void { current = s; }
