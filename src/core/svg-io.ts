// ---------------------------------------------------------------------------
// SVG import / defs export — round-tripping the document to and from SVG text.
//
//   • Defs export: getDefsContent/getDefsBlock emit every def the artwork
//     depends on (gradients, patterns, filters, clipPaths, masks, markers,
//     symbols, referenced templates), minus the editor's own grid/transparency
//     chrome, so a saved file renders identically anywhere.
//   • Import: importSVGContent faithfully clones a foreign SVG (ids + refs
//     intact) so layered Inkscape/Illustrator output survives; importDefsFrom
//     pulls its <defs>; importSVGMarkup loads trusted project markup.
//
// Extracted from AppState as a collaborator; it reaches AppState only through
// the SvgIoHost seam and owns the imported-namespace map (pure IO state).
// ---------------------------------------------------------------------------

import { ensureSvgNamespaces } from './svg-ns';
import { sanitizeSvgElement, sanitizeSvgMarkup } from './svg-sanitize';
import { sanitizePathData } from './path-sanitize';
import { stripBooleanOperands } from './boolean';
import { normalizeTextStrokesForExport } from './text-stroke';
import { xmlSafeMarkup } from './xml-safe';
import { prefixIds } from './svg-refs';
import { resolveAuthorStyles } from './author-styles';
import { stripHiddenForExport } from './export-scope';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Editor-only defs (grid + transparency chrome) that must never export/import. */
export const EDITOR_DEF_IDS = new Set(['grid-small', 'grid-large', 'transparency-check']);

export interface SvgIoHost {
  getDrawingLayer(): SVGGElement;
  /** The live <defs>, or null if not yet created. */
  getDefsElement(): SVGDefsElement | null;
  /** The live <defs>, creating it if needed. */
  ensureDefs(): SVGDefsElement;
  /** Symbol elements to emit in defs (they live in the shared <defs> DOM). */
  symbolElements(): SVGElement[];
  trackImportedSymbol(el: SVGElement): void;
  clearSymbols(): void;
  importGradientElement(el: Element): void;
  importPatternElement(el: Element): void;
  clearPaint(): void;
  setShapes(shapes: never[]): void;
  setSelection(ids: string[]): void;
  rebuild(): void;
  saveHistory(): void;
  onChange(): void;
}


/**
 * Presentation attributes that INHERIT down the SVG tree.
 *
 * These are the ones a root `<svg>` can set on behalf of everything inside it —
 * which icon sets do constantly (`<svg fill="#e3e3e3"><path d="…"/></svg>`, the
 * Material Symbols house style). Import clones the root's CHILDREN, so anything the
 * root was contributing by inheritance is left behind unless it's carried over: the
 * path then falls back to SVG's default fill and a near-white icon imports black.
 *
 * Deliberately excludes the non-inheriting ones (opacity, transform, clip-path,
 * mask, filter, display) — copying those down would change compositing rather than
 * preserve it.
 */
const INHERITED_PRESENTATION = [
  'fill', 'fill-opacity', 'fill-rule', 'clip-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
  'color', 'visibility', 'paint-order', 'shape-rendering', 'image-rendering',
  'text-rendering', 'color-interpolation', 'color-interpolation-filters', 'direction',
  'writing-mode', 'text-anchor', 'letter-spacing', 'word-spacing', 'dominant-baseline',
  'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant', 'font-stretch',
  'marker-start', 'marker-mid', 'marker-end',
];

/** Inheritable declarations from an inline `style`, as attribute pairs. */
function inheritedFromStyle(styleAttr: string | null): Array<[string, string]> {
  if (!styleAttr) return [];
  const out: Array<[string, string]> = [];
  for (const decl of styleAttr.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (val && INHERITED_PRESENTATION.includes(prop)) out.push([prop, val]);
  }
  return out;
}

/**
 * Push the root `<svg>`'s inherited presentation onto the imported top-level nodes,
 * so what the root was providing survives losing the root. A target that already
 * sets a property keeps its own — this only fills gaps, exactly as inheritance did.
 */
