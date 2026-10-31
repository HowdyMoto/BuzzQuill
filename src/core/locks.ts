/**
 * What "locked" means on the canvas. A locked shape — or anything inside a locked
 * group or frame — can't be picked, moved, resized or rotated there: a press goes
 * THROUGH it to what's underneath (the marquee and arrow-key nudges already skip
 * locked shapes). It can still be selected from the Layers panel, which shows its
 * outline but no handles, and its panels still edit it.
 *
 * The DOM is the source of truth: the lock lives on the element as
 * `data-locked="true"` (mirrored by LayerManager.toggleLock, carried onto wrappers
 * by CARRY_ATTRS), so one `closest()` covers the shape and every container above it.
 */
export function isLockedEl(el: Element): boolean {
  return el.closest('[data-locked="true"]') !== null;
}
