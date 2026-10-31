/**
 * OpenType feature chips — a small row of toggles for the OpenType layout features a
 * font actually provides (inspected via opentype.js), so there are no dead switches.
 * Toggling rebuilds a font-feature-settings string; the caller applies it (on the outer
 * element so it CSS-inherits into a multi-stroke text's render-clones). Singleton and
 * self-contained (injects its own styles via --ai-* tokens).
 *
 * Only OPT-IN features are offered (things off by default that you turn on) — Fractions,
 * Tabular/Oldstyle figures, Small caps, Discretionary ligatures, Swashes, Stylistic sets.
 * Standard ligatures / proportional-lining figures are already the default, so no chip.
 */

import { getFontFeatures } from '../fonts';

type OnChange = (settings: string) => void;

// tag → { chip label, full name }. Stylistic sets (ss01–ss20) are added dynamically.
const FEATURES: { tag: string; label: string; name: string }[] = [
  { tag: 'frac', label: '½', name: 'Fractions' },
  { tag: 'tnum', label: '#', name: 'Tabular figures' },
  { tag: 'onum', label: '0', name: 'Oldstyle figures' },
  { tag: 'smcp', label: 'ꜱᴄ', name: 'Small caps' },
  { tag: 'dlig', label: 'ﬅ', name: 'Discretionary ligatures' },
  { tag: 'swsh', label: '𝒮', name: 'Swashes' },
  { tag: 'salt', label: 'a', name: 'Stylistic alternates' },
];

let host: HTMLElement | null = null;
let onChange: OnChange = () => {};
const active = new Set<string>();

function injectStyles(): void {
  if (document.getElementById('ot-styles')) return;
  const el = document.createElement('style');
  el.id = 'ot-styles';
  el.textContent = `
.ot-chips { display: flex; flex-wrap: wrap; gap: 4px; }
/* Hide the whole row when the current font offers no opt-in features (chips empty). */
.panel-row:has(.ot-chips:empty) { display: none; }
.ot-chip {
  height: 22px; min-width: 26px; padding: 0 6px;
  background: var(--ai-btn); color: var(--ai-text); border: none; border-radius: 3px;
  cursor: pointer; font-size: 11px; line-height: 22px;
  display: inline-flex; align-items: center; justify-content: center; transition: background 0.1s;
}
.ot-chip:hover { background: var(--ai-btn-hover); }
.ot-chip.active { background: var(--ai-accent); color: #fff; }
`;
  document.head.appendChild(el);
}

/** Available feature tags in the display order (curated features first, then ss01…ss20). */
function shownTags(available: Set<string>): { tag: string; label: string; name: string }[] {
  const out = FEATURES.filter((f) => available.has(f.tag));
  for (let i = 1; i <= 20; i++) {
    const tag = `ss${String(i).padStart(2, '0')}`;
    if (available.has(tag)) out.push({ tag, label: `S${i}`, name: `Stylistic set ${i}` });
  }
  return out;
}

/** Parse a font-feature-settings string into the set of explicitly-enabled tags. */
function parseSettings(settings: string): Set<string> {
  const set = new Set<string>();
  const re = /["']([a-z0-9]{4})["']\s*(\d+|on)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(settings || ''))) {
    const val = m[2];
    if (val === undefined || val === 'on' || parseInt(val, 10) > 0) set.add(m[1].toLowerCase());
  }
  return set;
}

function buildSettings(): string {
  return [...active].map((t) => `"${t}" 1`).join(', ');
}

export function setupOpenType(hostEl: HTMLElement, change: OnChange): void {
  injectStyles();
  host = hostEl;
  onChange = change;
  host.className = 'ot-chips';
}

/** Rebuild the chips for a family and reflect the current font-feature-settings.
 *  Hides the row (via the caller-owned host) when the font offers no opt-in features. */
export async function setOpenType(family: string, settings: string): Promise<void> {
  if (!host) return;
  active.clear();
  for (const t of parseSettings(settings)) active.add(t);
  const available = await getFontFeatures(family);
  if (!host) return; // torn down while awaiting
  const tags = shownTags(available);
  host.replaceChildren(); // empty → the row hides via CSS :has(.ot-chips:empty)
  for (const f of tags) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ot-chip';
    chip.textContent = f.label;
    chip.title = f.name;
    chip.classList.toggle('active', active.has(f.tag));
    chip.addEventListener('click', () => {
      if (active.has(f.tag)) active.delete(f.tag); else active.add(f.tag);
      chip.classList.toggle('active', active.has(f.tag));
      onChange(buildSettings());
    });
    host.appendChild(chip);
  }
}
