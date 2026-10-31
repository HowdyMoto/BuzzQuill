/**
 * Lightweight transient notifications (toasts).
 *
 * Used to tell the user about non-fatal import caveats — e.g. an opened SVG used
 * a feature BuzzQuill doesn't support and it was dropped. Self-contained (injects
 * its own styles) and non-blocking, unlike `alert()`.
 *
 * ## The gooey stack
 *
 * Toasts render in TWO layers, and the split is the whole trick:
 *
 *   • a BLOB layer — one solid rounded rect per toast, behind everything, with an
 *     SVG goo filter (blur → alpha-contrast) on the shared parent. Because the
 *     filter sits on the parent, neighbouring blobs bleed into one another and
 *     merge like liquid as they enter, leave, or slide to a new slot.
 *   • a CONTENT layer — icon, message, buttons — with a transparent background
 *     and NO filter, so text stays perfectly crisp.
 *
 * Putting the filter on the whole stack would be far less code and would blur the
 * text into mush, which is why the blobs are tracked and positioned separately.
 * Each toast owns a blob; `syncBlobs` mirrors the flex layout onto them, and the
 * blob's own CSS transition does the morphing when a slot changes.
 *
 * Honors prefers-reduced-motion: the goo and the spring are dropped for a plain
 * fade, and the blob simply becomes the toast's background.
 */

const STYLE_ID = 'toast-style';
const GOO_FILTER_ID = 'bq-toast-goo';
/** Slack around the blob layer so the goo blur isn't clipped at the edges; blob
 *  coordinates are offset by this much to compensate. */
const GOO_PAD = 32;

let container: HTMLElement | null = null;
let blobLayer: HTMLElement | null = null;
/** Live toast → its blob, so layout changes can be mirrored onto the blobs. */
const blobs = new Map<HTMLElement, HTMLElement>();

/** The goo filter lives in its own hidden <svg> in <body> — never in the editor's
 *  canvas, where it would land in the document model, the history snapshot and
 *  the exported file. */
