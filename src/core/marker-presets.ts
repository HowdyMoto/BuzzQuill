/** Shared geometry for rendered SVG markers and their picker previews. Existing
 * marker IDs and dimensions are stable so saved artwork keeps its appearance. */
export const MARKER_PRESETS = [
  { id: 'mk-arrow', label: 'Triangle arrow', size: 8, refX: 9, svg: '<path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/>' },
  { id: 'mk-open', label: 'Line arrow', size: 9, refX: 8, svg: '<path d="M1,1 L9,5 L1,9" fill="none" stroke="context-stroke" stroke-width="1.5"/>' },
  { id: 'mk-dot', label: 'Circle', size: 6, refX: 5, svg: '<circle cx="5" cy="5" r="4" fill="context-stroke"/>' },
  { id: 'mk-diamond', label: 'Diamond', size: 6, refX: 5, svg: '<path d="M0,5 L5,0 L10,5 L5,10 Z" fill="context-stroke"/>' },
  { id: 'mk-triangle', label: 'Inward triangle', size: 6, refX: 8.66, svg: '<path d="M0,5 L8.66,0 L8.66,10 Z" fill="context-stroke"/>' },
  { id: 'mk-square', label: 'Square', size: 5, refX: 5, svg: '<path d="M1,1 H9 V9 H1 Z" fill="context-stroke"/>' },
  { id: 'mk-bar', label: 'Bar', size: 5, refX: 5, svg: '<path d="M4,0 H6 V10 H4 Z" fill="context-stroke"/>' },
] as const;
