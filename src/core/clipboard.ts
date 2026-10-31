import type { ShapeData, ShapeStyle } from './types';
import { sanitizeSvgElement } from './svg-sanitize';
import { allShapeNames, copyName } from './naming';
import { collectReferencedDefs, prefixIds, remapRefs } from './svg-refs';
import { effectivePaint, ownedPaint, INHERITABLE_PAINT } from './effective-paint';
import { matrixAttr, matrixBetween } from './coords';
import { isLockedEl } from './locks';

/** One copied shape, captured as serialized markup so paste is self-contained. */
interface ClipboardEntry {
  markup: string;
  type: ShapeData['type'];
  style: ShapeStyle;
  /** The source's layer name — paste keeps it, with a counter appended. */
  name: string;
  rotation?: number;
  symbolId?: string;
  /** Id of the group/frame the source lived inside (nearest modeled container), so
   *  the copy re-nests there instead of landing at the root — its markup coords are
   *  already container-local. Undefined for top-level sources. */
  parentContainerId?: string;
  /** That container's matrix into drawing-layer space at copy time, so a copy whose
   *  container is gone by paste time (deleted, or in another document) still lands
   *  where it was instead of reading its container-local coords as world coords. */
  parentMatrix?: [number, number, number, number, number, number];
  /** Serialized markup of every definition the shape REFERENCES but doesn't contain
   *  — clipPaths, gradients, patterns, filters, markers, `<use>` targets.
   *
   *  Without these a paste into another document loses them silently: the UK flag,
   *  whose group is clipped to its 60x30 box and whose red diagonals are carved by a
   *  second clipPath, pasted as an unclipped sprawl. Definitions are captured on
   *  COPY (while the source document is still reachable) rather than resolved on
   *  paste, because by then the target document is the only one in the DOM. */
  defs?: string;
}

/**
 * The slice of the document model the clipboard needs to copy out of and paste
 * back into. Clipboard is inherently coupled to the shape model — it creates and
 * deletes shapes — so this host surface is deliberately wide, but it makes that
 * dependency explicit and typed rather than reaching into the AppState god
 * object. AppState supplies it as an adapter (see its constructor).
 */
export interface ClipboardHost {
  getShapes(): ShapeData[];
  getDrawingLayer(): SVGGElement;
  getSelectedShapeIds(): string[];
  setSelection(ids: string[]): void;
  findShape(id: string): ShapeData | null;
  removeShape(id: string): void;
  removeSelected(): void;
  nextId(): string;
  offsetElement(el: SVGElement, dx: number, dy: number): void;
  reIdGroupChildren(el: SVGElement): void;
  detectType(el: SVGElement): ShapeData['type'] | null;
  readStyle(el: SVGElement, type: ShapeData['type']): ShapeStyle;
  addShape(shape: ShapeData): void;
  /** Position a pasted frame in the first free slot (tiling, no overlap). */
  placePastedFrame(el: SVGElement): void;
  /** Pan the shape with this id into view (used to reveal pasted frames). */
  revealShape(id: string): void;
  /** Re-derive the whole shape tree from the DOM (refreshes caches like artboards). */
  rebuild(): void;
  /** The document's shared <defs>, created if absent — a paste re-homes the
   *  definitions its artwork references (clips, gradients, markers) there. */
  ensureDefs(): SVGDefsElement;
  /** Drop style links that name an asset this document doesn't have (a paste from
   *  another file would otherwise import a link that means something else here). */
  pruneDanglingStyleLinks(): number;
  saveHistory(): void;
  onChange(): void;
}

/**
 * Cut / copy / paste. Owns the in-app clipboard buffer and the paste offset,
 * mirrors copies to the system clipboard for cross-app paste, and reads SVG back
 * from the system clipboard. Extracted from AppState; all shape-model access
 * goes through {@link ClipboardHost}.
 */

/**
 * Serialized markup that carries its own paint. A shape painting by INHERITANCE
 * owns no fill/stroke attribute, so its raw outerHTML renders black (SVG's
 * initial fill) once pasted outside the group it inherited from. Bake the
 * resolved paint onto the CLONE only — the original keeps inheriting, which is
 * the whole point of #208 — so a copy looks like what was copied wherever it
 * lands. Nothing is added when the shape already owns its paint.
 */
