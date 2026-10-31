import type { AppState } from '../core/state';
import type { BBox } from '../core/types';
import { nudgeTranslate, getRotation } from '../core/transform';
import { translateShapeGeometry } from '../core/shape-adapters';
import { localBBoxInLayer, layerDeltaToLocal } from '../core/coords';

type AlignMode = 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom';
type DistributeMode = 'h' | 'v' | 'diag-nwse' | 'diag-nesw';

export function setupAlign(state: AppState): void {
  document.querySelectorAll('.align-buttons button[data-align]').forEach(btn => {
    btn.addEventListener('click', () => {
      alignObjects(state, btn.getAttribute('data-align') as AlignMode);
    });
  });

  document.querySelectorAll('.align-buttons button[data-distribute]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-distribute') as DistributeMode | null;
      if (mode && ['h', 'v', 'diag-nwse', 'diag-nesw'].includes(mode)) {
        distributeObjects(state, mode);
      }
    });
  });
}

interface Item { el: SVGGraphicsElement; box: BBox }

/** Selected, movable (non-frame) shapes with their world-space (drawing-layer)
 *  boxes — NOT raw getBBox, which is local and lies inside groups/frames. */
function selectionItems(state: AppState): Item[] {
  return state.selectedShapeIds
    .map(id => state.findShapeById(id))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .map(s => s.element)
    .filter(el => !el.hasAttribute('data-frame'))
    .map(el => {
      const svg = el.ownerSVGElement;
      const box = svg ? localBBoxInLayer(svg, el) : null;
      return box ? { el, box } : null;
    })
    .filter((x): x is Item => !!x);
}

/** Move an element by a drawing-layer-space delta. The delta is mapped into the
 *  parent's coordinate space first, so children of scaled/rotated groups land
 *  where expected; dispatch matches the select tool's drag (transform for
 *  rotated/group/path, geometry attributes for plain primitives). */
function moveByWorldDelta(el: SVGGraphicsElement, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  const svg = el.ownerSVGElement;
  const parent = el.parentElement as unknown as SVGGraphicsElement | null;
  if (svg && parent) {
    const conv = layerDeltaToLocal(svg, parent, dx, dy);
    dx = conv.dx; dy = conv.dy;
  }
  const plainEl = el as unknown as SVGElement;
  const tag = el.tagName.toLowerCase();
  const needsTransform = getRotation(plainEl) !== 0 || tag === 'g' || tag === 'path';
  if (needsTransform || !translateShapeGeometry(plainEl, dx, dy)) {
    nudgeTranslate(plainEl, dx, dy);
  }
}

function unionBox(boxes: BBox[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** World box of the element's containing frame, else the active frame. */
function frameBoxFor(state: AppState, el: SVGGraphicsElement): BBox {
  const frameEl = (el.parentElement as Element | null)?.closest?.('[data-frame]');
  const ab = (frameEl?.id ? state.getArtboardById(frameEl.id) : undefined) ?? state.artboard;
  return { x: ab.x, y: ab.y, width: ab.width, height: ab.height };
}

/** Align the selection. With 2+ objects the reference is the selection's own
 *  bounding box (objects align to each other — the outermost edge stays put);
 *  with a single object it's the containing frame. */
export function alignObjects(state: AppState, mode: AlignMode): void {
  const items = selectionItems(state);
  if (!items.length) return;

  const target = items.length >= 2
    ? unionBox(items.map(i => i.box))
    : frameBoxFor(state, items[0].el);

  for (const { el, box } of items) {
    let dx = 0, dy = 0;
    switch (mode) {
      case 'left': dx = target.x - box.x; break;
      case 'center-h': dx = (target.x + target.width / 2) - (box.x + box.width / 2); break;
      case 'right': dx = (target.x + target.width) - (box.x + box.width); break;
      case 'top': dy = target.y - box.y; break;
      case 'center-v': dy = (target.y + target.height / 2) - (box.y + box.height / 2); break;
      case 'bottom': dy = (target.y + target.height) - (box.y + box.height); break;
    }
    moveByWorldDelta(el, dx, dy);
  }

  state.saveHistory();
  state.onChange_public();
}

/** Distribute objects equally spaced along a horizontal, vertical, or diagonal
 *  axis. The outermost objects along the chosen axis stay fixed; interior
 *  objects' centers move to even intervals (matches Illustrator). */
export function distributeObjects(state: AppState, mode: DistributeMode): void {
  const items = selectionItems(state).map(({ el, box }) => ({
    el, box,
    cx: box.x + box.width / 2,
    cy: box.y + box.height / 2,
  }));
  if (items.length < 3) return;

  if (mode === 'h') {
    items.sort((a, b) => a.cx - b.cx);
    const first = items[0].cx;
    const step = (items[items.length - 1].cx - first) / (items.length - 1);
    for (let i = 1; i < items.length - 1; i++) {
      moveByWorldDelta(items[i].el, first + i * step - items[i].cx, 0);
    }
  } else if (mode === 'v') {
    items.sort((a, b) => a.cy - b.cy);
    const first = items[0].cy;
    const step = (items[items.length - 1].cy - first) / (items.length - 1);
    for (let i = 1; i < items.length - 1; i++) {
      moveByWorldDelta(items[i].el, 0, first + i * step - items[i].cy);
    }
  } else {
    // Diagonal: order along the axis (NW→SE by cx+cy, NE→SW by cx−cy), then
    // space centers evenly on the line between the two outermost centers.
    items.sort(mode === 'diag-nwse'
      ? (a, b) => (a.cx + a.cy) - (b.cx + b.cy)
      : (a, b) => (a.cx - a.cy) - (b.cx - b.cy));
    const firstIt = items[0], lastIt = items[items.length - 1];
    for (let i = 1; i < items.length - 1; i++) {
      const t = i / (items.length - 1);
      const targetCx = firstIt.cx + t * (lastIt.cx - firstIt.cx);
      const targetCy = firstIt.cy + t * (lastIt.cy - firstIt.cy);
      moveByWorldDelta(items[i].el, targetCx - items[i].cx, targetCy - items[i].cy);
    }
  }

  state.saveHistory();
  state.onChange_public();
}
