import type { ShapeData, ShapeStyle, SymbolDef, Artboard } from './types';
import { sanitizeSvgElement } from './svg-sanitize';
import { visualLocalBBox, pointMapperBetween, viewportFit } from './coords';
import { dissolveOnto } from './wrapper-attrs';

/**
 * The viewBox→viewport step of a `<use>` of a `<symbol>` placed at x/y/w/h, per
 * the spec's preserveAspectRatio rules (default `xMidYMid meet`: UNIFORM scale,
 * centred). Detach used to assume independent x/y scaling, so a non-uniformly
 * resized instance — which renders uniformly scaled and centred — detached
 * stretched. Returns '' when the step is the identity.
 */
function viewportTransform(
  vb: number[], x: number, y: number, w: number, h: number, par: string | null,
): string {
  const { tx, ty, sx, sy } = viewportFit(vb, x, y, w, h, par);
  const eps = 1e-9;
  const unscaled = Math.abs(sx - 1) < eps && Math.abs(sy - 1) < eps;
  if (unscaled && Math.abs(tx) < eps && Math.abs(ty) < eps) return '';
  return unscaled ? `translate(${tx}, ${ty})` : `translate(${tx}, ${ty}) scale(${sx}, ${sy})`;
}

/**
 * The slice of the document the symbols subsystem needs. Creating a symbol
 * transforms a shape into a `<use>`, and detaching does the reverse, so this
 * host surface is wide — but it makes that coupling explicit and typed instead
 * of reaching into the AppState god object. AppState supplies it as an adapter
 * (see its constructor). `getShapes()` returns the live model array, so in-place
 * replacements land on the real document.
 */
export interface SymbolHost {
  getShapes(): ShapeData[];
  /** Find a shape anywhere in the tree — symbols must work for a shape nested in a
   *  frame or group, which the top-level getShapes() array doesn't contain. */
  findShape(id: string): ShapeData | null;
  getDrawingLayer(): SVGGElement;
  /** Re-derive the model from the DOM after a structural change. */
  rebuild(): void;
  ensureDefs(): SVGDefsElement;
  nextId(): string;
  detectType(el: SVGElement): ShapeData['type'] | null;
  readStyle(el: SVGElement, type: ShapeData['type']): ShapeStyle;
  getActiveArtboard(): Artboard;
  addShape(shape: ShapeData): void;
  setSelection(ids: string[]): void;
  getSelectedSymbolId(): string | null;
  setSelectedSymbolId(id: string | null): void;
  saveHistory(): void;
  onChange(): void;
}

const NS = 'http://www.w3.org/2000/svg';

/** Children of a `<symbol>` that draw nothing. */
const NOT_DRAWN = new Set(['title', 'desc', 'metadata', 'defs', 'style', 'script']);

function ownMatrix(el: Element): DOMMatrix {
  const m = (el as SVGGraphicsElement).transform?.baseVal?.consolidate?.()?.matrix;
  return m ? new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]) : new DOMMatrix();
}

/** The editor models `<ellipse>`, never `<circle>` (rebuild converts any it finds
 *  in the drawing layer). Content cloned out of a `<symbol>` hasn't been through
 *  that yet, and a bare circle is no shape type at all — so convert here, root
 *  included. Returns the (possibly replaced) root. */
function circlesToEllipses(root: SVGElement): SVGElement {
  const convert = (c: Element): SVGElement => {
    const ell = document.createElementNS(NS, 'ellipse') as SVGElement;
    for (const attr of Array.from(c.attributes)) {
      if (attr.name !== 'r') ell.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
    }
    const r = c.getAttribute('r') ?? '0';
    ell.setAttribute('rx', r);
    ell.setAttribute('ry', r);
    return ell;
  };
  for (const c of Array.from(root.querySelectorAll('circle'))) c.replaceWith(convert(c));
  return root.tagName.toLowerCase() === 'circle' ? convert(root) : root;
}

/**
 * Owns the document's `<symbol>` definitions: the tracked models surfaced in the
 * Symbols panel, their id counter, and the shape↔`<use>` transformations
 * (create-from-shape, place-instance, detach). Extracted from AppState; all
 * shape-model access goes through {@link SymbolHost}.
 */
export class SymbolRegistry {
  symbols: SymbolDef[] = [];
  private symbolCounter = 0;
  private readonly host: SymbolHost;

