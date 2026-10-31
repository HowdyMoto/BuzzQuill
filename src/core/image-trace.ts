// ---------------------------------------------------------------------------
// Image Trace — turn a raster image into editable vector paths.
//
// The tracing itself is imagetracerjs (public domain, pure JS): colour-quantize
// the bitmap into N layers, walk each layer's edges, then fit line and quadratic
// segments to the contours. Two constraints picked it over the alternatives:
// potrace and its WASM builds are GPL-2.0, and the app's CSP is `script-src
// 'self'` with no `wasm-unsafe-eval`, so a WASM tracer wouldn't load at all.
//
// This module owns everything around that call: getting the right PIXELS out of
// a shape (a plain <image>, or the nested `<svg data-crop>` a cropped one
// becomes), and turning the trace result back into document geometry positioned
// exactly over the source. The UI lives in ui/trace-dialog.ts.
// ---------------------------------------------------------------------------

import ImageTracer from 'imagetracerjs';

const SVG = 'http://www.w3.org/2000/svg';

/**
 * Longest edge the tracer ever sees. Detail beyond this is noise the contour
 * fitter turns into path count, not fidelity: a 1000px photo at 16 colours
 * already yields ~3,800 paths and ~0.5s. Capping keeps the command interactive
 * and the document sane, and the source bitmap is untouched either way.
 */
export const MAX_TRACE_PX = 1000;

/** Preview traces run smaller still — it only has to read true at thumbnail size. */
export const PREVIEW_TRACE_PX = 320;

export type TraceMode = 'silhouette' | 'lineart' | 'color';

export interface TraceOptions {
  mode: TraceMode;
  /** Colour mode only: how many colours to quantize to (2–32). */
  colors: number;
  /** 0 = most faithful (more, smaller paths) … 100 = smoothest (fewer). */
  detail: number;
  /**
   * Drop paths shorter than this. The single most valuable knob: colour
   * quantization can land on an unlucky palette that splits an anti-aliased edge
   * into near-duplicate shades (#e8892b *and* #e8892c), and each fringe becomes a
   * sliver path — one flat three-colour logo traced to 236 paths instead of 6.
   * Discarding the slivers collapses it back. (A pre-blur was tried first and made
   * it WORSE: blurring invents more intermediate shades to quantize.)
   */
  despeckle: number;
}

export const DEFAULT_TRACE_OPTIONS: TraceOptions = {
  mode: 'color', colors: 8, detail: 40, despeckle: 20,
};

export interface TracedPath { d: string; fill: string }

export interface TraceResult {
  paths: TracedPath[];
  /** Pixel dimensions the paths are expressed in (the traced raster's size). */
  pixelW: number;
  pixelH: number;
}

/** Why a shape can't be traced, in words the user can act on. */
export class TraceError extends Error {}

/**
 * The `<image>` behind a shape, plus the source rectangle (in BITMAP pixels) and
 * the destination box (in the shape's own user space) that rectangle maps onto.
 *
 * A committed crop is `<svg data-crop viewBox="cx cy cw ch">` wrapping an
 * `<image>` at 1:1, so the visible bitmap region is the crop rect expressed back
 * in pixels. Tracing the whole bitmap and letting the crop hide the rest would
 * put paths outside the visible box, so the crop is resolved here instead.
 */
interface Traceable {
  img: SVGImageElement;
  href: string;
  dest: { x: number; y: number; w: number; h: number };
  /** Null = the whole bitmap. */
  srcFrac: { x: number; y: number; w: number; h: number } | null;
}

const num = (el: Element, a: string): number => parseFloat(el.getAttribute(a) ?? '0') || 0;

