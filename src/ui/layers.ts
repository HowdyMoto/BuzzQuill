import type { AppState } from '../core/state';
import type { ShapeData } from '../core/types';
import type { CommandContext } from '../commands';
import { beginInlineRename, showContextMenu, type ContextMenuItem } from './panel-helpers';
import { showSelectionContextMenu, commandItem } from './context-menu';
import { exportArtboardToFile } from './export-dialog';
import { playExportSuccess } from './feedback';
import { ICON_EXPORT, ICON_EYE, ICON_EYE_OFF, ICON_LOCK, ICON_UNLOCK, getShapeIcon } from './icons';

// Id of the row currently being dragged in the Layers panel (null when idle).
let draggedId: string | null = null;
/** Every shape the current drag carries. A drag that starts on a row inside the
 *  selection moves the WHOLE selection — dropping five selected labels onto a
 *  rectangle should group all six, not just the row that was grabbed. Starting on
 *  an unselected row drags that row alone. */
let draggedIds: string[] = [];

// 'inside' = into an existing group; 'onto' = wrap target + dragged in a new group.
type DropZone = 'before' | 'after' | 'inside' | 'onto';

/** Where a drop lands within a row: above/below, or onto the row to combine. */
function dropZone(e: DragEvent, li: HTMLElement, targetIsGroup: boolean): DropZone {
  const r = li.getBoundingClientRect();
  const y = e.clientY - r.top;
  if (y < r.height / 3) return 'before';
  if (y > (r.height * 2) / 3) return 'after';
  return targetIsGroup ? 'inside' : 'onto';
}

// Tree-view depth picking for an 'after' drop. The horizontal cursor position
// chooses how deep the dropped row lands, between the NEXT visible row's depth (drag
// left → outdent, ultimately to the root) and the target row's own depth (drag right
// → stay nested as the group's last child). Only offers a real choice at the end of
// a nested run / the bottom of the list; elsewhere the range collapses to one depth.
const INDENT_PX = 14;
const ROW_PAD_PX = 8;
let afterDropDepth = 0; // chosen depth for the current 'after' dragover

/** [minDepth, maxDepth] a row dropped after `targetId` may land at. */
function afterDepthRange(targetId: string): [number, number] {
  const idx = vRows.findIndex(r => r.shape.id === targetId);
  if (idx < 0) return [0, 0];
  const dTarget = vRows[idx].depth;
  const dNext = idx + 1 < vRows.length ? vRows[idx + 1].depth : 0;
  return [Math.min(dNext, dTarget), dTarget];
}

/** Pick the drop depth from the cursor x, clamped to the row's allowed range. */
function pickAfterDepth(e: DragEvent, li: HTMLElement, targetId: string): number {
  const [min, max] = afterDepthRange(targetId);
  if (max <= min) return max;
  const rel = e.clientX - li.getBoundingClientRect().left - ROW_PAD_PX;
  return Math.max(min, Math.min(max, Math.round(rel / INDENT_PX)));
}

/** Both 'inside' and 'onto' highlight the whole row. */
function dropMark(zone: DropZone): string {
  return zone === 'before' || zone === 'after' ? `drop-${zone}` : 'drop-inside';
}

function clearDropMarks(li: HTMLElement): void {
  li.classList.remove('drop-before', 'drop-after', 'drop-inside', 'drop-depth', 'drop-illegal');
  li.style.removeProperty('--drop-indent');
}

/** A little "nope" — shake + red flash on a row when an illegal drop is attempted. */
function rejectDrop(li: HTMLElement): void {
  li.classList.remove('fx-nope');
  void li.offsetWidth; // restart if already animating
  li.classList.add('fx-nope');
  li.addEventListener('animationend', () => li.classList.remove('fx-nope'), { once: true });
}

// ---------------------------------------------------------------------------
// Virtualized rendering.
//
// The panel is a tree, but huge documents (e.g. a matplotlib export where every
// point is its own <g>) can have 100k+ rows. Rendering one <li> per shape builds
// ~1.8M DOM nodes and takes ~14s. Instead we flatten the *visible* tree (honoring
// collapse) into an array and render only the rows inside the scroll viewport,
// using top/bottom padding on the <ul> to preserve the scrollbar geometry.
// ---------------------------------------------------------------------------

type ContainerKind = 'frame' | 'mask' | 'group';
/** How a container reads in the rail language: frame (azure), mask (violet), or a
 *  plain group (neutral). A clip-group is type 'group' but marked data-clip-group. */
function containerKind(sh: ShapeData): ContainerKind {
  if (sh.type === 'frame') return 'frame';
  if (sh.element.hasAttribute('data-clip-group')) return 'mask';
  return 'group';
}

/** A container the panel can expand: group, frame, or repeat grid — a repeat's
 *  cell children are real modeled shapes (its generated clones never appear). */
function isExpandable(sh: ShapeData): boolean {
  return (sh.type === 'group' || sh.type === 'frame' || sh.type === 'repeat')
    && !!sh.children && sh.children.length > 0;
}

/** The frame/mask context that tints a row's block: the row's OWN kind if it is a
 *  frame/mask, else its deepest frame/mask ancestor. Plain groups don't tint (null). */
