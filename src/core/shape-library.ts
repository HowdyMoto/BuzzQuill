/**
 * A library of ready-made, parametric shapes (Freeform-style) that insert without
 * being drawn by hand — pie wedges, arcs, polygons, arrows, symbols, etc. Each entry
 * builds real SVG geometry for a given bounding box (world coordinates), so an
 * inserted shape is an ordinary path/polygon/ellipse that resizes, recolours, and
 * exports like anything else. `open: true` marks stroke-only shapes (arcs/lines) that
 * should get no fill.
 *
 * The picker (ui/shape-picker.ts) renders each `build()` at preview size and inserts
 * it at document size; the geometry is identical, so what you see is what you get.
 */

export interface BuiltShape {
  tag: string;                       // 'path' | 'polygon' | 'ellipse' | 'rect' | 'line'
  attrs: Record<string, string>;     // geometry attributes for that tag
}

export interface ShapeDef {
  id: string;
  name: string;
  category: 'Basic' | 'Round' | 'Arrows' | 'Symbols';
  open?: boolean;                    // stroke-only (no fill): arcs, lines
  /** Marks a shape as PARAMETRIC: it inserts with data-shape params so the on-canvas
   *  handles (ui/parametric-handles.ts) can tweak it — a pie's sweep, or a polygon's
   *  side count. */
  param?:
    | { kind: 'pie' | 'arc'; a0: number; a1: number }
    | { kind: 'polygon'; sides: number }
    | { kind: 'ring'; inner: number }
    | { kind: 'star'; points: number; inner: number }
    | { kind: 'plus'; arm: number };
  build(x: number, y: number, w: number, h: number): BuiltShape;
}

const n = (v: number): number => Math.round(v * 100) / 100;

/** Point on the ellipse (cx,cy,rx,ry) at `deg` (0=east, 90=down in SVG's y-down space). */
function ptOn(cx: number, cy: number, rx: number, ry: number, deg: number): [number, number] {
  const r = (deg * Math.PI) / 180;
  return [n(cx + rx * Math.cos(r)), n(cy + ry * Math.sin(r))];
}

/** Regular-polygon points (n sides) inscribed in the box, first vertex at `rotDeg`. */
function polyPoints(cx: number, cy: number, rx: number, ry: number, sides: number, rotDeg = -90): string {
  const out: string[] = [];
  for (let i = 0; i < sides; i++) {
    out.push(ptOn(cx, cy, rx, ry, rotDeg + (360 / sides) * i).join(','));
  }
  return out.join(' ');
}

/** Star points: `pts` outer spikes alternating with inner vertices at `inner` ratio. */
function starPoints(cx: number, cy: number, rx: number, ry: number, pts: number, inner: number, rotDeg = -90): string {
  const out: string[] = [];
  for (let i = 0; i < pts * 2; i++) {
    const rr = i % 2 === 0 ? 1 : inner;
    out.push(ptOn(cx, cy, rx * rr, ry * rr, rotDeg + (180 / pts) * i).join(','));
  }
  return out.join(' ');
}

