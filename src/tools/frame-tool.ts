import { tokens } from '../ui/tokens';
import { markNonScalingStroke } from '../ui/overlay-chrome';
import { openFrameRename } from '../ui/frame-renderer';
import { BaseTool } from './base';
import type { Point, Artboard } from '../core/types';

export class FrameTool extends BaseTool {
  name = 'frame';
  private mode: 'idle' | 'creating' | 'moving' | 'resizing' = 'idle';
  private startPt: Point = { x: 0, y: 0 };
  private previewEl: SVGRectElement | null = null;
  // Moving
  private movingAb: Artboard | null = null;
  private moveOrigX = 0;
  private moveOrigY = 0;
  // Resizing
  private resizingAb: Artboard | null = null;
  private resizeHandle = '';
  private resizeOrigRect = { x: 0, y: 0, w: 0, h: 0 };

  activate(): void {
    this.svgCanvas.style.cursor = 'crosshair';
    // Highlight artboards with editable borders
    this.state.selectedFrameId = this.state.activeFrameId;
    this.state.onChange_public();
  }

  deactivate(): void {
    this.svgCanvas.style.cursor = '';
    this.state.selectedFrameId = null;
    this.cleanup();
    this.state.onChange_public();
  }

  onDoubleClick(_pt: Point, e: MouseEvent): void {
    // Double-clicking a frame's name label renames it in place (same as Select).
    const label = (e.target as Element).closest?.('[data-frame-select]') as SVGElement | null;
    if (label) openFrameRename(this.state, this.svgCanvas, label.getAttribute('data-frame-select')!);
  }

  onMouseDown(pt: Point, e: MouseEvent): void {
    // Check if clicking on an artboard resize handle
    const handle = (e.target as SVGElement).getAttribute?.('data-ab-handle');
    const abId = (e.target as SVGElement).getAttribute?.('data-ab-id');
    if (handle && abId) {
      const ab = this.state.getArtboardById(abId);
      if (ab) {
        this.mode = 'resizing';
        this.state.setInteractive(true);
        this.resizingAb = ab;
        this.resizeHandle = handle;
        this.resizeOrigRect = { x: ab.x, y: ab.y, w: ab.width, h: ab.height };
        this.startPt = { ...pt };
        return;
      }
    }

    // Check if clicking inside an existing artboard
    const clickedAb = this.findArtboardAt(pt);
    if (clickedAb) {
      this.state.selectedFrameId = clickedAb.id;
      this.state.setActiveArtboard(clickedAb.id);
      this.mode = 'moving';
      this.state.setInteractive(true);
      this.movingAb = clickedAb;
      this.moveOrigX = clickedAb.x;
      this.moveOrigY = clickedAb.y;
      this.startPt = { ...pt };
      this.svgCanvas.style.cursor = 'move';
      return;
    }

    // Creating a new artboard
    this.mode = 'creating';
    this.startPt = { ...pt };
    const rect = document.createElementNS(this.NS, 'rect') as SVGRectElement;
    rect.setAttribute('x', String(pt.x));
    rect.setAttribute('y', String(pt.y));
    rect.setAttribute('width', '0');
    rect.setAttribute('height', '0');
    rect.setAttribute('fill', 'rgba(255,255,255,0.5)');
    rect.setAttribute('stroke', tokens.selectionAccent);
    rect.setAttribute('stroke-width', '1');
    rect.setAttribute('stroke-dasharray', '5,3');
    markNonScalingStroke(rect); // constant-width preview border at any zoom (see ui/overlay-chrome)
    const guidesLayer = this.svgCanvas.querySelector('#guides-layer')!;
    guidesLayer.appendChild(rect);
    this.previewEl = rect;
  }

  onMouseMove(pt: Point, _e: MouseEvent): void {
    if (this.mode === 'creating' && this.previewEl) {
      const x = Math.min(pt.x, this.startPt.x);
      const y = Math.min(pt.y, this.startPt.y);
      const w = Math.abs(pt.x - this.startPt.x);
      const h = Math.abs(pt.y - this.startPt.y);
      this.previewEl.setAttribute('x', String(x));
      this.previewEl.setAttribute('y', String(y));
      this.previewEl.setAttribute('width', String(w));
      this.previewEl.setAttribute('height', String(h));
    } else if (this.mode === 'moving' && this.movingAb) {
      const dx = pt.x - this.startPt.x;
      const dy = pt.y - this.startPt.y;
      // Moving a frame moves its contents (they live inside its <g>).
      this.state.updateArtboard(this.movingAb.id, {
        x: Math.round(this.moveOrigX + dx),
        y: Math.round(this.moveOrigY + dy),
      });
    } else if (this.mode === 'resizing' && this.resizingAb) {
      const dx = pt.x - this.startPt.x;
      const dy = pt.y - this.startPt.y;
      const orig = this.resizeOrigRect;
      let x = orig.x, y = orig.y, w = orig.w, h = orig.h;
      if (this.resizeHandle.includes('e')) w += dx;
      if (this.resizeHandle.includes('w')) { x += dx; w -= dx; }
      if (this.resizeHandle.includes('s')) h += dy;
      if (this.resizeHandle.includes('n')) { y += dy; h -= dy; }
      if (w < 20) w = 20;
      if (h < 20) h = 20;
      this.state.updateArtboard(this.resizingAb.id, {
        x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h),
      }, { keepChildrenFixed: true }); // resizing must not drag content along
    }
  }

  onMouseUp(_pt: Point, _e: MouseEvent): void {
    if (this.mode === 'creating' && this.previewEl) {
      const w = parseFloat(this.previewEl.getAttribute('width') ?? '0');
      const h = parseFloat(this.previewEl.getAttribute('height') ?? '0');
      const x = parseFloat(this.previewEl.getAttribute('x') ?? '0');
      const y = parseFloat(this.previewEl.getAttribute('y') ?? '0');
      this.previewEl.remove();
      this.previewEl = null;

      if (w >= 20 && h >= 20) {
        const ab: Artboard = {
          id: '', // ignored — addArtboard/addFrame mints the real shape-N id
          x: Math.round(x), y: Math.round(y),
          width: Math.round(w), height: Math.round(h),
          name: `Frame ${this.state.artboards.length + 1}`,
        };
        // Use the id addFrame actually assigned, not a discarded ab-N.
        this.state.selectedFrameId = this.state.addArtboard(ab);
      }
    } else if (this.mode === 'moving' || this.mode === 'resizing') {
      this.state.saveHistory();
      this.svgCanvas.style.cursor = 'crosshair';
    }
    this.mode = 'idle';
    this.movingAb = null;
    this.resizingAb = null;
    this.state.setInteractive(false); // gesture done — final full render below
    this.state.onChange_public();
  }

  onKeyDown(e: KeyboardEvent): void {
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.state.selectedFrameId) {
      this.state.removeArtboard(this.state.selectedFrameId);
    }
  }

  private findArtboardAt(pt: Point): Artboard | null {
    // Check in reverse so topmost artboard wins
    for (let i = this.state.artboards.length - 1; i >= 0; i--) {
      const ab = this.state.artboards[i];
      if (pt.x >= ab.x && pt.x <= ab.x + ab.width && pt.y >= ab.y && pt.y <= ab.y + ab.height) {
        return ab;
      }
    }
    return null;
  }

  private cleanup(): void {
    if (this.previewEl) {
      this.previewEl.remove();
      this.previewEl = null;
    }
  }
}