  constructor(host: SymbolHost) {
    this.host = host;
  }

  /** Reset tracked symbols + counter. The live `<defs>` DOM is cleared by the
   *  caller (AppState.clearDefs), which owns the shared element. */
  clear(): void {
    this.symbols = [];
    this.symbolCounter = 0;
  }

  private nextSymbolId(): string {
    // Token keeps component ids unique across documents (see core/library.ts).
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    const token = Array.from(buf, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6);
    return `symbol-${++this.symbolCounter}-${token}`;
  }

  // ---- Persistence -------------------------------------------------------
  // A <symbol> lives in <defs>, which is NOT in the history snapshot — so on its
  // own it can't survive undo, and deleting a component was unrecoverable. Carry
  // the definitions in a <metadata> carrier inside the drawing layer (the same
  // trick text styles / the asset library / embedded fonts use) and treat the
  // <defs> elements as a regenerated cache, per CLAUDE.md's defs rule.

  private carrier(): Element | null {
    return this.host.getDrawingLayer().querySelector(':scope > metadata.bq-symbols');
  }

  private flush(): void {
    if (!this.symbols.length && this.symbolCounter === 0) { this.carrier()?.remove(); return; }
    let c = this.carrier();
    if (!c) {
      c = document.createElementNS(NS, 'metadata');
      c.setAttribute('class', 'bq-symbols');
      this.host.getDrawingLayer().prepend(c);
    }
    c.setAttribute('data-symbols', JSON.stringify(this.symbols.map((s) => s.element.outerHTML)));
    c.setAttribute('data-seq', String(this.symbolCounter)); // never re-derive: ids must not recycle
  }

  /** Re-derive the symbol model + their `<defs>` elements from the carrier. Called
   *  after every rebuildShapesFromDOM, so components survive undo/redo/load. */
  syncFromDOM(): void {
    const carrier = this.carrier();
    let markups: string[] | null = null;
    if (carrier) {
      try {
        const parsed = JSON.parse(carrier.getAttribute('data-symbols') || '[]');
        if (Array.isArray(parsed)) markups = parsed as string[];
      } catch { /* corrupt carrier - fall through to adopting whatever defs hold */ }
    }
    const storedSeq = parseInt(carrier?.getAttribute('data-seq') ?? '', 10);
    const defs = this.host.ensureDefs();

    if (!markups) {
      // Legacy document or a fresh import: adopt the <symbol>s already in <defs>.
      markups = Array.from(defs.querySelectorAll(':scope > symbol')).map((e) => e.outerHTML);
      if (!markups.length) { this.symbols = []; return; }
    } else {
      // ADOPT a <symbol> that is in defs, absent from the carrier, and STILL
      // REFERENCED by a <use>. An SVG import tracks symbols straight into defs
      // without flushing, so regenerating purely from the carrier deleted them and
      // blanked their instances - artwork loss.
      //
      // Two things keep this from running away. Ids come from PARSING the stored
      // markup (a regex over the serialized string silently matched nothing, so
      // every symbol looked unknown and the library doubled on every rebuild). And
      // the "still referenced" test matters because defs is not in the history
      // snapshot: right after an undo it still holds symbols the restored document
      // dropped, and those have no <use> left, so they are not resurrected.
      const known = new Set(markups.map((m) => this.parseSymbol(m)?.id).filter(Boolean) as string[]);
      const layer = this.host.getDrawingLayer();
      for (const el of Array.from(defs.querySelectorAll(':scope > symbol'))) {
        if (!el.id || known.has(el.id)) continue;
        if (layer.querySelector(`use[href="#${el.id}"], use[*|href="#${el.id}"]`)) markups.push(el.outerHTML);
      }
    }
    this.regenerate(markups, Number.isFinite(storedSeq) && storedSeq > 0 ? storedSeq : 0);
    this.flush(); // normalizes a legacy document into a carrier
  }

  /** Parse one stored `<symbol>` markup string back into an element. */
  private parseSymbol(markup: string): SVGElement | null {
    const doc = new DOMParser().parseFromString(`<svg xmlns="${NS}">${markup}</svg>`, 'image/svg+xml');
    return doc.documentElement.querySelector('symbol') as SVGElement | null;
  }

