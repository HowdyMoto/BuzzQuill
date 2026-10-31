// ---------------------------------------------------------------------------
// Split view — the LAYOUT half of the two-editor-groups feature. The tab model
// (which tab is in which group, focus, drag-between-panes) lives in
// core/document-manager.ts; the tab STRIPS are rendered by ui/tab-bar.ts. This
// module owns the canvas layout: showing/hiding the second pane, which side is
// live, and painting the non-live group's document into the preview pane.
//
// There is one live AppState / canvas, so only the FOCUSED group is a real editor;
// the other group's pane is an <img> snapshot of its document (isolated, so its
// shape-N / defs ids can't collide with the live canvas). Clicking that pane calls
// docs.focusGroup(), which swaps which document is live (the proven tab
// serialize/load path) — and since group 0 is always the left column and group 1
// the right, the live #canvas-area just moves columns (`live-right`) so each
// document stays on its own side.
// ---------------------------------------------------------------------------

import type { DocumentManager } from '../core/document-manager';

let docs: DocumentManager;
let onLayoutChange: () => void;

const workspace = () => document.getElementById('workspace')!;

export function setupSplitView(deps: {
  docs: DocumentManager;
  onLayoutChange: () => void;
}): void {
  docs = deps.docs;
  onLayoutChange = deps.onLayoutChange;

  // Clicking the non-live pane focuses that group (makes its document live).
  document.getElementById('split-preview')?.addEventListener('click', () => {
    docs.focusGroup(otherGroup());
  });

  setupGutterResize();
}

/** Toggle split view on/off. Driven by the View ▸ Split View command (commands.ts);
 *  updateSplitView (next render) applies the layout and refits the canvas. */
export function toggleSplitView(): void {
  if (docs) docs.toggleSplit();
}

/** Whether the workspace is currently split — for the View menu's checkmark. */
export function isSplitActive(): boolean {
  return !!(docs && docs.splitOn);
}

/** Drag the divider to change how the two panes share the width. Adjusts the
 *  --split-left / --split-right fr ratios on #workspace and refits the live canvas. */
function setupGutterResize(): void {
  const gutter = document.getElementById('split-gutter');
  if (!gutter) return;
  let raf = 0;
  gutter.addEventListener('pointerdown', (e) => {
    if (!docs.splitOn) return;
    e.preventDefault();
    gutter.setPointerCapture(e.pointerId);
    gutter.classList.add('dragging');

    const move = (ev: PointerEvent) => {
      // The two panes span from the left strip's left edge to the right strip's
      // right edge (strips are pinned to their group's column). Place the gutter
      // centre at the pointer, clamped so neither pane gets too small.
      const a = document.getElementById('tabs-group-0')?.getBoundingClientRect();
      const b = document.getElementById('tabs-group-1')?.getBoundingClientRect();
      if (!a || !b) return;
      const gutterW = 8;
      const usable = (b.right - a.left) - gutterW;
      if (usable <= 0) return;
      let leftW = ev.clientX - a.left - gutterW / 2;
      leftW = Math.max(usable * 0.2, Math.min(usable * 0.8, leftW));
      const f = leftW / usable;
      const ws = workspace();
      ws.style.setProperty('--split-left', `${f}fr`);
      ws.style.setProperty('--split-right', `${1 - f}fr`);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; onLayoutChange(); });
    };
    const up = (ev: PointerEvent) => {
      gutter.releasePointerCapture(ev.pointerId);
      gutter.classList.remove('dragging');
      gutter.removeEventListener('pointermove', move);
      gutter.removeEventListener('pointerup', up);
      onLayoutChange();
    };
    gutter.addEventListener('pointermove', move);
    gutter.addEventListener('pointerup', up);
  });
}

/** The group currently shown in the preview pane = the one that isn't focused. */
function otherGroup(): 0 | 1 { return docs.focusedGroup === 0 ? 1 : 0; }

/** Reflect the document model's split state into the DOM. Called every render
 *  (from onStateChange) so entering/leaving split, focus swaps, and tab changes
 *  all stay in sync without any per-edit bookkeeping. */
export function updateSplitView(): void {
  if (!docs) return; // may fire from docs.onChange before setupSplitView wires up
  const ws = workspace();
  const split = docs.splitOn;
  const preview = document.getElementById('split-preview');
  const gutter = document.getElementById('split-gutter');

  const wasSplit = ws.classList.contains('split');
  const prevLiveRight = ws.classList.contains('live-right');

  ws.classList.toggle('split', split);
  ws.classList.toggle('live-right', split && docs.focusedGroup === 1);
  if (preview) preview.hidden = !split;
  if (gutter) gutter.hidden = !split;

  if (split) renderPreview(preview);

  // The live canvas changed width iff split turned on/off or the panes swapped
  // sides — refit its viewBox once the new grid has laid out.
  if (wasSplit !== split || prevLiveRight !== ws.classList.contains('live-right')) {
    requestAnimationFrame(() => onLayoutChange());
  }
}

/** Draw the non-focused group's document into the preview pane as an isolated <img>. */
function renderPreview(pane: HTMLElement | null): void {
  if (!pane) return;
  const body = pane.querySelector('.split-preview-body') as HTMLElement | null;
  if (!body) return;
  const shownId = docs.shownInGroup(otherGroup());
  const svg = shownId ? docs.tabSvgSnapshot(shownId) : null;
  if (!svg) {
    body.innerHTML = '<div class="split-preview-empty">Empty document — click to start editing</div>';
    return;
  }
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  body.replaceChildren(img);
}
