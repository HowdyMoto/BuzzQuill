/**
 * Editable path model: a lossy-but-faithful bridge between an SVG `d` string and
 * a list of anchor points with bezier handles, suitable for node editing.
 *
 * Geometry is normalized to lines and cubic beziers — the two forms the editor
 * manipulates directly. Quadratics (Q/T) are degree-elevated to cubics, smooth
 * shorthands (S/T) are expanded by reflecting the previous control point, and
 * arcs (A) are approximated by cubic segments. Multiple subpaths are preserved,
 * so compound paths round-trip and every node stays editable.
 */

export type AnchorType = 'corner' | 'smooth' | 'broken';

export interface Anchor {
  x: number; y: number;
  /** Incoming control handle (absolute), if the segment into this anchor curves. */
  inX?: number; inY?: number;
  /** Outgoing control handle (absolute), if the segment out of this anchor curves. */
  outX?: number; outY?: number;
  type: AnchorType;
}

export interface SubPath {
  anchors: Anchor[];
  closed: boolean;
}

export interface PathModel {
  subpaths: SubPath[];
}

/** Arg count per path command; repeated arg-sets are split by the tokenizer. */
const ARG_COUNT: Record<string, number> = {
  m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0,
};

/** Coincidence tolerance (user units) for merging closed-loop endpoints. */
const MERGE_EPS = 0.5;
/** Collinearity tolerance for smooth-vs-broken inference. */
const COLLINEAR_EPS = 0.08;
/** Closest two points can sit and still be the SAME point, for edits that must not
 *  change the geometry at all. MERGE_EPS is a node-editing nicety: at small scales it
 *  eats a real point (a closed loop in 1-unit artwork loses a corner). */
const EXACT_EPS = 1e-6;

export interface PathToken { cmd: string; args: number[] }

/** An arc's numbers. Its two flags are single digits that need no separator, and
 *  minifiers rely on that: SVGO writes "a5 5 0 015 5" for flags 0,1 and end point 5,5,
 *  which a plain number scan reads as the one number 015 — and then the arc comes up
 *  short of arguments and vanishes. */
function arcNumbers(s: string): number[] {
  const number = /[\s,]*(-?\d*\.?\d+(?:e[-+]?\d+)?)/iy;
  const flag = /[\s,]*([01])/y;
  const out: number[] = [];
  let at = 0;
  for (;;) {
    const re = out.length % 7 === 3 || out.length % 7 === 4 ? flag : number;
    re.lastIndex = at;
    const m = re.exec(s);
    if (!m) return out;
    out.push(Number(m[1]));
    at = re.lastIndex;
  }
}

/**
 * Split a `d` string into commands. Repeated coordinate groups become repeated
 * commands (and an implicit moveto's extras become linetos, per the SVG spec).
 */
export function tokenizePath(d: string): PathToken[] {
  const out: PathToken[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(d)) !== null) {
    const cmd = match[1];
    const lower = cmd.toLowerCase();
    const nums = lower === 'a' ? arcNumbers(match[2])
      : (match[2].match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
    const n = ARG_COUNT[lower];
    if (n === 0) { out.push({ cmd, args: [] }); continue; }
    let i = 0, first = true;
    do {
      const args = nums.slice(i, i + n);
      if (args.length < n) break;
      let effective = cmd;
      if (!first && lower === 'm') effective = cmd === 'M' ? 'L' : 'l';
      out.push({ cmd: effective, args });
      i += n; first = false;
    } while (i < nums.length);
  }
  return out;
}

/** Classify an anchor by the handles it currently has. */
export function inferType(a: Anchor): AnchorType {
  const hasIn = a.inX !== undefined, hasOut = a.outX !== undefined;
  if (!hasIn && !hasOut) return 'corner';
  if (hasIn && hasOut) {
    const inDx = a.x - (a.inX as number), inDy = a.y - (a.inY as number);
    const outDx = (a.outX as number) - a.x, outDy = (a.outY as number) - a.y;
    const lenIn = Math.hypot(inDx, inDy), lenOut = Math.hypot(outDx, outDy);
    const cross = inDx * outDy - inDy * outDx;
    const dot = inDx * outDx + inDy * outDy;
    // Collinear handles on opposite sides = smooth, regardless of handle length.
    // (Requiring equal length made a tangent point revert to "broken" the moment
    // a handle was dragged to a different length, losing its smoothness.)
    const collinear = Math.abs(cross) <= COLLINEAR_EPS * (lenIn * lenOut + 1e-6) && dot > 0;
    if (collinear) return 'smooth';
    return 'broken';
  }
  return 'broken'; // single handle (e.g. an open-path endpoint)
}

