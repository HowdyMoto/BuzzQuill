// ---------------------------------------------------------------------------
// Layer operations — the Layers-panel verbs: show/hide, lock/unlock, z-order
// (up/down/front/back), drag-reorder & drag-to-group, duplicate (incl.
// Figma-style step-and-repeat), and group / ungroup / new empty group (#192).
//
// These manipulate the shape tree, so — unlike the self-contained feature
// collaborators (effects/markers/appearance/width/pathfinder) — this one leans on
// several AppState primitives, surfaced through LayerHost. The step-and-repeat
// state (stepOffset / lastDuplicateIds) lives here since only these methods use it.
// ---------------------------------------------------------------------------

import { movePreservingWorld } from './coords';
import type { ShapeData } from './types';
import { allShapeNames, copyName } from './naming';
import { isModeledShapeEl } from './shape-props';
import { composeOpacity, getBlend, setBlend } from './wrapper-attrs';
import { inheritEffects } from './effects';

export interface LayerHost {
  getShapes(): ShapeData[];
  getSelectedIds(): string[];
  setSelection(ids: string[]): void;
  getDrawingLayer(): SVGGElement;
  findShape(id: string): ShapeData | null;
  nextId(): string;
  offsetElement(el: SVGElement, dx: number, dy: number): void;
  reIdGroupChildren(el: SVGElement): void;
  /** Move an attached copy of a frame into the first free slot beside its source. */
  placePastedFrame(el: SVGElement): void;
  /** The selection, ordered as it appears in the document. */
  selectedInDomOrder(): ShapeData[];
  /** The element that should hold a new group of these shapes. */
  commonParentOf(shapes: ShapeData[]): SVGElement;
  releaseClippingMask(id: string): void;
  /** Leave group isolation if the isolated group no longer exists. */
  clearStaleIsolation(): void;
  rebuild(): void;
  saveHistory(): void;
  onChange(): void;
}

export class LayerManager {
  private host: LayerHost;
  // Figma-style step-and-repeat: the offset a fresh duplicate is nudged by, so
  // repeating ⌘D keeps applying it. Only these methods touch it.
  private stepOffset: { dx: number; dy: number } | null = null;
  private lastDuplicateIds: string[] = [];

  constructor(host: LayerHost) { this.host = host; }

  toggleVisibility(id: string): void {
    const shape = this.host.findShape(id);
    if (!shape) return;
    shape.visible = !shape.visible;
    (shape.element as SVGElement).style.display = shape.visible ? '' : 'none';
    this.host.saveHistory();
    this.host.onChange();
  }

  toggleLock(id: string): void {
    const shape = this.host.findShape(id);
    if (!shape) return;
    shape.locked = !shape.locked;
    // Mirror onto the element so the lock survives history (which snapshots the
    // drawing layer's markup) and round-trips through rebuildShapesFromDOM.
    if (shape.locked) shape.element.setAttribute('data-locked', 'true');
    else shape.element.removeAttribute('data-locked');
    this.host.saveHistory();
    this.host.onChange();
  }

  /** Make every top-level shape visible again. */
  showAll(): void {
    for (const s of this.host.getShapes()) {
      s.visible = true;
      (s.element as SVGElement).style.display = '';
    }
    this.host.saveHistory();
    this.host.onChange();
  }

  /** Unlock every top-level shape. */
  unlockAll(): void {
    for (const s of this.host.getShapes()) {
      s.locked = false;
      s.element.removeAttribute('data-locked');
    }
    this.host.saveHistory();
    this.host.onChange();
  }

  /** Nearest sibling that's a modeled shape (chrome — frame clipPath/.frame-bg,
   *  metadata carriers, generated caches — is skipped; see isModeledShapeEl). */
  private shapeSibling(el: Element, dir: 'prev' | 'next'): SVGElement | null {
    const isShape = (id: string): boolean => !!this.host.findShape(id);
    let sib = dir === 'prev' ? el.previousElementSibling : el.nextElementSibling;
    while (sib && !isModeledShapeEl(sib, isShape)) {
      sib = dir === 'prev' ? sib.previousElementSibling : sib.nextElementSibling;
    }
    return sib as SVGElement | null;
  }

