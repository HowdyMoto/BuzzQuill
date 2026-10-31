// ---------------------------------------------------------------------------
// Smart guides / snapping for drag-move and resize.
//
// Pure geometry helpers plus guide-line rendering. Targets are collected once
// at the start of a gesture (the artboard and the non-moving objects don't move
// while you drag), then each mousemove only does cheap nearest-line lookups.
//
// All coordinates are in drawing-layer (canvas/SVG user) space — the same space
// the select tool already works in — so no screen<->canvas conversion is needed
// here. Thresholds are passed in already converted to canvas units.
// ---------------------------------------------------------------------------

import type { AppState } from './state';
import type { BBox, Point, ShapeData } from './types';
import { localBBoxInLayer, matrixBetween } from './coords';
import { resizeBox, shapeToPathData } from './shape-adapters';
import { parsePath } from './path-model';

const NS = 'http://www.w3.org/2000/svg';
const EPS = 0.01;

/** Snap zone in screen pixels. Callers divide by zoom to get canvas units. */
export const SNAP_PX = 6;

/** A candidate snap line. `pos` is the coordinate on the snap axis (X for a
 *  vertical line, Y for a horizontal line); `min`/`max` is the line's extent on
 *  the perpendicular axis, used to size the drawn guide. */
export interface SnapLine { pos: number; min: number; max: number }

/** Vertical lines snap the X axis; horizontal lines snap the Y axis. `boxes` are
 *  the full bboxes of the non-moving OBJECTS (no frames), used by the equal-spacing
 *  snap — line targets alone can't express "the gap between A and B". */
export interface SnapTargets { vertical: SnapLine[]; horizontal: SnapLine[]; boxes: BBox[] }

export interface GuideLine { x1: number; y1: number; x2: number; y2: number }

/** Axis-aligned bbox of an element in drawing-layer space (mirrors
 *  SelectTool.getScreenSpaceBBox for a single element). Returns null if the
 *  element has no renderable geometry. */
export function getAABB(el: SVGGraphicsElement, svgCanvas: SVGSVGElement): BBox | null {
  return localBBoxInLayer(svgCanvas, el);
}

/** Push the left/center/right (vertical) and top/middle/bottom (horizontal)
 *  snap lines of an axis-aligned box. */
function addBoxTargets(targets: SnapTargets, x: number, y: number, w: number, h: number): void {
  if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return;
  const top = y, bottom = y + h, left = x, right = x + w;
  targets.vertical.push(
    { pos: left, min: top, max: bottom },
    { pos: x + w / 2, min: top, max: bottom },
    { pos: right, min: top, max: bottom },
  );
  targets.horizontal.push(
    { pos: top, min: left, max: right },
    { pos: y + h / 2, min: left, max: right },
    { pos: bottom, min: left, max: right },
  );
}

/** Collect every snap line for the current gesture: every frame's edges + center,
 *  and the edges + center of every other (non-moving, visible, unlocked) OBJECT.
 *
 *  Container transparency: FRAMES are always descended (content lives in frames, so
 *  a top-level scan would miss almost everything). A GROUP normally snaps as a UNIT
 *  (its outer box) — EXCEPT a group that ENCLOSES the moving shape, which is made
 *  transparent so the moving shape can align to its siblings/cousins inside that
 *  group (the reported gap: a text nested in groups had no guides to a sibling rect).
 *  Unrelated groups stay opaque units.
 *
 *  `movingIds` are the shapes being dragged/resized (excluded, subtree and all, so
 *  they don't snap to themselves). All boxes are in drawing-layer (world) space. */