/** Filled sector (pie slice) from `a0`→`a1` degrees around (cx,cy). */
function sectorPath(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): string {
  const [x0, y0] = ptOn(cx, cy, rx, ry, a0);
  const [x1, y1] = ptOn(cx, cy, rx, ry, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${n(cx)} ${n(cy)} L ${x0} ${y0} A ${n(rx)} ${n(ry)} 0 ${large} 1 ${x1} ${y1} Z`;
}

/** Open arc (no center, no close) from `a0`→`a1` degrees — a stroked curve. */
function arcPath(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): string {
  const [x0, y0] = ptOn(cx, cy, rx, ry, a0);
  const [x1, y1] = ptOn(cx, cy, rx, ry, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${n(rx)} ${n(ry)} 0 ${large} 1 ${x1} ${y1}`;
}

/** Full ellipse outline as a path (so it can compose with a hole for a ring). */
function ellipsePath(cx: number, cy: number, rx: number, ry: number, cw = 1): string {
  return `M ${n(cx - rx)} ${n(cy)} A ${n(rx)} ${n(ry)} 0 1 ${cw} ${n(cx + rx)} ${n(cy)} A ${n(rx)} ${n(ry)} 0 1 ${cw} ${n(cx - rx)} ${n(cy)} Z`;
}

const path = (d: string): BuiltShape => ({ tag: 'path', attrs: { d } });
const poly = (points: string): BuiltShape => ({ tag: 'polygon', attrs: { points } });

export const SHAPES: ShapeDef[] = [
  // ---- Basic ----
  { id: 'rectangle', name: 'Rectangle', category: 'Basic',
    build: (x, y, w, h) => ({ tag: 'rect', attrs: { x: `${n(x)}`, y: `${n(y)}`, width: `${n(w)}`, height: `${n(h)}` } }) },
  { id: 'rounded-rect', name: 'Rounded rectangle', category: 'Basic',
    build: (x, y, w, h) => ({ tag: 'rect', attrs: { x: `${n(x)}`, y: `${n(y)}`, width: `${n(w)}`, height: `${n(h)}`, rx: `${n(Math.min(w, h) * 0.18)}` } }) },
  { id: 'ellipse', name: 'Ellipse', category: 'Basic',
    build: (x, y, w, h) => ({ tag: 'ellipse', attrs: { cx: `${n(x + w / 2)}`, cy: `${n(y + h / 2)}`, rx: `${n(w / 2)}`, ry: `${n(h / 2)}` } }) },
  { id: 'triangle', name: 'Triangle', category: 'Basic', param: { kind: 'polygon', sides: 3 },
    build: (x, y, w, h) => poly(polyPoints(x + w / 2, y + h / 2, w / 2, h / 2, 3, -90)) },
  { id: 'right-triangle', name: 'Right triangle', category: 'Basic',
    build: (x, y, w, h) => poly(`${n(x)},${n(y)} ${n(x)},${n(y + h)} ${n(x + w)},${n(y + h)}`) },
  { id: 'diamond', name: 'Diamond', category: 'Basic',
    build: (x, y, w, h) => poly(`${n(x + w / 2)},${n(y)} ${n(x + w)},${n(y + h / 2)} ${n(x + w / 2)},${n(y + h)} ${n(x)},${n(y + h / 2)}`) },
  { id: 'pentagon', name: 'Pentagon', category: 'Basic', param: { kind: 'polygon', sides: 5 },
    build: (x, y, w, h) => poly(polyPoints(x + w / 2, y + h / 2, w / 2, h / 2, 5, -90)) },
  { id: 'hexagon', name: 'Hexagon', category: 'Basic', param: { kind: 'polygon', sides: 6 },
    build: (x, y, w, h) => poly(polyPoints(x + w / 2, y + h / 2, w / 2, h / 2, 6, -90)) },
  { id: 'octagon', name: 'Octagon', category: 'Basic', param: { kind: 'polygon', sides: 8 },
    build: (x, y, w, h) => poly(polyPoints(x + w / 2, y + h / 2, w / 2, h / 2, 8, -90)) },
  { id: 'trapezoid', name: 'Trapezoid', category: 'Basic',
    build: (x, y, w, h) => poly(`${n(x + w * 0.22)},${n(y)} ${n(x + w * 0.78)},${n(y)} ${n(x + w)},${n(y + h)} ${n(x)},${n(y + h)}`) },
  { id: 'parallelogram', name: 'Parallelogram', category: 'Basic',
    build: (x, y, w, h) => poly(`${n(x + w * 0.25)},${n(y)} ${n(x + w)},${n(y)} ${n(x + w * 0.75)},${n(y + h)} ${n(x)},${n(y + h)}`) },
  { id: 'star-5', name: '5-point star', category: 'Basic', param: { kind: 'star', points: 5, inner: 0.4 },
    build: (x, y, w, h) => poly(starPoints(x + w / 2, y + h / 2, w / 2, h / 2, 5, 0.4)) },
  { id: 'star-6', name: '6-point star', category: 'Basic', param: { kind: 'star', points: 6, inner: 0.5 },
    build: (x, y, w, h) => poly(starPoints(x + w / 2, y + h / 2, w / 2, h / 2, 6, 0.5)) },

  // ---- Round / parametric ----
  { id: 'semicircle', name: 'Semicircle', category: 'Round',
    build: (x, y, w, h) => path(`M ${n(x)} ${n(y + h)} A ${n(w / 2)} ${n(h)} 0 0 1 ${n(x + w)} ${n(y + h)} Z`) },
  { id: 'quarter-circle', name: 'Quarter circle', category: 'Round',
    build: (x, y, w, h) => path(`M ${n(x)} ${n(y + h)} L ${n(x)} ${n(y)} A ${n(w)} ${n(h)} 0 0 1 ${n(x + w)} ${n(y + h)} Z`) },
  { id: 'pie', name: 'Pie (¾)', category: 'Round', param: { kind: 'pie', a0: -90, a1: 180 },
    build: (x, y, w, h) => path(sectorPath(x + w / 2, y + h / 2, w / 2, h / 2, -90, 180)) },
  { id: 'pie-wedge', name: 'Pie wedge', category: 'Round', param: { kind: 'pie', a0: -126, a1: -54 },
    build: (x, y, w, h) => path(sectorPath(x + w / 2, y + h / 2, w / 2, h / 2, -126, -54)) },
  { id: 'ring', name: 'Ring', category: 'Round', param: { kind: 'ring', inner: 0.28 },
    build: (x, y, w, h) => ({ tag: 'path', attrs: {
      d: `${ellipsePath(x + w / 2, y + h / 2, w / 2, h / 2, 1)} ${ellipsePath(x + w / 2, y + h / 2, w * 0.28, h * 0.28, 0)}`,
      'fill-rule': 'evenodd',
    } }) },
  { id: 'arc', name: 'Arc', category: 'Round', open: true, param: { kind: 'arc', a0: 180, a1: 360 },
    build: (x, y, w, h) => path(arcPath(x + w / 2, y + h, w / 2, h, 180, 360)) },

  // ---- Arrows ----
  { id: 'arrow-right', name: 'Arrow', category: 'Arrows',
    build: (x, y, w, h) => {
      const my = y + h / 2, s = h * 0.28, tail = x + w * 0.62;
      return poly(`${n(x)},${n(my - s)} ${n(tail)},${n(my - s)} ${n(tail)},${n(y)} ${n(x + w)},${n(my)} ${n(tail)},${n(y + h)} ${n(tail)},${n(my + s)} ${n(x)},${n(my + s)}`);
    } },
  { id: 'arrow-double', name: 'Double arrow', category: 'Arrows',
    build: (x, y, w, h) => {
      const my = y + h / 2, s = h * 0.26, l = x + w * 0.32, r = x + w * 0.68;
      return poly(`${n(x)},${n(my)} ${n(l)},${n(y)} ${n(l)},${n(my - s)} ${n(r)},${n(my - s)} ${n(r)},${n(y)} ${n(x + w)},${n(my)} ${n(r)},${n(y + h)} ${n(r)},${n(my + s)} ${n(l)},${n(my + s)} ${n(l)},${n(y + h)}`);
    } },
  { id: 'chevron', name: 'Chevron', category: 'Arrows',
    build: (x, y, w, h) => {
      const my = y + h / 2, t = w * 0.42;
      return poly(`${n(x)},${n(y)} ${n(x + t)},${n(y)} ${n(x + w)},${n(my)} ${n(x + t)},${n(y + h)} ${n(x)},${n(y + h)} ${n(x + w - t)},${n(my)}`);
    } },

  // ---- Symbols ----
  { id: 'plus', name: 'Plus', category: 'Symbols', param: { kind: 'plus', arm: 0.34 },
    build: (x, y, w, h) => {
      const t = Math.min(w, h) * 0.34, cx0 = x + w / 2 - t / 2, cy0 = y + h / 2 - t / 2;
      return poly(`${n(cx0)},${n(y)} ${n(cx0 + t)},${n(y)} ${n(cx0 + t)},${n(cy0)} ${n(x + w)},${n(cy0)} ${n(x + w)},${n(cy0 + t)} ${n(cx0 + t)},${n(cy0 + t)} ${n(cx0 + t)},${n(y + h)} ${n(cx0)},${n(y + h)} ${n(cx0)},${n(cy0 + t)} ${n(x)},${n(cy0 + t)} ${n(x)},${n(cy0)} ${n(cx0)},${n(cy0)}`);
    } },
  { id: 'heart', name: 'Heart', category: 'Symbols',
    build: (x, y, w, h) => path(
      `M ${n(x + w / 2)} ${n(y + h)} C ${n(x - w * 0.05)} ${n(y + h * 0.62)} ${n(x + w * 0.02)} ${n(y + h * 0.08)} ${n(x + w * 0.3)} ${n(y + h * 0.08)} C ${n(x + w * 0.43)} ${n(y + h * 0.08)} ${n(x + w * 0.5)} ${n(y + h * 0.2)} ${n(x + w / 2)} ${n(y + h * 0.28)} C ${n(x + w * 0.5)} ${n(y + h * 0.2)} ${n(x + w * 0.57)} ${n(y + h * 0.08)} ${n(x + w * 0.7)} ${n(y + h * 0.08)} C ${n(x + w * 0.98)} ${n(y + h * 0.08)} ${n(x + w * 1.05)} ${n(y + h * 0.62)} ${n(x + w / 2)} ${n(y + h)} Z`) },
  { id: 'speech', name: 'Speech bubble', category: 'Symbols',
    build: (x, y, w, h) => {
      const bh = h * 0.74, r = Math.min(w, bh) * 0.16;
      return path(
        `M ${n(x + r)} ${n(y)} L ${n(x + w - r)} ${n(y)} Q ${n(x + w)} ${n(y)} ${n(x + w)} ${n(y + r)} L ${n(x + w)} ${n(y + bh - r)} Q ${n(x + w)} ${n(y + bh)} ${n(x + w - r)} ${n(y + bh)} L ${n(x + w * 0.34)} ${n(y + bh)} L ${n(x + w * 0.2)} ${n(y + h)} L ${n(x + w * 0.24)} ${n(y + bh)} L ${n(x + r)} ${n(y + bh)} Q ${n(x)} ${n(y + bh)} ${n(x)} ${n(y + bh - r)} L ${n(x)} ${n(y + r)} Q ${n(x)} ${n(y)} ${n(x + r)} ${n(y)} Z`);
    } },
  { id: 'lightning', name: 'Lightning', category: 'Symbols',
    build: (x, y, w, h) => poly(`${n(x + w * 0.55)},${n(y)} ${n(x + w * 0.1)},${n(y + h * 0.56)} ${n(x + w * 0.45)},${n(y + h * 0.56)} ${n(x + w * 0.4)},${n(y + h)} ${n(x + w * 0.9)},${n(y + h * 0.4)} ${n(x + w * 0.52)},${n(y + h * 0.4)}`) },
];
