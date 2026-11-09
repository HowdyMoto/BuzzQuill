import type { AppState } from '../../core/state';
import type { AppearanceLayer, ShapeData } from '../../core/types';

import { bindLiveCommit } from '../dom';
import { setSliderValue, sliderField } from '../slider-field';
import { hasFill, hasCornerRadius, all, common, MIXED, type Maybe, type ShapeType } from '../../core/shape-props';
import { readRectBox } from '../../core/rect-shape';

import { MIXED_SWATCH, setNumField, putVal, setToggle } from './fields';
import { setupTransformProperties, updateTransformReadout } from './transform-controls';
import { setupTextProperties, updateTextProperties, resetTextProperties } from './text-controls';

/** Convert SVG fill/stroke values to CSS-renderable backgrounds for preview swatches */
export function paintPreviewBg(value: string, state: AppState): string {
  if (!value || value === 'none') return 'transparent';
  if (value.startsWith('url(#grad-')) {
    const id = value.match(/url\(#(grad-\d+)\)/)?.[1];
    if (id) {
      const grad = state.getGradientById(id);
      if (grad) {
        const stops = grad.stops.map(s => `${s.color} ${Math.round(s.offset * 100)}%`).join(', ');
        if (grad.type === 'linear') {
          const dx = (grad.x2 ?? 1) - (grad.x1 ?? 0);
          const dy = (grad.y2 ?? 0) - (grad.y1 ?? 0);
          const angle = Math.round((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360);
          return `linear-gradient(${angle}deg, ${stops})`;
        }
        return `radial-gradient(circle, ${stops})`;
      }
    }
  }
  if (value.startsWith('url(#pat-')) {
    // An image pattern shows the actual image (so a fill swatch reveals its source);
    // preset patterns fall back to a neutral checker glyph.
    const id = value.match(/url\(#(pat-\d+)\)/)?.[1];
    const pat = id ? state.getPatternById(id) : undefined;
    if (pat?.type === 'image' && pat.imageDataUrl) {
      return `url("${pat.imageDataUrl}") center / cover no-repeat`;
    }
    return 'repeating-conic-gradient(#555 0% 25%, #666 0% 50%) 0 0/8px 8px';
  }
  if (value.startsWith('url(')) return '#888';
  return value;
}

/** A paint preview swatch: shared colour, transparent (none), or the mixed swatch. */
function setPreview(el: HTMLElement, v: Maybe<string>, state: AppState): void {
  if (v === MIXED || v === undefined) { el.style.background = MIXED_SWATCH; return; }
  el.style.background = v === 'none' ? 'transparent' : paintPreviewBg(v, state);
}

/** Show the Point-type row while node-editing and reflect the selection's type. */
function updateNodeRow(state: AppState): void {
  const row = document.getElementById('prop-node-row') as HTMLElement | null;
  if (!row) return;
  const session = state.pathEdit;
  const active = !!(state.editingPathId && session && session.selected.size > 0);
  row.style.display = active ? '' : 'none';
  if (!active) return;
  const straighten = document.getElementById('prop-node-straighten') as HTMLButtonElement | null;
  if (straighten) straighten.disabled = !session!.canStraightenSelectedSegment();
  const type = session!.selectionType();
  for (const mode of ['corner', 'smooth', 'broken']) {
    const button = document.getElementById(`prop-node-${mode}`) as HTMLButtonElement;
    button.classList.toggle('active', type === mode);
    button.setAttribute('aria-pressed', String(type === mode));
  }
  const hint = document.getElementById('prop-node-hint');
  if (hint) hint.textContent = type === 'corner' ? 'No curve handles' : type === 'smooth' ? 'Handles stay aligned' : type === 'broken' ? 'Handles move independently' : 'Mixed modes — choose one for all selected points';

}

/** Refresh ONLY the corner-radius fields (the linked field + the per-corner grid)
 *  from the current selection. Cheap enough to run every frame, so the panel
 *  tracks a live corner-radius handle drag the same way X/Y/W/H/R track a resize.
 *  setNumField already skips the field being typed in, so this never fights the
 *  user's own edits. No-op unless every selected shape has a corner radius. */
export function updateRadiusReadout(state: AppState): void {
  const propRx = document.getElementById('prop-rx') as HTMLInputElement | null;
  if (!propRx) return;
  const shapes = state.getSelectedShapes();
  if (shapes.length === 0 || !all(shapes, hasCornerRadius)) return;
  const boxes = shapes.map(s => readRectBox(s.element));
  const cornerIds = ['prop-rx-tl', 'prop-rx-tr', 'prop-rx-br', 'prop-rx-bl'] as const;
  cornerIds.forEach((id, ci) => {
    const inp = document.getElementById(id) as HTMLInputElement | null;
    if (inp) setNumField(inp, common(boxes, b => b.radii[ci]));
  });
  // Linked field = the single radius shared by every corner of every selected rect,
  // otherwise "Mixed".
  const flat = boxes.flatMap(b => b.radii);
  const uniform = flat.length > 0 && flat.every(v => v === flat[0]);
  setNumField(propRx, uniform ? flat[0] : MIXED);
}

export function updatePropertiesPanel(state: AppState): void {
  const fillGroup = document.getElementById('fill-group') as HTMLElement | null;
  const fillNoneBtn = document.getElementById('prop-fill-none') as HTMLButtonElement;
  const fillPreview = document.getElementById('prop-fill-preview') as HTMLElement;
  const fillOpacityInput = document.getElementById('prop-fill-opacity') as HTMLInputElement;
  const propRx = document.getElementById('prop-rx') as HTMLInputElement;
  const rxRow = document.getElementById('prop-corners-row') as HTMLElement;
  const propRotation = document.getElementById('prop-rotation') as HTMLInputElement;

  // Toolbar swatches
  const fillSwatch = document.querySelector('#tb-fill-swatch .swatch-inner') as HTMLElement;
  const strokeSwatch = document.querySelector('#tb-stroke-swatch .swatch-inner') as HTMLElement;

  const shapes = state.getSelectedShapes();

  if (shapes.length === 0) {
    // ---- Nothing selected: reflect the tool defaults ----
    const ds = state.defaultStyle;
    if (fillGroup) fillGroup.style.display = '';
    fillNoneBtn.classList.remove('indeterminate');
    resetTextProperties();
    fillNoneBtn.classList.toggle('active', state.fillNone);
    fillPreview.style.background = state.fillNone ? 'transparent' : paintPreviewBg(ds.fill, state);
    setSliderValue(fillOpacityInput, ds.fillOpacity ?? 1);
    putVal(propRx, String(ds.rx ?? 0)); propRx.placeholder = '';
    rxRow.style.display = 'none';
    updateNodeRow(state);
    const rotRow0 = document.getElementById('prop-rotation-row');
    if (rotRow0) rotRow0.style.display = '';
    fillSwatch.style.background = state.fillNone ? 'transparent' : paintPreviewBg(ds.fill, state);
    strokeSwatch.style.borderColor = state.strokeNone ? 'transparent' : (ds.stroke.startsWith('url(') ? '#888' : ds.stroke);
    return;
  }

  // ---- One or more selected: show shared value or "Mixed", per property ----
  const isMulti = shapes.length > 1;

  // Fill: for a SINGLE selection the Fills list (appearance-panel) owns fills, so the
  // legacy Fill row shows only for a MULTI-selection (where it gives the mixed display
  // + apply-to-all that the per-object stack can't). Still gated on every shape being
  // fillable.
  const showFill = all(shapes, hasFill);
  if (fillGroup) fillGroup.style.display = (showFill && isMulti) ? '' : 'none';
  if (showFill) {
    setToggle(fillNoneBtn, common(shapes, s => s.style.fill === 'none'));
    setPreview(fillPreview, common(shapes, s => (s.style.fillMixed ? MIXED : s.style.fill)), state);
    const fo = common(shapes, s => s.style.fillOpacity ?? 1);
    setSliderValue(fillOpacityInput,
      fo === MIXED || fo === undefined ? (shapes[0].style.fillOpacity ?? 1) : fo, fo === MIXED);
  }

  // Corner radius (rect only): the linked field shows the shared radius (or "Mixed"),
  // and the per-corner grid shows each corner across the selection.
  const showRx = all(shapes, hasCornerRadius);
  rxRow.style.display = showRx ? '' : 'none';
  const cornersGrid = document.getElementById('prop-corners-grid') as HTMLElement | null;
  if (showRx) {
    updateRadiusReadout(state); // shared with the live handle-drag path (see main.ts)
  } else if (cornersGrid) {
    cornersGrid.style.display = 'none';
    document.getElementById('prop-corners-toggle')?.classList.remove('active');
  }

  updateTextProperties(state);

  updateTransformReadout(state);
  updateNodeRow(state);

  // Rotation is single-object only (frames are axis-aligned; multi uses the handle).
  const rotRow = document.getElementById('prop-rotation-row');
  if (rotRow) rotRow.style.display = (isMulti || shapes.some(s => s.type === 'frame')) ? 'none' : '';
  if (isMulti) propRotation.placeholder = '';

  // Toolbar swatches reflect the shared paint (mixed → neutral).
  const fillC = common(shapes, s => (s.style.fillMixed ? MIXED : s.style.fill));
  fillSwatch.style.background = fillC === MIXED || fillC === undefined ? MIXED_SWATCH
    : (fillC === 'none' ? 'transparent' : paintPreviewBg(fillC, state));
  const strokeC = common(shapes, s => (s.style.strokeMixed ? MIXED : s.style.stroke));
  strokeSwatch.style.borderColor = strokeC === MIXED || strokeC === undefined ? '#9aa0ab'
    : (strokeC === 'none' ? 'transparent' : (strokeC.startsWith('url(') ? '#888' : strokeC));
}
export function setupProperties(state: AppState): void {
  setupTextProperties(state);
  document.getElementById('prop-node-straighten')?.addEventListener('click', () => {
    if (state.pathEdit?.straightenSelectedSegment()) state.commitPathEdit();
  });

  // Node point-type buttons (visible only while node-editing a path).
  for (const [id, type] of [
    ['prop-node-corner', 'corner'], ['prop-node-smooth', 'smooth'], ['prop-node-broken', 'broken'],
  ] as const) {
    document.getElementById(id)?.addEventListener('click', () => {
      if (!state.pathEdit || state.pathEdit.selected.size === 0) return;
      state.pathEdit.setSelectedType(type);
      state.commitPathEdit();
    });
  }

  const fillNoneBtn = document.getElementById('prop-fill-none') as HTMLButtonElement;
  const fillOpacityInput = document.getElementById('prop-fill-opacity') as HTMLInputElement;
  const propRx = document.getElementById('prop-rx') as HTMLInputElement;
  // ---- Per-property appliers ----
  //
  // Each control writes ONE property to EVERY selected object that supports it, as a
  // single undo step (record=true on commit). With nothing selected, the property is
  // stored on the tool defaults instead. This replaces the old "write every control
  // to the primary object" apply, which both ignored the rest of a multi-selection
  // and clobbered per-object values you weren't editing.

  /** Run `write` over each selected supporting shape; else update the tool default.
   *  Appearance-wrapped (multi-paint) shapes carry their paints in a layer stack the
   *  plain attribute writers can't touch — when `writeStack` is given they get a
   *  stack edit instead, batched through setAppearanceMulti (one rebuild + undo step,
   *  selection preserved). Without `writeStack` the writer's own skip applies. */
  const applyProp = (
    supports: (t: ShapeType) => boolean,
    write: (shape: ShapeData) => void,
    record: boolean,
    writeStack?: (layers: AppearanceLayer[]) => void,
  ): void => {
    const shapes = state.getSelectedShapes().filter(s => supports(s.type));
    // Nothing selected → no-op. New shapes use the FIXED defaultStyle; editing a panel
    // never "learns" a new default (defaults change only via the explicit Default
    // Fill/Stroke command). Panels only ever affect the selected object.
    if (shapes.length === 0) return;
    const edits: Array<{ id: string; layers: AppearanceLayer[] }> = [];
    for (const s of shapes) {
      if (s.type === 'appearance' && writeStack) {
        const layers = state.getAppearance(s.id);
        writeStack(layers);
        edits.push({ id: s.id, layers });
      } else write(s);
    }
    if (edits.length > 0) state.setAppearanceMulti(edits, [...state.selectedShapeIds], false);
    if (record) state.saveHistory();
    state.onChange_public();
  };

  // Fill on/off
  const applyFillNone = (none: boolean, record: boolean): void => applyProp(hasFill, (s) => {
    const el = s.element;
    if (none) { el.setAttribute('fill', 'none'); s.style.fill = 'none'; }
    else {
      const c = s.style.fill && s.style.fill !== 'none' ? s.style.fill : state.defaultStyle.fill;
      el.setAttribute('fill', c); s.style.fill = c;
    }
  }, record, (layers) => {
    const f = layers.find(l => l.t === 'fill');
    if (none) { if (f) f.visible = false; }
    else if (f) f.visible = true;
    else layers.push({ t: 'fill', paint: state.defaultStyle.fill, opacity: 1 });
  });
  // Fill opacity
  const applyFillOpacity = (v: number, record: boolean): void => applyProp(hasFill, (s) => {
    const el = s.element;
    if (v < 1) el.setAttribute('fill-opacity', String(v)); else el.removeAttribute('fill-opacity');
    s.style.fillOpacity = v;
  }, record, (layers) => {
    const f = layers.find(l => l.t === 'fill');
    if (f) { f.visible = true; f.opacity = v; }
    else layers.push({ t: 'fill', paint: state.defaultStyle.fill, opacity: v });
  });
  // Cap / Join / Miter are path-level; owned by the top-level Stroke-panel controls
  // (ui/markers.ts), so they're no longer wired from here.
  // Corner radius (rect only). The linked field sets all four corners; the per-corner
  // grid sets them independently (which promotes the rect to a parametric path).
  const applyRx = (rx: number, record: boolean): void => {
    if (!state.getSelectedShapes().some(s => s.type === 'rect')) return;
    state.setSelectionRectRadii([rx, rx, rx, rx], record);
  };
  const applyCornerRadii = (record: boolean): void => {
    const rd = (id: string) => Math.max(0, parseFloat((document.getElementById(id) as HTMLInputElement).value) || 0);
    state.setSelectionRectRadii([rd('prop-rx-tl'), rd('prop-rx-tr'), rd('prop-rx-br'), rd('prop-rx-bl')], record);
  };
  // ---- Wiring ----

  // Live drag-scrub / slider `input` applies with record=false (no undo spam); the
  // final `change`/release commits with record=true → one undo step. Shared helper.
  const bindLive = bindLiveCommit;

  // Fill on/off — indeterminate (mixed) resolves to "filled" on the first click.
  fillNoneBtn.addEventListener('click', () => {
    const none = fillNoneBtn.classList.contains('indeterminate') ? false : !fillNoneBtn.classList.contains('active');
    fillNoneBtn.classList.remove('indeterminate');
    fillNoneBtn.classList.toggle('active', none);
    applyFillNone(none, true);
  });
  fillOpacityInput.after(sliderField(fillOpacityInput, { scale: 100, unit: '%' }));
  bindLive(fillOpacityInput, () => applyFillOpacity(parseFloat(fillOpacityInput.value), false),
    () => applyFillOpacity(parseFloat(fillOpacityInput.value), true));

  bindLive(propRx, () => { const v = parseFloat(propRx.value); if (Number.isFinite(v)) applyRx(v, false); },
    () => { const v = parseFloat(propRx.value); if (Number.isFinite(v)) applyRx(v, true); });
  // Per-corner radius grid + its reveal toggle.
  for (const id of ['prop-rx-tl', 'prop-rx-tr', 'prop-rx-br', 'prop-rx-bl']) {
    const inp = document.getElementById(id) as HTMLInputElement | null;
    if (inp) bindLive(inp, () => applyCornerRadii(false), () => applyCornerRadii(true));
  }
  document.getElementById('prop-corners-toggle')?.addEventListener('click', () => {
    const grid = document.getElementById('prop-corners-grid');
    const btn = document.getElementById('prop-corners-toggle');
    if (!grid || !btn) return;
    const open = grid.style.display === 'none';
    grid.style.display = open ? '' : 'none';
    btn.classList.toggle('active', open);
  });

  setupTransformProperties(state);
}
