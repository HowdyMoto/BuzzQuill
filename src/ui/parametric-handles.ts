/**
 * On-canvas handles for parametric library shapes (core/parametric.ts):
 *  - pie / arc  : a knob at each arc endpoint → the sweep angles.
 *  - polygon    : a knob to the right → the side count (with a live number).
 *  - ring       : a knob on the inner edge → the inner-radius ratio.
 *  - star       : a knob to the right → point count; a knob on a spike → its depth.
 *  - plus       : a knob on the bar → the arm thickness.
 * Each knob carries its own drag callback (cursor mapped to the element's local
 * space), so the module stays small. Self-contained (own fixed overlay + pointer
 * handling that stops propagation), so it never touches the Select tool / overlay.
 */

import type { AppState } from '../core/state';
import { tokens } from './tokens';
import {
  shapeKind, geomOf, getAngles, setAngles, ptOn, angleOf, regenerate,
  polyGeom, regeneratePolygon, polyHandlePoint,
  ringInner, regenerateRing, ringHandlePoint,
  starGeom, starInner, starPointCount, regenerateStar, starCountHandlePoint, starDepthHandlePoint,
  plusBox, plusArm, regeneratePlus, plusHandlePoint,
} from '../core/parametric';

const NS = 'http://www.w3.org/2000/svg';
const COUNT_STEP = 12; // screen px of vertical drag per added/removed side/point

type DragFn = (lx: number, ly: number, e: PointerEvent, startY: number) => void;

let overlay: SVGSVGElement | null = null;
let state: AppState | null = null;
let drag: { el: SVGElement; fn: DragFn; startY: number } | null = null;

export function setupParametricHandles(s: AppState): void {
  state = s;
  overlay = document.createElementNS(NS, 'svg') as SVGSVGElement;
  overlay.id = 'parametric-overlay';
  overlay.setAttribute('style', 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:64;overflow:visible');
  document.body.appendChild(overlay);
  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerup', onUp);
}

export function updateParametricHandles(s: AppState): void {
  state = s;
  if (drag) return; // mid-drag: onMove owns the overlay
  clear();
  if (s.currentTool !== 'select' || s.interactive) return;
  if (s.selectedShapeIds.length !== 1) return;
  const el = s.getSelectedShape()?.element;
  if (el && shapeKind(el)) render(el);
}

function clear(): void { overlay?.replaceChildren(); }
const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
function apply(m: DOMMatrix, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}
function unwrap(near: number, raw: number): number {
  while (raw - near > 180) raw -= 360;
  while (raw - near < -180) raw += 360;
  return raw;
}

function knob(el: SVGElement, sx: number, sy: number, fn: DragFn): void {
  const c = document.createElementNS(NS, 'circle');
  c.setAttribute('cx', String(sx)); c.setAttribute('cy', String(sy)); c.setAttribute('r', '6');
  c.setAttribute('fill', '#fff'); c.setAttribute('stroke', tokens.selectionAccent); c.setAttribute('stroke-width', '1.5');
  c.setAttribute('style', 'pointer-events:all;cursor:pointer');
  c.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    drag = { el, fn, startY: e.clientY };
    state?.setInteractive(true);
  });
  overlay!.appendChild(c);
}
function spoke(x1: number, y1: number, x2: number, y2: number): void {
  const l = document.createElementNS(NS, 'line');
  l.setAttribute('x1', String(x1)); l.setAttribute('y1', String(y1));
  l.setAttribute('x2', String(x2)); l.setAttribute('y2', String(y2));
  l.setAttribute('stroke', tokens.selectionAccent); l.setAttribute('stroke-width', '1'); l.setAttribute('opacity', '0.6');
  overlay!.appendChild(l);
}
function label(x: number, y: number, text: string): void {
  const t = document.createElementNS(NS, 'text');
  t.setAttribute('x', String(x)); t.setAttribute('y', String(y));
  t.setAttribute('font-size', '11'); t.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
  t.setAttribute('font-weight', '600'); t.setAttribute('fill', tokens.selectionAccent);
  t.setAttribute('dominant-baseline', 'central'); t.textContent = text;
  overlay!.appendChild(t);
}

