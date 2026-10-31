// ---------------------------------------------------------------------------
// The direction overlay: chevrons running along a path from a start marker to an end
// marker, and the flourish when a path turns around.
//
// It answers a question the canvas otherwise can't: which way does this path run?
// Three things ask it:
//   - the Direction tool shows every path, emphasising the one under the pointer;
//   - hovering Reverse on the path bar previews the selection;
//   - a reversal plays out on the shapes it changed, whichever way it was triggered,
//     and lingers for a moment before fading.
//
// The flourish is the path re-reading itself. A comet leaves the new start and runs
// the new way; each chevron turns over as the comet passes it, and each point takes
// its new number. Nothing about it is decoration: it IS the new drawing order, played
// once. Then the chevrons pick up speed in the new direction.
//
// Everything here is chrome in #direction-layer. It is never in the drawing layer, so
// no save or history snapshot can see it. Geometry comes from the same parser as the
// reversal, read fresh from the DOM, so what's shown is what the file says. Flows are
// sampled up front and animated from those samples, with no geometry calls per frame.
// ---------------------------------------------------------------------------

import type { AppState } from '../core/state';
import type { CanvasController } from '../core/canvas';
import type { Point, ShapeData } from '../core/types';
import { matrixBetween } from '../core/coords';
import { parsePath, reversedAnchorIndex, type SubPath } from '../core/path-model';
import { directedLeaves, directionPathData, directionSourceEl } from '../core/path-direction';
import { tokens } from './tokens';
import { showToast } from './toast';

const NS = 'http://www.w3.org/2000/svg';

// All in screen pixels (÷ zoom at the point of use) and milliseconds.
const CHEVRON_GAP = 72;       // spacing between chevrons
const CHEVRON_SIZE = 5.5;
const FLOW_SPEED = 44;        // calm: px/s
const SAMPLE_STEP = 6;        // polyline resolution of a curve
const SHORTEST_DRAWN = 14;    // a run shorter than this on screen gets no chevrons
const HIT_TOLERANCE = 10;     // how near a line counts as on it
const LABEL_CLEARANCE = 16;   // number labels closer than this are dropped
const MAX_ANIMATED = 120;     // past this many paths, only the longest on screen run
const MAX_LABELLED_POINTS = 64;
const COMET_SPEED = 1500;     // px/s, within COMET_MS
const COMET_MS: [number, number] = [420, 950];
const COMET_TAIL = 150;
const TURN_MS = 300;          // a chevron turning over
const SETTLE_MS = 500;        // chevrons getting back up to speed
const LINGER_MS = 1700;       // how long a reversal's flow stays once it's played

/** One subpath, flattened into the overlay's space. */
interface Run {
  xs: Float64Array; ys: Float64Array;
  /** Distance along the run at each sample. */
  cum: Float64Array;
  length: number;
  closed: boolean;
  /** The written points, in order, with their distance along the run. */
  anchors: { x: number; y: number; s: number }[];
  minX: number; minY: number; maxX: number; maxY: number;
  /** Shoelace over the samples: positive = clockwise on screen (y runs down). */
  area: number;
  /** The point dots and number labels currently on screen, by anchor. */
  dots: SVGCircleElement[];
  labels: (SVGTextElement | null)[];
  /** Chevron phase, in overlay units. */
  phase: number;
  comet: SVGPathElement[];
  head: SVGCircleElement | null;
  /** How long this run's comet takes; 0 without one. */
  cometMs: number;
}

interface Flow {
  id: string;
  shape: ShapeData;
  /** The geometry this was sampled from + its placement — unchanged means keep it. */
  key: string;
  runs: Run[];
  g: SVGGElement;
  line: SVGPathElement;
  halo: SVGPathElement;
  ink: SVGPathElement;
  marks: SVGGElement;
  /** Whether this flow is on screen and within budget. */
  drawn: boolean;
  /** Time this flow first appeared; chevrons grow in from it. */
  bornAt: number;
  /** When its last reversal started, or -1. */
  waveAt: number;
  /** When the flourish's flow stops lingering (0 = not lingering). */
  fadeAt: number;
  emphasised: boolean;
  /** What the markers were last drawn for; unchanged means leave them alone. */
  marksFor: string;
}

