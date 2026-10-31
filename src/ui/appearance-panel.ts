// ---------------------------------------------------------------------------
// Appearance panel — Illustrator/Figma-style stacks of FILLS and STROKES on one
// object, both driven by the same appearance stack (state.getAppearance /
// setAppearance, which wrap/unwrap a <g data-appearance> transparently).
//
// Two accordion sections over one `AppearanceLayer[]`:
//   • Fills   — [drag] [eye] [paint] [expand→ opacity/blend] [delete]
//   • Strokes — [drag] [eye] [paint] [weight] [expand→ dash/cap/join/…] [delete]
//
// "Add fill" offers a type: Solid | Gradient | Image | Pattern (the type is just
// what the layer's `paint` points at — a hex, a url(#grad-…), or a url(#pat-…)).
// A single-fill object stays a plain <rect fill> until a 2nd fill/stroke or a
// blend/offset/cut forces the wrapper (handled by AppearanceManager.isTrivial).
// ---------------------------------------------------------------------------

import type { AppState } from '../core/state';
import type { AppearanceLayer, GradientDef, PatternDef } from '../core/types';
import { paintPreviewBg } from './properties';
import { openLayerColorPicker, openSolidColorPicker } from './color-picker';
import { buildGradientEditor, buildPatternEditor, type PaintEditorHost } from './paint-editors';
import { ensureOffsetEngine } from '../core/boolean';
import { el } from './dom';
import { paintableLeaves, containerPaint, isPlainGroup, effectivePaint } from '../core/effective-paint';
import { showToast } from './toast';

const ICON_EYE = '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 3.5c-3 0-5.3 2.2-6 4.5.7 2.3 3 4.5 6 4.5s5.3-2.2 6-4.5c-.7-2.3-3-4.5-6-4.5z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="1.8" fill="currentColor"/></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 3.5c-3 0-5.3 2.2-6 4.5.7 2.3 3 4.5 6 4.5s5.3-2.2 6-4.5c-.7-2.3-3-4.5-6-4.5z" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.55"/><line x1="3" y1="13" x2="13" y2="3" stroke="currentColor" stroke-width="1.2"/></svg>';
const ICON_GRIP = '<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="6" cy="4" r="1"/><circle cx="10" cy="4" r="1"/><circle cx="6" cy="8" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="6" cy="12" r="1"/><circle cx="10" cy="12" r="1"/></svg>';
const ICON_X = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const CHEVRON = '<svg viewBox="0 0 16 16" width="10" height="10"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CUT = '<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="4" cy="4" r="2" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="4" cy="12" r="2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 5.5L14 12M5.5 10.5L14 4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

type Kind = 'fill' | 'stroke';
type FillType = 'solid' | 'gradient' | 'image' | 'pattern';

// The open row, identified by section + position (both sections share one stack).
let expanded: { kind: Kind; pos: number } | null = null;
let suspend = false; // freeze re-render during a live scrub
let rendering = false; // re-entrancy guard — see updateAppearancePanel

function svgIcon(html: string): HTMLElement { const s = el('span'); s.innerHTML = html; return s; }

/** The full appearance stack (fills + strokes) for the current context. */
function stackOf(state: AppState): AppearanceLayer[] {
  const shape = state.getSelectedShape();
  if (shape) return state.getAppearance(shape.id);
  const ds = state.defaultStyle;
  if (state.strokeNone) return [];
  const L: AppearanceLayer = { t: 'stroke', paint: ds.stroke, width: ds.strokeWidth, opacity: ds.strokeOpacity ?? 1 };
  if (ds.strokeDasharray) L.dash = ds.strokeDasharray;
  if (ds.strokeDashoffset) L.dashOffset = ds.strokeDashoffset;
  if (ds.strokeLinecap && ds.strokeLinecap !== 'butt') L.cap = ds.strokeLinecap as AppearanceLayer['cap'];
  if (ds.strokeLinejoin && ds.strokeLinejoin !== 'miter') L.join = ds.strokeLinejoin as AppearanceLayer['join'];
  if (ds.strokeMiterlimit && ds.strokeMiterlimit !== 4) L.miter = ds.strokeMiterlimit;
  if (ds.strokeNonScaling) L.nonScaling = true;
  return [L];
}

/** Write a modified stack back to all selected shapes or the primary shape only (for fills, which are per-object).
 *  With nothing selected, does nothing — defaults are fixed. `editFn` is re-applied to each shape's stack for multi-selection. */
function commit(state: AppState, layers: AppearanceLayer[], record = true, editFn?: (l: AppearanceLayer[]) => void): void {
  const shapes = state.getSelectedShapes();
  // Nothing selected → no-op: the stroke panel only edits the selected object. New
  // shapes use the fixed defaults, so editing here never "learns" a new default.
  if (shapes.length === 0) return;
  if (shapes.length === 1) {
    state.setAppearance(shapes[0].id, layers, record);
    return;
  }
  const edits = shapes.map(shape => {
    const shapeStack = state.getAppearance(shape.id);
    if (editFn) editFn(shapeStack);
    return { id: shape.id, layers: shapeStack };
  });
  state.setAppearanceMulti(edits, shapes.map(s => s.id), record);
}

/** Indices (into the full stack) of the layers of one type, top-first. */
function indicesOfType(layers: AppearanceLayer[], t: Kind): number[] {
  const out: number[] = [];
  layers.forEach((L, i) => { if (L.t === t) out.push(i); });
  return out;
}

/** Absolute stack index of the Nth layer of a kind (top-first), or -1 if the stack
 *  has no such layer. Row edits address layers this way so a multi-selection edit
 *  lands on each shape's OWN Nth fill/stroke — never on whatever happens to sit at
 *  the primary shape's absolute index (stacks interleave fills and strokes freely). */
function resolveIdx(layers: AppearanceLayer[], kind: Kind, pos: number): number {
  const idxs = indicesOfType(layers, kind);
  return pos < idxs.length ? idxs[pos] : -1;
}

