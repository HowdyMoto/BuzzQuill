// Shared interaction-feedback helpers. The CSS (style.css "Interaction feedback"
// section) handles hover / press / focus for every control; this adds the
// JS-driven "something happened" pulse — a quick accent wash — on action and
// toggle buttons, so a click that changes state (align, boolean op, swap colors,
// pick a segmented option) gets a satisfying, communicative confirmation.

import type { AppState } from '../core/state';

/** Buttons that perform an action or flip a state and deserve a confirmation
 *  flash on click. Icon/segmented controls, not plain rows or text inputs. */
const PULSE_SELECTOR = [
  '.btn-group button',
  '.align-buttons button',
  '.pathfinder-buttons button',
  '.pathfinder-popover button',
  '.swatch-swap',
  '.swatch-default',
  '.width-preset',
  '.symbol-place-btn',
  '.panel-add',
  '.appearance-toggle',
  '.dlg-seg-btn',
  '.cpicker-tab',
  '#fp-grid-mode button',
].join(',');

/** Play a one-shot CSS animation class, restarting it if already running and
 *  removing it when it ends (so it can be re-triggered later). */
const activeEffects = new WeakMap<HTMLElement, Map<string, () => void>>();
function playOnce(el: HTMLElement, cls: string): void {
  const effects = activeEffects.get(el) ?? new Map<string, () => void>();
  effects.get(cls)?.();
  if (prefersReducedMotion()) return;
  activeEffects.set(el, effects);
  let timer: ReturnType<typeof setTimeout>;
  const cleanup = () => {
    clearTimeout(timer);
    el.classList.remove(cls);
    el.removeEventListener('animationend', ended);
    effects.delete(cls);
  };
  const ended = (event: AnimationEvent) => { if (event.target === el) cleanup(); };
  void el.offsetWidth;
  el.classList.add(cls);
  effects.set(cls, cleanup);
  el.addEventListener('animationend', ended);
  timer = setTimeout(cleanup, 1000); // hidden/removed nodes may never emit animationend
}

/** Replay the accent pulse on an element. */
export function pulse(el: HTMLElement): void { playOnce(el, 'fx-pulse'); }

let shapePulseStyles = false;
function ensureShapePulseStyles(): void {
  if (shapePulseStyles) return;
  shapePulseStyles = true;
  const el = document.createElement('style');
  el.textContent = `
.fx-shape-pulse { position: fixed; pointer-events: none; z-index: 3500; border-radius: 3px;
  border: 2px solid var(--ai-accent, #4d7cfe); box-shadow: 0 0 0 3px rgba(77,124,254,0.22); opacity: 0; }
@keyframes fx-shape-pulse-kf { 0% { opacity: 0; transform: scale(1.05); } 22% { opacity: 1; } 100% { opacity: 0; transform: scale(1); } }
.fx-shape-pulse.run { animation: fx-shape-pulse-kf 0.62s ease-out; }
@media (prefers-reduced-motion: reduce) { .fx-shape-pulse.run { animation-duration: 0.01s; } }`;
  document.head.appendChild(el);
}

/**
 * Briefly flash an outline over each shape (by id) on the canvas — the visible
 * "these objects just changed" ripple, used when a text style is applied or
 * redefined so a document-wide change reads as caused-by-you and located exactly.
 * Uses screen-space getBoundingClientRect, so it's renderer-agnostic and never
 * touches the artwork. Capped so a huge redefine can't spawn thousands of nodes
 * (the toast still reports the true count).
 */
