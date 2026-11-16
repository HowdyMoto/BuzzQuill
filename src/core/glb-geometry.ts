import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { ShapeUtils, type Shape, type Vector2 } from 'three';
import { computeBoolean, ensureOffsetEngine, localPathData, outlineStrokeData, strokeOrderPathData } from './boolean';
import { transformPathData, parsePath } from './path-model';
import { matrixBetween, matrixToAncestor } from './coords';
import { mountGlbSvg } from './glb-source';
import { escapeHtml } from './markup-escape';

const loader = new SVGLoader();
export interface GlbRect { x: number; y: number; width: number; height: number }
function shapes(d: string, rule = 'nonzero'): Shape[] {
  return loader.parse(`<svg xmlns="http://www.w3.org/2000/svg"><path fill-rule="${rule}" d="${escapeHtml(d)}"/></svg>`).paths.flatMap(p => p.toShapes());
}
function ring(points: Vector2[], clockwise: boolean): string {
  if (ShapeUtils.isClockWise(points) !== clockwise) points.reverse();
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ') + 'Z';
}
function normalized(d: string, rule: string, segments: number): string {
  return shapes(d, rule).map(s => ring(s.getPoints(segments), true) + s.holes.map(h => ring(h.getPoints(segments), false)).join('')).join('');
}
function unite(ds: string[]): string { return computeBoolean(ds, 'unite').join(''); }

