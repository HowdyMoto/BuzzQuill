// ---------------------------------------------------------------------------
// Join (Illustrator's ⌘J): connect the open ends of paths.
//
// - One open path selected: close it.
// - Two open paths selected: join them end to end, at their nearest ends, into one
//   path (the upper one's, so it keeps its appearance and its place in the stack).
// - Node editing with two end points selected: join exactly those ends — the start
//   and end of one open subpath close it; ends of two open subpaths join them.
//
// Ends that sit on top of each other (within a couple of screen pixels) MERGE into
// one anchor that keeps the curve coming in and the curve going out — no kink, no
// zero-length sliver. Ends further apart are connected by a straight segment.
// ---------------------------------------------------------------------------

import { inferType, parsePath, serializePath, transformPathData } from './path-model';
import type { Anchor, PathModel, SubPath } from './path-model';
import type { PathEditSession } from './path-edit';
import { dropParametricAttrs, shapeToPathData } from './shape-adapters';
import { matrixBetween } from './coords';
import { isLockedEl } from './locks';
import type { ShapeData } from './types';

export type End = 'start' | 'end';

const dist = (a: Anchor, b: Anchor): number => Math.hypot(a.x - b.x, a.y - b.y);

/** The same subpath walked the other way: anchors reversed, in/out handles swapped. */
export function reverseSubPath(sp: SubPath): SubPath {
  const anchors = [...sp.anchors].reverse().map((a): Anchor => ({
    x: a.x, y: a.y,
    inX: a.outX, inY: a.outY,
    outX: a.inX, outY: a.inY,
    type: a.type,
  }));
  return { anchors, closed: sp.closed };
}

/** One anchor standing for two coincident ones: at their midpoint, with the curve
 *  coming IN to `incoming` and the curve going OUT of `outgoing`. Each handle moves
 *  with its anchor, so neither curve changes shape. */
function mergeAnchors(incoming: Anchor, outgoing: Anchor): Anchor {
  const x = (incoming.x + outgoing.x) / 2, y = (incoming.y + outgoing.y) / 2;
  const merged: Anchor = { x, y, type: 'corner' };
  if (incoming.inX !== undefined && incoming.inY !== undefined) {
    merged.inX = incoming.inX + (x - incoming.x); merged.inY = incoming.inY + (y - incoming.y);
  }
  if (outgoing.outX !== undefined && outgoing.outY !== undefined) {
    merged.outX = outgoing.outX + (x - outgoing.x); merged.outY = outgoing.outY + (y - outgoing.y);
  }
  merged.type = inferType(merged);
  return merged;
}

/** The new segment between two ends that don't meet is straight, as Join's always
 *  is — so neither end may carry a handle pointing into it. */
function straightenGap(from: Anchor, to: Anchor): void {
  delete from.outX; delete from.outY;
  delete to.inX; delete to.inY;
  from.type = inferType(from);
  to.type = inferType(to);
}

const copy = (sp: SubPath): SubPath => ({ anchors: sp.anchors.map(a => ({ ...a })), closed: sp.closed });

/** A run that closing turns into a shape: open, and more than a straight line
 *  between two points — closing THAT would be a zero-area sliver, invisible and
 *  indistinguishable from doing nothing (a plain <line> used to be offered it). */
export function canClose(sp: SubPath): boolean {
  if (sp.closed || sp.anchors.length < 2) return false;
  if (sp.anchors.length > 2) return true;
  const [a, b] = sp.anchors;
  return a.outX !== undefined || b.inX !== undefined; // a curve between them encloses area
}

/** Close an open subpath. Ends within `tol` merge; otherwise a straight segment
 *  closes it. Null when there is nothing to close. */
export function closeSubPath(sp: SubPath, tol: number): SubPath | null {
  if (!canClose(sp)) return null;
  const out = copy(sp);
  const n = out.anchors.length;
  const first = out.anchors[0], last = out.anchors[n - 1];
  // Two anchors on top of each other would merge into a single point — nothing left
  // to close. Keep both and close with the (zero-length) straight segment instead.
  if (n > 2 && dist(first, last) <= tol) {
    out.anchors = [mergeAnchors(last, first), ...out.anchors.slice(1, n - 1)];
  } else {
    straightenGap(last, first);
  }
  out.closed = true;
  return out;
}

