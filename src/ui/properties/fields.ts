import { MIXED, type Maybe } from '../../core/shape-props';

// ---- Mixed-aware control helpers (used by updatePropertiesPanel) ----

export const MIXED_HINT = 'Mixed';
/** Diagonal split swatch that reads as "these objects differ". */
export const MIXED_SWATCH = 'linear-gradient(135deg, #9aa0ab 0 48%, #4b5160 52% 100%)';

/** A number/text field shows the shared value, or blanks with a "Mixed" placeholder.
 *  Never writes into the field the user is typing in — every keystroke live-applies,
 *  which re-renders the panel, and a rewrite mid-edit clobbers the entry. */
export function setNumField(input: HTMLInputElement, v: Maybe<number>): void {
  if (document.activeElement === input) return;
  if (v === MIXED || v === undefined) { input.value = ''; input.placeholder = MIXED_HINT; }
  else { input.value = String(v); input.placeholder = ''; }
}

/** Same focus rule for direct text-field writes. */
export function putVal(input: HTMLInputElement, v: string): void {
  if (document.activeElement !== input) input.value = v;
}

/** A toggle button: active / inactive / indeterminate (mixed). */
export function setToggle(btn: HTMLButtonElement, v: Maybe<boolean>): void {
  if (v === MIXED || v === undefined) { btn.classList.remove('active'); btn.classList.add('indeterminate'); }
  else { btn.classList.toggle('active', v); btn.classList.remove('indeterminate'); }
}
