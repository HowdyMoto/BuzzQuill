// ---------------------------------------------------------------------------
// Design tokens for the TypeScript / canvas layer.
//
// The CSS custom properties in style.css are the source of truth for chrome
// (panels, menus, buttons). But a lot of the editor's visuals are SVG overlay
// elements created in TS — selection handles, marquees, tool previews, artboard
// chrome — whose colors are written as presentation attributes and so can't read
// a CSS variable. Those values used to be hardcoded hex literals scattered across
// the tools/ and ui/ files (the selection blue alone appeared 22× in 8 files,
// and had drifted from the CSS accent). This module is their single home.
//
// Keep in sync with style.css where a value lives in both worlds.
// ---------------------------------------------------------------------------

export const tokens = {
  /**
   * On-canvas selection / active-overlay accent: selection handles & marquees,
   * pen/polyline previews, the selected-artboard border, rotation widgets.
   * This is the brighter on-canvas blue — intentionally distinct from the UI
   * chrome accent (`--ai-accent` in CSS), but defined once here so the overlay
   * layer stays consistent and themeable.
   */
  selectionAccent: '#20a0ff',

  /**
   * Container "visual language" — shared by the canvas outlines AND the Layers-panel
   * rails (mirror these in style.css: --ai-frame / --ai-frame-dim / --ai-mask /
   * --ai-mask-dim). A FRAME reads azure, a MASK reads violet; each has a BRIGHT
   * identity hue (selected/entered) and a MUTED chrome hue (persistent, always-on).
   * Plain groups get no hue (neutral grey) — absence of colour means "ordinary group".
   * On canvas a second, redundant axis carries the meaning for colour-blind/greyscale
   * viewers: SOLID stroke = frame, DASHED stroke = mask.
   */
  frameChrome: '#4f88c4', // muted azure — persistent (unselected) frame border/rail
  maskAccent: '#a06bff',  // bright violet — selected/entered mask
  maskChrome: '#7d5bc0',  // muted violet — persistent mask outline/rail

  /** Direction overlay: where a path starts and ends. Green = go. The two also differ
   *  in SHAPE (a play-button circle vs a stop square), so colour isn't the only cue. */
  directionStart: '#16a34a',
  directionEnd: '#475569',
} as const;
