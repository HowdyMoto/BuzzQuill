import type { AppState } from '../core/state';
import type { Point } from '../core/types';
import { readSvgFile } from '../core/file-access';
import { withLoadingOverlay } from './loading-overlay';
import { showToast } from './toast';

/**
 * Append an image of ANY supported type — vector (SVG) or raster (PNG/JPG/GIF/WebP).
 * An SVG is imported as editable shapes; a raster is embedded as an <image> (a handy
 * tracing template — position/scale it, lock it, then draw over it).
 */

const NS = 'http://www.w3.org/2000/svg';

/** Open one file picker that accepts every supported image type and import it,
 *  routing SVGs to the vector importer and everything else to the raster embed. */
export function pickAndImportAny(state: AppState): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/pdf,.pdf,image/svg+xml,.svg,image/png,image/jpeg,image/gif,image/webp';
  input.style.display = 'none';
  document.body.appendChild(input);

  const cleanup = () => input.remove();
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) importAnyFile(state, file).catch((err) => showToast(`Couldn’t import “${file.name}”: ${errText(err)}`));
    cleanup();
  });
  input.addEventListener('cancel', cleanup);
  input.click();
}

/** A thrown value as a short human string for a toast. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Dispatch a chosen file by type: PDF → page render; SVG → vector import; else raster embed.
 *  Exported because drag-and-drop (ui/file-drop.ts) must append a dropped file by
 *  exactly the same rules as File ▸ Append — one dispatcher, not two. */
export async function importAnyFile(state: AppState, file: File, at?: Point): Promise<void> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    const { promptAndImportPdf } = await import('./import-pdf-vector'); // lazy — keeps pdf.js out of the main bundle
    await promptAndImportPdf(state, file);
    return;
  }
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  if (!isSvg) { importImageFile(state, file, at); return; }

  const text = await readSvgFile(file);
  // APPEND, never replace: this is the File ▸ Append / drag-onto-canvas path, and
  // importSVGContent wipes the drawing layer (right for opening a document, and a
  // silent data-loss bug here).
  const name = frameNameForFile(file.name);
  const append = () => {
    if (!state.appendSVGContent(text, name, at)) showToast(`Nothing to import from “${file.name}”.`);
  };
  if (text.length < 1_000_000) append();
  else await withLoadingOverlay(`Importing ${file.name}…`, append);
  if (state.lastImportHadAnimation) {
    showToast('This SVG used SMIL animation, which BuzzQuill doesn’t support yet. The static image was imported — saving won’t include the animation.');
  }
}

/** Read a File and embed it as an <image>. */
export function importImageFile(state: AppState, file: File, at?: Point): void {
  const reader = new FileReader();
  reader.onload = () => placeImageDataUrl(state, reader.result as string, at);
  reader.readAsDataURL(file);
}

/** "Append as New Frame": import a file into a brand-new frame sized to the
 *  file's OWN bounds (not scaled to fit an existing artboard), appended to the
 *  right of the current frames. A raster becomes an <image> filling a
 *  pixel-exact frame; a PDF routes to the per-page frame importer, which already
 *  makes one page-sized frame per page. */
export function pickAndImportAsFrame(state: AppState): void {
  const input = document.createElement('input');
  input.type = 'file';
  // Raster + PDF only. Editable-vector SVG into a sized frame needs a
  // non-destructive vector import (importSVGContent replaces the document) — a
  // separate follow-up — so SVG is intentionally left out of this picker.
  input.accept = 'application/pdf,.pdf,image/png,image/jpeg,image/gif,image/webp';
  input.style.display = 'none';
  document.body.appendChild(input);

  const cleanup = () => input.remove();
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) importFileAsFrame(state, file).catch((err) => showToast(`Couldn’t import “${file.name}”: ${errText(err)}`));
    cleanup();
  });
  input.addEventListener('cancel', cleanup);
  input.click();
}

async function importFileAsFrame(state: AppState, file: File): Promise<void> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    const { promptAndImportPdf } = await import('./import-pdf-vector'); // lazy — keeps pdf.js out of the main bundle
    await promptAndImportPdf(state, file); // already one page-sized frame per page
    return;
  }
  const reader = new FileReader();
  reader.onload = () => placeImageAsNewFrame(state, reader.result as string, frameNameForFile(file.name));
  reader.onerror = () => showToast('Could not read that file.');
  reader.readAsDataURL(file);
}

