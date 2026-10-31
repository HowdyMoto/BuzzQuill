// Repeat panel (issue #111) — columns/rows/gaps of the selected repeat grid,
// Edit shape (enter the pattern and select the original for in-place editing —
// the button form of double-clicking it), Bake grid (destructive: clones become
// real shapes) and Release grid (back to just the original). Visibility is
// driven by updateInspector (panel-repeat shows only when the selection is a
// repeat wrapper or a shape inside one).

import type { AppState } from '../core/state';

import { mustId as $ } from './dom';

/** The selected repeat wrapper's id — either selected directly, or the wrapper
 *  around a selected source shape (so the panel stays up while editing the
 *  original inside the pattern). */
export function selectedRepeatId(state: AppState): string | null {
  if (state.selectedShapeIds.length !== 1) return null;
  const s = state.getSelectedShape();
  if (!s) return null;
  if (s.type === 'repeat') return s.id;
  const parent = s.parentId ? state.findShapeById(s.parentId) : null;
  return parent && parent.type === 'repeat' ? parent.id : null;
}

export function setupRepeatPanel(state: AppState): void {
  const read = () => ({
    cols: parseInt($<HTMLInputElement>('rp-cols').value) || 1,
    rows: parseInt($<HTMLInputElement>('rp-rows').value) || 1,
    gapX: parseFloat($<HTMLInputElement>('rp-gap-x').value) || 0,
    gapY: parseFloat($<HTMLInputElement>('rp-gap-y').value) || 0,
  });
  const apply = (record: boolean) => {
    const id = selectedRepeatId(state);
    if (id) state.setRepeatConfig(id, read(), record);
  };
  for (const f of ['rp-cols', 'rp-rows', 'rp-gap-x', 'rp-gap-y']) {
    $<HTMLInputElement>(f).addEventListener('input', () => apply(false));
    $<HTMLInputElement>(f).addEventListener('change', () => apply(true));
  }
  $<HTMLButtonElement>('rp-bake').addEventListener('click', () => {
    const id = selectedRepeatId(state);
    if (id) state.bakeRepeat(id);
  });
  $<HTMLButtonElement>('rp-release').addEventListener('click', () => {
    const id = selectedRepeatId(state);
    if (id) state.releaseRepeat(id);
  });
  // Edit the originals in place: enter the wrapper (like double-clicking it) and
  // select the first cell shape, so every tool edits natively and the copies follow.
  $<HTMLButtonElement>('rp-edit').addEventListener('click', () => {
    const id = selectedRepeatId(state);
    const wrapper = id ? state.findShapeById(id) : null;
    const first = wrapper?.children?.[0];
    if (!id || !first) return;
    state.enterGroup(id);
    state.selectShape(first.id);
  });
}

export function updateRepeatPanel(state: AppState): void {
  const id = selectedRepeatId(state);
  if (!id) return; // panel hidden by the inspector
  const cfg = state.getRepeatConfig(id);
  if (!cfg) return;
  // "Edit …" is only useful while the WRAPPER is selected; once a cell shape
  // inside is selected you're already editing it. Label tracks the cell size.
  const edit = $<HTMLButtonElement>('rp-edit');
  edit.style.display = state.getSelectedShape()?.type === 'repeat' ? '' : 'none';
  const cellCount = state.findShapeById(id)?.children?.length ?? 0;
  edit.textContent = cellCount > 1 ? 'Edit contents' : 'Edit shape';
  const put = (fid: string, v: number) => {
    const input = $<HTMLInputElement>(fid);
    if (document.activeElement !== input) input.value = String(v);
  };
  put('rp-cols', cfg.cols); put('rp-rows', cfg.rows);
  put('rp-gap-x', cfg.gapX); put('rp-gap-y', cfg.gapY);
}
