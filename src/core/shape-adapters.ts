/**
 * Per-shape-type geometry, in one place.
 *
 * The same rect/ellipse/line/polyline/polygon/path/text/image/use knowledge used
 * to be re-expressed in a `switch (tag)` chain in every module that moves, resizes,
 * snaps, or converts a shape (SelectTool, the Transform panel, snapping, bake,
 * boolean). Those parallel chains are the single biggest source of the "per-type
 * dispatch gap" bug class documented in CLAUDE.md (a new primitive, or a missed
 * `polyline`, silently breaks one operation). This module is the shared home for
 * that logic so each operation dispatches once, here.
 *
 * Scope note: interactive resize (SelectTool.applyResize) and panel resize
 * (properties.setShapeWorldBox) still own their scaling math — one works from a
 * geometry snapshot captured at gesture start, the other from the live box — but
 * both now share `resizeBox` (the handle→box arithmetic) and the translate/
 * to-path/geom-attr tables below. Frames are deliberately absent: they resize
 * through AppState.updateArtboard (they own a clip/bg/mask), so their callers
 * special-case them before reaching here.
 */

import { readRectBox, applyRectBox, writeNativeRadius } from './rect-shape';
import { localPathData } from './boolean';
import { transformPathData } from './path-model';

export interface BoxLike { x: number; y: number; width: number; height: number; }

/** The six affine components (a DOMMatrix or SVGMatrix both satisfy this). */
export interface Mat2D { a: number; b: number; c: number; d: number; e: number; f: number }

/**
 * The new box produced by dragging a resize `handle` (any of n/s/e/w combined)
 * by (dx, dy) from an original box. Pure arithmetic, intentionally NOT clamped —
 * SelectTool clamps the result to a 1px minimum, while the snapping guides want
 * the raw box; each caller applies its own policy. Shared by SelectTool.applyResize
 * and core/snapping so the two can never disagree about which edges a handle moves.
 */
export function resizeBox(o: BoxLike, dx: number, dy: number, handle: string): BoxLike {
  let x = o.x, y = o.y, w = o.width, h = o.height;
  if (handle.includes('e')) { w += dx; }
  if (handle.includes('w')) { x += dx; w -= dx; }
  if (handle.includes('s')) { h += dy; }
  if (handle.includes('n')) { y += dy; h -= dy; }
  return { x, y, width: w, height: h };
}

/** The fixed (anchored) corner of a resize: the corner opposite the dragged handle. */
export function resizeAnchor(o: BoxLike, handle: string): { fx: number; fy: number } {
  return {
    fx: handle.includes('w') ? o.x + o.width : o.x,
    fy: handle.includes('n') ? o.y + o.height : o.y,
  };
}

const addNum = (el: SVGElement, attr: string, d: number): void =>
  el.setAttribute(attr, String(parseFloat(el.getAttribute(attr) ?? '0') + d));

/**
 * Shift a shape's geometry by a local-space delta via direct attribute writes,
 * for the primitive types whose position lives in plain attributes. Returns false
 * for types with no direct-attribute form (path, group, and anything unrecognized)
 * — their callers translate via the transform list instead. A no-op (returns
 * false) for those, matching the prior inline behaviour exactly.
 */
export function translateShapeGeometry(el: SVGElement, dx: number, dy: number): boolean {
  switch (el.tagName.toLowerCase()) {
    case 'rect': case 'text': case 'image': case 'use': case 'svg':
      // A crop moves its viewport; the inner image and viewBox stay unchanged.
      addNum(el, 'x', dx); addNum(el, 'y', dy);
      // Multi-line <text>: each <tspan> carries an ABSOLUTE x (shared line origin)
      // that the parent x doesn't move — shift them too, or the text only moves
      // vertically.
      if (el.tagName.toLowerCase() === 'text') {
        el.querySelectorAll('tspan').forEach((t) => {
          const tx = t.getAttribute('x');
          if (tx !== null) t.setAttribute('x', String(parseFloat(tx) + dx));
        });
      }
      return true;
    case 'ellipse':
      addNum(el, 'cx', dx); addNum(el, 'cy', dy);
      return true;
    case 'line':
      addNum(el, 'x1', dx); addNum(el, 'y1', dy); addNum(el, 'x2', dx); addNum(el, 'y2', dy);
      return true;
    case 'polyline': case 'polygon': {
      const nums = parsePointsList(el.getAttribute('points') ?? '');
      el.setAttribute('points', formatPointsList(nums.map((v, i) => v + (i % 2 === 0 ? dx : dy))));
      return true;
    }
    default:
      return false; // path, g, … — no direct-attribute translate
  }
}

