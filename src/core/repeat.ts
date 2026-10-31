// ---------------------------------------------------------------------------
// Repeat grid (issue #111) — repeat a CELL of objects into a rows × cols
// pattern whose instances follow every edit to the originals.
//
// A pattern is a `<g data-repeat>` wrapper that behaves like a group: every
// ordinary child is part of the repeated cell. It holds:
//   • the ORIGINAL cell children — they keep their ids and are modeled as real
//     children (like frame children), so every existing tool (move, node edit,
//     panels, appearance) edits them natively, and shapes can be dragged in or
//     out via the Layers panel like any group; and
//   • generated `<g data-repeat-clone>` instances at translate(col·stepX,
//     row·stepY), each holding id-less copies of the cell — regenerated cache
//     that rebuildShapesFromDOM never models, round-tripping through the
//     history/innerHTML snapshot for free.
//
// (Older documents marked their single source with `data-repeat-src`; the attr
// is ignored now — "not a clone" is what makes a child part of the cell — and
// stripped opportunistically.)
//
// syncAll() re-clones whenever the cell markup (or the config) changes — called
// once per render frame with a fast-path guard, mirroring
// refreshStrokeAlignClips. Config lives in data-repeat-* attributes so it
// survives the snapshot. Bake (destructive) promotes the instances to real
// shapes in a plain group; Release keeps just the originals.
// ---------------------------------------------------------------------------

import { movePreservingWorld } from './coords';
import type { ShapeData } from './types';
import { foldsCleanly, foldOnto } from './wrapper-attrs';

const SVG = 'http://www.w3.org/2000/svg';

export interface RepeatConfig {
  cols: number;
  rows: number;
  gapX: number;
  gapY: number;
}

export const REPEAT_ATTRS = ['data-repeat', 'data-repeat-cols', 'data-repeat-rows', 'data-repeat-gap-x', 'data-repeat-gap-y'];
const MAX_PER_AXIS = 100;

export interface RepeatHost {
  findShape(id: string): ShapeData | null;
  getDrawingLayer(): SVGGElement;
  nextId(): string;
  rebuild(): void;
  setSelection(ids: string[]): void;
  saveHistory(): void;
  onChange(): void;
}

const clampCount = (v: number, dflt: number): number =>
  Math.min(MAX_PER_AXIS, Math.max(1, Math.round(Number.isFinite(v) ? v : dflt)));

export class RepeatManager {
  private host: RepeatHost;
  // Last-regenerated fingerprint per wrapper (source markup + config), so the
  // per-frame sync is a no-op unless something actually changed. WeakMap keys die
  // with the elements, so history swaps (fresh elements) regenerate naturally.
  private fingerprints = new WeakMap<Element, string>();

  constructor(host: RepeatHost) { this.host = host; }

  /** A wrapper's grid config (attrs are the source of truth). */
  config(el: SVGElement): RepeatConfig {
    return {
      cols: clampCount(parseFloat(el.getAttribute('data-repeat-cols') ?? '3'), 3),
      rows: clampCount(parseFloat(el.getAttribute('data-repeat-rows') ?? '1'), 1),
      gapX: parseFloat(el.getAttribute('data-repeat-gap-x') ?? '20') || 0,
      gapY: parseFloat(el.getAttribute('data-repeat-gap-y') ?? '20') || 0,
    };
  }

  /** Wrap one or more shapes into a repeat grid whose cell is ALL of them (one
   *  undo step); returns the wrapper id. The wrapper takes the topmost shape's
   *  slot; shapes pulled in from other parents keep their on-screen position. */
  create(ids: string | string[], cfg: Partial<RepeatConfig> = {}): string | null {
    const idList = Array.isArray(ids) ? ids : [ids];
    const shapes = idList.map((id) => this.host.findShape(id)).filter((s): s is ShapeData => !!s);
    if (!shapes.length || shapes.length !== idList.length) return null;
    for (const s of shapes) {
      // Frames are top-level-only; a repeat inside a repeat is not supported —
      // neither a repeat (or repeat-carrying group) as cell content, nor
      // creating a grid from shapes already inside one.
      if (s.type === 'frame' || s.type === 'repeat') return null;
      if (s.element.querySelector('[data-repeat]')) return null;
      if (s.element.parentElement?.closest('[data-repeat]')) return null;
    }
    // Bottom-to-top DOM order, so the cell stacks exactly like the selection did.
    const els = shapes.map((s) => s.element).sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const topmost = els[els.length - 1];
    const parent = topmost.parentNode;
    if (!parent) return null;

    const g = document.createElementNS(SVG, 'g');
    g.id = this.host.nextId();
    g.setAttribute('data-repeat', '1');
    const full: RepeatConfig = { cols: 3, rows: 1, gapX: 20, gapY: 20, ...cfg };
    this.writeConfig(g, full);
    g.setAttribute('data-name', shapes.length === 1 ? `${shapes[0].name} pattern` : `Pattern ${g.id.replace('shape-', '#')}`);
    parent.insertBefore(g, topmost); // take the topmost shape's slot in the stack

    for (const el of els) {
      // Reparenting from elsewhere (another group/frame) bakes the coordinate
      // change into the element's transform so it doesn't jump on screen; a
      // same-space move keeps the authored transform untouched.
      movePreservingWorld(el, g);
    }
    this.regenerate(g);
    this.host.rebuild();
    this.host.setSelection([g.id]);
    this.host.saveHistory();
    this.host.onChange();
    return g.id;
  }