function containerBlockTint(sh: ShapeData, ancestors: ContainerKind[]): 'frame' | 'mask' | null {
  if (sh.type === 'frame') return 'frame';
  if (sh.element.hasAttribute('data-clip-group')) return 'mask';
  for (let d = ancestors.length - 1; d >= 0; d--) {
    const k = ancestors[d];
    if (k === 'frame' || k === 'mask') return k;
  }
  return null;
}

interface LayerRow {
  shape: ShapeData;
  depth: number;
  /** Container kind owning each ancestor column, so each indent rail is tinted by
   *  the frame/mask/group it belongs to. Length === depth. */
  ancestors: ContainerKind[];
  /** Shape id of the container owning each ancestor column (parallel to `ancestors`),
   *  so a row can tell whether the frame/mask enclosing it is currently selected. */
  ancestorIds: string[];
  /** Depth of the NEXT visible row (0 past the end) — a rail closes (bottom cap) at
   *  columns d where d >= nextDepth, i.e. this row is the last child at that level. */
  nextDepth: number;
}

let vRows: LayerRow[] = [];      // flattened visible rows (cached between scrolls)
let vRowH = 0;                   // measured row height (uniform); 0 until first render
// Ids present at the previous render, so a genuinely-new shape's row can animate
// in once (never on scroll or an ordinary re-render). enterIds is consumed as
// rows build; firstLayerRender suppresses the intro on the very first paint.
let prevLayerIds = new Set<string>();
const enterIds = new Set<string>();
let firstLayerRender = true;
// The group whose disclosure was just toggled, so its chevron can play a one-shot
// rotate on the next render (rows are rebuilt, so a CSS transition wouldn't fire).
let justToggledId: string | null = null;
let justToggledExpanding = false;
// Anchor for Shift range-select: the last row picked without Shift. Shift+click
// selects every visible row between it and the anchor (Finder-style).
let selectionAnchorId: string | null = null;
let curState: AppState | null = null;
let layerCtx: CommandContext | null = null; // set by setupLayerButtons, for the row context menu
let listEl: HTMLElement | null = null;
let scrollBound = false;
let pendingFrame = 0;
// True while an inline rename <input> is live in the list. The virtualized render
// rebuilds all rows via replaceChildren; focusing the rename input scrolls the
// container, which fires the scroll handler → renderWindow → the input is destroyed
// before you can type. Suspend re-rendering until the rename commits.
let renaming = false;

// ---- Illustrator-style column swipe -----------------------------------------
// Press on the eye or lock icon and drag up/down the column to set that toggle on
// every row you pass — one gesture, one undo step. The pressed row picks the TARGET
// state (its flip); rows swiped over are SET to that target, so passing an already-
// matching row does nothing (no flip-flop). The row *body* still drags to reorder —
// only the two icon columns swipe. Changes apply live (model + element + the row's
// icon) with the virtualized re-render frozen, then commit once on release.
type SwipeField = 'vis' | 'lock';
let swipe: { field: SwipeField; target: boolean; done: Set<string> } | null = null;

const visTitle = (visible: boolean) => `${visible ? 'Hide' : 'Show'} · drag to apply to more`;
const lockTitle = (locked: boolean) => `${locked ? 'Unlock' : 'Lock'} · drag to apply to more`;

/** The nearest hidden / locked ANCESTOR of a shape, if any. On the canvas a hidden
 *  group hides everything inside it and a locked one locks everything inside it
 *  (`isLockedEl` is a `closest()`), so the panel shows a child under one as hidden or
 *  locked too — dimmer than a row's own state, which its toggle still flips. */
function inheritedState(state: AppState, shape: ShapeData): { hiddenBy: ShapeData | null; lockedBy: ShapeData | null } {
  let hiddenBy: ShapeData | null = null, lockedBy: ShapeData | null = null;
  for (let p = shape.parentId ? state.findShapeById(shape.parentId) : null; p; p = p.parentId ? state.findShapeById(p.parentId) : null) {
    if (!hiddenBy && !p.visible) hiddenBy = p;
    if (!lockedBy && p.locked) lockedBy = p;
  }
  return { hiddenBy, lockedBy };
}

/** Paint a row's hidden/locked state and its eye + padlock from the live shape. The
 *  icon shows the EFFECTIVE state (hidden or locked by an ancestor reads as hidden or
 *  locked); a click still toggles the row's own flag, so the tooltip says which. */
function paintRowState(li: HTMLElement, state: AppState, shape: ShapeData): void {
  const { hiddenBy, lockedBy } = inheritedState(state, shape);
  li.classList.toggle('is-hidden', !shape.visible);
  li.classList.toggle('is-locked', shape.locked);
  li.classList.toggle('is-ancestor-hidden', shape.visible && !!hiddenBy);
  li.classList.toggle('is-ancestor-locked', !shape.locked && !!lockedBy);
  const vis = li.querySelector('.layer-vis') as HTMLElement | null;
  if (vis) {
    vis.innerHTML = shape.visible && !hiddenBy ? ICON_EYE : ICON_EYE_OFF;
    vis.title = shape.visible && hiddenBy
      ? `Hidden by “${hiddenBy.name}” · click to hide this layer too`
      : visTitle(shape.visible);
  }
  const lock = li.querySelector('.layer-lock') as HTMLElement | null;
  if (lock) {
    const showLocked = shape.locked || !!lockedBy;
    lock.className = showLocked ? 'layer-lock' : 'layer-lock unlocked';
    lock.innerHTML = showLocked ? ICON_LOCK : ICON_UNLOCK;
    lock.title = !shape.locked && lockedBy
      ? `Locked by “${lockedBy.name}” · click to lock this layer too`
      : lockTitle(shape.locked);
  }
}

