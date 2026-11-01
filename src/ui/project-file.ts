import type { AppState } from '../core/state';
import type { Artboard, ShapeStyle } from '../core/types';
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
import { escapeHtml } from './dom';
import { SVG_NS_DECLS, ensureSvgNamespaces } from '../core/svg-ns';
import { buildEmbeddedFontStyle, embeddedFontFaceStyle } from '../core/text-outline';
import { setDocSource, type DocSource } from '../core/doc-source';
import { captureSaveTarget } from '../core/document-save';

const FORMAT_VERSION = 1;
const SVG_EXTENSION = '.svg';
const SVG_MIME = 'image/svg+xml';
const LEGACY_EXTENSION = '.svgmaker';

const PICKER_TYPES: FilePickerType[] = [
  { description: 'SVG Image', accept: { [SVG_MIME]: [SVG_EXTENSION] } },
];

/** The active document's name (null = unnamed → shown as "Untitled"). This is the
 *  single source of truth for the current document name; the tab bar renders it as
 *  the active tab's title, so it is NOT also shown in the menu bar. DocumentManager
 *  swaps it on tab switch. Formerly stored as the #project-name element's text. */
let projectName: string | null = null;

/** Change what the active document IS — its source (see core/doc-source.ts), whether
 *  an unwritable copy sits on disk, and what it is called — in one step. The single
 *  funnel for every open/save/import path, so the three can never disagree. */
export function adoptSource(source: DocSource, name: string | null, onDisk = false): void {
  setDocSource(source);
  diskCopy = onDisk;
  setProjectName(name);
}

/** The active document's local handle, if its source is a local file. */


/** The active document came from — or was last saved as — a file the editor holds no
 *  writable handle for: opened through the plain file input (browsers without File
 *  System Access), dropped onto the window, imported from a PDF, or saved by
 *  download. While it's clean, that file IS its content, so closing it loses
 *  nothing — without this the close guard treated it as homeless work and warned
 *  "unsaved changes will be lost" over a document nobody had touched. Per-tab, like
 *  the source; adopting a real source replaces it. */
let diskCopy = false;
export function hasDiskCopy(): boolean { return diskCopy; }
export function setDiskCopy(on: boolean): void { diskCopy = on; }

/** Set the active document's name (null = unnamed). Updates the browser tab title;
 *  the document tab bar reflects it as the active tab's label (via DocumentManager). */
export function setProjectName(name: string | null): void {
  projectName = name;
  document.title = `${name ?? 'Untitled'} — BuzzQuill`;
}

/** The active document's display name ('Untitled' when unnamed). The single source
 *  of truth for the current name — read this instead of any DOM element. */
export function getProjectName(): string {
  return projectName ?? 'Untitled';
}

/**
 * Guard before any action that replaces the current document. Returns true if
 * it's safe to proceed (no unsaved changes, or the user chose to discard them).
 */
export function confirmDiscard(state: AppState): boolean {
  return !state.dirty || window.confirm('You have unsaved changes that will be lost. Continue?');
}

// ---------------------------------------------------------------------------
// Editor metadata embedded inside the saved SVG (ignored by other tools).
// ---------------------------------------------------------------------------

interface SerializedShape {
  id: string;
  type: string;
  name: string;
  style: ShapeStyle;
  visible: boolean;
  locked: boolean;
}

// 'SVGMaker' is the pre-rename identifier — still accepted on read so existing
// files keep opening; new files are written as 'BuzzQuill'.
type AppId = 'BuzzQuill' | 'SVGMaker';
const APP_ID: AppId = 'BuzzQuill';
const isKnownApp = (v: unknown): boolean => v === 'BuzzQuill' || v === 'SVGMaker';

interface DocMeta {
  app: AppId;
  version: number;
  artboards: Artboard[];
  activeFrameId: string | null;
  shapes: SerializedShape[];
  canvasBg?: string | null;
}

function buildMeta(state: AppState): DocMeta {
  return {
    app: APP_ID,
    version: FORMAT_VERSION,
    artboards: state.artboards.map(ab => ({ ...ab })),
    activeFrameId: state.activeFrameId,
    shapes: state.shapes.map(s => ({
      id: s.id, type: s.type, name: s.name,
      style: { ...s.style }, visible: s.visible, locked: s.locked,
    })),
    // defaultStyle / fillNone / strokeNone are intentionally NOT persisted. New shapes
    // always use the fixed default (makeDefaultStyle); persisting the default was why
    // "everything is 74.5px" survived reloads and new documents.
    canvasBg: state.canvasBackground,
  };
}


