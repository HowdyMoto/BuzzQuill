/**
 * A live node-editing session for a single path element. Holds the parsed
 * {@link PathModel}, the current anchor selection, and the editing operations
 * the Pen / Direct-Selection tools drive. All coordinates here are in the
 * element's *local* space (the tools convert pointer coords before calling in).
 *
 * Lives on AppState so the tool (mutates), the overlay (renders) and the
 * Properties panel (reads/sets type) share one source of truth.
 */
import {
  parsePath, serializePath, setAnchorType, insertAnchorAt, deleteAnchor, inferType,
  reverseSubPath, reversedAnchorIndex,
  type PathModel, type Anchor, type AnchorType,
} from './path-model';

export type HandleWhich = 'in' | 'out';

export interface AnchorRef { sp: number; i: number; }
export interface HandleHit extends AnchorRef { which: HandleWhich; }
export interface SegmentHit { sp: number; seg: number; t: number; }

const key = (sp: number, i: number) => `${sp}:${i}`;

export class PathEditSession {
  model: PathModel;
  /** Selected anchors as "sp:i" keys. */
  selected = new Set<string>();

  constructor(d: string) {
    this.model = parsePath(d);
  }

  commit(): string {
    return serializePath(this.model);
  }

  get isEmpty(): boolean {
    return this.model.subpaths.every(sp => sp.anchors.length === 0);
  }

  anchor(ref: AnchorRef): Anchor | undefined {
    return this.model.subpaths[ref.sp]?.anchors[ref.i];
  }

  // ---- selection ----

  isSelected(sp: number, i: number): boolean { return this.selected.has(key(sp, i)); }
  selectOnly(sp: number, i: number): void { this.selected.clear(); this.selected.add(key(sp, i)); }
  addSelect(sp: number, i: number): void { this.selected.add(key(sp, i)); }
  toggleSelect(sp: number, i: number): void {
    const k = key(sp, i);
    if (this.selected.has(k)) this.selected.delete(k); else this.selected.add(k);
  }
  clearSelection(): void { this.selected.clear(); }

  selectedRefs(): AnchorRef[] {
    return [...this.selected].map(k => {
      const [sp, i] = k.split(':').map(Number);
      return { sp, i };
    });
  }

  /** The single selected anchor's type, or null if 0 or mixed. */
  selectionType(): AnchorType | null {
    const refs = this.selectedRefs();
    if (refs.length === 0) return null;
    let t: AnchorType | null = null;
    for (const r of refs) {
      const a = this.anchor(r);
      if (!a) continue;
      if (t === null) t = a.type;
      else if (t !== a.type) return null;
    }
    return t;
  }

  // ---- editing ops ----

  /** Run the whole path the other way. The picked points stay picked: they're the
   *  same points, now at different indices. */
  reverse(): void {
    const lengths = this.model.subpaths.map(sp => sp.anchors.length);
    const closed = this.model.subpaths.map(sp => sp.closed);
    const picked = this.selectedRefs();
    this.model.subpaths = this.model.subpaths.map(reverseSubPath);
    this.selected = new Set(picked.map(r => key(r.sp, reversedAnchorIndex(r.i, lengths[r.sp], closed[r.sp]))));
  }

  /** Move an anchor and both its handles by (dx, dy). */
  moveAnchor(sp: number, i: number, dx: number, dy: number): void {
    const a = this.model.subpaths[sp]?.anchors[i];
    if (!a) return;
    a.x += dx; a.y += dy;
    if (a.inX !== undefined) { a.inX += dx; a.inY! += dy; }
    if (a.outX !== undefined) { a.outX += dx; a.outY! += dy; }
  }

  /** Move all currently-selected anchors by (dx, dy). */
  moveSelected(dx: number, dy: number): void {
    for (const r of this.selectedRefs()) this.moveAnchor(r.sp, r.i, dx, dy);
  }

  /**
   * Drag a control handle to (x, y). For smooth anchors the opposite handle is
   * mirrored (equal length, opposite direction). Alt breaks the link, demoting
   * the anchor to `broken`.
   */
  moveHandle(sp: number, i: number, which: HandleWhich, x: number, y: number, alt = false): void {
    const a = this.model.subpaths[sp]?.anchors[i];
    if (!a) return;
    if (which === 'in') { a.inX = x; a.inY = y; } else { a.outX = x; a.outY = y; }

    if (alt) { a.type = 'broken'; return; }

    if (a.type === 'smooth') {
      // Mirror the opposite handle: same distance, opposite direction.
      const hx = x - a.x, hy = y - a.y;
      if (which === 'in') {
        if (a.outX !== undefined) {
          const outLen = Math.hypot(a.outX - a.x, a.outY! - a.y) || Math.hypot(hx, hy);
          const m = Math.hypot(hx, hy) || 1;
          a.outX = a.x - (hx / m) * outLen; a.outY = a.y - (hy / m) * outLen;
        }
      } else {
        if (a.inX !== undefined) {
          const inLen = Math.hypot(a.x - a.inX, a.y - a.inY!) || Math.hypot(hx, hy);
          const m = Math.hypot(hx, hy) || 1;
          // Opposite side of the anchor (subtract), so the handles stay
          // collinear-opposite and the point reads as a smooth curve.
          a.inX = a.x - (hx / m) * inLen; a.inY = a.y - (hy / m) * inLen;
        }
      }
    } else {
      a.type = inferType(a);
    }
  }

  setSelectedType(type: AnchorType): void {
    for (const r of this.selectedRefs()) {
      const sp = this.model.subpaths[r.sp];
      if (sp) setAnchorType(sp, r.i, type);
    }
  }