  /** Rebuild the <defs> <symbol> cache (and the model) from stored markup. */
  private regenerate(markups: string[], seq: number): void {
    const defs = this.host.ensureDefs();
    for (const el of Array.from(defs.querySelectorAll(':scope > symbol'))) el.remove();
    this.symbols = [];
    this.symbolCounter = seq;
    const seen = new Set<string>();
    for (const markup of markups) {
      const parsed = this.parseSymbol(markup);
      if (!parsed) continue;
      const el = document.importNode(parsed, true) as SVGElement;
      if (!sanitizeSvgElement(el)) continue;
      if (!el.id) el.id = this.nextSymbolId();
      if (seen.has(el.id)) continue; // ids are unique: never emit the same symbol twice
      seen.add(el.id);
      const m = /symbol-(\d+)/.exec(el.id);
      if (m) this.symbolCounter = Math.max(this.symbolCounter, parseInt(m[1], 10));
      defs.appendChild(el);
      this.symbols.push({
        id: el.id,
        name: el.getAttribute('data-name') || `Symbol ${el.id}`,
        element: el as unknown as SVGSymbolElement,
      });
    }
  }

  /**
   * The box the shape's markup will occupy INSIDE the `<symbol>` — i.e. in the
   * space the `<use>` that replaces it lives in (the shape's former parent).
   *
   * The clone keeps its own `transform`, so the content is drawn in the source's
   * PARENT space, not its local space. A raw `getBBox()` is LOCAL and
   * pre-own-transform (CLAUDE.md recurring-bug #2), so for a rotated/scaled/skewed
   * shape it described a box the transformed content spills out of — and `<symbol>`
   * clips to its viewBox, so the component rendered cut off (#189).
   *
   * Ancestor (frame/group) transforms are deliberately NOT folded in — that's why
   * this isn't `localBBoxInLayer`. The `<use>` replaces the shape in the *same*
   * parent, so its x/y/width/height are read in exactly this space; a drawing-layer
   * box would be wrong for every shape living inside a transformed frame or group.
   */
  private symbolContentBox(el: SVGGraphicsElement, strokeWidth: number): DOMRect | null {
    // visualLocalBBox, not getBBox: a cropped image's box is its crop viewport and a
    // clip-group's is mask ∩ content — what actually renders, which is what must fit.
    const local = visualLocalBBox(el);
    if (!local) return null;
    let minX = local.x, minY = local.y;
    let maxX = local.x + local.width, maxY = local.y + local.height;
    const parent = el.parentElement as unknown as SVGGraphicsElement | null;
    const map = parent ? pointMapperBetween(parent, el) : null;
    if (map) { // el-local → parent space: the element's own transform, nothing above it
      const pts = [map(minX, minY), map(maxX, minY), map(maxX, maxY), map(minX, maxY)];
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      minX = Math.min(...xs); maxX = Math.max(...xs);
      minY = Math.min(...ys); maxY = Math.max(...ys);
    }
    // Snap OUTWARD at 1e-6: a rotation yields irrational corners, and the values are
    // serialized into two attributes — rounding out keeps the markup readable and can
    // never crop the content.
    minX = Math.floor(minX * 1e6) / 1e6; minY = Math.floor(minY * 1e6) / 1e6;
    maxX = Math.ceil(maxX * 1e6) / 1e6; maxY = Math.ceil(maxY * 1e6) / 1e6;
    // A zero-length viewBox axis DISABLES rendering outright (per spec), which blanks
    // the instance of anything flat — a horizontal <line> measures 0 tall. Expand a
    // flat axis symmetrically by the stroke it paints there. Padding the viewBox and
    // the <use> box identically keeps the 1:1 mapping below, so nothing shifts.
    const pad = Math.max(strokeWidth, 1);
    if (maxX - minX <= 0) { minX -= pad / 2; maxX += pad / 2; }
    if (maxY - minY <= 0) { minY -= pad / 2; maxY += pad / 2; }
    return new DOMRect(minX, minY, maxX - minX, maxY - minY);
  }

