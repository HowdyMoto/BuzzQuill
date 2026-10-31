import { BaseTool } from './base';
import type { Point } from '../core/types';

export class HandTool extends BaseTool {
  name = 'hand';
  private panning = false;

  activate(): void {
    this.svgCanvas.style.cursor = 'grab';
  }

  deactivate(): void {
    this.svgCanvas.style.cursor = '';
  }

  onMouseDown(_pt: Point, e: MouseEvent): void {
    this.panning = true;
    this.canvas.startPan(e.clientX, e.clientY);
    this.svgCanvas.style.cursor = 'grabbing';
  }

  onMouseMove(_pt: Point, _e: MouseEvent): void {}

  onMouseUp(_pt: Point, _e: MouseEvent): void {
    if (this.panning) {
      this.panning = false;
      this.canvas.endPan();
      this.svgCanvas.style.cursor = 'grab';
    }
  }
}