function selfContainedMarkup(el: SVGElement): string {
  const missing = INHERITABLE_PAINT.filter(p => ownedPaint(el, p) === null && effectivePaint(el, p) !== null);
  if (missing.length === 0) return el.outerHTML;
  const clone = el.cloneNode(true) as SVGElement;
  for (const p of missing) {
    const v = effectivePaint(el, p);
    if (v !== null) clone.setAttribute(p, v);
  }
  return clone.outerHTML;
}

export class ClipboardManager {
  private clipboard: ClipboardEntry[] = [];
  private pasteOffset = 0;
  private pasteDefSeq = 0;
  private readonly host: ClipboardHost;

  constructor(host: ClipboardHost) {
    this.host = host;
  }

  /** Nearest group/frame ancestor of a shape (walking the model's parent chain),
   *  so a copy of a nested shape can re-nest where the source lived. Other wrapper
   *  parents (boolean operands, …) are stepped over — pasting INTO those would
   *  change their result, so the copy joins the enclosing group/frame instead. */
  private nearestContainerId(shape: ShapeData): string | undefined {
    let pid = shape.parentId;
    while (pid) {
      const p = this.host.findShape(pid);
      if (!p) return undefined;
      if (p.type === 'frame' || p.type === 'group') return p.id;
      pid = p.parentId;
    }
    return undefined;
  }

  private snapshotShape(shape: ShapeData): ClipboardEntry {
    // Definitions live anywhere in the document — <defs>, or (for a foreign import
    // like the UK flag) as bare top-level siblings — so resolve by id document-wide.
    const deps = collectReferencedDefs(shape.element, (id) => document.getElementById(id));
    const parentContainerId = this.nearestContainerId(shape);
    const containerEl = parentContainerId ? this.host.findShape(parentContainerId)?.element : null;
    const m = containerEl
      ? matrixBetween(this.host.getDrawingLayer(), containerEl as SVGGraphicsElement) : null;
    return {
      markup: selfContainedMarkup(shape.element),
      defs: deps.length ? deps.map(d => d.outerHTML).join('') : undefined,
      type: shape.type,
      style: { ...shape.style },
      name: shape.name,
      rotation: shape.rotation,
      symbolId: shape.symbolId,
      parentContainerId,
      parentMatrix: m ? [m.a, m.b, m.c, m.d, m.e, m.f] : undefined,
    };
  }

  /** Replace the clipboard and mirror it to the system clipboard for cross-app paste. */
  private setClipboard(entries: ClipboardEntry[]): void {
    this.clipboard = entries;
    this.pasteOffset = 0;
    const markup = entries.map(e => e.markup).join('');
    // `data-bq-clip` marks this as our OWN copy so paste can tell it apart from
    // SVG copied in another app, and prefer the (richer) internal buffer for it.
    const svgWrapper = `<svg xmlns="http://www.w3.org/2000/svg" data-bq-clip="1">${markup}</svg>`;
    navigator.clipboard?.writeText(svgWrapper).catch(() => { /* ignore */ });
  }

  copyShape(id: string): void {
    const shape = this.host.getShapes().find(s => s.id === id);
    if (!shape) return;
    this.setClipboard([this.snapshotShape(shape)]);
  }

  /**
   * Copy the whole current selection (in selection order), resolving nested
   * shapes too so cut copies exactly what removeSelected deletes.
   */
  copySelected(): void {
    const shapes = this.host.getSelectedShapeIds()
      .map(id => this.host.findShape(id))
      .filter((s): s is ShapeData => s !== null);
    if (shapes.length === 0) return;
    this.setClipboard(shapes.map(s => this.snapshotShape(s)));
  }

  cutShape(id: string): void {
    this.copyShape(id);
    this.host.removeShape(id);
  }

  cutSelected(): void {
    this.copySelected();
    this.host.removeSelected();
  }

