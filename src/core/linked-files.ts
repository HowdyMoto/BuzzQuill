/**
 * Linked files — place another document's artwork and keep a live reference to it.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: a linked file still MATERIALIZES its content
 * into this document. The link is not load-bearing for rendering; it only answers
 * "is there a newer version?" — and it means a missing or unreachable source
 * degrades to "linked, source unavailable" while the artwork still renders, instead
 * of leaving a hole in the document. (Sources lived in the retired cloud backend, so
 * today every link is unreachable; Embed keeps the artwork for good.)
 *
 * Storage is a wrapper `<g data-linked-file>` — the wrapper-cache leaf pattern the
 * boolean/appearance/width subsystems use, so rebuildShapesFromDOM models it as ONE
 * layer and never walks the generated children into phantom layers:
 *
 *   data-linked-file            marks the wrapper (and makes it a 'linked' shape type)
 *   data-link-src   = <id>      the source document this mirrors
 *   data-link-rev   = <stamp>   source revision captured at placement → drives the badge
 *   data-link-name  = <name>    what the Layers row shows
 *
 * All of it rides the history snapshot and the saved file for free.
 */

import type { ShapeData } from './types';
import { sanitizeSvgElement } from './svg-sanitize';

const NS = 'http://www.w3.org/2000/svg';

export const LINK_ATTRS = {
  mark: 'data-linked-file',
  src: 'data-link-src',
  rev: 'data-link-rev',
  name: 'data-link-name',
} as const;

/** What the Layers panel and the links UI need to show one linked file. */
export interface LinkedFileInfo {
  shapeId: string;
  src: string;
  rev: string;
  name: string;
  /** True when the source has moved on since this was placed/updated. */
  stale: boolean;
  /** True when the source could not be resolved on the last check. */
  missing: boolean;
}

export interface LinkedFileHost {
  getShapes(): ShapeData[];
  findShape(id: string): ShapeData | null;
  getDrawingLayer(): SVGGElement;
  nextId(): string;
  addShape(shape: ShapeData): void;
  rebuild(): void;
  saveHistory(): void;
  onChange(): void;
}

export class LinkedFileManager {
  private readonly host: LinkedFileHost;
  /** src → latest known revision, from the last refresh. Purely a cache: the badge
   *  is derived, never stored, so it can't go stale in the saved file. */
  private latestRev = new Map<string, string>();
  /** Sources that failed to resolve on the last refresh. */
  private missing = new Set<string>();

  constructor(host: LinkedFileHost) {
    this.host = host;
  }

