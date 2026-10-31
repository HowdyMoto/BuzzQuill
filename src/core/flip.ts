/**
 * Flip (mirror) selected shapes horizontally or vertically about the selection's
 * union-bbox centre. One shape flips about its own centre (stays put, mirrored);
 * a multi-selection reflects about the group centre (shapes swap sides).
 *
 * A flip is a reflection — an affine matrix with negative determinant. How it's
 * stored per type:
 *   • Free geometry (path / polyline / polygon / line): folded straight into the
 *     coordinates — Béziers and point lists mirror exactly, no transform left.
 *   • Box shapes (rect / ellipse / circle): folded too, then negative
 *     width/height/r are normalised back to a positive box (foldMatrixIntoGeometry
 *     is written for positive scale, since resize never goes negative). Only when
 *     the shape is unrotated — a rotated box can't express the reflection in its
 *     attributes, so it falls through to the transform path.
 *   • Everything else (image / use / text / groups / wrappers / rotated boxes):
 *     the reflection is kept as the element's `transform` matrix — an <image> or
 *     glyph run can only be mirrored by a transform, not by its geometry. A double
 *     flip composes to the identity and the transform is dropped, so it round-trips
 *     back to pristine geometry.
 *
 * Frames are never passed here (they're axis-aligned containers) — the caller
 * filters them out.
 */

import { canFoldMatrix, foldMatrixIntoGeometry } from './shape-adapters';

export type FlipAxis = 'horizontal' | 'vertical';

const EPS = 1e-6;

/** Reflection in drawing-layer space: about the vertical line x=c (horizontal
 *  flip) or the horizontal line y=c (vertical flip). */
export function reflectionMatrix(axis: FlipAxis, c: number): DOMMatrix {
  return axis === 'horizontal'
    ? new DOMMatrix([-1, 0, 0, 1, 2 * c, 0])
    : new DOMMatrix([1, 0, 0, -1, 0, 2 * c]);
}

/** Free-geometry types fold ANY affine (incl. reflection) exactly into coords. */
const FREE_GEOMETRY = new Set(['path', 'polyline', 'polygon', 'line']);
/** Box types fold a reflection too, but need negative dims normalised after. */
const BOX_GEOMETRY = new Set(['rect', 'ellipse', 'circle']);

function isApproxIdentity(m: DOMMatrix): boolean {
  return Math.abs(m.a - 1) < EPS && Math.abs(m.b) < EPS && Math.abs(m.c) < EPS &&
    Math.abs(m.d - 1) < EPS && Math.abs(m.e) < EPS && Math.abs(m.f) < EPS;
}

function setOwnMatrix(el: SVGElement, m: DOMMatrix): void {
  el.setAttribute('transform', `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`);
}

const round = (v: number): string => String(Math.round(v * 1e4) / 1e4);

/** Fold an axis-aligned matrix `m` (b≈c≈0, guaranteed by canFoldMatrix) into a box
 *  shape's attributes, computing the FINAL positive box directly — unlike the shared
 *  foldMatrixIntoGeometry, which would transiently write a negative width/r that the
 *  SVG DOM rejects with a console error. A reflection preserves scale magnitude, so
 *  stroke width only changes if `m` also carries a resize scale. */
function foldBox(el: SVGElement, m: DOMMatrix): void {
  const n = (a: string): number => parseFloat(el.getAttribute(a) ?? '0') || 0;
  const tag = el.tagName.toLowerCase();
  if (tag === 'rect') {
    const x = n('x'), y = n('y'), w = n('width'), h = n('height');
    const x1 = m.a * x + m.e, x2 = m.a * (x + w) + m.e;
    const y1 = m.d * y + m.f, y2 = m.d * (y + h) + m.f;
    el.setAttribute('x', round(Math.min(x1, x2)));
    el.setAttribute('y', round(Math.min(y1, y2)));
    el.setAttribute('width', round(Math.abs(x2 - x1)));
    el.setAttribute('height', round(Math.abs(y2 - y1)));
    if (el.hasAttribute('rx')) el.setAttribute('rx', round(Math.abs(n('rx') * m.a)));
    if (el.hasAttribute('ry')) el.setAttribute('ry', round(Math.abs(n('ry') * m.d)));
  } else if (tag === 'ellipse') {
    el.setAttribute('cx', round(m.a * n('cx') + m.e));
    el.setAttribute('cy', round(m.d * n('cy') + m.f));
    el.setAttribute('rx', round(Math.abs(n('rx') * m.a)));
    el.setAttribute('ry', round(Math.abs(n('ry') * m.d)));
  } else if (tag === 'circle') {
    el.setAttribute('cx', round(m.a * n('cx') + m.e));
    el.setAttribute('cy', round(m.d * n('cy') + m.f));
    el.setAttribute('r', round(Math.abs(n('r') * m.a)));
  }
  const s = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)); // 1 for a pure reflection
  if (Math.abs(s - 1) > EPS) {
    const sw = el.getAttribute('stroke-width');
    if (sw !== null) el.setAttribute('stroke-width', round((parseFloat(sw) || 0) * s));
  }
}

/**
 * Apply world-space reflection `R` to one element while keeping it a child of its
 * current parent. `newOwn = P⁻¹·R·P·T` (P = parent→layer, T = element's own
 * transform) is the reflection re-expressed in the element's parent space; we bake
 * it into geometry where the type allows, else store it as the element's matrix.
 */
export function flipElement(el: SVGElement, R: DOMMatrix, layer: SVGGraphicsElement): void {
  const g = el as unknown as SVGGraphicsElement;
  const layerScreen = layer.getScreenCTM();
  const elScreen = g.getScreenCTM?.();
  const parentScreen = (el.parentNode as unknown as SVGGraphicsElement | null)?.getScreenCTM?.();
  if (!layerScreen || !elScreen || !parentScreen) return;
  // getScreenCTM yields legacy SVGMatrix; promote to DOMMatrix so it composes with R.
  const dm = (m: DOMMatrix | SVGMatrix): DOMMatrix => new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]);
  const layerInv = dm(layerScreen).inverse();
  const C = layerInv.multiply(dm(elScreen));      // element-local → layer (= P·T)
  const P = layerInv.multiply(dm(parentScreen));  // parent → layer
  const newOwn = P.inverse().multiply(R).multiply(C); // element-local → parent, reflected

  const tag = el.tagName.toLowerCase();
  const canFoldBox = BOX_GEOMETRY.has(tag) && canFoldMatrix(el, newOwn); // false when rotated
  if (FREE_GEOMETRY.has(tag)) {
    foldMatrixIntoGeometry(el, newOwn); // path/line/points fold any affine; det=-1 keeps stroke
    el.removeAttribute('transform');
  } else if (canFoldBox) {
    foldBox(el, newOwn); // positive box computed directly (no negative-dim intermediate)
    el.removeAttribute('transform');
  } else if (isApproxIdentity(newOwn)) {
    el.removeAttribute('transform'); // double flip cancels → back to pristine geometry
  } else {
    setOwnMatrix(el, newOwn);
  }
}