  /**
   * Paste the internal clipboard. Returns true if anything was pasted.
   *
   * An ordinary paste cascades each copy 10 units further down-right so repeated
   * pastes fan out. Paste in Place (`inPlace`) puts the copy exactly where its source
   * was, in the same container, and leaves the cascade alone. Frames tile beside
   * their source either way — frames never overlap.
   */
  pasteClipboard(inPlace = false): boolean {
    if (this.clipboard.length === 0) return false;
    const offset = inPlace ? 0 : (this.pasteOffset += 10);
    const newIds: string[] = [];
    for (const entry of this.clipboard) {
      const id = this.insertClipboardEntry(entry, offset);
      if (id) newIds.push(id);
    }
    if (newIds.length === 0) return false;
    // A copy from another document carries that document's style links; they name
    // assets which either don't exist here or mean something else. Drop them so a
    // pasted object is never silently adopted by a local style.
    this.host.pruneDanglingStyleLinks();
    // Rebuild when a pasted frame needs its artboards-cache/clipPath resynced, a
    // copy was re-nested inside a container (it's a group/frame child in the DOM but
    // was pushed to the model as top-level), OR a group was pasted (it's pushed as a
    // leaf, so its children wouldn't show in the Layers panel until some later
    // rebuild) — the rebuild re-derives the correct nesting.
    const pastedFrame = this.clipboard.some(e => e.type === 'frame');
    if (pastedFrame || this.clipboard.some(e => e.parentContainerId || e.type === 'group')) this.host.rebuild();
    this.host.setSelection(newIds);
    this.host.saveHistory();
    this.host.onChange();
    // Pasted frames land at a free slot near the viewport centre — pan so the copy
    // is on screen even if that slot ended up beside a frame filling the view.
    if (pastedFrame) this.host.revealShape(newIds[0]);
    return true;
  }


  /**
   * Re-create the definitions this entry references and re-point the pasted copy at
   * them, so a clip / gradient / pattern / marker survives a paste into a document
   * that never had it.
   *
   * The definitions get FRESH ids. Reusing the source's would be wrong twice over:
   * pasting twice into one document would duplicate an id, and pasting into a
   * document that already happens to use that id would bind this artwork to a
   * stranger's definition — both silent, and the second one corrupts the target's
   * existing artwork rather than just the paste.
   */
  private restoreReferencedDefs(entry: ClipboardEntry, newEl: SVGElement, doc: Document): void {
    if (!entry.defs) return;
    const holder = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
    holder.innerHTML = entry.defs;
    const nodes = Array.from(holder.children).map(n => document.importNode(n, true) as SVGElement).filter(sanitizeSvgElement);
    if (nodes.length === 0) return;

    // Prefix the DEFINITIONS, then apply the same map to the pasted element so its
    // references follow. The element's own ids are untouched — paste re-mints those.
    const map = prefixIds(nodes, `paste${++this.pasteDefSeq}`);
    remapRefs([newEl], map);

    const defs = this.host.ensureDefs();
    for (const n of nodes) defs.appendChild(n);
  }

