/**
 * Library panel — the unified home for reusable assets (text styles, and — as
 * their adapters land — palettes, components, effect & paint styles). It lives in
 * the left dock stacked under Layers (two independently-collapsible panels sharing
 * the column via a draggable divider), with search and one collapsible section per
 * asset type. The panel is type-agnostic: it iterates the adapter registry
 * (ui/library-adapters.ts) and speaks the uniform LibraryAsset envelope.
 *
 * Assets live INSIDE the document (core/library.ts), so a file never depends on
 * anything outside itself to open.
 */

import type { AppState } from '../core/state';
import type { LibraryAsset, AssetType } from '../core/library';
import { assetAdapters, registerBuiltinAdapters, type AssetAdapter } from './library-adapters';
import { promptDialog, confirmDialog } from './dialogs';
import { setFocusedStyle, getFocusedStyle, setupStylePanel, updateStylePanel } from './style-panel';
import { showContextMenu, beginInlineRename } from './panel-helpers';
import { openModal } from './modal';
import { showToast } from './toast';
import { pulseShapes, animateExpand } from './feedback';


let appState: AppState | null = null;
let query = '';
/** Folders the user has collapsed, keyed `${assetType}/${group}`. */
const collapsedFolders = new Set<string>();
/** Per-type section open/closed, remembered for the session — but only once the
 *  user has actually toggled it (sectionPinned); otherwise the default follows
 *  whether the section has any rows. */
const sectionState = new Map<string, boolean>();
const sectionPinned = new Set<string>();

// The left dock stacks two independent, collapsible panels — Layers over Library —
// sharing the column via a draggable divider (dockSplit = Layers' share, 0–1). Each
// panel's collapsed state and the divider position persist.
let dockSplit = 0.55;
const DOCK_SPLIT_KEY = 'bq-dock-split';
const LAYERS_COLLAPSED_KEY = 'bq-dock-layers-collapsed';
const LIBRARY_COLLAPSED_KEY = 'bq-dock-library-collapsed';

function persistDock(): void {
  try {
    localStorage.setItem(DOCK_SPLIT_KEY, String(dockSplit));
    localStorage.setItem(LAYERS_COLLAPSED_KEY, isCollapsed('panel-layers') ? '1' : '0');
    localStorage.setItem(LIBRARY_COLLAPSED_KEY, isCollapsed('panel-library') ? '1' : '0');
  } catch { /* storage unavailable — just won't persist */ }
}

function isCollapsed(id: string): boolean {
  return !!document.getElementById(id)?.classList.contains('collapsed');
}
function libraryOpen(): boolean {
  return !!document.getElementById('panel-library') && !isCollapsed('panel-library');
}

/** Push dockSplit into the CSS flex-grow vars the stacked layout reads. */
function applyDockSplit(): void {
  const lp = document.getElementById('left-panel');
  if (!lp) return;
  lp.style.setProperty('--dock-a', String(Math.round(dockSplit * 100)));
  lp.style.setProperty('--dock-b', String(Math.round((1 - dockSplit) * 100)));
}

/** Dragging is meaningless when either panel is collapsed to just its header, so
 *  the divider drops its grab handle then — but KEEPS its box. It is the only
 *  thing separating the two panels (#left-panel is a flex column with no gap and
 *  .panel has no margin), so removing it from layout fused Layers and Library
 *  into one slab. Note `inert`, not `hidden`: the global `.hidden` rule is
 *  `display: none !important`, which no amount of specificity here can walk back. */
function updateDivider(): void {
  const d = document.getElementById('left-dock-divider');
  if (!d) return;
  const off = isCollapsed('panel-layers') || isCollapsed('panel-library');
  d.classList.toggle('inert', off);
  // Purely a spacer once it can't be dragged — don't offer it to assistive tech.
  if (off) d.setAttribute('aria-hidden', 'true');
  else d.removeAttribute('aria-hidden');
}

/** Expand the Library panel if collapsed — used when an action should surface it
 *  (e.g. just saved an asset). No-op when it's already open. */
function ensureLibraryExpanded(): void {
  const panel = document.getElementById('panel-library');
  if (panel?.classList.contains('collapsed')) { panel.classList.remove('collapsed'); animateExpand(panel); }
}

