// ---------------------------------------------------------------------------
// Tool hint — the one strip at the top of the canvas that answers "what can I do
// right now?" for the active tool and the current selection.
//
// Rest hints come from TOOL_HINTS, one row per ToolName (a compile error until a
// new tool has one), each a function of state so the chips fit the moment: a
// selected path says what a double-click does to it, a picked end point says how
// to reach Join, a text being typed says how to finish. Gesture hints — the
// modifier keys DURING a drag (GESTURE_HINTS, driven by ui/gesture-hud.ts) —
// render into the SAME element in a bolder style with the held modifiers lit, so a
// drag continues the strip instead of stacking a second box on it: when a drag's
// chips are the ones already showing (a shape tool at rest shows its drag's
// chips), nothing is re-rendered and nothing blinks. The contextual popovers keep
// clear of the strip's band (ui/selection-popover.ts).
//
// A chip is `key · what it does`; the keycap holds only a key or a gesture token
// (Shift, Alt+drag, Double-click, Esc), never a sentence. A chip that carries a
// command is the action the current state has just unlocked (two end points →
// Join): it renders as a real button in an "available now" style, so it can be
// clicked as well as read. Everything else is visual chrome, hidden from assistive
// tech — menus carry the same facts with their accelerators. Never advertise an
// operation whose result would be indistinguishable from doing nothing.
// ---------------------------------------------------------------------------

import type { AppState } from '../core/state';
import type { PathEditSession, AnchorRef } from '../core/path-edit';
import type { ToolName } from '../core/types';
import { formatAccelerator, IS_MAC } from '../commands';
import { hintsEnabled, onHintsChange } from './hint-prefs';
import { hoveredDirection } from './direction-overlay';

export interface HintChip {
  key: string;
  label: string;
  /** A command id: the chip becomes a button that runs it. */
  command?: string;
}

export type GestureKind =
  | 'move' | 'resize' | 'rotate'   // select tool
  | 'nudge'                         // arrow-key move
  | 'rect' | 'ellipse' | 'line'     // shape drags with constraints
  | 'star' | 'polygon'              // point/side count
  | 'pen' | 'pen-start'             // click-to-place (closing needs three points)
  | 'crop';                         // crop handle drag (no modifiers)

export interface Mods { shift: boolean; mod: boolean; alt: boolean }
export interface GestureHint {
  key: string;
  /** Fixed, or read from state when the gesture's meaning depends on a setting. */
  label: string | ((s: AppState | null) => string);
  active?: (m: Mods) => boolean;
}

const MOD = IS_MAC ? '⌘' : 'Ctrl';
const ALT = IS_MAC ? '⌥' : 'Alt';
const JOIN = formatAccelerator('Mod+J');

const chip = (key: string, label: string, command?: string): HintChip => ({ key, label, command });

/** Modifier chips for each gesture; `active` lights the chip while its key is held. */
export const GESTURE_HINTS: Record<GestureKind, GestureHint[]> = {
  move: [
    { key: 'Shift', label: 'straight', active: (m) => m.shift },
    { key: MOD, label: 'ignore guides', active: (m) => m.mod },
  ],
  resize: [
    // With the aspect lock on, Shift is what FREES the resize (select.ts).
    { key: 'Shift', label: (s) => (s?.aspectLocked ? 'free' : 'proportional'), active: (m) => m.shift },
    { key: MOD, label: 'ignore guides', active: (m) => m.mod },
  ],
  rotate: [
    { key: 'Shift', label: 'snap 15°', active: (m) => m.shift },
  ],
  nudge: [
    { key: '↑ ↓ ← →', label: 'move 1px, hold to go faster' },
    { key: 'Shift', label: 'move 10px', active: (m) => m.shift },
  ],
  rect: [
    { key: 'Shift', label: 'square', active: (m) => m.shift },
    { key: ALT, label: 'from center', active: (m) => m.alt },
  ],
  ellipse: [
    { key: 'Shift', label: 'circle', active: (m) => m.shift },
    { key: ALT, label: 'from center', active: (m) => m.alt },
  ],
  line: [
    { key: 'Shift', label: '45° angles', active: (m) => m.shift },
  ],
  star: [
    { key: 'Shift', label: 'regular', active: (m) => m.shift },
    { key: ALT, label: 'from center', active: (m) => m.alt },
    { key: '↑ ↓', label: 'points' },
  ],
  polygon: [
    { key: 'Shift', label: 'regular', active: (m) => m.shift },
    { key: ALT, label: 'from center', active: (m) => m.alt },
    { key: '↑ ↓', label: 'sides' },
  ],
  'pen-start': [
    { key: 'Enter', label: 'or double-click to finish' },
    { key: 'Esc', label: 'cancel' },
  ],
  pen: [
    { key: 'Click', label: 'the start point to close' },
    { key: 'Enter', label: 'or double-click to finish' },
    { key: 'Esc', label: 'cancel' },
  ],
  crop: [
    { key: 'Enter', label: 'apply' },
    { key: 'Esc', label: 'cancel' },
  ],
};

