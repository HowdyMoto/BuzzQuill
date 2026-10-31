// ---------------------------------------------------------------------------
// Paint parameter editors — the gradient and preset-pattern controls, built once
// and mounted by BOTH hosts that need them:
//
//   • the colour picker popover (ui/color-picker.ts), as its Gradient/Pattern tabs
//   • the Fills/Strokes rows in the appearance panel (ui/appearance-panel.ts),
//     inline in the expanded row so a pattern or gradient is adjustable without
//     opening the popover at all
//
// One implementation, two mount points — deliberately. The pattern PREVIEW used to
// be a CSS lookalike maintained separately from the real `<pattern>` renderer, and
// it silently drifted from it at almost every setting; duplicating these editors
// per host would reproduce exactly that failure one level up.
//
// Hosts differ in one respect, which is what {@link PaintEditorHost} exists for:
// how a colour (a pattern's tint, a gradient stop) gets edited. The popover has
// room for the full SV-square editor and CANNOT nest another popover — `openPicker`
// closes any open picker first, so a chip inside the picker would dismiss its own
// parent. A panel row is the opposite: no room to inline the big editor, but free
// to open the popover. Each host supplies its own `mountColor`.
// ---------------------------------------------------------------------------

import type { AppState } from '../core/state';
import type { GradientDef, GradientStop, PatternDef } from '../core/types';
import { presetWeight } from '../core/paint-registry';
import { sliderField } from './slider-field';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface PaintEditorHost {
  /** Mount a colour editor for `current` into `container`, calling `onChange` with
   *  each new hex. See the note above on why this is host-supplied. */
  mountColor(container: HTMLElement, current: string, onChange: (hex: string) => void): void;
  /** The editor swapped in a NEW def and the paint must be re-pointed at it —
   *  linear↔radial creates a fresh gradient rather than mutating in place. */
  onPaintChange(value: string): void;
}

function elem(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// ===================== PRESET PATTERNS =====================

/** The four preset generators, in menu order. */
const PRESETS: { id: NonNullable<PatternDef['preset']>; label: string }[] = [
  { id: 'dots', label: 'Dots' },
  { id: 'stripes', label: 'Stripes' },
  { id: 'crosshatch', label: 'Crosshatch' },
  { id: 'grid', label: 'Grid' },
];

/** Collapse a preset pattern onto the `tileWidth` + `weight` axes the sliders drive,
 *  folding whatever `scale`/`spacing` it arrived with into them. Renders identically
 *  before and after (`presetWeight` guarantees it) — it just means a pattern loaded
 *  from an older document shows honest slider positions instead of snapping the
 *  first time one is touched. */
export function normalizePresetPattern(state: AppState, pat: PatternDef): void {
  if (pat.scale === 1 && pat.spacing === 0 && pat.weight !== undefined) return;
  pat.weight = presetWeight(pat);
  pat.tileWidth = pat.tileHeight = Math.max(2, Math.round(pat.tileWidth * pat.scale + pat.spacing));
  pat.scale = 1;
  pat.spacing = 0;
  state.updatePattern(pat);
}

/**
 * Type + Spacing + Weight + Rotation + tint for a PRESET pattern.
 *
 * Spacing is the tile period in px and Weight is the mark thickness in px — two
 * independent numbers. They used to be one (`scale` multiplied both), which locked
 * every stripe to sitting ten times further from its neighbour than it was thick.
 */
export function buildPatternEditor(state: AppState, pat: PatternDef, host: PaintEditorHost): HTMLElement {
  // Browsing/applying patterns lives in the Library; this is just the way there.
  const picker = buildPatternLibraryLink(pat.id);
  // Artwork-backed tiles (your own objects, or an image) get their own controls —
  // the preset dropdown/tint/weight below only describe the generated presets.
  if (pat.type === 'object' || pat.type === 'image') {
    const wrap = elem('div', 'paint-editor');
    wrap.append(picker, buildTiledPatternEditor(state, pat));
    return wrap;
  }
  const box = elem('div', 'paint-editor');
  box.appendChild(picker);
  normalizePresetPattern(state, pat);

  const typeRow = elem('div', 'cpicker-dir-row');
  const typeLabel = elem('label');
  typeLabel.textContent = 'Type';
  const typeSel = document.createElement('select');
  typeSel.className = 'cpicker-select';
  for (const p of PRESETS) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.label;
    o.selected = pat.preset === p.id;
    typeSel.appendChild(o);
  }
  typeRow.append(typeLabel, typeSel);
  box.appendChild(typeRow);

  const preview = elem('div', 'cpicker-pat-preview');
  box.appendChild(preview);

  const sliders = elem('div');
  box.appendChild(sliders);

  // "Tint", not "Color": in a fill row this sits directly under the row's own Color
  // swatch (which picks the fill's PAINT), and two rows labelled Color read as a bug.
  const colorLabel = elem('div', 'cpicker-section-label');
  colorLabel.textContent = 'Tint';
  box.appendChild(colorLabel);
  const colorArea = elem('div');
  box.appendChild(colorArea);

  const slider = (
    label: string, min: number, max: number, step: number, unit: string,
    read: () => number, write: (v: number) => void,
  ) => {
    const row = elem('div', 'cpicker-dir-row');
    const lab = elem('label');
    lab.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'cpicker-slider';
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(read());
    input.addEventListener('input', () => {
      write(parseFloat(input.value));
      state.updatePattern(pat);
      updatePatternPreview(preview, pat);
    });
    row.append(lab, input, sliderField(input, { unit }));
    sliders.appendChild(row);
  };

  const buildSliders = () => {
    sliders.replaceChildren();
    slider('Spacing', 2, 120, 1, 'px', () => pat.tileWidth,
      (v) => { pat.tileWidth = pat.tileHeight = v; });
    slider('Weight', 0.25, 24, 0.05, 'px', () => pat.weight ?? 2, (v) => { pat.weight = v; });
    slider('Rotation', 0, 360, 1, '°', () => pat.rotation ?? 0, (v) => { pat.rotation = v; });
  };

  typeSel.addEventListener('change', () => {
    pat.preset = typeSel.value as PatternDef['preset'];
    state.updatePattern(pat);
    updatePatternPreview(preview, pat);
  });

  buildSliders();
  host.mountColor(colorArea, pat.presetColor ?? '#000000', (hex) => {
    pat.presetColor = hex;
    state.updatePattern(pat);
    updatePatternPreview(preview, pat);
  });
  updatePatternPreview(preview, pat);
  return box;
}