  // Z-order commands swap DOM siblings within the element's REAL parent (frame
  // <g>, group, or the drawing layer) and re-derive the model. The old versions
  // indexed only the top-level shapes array, so they silently no-oped for
  // anything nested inside a frame or group (#213).

  moveShapeUp(id: string): void {
    const el = this.host.findShape(id)?.element as SVGElement | undefined;
    const parent = el?.parentNode;
    if (!el || !parent) return;
    const next = this.shapeSibling(el, 'next');
    if (!next) return; // already topmost among its siblings
    parent.insertBefore(next, el); // next steps below el → el moves up one
    this.host.rebuild();
    this.host.setSelection(this.host.getSelectedIds());
    this.host.saveHistory();
    this.host.onChange();
  }

  moveShapeDown(id: string): void {
    const el = this.host.findShape(id)?.element as SVGElement | undefined;
    const parent = el?.parentNode;
    if (!el || !parent) return;
    const prev = this.shapeSibling(el, 'prev');
    if (!prev) return; // already bottom-most among its siblings
    parent.insertBefore(el, prev);
    this.host.rebuild();
    this.host.setSelection(this.host.getSelectedIds());
    this.host.saveHistory();
    this.host.onChange();
  }

  /**
   * Drag-and-drop reorder/reparent from the Layers panel.
   *
   * The Layers panel lists shapes top-to-bottom in REVERSE paint order (top of the
   * list = top of the z-stack = last in the DOM). `position` is in that visual
   * order: 'before' = above the target in the panel (later in the DOM), 'after' =
   * below it, 'inside' = into the target group. We mutate the live DOM then rebuild
   * the model from it. When the parent changes, the transform is recomputed so the
   * element keeps its on-screen position.
   */
  /** Whether a Layers-panel drag would be a legal drop — mirrors the guards in
   *  moveShape/groupShapes without mutating, so the panel can show live "can't
   *  drop here" feedback (e.g. a frame into another frame). */
  canDrop(draggedId: string, targetId: string, zone: 'before' | 'after' | 'inside' | 'onto', outdentLevels = 0): boolean {
    if (draggedId === targetId) return false;
    const dragged = this.host.findShape(draggedId);
    const target = this.host.findShape(targetId);
    if (!dragged || !target) return false;
    const dEl = dragged.element, tEl = target.element;
    if (dEl === tEl || dEl.contains(tEl)) return false; // never into your own subtree
    // A repeat (or a container carrying one) can never land inside a repeat cell.
    const carriesRepeat = dEl.hasAttribute('data-repeat') || !!dEl.querySelector('[data-repeat]');

    if (zone === 'onto') {
      // Wrap both in a new group — frames are top-level only, so can't be grouped.
      if (tEl.contains(dEl)) return false;
      if (carriesRepeat && tEl.parentElement?.closest('[data-repeat]')) return false;
      return dragged.type !== 'frame' && target.type !== 'frame';
    }
    if (zone === 'inside') {
      if (dragged.type === 'frame') return false; // frames stay top-level
      if (carriesRepeat) return target.type === 'group' && !tEl.closest('[data-repeat]');
      return target.type === 'group' || target.type === 'repeat'; // repeats hold children like groups
    }
    // before / after: a frame may only ever land back at the top level.
    let anchor: Element = tEl;
    if (zone === 'after') {
      const layer = this.host.getDrawingLayer() as unknown as Element;
      for (let i = 0; i < outdentLevels && anchor.parentElement && anchor.parentElement !== layer; i++) {
        anchor = anchor.parentElement;
      }
    }
    if (dragged.type === 'frame' && anchor.parentNode !== this.host.getDrawingLayer()) return false;
    if (carriesRepeat && anchor.parentElement?.closest('[data-repeat]')) return false;
    return !!anchor.parentNode;
  }