/**
 * Parse a `points` list into a flat [x0,y0,x1,y1,…] number array.
 *
 * SVG separates coordinates with commas AND/OR whitespace, so "9 128 57 128" and
 * "9,128 57,128" are the same list. Splitting on whitespace and *then* on ','
 * silently mangled the space-separated form — which is what Illustrator emits — into
 * pairs whose y was `undefined`, and the attribute got rewritten as
 * "9,NaN 128,NaN …", so the polygon disappeared and the browser logged an
 * "Expected number" error. Match the numbers instead of guessing the separators.
 */
export function parsePointsList(points: string): number[] {
  return (points.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
}

/** Format a flat coordinate array back into a `points` attribute value. */
function formatPointsList(nums: readonly number[], fmtNum: (n: number) => string = String): string {
  const out: string[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push(`${fmtNum(nums[i])},${fmtNum(nums[i + 1])}`);
  return out.join(' ');
}

/**
 * Scale the `points` list of a polyline/polygon about a fixed point (fx, fy) by
 * (sx, sy). Shared by interactive + panel resize so the two use identical math.
 */
export function scalePoints(points: string, fx: number, fy: number, sx: number, sy: number): string {
  const nums = parsePointsList(points);
  return formatPointsList(nums.map((v, i) => (i % 2 === 0 ? fx + (v - fx) * sx : fy + (v - fy) * sy)));
}

/** Element-local geometry as SVG path `d` — the single geometry→path converter
 *  (delegates to core/boolean.localPathData, which handles every primitive). */
export function shapeToPathData(el: SVGElement): string {
  return localPathData(el);
}

/** The attributes that encode each type's geometry (e.g. for change detection or
 *  when converting a shape to a path). Keyed by tag; empty for types whose
 *  geometry isn't attribute-encoded (group, image, use). */
export const GEOM_ATTRS: Record<string, readonly string[]> = {
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polyline: ['points'],
  polygon: ['points'],
  path: ['d'],
};

/** Remove the markers that make a shape REGENERATE its geometry: a per-corner-radius
 *  rect (`data-rect*`) or a parametric library shape (`data-shape*`). Once the `d`
 *  is rewritten by hand (converted for node editing, corners rounded), keeping them
 *  meant the next resize or handle drag rebuilt the old shape over the edit. */
export function dropParametricAttrs(el: Element): void {
  for (const a of Array.from(el.attributes)) {
    if (/^data-(rect|shape)(-|$)/.test(a.name)) el.removeAttribute(a.name);
  }
}

// ---- Folding an affine matrix into geometry (shared by the export bake and the
// resize-commit bake — previously two parallel switch(tag) chains in core/bake.ts).

const EPS = 1e-6;
const fmt = (v: number): string => {
  const r = Math.round(v * 1e4) / 1e4;
  return String(r === 0 ? 0 : r);
};
const applyM = (m: Mat2D, x: number, y: number): { x: number; y: number } =>
  ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
const numAttr = (el: SVGElement, attr: string, dflt = 0): number => {
  const v = el.getAttribute(attr);
  return v === null ? dflt : parseFloat(v);
};
const hasRotationOrSkew = (m: Mat2D): boolean => Math.abs(m.b) > EPS || Math.abs(m.c) > EPS;

function foldPoints(points: string, m: Mat2D): string {
  const nums = parsePointsList(points);
  const out: string[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const p = applyM(m, nums[i], nums[i + 1]);
    out.push(`${fmt(p.x)},${fmt(p.y)}`);
  }
  return out.join(' ');
}

/** SVG renders a stroke through the element's CTM, so folding that CTM into
 *  geometry must scale stroke-width (and dash metrics) by √|det| — exact for a
 *  uniform scale, area-preserving otherwise (issue #105). A non-scaling stroke
 *  renders at its raw width regardless of the transform, so it's left alone. */
function foldStroke(el: SVGElement, m: Mat2D): void {
  if (el.getAttribute('vector-effect') === 'non-scaling-stroke') return;
  const s = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  if (!Number.isFinite(s) || Math.abs(s - 1) < EPS) return;
  const sw = el.getAttribute('stroke-width');
  if (sw !== null) el.setAttribute('stroke-width', fmt((parseFloat(sw) || 0) * s));
  const dash = el.getAttribute('stroke-dasharray');
  if (dash && dash !== 'none') {
    el.setAttribute('stroke-dasharray', dash.split(/[\s,]+/).filter(Boolean).map(v => fmt((parseFloat(v) || 0) * s)).join(' '));
  }
  const doff = el.getAttribute('stroke-dashoffset');
  if (doff !== null) el.setAttribute('stroke-dashoffset', fmt((parseFloat(doff) || 0) * s));
}

/** Can `el`'s TYPE absorb matrix `m` into its geometry attributes? Free-geometry
 *  shapes (path/points/line) fold any affine exactly; attribute-box shapes only a
 *  translate + axis-aligned scale; text additionally needs a UNIFORM scale (one
 *  font-size) and no textPath (glyphs follow the path, not x/y). Pure type
 *  capability — callers layer their own policy (wrappers, area text, …) on top. */
export function canFoldMatrix(el: SVGElement, m: Mat2D): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'path' || tag === 'polyline' || tag === 'polygon' || tag === 'line') return true;
  if (hasRotationOrSkew(m)) return false;
  if (tag === 'rect' || tag === 'ellipse') return true; // symmetric content — flips fold fine
  // A flip can't be expressed by a box alone: an image/use's CONTENT must mirror,
  // and text glyphs likewise — negative scales keep their matrix (#219).
  if (tag === 'image' || tag === 'use') return m.a > 0 && m.d > 0;
  if (tag === 'circle') return Math.abs(m.a - m.d) <= EPS; // r can't scale anisotropically
  if (tag === 'text') return m.a > EPS && Math.abs(m.a - m.d) <= EPS && !el.querySelector('textPath');
  return false;
}