function render(el: SVGElement): void {
  clear();
  if (!overlay) return;
  const ctm = (el as unknown as SVGGraphicsElement).getScreenCTM?.();
  if (!ctm) return;
  const L = (p: [number, number]): [number, number] => apply(ctm, p[0], p[1]);
  const kind = shapeKind(el);

  if (kind === 'pie' || kind === 'arc') {
    const g = geomOf(el); if (!g) return;
    const [cx, cy] = L([g.cx, g.cy]);
    for (const which of [0, 1] as const) {
      const [sx, sy] = L(ptOn(g, getAngles(el)[which]));
      spoke(cx, cy, sx, sy);
      knob(el, sx, sy, (lx, ly) => {
        const a = unwrap(getAngles(el)[which], angleOf(g, lx, ly));
        const ang = getAngles(el);
        if (which === 1) ang[1] = clampN(a, ang[0] + 1, ang[0] + 360);
        else ang[0] = clampN(a, ang[1] - 360, ang[1] - 1);
        setAngles(el, ang[0], ang[1]);
        regenerate(el);
      });
    }
  } else if (kind === 'polygon') {
    const g = polyGeom(el); if (!g) return;
    const [px, py] = L(polyHandlePoint(g)); const hx = px + 16;
    spoke(px, py, hx, py); label(hx + 12, py, String(g.sides));
    knob(el, hx, py, (_lx, _ly, e, startY) => regeneratePolygon(el, g, clampN(g.sides + Math.round((startY - e.clientY) / COUNT_STEP), 3, 60)));
  } else if (kind === 'ring') {
    const g = geomOf(el); if (!g) return; const inner = ringInner(el);
    const [cx, cy] = L([g.cx, g.cy]); const [ix, iy] = L(ringHandlePoint(g, inner));
    spoke(cx, cy, ix, iy);
    knob(el, ix, iy, (lx, ly) => regenerateRing(el, g, clampN(Math.hypot(lx - g.cx, ly - g.cy) / (g.rx || 1), 0.05, 0.9)));
  } else if (kind === 'star') {
    const g = starGeom(el); if (!g) return;
    const [px, py] = L(starCountHandlePoint(g)); const hx = px + 16;
    spoke(px, py, hx, py); label(hx + 12, py, String(g.points));
    knob(el, hx, py, (_lx, _ly, e, startY) => regenerateStar(el, g, clampN(g.points + Math.round((startY - e.clientY) / COUNT_STEP), 3, 30), starInner(el)));
    const [dx, dy] = L(starDepthHandlePoint(g, g.inner));
    spoke(...L([g.cx, g.cy]), dx, dy);
    knob(el, dx, dy, (lx, ly) => regenerateStar(el, g, starPointCount(el), clampN(Math.hypot(lx - g.cx, ly - g.cy) / (g.rx || 1), 0.1, 0.95)));
  } else if (kind === 'plus') {
    const box = plusBox(el); if (!box) return; const arm = plusArm(el);
    const [hx, hy] = L(plusHandlePoint(box, arm));
    knob(el, hx, hy, (lx) => regeneratePlus(el, box, clampN((2 * Math.abs(lx - (box.x + box.width / 2))) / Math.min(box.width, box.height), 0.1, 0.85)));
  }
}

function onMove(e: PointerEvent): void {
  if (!drag || !state) return;
  const ctm = (drag.el as unknown as SVGGraphicsElement).getScreenCTM?.();
  if (!ctm) return;
  const [lx, ly] = apply(ctm.inverse(), e.clientX, e.clientY);
  drag.fn(lx, ly, e, drag.startY);
  render(drag.el);
  state.onChange_public();
}

function onUp(): void {
  if (!drag || !state) return;
  drag = null;
  state.setInteractive(false);
  state.saveHistory();
  state.onChange_public();
  updateParametricHandles(state);
}