/** A short one-shot effect (a ripple, a marker popping in). */
interface Fx { start: number; dur: number; step: (p: number) => void; done?: () => void }

let state: AppState | null = null;
let canvas: CanvasController | null = null;
let layer: SVGGElement | null = null;

let toolActive = false;
let previewIds: string[] = [];
let hoveredId: string | null = null;
const flows = new Map<string, Flow>();
let fx: Fx[] = [];
let raf = 0;
let lastTick = 0;
let sampledZoom = 0;

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const px = (): number => 1 / (canvas?.getZoom() || 1);
const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOutBack = (t: number): number => { const c = 1.9; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };
const smooth = (t: number): number => t * t * (3 - 2 * t);

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

// ---- Geometry ---------------------------------------------------------------

/** Flatten a subpath through `m` into samples. */
function flatten(sp: SubPath, m: DOMMatrix): Run | null {
  const n = sp.anchors.length;
  if (n < 2) return null;
  const tx = (x: number, y: number): [number, number] => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  const xs: number[] = [], ys: number[] = [];
  const zoom = canvas?.getZoom() || 1;
  const starts: number[] = []; // sample index of each anchor
  const push = (p: [number, number]) => { xs.push(p[0]); ys.push(p[1]); };
  push(tx(sp.anchors[0].x, sp.anchors[0].y));
  starts.push(0);
  for (let i = 0; i < (sp.closed ? n : n - 1); i++) {
    const a = sp.anchors[i], b = sp.anchors[(i + 1) % n];
    if (a.outX === undefined && b.inX === undefined) {
      push(tx(b.x, b.y));
    } else {
      const c1x = a.outX ?? a.x, c1y = a.outY ?? a.y, c2x = b.inX ?? b.x, c2y = b.inY ?? b.y;
      const p0 = tx(a.x, a.y), p1 = tx(c1x, c1y), p2 = tx(c2x, c2y), p3 = tx(b.x, b.y);
      const rough = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
      const steps = Math.max(2, Math.min(64, Math.ceil((rough * zoom) / SAMPLE_STEP)));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, u = 1 - t;
        const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
        push([w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0], w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1]]);
      }
    }
    if (i + 1 < n) starts.push(xs.length - 1);
  }
  const count = xs.length;
  const X = new Float64Array(xs), Y = new Float64Array(ys);
  const cum = new Float64Array(count);
  let minX = X[0], minY = Y[0], maxX = X[0], maxY = Y[0], area = 0;
  for (let i = 1; i < count; i++) {
    cum[i] = cum[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]);
    area += X[i - 1] * Y[i] - X[i] * Y[i - 1];
    if (X[i] < minX) minX = X[i]; if (X[i] > maxX) maxX = X[i];
    if (Y[i] < minY) minY = Y[i]; if (Y[i] > maxY) maxY = Y[i];
  }
  const length = cum[count - 1];
  if (!(length > 0)) return null;
  return {
    xs: X, ys: Y, cum, length, closed: sp.closed,
    anchors: starts.map(i => ({ x: X[i], y: Y[i], s: cum[i] })),
    minX, minY, maxX, maxY, area, dots: [], labels: [], phase: 0, comet: [], head: null, cometMs: 0,
  };
}

/** Position and heading at distance `s` along a run. */
function at(run: Run, s: number): { x: number; y: number; a: number } {
  const { cum, xs, ys } = run;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  const span = cum[hi] - cum[lo] || 1;
  const t = clamp01((s - cum[lo]) / span);
  return {
    x: xs[lo] + (xs[hi] - xs[lo]) * t,
    y: ys[lo] + (ys[hi] - ys[lo]) * t,
    a: Math.atan2(ys[hi] - ys[lo], xs[hi] - xs[lo]),
  };
}