/** Convert rendered vector contours, strokes and vector clips to one planar region. */
export async function glbGeometry(svg: SVGSVGElement, quality: string, bounds?: GlbRect, mode: 'silhouette' | 'painted' = 'painted'): Promise<{ shapes: Shape[]; rect: GlbRect; warnings: string[] }> {
  await ensureOffsetEngine();
  const segments = quality === 'high' ? 48 : quality === 'draft' ? 8 : 24;
  const unmount = mountGlbSvg(svg);
  const warnings = new Set<string>();
  const clipping = new Set<string>();
  const rootContent = svg.querySelector('[data-glb-content]') as SVGGraphicsElement;
  const label = (el: Element) => el.getAttribute('data-name') || el.id || el.tagName;
  const pathOf = (el: SVGGraphicsElement, clip = false): string => {
    const cs = getComputedStyle(el);
    const length = (value: string): number => {
      const n = parseFloat(value);
      if (!value.endsWith('%')) return n;
      const viewport = el.viewportElement as SVGSVGElement | null;
      const vb = viewport?.viewBox?.baseVal;
      const w = vb?.width || viewport?.width?.baseVal.value || 300;
      const h = vb?.height || viewport?.height?.baseVal.value || 150;
      return n / 100 * Math.hypot(w, h) / Math.SQRT2;
    };
    if (cs.display === 'none' || Number(cs.opacity) === 0) return '';
    if (['defs', 'clipPath', 'mask', 'style', 'metadata', 'title', 'desc'].includes(el.tagName)) return '';
    if (el.tagName === 'image') return '';
    if (['use', 'text', 'foreignObject'].includes(el.tagName)) throw new Error(`${label(el)}: convert ${el.tagName} to paths before 3D export.`);
    if (cs.filter !== 'none' || cs.maskImage !== 'none' || el.hasAttribute('mask')) warnings.add(`${label(el)}: filters and soft masks affect appearance only.`);
    let d = localPathData(el);
    if (d) {
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return '';
      const pieces: string[] = [];
      const subpaths = mode === 'silhouette' ? parsePath(d, 1e-6).subpaths : [];
      const silhouette = !clip && mode === 'silhouette' && !el.classList.contains('frame-bg') && subpaths.length > 0 && subpaths.every(p => p.closed);
      if (clip || silhouette || (cs.fill !== 'none' && Number(cs.fillOpacity) > 0)) pieces.push(normalized(d, clip ? cs.clipRule : cs.fillRule, segments));
      if (!clip && !silhouette && cs.stroke !== 'none' && length(cs.strokeWidth) > 0 && Number(cs.strokeOpacity) > 0) {
        if ([cs.markerStart, cs.markerMid, cs.markerEnd].some(v => v && v !== 'none')) throw new Error(`${label(el)}: convert arrowheads/markers to paths before 3D export.`);
        if (cs.vectorEffect === 'non-scaling-stroke') throw new Error(`${label(el)}: outline the non-scaling stroke before 3D export.`);
        const renderedLength = (el as SVGGeometryElement).getTotalLength();
        const authoredLength = Number(el.getAttribute('pathLength'));
        const dashScale = authoredLength > 0 ? renderedLength / authoredLength : 1;
        const stroke = outlineStrokeData(strokeOrderPathData(el), length(cs.strokeWidth), cs.strokeLinejoin as 'miter' | 'round' | 'bevel', cs.strokeLinecap as 'butt' | 'round' | 'square', {
          miterLimit: parseFloat(cs.strokeMiterlimit), renderedLength,
          dash: cs.strokeDasharray === 'none' ? undefined : cs.strokeDasharray.split(/[ ,]+/).map(v => length(v) * dashScale), dashOffset: length(cs.strokeDashoffset) * dashScale,
        });
        if (!stroke) throw new Error(`${label(el)}: stroke could not be outlined.`);
        pieces.push(stroke);
      }
      const matrix = matrixBetween(svg, el);
      if (!matrix) throw new Error(`${label(el)}: unable to resolve transform.`);
      d = transformPathData(unite(pieces), matrix);
    } else d = unite(Array.from(el.children).filter((e): e is SVGGraphicsElement => e instanceof SVGGraphicsElement).map(e => pathOf(e, clip)));
    if (d && el.tagName === 'svg' && ['hidden', 'scroll', 'auto', 'clip'].includes(cs.overflow)) {
      const viewport = el as SVGSVGElement;
      const parent = el.parentElement as unknown as SVGGraphicsElement;
      const parentMatrix = matrixBetween(svg, parent);
      if (!parentMatrix) throw new Error(`${label(el)}: unable to resolve nested viewport.`);
      const m = DOMMatrix.fromMatrix(parentMatrix).multiply(matrixToAncestor(el, parent));
      const x = viewport.x.baseVal.value, y = viewport.y.baseVal.value, w = viewport.width.baseVal.value, h = viewport.height.baseVal.value;
      const clipD = transformPathData(`M${x},${y}h${w}v${h}h${-w}Z`, m);
      d = computeBoolean([d, clipD], 'intersect').join('');
    }
    if (d && cs.clipPath !== 'none') {
      const id = cs.clipPath.match(/#([^"')]+)["']?\)/)?.[1];
      const def = Array.from(svg.querySelectorAll('clipPath')).find(c => c.id === id);
      if (!def) throw new Error(`${label(el)}: unresolved clipping path.`);
      if (clipping.has(def.id)) throw new Error(`${label(el)}: circular clipping reference.`);
      // Clip coordinates are in the clipped element's own user space. Mount a copy there.
      const wrapper = document.createElementNS(svg.namespaceURI, 'g') as SVGGElement;
      const targetMatrix = matrixBetween(svg, el);
      if (!targetMatrix) throw new Error(`${label(el)}: unable to resolve clip transform.`);
      let prefix = `matrix(${targetMatrix.a} ${targetMatrix.b} ${targetMatrix.c} ${targetMatrix.d} ${targetMatrix.e} ${targetMatrix.f})`;
      if (def.getAttribute('clipPathUnits') === 'objectBoundingBox') {
        const box = el.getBBox(); prefix += ` translate(${box.x} ${box.y}) scale(${box.width} ${box.height})`;
      }
      wrapper.setAttribute('transform', `${prefix} ${def.getAttribute('transform') || ''}`);
      wrapper.setAttribute('clip-rule', getComputedStyle(def).clipRule);
      const nestedClip = getComputedStyle(def).clipPath;
      if (nestedClip !== 'none') wrapper.setAttribute('clip-path', nestedClip);
      for (const child of def.children) wrapper.append(child.cloneNode(true));
      svg.append(wrapper); clipping.add(def.id);
      let clipD: string;
      try { clipD = pathOf(wrapper, true); } finally { wrapper.remove(); clipping.delete(def.id); }
      d = clipD ? computeBoolean([d, clipD], 'intersect').join('') : '';
    }
    return d;
  };
  try {
    let d = pathOf(rootContent);
    if (bounds) {
      const { x, y, width: w, height: h } = bounds;
      d = d ? computeBoolean([d, `M${x},${y}h${w}v${h}h${-w}Z`], 'intersect').join('') : '';
    }
    const result = shapes(d);
    if (!result.length) throw new Error('No filled vector geometry in this source. Choose a vector outline.');
    const pts = result.flatMap(s => s.getPoints(segments));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const rect = bounds ?? { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    if (!(rect.width > 0 && rect.height > 0)) throw new Error('Geometry has no area.');
    return { shapes: result, rect, warnings: [...warnings] };
  } finally { unmount(); }
}
