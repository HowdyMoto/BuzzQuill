/**
 * Variable-font axis sliders — one continuous slider per non-weight axis a font
 * exposes (Width, Optical size). Weight stays on the discrete specimen slider; these
 * add the genuinely-new axes via font-variation-settings. Shown only for families that
 * have such axes (see fonts.getFontAxes); the row hides itself otherwise. Singleton and
 * self-contained (injects its own styles).
 */

import { getFontAxes, type FontAxis } from '../fonts';
import { setSliderValue, sliderField } from './slider-field';

type OnChange = (settings: string) => void;

let host: HTMLElement | null = null;
let onChange: OnChange = () => {};
let axes: FontAxis[] = [];
const values = new Map<string, number>(); // tag → current value
const sliders = new Map<string, HTMLInputElement>(); // tag → its slider

function injectStyles(): void {
  if (document.getElementById('axis-styles')) return;
  const el = document.createElement('style');
  el.id = 'axis-styles';
  el.textContent = `
.axis-list { display: flex; flex-direction: column; gap: 6px; }
/* Hide the whole row for a font with no extra axes (list empty). */
.panel-row:has(.axis-list:empty) { display: none; }
.axis-row { display: flex; align-items: center; gap: 7px; }
.axis-label { font-size: 11px; color: var(--ai-text-dim); flex: 0 0 auto; min-width: 62px; }
.axis-slider {
  flex: 1; min-width: 0; height: 16px; accent-color: var(--ai-accent); cursor: pointer;
}
`;
  document.head.appendChild(el);
}

/** font-variation-settings for the axes that differ from their default (empty = none). */
function buildSettings(): string {
  return axes
    .filter((a) => (values.get(a.tag) ?? a.default) !== a.default)
    .map((a) => `"${a.tag}" ${values.get(a.tag)}`)
    .join(', ');
}

function parse(settings: string): Map<string, number> {
  const m = new Map<string, number>();
  const re = /["']?(wdth|opsz)["']?\s+([\d.]+)/gi;
  let g: RegExpExecArray | null;
  while ((g = re.exec(settings || ''))) m.set(g[1].toLowerCase(), parseFloat(g[2]));
  return m;
}

export function setupAxisSliders(hostEl: HTMLElement, change: OnChange): void {
  injectStyles();
  host = hostEl;
  onChange = change;
  host.className = 'axis-list';
}

/** Identity of an axis set — the sliders are rebuilt only when it changes. */
const axesKey = (xs: FontAxis[]): string => xs.map((a) => `${a.tag}:${a.min}:${a.max}`).join(',');

/** Show the sliders for a family's axes, reflecting the current font-variation-settings. */
export function setAxisSliders(family: string, settings: string): void {
  if (!host) return;
  const next = getFontAxes(family);
  const current = parse(settings);
  values.clear();
  for (const a of next) values.set(a.tag, current.get(a.tag) ?? a.default);

  // Same axes → just move the sliders. Every edit re-renders the panel, so a rebuild
  // here would replace the very slider being dragged or field being typed in.
  if (axesKey(next) === axesKey(axes)) {
    for (const a of axes) setSliderValue(sliders.get(a.tag)!, values.get(a.tag)!);
    return;
  }
  axes = next;
  sliders.clear();
  host.replaceChildren(); // empty → row hides via CSS :has(.axis-list:empty)
  for (const a of axes) {
    const row = document.createElement('div'); row.className = 'axis-row';
    const label = document.createElement('span'); label.className = 'axis-label'; label.textContent = a.label;
    const slider = document.createElement('input');
    slider.type = 'range'; slider.className = 'axis-slider'; slider.title = a.label;
    slider.min = String(a.min); slider.max = String(a.max); slider.step = '1';
    slider.value = String(values.get(a.tag));
    slider.addEventListener('input', () => {
      values.set(a.tag, parseFloat(slider.value));
      onChange(buildSettings());
    });
    sliders.set(a.tag, slider);
    row.append(label, slider, sliderField(slider));
    host.appendChild(row);
  }
}