function injectStyles(): void {
  if (document.getElementById('lib-styles')) return;
  const el = document.createElement('style');
  el.id = 'lib-styles';
  el.textContent = `
/* Left dock = two stacked, independently-collapsible panels (Layers over Library),
   sharing the column height via flex-grow (--dock-a / --dock-b), each scrolling
   internally. A collapsed panel shrinks to just its header; the other fills. */
#left-panel > #panel-layers,
#left-panel > #panel-library { display: flex !important; flex-direction: column; min-height: 34px; }
#left-panel > #panel-layers  { flex: var(--dock-a, 55) 1 0; }
#left-panel > #panel-library { flex: var(--dock-b, 45) 1 0; }
/* Must repeat both ids: "#left-panel > .panel.collapsed" is one id + two classes,
   which LOSES to the two-id rules above, so a collapsed panel kept its flex-grow
   and stayed full height — a header with a dead slab under it, and the sibling
   never reclaimed the space. */
#left-panel > #panel-layers.collapsed,
#left-panel > #panel-library.collapsed { flex: 0 0 auto; }
#left-panel .panel-body, #left-panel .panel-body-layers { min-height: 0; overflow-y: auto; }
/* A collapsed panel hides its body. Needs id-level specificity to beat the
   #panel-library .panel-body { display:flex } layout rule below. */
#left-panel > .panel.collapsed .panel-body,
#left-panel > .panel.collapsed .panel-body-layers { display: none; }

#panel-library .panel-body { display: flex; flex-direction: column; min-height: 0; padding: 0; }
.lib-toolbar { display: flex; flex-direction: column; gap: 8px; padding: 8px; flex: 0 0 auto; }
.lib-search-row { display: flex; gap: 6px; }
.lib-search {
  flex: 1; min-width: 0; padding: 6px 8px; border-radius: 5px; font-size: 12px; outline: none;
  background: var(--ai-input, #1a1d24); border: 1px solid var(--ai-border, #2d313b); color: var(--ai-text, #e6e8ec);
}
.lib-search:focus { border-color: var(--ai-accent, #4d7cfe); }
.lib-add {
  flex: 0 0 auto; width: 30px; border-radius: 5px; cursor: pointer; font-size: 16px; line-height: 1;
  background: var(--ai-input, #1a1d24); border: 1px solid var(--ai-border-light, #3b414f); color: var(--ai-text, #e6e8ec);
}
.lib-add:hover { border-color: var(--ai-accent, #4d7cfe); }
.lib-add:disabled { opacity: 0.4; cursor: default; }

.lib-sections { overflow-y: auto; flex: 1; min-height: 0; padding: 0 6px 8px; }
.lib-section { margin-top: 6px; }
.lib-section-head {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 6px; cursor: pointer;
  background: transparent; border: none; text-align: left; border-radius: 5px;
  font-size: 10px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--ai-text-dim, #8b929e);
}
.lib-section-head:hover { background: var(--ai-hover, #2a3040); color: var(--ai-text, #e6e8ec); }
.lib-section-head:focus-visible { outline: 2px solid var(--ai-accent, #4d7cfe); outline-offset: -2px; }
.lib-section-head .lib-section-count { margin-left: auto; }
.lib-section-caret { width: 9px; flex: 0 0 auto; font-size: 8px; }
.lib-section-count { opacity: 0.7; }
.lib-empty { padding: 8px 6px; color: var(--ai-text-dim, #8b929e); font-style: italic; font-size: 11.5px; }

/* Playful reveal when a section is opened via a "Browse …" door (patterns, etc.):
   the section springs in, rows stagger up, an empty hint bounces, and + pulses. */
@keyframes lib-reveal-kf { 0% { transform: scale(0.98); opacity: 0.55; } 60% { transform: scale(1.008); } 100% { transform: scale(1); opacity: 1; } }
.lib-section.lib-reveal { animation: lib-reveal-kf 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); }
@keyframes lib-row-in-kf { 0% { opacity: 0; transform: translateY(7px) scale(0.98); } 100% { opacity: 1; transform: none; } }
.lib-row-in { animation: lib-row-in-kf 0.34s cubic-bezier(0.34, 1.56, 0.64, 1) both; animation-delay: calc(var(--i, 0) * 45ms); }
@keyframes lib-empty-in-kf { 0% { opacity: 0; transform: translateY(7px); } 55% { transform: translateY(-2px); } 100% { opacity: 1; transform: none; } }
.lib-empty-in { animation: lib-empty-in-kf 0.46s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
@keyframes lib-add-attn { 0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(77,124,254,0); } 30% { transform: scale(1.18); box-shadow: 0 0 0 4px rgba(77,124,254,0.28); } 62% { transform: scale(1); } }
.lib-add-attention { animation: lib-add-attn 0.7s ease-in-out 2; border-color: var(--ai-accent, #4d7cfe) !important; }
@media (prefers-reduced-motion: reduce) {
  .lib-section.lib-reveal, .lib-row-in, .lib-empty-in, .lib-add-attention { animation: none; }
}

.lib-row {
  position: relative; display: flex; align-items: center; gap: 9px; padding: 6px 8px;
  border-radius: 6px; cursor: pointer;
}
.lib-row:hover { background: var(--ai-hover, #2a3040); }
.lib-row.active { background: var(--ai-accent-dim, #3a5ad4); }
.lib-preview {
  flex: 0 0 auto; width: 30px; height: 24px; display: grid; place-items: center; border-radius: 4px;
  background: var(--ai-input, #1a1d24); border: 1px solid var(--ai-border, #2d313b);
  overflow: hidden; font-size: 13px; color: var(--ai-text, #e6e8ec);
}
.lib-preview-swatches { display: flex; width: 100%; height: 100%; }
.lib-preview-swatch { flex: 1; }
.lib-row-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.lib-row-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--ai-text, #e6e8ec); }
.lib-row-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--ai-text-dim, #8b929e); }
.lib-row.active .lib-row-meta { color: rgba(255,255,255,0.75); }
.lib-row-more {
  flex: 0 0 auto; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 4px;
  background: transparent; border: none; color: var(--ai-text-dim, #8b929e); cursor: pointer; opacity: 0; font-size: 15px;
}
.lib-row:hover .lib-row-more, .lib-row.active .lib-row-more,
.lib-row-more:focus-visible { opacity: 1; }
.lib-row-more:focus-visible, .lib-row:focus-visible {
  outline: 2px solid var(--ai-accent, #4d7cfe); outline-offset: -2px;
}
/* Focus is not signalled by colour alone: the focused row also gets a marker bar. */
.lib-row:focus-visible::before {
  content: ''; position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px;
  border-radius: 2px; background: var(--ai-accent, #4d7cfe);
}
.lib-row-more:hover { background: rgba(255,255,255,0.12); color: var(--ai-text, #e6e8ec); }

.lib-folder { margin: 2px 0; }
.lib-folder-head {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 6px;
  background: transparent; border: none; border-radius: 5px; cursor: pointer;
  color: var(--ai-text-dim, #8b929e); font-size: 11.5px; text-align: left;
}
.lib-folder-head:hover { background: var(--ai-hover, #2a3040); color: var(--ai-text, #e6e8ec); }
.lib-folder-head:focus-visible { outline: 2px solid var(--ai-accent, #4d7cfe); outline-offset: -2px; }
.lib-folder-caret { width: 10px; flex: 0 0 auto; font-size: 9px; }
.lib-folder-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-folder-body { padding-left: 10px; }
.lib-notice-sub { margin-top: 4px; font-size: 11px; opacity: 0.75; }
.lib-notice { padding: 16px 12px; text-align: center; color: var(--ai-text-dim, #8b929e); font-size: 12px; line-height: 1.5; }

/* ---- Divider between the two stacked panels ---- */
#left-dock-divider { flex: 0 0 auto; height: 8px; margin: 1px 0; cursor: row-resize; position: relative; }
/* Collapsed: keep the 10px of separation, drop only the affordance. */
#left-dock-divider.inert { cursor: default; pointer-events: none; }
#left-dock-divider.inert::before { display: none; }
#left-dock-divider::before {
  content: ''; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: 28px; height: 2px; border-radius: 1px; background: var(--ai-border, #2d313b); transition: background 0.12s, width 0.12s;
}
#left-dock-divider:hover::before, #left-dock-divider.dragging::before { background: var(--ai-accent, #4d7cfe); width: 44px; }
`;
  document.head.appendChild(el);
}

