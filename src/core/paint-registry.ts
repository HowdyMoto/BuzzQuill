import type { GradientDef, GradientStop, PatternDef } from './types';
import type { DocumentContext } from './document-context';
import { sanitizeSvgElement } from './svg-sanitize';

const NS = 'http://www.w3.org/2000/svg';

/** Effective mark thickness for a preset pattern, in px.
 *
 *  Patterns saved before `weight` existed fall back to the formula that was baked
 *  into the renderer then — thickness derived from `scale` — so an old document
 *  keeps rendering exactly as it did. Everything created or edited since carries an
 *  explicit `weight`, which is what lets thickness and spacing move independently. */
export function presetWeight(pat: PatternDef): number {
  if (pat.weight !== undefined) return pat.weight;
  switch (pat.preset) {
    case 'dots': return 4 * pat.scale;              // was r = 2 * scale
    case 'stripes': return Math.max(1, 2 * pat.scale);
    default: return Math.max(0.5, pat.scale);       // crosshatch / grid
  }
}

/**
 * Owns the document's gradients and patterns: the tracked models surfaced in the
 * paint UI, their id counters, and the live `<defs>` elements they sync to.
 *
 * Extracted from AppState. It reaches the shared `<defs>` and the re-render hook
 * through {@link DocumentContext} rather than the whole AppState, so its real
 * dependency surface is just those two members. Symbols are NOT here — they're
 * coupled to the shape model (create-from-selection, detach-to-shapes) and stay
 * in AppState; this class is purely paint.
 */
export class PaintRegistry {
  gradients: GradientDef[] = [];
  patterns: PatternDef[] = [];
  private gradCounter = 0;
  private patternCounter = 0;
  private readonly ctx: DocumentContext;

  constructor(ctx: DocumentContext) {
    this.ctx = ctx;
  }

  /**
   * Reset every tracked paint model and counter. The live `<defs>` DOM is
   * cleared by the caller (AppState.clearDefs), which owns the shared element
   * and removes all non-editor children in one pass.
   */
  clear(): void {
    this.gradients = [];
    this.patterns = [];
    this.gradCounter = 0;
    this.patternCounter = 0;
  }

  // ---- Gradient management ----

  createGradient(type: 'linear' | 'radial', stops?: GradientStop[]): GradientDef {
    const id = `grad-${++this.gradCounter}`;
    const defaultStops: GradientStop[] = stops ?? [
      { offset: 0, color: '#000000', opacity: 1 },
      { offset: 1, color: '#FFFFFF', opacity: 1 },
    ];
    const grad: GradientDef = {
      id, type, stops: defaultStops,
      spreadMethod: 'pad',
      ...(type === 'linear'
        ? { x1: 0, y1: 0, x2: 1, y2: 0 }
        : { cx: 0.5, cy: 0.5, r: 0.5, fx: 0.5, fy: 0.5 }),
    };
    this.gradients.push(grad);
    this.syncGradientToDefs(grad);
    this.flushGradientCarrier();
    return grad;
  }

  updateGradient(grad: GradientDef): void {
    const idx = this.gradients.findIndex(g => g.id === grad.id);
    if (idx >= 0) this.gradients[idx] = grad;
    this.syncGradientToDefs(grad);
    this.flushGradientCarrier();
    this.ctx.onChange();
  }

  removeGradient(id: string): void {
    this.gradients = this.gradients.filter(g => g.id !== id);
    const defs = this.ctx.ensureDefs();
    const el = defs.querySelector(`#${id}`);
    if (el) el.remove();
    this.flushGradientCarrier();
  }

  getGradientById(id: string): GradientDef | undefined {
    return this.gradients.find(g => g.id === id);
  }

