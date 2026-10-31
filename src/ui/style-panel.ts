/**
 * Style panel — live editing for the library style focused in the Library panel.
 *
 * This replaced a modal property editor: a modal covers the canvas, so you can't
 * see what a change does. The panel is modeless, so scrubbing a blur or dragging a
 * colour updates every object using that style in REAL TIME. It is now the single
 * renderer for an adapter's EditField descriptors.
 *
 * Opened by DOUBLE-clicking a library row (or its "Edit style…" menu item); a
 * single click applies, which is the action users repeat all day. Focusing does
 * NOT touch the shape selection, so "Apply to selection" here is still meaningful.
 *
 * History: live `input` events mutate without recording (applyEdits record:false);
 * the committing `change` event records ONE entry, so a whole scrub is one undo.
 */

import type { AppState } from '../core/state';
import type { AssetAdapter } from './library-adapters';
import { adapterFor } from './library-adapters';
import type { EditField, EditValues } from './dialogs';
import type { AssetType } from '../core/library';
import { showToast } from './toast';
import { buildGradientEditor, buildPatternEditor, type PaintEditorHost } from './paint-editors';
import { openSolidColorPicker } from './color-picker';
import type { PaintStylePayload, PalettePayload } from '../core/library';

interface Focus { type: AssetType; id: string }

let focused: Focus | null = null;
let onApply: ((type: AssetType, id: string) => void) | null = null;
let onFocusChange: (() => void) | null = null;

/** Focus a style for editing (called by the Library panel on row click). */
export function setFocusedStyle(type: AssetType, id: string): void {
  focused = { type, id };
  onFocusChange?.();
}

export function clearFocusedStyle(): void {
  if (!focused) return;
  focused = null;
  onFocusChange?.();
}

export function getFocusedStyle(): Focus | null {
  return focused;
}

/** Wire once at boot. `apply` performs "Apply to selection" through the Library
 *  panel's own path (toasts + pulse); `changed` re-renders the library rows. */
export function setupStylePanel(
  hooks: { apply: (type: AssetType, id: string) => void; changed: () => void },
): void {
  onApply = hooks.apply;
  onFocusChange = hooks.changed;
  // An explicit way out, next to the gesture one (clicking empty canvas). The panel
  // appears from a Library row click, so without a visible affordance the only exits
  // were gestures you had to already know about.
  document.getElementById('style-panel-close')?.addEventListener('click', (e) => {
    e.stopPropagation(); // don't let the header's double-click-to-collapse see it
    clearFocusedStyle();
  });
}

/** Re-render from AppState (called on every state change + on focus change). */
export function updateStylePanel(state: AppState): void {
  const body = document.getElementById('style-panel-body');
  if (!body) return;
  // Own our container's visibility: focusing a style isn't a document change, so
  // updateInspector doesn't necessarily re-run. Same predicate as its show() rule.
  const panel = document.getElementById('panel-style');
  const setShown = (on: boolean): void => { if (panel) panel.style.display = on ? '' : 'none'; };

  if (!focused) { body.innerHTML = ''; setShown(false); return; }

  const adapter = adapterFor(focused.type);
  const asset = adapter?.listDocument(state).find((a) => a.id === focused!.id);
  if (!adapter || !asset) { focused = null; body.innerHTML = ''; setShown(false); return; }
  setShown(true);

  // Don't fight a live drag: rebuilding mid-scrub would drop the input's focus.
  if (body.dataset.editing === '1') return;

  body.innerHTML = '';
  body.appendChild(header(adapter, asset.name));

  const fields = adapter.editFields?.(asset.payload) ?? [];
  // Some types can't be expressed as flat fields (a gradient's stops, a palette's
  // swatch set) and mount a purpose-built editor instead.
  const custom = adapter.type === 'paint-style' || adapter.type === 'pattern'
    ? buildPaintStyleEditor(state, asset.id, asset.payload as PaintStylePayload, body)
    : adapter.type === 'palette'
      ? buildPaletteEditor(state, asset.id, asset.payload as PalettePayload, body)
      : null;
  if (custom) body.appendChild(custom);
  else if (!fields.length) {
    body.appendChild(note('This asset has no editable properties.'));
  }
  const rowFor = new Map<string, HTMLElement>();
  for (const f of fields) {
    const row = fieldRow(state, adapter, asset.id, fields, f, body);
    rowFor.set(f.key, row);
    body.appendChild(row);
  }
  // Conditional fields (e.g. the shadow parameters) follow their controlling field
  // live, without rebuilding the panel — a rebuild mid-edit would drop focus.
  const syncVisibility = (): void => {
    const values = collect(body, fields);
    for (const f of fields) {
      if (!f.showWhen) continue;
      const row = rowFor.get(f.key);
      if (row) row.style.display = values[f.showWhen.key] === f.showWhen.equals ? '' : 'none';
    }
  };
  syncVisibility();
  body.addEventListener('input', syncVisibility);
  body.addEventListener('change', syncVisibility);

  body.appendChild(actions(state, adapter, asset.id, asset.name));
}

