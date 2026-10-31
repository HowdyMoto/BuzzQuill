/**
 * Pathfinder UI — the Boolean ops, designed to fix Illustrator's opaque version:
 * verbs with diagram icons (not cryptic glyphs), a LIVE hover preview that ghosts
 * the real result on canvas before you commit, and a Subtract "swap" that removes
 * the front/back guessing game.
 *
 * Two surfaces share one set of behaviors (see {@link wireBoolButton}):
 *  - a docked side panel (always visible, discoverable), and
 *  - a contextual popover that floats over the selection so the ops come to the
 *    artwork instead of the user hiking to the panel.
 *
 * Geometry lives in core/boolean.ts and state.ts; this module is presentation
 * and interaction only.
 */

import type { AppState } from '../core/state';
import type { ShapeData } from '../core/types';
import type { BooleanOp } from '../core/boolean';
import { ensureBooleanEngine, booleanEngineReady } from '../core/boolean';
import { selectionIsBooleanable, NON_BOOLEANABLE } from '../core/pathfinder';
import { selectionUnionRect, placeContextPopover, hideContextPopover } from './selection-popover';
import { showToast } from './toast';
import { formatAccelerator } from '../commands';

// A clipping mask's TOP object must be vector (a raster can't be a clipPath).
const MASK_TOP_TYPES = new Set<ShapeData['type']>([
  'path', 'rect', 'ellipse', 'polygon', 'polyline', 'line', 'boolean', 'group', 'appearance', 'width', 'text',
]);

const ICON_JOIN = '<svg viewBox="0 0 20 20" width="16" height="16"><path d="M3 15.5 C 5.5 8.5, 7.5 8.5, 10 10 M17 4.5 C 14.5 11.5, 12.5 11.5, 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="10" r="2.1" fill="currentColor"/></svg>';
const ICON_MASK = '<svg viewBox="0 0 20 20" width="16" height="16"><rect x="2.5" y="2.5" width="15" height="15" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.4 1.8"/><circle cx="10" cy="10" r="5.2" fill="currentColor" fill-opacity="0.9"/></svg>';

function selectedShapes(state: AppState): ShapeData[] {
  return state.selectedShapeIds.map((id) => state.findShapeById(id)).filter((s): s is ShapeData => !!s);
}

/** Whether the current selection can be combined with a boolean op. */
function canBoolean(state: AppState): boolean {
  return selectionIsBooleanable(selectedShapes(state));
}

/** The topmost selected shape in DOM (z) order — the object that becomes the mask. */
function topSelected(state: AppState): ShapeData | null {
  const shapes = selectedShapes(state);
  if (shapes.length < 2) return null;
  let top = shapes[0];
  for (const s of shapes.slice(1)) {
    if (top.element.compareDocumentPosition(s.element) & Node.DOCUMENT_POSITION_FOLLOWING) top = s;
  }
  return top;
}

