import { tokens } from './tokens';
import type { AppState } from '../core/state';
import type { ShapeData } from '../core/types';
import { pathMidFrame, visualLocalBBox, matrixBetween, matrixAttr, pointMapperBetween } from '../core/coords';
import { isLockedEl } from '../core/locks';

const NS = 'http://www.w3.org/2000/svg';
const HANDLE_SIZE = 6;

// World units per on-screen pixel (= 1 / zoom), set each render. The selection layer
// lives inside the zoomed viewBox, so multiplying every handle SIZE/offset/radius by
// this keeps the chrome a constant on-screen size at any zoom; strokes use
// vector-effect:non-scaling-stroke so their width + dashes stay constant for free.
let vscale = 1;
// The transform gesture in progress (from state.activeGesture), captured each render
// so the dimension badge can show the rotation angle while rotating instead of W×H.
let curGesture: 'move' | 'resize' | 'rotate' | null = null;
// Set each render so the single-selection chrome can reach the doc's text styles
// (for the on-select style tab) without threading state through every draw helper.
let curState: AppState | null = null;
const NONSCALE = 'non-scaling-stroke';
const HANDLE_CURSORS: Record<string, string> = {
  nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize',
  e: 'ew-resize', se: 'nwse-resize', s: 'ns-resize',
  sw: 'nesw-resize', w: 'ew-resize',
};

/** Each handle's pull direction in the shape's OWN space (y down): edges push
 *  straight out, corners along the diagonal between their two edges. */
const HANDLE_AXES: Record<string, [number, number]> = {
  e: [1, 0], w: [-1, 0], s: [0, 1], n: [0, -1],
  se: [1, 1], sw: [-1, 1], ne: [1, -1], nw: [-1, -1],
};

/**
 * The CSS resize cursor whose arrows point along `dx,dy` on SCREEN.
 *
 * A fixed cursor per handle NAME is wrong the moment the shape is rotated: the
 * "↕" on what used to be the top edge points across the direction that handle
 * actually drags. Figma and Illustrator both rotate the cursor with the object.
 * CSS ships only four double-headed arrows (each covers a line, so opposite
 * handles share one), which quantises to 45° — never more than 22.5° off, versus
 * up to 90° before. Continuous rotation needs custom cursor art, which only pays
 * for itself if it stays crisp on HiDPI.
 */
export function resizeCursorFor(dx: number, dy: number): string {
  const a = ((Math.atan2(dy, dx) * 180) / Math.PI + 180) % 180; // 0..180: a line, not a ray
  if (a < 22.5 || a >= 157.5) return 'ew-resize';
  if (a < 67.5) return 'nwse-resize';
  if (a < 112.5) return 'ns-resize';
  return 'nesw-resize';
}

/**
 * Cursor picker for a box drawn through `corners` (nw, ne, se, sw in screen
 * order). It reads the RENDERED edges rather than a rotation angle, so it covers
 * a shape rotated by an ancestor group or frame, and a flipped or non-uniformly
 * scaled one too: the handle's true on-screen direction is whatever the corners
 * say it is. A degenerate box (zero width or height) has no direction to read, so
 * it keeps the by-name cursor.
 */
function handleCursors(corners: { x: number; y: number }[]): (id: string) => string {
  const norm = (x: number, y: number): [number, number] => {
    const l = Math.hypot(x, y);
    return l < 1e-9 ? [0, 0] : [x / l, y / l];
  };
  const [ux, uy] = norm(corners[1].x - corners[0].x, corners[1].y - corners[0].y); // local +x
  const [vx, vy] = norm(corners[3].x - corners[0].x, corners[3].y - corners[0].y); // local +y
  return (id: string): string => {
    const axis = HANDLE_AXES[id];
    const fallback = HANDLE_CURSORS[id] ?? 'pointer';
    if (!axis) return fallback;
    const [lx, ly] = axis;
    const dx = lx * ux + ly * vx, dy = lx * uy + ly * vy;
    return (dx === 0 && dy === 0) ? fallback : resizeCursorFor(dx, dy);
  };
}