  /** Place another document's SVG as a linked file. `content` is that document's
   *  markup; only its drawable children are materialized. Returns the new shape id. */
  place(opts: { src: string; name: string; rev: string; content: string; x?: number; y?: number }): string | null {
    const doc = new DOMParser().parseFromString(opts.content, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return null;
    const root = doc.documentElement;

    const wrap = document.createElementNS(NS, 'g');
    const id = this.host.nextId();
    wrap.id = id;
    wrap.setAttribute(LINK_ATTRS.mark, '');
    wrap.setAttribute(LINK_ATTRS.src, opts.src);
    wrap.setAttribute(LINK_ATTRS.rev, opts.rev);
    wrap.setAttribute(LINK_ATTRS.name, opts.name);
    wrap.setAttribute('data-name', opts.name);
    if (opts.x || opts.y) wrap.setAttribute('transform', `translate(${opts.x ?? 0} ${opts.y ?? 0})`);
    this.materialize(wrap, root);

    this.host.getDrawingLayer().appendChild(wrap);
    this.host.rebuild();
    this.host.saveHistory();
    this.host.onChange();
    return id;
  }

  /** Replace a linked file's content from a newer version of its source. */
  updateFrom(shapeId: string, content: string, rev: string): boolean {
    const el = this.wrapperFor(shapeId);
    if (!el) return false;
    const doc = new DOMParser().parseFromString(content, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return false;
    el.replaceChildren();
    this.materialize(el, doc.documentElement);
    el.setAttribute(LINK_ATTRS.rev, rev);
    this.host.rebuild();
    this.host.saveHistory();
    this.host.onChange();
    return true;
  }

  /**
   * Embed a copy: drop the link attributes and keep the artwork exactly as it is.
   * The layer becomes an ordinary group. This is the counterpart of the linked/copy
   * choice used everywhere else in the app, and it's also what a user reaches for
   * when a source is gone for good.
   */
  embed(shapeId: string): boolean {
    const el = this.wrapperFor(shapeId);
    if (!el) return false;
    for (const a of Object.values(LINK_ATTRS)) el.removeAttribute(a);
    this.host.rebuild();
    this.host.saveHistory();
    this.host.onChange();
    return true;
  }

  /** Every linked file in the document, with its badge state. */
  list(): LinkedFileInfo[] {
    const out: LinkedFileInfo[] = [];
    const visit = (list: ShapeData[]): void => {
      for (const s of list) {
        const el = s.element;
        if (el.hasAttribute(LINK_ATTRS.mark)) {
          const src = el.getAttribute(LINK_ATTRS.src) ?? '';
          const rev = el.getAttribute(LINK_ATTRS.rev) ?? '';
          const latest = this.latestRev.get(src);
          out.push({
            shapeId: s.id, src, rev,
            name: el.getAttribute(LINK_ATTRS.name) ?? 'Linked file',
            stale: !!latest && !!rev && latest !== rev,
            missing: this.missing.has(src),
          });
        }
        if (s.children) visit(s.children);
      }
    };
    visit(this.host.getShapes());
    return out;
  }

  info(shapeId: string): LinkedFileInfo | undefined {
    return this.list().find((l) => l.shapeId === shapeId);
  }

  /** Record what the sources currently look like, so `stale`/`missing` can be
   *  derived. Called after a cloud listing; never persisted. */
  noteSourceRevisions(revs: Map<string, string>, missing: Iterable<string> = []): void {
    for (const [src, rev] of revs) { this.latestRev.set(src, rev); this.missing.delete(src); }
    for (const m of missing) this.missing.add(m);
    this.host.onChange();
  }

  private wrapperFor(shapeId: string): SVGElement | null {
    const el = this.host.findShape(shapeId)?.element ?? null;
    return el?.hasAttribute(LINK_ATTRS.mark) ? el : null;
  }

  /** Copy a source document's drawable content into the wrapper. Editor chrome and
   *  the app's own metadata carriers are skipped so a linked file never imports
   *  another document's styles/components as phantom state. */
  private materialize(wrap: SVGElement, root: Element): void {
    const SKIP = new Set(['defs', 'metadata', 'title', 'desc']);
    const layer = root.querySelector('#drawing-layer') ?? root;
    // Bring the source's <defs> across so gradients/patterns/filters still resolve.
    const defs = root.querySelector('defs');
    if (defs) {
      const d = document.importNode(defs, true) as SVGElement;
      wrap.appendChild(d);
    }
    for (const child of Array.from(layer.children)) {
      const tag = child.tagName.toLowerCase();
      if (SKIP.has(tag)) continue;
      if (child.hasAttribute('data-editor-chrome')) continue;
      const node = document.importNode(child, true) as SVGElement;
      // Generated content, not selectable layers — ids would collide and would show
      // up as phantom layers if the wrapper were ever walked.
      node.removeAttribute('id');
      for (const inner of Array.from(node.querySelectorAll('[id]'))) inner.removeAttribute('id');
      wrap.appendChild(node);
    }
    // Every other ingestion path sanitizes; this one adopts another document's markup
    // verbatim (the source may be another user's shared board), so strip event
    // handlers / <script> / <foreignObject> / unsafe href refs — the invariant is
    // "nothing unsanitized enters #drawing-layer". Sanitize the assembled wrapper,
    // NOT each child: a child that is itself a blocked element (a top-level <script>)
    // is only removed when the sanitizer sees it as a descendant of an attached root.
    sanitizeSvgElement(wrap);
  }
}