  /** Update a wrapper's grid config (live when record=false, one undo step when true). */
  setConfig(id: string, cfg: RepeatConfig, record = true): void {
    const shape = this.host.findShape(id);
    if (!shape || shape.type !== 'repeat') return;
    this.writeConfig(shape.element, cfg);
    this.regenerate(shape.element);
    if (record) this.host.saveHistory();
    this.host.onChange();
  }

  /** Keep just the original cell (the pattern's instances are discarded): a
   *  single-shape cell unwraps back to the bare shape; a multi-shape cell (or one
   *  under a clipped or effected pattern) keeps the wrapper as a plain group. */
  release(id: string): void {
    const shape = this.host.findShape(id);
    if (shape?.type !== 'repeat') return;
    const g = shape.element;
    const cell = this.cellChildren(g);
    if (!cell.length) return;
    g.querySelectorAll(':scope > [data-repeat-clone]').forEach((c) => c.remove());
    cell.forEach((c) => c.removeAttribute('data-repeat-src')); // legacy marker
    let selectId: string;
    // A lone cell takes over what the wrapper carried — its transform (from moving
    // the pattern), opacity, blend, lock, links — which unwrapping used to drop. A
    // clip or effect on the pattern is defined in the WRAPPER's space, so when the
    // cell doesn't share it the wrapper stays, as a plain group.
    if (cell.length === 1 && foldsCleanly(g, cell[0])) {
      const src = cell[0];
      foldOnto(g, src);
      g.replaceWith(src);
      selectId = src.id;
    } else {
      for (const a of REPEAT_ATTRS) g.removeAttribute(a);
      g.setAttribute('data-name', (g.getAttribute('data-name') ?? 'pattern').replace(/\s*pattern$/i, ' group').replace(/^Pattern /, 'Group '));
      selectId = g.id; // now a plain group holding the cell
    }
    this.host.rebuild();
    this.host.setSelection([selectId]);
    this.host.saveHistory();
    this.host.onChange();
  }

  /** Bake the pattern: instances become real shapes and the wrapper becomes a
   *  plain group — fully destructive, everything individually editable after.
   *  A single-shape cell's instances unwrap to bare shapes (composing the
   *  instance offset into their transform); a multi-shape cell yields one real
   *  group per instance, and the original cell is grouped to match. */
  bake(id: string): void {
    const shape = this.host.findShape(id);
    if (shape?.type !== 'repeat') return;
    const g = shape.element;
    this.regenerate(g); // make sure the instances match the cell's latest state
    const cell = this.cellChildren(g);
    const single = cell.length === 1;
    const baseName = single
      ? (cell[0].getAttribute('data-name') ?? 'shape').replace(/\s+\d+$/, '')
      : (g.getAttribute('data-name') ?? 'pattern').replace(/\s*pattern$/i, '').trim() || 'cell';
    let n = 2;
    g.querySelectorAll(':scope > [data-repeat-clone]').forEach((instEl) => {
      const inst = instEl as SVGElement;
      inst.removeAttribute('data-repeat-clone');
      if (single && inst.children.length === 1) {
        // Unwrap: promote the lone copy, folding the instance offset into it.
        const copy = inst.firstElementChild as SVGElement;
        const it = inst.getAttribute('transform');
        if (it) {
          const ct = copy.getAttribute('transform');
          copy.setAttribute('transform', ct ? `${it} ${ct}` : it);
        }
        copy.id = this.host.nextId();
        copy.setAttribute('data-name', `${baseName} ${n++}`);
        inst.replaceWith(copy);
      } else {
        inst.id = this.host.nextId();
        inst.setAttribute('data-name', `${baseName} ${n++}`);
      }
    });
    if (!single) {
      // Group the original cell too, so every instance has the same shape.
      const wrap = document.createElementNS(SVG, 'g');
      wrap.id = this.host.nextId();
      wrap.setAttribute('data-name', `${baseName} 1`);
      g.insertBefore(wrap, cell[0]);
      for (const c of cell) wrap.appendChild(c);
    }
    cell.forEach((c) => c.removeAttribute('data-repeat-src')); // legacy marker
    for (const a of REPEAT_ATTRS) g.removeAttribute(a);
    g.setAttribute('data-name', (g.getAttribute('data-name') ?? 'pattern').replace(/\s*pattern$/i, ' group').replace(/^Pattern /, 'Group '));
    this.host.rebuild(); // now a plain group with real children
    this.host.setSelection([id]);
    this.host.saveHistory();
    this.host.onChange();
  }

