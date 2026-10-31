/**
 * Parametric library shapes. A `data-shape="pie" | "arc"` marker plus angle params
 * (`data-shape-a0` / `data-shape-a1`, degrees) let the pie/arc's `d` be regenerated
 * from its CURRENT ellipse geometry and those angles. The geometry is parsed back out
 * of the live `d` (the sector's `M` is the centre and its `A` gives the radii; an arc
 * is reconstructed from its endpoints via the SVG centre formula) — so a shape stays
 * parametric through any resize/scale without needing a separate stored box, and it
 * round-trips through the history snapshot for free (it's all attributes + `d`).
 *
 * On-canvas angle handles live in ui/parametric-handles.ts; this module is the pure
 * geometry so it stays testable and decoupled from the DOM chrome.
 */

export type ShapeKind = 'pie' | 'arc' | 'polygon' | 'ring' | 'star' | 'plus';
export interface Geom { cx: number; cy: number; rx: number; ry: number; }

const KINDS = new Set(['pie', 'arc', 'polygon', 'ring', 'star', 'plus']);
const num = (v: number): number => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
/** Regular polygons/stars point straight up (a vertex at the top), like Figma. */
const POLY_ROT = -90;

export function shapeKind(el: Element): ShapeKind | null {
  const k = el.getAttribute('data-shape');
  return k && KINDS.has(k) ? (k as ShapeKind) : null;
}

/** A data-shape number attribute with a fallback + clamp. */
function attrN(el: Element, name: string, dflt: number, lo: number, hi: number): number {
  return clamp(parseFloat(el.getAttribute(name) ?? '') || dflt, lo, hi);
}

export function getAngles(el: Element): [number, number] {
  return [parseFloat(el.getAttribute('data-shape-a0') ?? '0') || 0, parseFloat(el.getAttribute('data-shape-a1') ?? '0') || 0];
}
export function setAngles(el: Element, a0: number, a1: number): void {
  el.setAttribute('data-shape-a0', String(num(a0)));
  el.setAttribute('data-shape-a1', String(num(a1)));
}

/** A point on the ellipse at parametric angle `deg` (0=east, 90=down). */
export function ptOn(g: Geom, deg: number): [number, number] {
  const r = (deg * Math.PI) / 180;
  return [g.cx + g.rx * Math.cos(r), g.cy + g.ry * Math.sin(r)];
}

/** The parametric angle (deg) of a point relative to the ellipse centre. */
export function angleOf(g: Geom, x: number, y: number): number {
  return (Math.atan2((y - g.cy) / (g.ry || 1), (x - g.cx) / (g.rx || 1)) * 180) / Math.PI;
}

