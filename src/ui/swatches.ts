/**
 * Swatches — a reusable colour palette (Figma-style). Stored in localStorage so
 * it persists across documents and sessions. Click a chip to fill the selection,
 * Alt/Shift-click to stroke it, right-click to remove; the "+" adds the current
 * fill colour. Applying goes through AppState.setSelection{Fill,Stroke} so it
 * covers the whole selection in one undo step.
 */

import type { AppState } from '../core/state';

const KEY = 'buzzquill.swatches';
const DEFAULTS = ['#111111', '#ffffff', '#e74c3c', '#e67e22', '#f1c40f', '#16a085', '#2d7ff9', '#9b59b6'];
const MAX = 24;

let swatches: string[] = loadSwatches();
let stateRef: AppState | null = null;

function loadSwatches(): string[] {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (Array.isArray(s) && s.every(x => typeof x === 'string')) return s as string[];
  } catch { /* fall through */ }
  return [...DEFAULTS];
}

function persist(): void {
  try { localStorage.setItem(KEY, JSON.stringify(swatches)); } catch { /* ignore quota */ }
}

/** A usable solid colour, else null (skip none / gradients / patterns). */
function normalize(c: string | undefined): string | null {
  if (!c || c === 'none' || c.startsWith('url(')) return null;
  return c.toLowerCase();
}

export function setupSwatches(state: AppState): void {
  stateRef = state;
  document.getElementById('swatch-add')?.addEventListener('click', () => {
    const c = normalize(state.defaultStyle.fill);
    if (!c || swatches.includes(c)) return;
    swatches.unshift(c);
    if (swatches.length > MAX) swatches.length = MAX;
    persist();
    renderSwatches();
  });
  renderSwatches();
}

/** Load colours into the swatch set — the Library "palette" apply. Each new,
 *  usable colour is added to the front (dedup + capped); returns how many were
 *  actually added. */
export function addSwatches(colors: string[]): number {
  let added = 0;
  for (const raw of colors) {
    const c = normalize(raw);
    if (!c || swatches.includes(c)) continue;
    swatches.unshift(c);
    added++;
  }
  if (swatches.length > MAX) swatches.length = MAX;
  if (added) { persist(); renderSwatches(); }
  return added;
}

export function renderSwatches(): void {
  const grid = document.getElementById('swatches-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const c of swatches) {
    const chip = document.createElement('button');
    chip.className = 'swatch-chip';
    chip.style.background = c;
    chip.title = `${c} · click = fill, Alt/Shift-click = stroke, right-click = remove`;
    chip.addEventListener('click', (e) => {
      const s = stateRef;
      if (!s) return;
      if (!s.selectedShapeIds.length) return; // fixed defaults: a swatch only paints the selection
      if (e.altKey || e.shiftKey) s.setSelectionStroke(c);
      else s.setSelectionFill(c);
    });
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      swatches = swatches.filter(x => x !== c);
      persist();
      renderSwatches();
    });
    grid.appendChild(chip);
  }
}
