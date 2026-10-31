/**
 * Boolean (Pathfinder) engine — Unite / Subtract / Intersect / Exclude / Divide
 * on vector geometry, preserving Bézier curves.
 *
 * The heavy lifting is delegated to Paper.js, which does native curve booleans
 * (a circle minus a circle yields a true crescent, not a faceted polygon). Paper
 * is **dynamically imported on first use** so the editor's initial bundle stays
 * lean and dependency-free; once loaded it is cached and used synchronously.
 *
 * This module is intentionally pure and DOM-light: it converts SVG primitives to
 * path `d` strings (reusing the cubic conventions in path-model.ts), runs the op,
 * and returns `d` string(s). The live compound-shape plumbing lives in state.ts.
 */

import { transformPathData } from './path-model';

export type BooleanOp = 'unite' | 'subtract' | 'intersect' | 'exclude' | 'divide';

// ---- Engine lifecycle (lazy Paper.js) ----

// Paper has no bundled ESM types we want to lean on here; treat the scope loosely.
/* eslint-disable @typescript-eslint/no-explicit-any */
let paper: any = null;
let loading: Promise<void> | null = null;

/** Load Paper.js once and stand up a headless project. Safe to call repeatedly. */
export async function ensureBooleanEngine(): Promise<void> {
  if (paper) return;
  if (!loading) {
    // `paper` is aliased to paper-CORE in vite.config.ts (paper-full bundles a
    // PaperScript parser that calls `new Function()` — blocked by our CSP). The
    // core build is geometry-only (Path/CompoundPath/boolean ops) and CSP-safe.
    loading = import('paper').then((mod) => {
      const p = (mod as any).default ?? mod;
      // A detached canvas gives Paper a project without attaching to the page.
      p.setup(document.createElement('canvas'));
      // Never auto-insert created/result items into the project's active layer —
      // we only want geometry, and this keeps the headless project leak-free.
      p.settings.insertItems = false;
      paper = p;
    });
  }
  await loading;
}

/** True once Paper is loaded and synchronous compute is available. */
export function booleanEngineReady(): boolean {
  return !!paper;
}

// ---- Offset engine (Outline Stroke / Offset Path via paperjs-offset) ----

let paperOffset: any = null;
let offsetLoading: Promise<void> | null = null;

/** Load paper-core + the offset plugin once. */
export async function ensureOffsetEngine(): Promise<void> {
  await ensureBooleanEngine();
  if (paperOffset) return;
  if (!offsetLoading) {
    offsetLoading = import('paperjs-offset').then((mod) => {
      paperOffset = (mod as any).PaperOffset ?? (mod as any).default;
    });
  }
  await offsetLoading;
}

export type StrokeJoin = 'miter' | 'round' | 'bevel';
export type StrokeCap = 'butt' | 'round' | 'square';

/**
 * Offset a path's `d` inward (negative) or outward (positive) by `delta`,
 * preserving curves. Requires {@link ensureOffsetEngine}. Returns '' on failure.
 */
export function offsetPathData(d: string, delta: number, join: StrokeJoin = 'miter'): string {
  if (!paper || !paperOffset) throw new Error('Offset engine not loaded.');
  if (!d.trim() || delta === 0) return d;
  const src = new paper.CompoundPath({ pathData: d, insert: false });
  let out = '';
  try {
    const res = paperOffset.offset(src, delta, { join, insert: false });
    out = res?.pathData ?? '';
    res?.remove?.();
  } catch { out = ''; }
  src.remove();
  return out;
}

export interface StrokeOutlineOptions {
  /** SVG `stroke-miterlimit` (default 4): a sharper miter corner is bevelled. */
  miterLimit?: number;
  /** `stroke-dasharray` lengths; absent or empty = a solid stroke. */
  dash?: number[];
  dashOffset?: number;
  /** The path's total length as the RENDERER measures it (`getTotalLength()`).
   *  Dashes are laid out along that; the engine's own length differs by a hair on
   *  curves, which over a long path walks the dashes out of step. */
  renderedLength?: number;
}