function rectsOverlap(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Whether the selection can be turned into a clipping mask: 2+ shapes, the top is
 * a vector mask, AND that mask actually overlaps something below it — masking with
 * a non-overlapping shape just yields an empty box, so we don't offer it.
 */
function canMask(state: AppState): boolean {
  const top = topSelected(state);
  if (!top || !MASK_TOP_TYPES.has(top.type)) return false;
  let maskRc: DOMRect;
  try { maskRc = top.element.getBoundingClientRect(); } catch { return false; }
  return selectedShapes(state).some((s) => {
    if (s.id === top.id) return false;
    try { return rectsOverlap(maskRc, s.element.getBoundingClientRect()); }
    catch { return false; }
  });
}

const PREVIEW_ATTR = 'data-boolean-preview';
const DIM_ATTR = 'data-boolean-dim'; // marks operands faded during a preview (stores original opacity)
const OPS: BooleanOp[] = ['unite', 'subtract', 'intersect', 'exclude', 'divide'];
const SWAP_TITLE = 'Subtract order — flips which shape is KEPT vs. cut away. Hover to preview; click to flip.';
let subtractSwapped = false;
let popover: HTMLDivElement | null = null;
// True while a boolean commit is running. The hover preview arrives ASYNC (after
// the engine warms up), so without this guard it can re-ghost the canvas after the
// click's clearPreview() and get caught by the commit's rebuild (#212).
let committing = false;

/** `getZoom` sizes Join's merge tolerance (a couple of screen pixels) at the
 *  current zoom, as the `path.join` command does. */
export function setupPathfinder(state: AppState, getZoom: () => number = () => 1): void {
  // Docked panel buttons (icons authored in index.html).
  document.querySelectorAll<HTMLButtonElement>('.pathfinder-buttons button[data-bool]')
    .forEach((btn) => wireBoolButton(state, btn, btn.getAttribute('data-bool') as BooleanOp));

  const dockSwap = document.getElementById('pf-swap') as HTMLButtonElement | null;
  if (dockSwap) wireSwapButton(state, dockSwap);
  document.getElementById('pf-flatten')?.addEventListener('click', () => flattenSelected(state));

  buildPopover(state, getZoom);
}

/** Reflect the current selection in the docked panel's enabled/disabled state. */
export function updatePathfinderPanel(state: AppState): void {
  const canCombine = canBoolean(state);
  document.querySelectorAll<HTMLButtonElement>('.pathfinder-buttons button[data-bool]')
    .forEach((btn) => { btn.disabled = !canCombine; });

  const isBoolean = state.getSelectedShape()?.type === 'boolean';
  const swap = document.getElementById('pf-swap') as HTMLButtonElement | null;
  if (swap) { swap.style.display = canCombine ? '' : 'none'; swap.classList.toggle('active', subtractSwapped); }
  const flatten = document.getElementById('pf-flatten') as HTMLButtonElement | null;
  if (flatten) flatten.style.display = isBoolean ? '' : 'none';

  const hint = document.getElementById('pf-hint');
  if (hint) {
    hint.textContent = canCombine ? '' : isBoolean ? 'Double-click to edit · Flatten to commit' : disabledReason(state);
    hint.style.display = hint.textContent ? '' : 'none';
  }
}

/** Why the ops are greyed out for THIS selection. "Select 2+ shapes" was shown even
 *  when 4 things were selected (one of them a frame or a text), which reads as the
 *  panel being broken rather than the selection being wrong. */
function disabledReason(state: AppState): string {
  const shapes = selectedShapes(state);
  if (shapes.length < 2) return 'Select 2+ shapes';
  const blockers = [...new Set(shapes.filter((s) => NON_BOOLEANABLE.includes(s.type)).map((s) => s.type))];
  if (blockers.length === 0) return 'Select 2+ shapes';
  const names: Partial<Record<ShapeData['type'], string>> = {
    text: 'Text', image: 'Images', frame: 'Frames', use: 'Symbols',
  };
  const label = blockers.map((t) => names[t] ?? t).join(' & ');
  const tip = blockers.includes('image') || blockers.includes('text') ? ' — try Mask instead' : '';
  return `${label} can’t be combined${tip}`;
}

// ---- Contextual floating popover ----

/** Build the popover once and append it to the body (position: fixed). */
function buildPopover(state: AppState, getZoom: () => number): void {
  if (popover) return;
  const el = document.createElement('div');
  el.id = 'pathfinder-popover';
  el.className = 'pathfinder-popover ctx-popover';
  el.hidden = true;
  // Don't let a click on the popover bubble out and clear the selection.
  el.addEventListener('mousedown', (e) => e.stopPropagation());

  for (const op of OPS) {
    const btn = document.createElement('button');
    btn.setAttribute('data-bool', op);
    const src = document.querySelector(`.pathfinder-buttons button[data-bool="${op}"]`);
    btn.innerHTML = src?.innerHTML ?? op;
    btn.title = src?.getAttribute('title') ?? op;
    wireBoolButton(state, btn, op);
    el.appendChild(btn);
  }

  const sep = document.createElement('span');
  sep.className = 'pf-pop-sep';
  sep.setAttribute('data-pf-boolsep', '');
  el.appendChild(sep);

  const swap = document.createElement('button');
  swap.id = 'pf-pop-swap';
  swap.className = 'pf-pop-swap';
  swap.title = SWAP_TITLE;
  swap.innerHTML = '&#x21C4;';
  wireSwapButton(state, swap);
  el.appendChild(swap);

  // Separator + Mask: use the top shape to clip/crop everything below it. Shown for
  // all-vector selections (beside the booleans) AND for image + shape selections,
  // where booleans are hidden — that's how you crop a raster to a shape.
  const masksep = document.createElement('span');
  masksep.className = 'pf-pop-sep';
  masksep.setAttribute('data-pf-masksep', '');
  el.appendChild(masksep);

  const mask = document.createElement('button');
  mask.id = 'pf-pop-mask';
  mask.className = 'pf-pop-text';
  mask.setAttribute('data-mask', '');
  mask.title = `Mask — the highlighted TOP shape clips/crops everything below it (${formatAccelerator('Mod+7')}). Great for cropping an image to a shape.`;
  mask.innerHTML = `${ICON_MASK}<span>Mask</span>`;
  mask.addEventListener('click', () => { clearMaskHint(); state.makeClippingMask(); });
  // Hovering previews WHICH object is the mask: outline it + label it, and dim the
  // objects it will clip — same "show what happens" intent as the boolean hover.
  mask.addEventListener('mouseenter', () => showMaskHint(state));
  mask.addEventListener('mouseleave', clearMaskHint);
  el.appendChild(mask);

  // Separator + Join (⌘J): two open paths become ONE, connected at their nearest
  // ends. The booleans above also accept two open strokes, but they are rarely
  // what a stroke drawer wants from them — Join is, and it had no on-canvas home.
  const joinsep = document.createElement('span');
  joinsep.className = 'pf-pop-sep';
  joinsep.setAttribute('data-pf-joinsep', '');
  el.appendChild(joinsep);

  const join = document.createElement('button');
  join.id = 'pf-pop-join';
  join.className = 'pf-pop-text';
  join.setAttribute('data-join', '');
  join.title = `Join — connect the two open paths at their nearest ends into one path (${formatAccelerator('Mod+J')}).`;
  join.innerHTML = `${ICON_JOIN}<span>Join</span>`;
  // Ends within ~2 screen pixels merge into one point; further apart, a straight segment joins them.
  join.addEventListener('click', () => { state.joinPaths(2 / getZoom()); });
  el.appendChild(join);

  document.body.appendChild(el);
  popover = el;
}

/**
 * Show/position the popover over the current selection. Called from onStateChange
 * (selection/edit changes) and the canvas view-change hook (pan/zoom), so it
 * tracks the shapes as the canvas moves. Cheap; bails fast when not applicable.
 */
export function updatePathfinderPopover(state: AppState): void {
  const pop = popover;
  if (!pop) return;

  const bool = canBoolean(state);
  const mask = canMask(state);
  const join = state.selectedShapeIds.length === 2 && state.canJoinPaths();
  const isolated = state.activeGroupId ? state.findShapeById(state.activeGroupId) : null;
  const show = state.currentTool === 'select'
    && !state.interactive
    && !state.editingPathId
    && isolated?.type !== 'boolean' // inside a group is fine; inside a live boolean its operands are spoken for
    && (bool || mask || join); // booleans need all-vector; Mask a vector on top (crops rasters too); Join two open paths
  if (!show) { hideContextPopover(pop, state); clearMaskHint(); return; }

  // Boolean ops + swap show only when the whole selection is vector; Mask shows
  // whenever the top object is a valid vector mask. The separators bracket Mask
  // only when it sits beside the booleans.
  const setDisp = (sel: string, on: boolean) => {
    const n = pop.querySelector<HTMLElement>(sel); if (n) n.style.display = on ? '' : 'none';
  };
  pop.querySelectorAll<HTMLElement>('button[data-bool]').forEach((b) => { b.style.display = bool ? '' : 'none'; });
  setDisp('#pf-pop-swap', bool);
  setDisp('[data-pf-boolsep]', bool);
  setDisp('[data-pf-masksep]', bool && mask);
  setDisp('#pf-pop-mask', mask);
  setDisp('[data-pf-joinsep]', join && (bool || mask));
  setDisp('#pf-pop-join', join);
  pop.classList.toggle('join-first', join); // two open strokes: Join before the booleans

  const rc = selectionUnionRect(state);
  if (!rc) { hideContextPopover(pop, state); return; }
  pop.querySelector('#pf-pop-swap')?.classList.toggle('active', subtractSwapped);
  placeContextPopover(pop, rc, state.selectedShapeIds.join(',')); // consistent: above the selection, like all context popovers
}

// ---- Mask hover preview: show the ACTUAL clipped result ----

const MASK_NS = 'http://www.w3.org/2000/svg';
const MASK_DIM_ATTR = 'data-mask-dim';
let maskChip: HTMLDivElement | null = null;
let maskPreviewSeq = 0;

/** Deep-strip id + data-name from a clone so it can't shadow real elements. */
function stripPreviewIds(el: Element): Element {
  el.removeAttribute('id');
  el.removeAttribute('data-name');
  for (const c of Array.from(el.children)) stripPreviewIds(c);
  return el;
}

/** Store & override an element's inline opacity (restored by clearMaskHint). */
function dimForMask(el: SVGElement, opacity: number): void {
  const e = el as SVGElement & { style: CSSStyleDeclaration };
  const cur = e.style.opacity !== '' ? e.style.opacity : (e.getAttribute('opacity') ?? '1');
  e.setAttribute(MASK_DIM_ATTR, cur);
  e.style.opacity = String(opacity);
}

/**
 * Hover preview for the Mask button — a transient photocopy of makeClippingMask's
 * own DOM (a self-contained `<g clip-path>` whose `<clipPath>` holds a clone of the
 * cutter, wrapping clones of the clipped objects). It renders the EXACT clipped
 * result bright on top; the real cutter fades to a dashed "MASK" silhouette (it's
 * consumed by the clip) and the real clipped objects fade to a faint "what's cut"
 * ghost — so the hover matches what commit produces, images and vectors alike.
 */
function showMaskHint(state: AppState): void {
  clearMaskHint();
  const plan = state.clipMaskPlan();
  if (!plan) return;
  const { cutter, clipped, parent } = plan;

  // The clipped-result ghost: identical structure to the committed clip-group, on
  // id-stripped clones, inserted in the same z-slot so it layers correctly.
  const clipId = `maskpreview-${++maskPreviewSeq}`;
  const g = document.createElementNS(MASK_NS, 'g');
  g.setAttribute('data-mask-preview', '');
  g.setAttribute('pointer-events', 'none');
  g.setAttribute('clip-path', `url(#${clipId})`);
  const clipPathEl = document.createElementNS(MASK_NS, 'clipPath');
  clipPathEl.setAttribute('id', clipId);
  clipPathEl.appendChild(stripPreviewIds(cutter.element.cloneNode(true) as SVGElement));
  g.appendChild(clipPathEl);
  for (const s of clipped) g.appendChild(stripPreviewIds(s.element.cloneNode(true) as SVGElement));
  parent.insertBefore(g, cutter.element.nextSibling);

  // Dashed silhouette of the cutter (which vanishes in the result), on top.
  const outline = stripPreviewIds(cutter.element.cloneNode(true) as SVGElement);
  outline.setAttribute('data-mask-preview', '');
  outline.setAttribute('fill', 'none');
  outline.setAttribute('stroke', '#2d7ff9');
  outline.setAttribute('stroke-width', '1.5');
  outline.setAttribute('stroke-dasharray', '4 3');
  outline.setAttribute('vector-effect', 'non-scaling-stroke');
  outline.setAttribute('pointer-events', 'none');
  outline.removeAttribute('opacity');
  g.parentNode!.insertBefore(outline, g.nextSibling);

  // Fade the originals: cutter → 0 (paint is consumed), clipped → faint ghost.
  dimForMask(cutter.element, 0);
  for (const s of clipped) dimForMask(s.element, 0.18);

  // "MASK" chip pinned to the cutter (names which shape does the cutting).
  let rc: DOMRect;
  try { rc = cutter.element.getBoundingClientRect(); } catch { return; }
  const chip = document.createElement('div');
  chip.textContent = 'MASK';
  chip.style.cssText = 'position:fixed;pointer-events:none;z-index:60;background:#2d7ff9;color:#fff;' +
    'font:600 10px/1.4 system-ui,sans-serif;letter-spacing:.05em;padding:0 5px;border-radius:3px;white-space:nowrap;' +
    `left:${Math.round(rc.left)}px;top:${Math.round(Math.max(2, rc.top - 15))}px;`;
  document.body.appendChild(chip);
  maskChip = chip;
}

function clearMaskHint(): void {
  maskChip?.remove();
  maskChip = null;
  document.querySelectorAll('#drawing-layer [data-mask-preview]').forEach((el) => el.remove());
  document.querySelectorAll<SVGElement>(`[${MASK_DIM_ATTR}]`).forEach((el) => {
    const orig = el.getAttribute(MASK_DIM_ATTR) ?? '1';
    if (orig === '1' || orig === '') el.style.removeProperty('opacity'); else el.style.opacity = orig;
    el.removeAttribute(MASK_DIM_ATTR);
  });
}

// ---- Shared behavior ----

/** Why an op yielded nothing — the shapes are legal operands, the RESULT is empty.
 *  Said plainly, because the alternative (what shipped) is a button that looks
 *  enabled, is clicked, and does nothing at all. */
const EMPTY_RESULT_MSG: Record<BooleanOp, string> = {
  intersect: 'Nothing to intersect — the shapes don’t overlap.',
  subtract: 'Nothing left — the front shape covers the one behind. Try the swap (⇄) to flip which shape is kept.',
  exclude: 'Nothing left — the shapes cancel out exactly.',
  divide: 'Nothing to divide — the shapes don’t overlap.',
  unite: 'Nothing to unite — the shapes have no fillable area.',
};

/** Subtract refuses for two different reasons and they need different words: the
 *  cutter missed entirely (nothing to cut), or it covered the base completely
 *  (nothing left). The engine is warm by the time this runs — the op just used it —
 *  so the overlap test is a cheap synchronous preview. */
function emptyResultMsg(state: AppState, op: BooleanOp): string {
  if (op === 'subtract' && state.previewSelectionBoolean('intersect').length === 0) {
    return 'Nothing to subtract — the shapes don’t overlap, so there is nothing to cut away.';
  }
  return EMPTY_RESULT_MSG[op];
}

function wireBoolButton(state: AppState, btn: HTMLButtonElement, op: BooleanOp): void {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    clearPreview();
    committing = true;
    void state.booleanSelection(op, op === 'subtract' && subtractSwapped)
      .then((ok) => { if (!ok) showToast(emptyResultMsg(state, op), 3400, undefined, 'info'); })
      .finally(() => { committing = false; });
  });
  // Live preview: warm the engine on hover, then ghost the result on canvas.
  btn.addEventListener('mouseenter', () => {
    if (btn.disabled) return;
    const reverse = op === 'subtract' && subtractSwapped;
    if (booleanEngineReady()) { showPreview(state, op, reverse); return; }
    void ensureBooleanEngine().then(() => { if (btn.matches(':hover') && !committing) showPreview(state, op, reverse); });
  });
  btn.addEventListener('mouseleave', clearPreview);
}

