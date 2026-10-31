/**
 * Offset Path dialog — a small numeric prompt for the offset distance, then hands
 * off to AppState.offsetSelectedPath. Positive grows the path outward, negative
 * shrinks it inward. Built on the shared Modal primitive.
 */

import type { AppState } from '../core/state';
import { openModal } from './modal';
import { showToast } from './toast';

export function showOffsetDialog(state: AppState): void {
  if (state.selectedShapeIds.length === 0) return;
  const modal = openModal({ id: 'offset-dialog', ariaLabel: 'Offset Path', dialogClass: 'offset-dialog' });
  if (!modal) return;
  const { dialog, close } = modal;

  const wrap = document.createElement('div');
  wrap.className = 'offset-dialog-body';
  wrap.innerHTML = `
    <div class="offset-dialog-title">Offset Path</div>
    <label class="offset-dialog-label">Offset (px) — positive grows, negative shrinks</label>
    <input type="number" id="offset-amount" value="10" step="1" class="offset-dialog-input" />
    <div class="offset-dialog-actions">
      <button id="offset-cancel" class="offset-btn">Cancel</button>
      <button id="offset-apply" class="offset-btn offset-btn-primary">Apply</button>
    </div>`;
  dialog.appendChild(wrap);

  const input = wrap.querySelector('#offset-amount') as HTMLInputElement;
  const apply = () => {
    const delta = parseFloat(input.value);
    close();
    if (Number.isFinite(delta) && delta !== 0) {
      void state.offsetSelectedPath(delta).then((ok) => {
        if (!ok) showToast('Nothing to offset — select a path or closed shape.');
      });
    }
  };
  wrap.querySelector('#offset-apply')!.addEventListener('click', apply);
  wrap.querySelector('#offset-cancel')!.addEventListener('click', () => close());
  input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') apply(); });
  input.focus();
  input.select();
}
