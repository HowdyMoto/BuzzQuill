export interface Point {
  x: number;
  y: number;
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ToolName =
  | 'select' | 'directSelect' | 'rect' | 'ellipse' | 'line' | 'arrow'
  | 'pen' | 'text' | 'hand' | 'zoom'
  | 'eyedropper' | 'star' | 'polygon' | 'frame' | 'crop' | 'shapeBuilder' | 'direction';

export interface ShapeStyle {
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  fillOpacity?: number;   // 0–1, independent of object opacity
  strokeOpacity?: number; // 0–1, independent of object opacity
  // A CONTAINER (group) whose contents paint with more than one colour. `fill` /
  // `stroke` then carry one representative colour, and the panels show "Mixed"
  // instead of implying the whole group is that one colour.
  fillMixed?: boolean;
  strokeMixed?: boolean;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  strokeDasharray?: string;
  strokeDashoffset?: number;
  strokeLinecap?: string;
  strokeLinejoin?: string;
  strokeMiterlimit?: number;
  /** Emulated stroke alignment. SVG has no native property, so inside/outside are
   *  rendered via clip-path + a doubled stroke-width (see stroke-align.ts). */
  strokeAlign?: 'center' | 'inside' | 'outside';
  /** vector-effect: non-scaling-stroke — keep stroke width constant under zoom/scale. */
  strokeNonScaling?: boolean;
  rx?: number;
}

export interface ShapeData {
  id: string;
  type: 'rect' | 'ellipse' | 'line' | 'polyline' | 'path' | 'text' | 'polygon' | 'group' | 'image' | 'use' | 'boolean' | 'frame' | 'appearance' | 'width' | 'repeat' | 'linked';
  element: SVGGraphicsElement;
  name: string;
  style: ShapeStyle;
  visible: boolean;
  locked: boolean;
  children?: ShapeData[];
  parentId?: string;
  rotation?: number;
  symbolId?: string; // for 'use' type, references a symbol in defs
  /** For 'boolean' (live compound shape): which Pathfinder op produced it. The
   *  `children` are the editable operands; a cached <path data-bool-result> child
   *  holds the computed geometry. See core/boolean.ts and AppState.createBoolean. */
  booleanOp?: 'unite' | 'subtract' | 'intersect' | 'exclude';
}

/**
 * One layer of an Appearance stack (Illustrator's Appearance panel): a fill or a
 * stroke painted over the object's geometry. An object with more than one fill or
 * stroke is stored as a `<g data-appearance>` wrapper whose child render-clones
 * are regenerated from this stack; see AppState.setAppearance. Array order is
 * TOP-first: layers[0] paints on top.
 */
export interface AppearanceLayer {
  t: 'fill' | 'stroke';
  paint: string;   // hex colour, gradient/pattern url(...), or 'none'
  opacity: number; // 0–1
  width?: number;  // stroke weight (stroke layers only)
  blend?: string;  // optional mix-blend-mode for this layer
  visible?: boolean; // eye toggle; undefined/true = shown
  // Per-stroke presentation (stroke layers only) — plain SVG attributes on each
  // render-clone. Absent/default values are omitted so the DOM stays clean.
  dash?: string;       // stroke-dasharray, e.g. "5,3"
  dashOffset?: number; // stroke-dashoffset
  cap?: 'butt' | 'round' | 'square';   // stroke-linecap
  join?: 'miter' | 'round' | 'bevel';  // stroke-linejoin
  miter?: number;      // stroke-miterlimit
  nonScaling?: boolean; // vector-effect: non-scaling-stroke
  // Non-destructive perpendicular offset (stroke layers only). The render-clone's
  // geometry becomes the source path shifted sideways by `offset` px (via the
  // paperjs-offset engine); + / − pick the two sides. All strokes derive from the
  // one shared source, so a centre line + parallel lines stay in sync. Editable
  // forever (unlike Path ▸ Offset Path, which bakes new geometry). 0/absent = none.
  offset?: number;
  // The source path has been reversed since this offset was set. The engine's result
  // depends on direction (open paths offset to one side, closed ones outward, curves
  // approximate differently each way), so no sign change can keep the stroke where it
  // is. Instead it is computed from the source walked the original way round.
  offsetReversed?: boolean;
  // A "cut" (knockout) stroke: instead of painting, its shape is punched OUT of
  // every stroke below it in the stack (via a mask). A thin cut down a thick
  // stroke reads as an inline gap / double line, perfectly registered and cheap
  // (no offset geometry). `width` is the gap thickness; `paint` is ignored.
  cut?: boolean;
}

/** Drop-shadow parameters for an object effect (see AppState.setObjectShadow). */
export interface ObjectShadow {
  dx: number;
  dy: number;
  blur: number;
  color: string;
  opacity: number;
}

export interface SymbolDef {
  id: string;
  name: string;
  element: SVGSymbolElement;
}

export interface HistoryEntry {
  svgContent: string;
  selectedId: string | null;
  artboardsJson: string;
}

/** A frame's editor grid (Figma-style layout grid): drawn inside the frame and
 *  optionally snapping moves/resizes. Two modes: 'px' is a uniform fixed-spacing
 *  grid (design rhythm — spacing survives frame resize); 'divisions' splits the
 *  frame into exactly cols × rows parts (composition — the COUNT survives frame
 *  resize, spacing is re-derived, and even counts put a line at the exact
 *  center). Editor chrome — persisted per frame (data-grid-* attributes) but
 *  never part of the exported artwork. */
export interface FrameGrid {
  mode: 'px' | 'divisions';
  size: number;         // px mode: spacing of the finest lines, in px (frame-local)
  cols: number;         // divisions mode: major divisions across the width
  rows: number;         // divisions mode: major divisions down the height
  subdivisions: number; // px: every Nth line is major; divisions: minor cells per division
  color: string;        // hex line colour
  visible: boolean;     // drawn on the canvas
  snap: boolean;        // quantize moves/resizes to this grid
}

export interface Artboard {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
  /** Editor grid config (see FrameGrid); absent when the frame has no grid. */
  grid?: FrameGrid | null;
  /** Whether rulers are shown along this frame's edges. */
  rulers?: boolean;
}

export type ExportFormat = 'svg' | 'png' | 'jpg' | 'bmp' | 'gif' | 'tiff';

/** One row in a frame's export list: a file to produce when the frame is exported.
 *  Lets a single logo fan out to many platform assets (favicon, apple-touch, …),
 *  each with its own filename, format and size. Stored as JSON in the frame's
 *  `data-export-targets` attribute so it round-trips through history/save. */
export interface ExportTarget {
  format: ExportFormat;
  /** Filename base (no extension); the extension is derived from `format`. */
  name: string;
  /** Resolution multiplier over the frame's own size; used when width/height are unset. */
  scale: number;
  /** Optional absolute output width in px (overrides scale). */
  width?: number;
  /** Optional absolute output height in px (overrides scale). */
  height?: number;

  // ---- Per-format options (all optional; each falls back to a sensible default,
  //      documented on the export UI). They round-trip as JSON in data-export-targets.

  /** SVG: how live <text> is handled. Defaults to the document's textExportMode. */
  textMode?: 'keep' | 'outline' | 'embed';
  /** SVG: flatten transforms into geometry. Defaults to the document's bakeTransformsOnExport. */
  bake?: boolean;
  /** Backdrop behind the artwork: 'transparent' or a hex colour. Default: transparent
   *  for SVG/PNG, white for JPG (which can't be transparent). */
  background?: string;
  /** JPG: encode quality 0–1. Default 0.92. Ignored for SVG/PNG. */
  quality?: number;
  /** Where the exported canvas's edges sit: the frame (default), or 'paths' — the
   *  tight bounds of the frame's visible path geometry, so the artwork touches the
   *  edges. Only the viewBox moves; coordinates stay the document's. */
  bounds?: 'frame' | 'paths';
}

// ---- Paint system (gradients & patterns) ----

export interface GradientStop {
  offset: number;  // 0–1
  color: string;   // hex
  opacity: number; // 0–1
}

export interface GradientDef {
  id: string;
  type: 'linear' | 'radial';
  stops: GradientStop[];
  // Linear-specific (objectBoundingBox coords, 0–1)
  x1?: number; y1?: number; x2?: number; y2?: number;
  // Radial-specific
  cx?: number; cy?: number; r?: number; fx?: number; fy?: number;
  spreadMethod?: 'pad' | 'reflect' | 'repeat';
}

/** How a tile repeats. Brick staggers alternate rows/columns by `tileOffset` of a
 *  repeat — an offset of 0.5 is the classic half-drop. SVG `<pattern>` has no native
 *  support for this, so it's baked into an oversized tile (see syncPatternToDefs). */
export type PatternTileType = 'grid' | 'brick-row' | 'brick-col';

export interface PatternDef {
  id: string;
  type: 'preset' | 'image' | 'object';
  // Preset params
  preset?: 'dots' | 'stripes' | 'crosshatch' | 'grid';
  presetColor?: string;
  /** Mark thickness in px — stroke width for line presets, dot diameter for dots.
   *  Deliberately INDEPENDENT of `scale`/`tileWidth`: thickness and spacing used to
   *  be locked to each other (thickness = 2*scale, period = 20*scale), so stripes
   *  were always ten times further apart than they were thick and tight hatching
   *  was unreachable. Undefined on pre-`weight` patterns — see `presetWeight()`. */
  weight?: number;
  // Image params
  imageDataUrl?: string;
  // Object params — a tile drawn from your own artwork. The markup is normalized to
  // the origin at creation, so rendering only has to scale it.
  sourceMarkup?: string;
  /** LINKED pattern: the shape id this tile mirrors. Present ⇒ the tile re-captures
   *  from that object whenever the document rebuilds. Absent ⇒ a plain copy. If the
   *  source disappears the id is dropped and the captured markup stays, so the fill
   *  freezes as a copy rather than breaking. */
  sourceId?: string;
  // Shared tiling
  tileType?: PatternTileType;
  /** 0..1 of a repeat; only meaningful for the brick types. Defaults to 0.5. */
  tileOffset?: number;
  // Shared
  scale: number;      // multiplier, 1 = natural size
  rotation: number;   // degrees
  spacing: number;    // px gap around tile
  tileWidth: number;
  tileHeight: number;
}