function arcToCubics(
  x0: number, y0: number, rx: number, ry: number, rotDeg: number,
  largeArc: number, sweep: number, x: number, y: number,
): { c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }[] {
  // Endpoint -> center parameterization (SVG implementation notes F.6).
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) {
    return [{ c1x: x0, c1y: y0, c2x: x, c2y: y, x, y }];
  }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (rotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx = (x0 - x) / 2, dy = (y0 - y) / 2;
  const x1p = cosP * dx + sinP * dy, y1p = -sinP * dx + cosP * dy;
  let rxs = rx * rx, rys = ry * ry;
  const lambda = (x1p * x1p) / rxs + (y1p * y1p) / rys;
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; rxs = rx * rx; rys = ry * ry; }
  let sign = largeArc !== sweep ? 1 : -1;
  let num = rxs * rys - rxs * y1p * y1p - rys * x1p * x1p;
  num = num < 0 ? 0 : num;
  const co = sign * Math.sqrt(num / (rxs * y1p * y1p + rys * x1p * x1p));
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x0 + x) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
  const segs = Math.ceil(Math.abs(dTheta) / (Math.PI / 2));
  const delta = dTheta / segs;
  const t = (4 / 3) * Math.tan(delta / 4);
  const out = [];
  let ang1 = theta1;
  let px = x0, py = y0;
  for (let i = 0; i < segs; i++) {
    const ang2 = ang1 + delta;
    const cos1 = Math.cos(ang1), sin1 = Math.sin(ang1);
    const cos2 = Math.cos(ang2), sin2 = Math.sin(ang2);
    const e2x = cosP * rx * cos2 - sinP * ry * sin2 + cx;
    const e2y = sinP * rx * cos2 + cosP * ry * sin2 + cy;
    const d1x = -rx * sin1, d1y = ry * cos1;
    const d2x = -rx * sin2, d2y = ry * cos2;
    const c1x = px + t * (cosP * d1x - sinP * d1y);
    const c1y = py + t * (sinP * d1x + cosP * d1y);
    const c2x = e2x - t * (cosP * d2x - sinP * d2y);
    const c2y = e2y - t * (sinP * d2x + cosP * d2y);
    out.push({ c1x, c1y, c2x, c2y, x: e2x, y: e2y });
    px = e2x; py = e2y; ang1 = ang2;
  }
  return out;
}

