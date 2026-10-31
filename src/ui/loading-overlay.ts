/**
 * Loading overlay for slow document opens.
 *
 * Opening a large SVG (some are 30–80MB / 100k+ elements) parses, imports and
 * rebuilds the model in one synchronous burst that blocks the main thread for
 * several seconds. With no feedback the app looks frozen/crashed. This overlay
 * is shown *before* that burst and reassures the user work is in progress.
 *
 * The progress bar is animated with a GPU-composited `transform` keyframe, so it
 * keeps sliding on the compositor thread even while the main thread is blocked
 * by the import — a plain width/opacity animation would freeze with everything
 * else. Duration is unknown up front, so the bar is indeterminate.
 */

let overlayEl: HTMLElement | null = null;
let labelEl: HTMLElement | null = null;

const STYLE_ID = 'loading-overlay-style';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .loading-overlay {
      position: fixed; inset: 0; z-index: var(--z-modal);
      display: flex; align-items: center; justify-content: center;
      background: rgba(20, 20, 20, 0.55);
      font-family: 'Segoe UI', system-ui, sans-serif;
    }
    .loading-card {
      min-width: 300px; max-width: 70vw; padding: 22px 26px;
      background: var(--ai-panel); border: 1px solid #555; border-radius: 8px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5); text-align: center; color: #e6e6e6;
    }
    .loading-label {
      font-size: 13px; margin-bottom: 14px; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    .loading-track {
      height: 6px; border-radius: 3px; background: var(--ai-border); overflow: hidden;
    }
    .loading-bar {
      height: 100%; width: 35%; border-radius: 3px; background: var(--ai-accent);
      will-change: transform;
      animation: loading-slide 1.1s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
    @keyframes loading-slide {
      0%   { transform: translateX(-130%); }
      100% { transform: translateX(330%); }
    }
  `;
  document.head.appendChild(style);
}

function ensureOverlay(): void {
  if (overlayEl) return;
  ensureStyles();
  overlayEl = document.createElement('div');
  overlayEl.className = 'loading-overlay';
  overlayEl.setAttribute('role', 'progressbar');
  overlayEl.setAttribute('aria-busy', 'true');
  overlayEl.innerHTML = `
    <div class="loading-card">
      <div class="loading-label"></div>
      <div class="loading-track"><div class="loading-bar"></div></div>
    </div>`;
  labelEl = overlayEl.querySelector('.loading-label');
  document.body.appendChild(overlayEl);
}

export function showLoadingOverlay(label: string): void {
  ensureOverlay();
  if (labelEl) labelEl.textContent = label;
  overlayEl!.style.display = 'flex';
}

export function hideLoadingOverlay(): void {
  if (overlayEl) overlayEl.style.display = 'none';
}

/** Resolve after the browser has had a chance to paint at least one frame. */
function nextPaint(): Promise<void> {
  return new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))),
  );
}

/**
 * Show the overlay, wait for it to paint, then run the (synchronous, blocking)
 * `work`. The overlay is always removed afterwards, even if `work` throws.
 * Returns whatever `work` returns.
 */
export async function withLoadingOverlay<T>(label: string, work: () => T): Promise<T> {
  showLoadingOverlay(label);
  await nextPaint();
  try {
    return work();
  } finally {
    hideLoadingOverlay();
  }
}
