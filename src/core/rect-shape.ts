// Rectangle geometry — uniform OR per-corner radii.
//
// SVG's <rect> can only do a single uniform corner radius (rx/ry). So a rectangle
// stays a plain <rect> while all four corners match, and becomes a PARAMETRIC path
// — `<path data-rect …>` carrying its box + 4 radii as data-* attributes — the moment
// the corners differ. `detectType` maps `<path data-rect>` back to type 'rect', so it
// is still treated as a (non-node-editable) rectangle everywhere; only its rendered
// `d` is regenerated from the params. This module is the single place that reads and
// writes that geometry, so resize / move / the panel all agree.

const SVG = 'http://www.w3.org/2000/svg';

/** Corner order: top-left, top-right, bottom-right, bottom-left. */
export type Radii = [number, number, number, number];

export interface RectBox {
  x: number; y: number; w: number; h: number;
  radii: Radii;
}

const num = (el: Element, a: string): number => parseFloat(el.getAttribute(a) ?? '0') || 0;

function parseRadii(s: string | null, fallback = 0): Radii {
  const parts = (s ?? '').trim().split(/[\s,]+/).map(Number).filter(n => Number.isFinite(n));
  if (parts.length === 4) return [parts[0], parts[1], parts[2], parts[3]];
  return [fallback, fallback, fallback, fallback];
}

export function radiiUniform(r: Radii): boolean {
  return Math.abs(r[0] - r[1]) < 1e-4 && Math.abs(r[0] - r[2]) < 1e-4 && Math.abs(r[0] - r[3]) < 1e-4;
}

/** Read a rectangle's box + per-corner radii from either representation. */
export function readRectBox(el: SVGElement): RectBox {
  if (el.tagName.toLowerCase() === 'path' && el.hasAttribute('data-rect')) {
    return {
      x: num(el, 'data-rect-x'), y: num(el, 'data-rect-y'),
      w: num(el, 'data-rect-w'), h: num(el, 'data-rect-h'),
      radii: parseRadii(el.getAttribute('data-rect-radii')),
    };
  }
  // data-radius holds the AUTHORED radius when the box is currently too small to
  // draw it — report that, so the panel shows what the user set and a later
  // enlargement can restore it.
  const drawn = el.hasAttribute('rx') ? num(el, 'rx') : (el.hasAttribute('ry') ? num(el, 'ry') : 0);
  const rx = el.hasAttribute('data-radius') ? num(el, 'data-radius') : drawn;
  return { x: num(el, 'x'), y: num(el, 'y'), w: num(el, 'width'), h: num(el, 'height'), radii: [rx, rx, rx, rx] };
}

/** Rounded-rect path with independent corner radii (each clamped to half the min
 *  dimension). A zero radius yields a sharp corner. Clockwise from the top-left. */
export function roundedRectPath(x: number, y: number, w: number, h: number, radii: Radii): string {
  const m = Math.min(w, h) / 2;
  const cl = (r: number) => Math.max(0, Math.min(r, m));
  const [tl, tr, br, bl] = [cl(radii[0]), cl(radii[1]), cl(radii[2]), cl(radii[3])];
  const R = (r: number) => r.toFixed(3);
  const N = (n: number) => n.toFixed(3);
  return [
    `M ${N(x + tl)} ${N(y)}`,
    `H ${N(x + w - tr)}`,
    tr ? `A ${R(tr)} ${R(tr)} 0 0 1 ${N(x + w)} ${N(y + tr)}` : '',
    `V ${N(y + h - br)}`,
    br ? `A ${R(br)} ${R(br)} 0 0 1 ${N(x + w - br)} ${N(y + h)}` : '',
    `H ${N(x + bl)}`,
    bl ? `A ${R(bl)} ${R(bl)} 0 0 1 ${N(x)} ${N(y + h - bl)}` : '',
    `V ${N(y + tl)}`,
    tl ? `A ${R(tl)} ${R(tl)} 0 0 1 ${N(x + tl)} ${N(y)}` : '',
    'Z',
  ].filter(Boolean).join(' ');
}


/**
 * The radius a plain `<rect>` can actually DRAW with circular corners.
 *
 * SVG clamps `rx` and `ry` INDEPENDENTLY — rx to width/2, ry to height/2 — so a
 * radius wider than half the box renders as an ELLIPSE, not a pill: a 20x39 rect
 * with r=16 came out as a full oval, because rx became 10 while ry stayed 16.
 * Clamping both to the same min(w,h)/2 keeps the corners circular, which is what
 * Figma draws (straight sides, semicircular caps).
 */