function resolveTraceable(el: SVGElement): Traceable {
  const tag = el.tagName.toLowerCase();

  if (tag === 'image') {
    const img = el as SVGImageElement;
    const href = img.getAttribute('href') ?? img.getAttribute('xlink:href') ?? '';
    if (!href) throw new TraceError('That image has no source to trace.');
    return {
      img, href,
      dest: { x: num(img, 'x'), y: num(img, 'y'), w: num(img, 'width'), h: num(img, 'height') },
      srcFrac: null,
    };
  }

  if (tag === 'svg' && el.hasAttribute('data-crop')) {
    const img = el.querySelector('image') as SVGImageElement | null;
    if (!img) throw new TraceError('That cropped image has no picture inside it.');
    const href = img.getAttribute('href') ?? img.getAttribute('xlink:href') ?? '';
    if (!href) throw new TraceError('That image has no source to trace.');
    const c = { x: num(el, 'x'), y: num(el, 'y'), w: num(el, 'width'), h: num(el, 'height') };
    const b = { x: num(img, 'x'), y: num(img, 'y'), w: num(img, 'width'), h: num(img, 'height') };
    // Crop and image share one user space (the viewBox is 1:1), so the visible
    // slice as a FRACTION of the bitmap is just their overlap over the image box.
    const frac = b.w && b.h
      ? { x: (c.x - b.x) / b.w, y: (c.y - b.y) / b.h, w: c.w / b.w, h: c.h / b.h }
      : null;
    return { img, href, dest: c, srcFrac: frac };
  }

  throw new TraceError('Select a single image to trace.');
}

/** True for a shape Image Trace can act on — drives menu/button enablement. */
export function isTraceable(el: SVGElement | null | undefined): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'image' || (tag === 'svg' && el.hasAttribute('data-crop'));
}

function loadBitmap(href: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    // Same-origin/data URLs only in practice (imports inline to data: URLs), but
    // ask for anonymous CORS so a remote href at least has a chance of being
    // readable rather than tainting the canvas.
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => reject(new TraceError('That image couldn’t be loaded for tracing.'));
    im.src = href;
  });
}

