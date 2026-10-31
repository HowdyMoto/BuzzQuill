import type { AppState } from '../core/state';
import type { GradientDef, PatternDef } from '../core/types';
import {
  buildGradientEditor, buildPatternEditor, updatePatternPreview,
  type PaintEditorHost,
} from './paint-editors';
import { sliderField } from './slider-field';

const SWATCHES = [
  'none',
  '#FFFFFF', '#000000', '#333333', '#666666', '#999999', '#CCCCCC',
  '#FF0000', '#FF6600', '#FFCC00', '#FFFF00', '#99FF00', '#00FF00',
  '#00FF99', '#00FFFF', '#0099FF', '#0000FF', '#6600FF', '#FF00FF',
  '#CC0000', '#CC6600', '#CC9900', '#999900', '#669900', '#009900',
  '#009966', '#009999', '#006699', '#000099', '#660099', '#990066',
  '#990000', '#993300', '#996600', '#666600', '#336600', '#006600',
  '#006633', '#006666', '#003366', '#000066', '#330066', '#660033',
  '#FFB3B3', '#FFD9B3', '#FFF0B3', '#FFFFB3', '#D9FFB3', '#B3FFB3',
  '#B3FFD9', '#B3FFFF', '#B3D9FF', '#B3B3FF', '#D9B3FF', '#FFB3FF',
];

type PaintMode = 'solid' | 'gradient' | 'image' | 'pattern';

let currentOverlay: HTMLElement | null = null;
let currentTarget: 'fill' | 'stroke' = 'fill';
// When set (e.g. editing one stroke of a multi-stroke stack), the picker routes
// the chosen paint here instead of the element's single fill/stroke attribute.
let layerApply: ((value: string | null) => void) | null = null;
// Optional "record one undo step" hook, fired once when the picker closes IF the
// colour actually changed. Lets solid controls apply live (no history) during a
// drag and commit a single history entry at the end (see openSolidColorPicker).
let onCommit: (() => void) | null = null;
let pickerDirty = false;

export function setupColorPicker(state: AppState): void {
  document.getElementById('prop-fill-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openPicker(state, 'fill', document.getElementById('prop-fill-btn')!);
  });
}

/** Open the picker bound to an arbitrary paint (e.g. one stroke of a stack):
 *  `apply(value)` gets the chosen color, or null for "none". */
export function openLayerColorPicker(
  state: AppState, anchor: HTMLElement, current: string, apply: (value: string | null) => void,
  kind: 'fill' | 'stroke' = 'stroke',
): void {
  openPicker(state, kind, anchor, { current, apply });
}

/** Open a SOLID-ONLY picker for a plain colour control (canvas background, frame
 *  grid, drop shadow, …): the same styled popover, minus the gradient/image/
 *  pattern tabs that only make sense for a shape's paint. `apply` gets the chosen
 *  hex (or null for "none"). Use this for every standalone colour control instead
 *  of a native <input type="color">, so pickers stay consistent app-wide. */
export function openSolidColorPicker(
  state: AppState, anchor: HTMLElement, current: string,
  apply: (value: string | null) => void, label?: string, commit?: () => void,
): void {
  openPicker(state, 'fill', anchor, { current, apply, solidOnly: true, label, commit });
}