function getHandlePositions(x: number, y: number, w: number, h: number) {
  return [
    { id: 'nw', cx: x, cy: y },
    { id: 'n', cx: x + w / 2, cy: y },
    { id: 'ne', cx: x + w, cy: y },
    { id: 'e', cx: x + w, cy: y + h / 2 },
    { id: 'se', cx: x + w, cy: y + h },
    { id: 's', cx: x + w / 2, cy: y + h },
    { id: 'sw', cx: x, cy: y + h },
    { id: 'w', cx: x, cy: y + h / 2 },
  ];
}

function appendResizeHandles(parent: SVGElement, x: number, y: number, w: number, h: number): void {
  const size = HANDLE_SIZE * vscale;
  for (const h2 of getHandlePositions(x, y, w, h)) {
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', String(h2.cx - size / 2));
    rect.setAttribute('y', String(h2.cy - size / 2));
    rect.setAttribute('width', String(size));
    rect.setAttribute('height', String(size));
    rect.setAttribute('fill', 'white');
    rect.setAttribute('stroke', tokens.selectionAccent);
    rect.setAttribute('stroke-width', '1');
    rect.setAttribute('vector-effect', NONSCALE);
    rect.setAttribute('data-handle', h2.id);
    rect.setAttribute('style', `cursor: ${HANDLE_CURSORS[h2.id]}`);
    parent.appendChild(rect);
  }
}

/** Map a point from an element's LOCAL space into the selection layer's space via
 *  the full CTM (so ancestor frame/group transforms + the element's own transform
 *  are all included). Returns null when the element isn't laid out. */
function makeLocalToLayer(selectionLayer: SVGGElement, el: SVGGraphicsElement):
  ((lx: number, ly: number) => { x: number; y: number }) | null {
  return pointMapperBetween(selectionLayer, el);
}

/** A constant-size (÷zoom) circular chrome dot at an ABSOLUTE selection-layer point. */
function drawDot(parent: SVGElement, cx: number, cy: number, r: number,
  fill: string, stroke: string, sw: number, dataHandle?: string, cursor?: string): void {
  const c = document.createElementNS(NS, 'circle');
  c.setAttribute('cx', String(cx)); c.setAttribute('cy', String(cy)); c.setAttribute('r', String(r));
  c.setAttribute('fill', fill); c.setAttribute('stroke', stroke); c.setAttribute('stroke-width', String(sw));
  c.setAttribute('vector-effect', NONSCALE);
  if (dataHandle) { c.setAttribute('data-handle', dataHandle); c.setAttribute('style', `cursor: ${cursor ?? 'pointer'}`); }
  else c.setAttribute('pointer-events', 'none');
  parent.appendChild(c);
}

/** The on-select text-style tab: a constant-size label above the selection's
 *  top-left corner naming the linked style. Amber "●" when it has overrides. */
function drawStyleTab(parent: SVGElement, at: { x: number; y: number }, name: string, overridden: boolean): void {
  const t = document.createElementNS(NS, 'text');
  t.setAttribute('x', String(at.x));
  t.setAttribute('y', String(at.y - 7 * vscale));
  t.setAttribute('font-size', String(10.5 * vscale));
  t.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
  t.setAttribute('font-weight', '600');
  t.setAttribute('fill', tokens.selectionAccent);
  t.setAttribute('pointer-events', 'none');
  if (overridden) {
    const dot = document.createElementNS(NS, 'tspan');
    dot.setAttribute('fill', '#e0a53a');
    dot.textContent = '● ';
    t.appendChild(dot);
  }
  t.appendChild(document.createTextNode(name));
  parent.appendChild(t);
}

/** A large invisible circular hit target (easy grab) at an ABSOLUTE point. */
function drawHit(parent: SVGElement, cx: number, cy: number, r: number, dataHandle: string, cursor: string): void {
  const c = document.createElementNS(NS, 'circle');
  c.setAttribute('cx', String(cx)); c.setAttribute('cy', String(cy)); c.setAttribute('r', String(r));
  c.setAttribute('fill', 'transparent'); c.setAttribute('pointer-events', 'all');
  c.setAttribute('data-handle', dataHandle); c.setAttribute('style', `cursor: ${cursor}`);
  parent.appendChild(c);
}