// ---- Add-layer entry points ----

/**
 * Add a stroke to all selected shapes' stacks and open its row. `opts.offset`
 * seeds a live parallel offset; `opts.cut` makes it a knockout. Shared by the
 * panel's `+` button and the contextual path-actions popover.
 */
export function addStroke(state: AppState, opts?: { offset?: number; cut?: boolean }): void {
  const shapes = state.getSelectedShapes();
  if (shapes.length === 0) {
    const layers = stackOf(state);
    const ds = state.defaultStyle;
    const base: AppearanceLayer = {
      t: 'stroke', paint: ds.stroke === 'none' ? '#000000' : ds.stroke,
      width: ds.strokeWidth || 1, opacity: 1,
    };
    if (opts?.offset) base.offset = opts.offset;
    if (opts?.cut) { base.cut = true; base.width = Math.max(1, Math.round((ds.strokeWidth || 4) / 2)); }
    layers.unshift(base);
    expanded = { kind: 'stroke', pos: 0 };
    commit(state, layers, true);
    return;
  }
  const ds = state.defaultStyle;
  const base: AppearanceLayer = {
    t: 'stroke', paint: ds.stroke === 'none' ? '#000000' : ds.stroke,
    width: ds.strokeWidth || 1, opacity: 1,
  };
  if (opts?.offset) base.offset = opts.offset;
  if (opts?.cut) { base.cut = true; base.width = Math.max(1, Math.round((ds.strokeWidth || 4) / 2)); }
  const edits = shapes.map(shape => {
    const layers = state.getAppearance(shape.id);
    layers.unshift(JSON.parse(JSON.stringify(base)));
    return { id: shape.id, layers };
  });
  expanded = { kind: 'stroke', pos: 0 };
  state.setAppearanceMulti(edits, shapes.map(s => s.id), true);
  updateAppearancePanel(state);
}

/** A preset pattern's marks have to be VISIBLE against what they land on. Seeding
 *  the tint from the object's own fill made "add a Pattern fill" look like a no-op
 *  on the common case — a white object got white marks on white. Choose black or
 *  white by the luminance of the topmost solid fill beneath instead. */
function contrastingTint(state: AppState): string {
  const beneath = stackOf(state).find(l => l.t === 'fill' && /^#[0-9a-f]{6}$/i.test(l.paint))?.paint;
  if (!beneath) return '#000000';
  const n = parseInt(beneath.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.5 ? '#000000' : '#FFFFFF';
}

/** Seed a fill's `paint` for a chosen type (image is handled async separately). */
function seedFillPaint(state: AppState, type: Exclude<FillType, 'image'>): string {
  if (type === 'gradient') return `url(#${state.createGradient('linear').id})`;
  if (type === 'pattern') {
    return `url(#${state.createPattern({
      type: 'preset', preset: 'dots', presetColor: contrastingTint(state), weight: 2,
    }).id})`;
  }
  const f = state.defaultStyle.fill;
  return f && f !== 'none' ? f : '#CCCCCC';
}

/** Add a fill of the chosen type on top of the stack and open its row. */
export function addFill(state: AppState, type: FillType): void {
  if (!state.getSelectedShape()) return; // multi-fill is a per-object thing
  if (type === 'image') { pickImageFill(state); return; }
  const layers = stackOf(state);
  layers.unshift({ t: 'fill', paint: seedFillPaint(state, type), opacity: 1 });
  expanded = { kind: 'fill', pos: 0 };
  commit(state, layers, true);
}

/** File-pick a raster → its data URL + natural pixel size (used to create/replace
 *  the <image> a pattern tiles). */
function pickImageDataUrl(cb: (url: string, w: number, h: number) => void): void {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*'; input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    const file = input.files?.[0]; input.remove();
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      const probe = new Image();
      probe.onload = () => cb(url, probe.naturalWidth, probe.naturalHeight);
      probe.src = url;
    };
    reader.readAsDataURL(file);
  });
  input.click();
}

/** Add a raster as an <image> pattern fill sized to its pixels. */
function pickImageFill(state: AppState): void {
  pickImageDataUrl((url, w, h) => {
    const pat = state.createPattern({ type: 'image', imageDataUrl: url, tileWidth: w, tileHeight: h });
    const layers = stackOf(state);
    layers.unshift({ t: 'fill', paint: `url(#${pat.id})`, opacity: 1 });
    expanded = { kind: 'fill', pos: 0 };
    commit(state, layers, true);
  });
}

// ---- Fill-type chooser popover ----