function toggleSwap(): void {
  subtractSwapped = !subtractSwapped;
  document.getElementById('pf-swap')?.classList.toggle('active', subtractSwapped);
  document.getElementById('pf-pop-swap')?.classList.toggle('active', subtractSwapped);
}

/**
 * The Subtract "swap" only means something if you can SEE it: on hover it ghosts
 * the Subtract result, and clicking flips the order and re-ghosts immediately — so
 * the shape visibly changes and you understand which object is kept vs. cut. (Swap
 * is a Subtract-only modifier, so its preview is always the Subtract result.)
 */
function wireSwapButton(state: AppState, btn: HTMLButtonElement): void {
  const preview = () => {
    if (state.selectedShapeIds.length < 2) return;
    if (booleanEngineReady()) { showPreview(state, 'subtract', subtractSwapped); return; }
    void ensureBooleanEngine().then(() => { if (btn.matches(':hover') && !committing) showPreview(state, 'subtract', subtractSwapped); });
  };
  btn.addEventListener('mouseenter', preview);
  btn.addEventListener('mouseleave', clearPreview);
  btn.addEventListener('click', () => { toggleSwap(); preview(); });
}

function flattenSelected(state: AppState): void {
  const p = state.getSelectedShape();
  if (p?.type === 'boolean') state.flattenBoolean(p.id);
}