/**
 * The gradient/pattern editor for a paint style — the SAME inline editor the Fills
 * panel uses (ui/paint-editors.ts), bound to the style's canonical def instead of
 * one object's paint. Because every object using the style references that def, a
 * stop drag or a tile-size change updates all of them live.
 *
 * Returns null for a solid paint (a flat colour field covers that) or when the
 * style's def isn't in this document yet — i.e. it has never been applied here.
 */
function buildPaintStyleEditor(
  state: AppState, styleId: string, payload: PaintStylePayload, body: HTMLElement,
): HTMLElement | null {
  if (payload.kind === 'solid' || !payload.defMarkup) return null;
  const url = state.canonicalPaintDef(styleId, payload.kind, payload.defMarkup);
  const defId = url ? /^url\(#(.+?)\)$/.exec(url)?.[1] : null;
  if (!defId) return null;

  const host: PaintEditorHost = {
    mountColor: (container, current, onChange) => {
      const chip = document.createElement('button');
      chip.className = 'ap-color';
      const inner = document.createElement('span');
      inner.className = 'ap-color-inner';
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
    // linear↔radial mints a NEW def, so move the style (and every object using it)
    // onto it: re-stamp the marker, repoint the linked fills, and save the markup.
    onPaintChange: (value) => {
      const newId = /^url\(#(.+?)\)$/.exec(value)?.[1];
      if (!newId) return;
      const linked = state.shapesWithStyleLink('data-paint-style', styleId).map((s) => s.id);
      if (linked.length) state.applyFillToShapes(linked, value, false);
      syncPayload(state, styleId, payload.kind, newId, true);
    },
  };

  const grad = state.getGradientById(defId);
  const pat = state.getPatternById(defId);
  const editor = grad ? buildGradientEditor(state, grad, host)
    : pat ? buildPatternEditor(state, pat, host) : null;
  if (!editor) return null;

  // The editors mutate the def through state.updateGradient/updatePattern, which
  // fires onStateChange — that would rebuild this panel and yank the control out
  // from under the pointer mid-drag. Hold the same guard the flat fields use, and
  // write the edited markup back into the style's payload as it changes.
  const wrap = document.createElement('div');
  wrap.className = 'sp-paint-editor';
  // Only real value controls hold the panel open. A pointerdown on a BUTTON used to
  // set this guard too, and nothing cleared it (only 'change' does), so clicking
  // "Edit artwork" or "Unlink" left the panel frozen showing stale state.
  wrap.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('button')) return;
    body.dataset.editing = '1';
  });
  wrap.addEventListener('input', () => {
    body.dataset.editing = '1';
    syncPayload(state, styleId, payload.kind, defId, false);
  });
  const commit = (): void => {
    if (body.dataset.editing !== '1') return;
    delete body.dataset.editing;
    syncPayload(state, styleId, payload.kind, defId, true);
    onFocusChange?.(); // refresh the row preview + description
  };
  // 'change' only — NOT pointerup. Committing on pointerup re-rendered the panel the
  // moment a <select> popup opened, so the dropdown appeared for one frame and
  // vanished. 'change' already fires on slider release and on choosing an option.
  wrap.addEventListener('change', commit);
  wrap.appendChild(editor);
  return wrap;
}

/**
 * Palette editor — a real swatch grid. Each chip opens the app's colour picker;
 * hovering reveals a ✕ to drop it; "+" appends one. This replaced a single text
 * box of comma-separated hex codes, where a typo silently dropped a colour and
 * there was no way to see what you were editing.
 */