let typeMenu: HTMLElement | null = null;
function closeTypeMenu(): void {
  typeMenu?.remove(); typeMenu = null;
  window.removeEventListener('mousedown', onMenuOutside, true);
}
function onMenuOutside(e: MouseEvent): void {
  if (typeMenu && !typeMenu.contains(e.target as Node)) closeTypeMenu();
}
function openFillTypeMenu(anchor: HTMLElement, onPick: (t: FillType) => void): void {
  closeTypeMenu();
  const menu = el('div', 'ap-type-menu');
  for (const [t, label] of [['solid', 'Solid'], ['gradient', 'Gradient'], ['image', 'Image'], ['pattern', 'Pattern']] as const) {
    const b = el('button', 'ap-type-item');
    b.textContent = label;
    b.addEventListener('click', () => { closeTypeMenu(); onPick(t); });
    menu.appendChild(b);
  }
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, r.right - 120)}px`;
  document.body.appendChild(menu);
  typeMenu = menu;
  setTimeout(() => window.addEventListener('mousedown', onMenuOutside, true), 0);
}

// ---- Setup + update ----

export function setupAppearancePanel(state: AppState): void {
  document.getElementById('add-stroke-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    addStroke(state);
  });
  document.getElementById('add-fill-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openFillTypeMenu(e.currentTarget as HTMLElement, (t) => addFill(state, t));
  });
}

/** Render both sections. Fills are single-object (the stack is per-object), so the
 *  Fills section hides for a multi-selection — the properties Fill row handles that. */
export function updateAppearancePanel(state: AppState): void {
  if (suspend || rendering) return;
  // Re-entrancy guard: building a row can legitimately touch state — mounting a
  // pattern editor normalizes the def, and `updatePattern` fires onStateChange,
  // which lands right back here. Without the guard the nested pass re-fills the
  // list and the outer pass then appends its rows on top, doubling every row.
  rendering = true;
  try {
    const layers = stackOf(state);
    const single = state.selectedShapeIds.length === 1;
    // A mask (clip-group) just clips its content — a fill/stroke on the group renders
    // nothing, so hide both sections rather than offer controls that do nothing.
    const isMask = !!state.getSelectedShape()?.element.hasAttribute('data-clip-group');

    const fillsSection = document.getElementById('fills-section');
    if (fillsSection) fillsSection.style.display = (single && !isMask) ? '' : 'none';
    const strokeSection = document.getElementById('stroke-group');
    if (strokeSection) strokeSection.style.display = isMask ? 'none' : '';
    if (isMask) return;

    if (single) renderSection(state, layers, 'fill', 'fills-list', 'add-fill-btn');
    renderSection(state, layers, 'stroke', 'strokes-list', 'add-stroke-btn');
  } finally {
    rendering = false;
  }
}

// Back-compat aliases (main.ts / path-actions wiring predates the rename).
export const setupStrokesPanel = setupAppearancePanel;
export const updateStrokesPanel = updateAppearancePanel;



function renderSection(state: AppState, layers: AppearanceLayer[], kind: Kind, listId: string, addBtnId: string): void {
  const list = document.getElementById(listId);
  if (!list) return;
  const addBtn = document.getElementById(addBtnId) as HTMLButtonElement | null;
  const idxs = indicesOfType(layers, kind);
  const sel = state.getSelectedShape();
  const hasShape = !!sel;
  if (addBtn) addBtn.style.visibility = hasShape ? 'visible' : 'hidden';

  list.replaceChildren();

  if (addBtn && kind === 'fill') { addBtn.disabled = false; addBtn.title = 'Add fill'; }

  // A container with no fill of its OWN is the confusing case: an imported icon is
  // a <g> over paths that each paint themselves, so the list had nothing to show
  // and read as "this has no fill" — for artwork that is plainly coloured on screen.
  // An empty box can't distinguish "deliberately none" from "nothing here to paint"
  // from "the colour lives one level down", so don't show one: show the colour that
  // IS there, say where it comes from, and let it be edited in place.
  if (kind === 'fill' && sel && idxs.length === 0 && isPlainGroup(sel.element)) {
    const leaves = paintableLeaves(sel.element);
    if (leaves.length === 0) {
      const note = el('div', 'ap-empty');
      note.textContent = 'Nothing inside to paint.';
      list.appendChild(note);
      return;
    }
    const paint = containerPaint(sel.element, 'fill');
    if (paint.value !== null) {
      // Count only the shapes that actually carry paint. An icon's invisible
      // `fill="none"` viewBox spacer is a shape, but saying "2 shapes" about
      // artwork the user sees as one is just a smaller version of the same lie.
      const painted = leaves.filter((l) => {
        const v = effectivePaint(l, 'fill');
        return v !== null && v !== 'none';
      }).length;
      list.appendChild(buildContentsRow(state, paint.value, paint.mixed, painted));
      return;
    }
    // Everything inside is explicitly unpainted — that IS "no fill", said plainly.
    const note = el('div', 'ap-empty');
    note.textContent = leaves.length === 1
      ? 'No fill — the shape inside is unfilled.'
      : `No fill — the ${leaves.length} shapes inside are unfilled.`;
    note.style.whiteSpace = 'normal';
    list.appendChild(note);
    return;
  }

  if (idxs.length === 0) {
    const empty = el('div', 'ap-empty');
    const noun = kind === 'fill' ? 'fill' : 'stroke';
    empty.textContent = hasShape ? `No ${noun} — click + to add one.` : `No default ${noun}.`;
    list.appendChild(empty);
    return;
  }
  idxs.forEach((layerIdx, pos) => {
    list.appendChild(buildRow(state, layers, layerIdx, kind, pos, idxs.length));
  });
}

function buildRow(
  state: AppState, layers: AppearanceLayer[], layerIdx: number, kind: Kind, pos: number, count: number,
): HTMLElement {
  const L = layers[layerIdx];
  const isOpen = expanded?.kind === kind && expanded.pos === pos;
  const row = el('div', 'ap-row');
  if (L.visible === false) row.classList.add('ap-hidden');
  if (L.cut) row.classList.add('ap-cut');

  const head = el('div', 'ap-head');

  const grip = el('button', 'ap-grip');
  grip.title = 'Drag to reorder';
  grip.appendChild(svgIcon(ICON_GRIP));
  head.appendChild(grip);

  const vis = el('button', 'ap-vis');
  vis.title = L.visible === false ? 'Show' : 'Hide';
  vis.appendChild(svgIcon(L.visible === false ? ICON_EYE_OFF : ICON_EYE));
  vis.addEventListener('click', (e) => {
    e.stopPropagation();
    mutate(state, kind, pos, (l, i) => { l[i].visible = l[i].visible === false; }, true);
  });
  head.appendChild(vis);

  // Color swatch: shown in the header when collapsed (at-a-glance), but moved to
  // its own "Color" row inside the details when a FILL is expanded, so it reads
  // like the other properties instead of living in the header.
  const color = makeColorSwatch(state, layers, layerIdx, kind, pos);
  const colorInDetails = kind === 'fill' && isOpen && !L.cut;
  if (!colorInDetails) head.appendChild(color);

  if (kind === 'stroke') {
    const weight = document.createElement('input');
    weight.type = 'number'; weight.className = 'ap-width'; weight.min = '0'; weight.step = '0.5';
    weight.value = String(L.width ?? 1);
    weight.title = L.cut ? 'Gap thickness' : 'Stroke weight';
    bindNum(state, kind, pos, weight, (l, v) => { l.width = v; });
    head.appendChild(weight);
    const unit = el('span', 'ap-unit'); unit.textContent = 'pt'; head.appendChild(unit);
  }

  const expand = el('button', 'ap-expand');
  if (!isOpen) expand.classList.add('collapsed');
  expand.title = 'Options';
  expand.appendChild(svgIcon(CHEVRON));
  expand.addEventListener('click', (e) => {
    e.stopPropagation();
    expanded = isOpen ? null : { kind, pos };
    updateAppearancePanel(state);
  });
  head.appendChild(expand);

  const del = el('button', 'ap-del');
  del.title = kind === 'fill' ? 'Delete fill' : 'Delete stroke';
  del.appendChild(svgIcon(ICON_X));
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isOpen) expanded = null;
    mutate(state, kind, pos, (l, i) => { l.splice(i, 1); }, true);
  });
  head.appendChild(del);

  row.appendChild(head);

  if (isOpen) row.appendChild(kind === 'fill'
    ? buildFillDetails(state, layers, layerIdx, pos, colorInDetails ? color : null)
    : buildStrokeDetails(state, layers, layerIdx, pos));

  wireReorder(state, row, grip, kind, pos, count);
  return row;
}

/** The paint swatch button for a layer (opens the layer-scoped color picker). */
function makeColorSwatch(state: AppState, layers: AppearanceLayer[], layerIdx: number, kind: Kind, pos: number): HTMLButtonElement {
  const L = layers[layerIdx];
  const color = el('button', 'ap-color') as HTMLButtonElement;
  if (L.cut) {
    color.classList.add('ap-cut-swatch');
    color.innerHTML = ICON_CUT;
    color.title = 'Cut (knockout) — punches a gap through strokes below. Toggle in options.';
    return color;
  }
  const inner = el('span', 'ap-color-inner');
  inner.style.background = L.paint === 'none' ? 'transparent' : paintPreviewBg(L.paint, state);
  if (L.paint === 'none') color.classList.add('ap-color-none');
  color.appendChild(inner);
  color.title = kind === 'fill' ? 'Fill paint' : 'Stroke color';
  color.addEventListener('click', (e) => {
    e.stopPropagation();
    openLayerColorPicker(state, color, L.paint, (value) => {
      mutate(state, kind, pos, (l, i) => { l[i].paint = value === null ? 'none' : value; }, true);
    }, kind);
  });
  return color;
}

/** Fills carry colour (when expanded) + opacity + blend, plus the parameters of
 *  whatever the paint actually IS — an image fill gets Replace/Scale/Rotate, and a
 *  gradient or preset pattern gets its full editor inline (the same builders the
 *  picker popover mounts). Adjusting a pattern or gradient therefore never requires
 *  opening the popover; the colour chip stays for picking a solid and for switching
 *  this fill to a different paint type. When `colorEl` is given, the swatch was
 *  pulled out of the header and shows here as its own Color row. */
function buildFillDetails(state: AppState, layers: AppearanceLayer[], layerIdx: number, pos: number, colorEl: HTMLElement | null): HTMLElement {
  const L = layers[layerIdx];
  const box = el('div', 'ap-details');
  if (colorEl) {
    const row = detailRow('Color');
    row.appendChild(colorEl);
    box.appendChild(row);
  }
  const pat = imagePatternOf(state, L.paint);
  if (pat) appendImageControls(state, box, pat);

  const preset = presetPatternOf(state, L.paint);
  if (preset) box.appendChild(mountInlineEditor(buildPatternEditor(state, preset, panelHost(state, 'fill', pos))));
  const grad = gradientOf(state, L.paint);
  if (grad) box.appendChild(mountInlineEditor(buildGradientEditor(state, grad, panelHost(state, 'fill', pos))));

  box.appendChild(opacityRow(state, L, 'fill', pos));
  box.appendChild(blendRow(state, L, 'fill', pos));
  return box;
}

/** Host seam for an inline editor in a fill row (see `PaintEditorHost`): colours
 *  open the compact solid picker off a chip — unlike the popover, a panel row has
 *  no space for the full SV-square editor but is free to open a popover. */
function panelHost(state: AppState, kind: Kind, pos: number): PaintEditorHost {
  return {
    mountColor: (container, current, onChange) => {
      const chip = el('button', 'ap-color') as HTMLButtonElement;
      const inner = el('span', 'ap-color-inner');
      inner.style.background = current;
      chip.appendChild(inner);
      chip.title = 'Pick colour';
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        openSolidColorPicker(state, chip, current, (v) => {
          if (v === null) return;
          inner.style.background = v;
          onChange(v);
        });
      });
      container.replaceChildren(chip);
    },
    // linear↔radial mints a NEW gradient def, so re-point this layer's paint at it.
    onPaintChange: (value) => mutate(state, kind, pos, (l, i) => { l[i].paint = value; }, true),
  };
}

/** Wrap an inline editor so a drag inside it doesn't get yanked out from under the
 *  pointer: every `updatePattern`/`updateGradient` fires onStateChange, which would
 *  re-render the panel and replace the very slider being dragged. Suspend for the
 *  duration of the interaction; the editor keeps its own preview current, so no
 *  re-render is needed on release (and skipping it preserves the selected stop). */
function mountInlineEditor(editor: HTMLElement): HTMLElement {
  editor.addEventListener('pointerdown', () => {
    suspend = true;
    window.addEventListener('pointerup', () => { suspend = false; }, { once: true });
  });
  return editor;
}

/** The PatternDef for a paint value iff it's an image pattern; else null. */
function imagePatternOf(state: AppState, paint: string): PatternDef | null {
  const id = paint.match(/url\(#(pat-\d+)\)/)?.[1];
  const p = id ? state.getPatternById(id) : undefined;
  return p && p.type === 'image' ? p : null;
}

/** The PatternDef for a paint value iff it's a PRESET pattern; else null. */
function presetPatternOf(state: AppState, paint: string): PatternDef | null {
  const id = paint.match(/url\(#(pat-\d+)\)/)?.[1];
  const p = id ? state.getPatternById(id) : undefined;
  return p && p.type === 'preset' ? p : null;
}

/** The GradientDef for a paint value, or null. */
function gradientOf(state: AppState, paint: string): GradientDef | null {
  const id = paint.match(/url\(#(grad-\d+)\)/)?.[1];
  return (id ? state.getGradientById(id) : undefined) ?? null;
}

/** Replace + Scale + Rotate for an image fill. Pattern-def edits update every
 *  reference live; Scale sets the tile size, and a shape larger than the tile
 *  repeats it (SVG patterns tile by default). */
function appendImageControls(state: AppState, box: HTMLElement, pat: PatternDef): void {
  const repRow = detailRow('Image');
  const replace = el('button', 'ap-img-replace');
  replace.textContent = 'Replace…';
  replace.title = 'Choose a different source image';
  replace.addEventListener('click', () => pickImageDataUrl((url, w, h) => {
    pat.imageDataUrl = url; pat.tileWidth = w; pat.tileHeight = h;
    state.updatePattern(pat);
    updateAppearancePanel(state);
  }));
  repRow.appendChild(replace);
  box.appendChild(repRow);

  box.appendChild(patSlider(state, pat, 'Scale', 10, 400, '%', () => Math.round((pat.scale || 1) * 100), (v) => { pat.scale = v / 100; }));
  box.appendChild(patSlider(state, pat, 'Rotate', 0, 360, '°', () => Math.round(pat.rotation || 0), (v) => { pat.rotation = v; }));
}

/** A scrubby number field bound to a pattern-def field: live-updates the def
 *  (suspending the panel's own rebuild so the field survives the scrub) and
 *  commits on release. Pattern defs live outside the history snapshot, so this
 *  isn't undoable — matching the color picker's pattern editor. */
function patSlider(state: AppState, pat: PatternDef, label: string, min: number, max: number, unit: string, read: () => number, apply: (v: number) => void): HTMLElement {
  const row = detailRow(label);
  const num = document.createElement('input');
  num.type = 'number'; num.min = String(min); num.max = String(max); num.step = '1';
  num.value = String(read());
  const val = (): number => Math.min(max, Math.max(min, parseFloat(num.value) || min));
  num.addEventListener('input', () => {
    suspend = true;
    apply(val());
    state.updatePattern(pat);
  });
  num.addEventListener('change', () => {
    apply(val());
    state.updatePattern(pat);
    suspend = false;
    updateAppearancePanel(state);
  });
  const unitEl = el('span', 'ap-unit'); unitEl.textContent = unit;
  row.append(num, unitEl);
  return row;
}

/** Does the selection contain live <text>? (An appearance-wrapped text keeps its
 *  <text> as the wrapper's source child, so look inside too.) */
function selectionHasLiveText(state: AppState): boolean {
  return state.getSelectedShapes().some(s =>
    s.type === 'text' || !!(s.element as SVGElement).querySelector(':scope > [data-ap-src] text, :scope > text'));
}

/**
 * A stroke on text with NO fill traces every contour the glyph is built from —
 * including the internal seams where a font's overlapping sub-shapes meet, which is
 * why Inter's R and A sprout shelves and doubled edges (#172). That's standard SVG:
 * native <text stroke fill="none"> and Illustrator-before-Create-Outlines do the
 * same. Filled text hides the seams under the fill, so the problem is specific to
 * fill:none.
 *
 * The cure is merging the glyph geometry, which Outline Text already does. Rather
 * than leave people to discover that, say so where the problem appears and offer
 * the one click — while being honest that it converts the text to paths.
 */
function appendTextStrokeHint(state: AppState, box: HTMLElement, layers: AppearanceLayer[]): void {
  if (!selectionHasLiveText(state)) return;
  const hasFill = layers.some(l => l.t === 'fill' && l.visible !== false && l.paint !== 'none');
  if (hasFill) return; // the fill covers the seams — nothing to warn about

  const note = el('div', 'ap-text-stroke-hint');
  const text = el('span', 'ap-hint');
  text.textContent = 'A no-fill stroke traces each glyph’s contours, so some letters show internal seams.';
  const btn = el('button', 'ap-img-replace');
  btn.textContent = 'Outline for a clean stroke';
  btn.title = 'Convert the text to a merged outline path — strokes cleanly, but the layer is no longer editable as text';
  btn.addEventListener('click', () => {
    void state.outlineSelectedText().then((notes) => { if (notes.length) showToast(notes.join('\n')); });
  });
  note.append(text, btn);
  box.appendChild(note);
}

function buildStrokeDetails(state: AppState, layers: AppearanceLayer[], layerIdx: number, pos: number): HTMLElement {
  const L = layers[layerIdx];
  const box = el('div', 'ap-details');
  void ensureOffsetEngine();

  // Same inline paint editors as a fill row — a stroke's paint is the same kind of
  // value, so a gradient or patterned stroke is adjustable here too rather than
  // only through the popover.
  const sPreset = presetPatternOf(state, L.paint);
  if (sPreset) box.appendChild(mountInlineEditor(buildPatternEditor(state, sPreset, panelHost(state, 'stroke', pos))));
  const sGrad = gradientOf(state, L.paint);
  if (sGrad) box.appendChild(mountInlineEditor(buildGradientEditor(state, sGrad, panelHost(state, 'stroke', pos))));

  // Align (center / inside / outside) — a per-ELEMENT emulation (stroke-align.ts),
  // so it shows only for plain single-stroke shapes with an enclosable outline
  // (multi-stroke stacks use per-layer Offset instead). This is the only home of
  // the feature: the hidden legacy stroke panel was retired (#202).
  const alignables = state.getSelectedShapes().filter(s =>
    s.type !== 'appearance' && ALIGNABLE_TYPES.has(s.type));
  if (alignables.length > 0) {
    const current = alignables[0].style.strokeAlign ?? 'center';
    const row = detailRow('Align');
    const group = el('div', 'stroke-seg');
    for (const [v, label] of [['center', 'Center'], ['inside', 'Inside'], ['outside', 'Outside']] as const) {
      const b = el('button');
      if (v === current) b.classList.add('active');
      const span = document.createElement('span'); span.textContent = label; b.appendChild(span);
      b.title = `Stroke sits ${v === 'center' ? 'centred on' : v} the path`;
      b.addEventListener('click', () => state.setSelectionStrokeAlign(v));
      group.appendChild(b);
    }
    row.appendChild(group);
    box.appendChild(row);
  }

  // Cut (knockout)
  const cutRow = detailRow('Cut');
  const cut = document.createElement('input');
  cut.type = 'checkbox'; cut.checked = !!L.cut; cut.style.flex = '0 0 auto';
  cut.title = 'Knock this stroke’s shape out of the strokes below (inline gap / double line)';
  cut.addEventListener('change', () => mutate(state, 'stroke', pos, (l, i) => { l[i].cut = cut.checked || undefined; }, true));
  const cutHint = el('span', 'ap-hint'); cutHint.textContent = 'knockout';
  cutRow.append(cut, cutHint);
  box.appendChild(cutRow);

  box.appendChild(opacityRow(state, L, 'stroke', pos));

  // Offset
  const offRow = detailRow('Offset');
  const off = document.createElement('input');
  off.type = 'number'; off.step = '0.5'; off.value = String(L.offset ?? 0);
  off.title = 'Perpendicular offset (± for either side) — parallel line from the same path';
  off.addEventListener('input', () => liveMutate(state, 'stroke', pos, (l, i) => { l[i].offset = parseFloat(off.value) || undefined; }));
  off.addEventListener('change', async () => {
    await ensureOffsetEngine();
    commitLive(state, 'stroke', pos, (l, i) => { l[i].offset = parseFloat(off.value) || undefined; });
  });
  const offUnit = el('span', 'ap-unit'); offUnit.textContent = 'px';
  offRow.append(off, offUnit);
  box.appendChild(offRow);

  // Dash + offset
  const dashRow = detailRow('Dash');
  const dash = document.createElement('input');
  dash.type = 'text'; dash.placeholder = 'e.g. 5,3'; dash.value = L.dash ?? '';
  dash.addEventListener('input', () => liveMutate(state, 'stroke', pos, (l, i) => { l[i].dash = dash.value.trim() || undefined; }));
  dash.addEventListener('change', () => commitLive(state, 'stroke', pos, (l, i) => { l[i].dash = dash.value.trim() || undefined; }));
  const doff = document.createElement('input');
  doff.type = 'number'; doff.step = '1'; doff.value = String(L.dashOffset ?? 0);
  doff.style.flex = '0 0 46px';
  bindNum(state, 'stroke', pos, doff, (l, v) => { l.dashOffset = v || undefined; });
  // Offset shifts where a dash pattern STARTS, so with a solid stroke it can do
  // nothing at all. Disable it until there's a pattern, rather than let it read as
  // broken (#171) — and revive it on the first character typed into Dash.
  const syncDoff = (pattern: string) => {
    const on = pattern.trim().length > 0;
    doff.disabled = !on;
    doff.title = on
      ? 'Dash offset — shifts where the dash pattern starts'
      : 'Dash offset — set a dash pattern first (nothing to offset on a solid stroke)';
  };
  syncDoff(dash.value);
  dash.addEventListener('input', () => syncDoff(dash.value));
  dashRow.append(dash, doff);
  box.appendChild(dashRow);

  // Cap (line ends) and Corners (join) are PATH-LEVEL properties — they read the
  // same on every stroke — so they live once at the top of the Stroke panel
  // (ui/markers.ts), not duplicated per stroke here. The miter LIMIT stays at its
  // SVG default (auto-flattens only extreme corners); no confusing limit field.

  box.appendChild(blendRow(state, L, 'stroke', pos));

  const fxRow = detailRow('Fixed');
  const fx = document.createElement('input'); fx.type = 'checkbox'; fx.checked = !!L.nonScaling; fx.style.flex = '0 0 auto';
  fx.addEventListener('change', () => mutate(state, 'stroke', pos, (l, i) => { l[i].nonScaling = fx.checked || undefined; }, true));
  fxRow.appendChild(fx);
  box.appendChild(fxRow);


  appendTextStrokeHint(state, box, layers);
  return box;
}

// ---- shared detail controls ----

function opacityRow(state: AppState, L: AppearanceLayer, kind: Kind, pos: number): HTMLElement {
  // Scrubby number field (number-scrub.ts makes it and its label drag handles) —
  // far more compact than the old range slider, and type-in comes free.
  const row = detailRow('Opacity');
  const op = document.createElement('input');
  op.type = 'number'; op.min = '0'; op.max = '100'; op.step = '1';
  op.value = String(Math.round(L.opacity * 100));
  const pct = (): number => Math.min(1, Math.max(0, (parseFloat(op.value) || 0) / 100));
  op.addEventListener('input', () => liveMutate(state, kind, pos, (l, i) => { l[i].opacity = pct(); }));
  op.addEventListener('change', () => commitLive(state, kind, pos, (l, i) => { l[i].opacity = pct(); }));
  const unit = el('span', 'ap-unit'); unit.textContent = '%';
  row.append(op, unit);
  return row;
}

function blendRow(state: AppState, L: AppearanceLayer, kind: Kind, pos: number): HTMLElement {
  const row = detailRow('Blend');
  const blend = document.createElement('select');
  blend.className = 'ap-blend';
  for (const m of ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']) {
    const o = document.createElement('option'); o.value = m; o.textContent = m[0].toUpperCase() + m.slice(1); blend.appendChild(o);
  }
  blend.value = L.blend ?? 'normal';
  blend.addEventListener('change', () => mutate(state, kind, pos, (l, i) => { l[i].blend = blend.value === 'normal' ? undefined : blend.value; }, true));
  row.appendChild(blend);
  return row;
}

function detailRow(label: string): HTMLElement {
  const r = el('div', 'stroke-detail-row');
  const l = el('label'); l.textContent = label; r.appendChild(l);
  return r;
}

/** Shape types whose outline encloses an area — the only ones inside/outside
 *  alignment means anything for (open shapes fall back to center in the engine). */
const ALIGNABLE_TYPES = new Set(['rect', 'ellipse', 'polygon', 'path']);

/** Turn a row-scoped edit into a per-stack editFn: resolves the row's (kind, pos)
 *  against EACH stack it runs on and skips stacks without that layer. */
function editAt(kind: Kind, pos: number, fn: (layers: AppearanceLayer[], idx: number) => void): (layers: AppearanceLayer[]) => void {
  return (layers) => {
    const idx = resolveIdx(layers, kind, pos);
    if (idx >= 0) fn(layers, idx);
  };
}

/** Discrete edit on the row at (kind, pos): mutate + commit (one undo step) + re-render. */
function mutate(state: AppState, kind: Kind, pos: number, fn: (layers: AppearanceLayer[], idx: number) => void, record: boolean): void {
  const editFn = editAt(kind, pos, fn);
  const layers = stackOf(state);
  editFn(layers);
  commit(state, layers, record, editFn);
}

/** Live edit (drag-scrub): apply without an undo step and freeze re-render so the
 *  input being scrubbed isn't destroyed mid-drag. */
function liveMutate(state: AppState, kind: Kind, pos: number, fn: (layers: AppearanceLayer[], idx: number) => void): void {
  suspend = true;
  const editFn = editAt(kind, pos, fn);
  const layers = stackOf(state);
  editFn(layers);
  commit(state, layers, false, editFn);
}
/** Commit a live edit (on release): record one undo step and thaw re-render. */
function commitLive(state: AppState, kind: Kind, pos: number, fn: (layers: AppearanceLayer[], idx: number) => void): void {
  const editFn = editAt(kind, pos, fn);
  const layers = stackOf(state);
  editFn(layers);
  commit(state, layers, true, editFn);
  suspend = false;
  updateAppearancePanel(state);
}

/** Bind a number input: live on `input`, commit on `change`. */
function bindNum(state: AppState, kind: Kind, pos: number, input: HTMLInputElement, apply: (l: AppearanceLayer, v: number) => void): void {
  input.addEventListener('input', () => liveMutate(state, kind, pos, (l, idx) => apply(l[idx], parseFloat(input.value) || 0)));
  input.addEventListener('change', () => commitLive(state, kind, pos, (l, idx) => apply(l[idx], parseFloat(input.value) || 0)));
}

/** Drag the grip to reorder this layer among its own type (fills among fills,
 *  strokes among strokes). The picked-up row lifts and tracks the cursor 1:1 while
 *  the OTHER rows of the section slide apart to open a gap exactly its size at the
 *  landing slot — the gap is the only affordance. On release the row eases into the
 *  gap; only then is the model reordered and the section rebuilt, at the exact same
 *  pixel coordinates (no teleport). A sub-threshold click does nothing. */
function wireReorder(state: AppState, row: HTMLElement, grip: HTMLElement, kind: Kind, pos: number, count: number): void {
  if (count < 2) return; // nothing to reorder — leave the grip inert

  grip.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const list = row.parentElement as HTMLElement | null;
    if (!list) return;

    const from = pos;
    const startY = e.clientY;
    const pid = e.pointerId;

    // Static snapshot (PRE-transform): centers drive the target, heights size the socket.
    const rows = Array.from(list.querySelectorAll<HTMLElement>(':scope > .ap-row'));
    const snap = rows.map((r) => { const b = r.getBoundingClientRect(); return { top: b.top, h: b.height }; });
    const gap = parseFloat(getComputedStyle(list).rowGap || getComputedStyle(list).gap || '') || 4;
    const D = snap[from].h + gap; // dragged row's footprint === the socket the siblings open

    let lifted = false;
    let target = from;
    let lastTarget = from;
    let done = false;

    // target = the slot whose (static, pre-transform) center is NEAREST the dragged row's
    // center. Compares the dragged CENTER, not the raw cursor/grip top (fixes the undershoot),
    // and the argmin flips at the MIDPOINT between two slots — a symmetric half-row threshold
    // (responsive both ways) that also stays correct when a row is expanded/taller (its center
    // is simply farther, so you drag its real distance). Uniform-height shortcut: nearest center
    // === clamp(from + round(dy / step), 0, count-1).
    const computeTarget = (dy: number): number => {
      const center = snap[from].top + snap[from].h / 2 + dy;
      let best = from, bestDist = Infinity;
      for (let i = 0; i < snap.length; i++) {
        const d = Math.abs(snap[i].top + snap[i].h / 2 - center);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      return best;
    };

    // Slide siblings by the constant footprint D to open one socket at `t` and close the hole.
    const applyGap = (t: number): void => {
      for (let i = 0; i < rows.length; i++) {
        if (i === from) continue;
        let ty = 0;
        if (from < t && i > from && i <= t) ty = -D;       // dragging DOWN: rows in (from,t] slide up
        else if (t < from && i >= t && i < from) ty = D;   // dragging UP:   rows in [t,from) slide down
        rows[i].style.transform = ty ? `translateY(${ty}px)` : '';
      }
    };

    // Where the dragged row lands: sum of the footprints it leapfrogs (== (target-from)*step
    // when uniform; correct even when the dragged row or a sibling is expanded).
    const settleOffset = (): number => {
      if (target === from) return 0;
      let dy = 0;
      if (target > from) for (let i = from + 1; i <= target; i++) dy += snap[i].h + gap;
      else for (let i = target; i < from; i++) dy -= snap[i].h + gap;
      return dy;
    };

    const pickup = (): void => {
      lifted = true;
      suspend = true; // freeze background re-render so a stray onStateChange can't wipe the drag
      document.body.classList.add('ap-reordering');
      row.classList.add('ap-dragging');
    };

    const onMove = (ev: PointerEvent): void => {
      const dy = ev.clientY - startY;
      if (!lifted) {
        if (Math.abs(dy) < 3) return; // 3px threshold — below it, the grip click is inert
        pickup();
      }
      row.style.transform = `translateY(${dy}px) scale(1.02)`;
      target = computeTarget(dy);
      if (target !== lastTarget) { applyGap(target); lastTarget = target; }
    };

    const finish = (): void => {
      if (done) return; done = true;
      document.body.classList.remove('ap-reordering');
      row.classList.remove('ap-dragging', 'ap-settling');
      suspend = false;
      // Pre-commit visual (siblings shifted, row parked in the gap) == post-commit flow layout,
      // so replaceChildren rebuilds fresh untransformed rows at the same pixels — no teleport.
      if (target !== from) reorderWithinType(state, kind, from, target);
      else updateAppearancePanel(state); // no-op move: just rebuild clean (no undo step)
    };

    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      try { grip.releasePointerCapture(pid); } catch { /* not captured */ }
      if (!lifted) return; // sub-threshold click: nothing lifted, nothing to commit

      row.classList.add('ap-settling');
      row.style.transform = `translateY(${settleOffset()}px) scale(1)`;
      let fired = false;
      const onEnd = (te: TransitionEvent): void => {
        if (te.propertyName !== 'transform') return;
        fired = true;
        row.removeEventListener('transitionend', onEnd);
        finish();
      };
      row.addEventListener('transitionend', onEnd);
      setTimeout(() => { if (!fired) { row.removeEventListener('transitionend', onEnd); finish(); } }, 260);
    };

    const onCancel = (): void => { target = from; onUp(); }; // OS/system gesture → abort to origin, no commit

    try { grip.setPointerCapture(pid); } catch { /* older UA */ }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  });
}

/** Move a layer within its own type's sub-order, recomputing the absolute insert
 *  index against the full (interleaved) stack so fills and strokes never cross. */
function reorderWithinType(state: AppState, kind: Kind, from: number, to: number): void {
  // Per-stack move, re-resolved against each shape's own layer list; stacks
  // without a layer at `from` are left untouched.
  const moveIn = (layers: AppearanceLayer[]) => {
    const idxs = indicesOfType(layers, kind);
    if (from >= idxs.length) return;
    const moved = layers.splice(idxs[from], 1)[0];
    const idxs2 = indicesOfType(layers, kind);
    const insertAt = to >= idxs2.length ? (idxs2.length ? idxs2[idxs2.length - 1] + 1 : 0) : idxs2[to];
    layers.splice(insertAt, 0, moved);
  };
  const layers = stackOf(state);
  moveIn(layers);
  remapExpandedAfterReorder(kind, from, to);
  commit(state, layers, true, moveIn);
}

/** Keep the SAME physical row expanded across a reorder — never force-expand.
 *  Remaps the open row's `pos` through the same move: the moved row follows to `to`, a
 *  row it passed shifts ±1, everything else is untouched; a closed stack stays closed. */
function remapExpandedAfterReorder(kind: Kind, from: number, to: number): void {
  if (!expanded || expanded.kind !== kind || from === to) return; // other kind / nothing open → leave
  const p = expanded.pos;
  let np = p;
  if (p === from) np = to;                                  // the moved row keeps its own expansion
  else if (from < to && p > from && p <= to) np = p - 1;    // moved down past p → p shifts up
  else if (to < from && to <= p && p < from) np = p + 1;    // moved up past p → p shifts down
  expanded = { kind, pos: np };
}

/** Mirrors the Properties panel's mixed swatch (ui/properties.ts) — the shared
 *  "these differ" texture. */
const MIXED_SWATCH = 'linear-gradient(135deg, #9aa0ab 0 48%, #4b5160 52% 100%)';

/**
 * The colour a container gets from its CONTENTS, shown as a real, editable row and
 * labelled with where it comes from. Dashed, so it reads as "this lives one level
 * down" rather than as a fill on the group itself — but it is still directly
 * actionable: picking a colour recolours every shape inside (AppState.setSelectionFill
 * clears the leaves' own paint so the new colour actually takes).
 */
function buildContentsRow(state: AppState, paint: string, mixed: boolean, count: number): HTMLElement {
  const row = el('div', 'ap-row ap-contents');
  const head = el('div', 'ap-head');

  const color = el('button', 'ap-color') as HTMLButtonElement;
  const inner = el('span', 'ap-color-inner');
  inner.style.background = mixed ? MIXED_SWATCH : paintPreviewBg(paint, state);
  color.appendChild(inner);
  color.title = mixed
    ? 'Several colours inside — pick one to recolour every shape in this group'
    : 'The colour of the shapes inside — pick to recolour them all';
  color.addEventListener('click', (e) => {
    e.stopPropagation();
    openLayerColorPicker(state, color, mixed ? '' : paint, (value) => {
      state.setSelectionFill(value === null ? 'none' : value);
    }, 'fill');
  });
  head.appendChild(color);

  const label = el('span', 'ap-contents-label');
  label.textContent = mixed
    ? `Mixed · ${count} shapes inside`
    : `From ${count} shape${count > 1 ? 's' : ''} inside`;
  head.appendChild(label);

  row.appendChild(head);
  return row;
}