  moveShape(draggedId: string, targetId: string, position: 'before' | 'after' | 'inside', outdentLevels = 0): boolean {
    if (draggedId === targetId) return false;
    const dragged = this.host.findShape(draggedId);
    const target = this.host.findShape(targetId);
    if (!dragged || !target) return false;

    const dEl = dragged.element;
    const tEl = target.element;
    // Never drop a group into its own subtree.
    if (dEl === tEl || dEl.contains(tEl)) return false;

    if (dragged.type === 'frame' && position === 'inside') return false;
    // A repeat (or anything carrying one) can't land inside a repeat's cell.
    const carriesRepeat = dEl.hasAttribute('data-repeat') || !!dEl.querySelector('[data-repeat]');

    if (position === 'inside') {
      // Repeat wrappers accept children like groups — the drop joins the cell
      // and every generated instance follows on the next sync.
      if (target.type !== 'group' && target.type !== 'repeat') return false;
      if (carriesRepeat && (target.type === 'repeat' || tEl.closest('[data-repeat]'))) return false;
      movePreservingWorld(dEl, tEl); // top of the group's stack
    } else {
      // For an 'after' drop, walk up `outdentLevels` container levels to choose how
      // deep the item lands — this is what lets a drop at the end of a nested run (or
      // the bottom of the whole list) attach as the group's last child (0 levels) or
      // pop out to a shallower level, up to the root (tree-view convention).
      let anchor: Element = tEl;
      if (position === 'after') {
        const layer = this.host.getDrawingLayer() as unknown as Element;
        for (let i = 0; i < outdentLevels && anchor.parentElement && anchor.parentElement !== layer; i++) {
          anchor = anchor.parentElement;
        }
      }
      // Frames live only at the top level — never nested in a group or another frame.
      if (dragged.type === 'frame' && anchor.parentNode !== this.host.getDrawingLayer()) return false;
      const parent = anchor.parentNode;
      if (!parent) return false;
      // A before/after drop beside a repeat's cell child also lands in the cell.
      if (carriesRepeat && parent instanceof Element && parent.closest('[data-repeat]')) return false;
      // Panel order is reversed vs. the DOM, so 'before' goes after the target.
      if (!(parent instanceof Element)) return false;
      movePreservingWorld(dEl, parent, position === 'before' ? anchor.nextSibling : anchor);
    }

    this.host.rebuild();
    this.host.setSelection([draggedId]);
    this.host.saveHistory();
    this.host.onChange();
    return true;
  }

  /**
   * Wrap `targetId` and every dragged shape in a NEW group at the target's
   * position/parent (dragging layers directly onto another). All keep their
   * on-screen position.
   *
   * Takes a LIST because the panel drags the whole selection: dropping five
   * selected labels onto a rectangle should group all six, not just the row that
   * happened to be grabbed. It used to take a single id, so the rest of the
   * selection was silently dropped on the floor.
   */
  groupShapes(dragged: string | string[], targetId: string): boolean {
    const target = this.host.findShape(targetId);
    if (!target) return false;
    const tEl = target.element;
    // Frames are top-level only, so they can't be wrapped into a new group.
    if (target.type === 'frame') return false;
    const parent = tEl.parentNode;
    if (!parent) return false;

    // Resolve, filter, and order the dragged elements. Document order keeps their
    // relative stacking inside the new group.
    const seen = new Set<string>();
    let els = (Array.isArray(dragged) ? dragged : [dragged])
      .filter(id => id !== targetId && !seen.has(id) && (seen.add(id), true))
      .map(id => this.host.findShape(id))
      .filter((sh): sh is ShapeData => !!sh && sh.type !== 'frame')
      .map(sh => sh.element)
      .filter(el => el !== tEl && !el.contains(tEl) && !tEl.contains(el) && !!el.parentNode);
    // Drop anything already inside another dragged element — it travels with its
    // ancestor, and moving it separately would tear it out of that subtree.
    els = els.filter(el => !els.some(other => other !== el && other.contains(el)));
    if (els.length === 0) return false;
    // Grouping with a shape inside a repeat cell would pull the dragged element
    // into that cell — never nest a repeat inside a repeat.
    if (parent instanceof Element && parent.closest('[data-repeat]')
        && els.some(el => el.hasAttribute('data-repeat') || el.querySelector('[data-repeat]'))) return false;
    els.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const id = this.host.nextId();
    g.id = id;
    g.setAttribute('data-name', 'Group');
    parent.insertBefore(g, tEl); // take the target's slot in the stack
    g.appendChild(tEl);          // target on the bottom (same space as the new group)
    // Dragged shapes stack above it, keeping their own relative order + position.
    for (const el of els) movePreservingWorld(el, g);

    this.host.rebuild();
    this.host.setSelection([id]);
    this.host.saveHistory();
    this.host.onChange();
    return true;
  }

