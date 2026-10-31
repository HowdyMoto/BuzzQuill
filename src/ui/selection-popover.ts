/**
 * Shared placement for the contextual operation popovers (Pathfinder booleans +
 * Mask, path-actions, image-actions). They're mutually exclusive by selection, so
 * they all anchor the SAME way — a single row **above** the selection — giving one
 * consistent place the eye learns to look for "what can I do with this?". Flips
 * below only when there's genuinely no room up top.
 */

import type { AppState } from '../core/state';

/** Union of the selected elements' on-screen rects, or null if none are laid out. */
export function selectionUnionRect(state: AppState): DOMRect | null {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const id of state.selectedShapeIds) {
    const shape = state.findShapeById(id);
    if (!shape) continue;
    let rc: DOMRect;
    try { rc = shape.element.getBoundingClientRect(); } catch { continue; }
    if (!rc || (rc.width === 0 && rc.height === 0)) continue;
    l = Math.min(l, rc.left); t = Math.min(t, rc.top);
    r = Math.max(r, rc.right); b = Math.max(b, rc.bottom);
  }
  return Number.isFinite(l) ? new DOMRect(l, t, r - l, b - t) : null;
}

/** The visible canvas area — popovers must stay inside it, never over the side
 *  panels (#221). Falls back to the window when the canvas isn't mounted. */
function canvasBounds(): { left: number; top: number; right: number; bottom: number } {
  const c = document.getElementById('svg-canvas');
  if (c) {
    const r = c.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return r;
  }
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

/** Position a popover in the consistent spot: centered above `rect`, flipped below
 *  only if it would clip off the top, clamped to the CANVAS area (not the window —
 *  the window includes the side panels, and a selection whose bbox extends past
 *  the canvas edge used to park the bar on top of the inspector, #221). */
export function placeContextPopover(pop: HTMLElement, rect: DOMRect, key = ''): void {
  const wasHidden = pop.hidden;
  pop.hidden = false; // reveal first so offsetWidth/Height measure
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const gap = 10;
  const cv = canvasBounds();
  // Anchor on the part of the selection the user can actually SEE: intersect the
  // bbox with the canvas so an off-canvas overhang doesn't drag the bar with it.
  let aLeft = rect.left, aWidth = rect.width, aTop = rect.top, aBottom = rect.bottom;
  const il = Math.max(rect.left, cv.left), ir = Math.min(rect.right, cv.right);
  if (ir > il) { aLeft = il; aWidth = ir - il; }
  aTop = Math.max(aTop, cv.top);
  aBottom = Math.min(Math.max(aBottom, aTop), cv.bottom);
  // The rotation handle rides a short stalk above the selection's top-centre
  // (~20px offset + its 5px dot ≈ 25px on screen), squarely where a top-anchored
  // toolbar would land. Lift the ABOVE placement clear of it so the toolbar never
  // buries the handle — the dot stays visible and grabbable below the bar. There's
  // no rotation handle below the selection, so the flipped-below case keeps gap.
  const rotationClearance = 26;
  // The tool-hint strip sits top-centre of the canvas; a bar placed above a
  // selection near the top of the view used to land right on it (and above it in
  // z-order), hiding the hints. Its band is off limits: flip below instead.
  let x = aLeft + aWidth / 2 - pw / 2;
  x = Math.max(cv.left + 8, Math.min(x, cv.right - pw - 8));
  const strip = document.getElementById('tool-hint');
  const sr = strip && !strip.hidden ? strip.getBoundingClientRect() : null;
  const crossesStrip = !!sr && sr.height > 0 && x < sr.right && x + pw > sr.left;
  const topLimit = crossesStrip ? Math.max(cv.top + 8, sr.bottom + 8) : cv.top + 8;
  let y = aTop - ph - gap - rotationClearance;     // ABOVE, clear of the rotation handle
  let below = false;
  // Below, the nub would touch the bottom-centre resize handle at the plain gap,
  // so give it the same breathing room the rotation stalk forces up top.
  if (y < topLimit) { y = aBottom + gap + 8; below = true; } // flip below only if no room up top
  y = Math.max(cv.top + 8, Math.min(y, cv.bottom - ph - 8));
  pop.style.left = `${Math.round(x)}px`;
  pop.style.top = `${Math.round(y)}px`;
  // The bar grows out of the selection it belongs to: its nub points at the
  // selection's centre (clamped to the bar when it was pushed along the canvas
  // edge), and the entrance scales from that edge.
  pop.dataset.placed = below ? 'below' : 'above';
  const nub = Math.max(14, Math.min(pw - 14, aLeft + aWidth / 2 - x));
  pop.style.setProperty('--ctx-nub-x', `${Math.round(nub)}px`);
  if (wasHidden && pop.dataset.anchorKey !== key) playEntrance(pop); // a new arrival, not a return
  pop.dataset.anchorKey = key;
}

/** Hide a context popover. The selection it was for is remembered for as long
 *  as it is selected — a drag, a nudge, a Space-pan or a trip through another
 *  tool hides the bar and shows it again — so the bar returns in place without
 *  re-playing its entrance (a pan happens dozens of times a minute). Once the
 *  selection itself is gone, the next bar is a new arrival and gets the
 *  animation. A bar that merely re-anchors to a different selection of the same
 *  kind (click A, then B) teleports: a replay on every click would be the
 *  annoying kind. An entrance still in flight is stopped, or a quick press
 *  within it would restart the animation on re-show. */
export function hideContextPopover(pop: HTMLElement, state: AppState): void {
  pop.hidden = true;
  stopEntrance(pop);
  if (state.selectedShapeIds.length === 0) delete pop.dataset.anchorKey;
}

const entranceTimers = new WeakMap<HTMLElement, number>();

/** Run the bar's entrance once: the bar springs out of the selection and its
 *  items follow one after another. The class is removed when the animation is
 *  over, because a CSS animation restarts every time an element leaves
 *  display:none — which is what made the old always-on animation replay after
 *  every drag. Items are counted among the VISIBLE children so the stagger has
 *  no gaps where a hidden button sits. */
function playEntrance(pop: HTMLElement): void {
  // Stagger in the order the items are SEEN: CSS order first (the Pathfinder bar
  // moves Join to the front that way), DOM order second.
  const visible = (Array.from(pop.children) as HTMLElement[])
    .filter((c) => c.style.display !== 'none')
    .map((el, dom) => ({ el, dom, order: parseInt(getComputedStyle(el).order, 10) || 0 }))
    .sort((a, b) => a.order - b.order || a.dom - b.dom);
  visible.forEach(({ el }, i) => el.style.setProperty('--ctx-i', String(i)));
  stopEntrance(pop);
  void pop.offsetWidth; // restart the animation if one is still running
  pop.classList.add('ctx-enter');
  entranceTimers.set(pop, window.setTimeout(() => pop.classList.remove('ctx-enter'), 600));
}

function stopEntrance(pop: HTMLElement): void {
  window.clearTimeout(entranceTimers.get(pop));
  entranceTimers.delete(pop);
  pop.classList.remove('ctx-enter');
}
