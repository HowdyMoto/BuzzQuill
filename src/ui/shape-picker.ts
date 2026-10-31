/**
 * Shapes library picker (Freeform-style). A toolbar button opens a popover grid of
 * ready-made parametric shapes (pie wedges, arcs, polygons, arrows, symbols…). Click
 * one and it's inserted at document size, centred in the current view — no manual
 * drawing. The inserted element is ordinary SVG geometry (from core/shape-library),
 * so it selects/resizes/recolours/exports like any other shape.
 */

import type { AppState } from '../core/state';
import type { CanvasController } from '../core/canvas';
import type { ShapeData } from '../core/types';
import { SHAPES, type ShapeDef } from '../core/shape-library';

const NS = 'http://www.w3.org/2000/svg';
const CATS = ['Basic', 'Round', 'Arrows', 'Symbols'] as const;
const INSERT_SIZE = 140;

let popover: HTMLElement | null = null;
let btn: HTMLElement | null = null;
let state: AppState;
let canvas: CanvasController;
let svgCanvas: SVGSVGElement;

const LAST_SHAPE_KEY = 'bq.lastShape';

export function setupShapePicker(s: AppState, c: CanvasController, svg: SVGSVGElement): void {
  state = s; canvas = c; svgCanvas = svg;
  btn = document.getElementById('shapes-lib-btn');
  if (!btn) return;
  buildPopover();
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  document.addEventListener('pointerdown', (e) => {
    if (popover && !popover.hidden && !popover.contains(e.target as Node) && !btn!.contains(e.target as Node)) hide();
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && popover && !popover.hidden) { hide(); e.stopPropagation(); } });
  // The toolbar button wears the LAST-USED shape (#107) — restore across sessions.
  try {
    const last = localStorage.getItem(LAST_SHAPE_KEY);
    const def = last ? SHAPES.find(d => d.name === last) : undefined;
    if (def) setButtonIcon(def);
  } catch { /* storage unavailable — keep the default icon */ }
}

/** Swap the toolbar button's icon to `def`'s mini preview, so the button shows
 *  the shape you last inserted (the picker itself still opens on click). */
function setButtonIcon(def: ShapeDef): void {
  if (!btn) return;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const b = def.build(3, 3, 18, 18);
  const el = document.createElementNS(NS, b.tag);
  for (const [k, v] of Object.entries(b.attrs)) el.setAttribute(k, v);
  if (def.open) { el.setAttribute('fill', 'none'); el.setAttribute('stroke', 'currentColor'); el.setAttribute('stroke-width', '1.8'); el.setAttribute('stroke-linecap', 'round'); }
  else { el.setAttribute('fill', 'none'); el.setAttribute('stroke', 'currentColor'); el.setAttribute('stroke-width', '1.5'); }
  svg.appendChild(el);
  btn.replaceChildren(svg);
  btn.title = `Shapes library — last used: ${def.name}`;
}

function buildPopover(): void {
  popover = document.createElement('div');
  popover.id = 'shape-picker';
  popover.className = 'shape-picker';
  popover.hidden = true;

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'shape-search';
  search.placeholder = 'Search shapes…';

  const grid = document.createElement('div');
  grid.className = 'shape-grid';
  renderGrid(grid, '');
  search.addEventListener('input', () => renderGrid(grid, search.value.trim().toLowerCase()));
  search.addEventListener('keydown', (e) => e.stopPropagation()); // don't trigger canvas shortcuts

  popover.append(search, grid);
  document.body.appendChild(popover);
}

function renderGrid(grid: HTMLElement, q: string): void {
  grid.replaceChildren();
  for (const cat of CATS) {
    const defs = SHAPES.filter(s => s.category === cat && (!q || s.name.toLowerCase().includes(q)));
    if (!defs.length) continue;
    const label = document.createElement('div');
    label.className = 'shape-cat';
    label.textContent = cat;
    grid.appendChild(label);
    const row = document.createElement('div');
    row.className = 'shape-row';
    for (const def of defs) row.appendChild(makeItem(def));
    grid.appendChild(row);
  }
  if (!grid.children.length) {
    const empty = document.createElement('div');
    empty.className = 'shape-empty';
    empty.textContent = 'No shapes match.';
    grid.appendChild(empty);
  }
}