function polyline(run: Run): string {
  let d = `M${run.xs[0]} ${run.ys[0]}`;
  for (let i = 1; i < run.xs.length; i++) d += `L${run.xs[i]} ${run.ys[i]}`;
  return d;
}

/** How far along the run a comet is, `t` ms in. Eases in and out. */
const cometAt = (run: Run, t: number): number => run.length * (1 - Math.cos(Math.PI * clamp01(t / run.cometMs))) / 2;
/** When the comet reaches distance `s`: the inverse of {@link cometAt}. */
const cometReaches = (run: Run, s: number): number => (run.cometMs * Math.acos(1 - 2 * clamp01(s / run.length))) / Math.PI;

// ---- Building and syncing flows ----------------------------------------------

/** The shapes that should be showing, in paint order. */
function wanted(): ShapeData[] {
  if (!state) return [];
  if (toolActive) {
    const out: ShapeData[] = [];
    for (const s of state.shapes) if (s.visible) directedLeaves(s, out);
    return out;
  }
  const out: ShapeData[] = [];
  const add = (id: string) => {
    const s = state!.findShapeById(id);
    if (s) directedLeaves(s, out);
  };
  previewIds.forEach(add);
  for (const f of flows.values()) if (f.fadeAt > 0) add(f.id);
  return [...new Set(out)];
}