  /** Selected elements in document order, so re-inserting preserves their
   *  relative stacking. */
  private selectedElsInDocOrder(): { ids: string[]; els: SVGElement[] } {
    const ids = this.host.getSelectedIds();
    const els = ids
      .map(i => this.host.findShape(i)?.element as SVGElement | undefined)
      .filter((e): e is SVGElement => !!e && !!e.parentNode);
    els.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    return { ids, els };
  }

  /** Move the selected shapes to the top of the z-order within each one's own
   *  parent (frame / group / drawing layer — see #213). */
  bringToFront(): void {
    const { ids, els } = this.selectedElsInDocOrder();
    if (els.length === 0) return;
    for (const el of els) el.parentNode?.appendChild(el);
    this.host.rebuild();
    this.host.setSelection(ids);
    this.host.saveHistory();
    this.host.onChange();
  }

  /** Move the selected shapes to the bottom of the z-order within each one's own
   *  parent, staying above non-shape chrome (frame-bg, clipPath, metadata). */
  sendToBack(): void {
    const { ids, els } = this.selectedElsInDocOrder();
    if (els.length === 0) return;
    // Reverse document order: each insert lands before the parent's current
    // first shape child, so the last-inserted (front-most in doc order) ends up
    // first and the group keeps its relative order.
    for (const el of [...els].reverse()) {
      const parent = el.parentNode as Element | null;
      if (!parent) continue;
      const isShape = (id: string): boolean => !!this.host.findShape(id);
      let anchor: Element | null = parent.firstElementChild;
      while (anchor && !isModeledShapeEl(anchor, isShape)) anchor = anchor.nextElementSibling;
      if (anchor && anchor !== el) parent.insertBefore(el, anchor);
    }
    this.host.rebuild();
    this.host.setSelection(ids);
    this.host.saveHistory();
    this.host.onChange();
  }

  duplicateShape(id: string): void {
    const newId = this.cloneShapeById(id);
    if (!newId) return;
    this.host.rebuild(); // clone was inserted into the DOM (maybe nested)
    this.host.setSelection([newId]);
    this.host.saveHistory();
    this.host.onChange();
  }

