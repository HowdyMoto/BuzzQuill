/**
 * Track layouts for TraceCraft: one circuit layout per file, written in exactly the
 * shape TraceCraft reads, so the file needs no clean-up afterwards. Its contract:
 *
 * - a bare `<svg viewBox>` — no width/height, only the SVG namespace;
 * - exactly ONE closed `<path>`: the circuit's centerline, a single subpath ending in Z;
 * - optionally ONE open `<path id="pit-lane">`, drawn in race direction (first point
 *   = pit entry, last = pit exit), both ends on the circuit;
 * - nothing else: no frame, background, image, defs, groups, ids or editor metadata;
 * - every transform baked in, coordinates in the ARTBOARD's own space (frame-local,
 *   never re-origined per file), because every layout of a circuit comes from one
 *   frame and TraceCraft overlays them on that shared frame;
 * - viewBox = the circuit's bounding box + 4 units each side (the pit lane and the
 *   frame don't count);
 * - absolute M / L / C / Z only — arcs become cubics (TraceCraft draws an arc as a
 *   straight line) — at two decimals.
 *
 * A layout is found from a selection: a closed path is a circuit; an open path is
 * its pit lane when selected with it or named "pit-lane" beside it. Selecting a group
 * or frame finds every layout inside it, so a group holding two loops and one pit
 * lane gives two files that share the pit lane.
 */

import type { ShapeData } from './types';
import { localPathData } from './boolean';
import { parsePath, type SubPath } from './path-model';
import { matrixToAncestor, ownTransformMatrix } from './coords';

export const PIT_LANE_ID = 'pit-lane';
export const VIEWBOX_MARGIN = 4;
/** How far (canvas units) a pit-lane end may sit from the circuit and still count as on it. */
export const ON_CIRCUIT_TOLERANCE = 0.5;
/** An open path whose ends are closer than this is a closed loop drawn without a Z. */
const SELF_CLOSE_EPS = 0.01;

/** A layer name that marks a pit lane: "pit-lane", "Pit Lane", "pit_lane", "pitlane". */
export function isPitLaneName(name: string): boolean {
  return /^pit[\s_-]*lane$/i.test(name.trim());
}

export interface TrackLayout {
  /** The circuit's layer name — the layout part of the filename. */
  name: string;
  circuit: ShapeData;
  pitLane: ShapeData | null;
  /** Name of the frame whose coordinates the file is in (null = the canvas). */
  frameName: string | null;
  /** The finished file. */
  svg: string;
  /** Things TraceCraft would object to that we can't fix for the user. */
  notes: string[];
}

export interface TrackLayoutScan {
  layouts: TrackLayout[];
  /** Selected objects that couldn't be used, and why. */
  skipped: string[];
}

interface Outline { shape: ShapeData; sp: SubPath | null; subpaths: number }

/**
 * Every layout in `roots`. `selected` says the roots are the user's selection (an
 * open path in it is a pit lane whatever its name, and anything unusable is
 * reported) rather than the whole document. `siblingsOf` returns the shapes beside
 * a shape in its parent (the document's top level for a top-level shape), so a
 * circuit selected on its own still finds its pit lane.
 */
