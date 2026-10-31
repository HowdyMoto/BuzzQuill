/**
 * Round Corners dialog — one radius, previewed live on the real artwork.
 *
 * The preview is the point: a radius means nothing in the abstract, only against
 * your own shapes at their real size. AppState.beginCornerPreview remembers the
 * original elements, each slider move re-rounds THAT remembered geometry (never
 * the last preview, which would round already-rounded corners), Apply keeps it as
 * one undo step, and Cancel/Escape puts the originals back — a cancelled dialog
 * leaves no trace and costs no undo step.
 *
 * The radius range is sized from the selection, so it's useful for a 30px icon
 * and a 3000px map alike.
 */

import type { AppState } from '../core/state';
import { openModal } from './modal';
import { showToast } from './toast';
import { sliderField } from './slider-field';

export function showRoundCornersDialog(state: AppState): void {
  if (!state.beginCornerPreview()) {
    showToast('Select a path or shape to round.');
    return;
  }

  // Scale the control to the artwork: an eighth of the selection's short side is
  // a visible-but-sane starting radius, and half of it is as far as any corner
  // can go (past that the cut is clamped anyway).
  const b = state.selectionWorldBounds();
  const short = b ? Math.min(b.w, b.h) : 100;
  const max = Math.max(10, Math.round(short / 2));
  const start = Math.max(1, Math.min(max, Math.round(short / 8)));

  let done = false;
  const modal = openModal({
    id: 'round-corners-dialog',
    ariaLabel: 'Round Corners',
    dialogClass: 'dlg dlg-corners',
    closeButton: false,
    onClose: () => finish(false),
  });
  if (!modal) { state.cancelCornerPreview(); return; }

  const finish = (apply: boolean): void => {
    if (done) return;
    done = true;
    if (apply) {
      if (!state.commitCornerPreview()) showToast('No corners to round at that radius.');
    } else {
      state.cancelCornerPreview();
    }
    modal.close();
  };

  const head = document.createElement('div');
  head.className = 'dlg-head';
  head.innerHTML = '<h2 class="dlg-title">Round Corners</h2>'
    + '<p class="dlg-msg">Rounds every corner of the selected paths at once. '
    + 'Straight edges stay straight; a radius that doesn’t fit a short edge is trimmed to fit.</p>';
  modal.dialog.appendChild(head);

  const body = document.createElement('div');
  body.className = 'dlg-body';
  const field = document.createElement('div');
  field.className = 'dlg-field';
  const label = document.createElement('label');
  label.className = 'dlg-label';
  label.textContent = 'Radius';
  const row = document.createElement('div');
  row.className = 'dlg-corners-slider';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.title = 'Corner radius';
  slider.min = '0';
  slider.max = String(max);
  slider.step = max > 40 ? '1' : '0.5';
  slider.value = String(start);
  row.append(slider, sliderField(slider, { unit: 'px' }));
  field.append(label, row);
  body.appendChild(field);
  modal.dialog.appendChild(body);

  const foot = document.createElement('div');
  foot.className = 'dlg-foot';
  const cancel = document.createElement('button');
  cancel.className = 'dlg-btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => finish(false));
  const ok = document.createElement('button');
  ok.className = 'dlg-btn dlg-btn-primary';
  ok.textContent = 'Round';
  ok.addEventListener('click', () => finish(true));
  foot.append(cancel, ok);
  modal.dialog.appendChild(foot);

  slider.addEventListener('input', () => state.previewCornerRadius(parseFloat(slider.value) || 0));
  state.previewCornerRadius(start); // show the starting radius immediately
}
