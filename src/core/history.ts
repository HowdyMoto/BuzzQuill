import type { HistoryEntry } from './types';

/**
 * Undo/redo bookkeeping: a linear stack of document snapshots with a
 * branch-on-edit model and a bounded depth.
 *
 * This class owns ONLY the navigation logic — the entry array, the current
 * index, the saved-baseline index (which drives `dirty`), and the depth cap.
 * Capturing and restoring the actual document is delegated to the two callbacks
 * supplied by the owner, so History has no knowledge of the SVG DOM or the
 * shape model. That callback seam is also where a future patch/command-based
 * undo would swap in: the navigation stays identical, only what a "snapshot" is
 * (full markup vs. a delta) changes.
 *
 * Extracted from AppState so the index-arithmetic — easy to get subtly wrong
 * (branch truncation, baseline tracking across the shift cap) — lives in one
 * small, focused unit instead of being threaded through the god object.
 */
export class History {
  private entries: HistoryEntry[] = [];
  private index = -1;
  /** Index whose document matches the last save/open/new (drives `dirty`). */
  private savedIndex = 0;
  private readonly capture: () => HistoryEntry;
  private readonly restore: (entry: HistoryEntry) => void;
  private readonly max: number;
  /** Total-bytes ceiling across all entries. The entry-count cap (`max`) alone
   *  lets a large document pin ~max × docSize of snapshots (a 2 MB doc → ~200 MB);
   *  this caps the actual memory, trading undo *depth* for size on big docs. */
  private readonly maxBytes: number;

  constructor(
    capture: () => HistoryEntry,
    restore: (entry: HistoryEntry) => void,
    max = 100,
    maxBytes = 64 * 1024 * 1024,
  ) {
    this.capture = capture;
    this.restore = restore;
    this.max = max;
    this.maxBytes = maxBytes;
  }

  private entryBytes(e: HistoryEntry): number {
    // Char length is a good proxy for the retained size; svgContent dominates.
    return e.svgContent.length + e.artboardsJson.length;
  }

  /** Capture the current document as a new entry at the head of the stack. */
  save(): void {
    this.restoredSinceSave = false;
    const entry = this.capture();
    // Branching off before a saved-but-undone state discards that saved point.
    if (this.savedIndex > this.index) this.savedIndex = -1;
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(entry);
    if (this.entries.length > this.max) {
      this.entries.shift();
      this.savedIndex--;
    }
    // Then enforce the memory ceiling: drop oldest entries while over budget, but
    // always keep at least two so a single undo is still possible.
    let total = this.entries.reduce((n, e) => n + this.entryBytes(e), 0);
    while (this.entries.length > 2 && total > this.maxBytes) {
      total -= this.entryBytes(this.entries[0]);
      this.entries.shift();
      this.savedIndex--;
    }
    this.index = this.entries.length - 1;
  }

  /** True after an undo/redo with no save since — the gesture that opened the
   *  current entry is gone, so an amend would rewrite a HISTORICAL entry (e.g. a
   *  stale nudge-commit timer firing right after Ctrl+Z). */
  private restoredSinceSave = false;

  /** Replace the current entry with a fresh snapshot, instead of pushing a new
   *  one. Lets a continuous gesture (e.g. a held arrow-key nudge) that opened one
   *  entry fold its later movement into that same entry — so it stays a single
   *  undo step. No-op before the first save, and after an undo/redo (the entry
   *  under the index is then history, not the gesture's own entry). */
  amend(): void {
    if (this.index >= 0 && !this.restoredSinceSave) this.entries[this.index] = this.capture();
  }

  undo(): boolean {
    if (this.index <= 0) return false;
    this.index--;
    this.restoredSinceSave = true;
    this.restore(this.entries[this.index]);
    return true;
  }

  redo(): boolean {
    if (this.index >= this.entries.length - 1) return false;
    this.index++;
    this.restoredSinceSave = true;
    this.restore(this.entries[this.index]);
    return true;
  }

  get canUndo(): boolean { return this.index > 0; }
  get canRedo(): boolean { return this.index < this.entries.length - 1; }

  /** True when there are edits since the last save/open/new. */
  get dirty(): boolean { return this.index !== this.savedIndex; }

  /** A token identifying the current document version. Changes on every edit
   *  (and undo/redo). Callers snapshot it before an async save and compare after,
   *  so they only mark clean if nothing changed during the await. */
  get revision(): number { return this.index; }

  /** Mark the current state as the saved baseline (call after save/open/new). */
  markClean(): void { this.savedIndex = this.index; }

  /** Snapshot the whole undo stack (for caching a document tab's history). */
  exportState(): HistorySnapshot {
    return { entries: [...this.entries], index: this.index, savedIndex: this.savedIndex };
  }

  /** Restore a previously exported undo stack. The caller guarantees the live
   *  document already matches entries[index] (e.g. it was just loaded). */
  restoreState(s: HistorySnapshot): void {
    this.entries = [...s.entries];
    this.index = s.index;
    this.savedIndex = s.savedIndex;
  }
}

export interface HistorySnapshot {
  entries: HistoryEntry[];
  index: number;
  savedIndex: number;
}