// ---- Preview ghost (drawn in drawing-layer space, never committed) ----

/**
 * Preview the boolean the way the user reasoned about it: what you KEEP is drawn
 * solid at full opacity with its real fill (the outcome, as it'll actually look),
 * and what's TAKEN AWAY fades — the selected operands drop to half opacity, so the
 * removed regions read as "going away" while the kept regions get covered by the
 * opaque result on top. (The old tinted "what remains" overlay read as darkened /
 * excluded — backwards.)
 */
function showPreview(state: AppState, op: BooleanOp, reverse: boolean): void {
  if (committing) return; // never ghost while a commit's rebuild may be running
  clearPreview();
  const dl = document.getElementById('drawing-layer');
  if (!dl) return;
  const ds = state.previewSelectionBoolean(op, reverse);
  if (!ds.length) return;

  // The result's fill = the kept (primary) shape's fill, so it looks like the real
  // outcome rather than an abstract tint.
  let fill = '#8a8f98';
  const primary = state.getSelectedShape()?.element as SVGElement | undefined;
  if (primary) {
    const f = getComputedStyle(primary).fill;
    if (f && f !== 'none' && f !== 'rgba(0, 0, 0, 0)') fill = f;
  }

  // Fade the operands to a QUARTER of their current opacity — the removed parts read
  // as clearly going away; the kept parts sit under the opaque result drawn below.
  for (const id of state.selectedShapeIds) {
    const el = state.findShapeById(id)?.element as (SVGElement & { style: CSSStyleDeclaration }) | undefined;
    if (!el) continue;
    const cur = el.style.opacity !== '' ? el.style.opacity : (el.getAttribute('opacity') ?? '1');
    el.setAttribute(DIM_ATTR, cur);
    el.style.opacity = String((parseFloat(cur) || 1) * 0.25);
  }

  const SVG = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(SVG, 'g');
  g.setAttribute(PREVIEW_ATTR, '');
  g.setAttribute('pointer-events', 'none');
  for (const d of ds) {
    if (!d.trim()) continue;
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', fill);
    p.setAttribute('fill-rule', 'evenodd');
    // A hairline accent outline just delineates the result edge (not a fill tint).
    p.setAttribute('stroke', '#2d7ff9');
    p.setAttribute('stroke-width', '1');
    p.setAttribute('vector-effect', 'non-scaling-stroke');
    g.appendChild(p);
  }
  dl.appendChild(g);
}

function clearPreview(): void {
  document.querySelectorAll(`#drawing-layer [${PREVIEW_ATTR}]`).forEach((el) => el.remove());
  document.querySelectorAll<SVGElement>(`#drawing-layer [${DIM_ATTR}]`).forEach((el) => {
    const orig = el.getAttribute(DIM_ATTR) ?? '1';
    if (orig === '1' || orig === '') el.style.removeProperty('opacity');
    else el.style.opacity = orig;
    el.removeAttribute(DIM_ATTR);
  });
}
