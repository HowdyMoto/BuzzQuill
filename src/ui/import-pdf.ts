import type { AppState } from '../core/state';
import { placeImageDataUrl, placeImageAt } from './import-image';
import { showToast } from './toast';
import { showLoadingOverlay, hideLoadingOverlay } from './loading-overlay';
// The worker ships as a same-origin bundled asset (Vite emits it); `?url` gives
// its served path without pulling the ~1MB engine into the main chunk.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/**
 * Import a PDF by rasterizing its pages (PDF.js, Apache-2.0). A single-page PDF is
 * embedded as one <image> on the active frame (like any raster import); a
 * multi-page PDF creates a frame per page, tiled to the right of existing content.
 * Editable-vector import is intentionally out of scope (see the plan) — this is a
 * faithful, resolution-independent-enough tracing/compositing template.
 */

const RENDER_SCALE = 2; // supersample so the embedded raster stays crisp when zoomed

export interface RenderedPage { url: string; w: number; h: number }

// pdf.js page/document types are loaded dynamically; keep this module lib-agnostic.
export async function renderPage(page: any, scale: number): Promise<RenderedPage> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  await page.render({ canvasContext: ctx, viewport }).promise;
  const pts = page.getViewport({ scale: 1 }); // page size in points (1pt = 1 user unit)
  return { url: canvas.toDataURL('image/png'), w: pts.width, h: pts.height };
}

/** World x just past the right edge of all existing frames (so pages tile beside them). */
function rightEdge(state: AppState): number {
  return state.artboards.reduce((m, a) => Math.max(m, a.x + a.width), 0);
}

export async function importPdfFile(state: AppState, file: File): Promise<void> {
  let doc: any;
  // Rendering a page is a long synchronous burst per page; without this the app
  // looks frozen for the whole (potentially multi-second) import.
  showLoadingOverlay(`Importing ${file.name}…`);
  try {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

    const data = new Uint8Array(await file.arrayBuffer());
    doc = await pdfjs.getDocument({ data }).promise;
    const n = doc.numPages as number;

    if (n === 1) {
      const { url } = await renderPage(await doc.getPage(1), RENDER_SCALE);
      placeImageDataUrl(state, url); // centered + fitted on the active frame
      return;
    }

    // Multi-page → a frame per page, laid out in a row beside existing content.
    const GAP = 40;
    let x = rightEdge(state);
    if (x > 0) x += GAP;
    for (let i = 1; i <= n; i++) {
      showLoadingOverlay(`Importing page ${i} of ${n}…`); // re-showing updates the label
      const { url, w, h } = await renderPage(await doc.getPage(i), RENDER_SCALE);
      const fid = state.addFrame(x, 0, w, h, `Page ${i}`);
      state.setFrameBackground(fid, '#FFFFFF', false); // a PDF page is white paper — back the frame so any transparent regions read white
      placeImageAt(state, url, x, 0, w, h); // fills the page frame; auto-parents into it
      x += w + GAP;
    }
    showToast(`Imported ${n} pages as frames.`, 8000, undefined, 'success');
  } catch (err) {
    showToast(`Couldn’t import PDF: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    hideLoadingOverlay();
    doc?.destroy?.();
  }
}