  // ---- Gradient persistence (survive undo/redo/load) --------------------------
  // A gradient's <linearGradient>/<radialGradient> lives in <defs>, which is NOT in
  // the history/save snapshot (only the drawing layer is). On its own that made a
  // deleted gradient unrecoverable — undo restored shapes referencing url(#grad-N)
  // for a def that no longer existed, so they rendered black (#179). Mirror the
  // symbol/text-style trick: carry the gradient models in a <metadata> element
  // INSIDE the drawing layer (so it rides the snapshot) and treat <defs> as a
  // regenerated cache. GradientDef is plain data, so the carrier is just JSON.
  // (Patterns share this latent undo bug but have their own data-pat-*/import
  // machinery — left for a follow-up so this stays a contained change.)

  private gradientCarrier(): Element | null {
    return this.ctx.getDrawingLayer().querySelector(':scope > metadata.bq-paint');
  }

  private flushGradientCarrier(): void {
    const layer = this.ctx.getDrawingLayer();
    if (!this.gradients.length && this.gradCounter === 0) {
      layer.querySelector(':scope > metadata.bq-paint')?.remove();
      return;
    }
    let c = this.gradientCarrier();
    if (!c) {
      c = document.createElementNS(NS, 'metadata');
      c.setAttribute('class', 'bq-paint');
      layer.prepend(c);
    }
    c.setAttribute('data-gradients', JSON.stringify(this.gradients));
    c.setAttribute('data-grad-seq', String(this.gradCounter)); // never re-derive: ids must not recycle
  }

  /** Re-derive the gradient model + its `<defs>` cache after every
   *  rebuildShapesFromDOM, so gradients survive undo/redo/load. When the carrier is
   *  present it is authoritative (it rode the snapshot the <defs> couldn't); when
   *  absent — a legacy pre-carrier document — the model just loaded is kept and a
   *  carrier is written, so it can never blank a fresh import. */
  syncGradientsFromDOM(): void {
    const carrier = this.gradientCarrier();
    if (carrier) {
      try {
        const parsed = JSON.parse(carrier.getAttribute('data-gradients') || '[]');
        if (Array.isArray(parsed)) this.gradients = parsed as GradientDef[];
      } catch { /* corrupt carrier — keep whatever's loaded rather than blank it */ }
      const seq = parseInt(carrier.getAttribute('data-grad-seq') ?? '', 10);
      if (Number.isFinite(seq)) this.gradCounter = Math.max(this.gradCounter, seq);
    }
    // Make the <defs> cache mirror the model exactly. Prune gradient defs the model
    // no longer has (a delete REDONE leaves the def we regenerated on undo behind),
    // then (re)generate the survivors — idempotent, and it also restores a def undo
    // couldn't bring back and reverts an undone stops-edit.
    const defs = this.ctx.ensureDefs();
    const modelIds = new Set(this.gradients.map((g) => g.id));
    for (const el of Array.from(defs.children)) {
      const tag = el.tagName.toLowerCase();
      if ((tag === 'lineargradient' || tag === 'radialgradient') && !modelIds.has(el.id)) el.remove();
    }
    for (const g of this.gradients) this.syncGradientToDefs(g);
    this.flushGradientCarrier(); // upgrade a legacy doc, refresh after regeneration
  }

  private syncGradientToDefs(grad: GradientDef): void {
    const defs = this.ctx.ensureDefs();

    // Remove existing
    const existing = defs.querySelector(`#${grad.id}`);
    if (existing) existing.remove();

    const el = document.createElementNS(NS,
      grad.type === 'linear' ? 'linearGradient' : 'radialGradient');
    el.id = grad.id;

    if (grad.type === 'linear') {
      el.setAttribute('x1', String(grad.x1 ?? 0));
      el.setAttribute('y1', String(grad.y1 ?? 0));
      el.setAttribute('x2', String(grad.x2 ?? 1));
      el.setAttribute('y2', String(grad.y2 ?? 0));
    } else {
      el.setAttribute('cx', String(grad.cx ?? 0.5));
      el.setAttribute('cy', String(grad.cy ?? 0.5));
      el.setAttribute('r', String(grad.r ?? 0.5));
      el.setAttribute('fx', String(grad.fx ?? 0.5));
      el.setAttribute('fy', String(grad.fy ?? 0.5));
    }
    el.setAttribute('spreadMethod', grad.spreadMethod ?? 'pad');

    for (const stop of grad.stops) {
      const s = document.createElementNS(NS, 'stop');
      s.setAttribute('offset', String(stop.offset));
      s.setAttribute('stop-color', stop.color);
      if (stop.opacity < 1) s.setAttribute('stop-opacity', String(stop.opacity));
      el.appendChild(s);
    }

    defs.appendChild(el);
  }

