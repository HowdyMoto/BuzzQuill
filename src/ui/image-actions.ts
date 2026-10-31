/**
 * Image-actions popover — surfaces the Crop tool (and one-click Reset for an
 * already-cropped image) right on the artwork, so cropping is discoverable
 * without knowing the double-click gesture. Mirrors path-actions.ts: it floats
 * BELOW a single selected raster image; the Pathfinder (2+) and path-actions
 * (single path-like) popovers cover the other selection shapes, so they never
 * overlap. Reuses the .path-actions-popover styling.
 */

import { runImageTrace } from './trace-image';
import type { AppState } from '../core/state';
import { isCropped, uncropToImage } from '../tools/crop';
import { selectionUnionRect, placeContextPopover, hideContextPopover } from './selection-popover';

let popover: HTMLDivElement | null = null;

const ICON_CROP = '<svg viewBox="0 0 20 20" width="16" height="16"><path d="M6 2v12h12M2 6h12v12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_RESET = '<svg viewBox="0 0 20 20" width="16" height="16"><path d="M4 4h12v12H4z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7 7l6 6M13 7l-6 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

function enterCrop(state: AppState): void {
  const s = state.getSelectedShape();
  if (!s || s.type !== 'image') return;
  state.cropReturnTool = 'select';
  state.requestTool?.('crop');
}

function resetCrop(state: AppState): void {
  const s = state.getSelectedShape();
  if (!s || !isCropped(s.element)) return;
  const bare = uncropToImage(s.element);
  if (!bare) return;
  const id = s.element.id;
  s.element.parentNode!.replaceChild(bare, s.element);
  state.rebuildShapesFromDOM();
  state.selectShape(id);
  state.saveHistory();
  state.onChange_public();
}

const ICON_TRACE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17c3-1 4-4 4-7a4 4 0 0 1 8 0c0 3 1 6 4 7"/><circle cx="4" cy="17" r="1.6"/><circle cx="20" cy="17" r="1.6"/><circle cx="12" cy="6" r="1.6"/></svg>';

export function setupImageActions(state: AppState): void {
  if (popover) return;
  const el = document.createElement('div');
  el.id = 'image-actions-popover';
  el.className = 'path-actions-popover ctx-popover';
  el.hidden = true;
  el.addEventListener('mousedown', (e) => e.stopPropagation());

  const crop = document.createElement('button');
  crop.setAttribute('data-image-action', 'crop');
  crop.title = 'Crop this image — double-click the image or press this to frame it (Enter to apply, Esc to cancel).';
  crop.innerHTML = `${ICON_CROP}<span>Crop</span>`;
  crop.addEventListener('click', () => enterCrop(state));
  el.appendChild(crop);

  const reset = document.createElement('button');
  reset.setAttribute('data-image-action', 'reset');
  reset.title = 'Reset crop — restore the full uncropped image.';
  reset.innerHTML = `${ICON_RESET}<span>Reset</span>`;
  reset.addEventListener('click', () => resetCrop(state));
  el.appendChild(reset);

  const trace = document.createElement('button');
  trace.setAttribute('data-image-action', 'trace');
  trace.title = 'Trace this image into editable vector shapes.';
  trace.innerHTML = `${ICON_TRACE}<span>Trace</span>`;
  trace.addEventListener('click', () => { void runImageTrace(state); });
  el.appendChild(trace);

  document.body.appendChild(el);
  popover = el;
}

export function updateImageActions(state: AppState): void {
  const pop = popover;
  if (!pop) return;

  const only = state.selectedShapeIds.length === 1 ? state.getSelectedShape() : null;
  const show = state.currentTool === 'select'
    && !state.interactive
    && !state.editingPathId
    && !state.activeGroupId
    && !!only && only.type === 'image';
  if (!show || !only) { hideContextPopover(pop, state); return; }

  // Reset only applies once cropped.
  const resetBtn = pop.querySelector('[data-image-action="reset"]') as HTMLElement | null;
  if (resetBtn) resetBtn.style.display = isCropped(only.element) ? '' : 'none';

  const rc = selectionUnionRect(state);
  if (!rc) { hideContextPopover(pop, state); return; }
  placeContextPopover(pop, rc, state.selectedShapeIds.join(','));
}