// Disclosure chevrons (small, so they read as UI affordances not content).
// One base chevron (points right); CSS rotates it 90° when the group is expanded,
// so expand/collapse can animate the same way the side-panel chevrons do.
const CHEVRON = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Repaint every rendered row's state from the live shapes (used during a swipe,
 *  when the full re-render is frozen). Every row, not just the toggled one: hiding or
 *  locking a group changes how each of its descendants' rows reads. */
function refreshRenderedRows(): void {
  if (!listEl || !curState) return;
  for (const li of listEl.querySelectorAll<HTMLElement>('li[data-id]')) {
    const shape = curState.findShapeById(li.dataset.id!);
    if (shape) paintRowState(li, curState, shape);
  }
}

/** Set one row to the swipe's target state (once). */
function applySwipeTo(id: string): void {
  if (!swipe || !curState || swipe.done.has(id)) return;
  const shape = curState.findShapeById(id);
  if (!shape) return;
  swipe.done.add(id);
  if (swipe.field === 'vis') {
    shape.visible = swipe.target;
    (shape.element as SVGElement).style.display = shape.visible ? '' : 'none';
  } else {
    shape.locked = swipe.target;
    if (shape.locked) shape.element.setAttribute('data-locked', 'true');
    else shape.element.removeAttribute('data-locked');
  }
  refreshRenderedRows();
}

/** Begin a column swipe from a pointerdown on a row's eye/lock icon. */
function startSwipe(field: SwipeField, li: HTMLElement, shapeId: string, e: PointerEvent): void {
  if (e.button !== 0 || !curState) return;
  e.preventDefault();   // no text selection / native drag
  e.stopPropagation();
  const shape = curState.findShapeById(shapeId);
  if (!shape) return;
  swipe = { field, target: field === 'vis' ? !shape.visible : !shape.locked, done: new Set() };
  li.draggable = false; // keep the native row-reorder drag from hijacking the swipe
  applySwipeTo(shapeId);

  // Track by hit-testing the row under the pointer (rows persist — render frozen).
  const onMove = (ev: PointerEvent) => {
    const row = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)
      ?.closest('li[data-id]') as HTMLElement | null;
    if (row?.dataset.id) applySwipeTo(row.dataset.id);
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const changed = !!swipe && swipe.done.size > 0;
    swipe = null;
    if (changed && curState) { curState.saveHistory(); curState.onChange_public(); }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}
const BUFFER = 8;                // extra rows rendered above/below the viewport
const DEFAULT_ROW_H = 24;        // used for the first render, before measuring
const FRAME_GAP = 8;             // px of blank space above each top-level frame (matches CSS .frame-sep)

// Per-row vertical offsets (prefix sum of row heights). The list is virtualized on
// a fixed base row height, but a top-level frame carries an extra FRAME_GAP above it
// so sibling frames read as separated cards (design ask) — which makes rows
// variable-height, so scroll math uses these cumulative tops instead of `i * rowH`.
let rowTops: number[] = [0];     // rowTops[i] = top offset of row i; rowTops[total] = total height
let totalRowsH = 0;

/** True when row `i` should get a separating gap above it: a top-level (depth-0)
 *  frame that isn't the very first row. Nested content already reads as "inside",
 *  and loose top-level shapes/groups stay tight — the gap is a frame-boundary cue. */
function rowNeedsGap(i: number): boolean {
  const r = vRows[i];
  return i > 0 && r.depth === 0 && r.shape.type === 'frame';
}

/** Rebuild the prefix-sum offsets from the current rows + base row height. Cheap
 *  (O(rows)); called only when the row set or measured height changes, never on scroll. */
function rebuildRowOffsets(rowH: number): void {
  rowTops = new Array(vRows.length + 1);
  let top = 0;
  for (let i = 0; i < vRows.length; i++) {
    rowTops[i] = top;
    top += rowH + (rowNeedsGap(i) ? FRAME_GAP : 0);
  }
  rowTops[vRows.length] = top;
  totalRowsH = top;
}

/** Largest index whose top offset is ≤ y (the row containing y), via binary search. */
function rowAtOffset(y: number): number {
  let lo = 0, hi = rowTops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rowTops[mid] <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Flatten the visible tree (collapsed groups hide their children) in render
 *  order — within each level, last shape first, matching the canvas z-order. */
function flattenVisible(list: ShapeData[], depth: number, out: LayerRow[], ancestors: ContainerKind[], ancestorIds: string[]): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const sh = list[i];
    out.push({ shape: sh, depth, ancestors, ancestorIds, nextDepth: 0 }); // nextDepth filled in a second pass
    if (isExpandable(sh) && sh.element.getAttribute('data-collapsed') !== 'true') {
      flattenVisible(sh.children!, depth + 1, out, [...ancestors, containerKind(sh)], [...ancestorIds, sh.id]);
    }
  }
}