export interface FoldOpts {
  /**
   * Keep a rectangle's authored corner radius instead of scaling it with the box.
   *
   * A corner radius is a property the user set — 8px means 8px — not geometry that
   * should stretch when the box does. The RESIZE bake passes this so a rounded rect
   * resized as part of a multi-selection or a group keeps its corners; without it,
   * a group resize turned an 8px radius into 20.5px.
   *
   * Export baking must NOT pass it: there the flattened output has to render
   * identically to the canvas, so a residual scale has to reach the radius too.
   */
  preserveCornerRadius?: boolean;
}

/**
 * Fold `m` into the element's geometry attributes + stroke metrics, in place.
 * Assumes {@link canFoldMatrix} passed; the caller removes/keeps the transform
 * attribute itself (policies differ: export keeps a consolidated matrix on
 * failure, the resize bake leaves the element untouched).
 */
export function foldMatrixIntoGeometry(el: SVGElement, m: Mat2D, opts: FoldOpts = {}): void {
  const tag = el.tagName.toLowerCase();
  // A parametric rect (per-corner radii) carries its box in data-* and regenerates
  // its `d` from them, so fold the PARAMS — transforming the path data alone would
  // leave the params stale and the next radius edit would snap it back. Only valid
  // for an axis-aligned matrix; a rotation can't be expressed as a box, so that
  // falls through to the generic path fold below.
  if (tag === 'path' && el.hasAttribute('data-rect')
      && Math.abs(m.b) < 1e-6 && Math.abs(m.c) < 1e-6) {
    const box = readRectBox(el);
    const x0 = m.a * box.x + m.e, y0 = m.d * box.y + m.f;
    const w = box.w * m.a, h = box.h * m.d;
    if (!opts.preserveCornerRadius) {
      el.setAttribute('data-rect-radii',
        box.radii.map(r => Math.abs(r * m.a)).join(' '));
    }
    applyRectBox(el, w < 0 ? x0 + w : x0, h < 0 ? y0 + h : y0, Math.abs(w), Math.abs(h));
    return;
  }
  if (tag === 'path') {
    el.setAttribute('d', transformPathData(el.getAttribute('d') ?? '', m as DOMMatrix));
  } else if (tag === 'polyline' || tag === 'polygon') {
    el.setAttribute('points', foldPoints(el.getAttribute('points') ?? '', m));
  } else if (tag === 'line') {
    const a = applyM(m, numAttr(el, 'x1'), numAttr(el, 'y1'));
    const b = applyM(m, numAttr(el, 'x2'), numAttr(el, 'y2'));
    el.setAttribute('x1', fmt(a.x)); el.setAttribute('y1', fmt(a.y));
    el.setAttribute('x2', fmt(b.x)); el.setAttribute('y2', fmt(b.y));
  } else if (tag === 'rect' || tag === 'image' || tag === 'use') {
    // A negative scale (flip) makes the scaled extent negative — normalize to the
    // min corner + absolute dims, or the write is invalid SVG (ry="-45", #219).
    const x0 = m.a * numAttr(el, 'x') + m.e;
    const y0 = m.d * numAttr(el, 'y') + m.f;
    const w = numAttr(el, 'width') * m.a;
    const h = numAttr(el, 'height') * m.d;
    el.setAttribute('x', fmt(w < 0 ? x0 + w : x0));
    el.setAttribute('y', fmt(h < 0 ? y0 + h : y0));
    if (el.hasAttribute('width')) el.setAttribute('width', fmt(Math.abs(w)));
    if (el.hasAttribute('height')) el.setAttribute('height', fmt(Math.abs(h)));
    // rx/ry on a <rect> are the CORNER RADIUS, not geometry — see FoldOpts. Either
    // way the DRAWN radius has to be re-clamped for the new box, or a rect scaled
    // down past twice its radius renders as an ellipse (SVG clamps rx and ry
    // independently); writeNativeRadius keeps the corners circular and remembers
    // the authored value.
    if (tag === 'rect' && (el.hasAttribute('rx') || el.hasAttribute('ry') || el.hasAttribute('data-radius'))) {
      const authored = readRectBox(el).radii[0];
      const next = opts.preserveCornerRadius ? authored : Math.abs(authored * m.a);
      writeNativeRadius(el, next, Math.abs(w), Math.abs(h));
    }
  } else if (tag === 'ellipse') {
    el.setAttribute('cx', fmt(m.a * numAttr(el, 'cx') + m.e));
    el.setAttribute('cy', fmt(m.d * numAttr(el, 'cy') + m.f));
    el.setAttribute('rx', fmt(Math.abs(numAttr(el, 'rx') * m.a)));
    el.setAttribute('ry', fmt(Math.abs(numAttr(el, 'ry') * m.d)));
  } else if (tag === 'circle') {
    el.setAttribute('cx', fmt(m.a * numAttr(el, 'cx') + m.e));
    el.setAttribute('cy', fmt(m.d * numAttr(el, 'cy') + m.f));
    el.setAttribute('r', fmt(Math.abs(numAttr(el, 'r') * m.a)));
  } else if (tag === 'text') {
    el.setAttribute('x', fmt(m.a * numAttr(el, 'x') + m.e));
    el.setAttribute('y', fmt(m.d * numAttr(el, 'y') + m.f));
    if (el.hasAttribute('font-size')) el.setAttribute('font-size', fmt(numAttr(el, 'font-size') * m.a));
    // Multi-line tspans carry ABSOLUTE x (line origin) + dy advances — fold both,
    // or the lines shear away from the moved first line.
    el.querySelectorAll('tspan').forEach(t => {
      const ts = t as SVGElement;
      if (ts.getAttribute('x') !== null) ts.setAttribute('x', fmt(m.a * numAttr(ts, 'x') + m.e));
      if (ts.getAttribute('dy') !== null) ts.setAttribute('dy', fmt(numAttr(ts, 'dy') * m.d));
    });
  }
  foldStroke(el, m);
}