  createSymbolFromShape(shapeId: string, name?: string): SymbolDef | null {
    // findShape (not the top-level array) — auto-parenting puts most shapes inside
    // a frame, and a top-level-only lookup made "save as component" fail for them.
    const shape = this.host.findShape(shapeId);
    if (!shape) return null;

    // Measure first: a shape with no measurable geometry must not leave a half-built
    // symbol (and a burned symbol id) behind.
    const bbox = this.symbolContentBox(shape.element, shape.style.strokeWidth);
    if (!bbox) return null;

    const defs = this.host.ensureDefs();
    const symbolEl = document.createElementNS(NS, 'symbol');
    const symId = this.nextSymbolId();
    symbolEl.id = symId;

    symbolEl.setAttribute('viewBox', `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);
    // A <symbol> establishes a viewport, and the UA stylesheet clips it to the
    // viewBox — while a bbox is FILL geometry, so the outer half of every stroke (and
    // any blur/shadow filter spill) fell outside and was cut off: converting a stroked
    // shape to a component visibly thinned its border. The presentation attribute is
    // author-origin, so it beats the UA rule; a renderer that ignores it just clips as
    // before. Measured: with it the instance is pixel-identical to the source shape,
    // without it ~1500 pixels of a stroked 120×60 rect differ.
    symbolEl.setAttribute('overflow', 'visible');

    const clone = shape.element.cloneNode(true) as SVGElement;
    clone.removeAttribute('id');
    symbolEl.appendChild(clone);
    defs.appendChild(symbolEl);

    // Take the caller's chosen name up front; renaming afterwards cost a 2nd undo step.
    const symName = name || shape.name || `Symbol ${symId}`;
    symbolEl.setAttribute('data-name', symName); // persist the name (trackImportedSymbol reads it)
    const symbolDef: SymbolDef = { id: symId, name: symName, element: symbolEl as unknown as SVGSymbolElement };
    this.symbols.push(symbolDef);

    const useEl = document.createElementNS(NS, 'use');
    const useId = this.host.nextId();
    useEl.id = useId;
    useEl.setAttribute('href', `#${symId}`);
    // Same box as the viewBox, on purpose: the instance's viewport transform then
    // reduces to translate(x,y)·translate(−viewBoxX,−viewBoxY)·scale(1) = identity, so
    // the clone renders at exactly the coordinates it had as a child of this parent —
    // the component is pixel-identical to the shape it replaced, rotation included.
    // detachInstanceElement relies on the same equality to invert cleanly.
    useEl.setAttribute('x', String(bbox.x));
    useEl.setAttribute('y', String(bbox.y));
    useEl.setAttribute('width', String(bbox.width));
    useEl.setAttribute('height', String(bbox.height));
    useEl.setAttribute('data-name', `${symName} instance`);

    // Replace in the DOM, then re-derive the model: the shape may live inside a
    // frame or group, so splicing the top-level array would miss it (and would
    // leave the tree wrong for nested shapes).
    shape.element.replaceWith(useEl);
    this.flush(); // persist the new symbol so it survives undo/redo/load
    this.host.rebuild();
    this.host.setSelection([useId]);
    this.host.saveHistory();
    this.host.onChange();
    return symbolDef;
  }

  placeSymbolInstance(symId: string): void {
    const sym = this.symbols.find(s => s.id === symId);
    if (!sym) return;

    const viewBox = sym.element.getAttribute('viewBox')?.split(' ').map(Number) ?? [0, 0, 100, 100];
    const ab = this.host.getActiveArtboard();
    const w = viewBox[2];
    const h = viewBox[3];
    const x = ab.x + (ab.width - w) / 2;
    const y = ab.y + (ab.height - h) / 2;

    const useEl = document.createElementNS(NS, 'use');
    const id = this.host.nextId();
    useEl.id = id;
    useEl.setAttribute('href', `#${symId}`);
    useEl.setAttribute('x', String(x));
    useEl.setAttribute('y', String(y));
    useEl.setAttribute('width', String(w));
    useEl.setAttribute('height', String(h));
    const name = `${sym.name} instance`;
    useEl.setAttribute('data-name', name);

    this.host.addShape({
      id, type: 'use', element: useEl, name,
      style: { fill: 'none', stroke: 'none', strokeWidth: 0, opacity: 1 },
      visible: true, locked: false,
      symbolId: symId,
    });
  }

  /** @returns false when nothing could be detached, so the caller can say so
   *  instead of appearing to work (#186's rule). */
  detachSymbolInstance(shapeId: string): boolean {
    // findShape, not the top-level array — an instance placed into a frame lives
    // in that frame's children.
    const shape = this.host.findShape(shapeId);
    if (!shape || shape.type !== 'use') return false;
    // Resolve the symbol from the ELEMENT's href rather than trusting the model
    // field: the DOM is the source of truth, and this method used to no-op for
    // every instance because rebuildShapesFromDOM dropped shape.symbolId (#234).
    const href = shape.element.getAttribute('href')
      ?? shape.element.getAttribute('xlink:href') ?? '';
    const symId = shape.symbolId ?? (href.startsWith('#') ? href.slice(1) : '');
    if (!symId) return false;
    const newId = this.detachInstanceElement(shape.element, symId);
    if (!newId) return false;
    this.host.rebuild();
    this.host.setSelection([newId]);
    this.host.saveHistory();
    this.host.onChange();
    return true;
  }

  /** DOM-only detach: replace one `<use>` with real geometry. No history/rebuild,
   *  so callers can batch (removeSymbol detaches every instance in one step). */
  /** Give every layer inside a detached clone a fresh id. importNode keeps the
   *  symbol's own, so two detached instances of a grouped component both held
   *  shape-2 and shape-3, and a rename or delete by id hit the wrong copy.
   *  References inside the clone (a textPath's href, a url(#…)) follow the rename. */
  private freshLayerIds(root: Element): void {
    const renamed = new Map<string, string>();
    root.querySelectorAll('[id^="shape-"]').forEach((n) => {
      const id = this.host.nextId();
      renamed.set(n.id, id);
      n.id = id;
    });
    if (!renamed.size) return;
    for (const n of [root, ...Array.from(root.querySelectorAll('*'))]) {
      for (const a of Array.from(n.attributes)) {
        if (!a.value.includes('#shape-')) continue;
        const v = a.value.replace(/#(shape-\d+)/g, (m, old: string) => {
          const id = renamed.get(old);
          return id ? `#${id}` : m;
        });
        if (v !== a.value) n.setAttribute(a.name, v);
      }
    }
  }

