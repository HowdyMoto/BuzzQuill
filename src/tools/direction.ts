import { BaseTool } from './base';
import type { Point } from '../core/types';
import { refreshToolHint } from '../ui/tool-hint';
import {
  showAllDirections, hideAllDirections, pickDirection, setHoveredDirection, reverseWithFlourish,
} from '../ui/direction-overlay';

/**
 * Direction — see which way every path runs, and turn one around with a click.
 *
 * The point order of a path is invisible, so the tool's whole job is to make it
 * visible: while it's active the overlay runs chevrons along every path, from a start
 * marker to an end marker. Picking is deliberately forgiving (a click near a line
 * counts, and a click on a filled shape counts), and goes through the overlay's list
 * of unlocked shapes, so a locked path can't be flipped.
 *
 * A press never changes the selection: this tool edits what's under the pointer, and
 * going through a long list of paths shouldn't keep re-pointing the panels.
 */
export class DirectionTool extends BaseTool {
  name = 'direction';

  activate(): void {
    showAllDirections();
    refreshToolHint();
  }

  deactivate(): void {
    hideAllDirections();
    this.svgCanvas.style.cursor = '';
  }

  onMouseDown(pt: Point, e: MouseEvent): void {
    const id = pickDirection(pt, this.unlockedTarget(e.target as SVGElement, e));
    if (id) reverseWithFlourish(this.state, [id]);
  }

  onMouseMove(pt: Point, e: MouseEvent): void {
    const id = pickDirection(pt, this.unlockedTarget(e.target as SVGElement, e));
    this.svgCanvas.style.cursor = id ? 'pointer' : '';
    if (setHoveredDirection(id)) refreshToolHint();
  }

  onMouseUp(_pt: Point, _e: MouseEvent): void { /* a press does it all */ }

  onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); this.state.requestTool?.('select'); }
  }
}
