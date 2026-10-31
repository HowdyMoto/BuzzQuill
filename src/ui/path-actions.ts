/**
 * Path-actions popover — brings the buried Path-menu operations (Offset, Outline)
 * and the new stroke modes (parallel Offset, knockout Cut) to the artwork, the
 * same way the Pathfinder popover surfaces booleans for a multi-selection.
 *
 * It leads with Edit Points for anything whose points can be edited: there is no
 * Direct Selection button in the toolbar (point editing is a double-click, Figma-
 * style), and a selected path gave no sign of that — the one thing most people
 * want to do with a path was the one thing the bar didn't offer.
 *
 * It floats over a SINGLE selected path-like shape (the Pathfinder popover owns
 * 2+ selections, so the two never overlap). Presentation + wiring only — the
 * geometry lives in strokes-panel (stack edits) and state/pathfinder (outline).
 */

import type { AppState } from '../core/state';
import type { ShapeData } from '../core/types';
import { addStroke } from './appearance-panel';
import { ensureOffsetEngine } from '../core/boolean';
import { selectionUnionRect, placeContextPopover, hideContextPopover } from './selection-popover';
import { hasDirection } from '../core/path-direction';
import { previewDirection, reverseSelectionWithFlourish } from './direction-overlay';

let popover: HTMLDivElement | null = null;

// Shapes whose geometry supports these stroke/path operations.
const PATH_TYPES = new Set<ShapeData['type']>([
  'rect', 'ellipse', 'line', 'polyline', 'path', 'polygon', 'boolean', 'appearance', 'width',
]);
// The stroke actions edit an appearance stack; a variable-width wrapper has none.
const hasStrokeStack = (_s: AppState, shape: ShapeData): boolean => shape.type !== 'width';

const ICON_OFFSET = '<svg viewBox="0 0 20 20" width="16" height="16"><path d="M3 7h14M3 13h14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_CUT = '<svg viewBox="0 0 20 20" width="16" height="16"><circle cx="5" cy="6" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5" cy="14" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7 7.5L18 14M7 12.5L18 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const ICON_POINTS = '<svg viewBox="0 0 20 20" width="16" height="16"><path d="M3 15.5 C 6.5 5, 13.5 5, 17 15.5" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="1.4" y="13.9" width="3.2" height="3.2" fill="currentColor"/><rect x="15.4" y="13.9" width="3.2" height="3.2" fill="currentColor"/><path d="M10 7.6 V 3.2 M7.5 3.2 h5" fill="none" stroke="currentColor" stroke-width="1.1"/><circle cx="10" cy="7.6" r="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
const ICON_OUTLINE = '<svg viewBox="0 0 20 20" width="16" height="16"><rect x="4" y="8" width="12" height="4" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

const ICON_REVERSE = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h12M12 4l3 3-3 3"/><path d="M17 13H5M8 10l-3 3 3 3"/></svg>';

interface Action {
  key: string; icon: string; label: string; title: string;
  run: (s: AppState) => void;
  /** Shown only when this holds for the selected shape (default: always). */
  when?: (s: AppState, shape: ShapeData) => boolean;
}

