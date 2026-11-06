// ---------------------------------------------------------------------------
// Markers — arrowheads / dots on line & path ends.
//
// The marker-start/marker-end presentation attributes round-trip through the
// history snapshot; the shared <marker> library lives in <defs> and is rebuilt by
// ensureMarkerDefs() (defs aren't snapshotted). fill="context-stroke" makes each
// arrowhead match its path's stroke colour.
//
// Extracted from AppState as a collaborator (see EffectsManager / ClipboardManager
// / SymbolRegistry): it reaches AppState only through the MarkersHost seam.
// ---------------------------------------------------------------------------

import { MARKER_PRESETS } from './marker-presets';

const SVG = 'http://www.w3.org/2000/svg';

export interface MarkersHost {
  ensureDefs(): SVGDefsElement;
  findShapeElement(id: string): SVGElement | null;
  selectionElements(): SVGElement[];
  saveHistory(): void;
  onChange(): void;
}

export class MarkersManager {
  private host: MarkersHost;
  constructor(host: MarkersHost) { this.host = host; }

  /** Create the standard marker library in <defs> once (idempotent). */
  ensureDefs(): void {
    const defs = this.host.ensureDefs();
    for (const preset of MARKER_PRESETS) {
      if (defs.querySelector(`[id="${preset.id}"]`)) continue;
      const m = document.createElementNS(SVG, 'marker');
      m.setAttribute('id', preset.id);
      m.setAttribute('viewBox', '0 0 10 10');
      m.setAttribute('markerUnits', 'strokeWidth');
      m.setAttribute('orient', 'auto-start-reverse');
      m.setAttribute('markerWidth', String(preset.size)); m.setAttribute('markerHeight', String(preset.size));
      m.setAttribute('refX', String(preset.refX)); m.setAttribute('refY', '5');
      m.innerHTML = preset.svg;
      defs.appendChild(m);
    }
  }

  get(id: string): { start: string; end: string } {
    const el = this.host.findShapeElement(id);
    const read = (attr: string) => el?.getAttribute(attr)?.match(/url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/)?.[1] ?? '';
    return { start: read('marker-start'), end: read('marker-end') };
  }

  private applyTo(el: SVGElement, pos: 'start' | 'end', markerId: string | null): void {
    const attr = `marker-${pos}`;
    if (markerId) el.setAttribute(attr, `url(#${markerId})`);
    else el.removeAttribute(attr);
  }

  set(id: string, pos: 'start' | 'end', markerId: string | null): void {
    const el = this.host.findShapeElement(id);
    if (!el) return;
    this.ensureDefs();
    this.applyTo(el, pos, markerId);
    this.host.saveHistory();
    this.host.onChange();
  }

  /** Apply a marker to every selected object in a single undo step. */
  setSelection(pos: 'start' | 'end', markerId: string | null): void {
    this.ensureDefs();
    for (const el of this.host.selectionElements()) this.applyTo(el, pos, markerId);
    this.host.saveHistory();
    this.host.onChange();
  }
}