export function collectSnapTargets(
  state: AppState,
  movingIds: Set<string>,
  svgCanvas: SVGSVGElement,
): SnapTargets {
  const targets: SnapTargets = { vertical: [], horizontal: [], boxes: [] };

  // Frame own-bounds (from the artboards cache — a frame's getBBox would be its
  // children's union, not its rect). Lets objects align to any frame's edges/center.
  for (const ab of state.artboards) {
    if (movingIds.has(ab.id)) continue;
    addBoxTargets(targets, ab.x, ab.y, ab.width, ab.height);
  }

  // Ancestor groups of the moving shapes — descend into these (transparent) so their
  // children become individual snap targets, instead of the group snapping as a unit.
  const enclosingGroupIds = new Set<string>();
  for (const id of movingIds) {
    let pid = state.findShapeById(id)?.parentId;
    while (pid) {
      enclosingGroupIds.add(pid);
      pid = state.findShapeById(pid)?.parentId;
    }
  }

  const visit = (shapes: ShapeData[]): void => {
    for (const shape of shapes) {
      if (movingIds.has(shape.id)) continue; // moving shape + its subtree: skip
      if (shape.type === 'frame') { if (shape.children) visit(shape.children); continue; }
      if (!shape.visible || shape.locked) continue;
      // A group enclosing the moving shape is transparent: descend so the moving
      // shape's siblings (at every enclosing level) become targets, and don't add
      // the group's own box (you're aligning INSIDE it, à la Figma).
      if (shape.type === 'group' && enclosingGroupIds.has(shape.id)) {
        if (shape.children) visit(shape.children);
        continue;
      }
      const aabb = getAABB(shape.element, svgCanvas);
      if (aabb) {
        addBoxTargets(targets, aabb.x, aabb.y, aabb.width, aabb.height);
        targets.boxes.push(aabb); // spacing snap works on whole object boxes
      }
      // Other groups snap as a unit (their bbox above); don't descend.
    }
  };
  visit(state.shapes);
  return targets;
}

/** Best (closest within threshold) snap of any candidate to any line. */
function bestSnap(
  candidates: number[],
  lines: SnapLine[],
  threshold: number,
): { delta: number; pos: number } | null {
  let best: { delta: number; pos: number } | null = null;
  for (const c of candidates) {
    for (const line of lines) {
      const dist = line.pos - c;
      if (Math.abs(dist) <= threshold && (!best || Math.abs(dist) < Math.abs(best.delta))) {
        best = { delta: dist, pos: line.pos };
      }
    }
  }
  return best;
}

/** Guides for every target line sitting exactly on a chosen snapped position,
 *  extended to also span the moving box. */
function guidesAt(
  lines: SnapLine[], pos: number, vertical: boolean,
  boxMin: number, boxMax: number,
): GuideLine[] {
  const out: GuideLine[] = [];
  for (const line of lines) {
    if (Math.abs(line.pos - pos) > EPS) continue;
    const a = Math.min(line.min, boxMin), b = Math.max(line.max, boxMax);
    out.push(vertical
      ? { x1: pos, y1: a, x2: pos, y2: b }
      : { x1: a, y1: pos, x2: b, y2: pos });
  }
  return out;
}

// ---- Equal-spacing snap (#110) ----
//
// While dragging, if placing the moving box next to a pair of neighbours would
// repeat their gap (A ↔ B ↔ moving, all sharing a row/column), snap to that
// position and draw a measurement guide across each equal gap. Also offers the
// "centered between two neighbours" position (equal gap on both sides).

interface SpacingHit { delta: number; guides: GuideLine[] }

/** A box projected onto one axis: [lo,hi] on the snap axis, [pLo,pHi] across it. */
interface Span { lo: number; hi: number; pLo: number; pHi: number }

const spanOf = (b: BBox, axis: 'x' | 'y'): Span => axis === 'x'
  ? { lo: b.x, hi: b.x + b.width, pLo: b.y, pHi: b.y + b.height }
  : { lo: b.y, hi: b.y + b.height, pLo: b.x, pHi: b.x + b.width };

/** A gap-measurement guide: a segment across the gap with end ticks, drawn at
 *  the middle of the two spans' shared perpendicular range. */
