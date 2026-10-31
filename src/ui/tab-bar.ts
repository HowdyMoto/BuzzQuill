/**
 * Document tabs. Unsplit, they render as one row in the top bar (#tab-list). When
 * the workspace is split into two editor groups, each group's tabs render in their
 * own strip directly above that group's canvas (#tabs-group-0 / #tabs-group-1).
 *
 * Click a tab to focus it (making its group live); double-click to rename; drag to
 * reorder within a strip OR across the divider to move it to the other group; × to
 * close (confirm when dirty); + for a new document (per group when split). Dragging
 * a tab onto the right half of an unsplit canvas creates the second group.
 */

import type { DocumentManager } from '../core/document-manager';
import { beginInlineRename } from './panel-helpers';
import { getDocSource } from '../core/doc-source';

// Tab identity glyphs: a page (local file) and a Drive-style triangle (Google Drive).
const DRIVE_ICON = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 4h7l5.5 10-3.5 6H6.5L3 14z"/><path d="M8.5 4 12 10.3M20.5 14H3M15.5 4 12 10.3 8.5 16.3"/></svg>';
const LOCAL_ICON = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M13 3.5H6.5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9z"/><path d="M13 3.5V9h5.5"/></svg>';

let docs: DocumentManager | null = null;
let draggedTabId: string | null = null;
// Set while a tab is dragged over the right half of an unsplit canvas: on drop the
// tab opens as a second editor group. Decided on dragEND (which always fires),
// not the canvas `drop` event — dropping onto a large non-list element doesn't
// reliably fire `drop`, whereas a document-level dragover reliably tracks position.
let splitIntent = false;
// Which tabs should play the enter animation. A freshly-created tab (File ▸ New,
// or the blank that replaces a closed last tab) is added here the first render it
// appears and stays until a timer clears it — NOT until the next render, because
// one action can render the bar several times in a tick (e.g. clearAll fires a
// render, then DocumentManager.onChange fires another); a render-diff would strip
// the class on that second pass and the animation would never play.
let knownTabIds = new Set<string>();
const enteringTabIds = new Set<string>();
let firstTabRender = true;
const TAB_ENTER_MS = 280; // ≥ the .tab-enter animation (240ms) + slack

export function setupTabBar(dm: DocumentManager): void {
  docs = dm;
  document.getElementById('tab-new')?.addEventListener('click', () => dm.newTab(0));

  // Per-pane "+" (new document in that editor group) and pane strips as drop targets
  // for a tab dragged from the other group (dropped on empty strip space → appended).
  document.querySelectorAll<HTMLButtonElement>('.pane-tab-new').forEach(btn => {
    btn.addEventListener('click', () => dm.newTab(groupAttr(btn)));
  });
  for (const g of [0, 1] as const) {
    const strip = document.getElementById(`tabs-group-${g}`);
    if (!strip) continue;
    strip.addEventListener('dragover', (e) => {
      if (!draggedTabId) return;
      e.preventDefault();
      strip.classList.add('drop-target');
    });
    strip.addEventListener('dragleave', (e) => {
      // Ignore dragleave bubbling up from child tabs still inside the strip.
      if (strip.contains(e.relatedTarget as Node)) return;
      strip.classList.remove('drop-target');
    });
    strip.addEventListener('drop', (e) => {
      e.preventDefault();
      strip.classList.remove('drop-target');
      if (draggedTabId) dm.moveTabToGroup(draggedTabId, g, null, false);
      draggedTabId = null;
    });
  }

  setupCanvasSplitDrop(dm);
  // Re-tint tabs when category colours load or change.
  renderTabBar();
}

function groupAttr(el: HTMLElement): 0 | 1 { return el.dataset.group === '1' ? 1 : 0; }

/** Drag a tab over the right half of an UNSPLIT canvas to open it as a second
 *  editor group. A document-level dragover tracks the pointer and lights up the
 *  right half; the split itself happens on the tab's dragend (see finishTabDrag),
 *  because the canvas `drop` event doesn't fire reliably for a large non-list drop
 *  target. Needs ≥2 tabs so the left pane isn't left empty. */