const plural = (n: number): string => (n === 1 ? '' : 's');

export function setupLibrary(state: AppState): void {
  appState = state;
  registerBuiltinAdapters();
  injectStyles();

  // The Style panel edits whatever row is focused here; route its actions back
  // through this panel so applying keeps the shared toast/pulse behaviour.
  setupStylePanel({
    apply: (type, id) => {
      const ad = assetAdapters().find((a) => a.type === type);
      const asset = ad && appState ? ad.listDocument(appState).find((x) => x.id === id) : undefined;
      if (ad && asset) applyDoc(ad, asset);
    },
    changed: () => { render(); if (appState) updateStylePanel(appState); },
  });

  const leftPanel = document.getElementById('left-panel');
  if (!leftPanel || document.getElementById('panel-library')) return;

  // The Library panel — a second collapsible panel stacked UNDER Layers in the dock.
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.id = 'panel-library';
  panel.innerHTML = `
    <div class="panel-header">
      <span>Library</span>
      <button class="panel-collapse" aria-label="Collapse Library">&#x25BC;</button>
    </div>
    <div class="panel-body">
      <div class="lib-toolbar">
        <div class="lib-search-row">
          <input class="lib-search" id="lib-search" type="text" placeholder="Search assets…" autocomplete="off" spellcheck="false" />
          <button class="lib-add" id="lib-add" type="button" title="Add selection to Library" aria-label="Add selection to Library">+</button>
        </div>
      </div>
      <div class="lib-sections" id="lib-sections"></div>
    </div>`;
  leftPanel.appendChild(panel);

  // Draggable divider between Layers (above) and Library (below). Insert after the
  // library panel is a child, positioned just before it.
  const divider = document.createElement('div');
  divider.id = 'left-dock-divider';
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', 'horizontal');
  divider.setAttribute('aria-label', 'Resize Layers / Library');
  leftPanel.insertBefore(divider, panel);
  setupDockDivider(divider);

  // The Library header collapses like any panel — but the app's generic collapse
  // wiring (main.ts) ran before this panel existed, so wire it here, matching that
  // behaviour: single-click the chevron, or double-click the bar (not its controls).
  const libHeader = panel.querySelector('.panel-header') as HTMLElement;
  const toggleLibrary = (): void => {
    const collapsed = panel.classList.toggle('collapsed');
    if (!collapsed) { animateExpand(panel); render(); } // populate on expand
  };
  libHeader.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.panel-collapse')) toggleLibrary();
  });
  libHeader.addEventListener('dblclick', (e) => {
    if ((e.target as Element).closest('button, input, select, textarea, [contenteditable]')) return;
    toggleLibrary();
  });

  const search = panel.querySelector('#lib-search') as HTMLInputElement;
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });
  (panel.querySelector('#lib-add') as HTMLButtonElement)
    .addEventListener('click', () => { if (appState) void openAddToLibraryDialog(appState); });

  // Restore each panel's collapsed state + the divider position, then reflect them.
  loadDockPrefs();
  applyDockSplit();
  updateDivider();
  if (libraryOpen()) render();

  // Keep the divider (shown only when both are open) and persistence in step whenever
  // EITHER panel collapses/expands — Layers via the app's generic wiring, Library via
  // ours. Attached after the initial restore so it doesn't churn during boot.
  const obs = new MutationObserver(() => { updateDivider(); persistDock(); });
  const layersPanel = document.getElementById('panel-layers');
  if (layersPanel) obs.observe(layersPanel, { attributes: true, attributeFilter: ['class'] });
  obs.observe(panel, { attributes: true, attributeFilter: ['class'] });
}

