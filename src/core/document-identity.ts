/** A file the editor holds a (possibly read-only) handle to; Save writes in place. */
export interface LocalSource { kind: 'local'; handle: FileSystemFileHandle }

/** A file in the user's Google Drive (ui/drive.ts). `modifiedTime` is Drive's
 *  stamp as of our last read or write — the baseline a save compares against so
 *  an edit made elsewhere is noticed before it is overwritten. */
export interface DriveSource { kind: 'drive'; fileId: string; name: string; modifiedTime: string | null }

/** Where the active document lives. `null` = never saved anywhere (untitled, a
 *  dropped file, a PDF import, a download) — Save becomes Save As. */
export type DocSource = LocalSource | DriveSource | null;

/** Identity of the document currently loaded into AppState. Inactive tabs retain
 * snapshots; history remains the authority for dirty state. */
export interface DocumentIdentity {
  readonly source: DocSource;
  readonly name: string | null;
  readonly diskCopy: boolean;
}

let current: DocumentIdentity = Object.freeze({ source: null, name: null, diskCopy: false });
const listeners = new Set<(identity: DocumentIdentity) => void>();

export function getDocumentIdentity(): DocumentIdentity { return current; }
export function getDocSource(): DocSource { return current.source; }
export function getProjectName(): string { return current.name ?? 'Untitled'; }
export function hasDiskCopy(): boolean { return current.diskCopy; }

/** Replace all identity fields before notifying presentation observers. */
export function adoptSource(source: DocSource, name: string | null, diskCopy = false): void {
  publish({ source, name, diskCopy });
}

export function setProjectName(name: string | null): void { publish({ ...current, name }); }
export function setDiskCopy(diskCopy: boolean): void { publish({ ...current, diskCopy }); }

function publish(identity: DocumentIdentity): void {
  current = Object.freeze(identity);
  for (const listener of listeners) listener(current);
}

/** Presentation subscribes here; document identity itself has no DOM dependency. */
export function onDocumentIdentityChange(listener: (identity: DocumentIdentity) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
