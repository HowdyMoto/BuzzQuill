// ---------------------------------------------------------------------------
// Coordinate-space helpers — the element-local ↔ drawing-layer (user) space
// conversions that tools and geometry code previously re-inlined at ~a dozen
// sites (three byte-identical `toLocal`s, two identical bbox-corner loops).
//
// All of these map relative to `#drawing-layer`, which is the space that
// Canvas.screenToSVG() (the single screen→world entry point) produces — so a
// point that came from a pointer event can be pushed straight into an element's
// local space and back. CTMs are read via getCTM (relative to the nearest
// viewport, i.e. the SVG), and the viewBox offset cancels because both the
// element and the drawing layer share it.
// ---------------------------------------------------------------------------

import type { Point, BBox } from './types';
import { boxOf } from './parametric';

function drawingLayerOf(svgCanvas: SVGSVGElement): SVGGraphicsElement | null {
  return svgCanvas.querySelector('#drawing-layer') as unknown as SVGGraphicsElement | null;
}

/**
 * The matrix mapping `el`'s LOCAL space into `ref`'s local space — the
 * `refScreen⁻¹ · elScreen` composition the overlay/ghost/crop code used to
 * re-inline at every site (#187). Includes el's own transform and every
 * ancestor's; works across sibling layers (selection / guides / drawing)
 * because they share the SVG viewport. Null when either isn't laid out.
 */
export function matrixBetween(ref: SVGGraphicsElement, el: SVGGraphicsElement): DOMMatrix | null {
  const r = ref.getScreenCTM?.();
  const o = el.getScreenCTM?.();
  if (!r || !o) return null;
  return r.inverse().multiply(o);
}

/** A reusable (x, y) → point-in-`ref`-space mapper over {@link matrixBetween}. */
export function pointMapperBetween(ref: SVGGraphicsElement, el: SVGGraphicsElement):
  ((x: number, y: number) => Point) | null {
  const m = matrixBetween(ref, el);
  if (!m) return null;
  const svg = ref.ownerSVGElement ?? (ref as unknown as SVGSVGElement);
  const P = svg.createSVGPoint();
  return (x, y) => { P.x = x; P.y = y; const p = P.matrixTransform(m); return { x: p.x, y: p.y }; };
}