/** Paint the preview box for `pat`.
 *
 *  Presets preview the REAL `<pattern>` def — a `<rect>` filled with `url(#pat-N)`,
 *  the very paint the shape uses — rather than a CSS lookalike. WYSIWYG by
 *  construction: scale/spacing/rotation land exactly as they will on canvas, and
 *  there's no second renderer to keep in sync with `buildPresetPatternContent`.
 *  Rotation in particular lives in the def's `patternTransform`, so it turns the
 *  *contents* inside a fixed viewport — never the preview element itself, which
 *  used to swing a rotated bar diagonally across the whole picker. */
export function updatePatternPreview(el: HTMLElement, pat: PatternDef): void {
  el.style.transform = '';  // legacy: older builds rotated the box itself
  if (pat.type === 'image' && pat.imageDataUrl) {
    // Show the WHOLE image (fit + centred), not the tiled-at-scale version — tiling a
    // small tile only revealed the image's top edge. The preview's job is "here's your
    // source"; the tiling itself is visible on the shape.
    let img = el.querySelector('.cpicker-pat-fit') as HTMLElement | null;
    if (!img) {
      img = elem('div', 'cpicker-pat-fit');
      el.replaceChildren(img);
    }
    img.style.backgroundImage = `url("${pat.imageDataUrl}")`;
    return;
  }
  let rect = el.querySelector('rect');
  if (!rect) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('width', '100%');
    rect.setAttribute('height', '100%');
    svg.appendChild(rect);
    el.replaceChildren(svg);
  }
  // Re-point the fill on every update: re-resolving the reference is what picks up
  // the def `updatePattern` just rebuilt under the same id.
  rect.setAttribute('fill', 'none');
  rect.setAttribute('fill', `url(#${pat.id})`);
}

// ===================== GRADIENTS =====================

/**
 * Linear/radial + preview + draggable stop bar + selected-stop editor + direction
 * and spread, for `grad`. Rebuilds itself in place when the type changes (that
 * creates a NEW gradient def, so the host is told to re-point its paint).
 */
