import type { PendingOpen } from '../core/pending-open';
import { serializeDocumentSVG, serializeDocumentSVGForSave,
  loadDocumentSVG as decodeSVG, loadDocumentString as decodeString } from '../core/document-codec';

import type { AppState } from '../core/state';
import type { FilePickerType } from '../core/file-access';
import type { PdfImportChoice } from './dialogs';
import {
  supportsFileSystemAccess,
  openFilePicker,
  saveFilePicker,
  writeHandle,
  ensureWritePermission,
  readHandle,
  readSvgFile,
  downloadFile,
} from '../core/file-access';
import { rememberRecentFile } from './recent-files';
import { withLoadingOverlay } from './loading-overlay';
import { showToast } from './toast';
import { adoptSource } from '../core/document-identity';
export { adoptSource, getProjectName, setProjectName, hasDiskCopy, setDiskCopy } from '../core/document-identity';
import { captureSaveTarget } from '../core/document-save';

// Compatibility exports keep existing UI consumers and browser harnesses working.
export { serializeDocumentSVG, serializeDocumentSVGForSave, loadProject } from '../core/document-codec';
export type { PendingOpen } from '../core/pending-open';

export function loadDocumentSVG(state: AppState, text: string): void {
  decodeSVG(state, text, showToast);
}

export function loadDocumentString(state: AppState, text: string): void {
  decodeString(state, text, showToast);
}

const SVG_EXTENSION = '.svg';
const SVG_MIME = 'image/svg+xml';
const LEGACY_EXTENSION = '.svgmaker';

const PICKER_TYPES: FilePickerType[] = [
  { description: 'SVG Image', accept: { [SVG_MIME]: [SVG_EXTENSION] } },
];

/**
 * Guard before any action that replaces the current document. Returns true if
 * it's safe to proceed (no unsaved changes, or the user chose to discard them).
 */
export function confirmDiscard(state: AppState): boolean {
  return !state.dirty || window.confirm('You have unsaved changes that will be lost. Continue?');
}

/** Snapshot content and its owner together, before any asynchronous interaction. */
export function beginDocumentSave(state: AppState) {
  const snapshot = serializeDocumentSVG(state);
  const target = captureSaveTarget(state, snapshot);
  if (!target) {
    showToast('This document is already being saved.');
    return null;
  }
  // Attach rejection handling immediately: a picker/sign-in may stay open while
  // font preparation finishes. The caller awaits this result before writing.
  const content = serializeDocumentSVGForSave(state, snapshot).then(
    value => ({ value, error: null }),
    (error: unknown) => ({ value: null, error }),
  );
  return { ...target, content: async () => {
    const result = await content;
    if (!result.value) throw result.error;
    return result.value;
  } };
}

// Parsing/importing runs synchronously and freezes the UI; above this size that
// stall is long enough (hundreds of ms to seconds) to need a loading overlay.
// Below it, opening is effectively instant and an overlay would only flash.
const HEAVY_DOC_BYTES = 1_000_000;

/**
 * Load a document string, showing a loading overlay first when the file is large
 * enough that the synchronous import would otherwise look like a frozen app.
 */
export async function loadDocumentStringWithFeedback(
  state: AppState, text: string, name: string,
): Promise<void> {
  if (text.length < HEAVY_DOC_BYTES) {
    loadDocumentString(state, text);
    return;
  }
  await withLoadingOverlay(`Opening ${name}…`, () => loadDocumentString(state, text));
}

// ---------------------------------------------------------------------------
// Save / Open (File System Access with download fallback)
// ---------------------------------------------------------------------------

export async function saveProject(state: AppState): Promise<void> {
  const save = beginDocumentSave(state);
  if (!save) return;
  try {
    const handle = save.source?.kind === 'local' ? save.source.handle : null;
    if (handle && await ensureWritePermission(handle)) {
      const { svg, warnings } = await save.content();
      if (!save.isOpen()) return;
      try {
        await writeHandle(handle, svg);
        save.complete(save.source, save.name);
        await rememberRecentFile(handle);
        if (warnings.length) showToast(warnings.join('\n'));
        return;
      } catch (err) {
        console.warn('Direct save failed, prompting for a new location:', err);
      }
    }
    if (save.isOpen()) await saveLocalAs(save);
  } finally { save.release(); }
}

export async function saveProjectAs(state: AppState): Promise<void> {
  const save = beginDocumentSave(state);
  if (!save) return;
  try { await saveLocalAs(save); }
  finally { save.release(); }
}

type PreparedSave = NonNullable<ReturnType<typeof beginDocumentSave>>;

async function saveLocalAs(save: PreparedSave): Promise<void> {
  const base = (save.name === 'Untitled' ? 'drawing' : save.name).replace(/\.svg$/i, '');
  if (supportsFileSystemAccess()) {
    try {
      // Start the native picker while the initiating gesture is still active.
      const handle = await saveFilePicker(`${base}${SVG_EXTENSION}`, PICKER_TYPES);
      if (!handle || !save.isOpen()) return;
      const { svg, warnings } = await save.content();
      if (!save.isOpen()) return;
      await writeHandle(handle, svg);
      save.complete({ kind: 'local', handle }, handle.name);
      await rememberRecentFile(handle);
      if (warnings.length) showToast(warnings.join('\n'));
    } catch (err) {
      alert('Failed to save: ' + (err instanceof Error ? err.message : String(err)));
    }
    return;
  }
  const { svg, warnings } = await save.content();
  if (!save.isOpen()) return;
  downloadFile(`${base}${SVG_EXTENSION}`, svg, SVG_MIME);
  save.complete(save.source, save.name, true);
  if (warnings.length) showToast(warnings.join('\n'));
}