function carryRootPresentation(svgEl: Element, targets: Element[]): void {
  const pairs: Array<[string, string]> = [];
  for (const name of INHERITED_PRESENTATION) {
    const v = svgEl.getAttribute(name);
    if (v !== null) pairs.push([name, v]);
  }
  // Inline style on the root beats its presentation attributes, so apply it last.
  pairs.push(...inheritedFromStyle(svgEl.getAttribute('style')));
  if (pairs.length === 0) return;
  for (const t of targets) {
    for (const [name, v] of pairs) {
      if (!t.hasAttribute(name)) t.setAttribute(name, v);
    }
  }
}


/**
 * Mark editor LAYER groups (`<g inkscape:groupmode="layer">`) so the rest of the
 * app can treat them as containers rather than artwork.
 *
 * Inkscape — and every tool copying its convention — wraps a whole drawing in one
 * such `<g>`. Modelled as an ordinary group it made the file a single object:
 * clicking any shape selected the lot. A layer is an organisational construct,
 * not artwork the user grouped.
 *
 * This deliberately does NOT unwrap the group. An earlier version did, folding the
 * layer's transform onto each child — which silently doubled that transform for
 * every `<use>` pointing at a sibling, because a `<use>` composes its TARGET's own
 * transform on top of its own CTM. Inkscape files lean on exactly that pattern
 * (an invisible template path drawn by several `<use>`s at different stroke
 * widths), so a track map imported a full page-width off canvas. Marking instead
 * of restructuring keeps the geometry byte-identical to the source and moves the
 * behaviour into selection, where it belongs. `data-layer` is a data-* attribute
 * so it survives the history snapshot for free.
 */
function markEditorLayers(root: Element): void {
  for (const g of Array.from(root.querySelectorAll('g'))) {
    if (g.getAttribute('inkscape:groupmode') === 'layer') g.setAttribute('data-layer', '');
  }
}

export class SvgIoManager {
  private host: SvgIoHost;
  private importedNamespaces = new Map<string, string>();
  /** Set by the last importSVGContent: whether the source carried SMIL animation
   *  (which the sanitizer strips) so the UI can warn. */
  lastImportHadAnimation = false;

  constructor(host: SvgIoHost) { this.host = host; }

  // ---- Defs export ----

  getDefsContent(): string {
    const parts: string[] = [];
    for (const el of this.host.symbolElements()) parts.push(el.outerHTML);
    const defs = this.host.getDefsElement();
    if (defs) {
      // Export every def the document depends on (gradients, patterns, filters,
      // clipPaths, masks, markers, referenced templates, …) so the saved file
      // renders identically anywhere. Two exclusions: the editor's own grid /
      // transparency chrome, and <symbol>s (already emitted from symbolElements
      // above — they share these same DOM nodes, so re-emitting would duplicate).
      for (const child of Array.from(defs.children)) {
        if (EDITOR_DEF_IDS.has(child.id)) continue;
        if (child.tagName.toLowerCase() === 'symbol') continue;
        parts.push(child.outerHTML);
      }
    }
    return xmlSafeMarkup(parts.join('\n'));
  }

  getDefsBlock(): string {
    const content = this.getDefsContent();
    return content ? `<defs>${content}</defs>\n` : '';
  }

  // (Export-only pruning lives in pruneUnusedDefs below — saves keep the full
  // defs so nothing a future edit might re-reference is lost from project files.)

  /** Record non-standard `xmlns:` prefixes from an imported root <svg>. */
  private captureNamespaces(svgEl: Element): void {
    const ALWAYS_EMITTED = new Set(['xlink', 'inkscape', 'sodipodi', 'svg']);
    for (const attr of Array.from(svgEl.attributes)) {
      const m = /^xmlns:(.+)$/.exec(attr.name);
      if (m && !ALWAYS_EMITTED.has(m[1]) && attr.value) {
        this.importedNamespaces.set(m[1], attr.value);
      }
    }
  }

  /**
   * Extra ` xmlns:p="uri"` declarations to splice into a serialized root <svg>,
   * beyond the always-emitted xlink/inkscape/sodipodi. Keeps files that use
   * custom prefixes (Adobe i/x/graph, bx, …) valid XML on save → reload.
   */
  getExtraNamespaceDecls(): string {
    let out = '';
    for (const [prefix, uri] of this.importedNamespaces) {
      out += ` xmlns:${prefix}="${uri.replace(/"/g, '&quot;')}"`;
    }
    return out;
  }