function makeFlow(shape: ShapeData, key: string, now: number): Flow {
  const g = el('g', { 'data-direction-flow': shape.id });
  const line = el('path', { fill: 'none', stroke: tokens.selectionAccent, opacity: 0.9, 'stroke-linejoin': 'round' });
  const halo = el('path', { fill: 'none', stroke: '#ffffff', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.9 });
  const ink = el('path', { fill: 'none', stroke: tokens.selectionAccent, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  const marks = el('g');
  g.append(line, halo, ink, marks);
  return {
    id: shape.id, shape, key, runs: [], g, line, halo, ink, marks,
    drawn: true, bornAt: now, waveAt: -1, fadeAt: 0, emphasised: false, marksFor: '',
  };
}

/** Sample a flow's geometry, keeping chevrons where they were if the shape hasn't
 *  really changed. */
function resample(flow: Flow, sps: SubPath[], m: DOMMatrix): void {
  const old = flow.runs;
  flow.runs = sps.map(sp => flatten(sp, m)).filter((r): r is Run => !!r);
  flow.runs.forEach((r, i) => { r.phase = old[i]?.phase ?? 0; });
  for (const r of old) { r.comet.forEach(c => c.remove()); r.head?.remove(); }
  flow.line.setAttribute('d', flow.runs.map(polyline).join(''));
}

/** Bring the flows in line with the document. Cheap when nothing changed. */
function sync(): void {
  if (!state || !layer) return;
  const now = performance.now();
  const zoom = canvas?.getZoom() || 1;
  const rescale = !sampledZoom || zoom / sampledZoom > 1.4 || sampledZoom / zoom > 1.4;
  if (rescale) sampledZoom = zoom;

  const shapes = wanted();
  const seen = new Set<string>();
  const ref = layer as unknown as SVGGraphicsElement;
  let cursor: ChildNode | null = layer.firstChild;
  for (const shape of shapes) {
    const src = directionSourceEl(shape);
    if (!src) continue;
    const m = matrixBetween(ref, src as unknown as SVGGraphicsElement);
    if (!m) continue; // hidden: nothing rendered to run along
    const d = directionPathData(shape);
    const key = `${d}|${m.a},${m.b},${m.c},${m.d},${m.e},${m.f}`;
    let flow = flows.get(shape.id);
    if (!flow) {
      flow = makeFlow(shape, '', now);
      flows.set(shape.id, flow);
    }
    flow.shape = shape;
    if (flow.key !== key || rescale) {
      flow.key = key;
      resample(flow, parsePath(d, 1e-6).subpaths, m);
    }
    // Paint order follows the document. Moved only when it's out of place: a state
    // change with thousands of paths on the canvas shouldn't shuffle every one.
    if (flow.g === cursor) cursor = cursor.nextSibling;
    else layer.insertBefore(flow.g, cursor);
    seen.add(shape.id);
  }
  for (const [id, flow] of flows) {
    if (!seen.has(id)) { flow.g.remove(); flows.delete(id); }
  }
  decideDrawn();
  ensureLoop();
}

/** Which flows actually run: what's on screen and long enough, longest first, within
 *  budget. Whatever someone's pointing at or just changed always runs. */
function decideDrawn(): void {
  if (!canvas || !layer) return;
  const svg = layer.ownerSVGElement as SVGSVGElement;
  const box = svg.getBoundingClientRect();
  const a = canvas.screenToSVG(box.left, box.top), b = canvas.screenToSVG(box.right, box.bottom);
  const zoom = canvas.getZoom();
  const scored: { flow: Flow; len: number }[] = [];
  for (const flow of flows.values()) {
    flow.emphasised = flow.id === hoveredId || previewIds.includes(flow.id) || flow.fadeAt > 0;
    let len = 0;
    for (const r of flow.runs) {
      if (r.maxX < a.x || r.minX > b.x || r.maxY < a.y || r.minY > b.y) continue;
      len += r.length * zoom;
    }
    flow.drawn = flow.emphasised;
    if (!flow.emphasised && len >= SHORTEST_DRAWN) scored.push({ flow, len });
  }
  scored.sort((p, q) => q.len - p.len);
  scored.forEach((s, i) => { s.flow.drawn = i < MAX_ANIMATED; });
  for (const flow of flows.values()) {
    flow.g.style.display = flow.drawn ? '' : 'none';
    flow.g.setAttribute('opacity', flow.emphasised || !anyEmphasised() ? '1' : '0.6');
    renderMarks(flow);
  }
}

const anyEmphasised = (): boolean => {
  for (const f of flows.values()) if (f.emphasised) return true;
  return false;
};

// ---- Start / end markers and point numbers -----------------------------------

function startMarker(x: number, y: number, a: number, size: number): SVGGElement {
  const g = el('g', { 'data-direction-start': '', transform: `translate(${x} ${y}) rotate(${(a * 180) / Math.PI}) scale(${size})` });
  g.append(
    el('circle', { r: 7, fill: tokens.directionStart, stroke: '#ffffff', 'stroke-width': 1.5 }),
    el('path', { d: 'M-2.2 -3.4 L3.8 0 L-2.2 3.4 Z', fill: '#ffffff' }),
  );
  return g;
}

function endMarker(x: number, y: number, size: number): SVGGElement {
  const g = el('g', { 'data-direction-end': '', transform: `translate(${x} ${y}) scale(${size})` });
  g.append(el('rect', { x: -5, y: -5, width: 10, height: 10, rx: 2, fill: tokens.directionEnd, stroke: '#ffffff', 'stroke-width': 1.5 }));
  return g;
}

/** Redraw a flow's markers at the current zoom. Numbers only on the path being looked
 *  at, and only when there are few enough to read. */
function renderMarks(flow: Flow): void {
  const unit = px();
  const stamp = `${flow.drawn}|${flow.emphasised}|${unit}|${flow.key}`;
  if (stamp === flow.marksFor) return;
  flow.marksFor = stamp;
  flow.marks.replaceChildren();
  if (!flow.drawn) return;
  flow.line.setAttribute('stroke-width', String((flow.emphasised ? 2 : 0) * unit));
  const total = flow.runs.reduce((n, r) => n + r.anchors.length, 0);
  const labelled = flow.emphasised && total <= MAX_LABELLED_POINTS;
  const placed: { x: number; y: number }[] = [];
  for (const run of flow.runs) {
    run.dots = [];
    run.labels = [];
    if (flow.emphasised) {
      run.anchors.forEach((p, i) => {
        const dot = el('circle', {
          cx: p.x, cy: p.y, r: 2.8 * unit, fill: '#ffffff',
          stroke: tokens.selectionAccent, 'stroke-width': 1.2 * unit, 'data-direction-point': i + 1,
        });
        flow.marks.appendChild(dot);
        run.dots[i] = dot;
        run.labels[i] = null;
        if (!labelled) return;
        if (placed.some(q => Math.hypot(q.x - p.x, q.y - p.y) < LABEL_CLEARANCE * unit)) return;
        placed.push(p);
        const label = el('text', {
          x: p.x + 8 * unit, y: p.y - 8 * unit, 'font-size': 10.5 * unit, 'font-weight': 600,
          'font-family': 'system-ui, sans-serif', fill: '#1a1a1a', stroke: '#ffffff', 'stroke-width': 3 * unit,
          'paint-order': 'stroke', 'text-anchor': 'middle', 'data-direction-label': i,
        });
        label.textContent = String(i + 1);
        flow.marks.appendChild(label);
        run.labels[i] = label;
      });
    }
    const first = run.anchors[0];
    const heading = at(run, Math.min(run.length, 2 * unit)).a;
    if (!run.closed) {
      const last = run.anchors[run.anchors.length - 1];
      flow.marks.appendChild(endMarker(last.x, last.y, unit));
    }
    flow.marks.appendChild(startMarker(first.x, first.y, heading, unit));
  }
}

// ---- The animation loop ------------------------------------------------------

function ensureLoop(): void {
  const live = flows.size > 0 || fx.length > 0;
  if (live && !raf) {
    lastTick = performance.now();
    raf = requestAnimationFrame(tick);
  } else if (!live && raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
}

/** One chevron's path, centred at `(x, y)` pointing along `a`. */
function chevron(x: number, y: number, a: number, size: number): string {
  if (size <= 0.0001) return '';
  const cos = Math.cos(a), sin = Math.sin(a);
  const arm = (dx: number, dy: number): string =>
    `${x + (dx * cos - dy * sin) * size} ${y + (dx * sin + dy * cos) * size}`;
  return `M${arm(-0.75, -1)}L${arm(0.65, 0)}L${arm(-0.75, 1)}`;
}

function drawChevrons(flow: Flow, now: number, dt: number): void {
  const unit = px();
  const size = CHEVRON_SIZE * unit * (flow.emphasised ? 1.2 : 1);
  const gapWorld = CHEVRON_GAP * unit;
  const still = reducedMotion();
  let d = '';
  for (const run of flow.runs) {
    if (run.length / unit < SHORTEST_DRAWN) continue;
    const wave = flow.waveAt >= 0 ? now - flow.waveAt : Infinity;
    // Stopped through the wave, then getting back up to speed.
    const speed = still ? 0 : smooth(clamp01((wave - run.cometMs) / SETTLE_MS));
    // On a closed loop the gap divides the length evenly, so chevrons wrap seamlessly.
    const count = Math.max(1, Math.round(run.length / gapWorld));
    const gap = run.closed ? run.length / count : Math.min(gapWorld, run.length);
    run.phase = (run.phase + (FLOW_SPEED * unit * dt * speed) / 1000) % gap;
    const appear = clamp01((now - flow.bornAt) / 320);
    for (let s = run.phase; s < run.length; s += gap) {
      // Open runs: chevrons grow out of the start and shrink into the end.
      const edge = run.closed ? 1 : smooth(clamp01(Math.min(s, run.length - s) / (14 * unit)));
      const stagger = clamp01(appear * 1.6 - (s / run.length) * 0.6);
      const p = at(run, s);
      // Still facing the old way until the comet gets here, then turning over.
      const turned = run.cometMs ? easeOutBack(clamp01((wave - cometReaches(run, s)) / TURN_MS)) : 1;
      const lift = run.cometMs ? 1 + 0.5 * Math.sin(Math.PI * clamp01((wave - cometReaches(run, s)) / TURN_MS)) : 1;
      d += chevron(p.x, p.y, p.a + Math.PI * (1 - turned), size * edge * smooth(stagger) * lift);
    }
  }
  flow.ink.setAttribute('d', d);
  flow.halo.setAttribute('d', d);
  flow.ink.setAttribute('stroke-width', String(1.9 * unit));
  flow.halo.setAttribute('stroke-width', String(4.4 * unit));
}

function drawComets(flow: Flow, now: number): void {
  if (flow.waveAt < 0) return;
  const unit = px();
  const t = now - flow.waveAt;
  let running = false;
  for (const run of flow.runs) {
    if (!run.comet.length) continue;
    const tail = COMET_TAIL * unit;
    // The head runs out at the end of the path and the tail drains in after it.
    const over = t - run.cometMs;
    const head = over > 0 ? run.length + (over / 220) * tail : cometAt(run, t);
    const alive = head - tail < run.length;
    run.comet.forEach((c, i) => {
      const len = tail * (1 - i * 0.3);
      const from = Math.max(0, head - len);
      const seen = Math.max(0, Math.min(head, run.length) - from);
      c.style.display = alive && seen > 0 ? '' : 'none';
      c.setAttribute('stroke-dasharray', `${seen} ${run.length + tail}`);
      c.setAttribute('stroke-dashoffset', String(-from));
      c.setAttribute('stroke-width', String((2.2 + i * 0.9) * unit));
    });
    if (run.head) {
      const p = at(run, Math.min(head, run.length));
      run.head.style.display = over > 0 ? 'none' : '';
      run.head.setAttribute('cx', String(p.x));
      run.head.setAttribute('cy', String(p.y));
      run.head.setAttribute('r', String(4.2 * unit));
      run.head.setAttribute('stroke-width', String(2 * unit));
    }
    if (alive) running = true;
    // Points take their new numbers, and swell, as the comet goes by.
    const n = run.anchors.length;
    run.anchors.forEach((a, i) => {
      const since = t - cometReaches(run, a.s);
      const label = run.labels[i];
      if (label) {
        const shown = String((since >= 0 ? i : reversedAnchorIndex(i, n, run.closed)) + 1);
        if (label.textContent !== shown) label.textContent = shown;
      }
      const bump = Math.sin(Math.PI * clamp01(since / 260));
      run.dots[i]?.setAttribute('r', String((2.8 + 2.6 * bump) * unit));
    });
  }
  if (!running) {
    for (const run of flow.runs) { run.comet.forEach(c => c.remove()); run.comet = []; run.head?.remove(); run.head = null; }
  }
}

function tick(now: number): void {
  raf = 0;
  const dt = Math.min(now - lastTick, 64);
  lastTick = now;

  // A tab switch swaps the document under us without always saying so.
  for (const f of flows.values()) {
    if (!f.shape.element.isConnected) { sync(); break; }
  }

  let lapsed = false;
  for (const flow of flows.values()) {
    if (flow.fadeAt > 0 && now >= flow.fadeAt) {
      flow.fadeAt = 0;
      lapsed = true;
    }
    if (!flow.drawn) continue;
    drawChevrons(flow, now, dt);
    drawComets(flow, now);
  }
  if (lapsed) fadeOutFinished();

  fx = fx.filter((e) => {
    const p = clamp01((now - e.start) / e.dur);
    e.step(p);
    if (p >= 1) { e.done?.(); return false; }
    return true;
  });

  if (flows.size > 0 || fx.length > 0) raf = requestAnimationFrame(tick);
}

/** Flows whose flourish has lapsed: fade the ones nothing else still wants. */
function fadeOutFinished(): void {
  const keep = new Set(wanted().map(s => s.id));
  const now = performance.now();
  for (const [id, flow] of flows) {
    if (keep.has(id)) { flow.emphasised = false; continue; }
    flows.delete(id);
    const g = flow.g;
    fx.push({
      start: now, dur: 260,
      step: (p) => g.setAttribute('opacity', String(1 - smooth(p))),
      done: () => g.remove(),
    });
  }
  decideDrawn();
}

// ---- The flourish ------------------------------------------------------------

function ripple(x: number, y: number, now: number, delay = 0): void {
  if (!layer) return;
  const unit = px();
  const ring = el('circle', { cx: x, cy: y, r: 0, fill: 'none', stroke: tokens.directionStart, opacity: 0 });
  layer.appendChild(ring);
  fx.push({
    start: now + delay, dur: 520,
    step: (p) => {
      if (p <= 0) return;
      ring.setAttribute('r', String((7 + 20 * (1 - (1 - p) * (1 - p))) * unit));
      ring.setAttribute('stroke-width', String(2.4 * (1 - p) * unit));
      ring.setAttribute('opacity', String(0.9 * (1 - p)));
    },
    done: () => ring.remove(),
  });
}

/** Play a reversal on these (already reversed) shapes. */
function playReversal(ids: string[]): void {
  if (!layer || !state) return;
  const now = performance.now();
  const lingerUntil = (ms: number) => (toolActive ? 0 : now + ms + LINGER_MS);
  // Mark them first: only a flow with a pending fade counts as wanted outside the tool.
  for (const id of ids) {
    const shape = state.findShapeById(id);
    if (!shape) continue;
    let flow = flows.get(id);
    if (!flow) {
      flow = makeFlow(shape, '', now);
      flows.set(id, flow);
    }
    flow.fadeAt = toolActive ? 0 : now + 1; // refined below, once its comet is timed
  }
  sync();

  const still = reducedMotion();
  for (const id of ids) {
    const flow = flows.get(id);
    if (!flow) continue;
    flow.bornAt = Math.min(flow.bornAt, now - 400); // already visible: no second entrance
    flow.waveAt = still ? -1 : now;
    let longest = 0;
    for (const run of flow.runs) {
      // The chevrons were at s; the same spots are now at L − s, facing the other way.
      const gap = Math.max(1e-6, run.closed ? run.length / Math.max(1, Math.round(run.length / (CHEVRON_GAP * px()))) : Math.min(CHEVRON_GAP * px(), run.length));
      run.phase = ((run.length - run.phase) % gap + gap) % gap;
      if (still) continue;
      run.cometMs = Math.max(COMET_MS[0], Math.min(COMET_MS[1], (run.length / px() / COMET_SPEED) * 1000));
      longest = Math.max(longest, run.cometMs);
      buildComet(flow, run);
      const a = run.anchors[0], z = run.anchors[run.anchors.length - 1];
      ripple(a.x, a.y, now);
      ripple(run.closed ? a.x : z.x, run.closed ? a.y : z.y, now, run.cometMs);
    }
    flow.fadeAt = lingerUntil(longest);
  }
  decideDrawn();
  ensureLoop();
}

function buildComet(flow: Flow, run: Run): void {
  run.comet.forEach(c => c.remove());
  run.head?.remove();
  const d = polyline(run);
  run.comet = [0.3, 0.55, 1].map(opacity => {
    const c = el('path', {
      d, fill: 'none', stroke: tokens.selectionAccent, opacity,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    });
    c.style.display = 'none';
    flow.g.insertBefore(c, flow.halo);
    return c;
  });
  run.head = el('circle', { fill: '#ffffff', stroke: tokens.selectionAccent });
  run.head.style.display = 'none';
  flow.g.appendChild(run.head);
}

// ---- Public API --------------------------------------------------------------

export function setupDirectionOverlay(s: AppState, c: CanvasController, svg: SVGSVGElement): void {
  state = s;
  canvas = c;
  layer = svg.querySelector('#direction-layer');
}

/** The document or the view changed: follow it. */
export function updateDirectionOverlay(): void {
  if (!state) return;
  // A drag in another tool: a lingering flourish shouldn't be dragged around with it.
  if (state.interactive && !toolActive) {
    let any = false;
    for (const f of flows.values()) if (f.fadeAt > 0) { f.fadeAt = 0; any = true; }
    if (any) fadeOutFinished();
  }
  if (flows.size || toolActive) sync();
}

export function showAllDirections(): void {
  toolActive = true;
  for (const f of flows.values()) f.fadeAt = 0;
  sync();
}

export function hideAllDirections(): void {
  toolActive = false;
  hoveredId = null;
  fadeOutFinished();
  ensureLoop();
}

/** Show these shapes' direction (the path bar's hover), or nothing with []. */
export function previewDirection(ids: string[]): void {
  previewIds = ids;
  if (ids.length) sync();
  else fadeOutFinished();
  ensureLoop();
}

/** Set the emphasised flow. True if that changed anything. */
export function setHoveredDirection(id: string | null): boolean {
  if (id === hoveredId) return false;
  hoveredId = id;
  decideDrawn();
  return true;
}

/** How the hovered path runs, in words. */
export function hoveredDirection(): { name: string; summary: string } | null {
  const flow = hoveredId ? flows.get(hoveredId) : null;
  if (!flow || !flow.runs.length) return null;
  const points = flow.runs.reduce((n, r) => n + r.anchors.length, 0);
  const ofPoints = `${points} point${points === 1 ? '' : 's'}`;
  if (flow.runs.length > 1) return { name: flow.shape.name, summary: `${flow.runs.length} runs · ${ofPoints}` };
  const run = flow.runs[0];
  const way = run.closed ? (run.area >= 0 ? 'clockwise' : 'counterclockwise') : 'open, green to square';
  return { name: flow.shape.name, summary: `${way} · ${ofPoints}` };
}

/**
 * The path under the pointer: anything within reach of a line first, nearest wins and
 * the upper one on a tie; failing that, the shape whose fill the pointer is in.
 */
export function pickDirection(pt: Point, target: Element | null): string | null {
  const reach = HIT_TOLERANCE * px();
  let best: string | null = null;
  let bestDist = reach;
  for (const flow of flows.values()) {
    for (const run of flow.runs) {
      if (pt.x < run.minX - reach || pt.x > run.maxX + reach || pt.y < run.minY - reach || pt.y > run.maxY + reach) continue;
      for (let i = 1; i < run.xs.length; i++) {
        const dist = toSegment(pt, run.xs[i - 1], run.ys[i - 1], run.xs[i], run.ys[i]);
        if (dist <= bestDist) { bestDist = dist; best = flow.id; }
      }
    }
  }
  if (best) return best;
  for (let n: Element | null = target; n && n.id !== 'drawing-layer'; n = n.parentElement) {
    if (n.id && flows.has(n.id)) return n.id;
  }
  return null;
}

function toSegment(p: Point, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 ? clamp01(((p.x - ax) * vx + (p.y - ay) * vy) / len2) : 0;
  return Math.hypot(p.x - (ax + t * vx), p.y - (ay + t * vy));
}

/** Reverse these shapes and play it. */
export function reverseWithFlourish(s: AppState, ids: string[]): void {
  report(s.reversePaths(ids));
}

/** Reverse the selection and play it (the command, the path bar). */
export function reverseSelectionWithFlourish(s: AppState): void {
  report(s.reverseSelectedPaths());
}

function report(result: ReturnType<AppState['reverseSelectedPaths']>): void {
  const { ids, converted, skipped } = result;
  if (ids.length) playReversal(ids);
  const notes: string[] = [];
  if (converted) {
    notes.push(converted === 1
      ? 'A rectangle or ellipse stores no point order, so this one is a path now.'
      : `Rectangles and ellipses store no point order, so ${converted} of them are paths now.`);
  }
  if (skipped.length) {
    const name = skipped.length === 1 ? `“${skipped[0].name}”` : `${skipped.length} objects`;
    notes.push(`${name} ${skipped.length === 1 ? 'has' : 'have'} no path of ${skipped.length === 1 ? 'its' : 'their'} own to reverse — flatten or detach first.`);
  }
  if (notes.length) showToast(notes.join('\n'));
  else if (!ids.length) showToast('Nothing to reverse — select a path with at least two points.');
}