export function collectTrackLayouts(
  roots: ShapeData[],
  selected: boolean,
  siblingsOf: (shape: ShapeData) => ShapeData[],
): TrackLayoutScan {
  const skipped: string[] = [];
  const explicit = new Set<ShapeData>();
  const leaves: ShapeData[] = [];
  const seen = new Set<string>();
  const walk = (s: ShapeData, isRoot: boolean) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    if (s.children && s.children.length && (s.type === 'group' || s.type === 'frame' || s.type === 'repeat')) {
      for (const c of s.children) walk(c, false);
      return;
    }
    leaves.push(s);
    if (isRoot && selected) explicit.add(s);
  };
  for (const r of roots) walk(r, true);

  const outlines = new Map<ShapeData, Outline>();
  const outlineOf = (s: ShapeData): Outline => {
    let o = outlines.get(s);
    if (!o) { o = readOutline(s); outlines.set(s, o); }
    return o;
  };

  const circuits: Outline[] = [];
  const opens: Outline[] = [];
  for (const s of leaves) {
    const o = outlineOf(s);
    if (!o.sp) {
      if (explicit.has(s)) {
        skipped.push(o.subpaths > 1
          ? `“${s.name}” has ${o.subpaths} subpaths — a circuit is one closed loop`
          : `“${s.name}” isn't a plain path`);
      }
      continue;
    }
    if (o.sp.closed) circuits.push(o);
    else if (explicit.has(s) || isPitLaneName(s.name)) opens.push(o);
  }

  if (!circuits.length && opens.length) {
    skipped.push(...opens.map(o => `“${o.shape.name}” is open — select the closed circuit with it`));
  }

  const layouts: TrackLayout[] = [];
  for (const c of circuits) {
    const notes: string[] = [];
    // The pit lane: one selected beside it (same parent) wins, then the only one
    // selected, then a "pit-lane" sibling of the circuit in the document.
    const besides = opens.filter(o => o.shape.parentId === c.shape.parentId);
    const picked = opens.filter(o => explicit.has(o.shape));
    let pick: Outline[] = besides.length ? besides : picked.length === 1 ? picked : [];
    if (!pick.length) {
      pick = siblingsOf(c.shape)
        .filter(s => s !== c.shape && isPitLaneName(s.name))
        .map(outlineOf)
        .filter(o => o.sp && !o.sp.closed);
    }
    if (pick.length > 1) {
      const named = pick.filter(o => isPitLaneName(o.shape.name));
      if (named.length) pick = named;
      if (pick.length > 1) notes.push(`${pick.length} candidate pit lanes beside it — used “${pick[0].shape.name}”`);
    }
    const pit = pick[0] ?? null;

    const frame = c.shape.element.closest('g[data-frame]');
    const toSpace = spaceMatrix(frame);
    const circuitSp = mapSubPath(c.sp!, toSpace.multiply(layerMatrix(c.shape.element)));
    const pitSp = pit ? mapSubPath(pit.sp!, toSpace.multiply(layerMatrix(pit.shape.element))) : null;
    if (pitSp) {
      const a = pitSp.anchors[0], b = pitSp.anchors[pitSp.anchors.length - 1];
      const da = distanceToSubPath(a.x, a.y, circuitSp), db = distanceToSubPath(b.x, b.y, circuitSp);
      if (da > ON_CIRCUIT_TOLERANCE) notes.push(`Pit entry is ${da.toFixed(1)} units off the circuit`);
      if (db > ON_CIRCUIT_TOLERANCE) notes.push(`Pit exit is ${db.toFixed(1)} units off the circuit`);
    }
    layouts.push({
      name: c.shape.name,
      circuit: c.shape,
      pitLane: pit?.shape ?? null,
      frameName: frame?.getAttribute('data-name') ?? null,
      svg: buildTrackLayoutSVG(circuitSp, pitSp),
      notes,
    });
  }
  return { layouts, skipped };
}

/** The shape's outline in its own local space, when it's exactly one subpath. A
 *  loop whose ends meet without a Z counts as closed. */
function readOutline(shape: ShapeData): Outline {
  const d = localPathData(shape.element);
  const model = d.trim() ? parsePath(d) : { subpaths: [] };
  const subs = model.subpaths.filter(sp => sp.anchors.length > 1);
  if (subs.length !== 1) return { shape, sp: null, subpaths: subs.length };
  const sp = subs[0];
  if (!sp.closed) {
    const first = sp.anchors[0], last = sp.anchors[sp.anchors.length - 1];
    if (sp.anchors.length > 2 && Math.hypot(last.x - first.x, last.y - first.y) < SELF_CLOSE_EPS) {
      if (last.inX !== undefined) { first.inX = last.inX; first.inY = last.inY; }
      sp.anchors.pop();
      sp.closed = true;
    }
  }
  return { shape, sp, subpaths: 1 };
}

/** Element-local → drawing-layer space, read from transform attributes (works on
 *  hidden layers, which have no CTM). */
function layerMatrix(el: Element): DOMMatrix {
  const layer = el.closest('#drawing-layer');
  return layer ? matrixToAncestor(el, layer) : new DOMMatrix();
}

/** Drawing-layer → the frame's own space (its content coordinates, origin at the
 *  artboard's top-left). Identity for shapes outside a frame. */
function spaceMatrix(frame: Element | null): DOMMatrix {
  return frame ? ownTransformMatrix(frame).inverse() : new DOMMatrix();
}

function mapSubPath(sp: SubPath, m: DOMMatrix): SubPath {
  const tx = (x: number, y: number) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
  return {
    closed: sp.closed,
    anchors: sp.anchors.map(a => {
      const p = tx(a.x, a.y);
      const out = { ...a, x: p.x, y: p.y };
      if (a.inX !== undefined) { const q = tx(a.inX, a.inY!); out.inX = q.x; out.inY = q.y; }
      if (a.outX !== undefined) { const q = tx(a.outX, a.outY!); out.outX = q.x; out.outY = q.y; }
      return out;
    }),
  };
}

