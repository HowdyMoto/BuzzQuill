/**
 * Slider + value field — the design-system pairing for EVERY range input.
 *
 * A slider alone can't land on an exact number (drag to precisely 37%?), so no
 * slider in the app gets a read-only readout: each carries an editable number
 * field instead. The two stay in lockstep —
 *   - dragging the slider rewrites the field;
 *   - a typed value applies on Enter / leaving the field (a half-typed "5" of "50"
 *     never applies), and Escape puts the old value back — inside a dialog too:
 *     the first Escape throws away what was half-typed, and only an Escape with
 *     nothing half-typed reaches the dialog and closes it;
 *   - scrubbing the field (number-scrub.ts) or arrow-key stepping applies live —
 *     except on a Mixed field, which has no one value to step from.
 *
 * The field drives the SLIDER, not the model: it sets the range's value and fires
 * the range's own `input` then `change`. Every slider listener — live on `input`,
 * one undo step on `change` — therefore runs unchanged, and dragging and typing
 * share one apply path. A typed value is clamped to the slider's min/max and
 * snapped to its step, so give a slider a step as fine as a typed value should be.
 */

import { bindScrubLiveTypeCommit } from './dom';

export interface SliderFieldOptions {
  /** Display multiplier: the field shows value × scale (a 0–1 opacity → 0–100). */
  scale?: number;
  /** Unit after the field — '%', '°', 'px'. */
  unit?: string;
}

interface Binding {
  field: HTMLInputElement;
  /** A multi-selection that disagrees: blank field, "Mixed" placeholder. */
  mixed: boolean;
  /** Repaint the field from the slider (or as Mixed). */
  render: () => void;
  /** Does the field hold something typed but not yet applied? */
  dirty: () => boolean;
}

const bindings = new WeakMap<HTMLInputElement, Binding>();
/** The same bindings, looked up from the FIELD (a key event's target). */
const byField = new WeakMap<HTMLInputElement, Binding>();

/**
 * Escape in a field holding a half-typed value reverts the field, and nothing else
 * hears the key. It has to get there FIRST: a dialog closes on Escape from a
 * document capture listener (ui/modal.ts), which runs before any listener on the
 * field — so typing a radius in Round Corners and pressing Escape threw away the
 * whole dialog. A window capture listener runs before a document one. Installed
 * once, for every field.
 */
let escapeGuard = false;
function installEscapeGuard(): void {
  if (escapeGuard) return;
  escapeGuard = true;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !(e.target instanceof HTMLInputElement)) return;
    const b = byField.get(e.target);
    if (!b || !b.dirty()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    b.render();
    b.field.blur();
  }, true);
}

/** Round away float dust (0.07 × 100 = 7.000000000000001). */
const clean = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * Build the editable value field for `range`, bind the two, and return the field
 * (with its unit) for the caller to place — normally right after the slider.
 */
export function sliderField(range: HTMLInputElement, opts: SliderFieldOptions = {}): HTMLElement {
  const scale = opts.scale ?? 1;
  const attr = (v: string, fallback: number): number => clean((v === '' ? fallback : parseFloat(v)) * scale);
  const step = attr(range.step, 1);
  const decimals = (String(step).split('.')[1] ?? '').length;

  const wrap = document.createElement('span');
  wrap.className = 'slider-field';
  const field = document.createElement('input');
  field.type = 'number';
  field.className = 'slider-field-input';
  field.min = String(attr(range.min, 0));
  field.max = String(attr(range.max, 100));
  field.step = String(step);
  if (range.title) { field.title = range.title; field.setAttribute('aria-label', range.title); }
  const unit = document.createElement('span');
  unit.className = 'slider-field-unit';
  unit.textContent = opts.unit ?? '';
  wrap.append(field, unit);

  const shown = (): string => String(Number((parseFloat(range.value) * scale).toFixed(decimals)));
  const b: Binding = {
    field,
    mixed: false,
    render: () => {
      field.placeholder = b.mixed ? 'Mixed' : '';
      field.value = b.mixed ? '' : shown();
    },
    dirty: () => field.value !== (b.mixed ? '' : shown()),
  };
  bindings.set(range, b);
  byField.set(field, b);
  installEscapeGuard();
  b.render();

  // Dragging the slider sets one value for everything — no longer Mixed.
  range.addEventListener('input', () => { b.mixed = false; b.render(); });

  /** Move the slider to the field's value; false if the field holds no number. */
  const push = (): boolean => {
    const v = parseFloat(field.value);
    if (!Number.isFinite(v)) return false;
    range.value = String(v / scale); // the slider clamps + snaps it
    return true;
  };
  const fire = (type: string): void => { range.dispatchEvent(new Event(type, { bubbles: true })); };
  // A Mixed field is blank, and stepping a blank number input starts from zero: one
  // ArrowUp set every selected object to the minimum. With no single value to step
  // from, stepping does nothing; typing a value still sets them all. Registered
  // before the live binding below so it can stop that listener too.
  field.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && b.mixed && field.value === '') {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  });
  bindScrubLiveTypeCommit(field,
    () => { if (push()) fire('input'); },
    () => {
      if (!push()) { b.render(); return; } // cleared / not a number → put the value back
      fire('input');
      fire('change');
    });
  field.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    b.render();
    field.blur();
  });
  return wrap;
}

/**
 * Set a slider from the model and show it in its field — assigning `range.value`
 * fires no event, so panel refreshes come through here. `mixed` shows the field as
 * "Mixed". A field the user is typing in is left alone.
 */
export function setSliderValue(range: HTMLInputElement, value: number, mixed = false): void {
  range.value = String(value);
  const b = bindings.get(range);
  if (!b) return;
  b.mixed = mixed;
  if (document.activeElement !== b.field) b.render();
}