  /** Build a tracked GradientDef from an imported `<linearGradient>`/
   *  `<radialGradient>` and copy the sanitized element into the live <defs>. */
  importGradientElement(child: Element): void {
    const tag = child.tagName.toLowerCase();
    const type = tag === 'lineargradient' ? 'linear' as const : 'radial' as const;
    const id = child.id || `grad-${++this.gradCounter}`;
    const stops: GradientStop[] = [];
    for (const stopEl of Array.from(child.querySelectorAll('stop'))) {
      stops.push({
        offset: parseFloat(stopEl.getAttribute('offset') ?? '0'),
        color: stopEl.getAttribute('stop-color') ?? '#000000',
        opacity: parseFloat(stopEl.getAttribute('stop-opacity') ?? '1'),
      });
    }
    const grad: GradientDef = {
      id, type, stops,
      spreadMethod: (child.getAttribute('spreadMethod') as GradientDef['spreadMethod']) ?? 'pad',
      x1: parseFloat(child.getAttribute('x1') ?? '0'),
      y1: parseFloat(child.getAttribute('y1') ?? '0'),
      x2: parseFloat(child.getAttribute('x2') ?? '1'),
      y2: parseFloat(child.getAttribute('y2') ?? '0'),
      cx: parseFloat(child.getAttribute('cx') ?? '0.5'),
      cy: parseFloat(child.getAttribute('cy') ?? '0.5'),
      r: parseFloat(child.getAttribute('r') ?? '0.5'),
      fx: parseFloat(child.getAttribute('fx') ?? '0.5'),
      fy: parseFloat(child.getAttribute('fy') ?? '0.5'),
    };
    this.gradients.push(grad);

    // Ensure counter stays ahead
    const m = id.match(/grad-(\d+)/);
    if (m) this.gradCounter = Math.max(this.gradCounter, parseInt(m[1]));

    // Copy element into our defs
    const imported = document.importNode(child, true) as SVGElement;
    if (!sanitizeSvgElement(imported)) return;
    this.ctx.ensureDefs().appendChild(imported);
    this.flushGradientCarrier(); // establish the carrier at load, so undo can restore
  }

  /** Adopt a foreign gradient element under a FRESH, collision-free id and return
   *  it. Unlike importGradientElement (which keeps the element's own id), this is
   *  for replanting a saved paint style — possibly from another document, where
   *  the original id may not exist or may already mean something else here. */
  adoptGradientElement(child: Element): string {
    const id = `grad-${++this.gradCounter}`;
    const clone = child.cloneNode(true) as Element;
    clone.setAttribute('id', id);
    this.importGradientElement(clone);
    return id;
  }

  /** Adopt a foreign pattern element under a FRESH id (see adoptGradientElement). */
  adoptPatternElement(child: Element): string {
    const id = `pat-${++this.patternCounter}`;
    const clone = child.cloneNode(true) as Element;
    clone.setAttribute('id', id);
    this.importPatternElement(clone);
    return id;
  }

  // ---- Pattern management ----

  createPattern(def: Partial<PatternDef> & { type: PatternDef['type'] }): PatternDef {
    const id = `pat-${++this.patternCounter}`;
    const pat: PatternDef = {
      id, type: def.type,
      sourceMarkup: def.sourceMarkup,
      sourceId: def.sourceId,
      tileType: def.tileType,
      tileOffset: def.tileOffset,
      preset: def.preset,
      presetColor: def.presetColor ?? '#000000',
      imageDataUrl: def.imageDataUrl,
      weight: def.weight,
      scale: def.scale ?? 1,
      rotation: def.rotation ?? 0,
      spacing: def.spacing ?? 0,
      tileWidth: def.tileWidth ?? 20,
      tileHeight: def.tileHeight ?? 20,
    };
    this.patterns.push(pat);
    this.syncPatternToDefs(pat);
    return pat;
  }