function buildPaletteEditor(
  state: AppState, styleId: string, payload: PalettePayload, body: HTMLElement,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sp-palette';
  const colors: string[] = [...(payload.colors ?? [])];

  const save = (record: boolean): void => {
    state.updateLibraryAsset(styleId, { colors: [...colors] } as PalettePayload, undefined, record);
    if (record) { delete body.dataset.editing; onFocusChange?.(); }
    else body.dataset.editing = '1'; // hold the rebuild off mid-interaction
  };

  const render = (): void => {
    wrap.replaceChildren();
    colors.forEach((color, i) => {
      const cell = document.createElement('div');
      cell.className = 'sp-swatch';
      const chip = document.createElement('button');
      chip.className = 'sp-swatch-btn';
      chip.type = 'button';
      chip.style.background = color;
      chip.title = `${color} — click to edit`;
      chip.setAttribute('aria-label', `Edit colour ${i + 1} of ${colors.length} (${color})`);
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        openSolidColorPicker(state, chip, colors[i], (v) => {
          if (v === null) return;
          colors[i] = v;
          chip.style.background = v;
          save(false);
        }, 'Colour', () => save(true));
      });
      const del = document.createElement('button');
      del.className = 'sp-swatch-x';
      del.type = 'button';
      del.textContent = '✕';
      del.title = 'Remove this colour';
      del.setAttribute('aria-label', `Remove colour ${i + 1} (${color})`);
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        colors.splice(i, 1);
        save(true);
        render();
      });
      cell.append(chip, del);
      wrap.appendChild(cell);
    });

    const add = document.createElement('button');
    add.className = 'sp-swatch-add';
    add.type = 'button';
    add.textContent = '+';
    add.title = 'Add a colour';
    add.setAttribute('aria-label', 'Add a colour to this palette');
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      const seed = colors[colors.length - 1] ?? '#888888';
      colors.push(seed);
      save(true);
      render();
      // Open the picker on the new chip straight away — appending a duplicate of
      // the last colour on its own isn't a useful outcome.
      const chips = wrap.querySelectorAll<HTMLElement>('.sp-swatch-btn');
      chips[chips.length - 1]?.click();
    });
    wrap.appendChild(add);
  };

  render();
  return wrap;
}

/** Copy the live def's markup back into the style definition. */
function syncPayload(
  state: AppState, styleId: string, kind: PaintStylePayload['kind'], defId: string, record: boolean,
): void {
  const el = document.getElementById(defId);
  if (!el) return;
  state.updateLibraryAsset(
    styleId,
    { kind, value: `url(#${defId})`, defMarkup: el.outerHTML, defId } as PaintStylePayload,
    undefined,
    record,
  );
}

function header(adapter: AssetAdapter, name: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'sp-head';
  const t = document.createElement('div');
  t.className = 'sp-title';
  t.textContent = name;
  const sub = document.createElement('div');
  sub.className = 'sp-sub';
  sub.textContent = adapter.label;
  const txt = document.createElement('div');
  txt.className = 'sp-head-text';
  txt.append(t, sub);
  const close = document.createElement('button');
  close.className = 'sp-close';
  close.textContent = '✕';
  close.title = 'Stop editing this style';
  close.addEventListener('click', () => clearFocusedStyle());
  row.append(txt, close);
  return row;
}

function note(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ap-empty';
  el.textContent = text;
  return el;
}