/** Restore dock prefs from storage and apply the collapsed classes. Library defaults
 *  to collapsed so a fresh dock still opens on just Layers. */
function loadDockPrefs(): void {
  let layersCollapsed = false, libraryCollapsed = true;
  try {
    const s = parseFloat(localStorage.getItem(DOCK_SPLIT_KEY) ?? '');
    if (isFinite(s) && s > 0.1 && s < 0.9) dockSplit = s;
    const lc = localStorage.getItem(LAYERS_COLLAPSED_KEY);
    if (lc != null) layersCollapsed = lc === '1';
    const rc = localStorage.getItem(LIBRARY_COLLAPSED_KEY);
    if (rc != null) libraryCollapsed = rc === '1';
  } catch { /* ignore */ }
  document.getElementById('panel-layers')?.classList.toggle('collapsed', layersCollapsed);
  document.getElementById('panel-library')?.classList.toggle('collapsed', libraryCollapsed);
}

/** Drag the divider to reallocate height between the stacked Layers/Library panels. */
function setupDockDivider(divider: HTMLElement): void {
  divider.addEventListener('pointerdown', (e) => {
    // The divider is hidden (display:none) when either panel is collapsed, so a
    // pointerdown here means both are open and the drag is meaningful.
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    divider.classList.add('dragging');
    const move = (ev: PointerEvent) => {
      const layers = document.getElementById('panel-layers');
      const library = document.getElementById('panel-library');
      if (!layers || !library) return;
      const top = layers.getBoundingClientRect().top;
      const bottom = library.getBoundingClientRect().bottom;
      const usable = bottom - top;
      if (usable <= 0) return;
      dockSplit = Math.max(0.15, Math.min(0.85, (ev.clientY - top) / usable));
      applyDockSplit();
    };
    const up = (ev: PointerEvent) => {
      divider.releasePointerCapture(ev.pointerId);
      divider.classList.remove('dragging');
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
      persistDock();
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
  });
}

/** Called from onStateChange; only re-renders when the Library panel is expanded. */
export function updateLibrary(state: AppState): void {
  appState = state;
  if (libraryOpen()) render();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(): void {
  const host = document.getElementById('lib-sections');
  if (!host || !appState) return;
  host.replaceChildren();

  // "Add" is enabled only when the selection can produce at least one asset type.
  const add = document.getElementById('lib-add') as HTMLButtonElement | null;
  if (add) add.disabled = !applicableAdapters(appState).length;

  let any = false;
  for (const adapter of assetAdapters()) {
    const section = renderSection(adapter);
    if (section) { host.appendChild(section); any = true; }
  }
  if (!any) {
    host.appendChild(notice('No assets in this document yet.\nSelect something and press + to save one.'));
  }
}

function renderSection(adapter: AssetAdapter): HTMLElement | null {
  if (!appState) return null;
  const rows = docRows(adapter);
  const filtered = rows.filter((r) => !query || r.name.toLowerCase().includes(query));
  if (query && !filtered.length) return null; // hide empty sections while searching

  const section = document.createElement('div');
  section.className = 'lib-section';
  section.dataset.assetType = adapter.type; // so revealLibrarySection can target + animate it
  // Each type section collapses, and remembers it. Six always-open sections in a
  // narrow column is a wall of rows; folding the types you aren't using is the
  // cheapest way to make the panel scannable. A section with nothing in it starts
  // folded, so an empty library reads as a short menu rather than a list of
  // "None yet" placeholders.
  const key = `sec:${adapter.type}`;
  // Default follows the CONTENT (open when it has rows), and only a deliberate
  // click pins it. Caching the default instead meant a section auto-folded while
  // empty stayed folded forever — so the asset you just saved was invisible.
  const open = sectionPinned.has(key) ? sectionState.get(key) === true : filtered.length > 0;

  const head = document.createElement('button');
  head.className = 'lib-section-head';
  head.type = 'button';
  head.setAttribute('aria-expanded', String(open));
  const caret = document.createElement('span');
  caret.className = 'lib-section-caret';
  caret.textContent = open ? '▾' : '▸';
  const title = document.createElement('span');
  title.textContent = adapter.labelPlural;
  const count = document.createElement('span');
  count.className = 'lib-section-count';
  count.textContent = String(filtered.length);
  head.append(caret, title, count);
  head.addEventListener('click', () => { sectionPinned.add(key); sectionState.set(key, !open); render(); });
  section.appendChild(head);
  if (!open) return section;   // header only

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'lib-empty';
    empty.textContent = `No ${adapter.labelPlural.toLowerCase()} yet — use + to add from your selection.`;
    section.appendChild(empty);
    return section;
  }

  // Sorted, and grouped into folders on "Group/Name" — the convention design
  // systems actually use (and what a paste from Figma looks like). Creation order
  // over a flat list stopped being readable at a few dozen styles.
  const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const loose: Row[] = [];
  const folders = new Map<string, Row[]>();
  for (const r of sorted) {
    const i = r.name.indexOf('/');
    const group = i > 0 ? r.name.slice(0, i).trim() : '';
    if (!group) { loose.push(r); continue; }
    // Show the leaf inside its folder; the full name stays for rename + tooltip.
    const nameEl = r.el.querySelector('.lib-row-name');
    if (nameEl) { nameEl.textContent = r.name.slice(i + 1).trim() || r.name; nameEl.setAttribute('title', r.name); }
    const list = folders.get(group);
    if (list) list.push(r); else folders.set(group, [r]);
  }

  for (const r of loose) section.appendChild(r.el);
  for (const [group, rows] of folders) section.appendChild(buildFolder(adapter, group, rows));
  return section;
}

/** A collapsible "Group/" folder inside a type section. */
function buildFolder(adapter: AssetAdapter, group: string, rows: Row[]): HTMLElement {
  const key = `${adapter.type}/${group}`;
  const wrap = document.createElement('div');
  wrap.className = 'lib-folder';
  const head = document.createElement('button');
  head.className = 'lib-folder-head';
  head.type = 'button';
  const caret = document.createElement('span');
  caret.className = 'lib-folder-caret';
  const label = document.createElement('span');
  label.className = 'lib-folder-name';
  label.textContent = group;
  const count = document.createElement('span');
  count.className = 'lib-section-count';
  count.textContent = String(rows.length);
  head.append(caret, label, count);
  const listEl = document.createElement('div');
  listEl.className = 'lib-folder-body';
  for (const r of rows) listEl.appendChild(r.el);

  const paint = (): void => {
    const open = !collapsedFolders.has(key);
    caret.textContent = open ? '▾' : '▸';
    listEl.style.display = open ? '' : 'none';
    head.setAttribute('aria-expanded', String(open));
    head.setAttribute('aria-label', `${group} — ${rows.length} item${rows.length === 1 ? '' : 's'}`);
  };
  head.addEventListener('click', () => {
    if (collapsedFolders.has(key)) collapsedFolders.delete(key); else collapsedFolders.add(key);
    paint();
  });
  paint();
  wrap.append(head, listEl);
  return wrap;
}

interface Row { name: string; el: HTMLElement; }

function docRows(adapter: AssetAdapter): Row[] {
  if (!appState) return [];
  const linked = adapter.linkedDocId?.(appState) ?? null;
  return adapter.listDocument(appState).map((asset) => ({
    name: asset.name,
    el: buildDocRow(adapter, asset, linked === asset.id),
  }));
}

function buildRowShell(adapter: AssetAdapter, name: string, payload: unknown, meta: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'lib-row';
  const preview = adapter.renderPreview({ name, payload });
  preview.classList.add('lib-preview');
  const body = document.createElement('div');
  body.className = 'lib-row-body';
  const nameEl = document.createElement('div');
  nameEl.className = 'lib-row-name';
  nameEl.textContent = name;
  const metaEl = document.createElement('div');
  metaEl.className = 'lib-row-meta';
  metaEl.textContent = meta;
  body.append(nameEl, metaEl);
  row.append(preview, body);
  return row;
}

function buildDocRow(adapter: AssetAdapter, asset: LibraryAsset, active: boolean): HTMLElement {
  const row = buildRowShell(adapter, asset.name, asset.payload, adapter.describe?.(asset.payload) ?? adapter.label);
  if (active) row.classList.add('active');
  const f = getFocusedStyle();
  if (f && f.type === adapter.type && f.id === asset.id) row.classList.add('lib-row-focused');

  const more = moreButton();
  row.appendChild(more);
  more.addEventListener('click', (e) => { e.stopPropagation(); openDocRowMenu(adapter, asset, more); });
  // Right-click anywhere on the row opens the same menu as the ⋯ button.
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    openDocRowMenu(adapter, asset, more, { x: e.clientX, y: e.clientY });
  });
  // Double-click the name to rename in place — same gesture as layers and tabs.
  wireInlineRename(row, asset.name, (newName) => {
    if (newName !== asset.name) adapter.renameDocument(appState!, asset.id, newName);
    render();
  });
  // Click APPLIES — the action a user repeats all day, one click, as in Figma /
  // Illustrator / Sketch. (This briefly became "focus for editing", which put the
  // rare action on the cheap gesture and the common one behind a cross-window trip.)
  row.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.lib-row-more') || (e.target as HTMLElement).tagName === 'INPUT') return;
    applyDoc(adapter, asset);
  });
  // Double-click the row BODY opens it in the live Style panel (double-clicking the
  // NAME renames, wired above and stopPropagation'd).
  row.addEventListener('dblclick', (e) => {
    if ((e.target as Element).closest('.lib-row-more, .lib-row-name')) return;
    if (!adapter.editFields) return; // no editor for this type — don't open a dead panel
    focusStyle(adapter, asset.id);
  });
  // Keyboard: rows were plain <div>s with no tabindex, so nothing here could be
  // reached — let alone applied — without a mouse.
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', `${asset.name} — ${adapter.label}`);
  row.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    // stopPropagation is NOT optional here: these keys are also global editor
    // shortcuts. Without it, Delete on a focused row deleted the selected ARTWORK
    // as well as opening this row's confirm dialog — even if you then cancelled.
    const handled = (): void => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Enter' || e.key === ' ') { handled(); applyDoc(adapter, asset); }
    else if (e.key === 'F2') { handled(); startRename(row, adapter, asset); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { handled(); void deleteDoc(adapter, asset); }
    else if (e.key === 'e' && !e.ctrlKey && !e.metaKey) { handled(); focusStyle(adapter, asset.id); }
  });
  return row;
}

