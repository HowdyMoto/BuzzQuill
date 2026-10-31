// ---------------------------------------------------------------------------
// Corner rounding & smoothing — the two ways to take the angles out of a path,
// both as ONE-SHOT geometry rewrites: no parameters are stored and no cache is
// regenerated, so the file holds exactly what you see and node editing afterwards
// behaves like any other path.
//
//   • roundPathData(d, r) — FILLET. Straight edges stay straight; each corner is
//     cut back by `r / tan(θ/2)` along both sides (θ = the interior angle) and the
//     two cut points are bridged with one cubic approximating the circular arc.
//     Its handles run toward the old corner at `4/3 · tan(φ/4) · tan(θ/2)` of the
//     cut distance (φ = π − θ, the arc's sweep) — the 0.5523 quarter-circle
//     constant generalised to any angle. This is Illustrator's Round Corners.
//   • smoothPathData(d) — TANGENTS. Every corner gets mirrored handles along the
//     chord between its neighbours: the same Catmull-Rom construction the node
//     editor's Smooth button applies to one node (path-model.setAnchorType),
//     applied to the whole path at once. The outline flows but no longer passes
//     through the old corners the way a fillet does.
//
// Both leave already-smooth anchors alone, so running either twice doesn't creep.
// A radius that doesn't fit is clamped to what the two edges can give (half of
// each), so corners sharing a short edge meet in the middle instead of crossing.
//
// Curved neighbours are handled as well as straight ones: the cut splits the
// curve (de Casteljau) at the point `r / tan(θ/2)` away from the corner, so the
// surviving curve keeps its shape and the fillet leaves it tangentially.
// ---------------------------------------------------------------------------

import { inferType, parsePath, serializePath, setAnchorType } from './path-model';
import type { Anchor, PathModel, SubPath } from './path-model';
import { dropParametricAttrs, shapeToPathData } from './shape-adapters';
import { matrixBetween } from './coords';
import type { ShapeData } from './types';

interface Pt { x: number; y: number }

/** A segment in cubic form. `line` keeps a straight edge straight on output. */
interface Seg { p0: Pt; p1: Pt; p2: Pt; p3: Pt; line: boolean }

/** What a corner will cost: how far back to cut, and the handle fraction. */
interface CornerPlan { trim: number; frac: number }

/** Angles this close to straight (or to a full fold-back) have no fillet to draw. */
const ANGLE_EPS = 0.02;
/** Endpoints closer than this count as coincident (a segment trimmed to nothing). */
const COINCIDENT = 1e-6;

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function unit(from: Pt, to: Pt): Pt | null {
  const dx = to.x - from.x, dy = to.y - from.y;
  const l = Math.hypot(dx, dy);
  return l < COINCIDENT ? null : { x: dx / l, y: dy / l };
}

// ---- segment <-> anchor plumbing -------------------------------------------

function toSegments(sp: SubPath): Seg[] {
  const n = sp.anchors.length;
  const count = sp.closed ? n : n - 1;
  const segs: Seg[] = [];
  for (let i = 0; i < count; i++) {
    const a = sp.anchors[i], b = sp.anchors[(i + 1) % n];
    const hasOut = a.outX !== undefined, hasIn = b.inX !== undefined;
    segs.push({
      p0: { x: a.x, y: a.y },
      p1: hasOut ? { x: a.outX as number, y: a.outY as number } : { x: a.x, y: a.y },
      p2: hasIn ? { x: b.inX as number, y: b.inY as number } : { x: b.x, y: b.y },
      p3: { x: b.x, y: b.y },
      line: !hasOut && !hasIn,
    });
  }
  return segs;
}