  /** The cell = every ordinary child (instances carry data-repeat-clone). */
  private cellChildren(g: SVGElement): SVGElement[] {
    return Array.from(g.children).filter((c) => !c.hasAttribute('data-repeat-clone')) as SVGElement[];
  }

  private fingerprintOf(cfg: RepeatConfig, cell: SVGElement[]): string {
    return `${cfg.cols}|${cfg.rows}|${cfg.gapX}|${cfg.gapY}|${cell.map((c) => c.outerHTML).join('')}`;
  }

  /** Re-clone every pattern whose cell markup or config changed since the last
   *  pass. Cheap when nothing changed (one querySelectorAll + string compares);
   *  called once per render frame, like refreshStrokeAlignClips. */
  syncAll(): void {
    const wrappers = this.host.getDrawingLayer().querySelectorAll(':scope g[data-repeat], :scope [data-repeat]');
    wrappers.forEach((w) => {
      const g = w as SVGElement;
      const fp = this.fingerprintOf(this.config(g), this.cellChildren(g));
      if (this.fingerprints.get(g) === fp) return;
      this.regenerate(g, fp);
    });
  }

  /** Rebuild the wrapper's `<g data-repeat-clone>` instances from its cell. */
  private regenerate(g: SVGElement, fingerprint?: string): void {
    const cell = this.cellChildren(g);
    const cfg = this.config(g);
    g.querySelectorAll(':scope > [data-repeat-clone]').forEach(c => c.remove());
    if (!cell.length) { // emptied via the Layers panel — nothing left to repeat
      this.fingerprints.set(g, this.fingerprintOf(cfg, cell));
      return;
    }
    const box = this.cellBox(cell);
    const stepX = (box?.width ?? 0) + cfg.gapX;
    const stepY = (box?.height ?? 0) + cfg.gapY;
    for (let row = 0; row < cfg.rows; row++) {
      for (let col = 0; col < cfg.cols; col++) {
        if (row === 0 && col === 0) continue; // the cell IS instance (0,0)
        const inst = document.createElementNS(SVG, 'g');
        inst.setAttribute('data-repeat-clone', '');
        inst.setAttribute('transform', `translate(${col * stepX}, ${row * stepY})`);
        for (const src of cell) {
          const clone = src.cloneNode(true) as SVGElement;
          clone.removeAttribute('data-repeat-src');
          clone.removeAttribute('id');
          clone.removeAttribute('data-name');
          clone.querySelectorAll('[id]').forEach(d => d.removeAttribute('id'));
          clone.querySelectorAll('[data-name]').forEach(d => d.removeAttribute('data-name'));
          inst.appendChild(clone);
        }
        g.appendChild(inst);
      }
    }
    this.fingerprints.set(g, fingerprint ?? this.fingerprintOf(cfg, cell));
  }

  /** The cell's union bbox in WRAPPER space: each child's local bbox mapped
   *  through its own transform (corner-mapped — exact for translate/scale, hull
   *  for rotation), unioned across the cell. */
  private cellBox(cell: SVGElement[]): { width: number; height: number } | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of cell) {
      let bb: DOMRect;
      try { bb = (el as unknown as SVGGraphicsElement).getBBox(); } catch { continue; }
      const list = (el as unknown as SVGGraphicsElement).transform?.baseVal;
      const m = list && list.numberOfItems ? list.consolidate()?.matrix : null;
      const corners: [number, number][] = [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]];
      for (const [px, py] of corners) {
        const x = m ? m.a * px + m.c * py + m.e : px;
        const y = m ? m.b * px + m.d * py + m.f : py;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    return maxX >= minX ? { width: maxX - minX, height: maxY - minY } : null;
  }

  private writeConfig(g: SVGElement, cfg: RepeatConfig): void {
    g.setAttribute('data-repeat-cols', String(clampCount(cfg.cols, 3)));
    g.setAttribute('data-repeat-rows', String(clampCount(cfg.rows, 1)));
    g.setAttribute('data-repeat-gap-x', String(Number.isFinite(cfg.gapX) ? cfg.gapX : 20));
    g.setAttribute('data-repeat-gap-y', String(Number.isFinite(cfg.gapY) ? cfg.gapY : 20));
  }
}
