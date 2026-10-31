/**
 * Object styles — shows which library styles the SELECTION is using, right above
 * the Fill panel.
 *
 * Before this, a style link was invisible state: you could not tell which style an
 * object used, or that a manual edit had just detached it. The only way to answer
 * "what uses this style?" was to hunt through a row menu per style.
 *
 * Each row names the style, says how many objects share it, and offers: open it in
 * the live Style panel, select every object using it, and unlink this object (which
 * keeps its current look — it just stops tracking the style).
 */

import type { AppState } from '../core/state';
import type { AssetType } from '../core/library';
import { assetAdapters, type AssetAdapter } from './library-adapters';
import { setFocusedStyle } from './style-panel';
import { showToast } from './toast';

let onChanged: (() => void) | null = null;

/** Wire once at boot so unlink/focus can refresh the Library rows + Style panel. */
export function setupObjectStylesPanel(hooks: { changed: () => void }): void {
  onChanged = hooks.changed;
}

/** True when the selection uses at least one library style (drives visibility). */
export function selectionHasStyleLinks(state: AppState): boolean {
  return linksForSelection(state).length > 0;
}

interface LinkRow { adapter: AssetAdapter; styleId: string; name: string; onSelection: number; total: number }

/** Every style link carried by the current selection, one row per distinct style. */
function linksForSelection(state: AppState): LinkRow[] {
  const shapes = state.getSelectedShapes();
  if (!shapes.length) return [];
  const rows: LinkRow[] = [];
  for (const adapter of assetAdapters()) {
    const attr = adapter.linkAttr;
    if (!attr) continue;
    const counts = new Map<string, number>();
    for (const s of shapes) {
      const id = s.element.getAttribute(attr);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (!counts.size) continue;
    const listed = adapter.listDocument(state);
    for (const [styleId, onSelection] of counts) {
      const asset = listed.find((a) => a.id === styleId);
      if (!asset) continue; // dangling links are pruned elsewhere; never show one
      rows.push({
        adapter, styleId, name: asset.name, onSelection,
        total: state.shapesWithStyleLink(attr, styleId).length,
      });
    }
  }
  return rows;
}

export function updateObjectStylesPanel(state: AppState): void {
  const body = document.getElementById('object-styles-body');
  if (!body) return;
  const rows = linksForSelection(state);
  const panel = document.getElementById('panel-object-styles');
  if (panel) panel.style.display = rows.length ? '' : 'none';
  body.innerHTML = '';
  const selCount = state.getSelectedShapes().length;
  for (const row of rows) body.appendChild(buildRow(state, row, selCount));
}

function buildRow(state: AppState, row: LinkRow, selCount: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'os-row';

  const preview = row.adapter.renderPreview({ name: row.name, payload: payloadOf(state, row) });
  preview.classList.add('os-preview');
  el.appendChild(preview);

  const body = document.createElement('div');
  body.className = 'os-body';
  const name = document.createElement('div');
  name.className = 'os-name';
  name.textContent = row.name;
  const meta = document.createElement('div');
  meta.className = 'os-meta';
  // "on 2 of 3 selected" only matters for a mixed selection; otherwise show reach.
  // Kept short: the panel is narrow, and a truncated "used b…" says nothing.
  meta.textContent = row.onSelection < selCount
    ? `${row.adapter.label} · ${row.onSelection}/${selCount} selected`
    : `${row.adapter.label} · ${row.total} object${row.total === 1 ? '' : 's'}`;
  meta.title = `${row.adapter.label} — used by ${row.total} object${row.total === 1 ? '' : 's'} in this document`;
  body.append(name, meta);
  el.appendChild(body);

  el.appendChild(iconBtn('✎', 'Edit this style', () => {
    setFocusedStyle(row.adapter.type as AssetType, row.styleId);
    onChanged?.();
  }));
  el.appendChild(iconBtn('⤢', 'Select every object using this style', () => {
    const attr = row.adapter.linkAttr;
    if (!attr) return;
    const ids = state.shapesWithStyleLink(attr, row.styleId).map((s) => s.id);
    if (ids.length) state.selectMultiple(ids);
  }));
  el.appendChild(iconBtn('✕', 'Unlink — keeps the current look, stops tracking the style', () => {
    const attr = row.adapter.linkAttr;
    if (!attr) return;
    let n = 0;
    for (const s of state.getSelectedShapes()) {
      if (s.locked) continue; // a locked object isn't editable, including its links
      if (s.element.getAttribute(attr) === row.styleId) { s.element.removeAttribute(attr); n++; }
    }
    if (!n) return;
    state.saveHistory();
    state.selectMultiple([...state.selectedShapeIds]); // re-affirm the selection to fire onStateChange
    onChanged?.();
    showToast(`Unlinked ${n} object${n === 1 ? '' : 's'} from “${row.name}” — the look is unchanged.`, 8000, undefined, 'success');
  }));
  return el;
}

function payloadOf(state: AppState, row: LinkRow): unknown {
  return row.adapter.listDocument(state).find((a) => a.id === row.styleId)?.payload;
}

function iconBtn(glyph: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'os-btn';
  b.textContent = glyph;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}