  /** The size an instance is drawn at: its own width/height, else the symbol's,
   *  else "100% of the viewport" — the canvas's current viewBox, which is what is
   *  on screen for an instance that arrived without either (new imports are given
   *  explicit sizes, see svg-io). */
  private instanceSize(useEl: SVGElement, symEl: Element): { w: number; h: number } {
    const pick = (attr: string): number | null => {
      for (const el of [useEl, symEl]) {
        const raw = el.getAttribute(attr);
        const v = parseFloat(raw ?? '');
        if (raw && !raw.trim().endsWith('%') && Number.isFinite(v) && v > 0) return v;
      }
      return null;
    };
    const view = useEl.ownerSVGElement?.viewBox?.baseVal;
    return {
      w: pick('width') ?? (view && view.width > 0 ? view.width : 100),
      h: pick('height') ?? (view && view.height > 0 ? view.height : 100),
    };
  }

  /** Does anything the symbol draws (strokes included) reach past the instance's
   *  viewport x/y/w/h? A `<symbol>` clips there unless it says `overflow: visible`,
   *  so detached content that spills needs the same clip to look the same. */
  private spillsViewport(symEl: Element, toUse: DOMMatrix, x: number, y: number, w: number, h: number): boolean {
    const overflow = symEl.getAttribute('overflow') ?? (symEl as SVGElement).style?.overflow ?? '';
    if (overflow === 'visible' || overflow === 'auto') return false;
    const eps = Math.max(0.01, 0.002 * Math.max(w, h));
    const outside = (px: number, py: number): boolean =>
      px < x - eps || py < y - eps || px > x + w + eps || py > y + h + eps;
    const visit = (parent: Element, m: DOMMatrix): boolean => {
      for (const c of Array.from(parent.children)) {
        const tag = c.tagName.toLowerCase();
        if (NOT_DRAWN.has(tag)) continue;
        const cm = m.multiply(ownMatrix(c));
        if (tag === 'g') { if (visit(c, cm)) return true; continue; }
        let bb: DOMRect;
        try { bb = (c as SVGGraphicsElement).getBBox(); } catch { continue; }
        if (!bb.width && !bb.height) continue;
        const cs = getComputedStyle(c);
        const half = cs.stroke && cs.stroke !== 'none' ? (parseFloat(cs.strokeWidth) || 0) / 2 : 0;
        for (const [cx, cy] of [[bb.x - half, bb.y - half], [bb.x + bb.width + half, bb.y - half],
          [bb.x - half, bb.y + bb.height + half], [bb.x + bb.width + half, bb.y + bb.height + half]]) {
          const p = new DOMPoint(cx, cy).matrixTransform(cm);
          if (outside(p.x, p.y)) return true;
        }
      }
      return false;
    };
    return visit(symEl, toUse);
  }

