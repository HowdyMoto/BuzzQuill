/**
 * Font-weight slider: a scrubbable axis with a specimen capital "A" above each
 * available weight, each rendered IN that weight (in the current family), so you see
 * every option's heaviness at a glance instead of hunting through a dropdown. The
 * thumb snaps to the font's real weights; click a specimen or drag the thumb to apply.
 * Replaces the weight <select>. Singleton (there is one weight control) and
 * self-contained (injects its own styles using the app's --ai-* tokens).
 */

import { WEIGHT_NAMES, availableWeights } from '../fonts';

type Pick = (weight: number, commit: boolean) => void;

const PAD = 12; // px inset so edge specimens/thumb don't overflow the control

let host: HTMLElement | null = null;
let specimensEl: HTMLElement | null = null;
let trackEl: HTMLElement | null = null;
let thumbEl: HTMLElement | null = null;
let readoutEl: HTMLElement | null = null;
let onPick: Pick = () => {};
let family = '';
let weights: number[] = [];
let current: number | null = null;
let dragging = false;

function weightLabel(w: number | null): string {
  if (w === null) return 'Mixed';
  return `${WEIGHT_NAMES[w] ?? w} · ${w}`;
}

function injectStyles(): void {
  if (document.getElementById('wt-styles')) return;
  const el = document.createElement('style');
  el.id = 'wt-styles';
  el.textContent = `
.wt-slider { position: relative; width: 100%; }
.wt-specimens { position: relative; height: 22px; }
.wt-a {
  position: absolute; top: 0; transform: translateX(-50%);
  background: none; border: none; padding: 0 4px; margin: 0;
  font-size: 17px; line-height: 22px; color: var(--ai-text-dim);
  cursor: pointer; user-select: none; transition: color 0.1s;
}
.wt-a:hover { color: var(--ai-text); }
.wt-a.current { color: var(--ai-accent); }
.wt-track { position: relative; height: 16px; cursor: pointer; touch-action: none; }
.wt-line {
  position: absolute; top: 7px; left: ${PAD}px; right: ${PAD}px; height: 2px;
  background: var(--ai-border-light); border-radius: 1px; pointer-events: none;
}
.wt-thumb {
  position: absolute; top: 2px; width: 12px; height: 12px; border-radius: 50%;
  background: var(--ai-accent); border: 2px solid var(--ai-panel); transform: translateX(-50%);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4); pointer-events: none;
}
.wt-mixed .wt-line { opacity: 0.5; }
.wt-readout {
  height: 15px; margin-top: 2px; font-size: 11px; line-height: 15px;
  text-align: center; color: var(--ai-text-dim); user-select: none;
}
`;
  document.head.appendChild(el);
}

/** Fractional position (0..1) of a weight across the family's [min,max] span. */
function fracOf(w: number): number {
  if (weights.length < 2) return 0.5;
  const min = weights[0], max = weights[weights.length - 1];
  return max === min ? 0.5 : (w - min) / (max - min);
}

/** CSS left for a fraction, inset by PAD so edge marks don't clip. */
function leftCss(frac: number): string {
  return `calc(${PAD}px + ${frac} * (100% - ${PAD * 2}px))`;
}

/** The available weight nearest to a fractional position along the track. */
function weightAtFrac(frac: number): number {
  if (weights.length < 2) return weights[0] ?? 400;
  const min = weights[0], max = weights[weights.length - 1];
  const val = min + frac * (max - min);
  return weights.reduce((b, w) => (Math.abs(w - val) < Math.abs(b - val) ? w : b), weights[0]);
}

export function setupWeightSlider(hostEl: HTMLElement, pick: Pick): void {
  injectStyles();
  host = hostEl;
  onPick = pick;
  host.className = 'wt-slider';
  host.replaceChildren();

  specimensEl = document.createElement('div');
  specimensEl.className = 'wt-specimens';
  trackEl = document.createElement('div');
  trackEl.className = 'wt-track';
  const line = document.createElement('div');
  line.className = 'wt-line';
  thumbEl = document.createElement('div');
  thumbEl.className = 'wt-thumb';
  trackEl.appendChild(line);
  trackEl.appendChild(thumbEl);
  // Always-visible name of the current weight ("SemiBold · 600") — the specimen
  // glyphs alone were unlabeled ~9px targets nobody could read or hit (#224).
  // Hovering a specimen previews ITS name here before you commit to a click.
  readoutEl = document.createElement('div');
  readoutEl.className = 'wt-readout';
  host.appendChild(specimensEl);
  host.appendChild(trackEl);
  host.appendChild(readoutEl);

  // Scrub: pointerdown anywhere on the track snaps the thumb to the nearest weight and
  // begins a drag; live-applies as it crosses ticks, commits (one undo step) on release.
  trackEl.addEventListener('pointerdown', (e) => {
    if (weights.length < 2) return;
    e.preventDefault();
    dragging = true;
    try { trackEl!.setPointerCapture(e.pointerId); } catch { /* older UA */ }
    moveTo(e.clientX, false);
    const onMove = (ev: PointerEvent) => { if (dragging) moveTo(ev.clientX, false); };
    const onUp = (ev: PointerEvent) => {
      dragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      moveTo(ev.clientX, true);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

function moveTo(clientX: number, commit: boolean): void {
  if (!trackEl || weights.length < 2) return;
  const rect = trackEl.getBoundingClientRect();
  const usable = rect.width - PAD * 2;
  const frac = usable > 0 ? Math.max(0, Math.min(1, (clientX - rect.left - PAD) / usable)) : 0;
  onPick(weightAtFrac(frac), commit);
}

/** Rebuild the specimens for a family and reflect the current weight (null = Mixed). */
export function setWeightSlider(fam: string, cur: number | null): void {
  if (!host || !specimensEl || !trackEl || !thumbEl) return;
  current = cur;
  const ws = availableWeights(fam);
  const familyChanged = fam !== family || ws.length !== weights.length || ws.some((w, i) => w !== weights[i]);
  family = fam;
  weights = ws;

  if (familyChanged) {
    specimensEl.replaceChildren();
    for (const w of ws) {
      const a = document.createElement('button');
      a.type = 'button';
      a.className = 'wt-a';
      a.textContent = 'A';
      a.style.left = leftCss(fracOf(w));
      a.style.fontFamily = `'${fam}'`;
      a.style.fontWeight = String(w);
      a.title = `${WEIGHT_NAMES[w] ?? w} (${w})`;
      a.setAttribute('aria-label', `${WEIGHT_NAMES[w] ?? w} (${w})`);
      a.dataset.w = String(w);
      a.addEventListener('click', () => onPick(w, true));
      // Preview the hovered weight's name in the readout; restore on leave.
      a.addEventListener('mouseenter', () => { if (readoutEl) readoutEl.textContent = weightLabel(w); });
      a.addEventListener('mouseleave', () => { if (readoutEl) readoutEl.textContent = weightLabel(current); });
      specimensEl.appendChild(a);
    }
    trackEl.style.display = ws.length < 2 ? 'none' : ''; // a single-weight font has nothing to scrub
  }

  for (const a of Array.from(specimensEl.children) as HTMLElement[]) {
    a.classList.toggle('current', current !== null && Number(a.dataset.w) === current);
  }
  if (current === null) {
    thumbEl.style.display = 'none';
    host.classList.add('wt-mixed');
  } else {
    thumbEl.style.display = '';
    host.classList.remove('wt-mixed');
    thumbEl.style.left = leftCss(fracOf(current));
  }
  if (readoutEl) readoutEl.textContent = weightLabel(current);
}