export interface PathFrame { x: number; y: number; angle: number }

/** Past this many dashes the outline is refused rather than grinding through
 *  thousands of unions (a hairline dash pattern on a very long path). */
const MAX_DASHES = 4000;
const LEN_EPS = 1e-6;

/** A usable dash pattern (even length, as SVG repeats an odd one), or null for solid. */
function dashPattern(dash: number[] | undefined): number[] | null {
  if (!dash || dash.length === 0) return null;
  if (dash.some((v) => !Number.isFinite(v) || v < 0)) return null;
  const p = dash.length % 2 ? [...dash, ...dash] : dash.slice();
  return p.reduce((a, b) => a + b, 0) > 0 ? p : null;
}

/** The part of `sub` between path offsets a and b, as a new open path. */
function slicePath(sub: any, a: number, b: number, length: number): any {
  const c = sub.clone({ insert: false });
  if (c.closed) {
    c.splitAt(a); // opens the loop at a; c now runs a → a
    if (b - a < length - LEN_EPS) c.splitAt(b - a)?.remove();
    return c;
  }
  let piece = c;
  if (a > LEN_EPS) { piece = c.splitAt(a); c.remove(); if (!piece) return null; }
  if (b < length - LEN_EPS) piece.splitAt(b - a)?.remove();
  return piece;
}

/** Cut one subpath into its "on" dashes. Null when there are too many to outline. */
function dashPieces(sub: any, rawPattern: number[], rawOffset: number, scale = 1): any[] | null {
  const length = sub.length as number;
  if (!(length > 0)) return [];
  const pattern = scale === 1 ? rawPattern : rawPattern.map((v) => v * scale);
  const offset = rawOffset * scale;
  const total = pattern.reduce((a, b) => a + b, 0);
  let pos = ((offset % total) + total) % total, i = 0;
  while (pos >= pattern[i]) { pos -= pattern[i]; i = (i + 1) % pattern.length; }

  const spans: [number, number][] = [];
  let s = 0;
  while (s < length - LEN_EPS) {
    const e = Math.min(length, s + pattern[i] - pos);
    if (i % 2 === 0 && e - s > LEN_EPS) {
      const last = spans[spans.length - 1];
      if (last && Math.abs(last[1] - s) < LEN_EPS) last[1] = e; // a zero-length gap
      else spans.push([s, e]);
      if (spans.length > MAX_DASHES) return null;
    }
    s = e; pos = 0; i = (i + 1) % pattern.length;
  }
  if (spans.length === 1 && spans[0][0] < LEN_EPS && spans[0][1] > length - LEN_EPS) {
    return [sub.clone({ insert: false })];
  }
  // On a closed subpath a dash running up to the closing point and one leaving
  // from it are ONE dash, joined at the corner — not two capped ends.
  let wrap: [number, number] | null = null;
  if (sub.closed && spans.length > 1 && spans[0][0] < LEN_EPS && spans[spans.length - 1][1] > length - LEN_EPS) {
    wrap = [spans.pop()![0], spans.shift()![1]];
  }
  const pieces: any[] = [];
  for (const [a, b] of spans) { const p = slicePath(sub, a, b, length); if (p) pieces.push(p); }
  if (wrap) {
    const c = sub.clone({ insert: false });
    c.splitAt(wrap[0]);
    c.splitAt(length - wrap[0] + wrap[1])?.remove();
    pieces.push(c);
  }
  // A cut leaves the end points holding the handle that used to lead on along the
  // path. Nothing follows them now, and the stroker would bend the cap along it.
  for (const p of pieces) {
    if (p.closed) continue;
    p.firstSegment.handleIn.set(0, 0);
    p.lastSegment.handleOut.set(0, 0);
  }
  return pieces;
}