export function buildGradientEditor(state: AppState, grad: GradientDef, host: PaintEditorHost): HTMLElement {
  const box = elem('div', 'paint-editor');
  let selectedStopIdx = 0;

  const build = (g: GradientDef) => {
    box.replaceChildren();

    // Linear / Radial — a variant OF a gradient, not a separate paint type (which is
    // why it lives here rather than as its own tab in the picker).
    const seg = elem('div', 'cpicker-seg');
    for (const t of ['linear', 'radial'] as const) {
      const b = elem('button', 'cpicker-seg-btn' + (t === g.type ? ' active' : ''));
      b.textContent = t === 'linear' ? 'Linear' : 'Radial';
      b.addEventListener('click', () => {
        if (t === g.type) return;
        const ng = state.createGradient(t, g.stops.map(s => ({ ...s })));
        host.onPaintChange(`url(#${ng.id})`);
        build(ng);
      });
      seg.appendChild(b);
    }
    box.appendChild(seg);

    const previewBar = elem('div', 'cpicker-grad-preview');
    updateGradientPreview(previewBar, g);
    box.appendChild(previewBar);

    const stopBar = elem('div', 'cpicker-stop-bar');
    box.appendChild(stopBar);

    const stopEditor = elem('div', 'cpicker-stop-editor');
    box.appendChild(stopEditor);

    // Focal X and Y get a row EACH. Sharing one row put two label+slider pairs on a
    // line that fits neither host's width — the second pair ran off the panel edge.
    const dirRow = elem('div');
    if (g.type === 'linear') {
      dirRow.className = 'cpicker-dir-row';
      dirRow.innerHTML = `
        <label>Angle</label>
        <input type="range" class="cpicker-slider" min="0" max="360" value="${Math.round(gradientAngle(g))}" data-grad-angle>`;
    } else {
      dirRow.innerHTML = `
        <div class="cpicker-dir-row"><label>Focal X</label>
          <input type="range" class="cpicker-slider" min="0" max="100" value="${Math.round((g.fx ?? 0.5) * 100)}" data-grad-fx></div>
        <div class="cpicker-dir-row"><label>Focal Y</label>
          <input type="range" class="cpicker-slider" min="0" max="100" value="${Math.round((g.fy ?? 0.5) * 100)}" data-grad-fy></div>`;
    }
    box.appendChild(dirRow);

    const spreadRow = elem('div', 'cpicker-dir-row');
    spreadRow.innerHTML = `<label>Spread</label>
      <select class="cpicker-select" data-grad-spread>
        <option value="pad" ${g.spreadMethod === 'pad' ? 'selected' : ''}>Pad</option>
        <option value="reflect" ${g.spreadMethod === 'reflect' ? 'selected' : ''}>Reflect</option>
        <option value="repeat" ${g.spreadMethod === 'repeat' ? 'selected' : ''}>Repeat</option>
      </select>`;
    box.appendChild(spreadRow);

    const rebuildStops = () => {
      stopBar.replaceChildren();
      g.stops.forEach((stop, i) => {
        const handle = elem('div', 'cpicker-stop-handle' + (i === selectedStopIdx ? ' active' : ''));
        handle.style.left = `${stop.offset * 100}%`;
        handle.style.background = stop.color;
        handle.title = `${Math.round(stop.offset * 100)}%`;
        handle.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectedStopIdx = i;
          rebuildStops();
          renderStopEditor();
          const barRect = stopBar.getBoundingClientRect();
          const onMove = (me: MouseEvent) => {
            const pct = Math.max(0, Math.min(1, (me.clientX - barRect.left) / barRect.width));
            g.stops[i].offset = Math.round(pct * 100) / 100;
            state.updateGradient(g);
            updateGradientPreview(previewBar, g);
            rebuildStops();
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        });
        stopBar.appendChild(handle);
      });
      stopBar.ondblclick = (e) => {
        const barRect = stopBar.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - barRect.left) / barRect.width));
        const newStop: GradientStop = { offset: Math.round(pct * 100) / 100, color: '#888888', opacity: 1 };
        g.stops.push(newStop);
        g.stops.sort((a, b) => a.offset - b.offset);
        selectedStopIdx = g.stops.indexOf(newStop);
        state.updateGradient(g);
        updateGradientPreview(previewBar, g);
        rebuildStops();
        renderStopEditor();
      };
    };

    const renderStopEditor = () => {
      stopEditor.replaceChildren();
      const stop = g.stops[selectedStopIdx];
      if (!stop) return;

      const row = elem('div', 'cpicker-stop-edit-row');
      row.innerHTML = `<label>Stop</label>
        <input type="number" min="0" max="100" value="${Math.round(stop.offset * 100)}" class="cpicker-slider-val" style="width:44px" title="Position along the gradient">%`;
      stopEditor.appendChild(row);

      const posInput = row.querySelector('.cpicker-slider-val') as HTMLInputElement;
      posInput.addEventListener('change', () => {
        stop.offset = Math.max(0, Math.min(100, parseInt(posInput.value) || 0)) / 100;
        g.stops.sort((a, b) => a.offset - b.offset);
        selectedStopIdx = g.stops.indexOf(stop);
        state.updateGradient(g);
        updateGradientPreview(previewBar, g);
        rebuildStops();
        renderStopEditor();
      });

      if (g.stops.length > 2) {
        const rm = elem('button', 'cpicker-stop-rm');
        rm.textContent = '✕';
        rm.title = 'Remove stop';
        rm.addEventListener('click', () => {
          g.stops.splice(selectedStopIdx, 1);
          selectedStopIdx = Math.min(selectedStopIdx, g.stops.length - 1);
          state.updateGradient(g);
          updateGradientPreview(previewBar, g);
          rebuildStops();
          renderStopEditor();
        });
        row.appendChild(rm);
      }

      const colorArea = elem('div', 'cpicker-stop-color-editor');
      stopEditor.appendChild(colorArea);
      host.mountColor(colorArea, stop.color, (hex) => {
        stop.color = hex;
        state.updateGradient(g);
        updateGradientPreview(previewBar, g);
        rebuildStops();
      });
    };

    rebuildStops();
    renderStopEditor();

    if (g.type === 'linear') {
      const angleSlider = dirRow.querySelector('[data-grad-angle]') as HTMLInputElement;
      angleSlider.after(sliderField(angleSlider, { unit: '°' }));
      const syncAngle = () => {
        const deg = parseFloat(angleSlider.value);
        const rad = deg * Math.PI / 180;
        g.x1 = 0.5 - 0.5 * Math.cos(rad);
        g.y1 = 0.5 - 0.5 * Math.sin(rad);
        g.x2 = 0.5 + 0.5 * Math.cos(rad);
        g.y2 = 0.5 + 0.5 * Math.sin(rad);
        state.updateGradient(g);
        updateGradientPreview(previewBar, g);
      };
      angleSlider.addEventListener('input', syncAngle);
    } else {
      const fx = dirRow.querySelector('[data-grad-fx]') as HTMLInputElement;
      const fy = dirRow.querySelector('[data-grad-fy]') as HTMLInputElement;
      fx.after(sliderField(fx, { unit: '%' }));
      fy.after(sliderField(fy, { unit: '%' }));
      fx?.addEventListener('input', () => {
        g.fx = parseInt(fx.value) / 100;
        state.updateGradient(g);
        updateGradientPreview(previewBar, g);
      });
      fy?.addEventListener('input', () => {
        g.fy = parseInt(fy.value) / 100;
        state.updateGradient(g);
        updateGradientPreview(previewBar, g);
      });
    }

    const spreadSel = spreadRow.querySelector('[data-grad-spread]') as HTMLSelectElement;
    spreadSel?.addEventListener('change', () => {
      g.spreadMethod = spreadSel.value as GradientDef['spreadMethod'];
      state.updateGradient(g);
    });
  };

  build(grad);
  return box;
}