/** Re-query the live name element by id so rename works after re-renders. */
function renameShape(id: string): void {
  if (!listEl || !curState) return;
  const nameEl = listEl.querySelector(`li[data-id="${CSS.escape(id)}"] .layer-name`) as HTMLElement | null;
  const shape = curState.findShapeById(id);
  if (!nameEl || !shape) return;
  renaming = true; // freeze the virtualized re-render until the edit commits
  beginInlineRename(nameEl, shape.name, (newName) => {
    renaming = false;
    curState!.renameShape(id, newName); // frame renames also refresh the canvas label
    curState!.onChange_public(); // rename may be a no-op (unchanged) — still unfreeze rows
  });
}

/** Render just the rows currently in the viewport (from cached vRows). */
function renderWindow(): void {
  if (!listEl || !curState) return;
  if (renaming || swipe) return; // never rebuild rows mid-rename or mid-swipe
  const container = listEl.parentElement as HTMLElement | null;
  const total = vRows.length;
  const rowH = vRowH || DEFAULT_ROW_H;
  const scrollTop = container?.scrollTop ?? 0;
  const viewH = container?.clientHeight || 400;

  // Offsets are cached; (re)build if a new row set or a height change invalidated them.
  if (rowTops.length !== total + 1) rebuildRowOffsets(rowH);

  let start = Math.max(0, rowAtOffset(scrollTop) - BUFFER);
  let end = Math.min(total, rowAtOffset(scrollTop + viewH) + 1 + BUFFER);
  if (end < start) end = start;

  listEl.style.paddingTop = `${Math.round(rowTops[start])}px`;
  listEl.style.paddingBottom = `${Math.round(totalRowsH - rowTops[end])}px`;

  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) frag.appendChild(buildRow(vRows[i], i));
  listEl.replaceChildren(frag);

  // Measure the real row height once, then rebuild offsets + re-window if the guess
  // was off. offsetHeight excludes margin, so a gapped first row still measures the
  // base height (the FRAME_GAP is folded in via rebuildRowOffsets, not the measurement).
  if (!vRowH) {
    const first = listEl.firstElementChild as HTMLElement | null;
    if (first && first.offsetHeight > 0) {
      vRowH = first.offsetHeight;
      if (Math.abs(vRowH - rowH) > 0.5) { rebuildRowOffsets(vRowH); renderWindow(); }
    }
  }
}

/** Bind scroll + resize once, so scrolling re-windows without re-flattening. */
function bindScroll(): void {
  if (scrollBound || !listEl) return;
  const container = listEl.parentElement;
  if (!container) return;
  const schedule = () => {
    if (pendingFrame) return;
    pendingFrame = requestAnimationFrame(() => { pendingFrame = 0; renderWindow(); });
  };
  container.addEventListener('scroll', schedule, { passive: true });
  new ResizeObserver(schedule).observe(container); // panel expand / window resize
  scrollBound = true;
}

// Last selection we auto-revealed, so we only expand/scroll on a genuine selection
// CHANGE — not on every render (else manually collapsing a group that holds the
// selected shape would immediately re-expand it).
let revealedSelKey = '';

/** On a new selection, expand the selected shapes' collapsed ancestors so they show
 *  in the tree. Returns the row id to scroll into view, or null. */
function revealSelectionAncestors(state: AppState): string | null {
  const ids = state.selectedShapeIds;
  const key = ids.join(',');
  if (key === revealedSelKey) return null;
  revealedSelKey = key;
  if (ids.length === 0) return null;
  for (const id of ids) {
    let pid = state.findShapeById(id)?.parentId;
    while (pid) {
      const parent = state.findShapeById(pid);
      if (!parent) break;
      if (parent.element.getAttribute('data-collapsed') === 'true') {
        parent.element.setAttribute('data-collapsed', 'false');
      }
      pid = parent.parentId;
    }
  }
  return ids[ids.length - 1] ?? null; // scroll to the primary (last-added) selection
}

/** Scroll the given row into view in the virtualized list, only if it's off-screen. */
function scrollRowIntoView(id: string): void {
  if (!listEl) return;
  const container = listEl.parentElement as HTMLElement | null;
  if (!container) return;
  const idx = vRows.findIndex(r => r.shape.id === id);
  if (idx < 0) return;
  const rowH = vRowH || DEFAULT_ROW_H;
  if (rowTops.length !== vRows.length + 1) rebuildRowOffsets(rowH);
  const rowTop = rowTops[idx], rowBottom = rowTops[idx + 1]; // top→next-top spans the gap too
  const viewTop = container.scrollTop, viewBottom = viewTop + container.clientHeight;
  if (rowTop < viewTop) container.scrollTop = Math.max(0, rowTop - rowH);
  else if (rowBottom > viewBottom) container.scrollTop = rowBottom - container.clientHeight + rowH;
  else return; // already fully visible
  renderWindow(); // re-window immediately at the new scroll position
}