const resolveLabel = (h: GestureHint, s: AppState | null): string => (typeof h.label === 'function' ? h.label(s) : h.label);

/** The gesture's chips at rest (before the drag), so the drag continues them. */
const atRest = (kind: GestureKind, s: AppState): HintChip[] => GESTURE_HINTS[kind].map((h) => chip(h.key, resolveLabel(h, s)));

// ---- Per-tool hints ----------------------------------------------------------

/** Select: what a double-click does to THIS selection, Join when it applies, and
 *  the way out of an entered group — appended, so a path inside a group still
 *  learns about its points (imported artwork is nested groups all the way down). */
function selectHints(s: AppState): HintChip[] {
  const ids = s.selectedShapeIds;
  const out: HintChip[] = [];
  if (ids.length === 0) out.push(chip('Click', 'select'), chip('Drag', 'box-select'));
  else if (ids.length === 2 && s.canJoinPaths()) out.push(chip(JOIN, 'join the two paths', 'path.join'));
  else if (ids.length >= 2) out.push(chip(formatAccelerator('Mod+G'), 'group'), chip('Shift+click', 'add or remove'));
  else out.push(...singleHints(s, ids[0]));
  if (s.activeGroupId) out.push(chip('Esc', 'step back out'));
  return out;
}

function singleHints(s: AppState, id: string): HintChip[] {
  const sh = s.findShapeById(id);
  if (!sh || sh.locked) return [];
  if (sh.element.hasAttribute('data-clip-group')) return [chip('Double-click', 'edit the mask shape')];
  switch (sh.type) {
    case 'group': return (sh.children?.length ?? 0) > 0 ? [chip('Double-click', 'select an item inside')] : [];
    case 'repeat': return [chip('Double-click', 'edit the repeated item')];
    case 'boolean': return [chip('Double-click', 'edit the shapes inside')];
    case 'text': return [chip('Double-click', 'edit text')];
    case 'image': return [chip('Double-click', 'crop')];
    case 'frame': return [chip('Double-click', 'the name to rename')];
    default: break;
  }
  if (s.canNodeEdit(sh.id)) {
    const out = [chip('Double-click', 'edit points')];
    if (s.canJoinPaths()) out.push(chip(JOIN, 'close path', 'path.join'));
    return out;
  }
  // A rectangle or an ellipse — the first thing anyone draws: the basics, not silence.
  return [chip('Shift+click', 'add or remove'), chip('Right-click', 'more actions')];
}

/** Whether `ref` is the first or last point of an OPEN run — a point Join can connect. */
function isOpenEnd(session: PathEditSession, ref: AnchorRef): boolean {
  const sp = session.model.subpaths[ref.sp];
  if (!sp || sp.closed || sp.anchors.length < 2) return false;
  return ref.i === 0 || ref.i === sp.anchors.length - 1;
}

/** Node editing: before any point is picked it teaches selecting / adding; with
 *  points picked, moving / converting / deleting; and it walks the user to Join.
 *  One end picked on a single run: ⌘J already closes it, say so. One end picked on
 *  a compound path: the end to join is on another run — say which to Shift-click.
 *  Two ends picked: Join lights up. When a join chip leads, the always-true chips
 *  step aside so the strip stays four chips wide. */