export function updateGradientPreview(el: HTMLElement, grad: GradientDef): void {
  const stops = grad.stops.map(s => `${s.color} ${Math.round(s.offset * 100)}%`).join(', ');
  if (grad.type === 'linear') {
    el.style.background = `linear-gradient(${Math.round(gradientAngle(grad))}deg, ${stops})`;
  } else {
    el.style.background = `radial-gradient(circle at ${Math.round((grad.fx ?? 0.5) * 100)}% ${Math.round((grad.fy ?? 0.5) * 100)}%, ${stops})`;
  }
}

export function gradientAngle(grad: GradientDef): number {
  const dx = (grad.x2 ?? 1) - (grad.x1 ?? 0);
  const dy = (grad.y2 ?? 0) - (grad.y1 ?? 0);
  return (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
}


/**
 * Editor for an artwork-backed tile (an object pattern, or an image). Alongside
 * scale/spacing/rotation it exposes how the tile REPEATS — grid or brick, with a
 * stagger offset (0.5 is the classic half-drop).
 *
 * The preview deliberately shows several repeats with one tile outlined, which is
 * the thing that makes seams and stagger fixable: Illustrator's whole pattern-editing
 * trick is letting you see the neighbours rather than guess at them.
 */
export function buildTiledPatternEditor(state: AppState, pat: PatternDef): HTMLElement {
  const box = elem('div', 'paint-editor');

  const preview = elem('div', 'cpicker-pat-preview pat-tile-preview');
  box.appendChild(preview);

  const rows = elem('div');
  box.appendChild(rows);

  const refresh = (): void => {
    state.updatePattern(pat);
    renderTiledPreview(preview, pat);
  };

  // --- linked or copy -------------------------------------------------------
  if (pat.type === 'object') {
    const row = elem('div', 'cpicker-dir-row');
    const lab = elem('label');
    lab.textContent = 'Source';
    const val = elem('span', 'pat-source-state');
    const paint = (): void => {
      val.textContent = pat.sourceId ? 'Linked to an object' : 'Copy';
      val.title = pat.sourceId
        ? 'This tile mirrors an object on the canvas — edit it and every fill follows.'
        : 'A snapshot. Editing the original artwork does not change this pattern.';
    };
    row.append(lab, val);
    // The answer to "how do I edit this pattern?" — put the tile artwork back on the
    // canvas as ordinary objects and link the pattern to them, so every edit follows.
    const edit = document.createElement('button');
    edit.className = 'cpicker-select pat-edit-art';
    edit.type = 'button';
    edit.textContent = pat.sourceId ? 'Select artwork' : 'Edit artwork';
    edit.title = pat.sourceId
      ? 'Select the object this tile mirrors'
      : 'Put the tile artwork on the canvas and link the pattern to it';
    edit.addEventListener('click', () => {
      const id = state.editPatternArtwork(pat.id);
      if (id) state.selectShape(id);
    });
    row.appendChild(edit);
    if (pat.sourceId) {
      const unlink = document.createElement('button');
      unlink.className = 'cpicker-select pat-unlink';
      unlink.type = 'button';
      unlink.textContent = 'Unlink';
      unlink.title = 'Stop tracking the source; keep the artwork as it is now';
      unlink.addEventListener('click', () => {
        state.unlinkPattern(pat.id);
        paint();
        unlink.remove();
      });
      row.appendChild(unlink);
    }
    paint();
    rows.appendChild(row);
  }

  // --- how it repeats -------------------------------------------------------
  const typeRow = elem('div', 'cpicker-dir-row');
  const typeLab = elem('label');
  typeLab.textContent = 'Repeat';
  const typeSel = document.createElement('select');
  typeSel.className = 'cpicker-select';
  for (const [val, label] of [['grid', 'Grid'], ['brick-row', 'Brick by row'], ['brick-col', 'Brick by column']]) {
    const o = document.createElement('option');
    o.value = val; o.textContent = label;
    o.selected = (pat.tileType ?? 'grid') === val;
    typeSel.appendChild(o);
  }
  typeRow.append(typeLab, typeSel);
  rows.appendChild(typeRow);

  const offsetRow = elem('div', 'cpicker-dir-row');
  const offsetLab = elem('label');
  offsetLab.textContent = 'Offset';
  const offsetInput = document.createElement('input');
  offsetInput.type = 'range';
  offsetInput.className = 'cpicker-slider';
  offsetInput.min = '0'; offsetInput.max = '1'; offsetInput.step = '0.01';
  offsetInput.value = String(pat.tileOffset ?? 0.5);
  const showOffset = (): void => {
    const brick = (pat.tileType ?? 'grid') !== 'grid';
    offsetRow.style.display = brick ? '' : 'none';   // meaningless for a plain grid
  };
  offsetInput.addEventListener('input', () => {
    pat.tileOffset = parseFloat(offsetInput.value);
    refresh();
  });
  offsetRow.append(offsetLab, offsetInput, sliderField(offsetInput, { scale: 100, unit: '%' }));
  rows.appendChild(offsetRow);

  typeSel.addEventListener('change', () => {
    pat.tileType = typeSel.value as PatternDef['tileType'];
    showOffset();
    refresh();
  });

  // --- size / gap / angle ---------------------------------------------------
  const slider = (
    label: string, min: number, max: number, step: number, unit: string,
    read: () => number, write: (v: number) => void,
  ): void => {
    const row = elem('div', 'cpicker-dir-row');
    const lab = elem('label');
    lab.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'cpicker-slider';
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(read());
    input.addEventListener('input', () => {
      write(parseFloat(input.value));
      refresh();
    });
    row.append(lab, input, sliderField(input, { scale: unit === '%' ? 100 : 1, unit }));
    rows.appendChild(row);
  };
  slider('Scale', 0.1, 4, 0.01, '%', () => pat.scale, (v) => { pat.scale = v; });
  // Negative spacing overlaps the tiles, which is how you close a seam.
  slider('Spacing', -20, 80, 1, 'px', () => pat.spacing, (v) => { pat.spacing = v; });
  slider('Rotation', 0, 360, 1, '°', () => pat.rotation ?? 0, (v) => { pat.rotation = v; });

  showOffset();
  renderTiledPreview(preview, pat);
  return box;
}

/** Preview several repeats of the live pattern, with ONE tile outlined so the tile
 *  edge (and any seam or stagger) is visible rather than guessed at. */
export function renderTiledPreview(el: HTMLElement, pat: PatternDef): void {
  el.replaceChildren();
  const W = 220, H = 110;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.display = 'block';

  const fill = document.createElementNS(SVG_NS, 'rect');
  fill.setAttribute('width', String(W));
  fill.setAttribute('height', String(H));
  fill.setAttribute('fill', `url(#${pat.id})`);
  svg.appendChild(fill);

  // Outline one tile, at the SAME size the pattern actually uses (brick doubles it).
  const cellW = pat.tileWidth * pat.scale + pat.spacing;
  const cellH = pat.tileHeight * pat.scale + pat.spacing;
  const tt = pat.tileType ?? 'grid';
  const tw = Math.max(1, Math.round(tt === 'brick-col' ? cellW * 2 : cellW));
  const th = Math.max(1, Math.round(tt === 'brick-row' ? cellH * 2 : cellH));
  if (tw <= W && th <= H) {
    const edge = document.createElementNS(SVG_NS, 'rect');
    edge.setAttribute('width', String(tw));
    edge.setAttribute('height', String(th));
    edge.setAttribute('fill', 'none');
    edge.setAttribute('stroke', 'var(--ai-accent, #4d7cfe)');
    edge.setAttribute('stroke-width', '1');
    edge.setAttribute('stroke-dasharray', '3 3');
    edge.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(edge);
  }
  el.appendChild(svg);
}


/**
 * A door to the Library rather than a second pattern browser.
 *
 * This used to be a swatch row of every pattern in the document — which duplicated
 * the Library panel (already the place you browse, name, fold, search and apply
 * assets) inside an editor popover that was busy enough, and rendered its chips
 * from a fixed-size viewBox that showed an empty corner of most tiles. One home,
 * one set of previews.
 */
export function buildPatternLibraryLink(currentId?: string): HTMLElement {
  const wrap = elem('div', 'pat-lib-link');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pat-lib-link-btn';
  btn.textContent = 'Browse patterns in the Library';
  btn.title = 'Patterns are named, organised and applied from the Library panel';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPatternLibrary?.(currentId);
  });
  wrap.appendChild(btn);
  return wrap;
}

/** Wired at boot so this module needn't import the Library panel (which imports
 *  the style panel, which imports this one — a cycle). */
let openPatternLibrary: ((docId?: string) => void) | null = null;
export function setPatternLibraryOpener(fn: (docId?: string) => void): void {
  openPatternLibrary = fn;
}