export function parsePath(d: string, mergeEps: number = MERGE_EPS): PathModel {
  const tokens = tokenizePath(d);
  const subpaths: SubPath[] = [];
  let cur: SubPath | null = null;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let prevCubicCp: { x: number; y: number } | null = null; // for S
  let prevQuadCp: { x: number; y: number } | null = null;   // for T
  let prevLower = '';

  const last = () => cur!.anchors[cur!.anchors.length - 1];

  for (const { cmd, args } of tokens) {
    const lower = cmd.toLowerCase();
    const rel = cmd !== cmd.toUpperCase() && lower !== 'z';

    // Drawing straight on after a Z, with no moveto: SVG starts a new run at the
    // closed loop's start point. Appending to the loop bent its closing segment.
    if (cur?.closed && lower !== 'm' && lower !== 'z') {
      cur = { anchors: [{ x: sx, y: sy, type: 'corner' }], closed: false };
      subpaths.push(cur);
    }

    if (lower === 'm') {
      const x = rel ? cx + args[0] : args[0];
      const y = rel ? cy + args[1] : args[1];
      cur = { anchors: [{ x, y, type: 'corner' }], closed: false };
      subpaths.push(cur);
      cx = x; cy = y; sx = x; sy = y;
    } else if (!cur) {
      continue;
    } else if (lower === 'l') {
      const x = rel ? cx + args[0] : args[0], y = rel ? cy + args[1] : args[1];
      cur.anchors.push({ x, y, type: 'corner' }); cx = x; cy = y;
    } else if (lower === 'h') {
      const x = rel ? cx + args[0] : args[0];
      cur.anchors.push({ x, y: cy, type: 'corner' }); cx = x;
    } else if (lower === 'v') {
      const y = rel ? cy + args[0] : args[0];
      cur.anchors.push({ x: cx, y, type: 'corner' }); cy = y;
    } else if (lower === 'c' || lower === 's') {
      let c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number;
      if (lower === 'c') {
        c1x = rel ? cx + args[0] : args[0]; c1y = rel ? cy + args[1] : args[1];
        c2x = rel ? cx + args[2] : args[2]; c2y = rel ? cy + args[3] : args[3];
        x = rel ? cx + args[4] : args[4]; y = rel ? cy + args[5] : args[5];
      } else {
        if ((prevLower === 'c' || prevLower === 's') && prevCubicCp) {
          c1x = 2 * cx - prevCubicCp.x; c1y = 2 * cy - prevCubicCp.y;
        } else { c1x = cx; c1y = cy; }
        c2x = rel ? cx + args[0] : args[0]; c2y = rel ? cy + args[1] : args[1];
        x = rel ? cx + args[2] : args[2]; y = rel ? cy + args[3] : args[3];
      }
      const prev = last();
      prev.outX = c1x; prev.outY = c1y;
      cur.anchors.push({ x, y, inX: c2x, inY: c2y, type: 'corner' });
      cx = x; cy = y; prevCubicCp = { x: c2x, y: c2y };
    } else if (lower === 'q' || lower === 't') {
      let qx: number, qy: number, x: number, y: number;
      if (lower === 'q') {
        qx = rel ? cx + args[0] : args[0]; qy = rel ? cy + args[1] : args[1];
        x = rel ? cx + args[2] : args[2]; y = rel ? cy + args[3] : args[3];
      } else {
        if ((prevLower === 'q' || prevLower === 't') && prevQuadCp) {
          qx = 2 * cx - prevQuadCp.x; qy = 2 * cy - prevQuadCp.y;
        } else { qx = cx; qy = cy; }
        x = rel ? cx + args[0] : args[0]; y = rel ? cy + args[1] : args[1];
      }
      const prev = last();
      prev.outX = cx + (2 / 3) * (qx - cx); prev.outY = cy + (2 / 3) * (qy - cy);
      cur.anchors.push({ x, y, inX: x + (2 / 3) * (qx - x), inY: y + (2 / 3) * (qy - y), type: 'corner' });
      cx = x; cy = y; prevQuadCp = { x: qx, y: qy };
    } else if (lower === 'a') {
      const x = rel ? cx + args[5] : args[5], y = rel ? cy + args[6] : args[6];
      const curves = arcToCubics(cx, cy, args[0], args[1], args[2], args[3], args[4], x, y);
      for (const seg of curves) {
        last().outX = seg.c1x; last().outY = seg.c1y;
        cur.anchors.push({ x: seg.x, y: seg.y, inX: seg.c2x, inY: seg.c2y, type: 'corner' });
      }
      cx = x; cy = y;
    } else if (lower === 'z') {
      cur.closed = true; cx = sx; cy = sy;
    }

    prevLower = lower;
    if (lower !== 'c' && lower !== 's') prevCubicCp = null;
    if (lower !== 'q' && lower !== 't') prevQuadCp = null;
  }

  // Post-process: merge coincident closed-loop endpoints, classify anchor types.
  for (const sp of subpaths) {
    if (sp.closed && sp.anchors.length > 1) {
      const first = sp.anchors[0];
      const lastA = sp.anchors[sp.anchors.length - 1];
      if (Math.hypot(lastA.x - first.x, lastA.y - first.y) < mergeEps) {
        if (lastA.inX !== undefined) { first.inX = lastA.inX; first.inY = lastA.inY; }
        sp.anchors.pop();
      }
    }
    for (const a of sp.anchors) a.type = inferType(a);
  }
  return { subpaths };
}

function f(n: number): string {
  const r = Math.round(n * 1e4) / 1e4;
  return String(r === 0 ? 0 : r);
}

