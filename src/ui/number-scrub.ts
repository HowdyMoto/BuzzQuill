/**
 * Unity-style scrubbable numeric inputs — an app-wide design-system behavior.
 *
 * Two drag handles, both covering every `<input type="number">`:
 *   1. A `<label>` associated with the input (hover shows the resize cursor).
 *   2. The input itself, while it isn't focused — so label-less fields (stroke
 *      width, corner radius, …) are scrubbable too. A plain click still focuses
 *      it for typing; only a drag scrubs.
 *
 * The delta is *position-based* (proportional to how far you've dragged from the
 * start), NOT velocity-based — holding still holds the value, and dragging back
 * to the start restores the original number. Modifiers: Shift = ×10 (coarse),
 * Alt/Option = ×0.1 (fine).
 *
 * Once a drag begins we grab the **Pointer Lock**: the cursor is pinned in place
 * and we accumulate `movementX` instead of reading absolute `clientX`, so you can
 * keep scrubbing past the edge of the screen indefinitely. Lock is best-effort —
 * if the browser denies it, `movementX` still drives the scrub, it just stops at
 * the screen edge like before.
 *
 * Wired through event delegation + a MutationObserver, so inputs created at
 * runtime (panel rebuilds, color picker, gradient stops, …) are covered
 * automatically. Values are written via the field's own `input`/`change` events,
 * so existing listeners react as if typed: `input` fires live during the drag,
 * one `change` fires on release.
 */

/** Pixels of horizontal drag that equal one `step` of the field, at ×1 speed. */
const PIXELS_PER_STEP = 4;
/** Drag must exceed this many px before it counts as a scrub (vs. a click). */
const DRAG_THRESHOLD = 3;

interface ScrubState {
  input: HTMLInputElement;
  /** Accumulated horizontal drag distance in px (via `movementX`), so the scrub
   *  survives Pointer Lock — where `clientX` is frozen. */
  dx: number;
  startVal: number;
  step: number;
  min: number;
  max: number;
  moved: boolean;
  /** True once we've acquired (or requested) Pointer Lock for this drag. */
  locked: boolean;
  /** Set when we request the lock; makes onPointerMove discard the ONE spurious
   *  `movementX` the browser reports when the lock actually engages (the OS warps
   *  the cursor to screen-centre — a large delta that jumped the value before the
   *  real drag took over). Cleared on the first event seen under the lock. */
  awaitingWarp: boolean;
  /** True when the handle is a label (vs. dragging the input field itself). */
  fromLabel: boolean;
}

let active: ScrubState | null = null;

/** Resolve the number input a label drives, or null if it isn't one. */
function inputForLabel(label: HTMLLabelElement): HTMLInputElement | null {
  // Explicit association (for= or a wrapped control).
  const ctrl = label.control;
  if (ctrl) return ctrl instanceof HTMLInputElement && ctrl.type === 'number' ? ctrl : null;
  // Implicit: the next number input sibling (e.g. `<label>X</label><input …>`),
  // skipping inert spans/units but stopping at the next label.
  let n = label.nextElementSibling;
  while (n) {
    if (n instanceof HTMLInputElement) return n.type === 'number' ? n : null;
    if (n.tagName === 'LABEL') break;
    n = n.nextElementSibling;
  }
  return null;
}

/** Tag labels that drive number inputs so CSS can give them the scrub cursor. */
function markLabels(root: ParentNode): void {
  const labels = root instanceof HTMLLabelElement
    ? [root]
    : Array.from(root.querySelectorAll('label'));
  for (const l of labels) l.classList.toggle('num-scrub', !!inputForLabel(l));
}

/** Round to the step grid and format without floating-point dust. */
function snapFormat(val: number, snap: number): string {
  const snapped = Math.round(val / snap) * snap;
  const decimals = (String(snap).split('.')[1] ?? '').length;
  return snapped.toFixed(decimals);
}

function beginScrub(input: HTMLInputElement, fromLabel: boolean): void {
  active = {
    input,
    dx: 0,
    startVal: parseFloat(input.value) || 0,
    step: parseFloat(input.step) || 1,
    min: input.min !== '' ? parseFloat(input.min) : -Infinity,
    max: input.max !== '' ? parseFloat(input.max) : Infinity,
    moved: false,
    locked: false,
    awaitingWarp: false,
    fromLabel,
  };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
}

/** Best-effort Pointer Lock so the cursor stays put and the drag never runs out
 *  of screen. Failure is fine — `movementX` still drives the scrub unlocked. */
function acquireLock(el: HTMLInputElement): void {
  try {
    const res = el.requestPointerLock() as unknown as Promise<void> | undefined;
    res?.catch?.(() => {}); // swallow rejection (e.g. denied) — scrub still works
  } catch { /* Pointer Lock unavailable; movementX fallback still scrubs */ }
}