export function updateLayersPanel(state: AppState): void {
  listEl = document.getElementById('layers-list');
  if (!listEl) return;
  curState = state;
  const scrollToId = revealSelectionAncestors(state);
  vRows = [];
  flattenVisible(state.shapes, 0, vRows, [], []);
  // A rail's bottom cap lands on the last child at each level, known from the next row's depth.
  for (let i = 0; i < vRows.length; i++) vRows[i].nextDepth = vRows[i + 1]?.depth ?? 0;
  // Rebuild the height offsets for the new row set (frame gaps depend on which rows
  // are top-level frames, which reordering can change without changing the count).
  rebuildRowOffsets(vRowH || DEFAULT_ROW_H);

  // Diff row ids vs. the last render so only newly-added shapes animate in.
  // Skipped during a group toggle, where id changes are children being revealed/
  // hidden (not real adds) — only the chevron should animate then.
  const currentIds = new Set(vRows.map(r => r.shape.id));
  enterIds.clear();
  if (!firstLayerRender && !justToggledId) {
    for (const id of currentIds) if (!prevLayerIds.has(id)) enterIds.add(id);
  }
  firstLayerRender = false;
  prevLayerIds = currentIds;

  bindScroll();
  renderWindow();
  if (scrollToId) scrollRowIntoView(scrollToId);
  // Consume the one-shot toggle flag; its chevron was built this pass.
  justToggledId = null;
}

/** Build one layer row (`<li>`); called only for rows in the viewport. */
/** Opens a linked file's source. Wired at boot so the Layers panel doesn't have to
 *  know about tabs or the cloud. */
let onOpenLinkedSource: ((src: string, name: string) => void) | null = null;
export function setLinkedSourceOpener(fn: (src: string, name: string) => void): void {
  onOpenLinkedSource = fn;
}
let onUpdateLinkedSource: ((shapeId: string) => void) | null = null;
export function setLinkedSourceUpdater(fn: (shapeId: string) => void): void {
  onUpdateLinkedSource = fn;
}