/** Join open subpath `a` at its `aEnd` to open subpath `b` at its `bEnd`. */
export function joinSubPaths(a: SubPath, aEnd: End, b: SubPath, bEnd: End, tol: number): SubPath {
  const A = aEnd === 'end' ? copy(a) : reverseSubPath(a);
  const B = bEnd === 'start' ? copy(b) : reverseSubPath(b);
  const aLast = A.anchors[A.anchors.length - 1], bFirst = B.anchors[0];
  if (dist(aLast, bFirst) <= tol) {
    return { anchors: [...A.anchors.slice(0, -1), mergeAnchors(aLast, bFirst), ...B.anchors.slice(1)], closed: false };
  }
  straightenGap(aLast, bFirst);
  return { anchors: [...A.anchors, ...B.anchors], closed: false };
}

/** The pair of ends, one from each subpath, that lie closest together. */
export function nearestEnds(a: SubPath, b: SubPath): { aEnd: End; bEnd: End } {
  const endOf = (sp: SubPath, e: End) => (e === 'start' ? sp.anchors[0] : sp.anchors[sp.anchors.length - 1]);
  let best: { aEnd: End; bEnd: End; d: number } | null = null;
  for (const aEnd of ['start', 'end'] as End[]) {
    for (const bEnd of ['start', 'end'] as End[]) {
      const d = dist(endOf(a, aEnd), endOf(b, bEnd));
      if (!best || d < best.d) best = { aEnd, bEnd, d };
    }
  }
  return { aEnd: best!.aEnd, bEnd: best!.bEnd };
}

/** The single open subpath of path data, or null (closed, compound, or empty). */
function soleOpenSubPath(d: string): SubPath | null {
  const m = parsePath(d);
  if (m.subpaths.length !== 1) return null;
  const sp = m.subpaths[0];
  return !sp.closed && sp.anchors.length >= 2 ? sp : null;
}

export interface PathJoinHost {
  getSelectedIds(): string[];
  setSelection(ids: string[]): void;
  findShape(id: string): ShapeData | null;
  /** Replace a primitive with an equivalent <path> in place; false if it can't. */
  convertShapeToPath(shape: ShapeData): boolean;
  /** Take a shape out of the document without recording history (one undo step
   *  covers the whole join). */
  detachShape(id: string): void;
  getDrawingLayer(): SVGGElement;
  /** The live node-editing session, or null outside node editing. */
  getEditSession(): PathEditSession | null;
  /** The element node editing reads/writes `d` on. */
  editingGeometryEl(): SVGElement | null;
  /** Write the edit session back to the element and record one undo step. */
  commitPathEdit(): void;
  rebuild(): void;
  saveHistory(): void;
  onChange(): void;
}

/** What ⌘J would do right now. */
type JoinPlan =
  | { kind: 'nodes'; session: PathEditSession; el: SVGElement; a: { sp: number; end: End }; b: { sp: number; end: End } }
  | { kind: 'close-edited'; session: PathEditSession; el: SVGElement; sp: number }
  | { kind: 'close'; shape: ShapeData }
  | { kind: 'join'; shapes: [ShapeData, ShapeData] };

const OPEN_PATH_TYPES: ReadonlyArray<ShapeData['type']> = ['path', 'line', 'polyline'];

export class PathJoinManager {
  private readonly host: PathJoinHost;
  constructor(host: PathJoinHost) { this.host = host; }

  /** An unlocked open path (or a line / polyline, which converts to one) with a
   *  single subpath — the only shapes whose ends Join can connect. */
  private openPathData(s: ShapeData): string | null {
    if (!OPEN_PATH_TYPES.includes(s.type) || isLockedEl(s.element)) return null;
    const d = s.type === 'path' ? (s.element.getAttribute('d') ?? '') : shapeToPathData(s.element);
    return soleOpenSubPath(d) ? d : null;
  }

  private plan(): JoinPlan | null {
    const session = this.host.getEditSession();
    if (session) {
      const el = this.host.editingGeometryEl();
      if (!el) return null;
      const subs = session.model.subpaths;
      const refs = session.selectedRefs();
      if (refs.length === 2) {
        const endOf = (r: { sp: number; i: number }): End | null => {
          const sp = subs[r.sp];
          if (!sp || sp.closed || sp.anchors.length < 2) return null;
          return r.i === 0 ? 'start' : r.i === sp.anchors.length - 1 ? 'end' : null;
        };
        const ea = endOf(refs[0]), eb = endOf(refs[1]);
        if (!ea || !eb) return null;
        if (refs[0].sp === refs[1].sp && !canClose(subs[refs[0].sp])) return null; // both ends of a bare line
        return { kind: 'nodes', session, el, a: { sp: refs[0].sp, end: ea }, b: { sp: refs[1].sp, end: eb } };
      }
      // Nothing (or one point) picked: close the path being edited, if it's one open run.
      const open = subs.map((sp, i) => ({ sp, i })).filter(({ sp }) => canClose(sp));
      return refs.length <= 1 && subs.length === 1 && open.length === 1
        ? { kind: 'close-edited', session, el, sp: open[0].i } : null;
    }
    const shapes = this.host.getSelectedIds().map(id => this.host.findShape(id)).filter((s): s is ShapeData => !!s);
    if (!shapes.every(s => this.openPathData(s) !== null)) return null;
    if (shapes.length === 1) {
      const sp = soleOpenSubPath(this.openPathData(shapes[0]) ?? '');
      return sp && canClose(sp) ? { kind: 'close', shape: shapes[0] } : null;
    }
    if (shapes.length === 2) return { kind: 'join', shapes: [shapes[0], shapes[1]] };
    return null;
  }