function gapGuide(from: number, to: number, a: Span, b: Span, axis: 'x' | 'y', tick: number): GuideLine[] {
  const mid = (Math.max(a.pLo, b.pLo) + Math.min(a.pHi, b.pHi)) / 2;
  return axis === 'x'
    ? [
      { x1: from, y1: mid, x2: to, y2: mid },
      { x1: from, y1: mid - tick, x2: from, y2: mid + tick },
      { x1: to, y1: mid - tick, x2: to, y2: mid + tick },
    ]
    : [
      { x1: mid, y1: from, x2: mid, y2: to },
      { x1: mid - tick, y1: from, x2: mid + tick, y2: from },
      { x1: mid - tick, y1: to, x2: mid + tick, y2: to },
    ];
}

function bestSpacingSnap(moving: BBox, boxes: BBox[], threshold: number, axis: 'x' | 'y'): SpacingHit | null {
  const M = spanOf(moving, axis);
  const size = M.hi - M.lo;
  // Only boxes sharing the moving box's row/column can pace it.
  const row = boxes.map(b => spanOf(b, axis)).filter(s => s.pLo < M.pHi && s.pHi > M.pLo);
  if (row.length < 2) return null;

  let best: { delta: number; A: Span; B: Span; kind: 'after' | 'before' | 'between' } | null = null;
  const consider = (target: number, A: Span, B: Span, kind: 'after' | 'before' | 'between') => {
    const delta = target - M.lo;
    if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
      best = { delta, A, B, kind };
    }
  };
  for (const A of row) {
    for (const B of row) {
      if (A === B || A.hi >= B.lo) continue; // need A strictly before B with a real gap
      const gap = B.lo - A.hi;
      consider(B.hi + gap, A, B, 'after');            // …A gap B gap M
      consider(A.lo - gap - size, A, B, 'before');    // M gap A gap B…
      if (size < gap - EPS) consider(A.hi + (gap - size) / 2, A, B, 'between'); // A = M = B
    }
  }
  if (!best) return null;

  const { delta, A, B, kind } = best as { delta: number; A: Span; B: Span; kind: 'after' | 'before' | 'between' };
  const lo = M.lo + delta, hi = lo + size;
  const snappedM: Span = { lo, hi, pLo: M.pLo, pHi: M.pHi };
  const tick = Math.max(2, threshold / 2);
  const guides: GuideLine[] = kind === 'after'
    ? [...gapGuide(A.hi, B.lo, A, B, axis, tick), ...gapGuide(B.hi, lo, B, snappedM, axis, tick)]
    : kind === 'before'
      ? [...gapGuide(hi, A.lo, snappedM, A, axis, tick), ...gapGuide(A.hi, B.lo, A, B, axis, tick)]
      : [...gapGuide(A.hi, lo, A, snappedM, axis, tick), ...gapGuide(hi, B.lo, snappedM, B, axis, tick)];
  return { delta, guides };
}

/** Snap a dragged box: edge/center alignment plus equal-spacing (#110) — per axis,
 *  whichever candidate is closer wins. Returns the position adjustment (`dx`/`dy`,
 *  0 per axis when nothing is within range) and the guides to draw. */
export function computeSnap(
  moving: BBox,
  targets: SnapTargets,
  threshold: number,
): { dx: number; dy: number; guides: GuideLine[] } {
  const xs = [moving.x, moving.x + moving.width / 2, moving.x + moving.width];
  const ys = [moving.y, moving.y + moving.height / 2, moving.y + moving.height];

  const sx = bestSnap(xs, targets.vertical, threshold);
  const sy = bestSnap(ys, targets.horizontal, threshold);
  const px = bestSpacingSnap(moving, targets.boxes, threshold, 'x');
  const py = bestSpacingSnap(moving, targets.boxes, threshold, 'y');
  const spacingX = !!px && (!sx || Math.abs(px.delta) < Math.abs(sx.delta));
  const spacingY = !!py && (!sy || Math.abs(py.delta) < Math.abs(sy.delta));
  const dx = spacingX ? px!.delta : sx ? sx.delta : 0;
  const dy = spacingY ? py!.delta : sy ? sy.delta : 0;

  const nx = moving.x + dx, ny = moving.y + dy;
  const guides: GuideLine[] = [];
  if (spacingX) guides.push(...px!.guides);
  else if (sx) guides.push(...guidesAt(targets.vertical, sx.pos, true, ny, ny + moving.height));
  if (spacingY) guides.push(...py!.guides);
  else if (sy) guides.push(...guidesAt(targets.horizontal, sy.pos, false, nx, nx + moving.width));
  return { dx, dy, guides };
}

