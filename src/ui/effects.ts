/**
 * Effects panel — non-destructive blur and drop shadow on the selected object,
 * rendered via SVG filters. The state owns the filter generation (data-fx-* attrs
 * → <filter> in defs); this module is the Properties-panel UI:
 *  - a Blur slider,
 *  - a Drop Shadow toggle with colour, opacity, offset, and softness.
 *
 * Sliders apply live on `input` (no history) and commit once on `change`, so a
 * drag leaves a single undo step. Each carries an editable value field
 * (slider-field.ts) that drives the slider through those same events.
 */

import type { AppState } from '../core/state';
import type { ObjectShadow } from '../core/types';
import { openSolidColorPicker } from './color-picker';
import { setToggle } from './components';
import { mustId as $, bindLiveCommit } from './dom';
import { setSliderValue, sliderField } from './slider-field';

const PERCENT = { scale: 100, unit: '%' };

// Shadow colour is picked with the app's custom picker (a swatch button), not a
// native input, so it holds its value in a module var + a preview swatch.
let shadowColor = '#000000';
const setShadowPreview = (c: string) => {
  const p = document.getElementById('fx-shadow-color-preview');
  if (p) p.style.background = c;
};

export function setupEffects(state: AppState): void {
  const blur = $<HTMLInputElement>('fx-blur');
  const toggle = $<HTMLButtonElement>('fx-shadow-toggle');
  const colorBtn = $<HTMLElement>('fx-shadow-color-btn');
  const opacity = $<HTMLInputElement>('fx-shadow-opacity');
  const dx = $<HTMLInputElement>('fx-shadow-dx');
  const dy = $<HTMLInputElement>('fx-shadow-dy');
  const soft = $<HTMLInputElement>('fx-shadow-blur');

  const hasSel = () => state.selectedShapeIds.length > 0;

  // Effects/blend/markers apply to the WHOLE selection in one undo step; the panel
  // reflects the primary (last-selected) object's values.

  // ---- Blur ----
  const applyBlur = (record: boolean) => {
    if (!hasSel()) return;
    state.setSelectionBlur(parseFloat(blur.value) || 0, record);
  };
  blur.after(sliderField(blur));
  bindLiveCommit(blur, () => applyBlur(false), () => applyBlur(true));

  // ---- Drop shadow ----
  const shadowOn = () => toggle.getAttribute('aria-checked') === 'true';
  const readShadow = (): ObjectShadow => ({
    dx: parseFloat(dx.value) || 0,
    dy: parseFloat(dy.value) || 0,
    blur: parseFloat(soft.value) || 0,
    color: shadowColor || '#000000',
    opacity: parseFloat(opacity.value),
  });
  const applyShadow = (record: boolean) => {
    if (!hasSel()) return;
    state.setSelectionShadow(shadowOn() ? readShadow() : null, record);
  };

  toggle.addEventListener('click', () => {
    setToggle(toggle, !shadowOn());
    // Apply FIRST (writes/removes data-fx-shadow from the new switch state), THEN
    // refresh the panel — updateEffectsPanel re-syncs the switch from the stored
    // shadow, so running it before applyShadow would clobber the switch back off
    // and the shadow would never be written.
    applyShadow(true);
    updateEffectsPanel(state); // reveal/hide the param rows to match
  });
  // Live-drag the opacity slider; commit on release. The rest are discrete.
  opacity.after(sliderField(opacity, PERCENT));
  bindLiveCommit(opacity, () => applyShadow(false), () => applyShadow(true));
  for (const inp of [dx, dy, soft]) inp.addEventListener('change', () => applyShadow(true));

  // Shadow colour via the custom picker: live while dragging, one undo step on close.
  colorBtn.addEventListener('click', () => {
    if (!hasSel()) return;
    openSolidColorPicker(
      state, colorBtn, shadowColor,
      (value) => { if (!value) return; shadowColor = value; setShadowPreview(value); applyShadow(false); },
      'Shadow', () => applyShadow(true),
    );
  });

  // ---- Object opacity (Layer section) ----
  const objOpacity = $<HTMLInputElement>('obj-opacity');
  const applyOpacity = (record: boolean) => {
    if (!hasSel()) return;
    state.setSelectionOpacity(parseFloat(objOpacity.value) || 0, record);
  };
  objOpacity.after(sliderField(objOpacity, PERCENT));
  bindLiveCommit(objOpacity, () => applyOpacity(false), () => applyOpacity(true));

  // ---- Blend mode (Layer section) ----
  $<HTMLSelectElement>('fx-blend').addEventListener('change', () => {
    if (hasSel()) state.setSelectionBlendMode($<HTMLSelectElement>('fx-blend').value);
  });
}

/** Reflect the selected object's Layer + Effects props into the panel. */
export function updateEffectsPanel(state: AppState): void {
  const group = document.getElementById('effects-group');
  const layerGroup = document.getElementById('layer-group');
  const paramsRow = document.getElementById('prop-shadow-params');
  if (!group || !layerGroup || !paramsRow) return;

  // Both the Layer (opacity/blend) and Effects sections show whenever ≥1 object is
  // selected; the fields reflect the primary object, edits apply to the whole selection.
  const single = state.selectedShapeIds.length >= 1 ? state.getSelectedShape() : null;
  if (!single) { group.style.display = 'none'; layerGroup.style.display = 'none'; return; }
  group.style.display = '';
  layerGroup.style.display = '';

  setSliderValue($<HTMLInputElement>('obj-opacity'), state.getObjectOpacity(single.id));
  $<HTMLSelectElement>('fx-blend').value = state.getBlendMode(single.id);

  const fx = state.getObjectEffects(single.id);
  setSliderValue($<HTMLInputElement>('fx-blur'), fx.blur);

  const toggle = $<HTMLButtonElement>('fx-shadow-toggle');
  const on = !!fx.shadow;
  setToggle(toggle, on);
  paramsRow.style.display = on ? '' : 'none';
  if (fx.shadow) {
    shadowColor = fx.shadow.color;
    setShadowPreview(fx.shadow.color);
    setSliderValue($<HTMLInputElement>('fx-shadow-opacity'), fx.shadow.opacity);
    $<HTMLInputElement>('fx-shadow-dx').value = String(fx.shadow.dx);
    $<HTMLInputElement>('fx-shadow-dy').value = String(fx.shadow.dy);
    $<HTMLInputElement>('fx-shadow-blur').value = String(fx.shadow.blur);
  }
}
