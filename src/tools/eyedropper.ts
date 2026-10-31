import { effectivePaint } from '../core/effective-paint';
import { showToast } from '../ui/toast';
import { BaseTool } from './base';
import type { Point } from '../core/types';

/** Load a (data-URL) image so its pixels can be read off an offscreen canvas. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');
const rgbToHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase();

/**
 * Eyedropper: copy an object's look onto the SELECTION (Illustrator/Figma), or —
 * with nothing selected — load it as the style the next shape is drawn with.
 *
 * It used to do only the latter, silently: with a selection active the panels show
 * the SELECTION's values, so a pick changed nothing you could see and the tool read
 * as broken. Applying to the selection is what an eyedropper is for; the sample is
 * the paint that actually RENDERS (inherited paints included) plus the stroke
 * weight, applied in one undo step.
 */
export class EyedropperTool extends BaseTool {
  name = 'eyedropper';

  activate(): void {
    // Pipette cursor (see style.css) — a class rather than an inline style so the
    // rule can also override the per-element cursors canvas children carry.
    this.svgCanvas.classList.add('cursor-eyedropper');
  }

  deactivate(): void {
    this.svgCanvas.classList.remove('cursor-eyedropper');
  }

  onMouseDown(_pt: Point, e: MouseEvent): void {
    const target = e.target as SVGElement;
    const shapeEl = this.findShapeElement(target);
    if (!shapeEl) return;

    // A raster <image> has no fill/stroke — its colour lives in the pixels, so sample
    // the pixel under the cursor instead of reading attributes.
    if (shapeEl.tagName.toLowerCase() === 'image') {
      void this.pickFromImage(shapeEl as unknown as SVGImageElement, e);
      return;
    }

    // Don't sample the objects we're about to paint — picking a shape that is itself
    // selected would just repaint it with its own look (and burn an undo step).
    if (this.state.selectedShapeIds.includes(shapeEl.id)) return;

    // Pick the paint that RENDERS, including one inherited from a group —
    // sampling the bare attribute returned nothing for such shapes (#208).
    const fill = effectivePaint(shapeEl, 'fill') ?? '';
    const stroke = effectivePaint(shapeEl, 'stroke') ?? '';
    const strokeWidthRaw = effectivePaint(shapeEl, 'stroke-width') ?? '';
    const strokeWidth = strokeWidthRaw ? parseFloat(strokeWidthRaw) : undefined;

    this.applySample({
      fill: fill || undefined,
      stroke: stroke || undefined,
      strokeWidth: Number.isFinite(strokeWidth) ? strokeWidth : undefined,
    });
  }

  /**
   * Route a sample to its target: the SELECTION when there is one (one undo step),
   * else the new-shape style. Either way it announces what it picked — a pick that
   * changes nothing visible is exactly what made this tool feel dead.
   */
  private applySample(sample: { fill?: string; stroke?: string; strokeWidth?: number }): void {
    if (sample.fill === undefined && sample.stroke === undefined) return;
    const ids = [...this.state.selectedShapeIds];

    if (ids.length > 0) {
      this.state.applySampledStyle(ids, sample);
      showToast(`Picked ${this.describe(sample)} → ${ids.length} object${ids.length > 1 ? 's' : ''}`,
        2200, undefined, 'success');
      return;
    }

    // Nothing selected: load the sample as the style the next shape is born with.
    if (sample.fill !== undefined) {
      if (sample.fill === 'none') this.state.fillNone = true;
      else { this.state.defaultStyle.fill = sample.fill; this.state.fillNone = false; }
    }
    if (sample.stroke !== undefined) {
      if (sample.stroke === 'none') this.state.strokeNone = true;
      else { this.state.defaultStyle.stroke = sample.stroke; this.state.strokeNone = false; }
    }
    if (sample.strokeWidth !== undefined) this.state.defaultStyle.strokeWidth = sample.strokeWidth;
    this.state.onChange_public();
    showToast(`Picked ${this.describe(sample)} — select an object to paint it, or draw a new one`,
      2600, undefined, 'info');
  }