function onPointerMove(e: PointerEvent): void {
  if (!active) return;
  // The first move AFTER Pointer Lock actually engages is the OS recentering warp
  // — a large spurious delta (cursor → screen-centre) that jumped the value before
  // the real drag took over. Discard exactly that one event; we only enter here
  // once the lock is confirmed held, so pre-lock moves and the lock-denied fallback
  // are untouched.
  if (active.awaitingWarp && document.pointerLockElement === active.input) {
    active.awaitingWarp = false;
    return;
  }
  // Relative motion — keeps counting under Pointer Lock. Clamp per-event motion as
  // a backstop against any residual jitter (a real hand moves a few px per event).
  active.dx += Math.max(-60, Math.min(60, e.movementX || 0));
  const dx = active.dx;
  if (!active.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
  if (!active.moved) {
    active.moved = true;
    document.body.classList.add('num-scrubbing');
    active.input.classList.add('fx-scrubbing'); // live accent ring on the field being scrubbed
    // Dragging the field itself: drop focus + any text selection it grabbed on
    // mousedown so the scrub isn't fighting a caret.
    if (!active.fromLabel) {
      active.input.blur();
      window.getSelection?.()?.removeAllRanges();
    }
    // Pin the cursor so the value keeps scrubbing past the edge of the screen.
    active.locked = true;
    active.awaitingWarp = true; // drop the recentering warp when the lock engages
    acquireLock(active.input);
  }

  const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
  const snap = active.step * mult;
  let val = active.startVal + (dx / PIXELS_PER_STEP) * snap;
  if (val < active.min || val > active.max) {
    val = Math.min(active.max, Math.max(active.min, val));
    // Re-base the accumulated drag AT the clamp: without this, overshooting the
    // min/max builds up "debt" that a reversed drag must pay back before the
    // value visibly moves again (a dead zone that reads as a broken field).
    active.dx = ((val - active.startVal) / snap) * PIXELS_PER_STEP;
  }
  active.input.value = snapFormat(val, snap);
  active.input.dispatchEvent(new Event('input', { bubbles: true }));
}

function onPointerUp(): void {
  window.removeEventListener('pointermove', onPointerMove);
  document.body.classList.remove('num-scrubbing');
  const finished = active;
  active = null;
  if (!finished) return;
  finished.input.classList.remove('fx-scrubbing');
  if (finished.locked && document.pointerLockElement) document.exitPointerLock();
  if (finished.moved) {
    finished.input.dispatchEvent(new Event('change', { bubbles: true }));
    // Swallow the click that fires after a field drag so it doesn't focus the
    // input we just scrubbed.
    if (!finished.fromLabel) suppressNextClick(finished.input);
  }
}

/** If the lock is lost mid-drag (the user hit Escape), end the scrub cleanly. */
function onPointerLockChange(): void {
  if (active?.locked && !document.pointerLockElement) onPointerUp();
}

function suppressNextClick(el: HTMLElement): void {
  const handler = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
  el.addEventListener('click', handler, { capture: true, once: true });
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 || active) return;
  const target = e.target as Element;

  // 1) Label handle — always scrubs, even if the field is focused.
  const label = target.closest?.('label.num-scrub') as HTMLLabelElement | null;
  if (label) {
    const input = inputForLabel(label);
    // A blank (Mixed) field has no value to scrub from — see case 2 below.
    if (input && !input.disabled && !input.readOnly && input.value.trim() !== '') {
      e.preventDefault(); // suppress text selection / the label's default focus
      beginScrub(input, true);
    }
    return;
  }

  // 2) The number input itself — scrubs only while unfocused, so a click can
  //    still focus it for typing and the native spinner keeps working.
  if (
    target instanceof HTMLInputElement && target.type === 'number' &&
    !target.disabled && !target.readOnly && document.activeElement !== target &&
    // A blank field is a Mixed multi-selection: scrubbing it would start from a
    // made-up 0 and overwrite every selected object's value. Click-to-type only.
    target.value.trim() !== ''
  ) {
    beginScrub(target, false); // no preventDefault — preserve click-to-focus
  }
}

/**
 * Enable scrubbable number inputs across the whole document. Call once at
 * startup; dynamically-added inputs are picked up automatically.
 */
export function setupNumberScrub(): void {
  markLabels(document);
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointerlockchange', onPointerLockChange);

  // Re-tag labels as the UI rebuilds (control bar, color picker, panels, …).
  const observer = new MutationObserver(muts => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node instanceof HTMLElement) markLabels(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
