// ---------------------------------------------------------------------------
// Marker geometry — what an arrowhead actually paints, as path data.
//
// A `<marker>` is drawn by the renderer, not by the path: its content is scaled
// (markerUnits="strokeWidth"), fitted viewBox→viewport, turned to the path's
// direction and clipped to its own viewport. Anything that turns a stroke into
// geometry (Outline Stroke) has to do all of that by hand, or the arrowhead
// simply disappears from the result.
//
// Pure geometry: reads the marker's definition and returns `d` strings in the
// path's local space. Requires the offset engine (a stroked marker, like the
// open chevron, is outlined too).
// ---------------------------------------------------------------------------

import {
  localPathData, outlineStrokeData, computeBoolean,
  type PathFrame, type StrokeJoin, type StrokeCap,
} from './boolean';
import { transformPathData } from './path-model';
import { viewportFit } from './coords';
import { effectivePaint } from './effective-paint';

/** One painted region of a marker. `paint` is a colour, or the `context-stroke` /
 *  `context-fill` keyword for "whatever the marked path uses". */
export interface MarkerPiece { d: string; paint: string }

const LEAF_TAGS = new Set(['path', 'rect', 'ellipse', 'circle', 'line', 'polygon', 'polyline']);

function ownMatrix(el: Element): DOMMatrix {
  const m = (el as SVGGraphicsElement).transform?.baseVal?.consolidate?.()?.matrix;
  return m ? new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]) : new DOMMatrix();
}

/**
 * The regions `marker` paints when placed at `at` on a path stroked `strokeWidth`
 * wide, in the path's local space. `isStart` matters for
 * `orient="auto-start-reverse"`, which turns the start marker to face outward.
 */
export function markerPieces(marker: Element, at: PathFrame, strokeWidth: number, isStart: boolean): MarkerPiece[] {
  const num = (attr: string, dflt: number): number => {
    const v = parseFloat(marker.getAttribute(attr) ?? '');
    return Number.isFinite(v) ? v : dflt;
  };
  const mw = num('markerWidth', 3), mh = num('markerHeight', 3);
  if (!(mw > 0 && mh > 0)) return [];
  const unit = marker.getAttribute('markerUnits') === 'userSpaceOnUse' ? 1 : strokeWidth;
  const orient = (marker.getAttribute('orient') ?? '0').trim();
  const angle = orient === 'auto' ? at.angle
    : orient === 'auto-start-reverse' ? at.angle + (isStart ? 180 : 0)
    : (parseFloat(orient) || 0);

  // viewBox → the marker's own viewport (0,0,markerWidth,markerHeight).
  const vb = (marker.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const toViewport = new DOMMatrix();
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
    const f = viewportFit(vb, 0, 0, mw, mh, marker.getAttribute('preserveAspectRatio'));
    toViewport.translateSelf(f.tx, f.ty).scaleSelf(f.sx, f.sy);
  }
  const ref = new DOMPoint(num('refX', 0), num('refY', 0)).matrixTransform(toViewport);
  // viewport → the path: the reference point lands on the vertex.
  const place = new DOMMatrix()
    .translateSelf(at.x, at.y).rotateSelf(angle).scaleSelf(unit).translateSelf(-ref.x, -ref.y);

  // A marker clips to its viewport unless it says otherwise — the open chevron's
  // miter tip pokes past its viewBox and is cut square by exactly this.
  const overflow = marker.getAttribute('overflow') ?? (marker as SVGElement).style?.overflow ?? '';
  const clip = overflow === 'visible' || overflow === 'auto' ? null : `M0,0 H${mw} V${mh} H0 Z`;

  const out: MarkerPiece[] = [];
  const push = (d: string, paint: string): void => {
    let v = d;
    if (clip) v = computeBoolean([v, clip], 'intersect')[0] ?? '';
    if (v.trim()) out.push({ d: transformPathData(v, place), paint });
  };
  const boundary = marker.parentElement; // paint may be set on the <marker> itself
  const visit = (parent: Element, m: DOMMatrix): void => {
    for (const child of Array.from(parent.children)) {
      const tag = child.tagName.toLowerCase();
      const cm = m.multiply(ownMatrix(child));
      if (tag === 'g') { visit(child, cm); continue; }
      if (!LEAF_TAGS.has(tag)) continue;
      const local = localPathData(child as SVGElement);
      if (!local.trim()) continue;
      const fill = effectivePaint(child, 'fill', boundary) ?? '#000000';
      if (fill !== 'none') push(transformPathData(local, cm), fill);
      const stroke = effectivePaint(child, 'stroke', boundary) ?? 'none';
      const sw = parseFloat(effectivePaint(child, 'stroke-width', boundary) ?? '1');
      if (stroke !== 'none' && sw > 0) {
        const rawJoin = effectivePaint(child, 'stroke-linejoin', boundary);
        const join: StrokeJoin = rawJoin === 'round' || rawJoin === 'bevel' ? rawJoin : 'miter';
        const rawCap = effectivePaint(child, 'stroke-linecap', boundary);
        const cap: StrokeCap = rawCap === 'round' || rawCap === 'square' ? rawCap : 'butt';
        const limit = parseFloat(child.getAttribute('stroke-miterlimit') ?? '');
        const o = outlineStrokeData(local, sw, join, cap, { miterLimit: Number.isFinite(limit) ? limit : undefined });
        if (o.trim()) push(transformPathData(o, cm), stroke);
      }
    }
  };
  visit(marker, toViewport);
  return out;
}
