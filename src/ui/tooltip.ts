/**
 * Lightweight custom tooltips. Native `title` tooltips render below the cursor,
 * which collides with the now bottom-docked tool bar; these render ABOVE the
 * element (flipping below only if there's no room) and are styled to match the
 * app. On setup we promote `title` → `data-tooltip` on the chrome that should use
 * them (so the browser's native tip doesn't also appear), then delegate globally
 * so dynamically-added elements (e.g. document tabs) work too.
 */

const PROMOTE = '.tool-btn[title], #tab-new[title], .toolbar-swatches [title], .doc-tab[title]';

export function setupTooltips(): void {
  document.querySelectorAll<HTMLElement>(PROMOTE).forEach((el) => {
    const t = el.getAttribute('title');
    if (t) {
      el.setAttribute('data-tooltip', t);
      // Native title supplied the name for icon-only buttons. Keep that name
      // when the custom tooltip takes over, without overriding explicit labels.
      if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && (el.matches('.tool-btn, .toolbar-swatches button') || !el.textContent?.trim())) {
        el.setAttribute('aria-label', t);
      }
      el.removeAttribute('title');
    }
    if (el.matches('.tool-btn[data-tool]')) {
      el.setAttribute('aria-pressed', String(el.classList.contains('active')));
    }
  });

  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.appendChild(tip);

  let current: Element | null = null;
  let timer = 0;

  const place = (el: Element) => {
    const text = el.getAttribute('data-tooltip');
    if (!text) return;
    tip.textContent = text;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let top = r.top - tr.height - 8;
    const below = top < 6;
    if (below) top = r.bottom + 8;
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - tr.width - 6));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.classList.toggle('tooltip-below', below);
  };

  const hide = () => {
    current = null;
    clearTimeout(timer);
    tip.hidden = true;
  };

  document.addEventListener('pointerover', (e) => {
    const el = (e.target as Element).closest?.('[data-tooltip]');
    if (!el || el === current) return;
    current = el;
    clearTimeout(timer);
    timer = window.setTimeout(() => { if (current === el) place(el); }, 350);
  });
  document.addEventListener('pointerout', (e) => {
    const el = (e.target as Element).closest?.('[data-tooltip]');
    if (el && el === current) {
      const to = e.relatedTarget as Element | null;
      if (!to || !current.contains(to)) hide();
    }
  });
  document.addEventListener('pointerdown', hide, true); // dismiss on click/drag
  window.addEventListener('blur', hide);
}
