/**
 * Text styles UI (Phase 5). Surfaces the document's reusable text styles where
 * you already are: a "Style" row at the TOP of the Text panel showing the
 * selected object's linked style (and its override state), which opens a library
 * flyout — each style previewed in its own face — for apply / create / redefine /
 * rename / delete.
 *
 * Self-contained singleton (injects its own styles, builds its own DOM at
 * runtime) so it never touches the contested index.html. The model + history live
 * in AppState / core/text-styles.ts; this module is pure presentation + wiring.
 */

import type { AppState } from '../core/state';
import type { ShapeData } from '../core/types';
import { promptDialog, confirmDialog } from './dialogs';
import { showToast } from './toast';
import { pulseShapes } from './feedback';

let appState: AppState | null = null;
let flyoutEl: HTMLElement | null = null;
let outsideHandler: ((e: MouseEvent) => void) | null = null;

function injectStyles(): void {
  if (document.getElementById('ts-styles')) return;
  const el = document.createElement('style');
  el.id = 'ts-styles';
  el.textContent = `
.ts-style-control { display: flex; align-items: center; gap: 6px; }
.ts-style-btn {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px;
  height: 26px; padding: 0 8px; border-radius: 5px; cursor: pointer;
  background: var(--ai-input, #1a1d24); border: 1px solid var(--ai-border-light, #3b414f);
  color: var(--ai-text, #e6e8ec); font-size: 12px; text-align: left;
}
.ts-style-btn:hover { border-color: var(--ai-accent, #4d7cfe); }
.ts-style-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ts-style-name.none { color: var(--ai-text-dim, #8b929e); }
.ts-override-dot { color: var(--ts-warn, #e0a53a); font-size: 10px; line-height: 1; flex: 0 0 auto; }
.ts-chevron { flex: 0 0 auto; opacity: 0.6; }
.ts-reset {
  flex: 0 0 auto; width: 24px; height: 24px; display: grid; place-items: center;
  border-radius: 5px; cursor: pointer; background: transparent;
  border: 1px solid var(--ai-border-light, #3b414f); color: var(--ai-text-dim, #8b929e);
}
.ts-reset:hover { color: var(--ai-text, #e6e8ec); border-color: var(--ai-accent, #4d7cfe); }

.ts-flyout {
  position: fixed; z-index: 4000; width: 268px; max-height: 60vh; display: flex; flex-direction: column;
  background: var(--ai-panel, #21242c); border: 1px solid var(--ai-border-light, #3b414f);
  border-radius: 9px; box-shadow: 0 12px 34px rgba(0,0,0,0.5); overflow: hidden;
  font-size: 12px; color: var(--ai-text, #e6e8ec);
}
.ts-flyout-search {
  margin: 8px; padding: 6px 8px; border-radius: 5px; flex: 0 0 auto;
  background: var(--ai-input, #1a1d24); border: 1px solid var(--ai-border, #2d313b);
  color: var(--ai-text, #e6e8ec); font-size: 12px; outline: none;
}
.ts-flyout-search:focus { border-color: var(--ai-accent, #4d7cfe); }
.ts-group {
  padding: 4px 12px; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--ai-text-dim, #8b929e); flex: 0 0 auto;
}
.ts-list { overflow-y: auto; padding: 0 6px; }
.ts-empty { padding: 10px 12px; color: var(--ai-text-dim, #8b929e); font-style: italic; }
.ts-item {
  position: relative; display: flex; align-items: center; gap: 8px; padding: 7px 8px;
  border-radius: 6px; cursor: pointer;
}
.ts-item:hover { background: var(--ai-hover, #2a3040); }
.ts-item.active { background: var(--ai-accent-dim, #3a5ad4); }
.ts-item-check { flex: 0 0 auto; width: 12px; opacity: 0; }
.ts-item.active .ts-item-check { opacity: 1; }
.ts-item-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ts-item-name {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; line-height: 1.25;
  color: var(--ai-text, #e6e8ec);
}
.ts-item-meta {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 10px; color: var(--ai-text-dim, #8b929e);
}
.ts-item.active .ts-item-meta { color: rgba(255,255,255,0.75); }
.ts-item-dot { color: var(--ts-warn, #e0a53a); font-size: 10px; flex: 0 0 auto; }
.ts-item-more {
  flex: 0 0 auto; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 4px;
  background: transparent; border: none; color: var(--ai-text-dim, #8b929e); cursor: pointer;
  opacity: 0; font-size: 15px; line-height: 1;
}
.ts-item:hover .ts-item-more, .ts-item.active .ts-item-more { opacity: 1; }
.ts-item-more:hover { background: rgba(255,255,255,0.12); color: var(--ai-text, #e6e8ec); }
.ts-create {
  margin: 6px 8px 8px; padding: 8px; flex: 0 0 auto; border-radius: 6px; cursor: pointer;
  background: var(--ai-input, #1a1d24); border: 1px dashed var(--ai-border-light, #3b414f);
  color: var(--ai-text, #e6e8ec); font-size: 12px; text-align: center;
}
.ts-create:hover { border-color: var(--ai-accent, #4d7cfe); border-style: solid; }

.ts-menu {
  position: fixed; z-index: 4100; min-width: 168px; padding: 4px;
  background: var(--ai-panel, #21242c); border: 1px solid var(--ai-border-light, #3b414f);
  border-radius: 7px; box-shadow: 0 10px 28px rgba(0,0,0,0.5);
}
.ts-menu-item {
  display: block; width: 100%; text-align: left; padding: 6px 9px; border-radius: 5px; cursor: pointer;
  background: transparent; border: none; color: var(--ai-text, #e6e8ec); font-size: 12px;
}
.ts-menu-item:hover { background: var(--ai-hover, #2a3040); }
.ts-menu-item.disabled { color: var(--ai-text-dim, #8b929e); pointer-events: none; }
.ts-menu-item.danger:hover { background: #7a2a2a; }

/* Layers panel: the "what's styled" chip on a styled text row. */
.layer-style-chip {
  flex: 0 0 auto; max-width: 94px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  margin-left: 6px; padding: 1px 6px; border-radius: 9px; font-size: 9.5px; line-height: 1.55;
  background: #363b4a; color: #aab3c5;
}
.layer-style-chip.cloud { background: #123a35; color: #5fd3c0; }
.layer-style-dot { color: var(--ts-warn, #e0a53a); margin-left: 3px; font-size: 8px; }
`;
  document.head.appendChild(el);
}