/** A square cap is a butt cap on a path that runs half a width further each way. */
function squareEnds(p: any, half: number): void {
  const len = p.length as number;
  if (!(len > 0)) return;
  const t0 = p.getTangentAt(0), t1 = p.getTangentAt(len) ?? p.getTangentAt(Math.max(0, len - LEN_EPS));
  if (!t0 || !t1) return;
  const head = p.firstSegment.point.subtract(t0.multiply(half));
  const tail = p.lastSegment.point.add(t1.multiply(half));
  p.insert(0, head);
  p.add(tail);
}

/** Union many items pairwise (a balanced tree, so the cost stays n·log n). */
function uniteAll(items: any[]): any {
  let level = items;
  while (level.length > 1) {
    const next: any[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? level[i].unite(level[i + 1], { insert: false }) : level[i]);
    }
    level = next;
  }
  return level[0] ?? null;
}

/**
 * Convert a stroke of the given width into a filled outline path's `d` (the
 * region the stroke covers): joins, caps (square included), the SVG miter limit
 * and a dash pattern. Requires {@link ensureOffsetEngine}. Returns '' on failure,
 * a non-positive width, or a dash pattern too fine to outline.
 */
export function outlineStrokeData(
  d: string, width: number, join: StrokeJoin = 'miter', cap: StrokeCap = 'butt',
  opts: StrokeOutlineOptions = {},
): string {
  if (!paper || !paperOffset) throw new Error('Offset engine not loaded.');
  if (!d.trim() || width <= 0) return '';
  const src = new paper.CompoundPath({ pathData: d, insert: false });
  // paperjs-offset's `limit` compares vertex→miter-tip against offset·limit, which
  // is exactly SVG's miter-length / stroke-width ratio. Its own default is 10 and
  // SVG's is 4, so sharp corners used to come out mitered where they render bevelled.
  const limit = opts.miterLimit && opts.miterLimit >= 1 ? opts.miterLimit : 4;
  const stroke = (item: any): any =>
    paperOffset.offsetStroke(item, width / 2, { join, cap: cap === 'round' ? 'round' : 'butt', limit, insert: false });
  const pattern = dashPattern(opts.dash);
  let out = '';
  try {
    if (!pattern && cap !== 'square') {
      const res = stroke(src);
      out = res?.pathData ?? '';
      res?.remove?.();
    } else {
      const pieces: any[] = [];
      let tooMany = false;
      // One subpath: its length and the renderer's describe the same curve, so the
      // ratio converts dash lengths exactly. (Several subpaths share one total.)
      const kids = (src.children as any[]).filter((k) => k.length > 0);
      const ratio = opts.renderedLength && kids.length === 1 ? kids[0].length / opts.renderedLength : 1;
      const scale = Math.abs(ratio - 1) < 0.05 ? ratio : 1;
      for (const sub of src.children as any[]) {
        if (!pattern) { pieces.push(sub.clone({ insert: false })); continue; }
        const cut = dashPieces(sub, pattern, opts.dashOffset ?? 0, scale);
        if (!cut) { tooMany = true; break; }
        pieces.push(...cut);
      }
      if (!tooMany) {
        if (cap === 'square') for (const p of pieces) if (!p.closed) squareEnds(p, width / 2);
        const outlines = pieces.map(stroke).filter((o: any) => o && !o.isEmpty());
        out = uniteAll(outlines)?.pathData ?? '';
      }
    }
  } catch { out = ''; }
  src.remove();
  return out;
}

/** Where a path starts and ends, and which way it is heading there (degrees) —
 *  the frames `marker-start` / `marker-end` are placed in. Requires the engine. */
export function pathEndFrames(d: string): { start: PathFrame; end: PathFrame } | null {
  if (!paper) throw new Error('Boolean engine not loaded — call ensureBooleanEngine() first.');
  if (!d.trim()) return null;
  const src = new paper.CompoundPath({ pathData: d, insert: false });
  let out: { start: PathFrame; end: PathFrame } | null = null;
  try {
    const kids = (src.children as any[]).filter((k) => k.length > 0);
    const first = kids[0], last = kids[kids.length - 1];
    if (first && last) {
      const t0 = first.getTangentAt(0);
      const t1 = last.getTangentAt(last.length) ?? last.getTangentAt(Math.max(0, last.length - LEN_EPS));
      const p0 = first.firstSegment.point;
      const p1 = last.closed ? last.firstSegment.point : last.lastSegment.point;
      if (t0 && t1) out = { start: { x: p0.x, y: p0.y, angle: t0.angle }, end: { x: p1.x, y: p1.y, angle: t1.angle } };
    }
  } catch { out = null; }
  src.remove();
  return out;
}

