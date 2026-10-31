// Shared inline-SVG glyphs used across the UI (Layers panel, and the design-
// system reference page). Single source of truth so every surface stays in sync.
//
// All glyphs are monochrome and inherit `currentColor`, so they take on the
// colour of whatever context they're dropped into (dim grey in a panel row,
// brighter on hover, white when a row is selected).

/** Download-arrow glyph for the per-frame quick-export button. */
export const ICON_EXPORT =
  '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 2v7m0 0 3-3m-3 3L5 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 11v2h10v-2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

// Minimalist, monochrome toggle glyphs — flat line icons on a 24-unit grid (the
// proportions used by well-tuned icon sets). Locked is a FILLED padlock and
// unlocked an OUTLINE one, so the fill itself signals state.
const SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
const EYE_LENS = 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z';

/** Layer visibility toggle — open eye (shown) / slashed eye (hidden). */
export const ICON_EYE =
  `${SVG}<path d="${EYE_LENS}"/><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/></svg>`;
export const ICON_EYE_OFF =
  `${SVG}<path d="${EYE_LENS}"/><path d="M4.5 19.5 19.5 4.5"/></svg>`;

/** Layer lock toggle — filled padlock (locked) / outline padlock (unlocked). */
export const ICON_LOCK =
  `${SVG}<path d="M8 11V7.5a4 4 0 0 1 8 0V11"/><path fill="currentColor" stroke="none" fill-rule="evenodd" d="M6.5 10.5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Zm5.5 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/></svg>`;
export const ICON_UNLOCK =
  `${SVG}<path d="M8 11V7.5a4 4 0 0 1 7-2"/><rect x="4.5" y="10.5" width="15" height="10" rx="2"/></svg>`;

/** Shape-type kinds that have a Layers-panel icon (also drives the icon gallery). */
export const SHAPE_ICON_TYPES = [
  'rect', 'ellipse', 'line', 'polyline', 'polygon', 'path',
  'text', 'group', 'frame', 'mask', 'image', 'use', 'boolean',
] as const;

/** Small monochrome glyph for a shape/layer type, sized for the Layers panel. */
export function getShapeIcon(type: string): string {
  switch (type) {
    // A linked file: a page with a chain link, so it never reads as a plain group.
    case 'linked': return '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M3 2h6l4 4v8H3z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.5 10.5a1.8 1.8 0 0 1 0-2.5l1-1a1.8 1.8 0 0 1 2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
    case 'rect': return '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="2" y="3" width="12" height="10" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    case 'ellipse': return '<svg viewBox="0 0 16 16" width="12" height="12"><ellipse cx="8" cy="8" rx="6" ry="5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    case 'line': return '<svg viewBox="0 0 16 16" width="12" height="12"><line x1="2" y1="14" x2="14" y2="2" stroke="currentColor" stroke-width="1.5"/></svg>';
    case 'polyline': return '<svg viewBox="0 0 16 16" width="12" height="12"><polyline points="2,14 6,4 10,10 14,2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    case 'polygon': return '<svg viewBox="0 0 16 16" width="12" height="12"><polygon points="8,2 14,6 12,14 4,14 2,6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    case 'path': return '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M2 14 Q8 2 14 8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    case 'text': return '<svg viewBox="0 0 16 16" width="12" height="12"><text x="8" y="13" text-anchor="middle" font-size="12" font-weight="bold" fill="currentColor">T</text></svg>';
    case 'group': return '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="1" y="3" width="8" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="5" y="6" width="8" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
    case 'frame': return '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M5 1v14M11 1v14M1 5h14M1 11h14" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
    // A clip mask (data-clip-group). A masquerade / domino eye-mask reads instantly
    // as "mask" even at panel size — eye-holes cut with fill-rule=evenodd.
    case 'mask': return '<svg viewBox="0 0 16 16" width="12" height="12"><path fill-rule="evenodd" d="M1.6 6.4C1.6 5 2.6 4.3 3.9 4.4 5.5 4.5 6.7 5.1 8 5.3 9.3 5.1 10.5 4.5 12.1 4.4 13.4 4.3 14.4 5 14.4 6.4 14.4 9.1 12.8 11 10.7 11 9.2 11 8.6 9.8 8 9.8 7.4 9.8 6.8 11 5.3 11 3.2 11 1.6 9.1 1.6 6.4Z M5.3 6A1.2 1.35 0 1 0 5.3 8.4 1.2 1.35 0 1 0 5.3 6Z M10.7 6A1.2 1.35 0 1 0 10.7 8.4 1.2 1.35 0 1 0 10.7 6Z" fill="currentColor"/></svg>';
    case 'image': return '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="6" cy="6" r="1.5" fill="currentColor"/><polyline points="2,12 6,8 9,10 12,6 14,9" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
    case 'use': return '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
    case 'boolean': return '<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="6" cy="8" r="4.5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="10" cy="8" r="4.5" fill="currentColor" fill-opacity="0.35" stroke="currentColor" stroke-width="1.2"/></svg>';
    case 'appearance': return '<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="6" cy="6" r="4" fill="currentColor" fill-opacity="0.35"/><circle cx="10" cy="10" r="4" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
    case 'width': return '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M1 8 Q8 4 15 8 Q8 12 1 8 Z" fill="currentColor" fill-opacity="0.5"/></svg>';
    default: return '';
  }
}