export function serializePath(model: PathModel): string {
  const parts: string[] = [];
  for (const sp of model.subpaths) {
    if (sp.anchors.length === 0) continue;
    const a0 = sp.anchors[0];
    let d = `M ${f(a0.x)} ${f(a0.y)}`;
    const n = sp.anchors.length;
    const segCount = sp.closed ? n : n - 1;
    for (let i = 0; i < segCount; i++) {
      const prev = sp.anchors[i];
      const curr = sp.anchors[(i + 1) % n];
      const hasOut = prev.outX !== undefined;
      const hasIn = curr.inX !== undefined;
      const closingSeg = sp.closed && i === segCount - 1;
      if (!hasOut && !hasIn) {
        if (!closingSeg) d += ` L ${f(curr.x)} ${f(curr.y)}`;
        // closing straight segment is drawn by Z below
      } else {
        const c1x = hasOut ? (prev.outX as number) : prev.x;
        const c1y = hasOut ? (prev.outY as number) : prev.y;
        const c2x = hasIn ? (curr.inX as number) : curr.x;
        const c2y = hasIn ? (curr.inY as number) : curr.y;
        d += ` C ${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(curr.x)} ${f(curr.y)}`;
      }
    }
    if (sp.closed) d += ' Z';
    parts.push(d);
  }
  return parts.join(' ');
}

/**
 * The same run walked the other way: the anchors in reverse order, each with its two
 * handles swapped, so every curve is exactly the curve it was. A closed loop keeps
 * its START POINT — it just leaves it the other way — because the start means
 * something to whoever reads the file (a circuit's start line, a baseline's origin).
 */
export function reverseSubPath(sp: SubPath): SubPath {
  const flip = (a: Anchor): Anchor => {
    const { inX, inY, outX, outY, ...rest } = a;
    const out: Anchor = { ...rest };
    if (outX !== undefined) { out.inX = outX; out.inY = outY; }
    if (inX !== undefined) { out.outX = inX; out.outY = inY; }
    return out;
  };
  const anchors = sp.anchors.map(flip).reverse();
  // Reversed, the old first anchor is now last. A loop's start doesn't move.
  if (sp.closed && anchors.length > 1) anchors.unshift(anchors.pop() as Anchor);
  return { anchors, closed: sp.closed };
}

/** Where anchor `i` of a run of `n` lands in {@link reverseSubPath}'s result. */
export function reversedAnchorIndex(i: number, n: number, closed: boolean): number {
  return closed ? (n - i) % n : n - 1 - i;
}

/**
 * Reverse every run of a path, leaving the runs in their order. Always all of them:
 * under fill-rule nonzero a hole is a run wound against its outline, and flipping one
 * alone fills the hole in. Flipping all of them negates every winding number, which
 * nonzero can't tell apart, so what's painted doesn't change.
 */
export function reversePathData(d: string): string {
  const model = parsePath(d, EXACT_EPS);
  return serializePath({ subpaths: model.subpaths.map(reverseSubPath) });
}

/**
 * Force an anchor to a given type, adjusting its handles:
 * - corner: remove both handles
 * - smooth: ensure mirrored (equal-length, collinear) handles
 * - broken: keep handles independent (synthesize gently if missing)
 */
export function setAnchorType(sp: SubPath, i: number, type: AnchorType): void {
  const a = sp.anchors[i];
  if (type === 'corner') {
    delete a.inX; delete a.inY; delete a.outX; delete a.outY;
    a.type = 'corner';
    return;
  }

  const n = sp.anchors.length;
  const prev = sp.closed ? sp.anchors[(i - 1 + n) % n] : sp.anchors[i - 1];
  const next = sp.closed ? sp.anchors[(i + 1) % n] : sp.anchors[i + 1];

  // Establish a tangent direction from neighbors when handles are absent.
  let dirX = 0, dirY = 0;
  if (a.outX !== undefined) { dirX = a.outX - a.x; dirY = a.outY! - a.y; }
  else if (a.inX !== undefined) { dirX = a.x - a.inX; dirY = a.y - a.inY!; }
  else if (prev && next) { dirX = next.x - prev.x; dirY = next.y - prev.y; }
  else if (next) { dirX = next.x - a.x; dirY = next.y - a.y; }
  else if (prev) { dirX = a.x - prev.x; dirY = a.y - prev.y; }
  const len = Math.hypot(dirX, dirY) || 1;
  const ux = dirX / len, uy = dirY / len;

  const inLen = a.inX !== undefined ? Math.hypot(a.x - a.inX, a.y - a.inY!) : (prev ? Math.hypot(a.x - prev.x, a.y - prev.y) / 3 : len / 3);
  const outLen = a.outX !== undefined ? Math.hypot(a.outX - a.x, a.outY! - a.y) : (next ? Math.hypot(next.x - a.x, next.y - a.y) / 3 : len / 3);

  if (type === 'smooth') {
    const h = Math.max((inLen + outLen) / 2, 1);
    a.inX = a.x - ux * h; a.inY = a.y - uy * h;
    a.outX = a.x + ux * h; a.outY = a.y + uy * h;
    a.type = 'smooth';
  } else { // broken
    if (a.inX === undefined && (prev || a.outX !== undefined)) { a.inX = a.x - ux * inLen; a.inY = a.y - uy * inLen; }
    if (a.outX === undefined && (next || a.inX !== undefined)) { a.outX = a.x + ux * outLen; a.outY = a.y + uy * outLen; }
    a.type = 'broken';
  }
}