/** Snap the moving edge(s) of a resize. `handle` is one of nw/n/ne/e/se/s/sw/w;
 *  the letters say which edges move. Returns adjusted `dx`/`dy` and guides. */
export function computeResizeSnap(
  origBBox: BBox,
  dx: number,
  dy: number,
  handle: string,
  targets: SnapTargets,
  threshold: number,
): { dx: number; dy: number; guides: GuideLine[] } {
  const left = origBBox.x, right = origBBox.x + origBBox.width;
  const top = origBBox.y, bottom = origBBox.y + origBBox.height;

  // Candidate moving edges in their current (dragged) position.
  const xEdges: number[] = [];
  if (handle.includes('w')) xEdges.push(left + dx);
  if (handle.includes('e')) xEdges.push(right + dx);
  const yEdges: number[] = [];
  if (handle.includes('n')) yEdges.push(top + dy);
  if (handle.includes('s')) yEdges.push(bottom + dy);

  const sx = bestSnap(xEdges, targets.vertical, threshold);
  const sy = bestSnap(yEdges, targets.horizontal, threshold);
  if (sx) dx += sx.delta;
  if (sy) dy += sy.delta;

  // Resized box (shared with SelectTool.applyResize via resizeBox) for guide extents.
  const { x: nx, y: ny, width: nw, height: nh } = resizeBox(origBBox, dx, dy, handle);

  const guides: GuideLine[] = [];
  if (sx) guides.push(...guidesAt(targets.vertical, sx.pos, true, ny, ny + nh));
  if (sy) guides.push(...guidesAt(targets.horizontal, sy.pos, false, nx, nx + nw));
  return { dx, dy, guides };
}

/**
 * Aspect-ratio-preserving variant of {@link computeResizeSnap}, used when a
 * corner is dragged with Shift held. The incoming `dx`/`dy` are assumed to
 * already lie on the locked-ratio diagonal. We look for a snap on either moving
 * edge, then apply whichever snaps the corner *least*, deriving the other axis
 * from the aspect ratio so the proportion is kept. Guides are emitted for every
 * target the final moving edges land on — so a corner that hits another corner
 * shows both the horizontal and vertical guide.
 *
 * Non-corner handles (or a degenerate box) fall back to the independent snap.
 */