  /**
   * Duplicate the selection in one undo step, Figma-style "step and repeat": the
   * first copy lands exactly on its source, and once you move a fresh duplicate
   * (recorded via notifyMovedSelection), repeating ⌘D keeps applying that offset.
   *
   * In place, not offset: a copy you mean to tweak and keep registered with its
   * source (an alternate layout of the same track, a variant of an icon) has to be
   * dragged back by hand if it lands 10 units away, and bbox snapping can't put a
   * tweaked copy exactly back — its box is no longer the source's box.
   */
  duplicateSelected(): void {
    const ids = [...this.host.getSelectedIds()];
    if (ids.length === 0) return;
    const off = this.stepOffset ?? { dx: 0, dy: 0 };
    const newIds: string[] = [];
    for (const id of ids) {
      const newId = this.cloneShapeById(id, off.dx, off.dy);
      if (newId) newIds.push(newId);
    }
    if (newIds.length === 0) return;
    this.host.rebuild(); // clones inserted into the DOM (maybe nested)
    this.host.setSelection(newIds);
    this.lastDuplicateIds = [...newIds];
    this.stepOffset = off;
    this.host.saveHistory();
    this.host.onChange();
  }

  /**
   * Told by the Select tool when a drag-move finishes. If it moved exactly the
   * shapes produced by the last duplicate, that delta becomes the step-and-repeat
   * offset; any other move breaks the chain so the next ⌘D uses the default.
   */
  notifyMovedSelection(dx: number, dy: number): void {
    const moved = [...this.host.getSelectedIds()].sort().join(',');
    const lastDup = [...this.lastDuplicateIds].sort().join(',');
    if (lastDup && moved === lastDup && (dx !== 0 || dy !== 0)) {
      this.stepOffset = { dx, dy };
    } else {
      this.lastDuplicateIds = [];
      this.stepOffset = null;
    }
  }

  /**
   * Clone a shape into its own parent offset by (dx,dy), returning the new id. Does
   * NOT record history / select / notify — callers batch those so a multi-duplicate
   * is one undo step.
   *
   * A frame copied with no offset doesn't stack on its source — frames don't
   * overlap — it tiles into the first free slot beside it, as a pasted frame does.
   */
  private cloneShapeById(id: string, dx = 0, dy = 0): string | null {
    const shape = this.host.findShape(id); // resolve anywhere in the tree (incl. frames)
    if (!shape) return null;
    const newEl = shape.element.cloneNode(true) as SVGElement;
    const newId = this.host.nextId();
    newEl.id = newId;
    // Re-id descendants so a duplicated container doesn't share child ids with the
    // original (which corrupts findShape / idCounter after a history rebuild).
    this.host.reIdGroupChildren(newEl);
    // The duplicate keeps the source's name with a counter ("Logo" → "Logo 2").
    newEl.setAttribute('data-name', copyName(shape.name, allShapeNames(this.host.getShapes())));
    const parent = (shape.element.parentElement as SVGElement | null) ?? this.host.getDrawingLayer();
    parent.insertBefore(newEl, shape.element.nextSibling);
    // Position AFTER attaching: a path or group moves by its transform, which can't be
    // written while the clone is detached — offsetting first silently did nothing for
    // those, so ⌘D put a path in place but a rect 10 units off.
    if (shape.type === 'frame' && dx === 0 && dy === 0) this.host.placePastedFrame(newEl);
    else if (dx !== 0 || dy !== 0) this.host.offsetElement(newEl, dx, dy);
    return newId;
  }

  // ---- Grouping ----

  groupSelectedShapes(): void {
    // Gather selected shapes wherever they live (inside a frame/group or top level).
    // Frames are top-level only and never join a group, so they're excluded here.
    const toGroup = this.host.selectedInDomOrder().filter(s => s.type !== 'frame');
    if (toGroup.length < 2) return;

    const parent = this.host.commonParentOf(toGroup);
    const gEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const groupId = this.host.nextId();
    gEl.id = groupId;
    gEl.setAttribute('data-name', 'Group');

    // Insert the group into the operands' parent, then move them in (coords keep,
    // wrapper has no transform in the same parent space).
    const insertBefore = toGroup[toGroup.length - 1].element.nextSibling as SVGElement | null;
    parent.insertBefore(gEl, insertBefore);
    for (const s of toGroup) gEl.appendChild(s.element);

    this.host.rebuild();
    this.host.setSelection([groupId]);
    this.host.saveHistory();
    this.host.onChange();
  }