// ---- Core computation ----

function toItem(d: string): any {
  // CompoundPath handles single- and multi-subpath geometry uniformly.
  return new paper.CompoundPath({ pathData: d, insert: false });
}

/**
 * Run a boolean op over operand `d` strings (given bottom→top in z-order, all in
 * the SAME coordinate space). Returns one `d` for single-output ops, or an array
 * of piece `d`s for 'divide'. Requires {@link ensureBooleanEngine} to have run.
 */
export function computeBoolean(operandDs: string[], op: BooleanOp): string[] {
  if (!paper) throw new Error('Boolean engine not loaded — call ensureBooleanEngine() first.');
  const ds = operandDs.filter((d) => d && d.trim());
  if (ds.length < 2) return ds.slice();

  const items = ds.map(toItem);
  try {
    if (op === 'divide') return divideAll(items);

    let acc = items[0];
    for (let i = 1; i < items.length; i++) {
      const next = items[i];
      acc =
        op === 'unite' ? acc.unite(next)
        : op === 'subtract' ? acc.subtract(next)
        : op === 'intersect' ? acc.intersect(next)
        : acc.exclude(next);
    }
    const d = pathDataOf(acc);
    return d ? [d] : [];
  } finally {
    for (const it of items) it.remove();
  }
}

/** True when a paper item has effectively no area / no geometry. */
function isEmptyItem(item: any): boolean {
  if (!item) return true;
  const d = (item.pathData ?? '').trim();
  if (!d) return true;
  return Math.abs(item.area ?? 0) < 1e-4;
}

/**
 * Divide: partition the union of the shapes into their atomic arrangement faces
 * (every minimal region), each disjoint. Incremental partition — for each new
 * shape, split existing faces into inside/outside pieces and keep the shape's
 * not-yet-covered remainder. Correct for any number of shapes (unlike a naive
 * pairwise divide, which leaves overlapping pieces).
 */
function divideAll(items: any[]): string[] {
  let faces: any[] = [items[0]];
  for (let k = 1; k < items.length; k++) {
    const shape = items[k];
    let remainder = shape;
    const next: any[] = [];
    for (const face of faces) {
      const inter = face.intersect(shape, { insert: false });
      if (isEmptyItem(inter)) { next.push(face); continue; }
      next.push(inter);
      const outside = face.subtract(shape, { insert: false });
      if (!isEmptyItem(outside)) next.push(outside);
      remainder = remainder.subtract(face, { insert: false });
    }
    if (!isEmptyItem(remainder)) next.push(remainder);
    faces = next;
  }
  return faces.map(pathDataOf).filter((d): d is string => !!d && !!d.trim());
}

function pathDataOf(item: any): string {
  if (!item) return '';
  const d = (item.pathData ?? '').trim();
  return d;
}

// ---- SVG primitive → path `d` ----

function n(el: Element, attr: string, dflt = 0): number {
  const v = el.getAttribute(attr);
  if (v === null) return dflt;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : dflt;
}

/** Round-rect path honoring SVG's rx/ry defaulting rules. */
function rectPath(x: number, y: number, w: number, h: number, rxAttr: number | null, ryAttr: number | null): string {
  let rx = rxAttr ?? ryAttr ?? 0;
  let ry = ryAttr ?? rxAttr ?? 0;
  rx = Math.min(Math.max(rx, 0), w / 2);
  ry = Math.min(Math.max(ry, 0), h / 2);
  if (rx === 0 || ry === 0) {
    return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
  }
  // Corners via elliptical arcs; transformPathData() converts them to cubics.
  return (
    `M ${x + rx} ${y}` +
    ` L ${x + w - rx} ${y} A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry}` +
    ` L ${x + w} ${y + h - ry} A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
    ` L ${x + rx} ${y + h} A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
    ` L ${x} ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`
  );
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  if (rx <= 0 || ry <= 0) return '';
  return (
    `M ${cx - rx} ${cy}` +
    ` A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy}` +
    ` A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`
  );
}

