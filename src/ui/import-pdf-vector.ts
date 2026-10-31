import type { AppState } from '../core/state';
import type { PdfImportChoice } from './dialogs';
import { sanitizeSvgElement } from '../core/svg-sanitize';
import { extractPageVectors } from '../core/pdf-vector';
import { renderPage, importPdfFile } from './import-pdf';
import { placeImageAt } from './import-image';
import { outlineText } from '../core/text-outline';
import { showToast } from './toast';
import { showLoadingOverlay, hideLoadingOverlay } from './loading-overlay';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/**
 * Import a PDF as EDITABLE objects (paths, images, text) rather than a flat raster.
 * Each page becomes a frame; its content is decomposed into individually selectable
 * layers. A page that uses features we can't vectorize (gradients/shadings, tiling
 * patterns, soft masks) is rasterized instead, so nothing silently goes missing.
 * Text mode: 'live' keeps re-typeable <text>; 'outline' converts glyphs to paths.
 */

export type PdfTextMode = 'live' | 'outline';

const RASTER_FALLBACK_SCALE = 2;

// PDF.js reports generic CSS families; map them to bundled fonts so live text
// renders consistently and outlineText can resolve real glyph outlines.
const GENERIC_FONT: Record<string, string> = {
  'sans-serif': 'Inter',
  serif: 'PT Serif',
  monospace: 'Roboto Mono',
};

function mapFonts(markup: string): string {
  return markup.replace(/font-family="([^"]*)"/g, (whole, fam: string) => {
    const mapped = GENERIC_FONT[fam.replace(/['"]/g, '').toLowerCase()];
    return mapped ? `font-family="${mapped}"` : whole;
  });
}

/** Parse an SVG markup fragment into elements adopted into the live document. */
function parseSvgElements(markup: string): SVGElement[] {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return [];
  // Sanitize before adopting into the live DOM. Every other markup entry point
  // runs the sanitizer; this vector-PDF path was the lone gap. The markup is
  // machine-generated, but a crafted font name / embedded string could smuggle
  // an unsafe attribute, and "nothing unsanitized enters the tree" is an
  // invariant worth holding uniformly. Sanitizing the wrapper also drops any
  // blocked top-level element (matches sanitizeSvgMarkup).
  sanitizeSvgElement(doc.documentElement);
  return Array.from(doc.documentElement.children)
    .map((c) => document.importNode(c, true) as SVGElement);
}

/** World x just past the right edge of all existing frames (so pages tile beside them). */
function rightEdge(state: AppState): number {
  return state.artboards.reduce((m, a) => Math.max(m, a.x + a.width), 0);
}

export async function importPdfAsVectors(state: AppState, file: File, textMode: PdfTextMode): Promise<void> {
  let doc: any;
  let rasterPages = 0;
  // Vectorizing a page (glyph outlining especially) blocks the main thread for a
  // while per page; without this the app looks frozen for the whole import.
  showLoadingOverlay(`Importing ${file.name}…`);
  try {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

    const data = new Uint8Array(await file.arrayBuffer());
    // fontExtraProperties keeps the reconstructed font PROGRAM on each font object
    // (font.data) so we can embed the real typeface — see extractPageVectors.
    doc = await pdfjs.getDocument({ data, fontExtraProperties: true }).promise;
    const n = doc.numPages as number;
    const GAP = 40;
    let x = rightEdge(state);
    if (x > 0) x += GAP;

    for (let i = 1; i <= n; i++) {
      showLoadingOverlay(`Importing page ${i} of ${n}…`); // re-showing updates the label
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const w = vp.width, h = vp.height;
      const res = await extractPageVectors(page, { includeText: true });
      const frameId = state.addFrame(x, 0, w, h, `Page ${i}`);
      state.setFrameBackground(frameId, '#FFFFFF', false); // PDF page = white paper behind the (often transparent) vector content

      if (!res.confident || res.elements.length === 0) {
        // Page needs features we can't vectorize → rasterize it (still faithful).
        const { url } = await renderPage(page, RASTER_FALLBACK_SCALE);
        placeImageAt(state, url, x, 0, w, h);
        rasterPages++;
      } else {
        // Register the page's real embedded fonts so text runs referencing their
        // ids render in the actual typeface (not a substitute). Live text only —
        // outline mode bakes glyphs to paths and needs no font.
        if (textMode === 'live') for (const f of res.fonts) state.addEmbeddedFont(f);
        let markup = mapFonts(res.elements.join('\n'));
        if (textMode === 'outline') markup = (await outlineText(markup)).content;
        const els = parseSvgElements(markup);
        if (els.length) state.addElementsToFrame(frameId, els);
      }
      x += w + GAP;
    }

    const msg = n > 1 ? `Imported ${n} pages as editable objects.` : 'Imported PDF as editable objects.';
    // A clean vector import is an unambiguous success; a raster fallback is a
    // fidelity caveat, so it keeps the warning icon.
    showToast(rasterPages > 0
      ? `${msg} ${rasterPages} page${rasterPages > 1 ? 's' : ''} with gradients/patterns were kept as images for fidelity.`
      : msg,
      8000, undefined, rasterPages > 0 ? 'warning' : 'success');
  } catch (err) {
    showToast(`Couldn’t import PDF: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    hideLoadingOverlay();
    doc?.destroy?.();
  }
}

/** Route a chosen PDF import to raster or editable-vector, per the dialog result. */
export async function runPdfImport(state: AppState, file: File, choice: PdfImportChoice): Promise<void> {
  if (choice.mode === 'raster') await importPdfFile(state, file);
  else await importPdfAsVectors(state, file, choice.text);
}

/** Ask how to import a PDF, then do it (import into the current document). No-op if
 *  the user cancels. Used by Append and drag-drop; Open drives the two steps itself
 *  so it can reset the document only after a choice is made. */
export async function promptAndImportPdf(state: AppState, file: File): Promise<void> {
  const { choosePdfImportDialog } = await import('./dialogs');
  const choice = await choosePdfImportDialog();
  if (choice) await runPdfImport(state, file, choice);
}