  /** Re-render a pattern's <defs> element without firing onChange — for the
   *  rebuild hook, where a notify would re-enter the render pass. */
  refreshPatternDef(pat: PatternDef): void {
    this.syncPatternToDefs(pat);
  }

  updatePattern(pat: PatternDef): void {
    const idx = this.patterns.findIndex(p => p.id === pat.id);
    if (idx >= 0) this.patterns[idx] = pat;
    this.syncPatternToDefs(pat);
    this.ctx.onChange();
  }

  removePattern(id: string): void {
    this.patterns = this.patterns.filter(p => p.id !== id);
    const defs = this.ctx.ensureDefs();
    const el = defs.querySelector(`#${id}`);
    if (el) el.remove();
  }

  getPatternById(id: string): PatternDef | undefined {
    return this.patterns.find(p => p.id === id);
  }

  private syncPatternToDefs(pat: PatternDef): void {
    const defs = this.ctx.ensureDefs();

    const existing = defs.querySelector(`#${pat.id}`);
    if (existing) existing.remove();

    // One repeat of the artwork, including its trailing gap.
    const cellW = pat.tileWidth * pat.scale + pat.spacing;
    const cellH = pat.tileHeight * pat.scale + pat.spacing;

    // Brick/half-drop is not a <pattern> feature — bake it by making the tile span
    // two rows (or columns) and drawing the cell at the staggered positions. The
    // extra copy at -cell covers the wrap, so the stagger has no seam at the edge.
    const tileType = pat.tileType ?? 'grid';
    const offset = Math.min(1, Math.max(0, pat.tileOffset ?? 0.5));
    const staggerable = pat.type === 'object' || pat.type === 'image';
    let tw = cellW;
    let th = cellH;
    let spots: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
    if (staggerable && tileType === 'brick-row') {
      th = cellH * 2;
      spots = [{ x: 0, y: 0 }, { x: offset * cellW, y: cellH }, { x: offset * cellW - cellW, y: cellH }];
    } else if (staggerable && tileType === 'brick-col') {
      tw = cellW * 2;
      spots = [{ x: 0, y: 0 }, { x: cellW, y: offset * cellH }, { x: cellW, y: offset * cellH - cellH }];
    }

    const el = document.createElementNS(NS, 'pattern');
    el.id = pat.id;
    // Integer tile dimensions: sub-pixel sizes are the classic source of hairline
    // seams between SVG pattern tiles.
    el.setAttribute('width', String(Math.max(1, Math.round(tw))));
    el.setAttribute('height', String(Math.max(1, Math.round(th))));
    el.setAttribute('patternUnits', 'userSpaceOnUse');

    if (pat.rotation !== 0) {
      el.setAttribute('patternTransform', `rotate(${pat.rotation})`);
    }

    // Stamp the model params so import() reconstructs the PatternDef faithfully —
    // otherwise a save/load (or tab switch) rebuilds every pattern as a generic grid
    // stub, losing the image and the scale/rotation. data-* survives the sanitizer.
    el.setAttribute('data-pat-type', pat.type);
    el.setAttribute('data-pat-scale', String(pat.scale));
    el.setAttribute('data-pat-rotation', String(pat.rotation));
    el.setAttribute('data-pat-spacing', String(pat.spacing));
    el.setAttribute('data-pat-tw', String(pat.tileWidth));
    el.setAttribute('data-pat-th', String(pat.tileHeight));
    if (pat.preset) el.setAttribute('data-pat-preset', pat.preset);
    if (pat.presetColor) el.setAttribute('data-pat-color', pat.presetColor);
    if (pat.weight !== undefined) el.setAttribute('data-pat-weight', String(pat.weight));
    if (pat.sourceId) el.setAttribute('data-pat-source', pat.sourceId);
    if (pat.tileType) el.setAttribute('data-pat-tiletype', pat.tileType);
    if (pat.tileOffset !== undefined) el.setAttribute('data-pat-tileoffset', String(pat.tileOffset));

    if (pat.type === 'preset') {
      this.buildPresetPatternContent(el, pat);   // presets fill the tile themselves
    } else {
      // One cell of content, repeated at each stagger position. The FIRST copy is
      // marked data-pat-src: import reads the normalized artwork back out of it, so
      // an object pattern needs no separate copy of its own markup.
      spots.forEach((spot, i) => {
        const cell = this.buildPatternCell(pat, i === 0);
        if (!cell) return;
        cell.setAttribute('transform', `translate(${spot.x} ${spot.y}) scale(${pat.scale})`);
        el.appendChild(cell);
      });
    }

    defs.appendChild(el);
  }