const ACTIONS: Action[] = [
  {
    key: 'edit-points', icon: ICON_POINTS, label: 'Edit Points',
    title: 'Edit the points of this path — or double-click it, or press A.',
    when: (s, shape) => s.canNodeEdit(shape.id),
    // The node tool edits the selection on activation; the return marker brings
    // Select back when the edit ends, exactly as the double-click route does.
    run: (s) => { if (!s.getSelectedShape()) return; s.nodeEditReturnTool = 'select'; s.requestTool?.('directSelect'); },
  },
  {
    key: 'reverse', icon: ICON_REVERSE, label: 'Reverse',
    title: 'Reverse Path Direction — run this path the other way. Nothing moves. Hover to see which way it runs now.',
    when: (_s, shape) => hasDirection(shape),
    run: (s) => reverseSelectionWithFlourish(s),
  },
  {
    key: 'offset', icon: ICON_OFFSET, label: 'Offset', when: hasStrokeStack,
    title: 'Add a parallel offset stroke — a live, adjustable line beside this one from the same path.',
    run: (s) => { void ensureOffsetEngine().then(() => addStroke(s, { offset: defaultOffset(s) })); },
  },
  {
    key: 'cut', icon: ICON_CUT, label: 'Cut', when: hasStrokeStack,
    title: 'Add a cut (knockout) stroke — punches an inline gap through the strokes below.',
    run: (s) => addStroke(s, { cut: true }),
  },
  {
    key: 'outline', icon: ICON_OUTLINE, label: 'Outline', when: hasStrokeStack,
    title: 'Outline Stroke — convert the stroke into a filled shape you can edit.',
    run: (s) => { void s.outlineSelectedStroke(); },
  },
];

/** A sensible starting offset: just clear of the current stroke's own width. */
function defaultOffset(state: AppState): number {
  const w = state.getSelectedShape()?.style.strokeWidth ?? state.defaultStyle.strokeWidth ?? 4;
  return Math.max(4, Math.round((w || 4) + 4));
}

export function setupPathActions(state: AppState): void {
  if (popover) return;
  const el = document.createElement('div');
  el.id = 'path-actions-popover';
  el.className = 'path-actions-popover ctx-popover';
  el.hidden = true;
  el.addEventListener('mousedown', (e) => e.stopPropagation()); // don't clear selection

  for (const a of ACTIONS) {
    const btn = document.createElement('button');
    btn.setAttribute('data-path-action', a.key);
    btn.title = a.title;
    btn.innerHTML = `${a.icon}<span>${a.label}</span>`;
    btn.addEventListener('click', () => a.run(state));
    if (a.key === 'reverse') { // Show the current direction before committing to flip it.
      btn.addEventListener('mouseenter', () => previewDirection([...state.selectedShapeIds]));
      btn.addEventListener('mouseleave', () => previewDirection([]));
    }
    el.appendChild(btn);
    if (a.key === 'reverse') { // editing | stroke operations
      const sep = document.createElement('span');
      sep.className = 'pf-pop-sep';
      sep.setAttribute('data-pa-sep', '');
      el.appendChild(sep);
    }
  }

  document.body.appendChild(el);
  popover = el;
}

/**
 * Show/position the popover over a single selected path-like shape. Called from
 * onStateChange and the canvas view-change hook so it tracks pan/zoom. Anchors
 * ABOVE the selection via the shared placeContextPopover — the one consistent
 * spot every contextual popover uses (Pathfinder, path-actions, image-actions).
 */
export function updatePathActionsPopover(state: AppState): void {
  const pop = popover;
  if (!pop) return;

  const only = state.selectedShapeIds.length === 1 ? state.getSelectedShape() : null;
  // Inside an entered group too: the bar anchors to one shape, and a path inside
  // a group is exactly where imported artwork keeps its paths.
  const show = state.currentTool === 'select'
    && !state.interactive
    && !state.editingPathId
    && !!only && PATH_TYPES.has(only.type);
  if (!show || !only) { hideContextPopover(pop, state); return; }

  for (const a of ACTIONS) {
    const btn = pop.querySelector<HTMLElement>(`[data-path-action="${a.key}"]`);
    if (btn) btn.style.display = !a.when || a.when(state, only) ? '' : 'none';
  }
  const sep = pop.querySelector<HTMLElement>('[data-pa-sep]');
  if (sep) sep.style.display = (state.canNodeEdit(only.id) || hasDirection(only)) && hasStrokeStack(state, only) ? '' : 'none';

  const rc = selectionUnionRect(state);
  if (!rc) { hideContextPopover(pop, state); return; }
  placeContextPopover(pop, rc, state.selectedShapeIds.join(',')); // consistent: above the selection, like all context popovers
}