  getDrawingLayerSVG(): string {
    const dl = this.host.getDrawingLayer();
    // Text-stroke outline caches + their suppression marker are live-editor state, not
    // document content — strip them so saved files are plain <text stroke=…> (they
    // re-derive on load). Only pay the clone when such a cache is actually present.
    if (!dl.querySelector('[data-text-stroke-cache],[data-text-stroke-outlined]')) {
      return xmlSafeMarkup(dl.innerHTML);
    }
    const clone = dl.cloneNode(true) as SVGGElement;
    normalizeTextStrokesForExport(clone);
    return xmlSafeMarkup(clone.innerHTML);
  }

  /** Like {@link getDrawingLayerSVG} but with live-boolean operands stripped, so
   *  exported files contain only the computed result paths (no hidden source
   *  geometry). Save/load uses the raw form above to keep booleans editable. */
  getDrawingLayerSVGForExport(): string {
    const clone = this.host.getDrawingLayer().cloneNode(true) as SVGGElement;
    stripBooleanOperands(clone);
    // Text-stroke outline caches are an editor render optimization — export plain
    // <text stroke=…> (restores the suppressed stroke, drops the cache paths).
    normalizeTextStrokesForExport(clone);
    // Frames show dimmed overflow via a mask while editing; the EXPORT hard-clips to
    // the frame bounds (swap the display mask back to the inline clipPath).
    for (const g of Array.from(clone.querySelectorAll('g[data-frame]')) as SVGElement[]) {
      g.removeAttribute('mask');
      const clip = g.querySelector(':scope > clipPath');
      if (clip?.id) g.setAttribute('clip-path', `url(#${clip.id})`);
    }
    stripHiddenForExport(clone);
    return xmlSafeMarkup(clone.innerHTML);
  }

  /** Clear all symbols/gradients/patterns and empty the live <defs> (keeping the
   *  editor's grid & transparency chrome, which lives in this same <defs>). */
  clearDefs(): void {
    this.host.clearSymbols();
    this.host.clearPaint();
    this.importedNamespaces.clear();
    const defs = this.host.getDefsElement();
    if (defs) {
      for (const child of Array.from(defs.children)) {
        if (!EDITOR_DEF_IDS.has(child.id)) child.remove();
      }
    }
  }

  /** Import gradients/patterns/symbols/other defs from a parsed SVG element. */
  importDefsFrom(svgEl: Element): void {
    // Capture any non-standard xmlns prefixes so prefixed content stays valid
    // XML when we re-serialize (see importedNamespaces).
    this.captureNamespaces(svgEl);

    // A file may carry several <defs> blocks (matplotlib scatters one clipPath
    // per <defs>; some tools nest them). Pull every entry, not just the first,
    // or referenced clips/filters silently vanish.
    const defsChildren: Element[] = [];
    for (const defsEl of Array.from(svgEl.querySelectorAll('defs'))) {
      defsChildren.push(...Array.from(defsEl.children));
    }
    if (defsChildren.length === 0) return;

    for (const child of defsChildren) {
      // Skip the editor's own grid/transparency chrome — the canvas already
      // has it, so re-importing would duplicate it (and leak it on re-export).
      if (EDITOR_DEF_IDS.has(child.id)) continue;
      const tag = child.tagName.toLowerCase();

      // Gradients and patterns get a tracked model (they're surfaced in the
      // editor UI). Every other def type — filters, clipPaths, masks, markers,
      // symbols, referenced template geometry — is copied verbatim below so the
      // `url(#…)` / `xlink:href` references in the artwork resolve. Without this,
      // layered SVGs (e.g. Inkscape glow/halo strokes built from <use> + filter)
      // lose their entire appearance.
      if (tag !== 'lineargradient' && tag !== 'radialgradient' && tag !== 'pattern') {
        const imported = document.importNode(child, true) as SVGElement;
        if (!sanitizeSvgElement(imported)) continue;
        this.host.ensureDefs().appendChild(imported);
        // Track symbols so they appear in the Symbols panel and round-trip.
        if (tag === 'symbol') this.host.trackImportedSymbol(imported);
        continue;
      }

      if (tag === 'lineargradient' || tag === 'radialgradient') {
        this.host.importGradientElement(child);
      }
      if (tag === 'pattern') {
        this.host.importPatternElement(child);
      }
    }
  }

