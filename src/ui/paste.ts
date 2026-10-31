import type { AppState } from '../core/state';
import { placeImageDataUrl } from './import-image';

/**
 * Paste content from OUTSIDE the app onto the canvas:
 *   - a raster image (a screenshot, or a PNG/JPG copied from a browser/Finder/etc.)
 *     is embedded as an <image>, centered and fitted on the active frame;
 *   - vector art copied from another design tool (SVG) becomes editable shapes.
 * In-app copy/paste keeps using the internal clipboard (richer: styles, frame nesting).
 *
 * Cmd/Ctrl+V flows through the native `paste` event (main.ts lets it reach here) —
 * clipboardData exposes image bytes with no permission prompt. The Edit ▸ Paste
 * menu can't produce a paste event, so it uses the async Clipboard API instead.
 */

const RASTER = /^image\/(png|jpe?g|gif|webp|bmp|avif|x-icon)$/i;
const NS = 'http://www.w3.org/2000/svg';
const LINE_HEIGHT = 1.2;

function isEditable(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  return !!n && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.isContentEditable === true);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function embedImage(state: AppState, blob: Blob): Promise<void> {
  placeImageDataUrl(state, await blobToDataUrl(blob));
}

/** Drop pasted plain text onto the canvas as an editable point-text element,
 *  in the document's default text style, centered on the active frame. */
function placeText(state: AppState, raw: string): void {
  const lines = raw.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');

  const fs = state.defaultStyle.fontSize ?? 24;
  const el = document.createElementNS(NS, 'text') as SVGTextElement;
  const id = state.nextId();
  el.id = id;
  el.setAttribute('font-size', String(fs));
  el.setAttribute('font-family', state.defaultStyle.fontFamily ?? 'Arial');
  el.setAttribute('font-weight', state.defaultStyle.fontWeight ?? 'normal');
  el.setAttribute('font-style', state.defaultStyle.fontStyle ?? 'normal');
  el.setAttribute('fill', state.fillNone ? '#000' : state.defaultStyle.fill);
  el.setAttribute('x', '0');
  el.setAttribute('y', String(fs * 0.85));
  if (lines.length <= 1) {
    el.textContent = lines[0] ?? '';
  } else {
    for (let i = 0; i < lines.length; i++) {
      const t = document.createElementNS(NS, 'tspan');
      t.setAttribute('x', '0');
      t.setAttribute('dy', i === 0 ? '0' : String(fs * LINE_HEIGHT));
      t.textContent = lines[i];
      el.appendChild(t);
    }
  }
  const name = `Type ${id.replace('shape-', '')}`;
  el.setAttribute('data-name', name);

  // Measure in the DOM, then shift so the text block centers on the active frame.
  const layer = document.getElementById('drawing-layer');
  if (layer) {
    layer.appendChild(el);
    const bb = el.getBBox();
    const ab = state.getActiveArtboard();
    const dx = ab.x + (ab.width - bb.width) / 2 - bb.x;
    const dy = ab.y + (ab.height - bb.height) / 2 - bb.y;
    el.setAttribute('x', String(dx));
    el.setAttribute('y', String(fs * 0.85 + dy));
    el.querySelectorAll('tspan').forEach(t => t.setAttribute('x', String(dx)));
    el.remove(); // addShape re-appends (and re-nests into the active frame)
  }

  state.addShape({
    id, type: 'text', element: el, name,
    style: { ...state.defaultStyle, fill: state.fillNone ? '#000' : state.defaultStyle.fill, stroke: 'none', strokeWidth: 0 },
    visible: true, locked: false,
  });
}

/** Extract an `<svg>` fragment from clipboard data (svg+xml, or text holding <svg>). */
function extractSvg(dt: DataTransfer): { text: string; ours: boolean } | null {
  const fromText = (raw: string): { text: string; ours: boolean } | null => {
    if (!raw) return null;
    const start = raw.indexOf('<svg');
    if (start < 0) return null;
    const end = raw.lastIndexOf('</svg>');
    return { text: end > start ? raw.slice(start, end + 6) : raw.slice(start), ours: /data-bq-clip/.test(raw) };
  };
  return fromText(dt.getData('image/svg+xml'))
    ?? fromText(dt.getData('text/plain'))
    ?? fromText(dt.getData('text/html'));
}

function imageFileFrom(dt: DataTransfer): File | null {
  const item = Array.from(dt.items).find(i => i.kind === 'file' && RASTER.test(i.type));
  if (item) return item.getAsFile();
  return Array.from(dt.files).find(f => RASTER.test(f.type)) ?? null;
}

/**
 * Route clipboard contents onto the canvas, in priority order. Returns true if it
 * consumed the paste (so the caller can preventDefault). Image embedding is async;
 * a truthy return just means "I'm handling this". `inPlace` (Paste in Place) puts
 * our own copy exactly where its source was; foreign content has no such position.
 */
export function pasteFromDataTransfer(state: AppState, dt: DataTransfer, inPlace = false): boolean {
  // 1. Raster image → embed as <image>.
  const img = imageFileFrom(dt);
  if (img) { void embedImage(state, img); return true; }

  // 2. Vector from another app → editable shapes.
  const svg = extractSvg(dt);
  if (svg && !svg.ours) return state.pasteSvgMarkup(svg.text) || true;

  // 3. Plain external text → a text element. Non-SVG text on the clipboard means
  //    our internal buffer is stale (a copy elsewhere overwrote our mirror), so
  //    this wins over the internal paste below.
  const plain = dt.getData('text/plain');
  if (plain && plain.trim() && !plain.includes('<svg')) { placeText(state, plain); return true; }

  // 4. Our own copy (internal buffer wins — it carries style/frame nesting).
  if (state.pasteClipboard(inPlace)) return true;

  // 5. Our SVG mirror with an empty internal buffer (e.g. copied in another tab).
  if (svg) return state.pasteSvgMarkup(svg.text);

  return false;
}

// Set by the Paste in Place shortcut's keydown, which lets the key through so the
// browser still fires its `paste` event (the only way to read the clipboard without a
// permission prompt); that event, which follows at once, consumes it.
let pasteInPlaceArmed = false;

/** Make the `paste` event this keystroke is about to fire a Paste in Place. */
export function armPasteInPlace(): void { pasteInPlaceArmed = true; }

/** Attach the document paste listener (handles Cmd/Ctrl+V and Cmd/Ctrl+Shift+V). */
export function setupPaste(state: AppState): void {
  document.addEventListener('paste', (e) => {
    const inPlace = pasteInPlaceArmed;
    pasteInPlaceArmed = false;
    // A field (layer rename, text input) owns its own paste — don't hijack it.
    if (isEditable(e.target) || isEditable(document.activeElement)) return;
    if (e.clipboardData && pasteFromDataTransfer(state, e.clipboardData, inPlace)) e.preventDefault();
  });
  // A Ctrl+Shift+V that brings no paste event (nothing pasteable) must not leave the
  // next ordinary paste armed.
  document.addEventListener('keyup', () => { pasteInPlaceArmed = false; });
}

/** Menu ▸ Paste path (no paste event available): read via the async Clipboard API. */
export async function pasteExternalAsync(state: AppState): Promise<void> {
  try {
    if (navigator.clipboard?.read) {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find(t => RASTER.test(t));
        if (type) { await embedImage(state, await item.getType(type)); return; }
      }
    }
  } catch { /* no permission / unsupported → fall through to SVG text */ }
  await state.pasteFromSystemClipboard();
}
