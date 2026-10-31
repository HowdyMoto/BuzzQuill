import type { AppState } from './state';
import type { DocSource } from './doc-source';

/** The owner of a save is captured before any picker, sign-in or upload awaits. */
export interface DocumentSaveTarget {
  source: DocSource;
  name: string;
  isOpen(): boolean;
  complete(source: DocSource, name: string, diskCopy?: boolean): void;
  release(): void;
}

type SaveOwner = (snapshot: string) => DocumentSaveTarget | null;
const owners = new WeakMap<AppState, SaveOwner>();

export function registerSaveOwner(state: AppState, owner: SaveOwner): void {
  owners.set(state, owner);
}

export function captureSaveTarget(state: AppState, snapshot: string): DocumentSaveTarget | null {
  const owner = owners.get(state);
  if (!owner) throw new Error('Document manager is not ready to save.');
  return owner(snapshot);
}
