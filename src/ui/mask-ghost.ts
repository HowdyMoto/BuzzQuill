/**
 * Mask onion-skin. When you select the SHAPE INSIDE a mask (the masked object —
 * e.g. double-click into the mask and pick the image), show that shape's clipped-
 * AWAY part as a dim ghost, so you can see its full extent and reposition it within
 * the mask. The in-mask part keeps rendering normally underneath.
 *
 * Deliberately does NOT trigger when the mask GROUP itself is selected — selecting
 * the mask should just show the normal result. Drawn transiently into the guides
 * layer (an inverse-of-cutter SVG mask on a dimmed clone) — never saved.
 */

import { matrixBetween } from '../core/coords';
import type { AppState } from '../core/state';

const NS = 'http://www.w3.org/2000/svg';
const GHOST_ID = 'mask-ghost';
const GHOST_OPACITY = '0.3';

/** The mask + the masked child, ONLY when a child inside a mask is selected (not
 *  the mask group itself). Null otherwise. */
function maskedChild(state: AppState): { mask: SVGElement; child: SVGElement } | null {
  const sel = state.getSelectedShape();
  if (!sel || sel.element.hasAttribute('data-clip-group')) return null; // not when the mask itself is selected
  const parent = sel.parentId ? state.findShapeById(sel.parentId) : null;
  if (!parent?.element.hasAttribute('data-clip-group')) return null;
  return { mask: parent.element, child: sel.element };
}

/** Drop ids from a clone tree so they can't shadow the real elements' ids. */
function stripIds(el: Element): void {
  el.removeAttribute('id');
  for (const c of Array.from(el.children)) stripIds(c);
}

export function clearMaskGhost(guidesLayer: SVGGElement): void {
  guidesLayer.querySelector(`#${GHOST_ID}`)?.remove();
}

export function renderMaskGhost(state: AppState, guidesLayer: SVGGElement): void {
  clearMaskGhost(guidesLayer);
  if (state.currentTool !== 'select' || state.interactive || state.editingPathId) return;

  const target = maskedChild(state);
  if (!target) return;
  const { mask, child } = target;
  const clipPathEl = Array.from(mask.children).find(c => c.tagName.toLowerCase() === 'clippath');
  const cutter = clipPathEl?.firstElementChild as SVGElement | null;
  if (!cutter) return;

  let bounds: DOMRect;
  try { bounds = (child as unknown as SVGGraphicsElement).getBBox(); } catch { return; }
  if (bounds.width === 0 && bounds.height === 0) return;
  // getBBox is in the child's own space; the clone renders in that same space, so a
  // child transform is carried by the clone. Map the mask's local space to the guides
  // layer for the outer group; the child clone + cutter live in mask-local coords.

  const m = matrixBetween(guidesLayer, mask as unknown as SVGGraphicsElement);
  if (!m) return;

  const g = document.createElementNS(NS, 'g') as SVGGElement;
  g.id = GHOST_ID;
  g.setAttribute('transform', `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`);
  g.setAttribute('opacity', GHOST_OPACITY);
  g.setAttribute('pointer-events', 'none');

  // Inverse mask: a white backdrop shows the child; the cutter in black hides it — so
  // the ghost paints the child ONLY where the clip hides it (never over the result).
  const maskId = `${GHOST_ID}-cut`;
  const svgMask = document.createElementNS(NS, 'mask');
  svgMask.id = maskId;
  const P = 5000; // backdrop padded well past the child so nothing outside gets clipped away
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('x', String(bounds.x - P)); bg.setAttribute('y', String(bounds.y - P));
  bg.setAttribute('width', String(bounds.width + P * 2)); bg.setAttribute('height', String(bounds.height + P * 2));
  bg.setAttribute('fill', '#fff');
  const cutBlack = cutter.cloneNode(true) as SVGElement;
  stripIds(cutBlack);
  cutBlack.setAttribute('fill', '#000');
  cutBlack.setAttribute('stroke', 'none');
  cutBlack.removeAttribute('opacity');
  cutBlack.removeAttribute('vector-effect');
  svgMask.append(bg, cutBlack);
  g.append(svgMask);

  const masked = document.createElementNS(NS, 'g');
  masked.setAttribute('mask', `url(#${maskId})`);
  const clone = child.cloneNode(true) as SVGElement;
  stripIds(clone);
  masked.append(clone);
  g.append(masked);

  guidesLayer.append(g);
}