  /** Delete selected anchors; prunes subpaths that fall below 2 anchors. Returns true if anything changed. */
  deleteSelected(): boolean {
    const refs = this.selectedRefs();
    if (refs.length === 0) return false;
    // Delete from highest index down so earlier indices stay valid.
    refs.sort((a, b) => (a.sp - b.sp) || (b.i - a.i));
    for (const r of refs) {
      const sp = this.model.subpaths[r.sp];
      if (sp) deleteAnchor(sp, r.i);
    }
    this.model.subpaths = this.model.subpaths.filter(sp => sp.anchors.length >= 2);
    this.selected.clear();
    return true;
  }

  insertAt(hit: SegmentHit): AnchorRef {
    const sp = this.model.subpaths[hit.sp];
    const newIndex = insertAnchorAt(sp, hit.seg, hit.t);
    return { sp: hit.sp, i: newIndex };
  }

  // ---- hit testing (local coords) ----

  hitHandle(px: number, py: number, tol: number): HandleHit | null {
    for (const r of this.selectedRefs()) {
      const a = this.anchor(r);
      if (!a) continue;
      if (a.outX !== undefined && Math.hypot(a.outX - px, a.outY! - py) <= tol) return { ...r, which: 'out' };
      if (a.inX !== undefined && Math.hypot(a.inX - px, a.inY! - py) <= tol) return { ...r, which: 'in' };
    }
    return null;
  }

  hitAnchor(px: number, py: number, tol: number): AnchorRef | null {
    for (let sp = 0; sp < this.model.subpaths.length; sp++) {
      const anchors = this.model.subpaths[sp].anchors;
      for (let i = 0; i < anchors.length; i++) {
        if (Math.hypot(anchors[i].x - px, anchors[i].y - py) <= tol) return { sp, i };
      }
    }
    return null;
  }

  /**
   * Find the nearest segment within tol. A straight segment is measured exactly.
   * A curve is sampled at a density set by its length and the tolerance — never a
   * fixed count: 24 samples on a 500-unit segment sat ~21 units apart, so a click
   * between two of them was "not on the path" and a double-click on a long path
   * inserted nothing (and the press that preceded it left the edit). The best
   * sample is then refined by bisection, so the returned t is where the click was.
   */
  hitSegment(px: number, py: number, tol: number): SegmentHit | null {
    let best: SegmentHit | null = null;
    let bestDist = tol;
    for (let sp = 0; sp < this.model.subpaths.length; sp++) {
      const path = this.model.subpaths[sp];
      const n = path.anchors.length;
      const segCount = path.closed ? n : n - 1;
      for (let seg = 0; seg < segCount; seg++) {
        const a = path.anchors[seg];
        const b = path.anchors[(seg + 1) % n];
        const hit = nearestOnSegment(a, b, px, py, tol);
        if (hit && hit.dist < bestDist) { bestDist = hit.dist; best = { sp, seg, t: hit.t }; }
      }
    }
    return best;
  }
}

/** Nearest point of the segment a→b to (px, py), as its parameter and distance,
 *  or null when the whole segment is clearly farther than tol. */
function nearestOnSegment(a: Anchor, b: Anchor, px: number, py: number, tol: number): { t: number; dist: number } | null {
  const c1x = a.outX ?? a.x, c1y = a.outY ?? a.y;
  const c2x = b.inX ?? b.x, c2y = b.inY ?? b.y;
  const straight = a.outX === undefined && b.inX === undefined;

  if (straight) {
    // Exact projection onto the line segment.
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
    return { t, dist: Math.hypot(a.x + dx * t - px, a.y + dy * t - py) };
  }

  const at = (t: number): [number, number] => {
    const u = 1 - t;
    return [
      u * u * u * a.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * b.x,
      u * u * u * a.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * b.y,
    ];
  };
  // Quick reject: the curve lies inside its control polygon's bounding box.
  const minX = Math.min(a.x, c1x, c2x, b.x), maxX = Math.max(a.x, c1x, c2x, b.x);
  const minY = Math.min(a.y, c1y, c2y, b.y), maxY = Math.max(a.y, c1y, c2y, b.y);
  if (px < minX - tol || px > maxX + tol || py < minY - tol || py > maxY + tol) return null;

  // Samples no farther apart than half the tolerance (the control polygon bounds
  // the curve's length), so a point within tol of the curve is within tol of a sample.
  const polyLen = Math.hypot(c1x - a.x, c1y - a.y) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(b.x - c2x, b.y - c2y);
  const samples = Math.max(8, Math.min(2000, Math.ceil(polyLen / Math.max(tol / 2, 0.01))));
  let bestT = 0, bestD = Infinity;
  for (let s = 0; s <= samples; s++) {
    const t = s / samples;
    const [x, y] = at(t);
    const d = Math.hypot(x - px, y - py);
    if (d < bestD) { bestD = d; bestT = t; }
  }
  // Refine around the best sample so the inserted point lands under the pointer.
  let lo = Math.max(0, bestT - 1 / samples), hi = Math.min(1, bestT + 1 / samples);
  for (let i = 0; i < 20; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    const [x1, y1] = at(m1), [x2, y2] = at(m2);
    if (Math.hypot(x1 - px, y1 - py) < Math.hypot(x2 - px, y2 - py)) hi = m2; else lo = m1;
  }
  const t = (lo + hi) / 2;
  const [x, y] = at(t);
  const d = Math.hypot(x - px, y - py);
  return d <= bestD ? { t, dist: d } : { t: bestT, dist: bestD };
}