  /** One repeat of a pattern's artwork, unscaled and at the origin. */
  private buildPatternCell(pat: PatternDef, isSource: boolean): SVGElement | null {
    const g = document.createElementNS(NS, 'g');
    if (isSource) g.setAttribute('data-pat-src', '');
    if (pat.type === 'image' && pat.imageDataUrl) {
      const img = document.createElementNS(NS, 'image');
      img.setAttribute('href', pat.imageDataUrl);
      img.setAttribute('width', String(pat.tileWidth));
      img.setAttribute('height', String(pat.tileHeight));
      img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
      g.appendChild(img);
      return g;
    }
    if (pat.type === 'object' && pat.sourceMarkup) {
      const doc = new DOMParser().parseFromString(
        `<svg xmlns="${NS}">${pat.sourceMarkup}</svg>`, 'image/svg+xml');
      for (const child of Array.from(doc.documentElement.childNodes)) {
        const node = document.importNode(child, true);
        if (node instanceof Element && !sanitizeSvgElement(node)) continue;
        g.appendChild(node);
      }
      return g;
    }
    return null;
  }

  private buildPresetPatternContent(el: SVGPatternElement, pat: PatternDef): void {
    const tw = pat.tileWidth * pat.scale + pat.spacing;
    const th = pat.tileHeight * pat.scale + pat.spacing;
    const color = pat.presetColor ?? '#000000';
    const w = presetWeight(pat);

    switch (pat.preset) {
      case 'dots': {
        const dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('cx', String(tw / 2));
        dot.setAttribute('cy', String(th / 2));
        dot.setAttribute('r', String(w / 2));
        dot.setAttribute('fill', color);
        el.appendChild(dot);
        break;
      }
      case 'stripes': {
        // Drawn at BOTH tile edges: a stroke centred on x=0 spills half its width
        // outside the tile, and SVG pattern tiles clip rather than wrap. Without the
        // mirror at x=tw a heavy stripe loses its left half at every repeat — very
        // visible once weight is free to approach the tile size.
        for (const x of [0, tw]) {
          const line = document.createElementNS(NS, 'line');
          line.setAttribute('x1', String(x)); line.setAttribute('y1', '0');
          line.setAttribute('x2', String(x)); line.setAttribute('y2', String(th));
          line.setAttribute('stroke', color);
          line.setAttribute('stroke-width', String(w));
          el.appendChild(line);
        }
        break;
      }
      case 'crosshatch': {
        const l1 = document.createElementNS(NS, 'line');
        l1.setAttribute('x1', '0'); l1.setAttribute('y1', '0');
        l1.setAttribute('x2', String(tw)); l1.setAttribute('y2', String(th));
        l1.setAttribute('stroke', color); l1.setAttribute('stroke-width', String(w));
        el.appendChild(l1);
        const l2 = document.createElementNS(NS, 'line');
        l2.setAttribute('x1', String(tw)); l2.setAttribute('y1', '0');
        l2.setAttribute('x2', '0'); l2.setAttribute('y2', String(th));
        l2.setAttribute('stroke', color); l2.setAttribute('stroke-width', String(w));
        el.appendChild(l2);
        break;
      }
      case 'grid': {
        // Same edge-clipping story as stripes: mirror the top/left rules onto the
        // bottom/right edge so a thick rule isn't halved at every tile seam.
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', `M ${tw} 0 L 0 0 0 ${th} M ${tw} ${th} L ${tw} 0 M ${tw} ${th} L 0 ${th}`);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-width', String(w));
        el.appendChild(path);
        break;
      }
    }
  }

  /** Track an imported `<pattern>`: copy the sanitized element into the live
   *  <defs> and record a minimal PatternDef so it round-trips. */
  importPatternElement(child: Element): void {
    const id = child.id || `pat-${++this.patternCounter}`;
    const m = id.match(/pat-(\d+)/);
    if (m) this.patternCounter = Math.max(this.patternCounter, parseInt(m[1]));

    // Copy element into our defs (sanitized: patterns can embed <image href>)
    const imported = document.importNode(child, true) as SVGElement;
    if (!sanitizeSvgElement(imported)) return;
    this.ctx.ensureDefs().appendChild(imported);

    // Reconstruct the PatternDef faithfully: prefer our stamped data-pat-* params
    // (exact round-trip of app-created patterns); otherwise infer from the content
    // (foreign SVG patterns) so an image pattern is never mistaken for a grid.
    const num = (a: string, d: number): number => {
      const v = parseFloat(imported.getAttribute(a) ?? '');
      return Number.isFinite(v) ? v : d;
    };
    const imageEl = imported.querySelector('image');
    const href = imageEl?.getAttribute('href') || imageEl?.getAttribute('xlink:href') || undefined;
    const type = (imported.getAttribute('data-pat-type') as PatternDef['type'] | null)
      || (imageEl ? 'image' : 'preset');
    // An object pattern's artwork is read back out of its first placed cell — the
    // one stamped data-pat-src — so the tile content IS the storage. Nothing extra
    // is written, and a saved file carries ordinary SVG.
    const srcCell = imported.querySelector('[data-pat-src]');
    const sourceMarkup = type === 'object' && srcCell ? srcCell.innerHTML : undefined;
    const patW = parseFloat(imported.getAttribute('width') ?? '20') || 20;
    // Foreign image patterns (no stamp): size the tile from the <image> so scale=1
    // renders identically, and fold any gap into spacing.
    const imgW = imageEl ? (parseFloat(imageEl.getAttribute('width') ?? '') || patW) : patW;
    const imgH = imageEl ? (parseFloat(imageEl.getAttribute('height') ?? '') || patW) : patW;
    const rot = (imported.getAttribute('patternTransform') ?? '').match(/rotate\(\s*([-\d.]+)/);

    this.patterns.push({
      id, type,
      preset: (imported.getAttribute('data-pat-preset') as PatternDef['preset']) ?? (type === 'preset' ? 'grid' : undefined),
      presetColor: imported.getAttribute('data-pat-color') ?? '#000000',
      // Absent on foreign/pre-`weight` patterns — presetWeight() then reproduces the
      // old scale-derived thickness rather than inventing one.
      weight: child.hasAttribute('data-pat-weight')
        ? num('data-pat-weight', 2) : undefined,
      imageDataUrl: type === 'image' ? href : undefined,
      sourceMarkup,
      sourceId: imported.getAttribute('data-pat-source') ?? undefined,
      tileType: (imported.getAttribute('data-pat-tiletype') as PatternDef['tileType']) ?? undefined,
      tileOffset: child.hasAttribute('data-pat-tileoffset')
        ? num('data-pat-tileoffset', 0.5) : undefined,
      scale: num('data-pat-scale', 1),
      rotation: num('data-pat-rotation', rot ? parseFloat(rot[1]) : 0),
      spacing: num('data-pat-spacing', imageEl ? Math.max(0, patW - imgW) : 0),
      tileWidth: num('data-pat-tw', imgW),
      tileHeight: num('data-pat-th', imgH),
    });
  }
}