  /** A short human label for a sample: "#2D7FF9", "no fill", "gradient", … */
  private describe(sample: { fill?: string; stroke?: string }): string {
    const label = (v: string | undefined, kind: 'fill' | 'stroke'): string | null => {
      if (v === undefined) return null;
      if (v === 'none') return `no ${kind}`;
      if (v.startsWith('url(')) return `${kind} pattern`;
      return v.toUpperCase();
    };
    const f = label(sample.fill, 'fill');
    // A plain fill colour reads on its own; mention the stroke only when it adds info.
    if (f && f.startsWith('#')) return f;
    return [f, label(sample.stroke, 'stroke')].filter(Boolean).join(' + ') || 'style';
  }

  onMouseMove(_pt: Point, _e: MouseEvent): void {}
  onMouseUp(_pt: Point, _e: MouseEvent): void {}

  /** Read the pixel under the cursor from a raster <image> and adopt it as the fill. */
  private async pickFromImage(imgEl: SVGImageElement, e: MouseEvent): Promise<void> {
    const hex = await this.sampleImagePixel(imgEl, e);
    if (!hex) return;
    this.applySample({ fill: hex }); // a pixel has no stroke — fill only
  }

  /** Map the click into the image's natural pixel grid (honouring its position,
   *  size and preserveAspectRatio letterboxing) and return that pixel's hex, or null
   *  when the click is outside the image or on a fully-transparent pixel. */
  private async sampleImagePixel(imgEl: SVGImageElement, e: MouseEvent): Promise<string | null> {
    const href = imgEl.getAttribute('href')
      || imgEl.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    const ctm = imgEl.getScreenCTM();
    if (!href || !ctm) return null;

    // Click (screen) → image-element local coords.
    const p = this.svgCanvas.createSVGPoint();
    p.x = e.clientX; p.y = e.clientY;
    const local = p.matrixTransform(ctm.inverse());

    const ix = parseFloat(imgEl.getAttribute('x') || '0');
    const iy = parseFloat(imgEl.getAttribute('y') || '0');
    const ew = parseFloat(imgEl.getAttribute('width') || '0');
    const eh = parseFloat(imgEl.getAttribute('height') || '0');
    if (ew <= 0 || eh <= 0) return null;

    let img: HTMLImageElement;
    try { img = await loadImage(href); } catch { return null; }
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) return null;

    // Element-local → natural pixel, accounting for preserveAspectRatio.
    const par = imgEl.getAttribute('preserveAspectRatio') || 'xMidYMid meet';
    let px: number, py: number;
    if (par.startsWith('none')) {
      px = ((local.x - ix) / ew) * nw;
      py = ((local.y - iy) / eh) * nh;
    } else {
      // 'meet' (the importer's default): scale to fit, centred (xMidYMid).
      const scale = Math.min(ew / nw, eh / nh);
      const offX = (ew - nw * scale) / 2;
      const offY = (eh - nh * scale) / 2;
      px = (local.x - ix - offX) / scale;
      py = (local.y - iy - offY) / scale;
    }
    if (px < 0 || py < 0 || px >= nw || py >= nh) return null;

    const canvas = document.createElement('canvas');
    canvas.width = nw; canvas.height = nh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    let d: Uint8ClampedArray;
    try { d = ctx.getImageData(Math.floor(px), Math.floor(py), 1, 1).data; } catch { return null; }
    if (d[3] === 0) return null; // fully transparent — nothing to pick
    return rgbToHex(d[0], d[1], d[2]);
  }

  private findShapeElement(target: SVGElement): SVGElement | null {
    let el: SVGElement | null = target;
    while (el) {
      if (el.id && this.state.findShapeById(el.id)) return el;
      el = el.parentElement as SVGElement | null;
    }
    return null;
  }
}