const CHEVRON = '<svg class="ts-chevron" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>';
const RESET_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2v3h-3"/></svg>';
const CHECK = '<svg class="ts-item-check" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 5"/></svg>';

/** Selected shapes that a style can apply to (text or multi-stroke text). */
function selectedTextShapes(state: AppState): ShapeData[] {
  return state.getSelectedShapes().filter((s) => state.canStyleText(s));
}
function selectedTextIds(state: AppState): string[] {
  return selectedTextShapes(state).map((s) => s.id);
}

const plural = (n: number): string => (n === 1 ? '' : 's');

export function setupTextStyles(state: AppState): void {
  appState = state;
  injectStyles();

  const body = document.querySelector('#panel-type .panel-body');
  if (!body || document.getElementById('ts-style-row')) return;

  const row = document.createElement('div');
  row.className = 'panel-row';
  row.id = 'ts-style-row';
  row.innerHTML = `
    <div class="panel-field full">
      <label>Style</label>
      <div class="ts-style-control">
        <button class="ts-style-btn" id="ts-style-btn" type="button">
          <span class="ts-style-name none" id="ts-style-name">No style</span>
          <span class="ts-override-dot" id="ts-override-dot" title="Has overrides" hidden>●</span>
          ${CHEVRON}
        </button>
        <button class="ts-reset" id="ts-reset" type="button" title="Reset to style" hidden>${RESET_ICON}</button>
      </div>
    </div>`;
  body.prepend(row);

  document.getElementById('ts-style-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFlyout();
  });
  document.getElementById('ts-reset')!.addEventListener('click', (e) => {
    e.stopPropagation();
    resetSelectionToStyle();
  });
}

/** Reflect the current selection's linked style + override state on the row. */
export function updateTextStylesUI(state: AppState): void {
  appState = state;
  const row = document.getElementById('ts-style-row');
  if (!row) return;

  const all = state.getSelectedShapes();
  const texts = selectedTextShapes(state);
  const allText = texts.length > 0 && texts.length === all.length;
  if (!allText) { row.style.display = 'none'; closeFlyout(); return; }
  row.style.display = '';

  const nameEl = document.getElementById('ts-style-name')!;
  const dot = document.getElementById('ts-override-dot')!;
  const reset = document.getElementById('ts-reset')!;

  const ids = texts.map((s) => state.linkedStyleOf(s)?.id ?? null);
  const common = ids.every((id) => id === ids[0]) ? ids[0] : undefined; // undefined = mixed
  let overridden = false;

  if (common === undefined) {
    nameEl.textContent = 'Mixed'; nameEl.classList.remove('none');
  } else if (common === null) {
    nameEl.textContent = 'No style'; nameEl.classList.add('none');
  } else {
    nameEl.textContent = state.getTextStyle(common)?.name ?? 'No style';
    nameEl.classList.remove('none');
    overridden = texts.some((s) => state.textStyleOverrides(s).length > 0);
  }
  dot.hidden = !overridden;
  reset.hidden = !overridden;

  if (flyoutEl) renderFlyoutList(); // keep an open flyout's active row in sync
}