function toSubPath(segs: Seg[], closed: boolean): SubPath {
  const anchors: Anchor[] = [];
  const n = segs.length;
  for (let i = 0; i < n; i++) {
    const seg = segs[i];
    const prev = i === 0 ? (closed ? segs[n - 1] : null) : segs[i - 1];
    const a: Anchor = { x: seg.p0.x, y: seg.p0.y, type: 'corner' };
    if (prev && !prev.line) { a.inX = prev.p2.x; a.inY = prev.p2.y; }
    if (!seg.line) { a.outX = seg.p1.x; a.outY = seg.p1.y; }
    a.type = inferType(a);
    anchors.push(a);
  }
  if (!closed && n > 0) {
    const last = segs[n - 1];
    const a: Anchor = { x: last.p3.x, y: last.p3.y, type: 'corner' };
    if (!last.line) { a.inX = last.p2.x; a.inY = last.p2.y; }
    a.type = inferType(a);
    anchors.push(a);
  }
  return { anchors, closed };
}

// ---- cubic helpers ----------------------------------------------------------

function cubicAt(s: Seg, t: number): Pt {
  const a = lerp(s.p0, s.p1, t), b = lerp(s.p1, s.p2, t), c = lerp(s.p2, s.p3, t);
  return lerp(lerp(a, b, t), lerp(b, c, t), t);
}

/** de Casteljau split; returns the piece before t and the piece after it. */
function splitCubic(s: Seg, t: number): [Seg, Seg] {
  const a = lerp(s.p0, s.p1, t), b = lerp(s.p1, s.p2, t), c = lerp(s.p2, s.p3, t);
  const d = lerp(a, b, t), e = lerp(b, c, t);
  const mid = lerp(d, e, t);
  return [
    { p0: s.p0, p1: a, p2: d, p3: mid, line: false },
    { p0: mid, p1: e, p2: c, p3: s.p3, line: false },
  ];
}

/** The parameter at which the curve is `len` away (straight-line) from one end.
 *  Bisection: near an endpoint the distance grows monotonically with t. */
function paramAtDistance(s: Seg, len: number, from: 'start' | 'end'): number {
  const anchor = from === 'start' ? s.p0 : s.p3;
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const p = cubicAt(s, from === 'start' ? mid : 1 - mid);
    if (dist(p, anchor) < len) lo = mid; else hi = mid;
  }
  const t = (lo + hi) / 2;
  return from === 'start' ? t : 1 - t;
}

/** Drop `len` from the segment's start, keeping the far part. */
function trimStart(s: Seg, len: number): Seg {
  if (len <= 0) return s;
  if (s.line) {
    const total = dist(s.p0, s.p3);
    if (total < COINCIDENT) return s;
    const p0 = lerp(s.p0, s.p3, Math.min(1, len / total));
    return { p0, p1: p0, p2: s.p3, p3: s.p3, line: true };
  }
  return splitCubic(s, paramAtDistance(s, len, 'start'))[1];
}

/** Drop `len` from the segment's end, keeping the near part. */
function trimEnd(s: Seg, len: number): Seg {
  if (len <= 0) return s;
  if (s.line) {
    const total = dist(s.p0, s.p3);
    if (total < COINCIDENT) return s;
    const p3 = lerp(s.p3, s.p0, Math.min(1, len / total));
    return { p0: s.p0, p1: s.p0, p2: p3, p3, line: true };
  }
  return splitCubic(s, paramAtDistance(s, len, 'end'))[0];
}

/** The direction a segment leaves its start / arrives at its end, taken from the
 *  nearest control point that isn't sitting on the endpoint itself. */
const dirAtStart = (s: Seg): Pt | null => unit(s.p0, s.p1) ?? unit(s.p0, s.p2) ?? unit(s.p0, s.p3);
const dirAtEnd = (s: Seg): Pt | null => unit(s.p3, s.p2) ?? unit(s.p3, s.p1) ?? unit(s.p3, s.p0);

/** How far a segment can give up at each end: half of it, so the two corners on a
 *  short edge meet in the middle rather than crossing past each other. */