export function updateSelectionOverlay(state: AppState, selectionLayer: SVGGElement, zoom = 1): void {
  vscale = zoom > 0 ? 1 / zoom : 1; // keep handle chrome a constant on-screen size
  curGesture = state.activeGesture;
  curState = state;
  // Preserve marquee rect if it exists
  const marquee = selectionLayer.querySelector('#marquee-rect');
  selectionLayer.innerHTML = '';
  if (marquee) selectionLayer.appendChild(marquee);

  // While node-editing a path, the node overlay owns the display.
  if (state.editingPathId) return;
  // The Crop tool draws its own session chrome; don't fight it with handles.
  if (state.currentTool === 'crop') return;

  // Show which group is "entered" (double-click isolation), if any.
  drawActiveGroupOutline(state, selectionLayer);

  const selectedIds = state.selectedShapeIds;
  if (selectedIds.length === 0) return;

  // --- Multi-selection: draw individual bbox for each shape + combined bbox ---
  if (selectedIds.length > 1) {
    drawMultiSelection(state, selectionLayer, selectedIds);
    return;
  }

  // --- Single selection: full handles ---
  const shape = state.getSelectedShape();
  if (!shape) return;
  drawSingleSelection(shape, selectionLayer);
}

/** Faint dashed box around the group the user has entered (isolation mode). For a
 *  mask (clip-group) this box is the MASK BOUNDARY (the visible crop region), so the
 *  masked content's larger bbox reads as "clipped to here" rather than a bug — and
 *  it's labelled MASK. */
function drawActiveGroupOutline(state: AppState, selectionLayer: SVGGElement): void {
  const id = state.activeGroupId;
  if (!id) return;
  const shape = state.findShapeById(id);
  if (!shape) return;
  const el = shape.element;
  const isMask = shape.element.hasAttribute('data-clip-group');
  let bbox: DOMRect | null;
  try { bbox = isMask ? visualLocalBBox(el) : el.getBBox(); } catch { return; }
  if (!bbox || (bbox.width === 0 && bbox.height === 0)) return;

  const g = document.createElementNS(NS, 'g');
  // Position via the element's full transform chain so ancestor group transforms are included.
  const lm = matrixBetween(selectionLayer, el);
  if (lm) g.setAttribute('transform', matrixAttr(lm));
  // A mask entered/selected brightens to its violet identity hue (the persistent
  // canvas outline is the muted violet); a plain group uses the neutral accent.
  const activeStroke = isMask ? tokens.maskAccent : tokens.selectionAccent;
  appendRect(g, bbox.x, bbox.y, bbox.width, bbox.height, {
    fill: 'none', stroke: activeStroke, strokeWidth: isMask ? '2' : '1',
    strokeDasharray: isMask ? '4,3' : '3,3', opacity: isMask ? '0.95' : '0.5', pointerEvents: 'none',
  });
  if (isMask) {
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', String(bbox.x));
    t.setAttribute('y', String(bbox.y - 4 * vscale));
    t.setAttribute('font-size', String(10 * vscale));
    t.setAttribute('font-weight', '600');
    t.setAttribute('font-family', 'system-ui, sans-serif');
    t.setAttribute('fill', activeStroke);
    t.setAttribute('pointer-events', 'none');
    t.textContent = 'MASK';
    g.appendChild(t);
  }
  selectionLayer.appendChild(g);
}