function ensureGooFilter(): void {
  if (document.getElementById(GOO_FILTER_ID)) return;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';
  const defs = document.createElementNS(NS, 'defs');
  const filter = document.createElementNS(NS, 'filter');
  filter.setAttribute('id', GOO_FILTER_ID);
  // Generous region: the blur reaches well outside each blob's own box.
  filter.setAttribute('x', '-50%'); filter.setAttribute('y', '-50%');
  filter.setAttribute('width', '200%'); filter.setAttribute('height', '200%');
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  const blur = document.createElementNS(NS, 'feGaussianBlur');
  blur.setAttribute('in', 'SourceGraphic');
  blur.setAttribute('stdDeviation', '8');
  blur.setAttribute('result', 'blur');
  // Ramp alpha hard so the blurred halo snaps back to a solid edge — overlapping
  // blurs cross the threshold together, which is what fuses them into one shape.
  const contrast = document.createElementNS(NS, 'feColorMatrix');
  contrast.setAttribute('in', 'blur');
  contrast.setAttribute('type', 'matrix');
  contrast.setAttribute('values', '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -10');
  filter.append(blur, contrast);
  defs.appendChild(filter);
  svg.appendChild(defs);
  document.body.appendChild(svg);
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .toast-stack {
      position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
      z-index: 11000; display: flex; flex-direction: column; gap: 10px;
      align-items: center; pointer-events: none;
      font-family: 'Segoe UI', system-ui, sans-serif;
    }
    /* Blob layer: the only thing the goo filter touches. Inset negatively so the
       blur has room to spread without being clipped. */
    .toast-goo {
      position: absolute; left: ${-GOO_PAD}px; top: ${-GOO_PAD}px;
      right: ${-GOO_PAD}px; bottom: ${-GOO_PAD}px;
      z-index: 0; pointer-events: none;
      filter: url(#${GOO_FILTER_ID}) drop-shadow(0 8px 26px rgba(0,0,0,0.45));
    }
    .toast-blob {
      position: absolute; border-radius: 10px;
      background: var(--ai-panel, #2b2b2b);
      opacity: 0; transform: scale(0.94);
      transition: left var(--fx-settle) var(--fx-spring),
                  top var(--fx-settle) var(--fx-spring),
                  width var(--fx-settle) var(--fx-spring),
                  height var(--fx-settle) var(--fx-spring),
                  opacity .2s ease, transform var(--fx-settle) var(--fx-spring);
    }
    .toast-blob.show { opacity: 1; transform: scale(1); }
    .toast {
      position: relative; z-index: 1;
      pointer-events: auto; max-width: 460px;
      display: flex; align-items: flex-start; gap: 10px;
      padding: 11px 14px; border-radius: 10px;
      background: transparent; border: none; color: #e8e8e8;
      font-size: 12.5px; line-height: 1.4;
      opacity: 0; transform: translateY(8px); transition: opacity .18s ease, transform .18s ease;
    }
    /* The content waits a beat, so the blob has swelled out of the tool bar
       before the text lands on it. Leaving has no delay. */
    .toast.show { opacity: 1; transform: translateY(0); transition-delay: 40ms; }
    .toast-icon { flex: none; margin-top: 1px; color: #f0c040; position: relative; }
    .toast-icon svg { display: block; }
    /* Success: the ring, then the tick, draw themselves in, the icon pops, and a
       few sparks fly — the export button's celebration, toast-sized. */
    .toast.success .ring { stroke-dasharray: 57; stroke-dashoffset: 57; }
    .toast.success .tick { stroke-dasharray: 12; stroke-dashoffset: 12; }
    .toast.show.success .ring { animation: toast-draw .34s ease-out .16s forwards; }
    .toast.show.success .tick { animation: toast-draw .22s ease-out .4s forwards; }
    /* Losing .show ends those animations; keep the check drawn while it fades. */
    .toast.leaving.success .ring, .toast.leaving.success .tick { stroke-dashoffset: 0; }
    .toast.show.success .toast-icon { animation: toast-pop .5s var(--fx-spring) .14s both; }
    .toast.show.warning .toast-icon { animation: toast-wobble .6s ease-in-out .3s both; }
    .toast.show.info .toast-icon { animation: toast-bob .5s var(--fx-spring) .2s both; }
    @keyframes toast-draw { to { stroke-dashoffset: 0; } }
    @keyframes toast-pop { 0% { transform: scale(.4); } 60% { transform: scale(1.08); } 100% { transform: scale(1); } }
    @keyframes toast-wobble { 0%,100% { transform: rotate(0); } 20% { transform: rotate(-4deg); } 45% { transform: rotate(3deg); } 70% { transform: rotate(-1deg); } }
    @keyframes toast-bob { 0% { transform: translateY(5px) scale(.7); } 60% { transform: translateY(-2px) scale(1.1); } 100% { transform: none; } }
    .toast-sparks { position: absolute; left: 50%; top: 50%; pointer-events: none; }
    .toast-sparks i {
      position: absolute; width: 4px; height: 4px; margin: -2px 0 0 -2px;
      border-radius: 50%; opacity: 0;
    }
    .toast.show .toast-sparks i { animation: toast-spark .6s cubic-bezier(.2,.7,.3,1) .46s both; }
    @keyframes toast-spark {
      0%   { opacity: 1; transform: translate(0, 0) scale(1); }
      100% { opacity: 0; transform: translate(var(--dx), var(--dy)) scale(.3); }
    }
    /* Leaving is a plain, unhurried fade in place. The goo filter can't fade: its
       alpha threshold breaks a half-transparent blob into smudges. So the toast
       takes over the panel look itself, the blob drops out under it, and the toast
       fades as one solid piece. */
    .toast-blob.leaving { transition: none; opacity: 0; }
    .toast.leaving {
      background: var(--ai-panel, #2b2b2b); box-shadow: 0 8px 26px rgba(0,0,0,0.45);
      transform: none; transition: opacity .35s ease;
    }
    /* Icon colour by kind — success reads as confident, not alarming. */
    .toast.success .toast-icon { color: var(--fx-success); }
    .toast.warning .toast-icon { color: #f0c040; }
    .toast.info .toast-icon { color: var(--ai-accent, #4a8cff); }
    .toast-msg { flex: 1 1 auto; }
    .toast-close {
      flex: none; background: none; border: none; color: var(--ai-text-dim); cursor: pointer;
      font-size: 15px; line-height: 1; padding: 0 2px;
    }
    .toast-close:hover { color: #ddd; }
    .toast-action {
      flex: none; align-self: center; cursor: pointer;
      background: var(--ai-accent, #4a8cff); border: none; color: #fff;
      font: inherit; font-weight: 600; font-size: 12px; line-height: 1;
      padding: 6px 10px; border-radius: 5px; white-space: nowrap;
    }
    .toast-action:hover { filter: brightness(1.1); }
    /* No goo, no spring — a plain panel that fades. */
    @media (prefers-reduced-motion: reduce) {
      .toast-goo { filter: drop-shadow(0 8px 26px rgba(0,0,0,0.45)); }
      .toast-blob { transition: opacity .15s ease; transform: none; border: 1px solid #555; }
      .toast-blob.show { transform: none; }
      .toast { transition: opacity .15s ease; transform: none; }
      .toast.show { transform: none; transition-delay: 0s; }
      .toast-icon, .toast.show .toast-icon { animation: none; }
      .toast.success .ring, .toast.success .tick { stroke-dasharray: none; animation: none; }
      .toast-sparks { display: none; }
    }
  `;
  document.head.appendChild(style);
}

function ensureContainer(): HTMLElement {
  if (container) return container;
  ensureStyles();
  ensureGooFilter();
  container = document.createElement('div');
  container.className = 'toast-stack';
  blobLayer = document.createElement('div');
  blobLayer.className = 'toast-goo';
  container.appendChild(blobLayer);
  document.body.appendChild(container);
  // Text reflow (a long message wrapping) changes a toast's height without any
  // add/remove, so mirror size changes too rather than only on insert/dismiss.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => syncBlobs()).observe(container);
  }
  window.addEventListener('resize', placeStack);
  return container;
}

/** Gap between the stack and the floating tool bar under it. */
const TOOLBAR_GAP = 12;

/** Sit the stack just above the floating tool bar (#toolbar, bottom-centre), so a
 *  toast never covers the tools; without a visible tool bar it keeps its CSS
 *  default. Re-measured on every toast and on resize, since the bar's height
 *  changes with the window and can be hidden. */
function placeStack(): void {
  if (!container) return;
  const bar = document.getElementById('toolbar')?.getBoundingClientRect();
  container.style.bottom = bar && bar.height > 0
    ? `${Math.max(16, window.innerHeight - bar.top + TOOLBAR_GAP)}px`
    : '';
}

/** Mirror each toast's box onto its blob. The blobs are absolutely positioned in
 *  their own layer, so this is what keeps them under their toasts as the flex
 *  column reflows — and because the blob transitions these properties, a toast
 *  leaving makes the ones below morph up into its place. */
function syncBlobs(): void {
  for (const [toast, blob] of blobs) {
    if (!toast.isConnected) continue;
    blob.style.left = `${toast.offsetLeft + GOO_PAD}px`;
    blob.style.top = `${toast.offsetTop + GOO_PAD}px`;
    blob.style.width = `${toast.offsetWidth}px`;
    blob.style.height = `${toast.offsetHeight}px`;
  }
}

/** The blob directly above `blob` in the stack, if any. */
function previousBlobOf(blob: HTMLElement): HTMLElement | null {
  const prev = blob.previousElementSibling;
  return prev instanceof HTMLElement && prev.classList.contains('toast-blob') ? prev : null;
}

/** Users who asked the OS for less motion get the plain fade, not the goo. */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const WARN_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
const SUCCESS_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle class="ring" cx="12" cy="12" r="9" transform="rotate(-90 12 12)"/><path class="tick" d="m8.5 12 2.5 2.5 4.5-5"/></svg>';
const INFO_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';

export type ToastKind = 'success' | 'warning' | 'info';
const ICONS: Record<ToastKind, string> = { success: SUCCESS_ICON, warning: WARN_ICON, info: INFO_ICON };

/** An optional call-to-action button rendered inside a toast. */
export interface ToastAction {
  label: string;
  /** Invoked on click. The toast auto-dismisses afterward. */
  onClick: () => void;
}

const SPARK_COLORS = ['var(--fx-success)', 'var(--ai-accent)', 'var(--ai-text-bright)'];

/** Six dots that burst out of a success icon (same palette as the export confetti). */
function sparks(): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'toast-sparks';
  wrap.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    const dist = 15 + (i % 2) * 5;
    const dot = document.createElement('i');
    dot.style.setProperty('--dx', `${(Math.cos(a) * dist).toFixed(1)}px`);
    dot.style.setProperty('--dy', `${(Math.sin(a) * dist).toFixed(1)}px`);
    dot.style.background = SPARK_COLORS[i % SPARK_COLORS.length];
    wrap.appendChild(dot);
  }
  return wrap;
}

/** Shrink a blob to a small pill at the bottom centre of `toast`'s slot — where a
 *  lone toast swells up from, just above the tool bar. */
function pinchBlob(blob: HTMLElement, toast: HTMLElement): void {
  const w = 44, h = 12;
  blob.style.left = `${toast.offsetLeft + GOO_PAD + toast.offsetWidth / 2 - w / 2}px`;
  blob.style.top = `${toast.offsetTop + GOO_PAD + toast.offsetHeight - h}px`;
  blob.style.width = `${w}px`;
  blob.style.height = `${h}px`;
}

/**
 * Show a transient toast. Auto-dismisses after `durationMs` (0 = until closed).
 * `kind` picks the icon/tint — 'success' reads as confident, 'warning' as a caveat
 * (the default, for the import/caveat messages this started life serving). Pass an
 * `action` to render a clickable button (e.g. "Reload") before the close ✕.
 */
export function showToast(message: string, durationMs = 8000, action?: ToastAction, kind: ToastKind = 'warning'): void {
  const stack = ensureContainer();
  placeStack();
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.setAttribute('role', 'status');

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = ICONS[kind];
  if (kind === 'success' && !prefersReducedMotion()) icon.appendChild(sparks());

  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.textContent = '✕';
  close.title = 'Dismiss';
  close.setAttribute('aria-label', 'Dismiss notification');

  const blob = document.createElement('div');
  blob.className = 'toast-blob';

  let dismissed = false;
  let timer = 0;
  const dismiss = () => {
    if (dismissed) return; // close ✕ and the auto-dismiss timer both land here
    dismissed = true;
    window.clearTimeout(timer);
    toast.classList.add('leaving');
    blob.classList.add('leaving');
    toast.classList.remove('show');
    blob.classList.remove('show');
    const reduced = prefersReducedMotion();
    window.setTimeout(() => {
      blobs.delete(toast);
      blob.remove();
      toast.remove();
      // The survivors slide up into the freed slot; re-mirror so their blobs
      // travel with them (the transition turns that into the morph).
      syncBlobs();
    }, reduced ? 160 : 420);
  };
  close.addEventListener('click', dismiss);

  toast.append(icon, msg);
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { action.onClick(); dismiss(); });
    toast.append(btn);
  }
  toast.append(close);
  stack.appendChild(toast);
  blobLayer?.appendChild(blob);
  blobs.set(toast, blob);

  // Seed the new blob ON TOP of its neighbour, then let the transition carry it
  // down to its own slot. The two overlap for the whole trip, so the goo fuses
  // them and the toast reads as budding off the stack — which is the effect.
  // Proximity alone can't do this: a resting gap tight enough to merge also
  // merges when nothing is happening, and the stack stops reading as separate
  // messages. Travelling through the overlap decouples the two.
  const prev = previousBlobOf(blob);
  if (prev && !prefersReducedMotion()) {
    blob.style.left = prev.style.left;
    blob.style.top = prev.style.top;
    blob.style.width = prev.style.width;
    blob.style.height = prev.style.height;
  } else if (!prefersReducedMotion()) {
    // First toast in the stack: start as a small pill at its foot, right above
    // the tool bar, and spring up to full size — it swells out of the bar.
    pinchBlob(blob, toast);
  } else {
    syncBlobs();
  }
  requestAnimationFrame(() => {
    syncBlobs();
    toast.classList.add('show');
    blob.classList.add('show');
  });
  if (durationMs > 0) {
    // Hover and keyboard focus hold the toast so reading or reaching its action never races expiry.
    let remaining = durationMs;
    let startedAt = 0;
    const pause = () => {
      if (!timer) return;
      window.clearTimeout(timer);
      timer = 0;
      remaining = Math.max(0, remaining - (performance.now() - startedAt));
    };
    const arm = () => {
      if (dismissed || toast.matches(':hover') || toast.contains(document.activeElement)) return;
      window.clearTimeout(timer);
      startedAt = performance.now();
      timer = window.setTimeout(dismiss, remaining);
    };
    toast.addEventListener('mouseenter', pause);
    toast.addEventListener('mouseleave', arm);
    toast.addEventListener('focusin', pause);
    toast.addEventListener('focusout', () => queueMicrotask(arm));
    arm();
  }
}