  /**
   * Import a foreign SVG so it renders byte-for-byte the way a browser would.
   *
   * Rather than reconstruct the artwork from a whitelist of tags (which dropped
   * `<use>`, filters, clipPaths, masks, markers, … and rewrote every id, breaking
   * the internal `#…` references that drive layered Inkscape/Illustrator output),
   * we faithfully clone the whole tree: every rendering element, every `<defs>`
   * entry, and every original id are preserved so `url(#…)` / `xlink:href` refs
   * still resolve. The editor model is then derived from the live DOM by
   * rebuildShapesFromDOM, which already understands use/group/path/text/…;
   * anything it doesn't model still renders, because the node stays in the DOM.
   */

  // ---- Non-destructive vector append -------------------------------------
  // importSVGContent REPLACES the drawing layer, which is right for opening a
  // document and wrong for every "add this artwork to what I have" gesture — File ▸
  // Append and a canvas drop both silently wiped the open document. This is the
  // append counterpart.

  private appendSeq = 0;

  /**
   * Append a foreign SVG's artwork to the CURRENT document as one `<g>`, returning
   * it un-parented for the caller to position and hand to addShape (which is what
   * gives it a shape id and auto-parents it into the frame under the drop point).
   *
   * Incoming frames are demoted to ordinary groups: frames are top-level-only, and
   * this gesture places artwork rather than merging documents — dropping a
   * BuzzQuill file onto the canvas should not graft its pages into yours. Opening
   * it as its own document (drop on the tab bar) is the gesture that keeps frames.
   */
  appendSVGContent(svgString: string, name: string): SVGGElement | null {
    const doc = new DOMParser().parseFromString(ensureSvgNamespaces(svgString), 'image/svg+xml');
    const svgEl = doc.querySelector('svg');
    if (doc.querySelector('parsererror') || !svgEl) return null;
    this.lastImportHadAnimation = !!svgEl.querySelector(
      'animate, animateTransform, animateMotion, animateColor, set',
    );

    const NON_RENDERING = new Set(['metadata', 'title', 'desc', 'namedview']);
    const staging = document.createElementNS(SVG_NS, 'g');
    const incomingDefs = document.createElementNS(SVG_NS, 'defs');
    for (const child of Array.from(svgEl.children)) {
      const tag = child.localName.toLowerCase();
      if (NON_RENDERING.has(tag)) continue;
      if (tag === 'defs') {
        for (const d of Array.from(child.children)) {
          if (d.id && EDITOR_DEF_IDS.has(d.id)) continue;
          incomingDefs.appendChild(document.importNode(d, true));
        }
        continue;
      }
      if (tag === 'g' && (child as Element).classList.contains('svgmaker-doc')) {
        for (const inner of Array.from(child.children)) staging.appendChild(document.importNode(inner, true));
        continue;
      }
      staging.appendChild(document.importNode(child, true));
    }
    sizeBareInstances(staging, svgEl);
    sanitizeSvgElement(staging);
    sanitizeSvgElement(incomingDefs);
    // Resolve the file's own <style> rules against its own artwork BEFORE any of it
    // joins the document. A class rule applies document-wide and every Illustrator
    // export names its classes .cls-1, .cls-2, … — merged unresolved, the incoming
    // `.cls-1` would repaint existing art that carries the same class.
    this.resolveStagedStyles(incomingDefs, staging);

    // Demote any frames to plain groups, and drop the chrome that only means
    // something to a frame (its clip + background rect).
    for (const f of Array.from(staging.querySelectorAll('[data-frame]'))) {
      f.removeAttribute('data-frame');
      f.removeAttribute('data-frame-w');
      f.removeAttribute('data-frame-h');
      f.querySelectorAll(':scope > clipPath, :scope > .frame-bg').forEach(n => n.remove());
      f.removeAttribute('clip-path');
    }
    // Editor ids would be re-minted anyway; clearing them keeps prefixed junk like
    // "imp1-shape-4" out of the model, which re-ids from scratch on rebuild.
    for (const el of Array.from(staging.querySelectorAll('[id^="shape-"]'))) el.removeAttribute('id');

    markEditorLayers(staging); // same layer handling as a full import
    prefixIds([staging, incomingDefs], `imp${++this.appendSeq}`);

    for (const pathEl of Array.from(staging.querySelectorAll('path'))) {
      const d = pathEl.getAttribute('d');
      if (!d) continue;
      const { d: clean, removed } = sanitizePathData(d);
      if (removed > 0) pathEl.setAttribute('d', clean);
    }

    const defs = this.host.ensureDefs();
    for (const d of Array.from(incomingDefs.children)) {
      const tag = d.localName.toLowerCase();
      if (tag === 'lineargradient' || tag === 'radialgradient') this.host.importGradientElement(d);
      else if (tag === 'pattern') this.host.importPatternElement(d);
      else defs.appendChild(d);
    }

    if (!staging.firstChild) return null;
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('data-name', name);
    while (staging.firstChild) group.appendChild(staging.firstChild);
    // Onto the CHILDREN, not the wrapper. Putting it on the wrapper left the group
    // layer showing a fill that did nothing: the children resolve their own paint,
    // so the group's value is inert SVG, but the Layers/Properties UI still offered
    // it as editable. Applying it where the open path applies it — the top-level
    // imported nodes — keeps every fill the UI shows a fill that actually paints.
    carryRootPresentation(svgEl, Array.from(group.children));
    return group;
  }