function sectorD(g: Geom, a0: number, a1: number): string {
  const [x0, y0] = ptOn(g, a0), [x1, y1] = ptOn(g, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 >= a0 ? 1 : 0;
  return `M ${num(g.cx)} ${num(g.cy)} L ${num(x0)} ${num(y0)} A ${num(g.rx)} ${num(g.ry)} 0 ${large} ${sweep} ${num(x1)} ${num(y1)} Z`;
}
function arcD(g: Geom, a0: number, a1: number): string {
  const [x0, y0] = ptOn(g, a0), [x1, y1] = ptOn(g, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 >= a0 ? 1 : 0;
  return `M ${num(x0)} ${num(y0)} A ${num(g.rx)} ${num(g.ry)} 0 ${large} ${sweep} ${num(x1)} ${num(y1)}`;
}

/** SVG endpoint→centre parametrisation for an axis-aligned (φ=0) arc. */
function arcCentre(x1: number, y1: number, x2: number, y2: number, rx: number, ry: number, fa: number, fs: number): Geom {
  rx = Math.abs(rx); ry = Math.abs(ry);
  const x1p = (x1 - x2) / 2, y1p = (y1 - y2) / 2;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const rx2 = rx * rx, ry2 = ry * ry, x1p2 = x1p * x1p, y1p2 = y1p * y1p;
  const denom = rx2 * y1p2 + ry2 * x1p2 || 1;
  let co = Math.sqrt(Math.max(0, rx2 * ry2 - denom) / denom);
  if (fa === fs) co = -co;
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  return { cx: (x1 + x2) / 2 + cxp, cy: (y1 + y2) / 2 + cyp, rx, ry };
}

/** Recover the ellipse geometry from a pie/arc element's current `d`. */
export function geomOf(el: Element): Geom | null {
  const kind = shapeKind(el);
  const d = el.getAttribute('d') ?? '';
  const nn = '(-?\\d*\\.?\\d+)';
  if (kind === 'pie') {
    const m = d.match(new RegExp(`M\\s*${nn}[ ,]${nn}.*?A\\s*${nn}[ ,]${nn}`));
    if (!m) return null;
    return { cx: +m[1], cy: +m[2], rx: +m[3], ry: +m[4] };
  }
  if (kind === 'arc') {
    const m = d.match(new RegExp(`M\\s*${nn}[ ,]${nn}\\s*A\\s*${nn}[ ,]${nn}\\s+0\\s+([01])\\s+([01])\\s+${nn}[ ,]${nn}`));
    if (!m) return null;
    return arcCentre(+m[1], +m[2], +m[7], +m[8], +m[3], +m[4], +m[5], +m[6]);
  }
  if (kind === 'ring') {
    // The outer ellipse leads: M (cx-rx) cy A rx ry … → cx = mx + rx.
    const m = d.match(new RegExp(`M\\s*${nn}[ ,]${nn}\\s*A\\s*${nn}[ ,]${nn}`));
    if (!m) return null;
    return { cx: +m[1] + +m[3], cy: +m[2], rx: +m[3], ry: +m[4] };
  }
  return null;
}

/** Rebuild the element's `d` from an explicit geometry + its stored angles. Used by
 *  resize (with the new circle box) so the arc is regenerated exactly, never scaled
 *  into béziers — which is what cost the pie its roundness. */
export function regenerateWith(el: SVGElement, g: Geom): void {
  const kind = shapeKind(el);
  if (!kind) return;
  const [a0, a1] = getAngles(el);
  el.setAttribute('d', kind === 'arc' ? arcD(g, a0, a1) : sectorD(g, a0, a1));
}

/** Rebuild `d` from the geometry recovered from the current `d` + stored angles. */
export function regenerate(el: SVGElement): void {
  const g = geomOf(el);
  if (g) regenerateWith(el, g);
}

/** The FULL circle/ellipse bounding box (not the visible wedge's) — the box the pie
 *  is parametrised in, so selection + resize operate on the circle like real tools.
 *  Polygons keep their own tight bbox (null here), so this only affects pie/arc. */
export function boxOf(el: Element): DOMRect | null {
  const k = shapeKind(el);
  if (k !== 'pie' && k !== 'arc' && k !== 'ring') return null;
  const g = geomOf(el);
  return g ? new DOMRect(g.cx - g.rx, g.cy - g.ry, g.rx * 2, g.ry * 2) : null;
}

// ---- Parametric regular polygon (adjustable side count) ---------------------

export interface PolyGeom extends Geom { sides: number; }

export function polySides(el: Element): number {
  const n = Math.round(parseFloat(el.getAttribute('data-shape-sides') ?? '6') || 6);
  return Math.max(3, Math.min(60, n));
}

/** Recover the polygon's inscribing ellipse (cx,cy,rx,ry) + side count from its own
 *  points bbox — the vertices sit at fixed angles, so the bbox spans give rx/ry and
 *  the extremes give the centre. Derived (not stored), so move/resize/undo just work.
 *  Non-uniform resize scales the points, which this reads back as an ellipse. */
export function polyGeom(el: Element): PolyGeom | null {
  if (shapeKind(el) !== 'polygon') return null;
  const sides = polySides(el);
  let bb: DOMRect;
  try { bb = (el as SVGGraphicsElement).getBBox(); } catch { return null; }
  if (!bb || (bb.width === 0 && bb.height === 0)) return null;
  let minC = Infinity, maxC = -Infinity, minS = Infinity, maxS = -Infinity;
  for (let i = 0; i < sides; i++) {
    const a = ((POLY_ROT + (i * 360) / sides) * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    if (c < minC) minC = c; if (c > maxC) maxC = c;
    if (s < minS) minS = s; if (s > maxS) maxS = s;
  }
  const rx = maxC - minC > 1e-6 ? bb.width / (maxC - minC) : bb.width / 2;
  const ry = maxS - minS > 1e-6 ? bb.height / (maxS - minS) : bb.height / 2;
  return { cx: bb.x - rx * minC, cy: bb.y - ry * minS, rx, ry, sides };
}

function polyPointsStr(g: Geom, sides: number): string {
  const out: string[] = [];
  for (let i = 0; i < sides; i++) {
    const a = ((POLY_ROT + (i * 360) / sides) * Math.PI) / 180;
    out.push(`${num(g.cx + g.rx * Math.cos(a))},${num(g.cy + g.ry * Math.sin(a))}`);
  }
  return out.join(' ');
}

/** Rewrite the polygon's points for `sides`, inscribed in geometry `g`. */
export function regeneratePolygon(el: Element, g: Geom, sides: number): void {
  const s = Math.max(3, Math.min(60, Math.round(sides)));
  el.setAttribute('points', polyPointsStr(g, s));
  el.setAttribute('data-shape-sides', String(s));
}

/** Local anchor for the side-count handle: the inscribing circle's right point
 *  (stable while the count changes, so the handle doesn't jump as sides are added). */
export function polyHandlePoint(g: Geom): [number, number] { return [g.cx + g.rx, g.cy]; }

// ---- Ring (adjustable inner radius) ----------------------------------------

function ellipseD(cx: number, cy: number, rx: number, ry: number, cw: number): string {
  return `M ${num(cx - rx)} ${num(cy)} A ${num(rx)} ${num(ry)} 0 1 ${cw} ${num(cx + rx)} ${num(cy)} A ${num(rx)} ${num(ry)} 0 1 ${cw} ${num(cx - rx)} ${num(cy)} Z`;
}
/** Inner-radius ratio (inner ÷ outer), 0.05–0.9. */
export function ringInner(el: Element): number { return attrN(el, 'data-shape-inner', 0.28, 0.05, 0.9); }
/** Rebuild the ring's `d`: outer ellipse + inner hole (evenodd) at ratio `inner`. */
export function regenerateRing(el: Element, g: Geom, inner: number): void {
  const r = clamp(inner, 0.05, 0.9);
  el.setAttribute('d', `${ellipseD(g.cx, g.cy, g.rx, g.ry, 1)} ${ellipseD(g.cx, g.cy, g.rx * r, g.ry * r, 0)}`);
  el.setAttribute('fill-rule', 'evenodd');
  el.setAttribute('data-shape-inner', String(num(r)));
}
/** Local anchor for the inner-radius handle: the right point of the inner circle. */
export function ringHandlePoint(g: Geom, inner: number): [number, number] { return [g.cx + g.rx * inner, g.cy]; }

// ---- Star (adjustable point count + spike depth) ---------------------------

export interface StarGeom extends Geom { points: number; inner: number; }
export function starPointCount(el: Element): number { return Math.round(attrN(el, 'data-shape-sides', 5, 3, 30)); }
export function starInner(el: Element): number { return attrN(el, 'data-shape-inner', 0.4, 0.1, 0.95); }

/** Recover a star's inscribing ellipse from its points bbox (the OUTER spikes set
 *  the bounds, so the same span math as a polygon of `points` sides applies). */
export function starGeom(el: Element): StarGeom | null {
  if (shapeKind(el) !== 'star') return null;
  const points = starPointCount(el), inner = starInner(el);
  let bb: DOMRect;
  try { bb = (el as SVGGraphicsElement).getBBox(); } catch { return null; }
  if (!bb || (bb.width === 0 && bb.height === 0)) return null;
  let minC = Infinity, maxC = -Infinity, minS = Infinity, maxS = -Infinity;
  for (let i = 0; i < points; i++) {
    const a = ((POLY_ROT + (i * 360) / points) * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    if (c < minC) minC = c; if (c > maxC) maxC = c;
    if (s < minS) minS = s; if (s > maxS) maxS = s;
  }
  const rx = maxC - minC > 1e-6 ? bb.width / (maxC - minC) : bb.width / 2;
  const ry = maxS - minS > 1e-6 ? bb.height / (maxS - minS) : bb.height / 2;
  return { cx: bb.x - rx * minC, cy: bb.y - ry * minS, rx, ry, points, inner };
}
function starPointsStr(g: Geom, points: number, inner: number): string {
  const out: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const rr = i % 2 === 0 ? 1 : inner;
    const a = ((POLY_ROT + (i * 180) / points) * Math.PI) / 180;
    out.push(`${num(g.cx + g.rx * rr * Math.cos(a))},${num(g.cy + g.ry * rr * Math.sin(a))}`);
  }
  return out.join(' ');
}
export function regenerateStar(el: Element, g: Geom, points: number, inner: number): void {
  const p = Math.max(3, Math.min(30, Math.round(points)));
  el.setAttribute('points', starPointsStr(g, p, clamp(inner, 0.1, 0.95)));
  el.setAttribute('data-shape-sides', String(p));
  el.setAttribute('data-shape-inner', String(num(clamp(inner, 0.1, 0.95))));
}
/** Count handle (right, stable) and depth handle (first inner spike). */
export function starCountHandlePoint(g: Geom): [number, number] { return [g.cx + g.rx, g.cy]; }
export function starDepthHandlePoint(g: StarGeom, inner: number): [number, number] {
  const a = ((POLY_ROT + 180 / g.points) * Math.PI) / 180; // first inner vertex
  return [g.cx + g.rx * inner * Math.cos(a), g.cy + g.ry * inner * Math.sin(a)];
}

// ---- Plus / cross (adjustable arm thickness) -------------------------------

export function plusArm(el: Element): number { return attrN(el, 'data-shape-arm', 0.34, 0.1, 0.85); }
export function plusBox(el: Element): DOMRect | null {
  if (shapeKind(el) !== 'plus') return null;
  try { const b = (el as SVGGraphicsElement).getBBox(); return b.width || b.height ? b : null; } catch { return null; }
}
export function regeneratePlus(el: Element, box: DOMRect, arm: number): void {
  const { x, y, width: w, height: h } = box;
  const t = Math.min(w, h) * clamp(arm, 0.1, 0.85);
  const ax = x + w / 2 - t / 2, ay = y + h / 2 - t / 2;
  el.setAttribute('points', [
    [ax, y], [ax + t, y], [ax + t, ay], [x + w, ay], [x + w, ay + t], [ax + t, ay + t],
    [ax + t, y + h], [ax, y + h], [ax, ay + t], [x, ay + t], [x, ay], [ax, ay],
  ].map(([px, py]) => `${num(px)},${num(py)}`).join(' '));
  el.setAttribute('data-shape-arm', String(num(clamp(arm, 0.1, 0.85))));
}
/** Arm handle: the right edge of the vertical bar, at mid-height. */
export function plusHandlePoint(box: DOMRect, arm: number): [number, number] {
  return [box.x + box.width / 2 + (Math.min(box.width, box.height) * clamp(arm, 0.1, 0.85)) / 2, box.y + box.height / 2];
}