/** Bounding box that encloses every artboard, used as the SVG viewport. */
function unionArtboardBounds(state: AppState): { x: number; y: number; w: number; h: number } {
  if (state.artboards.length === 0) return { x: 0, y: 0, w: 960, h: 540 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ab of state.artboards) {
    minX = Math.min(minX, ab.x);
    minY = Math.min(minY, ab.y);
    maxX = Math.max(maxX, ab.x + ab.width);
    maxY = Math.max(maxY, ab.y + ab.height);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Serialize the document to a standard SVG. Editor-only state (artboards,
 * lock flags, default styles) is stored in a <metadata> block so the file
 * round-trips losslessly while remaining a valid SVG that renders anywhere.
 */
export function serializeDocumentSVG(state: AppState): string {
  const b = unionArtboardBounds(state);
  const metaJson = escapeHtml(JSON.stringify(buildMeta(state)));

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" ${SVG_NS_DECLS}${state.getExtraNamespaceDecls()} viewBox="${b.x} ${b.y} ${b.w} ${b.h}" width="${b.w}" height="${b.h}">
<metadata class="svgmaker-state">${metaJson}</metadata>
${state.getDefsBlock()}<g class="svgmaker-doc">${state.getDrawingLayerSVG()}</g>
</svg>`;
}

/**
 * Serialize for a FILE SAVE: {@link serializeDocumentSVG} plus the used fonts embedded
 * as `@font-face` (data-URLs). Without this a saved .svg only carries `font-family`
 * NAMES, so a viewer that lacks the font (or the browser rendering it standalone) falls
 * back to a serif — the fonts are only "present" while BuzzQuill has them loaded.
 *
 * The `<style>` is placed directly under `<svg>`, NOT inside `<defs>`: viewers apply it
 * document-wide, but our loader only imports `<defs>` + the drawing group, so it's
 * ignored on reopen (no round-trip accumulation). Re-derived fresh on every save.
 */
export async function serializeDocumentSVGForSave(state: AppState, base = serializeDocumentSVG(state)): Promise<{ svg: string; warnings: string[] }> {
  const markup = state.getDrawingLayerSVG();
  const docFaces = embeddedFontFaceStyle(state.embeddedFonts, markup); // e.g. PDF-import fonts
  const bundled = await buildEmbeddedFontStyle(markup);                 // bundled families in use
  const style = [docFaces, bundled.style].filter(Boolean).join('\n');
  const svg = style ? base.replace('</metadata>', `</metadata>\n${style}`) : base;
  return { svg, warnings: bundled.warnings };
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

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Re-apply names/visibility/lock/style that don't fully live in the markup. */
function applyShapeMeta(state: AppState, shapes: SerializedShape[]): void {
  for (const saved of shapes) {
    const shape = state.findShapeById(saved.id);
    if (!shape) continue;
    shape.name = saved.name;
    shape.style = { ...saved.style };
    shape.visible = saved.visible;
    shape.locked = saved.locked;
    if (!saved.visible) (shape.element as SVGElement).style.display = 'none';
    if (saved.locked) shape.element.setAttribute('data-locked', 'true');
  }
}

/** Load a document from an SVG string (ours, with metadata, or a foreign SVG). */
export function loadDocumentSVG(state: AppState, svgString: string): void {
  const doc = new DOMParser().parseFromString(ensureSvgNamespaces(svgString), 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  if (!svgEl) throw new Error('File is not a valid SVG.');

  // A point edit left open would point at a shape in the document being replaced.
  state.exitPathEdit();

  // Look for our embedded editor metadata.
  let meta: DocMeta | null = null;
  const metaEl = svgEl.querySelector('metadata.svgmaker-state') ?? svgEl.querySelector('metadata');
  if (metaEl?.textContent) {
    try {
      const parsed = JSON.parse(metaEl.textContent.trim());
      if (parsed && isKnownApp(parsed.app)) meta = parsed as DocMeta;
    } catch { /* not our metadata — treat as a foreign SVG */ }
  }

  if (meta) {
    // ---- Our document: restore everything ----
    if (meta.version > FORMAT_VERSION) {
      throw new Error(`This file was made with a newer BuzzQuill (v${meta.version}). Please update.`);
    }

    state.clearDefs();
    state.importDefsFrom(svgEl);

    // Drawing content lives inside <g class="svgmaker-doc">.
    const body = svgEl.querySelector('g.svgmaker-doc');
    const serializer = new XMLSerializer();
    let markup = '';
    if (body) {
      for (const child of Array.from(body.children)) markup += serializer.serializeToString(child);
    }
    state.importSVGMarkup(markup);

    if (meta.shapes) applyShapeMeta(state, meta.shapes);
    // defaultStyle / fillNone / strokeNone are NOT restored — new shapes always use the
    // fixed default. Old files may still carry them in the metadata; we ignore them.
    state.canvasBackground = meta.canvasBg ?? null;
    state.applyCanvasBackground();

    // Current-format docs already contain frame elements (migrate is a no-op).
    // Legacy docs carry only `meta.artboards`; wrap their content into frames.
    const boards = meta.artboards?.length
      ? meta.artboards.map(a => ({ x: a.x, y: a.y, width: a.width, height: a.height, name: a.name }))
      : [{ x: 0, y: 0, width: 960, height: 540, name: 'Frame 1' }];
    state.migrateContentToFrames(boards);
    state.activeFrameId =
      (meta.activeFrameId && state.getArtboardById(meta.activeFrameId))
        ? meta.activeFrameId
        : (state.artboards[0]?.id ?? null);
  } else {
    // ---- Foreign SVG: import shapes and wrap them in a single frame ----
    state.clearDefs();
    state.importSVGContent(svgString);

    // The imported content lives in the viewBox coordinate system, so the frame
    // must match the viewBox — not width/height, which are the display size and
    // may be in physical units (mm/cm/in) or % that parseFloat would misread.
    const vb = svgEl.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
      .filter(n => Number.isFinite(n));
    const hasVb = vb?.length === 4 && vb[2] > 0 && vb[3] > 0;
    const w = (hasVb ? vb![2] : parseFloat(svgEl.getAttribute('width') ?? '')) || 960;
    const h = (hasVb ? vb![3] : parseFloat(svgEl.getAttribute('height') ?? '')) || 540;
    const x = hasVb ? vb![0] : 0;
    const y = hasVb ? vb![1] : 0;
    state.migrateContentToFrames([{ x, y, width: w, height: h, name: 'Frame 1' }]);
    state.activeFrameId = state.artboards[0]?.id ?? null;
    state.canvasBackground = null; // foreign SVGs carry no BuzzQuill background
    state.applyCanvasBackground();
  }

  state.selectedFrameId = null;
  state.saveHistory();
  state.markClean();
  state.onChange_public();

  if (!meta && state.lastImportHadAnimation) {
    showToast('This SVG used SMIL animation, which BuzzQuill doesn’t support yet. The static image was imported — saving won’t include the animation.');
  }
}

/** Dispatch on file contents: legacy .svgmaker JSON vs. SVG. */
export function loadDocumentString(state: AppState, text: string): void {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    loadProject(state, text); // legacy .svgmaker project
  } else {
    loadDocumentSVG(state, text);
  }
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
        showToast(`Saved “${handle.name}”.`, 4000, undefined, 'success');
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
      showToast(`Saved “${handle.name}”.`, 4000, undefined, 'success');
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

/**
 * A picked document ready to load, with any load-time prompts (the PDF import
 * dialog) already resolved — so a caller can create a fresh tab and populate it
 * via {@link PendingOpen.load} with no risk of a late cancel leaving an empty tab.
 */
export interface PendingOpen {
  /** File name, used to title a freshly-created tab before content loads. */
  name: string;
  /** Load the picked document into `state` (no further prompts). */
  load: (state: AppState) => Promise<void>;
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
  if (/\.pdf$/i.test(handle.name)) return pendingFromPdfFile(await handle.getFile());
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

// ---------------------------------------------------------------------------
// Legacy .svgmaker (JSON) loading — open-only, for backward compatibility.
// ---------------------------------------------------------------------------

interface ProjectFile {
  version: number;
  app: AppId;
  artboards: Artboard[];
  activeFrameId: string | null;
  shapes: SerializedShape[];
  svgContent: string;
}

export function loadProject(state: AppState, json: string): void {
  const project = JSON.parse(json) as ProjectFile;
  if (!isKnownApp(project.app)) throw new Error('Not a valid BuzzQuill file.');
  if (!project.version || project.version > FORMAT_VERSION) {
    throw new Error(`File version ${project.version} is newer than this version of BuzzQuill supports.`);
  }

  if (project.artboards?.length) {
    state.artboards.length = 0;
    for (const ab of project.artboards) state.artboards.push({ ...ab });
    state.activeFrameId = project.activeFrameId ?? state.artboards[0].id;
  }

  state.importSVGMarkup(project.svgContent);
  if (project.shapes) applyShapeMeta(state, project.shapes);
  // defaultStyle / fillNone / strokeNone intentionally not restored (fixed defaults).

  state.selectedFrameId = null;
  state.saveHistory();
  state.markClean();
  state.onChange_public();
}