export function computeResizeSnapProportional(
  origBBox: BBox,
  dx: number,
  dy: number,
  handle: string,
  targets: SnapTargets,
  threshold: number,
): { dx: number; dy: number; guides: GuideLine[] } {
  const hasE = handle.includes('e'), hasW = handle.includes('w');
  const hasN = handle.includes('n'), hasS = handle.includes('s');
  if (!((hasE || hasW) && (hasN || hasS)) || origBBox.width <= 0 || origBBox.height <= 0) {
    return computeResizeSnap(origBBox, dx, dy, handle, targets, threshold);
  }

  const left = origBBox.x, right = origBBox.x + origBBox.width;
  const top = origBBox.y, bottom = origBBox.y + origBBox.height;
  const ratio = origBBox.height / origBBox.width; // dHeight per dWidth

  // Moving edges at the current (ratio-locked) drag position.
  const xEdge = (hasE ? right : left) + dx;
  const yEdge = (hasS ? bottom : top) + dy;
  const sx = bestSnap([xEdge], targets.vertical, threshold);
  const sy = bestSnap([yEdge], targets.horizontal, threshold);

  // Snapping one axis fixes its delta; the other is rebuilt from the ratio.
  const fromX = (ndx: number) => {
    const dW = hasE ? ndx : -ndx;
    const dH = dW * ratio;
    return { dx: ndx, dy: hasS ? dH : -dH };
  };
  const fromY = (ndy: number) => {
    const dH = hasS ? ndy : -ndy;
    const dW = dH / ratio;
    return { dx: hasE ? dW : -dW, dy: ndy };
  };
  // Pick whichever available snap displaces the corner the least from the drag.
  const candidates: { dx: number; dy: number }[] = [];
  if (sx) candidates.push(fromX(dx + sx.delta));
  if (sy) candidates.push(fromY(dy + sy.delta));
  let best: { dx: number; dy: number } | null = null;
  let bestMove = Infinity;
  for (const cand of candidates) {
    const moved = Math.hypot(cand.dx - dx, cand.dy - dy);
    if (moved < bestMove) { best = cand; bestMove = moved; }
  }
  if (best) { dx = best.dx; dy = best.dy; }

  // Rebuild the final box (mirrors applyResize) and draw a guide for any target
  // the moving edges now coincide with.
  let nx = origBBox.x, ny = origBBox.y, nw = origBBox.width, nh = origBBox.height;
  if (hasE) nw += dx;
  if (hasW) { nx += dx; nw -= dx; }
  if (hasS) nh += dy;
  if (hasN) { ny += dy; nh -= dy; }
  const finalX = hasE ? nx + nw : nx;
  const finalY = hasS ? ny + nh : ny;
  const guides: GuideLine[] = [
    ...guidesAt(targets.vertical, finalX, true, ny, ny + nh),
    ...guidesAt(targets.horizontal, finalY, false, nx, nx + nw),
  ];
  return { dx, dy, guides };
}

// ---- Point snap ----
//
// Illustrator's "snap to point": grab a shape BY one of its anchor points and that
// point snaps onto an anchor of any other shape. Box snapping lines up edges and
// centers, which stacks two shapes exactly only when their boxes match — and a
// tweaked copy of a path has a different box from its source, so dragging it back
// by its box lands it a fraction of a unit off everywhere you didn't touch it.
// Dropping one anchor the edit left alone onto the same anchor of the source
// registers the whole shape.

/** Elements that hold definitions or metadata, not artwork — never snap targets. */
const NOT_ARTWORK = new Set([
  'clippath', 'mask', 'defs', 'symbol', 'marker', 'pattern', 'lineargradient',
  'radialgradient', 'filter', 'title', 'desc', 'metadata', 'style', 'script',
]);

/** Every anchor point of `el` and of the artwork inside it, in drawing-layer space.
 *  Rects, ellipses, polygons and lines count through their path form (a rect's
 *  corners, an ellipse's quadrant points). Text, images and instances have none. */
export function anchorPointsOf(el: SVGGraphicsElement, layer: SVGGraphicsElement, out: Point[] = []): Point[] {
  const tag = el.tagName.toLowerCase();
  if (NOT_ARTWORK.has(tag)) return out;
  if (el.getAttribute('display') === 'none' || (el as SVGElement).style?.display === 'none') return out;
  if (tag === 'g' || tag === 'svg' || tag === 'a') {
    for (const c of Array.from(el.children)) anchorPointsOf(c as SVGGraphicsElement, layer, out);
    return out;
  }
  const d = shapeToPathData(el as SVGElement);
  if (!d.trim()) return out;
  const m = matrixBetween(layer, el);
  if (!m) return out;
  for (const sp of parsePath(d).subpaths) {
    for (const a of sp.anchors) {
      out.push({ x: m.a * a.x + m.c * a.y + m.e, y: m.b * a.x + m.d * a.y + m.f });
    }
  }
  return out;
}

/** The anchor of the dragged shapes nearest `pt` within `radius`, or null — the
 *  point the user grabbed the selection by, if they grabbed it by an anchor. */