function nodeHints(s: AppState): HintChip[] {
  const session = s.pathEdit;
  if (!s.editingPathId || !session) {
    return [chip('Click', 'select a path'), chip('Double-click', 'edit its points'), chip('V', 'back to Select')];
  }
  const refs = session.selectedRefs();
  const joinable = s.canJoinPaths();
  const openRuns = session.model.subpaths.filter((sp) => !sp.closed && sp.anchors.length >= 2).length;
  const done = chip('Esc', 'done');
  if (refs.length === 0) {
    const out = [chip('Click', 'select a point'), chip('Double-click', 'add a point'), chip(`${ALT}+drag`, 'pull a curve')];
    if (joinable) out.push(chip(JOIN, 'close path', 'path.join'));
    return [...out, done];
  }
  if (refs.length === 2 && joinable) {
    const same = refs[0].sp === refs[1].sp;
    return [chip(JOIN, same ? 'close path' : 'join ends', 'path.join'), chip('Drag', 'move'), chip('Del', 'remove'), done];
  }
  if (refs.length === 1 && isOpenEnd(session, refs[0])) {
    const lead = openRuns >= 2 ? chip('Shift+click', 'an end of another run to join')
      : joinable ? chip(JOIN, 'close path', 'path.join') : null;
    if (lead) return [lead, chip('Drag', 'move'), chip('Del', 'remove'), done];
  }
  return [chip('Drag', 'move'), chip('Double-click', 'smooth / corner'), chip(`${ALT}+drag`, 'pull a curve or break a handle'), chip('Del', 'remove'), done];
}

/** Pen: with a path selected and nothing in progress it edits that path's points
 *  (Illustrator's +/-) and a click elsewhere starts a new one; otherwise it draws.
 *  Once a point is placed the gesture chips take over (finish / close / cancel). */
function penHints(s: AppState): HintChip[] {
  const sel = s.getSelectedShape();
  if (sel && sel.type === 'path' && !sel.locked) {
    return [chip('Click', 'a point to remove it, the edge to add one'), chip('Click', 'empty space to start a path')];
  }
  return [chip('Click', 'corner point'), chip('Drag', 'curve point'), chip('Shift', 'horizontal / vertical')];
}

/** Text: while the editor is open, how to finish; otherwise how to start. The tool
 *  marks its editor and refreshes the strip, since no state change carries that. */
function textHints(): HintChip[] {
  if (document.querySelector('textarea[data-text-editor]')) return [chip('Esc', 'done'), chip('Enter', 'new line')];
  return [chip('Click', 'point text'), chip('Drag', 'text box')];
}

/** Shape Builder: its faces arrive async, so it reads the tool's layer — busy while
 *  the pieces are being found, populated when they are, empty when the selection
 *  couldn't be decomposed (it needs 2+ overlapping shapes, picked with Select). */
function shapeBuilderHints(): HintChip[] {
  const layer = document.getElementById('shapebuilder-layer');
  if (!layer || layer.hasAttribute('data-busy')) return [];
  if (layer.childElementCount > 0) {
    return [chip('Drag', 'merge pieces'), chip(`${ALT}+click`, 'delete a piece'), chip('Enter', 'apply'), chip('Esc', 'cancel')];
  }
  return [chip('V', 'back to Select, then pick 2+ overlapping shapes')];
}

/** Direction: what's under the pointer and how it runs right now — the thing you came
 *  to find out. With paths selected, one key turns them all around. */
function directionHints(s: AppState): HintChip[] {
  const over = hoveredDirection();
  if (over) return [chip('Click', `reverse “${over.name}”`), chip('Runs', over.summary)];
  const out = [chip('Click', 'a path to reverse it')];
  if (s.canReversePaths()) out.push(chip(formatAccelerator('Mod+Alt+R'), 'reverse the selection', 'path.reverse'));
  return [...out, chip('Esc', 'done')];
}

const TOOL_HINTS: Record<ToolName, (s: AppState) => HintChip[]> = {
  select: selectHints,
  directSelect: nodeHints,
  rect: (s) => atRest('rect', s),
  ellipse: (s) => atRest('ellipse', s),
  line: (s) => atRest('line', s),
  arrow: () => [chip('Drag', 'draw')],
  star: (s) => atRest('star', s),
  polygon: (s) => atRest('polygon', s),
  pen: penHints,
  text: textHints,
  eyedropper: (s) => s.selectedShapeIds.length > 0
    ? [chip('Click', 'an object to copy its look onto the selection')]
    : [chip('Click', 'an object to set the style for new shapes')],
  frame: () => [chip('Drag', 'draw a frame')],
  hand: () => [chip('Drag', 'pan')],
  zoom: () => [chip('Click', 'zoom in'), chip(`${ALT}+click`, 'zoom out')],
  crop: (s) => [chip('Drag', 'the handles to crop'), ...atRest('crop', s)],
  shapeBuilder: shapeBuilderHints,
  direction: directionHints,
};