/** Draw the traceable region into a canvas, capped to `maxPx` on its long edge. */
async function rasterize(t: Traceable, maxPx: number): Promise<ImageData> {
  const bmp = await loadBitmap(t.href);
  const natW = bmp.naturalWidth || bmp.width, natH = bmp.naturalHeight || bmp.height;
  if (!natW || !natH) throw new TraceError('That image has no pixels to trace.');

  const f = t.srcFrac ?? { x: 0, y: 0, w: 1, h: 1 };
  const sx = Math.max(0, f.x * natW), sy = Math.max(0, f.y * natH);
  const sw = Math.max(1, Math.min(natW - sx, f.w * natW));
  const sh = Math.max(1, Math.min(natH - sy, f.h * natH));

  const scale = Math.min(1, maxPx / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new TraceError('Couldn’t prepare a canvas to trace with.');
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  try {
    return ctx.getImageData(0, 0, w, h);
  } catch {
    // A cross-origin bitmap taints the canvas and the pixels can't be read.
    throw new TraceError('That image comes from another site, so its pixels can’t be read. Re-import it into the document and try again.');
  }
}

/** Map the UI's options onto the tracer's knobs. */
function tracerOptions(o: TraceOptions): Record<string, unknown> {
  // detail 0→100 walks the line/quad fit tolerance: tight (faithful, many nodes)
  // to loose (smooth, few). The tracer's own defaults sit around 1.
  const t = 0.01 + (o.detail / 100) * 3.5;
  const base: Record<string, unknown> = {
    ltres: t, qtres: t,
    pathomit: Math.max(0, Math.round(o.despeckle)),
    rightangleenhance: true,
    linefilter: true,
    strokewidth: 0,
    roundcoords: 2,
    blurradius: 0,
  };
  if (o.mode === 'color') {
    return { ...base, colorsampling: 2, numberofcolors: Math.max(2, Math.min(32, o.colors)), colorquantcycles: 3 };
  }
  // Silhouette and line art both quantize to two tones; silhouette then keeps only
  // the darker one, so the result is a single solid shape rather than shape+ground.
  return { ...base, colorsampling: 0, numberofcolors: 2, colorquantcycles: 1 };
}

const hex = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** Relative luminance, for picking/dropping the "ink" layer in 2-tone modes. */
const luma = (c: { r: number; g: number; b: number }): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/**
 * One path's `d`, including its holes.
 *
 * Holes are appended as sub-paths wound in REVERSE, which is what makes the
 * default nonzero fill-rule punch them out — the inside of an "O" stays open.
 * Ported rather than taken from the library's own SVG-string output so the paths
 * can be built as real elements with our own precision and paint.
 */
function pathData(layer: TracerPath[], p: TracerPath): string {
  const segs = p.segments;
  if (!segs.length) return '';
  const r = (n: number): number => Math.round(n * 100) / 100;
  let d = `M ${r(segs[0].x1)} ${r(segs[0].y1)}`;
  for (const s of segs) {
    d += ` ${s.type} ${r(s.x2)} ${r(s.y2)}`;
    if (s.x3 !== undefined && s.y3 !== undefined) d += ` ${r(s.x3)} ${r(s.y3)}`;
  }
  d += ' Z';

  for (const hi of p.holechildren) {
    const h = layer[hi];
    if (!h || !h.segments.length) continue;
    const last = h.segments[h.segments.length - 1];
    const startX = last.x3 !== undefined ? last.x3 : last.x2;
    const startY = last.y3 !== undefined ? last.y3 : last.y2;
    d += ` M ${r(startX)} ${r(startY)}`;
    for (let i = h.segments.length - 1; i >= 0; i--) {
      const s = h.segments[i];
      d += ` ${s.type}`;
      if (s.x3 !== undefined && s.y3 !== undefined) d += ` ${r(s.x2)} ${r(s.y2)}`;
      d += ` ${r(s.x1)} ${r(s.y1)}`;
    }
    d += ' Z';
  }
  return d;
}

interface TracerSegment { type: 'L' | 'Q'; x1: number; y1: number; x2: number; y2: number; x3?: number; y3?: number }
interface TracerPath { segments: TracerSegment[]; isholepath: boolean; holechildren: number[] }
interface TracerData { layers: TracerPath[][]; palette: { r: number; g: number; b: number; a: number }[] }

/** Trace already-rasterized pixels into paths, in PIXEL coordinates. */
export function tracePixels(imgd: ImageData, opts: TraceOptions): TraceResult {
  const td = ImageTracer.imagedataToTracedata(
    { width: imgd.width, height: imgd.height, data: imgd.data },
    tracerOptions(opts),
  ) as TracerData;

  // Silhouette keeps only the darkest layer — one solid shape, no background.
  let keep: number[] = td.layers.map((_, i) => i);
  if (opts.mode === 'silhouette' && td.palette.length > 1) {
    let darkest = 0;
    for (let i = 1; i < td.palette.length; i++) {
      if (luma(td.palette[i]) < luma(td.palette[darkest])) darkest = i;
    }
    keep = [darkest];
  }

  const paths: TracedPath[] = [];
  for (const li of keep) {
    const layer = td.layers[li];
    const col = td.palette[li];
    if (!layer || !col) continue;
    // Fully transparent quantization buckets are background, not ink.
    if (col.a !== undefined && col.a < 8) continue;
    const fill = `#${hex(col.r)}${hex(col.g)}${hex(col.b)}`;
    for (const p of layer) {
      if (p.isholepath) continue;           // emitted as part of its parent
      const d = pathData(layer, p);
      if (d) paths.push({ d, fill });
    }
  }
  return { paths, pixelW: imgd.width, pixelH: imgd.height };
}

/** Rasterize a shape and trace it. `maxPx` caps the working resolution. */
export async function traceShape(el: SVGElement, opts: TraceOptions, maxPx = MAX_TRACE_PX): Promise<TraceResult> {
  const t = resolveTraceable(el);
  const imgd = await rasterize(t, maxPx);
  return tracePixels(imgd, opts);
}

/**
 * Build the `<g>` of traced paths, mapped from pixel space onto the exact box the
 * source image occupies — and carrying the image's OWN transform, so the result
 * lands precisely over it whatever the image was rotated/scaled to.
 */
export function buildTracedGroup(el: SVGElement, result: TraceResult, name: string): SVGGElement {
  const t = resolveTraceable(el);
  const g = document.createElementNS(SVG, 'g') as SVGGElement;
  g.setAttribute('data-name', name);

  const sx = result.pixelW ? t.dest.w / result.pixelW : 1;
  const sy = result.pixelH ? t.dest.h / result.pixelH : 1;
  const own = el.getAttribute('transform');
  const place = `translate(${t.dest.x} ${t.dest.y}) scale(${sx} ${sy})`;
  g.setAttribute('transform', own ? `${own} ${place}` : place);

  for (const p of result.paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', p.d);
    path.setAttribute('fill', p.fill);
    path.setAttribute('stroke', 'none');
    g.appendChild(path);
  }
  return g;
}
