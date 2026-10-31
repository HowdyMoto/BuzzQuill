// Inspector — the right panel's context layer.
//
// Two jobs, both driven by the current selection:
//  1. A header showing the selected object's NAME (editable) + TYPE — or "Canvas"
//     when nothing is selected.
//  2. Context-sensitive panel VISIBILITY: only the panels relevant to what's
//     selected are shown (Transform for anything, Appearance/Swatches for paintable
//     objects, Width for paths, Character for text, Align/Pathfinder for multi, …).
//     With nothing selected, the Canvas panel (background colour) takes over.
//
// The per-panel *contents* are still owned by their own modules (properties, width,
// frame, …); this module only decides which are on screen and renders the header.
// Called from onStateChange via updateInspector(). Panel-frame stays owned by
// frame-panel.ts; panel-type visibility is centralised here.

import type { AppState } from '../core/state';
import { getFocusedStyle } from './style-panel';
import { selectionHasStyleLinks } from './object-styles-panel';
import type { ShapeData } from '../core/types';
import { openSolidColorPicker } from './color-picker';
import { isTextShape } from './properties';
import { selectedRepeatId } from './repeat-panel';
import { byId as $ } from './dom';

/** The backdrop colour actually on screen when the document has no explicit
 *  canvas background (i.e. the editor theme's pasteboard token). */
const themeCanvasBg = () =>
  getComputedStyle(document.documentElement).getPropertyValue('--ai-bg').trim() || '#000000';

/** Friendly, human names for the internal shape-type tags shown in the header. */
const TYPE_LABEL: Record<ShapeData['type'], string> = {
  rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', polyline: 'Polyline',
  path: 'Path', text: 'Text', polygon: 'Polygon', group: 'Group', image: 'Image',
  use: 'Symbol', boolean: 'Compound Shape', frame: 'Frame', repeat: 'Repeat Grid',
  linked: 'Linked File',
  // Fallbacks — usually resolved to the underlying geometry by typeLabel() below.
  appearance: 'Shape', width: 'Path',
};

/** Friendly geometry name for an SVG element tag (the shape it *is*, not how it's
 *  stored). Used to unwrap the internal `appearance`/`width` container types. */
function tagLabel(el: Element | null): string | null {
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  if (tag === 'rect' || (tag === 'path' && el.hasAttribute('data-rect'))) return 'Rectangle';
  if (tag === 'ellipse' || tag === 'circle') return 'Ellipse';
  if (tag === 'line') return 'Line';
  if (tag === 'polyline') return 'Polyline';
  if (tag === 'polygon') return 'Polygon';
  if (tag === 'text') return 'Text';
  if (tag === 'path') return 'Path';
  return null;
}

/**
 * Header type label. The internal `appearance` (multiple fills/strokes) and `width`
 * (variable-width stroke) types are storage wrappers, not something a user thinks in
 * — so we report the SHAPE they actually wrap (e.g. a many-stroked line reads as
 * "Path", not "Shape"), tagging it as multi-stroke when it has 2+ paint layers.
 */
function typeLabel(shape: ShapeData): string {
  // A clip-group reads as a "Mask" (that's the operation that made it), not a Group.
  if (shape.element.hasAttribute('data-clip-group')) return 'Mask';
  if (shape.type === 'appearance' || shape.type === 'width') {
    const sel = shape.type === 'width' ? '[data-width-src]' : '[data-ap-src]';
    const base = tagLabel(shape.element.querySelector(`:scope > ${sel}`)) ?? 'Path';
    if (shape.type === 'width') return `${base} · Variable width`;
    let layers = 0;
    try { layers = (JSON.parse(shape.element.getAttribute('data-appearance') || '[]') as unknown[]).length; } catch { /* 0 */ }
    return layers >= 2 ? `${base} · Multi-stroke` : base;
  }
  return TYPE_LABEL[shape.type] ?? shape.type;
}

const show = (id: string, on: boolean) => { const el = $(id); if (el) el.style.display = on ? '' : 'none'; };