function makeItem(def: ShapeDef): HTMLButtonElement {
  const item = document.createElement('button');
  item.className = 'shape-item';
  item.title = def.name;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  const b = def.build(5, 5, 30, 30);
  const el = document.createElementNS(NS, b.tag);
  for (const [k, v] of Object.entries(b.attrs)) el.setAttribute(k, v);
  if (def.open) { el.setAttribute('fill', 'none'); el.setAttribute('stroke', 'currentColor'); el.setAttribute('stroke-width', '2.4'); el.setAttribute('stroke-linecap', 'round'); }
  else { el.setAttribute('fill', 'currentColor'); }
  svg.appendChild(el);
  item.appendChild(svg);
  item.addEventListener('click', () => insert(def));
  return item;
}

/** Insert `def` centred in the current view at document size, then select it. */
function insert(def: ShapeDef): void {
  const r = svgCanvas.getBoundingClientRect();
  const c = canvas.screenToSVG(r.left + r.width / 2, r.top + r.height / 2);
  const x = c.x - INSERT_SIZE / 2, y = c.y - INSERT_SIZE / 2;
  const b = def.build(x, y, INSERT_SIZE, INSERT_SIZE);

  const el = document.createElementNS(NS, b.tag) as SVGGraphicsElement;
  for (const [k, v] of Object.entries(b.attrs)) el.setAttribute(k, v);
  const id = state.nextId();
  el.id = id;

  const ds = state.defaultStyle;
  const fill = def.open || state.fillNone ? 'none' : ds.fill;
  el.setAttribute('fill', fill);
  // An open shape (arc/line) is invisible without a stroke, so force one there.
  const stroke = def.open ? (state.strokeNone ? '#111111' : ds.stroke) : (state.strokeNone ? null : ds.stroke);
  if (stroke) { el.setAttribute('stroke', stroke); el.setAttribute('stroke-width', String(def.open ? Math.max(ds.strokeWidth, 2) : ds.strokeWidth)); }
  if (ds.opacity !== 1) el.setAttribute('opacity', String(ds.opacity));

  // Parametric shapes carry their kind + params so the on-canvas handles can tweak
  // them; the geometry built above already matches these defaults.
  if (def.param) {
    const p = def.param;
    el.setAttribute('data-shape', p.kind);
    if (p.kind === 'pie' || p.kind === 'arc') {
      el.setAttribute('data-shape-a0', String(p.a0));
      el.setAttribute('data-shape-a1', String(p.a1));
    } else if (p.kind === 'polygon') {
      el.setAttribute('data-shape-sides', String(p.sides));
    } else if (p.kind === 'ring') {
      el.setAttribute('data-shape-inner', String(p.inner));
    } else if (p.kind === 'star') {
      el.setAttribute('data-shape-sides', String(p.points));
      el.setAttribute('data-shape-inner', String(p.inner));
    } else if (p.kind === 'plus') {
      el.setAttribute('data-shape-arm', String(p.arm));
    }
  }

  const name = `${def.name} ${id.replace('shape-', '#')}`;
  el.setAttribute('data-name', name);

  const shape: ShapeData = {
    id, type: b.tag as ShapeData['type'], element: el, name,
    style: { ...ds, fill, stroke: stroke ?? 'none' },
    visible: true, locked: false,
  };
  state.addShape(shape, c);
  state.requestTool?.('select');
  setButtonIcon(def);
  try { localStorage.setItem(LAST_SHAPE_KEY, def.name); } catch { /* ignore */ }
  hide();
}

function toggle(): void { if (popover?.hidden) show(); else hide(); }

function show(): void {
  if (!popover || !btn) return;
  popover.hidden = false;
  // Anchor above the toolbar button, centred on it, clamped to the viewport.
  const b = btn.getBoundingClientRect();
  const pw = popover.offsetWidth, ph = popover.offsetHeight;
  let x = b.left + b.width / 2 - pw / 2;
  let y = b.top - ph - 10;
  if (y < 8) y = b.bottom + 10;
  x = Math.max(8, Math.min(x, window.innerWidth - pw - 8));
  popover.style.left = `${Math.round(x)}px`;
  popover.style.top = `${Math.round(y)}px`;
  btn.classList.add('active');
  (popover.querySelector('.shape-search') as HTMLInputElement | null)?.focus();
}

function hide(): void {
  if (popover) popover.hidden = true;
  btn?.classList.remove('active');
}
