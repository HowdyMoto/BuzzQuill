/**
 * Width panel — apply a named width profile (Illustrator's Width Profile dropdown)
 * to the selected path: uniform, taper, leaf, bulge, waist. A base-width field sets
 * the nominal thickness; Release drops the profile back to a plain stroke. Works
 * alongside the Width *tool* (direct manipulation) — both drive setWidthProfile.
 */

import type { AppState } from '../core/state';
import { profileToPoints } from '../core/variable-width';

import { mustId as $ } from './dom';

export function setupWidthPanel(state: AppState): void {
  const base = $<HTMLInputElement>('width-base');

  const target = (): string | null => {
    if (state.selectedShapeIds.length !== 1) return null;
    const id = state.selectedShapeIds[0];
    return state.canApplyWidth(id) ? id : null;
  };

  const apply = (profile: string) => {
    const id = target();
    if (!id) return;
    const b = Math.max(0, parseFloat(base.value) || 0) || 1;
    state.setWidthProfile(id, profileToPoints(profile, b), b, true);
    updateWidthPanel(state);
  };

  document.querySelectorAll<HTMLButtonElement>('#width-presets .width-preset').forEach(btn => {
    btn.addEventListener('click', () => apply(btn.dataset.profile || 'uniform'));
  });

  // Re-apply the current profile shape at the new base width. If it's a plain path
  // (no profile yet), changing the number alone does nothing until a preset is picked.
  base.addEventListener('change', () => {
    const id = target();
    if (!id) return;
    const model = state.getWidthProfile(id);
    if (!model || model.points.length === 0) return;
    const b = Math.max(0, parseFloat(base.value) || 0) || 1;
    const scale = b / (model.base || b);
    const scaled = model.points.map(p => ({ t: p.t, w: p.w * scale }));
    state.setWidthProfile(id, scaled, b, true);
    updateWidthPanel(state);
  });

  $<HTMLButtonElement>('width-release').addEventListener('click', () => {
    const id = target();
    if (id && state.findShapeById(id)?.type === 'width') { state.clearWidthProfile(id); updateWidthPanel(state); }
  });

  updateWidthPanel(state);
}

/** Reflect the selection into the Width panel (enable presets, show base + Release). */
export function updateWidthPanel(state: AppState): void {
  const empty = document.getElementById('width-empty');
  const presets = document.getElementById('width-presets');
  const release = document.getElementById('width-release');
  const base = document.getElementById('width-base') as HTMLInputElement | null;
  if (!empty || !presets || !release || !base) return;

  const id = state.selectedShapeIds.length === 1 ? state.selectedShapeIds[0] : null;
  const ok = !!id && state.canApplyWidth(id);
  presets.style.display = ok ? '' : 'none';
  empty.style.display = ok ? 'none' : '';

  const model = ok ? state.getWidthProfile(id!) : null;
  release.style.display = model ? '' : 'none';
  if (model) base.value = String(model.base);
}