export function pulseShapes(state: AppState, ids: string[]): void {
  ensureShapePulseStyles();
  const MAX = 60;
  const pad = 3;
  for (const id of ids.slice(0, MAX)) {
    const shape = state.findShapeById(id);
    if (!shape) continue;
    let r: DOMRect;
    try { r = shape.element.getBoundingClientRect(); } catch { continue; }
    if (r.width < 0.5 && r.height < 0.5) continue; // not laid out / off in a hidden branch
    const box = document.createElement('div');
    box.className = 'fx-shape-pulse';
    box.style.left = `${r.left - pad}px`;
    box.style.top = `${r.top - pad}px`;
    box.style.width = `${r.width + pad * 2}px`;
    box.style.height = `${r.height + pad * 2}px`;
    document.body.appendChild(box);
    void box.offsetWidth; // reflow so the animation always plays from the start
    box.classList.add('run');
    const done = (): void => box.remove();
    box.addEventListener('animationend', done, { once: true });
    setTimeout(done, 1400); // fallback cleanup if animationend is missed
  }
}

// ---------------------------------------------------------------------------
// Export success — a delightful, Aaron-Iker-style confirmation right on the button
// the user just clicked (their eye is already there): a spring pop, a green wash, a
// checkmark that draws itself in, and a little confetti burst from the button. Plays
// only on a genuinely successful export.
// ---------------------------------------------------------------------------

let exportSuccessStyles = false;
function ensureExportSuccessStyles(): void {
  if (exportSuccessStyles) return;
  exportSuccessStyles = true;
  const el = document.createElement('style');
  el.textContent = `
.fx-export-done {
  animation: fx-export-pop var(--fx-settle) var(--fx-spring);
  background: var(--fx-success) !important; border-color: var(--fx-success) !important; color: #fff !important;
  transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
.fx-export-done .fx-check { width: 15px; height: 15px; flex: 0 0 auto; }
.fx-export-done .fx-check path {
  fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round;
  stroke-dasharray: 30; stroke-dashoffset: 30; animation: fx-check-draw 0.42s 0.1s cubic-bezier(0.65, 0, 0.35, 1) forwards;
}
@keyframes fx-check-draw { to { stroke-dashoffset: 0; } }
@keyframes fx-export-pop { 0% { transform: scale(1); } 28% { transform: scale(0.97); } 55% { transform: scale(1.025); } 100% { transform: scale(1); } }
.fx-burst { position: fixed; z-index: 12000; pointer-events: none; }
.fx-burst i {
  position: absolute; left: 0; top: 0; width: 4px; height: 4px; margin: -2px 0 0 -2px; border-radius: 50%;
  animation: fx-burst-kf 0.72s cubic-bezier(0.2, 0.75, 0.3, 1) forwards;
}
@keyframes fx-burst-kf {
  0% { opacity: 1; transform: translate(0, 0) scale(1); }
  100% { opacity: 0; transform: translate(var(--dx), var(--dy)) scale(0.35); }
}
/* Per-target row flash in the export sequence: spring pop + a green inset wash that
   fades, and a checkmark badge that pops+draws in at the row's right edge. */
.fx-row-exported { animation: fx-row-pop 0.5s var(--fx-spring); border-radius: 6px; }
@keyframes fx-row-pop {
  0% { transform: scale(1); box-shadow: inset 0 0 0 2px rgba(46, 160, 67, 0.9); }
  45% { transform: scale(1.015); }
  100% { transform: scale(1); box-shadow: inset 0 0 0 2px rgba(46, 160, 67, 0); }
}
.fx-row-check {
  position: fixed; z-index: 12000; pointer-events: none;
  width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%; background: var(--fx-success);
  display: flex; align-items: center; justify-content: center;
  animation: fx-row-check-kf 0.72s var(--fx-spring) forwards;
}
.fx-row-check svg { width: 12px; height: 12px; }
.fx-row-check path { fill: none; stroke: #fff; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round;
  stroke-dasharray: 30; stroke-dashoffset: 30; animation: fx-check-draw 0.32s 0.06s cubic-bezier(0.65, 0, 0.35, 1) forwards; }
@keyframes fx-row-check-kf {
  0% { opacity: 0; transform: scale(0.4); } 25% { opacity: 1; transform: scale(1.12); }
  72% { opacity: 1; transform: scale(1); } 100% { opacity: 0; transform: scale(1); }
}
/* A file-count pill that floats up out of the button as the fireworks fire, so an
   icon-only export button still says how many files it just wrote. */
.fx-float-count {
  position: fixed; z-index: 12001; pointer-events: none; white-space: nowrap;
  font-size: 11.5px; font-weight: 700; letter-spacing: 0.02em; color: #fff;
  background: var(--fx-success); padding: 2px 8px; border-radius: 999px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28);
  animation: fx-float-count-kf 1.15s cubic-bezier(0.22, 0.75, 0.3, 1) forwards;
}
@keyframes fx-float-count-kf {
  0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.55); }
  16%  { opacity: 1; transform: translate(-50%, -150%) scale(1.08); }
  72%  { opacity: 1; transform: translate(-50%, -330%) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -430%) scale(0.95); }
}
@media (prefers-reduced-motion: reduce) {
  .fx-export-done { animation: none; }
  .fx-export-done .fx-check path { animation-duration: 0.01s; }
  .fx-row-exported { animation: none; }
}`;
  document.head.appendChild(el);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** Confetti burst radiating from an anchor element's centre. Evenly-spaced dots in a
 *  small multi-colour palette; self-cleans. Skipped under reduced-motion. */
function confettiBurst(anchor: HTMLElement): void {
  if (prefersReducedMotion()) return;
  const r = anchor.getBoundingClientRect();
  if (r.width < 1 && r.height < 1) return; // detached/hidden anchor — don't fire from the corner
  const c = document.createElement('div');
  c.className = 'fx-burst';
  c.style.left = `${r.left + r.width / 2}px`;
  c.style.top = `${r.top + r.height / 2}px`;
  const colors = ['var(--fx-success)', 'var(--ai-accent)', 'var(--ai-text-bright)'];
  const N = 6;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + 0.15;
    const dist = 20 + (i % 3) * 5;
    const dot = document.createElement('i');
    dot.style.setProperty('--dx', `${Math.cos(a) * dist}px`);
    dot.style.setProperty('--dy', `${Math.sin(a) * dist}px`);
    dot.style.background = colors[i % colors.length];
    dot.style.animationDelay = `${(i % 4) * 12}ms`;
    c.appendChild(dot);
  }
  document.body.appendChild(c);
  setTimeout(() => c.remove(), 950);
}

