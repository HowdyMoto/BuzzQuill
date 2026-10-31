/**
 * Alt-hover measurement overlay (Figma/Sketch "Option-hover to measure"). With a
 * single object selected in the Select tool, holding Alt and hovering another object
 * draws red measurement lines + distance labels between the two: the GAP when they're
 * apart (side-by-side or stacked), or the four edge INSETS when one contains/overlaps
 * the other (e.g. distance from the selection to a frame's edges). Distances read in
 * document units (screen px ÷ zoom); the whole thing is passive, transient chrome.
 *
 * It's a fixed, pointer-events-none SVG over the viewport, drawn in client-pixel
 * coordinates from each element's getBoundingClientRect — so it aligns with what's on
 * screen regardless of frame/group transforms, and stays a constant on-screen size.
 */

import type { AppState } from '../core/state';
import type { CanvasController } from '../core/canvas';

const NS = 'http://www.w3.org/2000/svg';
const COLOR = '#f24822'; // Figma's measurement red

let overlay: SVGSVGElement | null = null;
let state: AppState | null = null;
let canvas: CanvasController | null = null;
let altHeld = false;
let client = { x: 0, y: 0 };

export function setupMeasureOverlay(s: AppState, c: CanvasController): void {
  state = s; canvas = c;
  overlay = document.createElementNS(NS, 'svg') as SVGSVGElement;
  overlay.id = 'measure-overlay';
  overlay.setAttribute('style',
    'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:60;overflow:visible');
  document.body.appendChild(overlay);

  window.addEventListener('keydown', (e) => { if (e.key === 'Alt' && !altHeld) { altHeld = true; render(); } });
  window.addEventListener('keyup', (e) => { if (e.key === 'Alt') { altHeld = false; clear(); } });
  window.addEventListener('blur', () => { altHeld = false; clear(); });
  window.addEventListener('pointermove', (e) => {
    client = { x: e.clientX, y: e.clientY };
    if (altHeld) render();
  }, { passive: true });
}

function clear(): void { overlay?.replaceChildren(); }

function render(): void {
  clear();
  if (!altHeld || !state || !canvas || !overlay) return;
  if (state.currentTool !== 'select' || state.interactive) return;
  const ids = state.selectedShapeIds;
  if (ids.length !== 1) return; // measure FROM a single reference object
  const refEl = state.findShapeById(ids[0])?.element as SVGElement | undefined;
  if (!refEl) return;
  const targetEl = resolveTarget(document.elementFromPoint(client.x, client.y), refEl,
    (id) => !!state?.findShapeById(id));
  if (!targetEl) return;
  let R: DOMRect, T: DOMRect;
  try {
    R = (refEl as unknown as SVGGraphicsElement).getBoundingClientRect();
    T = (targetEl as unknown as SVGGraphicsElement).getBoundingClientRect();
  } catch { return; }
  if ((!R.width && !R.height) || (!T.width && !T.height)) return;
  drawMeasurements(R, T, canvas.getZoom() || 1);
}

/** The shape/frame under the cursor to measure against — the innermost `shape-*`
 *  ancestor that isn't the reference. Null when hovering the reference itself. */
function resolveTarget(
  hit: Element | null, refEl: SVGElement, isShape: (id: string) => boolean,
): SVGElement | null {
  if (!hit || refEl.contains(hit)) return null;
  let el: Element | null = hit;
  while (el && el !== document.body) {
    // Model lookup, not id spelling — imported shapes keep their authored ids.
    if (el.id && isShape(el.id) && el !== refEl) return el as SVGElement;
    el = el.parentElement;
  }
  return null;
}

