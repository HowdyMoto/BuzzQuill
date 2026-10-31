// ---------------------------------------------------------------------------
// Gesture hints — the modifier keys and shortcuts available DURING a direct-
// manipulation gesture (moving, resizing, rotating, drawing a shape, nudging).
//
// They render into the tool-hint strip (ui/tool-hint.ts, which also holds the
// chip table GESTURE_HINTS) in its bold gesture style, each modifier chip lit the
// moment its key is held — so the strip is both a reference ("what can I press?")
// and live feedback ("it's active now"). One element for rest and gesture hints:
// a drag continues the strip rather than stacking a second box on it.
//
// Modifier state is tracked here via window key listeners, so a modifier pressed
// without moving the mouse still lights up. Callers only need showGestureHud() on
// each mousemove of a gesture (idempotent) and hideGestureHud() at the end.
// ---------------------------------------------------------------------------

import { beginGesture, paintGesture, endGesture, type GestureKind, type Mods } from './tool-hint';

export type { GestureKind };

let currentKind: GestureKind | null = null;

function modsOf(e: KeyboardEvent | MouseEvent): Mods {
  return { shift: e.shiftKey, mod: e.metaKey || e.ctrlKey, alt: e.altKey };
}

function onKey(e: KeyboardEvent): void {
  if (currentKind) paintGesture(modsOf(e));
}

/** Show (or refresh) the hints for a gesture. Idempotent: safe to call on every
 *  mousemove. `e` supplies the current modifier state. */
export function showGestureHud(kind: GestureKind, e: MouseEvent | KeyboardEvent): void {
  if (currentKind !== kind) {
    currentKind = kind;
    beginGesture(kind);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
  }
  paintGesture(modsOf(e));
}

export function hideGestureHud(): void {
  if (!currentKind) return;
  currentKind = null;
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('keyup', onKey, true);
  endGesture();
}
