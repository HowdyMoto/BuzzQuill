// Shared DOM micro-helpers — one home for the getElementById wrappers, element
// creation, and the live-then-commit input binding that panel modules each used
// to reinvent (issue #126).

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escape text for HTML/XML content OR a quoted attribute (either quote style).
 *
 * The one escaper (#190). There used to be five, and three escaped only `& < >`:
 * safe in element content, but a value that later moved into an attribute could
 * close the quote and inject markup. Escaping all five characters means a call site
 * never has to know which position its string will land in.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** getElementById, honestly typed as possibly-null. Prefer this at call sites
 *  that handle a missing element. */
export function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** getElementById for elements the caller KNOWS exist (they're in index.html).
 *  Throws in dev if the id is missing — surfacing a typo instead of the silent
 *  `as T` cast that the panel `$` helpers used to do. In prod it still returns
 *  the (possibly null) element cast to T, matching the old behaviour. */
export function mustId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el && import.meta.env.DEV) throw new Error(`[dom] required element #${id} not found`);
  return el as T;
}

/** Create an element with an optional class. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

/** Bind a value control's live-then-commit pair: `input` applies without an undo
 *  step (record=false), `change` commits one (record=true). The single home for
 *  the pattern hand-rolled across the panels. */
export function bindLiveCommit(
  control: HTMLElement,
  live: () => void,
  commit: () => void,
): void {
  control.addEventListener('input', live);
  control.addEventListener('change', commit);
}

/** Like {@link bindLiveCommit}, but TYPED keystrokes wait for the commit
 *  (Enter/blur `change`) instead of applying live. Drag-scrub still applies live
 *  (its synthetic `input` events have isTrusted=false), and arrow-key stepping
 *  re-applies after the native step. For fields where applying a half-typed
 *  value is destructive — typing the "5" of "50" into Transform X must not
 *  teleport the shape to x=5 (#218). */
export function bindScrubLiveTypeCommit(
  control: HTMLElement,
  live: () => void,
  commit: () => void,
): void {
  control.addEventListener('input', (e) => { if (!e.isTrusted) live(); });
  control.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === 'ArrowUp' || k === 'ArrowDown') window.setTimeout(live, 0);
  });
  control.addEventListener('change', commit);
}

/**
 * Commit a half-typed panel field BEFORE a press on the canvas acts. The canvas
 * selects on pointerdown, but a field only commits on its blur/change, which the
 * browser fires after the pointerdown handlers have run — so a value typed for
 * shape A (an opacity, a width) landed on shape B, the one the click just selected.
 * Blurring the field in the capture phase, ahead of every tool, commits it against
 * the selection it was typed for. Fields inside the canvas area (on-canvas text
 * editing) and the inline-rename field, which times its own commit, are left alone.
 */
export function commitFieldsOnCanvasPress(canvasArea: Element): void {
  window.addEventListener('pointerdown', (e) => {
    const a = document.activeElement;
    if (!(a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement)) return;
    if (a.classList.contains('layer-rename') || canvasArea.contains(a)) return;
    if (!canvasArea.contains(e.target as Node)) return;
    a.blur();
  }, true);
}