type Seg = [number, number, number, number, number, number, number, number]; // p0, c1, c2, p3

/** Every segment of a subpath as a cubic (a straight one has its controls on its ends). */
function segments(sp: SubPath): Seg[] {
  const n = sp.anchors.length;
  const out: Seg[] = [];
  for (let i = 0; i < (sp.closed ? n : n - 1); i++) {
    const a = sp.anchors[i], b = sp.anchors[(i + 1) % n];
    out.push([a.x, a.y, a.outX ?? a.x, a.outY ?? a.y, b.inX ?? b.x, b.inY ?? b.y, b.x, b.y]);
  }
  return out;
}

const cubicAt = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

/** Parameters in (0,1) where one coordinate of a cubic turns (its derivative's roots). */
function turningPoints(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      ts.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return ts.filter(t => t > 0 && t < 1);
}

/** The curve's true bounding box — through its turning points, not its control points. */
export function subPathBounds(sp: SubPath): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const a of sp.anchors) add(a.x, a.y);
  for (const [ax, ay, bx, by, cx, cy, dx, dy] of segments(sp)) {
    for (const t of [...turningPoints(ax, bx, cx, dx), ...turningPoints(ay, by, cy, dy)]) {
      add(cubicAt(ax, bx, cx, dx, t), cubicAt(ay, by, cy, dy, t));
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Distance from a point to a subpath, via a fine polyline through each segment. */
export function distanceToSubPath(px: number, py: number, sp: SubPath): number {
  const STEPS = 64;
  let best = Infinity;
  for (const [ax, ay, bx, by, cx, cy, dx, dy] of segments(sp)) {
    let qx = ax, qy = ay;
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS;
      const rx = cubicAt(ax, bx, cx, dx, t), ry = cubicAt(ay, by, cy, dy, t);
      best = Math.min(best, pointToSegment(px, py, qx, qy, rx, ry));
      qx = rx; qy = ry;
    }
  }
  return best;
}

function pointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** Two decimals, no trailing zeros, never "-0". */
function num(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(r === 0 ? 0 : r);
}

/** Absolute M / L / C (/ Z when closed) — the only commands TraceCraft needs. */
export function subPathData(sp: SubPath): string {
  const a0 = sp.anchors[0];
  let d = `M ${num(a0.x)} ${num(a0.y)}`;
  const segs = segments(sp);
  sp.anchors.forEach((a, i) => {
    if (i >= segs.length) return;
    const b = sp.anchors[(i + 1) % sp.anchors.length];
    const straight = a.outX === undefined && b.inX === undefined;
    const closing = sp.closed && i === segs.length - 1;
    if (straight) { if (!closing) d += ` L ${num(b.x)} ${num(b.y)}`; } // Z draws the closing line
    else {
      const [, , c1x, c1y, c2x, c2y, x, y] = segs[i];
      d += ` C ${num(c1x)} ${num(c1y)} ${num(c2x)} ${num(c2y)} ${num(x)} ${num(y)}`;
    }
  });
  return sp.closed ? d + ' Z' : d;
}

/** The file: XML declaration, a bare viewBox root, the circuit, then the pit lane. */
export function buildTrackLayoutSVG(circuit: SubPath, pitLane: SubPath | null): string {
  const b = subPathBounds(circuit);
  const m = VIEWBOX_MARGIN;
  const viewBox = [b.x - m, b.y - m, b.w + 2 * m, b.h + 2 * m].map(num).join(' ');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">`,
    `  <path d="${subPathData(circuit)}" fill="none" stroke="#000"/>`,
  ];
  if (pitLane) lines.push(`  <path id="${PIT_LANE_ID}" d="${subPathData(pitLane)}" fill="none" stroke="#d33"/>`);
  lines.push('</svg>', '');
  return lines.join('\n');
}

/** A filename-safe slug: lowercase ASCII words joined by hyphens. */
export function slugify(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** `<circuit>-<layout>.layout.svg` — without repeating the circuit when the layout's
 *  own name already starts with it ("Miami MIA Loop" under "miami"). */
export function trackLayoutFilename(circuitName: string, layoutName: string): string {
  const c = slugify(circuitName), l = slugify(layoutName) || 'layout';
  const stem = !c || l === c || l.startsWith(c + '-') ? l : `${c}-${l}`;
  return `${stem}.layout.svg`;
}