// ---------------------------------------------------------------------------
// Flyout
// ---------------------------------------------------------------------------

function toggleFlyout(): void {
  if (flyoutEl) { closeFlyout(); return; }
  openFlyout();
}

function openFlyout(): void {
  const btn = document.getElementById('ts-style-btn');
  if (!btn || !appState) return;

  flyoutEl = document.createElement('div');
  flyoutEl.className = 'ts-flyout';
  flyoutEl.innerHTML = `
    <input class="ts-flyout-search" id="ts-search" placeholder="Search styles…" autocomplete="off" spellcheck="false" />
    <div class="ts-group">This document</div>
    <div class="ts-list" id="ts-list"></div>
    <div class="ts-empty" id="ts-empty" hidden>No styles yet — create one from a text object.</div>
    <button class="ts-create" id="ts-create" type="button">+ New style from selection</button>`;
  document.body.appendChild(flyoutEl);

  const r = btn.getBoundingClientRect();
  const w = 268;
  let left = r.left;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  flyoutEl.style.left = `${Math.max(8, left)}px`;
  flyoutEl.style.top = `${r.bottom + 6}px`;

  flyoutEl.querySelector('#ts-search')!.addEventListener('input', renderFlyoutList);
  flyoutEl.querySelector('#ts-create')!.addEventListener('click', createFromSelection);
  renderFlyoutList();

  outsideHandler = (e: MouseEvent) => {
    const t = e.target as Node;
    if (flyoutEl && !flyoutEl.contains(t) && !btn.contains(t) && !(t instanceof Element && t.closest('.ts-menu'))) {
      closeFlyout();
    }
  };
  // Defer so the opening click doesn't immediately close it.
  setTimeout(() => document.addEventListener('mousedown', outsideHandler!), 0);
}

function closeFlyout(): void {
  closeMenu();
  if (outsideHandler) { document.removeEventListener('mousedown', outsideHandler); outsideHandler = null; }
  flyoutEl?.remove();
  flyoutEl = null;
}