  /** Create a new empty group ("layer") at the top of the stack. */
  addEmptyGroup(): void {
    const gEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const id = this.host.nextId();
    gEl.id = id;
    const name = `Layer ${id.replace('shape-', '#')}`;
    gEl.setAttribute('data-name', name);
    this.host.getDrawingLayer().appendChild(gEl);

    this.host.getShapes().push({
      id,
      type: 'group',
      element: gEl,
      name,
      style: { fill: 'none', stroke: 'none', strokeWidth: 0, opacity: 1 },
      visible: true,
      locked: false,
      children: [],
    });
    this.host.setSelection([id]);
    this.host.saveHistory();
    this.host.onChange();
  }

  ungroupShape(id: string): void {
    // findShape (not the top-level array) — auto-parenting puts most groups
    // INSIDE a frame, and a top-level-only lookup made ungroup a silent no-op there.
    const group = this.host.findShape(id);
    if (!group || group.type !== 'group' || !group.children) return;
    // Ungrouping a clip group would delete the clip shape (it lives in a non-model
    // <clipPath>). Release the mask instead, which restores it as a normal child.
    if (group.element.hasAttribute('data-clip-group')) { this.host.releaseClippingMask(id); return; }

    const gEl = group.element;
    // Move children into the group's OWN parent (a frame or another group), not
    // the drawing layer — reparenting to the layer teleported frame-nested shapes
    // out of their frame.
    const parent = gEl.parentNode;
    if (!parent) return;
    const svg = gEl.ownerSVGElement;
    // A group may carry its own transform (e.g. a rotated group). Moving a child to
    // the group's parent drops that transform, so fold it into each child first to
    // preserve rendered position.
    const consolidated = gEl.transform.baseVal.consolidate();
    const gm = consolidated ? consolidated.matrix : null;
    const childEls = group.children.map(c => c.element);

    // What the group carried goes to each child, as far as separate objects can
    // hold it — ungrouping used to simply drop the lot, so a faded, shadowed group
    // came apart fully opaque with no shadow. Overlapping children can't match a
    // group pixel for pixel (the group composited them as one); that is what no
    // longer being a group means.
    const gOpacity = gEl.getAttribute('opacity');
    const gBlend = getBlend(gEl);
    const gClip = gEl.getAttribute('clip-path');
    for (const el of childEls) {
      const ct = el.transform.baseVal.consolidate();
      const own = ct ? new DOMMatrix([ct.matrix.a, ct.matrix.b, ct.matrix.c, ct.matrix.d, ct.matrix.e, ct.matrix.f]) : new DOMMatrix();
      inheritEffects(el, gEl, own); // in the child's own space, before it moves
      const op = composeOpacity(gOpacity, el.getAttribute('opacity'));
      if (op) el.setAttribute('opacity', op); else el.removeAttribute('opacity');
      if (gBlend && !getBlend(el)) setBlend(el, gBlend);
      if (gEl.style.display === 'none') el.style.display = 'none';
      if (gEl.getAttribute('data-locked') === 'true') el.setAttribute('data-locked', 'true');
      // A clip is geometry in the group's space; only a child that shares it can take it.
      if (gClip && !ct && !el.hasAttribute('clip-path')) el.setAttribute('clip-path', gClip);
      if (gm && svg) {
        const composed = ct ? gm.multiply(ct.matrix) : gm;
        el.transform.baseVal.initialize(svg.createSVGTransformFromMatrix(composed));
      }
      parent.insertBefore(el, gEl); // preserves DOM order ahead of the group
    }
    gEl.remove();

    // The DOM is the source of truth — resync the model (handles the frame/nested
    // case that hand-splicing the top-level array could not).
    this.host.rebuild();
    this.host.setSelection(childEls.map(el => el.id).filter(Boolean));
    this.host.clearStaleIsolation();
    this.host.saveHistory();
    this.host.onChange();
  }
}