function buildRow(row: LayerRow, index: number): HTMLLIElement {
  const state = curState!;
  const list = listEl!;
  const { shape, depth } = row;
  const isGroup = isExpandable(shape);
  const isCollapsed = shape.element.getAttribute('data-collapsed') === 'true';

  const li = document.createElement('li');
  li.className = 'layer-item';
  if (depth > 0) li.classList.add('layer-child');
  if (isGroup) li.classList.add('layer-group');
  // Tinted container BLOCK: every row inside a frame (or mask) sits on a faint
  // azure (or violet) wash — and a container header sits on its OWN kind's wash —
  // so a frame/mask + its contents read as one grouped panel. Uses the deepest
  // frame/mask context (plain groups are transparent to the wash).
  const blockTint = containerBlockTint(shape, row.ancestors);
  if (blockTint) li.classList.add(`block-${blockTint}`);
  // Blank gap above a top-level frame so sibling frames read as separated cards.
  if (rowNeedsGap(index)) li.classList.add('frame-sep');
  if (shape.id === state.selectedShapeId || state.selectedShapeIds.includes(shape.id)) {
    li.classList.add('selected');
  }
  li.setAttribute('data-id', shape.id);
  li.setAttribute('data-depth', String(depth));
  // Play the slide-in once for a freshly-added shape (consumed so scrolling the
  // row out and back doesn't re-trigger it).
  if (enterIds.has(shape.id)) { li.classList.add('fx-enter'); enterIds.delete(shape.id); }
  // Indent spacer — reserves the nesting width. Plain-group columns get a thin
  // neutral rail (with a bottom cap where the group ends); frame/mask columns are
  // instead drawn as full rounded PANEL walls below, so they're skipped here.
  if (depth > 0) {
    const indent = document.createElement('span');
    indent.className = 'layer-indent';
    indent.style.width = `${depth * 14}px`;
    indent.style.minWidth = `${depth * 14}px`;
    for (let d = 0; d < depth; d++) {
      if (row.ancestors[d] !== 'group') continue;
      const guide = document.createElement('span');
      guide.className = 'layer-indent-guide rail-group';
      if (d >= row.nextDepth) guide.classList.add('rail-cap-bottom');
      guide.style.left = `${d * 14 + 7}px`;
      indent.appendChild(guide);
    }
    li.appendChild(indent);
  }

  // Nested container PANELS: a frame (azure) or mask (violet) + its contents render
  // as one rounded card, matching the canvas container language. The card BORDER is
  // shown only while its own container is SELECTED — so an idle tree stays quiet and
  // selecting a frame/mask reveals its extent (its faint wash + tinted icon persist
  // either way). Each row draws its slice of every SELECTED frame/mask box it sits
  // inside — side walls, a rounded top + divider on the header, a rounded bottom on
  // the last descendant. Stacked slices nest: a violet mask card inside an azure one.
  const isSel = (id: string) => state.selectedShapeId === id || state.selectedShapeIds.includes(id);
  const boxes: { col: number; kind: 'frame' | 'mask'; top: boolean; bottom: boolean }[] = [];
  for (let d = 0; d < depth; d++) {
    const k = row.ancestors[d];
    if ((k === 'frame' || k === 'mask') && isSel(row.ancestorIds[d])) {
      boxes.push({ col: d, kind: k, top: false, bottom: d >= row.nextDepth });
    }
  }
  // The row's OWN card, if it's a frame/mask. Expanded-with-children opens the card
  // (top edge here; the sides run down through the children; the last descendant
  // draws the bottom). Collapsed OR empty → a self-contained single-row card. The
  // icon tint + header wash mark it as a container always; the border only when
  // selected. A plain group keeps the lighter neutral bracket while open.
  const ownKind = containerKind(shape);
  if (ownKind === 'frame' || ownKind === 'mask') {
    li.classList.add(`is-${ownKind}`); // tints the folder icon + header wash (always)
    if (isSel(shape.id)) {
      const opensDown = isGroup && !isCollapsed; // has visible children continuing below
      boxes.push({ col: depth, kind: ownKind, top: true, bottom: !opensDown });
    }
  } else if (isGroup && !isCollapsed) {
    const cap = document.createElement('span');
    cap.className = 'layer-indent-guide rail-group rail-cap-top';
    cap.style.left = `${depth * 14 + 7}px`;
    li.appendChild(cap);
  }
  for (const b of boxes) {
    const seg = document.createElement('span');
    seg.className = `panel-seg panel-${b.kind}${b.top ? ' seg-top' : ''}${b.bottom ? ' seg-bottom' : ''}`;
    seg.style.left = `${b.col * 14 + 2}px`;
    seg.style.right = `${6 + b.col * 8}px`;
    li.appendChild(seg);
  }

  // Disclosure chevron, immediately left of the name. The slot is ALWAYS present
  // (empty for childless layers) so every name left-aligns whether or not the row
  // can expand.
  const disclosure = document.createElement('span');
  disclosure.className = 'layer-disclosure';
  if (isGroup) {
    disclosure.classList.add('is-toggle');
    if (!isCollapsed) disclosure.classList.add('expanded'); // resting rotation
    disclosure.innerHTML = CHEVRON;
    // If this group was just toggled, play the one-shot rotate (rows rebuild, so
    // a plain CSS transition on the fresh element wouldn't animate).
    if (shape.id === justToggledId) {
      disclosure.classList.add(justToggledExpanding ? 'chev-open' : 'chev-close');
    }
    disclosure.title = isCollapsed ? 'Expand' : 'Collapse';
    disclosure.addEventListener('click', (e) => {
      e.stopPropagation();
      justToggledId = shape.id;
      justToggledExpanding = isCollapsed; // was collapsed → now expanding
      shape.element.setAttribute('data-collapsed', isCollapsed ? 'false' : 'true');
      // Collapse is a layers-view-only concern — rebuild just this panel rather
      // than the whole app, so the chevron animation starts instantly (a full
      // onChange_public rebuilds every panel first, which delayed the rotate).
      updateLayersPanel(state);
    });
  }
  li.appendChild(disclosure);

  // Type icon + name. A clip mask is type 'group' with data-clip-group — give it the
  // dedicated mask glyph so it never reads as a plain group.
  const icon = document.createElement('span');
  icon.className = 'layer-icon';
  const iconType = shape.element.hasAttribute('data-clip-group') ? 'mask' : shape.type;
  icon.innerHTML = getShapeIcon(iconType);

  const name = document.createElement('span');
  name.className = 'layer-name';
  // While a mask is being edited, its cutter is modeled as a child inside the
  // <clipPath> — label it "Mask shape" so the transient row is self-explanatory.
  const isCutter = shape.element.parentElement?.tagName.toLowerCase() === 'clippath';
  name.textContent = isCutter ? 'Mask shape' : shape.name;

  li.appendChild(icon);
  li.appendChild(name);

  // Text-style chip: which reusable text style governs this object, so you can scan
  // the whole document for what's styled (slate = document, teal = cloud). "●" = the
  // object has local overrides. Only present for a live link to an existing style.
  const linkedStyleId = shape.element.getAttribute('data-text-style');
  const linkedStyle = linkedStyleId ? state.getTextStyle(linkedStyleId) : undefined;
  if (linkedStyle) {
    const chip = document.createElement('span');
    chip.className = 'layer-style-chip' + (linkedStyle.origin ? ' cloud' : '');
    chip.textContent = linkedStyle.name;
    let tip = `Text style: ${linkedStyle.name}`;
    if (state.textStyleOverrides(shape).length > 0) {
      const dot = document.createElement('span');
      dot.className = 'layer-style-dot';
      dot.textContent = '●';
      chip.appendChild(dot);
      tip += ' (overridden)';
    }
    chip.title = tip;
    li.appendChild(chip);
  }

  // Linked-file chip: the source's name, its status, and the click-through. Status
  // reuses the library's ⤓ language — no badge when current, ⤓ when the source has
  // moved on, "!" when it can't be resolved. The artwork renders either way; the
  // link is only about whether a newer version exists.
  if (shape.type === 'linked') {
    const info = state.linkedFileInfo(shape.id);
    if (info) {
      const chip = document.createElement('button');
      chip.className = 'layer-link-chip' + (info.missing ? ' missing' : info.stale ? ' stale' : '');
      chip.type = 'button';
      chip.textContent = info.missing ? '!' : info.stale ? '⤓' : '↗';
      chip.title = info.missing
        ? `${info.name} — source unavailable (the artwork is still here)`
        : info.stale
          ? `${info.name} — a newer version exists. Open it, or update from source.`
          : `Open “${info.name}”`;
      chip.setAttribute('aria-label', chip.title);
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        // Stale ⤓ pulls the update — the same meaning the badge has in the Library.
        // Otherwise ↗ takes you to the source.
        if (info.stale) onUpdateLinkedSource?.(shape.id);
        else onOpenLinkedSource?.(info.src, info.name);
      });
      li.appendChild(chip);
    }
  }

  // Right-aligned action cluster (Figma): per-frame export, then visibility + lock.
  // Hover-revealed via CSS; a hidden eye and a locked padlock stay visible.
  // Click toggles this row; press-and-drag up/down toggles every row the cursor
  // enters (Illustrator/Figma swipe — see startSwipe). A plain click is a
  // zero-distance swipe, so pointerdown handles both; click only stops row-select.
  const actions = document.createElement('span');
  actions.className = 'layer-actions';

  if (shape.type === 'frame') {
    const exportBtn = document.createElement('button');
    exportBtn.className = 'layer-export';
    exportBtn.title = 'Export this frame (uses its export settings)';
    exportBtn.innerHTML = ICON_EXPORT;
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ab = state.getArtboardById(shape.id);
      if (!ab) return;
      const fid = shape.id;
      const count = state.getFrameExportTargets(fid).length;
      void exportArtboardToFile(state, ab).then((ok) => {
        if (!ok) return;
        // The layers list rebuilds during the async export (the exporter bakes the
        // drawing layer), which detaches exportBtn — its rect goes to 0 and the
        // fireworks land in the screen corner. Re-find the live export button for
        // this frame so the celebration + floating count anchor to it.
        const live = document.querySelector<HTMLElement>(`li[data-id="${CSS.escape(fid)}"] .layer-export`) ?? exportBtn;
        playExportSuccess(live, { compact: true, count });
      });
    });
    actions.appendChild(exportBtn);
  }

  const vis = document.createElement('span');
  vis.className = 'layer-vis';
  vis.addEventListener('pointerdown', (e) => startSwipe('vis', li, shape.id, e));
  vis.addEventListener('click', (e) => e.stopPropagation());

  const lock = document.createElement('span');
  lock.className = 'layer-lock';
  lock.addEventListener('pointerdown', (e) => startSwipe('lock', li, shape.id, e));
  lock.addEventListener('click', (e) => e.stopPropagation());

  actions.appendChild(vis);
  actions.appendChild(lock);
  li.appendChild(actions);
  // Figma-style row state: a hidden row dims, a locked row keeps its lock showing —
  // and a row inside a hidden/locked container reads that way too, more quietly.
  paintRowState(li, state, shape);

  // Click to select. Selecting from the panel is an explicit "take me to this", so
  // pan an off-screen target into view (frames especially can sit far off-canvas).
  li.addEventListener('click', (e) => {
    state.activePanel = 'layers';
    if (e.shiftKey) {
      // Range-select every visible row between the anchor and this one. The
      // anchor is the last non-Shift pick (falling back to the current primary
      // selection, e.g. when it was made on the canvas) and stays fixed so
      // repeated Shift+clicks grow/shrink the range from the same origin.
      const ids = vRows.map(r => r.shape.id);
      const anchorId = (selectionAnchorId && ids.includes(selectionAnchorId))
        ? selectionAnchorId : state.selectedShapeId;
      const ai = anchorId ? ids.indexOf(anchorId) : -1;
      const ci = ids.indexOf(shape.id);
      if (ai === -1) {
        state.selectShape(shape.id);
        selectionAnchorId = shape.id;
      } else {
        const [lo, hi] = ai <= ci ? [ai, ci] : [ci, ai];
        state.selectMultiple(ids.slice(lo, hi + 1));
      }
      state.revealShape(shape.id);
    } else if (e.metaKey || e.ctrlKey) {
      // Toggle this row in/out of the selection without disturbing the rest.
      state.toggleMultiSelect(shape.id);
      selectionAnchorId = shape.id;
    } else {
      state.selectShape(shape.id);
      selectionAnchorId = shape.id;
      state.revealShape(shape.id);
    }
  });

  // Click the name of an already-selected item to rename it (Finder-style). A
  // modifier click is a selection gesture (range / toggle), never a rename.
  name.addEventListener('click', (e) => {
    const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey;
    const onlySelected = state.selectedShapeId === shape.id && state.selectedShapeIds.length <= 1;
    if (plain && onlySelected) {
      e.stopPropagation();
      renameShape(shape.id);
    }
  });

  // Double-click to rename
  li.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    renameShape(shape.id);
  });

  // Right-click context menu: select this row (unless already in the selection) so
  // the shared selection commands act on it, then show the command-driven menu with
  // Layers-specific items (Rename, per-frame Export) prefixed.
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    state.activePanel = 'layers';
    if (!state.selectedShapeIds.includes(shape.id)) state.selectShape(shape.id);
    const prefix: ContextMenuItem[] = [
      { label: 'Rename', action: () => renameShape(shape.id) },
      ...(shape.type === 'frame' ? [{
        label: 'Export frame',
        action: () => { const ab = state.getArtboardById(shape.id); if (ab) void exportArtboardToFile(state, ab); },
      }] : []),
    ];
    if (layerCtx) showSelectionContextMenu(e.clientX, e.clientY, layerCtx, prefix);
  });

  // Drag to reorder / reparent.
  li.draggable = true;
  li.addEventListener('dragstart', (e) => {
    if (swipe) { e.preventDefault(); return; } // a column swipe is not a row drag
    draggedId = shape.id;
    const sel = curState?.selectedShapeIds ?? [];
    draggedIds = sel.includes(shape.id) ? [...sel] : [shape.id];
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', shape.id);
    // Mark every row travelling, not just the grabbed one.
    for (const id of draggedIds) {
      list.querySelector(`[data-id="${id}"]`)?.classList.add('dragging');
    }
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => {
    draggedId = null;
    draggedIds = [];
    list.querySelectorAll('.layer-item').forEach(el => {
      el.classList.remove('dragging');
      clearDropMarks(el as HTMLElement);
    });
  });
  li.addEventListener('dragover', (e) => {
    if (!draggedId || draggedId === shape.id) return;
    e.preventDefault();
    // Repeat wrappers accept 'inside' drops like groups (the drop joins the cell).
    const zone = dropZone(e, li, shape.type === 'group' || shape.type === 'repeat');
    clearDropMarks(li);

    // Resolve the depth/outdent the drop would use, so the legality check matches
    // exactly what the drop does.
    if (zone === 'after') {
      const dragShape = curState?.findShapeById(draggedId);
      afterDropDepth = dragShape?.type === 'frame' ? 0 : pickAfterDepth(e, li, shape.id);
    }
    const idx = vRows.findIndex(r => r.shape.id === shape.id);
    const targetDepth = idx >= 0 ? vRows[idx].depth : 0;
    const outdent = zone === 'after' ? Math.max(0, targetDepth - afterDropDepth) : 0;

    // Illegal (e.g. a frame into another frame): show a red "can't drop" state and
    // the OS no-drop cursor instead of the blue insertion indicator.
    if (!curState?.canDrop(draggedId, shape.id, zone, outdent)) {
      e.dataTransfer!.dropEffect = 'none';
      li.classList.add('drop-illegal');
      return;
    }

    e.dataTransfer!.dropEffect = 'move';
    li.classList.add(dropMark(zone));
    // For an 'after' drop, follow the cursor's x to pick the target depth and slide
    // the drop indicator to that indent so the root-vs-nested choice is visible.
    if (zone === 'after') {
      const [min, max] = afterDepthRange(shape.id);
      li.style.setProperty('--drop-indent', `${ROW_PAD_PX + afterDropDepth * INDENT_PX}px`);
      li.classList.toggle('drop-depth', max > min); // only style as depth-pickable when it is
    }
  });
  li.addEventListener('dragleave', () => clearDropMarks(li));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    const zone = dropZone(e, li, shape.type === 'group' || shape.type === 'repeat');
    const depth = zone === 'after' ? afterDropDepth : 0;
    clearDropMarks(li);
    if (draggedId && draggedId !== shape.id) {
      let ok: boolean;
      if (zone === 'onto') ok = state.groupShapes(draggedIds.length ? draggedIds : draggedId, shape.id);
      else {
        // outdentLevels = how many container levels shallower than the target row.
        const idx = vRows.findIndex(r => r.shape.id === shape.id);
        const targetDepth = idx >= 0 ? vRows[idx].depth : 0;
        ok = state.moveShape(draggedId, shape.id, zone, zone === 'after' ? Math.max(0, targetDepth - depth) : 0);
      }
      // A rejected drop (illegal rearrange) leaves the tree unchanged — say "nope".
      if (!ok) rejectDrop(li);
    }
    draggedId = null;
  });

  return li;
}