// ---- Rendering ----------------------------------------------------------------

let lastState: AppState | null = null;
let lastKey = '';
let runCommandById: ((id: string) => void) | null = null;
// While a gesture is up the strip shows its chips and ignores rest updates.
let gestureChips: { el: Element; active?: (m: Mods) => boolean }[] | null = null;

/** Wire the accent chips to the command registry (main.ts). */
export function setHintCommandRunner(run: (id: string) => void): void { runCommandById = run; }

const stripEl = (): HTMLElement | null => document.getElementById('tool-hint');
const keyOf = (chips: HintChip[]): string => chips.map((c) => `${c.key}\t${c.label}\t${c.command ?? ''}`).join('\n');

function chipEl(key: string, label: string, command?: string): HTMLElement {
  const el = document.createElement(command ? 'button' : 'span');
  el.className = command ? 'gesture-hud-chip accent' : 'gesture-hud-chip';
  if (command) {
    const btn = el as HTMLButtonElement;
    btn.type = 'button';
    btn.setAttribute('aria-label', `${label} (${key})`);
    btn.addEventListener('click', () => runCommandById?.(command));
  } else {
    el.setAttribute('aria-hidden', 'true'); // visual chrome; the menus carry the same facts
  }
  const kbd = document.createElement('kbd');
  kbd.textContent = key;
  const text = document.createElement('span');
  text.className = 'gesture-hud-label';
  text.textContent = label;
  el.append(kbd, text);
  return el;
}

/** Put `chips` in the strip unless they are what is showing already. */
function show(el: HTMLElement, chips: HintChip[]): void {
  const key = keyOf(chips);
  if (key !== lastKey) {
    el.replaceChildren(...chips.map((c) => chipEl(c.key, c.label, c.command)));
    lastKey = key;
  }
  el.hidden = false;
}

/** Reflect the active tool + selection in the strip. Cheap when nothing changed. */
export function updateToolHint(state: AppState): void {
  lastState = state;
  if (gestureChips) return; // the gesture owns the strip until it ends
  const el = stripEl();
  if (!el) return;
  const chips = hintsEnabled() ? (TOOL_HINTS[state.currentTool]?.(state) ?? []) : [];
  if (chips.length === 0) { el.hidden = true; lastKey = ''; return; }
  show(el, chips);
}

/** Re-render for the last state — for a change no state notification carries
 *  (Shape Builder's faces arriving, a text editor opening, the preference). */
export function refreshToolHint(): void {
  if (lastState) updateToolHint(lastState);
}

onHintsChange(refreshToolHint);

// ---- Gesture mode (driven by ui/gesture-hud.ts) ------------------------------

/** Swap the strip to a gesture's chips in the bold gesture style. When they are the
 *  chips already showing (a shape tool at rest shows its drag's chips) the content
 *  stays put and only the style changes; a new set bulges in once, on entering the
 *  gesture — never on the kind changing mid-gesture, and never while hints are off. */
export function beginGesture(kind: GestureKind): void {
  const el = stripEl();
  if (!el || !hintsEnabled()) return;
  const hints = GESTURE_HINTS[kind];
  const entering = !gestureChips;
  const changed = keyOf(hints.map((h) => chip(h.key, resolveLabel(h, lastState)))) !== lastKey;
  show(el, hints.map((h) => chip(h.key, resolveLabel(h, lastState))));
  gestureChips = hints.map((h, i) => ({ el: el.children[i], active: h.active }));
  el.classList.add('gesturing');
  if (entering && changed) {
    el.classList.remove('gh-pop');
    void el.offsetWidth; // reflow so the animation restarts even if the class was already on
    el.classList.add('gh-pop');
  }
}

/** Light the chips whose modifier is held. */
export function paintGesture(m: Mods): void {
  for (const c of gestureChips ?? []) c.el.classList.toggle('active', !!c.active && c.active(m));
}

/** The gesture is over: back to the rest hints for the current state — which stay
 *  in place, unanimated, when they are the same chips. */
export function endGesture(): void {
  if (!gestureChips) return;
  for (const c of gestureChips) c.el.classList.remove('active');
  gestureChips = null;
  stripEl()?.classList.remove('gesturing', 'gh-pop');
  refreshToolHint();
}