async function pdfChoiceOrNull(): Promise<PdfImportChoice | null> {
  const { choosePdfImportDialog } = await import('./dialogs');
  return choosePdfImportDialog();
}

/**
 * Rasterize a PDF into an ALREADY-BLANK document (the caller opened a fresh tab,
 * so there's nothing to discard and no dialog here — the choice is passed in). A
 * single page fills the default frame; a multi-page PDF adds a frame per page, so
 * we drop the leftover blank default. A PDF isn't a writable BuzzQuill file, so
 * there's no handle to save back to.
 */
async function importPdfInto(state: AppState, file: File, choice: PdfImportChoice): Promise<void> {
  const defaultFrameId = state.artboards[0]?.id ?? null;
  const { runPdfImport } = await import('./import-pdf-vector');
  await runPdfImport(state, file, choice);
  if (defaultFrameId && state.artboards.length > 1) {
    state.removeShape(defaultFrameId); // page frames were added beside the empty default — remove it
  }
  adoptSource(null, file.name.replace(/\.pdf$/i, ''), true); // the PDF on disk re-imports to this
}

/** Build a prompt-free loader for a PDF from anywhere (a handle, a Drive download).
 *  Resolves the import choice up front; null if cancelled. */
export async function pendingFromPdfFile(file: File): Promise<PendingOpen | null> {
  const choice = await pdfChoiceOrNull();
  if (!choice) return null;
  return { name: file.name, load: (s) => importPdfInto(s, file, choice) };
}

/** Build a prompt-free loader for an already-obtained handle (Open dialog or
 *  Recent Files). Resolves the PDF import choice up front; null if cancelled. */
export async function pendingFromHandle(handle: FileSystemFileHandle): Promise<PendingOpen | null> {
  if (/\.pdf$/i.test(handle.name)) {
    const pending = await pendingFromPdfFile(await handle.getFile());
    if (!pending) return null;
    return { name: pending.name, load: async (state) => {
      await pending.load(state);
      await rememberRecentFile(handle);
    } };
  }
  return { name: handle.name, load: (s) => openHandle(s, handle) };
}

/**
 * Show the Open picker and resolve any load-time prompts, returning a prompt-free
 * {@link PendingOpen} — or null if the user cancelled. Never touches the current
 * document: the caller (DocumentManager) decides which tab to load it into, so
 * Open no longer needs a discard confirmation.
 */
export async function pickDocumentToOpen(): Promise<PendingOpen | null> {
  if (supportsFileSystemAccess()) {
    let handle: FileSystemFileHandle | null;
    try {
      handle = await openFilePicker([
        { description: 'SVG / PDF / BuzzQuill', accept: { [SVG_MIME]: [SVG_EXTENSION], 'application/pdf': ['.pdf'], 'application/json': [LEGACY_EXTENSION] } },
      ]);
    } catch (err) {
      alert('Failed to open: ' + (err instanceof Error ? err.message : String(err)));
      return null;
    }
    if (!handle) return null; // cancelled
    return pendingFromHandle(handle);
  }

  // Fallback: hidden file input (no writable handle available).
  const file = await pickFileViaInput(`${SVG_EXTENSION},${LEGACY_EXTENSION},.json,application/pdf,.pdf`);
  if (!file) return null;
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    const choice = await pdfChoiceOrNull();
    if (!choice) return null;
    return { name: file.name, load: (s) => importPdfInto(s, file, choice) };
  }
  return {
    name: file.name,
    load: async (s) => {
      const text = await readSvgFile(file);
      await loadDocumentStringWithFeedback(s, text, file.name);
      // Can't write back without FS Access — but the file it came from is on disk.
      adoptSource(null, file.name, true);
    },
  };
}

/** Promisified hidden `<input type=file>` for the no-FS-Access fallback. */
function pickFileViaInput(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    let settled = false;
    const done = (f: File | null) => { if (!settled) { settled = true; resolve(f); } };
    input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });
    input.click();
  });
}

/** Load document text that has no writable handle (e.g. a dropped file). */
export async function openTextWithoutHandle(state: AppState, text: string, name: string): Promise<void> {
  await loadDocumentStringWithFeedback(state, text, name);
  adoptSource(null, name, true); // the dropped file is still on disk
}

/** Open a document directly from a handle (used by Open and Recent Files). */
export async function openHandle(state: AppState, handle: FileSystemFileHandle): Promise<void> {
  const text = await readHandle(handle);
  await loadDocumentStringWithFeedback(state, text, handle.name);
  adoptSource({ kind: 'local', handle }, handle.name);
  await rememberRecentFile(handle);
}