/** Start the inline rename editor on a row (F2, and the name's double-click). */
function startRename(row: HTMLElement, adapter: AssetAdapter, asset: LibraryAsset): void {
  const nameEl = row.querySelector('.lib-row-name') as HTMLElement | null;
  if (!nameEl || !appState) return;
  beginInlineRename(nameEl, asset.name, (newName) => {
    if (newName !== asset.name) adapter.renameDocument(appState!, asset.id, newName);
    render();
  });
}

/** Double-click a row's name to rename it in place (the shared Layers/tabs inline
 *  editor). commit re-renders to restore the name span. */
function wireInlineRename(row: HTMLElement, current: string, commit: (name: string) => void): void {
  const nameEl = row.querySelector('.lib-row-name') as HTMLElement | null;
  if (!nameEl) return;
  nameEl.title = 'Double-click to rename';
  nameEl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation(); // don't let the dblclick reach the row (which would apply)
    beginInlineRename(nameEl, current, commit);
  });
}

function moreButton(): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'lib-row-more';
  b.type = 'button';
  b.title = 'More';
  b.setAttribute('aria-label', 'More actions for this asset');
  b.textContent = '⋯';
  return b;
}

function notice(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'lib-notice';
  el.textContent = text;
  return el;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function applyDoc(adapter: AssetAdapter, asset: LibraryAsset): void {
  if (!appState) return;
  const n = adapter.applyDocument(appState, asset.id);
  if (n > 0) {
    pulseShapes(appState, appState.getSelectedShapes().map((s) => s.id));
    showToast(adapter.successMessage?.(n) ?? `Applied “${asset.name}” to ${n} object${plural(n)}.`,
      8000, undefined, 'success');
  } else {
    showToast(`Select a compatible object, then apply “${asset.name}”.`);
  }
  // Applying isn't a document change the panel hears about, so refresh the rows and
  // the Style panel — otherwise it kept reading "No objects use this style yet"
  // at the same moment the toast said it had been applied to N of them.
  render();
  updateStylePanel(appState);
}

function openDocRowMenu(
  adapter: AssetAdapter, asset: LibraryAsset,
  anchor: HTMLElement, at?: { x: number; y: number },
): void {
  if (!appState) return;
  const r = anchor.getBoundingClientRect();
  const items = [
    { label: 'Apply to selection', action: () => applyDoc(adapter, asset) },
    // Linked types: edit the style's own values, redefine it from the selection
    // (both propagate to every object using it), and jump to those objects.
    // Gate on the capability, not on the field COUNT: types with a purpose-built
    // editor (gradient/pattern paints, palettes) return no flat fields, which used
    // to hide this item for exactly the types that most need it.
    ...(adapter.editFields
      ? [{ label: 'Edit style…', action: () => focusStyle(adapter, asset.id) }] : []),
    ...(adapter.redefineFromSelection
      ? [{ label: 'Update style from selection', action: () => redefineFromSelection(adapter, asset) }] : []),
    ...(adapter.linkAttr
      ? [{ label: 'Select objects using this style', action: () => selectUsingStyle(adapter, asset) }] : []),
    { label: 'Rename…', action: () => void renameDoc(adapter, asset) },
    { separator: true, label: '', action: () => {} },
    { label: 'Delete', action: () => void deleteDoc(adapter, asset), danger: true },
  ];
  showContextMenu(at?.x ?? r.left, at?.y ?? r.bottom + 4, items);
}

/**
 * Show a just-created asset where it lives and let the user name it immediately.
 *
 * A toast at the bottom of the screen told you something happened but not what or
 * where; and there was no chance to name the thing you'd just made. This switches
 * to the Library, scrolls the new row into view, and opens its inline rename with
 * the text selected — so "it went there, and it's called this" is one gesture.
 */
/**
 * Surface a type's section in the Library — the "go where these live" door used by
 * the paint editors, so browsing/applying patterns has ONE home instead of a second
 * picker duplicated inside the Fills popover. Optionally highlights one row.
 */
export function revealLibrarySection(type: AssetType, docId?: string): void {
  if (!appState) return;
  ensureLibraryExpanded();
  sectionPinned.add(`sec:${type}`);
  sectionState.set(`sec:${type}`, true);
  render();
  const adapter = assetAdapters().find((a) => a.type === type);
  const listed = adapter?.listDocument(appState) ?? [];
  // Callers may hand us either the ASSET id or the underlying def id (the paint
  // editor knows its <pattern>, not the library envelope wrapping it), so accept
  // both rather than silently failing to highlight anything.
  const asset = docId
    ? (listed.find((a) => a.id === docId)
      ?? listed.find((a) => (a.payload as { defId?: string } | undefined)?.defId === docId))
    : undefined;
  requestAnimationFrame(() => {
    // Playful reveal of the section every time the "Browse …" door is used — even
    // when empty, it bounces in and nudges toward + (Aaron-Iker-style; see MEMORY).
    playLibraryReveal(type);
    if (!asset) return;
    const row = Array.from(document.querySelectorAll<HTMLElement>('#lib-sections .lib-row'))
      .find((r) => r.querySelector('.lib-row-name')?.textContent === asset.name);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    row.classList.add('lib-row-new');
    setTimeout(() => row.classList.remove('lib-row-new'), 1200);
  });
}

/** Playful reveal of a just-opened Library section: the section springs in and its
 *  rows stagger up; if it's empty, the empty hint bounces in and the + button pulses
 *  to show where new assets come from. Honors prefers-reduced-motion via CSS. */
function playLibraryReveal(type: AssetType): void {
  const section = document.querySelector<HTMLElement>(`#lib-sections .lib-section[data-asset-type="${type}"]`);
  if (!section) return;
  section.classList.remove('lib-reveal'); void section.offsetWidth; section.classList.add('lib-reveal');
  const rows = section.querySelectorAll<HTMLElement>('.lib-row');
  rows.forEach((r, i) => { r.style.setProperty('--i', String(i)); r.classList.remove('lib-row-in'); void r.offsetWidth; r.classList.add('lib-row-in'); });
  section.querySelector('.lib-empty')?.classList.add('lib-empty-in');
  if (!rows.length) {
    const add = document.getElementById('lib-add');
    if (add) { add.classList.remove('lib-add-attention'); void add.offsetWidth; add.classList.add('lib-add-attention'); setTimeout(() => add.classList.remove('lib-add-attention'), 1700); }
  }
}

export function revealNewAsset(type: AssetType, docId: string): void {
  const adapter = assetAdapters().find((a) => a.type === type);
  if (!adapter || !appState) return;
  ensureLibraryExpanded();
  // Force this type's section open too — the panel being expanded isn't enough if
  // the user had folded the section the asset just landed in, and a row that isn't
  // rendered can't be revealed or renamed.
  sectionPinned.add(`sec:${type}`);
  sectionState.set(`sec:${type}`, true);
  render();
  const asset = adapter.listDocument(appState).find((a) => a.id === docId);
  if (!asset) return;

  // The row only exists after render(), and the panel may still be running its
  // expand animation, so retry across a few frames rather than assuming one.
  let tries = 0;
  const grab = (): void => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('#lib-sections .lib-row'));
    const row = rows.find((r) => r.querySelector('.lib-row-name')?.textContent === asset.name);
    if (!row) {
      if (++tries < 8) { requestAnimationFrame(grab); return; }
      showToast(`${adapter.label} “${asset.name}” added to the Library.`, 8000, undefined, 'success');
      return;
    }
    row.scrollIntoView({ block: 'nearest' });
    row.classList.add('lib-row-new');
    setTimeout(() => row.classList.remove('lib-row-new'), 1200);
    startRename(row, adapter, asset);
  };
  requestAnimationFrame(grab);
}