const halfSpan = (s: Seg): number => dist(s.p0, s.p3) / 2;

/** Plan the fillet at the joint where `inSeg` meets `outSeg`, or null when there's
 *  no corner to round (already tangent, or folded back on itself). */
function planCorner(inSeg: Seg, outSeg: Seg, radius: number): CornerPlan | null {
  const back = dirAtEnd(inSeg);        // back along the incoming edge
  const fwd = dirAtStart(outSeg);      // forward along the outgoing edge
  if (!back || !fwd) return null;
  const dot = Math.max(-1, Math.min(1, back.x * fwd.x + back.y * fwd.y));
  const theta = Math.acos(dot);        // interior angle at the corner
  if (theta <= ANGLE_EPS || theta >= Math.PI - ANGLE_EPS) return null;
  const phi = Math.PI - theta;         // the arc's sweep
  return {
    trim: radius / Math.tan(theta / 2),
    frac: (4 / 3) * Math.tan(phi / 4) * Math.tan(theta / 2),
  };
}

function roundSubPath(sp: SubPath, radius: number): SubPath | null {
  // A zero-length straight segment (a doubled point) has no direction, so the
  // corner on either side of it read as "no corner" and stayed sharp. Dropping it
  // loses nothing: its neighbours already meet at that point.
  const segs = toSegments(sp).filter(s => !s.line || dist(s.p0, s.p3) > COINCIDENT);
  const n = segs.length;
  if (n < 2) return null;
  const joints = sp.closed ? n : n - 1; // joint j joins segment j to segment j+1

  const plans: (CornerPlan | null)[] = [];
  for (let j = 0; j < joints; j++) {
    // Only round anchors that ARE corners: a joint whose handles already run
    // straight through (a smooth point) has nothing to fillet.
    plans.push(planCorner(segs[j], segs[(j + 1) % n], radius));
  }
  // Clamp each cut to half of both edges it eats into.
  for (let j = 0; j < joints; j++) {
    const p = plans[j];
    if (!p) continue;
    p.trim = Math.min(p.trim, halfSpan(segs[j]), halfSpan(segs[(j + 1) % n]));
    if (p.trim < COINCIDENT) plans[j] = null;
  }
  if (!plans.some(Boolean)) return null;

  // Trim every segment first, so a fillet can join two already-trimmed ends.
  const trimmed = segs.map((s, i) => {
    const startJoint = sp.closed ? (i - 1 + n) % n : i - 1;
    let out = s;
    if (startJoint >= 0 && startJoint < joints && plans[startJoint]) {
      out = trimStart(out, (plans[startJoint] as CornerPlan).trim);
    }
    if (i < joints && plans[i]) out = trimEnd(out, (plans[i] as CornerPlan).trim);
    return out;
  });

  const out: Seg[] = [];
  for (let i = 0; i < n; i++) {
    // A segment eaten entirely by its two corners leaves nothing to draw.
    if (dist(trimmed[i].p0, trimmed[i].p3) > COINCIDENT) out.push(trimmed[i]);
    const plan = i < joints ? plans[i] : null;
    if (!plan) continue;
    const corner = segs[i].p3;                 // the original, un-trimmed corner
    const t1 = trimmed[i].p3, t2 = trimmed[(i + 1) % n].p0;
    out.push({ p0: t1, p1: lerp(t1, corner, plan.frac), p2: lerp(t2, corner, plan.frac), p3: t2, line: false });
  }
  return out.length ? toSubPath(out, sp.closed) : null;
}

/** Round every corner of a path's geometry. Returns `d` unchanged when nothing
 *  could be rounded (no corners, or a radius of zero). */
export function roundPathData(d: string, radius: number): string {
  if (!(radius > 0)) return d;
  let model: PathModel;
  try { model = parsePath(d); } catch { return d; }
  let changed = false;
  for (let i = 0; i < model.subpaths.length; i++) {
    const rounded = roundSubPath(model.subpaths[i], radius);
    if (rounded) { model.subpaths[i] = rounded; changed = true; }
  }
  return changed ? serializePath(model) : d;
}