  private detachInstanceElement(useEl: SVGElement, symbolId: string): string | null {
    const sym = this.symbols.find(s => s.id === symbolId);
    if (!sym) return null;

    // Everything the symbol draws. An imported one may open with a <title> and hold
    // several shapes; taking only its first child lost the rest, or failed outright.
    const drawn = Array.from(sym.element.children).filter((c) => !NOT_DRAWN.has(c.tagName.toLowerCase()));
    if (drawn.length === 0) return null;
    let clone: SVGElement;
    if (drawn.length === 1) {
      clone = document.importNode(drawn[0], true) as SVGElement;
    } else {
      clone = document.createElementNS(NS, 'g') as SVGElement;
      for (const c of drawn) clone.appendChild(document.importNode(c, true));
    }
    clone = circlesToEllipses(clone);
    clone.removeAttribute('id');
    this.freshLayerIds(clone);
    const type = this.host.detectType(clone);
    if (!type) return null;

    const x = parseFloat(useEl.getAttribute('x') ?? '0') || 0;
    const y = parseFloat(useEl.getAttribute('y') ?? '0') || 0;
    const { w, h } = this.instanceSize(useEl, sym.element);

    // The instance renders as  use.transform · viewBox→viewport · content.transform,
    // so the detached geometry must compose ALL THREE. Writing only the viewport
    // step (as this used to) dropped a rotated instance's rotation AND overwrote a
    // rotated source's own — detaching visibly changed the artwork.
    const vbRaw = (sym.element.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
    const viewBox = vbRaw.length === 4 && vbRaw.every(Number.isFinite) && vbRaw[2] > 0 && vbRaw[3] > 0
      ? vbRaw : [0, 0, w, h];
    const par = sym.element.getAttribute('preserveAspectRatio');
    let via = viewportTransform(viewBox, x, y, w, h, par);

    // Content that spills past the viewport was being clipped there (a "slice" fit,
    // or artwork drawn outside the viewBox). The same clip comes along, as a mask.
    let content = clone;
    let mask: SVGElement | null = null, cutter: SVGElement | null = null, clipPath: SVGElement | null = null;
    const fit = viewportFit(viewBox, x, y, w, h, par);
    if (this.spillsViewport(sym.element, new DOMMatrix([fit.sx, 0, 0, fit.sy, fit.tx, fit.ty]), x, y, w, h)) {
      const own = [via, clone.getAttribute('transform')].filter(Boolean).join(' ');
      if (own) clone.setAttribute('transform', own);
      cutter = document.createElementNS(NS, 'rect') as SVGElement;
      for (const [k, v] of [['x', x], ['y', y], ['width', w], ['height', h]] as const) cutter.setAttribute(k, String(v));
      cutter.setAttribute('fill', '#000000');
      clipPath = document.createElementNS(NS, 'clipPath') as SVGElement;
      clipPath.appendChild(cutter);
      mask = document.createElementNS(NS, 'g') as SVGElement;
      mask.setAttribute('data-clip-group', '');
      mask.setAttribute('clip-path', 'url(#pending)'); // named once the mask has its id
      mask.append(clipPath, clone);
      content = mask;
      via = '';
    }

    // What the INSTANCE carried folds onto the content — or, when it has a clip or
    // an effect (defined in the instance's own space, which the content's adds the
    // viewport step to), stays on a group around it.
    const top = dissolveOnto(useEl, content, via);
    const newId = this.host.nextId();
    top.id = newId;
    for (const el of [content, clone]) if (!el.id) el.id = this.host.nextId();
    if (mask && clipPath && cutter) {
      const n = mask.id.replace('shape-', '');
      clipPath.id = `clipmask-${n}`;
      mask.setAttribute('clip-path', `url(#clipmask-${n})`);
      mask.setAttribute('data-name', `Mask #${n}`);
      cutter.id = this.host.nextId();
    }
    if (top !== mask) top.setAttribute('data-name', `${top === clone ? type : 'group'} ${newId.replace('shape-', '#')}`);

    useEl.replaceWith(top);
    return newId;
  }

  /**
   * Delete a component. Every instance is first detached back into real geometry,
   * so the artwork is KEPT — previously the `<symbol>` was removed out from under
   * the still-present `<use>` elements, which silently blanked them to 0×0 with no
   * history entry, making it unrecoverable. One undo step; the definition itself
   * round-trips via the carrier, so undo restores the component too.
   */
  removeSymbol(id: string): void {
    const idx = this.symbols.findIndex(s => s.id === id);
    if (idx === -1) return;
    // Every instance, wherever it lives — including INSIDE other components, whose
    // own <symbol> would otherwise keep pointing at a definition that's gone and
    // quietly lose that part of every instance.
    const selector = `use[href="#${id}"], use[*|href="#${id}"]`;
    const uses = [
      ...Array.from(this.host.getDrawingLayer().querySelectorAll<SVGElement>(selector)),
      ...this.symbols.filter((s) => s.id !== id)
        .flatMap((s) => Array.from(s.element.querySelectorAll<SVGElement>(selector))),
    ];
    for (const useEl of uses) this.detachInstanceElement(useEl, id);
    this.symbols[idx].element.remove(); // the regenerated <defs> cache
    this.symbols.splice(idx, 1);
    if (this.host.getSelectedSymbolId() === id) this.host.setSelectedSymbolId(null);
    this.flush();
    this.host.rebuild();
    this.host.saveHistory();
    this.host.onChange();
  }

  /** Stamp cloud provenance on a component and PERSIST it. Writing the attributes
   *  directly onto sym.element isn't enough any more: <defs> is regenerated from the
   *  carrier, so anything not flushed is erased on the next rebuild. */
  setSymbolProvenance(id: string, origin: string, rev: number): void {
    const sym = this.symbols.find(s => s.id === id);
    if (!sym) return;
    sym.element.setAttribute('data-origin', origin);
    sym.element.setAttribute('data-rev', String(rev));
    this.flush();
  }

  /** Rename a symbol (model + the persisted data-name so it survives a rebuild). */
  renameSymbol(id: string, name: string): void {
    const sym = this.symbols.find(s => s.id === id);
    if (!sym) return;
    sym.name = name;
    sym.element.setAttribute('data-name', name);
    this.flush();
    this.host.saveHistory();
    this.host.onChange();
  }

  /** Replace a tracked symbol's content + viewBox from newer markup, keeping its
   *  id and name (the ⤓ update path). Existing `<use>` instances re-render. */
  updateSymbolFromMarkup(id: string, el: Element): void {
    const sym = this.symbols.find(s => s.id === id);
    if (!sym) return;
    const imported = document.importNode(el, true) as SVGElement;
    if (!sanitizeSvgElement(imported)) return;
    const vb = imported.getAttribute('viewBox');
    if (vb) sym.element.setAttribute('viewBox', vb);
    sym.element.replaceChildren(...Array.from(imported.childNodes));
    this.flush();
    this.host.saveHistory();
    this.host.onChange();
  }

  /** Adopt a foreign `<symbol>` element (e.g. a component pulled from the account
   *  library) into this document's defs under a FRESH id, and return that id. The
   *  fresh id avoids colliding with a symbol the target document already has. */
  adoptSymbolElement(el: Element): string {
    const imported = document.importNode(el, true) as SVGElement;
    imported.id = this.nextSymbolId();
    if (!sanitizeSvgElement(imported)) throw new Error('Invalid symbol artwork.');
    this.host.ensureDefs().appendChild(imported);
    this.trackImportedSymbol(imported); // records the model entry (name from data-name)
    this.flush();
    return imported.id;
  }

  /**
   * Track a `<symbol>` already imported into the shared `<defs>` so it appears
   * in the Symbols panel and round-trips. The element is in the DOM already;
   * this only assigns/records its id and model entry.
   */
  trackImportedSymbol(imported: SVGElement): void {
    const id = imported.id || this.nextSymbolId();
    imported.id = id;
    const m = id.match(/symbol-(\d+)/);
    if (m) this.symbolCounter = Math.max(this.symbolCounter, parseInt(m[1]));
    this.symbols.push({
      id,
      name: imported.getAttribute('data-name') || `Symbol ${id}`,
      element: imported as unknown as SVGSymbolElement,
    });
  }
}
