/**
 * Draggable side-panel resizers. The left (Layers) and right (Properties) panels
 * are grid columns sized by the `--left-panel-w` / `--panel-w` CSS vars; each
 * resizer is a thin strip pinned to that panel's inner edge that drags the var.
 * Widths persist in localStorage; double-click resets to the default.
 *
 * Discoverability: each strip shows an always-visible grip that highlights (accent)
 * on hover along with a `col-resize` cursor — the standard "grab me" affordance.
 */

const MIN = 180;
const MAX = 480;
const DEFAULT_LEFT = 240;
const DEFAULT_RIGHT = 260;
const LS_LEFT = 'bq.leftPanelW';
const LS_RIGHT = 'bq.rightPanelW';

type Side = 'left' | 'right';

const clamp = (v: number) => Math.max(MIN, Math.min(MAX, v));

/** @param onResize run after the panel width changes so the canvas can refit. */
export function setupPanelResizers(onResize: () => void): void {
  const root = document.documentElement;

  const cfg = {
    left: { id: 'left-resizer', varName: '--left-panel-w', ls: LS_LEFT, def: DEFAULT_LEFT },
    right: { id: 'right-resizer', varName: '--panel-w', ls: LS_RIGHT, def: DEFAULT_RIGHT },
  } as const;

  // Restore saved widths before anything paints.
  for (const side of ['left', 'right'] as Side[]) {
    const saved = parseInt(localStorage.getItem(cfg[side].ls) || '', 10);
    if (saved) root.style.setProperty(cfg[side].varName, `${clamp(saved)}px`);
  }

  const currentWidth = (varName: string, def: number) =>
    parseFloat(getComputedStyle(root).getPropertyValue(varName)) || def;

  for (const side of ['left', 'right'] as Side[]) {
    const { id, varName, ls, def } = cfg[side];
    const el = document.getElementById(id);
    if (!el) continue;

    el.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = currentWidth(varName, def);
      el.classList.add('active');
      document.body.classList.add('resizing-col');

      let raf = 0;
      let latest = startW;
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        // Left panel grows dragging right; right panel grows dragging left.
        latest = clamp(startW + (side === 'left' ? dx : -dx));
        if (!raf) {
          raf = requestAnimationFrame(() => {
            raf = 0;
            root.style.setProperty(varName, `${latest}px`);
            onResize();
          });
        }
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (raf) cancelAnimationFrame(raf);
        root.style.setProperty(varName, `${latest}px`);
        el.classList.remove('active');
        document.body.classList.remove('resizing-col');
        localStorage.setItem(ls, String(Math.round(latest)));
        onResize();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    // Double-click restores the default width.
    el.addEventListener('dblclick', () => {
      root.style.setProperty(varName, `${def}px`);
      localStorage.removeItem(ls);
      onResize();
    });
  }
}
