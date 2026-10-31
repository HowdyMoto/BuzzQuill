import { BaseTool } from './base';
import type { Point } from '../core/types';
import { ensureBooleanEngine, computeBoolean } from '../core/boolean';
import { refreshToolHint } from '../ui/tool-hint';

/**
 * Shape Builder — the interactive Pathfinder. With 2+ overlapping shapes selected,
 * switching to this tool decomposes them into their arrangement faces (via the
 * boolean divide engine) shown as an overlay. Then:
 *   - drag across faces to MERGE them into one shape,
 *   - Alt/Option-click a face to DELETE it,
 *   - Enter/Return to commit, Escape to cancel (and return to Select).
 * Untouched faces each become their own shape on commit. Switching tools also
 * commits any pending edits. It's a session over a live overlay, so nothing is
 * destroyed until you commit — matching the quality bar of the other features.
 */

interface Face {
  d: string;
  el: SVGPathElement;
  group: number;   // 0 = ungrouped (its own shape), >0 = merge group
  deleted: boolean;
}

// Distinct, readable fills for merge groups (cycled).
const GROUP_COLORS = ['#2d7ff9', '#e67e22', '#16a085', '#9b59b6', '#e74c3c', '#f1c40f'];

export class ShapeBuilderTool extends BaseTool {
  name = 'shapeBuilder';

  private layer: SVGGElement | null = null;
  private faces: Face[] = [];
  private originalIds: string[] = [];
  private groupCounter = 0;
  private hoverIdx = -1;
  private dragging = false;
  private dragDelete = false;
  private dragGroup = 0;

  activate(): void {
    // Busy from the first render: the tool-hint strip reads the flag (see build).
    this.svgCanvas.querySelector('#shapebuilder-layer')?.setAttribute('data-busy', '');
    void this.build();
  }

  deactivate(): void {
    // Switching away commits pending edits (Illustrator-style); a pristine session
    // just tears down with no change.
    if (this.hasEdits()) this.commit(false);
    else this.cleanup();
  }

  onMouseDown(pt: Point, e: MouseEvent): void {
    const i = this.faceAt(pt);
    if (i < 0) return;
    this.dragging = true;
    this.dragDelete = e.altKey;
    if (this.dragDelete) {
      this.faces[i].deleted = true;
      this.faces[i].group = 0;
    } else {
      this.dragGroup = ++this.groupCounter;
      this.assign(i);
    }
    this.render();
  }

  onMouseMove(pt: Point, _e: MouseEvent): void {
    if (this.dragging) {
      const i = this.faceAt(pt);
      if (i >= 0) {
        if (this.dragDelete) { this.faces[i].deleted = true; this.faces[i].group = 0; }
        else this.assign(i);
        this.render();
      }
      return;
    }
    const i = this.faceAt(pt);
    if (i !== this.hoverIdx) { this.hoverIdx = i; this.render(); }
  }

  onMouseUp(_pt: Point, _e: MouseEvent): void {
    this.dragging = false;
  }

  onKeyDown(e: KeyboardEvent): void {
    // Esc always leaves — with no faces too, which is exactly when a lost user presses it.
    if (e.key === 'Escape') { e.preventDefault(); this.cleanup(); this.state.requestTool?.('select'); return; }
    if (!this.faces.length) return;
    if (e.key === 'Enter') { e.preventDefault(); this.commit(true); }
  }

  // ---- Session lifecycle ----