/** The two "create a top-level container" actions shared by the + button and the
 *  panel's empty-area right-click menu: an ordinary layer (empty group) or a frame. */
function addContainerItems(state: AppState): ContextMenuItem[] {
  return [
    { label: 'Add Layer', action: () => state.addEmptyGroup() },
    { label: 'Add Frame', action: () => addFrameFromPanel(state) },
  ];
}

export function setupLayerButtons(ctx: CommandContext): void {
  const state = ctx.state;
  layerCtx = ctx; // available to the row right-click menu
  const addBtn = document.getElementById('btn-layer-add');
  addBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.activePanel = 'layers';
    // Menu drops from the button's bottom-left.
    const r = addBtn.getBoundingClientRect();
    showContextMenu(r.left, r.bottom + 4, addContainerItems(state));
  });

  // Right-click on the panel's EMPTY space (not on a row): a panel-level menu with
  // the create actions plus a couple of common edits. A right-click on a row keeps
  // its own selection menu — the .layer-item guard lets that one win.
  const body = document.querySelector('.panel-body-layers');
  body?.addEventListener('contextmenu', (e) => {
    const ev = e as MouseEvent;
    if ((ev.target as Element).closest('.layer-item')) return; // row has its own menu
    ev.preventDefault();
    state.activePanel = 'layers';
    const items: ContextMenuItem[] = [...addContainerItems(state)];
    const extra = ['edit.paste', 'edit.select-all']
      .map((id) => commandItem(id, ctx))
      .filter((x): x is ContextMenuItem => !!x);
    if (extra.length) { items.push({ separator: true, label: '', action: () => {} }, ...extra); }
    showContextMenu(ev.clientX, ev.clientY, items);
  });
}

/** Create a new frame from the Layers panel: default 960×540, tiled just past the
 *  right edge of the existing frames (0 when there are none), then select+reveal. */
function addFrameFromPanel(state: AppState): void {
  const GAP = 40;
  const edge = state.artboards.reduce((m, a) => Math.max(m, a.x + a.width), 0);
  const x = edge > 0 ? edge + GAP : 0;
  const id = state.addFrame(x, 0, 960, 540, `Frame ${state.artboards.length + 1}`);
  state.selectShape(id);
  state.revealShape(id);
  // (The old footer buttons — move up/down, duplicate, delete — are gone: rows
  // drag to reorder, and the row context menu / shortcuts cover the rest.)
}