function renderFlyoutList(): void {
  if (!flyoutEl || !appState) return;
  const list = flyoutEl.querySelector('#ts-list') as HTMLElement;
  const empty = flyoutEl.querySelector('#ts-empty') as HTMLElement;
  const q = (flyoutEl.querySelector('#ts-search') as HTMLInputElement).value.trim().toLowerCase();

  const styles = appState.textStyles.filter((s) => !q || s.name.toLowerCase().includes(q));
  const texts = selectedTextShapes(appState);
  const linkedIds = new Set(texts.map((s) => appState!.linkedStyleOf(s)?.id).filter(Boolean) as string[]);

  list.replaceChildren();
  empty.hidden = appState.textStyles.length > 0;

  for (const s of styles) {
    const p = s.props;
    const item = document.createElement('div');
    item.className = 'ts-item' + (linkedIds.has(s.id) ? ' active' : '');
    item.dataset.id = s.id;
    item.innerHTML = `
      ${CHECK}
      <span class="ts-item-body">
        <span class="ts-item-name"></span>
        <span class="ts-item-meta"></span>
      </span>
      <button class="ts-item-more" type="button" title="More">⋯</button>`;
    const nameEl = item.querySelector('.ts-item-name') as HTMLElement;
    nameEl.textContent = s.name;
    // Preview the style on the label via the CSSOM rather than an innerHTML
    // style="…" string. These props come from the document's own markup (a
    // shared/public board can carry hostile ones), and the setters silently drop
    // invalid values — so there's no attribute string to break out of.
    nameEl.style.fontFamily = p.fontFamily;
    nameEl.style.fontWeight = String(p.fontWeight);
    nameEl.style.fontStyle = p.fontStyle;
    nameEl.style.textTransform = p.textTransform && p.textTransform !== 'none' ? p.textTransform : 'none';
    (item.querySelector('.ts-item-meta') as HTMLElement).textContent =
      `${p.fontFamily} · ${p.fontWeight}${p.fontStyle === 'italic' ? ' Italic' : ''} · ${p.fontSize}`;
    item.addEventListener('click', (e) => {
      if ((e.target as Element).closest('.ts-item-more')) return;
      applyStyle(s.id);
    });
    item.querySelector('.ts-item-more')!.addEventListener('click', (e) => {
      e.stopPropagation();
      openItemMenu(s.id, e.currentTarget as HTMLElement);
    });
    list.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function applyStyle(id: string): void {
  if (!appState) return;
  const ids = selectedTextIds(appState);
  if (!ids.length) { showToast('Select a text object first.'); return; }
  const name = appState.getTextStyle(id)?.name ?? 'style';
  const affected = appState.applyTextStyle(id, ids);
  closeFlyout();
  if (affected.length) {
    pulseShapes(appState, affected);
    showToast(`Applied “${name}” to ${affected.length} object${plural(affected.length)}.`,
      8000, undefined, 'success'); // guarded by affected.length — always a real success
  }
}

async function createFromSelection(): Promise<void> {
  if (!appState) return;
  const ids = selectedTextIds(appState);
  if (!ids.length) { showToast('Select a text object first.'); return; }
  const suggested = `Style ${appState.textStyles.length + 1}`;
  closeFlyout();
  const name = await promptDialog({ title: 'New text style', label: 'Name', value: suggested, confirmText: 'Create' });
  if (!name) return;
  const style = appState.createTextStyleFromShapes(name, ids);
  if (style) showToast(`Created “${name}”.`, 8000, undefined, 'success');
}

function redefineFromSelection(id: string): void {
  if (!appState) return;
  const shape = selectedTextShapes(appState)[0];
  if (!shape) { showToast('Select a text object to update from.'); return; }
  const props = appState.readTextProps(shape);
  if (!props) return;
  const name = appState.getTextStyle(id)?.name ?? 'style';
  const affected = appState.redefineTextStyle(id, props);
  pulseShapes(appState, affected);
  showToast(`Updated “${name}” — ${affected.length} object${plural(affected.length)} changed.`,
    8000, undefined, affected.length > 0 ? 'success' : 'warning');
}

async function renameStyle(id: string): Promise<void> {
  if (!appState) return;
  const cur = appState.getTextStyle(id);
  if (!cur) return;
  const name = await promptDialog({ title: 'Rename style', label: 'Name', value: cur.name, confirmText: 'Rename' });
  if (name && name !== cur.name) appState.renameTextStyle(id, name);
}

async function deleteStyle(id: string): Promise<void> {
  if (!appState) return;
  const cur = appState.getTextStyle(id);
  if (!cur) return;
  const n = appState.shapesLinkedToStyle(id).length;
  const ok = await confirmDialog({
    title: `Delete “${cur.name}”?`,
    message: n ? `${n} text object${plural(n)} will keep their look but lose the link.` : 'This style isn’t used by any objects.',
    confirmText: 'Delete', danger: true,
  });
  if (ok) appState.removeTextStyle(id);
}

function resetSelectionToStyle(): void {
  if (!appState) return;
  const texts = selectedTextShapes(appState);
  const styleId = texts[0] && appState.linkedStyleOf(texts[0])?.id;
  if (!styleId) return;
  const ids = texts.filter((s) => appState!.linkedStyleOf(s)?.id === styleId).map((s) => s.id);
  const affected = appState.applyTextStyle(styleId, ids);
  pulseShapes(appState, affected);
  const name = appState.getTextStyle(styleId)?.name ?? 'style';
  showToast(`Reset ${affected.length} object${plural(affected.length)} to “${name}”.`,
    8000, undefined, affected.length > 0 ? 'success' : 'warning');
}

// ---------------------------------------------------------------------------
// Per-item menu
// ---------------------------------------------------------------------------

let menuEl: HTMLElement | null = null;
function closeMenu(): void { menuEl?.remove(); menuEl = null; }

function openItemMenu(id: string, anchor: HTMLElement): void {
  closeMenu();
  if (!appState) return;
  const hasSelection = selectedTextShapes(appState).length > 0;
  menuEl = document.createElement('div');
  menuEl.className = 'ts-menu';
  const items: Array<{ label: string; run: () => void; disabled?: boolean; danger?: boolean }> = [
    { label: 'Update style from selection', run: () => redefineFromSelection(id), disabled: !hasSelection },
    { label: 'Rename…', run: () => void renameStyle(id) },
    { label: 'Delete', run: () => void deleteStyle(id), danger: true },
  ];
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'ts-menu-item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    if (!it.disabled) b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); closeFlyout(); it.run(); });
    menuEl.appendChild(b);
  }
  document.body.appendChild(menuEl);
  const r = anchor.getBoundingClientRect();
  const mw = 172;
  menuEl.style.left = `${Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8))}px`;
  menuEl.style.top = `${r.bottom + 4}px`;
}