  /** Materialize one clipboard entry into the drawing layer; returns the new id. */
  private insertClipboardEntry(entry: ClipboardEntry, offset: number): string | null {
    const parser = new DOMParser();
    const doc = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${entry.markup}</svg>`,
      'image/svg+xml'
    );
    const srcEl = doc.querySelector('svg')?.firstElementChild as SVGElement | null;
    if (!srcEl) return null;

    const newEl = document.importNode(srcEl, true) as SVGGraphicsElement;
    if (!sanitizeSvgElement(newEl)) return null;
    this.restoreReferencedDefs(entry, newEl, doc);
    const newId = this.host.nextId();
    newEl.id = newId;
    // The copy keeps the source's name with a counter ("Logo" → "Logo 2").
    const name = entry.name
      ? copyName(entry.name, allShapeNames(this.host.getShapes()))
      : `${entry.type} ${newId.replace('shape-', '#')}`;
    newEl.setAttribute('data-name', name);

    // Re-id ALL nested children that carry ids, not just group/frame contents:
    // wrapper-leaf types keep id-bearing children too (a boolean's operands, a
    // repeat grid's source), and pasting them without re-iding duplicates the
    // source's shape-N ids in the document (#211). Duplicate (cloneShapeById)
    // already re-ids unconditionally — paste was the diverged sibling call site.
    // A frame's inline <clipPath> is renamed after the copy's id there too.
    this.host.reIdGroupChildren(newEl);

    // Attach BEFORE positioning: a <g> (group/frame) moves via its transform, and
    // nudgeTranslate needs the element in the SVG tree (ownerSVGElement) — offsetting
    // it while detached silently no-ops, which is why pasted frames/groups used to
    // land exactly on the original. (Rects offset via x/y attrs, so they were fine.)
    const dl = this.host.getDrawingLayer();
    // Re-nest into the source's group/frame if it still exists, so a copy of a nested
    // shape stays in its container (its coords are already container-local).
    const parent = entry.parentContainerId ? this.host.findShape(entry.parentContainerId) : null;
    // Not into a locked one: the copy would come out locked, unpickable on the canvas.
    // It lands where it was, on the canvas, by the container's matrix below.
    const containerEl = parent && (parent.type === 'frame' || parent.type === 'group')
      && (parent.element as SVGElement).isConnected && !isLockedEl(parent.element)
      ? (parent.element as SVGElement) : null;
    if (entry.type === 'frame') {
      // A pasted frame joins the FRONT of the layer so it lands at the BOTTOM of the
      // Layers list (new frames append to the collection, don't jump to the top);
      // frames don't overlap, so back-of-z has no visual effect. Then tile it into
      // the first free slot beside the source (no overlap, gap-filling).
      dl.insertBefore(newEl, dl.firstChild);
      this.host.placePastedFrame(newEl);
    } else if (containerEl) {
      containerEl.appendChild(newEl);
      if (offset !== 0) this.host.offsetElement(newEl, offset, offset); // container-local cascade
    } else {
      // Small shapes cascade down-right so repeated pastes fan out from the original.
      dl.appendChild(newEl);
      // A copy of a nested shape whose container is gone: its coords are local to
      // that container, so carry the container's matrix to land where it was.
      const pm = entry.parentContainerId ? entry.parentMatrix : undefined;
      if (pm) {
        const [a, b, c, d, e, f] = pm;
        if (a === 1 && b === 0 && c === 0 && d === 1) this.host.offsetElement(newEl, e, f);
        else {
          const own = newEl.getAttribute('transform');
          newEl.setAttribute('transform', [matrixAttr(new DOMMatrix(pm)), own].filter(Boolean).join(' '));
        }
      }
      if (offset !== 0) this.host.offsetElement(newEl, offset, offset);
    }

    this.host.getShapes().push({
      id: newId,
      type: entry.type,
      element: newEl,
      name,
      style: { ...entry.style },
      visible: true,
      locked: false,
      rotation: entry.rotation,
      symbolId: entry.symbolId,
    });
    return newId;
  }

  /** Try to paste SVG content from the system clipboard (async text read). */
  async pasteFromSystemClipboard(): Promise<boolean> {
    try {
      return this.pasteSvgMarkup(await navigator.clipboard.readText());
    } catch {
      return false;
    }
  }

  /**
   * Import an SVG-markup string (a `<svg>…</svg>` fragment, e.g. copied from
   * another app or read from the system clipboard) as editable shapes. Each
   * top-level child becomes a shape; returns true if anything was added.
   */
  pasteSvgMarkup(text: string): boolean {
    if (!text || (!text.includes('<svg') && !text.includes('<SVG'))) return false;
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svgEl = doc.querySelector('svg');
    if (!svgEl) return false;

    const newIds: string[] = [];
    for (const child of Array.from(svgEl.children)) {
      const imported = document.importNode(child, true) as SVGGraphicsElement;
      if (!sanitizeSvgElement(imported)) continue;
      const type = this.host.detectType(imported);
      if (!type) continue;

      const id = this.host.nextId();
      imported.id = id;
      const name = `${type} ${id.replace('shape-', '#')}`;
      imported.setAttribute('data-name', name);

      this.host.addShape({
        id, type, element: imported, name,
        style: this.host.readStyle(imported, type),
        visible: true, locked: false,
      });
      newIds.push(id);
    }
    if (newIds.length === 0) return false;
    this.host.setSelection(newIds);
    return true;
  }
}
