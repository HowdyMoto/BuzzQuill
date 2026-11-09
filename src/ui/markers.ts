import { StrokePicker, CAP_CHOICES, endChoices } from './stroke-picker';
/**
 * Stroke-geometry controls for the Stroke panel, all path-level (they apply to
 * the whole shape / every stroke, not per-stroke — matching how designers think):
 *   • Cap — the shape of the stroke ENDS (flat / round / square). Open paths only.
 *   • Corners (join) — the shape of the CORNERS where segments meet (miter /
 *     round / bevel). Cornered shapes only. The miter LIMIT keeps its SVG default
 *     of 4 (auto-flattens only extremely sharp corners); no confusing limit field.
 *   • Markers — arrowheads / dots on the start and end (the shared <marker>
 *     library lives in defs; state owns the marker-* attributes). Open paths only.
 * All applied via AppState.setSelectionStrokeCap / setSelectionStrokeJoin /
 * setSelectionMarker, which handle plain and appearance-wrapped shapes alike.
 */

import type { AppState } from '../core/state';
import type { ShapeData } from '../core/types';

const OPEN_SHAPES = new Set(['line', 'polyline', 'path']);    // have ends → cap + markers
const CORNER_SHAPES = new Set(['polyline', 'polygon', 'path', 'rect']); // have corners → join
let capPicker: StrokePicker;
let startPicker: StrokePicker;
let endPicker: StrokePicker;
const JOINS = ['miter', 'round', 'bevel'] as const;

/** The uniform cap/join of a shape's stroke(s): the element's attr for a plain
 *  shape, the (first) stroke layer's value for an appearance-wrapped one. */
function shapeCap(state: AppState, shape: ShapeData): string | null {
  if (shape.type === 'appearance') {
    const caps = state.getAppearance(shape.id).filter(l => l.t === 'stroke').map(l => l.cap ?? 'butt');
    return caps.every(c => c === caps[0]) ? caps[0] ?? 'butt' : null;
  }
  return shape.element.getAttribute('stroke-linecap') || 'butt';
}
function shapeJoin(state: AppState, shape: ShapeData): string {
  if (shape.type === 'appearance') return state.getAppearance(shape.id).find(l => l.t === 'stroke')?.join ?? 'miter';
  return shape.element.getAttribute('stroke-linejoin') || 'miter';
}

export function setupMarkers(state: AppState): void {
  capPicker = new StrokePicker(document.getElementById('prop-cap-picker') as HTMLButtonElement, CAP_CHOICES, 'Cap style', value => {
    if (state.selectedShapeIds.length) state.setSelectionStrokeCap(value as 'butt' | 'round' | 'square');
  });
  startPicker = new StrokePicker(document.getElementById('mk-start') as HTMLButtonElement, endChoices(true), 'Start', value => {
    if (state.selectedShapeIds.length) state.setSelectionMarker('start', value || null);
  });
  endPicker = new StrokePicker(document.getElementById('mk-end') as HTMLButtonElement, endChoices(false), 'End', value => {
    if (state.selectedShapeIds.length) state.setSelectionMarker('end', value || null);
  });

  document.querySelectorAll<HTMLButtonElement>('#prop-join-buttons button').forEach(btn => {
    btn.addEventListener('click', () => {
      const join = btn.getAttribute('data-join');
      if (state.selectedShapeIds.length && (JOINS as readonly string[]).includes(join ?? '')) {
        state.setSelectionStrokeJoin(join as typeof JOINS[number]);
      }
    });
  });
}

export function updateMarkersPanel(state: AppState): void {
  const single = state.selectedShapeIds.length >= 1 ? state.getSelectedShape() : null;
  const setActive = (sel: string, attr: string, value: string) =>
    document.querySelectorAll(`${sel} button`).forEach(b => b.classList.toggle('active', b.getAttribute(attr) === value));
  const showRow = (id: string, on: boolean) => { const r = document.getElementById(id); if (r) r.style.display = on ? '' : 'none'; };

  // Cap — open (has-ends) shapes.
  const geometryType = single?.type === 'appearance'
    ? single.element.querySelector('[data-ap-src]')?.tagName.toLowerCase() : single?.type;
  const openShape = !!geometryType && OPEN_SHAPES.has(geometryType);
  showRow('prop-cap-row', openShape);
  const uniform = (values: (string | null)[]) => values.every(v => v === values[0]) ? values[0] : null;
  if (openShape && single) capPicker.update(uniform(state.getSelectedShapes().map(s => shapeCap(state, s))));

  // Corners (join) — cornered shapes.
  const cornerShape = !!geometryType && CORNER_SHAPES.has(geometryType);
  showRow('prop-join-row', cornerShape);
  if (cornerShape && single) setActive('#prop-join-buttons', 'data-join', shapeJoin(state, single));

  // Markers (arrowheads) — open shapes.
  showRow('prop-markers-row', openShape);
  if (openShape && single) {
    const markers = state.getSelectedShapes().map(s => state.getMarkers(s.id));
    startPicker.update(uniform(markers.map(m => m.start)));
    endPicker.update(uniform(markers.map(m => m.end)));
  }
}
