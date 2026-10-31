import { BaseTool } from './base';
import type { Point } from '../core/types';

export class ZoomTool extends BaseTool {
  name = 'zoom';

  activate(): void {
    this.svgCanvas.style.cursor = 'zoom-in';
  }

  deactivate(): void {
    this.svgCanvas.style.cursor = '';
  }

  onMouseDown(_pt: Point, e: MouseEvent): void {
    const currentZoom = this.canvas.getZoom();
    if (e.altKey) {
      this.svgCanvas.style.cursor = 'zoom-out';
      this.canvas.setZoom(currentZoom / 1.5, { x: e.clientX, y: e.clientY });
    } else {
      this.svgCanvas.style.cursor = 'zoom-in';
      this.canvas.setZoom(currentZoom * 1.5, { x: e.clientX, y: e.clientY });
    }
  }

  onMouseMove(_pt: Point, _e: MouseEvent): void {}
  onMouseUp(_pt: Point, _e: MouseEvent): void {}
}
