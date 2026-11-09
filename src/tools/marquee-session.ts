import type { Point, ShapeData } from '../core/types';
import { localBBoxInLayer } from '../core/coords';
import { createMarqueeRect } from '../ui/overlay-chrome';

export interface MarqueeHost {
  svgCanvas: SVGSVGElement;
  shapes(): ShapeData[];
  selection(): string[];
  selectMultiple(ids: string[]): void;
}

/** Rubber-band chrome and selection hit testing in drawing-layer coordinates. */
export class MarqueeSession {
  private readonly host: MarqueeHost;
  active = false;
  private marqueeStart: Point = { x: 0, y: 0 };
  private marqueeRect: SVGRectElement | null = null;

  constructor(host: MarqueeHost) { this.host = host; }

  begin(pt: Point): void {
    this.active = true;
    this.marqueeStart = { ...pt };
    this.createMarqueeRect(pt);
  }

  update(pt: Point): void { this.updateMarqueeRect(pt); }

  finish(pt: Point, additive: boolean): void {
    this.finishMarquee(pt, additive);
    this.active = false;
    this.removeMarqueeRect();
  }

  // ---- Marquee helpers ----

  private createMarqueeRect(pt: Point): void {
    const selLayer = this.host.svgCanvas.querySelector('#selection-layer') as SVGGElement;
    if (!selLayer) return;
    // Shared constant-size chrome (non-scaling stroke + dashes) — see ui/overlay-chrome.
    const rect = createMarqueeRect();
    rect.setAttribute('x', String(pt.x));
    rect.setAttribute('y', String(pt.y));
    rect.setAttribute('width', '0');
    rect.setAttribute('height', '0');
    selLayer.appendChild(rect);
    this.marqueeRect = rect;
  }

  private updateMarqueeRect(pt: Point): void {
    if (!this.marqueeRect) return;
    const x = Math.min(pt.x, this.marqueeStart.x);
    const y = Math.min(pt.y, this.marqueeStart.y);
    const w = Math.abs(pt.x - this.marqueeStart.x);
    const h = Math.abs(pt.y - this.marqueeStart.y);
    this.marqueeRect.setAttribute('x', String(x));
    this.marqueeRect.setAttribute('y', String(y));
    this.marqueeRect.setAttribute('width', String(w));
    this.marqueeRect.setAttribute('height', String(h));
  }

  private removeMarqueeRect(): void {
    this.marqueeRect?.remove();
    this.marqueeRect = null;
  }

  private finishMarquee(pt: Point, additive: boolean): void {
    const mx = Math.min(pt.x, this.marqueeStart.x);
    const my = Math.min(pt.y, this.marqueeStart.y);
    const mw = Math.abs(pt.x - this.marqueeStart.x);
    const mh = Math.abs(pt.y - this.marqueeStart.y);

    // Minimum drag distance to count as marquee (not accidental click)
    if (mw < 3 && mh < 3) return;

    // Candidates: frames are transparent containers — a marquee selects the shapes
    // INSIDE a frame, never the frame itself (else any drag touching the big frame
    // grabs it and you can't rubber-band its contents). Recurse through frames;
    // treat everything else (groups/booleans/leaves) as a selectable unit.
    const collect = (shapes: ShapeData[]): ShapeData[] => {
      const out: ShapeData[] = [];
      for (const s of shapes) {
        if (s.type === 'frame') { if (s.children) out.push(...collect(s.children)); }
        else out.push(s);
      }
      return out;
    };

    const hitIds: string[] = [];
    for (const shape of collect(this.host.shapes())) {
      if (!shape.visible || shape.locked) continue;
      // World-space bbox (marquee coords are drawing-layer space via screenToSVG),
      // so it's correct for shapes nested/transformed inside frames.
      const bb = localBBoxInLayer(this.host.svgCanvas, shape.element);
      if (bb && this.rectsIntersect(mx, my, mw, mh, bb.x, bb.y, bb.width, bb.height)) {
        hitIds.push(shape.id);
      }
    }

    if (hitIds.length === 0) return;

    if (additive) {
      // Shift+marquee: add to existing selection
      const combined = new Set([...this.host.selection(), ...hitIds]);
      this.host.selectMultiple([...combined]);
    } else {
      this.host.selectMultiple(hitIds);
    }
  }

  private rectsIntersect(
    ax: number, ay: number, aw: number, ah: number,
    bx: number, by: number, bw: number, bh: number,
  ): boolean {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

}
