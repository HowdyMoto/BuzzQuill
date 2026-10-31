// ---------------------------------------------------------------------------
// Image Trace — the one entry point the menu command and the image toolbar both
// call. Opens the dialog, runs the full-resolution trace, and commits the result
// into the document as ordinary editable paths.
// ---------------------------------------------------------------------------

import type { AppState } from '../core/state';
import type { ShapeData } from '../core/types';
import { buildTracedGroup, isTraceable, TraceError, traceShape } from '../core/image-trace';
import { openTraceDialog } from './trace-dialog';
import { showToast } from './toast';
import { withLoadingOverlay } from './loading-overlay';

/** True when the selection is a single image (or cropped image) we can trace. */
export function canTraceSelection(state: AppState): boolean {
  if (state.selectedShapeIds.length !== 1) return false;
  const s = state.getSelectedShape();
  return !!s && isTraceable(s.element);
}

/**
 * Trace the selected image. The dialog previews at thumbnail resolution; this
 * re-runs the chosen settings at full resolution, so what lands matches what was
 * shown but with the detail the real bitmap carries.
 */
export async function runImageTrace(state: AppState): Promise<void> {
  const shape = state.selectedShapeIds.length === 1 ? state.getSelectedShape() : null;
  if (!shape || !isTraceable(shape.element)) {
    showToast('Select a single image to trace.');
    return;
  }
  const el = shape.element;

  const choice = await openTraceDialog(el);
  if (!choice) return;

  try {
    const result = await withLoadingOverlay('Tracing image…', async () =>
      traceShape(el, choice.options));

    if (result.paths.length === 0) {
      showToast('Tracing found no shapes — try more colours, or lower “ignore specks”.');
      return;
    }

    const name = `${shape.name || 'Image'} traced`;
    const group = buildTracedGroup(el, result, name);

    // Same parent, directly above the image, so the traced art sits exactly where
    // the picture was in both space AND z-order.
    const parent = el.parentNode;
    if (!parent) { showToast('Couldn’t place the traced shapes.'); return; }
    parent.insertBefore(group, el.nextSibling);
    if (choice.replace) el.remove();

    state.rebuildShapesFromDOM();
    // The group has no id until the rebuild mints one; find it by identity.
    const traced = findByElement(state.shapes, group);
    if (traced) state.selectShape(traced);
    state.saveHistory();
    state.onChange_public();

    showToast(
      `Traced into ${result.paths.length} shape${result.paths.length === 1 ? '' : 's'}.`,
      6000, undefined, 'success',
    );
  } catch (err) {
    showToast(err instanceof TraceError ? err.message : 'Couldn’t trace that image.');
  }
}

/** The id the rebuild assigned to a freshly-inserted element. */
function findByElement(list: ShapeData[], el: SVGElement): string | null {
  for (const s of list) {
    if (s.element === el) return s.id;
    const inner = s.children ? findByElement(s.children, el) : null;
    if (inner) return inner;
  }
  return null;
}