/** Open a style in the live Style panel. This replaced a modal property editor:
 *  the modal covered the canvas, so you couldn't see what a change did, and it
 *  offered nothing the modeless panel lacks. */
function focusStyle(adapter: AssetAdapter, docId: string): void {
  setFocusedStyle(adapter.type, docId);
  render();
  if (appState) updateStylePanel(appState);
}

/** Update a style's definition from the current selection, propagating to all
 *  linked objects. (Illustrator calls this "redefine"; the label follows Figma.) */
function redefineFromSelection(adapter: AssetAdapter, asset: LibraryAsset): void {
  if (!appState || !adapter.redefineFromSelection) return;
  const n = adapter.redefineFromSelection(appState, asset.id);
  render();
  showToast(n > 0
    ? `Updated “${asset.name}” — ${n} object${plural(n)} changed.`
    : `Select an object with the values you want, then update “${asset.name}”.`,
    8000, undefined, n > 0 ? 'success' : 'warning');
}

/** Select every object linked to a style (its data-* link attribute). */
function selectUsingStyle(adapter: AssetAdapter, asset: LibraryAsset): void {
  if (!appState || !adapter.linkAttr) return;
  const ids = appState.shapesWithStyleLink(adapter.linkAttr, asset.id).map((s) => s.id);
  if (!ids.length) { showToast(`No objects are using “${asset.name}”.`); return; }
  appState.selectMultiple(ids);
  showToast(`Selected ${ids.length} object${plural(ids.length)} using “${asset.name}”.`, 8000, undefined, 'success');
}