/** A matrix as a `transform` attribute value. */
export function matrixAttr(m: DOMMatrix): string {
  return `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;
}

const matricesEqual = (a: DOMMatrix, b: DOMMatrix): boolean =>
  Math.abs(a.a - b.a) < 1e-6 && Math.abs(a.b - b.b) < 1e-6 &&
  Math.abs(a.c - b.c) < 1e-6 && Math.abs(a.d - b.d) < 1e-6 &&
  Math.abs(a.e - b.e) < 1e-6 && Math.abs(a.f - b.f) < 1e-6;

/**
 * Move `el` under `newParent` (before `anchor`, else appended) with its rendered
 * position preserved: the element's transform is re-expressed as
 * `newParentScreen⁻¹ · elScreen` — its full old placement re-based onto the new
 * parent. Implemented three separate times before (Layers-panel reorder, drag-
 * to-group, repeat-grid wrap — #187). When the old and new parents share a
 * coordinate space (a plain reorder, or a hop between untransformed containers)
 * the authored transform is kept as-is: consolidating to a matrix would be
 * visually identical but destroys the translate/rotate list getRotation() reads.
 */
export function movePreservingWorld(el: SVGGraphicsElement, newParent: Element, anchor: Node | null = null): void {
  const oldSpace = (el.parentElement as unknown as SVGGraphicsElement | null)?.getScreenCTM?.() ?? null;
  const elScreen = el.getScreenCTM?.() ?? null;
  newParent.insertBefore(el, anchor);
  const newSpace = (newParent as unknown as SVGGraphicsElement).getScreenCTM?.() ?? null;
  if (!elScreen || !newSpace) return;
  if (oldSpace && matricesEqual(oldSpace, newSpace)) return;
  const m = newSpace.inverse().multiply(elScreen);
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  el.setAttribute('transform', `matrix(${r(m.a)} ${r(m.b)} ${r(m.c)} ${r(m.d)} ${r(m.e)} ${r(m.f)})`);
}

/**
 * Map a point from drawing-layer (user) space into `el`'s local space. Returns the
 * input unchanged when the CTMs aren't available (e.g. a detached element), which
 * matches the previous per-tool behavior.
 */
export function worldToLocal(svgCanvas: SVGSVGElement, el: SVGElement | null, pt: Point): Point {
  const elCtm = (el as unknown as SVGGraphicsElement | null)?.getCTM?.();
  const parentCtm = drawingLayerOf(svgCanvas)?.getCTM?.();
  if (!elCtm || !parentCtm) return pt;
  const m = parentCtm.inverse().multiply(elCtm); // element-local → drawing-layer space
  const p = svgCanvas.createSVGPoint();
  p.x = pt.x; p.y = pt.y;
  const local = p.matrixTransform(m.inverse());
  return { x: local.x, y: local.y };
}

/**
 * Map a delta VECTOR from drawing-layer space into `el`'s local coordinate space
 * (linear part only — translation doesn't apply to free vectors). Identity chains
 * (top-level shapes, untransformed groups) return the delta unchanged. Use with
 * el = the PARENT of the element being moved: a child's geometry lives in its
 * parent's coordinate space.
 */
export function layerDeltaToLocal(svgCanvas: SVGSVGElement, el: SVGGraphicsElement, dx: number, dy: number): { dx: number; dy: number } {
  const elCtm = el.getCTM?.();
  const layerCtm = drawingLayerOf(svgCanvas)?.getCTM?.();
  if (!elCtm || !layerCtm) return { dx, dy };
  const m = layerCtm.inverse().multiply(elCtm); // el-local → drawing-layer space
  if (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1) return { dx, dy };
  const inv = m.inverse();
  if (!isFinite(inv.a) || !isFinite(inv.d)) return { dx, dy }; // degenerate
  return { dx: inv.a * dx + inv.c * dy, dy: inv.b * dx + inv.d * dy };
}

/**
 * The rotation, in degrees, that `el`'s local→drawing-layer mapping applies — the
 * element's OWN rotation composed with every ancestor's.
 *
 * This is the angle the selection handles are drawn at, because the overlay maps
 * the element's local bbox through this same matrix. So a gesture measured against
 * those handles must be de-rotated by THIS angle, not by the element's own: when
 * the rotation lives in an ancestor the two differ, and the difference costs the
 * drag a factor of cos(theta) (#273).
 */
export function layerRotationOf(svgCanvas: SVGSVGElement, el: SVGGraphicsElement): number {
  const elCtm = el.getCTM?.();
  const layerCtm = drawingLayerOf(svgCanvas)?.getCTM?.();
  if (!elCtm || !layerCtm) return 0;
  const m = layerCtm.inverse().multiply(elCtm); // el-local → drawing-layer space
  const deg = (Math.atan2(m.b, m.a) * 180) / Math.PI;
  return Number.isFinite(deg) ? deg : 0;
}

/**
 * The inverse of {@link layerDeltaToLocal}: an element-local delta expressed in
 * drawing-layer space. Together the pair lets a gesture be measured in world units
 * (where snapping and the pointer live) and applied in local ones (where geometry
 * attributes live), without either side hard-coding an assumption about the
 * transform between them.
 */
export function localDeltaToLayer(svgCanvas: SVGSVGElement, el: SVGGraphicsElement, dx: number, dy: number): { dx: number; dy: number } {
  const elCtm = el.getCTM?.();
  const layerCtm = drawingLayerOf(svgCanvas)?.getCTM?.();
  if (!elCtm || !layerCtm) return { dx, dy };
  const m = layerCtm.inverse().multiply(elCtm); // el-local → drawing-layer space
  return { dx: m.a * dx + m.c * dy, dy: m.b * dx + m.d * dy };
}

/**
 * A reference frame at the MIDPOINT of a path-like element, in the element's own
 * local space: the point `base` and a unit `perp` pointing to the side that
 * paperjs-offset's POSITIVE delta shifts toward. Used to place + drag the on-canvas
 * offset handle. Null when the element has no measurable geometry.
 */
export function pathMidFrame(el: SVGElement): { base: Point; perp: Point } | null {
  const geo = el as unknown as SVGGeometryElement;
  let total = 0;
  try { total = geo.getTotalLength?.() ?? 0; } catch { total = 0; }
  let a: Point, b: Point;
  if (total > 1e-3) {
    const pa = geo.getPointAtLength(total * 0.5);
    const pb = geo.getPointAtLength(Math.min(total, total * 0.5 + Math.max(0.5, total * 0.01)));
    a = { x: pa.x, y: pa.y }; b = { x: pb.x, y: pb.y };
  } else {
    let bb: DOMRect; try { bb = geo.getBBox(); } catch { return null; }
    a = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
    b = { x: a.x + 1, y: a.y };
  }
  let tx = b.x - a.x, ty = b.y - a.y;
  const len = Math.hypot(tx, ty);
  if (len < 1e-6) { tx = 1; ty = 0; } else { tx /= len; ty /= len; }
  return { base: a, perp: { x: ty, y: -tx } }; // (ty,−tx) matches paperjs-offset's +delta side
}

/**
 * The element's LOCAL *visual* bbox — the region the user actually sees — for the
 * types whose visible area differs from the raw getBBox:
 *  - a cropped image (`<svg data-crop>`): its viewBox (the crop viewport),
 *  - a clip-group mask (`<g data-clip-group>`): the mask shape ∩ the clipped
 *    content (getBBox ignores the clip and returns the full unclipped content).
 * Everything else returns plain getBBox. Null when getBBox throws.
 *
 * Frames are intentionally NOT handled here — they hug their own data-frame-w/h and
 * are special-cased by callers before this is reached.
 */
/** An element's getBBox, mapped through its OWN transform to its parent's space
 *  (axis-aligned). Used to place a clip mask's box in its group's coordinate space. */
function rectThroughOwnTransform(el: SVGGraphicsElement): DOMRect {
  const b = el.getBBox();
  const t = el.transform?.baseVal?.consolidate?.();
  const m = t?.matrix;
  if (!m) return b;
  const pts = [
    new DOMPoint(b.x, b.y).matrixTransform(m),
    new DOMPoint(b.x + b.width, b.y).matrixTransform(m),
    new DOMPoint(b.x, b.y + b.height).matrixTransform(m),
    new DOMPoint(b.x + b.width, b.y + b.height).matrixTransform(m),
  ];
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return new DOMRect(x, y, Math.max(...xs) - x, Math.max(...ys) - y);
}

export function visualLocalBBox(el: SVGGraphicsElement): DOMRect | null {
  try {
    const tag = el.tagName.toLowerCase();
    // Parametric pie/arc: select + resize the FULL circle box (not the wedge's bbox),
    // so a pie behaves like a circle and stays perfectly round when resized.
    if (el.hasAttribute('data-shape')) {
      const b = boxOf(el);
      if (b) return b;
    }
    if (tag === 'svg' && el.hasAttribute('data-crop')) {
      const vb = (el.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
      if (vb.length === 4) return new DOMRect(vb[0], vb[1], vb[2], vb[3]);
    }
    if (el.hasAttribute('data-clip-group')) {
      const content = el.getBBox(); // in the group's user space (children transforms applied)
      // Find the mask shape via the clipPath among DIRECT children (robust to SVG's
      // camelCase 'clipPath' and to nested clip-groups a querySelector could mis-hit).
      const clipPathEl = Array.from(el.children).find(c => c.tagName.toLowerCase() === 'clippath');
      const maskShape = clipPathEl?.firstElementChild as SVGGraphicsElement | null;
      if (!maskShape) return content;
      // The mask's getBBox is in ITS user space; map it into the group's space via its
      // own transform (the clipPath is userSpaceOnUse, so it adds no transform) so the
      // intersection below compares like-for-like even when the mask was moved/rotated.
      const m = rectThroughOwnTransform(maskShape);
      const x = Math.max(content.x, m.x), y = Math.max(content.y, m.y);
      const r = Math.min(content.x + content.width, m.x + m.width);
      const b = Math.min(content.y + content.height, m.y + m.height);
      return r > x && b > y ? new DOMRect(x, y, r - x, b - y) : new DOMRect(m.x, m.y, m.width, m.height);
    }
    return el.getBBox();
  } catch {
    return null;
  }
}

/**
 * An element's axis-aligned bbox expressed in drawing-layer (user) space: its local
 * getBBox with each corner mapped through the element's transform chain. Falls back
 * to the raw local bbox when CTMs are unavailable; null when getBBox throws (an
 * element with no renderable geometry).
 */
export function localBBoxInLayer(svgCanvas: SVGSVGElement, el: SVGGraphicsElement): BBox | null {
  let bbox: DOMRect;
  try { bbox = el.getBBox(); } catch { return null; }
  return mapLocalRectToLayer(svgCanvas, el, bbox);
}

/**
 * An element's axis-aligned bbox expressed in ANOTHER element's local space.
 *
 * {@link localBBoxInLayer} is this with `ref` = the drawing layer. A CONTAINER needs
 * its PARENT's space instead, because that is where its `transform` is written — and
 * where, once the ancestors' rotation is accounted for, its handles are drawn.
 */
export function localBBoxIn(ref: SVGGraphicsElement, el: SVGGraphicsElement): BBox | null {
  let bbox: DOMRect;
  try { bbox = el.getBBox(); } catch { return null; }
  const map = pointMapperBetween(ref, el);
  if (!map) return { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
  const pts = [
    map(bbox.x, bbox.y), map(bbox.x + bbox.width, bbox.y),
    map(bbox.x + bbox.width, bbox.y + bbox.height), map(bbox.x, bbox.y + bbox.height),
  ];
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * Like {@link localBBoxInLayer} but for the element's VISIBLE box — the crop
 * viewport (cropped image) or mask ∩ content (clip-group), via visualLocalBBox —
 * mapped into drawing-layer (world) space. Falls back to the raw local box (no
 * CTM) or null (no geometry).
 */
export function visualWorldBBox(svgCanvas: SVGSVGElement, el: SVGGraphicsElement): BBox | null {
  const local = visualLocalBBox(el);
  if (!local) return null;
  return mapLocalRectToLayer(svgCanvas, el, local);
}

/** Map an element-local rect's four corners into drawing-layer space through the
 *  element's transform chain (el-local → drawing-layer). Shared by
 *  localBBoxInLayer / visualWorldBBox so the corner-mapping lives in one place. */
function mapLocalRectToLayer(svgCanvas: SVGSVGElement, el: SVGGraphicsElement, box: { x: number; y: number; width: number; height: number }): BBox {
  const parentCtm = drawingLayerOf(svgCanvas)?.getCTM?.();
  const ctm = el.getCTM?.();
  if (!ctm || !parentCtm) return { x: box.x, y: box.y, width: box.width, height: box.height };
  const m = parentCtm.inverse().multiply(ctm);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ]) {
    const pt = svgCanvas.createSVGPoint();
    pt.x = c.x; pt.y = c.y;
    const t = pt.matrixTransform(m);
    minX = Math.min(minX, t.x); minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x); maxY = Math.max(maxY, t.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The viewBox→viewport mapping SVG applies to a `<symbol>` instance, a `<marker>`
 * or a nested `<svg>`: content in `vb` fitted into the box x/y/w/h under
 * `preserveAspectRatio` (default `xMidYMid meet` — UNIFORM scale, centred). A
 * point maps to `(tx + sx·x, ty + sy·y)`.
 */
export function viewportFit(
  vb: number[], x: number, y: number, w: number, h: number, par: string | null,
): { tx: number; ty: number; sx: number; sy: number } {
  const [vbx, vby, vbw, vbh] = vb;
  let sx = w / vbw, sy = h / vbh;
  const [align = 'xMidYMid', mode = 'meet'] = (par ?? '').trim().split(/\s+/).filter(Boolean);
  if (align !== 'none') {
    const s = mode === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = sy = s;
  }
  let tx = x - vbx * sx, ty = y - vby * sy;
  if (align !== 'none') {
    if (align.includes('xMid')) tx += (w - vbw * sx) / 2;
    else if (align.includes('xMax')) tx += w - vbw * sx;
    if (align.includes('YMid')) ty += (h - vbh * sy) / 2;
    else if (align.includes('YMax')) ty += h - vbh * sy;
  }
  return { tx, ty, sx, sy };
}

/**
 * An element's OWN transform as one matrix (identity when it has none), multiplied
 * out item by item — never via `SVGTransformList.consolidate()`, which rewrites the
 * list into a single matrix and loses the translate/rotate form getRotation reads.
 */
export function ownTransformMatrix(el: Element): DOMMatrix {
  const list = (el as unknown as SVGGraphicsElement).transform?.baseVal;
  let m = new DOMMatrix();
  if (!list) return m;
  for (let i = 0; i < list.numberOfItems; i++) {
    const t = list.getItem(i).matrix;
    m = m.multiply(new DOMMatrix([t.a, t.b, t.c, t.d, t.e, t.f]));
  }
  return m;
}

/**
 * The matrix mapping `el`'s local space into `ancestor`'s local space, composed
 * from the transform attributes in between (el's own included, the ancestor's own
 * excluded). Unlike {@link matrixBetween} it needs no layout, so it works on a
 * hidden (`display:none`) element, which has no CTM to ask. Ignores a nested
 * `<svg>`'s viewport step, so keep it to ordinary group/shape chains.
 */
export function matrixToAncestor(el: Element, ancestor: Element): DOMMatrix {
  let m = new DOMMatrix();
  for (let n: Element | null = el; n && n !== ancestor; n = n.parentElement) {
    m = ownTransformMatrix(n).multiply(m);
  }
  return m;
}