export function grabAnchor(shapes: ShapeData[], pt: Point, radius: number, svgCanvas: SVGSVGElement): Point | null {
  const layer = svgCanvas.querySelector('#drawing-layer') as unknown as SVGGraphicsElement | null;
  if (!layer) return null;
  const pts: Point[] = [];
  for (const s of shapes) {
    // A frame's own corners are its anchors; its contents ride along but aren't
    // what you hold it by.
    if (s.type !== 'frame') anchorPointsOf(s.element as SVGGraphicsElement, layer, pts);
  }
  return nearestPoint(pts, pt, radius);
}

/** Anchor points of every non-moving, visible, unlocked shape (descending into
 *  groups and frames — a point inside a group is as good a target as any), plus
 *  each other frame's corners. */
export function collectPointTargets(state: AppState, movingIds: Set<string>, svgCanvas: SVGSVGElement): Point[] {
  const layer = svgCanvas.querySelector('#drawing-layer') as unknown as SVGGraphicsElement | null;
  const out: Point[] = [];
  if (!layer) return out;
  for (const ab of state.artboards) {
    if (movingIds.has(ab.id)) continue;
    out.push({ x: ab.x, y: ab.y }, { x: ab.x + ab.width, y: ab.y },
      { x: ab.x + ab.width, y: ab.y + ab.height }, { x: ab.x, y: ab.y + ab.height });
  }
  const visit = (shapes: ShapeData[]): void => {
    for (const shape of shapes) {
      if (movingIds.has(shape.id)) continue;
      if (!shape.visible || shape.locked) continue;
      if ((shape.type === 'frame' || shape.type === 'group') && shape.children) { visit(shape.children); continue; }
      anchorPointsOf(shape.element as SVGGraphicsElement, layer, out);
    }
  };
  visit(state.shapes);
  return out;
}

function nearestPoint(pts: Point[], p: Point, radius: number): Point | null {
  let best: Point | null = null;
  let bestD = radius;
  for (const q of pts) {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d <= bestD) { best = q; bestD = d; }
  }
  return best;
}

/** Snap the grabbed anchor, carried by the raw drag delta, onto the nearest target
 *  anchor within `threshold`. Both axes snap together — a point either lands on the
 *  other point or doesn't snap. The guides outline the point it landed on. */
export function computePointSnap(
  grab: Point, rawDx: number, rawDy: number, targets: Point[], threshold: number,
): { dx: number; dy: number; guides: GuideLine[] } | null {
  const p = { x: grab.x + rawDx, y: grab.y + rawDy };
  const t = nearestPoint(targets, p, threshold);
  if (!t) return null;
  const r = threshold * 0.6;
  const guides: GuideLine[] = [
    { x1: t.x - r, y1: t.y - r, x2: t.x + r, y2: t.y - r },
    { x1: t.x + r, y1: t.y - r, x2: t.x + r, y2: t.y + r },
    { x1: t.x + r, y1: t.y + r, x2: t.x - r, y2: t.y + r },
    { x1: t.x - r, y1: t.y + r, x2: t.x - r, y2: t.y - r },
  ];
  return { dx: t.x - p.x, dy: t.y - p.y, guides };
}

export function drawSnapGuides(guidesLayer: SVGGElement, guides: GuideLine[]): void {
  clearSnapGuides(guidesLayer);
  for (const g of guides) {
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', String(g.x1));
    line.setAttribute('y1', String(g.y1));
    line.setAttribute('x2', String(g.x2));
    line.setAttribute('y2', String(g.y2));
    line.setAttribute('stroke', '#FF00FF');
    line.setAttribute('stroke-width', '1');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    line.setAttribute('pointer-events', 'none');
    line.setAttribute('data-snap-guide', '');
    guidesLayer.appendChild(line);
  }
}

export function clearSnapGuides(guidesLayer: SVGGElement): void {
  guidesLayer.querySelectorAll('[data-snap-guide]').forEach(el => el.remove());
}
