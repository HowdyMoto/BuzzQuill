import type { Point } from './types';

/** Pinch-zoom damping: exponent applied to each pinch step so pinch zooms at ~1/9
 *  the sensitivity of the scroll-wheel zoom (zoom is multiplicative, so 1/9 the
 *  speed = the ninth root of the per-event step). */
const PINCH_DAMP = 1 / 9;

export interface ViewState {
  viewBox: { x: number; y: number; w: number; h: number };
  zoom: number;
}

export class CanvasController {
  private svgCanvas: SVGSVGElement;
  private viewBox = { x: -80, y: -30, w: 1120, h: 600 };
  private zoom = 1;
  private isPanning = false;
  private panStart: Point = { x: 0, y: 0 };
  private panViewBoxStart = { x: 0, y: 0 };
  private cursorPosEl: HTMLElement;
  private zoomSelect: HTMLSelectElement;
  private onViewChange: (() => void) | null = null;

  constructor(svgCanvas: SVGSVGElement) {
    this.svgCanvas = svgCanvas;
    this.cursorPosEl = document.getElementById('cursor-pos')!;
    this.zoomSelect = document.getElementById('zoom-select') as HTMLSelectElement;
    this.updateViewBox();
    this.setupEvents();
  }

  setOnViewChange(fn: () => void): void {
    this.onViewChange = fn;
  }