export function setupInspector(state: AppState): void {
  const nameInput = $('inspector-name') as HTMLInputElement | null;
  const bgBtn = $('canvas-bg-btn');
  const bgReset = $('canvas-bg-reset') as HTMLButtonElement | null;

  // Rename the selected object from the header (mirrors the Layers-panel rename).
  const commitName = () => {
    if (!nameInput || nameInput.readOnly) return;
    const ids = state.selectedShapeIds;
    if (ids.length !== 1) return;
    const shape = state.findShapeById(ids[0]);
    if (!shape) return;
    const name = nameInput.value.trim();
    if (!name || name === shape.name) { nameInput.value = shape.name; return; }
    state.renameShape(shape.id, name); // frame renames also refresh the canvas label
  };
  nameInput?.addEventListener('change', commitName);
  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
    else if (e.key === 'Escape') { updateInspector(state); nameInput.blur(); }
  });

  // Canvas background colour — uses the app's custom picker (not a native input),
  // so it matches every other colour control. Applies live; "none" resets to the
  // theme default. Persisted via document metadata (setCanvasBackground records no
  // undo step of its own).
  if (bgBtn) {
    const btn = bgBtn;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSolidColorPicker(
        state, btn, state.canvasBackground ?? themeCanvasBg(),
        (value) => state.setCanvasBackground(value, true), 'Canvas',
      );
    });
  }
  bgReset?.addEventListener('click', () => state.setCanvasBackground(null, true));
}

export function updateInspector(state: AppState): void {
  const ids = state.selectedShapeIds;
  const shapes = ids.map(id => state.findShapeById(id)).filter((s): s is ShapeData => !!s);
  const n = shapes.length;
  const single = n === 1 ? shapes[0] : null;
  const t = single?.type;

  // ---- Header ----
  const nameInput = $('inspector-name') as HTMLInputElement | null;
  const typeEl = $('inspector-type');
  if (nameInput && typeEl) {
    if (n === 0) {
      nameInput.value = 'Canvas'; nameInput.readOnly = true;
      typeEl.textContent = 'Background';
    } else if (single) {
      // Don't clobber the field mid-edit (would fight the user's typing).
      if (document.activeElement !== nameInput) nameInput.value = single.name;
      nameInput.readOnly = false;
      typeEl.textContent = typeLabel(single);
    } else {
      nameInput.value = `${n} objects`; nameInput.readOnly = true;
      typeEl.textContent = 'Selection';
    }
  }

  // ---- Canvas panel: reflect the current background ----
  if (n === 0) {
    const bgPreview = $('canvas-bg-preview');
    const bgReset = $('canvas-bg-reset') as HTMLButtonElement | null;
    if (bgPreview) bgPreview.style.background = state.canvasBackground ?? themeCanvasBg();
    if (bgReset) bgReset.style.display = state.canvasBackground ? '' : 'none';
  }

  // ---- Context-sensitive panel visibility ----
  // "Paintable" = has fill/stroke/opacity worth editing: any object except a frame
  // (a frame's backing is chrome, edited via the Frame panel) and the empty canvas.
  const paintable = n >= 1 && !(single && single.type === 'frame');
  const isPath = !!single && (t === 'path' || t === 'line' || t === 'polyline' || t === 'polygon' || t === 'width');
  // A clip-group (mask) just clips its content — a fill/stroke on it renders nothing,
  // so its Fill/Stroke panels stay hidden (mirrors updateAppearancePanel's old guard).
  const isMask = !!(single && single.element.hasAttribute('data-clip-group'));

  show('panel-style', !!getFocusedStyle()); // live style editor (Library focus)
  show('panel-object-styles', selectionHasStyleLinks(state)); // which styles the selection uses
  show('panel-canvas', n === 0);
  show('panel-properties', n >= 1);            // Transform: position/size of any selection
  show('panel-fill', paintable && !isMask);    // Fill — its own panel (fills stack + multi-select row)
  show('panel-stroke', paintable && !isMask);  // Stroke — its own panel (strokes stack)
  show('panel-appearance', paintable);         // Layer opacity/blend, corner radius, markers, effects
  show('panel-swatches', paintable);
  show('panel-width', isPath);                 // variable-width stroke profiles
  show('panel-repeat', !!selectedRepeatId(state)); // repeat grid (or its source) selected
  // Text panels: shown for ANY all-text selection (one OR many) so font/size/weight/
  // etc. can be edited across the whole group at once. isTextShape also covers
  // multi-stroke (appearance-wrapped) text. The panels' read + apply are already
  // multi-selection aware (shared value / "Mixed", applied to every selected text).
  const allText = n >= 1 && shapes.every(isTextShape);
  show('panel-type', allText);                 // Character / Text
  show('panel-type-advanced', allText);        // Type settings (case/decoration/baseline)
  show('panel-align', n >= 2);                 // align/distribute needs ≥2 objects
  show('panel-pathfinder', n >= 2 || t === 'boolean'); // combine ≥2, or flatten a compound
  show('panel-symbols', t === 'use');          // symbol-instance actions (create is in the menu)
  // panel-frame / panel-frame-grid / panel-frame-rulers are owned by
  // frame-panel.ts (single-frame only).
}