/** Split the segment after anchor `segIndex` at parameter t (0..1), returning the new anchor index. */
export function insertAnchorAt(sp: SubPath, segIndex: number, t: number): number {
  const n = sp.anchors.length;
  const a = sp.anchors[segIndex];
  const b = sp.anchors[(segIndex + 1) % n];
  const hasCurve = a.outX !== undefined || b.inX !== undefined;
  if (!hasCurve) {
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
    sp.anchors.splice(segIndex + 1, 0, { x, y, type: 'corner' });
    return segIndex + 1;
  }
  const p0 = { x: a.x, y: a.y };
  const p1 = { x: a.outX ?? a.x, y: a.outY ?? a.y };
  const p2 = { x: b.inX ?? b.x, y: b.inY ?? b.y };
  const p3 = { x: b.x, y: b.y };
  const lerp = (u: { x: number; y: number }, v: { x: number; y: number }) => ({ x: u.x + (v.x - u.x) * t, y: u.y + (v.y - u.y) * t });
  const p01 = lerp(p0, p1), p12 = lerp(p1, p2), p23 = lerp(p2, p3);
  const p012 = lerp(p01, p12), p123 = lerp(p12, p23);
  const mid = lerp(p012, p123);
  a.outX = p01.x; a.outY = p01.y;
  b.inX = p23.x; b.inY = p23.y;
  const newA: Anchor = { x: mid.x, y: mid.y, inX: p012.x, inY: p012.y, outX: p123.x, outY: p123.y, type: 'smooth' };
  sp.anchors.splice(segIndex + 1, 0, newA);
  return segIndex + 1;
}

/** Remove an anchor. Neighboring handles are kept (still valid control points). */
export function deleteAnchor(sp: SubPath, i: number): void {
  sp.anchors.splice(i, 1);
}

/**
 * Apply an affine matrix to every coordinate of a path's `d` (anchors and
 * bezier control points), returning a new `d`. Béziers are affine-invariant,
 * so this is exact — no resampling. Used to bake an element's transform into
 * its geometry on export.
 */
export function transformPathData(d: string, m: DOMMatrix): string {
  const model = parsePath(d);
  const tx = (x: number, y: number) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
  for (const sp of model.subpaths) {
    for (const a of sp.anchors) {
      const p = tx(a.x, a.y); a.x = p.x; a.y = p.y;
      if (a.inX !== undefined) { const q = tx(a.inX, a.inY!); a.inX = q.x; a.inY = q.y; }
      if (a.outX !== undefined) { const q = tx(a.outX, a.outY!); a.outX = q.x; a.outY = q.y; }
    }
  }
  return serializePath(model);
}

/**
 * Scale every coordinate of a path's `d` by (sx, sy) about the fixed point
 * (fx, fy), returning a new `d`. Used by the Select tool to resize paths while
 * keeping their geometry baked into `d` (so node editing stays clean).
 */
export function scalePathData(d: string, fx: number, fy: number, sx: number, sy: number): string {
  const model = parsePath(d);
  for (const sp of model.subpaths) {
    for (const a of sp.anchors) {
      a.x = fx + (a.x - fx) * sx; a.y = fy + (a.y - fy) * sy;
      if (a.inX !== undefined) { a.inX = fx + (a.inX - fx) * sx; a.inY = fy + (a.inY! - fy) * sy; }
      if (a.outX !== undefined) { a.outX = fx + (a.outX - fx) * sx; a.outY = fy + (a.outY! - fy) * sy; }
    }
  }
  return serializePath(model);
}