/** Give every corner mirrored handles (Catmull-Rom). Open-path endpoints keep
 *  their shape — they have only one neighbour, so there's no chord to follow. */
export function smoothPathData(d: string): string {
  let model: PathModel;
  try { model = parsePath(d); } catch { return d; }
  let changed = false;
  for (const sp of model.subpaths) {
    const n = sp.anchors.length;
    for (let i = 0; i < n; i++) {
      if (!sp.closed && (i === 0 || i === n - 1)) continue;
      if (sp.anchors[i].type === 'smooth') continue; // already smooth — leave it be
      setAnchorType(sp, i, 'smooth');
      changed = true;
    }
  }
  return changed ? serializePath(model) : d;
}

// ---- applying it to the selection -------------------------------------------

/** Types whose geometry can become a path (primitives convert in place). */
const ROUNDABLE: ReadonlyArray<ShapeData['type']> =
  ['path', 'rect', 'ellipse', 'line', 'polyline', 'polygon'];

export interface CornerHost {
  getSelectedIds(): string[];
  findShape(id: string): ShapeData | null;
  /** Replace a primitive with an equivalent <path> in place; false if it can't. */
  convertShapeToPath(shape: ShapeData): boolean;
  /** The world (drawing-layer) space a radius is measured in. */
  getDrawingLayer(): SVGGElement;
  /** Re-derive the shape tree — a cancelled preview puts real elements back. */
  rebuild(): void;
  saveHistory(): void;
  onChange(): void;
}

/** The shape's geometry as path data, without converting anything yet. */
function pathDataOf(s: ShapeData): string {
  return s.type === 'path' ? (s.element.getAttribute('d') ?? '') : shapeToPathData(s.element);
}

/** Per-shape running-preview state: what to restore, what to round, at what scale. */
interface PreviewEntry { id: string; markup: string; base: string; scale: number }

/**
 * Round Corners / Smooth over the current selection.
 *
 * The Round Corners dialog drives a LIVE preview: `beginPreview` converts the
 * primitives once and remembers each shape's markup, every radius change redraws
 * from the remembered geometry (never from the last preview, which would round
 * already-rounded corners), and Cancel puts the original elements back — so a
 * cancelled preview leaves no trace and costs no undo step. Committing puts back
 * every shape the radius didn't change, so an ellipse in the selection (no corners)
 * stays an ellipse rather than turning into a path behind the user's back.
 *
 * The radius is in WORLD units — what the dialog shows, sized from the selection's
 * on-canvas bounds — and is divided by each shape's own scale before rounding its
 * local geometry, so a shape drawn small and scaled up gets the radius you asked for.
 */
export class CornerManager {
  private host: CornerHost;
  private preview: PreviewEntry[] | null = null;

  constructor(host: CornerHost) { this.host = host; }

  /** How much the shape's local units are magnified on the canvas (area scale's
   *  square root, so a non-uniform scale gets its geometric mean). */
  private worldScale(el: SVGElement): number {
    const m = matrixBetween(this.host.getDrawingLayer(), el as unknown as SVGGraphicsElement);
    const s = m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : 1;
    return s > 1e-9 && Number.isFinite(s) ? s : 1;
  }

  /** Selected shapes with geometry these ops can rewrite. */
  private targets(): ShapeData[] {
    return this.host.getSelectedIds()
      .map(id => this.host.findShape(id))
      .filter((s): s is ShapeData => !!s && !s.locked && ROUNDABLE.includes(s.type));
  }

  /** True when the current selection has something to round or smooth. */
  canApply(): boolean { return this.targets().length > 0; }

  /** A preview is running: the document holds geometry nobody has committed yet. */
  previewing(): boolean { return this.preview !== null; }

