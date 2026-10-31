import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SVG import / round-trip fidelity tests against a corpus of large, real-world
 * SVGs (Wikimedia Commons maps, coats of arms, matplotlib figures). The corpus
 * is not committed — run `npm run corpus:fetch` first.
 *
 * Each file must, when opened the way the app opens a foreign SVG
 * (state.importSVGContent):
 *   1. import without throwing or logging a page error;
 *   2. lose no *rendering* element (metadata/foreignObject excepted — see below);
 *   3. round-trip: serialize → re-parse as valid XML;
 *   4. preserve arbitrary edits across that serialize;
 *   5. render non-blank (non-empty bounding box);
 *   6. keep every <image> source and <use> reference that worked in the source.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'test/corpus/corpus.json'), 'utf8')) as {
  destDir: string;
  files: { file: string; bytes: number; notes: string }[];
};

// Rendering tags whose count must never shrink on import. (>= because the editor's
// own grid/transparency chrome adds <pattern>/<rect> to the shared <defs>.)
const RENDER_TAGS = [
  'path', 'use', 'g', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'image', 'symbol', 'clippath', 'mask', 'filter', 'pattern',
  'lineargradient', 'radialgradient', 'marker', 'switch', 'style',
];

type Metrics = Awaited<ReturnType<typeof importAndMeasure>>;

// Runs in the browser via page.evaluate. Imports the SVG through the real app
// state and measures fidelity from both the source and the live DOM.
function importAndMeasure(args: { txt: string; tags: string[] }) {
  const { txt, tags } = args;
  const state = (window as unknown as { state: { importSVGContent: (s: string) => void; getDefsBlock: () => string; getDrawingLayerSVG: () => string; getExtraNamespaceDecls: () => string } }).state;

  const lc = (e: Element) => e.tagName.toLowerCase();
  const censusOf = (root: ParentNode) => {
    const c: Record<string, number> = {};
    root.querySelectorAll('*').forEach(e => { const t = lc(e); if (tags.includes(t)) c[t] = (c[t] || 0) + 1; });
    return c;
  };
  const hrefOf = (e: Element) => e.getAttribute('href') || e.getAttribute('xlink:href') || '';
  const usableHref = (h: string) => h.startsWith('data:') || h.startsWith('#');
  const refResolves = (doc: Document, e: Element) => {
    const h = hrefOf(e);
    return h.startsWith('#') ? !!doc.getElementById(h.slice(1)) : false;
  };

  // --- source ---
  const srcDoc = new DOMParser().parseFromString(txt, 'image/svg+xml');
  if (srcDoc.querySelector('parsererror')) return { sourceParseError: true } as const;
  const srcCensus = censusOf(srcDoc);
  const srcImagesWithHref = [...srcDoc.querySelectorAll('image')].filter(i => usableHref(hrefOf(i))).length;
  const srcUsesResolved = [...srcDoc.querySelectorAll('use')].filter(u => refResolves(srcDoc, u)).length;

  // --- import ---
  let importError: string | null = null;
  const t0 = performance.now();
  try { state.importSVGContent(txt); } catch (e) { importError = String((e as Error).message); }
  const importMs = Math.round(performance.now() - t0);

  const layer = document.getElementById('drawing-layer')!;
  const defs = document.querySelector('#svg-canvas defs')!;
  const after = censusOf(layer);
  const afterDefs = censusOf(defs);
  for (const k in afterDefs) after[k] = (after[k] || 0) + afterDefs[k];

  // Count across the whole canvas (drawing layer + <defs>): images/uses can live
  // inside masks, patterns or symbols, not just the drawing layer.
  const canvas = document.getElementById('svg-canvas')!;
  const afterImagesWithHref = [...canvas.querySelectorAll('image')].filter(i => usableHref(hrefOf(i))).length;
  const afterUsesResolved = [...canvas.querySelectorAll('use')].filter(u => refResolves(document, u)).length;

  // --- render sanity ---
  let bbox = { w: 0, h: 0 };
  try { const b = (layer as unknown as SVGGraphicsElement).getBBox(); bbox = { w: b.width, h: b.height }; } catch { /* ignore */ }

  // --- edit every element, then serialize + re-parse (the "save" path) ---
  const all = layer.querySelectorAll('*');
  all.forEach(e => e.setAttribute('data-edit-probe', '1'));
  const stamped = all.length;

  const body = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" `
    + `xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" `
    + `xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd"`
    + `${state.getExtraNamespaceDecls()}>${state.getDefsBlock()}${state.getDrawingLayerSVG()}</svg>`;
  const rt = new DOMParser().parseFromString(body, 'image/svg+xml');
  const reparseError = rt.querySelector('parsererror')?.textContent?.slice(0, 200) ?? null;
  const editsSurvived = rt.querySelectorAll('[data-edit-probe]').length;

  return {
    sourceParseError: false,
    importError, importMs,
    srcCensus, after,
    srcImagesWithHref, afterImagesWithHref,
    srcUsesResolved, afterUsesResolved,
    bbox, stamped, reparseError, editsSurvived,
  } as const;
}

for (const entry of manifest.files) {
  const path = join(ROOT, manifest.destDir, entry.file);

  test(`${entry.file} — ${(entry.bytes / 1e6).toFixed(0)}MB`, async ({ page }) => {
    test.skip(!existsSync(path), `Corpus file missing — run \`npm run corpus:fetch\`.`);
    test.info().annotations.push({ type: 'svg', description: entry.notes });

    const pageErrors: string[] = [];
    page.on('pageerror', e => pageErrors.push(e.message));

    await page.goto('/');
    await page.waitForFunction(() => (window as unknown as { state?: unknown }).state, { timeout: 15_000 });

    const txt = readFileSync(path, 'utf8');
    const m = (await page.evaluate(importAndMeasure, { txt, tags: RENDER_TAGS })) as Metrics;

    expect(m.sourceParseError, 'source is valid SVG').toBe(false);

    // 1. imports cleanly
    expect(m.importError, 'importSVGContent threw').toBeNull();
    expect(pageErrors, 'no uncaught page errors during import').toEqual([]);

    // 2. no rendering element dropped (foreignObject is intentionally stripped
    //    for security and excluded from RENDER_TAGS).
    for (const tag of Object.keys(m.srcCensus)) {
      expect(m.after[tag] ?? 0, `lost <${tag}> elements on import`).toBeGreaterThanOrEqual(m.srcCensus[tag]);
    }

    // 3. round-trips to valid XML
    expect(m.reparseError, 'serialized SVG re-parsed with an XML error').toBeNull();

    // 4. arbitrary edits survive the serialize
    expect(m.editsSurvived, 'edits did not survive serialize→reparse').toBe(m.stamped);

    // 5. renders non-blank
    expect(m.bbox.w, 'imported content has zero width').toBeGreaterThan(0);
    expect(m.bbox.h, 'imported content has zero height').toBeGreaterThan(0);

    // 6. every working <image> source and <use> reference is preserved
    expect(m.afterImagesWithHref, 'lost <image> sources (stripped hrefs)').toBeGreaterThanOrEqual(m.srcImagesWithHref);
    expect(m.afterUsesResolved, 'broke <use> references').toBeGreaterThanOrEqual(m.srcUsesResolved);
  });
}