function setupCanvasSplitDrop(dm: DocumentManager): void {
  const canvas = document.getElementById('canvas-area');
  if (!canvas) return;
  document.addEventListener('dragover', (e) => {
    if (!draggedTabId) return;
    const r = canvas.getBoundingClientRect();
    const overRight = !dm.splitOn && dm.tabsInGroup(0).length >= 2
      && e.clientX > r.left + r.width * 0.55 && e.clientX <= r.right
      && e.clientY >= r.top && e.clientY <= r.bottom;
    splitIntent = overRight;
    canvas.classList.toggle('split-drop-hint', overRight);
    if (overRight) e.preventDefault(); // show the copy/move cursor over the drop zone
  });
}

/** End of a tab drag: if it finished over the split drop-zone, open the second
 *  group. Runs on dragend, which always fires — after any strip/tab drop that may
 *  have already handled the move (in which case draggedTabId is cleared and this
 *  is a no-op). */
function finishTabDrag(): void {
  if (splitIntent && draggedTabId && docs) docs.moveTabToGroup(draggedTabId, 1, null, false);
  splitIntent = false;
  draggedTabId = null;
  clearDropMarks(document);
}

function clearDropMarks(root: ParentNode): void {
  root.querySelectorAll('.doc-tab').forEach(el =>
    el.classList.remove('doc-tab-dragging', 'drop-before', 'drop-after'));
  document.querySelectorAll('.pane-tabs, #canvas-area').forEach(el =>
    el.classList.remove('drop-target', 'split-drop-hint'));
}

/** Which side of the target tab the pointer is on (→ insert after vs before). */
function isAfter(e: DragEvent, tab: HTMLElement): boolean {
  const r = tab.getBoundingClientRect();
  return (e.clientX - r.left) > r.width / 2;
}

/** Build one tab button. `selected` = the tab its group is currently showing. */
function buildTab(t: import('../core/document-manager').DocTab, selected: boolean): HTMLButtonElement {
  const d = docs!;
  const tab = document.createElement('button');
  tab.className = 'doc-tab' + (selected ? ' active' : '') + (enteringTabIds.has(t.id) ? ' tab-enter' : '');
  tab.dataset.tabId = t.id;
  tab.draggable = true;
  tab.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return; // mid-rename
    d.focusTab(t.id);
  });

  // Identity badge: where does this doc live? (A blank or never-saved tab has no
  // source and gets no badge.) The ACTIVE tab's live source is the doc-source
  // singleton (its DocTab cache is only refreshed on switch-away); inactive tabs
  // use their cached source.
  const active = t.id === d.activeId;
  const source = active ? getDocSource() : t.source;
  if (source?.kind === 'local') {
    const badge = document.createElement('span');
    badge.className = 'doc-tab-badge local';
    badge.innerHTML = LOCAL_ICON;
    badge.title = 'Local file';
    tab.appendChild(badge);
  } else if (source?.kind === 'drive') {
    const badge = document.createElement('span');
    badge.className = 'doc-tab-badge drive';
    badge.innerHTML = DRIVE_ICON;
    badge.title = `Google Drive · ${source.name}`;
    tab.appendChild(badge);
  }

  if (t.dirty) {
    const dot = document.createElement('span');
    dot.className = 'doc-tab-dirty';
    dot.textContent = '•';
    tab.appendChild(dot);
  }
  const name = document.createElement('span');
  name.className = 'doc-tab-name';
  name.textContent = t.title;
  tab.appendChild(name);

  // Double-click to rename in place (reuses the Layers-panel inline editor). The
  // single-click that precedes a dblclick may switch tabs and re-render the bar, so
  // target the LIVE name element by id rather than this (possibly stale) one.
  tab.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const liveName = document.querySelector(`.doc-tab[data-tab-id="${t.id}"] .doc-tab-name`) as HTMLElement | null;
    if (!liveName) return;
    beginInlineRename(liveName, t.title, (newName) => {
      d.renameTab(t.id, newName);
      renderTabBar(); // restore the name span (also handles a no-op rename that didn't re-render)
    });
  });

  // Every tab is closable — closing the last one swaps in a fresh blank doc
  // (see DocumentManager.closeTab), so the editor is never left tab-less.
  const close = document.createElement('button');
  close.className = 'doc-tab-close';
  close.textContent = '×';
  close.title = 'Close';
  close.draggable = false; // don't start a tab drag from the × button
  close.addEventListener('click', (e) => { e.stopPropagation(); requestClose(t.id); });
  tab.appendChild(close);

  // Drag to reorder (same strip) or to move across the divider (other group).
  tab.addEventListener('dragstart', (e) => {
    draggedTabId = t.id;
    e.dataTransfer!.effectAllowed = 'move';
    tab.classList.add('doc-tab-dragging');
  });
  tab.addEventListener('dragend', () => finishTabDrag());
  tab.addEventListener('dragover', (e) => {
    if (!draggedTabId || draggedTabId === t.id) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    const after = isAfter(e, tab);
    tab.classList.toggle('drop-after', after);
    tab.classList.toggle('drop-before', !after);
  });
  tab.addEventListener('dragleave', () => tab.classList.remove('drop-before', 'drop-after'));
  tab.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation(); // don't also trigger the strip's append-drop
    if (draggedTabId && draggedTabId !== t.id) {
      const after = isAfter(e, tab);
      const sameGroup = d.tabsInGroup(t.group).some(x => x.id === draggedTabId);
      if (sameGroup) d.reorderTab(draggedTabId, t.id, after);   // pure reorder, focus unchanged
      else d.moveTabToGroup(draggedTabId, t.group, t.id, after); // cross-pane move, focuses it
    }
    draggedTabId = null;
  });

  return tab;
}