  /**
   * {@link resolveAuthorStyles} for artwork not yet in the document: mount it in a
   * throwaway nested `<svg>` just long enough to read computed style (synchronous,
   * so it never paints). Callers sanitize first — this touches the live DOM.
   */
  private resolveStagedStyles(defs: Element, content: Element): void {
    const styles = [...Array.from(defs.querySelectorAll('style')), ...Array.from(content.querySelectorAll('style'))];
    const canvas = this.host.getDrawingLayer().ownerSVGElement;
    if (styles.length === 0 || !canvas) return;
    const probe = document.createElementNS(SVG_NS, 'svg');
    probe.setAttribute('width', '0');
    probe.setAttribute('height', '0');
    probe.append(defs, content);
    canvas.appendChild(probe);
    try {
      resolveAuthorStyles(styles, () =>
        [...Array.from(defs.querySelectorAll('*')), ...Array.from(content.querySelectorAll('*'))]);
    } finally {
      probe.remove();
    }
  }

  importSVGContent(svgString: string): void {
    const doc = new DOMParser().parseFromString(ensureSvgNamespaces(svgString), 'image/svg+xml');
    const svgEl = doc.querySelector('svg');
    if (doc.querySelector('parsererror') || !svgEl) return;
    const layer = this.host.getDrawingLayer();
    // Detect SMIL animation before the sanitizer strips it, so the UI can warn.
    this.lastImportHadAnimation = !!svgEl.querySelector(
      'animate, animateTransform, animateMotion, animateColor, set',
    );
    layer.innerHTML = '';
    this.host.setShapes([]);

    // 1. Bring across the full <defs> so every reference in the artwork resolves.
    this.importDefsFrom(svgEl);

    // 2. Faithfully clone each rendering child, ids and references intact.
    //    The clones are sanitized inside a DETACHED staging group before any of
    //    them touch the live document — stripping event handlers, unsafe hrefs,
    //    and whole blocked elements (incl. a top-level <script>/<foreignObject>).
    const NON_RENDERING = new Set(['defs', 'metadata', 'title', 'desc', 'namedview']);
    const staging = document.createElementNS(SVG_NS, 'g');
    for (const child of Array.from(svgEl.children)) {
      if (NON_RENDERING.has(child.localName.toLowerCase())) continue;
      // A BuzzQuill export wraps its frames in <g class="svgmaker-doc"> — unwrap it
      // (as the project loader does) so the frames land TOP-LEVEL. Otherwise the
      // frame stays nested inside this group and the artboards cache can't see it,
      // tripping the frames-invariant (frames are top-level only).
      if (child.localName.toLowerCase() === 'g' && (child as Element).classList.contains('svgmaker-doc')) {
        for (const inner of Array.from(child.children)) staging.appendChild(document.importNode(inner, true));
        continue;
      }
      staging.appendChild(document.importNode(child, true));
    }
    sizeBareInstances(staging, svgEl);
    sanitizeSvgElement(staging); // off-document; drops blocked roots too
    // No wrapper here (children land top-level), so each one inherits from the root
    // individually — see carryRootPresentation.
    markEditorLayers(staging);
    carryRootPresentation(svgEl, Array.from(staging.children));
    while (staging.firstChild) layer.appendChild(staging.firstChild);

    // 3. Strip Inkscape's degenerate subpaths (anchors collapsed to a point with
    //    control points flung to the origin) — invisible when filled but a stray
    //    line when stroked. The one intentional deviation from raw input.
    for (const pathEl of Array.from(layer.querySelectorAll('path'))) {
      const d = pathEl.getAttribute('d');
      if (!d) continue;
      const { d: clean, removed } = sanitizePathData(d);
      if (removed > 0) pathEl.setAttribute('d', clean);
    }

    // 4. Build the editor model from whatever was imported.
    this.host.rebuild();
    this.host.setSelection([]);
    this.host.saveHistory();
    this.host.onChange();
  }