async function renameDoc(adapter: AssetAdapter, asset: LibraryAsset): Promise<void> {
  if (!appState) return;
  const name = await promptDialog({ title: 'Rename asset', label: 'Name', value: asset.name, confirmText: 'Rename' });
  if (name && name !== asset.name) { adapter.renameDocument(appState, asset.id, name); render(); }
}

async function deleteDoc(adapter: AssetAdapter, asset: LibraryAsset): Promise<void> {
  if (!appState) return;
  // Per-type consequence — the old blanket line ("objects keep their look but lose
  // the link") was wrong for every type: paint/effect used to KEEP the dead link,
  // and deleting a component changes its instances.
  const using = adapter.linkAttr && appState
    ? appState.shapesWithStyleLink(adapter.linkAttr, asset.id).length : 0;
  const message = adapter.type === 'component'
    ? 'Any instances of it are turned back into ordinary shapes, so your artwork is kept.'
    : using
      ? `${using} object${plural(using)} using it keep${using === 1 ? 's' : ''} its look but lose${using === 1 ? 's' : ''} the link.`
      : 'Nothing in this document is using it.';
  const ok = await confirmDialog({
    title: `Delete “${asset.name}”?`,
    message,
    confirmText: 'Delete', danger: true,
  });
  if (ok) { adapter.removeDocument(appState, asset.id); render(); }
}