function drawSingleSelection(shape: ShapeData, selectionLayer: SVGGElement): void {
  const el = shape.element;
  const gesture = curGesture;
  let bbox: DOMRect;
  if (shape.type === 'frame') {
    // A frame's selection box hugs its OWN bounds (local 0,0,w,h), not the union
    // of its possibly-overflowing children that getBBox would return.
    const w = parseFloat(shape.element.getAttribute('data-frame-w') ?? '0');
    const h = parseFloat(shape.element.getAttribute('data-frame-h') ?? '0');
    bbox = new DOMRect(0, 0, w, h);
  } else {
    // visualLocalBBox hugs what's actually visible for a cropped image (its viewBox)
    // and a clip-group mask (mask ∩ content) — plain getBBox otherwise.
    const vb = visualLocalBBox(el);
    if (!vb) return;
    bbox = vb;
  }
  if (bbox.width === 0 && bbox.height === 0) return;

  const { x, y, width: w, height: h } = bbox;

  // Map the shape's LOCAL bbox into selection-layer space and draw all chrome there
  // at a constant on-screen size. (Previously the whole handle group carried the
  // element's transform, so an object with a SCALE in its transform — e.g. an
  // imported/resized shape — squished its own handles. Same fix the node overlay got.)
  const tp = makeLocalToLayer(selectionLayer, el);
  if (!tp) return;
  const g = document.createElementNS(NS, 'g'); // untransformed

  // Bounding box: a polygon through the four true corners, so it still hugs a
  // rotated/scaled shape while its stroke stays a constant width.
  const corners = [tp(x, y), tp(x + w, y), tp(x + w, y + h), tp(x, y + h)];
  const poly = document.createElementNS(NS, 'polygon');
  poly.setAttribute('points', corners.map(p => `${p.x},${p.y}`).join(' '));
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', tokens.selectionAccent);
  poly.setAttribute('stroke-width', '1');
  poly.setAttribute('vector-effect', NONSCALE);
  poly.setAttribute('pointer-events', 'none');
  g.appendChild(poly);

  // Area-text overflow badge (#120): a red ⊞ near the bottom-right corner when the
  // wrapped content no longer fits the box's fixed height. Nudged toward the box
  // centre so it doesn't sit under the SE resize handle.
  if (shape.element.hasAttribute('data-area-overflow')) {
    const se = corners[2];
    const mid = tp(x + w / 2, y + h / 2);
    const vlen = Math.hypot(mid.x - se.x, mid.y - se.y) || 1;
    const p = { x: se.x + ((mid.x - se.x) / vlen) * 16 * vscale, y: se.y + ((mid.y - se.y) / vlen) * 16 * vscale };
    const s2 = 10 * vscale;
    const badge = document.createElementNS(NS, 'rect');
    badge.setAttribute('x', String(p.x - s2 / 2));
    badge.setAttribute('y', String(p.y - s2 / 2));
    badge.setAttribute('width', String(s2));
    badge.setAttribute('height', String(s2));
    badge.setAttribute('fill', 'white');
    badge.setAttribute('stroke', '#e5484d');
    badge.setAttribute('stroke-width', '1.5');
    badge.setAttribute('vector-effect', NONSCALE);
    badge.setAttribute('pointer-events', 'none');
    g.appendChild(badge);
    const plus = document.createElementNS(NS, 'path');
    const a = s2 * 0.28;
    plus.setAttribute('d', `M${p.x - a},${p.y} H${p.x + a} M${p.x},${p.y - a} V${p.y + a}`);
    plus.setAttribute('stroke', '#e5484d');
    plus.setAttribute('stroke-width', '1.5');
    plus.setAttribute('vector-effect', NONSCALE);
    plus.setAttribute('fill', 'none');
    plus.setAttribute('pointer-events', 'none');
    g.appendChild(plus);
  }

  // On-select style tab: name the reusable text style this object is linked to, at
  // the box's top-left ("●" = local overrides), so the link is legible on the object.
  const linkedStyleId = shape.element.getAttribute('data-text-style');
  const linkedStyle = linkedStyleId ? curState?.getTextStyle(linkedStyleId) : undefined;
  if (linkedStyle && curState?.canStyleText(shape)) {
    drawStyleTab(g, corners[0], linkedStyle.name, curState.textStyleOverrides(shape).length > 0);
  }

  // A locked shape (selected from the Layers panel) shows where it is, but offers
  // nothing to grab: no resize, rotate, radius or offset handles (core/locks.ts).
  if (isLockedEl(el)) { selectionLayer.appendChild(g); return; }

  // Live corner-radius handles for a plain <rect> (drawn before the resize squares
  // so they win clicks right at the corner).
  if (shape.type === 'rect' && el.tagName.toLowerCase() === 'rect') {
    const rx = parseFloat(el.getAttribute('rx') ?? '') || shape.style.rx || 0;
    const rr = Math.max(0, Math.min(rx, Math.min(w, h) / 2));
    if (rr > 0) {
      for (const c of [
        { id: 'radius-nw', p: tp(x + rr, y + rr) },
        { id: 'radius-ne', p: tp(x + w - rr, y + rr) },
        { id: 'radius-se', p: tp(x + w - rr, y + h - rr) },
        { id: 'radius-sw', p: tp(x + rr, y + h - rr) },
      ]) {
        drawHit(g, c.p.x, c.p.y, 9 * vscale, c.id, 'pointer');
        drawDot(g, c.p.x, c.p.y, 4 * vscale, 'white', tokens.selectionAccent, 1.5);
      }
    }
  }

  // Resize squares at the four corners + four edge midpoints (constant size).
  // Cursors come from the box's RENDERED corners, so they rotate with the shape.
  const size = HANDLE_SIZE * vscale;
  const cursorFor = handleCursors(corners);
  const resize = [
    { id: 'nw', p: tp(x, y) }, { id: 'n', p: tp(x + w / 2, y) }, { id: 'ne', p: tp(x + w, y) },
    { id: 'e', p: tp(x + w, y + h / 2) }, { id: 'se', p: tp(x + w, y + h) }, { id: 's', p: tp(x + w / 2, y + h) },
    { id: 'sw', p: tp(x, y + h) }, { id: 'w', p: tp(x, y + h / 2) },
  ];
  for (const r of resize) {
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', String(r.p.x - size / 2));
    rect.setAttribute('y', String(r.p.y - size / 2));
    rect.setAttribute('width', String(size));
    rect.setAttribute('height', String(size));
    rect.setAttribute('fill', 'white');
    rect.setAttribute('stroke', tokens.selectionAccent);
    rect.setAttribute('stroke-width', '1');
    rect.setAttribute('vector-effect', NONSCALE);
    rect.setAttribute('data-handle', r.id);
    rect.setAttribute('style', `cursor: ${cursorFor(r.id)}`);
    g.appendChild(rect);
  }

  // Rotation handle — omitted for frames (they must stay axis-aligned for
  // export/rulers/grid). Offset perpendicular to the top edge, away from centre,
  // so it follows a rotated box.
  if (shape.type !== 'frame') {
    const topMid = tp(x + w / 2, y);
    const centre = tp(x + w / 2, y + h / 2);
    let ux = topMid.x - centre.x, uy = topMid.y - centre.y;
    const len = Math.hypot(ux, uy) || 1; ux /= len; uy /= len;
    const off = 20 * vscale;
    const rp = { x: topMid.x + ux * off, y: topMid.y + uy * off };
    const rotLine = document.createElementNS(NS, 'line');
    rotLine.setAttribute('x1', String(topMid.x)); rotLine.setAttribute('y1', String(topMid.y));
    rotLine.setAttribute('x2', String(rp.x)); rotLine.setAttribute('y2', String(rp.y));
    rotLine.setAttribute('stroke', tokens.selectionAccent);
    rotLine.setAttribute('stroke-width', '1');
    rotLine.setAttribute('vector-effect', NONSCALE);
    rotLine.setAttribute('pointer-events', 'none');
    g.appendChild(rotLine);
    drawDot(g, rp.x, rp.y, 5 * vscale, 'white', tokens.selectionAccent, 1.5, 'rotate', 'crosshair');
  }

  // Anchor dots for line-like shapes (at the true corners).
  if (shape.type === 'line' || shape.type === 'polyline' || shape.type === 'path') {
    for (const c of corners) drawDot(g, c.x, c.y, 2.5 * vscale, 'white', tokens.selectionAccent, 1);
  }

  // On-canvas handles for parallel-offset strokes (multi-stroke appearance).
  if (shape.type === 'appearance') appendOffsetHandles(g, shape, tp);

  // On-canvas start-offset handle for text flowed on a path.
  if (shape.type === 'text') appendTextPathHandle(g, shape, selectionLayer);

  selectionLayer.appendChild(g);

  // Dimension badge (appended after `g` is in the DOM so the text can be measured).
  // Skip frames — they show their own edge dimensions when rulers are on. The readout
  // is the rotation angle while rotating, else the rendered W × H (from the transformed
  // corner edge-lengths, so it's correct for rotated + scaled shapes).
  if (shape.type !== 'frame') {
    let label: string;
    if (gesture === 'rotate') {
      let ang = Math.round(Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x) * 180 / Math.PI);
      if (ang > 180) ang -= 360; if (ang <= -180) ang += 360;
      label = `${ang}°`;
    } else {
      const wr = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
      const hr = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
      label = `${Math.round(wr)} × ${Math.round(hr)}`;
    }
    drawDimBadge(g, corners, label, tokens.selectionAccent);
  }
}