/** A file-count pill that rises out of an anchor and fades — the "N files" that
 *  floats up with the export fireworks. Skipped under reduced-motion (like confetti). */
function floatCount(anchor: HTMLElement, count: number): void {
  if (prefersReducedMotion()) return;
  const r = anchor.getBoundingClientRect();
  if (r.width < 1 && r.height < 1) return; // detached/hidden anchor — don't float from the corner
  const pill = document.createElement('div');
  pill.className = 'fx-float-count';
  pill.textContent = count === 1 ? '1 file' : `${count} files`;
  pill.style.left = `${r.left + r.width / 2}px`;
  pill.style.top = `${r.top + r.height / 2}px`;
  document.body.appendChild(pill);
  setTimeout(() => pill.remove(), 1250);
}

/** Celebrate a successful export on the button the user clicked: spring pop + green
 *  wash + a drawn checkmark + a confetti burst, reverting after ~1.5s. A text button
 *  gets a label ("Exported!" by default) beside the check; `compact` (icon-only
 *  buttons, e.g. the Layers panel's per-frame export) shows just the checkmark.
 *  `count` floats a "N files" pill up with the burst — the file tally an icon-only
 *  button can't otherwise show. */
export function playExportSuccess(btn: HTMLElement, opts: { compact?: boolean; label?: string; count?: number } = {}): void {
  ensureExportSuccessStyles();
  if (btn.dataset.fxBusy) return; // one celebration at a time
  btn.dataset.fxBusy = '1';
  const original = Array.from(btn.childNodes);
  const originalMinWidth = btn.style.minWidth;
  const originalLabel = btn.getAttribute('aria-label');
  const check = '<svg class="fx-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5 11-12"/></svg>';
  const label = document.createElement('span'); label.textContent = opts.label ?? 'Exported';
  btn.setAttribute('aria-label', label.textContent);
  if (!opts.compact) btn.style.minWidth = `${Math.round(btn.getBoundingClientRect().width)}px`; // no width jump on the label swap
  btn.classList.add('fx-export-done');
  btn.innerHTML = check;
  if (!opts.compact) btn.appendChild(label); // textContent = safe against a crafted label
  confettiBurst(btn);
  if (opts.count) floatCount(btn, opts.count);
  window.setTimeout(() => {
    btn.classList.remove('fx-export-done');
    btn.replaceChildren(...original);
    btn.style.minWidth = originalMinWidth;
    if (originalLabel === null) btn.removeAttribute('aria-label'); else btn.setAttribute('aria-label', originalLabel);
    delete btn.dataset.fxBusy;
  }, 1500);
}