/** File name without its extension, as the frame's name (falls back to "Frame"). */
function frameNameForFile(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, '').trim() || 'Frame';
}

/** World x just past the right edge of every existing frame, so a new frame tiles
 *  beside them (0 when there are no frames yet). */
function framesRightEdge(state: AppState): number {
  return state.artboards.reduce((m, a) => Math.max(m, a.x + a.width), 0);
}

/** Embed a data: URL as an <image> filling a NEW frame sized to the image's own
 *  natural pixel dimensions, appended to the right of the current frames, then
 *  select and reveal that frame. */
export function placeImageAsNewFrame(state: AppState, dataUrl: string, name: string): void {
  const probe = new Image();
  probe.onload = () => {
    const w = Math.max(1, Math.round(probe.naturalWidth));
    const h = Math.max(1, Math.round(probe.naturalHeight));
    if (w <= 1 || h <= 1) { showToast('Could not read the image’s dimensions.'); return; }
    const GAP = 40;
    const edge = framesRightEdge(state);
    const x = edge > 0 ? edge + GAP : 0;
    const frameId = state.addFrame(x, 0, w, h, name); // frame sized to the image
    placeImageAt(state, dataUrl, x, 0, w, h);          // fills it; auto-parents into it
    state.selectShape(frameId);
    state.revealShape(frameId);
  };
  probe.onerror = () => showToast('Could not load that image.');
  probe.src = dataUrl;
}

/** Embed a data: URL as a centered <image> shape on the active artboard. */
export function placeImageDataUrl(state: AppState, dataUrl: string, at?: Point): void {
  const probe = new Image();
  probe.onload = () => {
    const el = document.createElementNS(NS, 'image') as SVGImageElement;
    const id = state.nextId();
    el.id = id;
    const name = `image ${id.replace('shape-', '#')}`;
    el.setAttribute('data-name', name);

    const ab = state.getActiveArtboard();
    let w = probe.naturalWidth;
    let h = probe.naturalHeight;

    // Scale down to fit the artboard while preserving aspect ratio.
    const maxW = ab.width * 0.9;
    const maxH = ab.height * 0.9;
    if (w > maxW || h > maxH) {
      const scale = Math.min(maxW / w, maxH / h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }

    // Centre on the drop point when there is one, else on the active frame.
    const cx = at ? at.x : ab.x + ab.width / 2;
    const cy = at ? at.y : ab.y + ab.height / 2;
    el.setAttribute('x', String(cx - w / 2));
    el.setAttribute('y', String(cy - h / 2));
    el.setAttribute('width', String(w));
    el.setAttribute('height', String(h));
    el.setAttribute('href', dataUrl);
    el.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    state.addShape({
      id,
      type: 'image',
      element: el,
      name,
      style: { fill: 'none', stroke: 'none', strokeWidth: 0, opacity: 1 },
      visible: true,
      locked: false,
    }, at);
  };
  probe.src = dataUrl;
}

/** Embed a data: URL as an <image> at an exact WORLD rect (x,y,w,h). addShape
 *  auto-parents it into the frame under that rect — used to fill a page-sized
 *  frame when importing a multi-page PDF. */
export function placeImageAt(state: AppState, dataUrl: string, x: number, y: number, w: number, h: number): void {
  const el = document.createElementNS(NS, 'image') as SVGImageElement;
  const id = state.nextId();
  el.id = id;
  const name = `image ${id.replace('shape-', '#')}`;
  el.setAttribute('data-name', name);
  el.setAttribute('x', String(x));
  el.setAttribute('y', String(y));
  el.setAttribute('width', String(w));
  el.setAttribute('height', String(h));
  el.setAttribute('href', dataUrl);
  el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  state.addShape({
    id, type: 'image', element: el, name,
    style: { fill: 'none', stroke: 'none', strokeWidth: 0, opacity: 1 },
    visible: true, locked: false,
  });
}
