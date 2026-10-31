import { sanitizeSvgElement } from './svg-sanitize';
// ---------------------------------------------------------------------------
// Pattern links — object patterns made from, and kept in step with, artwork.
//
//   • Make a pattern from shapes (Illustrator's Object > Pattern > Make): the
//     artwork is snapshotted into the tile, optionally LINKED to one source object.
//   • Refresh linked patterns after every rebuild, so editing the source updates
//     every fill; a vanished source freezes the pattern into a copy.
//   • Edit a pattern by putting its tile back on the canvas as a linked group, and
//     unlink to freeze it again.
//
// Not in PaintRegistry: that registry is deliberately "purely paint", depending on
// nothing but <defs> and a re-render hook. This feature reaches the shape model —
// lookups, ids, rebuilds, selection, history — so it gets its own seam and asks
// the registry for just the five pattern operations it needs.
//
// Extracted from AppState as a collaborator behind a PatternLinkHost seam (#192).
// ---------------------------------------------------------------------------

import type { Artboard, PatternDef, ShapeData } from './types';
import { localBBoxInLayer } from './coords';

export interface PatternLinkHost {
  // Paint registry — only the pattern operations this needs.
  patterns(): PatternDef[];
  getPatternById(id: string): PatternDef | undefined;
  createPattern(def: Partial<PatternDef> & { type: PatternDef['type'] }): PatternDef;
  refreshPatternDef(pat: PatternDef): void;
  updatePattern(pat: PatternDef): void;
  // Shape model.
  findShape(id: string): ShapeData | null;
  nextId(): string;
  getDrawingLayer(): SVGGElement;
  /** Where editable pattern artwork is dropped: the first frame, if any. */
  firstArtboard(): Artboard | undefined;
  setSelection(ids: string[]): void;
  rebuild(): void;
  saveHistory(): void;
  onChange(): void;
}

export class PatternLinkManager {
  private host: PatternLinkHost;
  constructor(host: PatternLinkHost) { this.host = host; }

  /**
   * Build a tiling pattern out of the given shapes' artwork (Illustrator's
   * "Object > Pattern > Make"). This is the COPY model: the artwork is snapshotted
   * into the tile, so editing the originals afterwards doesn't change the pattern.
   *
   * The markup is normalized to the origin here — sized from the union bbox in
   * LAYER coords (getBBox is local and pre-transform, so it would misplace any
   * rotated or frame-nested shape) — which leaves rendering to only apply scale.
   */
  createPatternFromShapes(ids: string[], opts?: { link?: boolean }): PatternDef | null {
    const art = this.capturePatternArt(ids);
    if (!art) return null;
    // Linking needs a single, stable source object to mirror.
    const link = opts?.link && ids.length === 1 ? ids[0] : undefined;
    return this.host.createPattern({
      type: 'object',
      sourceMarkup: art.markup,
      sourceId: link,
      tileWidth: art.width,
      tileHeight: art.height,
      scale: 1, rotation: 0, spacing: 0,
      tileType: 'grid', tileOffset: 0.5,
    });
  }

  /** Snapshot shapes as normalized tile artwork: cloned, id-stripped, and shifted so
   *  the union bbox starts at the origin. Sized in LAYER coords via localBBoxInLayer —
   *  getBBox alone is local and pre-transform, so it would misplace a rotated or
   *  frame-nested shape (CLAUDE.md recurring bug #2). */
  private capturePatternArt(ids: string[]): { markup: string; width: number; height: number } | null {
    const svg = this.host.getDrawingLayer().closest('svg');
    if (!svg) return null;
    const shapes = ids.map((id) => this.host.findShape(id)).filter((sh): sh is ShapeData => !!sh);
    if (!shapes.length) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const sh of shapes) {
      const b = localBBoxInLayer(svg, sh.element);
      if (!b) continue;
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
    }
    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;

    const parts: string[] = [];
    for (const sh of shapes) {
      const clone = sh.element.cloneNode(true) as SVGElement;
      clone.removeAttribute('id');
      for (const el of Array.from(clone.querySelectorAll('[id]'))) el.removeAttribute('id');
      const wrap = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      wrap.setAttribute('transform', `translate(${-minX} ${-minY})`);
      wrap.appendChild(clone);
      parts.push(wrap.outerHTML);
    }
    return {
      markup: parts.join(''),
      width: Math.max(1, Math.round(maxX - minX)),
      height: Math.max(1, Math.round(maxY - minY)),
    };
  }

  /**
   * Re-capture every LINKED pattern from its source object. Called after each
   * rebuild, so editing the source updates every shape filled with it.
   *
   * If a source is gone the pattern FREEZES into a copy (sourceId dropped, artwork
   * kept) rather than breaking — the same "never lose artwork" rule as deleting a
   * component or a linked file whose source is unreachable.
   */
  refreshLinkedPatterns(): void {
    for (const pat of this.host.patterns()) {
      if (!pat.sourceId) continue;
      const src = this.host.findShape(pat.sourceId);
      if (!src) { delete pat.sourceId; continue; }               // freeze as a copy
      // A source painted WITH its own pattern would capture itself; skip that frame.
      if ((src.element.getAttribute('fill') ?? '').includes(`#${pat.id}`)) continue;
      const art = this.capturePatternArt([pat.sourceId]);
      if (!art || art.markup === pat.sourceMarkup) continue;      // unchanged
      pat.sourceMarkup = art.markup;
      pat.tileWidth = art.width;
      pat.tileHeight = art.height;
      this.host.refreshPatternDef(pat);
    }
  }

  /**
   * Put a pattern's tile artwork back on the canvas as an editable group, and LINK
   * the pattern to it — so moving/recolouring those shapes updates every fill live.
   *
   * This is the answer to "how do I edit a pattern?". Illustrator uses a separate
   * pattern-editing mode; here the artwork is just objects again, which needs no new
   * mode and reuses the linked-pattern machinery. Unlink when you're done to freeze
   * it back into a copy. If the pattern is already linked to a live object, this
   * just returns that object so the caller can select it.
   */
  editPatternArtwork(patternId: string): string | null {
    const pat = this.host.getPatternById(patternId);
    if (!pat || pat.type !== 'object' || !pat.sourceMarkup) return null;
    if (pat.sourceId && this.host.findShape(pat.sourceId)) return pat.sourceId;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g') as SVGGElement;
    g.id = this.host.nextId();
    g.setAttribute('data-name', 'Pattern artwork');
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${pat.sourceMarkup}</svg>`, 'image/svg+xml');
    for (const child of Array.from(doc.documentElement.childNodes)) {
      g.appendChild(document.importNode(child, true));
    }
    sanitizeSvgElement(g); // revalidate retained artwork at its secondary insertion
    // Drop it somewhere visible rather than at the origin.
    const ab = this.host.firstArtboard();
    const x = ab ? ab.x + 24 : 24;
    const y = ab ? ab.y + 24 : 24;
    g.setAttribute('transform', `translate(${x} ${y})`);
    this.host.getDrawingLayer().appendChild(g);
    this.host.rebuild();

    pat.sourceId = g.id;
    this.host.refreshPatternDef(pat);
    this.host.setSelection([g.id]);
    this.host.saveHistory();
    this.host.onChange();
    return g.id;
  }

  /** Stop a pattern tracking its source; the captured artwork stays. */
  unlinkPattern(patternId: string): void {
    const pat = this.host.getPatternById(patternId);
    if (!pat?.sourceId) return;
    delete pat.sourceId;
    this.host.updatePattern(pat);
    this.host.saveHistory();
  }
}