/** Flash a single export-target row as "done": a spring pop with a green inset wash
 *  and a checkmark badge that draws in at the row's right edge. */
function flashRowExported(row: HTMLElement): void {
  ensureExportSuccessStyles();
  playOnce(row, 'fx-row-exported');
  const r = row.getBoundingClientRect();
  if (r.width < 1) return;
  const badge = document.createElement('div');
  badge.className = 'fx-row-check';
  badge.style.left = `${r.right - 16}px`;
  badge.style.top = `${r.top + r.height / 2}px`;
  badge.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5 11-12"/></svg>';
  document.body.appendChild(badge);
  setTimeout(() => badge.remove(), 900);
}

/**
 * Delightful multi-file export: tick down the target rows one-by-one (each pops + gets
 * a drawn check), then land a completion confirmation on the button — "Exported N
 * files" — so producing several files reads as a satisfying sequence, not one opaque
 * click. Under reduced motion it collapses to just the button confirmation.
 */
export function playExportSequence(rows: HTMLElement[], btn: HTMLElement, fileCount: number): void {
  const label = fileCount === 1 ? 'Exported 1 file' : `Exported ${fileCount} files`;
  const stagger = rows.length > 8 ? 70 : 130; // keep long lists snappy
  if (prefersReducedMotion() || rows.length === 0) { playExportSuccess(btn, { label }); return; }
  rows.forEach((row, i) => setTimeout(() => flashRowExported(row), i * stagger));
  window.setTimeout(() => playExportSuccess(btn, { label }), rows.length * stagger + 140);
}

/** Gentle reveal of a panel's body — call when it is expanded (not on content
 *  rebuilds), so it only plays on the actual collapse→expand transition. */
export function animateExpand(panel: Element): void {
  const body = panel.querySelector('.panel-body') as HTMLElement | null;
  if (body) playOnce(body, 'fx-expanding');
}

/** Soft accent-ring flash confirming a numeric field's value just changed. */
function flashField(el: HTMLElement): void { playOnce(el, 'fx-field-flash'); }

function isNumberInput(el: EventTarget | null): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type === 'number';
}

/** Wire one delegated listener that pulses any action/toggle button on click.
 *  Skips disabled controls. Purely additive — it never intercepts the real
 *  handlers (it only adds a CSS class). */
export function setupInteractionFeedback(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    const btn = target?.closest?.(PULSE_SELECTOR) as HTMLElement | null;
    if (!btn) return;
    if (btn.matches(':disabled, [aria-disabled="true"], .disabled') || btn.closest('[inert]')) return;
    pulse(btn);
  });

  // Numeric fields flash to confirm a committed value change. `change` covers a
  // scrub release (number-scrub fires one on pointerup), Enter, and blur after
  // typing; Arrow keydown adds immediate per-nudge feedback. Programmatic panel
  // rebuilds set `.value` without events, so those (frequent) updates don't flash.
  document.addEventListener('change', (e) => {
    const field = e.target;
    if ((field instanceof HTMLInputElement || field instanceof HTMLSelectElement)
        && !field.disabled && !field.closest('#svg-canvas') && field.checkValidity()) flashField(field);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && isNumberInput(e.target)) {
      flashField(e.target);
    }
  });
}