export function drawableRadius(r: number, w: number, h: number): number {
  return Math.max(0, Math.min(r, Math.min(Math.abs(w), Math.abs(h)) / 2));
}

/**
 * Write a uniform radius onto a plain `<rect>`, drawing the clamped value but
 * REMEMBERING the authored one in `data-radius` when the box is too small for it.
 *
 * Figma keeps what you typed: squash a rounded rect until its corners can't fit and
 * it renders as a pill, but stretch it back and the full radius returns. Storing
 * only the clamped number would silently destroy the 16 you set the moment the box
 * got narrow. `data-radius` is a data-* attribute, so it survives the history
 * snapshot and the saved file for free.
 */
export function writeNativeRadius(el: SVGElement, r: number, w: number, h: number): void {
  // Round on the way out: a scaled radius arrives as 15.999999999999998, and that
  // lands verbatim in the attribute, the saved file and the exported SVG.
  const round = (n: number): string => String(Math.round(n * 1000) / 1000);
  const drawn = drawableRadius(r, w, h);
  if (drawn > 0) {
    el.setAttribute('rx', round(drawn));
    el.setAttribute('ry', round(drawn)); // BOTH — leaving ry off re-opens the ellipse
  } else {
    el.removeAttribute('rx'); el.removeAttribute('ry');
  }
  if (r > drawn + 1e-6) el.setAttribute('data-radius', round(r));
  else el.removeAttribute('data-radius');
}

/** Move/resize a rectangle to a new box, preserving its radii. Works for both a
 *  plain <rect> and a parametric <path data-rect> (regenerates the `d`). */
export function applyRectBox(el: SVGElement, x: number, y: number, w: number, h: number): void {
  if (el.tagName.toLowerCase() === 'path' && el.hasAttribute('data-rect')) {
    el.setAttribute('data-rect-x', String(x));
    el.setAttribute('data-rect-y', String(y));
    el.setAttribute('data-rect-w', String(w));
    el.setAttribute('data-rect-h', String(h));
    el.setAttribute('d', roundedRectPath(x, y, w, h, parseRadii(el.getAttribute('data-rect-radii'))));
  } else {
    const authored = readRectBox(el).radii[0];
    el.setAttribute('x', String(x)); el.setAttribute('y', String(y));
    el.setAttribute('width', String(w)); el.setAttribute('height', String(h));
    // Re-clamp for the NEW box: shrinking squashes the corners to a pill, and
    // growing restores the full authored radius.
    if (authored > 0) writeNativeRadius(el, authored, w, h);
  }
}

/**
 * Set a rectangle's corner radii. Uniform radii keep (or become) a plain <rect rx>;
 * non-uniform radii promote the element to a `<path data-rect>` (converted in place,
 * preserving id + presentation). Returns the element to use afterwards — the SAME
 * node when no conversion was needed, or the NEW <path> when it was promoted. The
 * caller should rebuild the model (the element identity/tag may have changed).
 */
export function setRectRadii(el: SVGElement, radii: Radii): SVGElement {
  const box = readRectBox(el);
  const uniform = radiiUniform(radii);
  const isPath = el.tagName.toLowerCase() === 'path' && el.hasAttribute('data-rect');

  if (uniform && !isPath) {
    // Plain <rect>: draw the clamped radius, remember the authored one (0 clears).
    writeNativeRadius(el, radii[0], box.w, box.h);
    return el;
  }

  if (isPath) {
    // Already a parametric path: update radii + regenerate (stays a path even if the
    // radii became uniform again, to avoid flip-flopping the element type mid-edit).
    el.setAttribute('data-rect-radii', radii.join(' '));
    el.setAttribute('d', roundedRectPath(box.x, box.y, box.w, box.h, radii));
    return el;
  }

  // Promote <rect> → <path data-rect> for per-corner radii.
  const path = document.createElementNS(SVG, 'path') as SVGPathElement;
  const geom = new Set(['x', 'y', 'width', 'height', 'rx', 'ry']);
  for (const a of Array.from(el.attributes)) {
    if (!geom.has(a.name)) path.setAttribute(a.name, a.value);
  }
  path.setAttribute('data-rect', '');
  path.setAttribute('data-rect-x', String(box.x));
  path.setAttribute('data-rect-y', String(box.y));
  path.setAttribute('data-rect-w', String(box.w));
  path.setAttribute('data-rect-h', String(box.h));
  path.setAttribute('data-rect-radii', radii.join(' '));
  path.setAttribute('d', roundedRectPath(box.x, box.y, box.w, box.h, radii));
  el.replaceWith(path);
  return path;
}