  /** Load raw SVG innerHTML into the drawing layer (used by the project loader). */
  importSVGMarkup(svgMarkup: string): void {
    // Untrusted file content: sanitize before it touches the live DOM so a
    // crafted .svg/.svgmaker can't smuggle in event handlers or external refs.
    this.host.getDrawingLayer().innerHTML = sanitizeSvgMarkup(svgMarkup);
    this.host.rebuild();
    this.host.setSelection([]);
  }
}

/**
 * Give every `<use>` of a `<symbol>` an explicit size. With no width/height on
 * either, the instance is "100% of the viewport" — which in the file is the
 * file's own viewport, but here is the editor canvas, whose viewBox changes with
 * every zoom: the artwork resized as you zoomed, and nothing downstream (detach,
 * bounds) could know its real size. `source` is the root `<svg>` being imported.
 */
function sizeBareInstances(root: Element, source: SVGSVGElement | Element): void {
  const vb = (source.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const hasBox = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
  const width = hasBox ? vb[2] : parseFloat(source.getAttribute('width') ?? '');
  const height = hasBox ? vb[3] : parseFloat(source.getAttribute('height') ?? '');
  if (!(width > 0 && height > 0)) return;
  for (const use of Array.from(root.querySelectorAll('use'))) {
    const ref = (use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '').replace(/^#/, '');
    const target = ref ? source.querySelector(`[id="${ref.replace(/["\\]/g, '\\$&')}"]`) : null;
    if (!target || target.localName.toLowerCase() !== 'symbol') continue;
    if (!use.hasAttribute('width') && !target.hasAttribute('width')) use.setAttribute('width', String(width));
    if (!use.hasAttribute('height') && !target.hasAttribute('height')) use.setAttribute('height', String(height));
  }
}

/**
 * Drop defs children whose ids nothing in `contentMarkup` references —
 * transitively, so a kept def's own url()/href targets stay too (filter →
 * gradient, marker → paint, gradient → template). Exports used to ship editor
 * chrome (frame overflow masks) and orphaned paste-prefixed filter copies with
 * every file (#220). Children without ids (e.g. <style>) are always kept, and
 * an unparsable block is returned unchanged rather than risk dropping defs.
 * EXPORT-only: saves keep the full defs (a project file may re-reference them).
 */
export function pruneUnusedDefs(defsBlock: string, contentMarkup: string): string {
  if (!defsBlock.trim()) return defsBlock;
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink">${defsBlock}</svg>`,
    'image/svg+xml'
  );
  if (doc.querySelector('parsererror')) return defsBlock;
  const defs = doc.querySelector('defs');
  if (!defs) return defsBlock;
  const refsIn = (s: string): string[] => {
    const out: string[] = [];
    for (const m of s.matchAll(/url\(['"]?#([^)'"]+)['"]?\)/g)) out.push(m[1]);
    for (const m of s.matchAll(/(?:xlink:)?href=["']#([^"']+)["']/g)) out.push(m[1]);
    return out;
  };
  const needed = new Set(refsIn(contentMarkup));
  const children = Array.from(defs.children);
  const kept = new Set<Element>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of children) {
      if (kept.has(c)) continue;
      if (c.id && !needed.has(c.id)) continue;
      kept.add(c);
      for (const r of refsIn(c.outerHTML)) {
        if (!needed.has(r)) { needed.add(r); grew = true; }
      }
    }
  }
  const parts = children.filter(c => kept.has(c)).map(c => c.outerHTML);
  return parts.length ? `<defs>${parts.join('\n')}</defs>\n` : '';
}