function renderInto(container: Element | null, tabs: import('../core/document-manager').DocTab[]): void {
  if (!container) return;
  container.innerHTML = '';
  const shownFocused = docs!.activeId;
  for (const t of tabs) {
    const selected = t.id === (t.group === docs!.focusedGroup ? shownFocused : docs!.shownInGroup(t.group));
    container.appendChild(buildTab(t, selected));
  }
}

export function renderTabBar(): void {
  if (!docs) return;
  docs.refreshActive();
  const split = docs.splitOn;

  const topList = document.getElementById('tab-list');
  const strip0 = document.getElementById('tabs-group-0');
  const strip1 = document.getElementById('tabs-group-1');
  if (!topList) return;

  // Flag genuinely-new tabs for the enter animation (skip the boot render so
  // existing tabs don't all animate on load). Cleared by a timer, not by the next
  // render — see the note on enteringTabIds.
  const currentIds = docs.tabs.map(t => t.id);
  if (!firstTabRender) {
    for (const id of currentIds) {
      if (!knownTabIds.has(id) && !enteringTabIds.has(id)) {
        enteringTabIds.add(id);
        window.setTimeout(() => { enteringTabIds.delete(id); }, TAB_ENTER_MS);
      }
    }
  }
  for (const id of [...enteringTabIds]) if (!currentIds.includes(id)) enteringTabIds.delete(id);

  // Show/highlight the per-pane strips only when split; the top bar carries the
  // single tab row otherwise.
  if (strip0) { strip0.hidden = !split; strip0.classList.toggle('focused', split && docs.focusedGroup === 0); }
  if (strip1) { strip1.hidden = !split; strip1.classList.toggle('focused', split && docs.focusedGroup === 1); }

  if (!split) {
    renderInto(topList, docs.tabs);
  } else {
    topList.innerHTML = '';
    renderInto(strip0?.querySelector('.pane-tab-list') ?? null, docs.tabsInGroup(0));
    renderInto(strip1?.querySelector('.pane-tab-list') ?? null, docs.tabsInGroup(1));
  }

  knownTabIds = new Set(currentIds);
  firstTabRender = false;
}

/** Close a tab through the same guard the × button uses (confirming when the
 *  close would discard the only copy of real work). Exported so the Close Tab
 *  COMMAND can't diverge from the mouse path — #197. */
export function requestCloseTab(id: string): void { requestClose(id); }

function requestClose(id: string): void {
  if (!docs) return;
  const t = docs.tabs.find(x => x.id === id);
  if (!t) return;
  // Prompt not just on dirty, but whenever closing would discard the only copy of
  // real work — including a session-restored tab that has no file to go back to (#178).
  if (docs.closeWouldLoseWork(id) && !confirm('Close this document? Unsaved changes will be lost.')) return;
  docs.closeTab(id);
}