// ---------------------------------------------------------------------------
// Add-to-Library dialog (also invoked by the library.add-from-selection command)
// ---------------------------------------------------------------------------

function applicableAdapters(state: AppState): AssetAdapter[] {
  return assetAdapters().filter((a) => a.capture(state) !== null);
}

/** Open the "Add to Library" dialog for the current selection. Exported so the
 *  command in commands.ts drives the exact same flow as the panel's + button. */
export async function openAddToLibraryDialog(state: AppState): Promise<void> {
  appState = state;
  const applicable = applicableAdapters(state);
  if (!applicable.length) { showToast('Select an object to save to the Library.'); return; }

  const result = await addDialog(applicable, state);
  if (!result) return;
  const { adapter, name } = result;

  const docId = adapter.createFromSelection(state, name);
  if (!docId) { showToast('Couldn’t create that asset from the selection.'); return; }

  showToast(`Saved “${name}” to this document.`, 8000, undefined, 'success');
  // Surface it where the user just saved it.
  ensureLibraryExpanded();
  render();
}

interface AddResult { adapter: AssetAdapter; name: string; }

function addDialog(applicable: AssetAdapter[], state: AppState): Promise<AddResult | null> {
  return new Promise((resolve) => {
    let done = false;
    let chosenType = applicable[0].type;
    const finish = (v: AddResult | null) => { if (done) return; done = true; handle?.close(); resolve(v); };

    const handle = openModal({ id: 'lib-add-dialog', ariaLabel: 'Add to Library', dialogClass: 'dlg', closeButton: false, onClose: () => finish(null) });
    if (!handle) { resolve(null); return; }

    const head = document.createElement('div');
    head.className = 'dlg-head';
    head.innerHTML = `<h2 class="dlg-title">Add to Library</h2>`;
    handle.dialog.appendChild(head);

    const body = document.createElement('div');
    body.className = 'dlg-body';

    // Name.
    const nameWrap = field(body, 'Name');
    const nameEl = document.createElement('input');
    nameEl.className = 'dlg-input';
    nameEl.type = 'text';
    const adapterOf = (t: string) => applicable.find((a) => a.type === t)!;
    nameEl.value = adapterOf(chosenType).capture(state)?.name ?? 'Asset';
    nameEl.autocomplete = 'off';
    nameEl.spellcheck = false;
    nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    nameWrap.appendChild(nameEl);

    // Type (only when the selection can produce more than one).
    if (applicable.length > 1) {
      const typeWrap = field(body, 'Save as');
      const seg = segmented(applicable.map((a) => ({ val: a.type, label: a.label })), () => chosenType, (v) => {
        chosenType = v as typeof chosenType;
        // Refresh the suggested name for the newly chosen type.
        nameEl.value = adapterOf(chosenType).capture(state)?.name ?? nameEl.value;
      });
      typeWrap.appendChild(seg);
    }

    handle.dialog.appendChild(body);

    const foot = document.createElement('div');
    foot.className = 'dlg-foot';
    const cancel = document.createElement('button');
    cancel.className = 'dlg-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => finish(null));
    const ok = document.createElement('button');
    ok.className = 'dlg-btn dlg-btn-primary';
    ok.textContent = 'Save';
    const submit = () => finish({ adapter: adapterOf(chosenType), name: nameEl.value.trim() || 'Asset' });
    ok.addEventListener('click', submit);
    foot.append(cancel, ok);
    handle.dialog.appendChild(foot);

    queueMicrotask(() => { nameEl.focus(); nameEl.select(); });
  });
}

function field(body: HTMLElement, labelText: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'dlg-field';
  const l = document.createElement('label');
  l.className = 'dlg-label';
  l.textContent = labelText;
  wrap.appendChild(l);
  body.appendChild(wrap);
  return wrap;
}

function segmented(
  options: { val: string; label: string; hint?: string; disabled?: boolean }[],
  getCurrent: () => string,
  set: (v: string) => void,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'dlg-seg';
  for (const o of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dlg-seg-btn' + (o.val === getCurrent() ? ' active' : '');
    b.innerHTML = `<span class="dlg-seg-label">${o.label}</span>${o.hint ? `<span class="dlg-seg-hint">${o.hint}</span>` : ''}`;
    if (o.disabled) { b.disabled = true; b.style.opacity = '0.45'; b.style.cursor = 'default'; }
    else b.addEventListener('click', () => { set(o.val); el.querySelectorAll('.dlg-seg-btn').forEach((x) => x.classList.toggle('active', x === b)); });
    el.appendChild(b);
  }
  return el;
}