  canJoin(): boolean { return this.plan() !== null; }

  /** `tolWorld` is how close (in canvas units) two ends must be to merge — the
   *  caller passes a couple of screen pixels at the current zoom. */
  join(tolWorld: number): boolean {
    const plan = this.plan();
    if (!plan) return false;
    const layer = this.host.getDrawingLayer() as unknown as SVGGraphicsElement;
    // A tolerance the user sees in canvas units, measured in the element's own space.
    const localTol = (el: SVGElement) => {
      const m = matrixBetween(layer, el as unknown as SVGGraphicsElement);
      const s = m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : 1;
      return tolWorld / (s || 1);
    };

    if (plan.kind === 'nodes' || plan.kind === 'close-edited') {
      const { session } = plan;
      const tol = localTol(plan.el);
      const subs = session.model.subpaths;
      if (plan.kind === 'close-edited' || plan.a.sp === plan.b.sp) {
        const i = plan.kind === 'close-edited' ? plan.sp : plan.a.sp;
        const closed = closeSubPath(subs[i], tol);
        if (!closed) return false;
        subs[i] = closed;
      } else {
        const joined = joinSubPaths(subs[plan.a.sp], plan.a.end, subs[plan.b.sp], plan.b.end, tol);
        // The joined run takes the first subpath's place; the second is absorbed.
        subs[plan.a.sp] = joined;
        subs.splice(plan.b.sp, 1);
      }
      session.clearSelection();
      this.host.commitPathEdit();
      return true;
    }

    if (plan.kind === 'close') {
      const shape = plan.shape;
      if (shape.type !== 'path' && !this.host.convertShapeToPath(shape)) return false;
      const el = shape.element;
      const sp = soleOpenSubPath(el.getAttribute('d') ?? '');
      const closed = sp && closeSubPath(sp, localTol(el));
      if (!closed) return false;
      this.writePath(el, { subpaths: [closed] });
      this.host.rebuild();
      this.host.setSelection([shape.id]);
      this.host.saveHistory();
      this.host.onChange();
      return true;
    }

    // Two paths: the UPPER one survives — its appearance, its place in the stack, its
    // coordinate space — and the lower one's geometry is mapped into that space.
    const [p, q] = plan.shapes;
    const upperFirst = !!(q.element.compareDocumentPosition(p.element) & Node.DOCUMENT_POSITION_FOLLOWING);
    const keep = upperFirst ? p : q, other = upperFirst ? q : p;
    for (const s of [keep, other]) {
      if (s.type !== 'path' && !this.host.convertShapeToPath(s)) return false;
    }
    const mk = matrixBetween(layer, keep.element as unknown as SVGGraphicsElement);
    const mo = matrixBetween(layer, other.element as unknown as SVGGraphicsElement);
    if (!mk || !mo) return false;
    const a = soleOpenSubPath(keep.element.getAttribute('d') ?? '');
    const b = soleOpenSubPath(transformPathData(other.element.getAttribute('d') ?? '', mk.inverse().multiply(mo)));
    if (!a || !b) return false;
    const { aEnd, bEnd } = nearestEnds(a, b);
    this.writePath(keep.element, { subpaths: [joinSubPaths(a, aEnd, b, bEnd, localTol(keep.element))] });
    this.host.detachShape(other.id);
    this.host.rebuild();
    this.host.setSelection([keep.id]);
    this.host.saveHistory();
    this.host.onChange();
    return true;
  }

  private writePath(el: SVGElement, model: PathModel): void {
    // Hand-made geometry now: a parametric marker (an arc's data-shape) would
    // regenerate the old shape over it on the next resize.
    dropParametricAttrs(el);
    el.setAttribute('d', serializePath(model));
  }
}