function pointsPath(points: string, close: boolean): string {
  const nums = (points.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
  if (nums.length < 4) return '';
  let d = `M ${nums[0]} ${nums[1]}`;
  for (let i = 2; i + 1 < nums.length; i += 2) d += ` L ${nums[i]} ${nums[i + 1]}`;
  return close ? d + ' Z' : d;
}

/** Geometry of any supported leaf element as a local-space path `d`. */
export function localPathData(el: SVGElement): string {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'path': return el.getAttribute('d') ?? '';
    case 'rect': {
      const rx = el.hasAttribute('rx') ? n(el, 'rx') : null;
      const ry = el.hasAttribute('ry') ? n(el, 'ry') : null;
      return rectPath(n(el, 'x'), n(el, 'y'), n(el, 'width'), n(el, 'height'), rx, ry);
    }
    case 'ellipse': return ellipsePath(n(el, 'cx'), n(el, 'cy'), n(el, 'rx'), n(el, 'ry'));
    case 'circle': return ellipsePath(n(el, 'cx'), n(el, 'cy'), n(el, 'r'), n(el, 'r'));
    case 'polygon': return pointsPath(el.getAttribute('points') ?? '', true);
    case 'polyline': return pointsPath(el.getAttribute('points') ?? '', false);
    case 'line': return `M ${n(el, 'x1')} ${n(el, 'y1')} L ${n(el, 'x2')} ${n(el, 'y2')}`;
    case 'g': return '';
    default: return '';
  }
}

/**
 * An element's geometry in the order the RENDERER walks it — which is what a dash
 * pattern is measured along. SVG starts an ellipse at 3 o'clock and goes clockwise;
 * {@link localPathData} starts it at 9 o'clock going the other way (kept as is:
 * variable-width profiles and converted paths are positioned along that one).
 * Every other shape already matches.
 */
export function strokeOrderPathData(el: SVGElement): string {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'ellipse' && tag !== 'circle') return localPathData(el);
  const cx = n(el, 'cx'), cy = n(el, 'cy');
  const rx = tag === 'circle' ? n(el, 'r') : n(el, 'rx');
  const ry = tag === 'circle' ? n(el, 'r') : n(el, 'ry');
  if (rx <= 0 || ry <= 0) return '';
  return `M ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy} Z`;
}

/**
 * Geometry of an element expressed in a target coordinate space, given the matrix
 * that maps the element's local coords into that space. Béziers are affine, so
 * this is exact. Used to feed operands to {@link computeBoolean} in a common space.
 */
export function elementPathData(el: SVGElement, toTargetSpace: DOMMatrix): string {
  const local = localPathData(el);
  if (!local.trim()) return '';
  return transformPathData(local, toTargetSpace);
}

// ---- Export ----

/**
 * Flatten live booleans for export, in-place on a DOM subtree (operate on a CLONE
 * — this is destructive to the tree). For each `<g data-boolean>` it drops the
 * editable operand children and the internal markers, leaving a plain group that
 * paints only the cached result path. Keeps export markup clean and leak-free.
 */
export function stripBooleanOperands(root: Element): void {
  const wrappers = root.querySelectorAll('[data-boolean]');
  wrappers.forEach((w) => {
    w.querySelectorAll(':scope > [data-bool-operand]').forEach((op) => op.remove());
    w.removeAttribute('data-boolean');
    w.removeAttribute('data-bool-editing');
    w.querySelectorAll(':scope > [data-bool-result]').forEach((r) => r.removeAttribute('data-bool-result'));
  });
}
