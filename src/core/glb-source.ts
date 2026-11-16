import type { AppState } from './state';
import type { EmbeddedFont } from './embedded-fonts';
import { stripBooleanOperands } from './boolean';
import { normalizeTextStrokesForExport } from './text-stroke';
import { stripHiddenForExport } from './export-scope';
import { SVG_NS_DECLS } from './svg-ns';
import { pinAssets } from './raster-assets';

export interface GlbSnapshot {
  generation?: number;
  release?: () => void;
  svg: string;
  fonts: EmbeddedFont[];
  selected: string[];
  layers: { id: string; name: string }[];
  frames: { id: string; name: string; x: number; y: number; width: number; height: number }[];
}
/** Capture synchronously before any dependency load, so tab switches cannot mix documents. */
export function captureGlbSnapshot(state: AppState): GlbSnapshot {
  const viewport = document.getElementById('drawing-layer')?.closest('svg')?.viewBox.baseVal;
  const dimensions = viewport && viewport.width > 0 && viewport.height > 0 ? ` viewBox="${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}" width="${viewport.width}" height="${viewport.height}"` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" ${SVG_NS_DECLS}${state.getExtraNamespaceDecls()}${dimensions}>${state.getDefsBlock()}<g data-glb-content="true">${state.getDrawingLayerSVG()}</g></svg>`;
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  return { svg, generation: state.documentGeneration, release: pinAssets(svg), fonts: [...state.embeddedFonts], selected: [...state.selectedShapeIds],
    layers: Array.from(doc.querySelectorAll('[data-glb-content] [id]')).filter(e => /^shape-/.test(e.id)).map(e => ({ id: e.id, name: e.getAttribute('data-name') || e.id })),
    frames: state.framesInPageOrder.map(f => ({ ...f })) };
}

/** Prune siblings, keeping ancestors (and their transforms/clips) and referenced definitions. */
export function sourceSvg(snapshot: GlbSnapshot, ids: string[] | null, excluded: string[] = [], explicit = false): SVGSVGElement {
  const doc = new DOMParser().parseFromString(snapshot.svg, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('The export snapshot contains invalid SVG markup.');
  const root = doc.documentElement as unknown as SVGSVGElement;
  const content = root.querySelector('[data-glb-content]')!;
  if (ids) {
    const keep = new Set<Element>();
    for (const id of ids) {
      const el = Array.from(content.querySelectorAll('[id]')).find(e => e.id === id);
      if (!el) throw new Error(`Source layer ${id} is missing. Choose another source.`);
      for (const child of [el, ...el.querySelectorAll('*')]) keep.add(child);
      for (let p: Element | null = el; p && p !== content; p = p.parentElement) {
        keep.add(p);
        if (explicit) { p.removeAttribute('display'); (p as SVGElement).style.removeProperty('display'); p.removeAttribute('visibility'); (p as SVGElement).style.removeProperty('visibility'); }
      }
    }
    const prune = (el: Element) => {
      for (const child of Array.from(el.children)) {
        if (['defs', 'clipPath', 'mask', 'style'].includes(child.tagName)) continue;
        if (!keep.has(child)) child.remove(); else prune(child);
      }
    };
    prune(content);
  }
  for (const el of Array.from(content.querySelectorAll('[id]'))) if (excluded.includes(el.id)) el.remove();
  stripBooleanOperands(root);
  normalizeTextStrokesForExport(root);
  for (const g of root.querySelectorAll('g[data-frame]')) {
    g.removeAttribute('mask');
    const clip = g.querySelector(':scope > clipPath');
    if (clip?.id) g.setAttribute('clip-path', `url(#${clip.id})`);
  }
  stripHiddenForExport(root);
  // Freeze SVG lengths before texture baking changes the viewport. AnimatedLength.value
  // resolves %, physical units and inherited viewport context in browser user units.
  const unmount = mountGlbSvg(root);
  try {
    for (const el of root.querySelectorAll('rect,circle,ellipse,line,image,svg,use')) {
      for (const name of ['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2']) {
        const raw = el.getAttribute(name);
        if (!raw || !/[a-z%]/i.test(raw.replace(/e[+-]?\d+/gi, ''))) continue;
        const length = (el as unknown as Record<string, SVGAnimatedLength>)[name];
        if (length?.baseVal && Number.isFinite(length.baseVal.value)) el.setAttribute(name, String(length.baseVal.value));
        else throw new Error(`${el.id || el.tagName}: unable to resolve ${name}.`);
      }
    }
  } finally { unmount(); }
  return root;
}

/** Shadow isolation keeps snapshot IDs/styles from interacting with the editor. */
export function mountGlbSvg(svg: SVGSVGElement): () => void {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none;opacity:0';
  host.attachShadow({ mode: 'closed' }).append(svg);
  document.body.append(host);
  return () => host.remove();
}