  private setupEvents(): void {
    this.svgCanvas.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      // Ignore the wheel while middle-drag panning — some mice emit stray wheel
      // deltas mid-pan, which caused jarring zoom jumps.
      if (this.isPanning) return;
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      this.setZoom(this.zoom * delta, { x: e.clientX, y: e.clientY });
    }, { passive: false });

    // Trackpad PINCH (and ⌘/Ctrl+wheel) arrives as a wheel event with ctrlKey set.
    // The browser's default for that is to zoom the whole PAGE — which scales our
    // entire UI. Intercept it at the window (capture phase) everywhere so the page
    // never zooms; instead it zooms the DRAWING. stopPropagation keeps the canvas's
    // own wheel handler above from also firing (no double-zoom) when over the canvas;
    // over the panels/toolbar we zoom about the canvas centre. Plain (non-ctrl) wheel
    // is left untouched so normal scrolling/zoom-over-canvas behaves as before.
    window.addEventListener('wheel', (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.isPanning) return;
      // Pinch is much twitchier than a scroll wheel (many events per gesture), so
      // damp it to ~1/3 the per-event step. Zoom is multiplicative, so 1/3 the
      // "speed" = the cube root of the wheel step (PINCH_DAMP).
      const delta = (e.deltaY > 0 ? 0.9 : 1.1) ** PINCH_DAMP;
      const overCanvas = this.svgCanvas.contains(e.target as Node);
      this.setZoom(this.zoom * delta, overCanvas ? { x: e.clientX, y: e.clientY } : undefined);
    }, { passive: false, capture: true });

    // Safari delivers pinch as gesture* events (not ctrl+wheel) and page-zooms on
    // them; preventDefault kills that and routes the scale to the drawing instead.
    let gestureScale = 1;
    document.addEventListener('gesturestart', (e: Event) => {
      e.preventDefault();
      gestureScale = (e as unknown as { scale?: number }).scale ?? 1;
    }, { passive: false });
    document.addEventListener('gesturechange', (e: Event) => {
      e.preventDefault();
      const ge = e as unknown as { scale?: number; clientX?: number; clientY?: number };
      const s = ge.scale ?? 1;
      const factor = (gestureScale !== 0 ? s / gestureScale : 1) ** PINCH_DAMP;
      gestureScale = s;
      const overCanvas = ge.clientX != null && this.svgCanvas.contains(document.elementFromPoint(ge.clientX, ge.clientY ?? 0) as Node);
      this.setZoom(this.zoom * factor, overCanvas ? { x: ge.clientX!, y: ge.clientY! } : undefined);
    }, { passive: false });
    document.addEventListener('gestureend', (e: Event) => e.preventDefault(), { passive: false });

    this.zoomSelect.addEventListener('change', () => {
      this.setZoom(parseFloat(this.zoomSelect.value));
    });

    document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
      this.setZoom(this.zoom * 1.25);
    });

    document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
      this.setZoom(this.zoom / 1.25);
    });

    this.svgCanvas.addEventListener('mousemove', (e: MouseEvent) => {
      const pt = this.screenToSVG(e.clientX, e.clientY);
      this.cursorPosEl.textContent = `${Math.round(pt.x)}, ${Math.round(pt.y)}`;

      if (this.isPanning) {
        const dx = (e.clientX - this.panStart.x) / this.zoom;
        const dy = (e.clientY - this.panStart.y) / this.zoom;
        this.viewBox.x = this.panViewBoxStart.x - dx;
        this.viewBox.y = this.panViewBoxStart.y - dy;
        this.updateViewBox();
        this.notifyViewChange();
      }
    });
  }

  startPan(clientX: number, clientY: number): void {
    this.isPanning = true;
    this.panStart = { x: clientX, y: clientY };
    this.panViewBoxStart = { x: this.viewBox.x, y: this.viewBox.y };
    this.svgCanvas.style.cursor = 'grabbing';
  }

  endPan(): void {
    this.isPanning = false;
    this.svgCanvas.style.cursor = '';
  }

  get panning(): boolean {
    return this.isPanning;
  }

  setZoom(newZoom: number, screenCenter?: Point): void {
    newZoom = Math.max(0.05, Math.min(64, newZoom));

    if (screenCenter) {
      const svgPt = this.screenToSVG(screenCenter.x, screenCenter.y);
      this.zoom = newZoom;
      const rect = this.svgCanvas.getBoundingClientRect();
      this.viewBox.w = rect.width / this.zoom;
      this.viewBox.h = rect.height / this.zoom;
      const newSvgPt = this.screenToSVG(screenCenter.x, screenCenter.y);
      this.viewBox.x += svgPt.x - newSvgPt.x;
      this.viewBox.y += svgPt.y - newSvgPt.y;
    } else {
      const cx = this.viewBox.x + this.viewBox.w / 2;
      const cy = this.viewBox.y + this.viewBox.h / 2;
      this.zoom = newZoom;
      const rect = this.svgCanvas.getBoundingClientRect();
      this.viewBox.w = rect.width / this.zoom;
      this.viewBox.h = rect.height / this.zoom;
      this.viewBox.x = cx - this.viewBox.w / 2;
      this.viewBox.y = cy - this.viewBox.h / 2;
    }

    this.updateViewBox();
    this.updateZoomSelect();
    this.notifyViewChange();
  }

  fitToWindow(bounds?: { x: number; y: number; w: number; h: number }): void {
    const rect = this.svgCanvas.getBoundingClientRect();
    const bx = bounds?.x ?? 0;
    const by = bounds?.y ?? 0;
    const bw = bounds?.w ?? 960;
    const bh = bounds?.h ?? 540;
    const pad = 60;
    const scaleX = rect.width / (bw + pad * 2);
    const scaleY = rect.height / (bh + pad * 2);
    // Same clamp as setZoom — focusing a tiny shape must not exceed max zoom.
    const scale = Math.max(0.05, Math.min(64, Math.min(scaleX, scaleY)));
    this.zoom = scale;
    this.viewBox.w = rect.width / this.zoom;
    this.viewBox.h = rect.height / this.zoom;
    this.viewBox.x = bx + (bw - this.viewBox.w) / 2;
    this.viewBox.y = by + (bh - this.viewBox.h) / 2;
    this.updateViewBox();
    this.updateZoomSelect();
    this.notifyViewChange();
  }

  /** Snapshot the viewport (per-document tab remembers its own zoom/pan). */
  getViewState(): ViewState {
    return { viewBox: { ...this.viewBox }, zoom: this.zoom };
  }

  setViewState(v: ViewState): void {
    this.viewBox = { ...v.viewBox };
    this.zoom = v.zoom;
    this.updateViewBox();
    this.updateZoomSelect();
    this.notifyViewChange();
  }

  private updateViewBox(): void {
    this.svgCanvas.setAttribute('viewBox',
      `${this.viewBox.x} ${this.viewBox.y} ${this.viewBox.w} ${this.viewBox.h}`);
  }

  private updateZoomSelect(): void {
    const pct = Math.round(this.zoom * 100);
    const options = this.zoomSelect.options;
    let matched = false;
    for (let i = 0; i < options.length; i++) {
      const optPct = Math.round(parseFloat(options[i].value) * 100);
      if (Math.abs(optPct - pct) < 2) {
        this.zoomSelect.selectedIndex = i;
        matched = true;
        break;
      }
    }
    if (!matched) {
      const existing = this.zoomSelect.querySelector('option[data-custom]');
      if (existing) existing.remove();
      const opt = document.createElement('option');
      opt.value = String(this.zoom);
      opt.textContent = `${pct}%`;
      opt.setAttribute('data-custom', 'true');
      opt.selected = true;
      this.zoomSelect.appendChild(opt);
    }
  }

  private notifyViewChange(): void {
    if (this.onViewChange) this.onViewChange();
  }

  screenToSVG(clientX: number, clientY: number): Point {
    const rect = this.svgCanvas.getBoundingClientRect();
    return {
      x: this.viewBox.x + (clientX - rect.left) / this.zoom,
      y: this.viewBox.y + (clientY - rect.top) / this.zoom,
    };
  }

  getZoom(): number {
    return this.zoom;
  }

  getViewBox(): { x: number; y: number; w: number; h: number } {
    return { ...this.viewBox };
  }

  /**
   * Pan (keeping zoom) so a world-space rect is comfortably in view. No-op if it's
   * already fully visible — so selecting something already on screen never jars the
   * view. If the rect is larger than the viewport on an axis, it's centered on that
   * axis. Used to reveal an off-screen frame/shape selected from the Layers panel,
   * and to bring freshly-pasted frames into view.
   */
  revealBounds(b: { x: number; y: number; w: number; h: number }): void {
    const vb = this.viewBox;
    const pad = 48 / this.zoom; // keep a comfortable margin, in world units
    let nx = vb.x, ny = vb.y;

    if (b.w + pad * 2 <= vb.w) {
      if (b.x < vb.x + pad) nx = b.x - pad;
      else if (b.x + b.w > vb.x + vb.w - pad) nx = b.x + b.w - vb.w + pad;
    } else {
      nx = b.x + b.w / 2 - vb.w / 2; // too wide to fit → center on x
    }
    if (b.h + pad * 2 <= vb.h) {
      if (b.y < vb.y + pad) ny = b.y - pad;
      else if (b.y + b.h > vb.y + vb.h - pad) ny = b.y + b.h - vb.h + pad;
    } else {
      ny = b.y + b.h / 2 - vb.h / 2; // too tall to fit → center on y
    }

    if (nx !== vb.x || ny !== vb.y) {
      this.viewBox.x = nx;
      this.viewBox.y = ny;
      this.updateViewBox();
      this.notifyViewChange();
    }
  }

  initSize(centerOn?: { x: number; y: number; w: number; h: number }): void {
    const rect = this.svgCanvas.getBoundingClientRect();
    this.viewBox.w = rect.width / this.zoom;
    this.viewBox.h = rect.height / this.zoom;
    const cx = centerOn?.x ?? 0;
    const cy = centerOn?.y ?? 0;
    const cw = centerOn?.w ?? 960;
    const ch = centerOn?.h ?? 540;
    this.viewBox.x = cx + (cw - this.viewBox.w) / 2;
    this.viewBox.y = cy + (ch - this.viewBox.h) / 2;
    this.updateViewBox();
    this.notifyViewChange();
  }
}
