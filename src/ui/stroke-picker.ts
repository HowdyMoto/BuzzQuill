import { MARKER_PRESETS } from '../core/marker-presets';

interface Choice { value: string; label: string; preview: string; }
let closeActive: (() => void) | null = null;
const svg = (content: string) => `<svg viewBox="0 0 80 28" width="80" height="28" aria-hidden="true">${content}</svg>`;
export const CAP_CHOICES: Choice[] = (['butt', 'round', 'square'] as const).map((cap, i) => ({
  value: cap, label: ['Flat', 'Round', 'Square'][i],
  preview: svg(`<path d="M18 14 H62" stroke="currentColor" stroke-width="10" stroke-linecap="${cap}"/><path d="M62 2 V26" stroke="var(--ai-text-dim)" stroke-width="1" stroke-dasharray="2 2"/>`),
}));
export function endChoices(start: boolean): Choice[] {
  const line = '<path d="M18 14 H62" stroke="currentColor" stroke-width="2"/>';
  return [{ value: '', label: 'None', preview: svg(line) }, ...MARKER_PRESETS.map(p => ({
    value: p.id, label: p.label,
    preview: svg(line + `<g transform="translate(${start ? 18 : 62} 14) scale(${start ? -1 : 1} 1)"><svg x="${-p.refX * p.size / 5}" y="${-p.size}" width="${p.size * 2}" height="${p.size * 2}" viewBox="0 0 10 10" overflow="hidden">${p.svg.replaceAll('context-stroke', 'currentColor')}</svg></g>`),
  }))];
}

/** Visual menu with native buttons, roving arrow-key focus and explicit selection.
 * Pointer dismissal leaves focus with the clicked control; Escape returns it. */
export class StrokePicker {
  private value: string | null = '';
  constructor(privateButton: HTMLButtonElement, choices: Choice[], label: string, onPick: (value: string) => void) {
    this.button = privateButton; this.choices = choices; this.label = label;
    privateButton.classList.add('stroke-picker'); privateButton.type = 'button';
    privateButton.setAttribute('aria-haspopup', 'menu'); privateButton.setAttribute('aria-expanded', 'false');
    privateButton.addEventListener('click', () => this.open(onPick));
    privateButton.addEventListener('keydown', e => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); e.stopPropagation(); this.open(onPick); }
    });
  }
  private button: HTMLButtonElement;
  private choices: Choice[];
  private label: string;
  update(value: string | null): void {
    this.value = value;
    const choice = this.choices.find(c => c.value === value);
    const label = value === null ? 'Mixed' : choice?.label ?? 'Custom';
    this.button.replaceChildren();
    const preview = document.createElement('span'); preview.className = 'stroke-picker-preview';
    if (choice) preview.innerHTML = choice.preview;
    const text = document.createElement('span'); text.className = 'stroke-picker-label'; text.textContent = label;
    const caret = document.createElement('span'); caret.textContent = '▾'; caret.setAttribute('aria-hidden', 'true');
    this.button.append(preview, text, caret);
    this.button.setAttribute('aria-label', `${this.label}: ${label}`);
    this.button.title = `${this.label}: ${label}`;
  }
  private open(onPick: (value: string) => void): void {
    const wasOpen = this.button.getAttribute('aria-expanded') === 'true';
    closeActive?.(); if (wasOpen) return;
    const menu = document.createElement('div'); menu.className = 'stroke-picker-menu';
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', this.label);
    const close = (focus = false) => {
      menu.remove(); this.button.setAttribute('aria-expanded', 'false'); closeActive = null;
      document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('blur', dismiss);
      if (focus && this.button.isConnected) this.button.focus();
    };
    const outside = (e: PointerEvent) => { if (!menu.contains(e.target as Node) && !this.button.contains(e.target as Node)) close(); };
    const dismiss = () => close();
    const buttons = this.choices.map(c => {
      const b = document.createElement('button'); b.type = 'button'; b.tabIndex = -1;
      b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(c.value === this.value));
      const preview = document.createElement('span'); preview.innerHTML = c.preview;
      const label = document.createElement('span'); label.textContent = c.label;
      const check = document.createElement('span'); check.className = 'stroke-picker-check';
      check.textContent = c.value === this.value ? '✓' : ''; check.setAttribute('aria-hidden', 'true');
      b.append(preview, label, check);
      b.addEventListener('click', () => { close(true); onPick(c.value); });
      menu.appendChild(b); return b;
    });
    const keydown = (e: KeyboardEvent) => {
      e.stopImmediatePropagation(); // menu keys must not trigger canvas shortcuts
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(true); }
      else if (e.key === 'Tab') { close(true); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault(); e.stopImmediatePropagation();
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
      }
    };
    document.body.appendChild(menu);
    const r = this.button.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 4))}px`;
    this.button.setAttribute('aria-expanded', 'true'); closeActive = dismiss;
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keydown, true);
    window.addEventListener('blur', dismiss);
    (buttons.find(b => b.getAttribute('aria-checked') === 'true') ?? buttons[0]).focus();
  }
}