/** Figma-style dimension badge: a small pill showing the selection's rendered W × H
 *  in document units, centred just BELOW the box — clear of the top-anchored toolbar
 *  and rotation handle, and offset past the bottom resize handles. Constant on-screen
 *  size; it tracks and updates live because the overlay re-renders during a resize.
 *  `parent` must already be in the DOM so getComputedTextLength can size the pill. */
function drawDimBadge(
  parent: SVGElement, corners: { x: number; y: number }[], label: string, color: string,
): void {
  if (!label) return;
  const xs = corners.map(c => c.x), ys = corners.map(c => c.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const top = Math.max(...ys) + 14 * vscale; // below the bottom edge + its resize handles
  const fs = 11 * vscale;

  const t = document.createElementNS(NS, 'text');
  t.setAttribute('font-size', String(fs));
  t.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
  t.setAttribute('font-weight', '600');
  t.setAttribute('fill', '#fff');
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('dominant-baseline', 'central');
  t.setAttribute('pointer-events', 'none');
  t.textContent = label;
  parent.appendChild(t);
  let textW = fs * label.length * 0.6;
  try { const m = (t as unknown as SVGTextContentElement).getComputedTextLength(); if (m) textW = m; } catch { /* not laid out */ }

  const bh = fs + 6 * vscale, bw = textW + 14 * vscale;
  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('x', String(cx - bw / 2)); rect.setAttribute('y', String(top));
  rect.setAttribute('width', String(bw)); rect.setAttribute('height', String(bh));
  rect.setAttribute('rx', String(bh / 2)); rect.setAttribute('ry', String(bh / 2));
  rect.setAttribute('fill', color);
  rect.setAttribute('pointer-events', 'none');
  parent.insertBefore(rect, t); // pill behind the text
  t.setAttribute('x', String(cx));
  t.setAttribute('y', String(top + bh / 2));
}

/** A grab handle at the point on the path where the text starts. Dragging it is
 *  handled by the Select tool (data-handle="text-path-offset"), which sets the
 *  <textPath> startOffset. Nothing is drawn for plain (non-path) text. */
function appendTextPathHandle(g: SVGElement, shape: ShapeData, selectionLayer: SVGGElement): void {
  const tpEl = shape.element.querySelector('textPath');
  if (!tpEl) return;
  const pathId = (tpEl.getAttribute('href') || tpEl.getAttribute('xlink:href') || '').replace(/^#/, '');
  const geom = pathId ? (document.getElementById(pathId) as SVGGeometryElement | null) : null;
  if (!geom || typeof geom.getTotalLength !== 'function') return;
  const total = geom.getTotalLength();
  if (!total) return;
  const so = (tpEl.getAttribute('startOffset') || '0').trim();
  let len = so.endsWith('%') ? (parseFloat(so) / 100) * total : (parseFloat(so) || 0);
  len = Math.max(0, Math.min(total, len));
  const p = geom.getPointAtLength(len);
  const map = makeLocalToLayer(selectionLayer, geom);
  if (!map) return;
  const lp = map(p.x, p.y);
  drawHit(g, lp.x, lp.y, 11 * vscale, 'text-path-offset', 'grab');
  drawDot(g, lp.x, lp.y, 5 * vscale, tokens.selectionAccent, 'white', 1.5);
}

/** Draggable dots on each offset stroke (data-handle="offset-<layerIdx>"), placed
 *  at their true selection-layer positions via `tp`. */
function appendOffsetHandles(
  parent: SVGElement, shape: ShapeData,
  tp: (lx: number, ly: number) => { x: number; y: number },
): void {
  const src = shape.element.querySelector(':scope > [data-ap-src]') as SVGElement | null;
  if (!src) return;
  let layers: Array<{ t?: string; offset?: number; offsetReversed?: boolean }>;
  try { layers = JSON.parse(shape.element.getAttribute('data-appearance') || '[]'); } catch { return; }
  const frame = pathMidFrame(src);
  if (!frame) return;
  const { base, perp } = frame;

  layers.forEach((L, idx) => {
    if (L.t !== 'stroke' || !L.offset) return;
    const b = tp(base.x, base.y);
    // Reversing the path turned `perp` round; the stroke itself stayed put.
    const along = L.offsetReversed ? -L.offset : L.offset;
    const o = tp(base.x + perp.x * along, base.y + perp.y * along);

    // Thin tether from the centerline to the offset dot.
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', String(b.x)); line.setAttribute('y1', String(b.y));
    line.setAttribute('x2', String(o.x)); line.setAttribute('y2', String(o.y));
    line.setAttribute('stroke', tokens.selectionAccent);
    line.setAttribute('stroke-width', '1');
    line.setAttribute('stroke-dasharray', '2,2');
    line.setAttribute('vector-effect', NONSCALE);
    line.setAttribute('pointer-events', 'none');
    parent.appendChild(line);

    drawHit(parent, o.x, o.y, 9 * vscale, `offset-${idx}`, 'move');
    drawDot(parent, o.x, o.y, 4 * vscale, tokens.selectionAccent, 'white', 1.5);
  });
}

function drawMultiSelection(state: AppState, selectionLayer: SVGGElement, ids: string[]): void {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const id of ids) {
    const shape = state.findShapeById(id);
    if (!shape) continue;
    const el = shape.element;
    let bbox: DOMRect;
    try {
      bbox = el.getBBox();
    } catch {
      continue;
    }
    if (bbox.width === 0 && bbox.height === 0) continue;

    // Individual highlight, positioned via the element's FULL transform to the
    // selection layer (same as drawSingleSelection) so ancestor frame/group
    // transforms are included. Using only the shape's own transform drew the outline
    // at frame-local coords in world space — i.e. in the wrong frame (usually Frame 1
    // at the origin) after a shape was dragged into a different, offset frame.
    const itemGroup = document.createElementNS(NS, 'g');
    const im = matrixBetween(selectionLayer, el);
    if (im) itemGroup.setAttribute('transform', matrixAttr(im));
    appendRect(itemGroup, bbox.x, bbox.y, bbox.width, bbox.height, {
      fill: 'none',
      stroke: tokens.selectionAccent,
      strokeWidth: '1',
      pointerEvents: 'none',
      opacity: '0.5',
    });
    selectionLayer.appendChild(itemGroup);

    // Track combined bounds in parent space by transforming bbox corners
    const corners = [
      { x: bbox.x, y: bbox.y },
      { x: bbox.x + bbox.width, y: bbox.y },
      { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
      { x: bbox.x, y: bbox.y + bbox.height },
    ];
    const svgEl = selectionLayer.closest('svg');
    if (svgEl) {
      const ctm = el.getCTM();
      const parentCtm = (selectionLayer.parentElement as unknown as SVGGraphicsElement)?.getCTM?.();
      if (ctm && parentCtm) {
        const inv = parentCtm.inverse();
        const m = inv.multiply(ctm);
        for (const c of corners) {
          const pt = svgEl.createSVGPoint();
          pt.x = c.x; pt.y = c.y;
          const transformed = pt.matrixTransform(m);
          minX = Math.min(minX, transformed.x);
          minY = Math.min(minY, transformed.y);
          maxX = Math.max(maxX, transformed.x);
          maxY = Math.max(maxY, transformed.y);
        }
      }
    }
  }

  if (!isFinite(minX)) return;

  const cw = maxX - minX;
  const ch = maxY - minY;

  // Combined bounding rect (solid)
  appendRect(selectionLayer, minX, minY, cw, ch, {
    fill: 'none',
    stroke: tokens.selectionAccent,
    strokeWidth: '1',
    pointerEvents: 'none',
    strokeDasharray: '4,2',
  });

  // A locked member would be resized/rotated with the rest, so a selection holding
  // one gets no handles at all (a drag still moves its unlocked members).
  const hasLocked = ids.some(id => { const s = state.findShapeById(id); return !!s && isLockedEl(s.element); });
  if (!hasLocked) appendResizeHandles(selectionLayer, minX, minY, cw, ch);

  // Combined W × H badge below the union box (selectionLayer is already in the DOM).
  drawDimBadge(selectionLayer, [
    { x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY },
  ], `${Math.round(cw)} × ${Math.round(ch)}`, tokens.selectionAccent);

  // Rotation handle — omitted if a frame is in the selection (frames stay
  // axis-aligned so export/rulers/grid keep working; see drawSingleSelection).
  const hasFrame = ids.some(id => state.findShapeById(id)?.type === 'frame');
  if (!hasFrame && !hasLocked) {
    const rotOffset = 20 * vscale;
    const rotLine = document.createElementNS(NS, 'line');
    rotLine.setAttribute('x1', String(minX + cw / 2));
    rotLine.setAttribute('y1', String(minY));
    rotLine.setAttribute('x2', String(minX + cw / 2));
    rotLine.setAttribute('y2', String(minY - rotOffset));
    rotLine.setAttribute('stroke', tokens.selectionAccent);
    rotLine.setAttribute('stroke-width', '1');
    rotLine.setAttribute('vector-effect', NONSCALE);
    rotLine.setAttribute('pointer-events', 'none');
    selectionLayer.appendChild(rotLine);

    const rotCircle = document.createElementNS(NS, 'circle');
    rotCircle.setAttribute('cx', String(minX + cw / 2));
    rotCircle.setAttribute('cy', String(minY - rotOffset));
    rotCircle.setAttribute('r', String(5 * vscale));
    rotCircle.setAttribute('fill', 'white');
    rotCircle.setAttribute('stroke', tokens.selectionAccent);
    rotCircle.setAttribute('stroke-width', '1.5');
    rotCircle.setAttribute('vector-effect', NONSCALE);
    rotCircle.setAttribute('data-handle', 'rotate');
    rotCircle.setAttribute('style', 'cursor: crosshair');
    selectionLayer.appendChild(rotCircle);
  }

  // Selection count badge
  const badge = document.createElementNS(NS, 'text');
  badge.setAttribute('x', String(maxX + 8 * vscale));
  badge.setAttribute('y', String(minY + 12 * vscale));
  badge.setAttribute('fill', tokens.selectionAccent);
  badge.setAttribute('font-size', String(11 * vscale));
  badge.setAttribute('font-family', 'Arial, sans-serif');
  badge.setAttribute('pointer-events', 'none');
  badge.textContent = `${ids.length} objects`;
  selectionLayer.appendChild(badge);
}

function appendRect(
  parent: SVGElement,
  x: number, y: number, w: number, h: number,
  attrs: Record<string, string>,
): void {
  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('x', String(x));
  rect.setAttribute('y', String(y));
  rect.setAttribute('width', String(w));
  rect.setAttribute('height', String(h));
  // Constant on-screen stroke width + dash pattern at any zoom.
  rect.setAttribute('vector-effect', NONSCALE);
  for (const [k, v] of Object.entries(attrs)) {
    // Convert camelCase to kebab-case for SVG attributes
    const attr = k.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
    rect.setAttribute(attr, v);
  }
  parent.appendChild(rect);
}