  /** Rewrite each target's geometry; true if any shape actually changed. A shape
   *  is converted to a path only once its rewrite is known to change it — a no-op
   *  (Round on an ellipse) used to leave a converted path behind with no undo step,
   *  so the next Ctrl+Z deleted the shape. */
  private applyToTargets(shapes: ShapeData[], rewrite: (d: string, s: ShapeData) => string): boolean {
    let changed = false;
    for (const s of shapes) {
      const d = pathDataOf(s);
      if (!d.trim()) continue;
      const out = rewrite(d, s);
      if (!out || out === d) continue;
      if (s.type !== 'path' && !this.host.convertShapeToPath(s)) continue;
      s.element.setAttribute('d', out);
      dropParametricAttrs(s.element);
      changed = true;
    }
    return changed;
  }

  /** Smooth every corner of every selected path — one undo step. */
  smoothSelected(): boolean {
    const changed = this.applyToTargets(this.targets(), smoothPathData);
    if (!changed) return false;
    this.host.saveHistory();
    this.host.onChange();
    return true;
  }

  /** Round corners without a preview (one undo step). `radius` is in world units. */
  roundSelected(radius: number): boolean {
    const changed = this.applyToTargets(this.targets(),
      (d, s) => roundPathData(d, radius / this.worldScale(s.element)));
    if (!changed) return false;
    this.host.saveHistory();
    this.host.onChange();
    return true;
  }

  /** Start a live preview: convert primitives once and remember the originals. */
  beginPreview(): boolean {
    const shapes = this.targets();
    if (shapes.length === 0) return false;
    const entries: PreviewEntry[] = [];
    for (const s of shapes) {
      const markup = s.element.outerHTML;
      const scale = this.worldScale(s.element);
      if (s.type !== 'path' && !this.host.convertShapeToPath(s)) continue;
      const base = s.element.getAttribute('d') ?? '';
      if (!base.trim()) continue;
      entries.push({ id: s.id, markup, base, scale });
    }
    if (entries.length === 0) return false;
    this.preview = entries;
    return true;
  }

  /** Redraw the preview at a radius. Always rounds the REMEMBERED geometry. */
  previewRadius(radius: number): void {
    if (!this.preview) return;
    for (const e of this.preview) {
      const shape = this.host.findShape(e.id);
      if (shape) shape.element.setAttribute('d', roundPathData(e.base, radius / e.scale));
    }
    this.host.onChange();
  }

  /** Keep what the preview shows: one undo step for the whole operation. Shapes
   *  the radius left unchanged go back exactly as they were. */
  commitPreview(): boolean {
    if (!this.preview) return false;
    const entries = this.preview;
    this.preview = null;
    const unchanged: PreviewEntry[] = [];
    let kept = false;
    for (const e of entries) {
      const shape = this.host.findShape(e.id);
      if (!shape) continue;
      if (shape.element.getAttribute('d') === e.base) { unchanged.push(e); continue; }
      dropParametricAttrs(shape.element);
      kept = true;
    }
    if (unchanged.length) { this.restore(unchanged); this.host.rebuild(); }
    if (!kept) { this.host.onChange(); return false; }
    this.host.saveHistory();
    this.host.onChange();
    return true;
  }

  /** Put the original elements back — including any primitive this op converted. */
  cancelPreview(): void {
    if (!this.preview) return;
    this.restore(this.preview);
    this.preview = null;
    this.host.rebuild(); // a primitive may have come back as <rect>/<polygon> again
    this.host.onChange();
  }

  private restore(entries: PreviewEntry[]): void {
    for (const e of entries) {
      const shape = this.host.findShape(e.id);
      if (!shape) continue;
      const holder = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      holder.innerHTML = e.markup;
      const original = holder.firstElementChild as SVGGraphicsElement | null;
      if (!original) continue;
      shape.element.replaceWith(original);
      shape.element = original;
    }
  }
}