  private async build(): Promise<void> {
    this.cleanup();
    this.layer = this.svgCanvas.querySelector('#shapebuilder-layer');
    // The faces arrive async (engine warm-up + divide). The tool-hint strip reads
    // this layer: busy → say nothing yet; faces → the drag/Alt/Enter hints; empty →
    // "select 2+ overlapping shapes first". Refresh it when the answer lands, since
    // no state change carries that.
    this.layer?.setAttribute('data-busy', '');
    try {
      await ensureBooleanEngine();
      const res = await this.state.selectionFaces();
      if (!res || !this.layer) return; // needs 2+ overlapping shapes
      this.originalIds = res.ids;
      this.groupCounter = 0;
      this.layer.innerHTML = '';
      this.faces = res.faces.map((d) => {
        const el = document.createElementNS(this.NS, 'path') as SVGPathElement;
        el.setAttribute('d', d);
        this.layer!.appendChild(el);
        return { d, el, group: 0, deleted: false };
      });
      this.render();
    } finally {
      this.layer?.removeAttribute('data-busy');
      refreshToolHint();
    }
  }

  private hasEdits(): boolean {
    return this.faces.some((f) => f.group > 0 || f.deleted);
  }

  private assign(i: number): void {
    this.faces[i].group = this.dragGroup;
    this.faces[i].deleted = false;
  }

  /** Index of the (disjoint) face under the pointer, or -1. */
  private faceAt(pt: Point): number {
    const p = new DOMPoint(pt.x, pt.y);
    for (let i = 0; i < this.faces.length; i++) {
      const el = this.faces[i].el as unknown as SVGGeometryElement;
      try { if (el.isPointInFill(p)) return i; } catch { /* not rendered */ }
    }
    return -1;
  }

  private render(): void {
    for (let i = 0; i < this.faces.length; i++) {
      const f = this.faces[i];
      const el = f.el;
      const hovered = i === this.hoverIdx;
      if (f.deleted) {
        el.setAttribute('fill', 'rgba(231,76,60,0.14)');
        el.setAttribute('stroke', '#e74c3c');
        el.setAttribute('stroke-dasharray', '4 3');
      } else if (f.group > 0) {
        const c = GROUP_COLORS[(f.group - 1) % GROUP_COLORS.length];
        el.setAttribute('fill', c);
        el.setAttribute('fill-opacity', hovered ? '0.45' : '0.3');
        el.setAttribute('stroke', c);
        el.removeAttribute('stroke-dasharray');
      } else {
        el.setAttribute('fill', hovered ? 'rgba(45,127,249,0.22)' : 'rgba(120,120,120,0.04)');
        el.setAttribute('fill-opacity', '1');
        el.setAttribute('stroke', hovered ? '#2d7ff9' : 'rgba(150,150,150,0.7)');
        el.removeAttribute('stroke-dasharray');
      }
      el.setAttribute('stroke-width', '1');
      el.setAttribute('vector-effect', 'non-scaling-stroke');
      el.setAttribute('fill-rule', 'evenodd');
    }
  }

  private commit(rebuild: boolean): void {
    if (!this.faces.length) { this.cleanup(); return; }
    const groups = new Map<number, string[]>();
    const standalone: string[] = [];
    for (const f of this.faces) {
      if (f.deleted) continue;
      if (f.group > 0) {
        const list = groups.get(f.group) ?? [];
        list.push(f.d);
        groups.set(f.group, list);
      } else {
        standalone.push(f.d);
      }
    }
    const resultDs: string[] = [...standalone];
    for (const ds of groups.values()) {
      resultDs.push(...(ds.length === 1 ? ds : computeBoolean(ds, 'unite')));
    }

    const originalIds = this.originalIds;
    const fill = this.originalFill();
    this.cleanup();
    if (resultDs.length) this.state.replaceShapesWithPaths(originalIds, resultDs, fill);
    if (rebuild) void this.build();
  }

  private originalFill(): string {
    for (const id of this.originalIds) {
      const f = this.state.findShapeById(id)?.element.getAttribute('fill');
      if (f && f !== 'none') return f;
    }
    return '#cccccc';
  }

  private cleanup(): void {
    if (this.layer) this.layer.innerHTML = '';
    this.faces = [];
    this.originalIds = [];
    this.hoverIdx = -1;
    this.dragging = false;
    this.groupCounter = 0;
    refreshToolHint(); // the faces are gone — back to "select 2+ shapes first"
  }
}