function openPicker(
  state: AppState, target: 'fill' | 'stroke', anchor: HTMLElement,
  override?: {
    current: string; apply: (value: string | null) => void;
    solidOnly?: boolean; label?: string; commit?: () => void;
  },
): void {
  closePicker();
  currentTarget = target;
  // Wrap the caller's apply so any change flags the session dirty (drives the
  // commit-on-close hook); live applies themselves stay history-free.
  const rawApply = override?.apply ?? null;
  layerApply = rawApply ? (v) => { pickerDirty = true; rawApply(v); } : null;
  onCommit = override?.commit ?? null;
  pickerDirty = false;

  const currentValue = override ? override.current : getCurrentColor(state, target);
  const solidOnly = override?.solidOnly ?? false;
  const initialMode: PaintMode = solidOnly ? 'solid' : detectMode(currentValue, state);

  const overlay = document.createElement('div');
  overlay.className = 'cpicker-overlay';
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closePicker(); });

  const panel = document.createElement('div');
  panel.className = 'cpicker-panel';
  const rect = anchor.getBoundingClientRect();
  panel.style.top = `${rect.bottom + 4}px`;
  panel.style.left = `${Math.max(8, rect.left - 100)}px`;

  // Header
  const header = document.createElement('div');
  header.className = 'cpicker-header';
  header.textContent = override?.label ?? (target === 'fill' ? 'Fill' : 'Stroke');
  panel.appendChild(header);

  // Mode tabs
  const tabs = document.createElement('div');
  tabs.className = 'cpicker-tabs';
  const modes: { id: PaintMode; label: string }[] = [
    { id: 'solid', label: 'Solid' },
    { id: 'gradient', label: 'Gradient' },
    { id: 'image', label: 'Image' },
    { id: 'pattern', label: 'Pattern' },
  ];
  const tabBtns: Map<PaintMode, HTMLButtonElement> = new Map();
  for (const m of modes) {
    const btn = document.createElement('button');
    btn.className = 'cpicker-tab';
    btn.textContent = m.label;
    btn.setAttribute('data-mode', m.id);
    if (m.id === initialMode) btn.classList.add('active');
    tabBtns.set(m.id, btn);
    tabs.appendChild(btn);
  }
  if (!solidOnly) panel.appendChild(tabs); // solid-only controls skip the paint-type tabs

  // Content area — swapped based on active tab
  const content = document.createElement('div');
  content.className = 'cpicker-content';
  panel.appendChild(content);

  // `applyOnSwitch` is true only when the user CLICKS a tab (not the initial open):
  // switching a tab commits that paint type to the shape. The gradient/pattern
  // renderers already apply on render; solid must too, or clicking Solid would show
  // the solid editor while the shape kept its gradient (the reported bug).
  const renderMode = (mode: PaintMode, applyOnSwitch = false) => {
    tabBtns.forEach((btn, id) => btn.classList.toggle('active', id === mode));
    content.innerHTML = '';
    switch (mode) {
      case 'solid': renderSolid(state, content, currentValue, applyOnSwitch); break;
      case 'gradient': renderGradient(state, content, currentValue); break;
      case 'image': renderImage(state, content, currentValue); break;
      case 'pattern': renderPattern(state, content, currentValue); break;
    }
  };

  if (!solidOnly) {
    for (const m of modes) {
      tabBtns.get(m.id)!.addEventListener('click', () => renderMode(m.id, true));
    }
  }

  renderMode(initialMode);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  currentOverlay = overlay;

  // Now that it's measured, nudge the panel fully on-screen (the gradient/pattern
  // tabs can be tall; the anchor may sit low or near the right edge).
  const pr = panel.getBoundingClientRect();
  const M = 8;
  if (pr.bottom > window.innerHeight - M) {
    panel.style.top = `${Math.max(M, window.innerHeight - M - pr.height)}px`;
  }
  if (pr.right > window.innerWidth - M) {
    panel.style.left = `${Math.max(M, window.innerWidth - M - pr.width)}px`;
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closePicker();
  };
  window.addEventListener('keydown', onKey);
  // Store cleanup ref so closePicker removes it
  (overlay as any)._escCleanup = onKey;
}

function closePicker(): void {
  // Record one undo step for the whole editing session (only if something changed).
  if (onCommit && pickerDirty) onCommit();
  onCommit = null; pickerDirty = false;
  layerApply = null;
  if (currentOverlay) {
    const cleanup = (currentOverlay as any)._escCleanup;
    if (cleanup) window.removeEventListener('keydown', cleanup);
    currentOverlay.remove();
    currentOverlay = null;
  }
}

// ---- Detect current paint mode ----