function drawMeasurements(R: DOMRect, T: DOMRect, zoom: number): void {
  const val = (px: number) => String(Math.round(Math.abs(px) / zoom));

  // Position a gap's measurement line within the two boxes' shared band (else midway).
  const sharedY = () => {
    const t = Math.max(R.top, T.top), b = Math.min(R.bottom, T.bottom);
    return t < b ? (t + b) / 2 : (R.top + R.height / 2 + T.top + T.height / 2) / 2;
  };
  const sharedX = () => {
    const l = Math.max(R.left, T.left), r = Math.min(R.right, T.right);
    return l < r ? (l + r) / 2 : (R.left + R.width / 2 + T.left + T.width / 2) / 2;
  };

  let drewGap = false;
  if (R.left >= T.right) { hMeasure(T.right, R.left, sharedY(), val); drewGap = true; }
  else if (T.left >= R.right) { hMeasure(R.right, T.left, sharedY(), val); drewGap = true; }
  if (R.top >= T.bottom) { vMeasure(T.bottom, R.top, sharedX(), val); drewGap = true; }
  else if (T.top >= R.bottom) { vMeasure(R.bottom, T.top, sharedX(), val); drewGap = true; }

  if (!drewGap) {
    // Overlapping / contained → the four edge insets (selection → target edges).
    const my = R.top + R.height / 2, mx = R.left + R.width / 2;
    hMeasure(Math.min(R.left, T.left), Math.max(R.left, T.left), my, val);   // left
    hMeasure(Math.min(R.right, T.right), Math.max(R.right, T.right), my, val); // right
    vMeasure(Math.min(R.top, T.top), Math.max(R.top, T.top), mx, val);        // top
    vMeasure(Math.min(R.bottom, T.bottom), Math.max(R.bottom, T.bottom), mx, val); // bottom
  }
}

function hMeasure(x1: number, x2: number, y: number, val: (px: number) => string): void {
  if (Math.abs(x2 - x1) < 0.75) return;
  line(x1, y, x2, y); tick(x1, y, true); tick(x2, y, true);
  label((x1 + x2) / 2, y, val(x2 - x1));
}
function vMeasure(y1: number, y2: number, x: number, val: (px: number) => string): void {
  if (Math.abs(y2 - y1) < 0.75) return;
  line(x, y1, x, y2); tick(x, y1, false); tick(x, y2, false);
  label(x, (y1 + y2) / 2, val(y2 - y1));
}

function line(x1: number, y1: number, x2: number, y2: number): void {
  const l = document.createElementNS(NS, 'line');
  l.setAttribute('x1', String(x1)); l.setAttribute('y1', String(y1));
  l.setAttribute('x2', String(x2)); l.setAttribute('y2', String(y2));
  l.setAttribute('stroke', COLOR); l.setAttribute('stroke-width', '1');
  overlay!.appendChild(l);
}
/** A short end cap perpendicular to the measurement line. `horiz` = the line is horizontal. */
function tick(x: number, y: number, horiz: boolean): void {
  const t = document.createElementNS(NS, 'line');
  const d = 3.5;
  t.setAttribute('x1', String(horiz ? x : x - d)); t.setAttribute('y1', String(horiz ? y - d : y));
  t.setAttribute('x2', String(horiz ? x : x + d)); t.setAttribute('y2', String(horiz ? y + d : y));
  t.setAttribute('stroke', COLOR); t.setAttribute('stroke-width', '1');
  overlay!.appendChild(t);
}
function label(cx: number, cy: number, text: string): void {
  const t = document.createElementNS(NS, 'text');
  t.setAttribute('font-size', '11'); t.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
  t.setAttribute('font-weight', '600'); t.setAttribute('fill', '#fff');
  t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'central');
  t.textContent = text;
  overlay!.appendChild(t);
  let w = text.length * 7;
  try { const m = (t as unknown as SVGTextContentElement).getComputedTextLength(); if (m) w = m; } catch { /* not laid out */ }
  const bw = w + 10, bh = 15;
  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('x', String(cx - bw / 2)); rect.setAttribute('y', String(cy - bh / 2));
  rect.setAttribute('width', String(bw)); rect.setAttribute('height', String(bh));
  rect.setAttribute('rx', '3.5'); rect.setAttribute('fill', COLOR);
  overlay!.insertBefore(rect, t); // pill behind the text
  t.setAttribute('x', String(cx)); t.setAttribute('y', String(cy));
}