/** Read every control's current value, so one changed field still submits a full set. */
function collect(body: HTMLElement, fields: EditField[]): EditValues {
  const out: EditValues = {};
  for (const f of fields) {
    const el = body.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-sp-key="${f.key}"]`);
    if (!el) { out[f.key] = f.value; continue; }
    if (f.type === 'checkbox') out[f.key] = (el as HTMLInputElement).checked;
    else if (f.type === 'number') out[f.key] = parseFloat(el.value) || 0;
    else out[f.key] = el.value;
  }
  return out;
}

function fieldRow(
  state: AppState, adapter: AssetAdapter, docId: string,
  fields: EditField[], f: EditField, body: HTMLElement,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'appearance-row sp-row';
  const label = document.createElement('span');
  label.className = 'appearance-label';
  label.textContent = f.label;
  row.appendChild(label);

  let input: HTMLInputElement | HTMLSelectElement;
  if (f.type === 'select') {
    const sel = document.createElement('select');
    sel.className = 'sp-input';
    for (const o of f.options ?? []) {
      const opt = document.createElement('option');
      opt.value = o; opt.textContent = o;
      sel.appendChild(opt);
    }
    sel.value = String(f.value);
    input = sel;
  } else if (f.type === 'color') {
    // The app's own picker, NOT <input type="color">: color-picker.ts states every
    // colour surface must use it, and on Windows the native control opens an OS
    // modal over the canvas — the exact thing this modeless panel exists to avoid.
    // (It also sat right beside the gradient editor, which already used the app
    // picker, so the panel contradicted itself.)
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.value = String(f.value);
    const chip = document.createElement('button');
    chip.className = 'ap-color sp-color';
    chip.type = 'button';
    chip.title = `Pick ${f.label.toLowerCase()}`;
    chip.setAttribute('aria-label', `Pick ${f.label.toLowerCase()}`);
    const inner = document.createElement('span');
    inner.className = 'ap-color-inner';
    inner.style.background = String(f.value);
    chip.appendChild(inner);
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      openSolidColorPicker(
        state, chip, hidden.value,
        (v) => {                       // live: tracks the drag, records nothing
          if (v === null) return;
          inner.style.background = v;
          hidden.value = v;
          hidden.dispatchEvent(new Event('input', { bubbles: false }));
        },
        f.label,
        () => hidden.dispatchEvent(new Event('change', { bubbles: false })), // one undo step
      );
    });
    row.appendChild(chip);
    input = hidden;
  } else {
    const el = document.createElement('input');
    el.className = f.type === 'checkbox' ? 'sp-check' : 'sp-input';
    el.type = f.type;
    if (f.type === 'checkbox') el.checked = Boolean(f.value);
    else el.value = String(f.value);
    if (f.min !== undefined) el.min = String(f.min);
    if (f.max !== undefined) el.max = String(f.max);
    if (f.step !== undefined) el.step = String(f.step);
    input = el;
  }
  input.dataset.spKey = f.key;

  // Live: mutate without recording so the canvas tracks the drag/typing…
  input.addEventListener('input', () => {
    body.dataset.editing = '1';
    adapter.applyEdits?.(state, docId, collect(body, fields), false);
  });
  // …then commit exactly one history entry when the interaction ends.
  const commit = (): void => {
    if (body.dataset.editing !== '1') return;
    delete body.dataset.editing;
    adapter.applyEdits?.(state, docId, collect(body, fields), true);
    onFocusChange?.(); // refresh the library row's preview + description
  };
  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);

  row.appendChild(input);
  return row;
}

function actions(state: AppState, adapter: AssetAdapter, docId: string, name: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sp-actions';

  const n = state.selectedShapeIds.length;
  // Types whose apply doesn't act on the selection (a palette loads swatches, a
  // component places an instance) must not be gated on one — their only action
  // used to sit disabled whenever nothing happened to be selected.
  const needsSel = adapter.needsSelection !== false;
  const apply = document.createElement('button');
  apply.className = 'sp-btn sp-btn-primary';
  apply.textContent = !needsSel
    ? (adapter.applyLabel ?? 'Apply')
    : n ? `Apply to selection (${n})` : 'Apply to selection';
  apply.disabled = needsSel && n === 0;
  apply.title = !needsSel ? (adapter.applyLabel ?? 'Apply')
    : n ? 'Apply this style to the selected objects' : 'Select objects on the canvas first';
  apply.addEventListener('click', () => onApply?.(adapter.type, docId));
  wrap.appendChild(apply);

  if (adapter.redefineFromSelection) {
    const redef = document.createElement('button');
    redef.className = 'sp-btn';
    redef.textContent = n && state.shapesWithStyleLink(adapter.linkAttr ?? '', docId).length
      ? `Update from selection (${state.shapesWithStyleLink(adapter.linkAttr ?? '', docId).length} using)`
      : 'Update from selection';
    redef.disabled = n === 0;
    redef.title = 'Make this style match the selected object';
    redef.addEventListener('click', () => {
      const count = adapter.redefineFromSelection?.(state, docId) ?? 0;
      onFocusChange?.();
      showToast(count > 0
        ? `Updated “${name}” — ${count} object${count === 1 ? '' : 's'} changed.`
        : 'Select an object with the values you want first.',
        8000, undefined, count > 0 ? 'success' : 'warning');
    });
    wrap.appendChild(redef);
  }

  if (adapter.linkAttr) {
    const using = state.shapesWithStyleLink(adapter.linkAttr, docId).length;
    wrap.appendChild(note(using
      ? `${using} object${using === 1 ? '' : 's'} ${using === 1 ? 'uses' : 'use'} this style — edits above apply to all of them live.`
      : 'No objects use this style yet.'));
  }
  return wrap;
}