function detectMode(value: string, state: AppState): PaintMode {
  if (value.startsWith('url(#grad-')) return 'gradient';
  if (value.startsWith('url(#pat-')) {
    // Image and preset are BOTH url(#pat-…) under the hood, but they're peer tabs to
    // the user — route to whichever the pattern actually is.
    const id = value.match(/url\(#(pat-\d+)\)/)?.[1];
    return state.getPatternById(id ?? '')?.type === 'image' ? 'image' : 'pattern';
  }
  return 'solid';
}

// ===================== SOLID MODE =====================

/** The solid colour to show/apply for a given paint: a gradient flattens to its
 *  first stop, a pattern falls back to white, a solid (or 'none') stays as-is. */
function solidColorFor(state: AppState, value: string): string {
  const gradId = value.match(/url\(#(grad-\d+)\)/)?.[1];
  if (gradId) return state.getGradientById(gradId)?.stops?.[0]?.color ?? '#FFFFFF';
  if (value.startsWith('url(')) return '#FFFFFF';
  return value;
}

interface SolidEditorOverride {
  onChange: (value: string | null) => void;
  includeSwatches?: boolean;
  includeNone?: boolean;
}

/** The reusable solid-colour editor (SV square + hue slider + hex/RGB/HSL fields
 *  + preset swatches). By default it writes to the shape's fill/stroke; pass
 *  `override.onChange` to bind it to ANY colour — a gradient stop, a pattern tint —
 *  so every colour surface uses this same editor instead of a native colour input. */
function renderSolid(
  state: AppState, container: HTMLElement, currentValue: string,
  applyOnSwitch = false, override?: SolidEditorOverride,
): void {
  const startColor = solidColorFor(state, currentValue);
  const apply = (v: string | null) =>
    override ? override.onChange(v) : (v === null ? applyNone(state) : applyPaint(state, v));
  const includeSwatches = override?.includeSwatches ?? true;
  const includeNone = override ? (override.includeNone ?? false) : true;

  // Committing the switch to Solid: replace the shape's gradient/pattern with this
  // solid colour immediately (matches how the gradient tabs apply on switch). Only
  // for the shape-paint case — a bound editor applies through onChange instead.
  if (applyOnSwitch && !override) {
    if (startColor === 'none') applyNone(state); else applyPaint(state, startColor);
  }

  // HSV is the picker's source of truth (the square + hue slider are HSV-native);
  // RGB/HSL/Hex are derived views that convert back into it.
  const rgb0 = hexToRgb(colorToHex(startColor === 'none' ? '#FFFFFF' : startColor));
  const hsv = rgbToHsv(rgb0.r, rgb0.g, rgb0.b);

  // --- Saturation × Value square ---
  const square = document.createElement('div');
  square.className = 'cpicker-sv';
  const svKnob = document.createElement('div');
  svKnob.className = 'cpicker-sv-knob';
  square.appendChild(svKnob);
  container.appendChild(square);

  // --- Hue slider ---
  const hueBar = document.createElement('div');
  hueBar.className = 'cpicker-hue';
  const hueKnob = document.createElement('div');
  hueKnob.className = 'cpicker-hue-knob';
  hueBar.appendChild(hueKnob);
  container.appendChild(hueBar);

  // --- Preview + hex ---
  const previewRow = document.createElement('div');
  previewRow.className = 'cpicker-preview-row';
  const preview = document.createElement('div');
  preview.className = 'cpicker-preview';
  const hexWrap = document.createElement('div');
  hexWrap.className = 'cpicker-hex-wrap';
  const hashLabel = document.createElement('span');
  hashLabel.textContent = '#'; hashLabel.className = 'cpicker-hash';
  const hexInput = document.createElement('input');
  hexInput.type = 'text'; hexInput.maxLength = 7; hexInput.className = 'cpicker-hex';
  hexWrap.append(hashLabel, hexInput);
  previewRow.append(preview, hexWrap);
  container.appendChild(previewRow);

  // --- Colour-model selector (RGB / HSV / HSL) + three numeric channels ---
  const modelRow = document.createElement('div');
  modelRow.className = 'cpicker-model-row';
  const modelSel = document.createElement('select');
  modelSel.className = 'cpicker-model-sel';
  for (const m of ['RGB', 'HSV', 'HSL']) {
    const o = document.createElement('option'); o.value = m; o.textContent = m; modelSel.appendChild(o);
  }
  modelRow.appendChild(modelSel);
  const chans: { label: HTMLElement; input: HTMLInputElement }[] = [];
  for (let i = 0; i < 3; i++) {
    const wrap = document.createElement('div'); wrap.className = 'cpicker-chan';
    const label = document.createElement('label'); label.className = 'cpicker-chan-label';
    const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.className = 'cpicker-chan-input';
    wrap.append(label, input);
    modelRow.appendChild(wrap);
    chans.push({ label, input });
  }
  container.appendChild(modelRow);

  // Repaint every control from the current HSV. Never clobbers the field the user is
  // actively editing. Returns the current hex (with '#').
  const render = (): string => {
    const { r, g, b } = hsvToRgb(hsv.h, hsv.s, hsv.v);
    const hex = ('#' + rgbToHex(r, g, b)).toUpperCase();
    square.style.background =
      `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${Math.round(hsv.h)}, 100%, 50%))`;
    svKnob.style.left = `${hsv.s}%`;
    svKnob.style.top = `${100 - hsv.v}%`;
    svKnob.style.background = hex;
    hueKnob.style.left = `${(hsv.h / 360) * 100}%`;
    preview.style.background = hex; preview.classList.remove('cpicker-none');
    if (document.activeElement !== hexInput) hexInput.value = hex.slice(1);

    const model = modelSel.value;
    let vals: [number, number, number], labels: [string, string, string], maxes: [number, number, number];
    if (model === 'RGB') { vals = [r, g, b]; labels = ['R', 'G', 'B']; maxes = [255, 255, 255]; }
    else if (model === 'HSV') { vals = [Math.round(hsv.h), Math.round(hsv.s), Math.round(hsv.v)]; labels = ['H', 'S', 'V']; maxes = [360, 100, 100]; }
    else { const hsl = rgbToHsl(r, g, b); vals = [Math.round(hsl.h), Math.round(hsl.s), Math.round(hsl.l)]; labels = ['H', 'S', 'L']; maxes = [360, 100, 100]; }
    chans.forEach((c, i) => {
      c.label.textContent = labels[i];
      c.input.max = String(maxes[i]);
      if (document.activeElement !== c.input) c.input.value = String(vals[i]);
    });
    return hex;
  };
  const commit = () => { apply(render()); };

  bindDrag(square, (fx, fy) => { hsv.s = fx * 100; hsv.v = (1 - fy) * 100; commit(); });
  bindDrag(hueBar, (fx) => { hsv.h = fx * 360; commit(); });

  modelSel.addEventListener('change', render);
  for (const c of chans) {
    c.input.addEventListener('input', () => {
      const a = parseFloat(chans[0].input.value) || 0;
      const b = parseFloat(chans[1].input.value) || 0;
      const cc = parseFloat(chans[2].input.value) || 0;
      const model = modelSel.value;
      let h: { h: number; s: number; v: number };
      if (model === 'RGB') h = rgbToHsv(clamp(a), clamp(b), clamp(cc));
      else if (model === 'HSV') h = { h: clampDeg(a), s: clamp100(b), v: clamp100(cc) };
      else { const rgb = hslToRgb(clampDeg(a), clamp100(b), clamp100(cc)); h = rgbToHsv(rgb.r, rgb.g, rgb.b); }
      hsv.h = h.h; hsv.s = h.s; hsv.v = h.v;
      commit();
    });
  }
  hexInput.addEventListener('input', () => {
    const hx = hexInput.value.replace('#', '');
    if (hx.length !== 6) return;
    const { r, g, b } = hexToRgb(hx);
    const h = rgbToHsv(r, g, b);
    hsv.h = h.h; hsv.s = h.s; hsv.v = h.v;
    commit();
  });

  // --- Preset swatches ---
  if (includeSwatches) {
    const divider = document.createElement('div');
    divider.className = 'cpicker-divider';
    container.appendChild(divider);

    const grid = document.createElement('div');
    grid.className = 'cpicker-swatches';
    for (const c of SWATCHES) {
      if (c === 'none' && !includeNone) continue; // a bound colour (stop/tint) can't be "none"
      const cell = document.createElement('div');
      cell.className = 'swatch-cell';
      if (c === 'none') cell.classList.add('none-swatch');
      else cell.style.background = c;
      cell.addEventListener('click', () => {
        if (c === 'none') {
          apply(null);
          preview.style.background = 'transparent'; preview.classList.add('cpicker-none');
        } else {
          const { r, g, b } = hexToRgb(c.replace('#', ''));
          const h = rgbToHsv(r, g, b);
          hsv.h = h.h; hsv.s = h.s; hsv.v = h.v;
          commit();
        }
      });
      grid.appendChild(cell);
    }
    container.appendChild(grid);
  }

  render(); // initial paint, no apply
}

/** Pointer drag over a 2D area: calls `onPos` with clamped 0–1 fractions on down and
 *  every move until release (pointer-captured, so drags can leave the element). */
function bindDrag(el: HTMLElement, onPos: (fx: number, fy: number) => void): void {
  const at = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    const fx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const fy = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    onPos(fx, fy);
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    at(e);
    const move = (ev: PointerEvent) => at(ev);
    const up = (ev: PointerEvent) => {
      try { el.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}

// ===================== GRADIENT MODE =====================

/** The Gradient tab = the shared gradient editor, mounted in the popover. Its
 *  colours use the full inline SV-square editor: the popover has room, and it
 *  cannot open a nested picker (openPicker closes any open one first). */
function renderGradient(state: AppState, container: HTMLElement, currentValue: string): void {
  let grad: GradientDef | undefined;
  const urlMatch = currentValue.match(/url\(#(grad-\d+)\)/);
  if (urlMatch) grad = state.getGradientById(urlMatch[1]);
  if (!grad) {
    const fallbackColor = currentValue.startsWith('url(') ? '#000000' : (currentValue === 'none' ? '#000000' : currentValue);
    grad = state.createGradient('linear', [
      { offset: 0, color: fallbackColor, opacity: 1 },
      { offset: 1, color: '#FFFFFF', opacity: 1 },
    ]);
    applyPaint(state, `url(#${grad.id})`);
  }
  container.appendChild(buildGradientEditor(state, grad, popoverHost(state)));
}

/** Host seam for the popover: colours edit inline, paint swaps go through applyPaint. */
function popoverHost(state: AppState): PaintEditorHost {
  return {
    mountColor: (box, current, onChange) => {
      renderSolid(state, box, current, false, {
        onChange: (v) => { if (v !== null) onChange(v); },
        includeNone: false,
      });
    },
    onPaintChange: (value) => applyPaint(state, value),
  };
}

// ===================== IMAGE MODE =====================

/** File-pick a raster \u2192 its data URL + natural pixel size. */
function pickPatternImage(cb: (url: string, w: number, h: number) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => cb(reader.result as string, img.naturalWidth, img.naturalHeight);
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
  input.click();
}

/** Scale / Rotation / Spacing sliders for the IMAGE tab. */
function appendPatternSliders(state: AppState, controls: HTMLElement, previewBox: HTMLElement, pat: PatternDef): void {
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="cpicker-dir-row"><label>Scale</label>
      <input type="range" class="cpicker-slider" min="10" max="400" value="${Math.round((pat.scale ?? 1) * 100)}" id="_pat-scale"></div>
    <div class="cpicker-dir-row"><label>Rotation</label>
      <input type="range" class="cpicker-slider" min="0" max="360" value="${pat.rotation ?? 0}" id="_pat-rotation"></div>
    <div class="cpicker-dir-row"><label>Spacing</label>
      <input type="range" class="cpicker-slider" min="0" max="50" value="${pat.spacing ?? 0}" id="_pat-spacing"></div>`;
  controls.appendChild(div);
  const scale = div.querySelector('#_pat-scale') as HTMLInputElement;
  const rot = div.querySelector('#_pat-rotation') as HTMLInputElement;
  const spc = div.querySelector('#_pat-spacing') as HTMLInputElement;
  scale.after(sliderField(scale, { unit: '%' }));
  rot.after(sliderField(rot, { unit: '\u00B0' }));
  spc.after(sliderField(spc, { unit: 'px' }));
  const upd = () => {
    pat.scale = parseInt(scale.value) / 100;
    pat.rotation = parseInt(rot.value);
    pat.spacing = parseInt(spc.value);
    state.updatePattern(pat);
    updatePatternPreview(previewBox, pat);
  };
  scale.addEventListener('input', upd);
  rot.addEventListener('input', upd);
  spc.addEventListener('input', upd);
}

function renderImage(state: AppState, container: HTMLElement, currentValue: string): void {
  const id = currentValue.match(/url\(#(pat-\d+)\)/)?.[1];
  let pat = id ? state.getPatternById(id) : undefined;
  if (pat && pat.type !== 'image') pat = undefined;

  const previewBox = document.createElement('div');
  previewBox.className = 'cpicker-pat-preview cpicker-pat-preview--image';
  container.appendChild(previewBox);
  const controls = document.createElement('div');
  container.appendChild(controls);

  const build = () => {
    controls.innerHTML = '';
    const uploadBtn = document.createElement('button');
    uploadBtn.className = 'cpicker-upload-btn';
    uploadBtn.textContent = pat?.imageDataUrl ? 'Change Image\u2026' : 'Upload Image\u2026';
    uploadBtn.addEventListener('click', () => pickPatternImage((url, w, h) => {
      if (pat) { pat.imageDataUrl = url; pat.tileWidth = w; pat.tileHeight = h; state.updatePattern(pat); }
      else {
        pat = state.createPattern({ type: 'image', imageDataUrl: url, tileWidth: w, tileHeight: h, scale: Math.min(1, 100 / Math.max(w, h)) || 1 });
        applyPaint(state, `url(#${pat.id})`);
      }
      updatePatternPreview(previewBox, pat);
      build();
    }));
    controls.appendChild(uploadBtn);
    if (pat) appendPatternSliders(state, controls, previewBox, pat);
  };
  if (pat) updatePatternPreview(previewBox, pat);
  build();
}

// ===================== PATTERN MODE (presets) =====================

/** The Pattern tab = the shared preset-pattern editor, mounted in the popover.
 *  The same editor is mounted inline in the Fills panel row. */
function renderPattern(state: AppState, container: HTMLElement, currentValue: string): void {
  const idm = currentValue.match(/url\(#(pat-\d+)\)/)?.[1];
  let pat = idm ? state.getPatternById(idm) : undefined;
  if (pat && pat.type !== 'preset') pat = undefined; // image is its own tab
  if (!pat) {
    pat = state.createPattern({
      type: 'preset', preset: 'dots', tileWidth: 20, tileHeight: 20, weight: 2,
    });
    applyPaint(state, `url(#${pat.id})`);
  }
  container.appendChild(buildPatternEditor(state, pat, popoverHost(state)));
}


// ===================== APPLY HELPERS =====================

function applyPaint(state: AppState, value: string): void {
  if (layerApply) { layerApply(value); return; }
  // Selection-wide appliers cover EVERY selected object (incl. appearance-wrapped
  // multi-paint shapes) in one undo step. With nothing selected the picker is a no-op:
  // new shapes use the FIXED defaults, so painting here never "learns" a new default.
  if (state.selectedShapeIds.length === 0) return;
  if (currentTarget === 'fill') state.setSelectionFill(value);
  else state.setSelectionStroke(value);
}

function applyNone(state: AppState): void {
  if (layerApply) { layerApply(null); return; }
  if (state.selectedShapeIds.length === 0) return;
  if (currentTarget === 'fill') state.setSelectionFill('none');
  else state.setSelectionStroke('none');
}

function getCurrentColor(state: AppState, target: 'fill' | 'stroke'): string {
  const shape = state.getSelectedShape();
  if (target === 'fill') return shape ? shape.style.fill : (state.fillNone ? 'none' : state.defaultStyle.fill);
  return shape ? shape.style.stroke : (state.strokeNone ? 'none' : state.defaultStyle.stroke);
}

// ===================== COLOR UTILS =====================

function colorToHex(color: string): string {
  if (!color || color === 'none' || color.startsWith('url(')) return 'FFFFFF';
  return color.replace('#', '').toUpperCase();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  hex = hex.replace('#', '');
  if (hex.length !== 6) return { r: 255, g: 255, b: 255 };
  return {
    r: parseInt(hex.substring(0, 2), 16) || 0,
    g: parseInt(hex.substring(2, 4), 16) || 0,
    b: parseInt(hex.substring(4, 6), 16) || 0,
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  return [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function clamp(v: number): number { return Math.max(0, Math.min(255, Math.round(v))); }
function clamp100(v: number): number { return Math.max(0, Math.min(100, v)); }
function clampDeg(v: number): number { return Math.max(0, Math.min(360, v)); }

// ---- HSV / HSL conversions (h: 0–360, s/v/l: 0–100, r/g/b: 0–255) ----

function hueFrom(r: number, g: number, b: number, max: number, d: number): number {
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  return { h: hueFrom(r, g, b, max, d), s: (max === 0 ? 0 : d / max) * 100, v: max * 100 };
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  s /= 100; v /= 100;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  return primeToRgb(h, c, x, m);
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: hueFrom(r, g, b, max, d), s: s * 100, l: l * 100 };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  return primeToRgb(h, c, x, m);
}

/** Shared piecewise RGB assembly for HSV/HSL → RGB (given chroma c, second x, offset m). */
function primeToRgb(h: number, c: number, x: number, m: number): { r: number; g: number; b: number } {
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
