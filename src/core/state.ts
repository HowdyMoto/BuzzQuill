import type { ToolName, ShapeData, HistoryEntry, ShapeStyle, Artboard, SymbolDef, GradientDef, GradientStop, PatternDef, ObjectShadow, AppearanceLayer, FrameGrid, Point, ExportTarget } from './types';
import { sanitizeSvgMarkup } from './svg-sanitize';
import { PathEditSession } from './path-edit';
import { History, type HistorySnapshot } from './history';
import { PaintRegistry } from './paint-registry';
import { ClipboardManager, type ClipboardHost } from './clipboard';
import { SymbolRegistry, type SymbolHost } from './symbol-registry';
import { EffectsManager, type EffectsHost } from './effects';
import { MarkersManager, type MarkersHost } from './markers';
import { AppearanceManager, type AppearanceHost } from './appearance';
import { WidthStrokeManager, type WidthStrokeHost } from './width-stroke';
import { RepeatManager, type RepeatHost, type RepeatConfig } from './repeat';
import { PathfinderManager, type PathfinderHost } from './pathfinder';
import { CornerManager, type CornerHost } from './corners';
import { PathJoinManager, type PathJoinHost } from './path-join';
import { PathDirectionManager, type PathDirectionHost, type ReverseResult } from './path-direction';
import { LayerManager, type LayerHost } from './layers';
import {
  TextStyleRegistry, isTextStyleTarget, readTextStyleProps, applyTextStyleProps, overriddenKeys,
  type TextStyle, type TextStyleProps,
} from './text-styles';
import { LibraryRegistry, type AssetType, type LibraryAsset, type PaintStylePayload } from './library';
import { StyleLinkManager, type StyleLinkHost, LINK_ATTR } from './library-styles';
import { LinkedFileManager, type LinkedFileInfo } from './linked-files';
import { EmbeddedFontRegistry, type EmbeddedFont } from './embedded-fonts';
import { nudgeTranslate, getRotation } from './transform';
import { localBBoxInLayer, visualWorldBBox, matrixBetween } from './coords';
import { isLockedEl } from './locks';
import { isModeledShapeEl } from './shape-props';
import { effectivePaint, ownedPaint, containerPaint, isPlainGroup, inheritsPaint } from './effective-paint';
import { reflectionMatrix, flipElement, type FlipAxis } from './flip';
import { outlineLiveText } from './text-outline';
import { readRectBox, type Radii } from './rect-shape';
import { applyStrokeAlignment, STROKE_CLIP_PREFIX } from './stroke-align';
import { refreshTextStrokeOutlines } from './text-stroke';
import {
  type BooleanOp,
  ensureBooleanEngine, booleanEngineReady,
} from './boolean';
import { shapeToPathData, GEOM_ATTRS, parsePointsList, dropParametricAttrs } from './shape-adapters';
import { FrameChromeManager, gridSteps, type FrameChromeHost } from './frame-chrome';
import { SvgIoManager, type SvgIoHost, EDITOR_DEF_IDS } from './svg-io';
import { resolveAuthorStyles } from './author-styles';
import { CompositingManager, type CompositingHost } from './compositing';
import { SelectionStyleManager, type SelectionStyleHost } from './selection-style';
import { PatternLinkManager, type PatternLinkHost } from './pattern-links';
import { xmlSafeMarkup } from './xml-safe';
import type { WidthPoint } from './variable-width';

/**
 * Built-in editor chrome that lives in the canvas <defs> (the grid background
 * and transparency checkerboard). It must never be exported or re-imported:
 * their tiny corner paths render as stray lines in tools that read raw <path>
 * geometry and ignore <defs>/<pattern> structure (e.g. TraceCraft).
 */

/**
 * Above this many rendered elements, a document is treated as a bulk/generative
 * import: rebuildShapesFromDOM stops auto-assigning ids to id-less elements
 * (which would model each as its own Layers-panel row). Normal artwork is far
 * below this; it only excludes pathological files (e.g. a 21MB attractor with
 * 100k segments) where per-element layers are useless and prohibitively slow.
 */
const AUTO_ID_MODEL_LIMIT = 20000;

/**
 * Paint/style properties promoted from an inline `style` attribute to the
 * equivalent presentation attribute on import, so the editor's attribute-based
 * model can read and write them. See {@link AppState.flattenInlineStyle}.
 */
const FLATTEN_PROPS = [
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'opacity',
  'font-size', 'font-family', 'font-weight', 'font-style', 'rx',
];

/** The editor's own chrome in the canvas <defs> — never author content. */
const EDITOR_DEFS_SELECTOR = [...EDITOR_DEF_IDS].map((id) => `#${id}`).join(', ');

/** Paint props flattenComputedPaint can bake from a class rule / inheritance onto
 *  an element as an attribute (so the model reflects what renders — issue #139). */
const COMPUTED_PAINT_PROPS = [
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'opacity',
];
/** Geometry shapes that paint a FILL area themselves (so an absent fill means the
 *  SVG default black, not "no fill"). Excludes containers (g/use/image/svg) and
 *  `<line>` — a 1-D segment has no fill area, so BuzzQuill models its fill as none. */
const PAINTABLE_LEAF_TAGS = new Set([
  'path', 'rect', 'ellipse', 'circle', 'polyline', 'polygon', 'text',
]);

/**
 * `innerHTML`/`outerHTML` use HTML fragment serialization, which emits `&nbsp;`
 * for a U+00A0 non-breaking space. That entity is undefined in XML/SVG, so the
 * markup fails to re-parse — breaking save→reload, export, and undo/redo (history
 * restore re-parses as XML and would silently drop the content). Map it to the
 * numeric reference, which is valid in both. `&nbsp;` is the only non-XML entity
 * these serializers produce, and a literal "&nbsp;" in text serializes as
 * "&amp;nbsp;", so this never corrupts real content.
 */
/** The fixed style new shapes are born with. New shapes ALWAYS use this — editing a
 *  panel styles the selected object but never "learns" a new default (deliberate:
 *  defaults change only via `resetDefaultStyle`/the Default Fill/Stroke command or the
 *  eyedropper). Single source of truth for both the initial value and the reset. */
function makeDefaultStyle(): ShapeStyle {
  return {
    fill: '#FFFFFF',
    stroke: '#000000',
    strokeWidth: 1,
    opacity: 1,
    fillOpacity: 1,
    strokeOpacity: 1,
    fontSize: 24,
    fontFamily: 'Inter',
    fontWeight: 'normal',
    fontStyle: 'normal',
    strokeLinecap: 'butt',
    strokeLinejoin: 'miter',
    strokeMiterlimit: 4,
    strokeAlign: 'center',
    strokeDashoffset: 0,
    strokeNonScaling: false,
    rx: 0,
  };
}

export class AppState {
  currentTool: ToolName = 'select';
  shapes: ShapeData[] = [];
  get selectedShapeId(): string | null {
    return this.selectedShapeIds.length > 0 ? this.selectedShapeIds[this.selectedShapeIds.length - 1] : null;
  }
  /** Group the user has "entered" via double-click (Adobe-style isolation), so
   *  canvas clicks select its direct children instead of the group as a whole.
   *  null = top level. Isolation exit is driven by SelectTool; the scope is
   *  cleared automatically if the group is later deleted/ungrouped/undone. */
  activeGroupId: string | null = null;
  // Node-editing session (Direct Selection / Pen). Non-null while a path's
  // anchors are being edited; shared by the tools, overlay, and Properties panel.
  editingPathId: string | null = null;
  pathEdit: PathEditSession | null = null;
  /** The mask whose CUTTER shape is being edited, if any. Pure editor state (never
   *  serialized): while set, rebuildShapesFromDOM models that mask's clipPath child
   *  as an editable node, so its shape can be tweaked with the clip staying live. The
   *  DOM is never restructured, so history snapshots stay ordinary mask markup. */
  maskEditId: string | null = null;
  /** When node-editing a WRAPPED vector (variable-width / multi-stroke), the inner
   *  source `<path>` whose `d` is actually edited (the wrapper `<g>` has no geometry).
   *  Null for a plain path/primitive, where the geometry lives on the shape element. */
  editingSourceEl: SVGElement | null = null;
  /** Regenerate the wrapper's rendered output after a geometry change (null for a
   *  plain path). Runs on every live edit + commit so strokes/width follow the nodes. */
  private editingRegen: (() => void) | null = null;

  /** Smart guides: snap drag/resize to the artboard and other objects. Toggled
   *  from View → Smart Guides; held ⌘/Ctrl bypasses it per-gesture. */
  snapEnabled = true;

  private idCounter = 0;
  /** Undo/redo stack. Owns the index/branching/cap bookkeeping; this class
   *  supplies the document capture/restore via {@link captureSnapshot} /
   *  {@link restoreHistory}. See core/history.ts. */
  private historyMgr: History;
  private drawingLayer: SVGGElement;
  private onChangeCallback: () => void;

  artboards: Artboard[] = [];
  activeFrameId: string | null = null;
  selectedFrameId: string | null = null; // used by artboard tool

  /**
   * Frames in PAGE order — top-first, exactly as the Layers panel lists them.
   *
   * This is the REVERSE of `artboards`, which follows DOM/z-order: `mountNewFrame`
   * prepends each new frame so it sits *behind* existing artwork, making DOM order
   * newest-first. The Layers panel already compensates (it flattens back-to-front),
   * so what the user reads top-down is oldest-first — and that, not z-order, is what
   * "page 1, page 2, …" means. Multi-page output and the export frame list both go
   * through here, so the order you see stacked in Layers is the order you get.
   */
  get framesInPageOrder(): Artboard[] {
    return [...this.artboards].reverse();
  }

  /** Lets a tool ask the app to switch tools (e.g. a draw tool returns to Select
   *  after placing one shape). Wired by main.ts to setTool; null in headless use. */
  requestTool: ((tool: ToolName) => void) | null = null;

  /** Set when point-editing was entered by DOUBLE-CLICKING in the Selection tool
   *  (Figma-style — no separate tool). Records the tool to hop back to when the
   *  edit ends, by any route (exitPathEdit). Null when the user picked the node tool
   *  directly, so that flow stays put. */
  nodeEditReturnTool: ToolName | null = null;
  /** Where the Crop tool hands control back to when a crop session ends. */
  cropReturnTool: ToolName | null = null;
  /** Shape id the Text tool should edit immediately on activation (set by a Select-tool
   *  double-click on text); the Text tool returns to Select when that edit commits. */
  textEditTarget: string | null = null;

  /** Pan a world-space rect into view (keeping zoom). Wired by main.ts to the
   *  canvas; null in headless use. Used to reveal an off-screen frame/shape picked
   *  from the Layers panel and to bring pasted frames on screen. */
  revealBounds: ((b: { x: number; y: number; w: number; h: number }) => void) | null = null;

  /** Current viewport rect in world coords (for placing pasted frames on screen).
   *  Wired by main.ts to the canvas; null in headless use. */
  getViewBox: (() => { x: number; y: number; w: number; h: number }) | null = null;

  /** Bring the shape with `id` into view (no-op if already visible). Frames reveal
   *  their own bounds; other shapes reveal their world bbox. */
  revealShape(id: string): void {
    if (!this.revealBounds) return;
    const shape = this.findShapeById(id);
    const b = shape ? this.shapeWorldBounds(shape) : null;
    if (b && b.w > 0 && b.h > 0) this.revealBounds(b);
  }

  /** World-space (drawing-layer) bbox of one shape. Frames report their frame
   *  rect (`data-frame-w/h`), everything else its rendered bbox incl. transforms. */
  shapeWorldBounds(shape: ShapeData): { x: number; y: number; w: number; h: number } | null {
    if (shape.type === 'frame') {
      const o = this.frameWorldOrigin(shape.element);
      return {
        x: o.x, y: o.y,
        w: parseFloat(shape.element.getAttribute('data-frame-w') ?? '0') || 0,
        h: parseFloat(shape.element.getAttribute('data-frame-h') ?? '0') || 0,
      };
    }
    const svg = this.drawingLayer.ownerSVGElement;
    const bb = svg ? localBBoxInLayer(svg, shape.element) : null;
    return bb ? { x: bb.x, y: bb.y, w: bb.width, h: bb.height } : null;
  }

  /** Union world bbox of the current selection, or null when nothing measurable
   *  is selected. Zero-area members (lines) still contribute their extent. */
  selectionWorldBounds(): { x: number; y: number; w: number; h: number } | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of this.selectedShapeIds) {
      const shape = this.findShapeById(id);
      const b = shape ? this.shapeWorldBounds(shape) : null;
      if (!b) continue;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    if (minX === Infinity) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // Which side-panel list the user last interacted with, so Delete/Backspace
  // targets the right thing ('layers' = shapes on canvas).
  activePanel: 'layers' | 'artboards' | 'symbols' = 'layers';
  selectedSymbolId: string | null = null;

  defaultStyle: ShapeStyle = makeDefaultStyle();

  fillNone = false;
  strokeNone = false;
  showTransparency = true; // checkerboard background on by default

  /** Document canvas-background colour, or null to use the editor's theme default.
   *  Not part of the drawing-layer history snapshot (the pasteboard is chrome), so
   *  it's persisted in the document metadata blob (project-file buildMeta/load) and
   *  applied to the #pasteboard rect. */
  canvasBackground: string | null = null;

  /**
   * When true, "Export Active Artboard" bakes element transforms into geometry
   * so the SVG contains no transform attributes (for consumers that ignore
   * them, e.g. TraceCraft). Persisted across sessions; on by default.
   */
  bakeTransformsOnExport = (() => {
    try { return localStorage.getItem('svgmaker.bakeTransforms') !== 'false'; } catch { return true; }
  })();

  /** Default handling of live `<text>` when exporting to SVG: keep it editable,
   *  convert to outlines (paths — renders without the font), or embed the font.
   *  Persisted across sessions; 'keep' by default so export is never destructive
   *  unless opted in. The Export dialog seeds its Text control from this and writes
   *  it back; the one-click frame exports honor it too. */
  textExportMode: 'keep' | 'outline' | 'embed' = (() => {
    try { const v = localStorage.getItem('buzzquill.textExportMode'); return v === 'outline' || v === 'embed' ? v : 'keep'; }
    catch { return 'keep'; }
  })();

  setTextExportMode(mode: 'keep' | 'outline' | 'embed'): void {
    this.textExportMode = mode;
    try { localStorage.setItem('buzzquill.textExportMode', mode); } catch { /* ignore */ }
  }

  /** Constrain proportions: when on, resizing (the Transform panel's W/H or a
   *  corner drag) preserves the object's aspect ratio; holding Shift inverts it
   *  for that one gesture. Persisted across sessions; off by default. */
  aspectLocked = (() => {
    try { return localStorage.getItem('buzzquill.aspectLocked') === 'true'; } catch { return false; }
  })();

  setAspectLocked(on: boolean): void {
    this.aspectLocked = on;
    try { localStorage.setItem('buzzquill.aspectLocked', String(on)); } catch { /* ignore */ }
  }

  /** <symbol> defs + the shape↔<use> transforms. Extracted to
   *  core/symbol-registry.ts. `symbols` is a read-only view for the panel and
   *  export; all mutation goes through the registry. */
  private symbolRegistry: SymbolRegistry;
  get symbols(): SymbolDef[] { return this.symbolRegistry.symbols; }
  /** Tracked paint defs — mirrors the `symbols` accessor. */
  get patterns(): PatternDef[] { return this.paint.patterns; }
  get gradients(): GradientDef[] { return this.paint.gradients; }
  private defsElement: SVGDefsElement | null = null;

  /** Gradients & patterns: tracked models + their live <defs> elements.
   *  Extracted to core/paint-registry.ts; AppState delegates the public paint
   *  methods to it and reaches it for clear/import. */
  private paint: PaintRegistry;

  /** Cut/copy/paste. Extracted to core/clipboard.ts; reaches the shape model
   *  through the host adapter built in the constructor. */
  private clipboardMgr: ClipboardManager;
  private linkedFiles: LinkedFileManager;
  private effects: EffectsManager;
  private markers: MarkersManager;
  private appearanceMgr: AppearanceManager;
  private widthMgr: WidthStrokeManager;
  private repeatMgr: RepeatManager;
  private frameChrome: FrameChromeManager;
  private svgIo: SvgIoManager;
  private compositing: CompositingManager;
  private selectionStyle: SelectionStyleManager;
  private patternLinks: PatternLinkManager;
  private pathfinder: PathfinderManager;
  private corners: CornerManager;
  private pathJoin: PathJoinManager;
  private pathDirection: PathDirectionManager;
  private layerMgr: LayerManager;
  /** Reusable text styles (Phase 5). Model persisted in a carrier element inside
   *  #drawing-layer; re-derived on every rebuild. See core/text-styles.ts. */
  private textStyleReg: TextStyleRegistry;
  /** Generic Asset Library store (palettes / effect styles / paint styles). Same
   *  carrier-re-derived-on-rebuild pattern as textStyleReg. See core/library.ts. */
  private libraryReg: LibraryRegistry;
  private styleLinks: StyleLinkManager;
  /** Fonts embedded in the document (e.g. extracted from an imported PDF so text
   *  renders in its real typeface). Same carrier pattern; the FontFaces are a
   *  regenerated cache re-ensured on rebuild. See core/embedded-fonts.ts. */
  private embeddedFontReg: EmbeddedFontRegistry;


  /**
   * Paint properties that some author `<style>` rule targets in the current
   * document. Flattening one of these from inline style to a presentation
   * attribute can change the cascade outcome (a stylesheet rule outranks an
   * attribute but not inline style), so {@link flattenInlineStyle} guards them.
   * Refreshed per rebuild; empty for the common no-stylesheet case (no cost).
   */
  private stylesheetPaintProps = new Set<string>();

  constructor(drawingLayer: SVGGElement, onChange: () => void) {
    this.drawingLayer = drawingLayer;
    this.onChangeCallback = onChange;
    this.historyMgr = new History(
      () => this.captureSnapshot(),
      (entry) => this.restoreHistory(entry),
    );
    this.paint = new PaintRegistry({
      ensureDefs: () => this.ensureDefs(),
      getDrawingLayer: () => this.drawingLayer,
      onChange: () => this.notify(),
    });
    const patternLinkHost: PatternLinkHost = {
      patterns: () => this.paint.patterns,
      getPatternById: (id) => this.paint.getPatternById(id),
      createPattern: (def) => this.createPattern(def),
      refreshPatternDef: (pat) => this.paint.refreshPatternDef(pat),
      updatePattern: (pat) => this.paint.updatePattern(pat),
      findShape: (id) => this.findShapeById(id),
      nextId: () => this.nextId(),
      getDrawingLayer: () => this.drawingLayer,
      firstArtboard: () => this.artboards[0],
      setSelection: (ids) => { this.selectedShapeIds = ids; },
      rebuild: () => this.rebuildShapesFromDOM(),
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    };
    this.patternLinks = new PatternLinkManager(patternLinkHost);
    const clipboardHost: ClipboardHost = {
      getShapes: () => this.shapes,
      getDrawingLayer: () => this.drawingLayer,
      getSelectedShapeIds: () => this.selectedShapeIds,
      setSelection: (ids) => { this.selectedShapeIds = ids; },
      findShape: (id) => this.findShapeById(id),
      removeShape: (id) => this.removeShape(id),
      removeSelected: () => this.removeSelected(),
      nextId: () => this.nextId(),
      offsetElement: (el, dx, dy) => this.offsetElement(el, dx, dy),
      reIdGroupChildren: (el) => this.reIdGroupChildren(el),
      detectType: (el) => this.detectType(el),
      readStyle: (el, type) => this.readStyle(el, type),
      addShape: (shape) => this.addShape(shape),
      placePastedFrame: (el) => this.placePastedFrame(el),
      revealShape: (id) => this.revealShape(id),
      rebuild: () => this.rebuildShapesFromDOM(),
      pruneDanglingStyleLinks: () => this.pruneDanglingStyleLinks(),
      ensureDefs: () => this.ensureDefs(),
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    };
    this.clipboardMgr = new ClipboardManager(clipboardHost);
    this.linkedFiles = new LinkedFileManager({
      getShapes: () => this.shapes,
      findShape: (id) => this.findShapeById(id),
      getDrawingLayer: () => this.drawingLayer,
      nextId: () => this.nextId(),
      addShape: (shape) => this.addShape(shape),
      rebuild: () => this.rebuildShapesFromDOM(),
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    });
    const symbolHost: SymbolHost = {
      getShapes: () => this.shapes,
      findShape: (id) => this.findShapeById(id),
      getDrawingLayer: () => this.drawingLayer,
      rebuild: () => this.rebuildShapesFromDOM(),
      ensureDefs: () => this.ensureDefs(),
      nextId: () => this.nextId(),
      detectType: (el) => this.detectType(el),
      readStyle: (el, type) => this.readStyle(el, type),
      getActiveArtboard: () => this.getActiveArtboard(),
      addShape: (shape) => this.addShape(shape),
      setSelection: (ids) => { this.selectedShapeIds = ids; },
      getSelectedSymbolId: () => this.selectedSymbolId,
      setSelectedSymbolId: (id) => { this.selectedSymbolId = id; },
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    };
    this.symbolRegistry = new SymbolRegistry(symbolHost);
    const effectsHost: EffectsHost = {
      ensureDefs: () => this.ensureDefs(),
      getDrawingLayer: () => this.drawingLayer,
      findShapeElement: (id) => this.findShapeById(id)?.element ?? null,
      selectionElements: () => this.selectionElements(),
      nextId: () => this.nextId(),
      rebuild: () => this.rebuildShapesFromDOM(),
      replaceInSelection: (oldId, newId) => {
        this.selectedShapeIds = this.selectedShapeIds.map((id) => (id === oldId ? newId : id));
      },
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    };
    this.effects = new EffectsManager(effectsHost);
    const markersHost: MarkersHost = {
      ensureDefs: () => this.ensureDefs(),
      findShapeElement: (id) => this.findShapeById(id)?.element ?? null,
      selectionElements: () => this.selectionElements(),
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    };
    this.markers = new MarkersManager(markersHost);
    const appearanceHost: AppearanceHost = {
      findShape: (id) => this.findShapeById(id),
      applyEffectFilter: (el) => this.effects.applyFilter(el),
      rebuild: () => this.rebuildShapesFromDOM(),
      setSelection: (ids) => { this.selectedShapeIds = ids; },
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    };
    this.appearanceMgr = new AppearanceManager(appearanceHost);
    const widthHost: WidthStrokeHost = {
      findShape: (id) => this.findShapeById(id),
      applyEffectFilter: (el) => this.effects.applyFilter(el),
      rebuild: () => this.rebuildShapesFromDOM(),
      setSelection: (ids) => { this.selectedShapeIds = ids; },
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    };
    this.widthMgr = new WidthStrokeManager(widthHost);
    const repeatHost: RepeatHost = {
      findShape: (id) => this.findShapeById(id),
      getDrawingLayer: () => this.drawingLayer,
      nextId: () => this.nextId(),
      rebuild: () => this.rebuildShapesFromDOM(),
      setSelection: (ids) => { this.selectedShapeIds = ids; },
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    };
    this.repeatMgr = new RepeatManager(repeatHost);
    const frameChromeHost: FrameChromeHost = {
      frameElement: (id) => this.frameShapeById(id)?.element ?? null,
      syncArtboards: () => this.syncArtboardsCache(),
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    };
    this.frameChrome = new FrameChromeManager(frameChromeHost);
    const svgIoHost: SvgIoHost = {
      getDrawingLayer: () => this.drawingLayer,
      getDefsElement: () => this.defsElement,
      ensureDefs: () => this.ensureDefs(),
      symbolElements: () => this.symbols.map(s => s.element),
      trackImportedSymbol: (el) => this.symbolRegistry.trackImportedSymbol(el),
      clearSymbols: () => this.symbolRegistry.clear(),
      importGradientElement: (el) => this.paint.importGradientElement(el),
      importPatternElement: (el) => this.paint.importPatternElement(el),
      clearPaint: () => this.paint.clear(),
      setShapes: () => { this.shapes = []; },
      setSelection: (ids) => { this.selectedShapeIds = ids; },
      rebuild: () => this.rebuildShapesFromDOM(),
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    };
    this.svgIo = new SvgIoManager(svgIoHost);
    const compositingHost: CompositingHost = {
      findShape: (id) => this.findShapeById(id),
      selectionElements: () => this.selectionElements(),
      getDrawingLayer: () => this.drawingLayer,
      canvasBackground: () => this.canvasBackground,
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    };
    this.compositing = new CompositingManager(compositingHost);
    const selectionStyleHost: SelectionStyleHost = {
      selectedIds: () => this.selectedShapeIds,
      findShape: (id) => this.findShapeById(id),
      selectedShapes: () => this.getSelectedShapes(),
      getAppearance: (id) => this.getAppearance(id),
      setAppearanceMulti: (edits, selectionAfter, record) => this.setAppearanceMulti(edits, selectionAfter, record),
      reconcileStyleLinks: (ids) => { this.reconcileStyleLinks(ids); },
      defaultStyle: () => this.defaultStyle,
      setEffectsOnElements: (els, blur, shadow, record) => this.effects.setEffectsOnElements(els, blur, shadow, record),
      setSelectionBlur: (stdDev) => this.effects.setSelectionBlur(stdDev, false),
      setSelectionShadow: (shadow) => this.effects.setSelectionShadow(shadow, false),
      rebuild: () => this.rebuildShapesFromDOM(),
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    };
    this.selectionStyle = new SelectionStyleManager(selectionStyleHost);
    const pathfinderHost: PathfinderHost = {
      getShapes: () => this.shapes,
      getSelectedIds: () => this.selectedShapeIds,
      setSelection: (ids) => { this.selectedShapeIds = ids; },
      getDrawingLayer: () => this.drawingLayer,
      findShape: (id) => this.findShapeById(id),
      nextId: () => this.nextId(),
      selectedInDomOrder: () => this.selectedInDomOrder(),
      commonParentOf: (shapes) => this.commonParentOf(shapes),
      convertShapeToPath: (shape) => this.convertShapeToPath(shape),
      detachShape: (id) => this.detachShape(id),
      exitGroupIsolation: () => this.exitGroupIsolation(),
      rebuild: () => this.rebuildShapesFromDOM(),
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    };
    this.pathfinder = new PathfinderManager(pathfinderHost);
    const cornerHost: CornerHost = {
      getSelectedIds: () => this.selectedShapeIds,
      findShape: (id) => this.findShapeById(id),
      convertShapeToPath: (shape) => this.convertShapeToPath(shape),
      getDrawingLayer: () => this.drawingLayer,
      rebuild: () => this.rebuildShapesFromDOM(),
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    };
    this.corners = new CornerManager(cornerHost);
    const pathJoinHost: PathJoinHost = {
      getSelectedIds: () => this.selectedShapeIds,
      setSelection: (ids) => { this.selectedShapeIds = ids; },
      findShape: (id) => this.findShapeById(id),
      convertShapeToPath: (shape) => this.convertShapeToPath(shape),
      detachShape: (id) => { this.detachShape(id); },
      getDrawingLayer: () => this.drawingLayer,
      getEditSession: () => (this.editingPathId ? this.pathEdit : null),
      editingGeometryEl: () => this.editingGeometryEl(),
      commitPathEdit: () => this.commitPathEdit(),
      rebuild: () => this.rebuildShapesFromDOM(),
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    };
    this.pathJoin = new PathJoinManager(pathJoinHost);
    const pathDirectionHost: PathDirectionHost = {
      getSelectedIds: () => this.selectedShapeIds,
      findShape: (id) => this.findShapeById(id),
      convertShapeToPath: (shape) => this.convertShapeToPath(shape),
      getEditSession: () => (this.editingPathId ? this.pathEdit : null),
      getEditingId: () => this.editingPathId,
      commitPathEdit: () => this.commitPathEdit(false),
      refreshWidth: (el) => this.widthMgr.refresh(el),
      refreshAppearance: (el) => this.appearanceMgr.refresh(el),
      rebuild: () => this.rebuildShapesFromDOM(),
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    };
    this.pathDirection = new PathDirectionManager(pathDirectionHost);
    const layerHost: LayerHost = {
      getShapes: () => this.shapes,
      getSelectedIds: () => this.selectedShapeIds,
      setSelection: (ids) => { this.selectedShapeIds = ids; },
      getDrawingLayer: () => this.drawingLayer,
      findShape: (id) => this.findShapeById(id),
      nextId: () => this.nextId(),
      offsetElement: (el, dx, dy) => this.offsetElement(el, dx, dy),
      reIdGroupChildren: (el) => this.reIdGroupChildren(el),
      placePastedFrame: (el) => this.placePastedFrame(el),
      selectedInDomOrder: () => this.selectedInDomOrder(),
      commonParentOf: (shapes) => this.commonParentOf(shapes),
      releaseClippingMask: (id) => this.releaseClippingMask(id),
      clearStaleIsolation: () => this.clearStaleIsolation(),
      rebuild: () => this.rebuildShapesFromDOM(),
      saveHistory: () => this.saveHistory(),
      onChange: () => this.notify(),
    };
    this.layerMgr = new LayerManager(layerHost);
    this.textStyleReg = new TextStyleRegistry({ getDrawingLayer: () => this.drawingLayer });
    this.libraryReg = new LibraryRegistry({ getDrawingLayer: () => this.drawingLayer });
    // Style links: the "which objects use which library style" model + the
    // detach-by-reconciliation policy. Narrow host seam, per the collaborator pattern.
    const styleLinkHost: StyleLinkHost = {
      getShapes: () => this.shapes,
      findShape: (id) => this.findShapeById(id),
      getDrawingLayer: () => this.drawingLayer,
      getAppearance: (id) => this.getAppearance(id),
      getObjectEffects: (id) => this.getObjectEffects(id),
      getAsset: (id) => this.libraryReg.get(id),
      hasTextStyle: (id) => !!this.textStyleReg.get(id),
    };
    this.styleLinks = new StyleLinkManager(styleLinkHost);
    this.embeddedFontReg = new EmbeddedFontRegistry({ getDrawingLayer: () => this.drawingLayer });
    // Create the default frame ("Frame 1"). Frames are real <g data-frame>
    // container-shapes in the drawing layer; rebuildShapesFromDOM derives the
    // artboards cache from them.
    this.drawingLayer.appendChild(this.createFrameElement(0, 0, 960, 540, 'Frame 1'));
    this.rebuildShapesFromDOM();
    this.activeFrameId = this.artboards[0]?.id ?? null;
    this.saveHistory();
    this.markClean();
  }

  // ---- Frames (Figma-style containers; the artboards cache derives from them) ----
  //
  // A frame is a `<g data-frame>` container-shape in #drawing-layer with an inline
  // <clipPath> + .frame-bg rect + children in frame-local coords. `this.artboards`
  // is a DERIVED cache (Artboard views: id/x/y/w/h/name) kept in sync by
  // syncArtboardsCache() so all the read-only callers (rulers/export/snapping/
  // status bar/align) keep working unchanged.

  private createFrameElement(x: number, y: number, w: number, h: number, name: string): SVGGElement {
    const SVG = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(SVG, 'g');
    const id = this.nextId();
    g.id = id;
    g.setAttribute('data-frame', '');
    g.setAttribute('data-name', name);
    g.setAttribute('data-frame-w', String(w));
    g.setAttribute('data-frame-h', String(h));
    if (x !== 0 || y !== 0) g.setAttribute('transform', `translate(${x} ${y})`);
    const clipId = `frameclip-${id.replace('shape-', '')}`;
    // While editing, a frame shows its overflow (dimmed) via a mask rather than hard-
    // clipping, so a child is never lost at the boundary. Export swaps back to the hard
    // clip (getDrawingLayerSVGForExport). The mask def is regenerated in defs
    // (ensureFrameOverflowMasks); the inline clipPath below is kept for export.
    g.setAttribute('mask', `url(#framemask-${id.replace('shape-', '')})`);
    const clip = document.createElementNS(SVG, 'clipPath');
    clip.setAttribute('id', clipId);
    clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
    const clipRect = document.createElementNS(SVG, 'rect');
    clipRect.setAttribute('x', '0'); clipRect.setAttribute('y', '0');
    clipRect.setAttribute('width', String(w)); clipRect.setAttribute('height', String(h));
    clip.appendChild(clipRect);
    g.appendChild(clip);
    const bg = document.createElementNS(SVG, 'rect');
    bg.setAttribute('class', 'frame-bg');
    bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
    bg.setAttribute('width', String(w)); bg.setAttribute('height', String(h));
    // Default frame background: transparent (no fill) — the frame reads as just its
    // outline chrome, and exports carry no unwanted backing. A fill can still be set
    // later (the .frame-bg rect is the target); the overlay border keeps it visible.
    bg.setAttribute('fill', 'none');
    bg.setAttribute('pointer-events', 'none');
    g.appendChild(bg);
    return g;
  }

  /** World translate of a frame's `<g>` (its position). */
  private frameTranslate(el: SVGElement): { x: number; y: number } {
    const m = (el as unknown as SVGGraphicsElement).transform.baseVal.consolidate()?.matrix;
    return { x: m?.e ?? 0, y: m?.f ?? 0 };
  }

  private frameToArtboard(s: ShapeData): Artboard {
    const { x, y } = this.frameTranslate(s.element);
    return {
      id: s.id, x, y,
      width: parseFloat(s.element.getAttribute('data-frame-w') ?? '0'),
      height: parseFloat(s.element.getAttribute('data-frame-h') ?? '0'),
      name: s.name,
      grid: this.frameChrome.gridOf(s.element),
      rulers: s.element.getAttribute('data-frame-rulers') === '1',
    };
  }

  /**
   * Place a freshly-pasted frame in the first empty slot to the right of the frame
   * it was copied from, keeping a gap and never overlapping an existing frame — so
   * repeated pastes TILE across the canvas (and fill gaps between frames) instead of
   * cascade-stacking like small shapes do. Mirrors how Illustrator/Figma lay out
   * duplicated artboards/frames. Scans the LIVE DOM, so frames pasted earlier in the
   * same gesture are accounted for; `el` must already be attached. Frames are
   * translate-only, so we can set the position with a plain translate.
   */
  placePastedFrame(el: SVGElement): void {
    const w = parseFloat(el.getAttribute('data-frame-w') ?? '0') || 0;
    const h = parseFloat(el.getAttribute('data-frame-h') ?? '0') || 0;
    const src = this.frameTranslate(el); // el still carries the source frame's position
    const GAP = 40;
    const others = (Array.from(this.drawingLayer.querySelectorAll('g[data-frame]')) as SVGElement[])
      .filter(g => g !== el)
      .map(g => {
        const t = this.frameTranslate(g);
        return {
          x: t.x, y: t.y,
          w: parseFloat(g.getAttribute('data-frame-w') ?? '0') || 0,
          h: parseFloat(g.getAttribute('data-frame-h') ?? '0') || 0,
        };
      });
    const clash = (cx: number, cy: number) => others.find(o =>
      cx < o.x + o.w + GAP && cx + w > o.x - GAP &&
      cy < o.y + o.h + GAP && cy + h > o.y - GAP);
    // Anchor tiling to the SOURCE frame's own row (not the viewport), so repeated
    // pastes lay out in one neat, consistent row regardless of where the view is
    // panned — then scan right past any frame it would overlap, filling gaps. The
    // caller reveals the result, which is what brings the copy on screen.
    let cx = src.x + w + GAP; // just right of the source
    const cy = src.y;         // same row as the source
    // Each jump lands past a blocker (cx strictly increases past a finite set), so
    // this settles in at most `others.length` steps; the bound is a safety net.
    for (let i = 0; i <= others.length; i++) {
      const c = clash(cx, cy);
      if (!c) break;
      cx = c.x + c.w + GAP;
    }
    el.setAttribute('transform', `translate(${cx} ${cy})`);
  }

  // ---- Frame chrome (grid / rulers / export targets) ----
  //
  // Owned by FrameChromeManager; these are thin delegates so call sites (frame
  // panel, export dialog) don't change. The config lives as data-* on the frame
  // and round-trips the snapshot; the renderer draws it as derived chrome.
  getFrameGrid(id: string): FrameGrid | null { return this.frameChrome.getGrid(id); }
  setFrameGrid(id: string, grid: FrameGrid | null, record = true): void { this.frameChrome.setGrid(id, grid, record); }
  getFrameRulers(id: string): boolean { return this.frameChrome.getRulers(id); }
  setFrameRulers(id: string, on: boolean, record = true): void { this.frameChrome.setRulers(id, on, record); }
  getFrameExportTargets(id: string): ExportTarget[] { return this.frameChrome.getExportTargets(id); }
  setFrameExportTargets(id: string, targets: ExportTarget[], record = true): void { this.frameChrome.setExportTargets(id, targets, record); }
  getFrameBackground(id: string): string | null { return this.frameChrome.getBackground(id); }
  setFrameBackground(id: string, color: string | null, record = true): void { this.frameChrome.setBackground(id, color, record); }

  /** Grid-snap parameters for the active frame (origin + per-axis spacing — a
   *  divisions grid can have different column/row spacing), or null when no active
   *  frame has snapping on. Used by the select tool to quantize gestures. */
  activeGridSnap(): { ox: number; oy: number; sx: number; sy: number } | null {
    const id = this.activeFrameId;
    if (!id) return null;
    const ab = this.artboards.find(a => a.id === id);
    if (!ab || !ab.grid || !ab.grid.snap) return null;
    const { sx, sy } = gridSteps(ab.grid, ab.width, ab.height);
    return { ox: ab.x, oy: ab.y, sx, sy };
  }

  /** Rebuild the derived artboards cache from the top-level frame shapes. */
  private syncArtboardsCache(): void {
    this.artboards = this.shapes.filter(s => s.type === 'frame').map(s => this.frameToArtboard(s));
    if (!this.artboards.some(a => a.id === this.activeFrameId)) {
      this.activeFrameId = this.artboards[0]?.id ?? null;
    }
  }

  /** Re-derive the artboards cache from the live frames — call after moving a frame's
   *  transform directly (e.g. a canvas drag) so its border/label/dimension chrome,
   *  which the renderer draws from this cache, follows the frame. */
  syncFrames(): void {
    this.syncArtboardsCache();
  }

  /** Rename a shape. The single rename path for every entry point (layers panel,
   *  inspector, on-canvas frame label): updates the model + `data-name` (which
   *  round-trips the history snapshot) and — for a frame — re-derives the artboards
   *  cache so the canvas label chrome updates immediately, not on the next rebuild. */
  renameShape(id: string, name: string, record = true): void {
    const shape = this.findShapeById(id);
    const trimmed = name.trim();
    if (!shape || !trimmed || trimmed === shape.name) return;
    shape.name = trimmed;
    shape.element.setAttribute('data-name', trimmed);
    // A manual rename wins permanently: stop auto-deriving a text layer's name
    // from its content (#225).
    shape.element.removeAttribute('data-name-auto');
    if (shape.type === 'frame') this.syncArtboardsCache();
    if (record) this.saveHistory();
    this.notify();
  }

  /**
   * DEV-only invariant: the derived shape model must not drift from the DOM (the
   * source of truth). Every structural DOM mutation must call rebuildShapesFromDOM;
   * forgetting it is the single largest bug class here — a deleted element still
   * selectable, a pasted element not selectable, an undo leaving a stale tree.
   * Two directions, both logged to console.error (never throws, no-op in prod),
   * wired into onStateChange next to devCheckFramesInvariant:
   *   forward  — every model node references a connected in-layer element whose id
   *              matches (catches a stale model pointing at removed/moved elements);
   *   reverse  — every `shape-N` element in the layer is in the model (catches an
   *              element added without a rebuild → silently unselectable).
   * The reverse skips elements nested inside a wrapper-leaf (boolean/appearance/
   * width/clip/crop), whose regenerated children the model deliberately doesn't
   * walk — flagging them would be a false positive.
   */
  devCheckShapesMatchDOM(): void {
    if (!import.meta.env?.DEV) return;

    const modelIds = new Set<string>();
    const walk = (nodes: ShapeData[]): void => {
      for (const s of nodes) {
        if (modelIds.has(s.id)) {
          console.error(`[shapes-invariant] id ${s.id} appears more than once in the model tree — rebuild produced a duplicate.`);
        }
        modelIds.add(s.id);
        const el = s.element;
        if (!el || !el.isConnected) {
          console.error(`[shapes-invariant] model shape ${s.id} references an element no longer in the DOM — a mutation path forgot rebuildShapesFromDOM.`);
        } else if (el.id !== s.id) {
          console.error(`[shapes-invariant] model shape ${s.id} points at an element whose id is "${el.id}".`);
        } else if (!this.drawingLayer.contains(el)) {
          console.error(`[shapes-invariant] model shape ${s.id} is outside #drawing-layer.`);
        }
        if (s.children) walk(s.children);
      }
    };
    walk(this.shapes);

    const WRAPPER_LEAF = '[data-boolean],[data-appearance],[data-width],[data-clip-group],[data-crop]';
    for (const el of Array.from(this.drawingLayer.querySelectorAll('[id^="shape-"]'))) {
      if (!/^shape-\d+$/.test(el.id) || modelIds.has(el.id)) continue;
      // Skip the regenerated innards of a wrapper-leaf (the model represents the
      // wrapper, not its cache children).
      if (el.parentElement?.closest(WRAPPER_LEAF)) continue;
      console.error(`[shapes-invariant] DOM element ${el.id} is not in the model tree — added without rebuildShapesFromDOM (it won't be selectable).`);
    }
  }

  /**
   * DEV-only invariant: the derived `artboards` cache must mirror the live frames in
   * the DOM. A mismatch means some mutation path forgot to re-derive it
   * (syncArtboardsCache / syncFrames / rebuildShapesFromDOM) — the exact root cause of
   * a whole cluster of bugs (a deleted frame's outline lingering, a pasted frame not
   * being selectable, a dragged frame's chrome lagging). Logs to console.error
   * (never throws) so it surfaces loudly in QA output without breaking the app. Wired
   * into onStateChange; a no-op in production.
   */
  devCheckFramesInvariant(): void {
    if (!import.meta.env?.DEV) return;
    const frames = Array.from(this.drawingLayer.querySelectorAll('g[data-frame]')) as SVGElement[];
    if (frames.length !== this.artboards.length) {
      console.error(`[frames-invariant] artboards cache has ${this.artboards.length} entries but the DOM has ${frames.length} frames — a mutation path forgot to re-sync (syncArtboardsCache / syncFrames).`);
    }
    for (const g of frames) {
      const ab = this.artboards.find(a => a.id === g.id);
      if (!ab) { console.error(`[frames-invariant] DOM frame ${g.id} is missing from the artboards cache.`); continue; }
      const t = this.frameTranslate(g);
      const w = parseFloat(g.getAttribute('data-frame-w') ?? '0') || 0;
      const h = parseFloat(g.getAttribute('data-frame-h') ?? '0') || 0;
      const r = Math.round;
      if (r(ab.x) !== r(t.x) || r(ab.y) !== r(t.y) || r(ab.width) !== r(w) || r(ab.height) !== r(h)) {
        console.error(`[frames-invariant] frame ${g.id}: cache {x:${r(ab.x)},y:${r(ab.y)},${r(ab.width)}×${r(ab.height)}} disagrees with DOM {x:${r(t.x)},y:${r(t.y)},${r(w)}×${r(h)}} — re-sync needed.`);
      }
    }
  }

  /**
   * Regenerate the per-frame "dim overflow" mask in <defs> (a cache, like effect
   * filters — defs aren't in the history snapshot). Each mask renders frame content
   * at full opacity INSIDE the frame rect and dimmed OUTSIDE it, so a child that
   * spills past the edge stays visible but reads as outside the exportable area.
   * Also migrates older frames that still hard-clip: swap clip-path → mask for
   * display (the inline <clipPath> is retained for export). Idempotent.
   */
  ensureFrameOverflowMasks(): void {
    const SVG = 'http://www.w3.org/2000/svg';
    const defs = this.ensureDefs();
    const B = 1e5; // huge region so far-flung overflow still renders (dimmed)
    const alive = new Set<string>();
    for (const g of Array.from(this.drawingLayer.querySelectorAll('g[data-frame]')) as SVGElement[]) {
      const num = g.id.replace('shape-', '');
      const maskId = `framemask-${num}`;
      alive.add(maskId);
      const w = parseFloat(g.getAttribute('data-frame-w') ?? '0') || 0;
      const h = parseFloat(g.getAttribute('data-frame-h') ?? '0') || 0;
      // Display via the dim mask; keep the hard clip out of the live view.
      if (g.getAttribute('mask') !== `url(#${maskId})`) g.setAttribute('mask', `url(#${maskId})`);
      if (g.hasAttribute('clip-path')) g.removeAttribute('clip-path');

      defs.querySelector(`#${maskId}`)?.remove();
      const mask = document.createElementNS(SVG, 'mask');
      mask.setAttribute('id', maskId);
      mask.setAttribute('maskUnits', 'userSpaceOnUse');
      mask.setAttribute('x', String(-B)); mask.setAttribute('y', String(-B));
      mask.setAttribute('width', String(2 * B)); mask.setAttribute('height', String(2 * B));
      const outside = document.createElementNS(SVG, 'rect'); // dim everything…
      outside.setAttribute('x', String(-B)); outside.setAttribute('y', String(-B));
      outside.setAttribute('width', String(2 * B)); outside.setAttribute('height', String(2 * B));
      outside.setAttribute('fill', '#fff'); outside.setAttribute('fill-opacity', '0.28');
      const inside = document.createElementNS(SVG, 'rect'); // …full opacity inside the frame
      inside.setAttribute('x', '0'); inside.setAttribute('y', '0');
      inside.setAttribute('width', String(w)); inside.setAttribute('height', String(h));
      inside.setAttribute('fill', '#fff');
      mask.appendChild(outside); mask.appendChild(inside);
      defs.appendChild(mask);
    }
    // Prune masks whose frames are gone.
    for (const m of Array.from(defs.querySelectorAll('mask[id^="framemask-"]'))) {
      if (!alive.has(m.id)) m.remove();
    }
  }

  private frameShapeById(id: string): ShapeData | undefined {
    return this.shapes.find(s => s.type === 'frame' && s.id === id);
  }

  /** The top-level frame whose world bounds contain (cx, cy), else null. */
  /** A frame's ORIGIN in world (drawing-layer) coordinates, accumulating ancestor
   *  frame transforms so nested frames convert coordinates correctly. Frames are
   *  translate-only, so the composed matrix's e/f are the world origin. */
  private frameWorldOrigin(el: SVGElement): { x: number; y: number } {
    const m = matrixBetween(this.drawingLayer, el as unknown as SVGGraphicsElement);
    if (!m) return this.frameTranslate(el); // detached fallback
    return { x: m.e, y: m.f };
  }

  /** Frames that can take a new child. A locked frame can't: everything inside it is
   *  locked too, so a shape drawn, pasted or dragged into one could never be picked or
   *  moved again — a pasted image came out stuck, and a press on it went through to the
   *  frame. Such a shape stays on the canvas above the frame instead. */
  private adoptingFrames(): SVGElement[] {
    return (Array.from(this.drawingLayer.querySelectorAll('g[data-frame]')) as SVGElement[])
      .filter(el => !isLockedEl(el));
  }

  /** The DEEPEST frame whose world bounds contain (cx, cy), or null. Scans every
   *  frame element (including nested ones), not just top-level frames. */
  private frameAtPoint(cx: number, cy: number): ShapeData | null {
    let best: SVGElement | null = null;
    let bestDepth = -1;
    for (const el of this.adoptingFrames()) {
      const o = this.frameWorldOrigin(el);
      const w = parseFloat(el.getAttribute('data-frame-w') ?? '0');
      const h = parseFloat(el.getAttribute('data-frame-h') ?? '0');
      if (cx < o.x || cx > o.x + w || cy < o.y || cy > o.y + h) continue;
      let depth = 0;
      const layer: Element = this.drawingLayer;
      for (let p: Element | null = el.parentElement; p && p !== layer; p = p.parentElement) {
        if (p.hasAttribute('data-frame')) depth++;
      }
      if (depth > bestDepth) { bestDepth = depth; best = el; }
    }
    return best ? this.findShapeById(best.id) : null;
  }

  /**
   * The frame a shape (given by its WORLD bbox) belongs in — Figma-style: a shape
   * counts as "on" a frame if its CENTER is inside OR a MAJORITY of its area
   * overlaps the frame. This is a strict superset of the center-only test, so it
   * never un-nests something the old rule caught; it just also grabs shapes that
   * straddle an edge or are drawn substantially on top of the frame. Among
   * qualifying frames the DEEPEST wins (nested frames), tie-broken by most overlap.
   */
  /** Public: id of the frame a world-space rect would drop into (drag feedback). */
  frameIdForWorldBBox(x: number, y: number, w: number, h: number): string | null {
    return this.frameForWorldBBox(x, y, w, h)?.id ?? null;
  }

  private frameForWorldBBox(x: number, y: number, w: number, h: number): ShapeData | null {
    const area = w * h;
    const cx = x + w / 2, cy = y + h / 2;
    let best: SVGElement | null = null;
    let bestScore = -1;
    for (const el of this.adoptingFrames()) {
      const o = this.frameWorldOrigin(el);
      const fw = parseFloat(el.getAttribute('data-frame-w') ?? '0');
      const fh = parseFloat(el.getAttribute('data-frame-h') ?? '0');
      // Intersection of the shape's bbox with the frame bounds (world space).
      const iw = Math.min(x + w, o.x + fw) - Math.max(x, o.x);
      const ih = Math.min(y + h, o.y + fh) - Math.max(y, o.y);
      const inter = (iw > 0 && ih > 0) ? iw * ih : 0;
      const centerInside = cx >= o.x && cx <= o.x + fw && cy >= o.y && cy <= o.y + fh;
      // Degenerate (zero-area) shapes — lines, single clicks — fall back to center.
      const majorityOverlap = area > 0 && inter >= 0.5 * area;
      if (!centerInside && !majorityOverlap) continue;
      let depth = 0;
      for (let p: Element | null = el.parentElement; p && p !== this.drawingLayer; p = p.parentElement) {
        if (p.hasAttribute('data-frame')) depth++;
      }
      const score = depth * 1e12 + inter; // deeper wins; then larger overlap
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best ? this.findShapeById(best.id) : null;
  }

  // Keep the legacy getter for backward compat with align, export, etc.
  get artboard(): Artboard {
    return this.getActiveArtboard();
  }

  getActiveArtboard(): Artboard {
    return this.artboards.find(a => a.id === this.activeFrameId)
      ?? this.artboards[0]
      // Safety net for documents with no frame yet (e.g. an old file mid-migration):
      // a default view so rulers/export/status never read `undefined`.
      ?? { id: '', x: 0, y: 0, width: 960, height: 540, name: 'Frame' };
  }

  getArtboardById(id: string): Artboard | undefined {
    return this.artboards.find(a => a.id === id);
  }

  /** Mount a new frame at the FRONT of the drawing layer, so it appears at the
   *  BOTTOM of the (reverse-DOM) Layers list — a new frame reads as appended to the
   *  collection rather than jumping above the existing ones. Frames are side-by-side
   *  and don't overlap, so the resulting back-of-z placement has no visual effect. */
  private mountNewFrame(el: SVGElement): void {
    this.drawingLayer.insertBefore(el, this.drawingLayer.firstChild);
  }

  /** Create a frame (world coords). Returns the new frame shape's id. Frames are
   *  ALWAYS top-level — never nested inside another frame or a group. */
  addFrame(x: number, y: number, w: number, h: number, name: string): string {
    const g = this.createFrameElement(x, y, w, h, name);
    this.mountNewFrame(g);
    this.rebuildShapesFromDOM();
    this.activeFrameId = g.id;
    this.selectedShapeIds = [g.id];
    this.saveHistory();
    this.notify();
    return g.id;
  }

  /** Create a frame from an Artboard-shaped request (the Frame tool's adapter);
   *  returns the new frame's id. addFrame mints its own shape-N id, so the
   *  request's `id` is ignored. */
  addArtboard(ab: Artboard): string {
    return this.addFrame(ab.x, ab.y, ab.width, ab.height, ab.name);
  }

  /**
   * Migrate freshly-imported legacy content (no frames) into frame(s): for each
   * legacy board, wrap the top-level shapes whose center falls inside it into a
   * new frame (world→frame-local). No-op if the imported markup already has
   * frames (a current-format doc). Does not save history (the caller does).
   */
  migrateContentToFrames(boards: ReadonlyArray<{ x: number; y: number; width: number; height: number; name: string }>): void {
    if (this.shapes.some(s => s.type === 'frame')) return; // already frames
    const top = [...this.shapes];
    const frames = boards.map(b => {
      const g = this.createFrameElement(b.x, b.y, b.width, b.height, b.name);
      this.drawingLayer.appendChild(g);
      return { b, g };
    });
    if (frames.length === 0) return;

    for (const sh of top) {
      // Choose the frame this shape belongs to. With a single frame — the
      // foreign-import case — EVERYTHING goes in: a bbox/center test would
      // wrongly exclude a group whose getBBox ignores clipping (e.g. a clipped
      // decorative path with huge geometry), leaving it orphaned BEHIND the
      // frame where the frame background hides it. With multiple frames, assign
      // by bbox center, falling back to the first frame so nothing is orphaned.
      let target = frames[0];
      if (frames.length > 1) {
        try {
          const bb = sh.element.getBBox();
          const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
          const hit = frames.find(({ b }) => cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height);
          if (hit) target = hit;
        } catch { /* keep frames[0] */ }
      }
      this.offsetElement(sh.element, -target.b.x, -target.b.y);
      target.g.appendChild(sh.element);
    }
    this.rebuildShapesFromDOM();
  }

  /**
   * THE seam every move gesture commits through: reconcile frame auto-parenting
   * for the moved shapes, then record the undo step. Drag drops, arrow-nudge
   * runs, and Transform-panel X/Y commits all end here — one obligation instead
   * of a "remember to reparent, then save" pair at every mover, which is how
   * numeric moves shipped without reparenting in the first place (#222). A new
   * mover needs the history save anyway, and this is where it gets it.
   *
   * Containment re-evaluates on MOVE only (Figma semantics): resize, rotate, and
   * style commits go through plain saveHistory and never re-parent — a shape
   * deliberately owned by the frame it was DRAWN in (start-point rule) keeps
   * that home until the user actually moves it.
   */
  commitMove(ids?: string[], opts?: { amend?: boolean }): void {
    this.reparentAfterMove(ids ?? [...this.selectedShapeIds]);
    if (opts?.amend) this.amendHistory();
    else this.saveHistory();
  }

  /**
   * Reparent each moved shape into the frame now under its center (or out to
   * the pasteboard), converting coords between world and frame-local space.
   * Frames themselves are not reparented. Private policy behind
   * {@link commitMove} — callers never invoke it directly.
   */
  private reparentAfterMove(ids: string[]): void {
    let changed = false;
    for (const id of ids) {
      const shape = this.findShapeById(id);
      if (!shape || shape.type === 'frame') continue;
      const el = shape.element;
      const curParent = el.parentElement as SVGElement | null;
      // Only top-level shapes and direct frame-children participate in frame
      // auto-parenting. A shape nested in a group / clip-group / boolean / etc.
      // belongs to that container — reparenting it to a frame would rip it out of
      // its group (and, since its bbox is container-local, at a wrong position).
      const curFrameEl = curParent?.hasAttribute?.('data-frame') ? curParent : null;
      if (curParent !== this.drawingLayer && !curFrameEl) continue;
      const curOff = curFrameEl ? this.frameWorldOrigin(curFrameEl) : { x: 0, y: 0 };
      // Use the visible world bbox, so a crop's hidden source cannot choose its frame.
      // Include the full CTM, not curOff + getBBox():
      // a group/path is moved by a `transform` that getBBox() ignores, so the naive
      // form tested the pre-move position and never saw the frame it was dragged into.
      const svg = this.drawingLayer.ownerSVGElement;
      const wb = svg ? visualWorldBBox(svg, el) : null;
      if (!wb) continue;
      // Same center-in-or-majority-overlap rule as drawing, in world space.
      const targetFrame = this.frameForWorldBBox(wb.x, wb.y, wb.width, wb.height);
      const targetEl: SVGElement = targetFrame ? (targetFrame.element as SVGElement) : this.drawingLayer;
      if (targetEl === curParent) continue; // unchanged
      const tOff = targetFrame ? this.frameWorldOrigin(targetFrame.element) : { x: 0, y: 0 };
      const dx = curOff.x - tOff.x, dy = curOff.y - tOff.y; // cur-local → target-local
      if (dx !== 0 || dy !== 0) this.offsetElement(el, dx, dy);
      this.insertPreservingDocOrder(targetEl, el);
      changed = true;
    }
    if (changed) this.rebuildShapesFromDOM();
  }

  /**
   * Move `el` into `parent` at the position that keeps the document's current
   * paint order: before the first modeled-shape child that FOLLOWS el today,
   * else appended. Blind appendChild made every reparent a z-jump — a shape
   * leaving a frame leapt above every later frame and shape, and one returning
   * always landed on top of the stack (#222's z-order wrinkle). Order across a
   * clip boundary can't always survive (a frame child paints inside its frame's
   * span), but where a stable position exists, this finds it.
   */
  private insertPreservingDocOrder(parent: SVGElement, el: SVGElement): void {
    const isShape = (id: string): boolean => !!this.findShapeById(id);
    let anchor: Element | null = null;
    for (const child of Array.from(parent.children)) {
      if (child === el || !isModeledShapeEl(child, isShape)) continue;
      if (el.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING) { anchor = child; break; }
    }
    if (anchor) parent.insertBefore(el, anchor);
    else parent.appendChild(el);
  }

  removeArtboard(id: string): void {
    if (this.shapes.filter(s => s.type === 'frame').length <= 1) return; // keep ≥1
    if (!this.detachShape(id)) return;
    if (this.selectedFrameId === id) this.selectedFrameId = null;
    this.rebuildShapesFromDOM();
    this.saveHistory();
    this.notify();
  }

  updateArtboard(id: string, updates: Partial<Omit<Artboard, 'id'>>, opts: { keepChildrenFixed?: boolean } = {}): void {
    const s = this.frameShapeById(id);
    if (!s) return;
    const el = s.element;
    const cur = this.frameToArtboard(s);
    if (updates.name != null) { el.setAttribute('data-name', updates.name); s.name = updates.name; }
    const nx = updates.x ?? cur.x, ny = updates.y ?? cur.y;
    if (updates.x != null || updates.y != null) {
      // When resizing from the top/left, the origin moves but content should stay
      // world-fixed — compensate the child geometry by the inverse origin delta.
      // (For a plain move, keepChildrenFixed is false so content travels with the frame.)
      if (opts.keepChildrenFixed) {
        const ddx = nx - cur.x, ddy = ny - cur.y;
        if (ddx || ddy) {
          for (const child of Array.from(el.children) as SVGElement[]) {
            if (child.tagName.toLowerCase() === 'clippath' || child.classList.contains('frame-bg')) continue;
            this.offsetElement(child, -ddx, -ddy);
          }
        }
      }
      if (nx !== 0 || ny !== 0) el.setAttribute('transform', `translate(${nx} ${ny})`);
      else el.removeAttribute('transform');
    }
    const nw = updates.width ?? cur.width, nh = updates.height ?? cur.height;
    if (updates.width != null || updates.height != null) {
      el.setAttribute('data-frame-w', String(nw));
      el.setAttribute('data-frame-h', String(nh));
      el.querySelectorAll('clipPath > rect, rect.frame-bg').forEach((r) => {
        r.setAttribute('width', String(nw));
        r.setAttribute('height', String(nh));
      });
      this.ensureFrameOverflowMasks(); // resize the dim-overflow mask's "inside" rect
    }
    this.syncArtboardsCache();
    this.notify();
  }

  setActiveArtboard(id: string): void {
    this.activeFrameId = id;
    this.notify();
  }

  onChange_public(): void {
    this.notify();
  }

  // ---- Change notification (coalescing) ------------------------------------
  // Every mutation routes its "something changed" signal through notify(). Inside
  // runBatched(fn) those signals are coalesced: observers don't render against a
  // half-updated document, and exactly one onChange fires after fn completes. This
  // is what makes a multi-step operation (e.g. DocumentManager.loadTabIntoState:
  // load content + re-tether cloud/file identity + set the display name) atomic —
  // the render only ever sees the finished state, never an intermediate one.
  private notifyDepth = 0;
  private notifyPending = false;

  private notify(): void {
    if (this.notifyDepth > 0) { this.notifyPending = true; return; }
    this.onChangeCallback();
  }

  /** Run `fn` with change notifications coalesced into a single onChange fired
   *  after it returns (only if something inside requested one). Nestable. */
  runBatched(fn: () => void): void {
    this.notifyDepth++;
    try {
      fn();
    } finally {
      this.notifyDepth--;
      if (this.notifyDepth === 0 && this.notifyPending) {
        this.notifyPending = false;
        this.onChangeCallback();
      }
    }
  }

  /**
   * Re-sync emulated stroke-alignment clip-paths to current geometry, and prune
   * clips for shapes that are gone or no longer aligned. Called from the render
   * cycle so inside/outside strokes stay aligned after moves/resizes/loads.
   */
  refreshStrokeAlignClips(): void {
    // Fast path: with no stroke-aligned shape in the document (the common case)
    // there's nothing to re-sync and nothing to prune — skip the whole-tree walk
    // that otherwise ran on every render frame. The `data-stroke-align` marker is
    // present iff a shape uses inside/outside alignment (see core/stroke-align).
    const defs = this.defsElement ?? this.drawingLayer.closest('svg')?.querySelector('defs');
    const hasAligned = this.drawingLayer.querySelector('[data-stroke-align]') !== null;
    const hasClips = !!defs && Array.from(defs.children).some((c) => c.id.startsWith(STROKE_CLIP_PREFIX));
    if (!hasAligned && !hasClips) return;

    const expected = new Set<string>();
    const visit = (shapes: ShapeData[]) => {
      for (const s of shapes) {
        const align = s.style.strokeAlign ?? 'center';
        if (align !== 'center' && s.element.isConnected) {
          expected.add(STROKE_CLIP_PREFIX + s.element.id);
          applyStrokeAlignment(s.element, s.type, align, s.style.strokeWidth);
        }
        if (s.children?.length) visit(s.children);
      }
    };
    visit(this.shapes);

    // Prune orphaned alignment clips.
    if (defs) {
      for (const child of Array.from(defs.children)) {
        if (child.id.startsWith(STROKE_CLIP_PREFIX) && !expected.has(child.id)) child.remove();
      }
    }
  }

  /**
   * Give stroked <text> a clean, Figma-style outline. SVG's defaults render text
   * strokes badly: the (centred) stroke paints OVER the fill — eating into the
   * letterform and, where glyph edges cross (the middle of an X), overlapping into a
   * janky tangle — and mitre joins spike at the sharp corners of a glyph. We instead
   * paint the stroke UNDER the fill (`paint-order: stroke`), so it reads as an
   * outline hugging the glyphs, and round the joins/caps so corners don't spike.
   *
   * Runs each render (cheap fast-path when the doc has no text). Idempotent, and
   * stored as DOM attributes / inline style, so it round-trips the history/save
   * snapshot without any model bookkeeping — text stays out of the inside/outside
   * clip machinery entirely. Also covers the stroke *clones* of a multi-stroke
   * (appearance-wrapped) text, which are <text> elements too.
   */
  polishTextStrokes(): void {
    const texts = this.drawingLayer.getElementsByTagName('text');
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i] as SVGTextElement;
      // Stroked-no-fill text renders via a regenerated outline path instead (its
      // browser stroke is suppressed) — leave it to refreshTextStrokeOutlines.
      if (t.hasAttribute('data-text-stroke-outlined')) continue;
      const stroke = (t.getAttribute('stroke') ?? '').trim();
      const w = parseFloat(t.getAttribute('stroke-width') ?? '0');
      const hasStroke = stroke !== '' && stroke !== 'none' && w > 0;
      if (!hasStroke) { t.style.removeProperty('paint-order'); continue; }
      const fill = (t.getAttribute('fill') ?? '').trim();
      const hasFill = fill !== '' && fill !== 'none';
      // Fill on top of the stroke = clean outline. With no fill (outline-only text)
      // there's nothing to layer over, so leave the natural centred stroke.
      if (hasFill) t.style.paintOrder = 'stroke'; else t.style.removeProperty('paint-order');
      if (!t.getAttribute('stroke-linejoin')) t.setAttribute('stroke-linejoin', 'round');
      if (!t.getAttribute('stroke-linecap')) t.setAttribute('stroke-linecap', 'round');
    }
  }

  /** Render stroked, fill:none text as a clean regenerated outline (issue #172).
   *  Delegates to the text-stroke engine; sync + signature-gated (see core/text-stroke). */
  refreshTextStrokeOutlines(): void {
    refreshTextStrokeOutlines(this.drawingLayer);
  }

  /**
   * True while a continuous pointer gesture (drag/resize/rotate) is in flight.
   * The renderer uses this to skip the expensive side-panel rebuilds on every
   * mousemove — only the canvas overlays need to follow the pointer live — and
   * does a full render once the gesture ends. Tools must clear it on mouseup.
   */
  interactive = false;

  /** The kind of transform gesture in progress, so the selection overlay's dimension
   *  badge can show the relevant readout (angle while rotating, X/Y while moving, else
   *  W×H). Transient editor state — set by the Select tool, never serialized. */
  activeGesture: 'move' | 'resize' | 'rotate' | null = null;

  /** Begin/end an interactive gesture (see `interactive`). */
  setInteractive(on: boolean): void {
    this.interactive = on;
  }

  nextId(): string {
    return `shape-${++this.idCounter}`;
  }

  addShape(shape: ShapeData, originPt?: Point): void {
    this.drawingLayer.appendChild(shape.element);
    // Figma-style auto-parent: a shape drawn inside a frame becomes its child
    // (converted to frame-local coords). Otherwise it stays a top-level shape.
    // `originPt` (the world point where the draw began) lets a shape you started
    // drawing inside a frame land in that frame even if you drag past its edge.
    const frame = this.frameForNewElement(shape.element, originPt);
    if (frame) {
      const a = this.frameWorldOrigin(frame.element); // accumulates nested frames
      this.offsetElement(shape.element, -a.x, -a.y); // world → frame-local
      frame.element.appendChild(shape.element);
      this.rebuildShapesFromDOM(); // now nested under the frame → resync model
    } else {
      this.shapes.push(shape);
    }
    this.selectedShapeIds = [shape.id];
    this.saveHistory();
    this.notify();
  }

  /**
   * Append pre-built SVG elements as children (layers) of a frame, in frame-LOCAL
   * coordinates (0..w, 0..h). Used by "Import PDF as vectors": the extracted page
   * objects are already in page space, which IS the frame's local space, so no
   * offset is needed. Each element becomes an individually selectable layer.
   */
  addElementsToFrame(frameId: string, elements: SVGElement[]): void {
    const frame = this.shapeById.get(frameId)?.element;
    if (!frame) return;
    for (const el of elements) {
      if (!el.id) el.id = this.nextId();
      if (!el.getAttribute('data-name')) {
        el.setAttribute('data-name', `${el.tagName.toLowerCase()} ${el.id.replace('shape-', '#')}`);
      }
      frame.appendChild(el);
    }
    this.rebuildShapesFromDOM();
    this.saveHistory();
    this.notify();
  }

  /** The frame a freshly-drawn element falls into, or null. Primary rule: the
   *  frame you STARTED the draw in (originPt) owns the shape — the most intuitive,
   *  Figma-matching behavior, robust even when you drag well past the frame edge.
   *  Fallback (no origin, or started on the pasteboard): the shape's world bbox is
   *  center-inside or majority-overlaps a frame. Use the visible world box so
   *  crops and transformed elements follow the same policy as moved shapes. */
  private frameForNewElement(el: SVGGraphicsElement, originPt?: Point): ShapeData | null {
    if (originPt) {
      const byStart = this.frameAtPoint(originPt.x, originPt.y);
      if (byStart) return byStart;
    }
    const svg = this.drawingLayer.ownerSVGElement;
    const bbox = svg ? visualWorldBBox(svg, el) : null;
    return bbox ? this.frameForWorldBBox(bbox.x, bbox.y, bbox.width, bbox.height) : null;
  }

  /** Find a shape and the array that directly contains it (handles nesting). */
  private locateShape(id: string, list: ShapeData[] = this.shapes): { shape: ShapeData; siblings: ShapeData[] } | null {
    for (const s of list) {
      if (s.id === id) return { shape: s, siblings: list };
      if (s.children) {
        const found = this.locateShape(id, s.children);
        if (found) return found;
      }
    }
    return null;
  }

  /** Remove a shape (top-level or nested inside a group) from model + DOM. */
  private detachShape(id: string): boolean {
    const loc = this.locateShape(id);
    if (!loc) return false;
    loc.shape.element.remove();
    this.shapeById.delete(id);
    const i = loc.siblings.indexOf(loc.shape);
    if (i >= 0) loc.siblings.splice(i, 1);
    return true;
  }

  removeShape(id: string): void {
    if (!this.detachShape(id)) return;
    this.selectedShapeIds = this.selectedShapeIds.filter(sid => sid !== id);
    this.clearStaleIsolation();
    // The artboards cache is derived from the frame elements; refresh it so deleting
    // a frame also drops its overlay chrome (border/label), which the renderer draws
    // from this cache — otherwise the frame lingers on canvas until a reload.
    this.syncArtboardsCache();
    this.saveHistory();
    this.notify();
  }

  /** Remove the entire current selection in a single undo step. */
  removeSelected(): void {
    if (this.selectedShapeIds.length === 0) return;
    for (const id of [...this.selectedShapeIds]) this.detachShape(id);
    this.selectedShapeIds = [];
    this.clearStaleIsolation();
    // Refresh the derived artboards cache so a deleted frame's overlay chrome
    // (border/label/dimensions, drawn from that cache) disappears immediately —
    // matching removeShape. Without this a deleted frame lingers until reload.
    this.syncArtboardsCache();
    this.saveHistory();
    this.notify();
  }

  getSelectedShape(): ShapeData | null {
    if (!this.selectedShapeId) return null;
    return this.findShapeById(this.selectedShapeId);
  }

  /** Every selected shape (in selection order), skipping any stale ids. Used by the
   *  properties panel to edit a whole multi-selection at once. */
  getSelectedShapes(): ShapeData[] {
    return this.selectedShapeIds
      .map(id => this.findShapeById(id))
      .filter((s): s is ShapeData => !!s);
  }

  selectShape(id: string | null): void {
    this.selectedShapeIds = id ? [id] : [];
    if (this.editingPathId && id !== this.editingPathId) this.exitPathEdit(false);
    this.notify();
  }

  // ---- Group isolation (double-click to edit children on the canvas) ----

  /** Enter a group so canvas clicks select its direct children. No-op if `id`
   *  is not a group, or it's already the active scope. */
  /** Isolate a group (or boolean / repeat grid). Returns false — and changes
   *  nothing — for anything else, a frame above all: the caller stepping OUT of a
   *  group must then leave isolation instead of staying stuck inside. */
  enterGroup(id: string): boolean {
    const shape = this.findShapeById(id);
    // Repeat grids isolate too: their SOURCE is a modeled child, and drilling in
    // is how you edit the original that all instances follow (#111).
    if (shape?.type !== 'group' && shape?.type !== 'boolean' && shape?.type !== 'repeat') return false;
    if (this.activeGroupId === id) return true;
    this.exitGroupIsolation();
    this.activeGroupId = id;
    // Entering a live boolean reveals its operands for editing (CSS keyed on
    // data-bool-editing) and warms the engine so recompute stays synchronous.
    if (shape.type === 'boolean') {
      shape.element.setAttribute('data-bool-editing', '');
      void ensureBooleanEngine().then(() => this.notify());
    }
    this.notify();
    return true;
  }

  /** Leave group isolation. No-op (and no render) when not isolated, so callers
   *  can invoke it unconditionally. */
  exitGroupIsolation(): void {
    if (!this.activeGroupId) return;
    this.findShapeById(this.activeGroupId)?.element.removeAttribute('data-bool-editing');
    this.activeGroupId = null;
    this.notify();
  }

  /** Drop a dangling isolation scope when its group no longer exists (after
   *  delete / ungroup / undo). Cheap; called from the few mutation points. */
  private clearStaleIsolation(): void {
    if (this.activeGroupId && !this.findShapeById(this.activeGroupId)) this.activeGroupId = null;
  }

  // ---- Node editing ----

  /** Begin editing a path's anchors. No-op for non-path shapes. */
  enterPathEdit(id: string): boolean {
    const shape = this.findShapeById(id);
    if (!shape || shape.locked) return false;

    // Wrapped vector (variable-width `data-width` / multi-stroke `data-appearance`):
    // the geometry lives on the inner SOURCE path, not the wrapper `<g>`. Edit that
    // source and regenerate the wrapper after every change, so the path keeps its
    // strokes/width while its points stay directly editable.
    if (shape.type === 'width' || shape.type === 'appearance') {
      const srcSel = shape.type === 'width' ? '[data-width-src]' : '[data-ap-src]';
      const src = shape.element.querySelector(`:scope > ${srcSel}`) as SVGElement | null;
      const wd = src?.getAttribute('d');
      if (!src || !wd) return false; // only path-source wrappers are node-editable
      this.editingSourceEl = src;
      this.editingRegen = shape.type === 'width'
        ? () => this.widthMgr.refresh(shape.element)
        : () => this.appearanceMgr.refresh(shape.element);
      this.editingPathId = id;
      this.pathEdit = new PathEditSession(wd);
      this.selectedShapeIds = [id];
      this.notify();
      return true;
    }

    // Node editing operates on a <path>. Point-based primitives (polygon/star,
    // polyline, line) convert to an equivalent path in place so their vertices become
    // directly editable. Parametric primitives (rect / rounded rect / ellipse) are
    // deliberately NOT node-edited (Figma-style) — converting would explode their
    // clean form into beziers and drop the corner-radius control; edit them via the
    // panel instead.
    let converted = false;
    if (shape.type !== 'path') {
      if (!['polygon', 'polyline', 'line'].includes(shape.type)) return false;
      if (!this.convertShapeToPath(shape)) return false;
      converted = true;
    }
    const d = shape.element.getAttribute('d');
    if (!d) return false;
    this.editingSourceEl = null;
    this.editingRegen = null;
    this.editingPathId = id;
    this.pathEdit = new PathEditSession(d);
    this.selectedShapeIds = [id];
    // The in-place conversion changed the document, so make it an undoable step.
    if (converted) this.saveHistory();
    this.notify();
    return true;
  }

  /** Can this shape's points be node-edited right now? A plain path or a primitive
   *  that converts to one, or a wrapped vector whose inner SOURCE is a path. Used by
   *  the Selection tool's double-click so it only drops into editing when it'll work. */
  canNodeEdit(id: string): boolean {
    const shape = this.findShapeById(id);
    if (!shape || shape.locked) return false;
    if (shape.type === 'width' || shape.type === 'appearance') {
      const srcSel = shape.type === 'width' ? '[data-width-src]' : '[data-ap-src]';
      const src = shape.element.querySelector(`:scope > ${srcSel}`) as SVGElement | null;
      return !!src?.getAttribute('d'); // only a PATH source (rect/ellipse sources have no d)
    }
    // Figma-style: parametric primitives (rect / rounded rect / ellipse) are NOT
    // node-edited — exploding them into bezier anchors would destroy their live
    // corner-radius / W-H form. Only freeform paths and point-based shapes qualify.
    return ['path', 'polygon', 'polyline', 'line'].includes(shape.type);
  }

  /** The element whose `d` node-editing reads/writes: the inner source for a wrapped
   *  vector, else the shape element itself. */
  editingGeometryEl(): SVGElement | null {
    return this.editingSourceEl ?? this.findShapeById(this.editingPathId ?? '')?.element ?? null;
  }

  /** Write edited geometry back and regenerate the wrapper (no-op regen for a plain
   *  path). Used by the node tool's live preview and by commit. */
  applyEditGeometry(d: string): void {
    const el = this.editingGeometryEl();
    if (el) el.setAttribute('d', d);
    this.editingRegen?.();
  }

  /** Edit a mask's CUTTER shape: model it (via maskEditId), select it, and drop into
   *  the node editor with the clip live — so reshaping updates the masked result in
   *  real time. Teardown is centralized in exitPathEdit (fires on every exit route). */
  enterMaskEdit(maskId: string): void {
    const mask = this.findShapeById(maskId);
    if (!mask || mask.locked || !mask.element.hasAttribute('data-clip-group')) return;
    this.maskEditId = maskId;
    this.rebuildShapesFromDOM(); // now models the cutter as an editable child
    const cp = Array.from(mask.element.children).find(c => c.tagName.toLowerCase() === 'clippath');
    const cutterId = (cp?.firstElementChild as SVGElement | null)?.id;
    if (!cutterId) { this.maskEditId = null; this.rebuildShapesFromDOM(); return; }
    // Parametric primitives (rect/ellipse) aren't node-editable; convert the cutter to
    // a <path> IN PLACE (id + geometry preserved, so the clip stays visually identical).
    if (!this.canNodeEdit(cutterId)) {
      const cs = this.findShapeById(cutterId);
      if (cs && this.convertShapeToPath(cs)) { this.rebuildShapesFromDOM(); this.saveHistory(); }
    }
    this.selectShape(cutterId);
    this.nodeEditReturnTool = 'select';
    this.requestTool?.('directSelect'); // NodeEditTool.activate() → enterPathEdit(cutter)
    this.notify();
  }

  exitPathEdit(notify = true): void {
    const hadMaskEdit = !!this.maskEditId;
    if (!this.editingPathId && !this.pathEdit) {
      // No node session, but a mask-edit could still be dangling (edge case) — clear it.
      if (hadMaskEdit) { this.maskEditId = null; this.rebuildShapesFromDOM(); if (notify) this.notify(); }
      return;
    }
    this.editingPathId = null;
    this.pathEdit = null;
    this.editingSourceEl = null;
    this.editingRegen = null;
    // Leaving node editing (incl. Escape mid-drag) ends any interactive gesture,
    // so the side-panel render guard can't get stuck on.
    this.interactive = false;
    // End a mask-edit session on ANY node-edit exit route (Esc, click-away, tool
    // switch, selecting another shape): un-model the cutter. Editor-state only, so
    // there's no DOM to reverse — the mask markup was never restructured.
    if (hadMaskEdit) { this.maskEditId = null; this.rebuildShapesFromDOM(); }
    // A point edit entered by double-click hops back to the tool it came from on
    // EVERY exit route, not just the node tool's own (Esc / click-away). Picking a
    // layer in the Layers panel or undoing ended the edit but left the node tool
    // active with nothing to edit, where a press only selects: a pasted image then
    // looked selected but wouldn't move or resize until a reload.
    const back = this.nodeEditReturnTool;
    if (back && this.currentTool === 'directSelect') {
      this.nodeEditReturnTool = null;
      this.requestTool?.(back);
    }
    if (notify) this.notify();
  }

  /** Write the live model back to the element's `d`. `record` saves an undo step. */
  commitPathEdit(record = true): void {
    if (!this.editingPathId || !this.pathEdit) return;
    const shape = this.findShapeById(this.editingPathId);
    if (!shape) return;
    if (this.pathEdit.isEmpty) {
      // A mask cutter emptied to nothing would clip the content away entirely — don't
      // delete it; just leave editing (mirrors the clip-group guards elsewhere).
      if (shape.element.parentElement?.tagName.toLowerCase() === 'clippath') { this.exitPathEdit(); return; }
      // All nodes deleted — remove the now-empty path.
      this.removeShape(this.editingPathId);
      this.exitPathEdit();
      return;
    }
    this.applyEditGeometry(this.pathEdit.commit());
    if (record) this.saveHistory();
    this.notify();
  }

  // Layer-panel operations are owned by LayerManager; these delegate.
  toggleVisibility(id: string): void { this.layerMgr.toggleVisibility(id); }
  toggleLock(id: string): void { this.layerMgr.toggleLock(id); }
  showAll(): void { this.layerMgr.showAll(); }
  unlockAll(): void { this.layerMgr.unlockAll(); }
  moveShapeUp(id: string): void { this.layerMgr.moveShapeUp(id); }
  moveShapeDown(id: string): void { this.layerMgr.moveShapeDown(id); }
  moveShape(draggedId: string, targetId: string, position: 'before' | 'after' | 'inside', outdentLevels = 0): boolean { return this.layerMgr.moveShape(draggedId, targetId, position, outdentLevels); }
  groupShapes(dragged: string | string[], targetId: string): boolean { return this.layerMgr.groupShapes(dragged, targetId); }
  canDrop(draggedId: string, targetId: string, zone: 'before' | 'after' | 'inside' | 'onto', outdentLevels = 0): boolean { return this.layerMgr.canDrop(draggedId, targetId, zone, outdentLevels); }
  bringToFront(): void { this.layerMgr.bringToFront(); }
  sendToBack(): void { this.layerMgr.sendToBack(); }
  duplicateShape(id: string): void { this.layerMgr.duplicateShape(id); }
  duplicateSelected(): void { this.layerMgr.duplicateSelected(); }
  notifyMovedSelection(dx: number, dy: number): void { this.layerMgr.notifyMovedSelection(dx, dy); }

  // ---- Clipboard ----
  // Cut/copy/paste live in core/clipboard.ts; AppState owns the manager and the
  // host adapter (built in the constructor) and delegates the public methods.

  copyShape(id: string): void { this.clipboardMgr.copyShape(id); }
  copySelected(): void { this.clipboardMgr.copySelected(); }
  cutShape(id: string): void { this.clipboardMgr.cutShape(id); }
  cutSelected(): void { this.clipboardMgr.cutSelected(); }
  pasteClipboard(inPlace = false): boolean { return this.clipboardMgr.pasteClipboard(inPlace); }
  pasteFromSystemClipboard(): Promise<boolean> { return this.clipboardMgr.pasteFromSystemClipboard(); }
  pasteSvgMarkup(text: string): boolean { return this.clipboardMgr.pasteSvgMarkup(text); }

  /** Handle a paste of external system-clipboard content (raster image / vector).
   *  Wired by the UI layer (main.ts) since embedding an <image> is UI work; used
   *  by the menu's Paste command (Cmd+V goes through the DOM `paste` event). */
  pasteExternal: (() => void) | null = null;

  private offsetElement(el: SVGElement, dx: number, dy: number): void {
    const tag = el.tagName.toLowerCase();
    if (tag === 'rect' || tag === 'text' || tag === 'image' || tag === 'use' || tag === 'svg') {
      el.setAttribute('x', String(parseFloat(el.getAttribute('x') ?? '0') + dx));
      el.setAttribute('y', String(parseFloat(el.getAttribute('y') ?? '0') + dy));
    } else if (tag === 'ellipse') {
      el.setAttribute('cx', String(parseFloat(el.getAttribute('cx') ?? '0') + dx));
      el.setAttribute('cy', String(parseFloat(el.getAttribute('cy') ?? '0') + dy));
    } else if (tag === 'line') {
      el.setAttribute('x1', String(parseFloat(el.getAttribute('x1') ?? '0') + dx));
      el.setAttribute('y1', String(parseFloat(el.getAttribute('y1') ?? '0') + dy));
      el.setAttribute('x2', String(parseFloat(el.getAttribute('x2') ?? '0') + dx));
      el.setAttribute('y2', String(parseFloat(el.getAttribute('y2') ?? '0') + dy));
    } else if (tag === 'polyline' || tag === 'polygon') {
      // Same tokenizing rule as shape-adapters: commas and/or whitespace both
      // separate coordinates, so never split on one and assume the other.
      const nums = parsePointsList(el.getAttribute('points') ?? '');
      const moved: string[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) moved.push(`${nums[i] + dx},${nums[i + 1] + dy}`);
      el.setAttribute('points', moved.join(' '));
    } else if (tag === 'path' || tag === 'g') {
      nudgeTranslate(el, dx, dy);
    }
  }

  /** Fresh ids for a copied container's descendants. A frame's inline <clipPath> is
   *  not a layer: it is named after its frame (`frameclip-N`), so a copy's clip
   *  follows the copy's own id instead of taking a `shape-N` id that rebuild then
   *  finds in the DOM but not in the model. Call after the container has its new id. */
  private reIdGroupChildren(groupEl: SVGElement): void {
    const isFrame = groupEl.hasAttribute('data-frame');
    for (let i = 0; i < groupEl.children.length; i++) {
      const child = groupEl.children[i] as SVGElement;
      if (isFrame && child.tagName.toLowerCase() === 'clippath') {
        child.id = `frameclip-${groupEl.id.replace('shape-', '')}`;
        continue;
      }
      if (child.id) {
        child.id = this.nextId();
      }
      if (child.tagName.toLowerCase() === 'g') {
        this.reIdGroupChildren(child);
      }
    }
  }

  /** Record the current document as an undo step. Delegates the navigation
   *  bookkeeping to {@link History}; the document-specific snapshot is built by
   *  {@link captureSnapshot}. */
  saveHistory(): void {
    this.historyMgr.save();
  }

  /** Fold subsequent changes into the current undo entry instead of adding a new
   *  one (used to coalesce a held-arrow nudge run into one step). See History.amend. */
  amendHistory(): void {
    this.historyMgr.amend();
  }

  /** Serialize the live document into a history entry (the History `capture`
   *  callback). Scrubs transient editor-only artifacts so they never reach a
   *  snapshot. */
  private captureSnapshot(): HistoryEntry {
    // When isolated inside a live boolean, an operand was likely just edited —
    // refresh the cached result path before it is serialized. Synchronous: the
    // engine was warmed on isolation entry (see enterGroup).
    if (this.activeGroupId && booleanEngineReady()) {
      const active = this.findShapeById(this.activeGroupId);
      if (active?.type === 'boolean') this.pathfinder.recompute(active.element);
    }
    // Transient editor-only artifacts must never reach a history snapshot: the
    // `data-bool-editing` reveal hook (would survive undo and show operands) and
    // any live Pathfinder hover-preview ghost.
    this.drawingLayer.querySelectorAll('[data-boolean-preview],[data-mask-preview]').forEach((p) => p.remove());
    const editing = this.drawingLayer.querySelectorAll('[data-bool-editing]');
    editing.forEach((w) => w.removeAttribute('data-bool-editing'));
    const svgContent = xmlSafeMarkup(this.drawingLayer.innerHTML);
    editing.forEach((w) => w.setAttribute('data-bool-editing', ''));

    return {
      svgContent,
      selectedId: this.selectedShapeId,
      artboardsJson: JSON.stringify(this.artboards),
    };
  }

  /** Snapshot / restore the whole undo stack (used by the document tab manager to
   *  cache each tab's history). */
  exportHistory(): HistorySnapshot { return this.historyMgr.exportState(); }
  importHistory(s: HistorySnapshot): void { this.historyMgr.restoreState(s); }

  /** True when there are edits since the last save/open/new. */
  get dirty(): boolean { return this.historyMgr.dirty; }

  /** Document-version token; changes on every edit. Snapshot before an async save
   *  and compare after, so markClean only runs if nothing changed mid-await. */
  get revision(): number { return this.historyMgr.revision; }

  /** Mark the current state as the saved baseline (call after save/open/new). */
  markClean(): void { this.historyMgr.markClean(); }

  undo(): boolean { return this.historyMgr.undo(); }

  redo(): boolean { return this.historyMgr.redo(); }

  get canUndo(): boolean { return this.historyMgr.canUndo; }
  get canRedo(): boolean { return this.historyMgr.canRedo; }

  private restoreHistory(entry: HistoryEntry): void {
    // History holds already-sanitized markup, but re-sanitize so the invariant
    // "drawingLayer.innerHTML is never assigned unsanitized content" holds at
    // every sink unconditionally (defense in depth; undo/redo isn't hot).
    this.drawingLayer.innerHTML = sanitizeSvgMarkup(entry.svgContent);
    this.rebuildShapesFromDOM();
    this.selectedShapeIds = entry.selectedId ? [entry.selectedId] : [];
    // The new DOM lost the transient editing marker (scrubbed before snapshot).
    // Re-apply it if we're still isolated inside a boolean, so operands re-reveal.
    this.clearStaleIsolation();
    if (this.activeGroupId) {
      const active = this.findShapeById(this.activeGroupId);
      if (active?.type === 'boolean') active.element.setAttribute('data-bool-editing', '');
      else this.activeGroupId = null;
    }
    // Keep any node-editing session in sync with the restored geometry.
    if (this.editingPathId) {
      const shape = this.findShapeById(this.editingPathId);
      const d = shape?.element.getAttribute('d');
      if (shape && shape.type === 'path' && d) this.pathEdit = new PathEditSession(d);
      else this.exitPathEdit(false);
    }
    // Artboards now derive from the frame shapes in the restored markup
    // (syncArtboardsCache ran inside rebuildShapesFromDOM above), so there's no
    // separate artboardsJson to parse back.
    this.notify();
  }

  /** The editor has no `circle` shape type — everything round is an `<ellipse>`
   *  with rx=ry (the ellipse tool emits `<ellipse>`), and per-type geometry,
   *  nudge, stroke-align, and the Properties panel all dispatch on `ellipse`
   *  only. Foreign/imported SVG, however, commonly uses `<circle>`, which then
   *  rendered on canvas but was unmodeled — invisible in Layers and unselectable
   *  (issue #177). Rather than thread a `circle` special-case through every
   *  tag/type dispatch, normalize each `<circle>` in the drawing layer to an
   *  equivalent `<ellipse>` (cx/cy kept, r → rx=ry) at this single choke point
   *  every ingestion path flows through. Idempotent (no circles remain after the
   *  first pass, so re-runs on undo/redo/rebuild are no-ops); overlay/handle
   *  circles live in other layers and `<circle>`s inside `<defs>` aren't in the
   *  drawing layer, so neither is touched. */
  private normalizeCircles(): void {
    const circles = this.drawingLayer.querySelectorAll('circle');
    for (const c of Array.from(circles)) {
      const ell = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
      for (const attr of Array.from(c.attributes)) {
        if (attr.name === 'r') continue; // r has no ellipse equivalent — becomes rx/ry
        ell.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
      }
      const r = c.getAttribute('r') ?? '0';
      ell.setAttribute('rx', r);
      ell.setAttribute('ry', r);
      c.replaceWith(ell);
    }
  }

  rebuildShapesFromDOM(): void {
    this.normalizeCircles(); // fold imported <circle> into <ellipse> before modeling
    this.shapes = [];
    this.shapeById.clear(); // shapes are rebuilt from scratch; drop stale cache
    this.resolveAuthorStyles(); // author <style> paint → attributes, so edits render
    this.refreshStylesheetProps(); // which paint props an author stylesheet still sets

    // Foreign SVGs — and our own "clean"/TraceCraft exports that strip editor
    // ids — commonly have id-less elements. They render fine, but without an id
    // they never entered the model, so the artwork appeared on the canvas with
    // an EMPTY Layers panel. Assign ids so every renderable element becomes a
    // selectable, editable layer.
    //
    // Guardrail: skip this for pathological bulk imports (e.g. a 21MB generative
    // SVG with 100k+ id-less segments). Modeling each as its own layer is both
    // useless to edit and prohibitively slow, so above the cap we keep the old
    // behavior — only elements that already carry an id become layers.
    const assignIds = this.drawingLayer.querySelectorAll('*').length <= AUTO_ID_MODEL_LIMIT;

    // Bump the id counter above every existing shape-N in the tree first, so the
    // ids we assign below can't collide with ids already present (top level or
    // nested inside groups).
    if (assignIds) {
      this.drawingLayer.querySelectorAll('[id]').forEach((el) => {
        const m = (el as SVGElement).id.match(/^shape-(\d+)$/);
        if (m) this.idCounter = Math.max(this.idCounter, parseInt(m[1]));
      });
    }

    const elements = this.drawingLayer.children;

    const processElement = (el: SVGElement): ShapeData | null => {
      const type = this.detectType(el);
      if (!type) return null; // not a renderable shape (metadata, unknown tag)

      let id = el.id;
      if (!id) {
        if (!assignIds) return null; // bulk import — leave id-less elements unmodeled
        id = this.nextId();
        el.id = id;
      }

      const shape: ShapeData = {
        // The one narrowing point for the whole model: detectType only recognises
        // renderable shapes, and every one of those is an SVGGraphicsElement (#193).
        id, type, element: el as SVGGraphicsElement,
        name: el.getAttribute('data-name') || `${type} ${id.replace('shape-', '#')}`,
        style: this.readStyle(el, type),
        visible: el.style.display !== 'none',
        locked: el.getAttribute('data-locked') === 'true',
      };

      // A component instance's symbol link is derived from the element's own
      // href, like every other modelled property. It used to be set ONLY on the
      // object placeSymbolInstance pushed, so the first rebuild — i.e. any
      // structural edit, undo, or load — silently dropped it, leaving Detach
      // Instance, the library's instance lookup, and copy/paste of an instance
      // all reading null (#234).
      if (type === 'use') {
        const href = el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? '';
        if (href.startsWith('#')) shape.symbolId = href.slice(1);
      }

      // Read rotation from the transform list (robust to matrix()/ordering).
      const rot = getRotation(el);
      if (rot) shape.rotation = rot;

      // Rebuild children for groups
      if (type === 'group') {
        shape.children = [];
        for (let j = 0; j < el.children.length; j++) {
          const child = processElement(el.children[j] as SVGElement);
          if (child) {
            child.parentId = id;
            shape.children.push(child);
          }
        }
        // While THIS mask is being edited, additionally model its cutter (the shape
        // inside the <clipPath>) as an editable child so it can be node-edited. Only
        // during its own session — normal masks stay leaf-like and the cutter hidden.
        if (this.maskEditId === id) {
          const cp = Array.from(el.children).find(c => c.tagName.toLowerCase() === 'clippath');
          const cutter = cp?.firstElementChild as SVGElement | null;
          const child = cutter ? processElement(cutter) : null;
          if (child) { child.parentId = id; shape.children.push(child); }
        }
      }

      // A frame contains its children like a group, but its own <clipPath> and
      // .frame-bg rect are managed chrome, not model shapes — skip them.
      if (type === 'frame') {
        shape.children = [];
        for (let j = 0; j < el.children.length; j++) {
          const childEl = el.children[j] as SVGElement;
          const ctag = childEl.tagName.toLowerCase();
          if (ctag === 'clippath' || childEl.classList.contains('frame-bg')) continue;
          const child = processElement(childEl);
          if (child) {
            child.parentId = id;
            shape.children.push(child);
          }
        }
      }

      // A live boolean's children are its operands (marked elements); the
      // <path data-bool-result> sibling is a managed cache, not a shape.
      if (type === 'boolean') {
        shape.booleanOp = (el.getAttribute('data-boolean') as ShapeData['booleanOp']) ?? 'unite';
        shape.children = [];
        for (let j = 0; j < el.children.length; j++) {
          const childEl = el.children[j] as SVGElement;
          if (!childEl.hasAttribute('data-bool-operand')) continue;
          const child = processElement(childEl);
          if (child) {
            child.parentId = id;
            shape.children.push(child);
          }
        }
      }

      // A repeat grid models only its SOURCE (a real, fully editable child shape);
      // the [data-repeat-clone] copies are regenerated cache, never model shapes.
      if (type === 'repeat') {
        shape.children = [];
        for (let j = 0; j < el.children.length; j++) {
          const childEl = el.children[j] as SVGElement;
          if (childEl.hasAttribute('data-repeat-clone')) continue;
          const child = processElement(childEl);
          if (child) {
            child.parentId = id;
            shape.children.push(child);
          }
        }
      }

      return shape;
    };

    for (let i = 0; i < elements.length; i++) {
      const shape = processElement(elements[i] as SVGElement);
      if (shape) this.shapes.push(shape);
    }
    this.clearStaleIsolation();
    // Effect <filter> defs aren't in the history snapshot — rebuild them from the
    // round-tripped data-fx-* attrs so blur/shadow survive undo, redo, and load.
    this.effects.ensureFilters();
    // Blend mode: adopt inline-only styles into data-blend, and re-derive the style.
    this.compositing.ensureBlend();
    // Regenerate per-frame dim-overflow masks (defs aren't snapshotted); also migrates
    // older hard-clipping frames to the mask on load.
    this.ensureFrameOverflowMasks();
    // Likewise the shared marker library, if any element references it.
    if (this.drawingLayer.querySelector('[marker-start],[marker-end]')) this.ensureMarkerDefs();
    // Frames are the source of truth; refresh the derived artboards cache that
    // rulers/export/snapping/status-bar read from.
    this.syncArtboardsCache();
    // Text-style library is carried in a <metadata> element inside the layer (not
    // in defs), so it round-trips the snapshot; re-derive the model from it so the
    // library re-syncs after undo/redo/load. See core/text-styles.ts.
    this.textStyleReg.syncFromDOM();
    // The generic Asset Library store rides the same <metadata> carrier; re-derive it too.
    this.libraryReg.syncFromDOM();
    // Embedded fonts ride the same carrier; re-derive the model AND re-register the
    // FontFaces (a regenerated cache, not snapshotted) so imported text keeps its
    // real typeface after undo/redo/load. See core/embedded-fonts.ts.
    // Linked patterns re-capture from their source object (and freeze into a copy
    // if it's gone) — a regenerated cache, like the filters above.
    this.refreshLinkedPatterns();
    // Components carry their <symbol> markup in a <metadata> carrier too, so they
    // survive undo/redo/load; this regenerates the <defs> cache from it.
    this.symbolRegistry.syncFromDOM();
    // Gradients do the same: their <defs> aren't snapshotted, so a deleted gradient
    // was unrecoverable on undo (shapes went black) until the carrier (#179).
    this.paint.syncGradientsFromDOM();
    this.embeddedFontReg.syncFromDOM();
    this.embeddedFontReg.ensureFontFaces();
  }

  private detectType(el: SVGElement): ShapeData['type'] | null {
    if (el.hasAttribute('data-mask-preview')) return null; // transient hover ghost — never a model shape
    // Same for the Pathfinder hover ghost: it can land asynchronously (engine warm-up)
    // after the commit's clearPreview, and modeling it minted phantom top-level
    // layers with dead ids (#212).
    if (el.hasAttribute('data-boolean-preview')) return null;
    if (el.hasAttribute('data-text-stroke-cache')) return null; // regenerated text-stroke outline (see core/text-stroke.ts)
    const tag = el.tagName.toLowerCase();
    if (tag === 'rect') return 'rect';
    if (tag === 'ellipse') return 'ellipse';
    if (tag === 'line') return 'line';
    if (tag === 'polyline') return 'polyline';
    if (tag === 'polygon') return 'polygon';
    // A parametric rectangle with per-corner radii is a <path data-rect> but is still
    // a rectangle (box + radii editable via the panel), never a freeform path.
    if (tag === 'path' && el.hasAttribute('data-rect')) return 'rect';
    if (tag === 'path') return 'path';
    if (tag === 'text') return 'text';
    if (tag === 'g') {
      // Before the generic group branch: a linked file is one layer, and its
      // generated children must never become phantom layers.
      if (el.hasAttribute('data-linked-file')) return 'linked';
      if (el.hasAttribute('data-appearance')) return 'appearance';
      if (el.hasAttribute('data-width')) return 'width';
      if (el.hasAttribute('data-boolean')) return 'boolean';
      if (el.hasAttribute('data-frame')) return 'frame';
      if (el.hasAttribute('data-repeat')) return 'repeat';
      return 'group';
    }
    if (tag === 'image') return 'image';
    // A cropped raster is a self-contained nested <svg data-crop> viewport wrapping
    // one <image>; modeled as a single image leaf (rebuild never recurses into <svg>).
    if (tag === 'svg' && el.hasAttribute('data-crop')) return 'image';
    if (tag === 'use') return 'use';
    return null;
  }

  /**
   * Hand paint that an author `<style>` supplies (Illustrator's `.cls-1{…}` classes)
   * over to presentation attributes, so the controls — which write attributes, the
   * weakest layer of the cascade — actually change what renders. See
   * core/author-styles.ts. Idempotent: once a document's rules are resolved there's
   * nothing left to find, so later rebuilds pay only the `<style>` query.
   */
  private resolveAuthorStyles(): void {
    const defs = this.defsElement ?? this.drawingLayer.closest('svg')?.querySelector('defs') ?? null;
    const styles = [
      ...Array.from(this.drawingLayer.querySelectorAll('style')),
      ...Array.from(defs?.querySelectorAll('style') ?? []),
    ];
    if (styles.length === 0) return;
    // The artwork plus the defs it draws through (symbols, patterns, markers). Editor
    // chrome is left out: a stripped `rect{fill:…}` should stop painting the frame
    // backgrounds and the grid, not be pinned onto them.
    resolveAuthorStyles(styles, () => [
      ...Array.from(this.drawingLayer.querySelectorAll('*')).filter((el) => !el.classList.contains('frame-bg')),
      ...Array.from(defs?.querySelectorAll('*') ?? []).filter((el) => !el.closest(EDITOR_DEFS_SELECTOR)),
    ]);
  }

  /**
   * Scan author `<style>` blocks for which {@link FLATTEN_PROPS} they declare,
   * so {@link flattenInlineStyle} knows which properties need the cascade-
   * preserving guard. Cheap and called once per rebuild; for the common case of
   * no author stylesheet, the result is empty and flattening takes the fast path.
   */
  private refreshStylesheetProps(): void {
    this.stylesheetPaintProps.clear();
    const styles = this.drawingLayer.closest('svg')?.querySelectorAll('style');
    if (!styles || styles.length === 0) return;
    let css = '';
    styles.forEach(s => { css += s.textContent || ''; });
    for (const prop of FLATTEN_PROPS) {
      if (new RegExp(`(^|[\\s{;])${prop}\\s*:`).test(css)) this.stylesheetPaintProps.add(prop);
    }
  }

  /**
   * SVGs imported from other tools (e.g. Inkscape) keep their paint in the CSS
   * `style` attribute. BuzzQuill reads and writes presentation attributes, so we
   * promote inline paint to attributes and drop it from `style` so both stay in
   * sync.
   *
   * Cascade caveat: inline style outranks an author `<style>` rule, but a
   * presentation attribute does not. So when a stylesheet also targets the
   * property, blindly moving it to an attribute can let the stylesheet win and
   * silently change what renders. For those properties we move the value, check
   * the computed result is unchanged, and revert (leaving it as inline style) if
   * it isn't — preferring faithful rendering over editability in that rare clash.
   */
  private flattenInlineStyle(el: SVGElement): void {
    if (!el.getAttribute('style')) return;
    for (const prop of FLATTEN_PROPS) {
      const val = el.style.getPropertyValue(prop);
      if (!val) continue;

      if (this.stylesheetPaintProps.has(prop)) {
        const before = getComputedStyle(el).getPropertyValue(prop);
        const hadAttr = el.hasAttribute(prop);
        const prevAttr = hadAttr ? el.getAttribute(prop) : null;
        el.setAttribute(prop, val);
        el.style.removeProperty(prop);
        if (getComputedStyle(el).getPropertyValue(prop) !== before) {
          // Demotion changed the rendering — a stylesheet rule now wins. Revert.
          el.style.setProperty(prop, val);
          if (hadAttr) el.setAttribute(prop, prevAttr!);
          else el.removeAttribute(prop);
        }
      } else {
        el.setAttribute(prop, val); // inline style wins, so overwrite the attribute
        el.style.removeProperty(prop);
      }
    }
    if (!el.getAttribute('style')?.trim()) el.removeAttribute('style');
  }

  /**
   * Paint that reaches an element through a CSS-class rule (`.st0{fill:…}` — the
   * default of Illustrator's "Presentation Attributes → Internal CSS" export) or by
   * INHERITANCE from an ancestor `<g fill=…>` never lands on the element as an
   * attribute or inline style, so readStyle used to report the SVG defaults (white
   * fill / no stroke) even though the shape clearly rendered coloured (issue #139).
   *
   * Bake the *computed* value of those paint properties onto the element as a
   * presentation attribute so the model — and the Fill/Stroke panel — reflect what
   * actually renders. Also makes the colour snapshot-safe: a `<style>` in `<defs>`
   * isn't in the history snapshot, so without this the colour would vanish on undo.
   *
   * Gated to shapes that genuinely take paint from a stylesheet or a paint-bearing
   * ancestor, so plain shapes (and native docs) never pay the getComputedStyle cost
   * and never get defaults spammed onto them. resolveAuthorStyles normally hands
   * class-rule paint over to attributes first, so the stylesheet branch only sees a
   * rule it couldn't take over; there the rule still out-ranks the attribute for
   * RENDERING, so baking changes nothing visually — it only records the value.
   */
  private flattenComputedPaint(el: SVGElement): void {
    const need = new Set<string>();
    // Props an author <style> declares (refreshStylesheetProps scanned them).
    for (const p of this.stylesheetPaintProps) if (COMPUTED_PAINT_PROPS.includes(p)) need.add(p);
    // Inherited paint is deliberately NOT baked. Copying an ancestor's fill onto
    // each child made the model accurate but flattened the document: the group's
    // own fill became permanently inert (#206/#208), and imported artwork that
    // paints by inheritance — a core SVG idiom — was silently rewritten on load.
    // readStyle now RESOLVES inherited paint for display instead (effectivePaint),
    // so the model still reflects what renders without touching the markup.
    const layer: Element = this.drawingLayer;
    // Plain SVG default: a paintable leaf with NO fill source ANYWHERE still
    // renders — SVG's initial fill is BLACK, not none — yet readStyle/getAppearance
    // reported "No fill" for a clearly-black shape (issue #139). Record the computed
    // fill in that case only. The inherits-from-an-ancestor case is excluded here:
    // it was the part that made group fills inert, and it is what effectivePaint
    // resolves on read instead.
    if (PAINTABLE_LEAF_TAGS.has(el.tagName.toLowerCase()) &&
        ownedPaint(el, 'fill') === null && !inheritsPaint(el, 'fill', layer)) {
      need.add('fill');
    }
    if (need.size === 0) return;
    const cs = getComputedStyle(el);
    for (const p of need) {
      if (el.hasAttribute(p) || el.style.getPropertyValue(p)) continue; // element already owns it
      const v = cs.getPropertyValue(p).trim();
      if (!v || (p === 'stroke' && v === 'none')) continue; // don't bake a redundant no-stroke
      el.setAttribute(p, v);
    }
  }

  private readStyle(el: SVGElement, type: ShapeData['type']): ShapeStyle {
    this.flattenInlineStyle(el);
    this.flattenComputedPaint(el);
    // Prefer the element's own value (presentation attribute, else the inline
    // style flattenInlineStyle may have left behind), then fall back to whatever
    // it INHERITS from an ancestor. Resolving here rather than baking onto the
    // element is what lets a group's fill stay live and keeps imported artwork's
    // authored structure intact (#208), while the model still reports the paint
    // the user actually sees (#139). Non-inheritable props (opacity) resolve to
    // the element's own value only — effectivePaint enforces that.
    const attr = (name: string): string | null =>
      effectivePaint(el, name, this.drawingLayer);
    if (type === 'group' || type === 'image' || type === 'use' || type === 'boolean' || type === 'appearance' || type === 'width' || type === 'repeat') {
      const style: ShapeStyle = {
        fill: attr('fill') ?? 'none',
        stroke: attr('stroke') ?? 'none',
        strokeWidth: parseFloat(attr('stroke-width') ?? '0'),
        opacity: parseFloat(attr('opacity') ?? '1'),
      };
      // A plain group that owns no paint reports what its CONTENTS paint. Imported
      // artwork colours each leaf, so reading only the group's own attribute told
      // the user a visibly grey icon had "no fill" (and the swatch showed empty).
      if (type === 'group' && isPlainGroup(el)) {
        if (ownedPaint(el, 'fill') === null) {
          const c = containerPaint(el, 'fill', this.drawingLayer);
          if (c.value !== null) { style.fill = c.value; style.fillMixed = c.mixed; }
        }
        if (ownedPaint(el, 'stroke') === null) {
          const c = containerPaint(el, 'stroke', this.drawingLayer);
          if (c.value !== null) { style.stroke = c.value; style.strokeMixed = c.mixed; }
        }
      }
      // An appearance wrapper's stroke details live on its stack's layers, not as
      // attributes — mirror the TOP paintable stroke (the layer the Properties
      // panel's shared controls edit) so multi-selection readbacks compare real
      // values instead of reporting "Mixed" against plain shapes.
      if (type === 'appearance') {
        try {
          const layers = JSON.parse(el.getAttribute('data-appearance') || '[]') as AppearanceLayer[];
          const t = Array.isArray(layers) ? layers.find(l => l && l.t === 'stroke' && !l.cut) : undefined;
          if (t) {
            style.strokeOpacity = t.opacity ?? 1;
            style.strokeLinecap = t.cap ?? 'butt';
            style.strokeLinejoin = t.join ?? 'miter';
            style.strokeMiterlimit = t.miter ?? 4;
            style.strokeDasharray = t.dash ?? '';
            style.strokeDashoffset = t.dashOffset ?? 0;
            style.strokeNonScaling = !!t.nonScaling;
          }
          const f = Array.isArray(layers) ? layers.find(l => l && l.t === 'fill') : undefined;
          if (f) style.fillOpacity = f.opacity ?? 1;
        } catch { /* malformed stack attr — leave the representative attrs */ }
      }
      return style;
    }
    const fill = attr('fill') ?? (type === 'line' ? 'none' : '#FFFFFF');
    // SVG's default stroke is 'none' — a missing stroke attribute renders no outline,
    // so report 'none' (not black) to keep the model truthful. Tools always set an
    // explicit stroke, so this only affects strokeless elements (text, imports).
    const stroke = attr('stroke') ?? 'none';
    // Inside/outside alignment renders at double width (see stroke-align.ts);
    // the data-stroke-align marker lets us recover the authored width.
    const align = el.getAttribute('data-stroke-align');
    const rawWidth = parseFloat(attr('stroke-width') ?? (stroke === 'none' ? '0' : '1'));
    const strokeWidth = (align === 'inside' || align === 'outside') ? rawWidth / 2 : rawWidth;
    const opacity = parseFloat(attr('opacity') ?? '1');
    const style: ShapeStyle = { fill, stroke, strokeWidth, opacity };
    style.fillOpacity = parseFloat(attr('fill-opacity') ?? '1');
    style.strokeOpacity = parseFloat(attr('stroke-opacity') ?? '1');
    style.strokeAlign = (align === 'inside' || align === 'outside') ? align : 'center';
    style.strokeLinecap = el.getAttribute('stroke-linecap') ?? 'butt';
    style.strokeLinejoin = el.getAttribute('stroke-linejoin') ?? 'miter';
    style.strokeMiterlimit = parseFloat(el.getAttribute('stroke-miterlimit') ?? '4');
    style.strokeDasharray = el.getAttribute('stroke-dasharray') ?? '';
    style.strokeDashoffset = parseFloat(el.getAttribute('stroke-dashoffset') ?? '0');
    style.strokeNonScaling = (el.getAttribute('vector-effect') ?? '').includes('non-scaling-stroke');
    if (type === 'rect') {
      // Uniform radius for the model/style; the panel reads the full 4 radii live
      // from the element (readRectBox) when it needs per-corner values.
      style.rx = readRectBox(el).radii[0];
    }
    if (type === 'text') {
      style.fontSize = parseFloat(el.getAttribute('font-size') ?? '24');
      style.fontFamily = el.getAttribute('font-family') ?? 'Arial';
      style.fontWeight = el.getAttribute('font-weight') ?? 'normal';
      style.fontStyle = el.getAttribute('font-style') ?? 'normal';
    }
    return style;
  }

  // Multi-selection support
  selectedShapeIds: string[] = [];

  selectMultiple(ids: string[]): void {
    this.selectedShapeIds = ids;
    this.notify();
  }

  toggleMultiSelect(id: string): void {
    const idx = this.selectedShapeIds.indexOf(id);
    if (idx >= 0) {
      this.selectedShapeIds.splice(idx, 1);
    } else {
      this.selectedShapeIds.push(id);
    }
    this.notify();
  }

  /**
   * Fast id→shape lookup cache. Entries are validated on read (a removed shape's
   * element is disconnected, a stale entry's id won't match) and refilled from a
   * tree walk on miss, so the cache is always correct even if a mutation site
   * forgets to update it — it only ever falls back to the old O(n) behavior.
   */
  private shapeById = new Map<string, ShapeData>();

  findShapeById(id: string, list?: ShapeData[]): ShapeData | null {
    // Caller-scoped searches (passing an explicit subtree) bypass the cache.
    if (list) return this.walkFindShape(id, list);

    const cached = this.shapeById.get(id);
    if (cached && cached.id === id && cached.element.isConnected) return cached;

    const found = this.walkFindShape(id, this.shapes);
    if (found) this.shapeById.set(id, found);
    else this.shapeById.delete(id);
    return found;
  }

  private walkFindShape(id: string, list: ShapeData[]): ShapeData | null {
    for (const s of list) {
      if (s.id === id) return s;
      if (s.children) {
        const found = this.walkFindShape(id, s.children);
        if (found) return found;
      }
    }
    return null;
  }

  /** Mirror the selection horizontally or vertically about its union-bbox centre.
   *  Frames are excluded (axis-aligned containers). Geometry-folds where the type
   *  allows, else stores a reflection transform (images/text/groups/rotated). */
  flipSelected(axis: FlipAxis): void {
    const shapes = this.getSelectedShapes().filter(s => s.type !== 'frame');
    if (shapes.length === 0) return;
    const svg = this.drawingLayer.ownerSVGElement;
    if (!svg) return;
    // Union world (drawing-layer) bbox → the reflection axis passes through its centre.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of shapes) {
      const b = localBBoxInLayer(svg, s.element);
      if (!b) continue;
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
    }
    if (!Number.isFinite(minX)) return;
    const c = axis === 'horizontal' ? (minX + maxX) / 2 : (minY + maxY) / 2;
    const R = reflectionMatrix(axis, c);
    for (const s of shapes) flipElement(s.element, R, this.drawingLayer);
    this.rebuildShapesFromDOM();
    this.saveHistory();
    this.notify();
  }

  // Grouping is owned by LayerManager with the other Layers-panel verbs (#192).
  groupSelectedShapes(): void { this.layerMgr.groupSelectedShapes(); }
  /** Create a new empty group ("layer") at the top of the stack. */
  addEmptyGroup(): void { this.layerMgr.addEmptyGroup(); }
  ungroupShape(id: string): void { this.layerMgr.ungroupShape(id); }

  /**
   * Convert the selected TEXT objects to editable `<path>` outlines, in place —
   * the destructive, explicit counterpart to the non-destructive export-time
   * outline (both share core/text-outline). One undo step; selection moves to the
   * new paths; position, fill, transform and id are preserved. Handles multi-line,
   * wrapped area text, text-on-a-path, letter-spacing, case and weight/italic via
   * the element's real layout. Returns any per-object notes for the caller to
   * surface. Bundled fonts only — a non-bundled family is reported and kept as text.
   */
  async outlineSelectedText(): Promise<string[]> {
    const texts = this.getSelectedShapes().filter(s => s.type === 'text');
    if (texts.length === 0) return [];
    const notes: string[] = [];
    const newIds: string[] = [];
    let changed = false;
    for (const shape of texts) {
      const el = shape.element as unknown as SVGTextElement;
      const result = await outlineLiveText(el); // el is live/rendered → measured in place
      if (!result) continue; // empty text
      if ('skip' in result) {
        notes.push(`“${(el.textContent ?? '').trim().slice(0, 24) || 'text'}” — ${result.skip}; left as text.`);
        continue;
      }
      if (!result.id) result.id = shape.id; // keep the same shape id for continuity
      el.replaceWith(result);
      newIds.push(result.id);
      changed = true;
    }
    if (changed) {
      this.rebuildShapesFromDOM();
      this.selectedShapeIds = newIds;
      this.saveHistory();
      this.notify();
    }
    return notes;
  }

  // ---- Boolean / Pathfinder (live compound shapes) ----

  /**
   * Combine the current top-level selection with a Pathfinder op. The four
   * single-output ops build a LIVE `<g data-boolean>` whose operands stay
   * editable (double-click to enter isolation) and whose cached result path
   * recomputes on edit. `divide` produces a plain group of the disjoint pieces.
   * Operands are taken in document order (bottom→top z), which defines subtract.
   * Returns false (no-op) when fewer than two shapes are selected or the result
   * is empty (e.g. intersecting disjoint shapes).
   */
  // Pathfinder / boolean / shape-builder / outline / offset are owned by
  // PathfinderManager; these delegate. selectedInDomOrder / commonParentOf /
  // convertShapeToPath stay here (grouping & clipping use them too) and are
  // surfaced to the manager through its host.
  booleanSelection(op: BooleanOp, reverse = false): Promise<boolean> { return this.pathfinder.booleanSelection(op, reverse); }
  previewSelectionBoolean(op: BooleanOp, reverse = false): string[] { return this.pathfinder.previewSelectionBoolean(op, reverse); }
  selectionFaces(): Promise<{ faces: string[]; ids: string[] } | null> { return this.pathfinder.selectionFaces(); }
  replaceShapesWithPaths(originalIds: string[], resultDs: string[], fill: string): void { this.pathfinder.replaceShapesWithPaths(originalIds, resultDs, fill); }
  flattenBoolean(id: string): void { this.pathfinder.flatten(id); }
  flattenMask(id: string): Promise<void> { return this.pathfinder.flattenMask(id); }
  canFlattenMask(el: SVGElement): boolean { return this.pathfinder.canFlattenMask(el); }
  outlineSelectedStroke(): Promise<boolean> { return this.pathfinder.outlineSelectedStroke(); }
  offsetSelectedPath(delta: number): Promise<boolean> { return this.pathfinder.offsetSelectedPath(delta); }

  // Round Corners / Smooth are owned by CornerManager; these delegate. The
  // preview trio is what the Round Corners dialog drives.
  canRoundCorners(): boolean { return this.corners.canApply(); }
  /** Join (⌘J): close one open path, join two at their nearest ends, or — while node
   *  editing — join the two selected end points. See core/path-join.ts. */
  canJoinPaths(): boolean { return this.pathJoin.canJoin(); }
  joinPaths(tolWorld: number): boolean { return this.pathJoin.join(tolWorld); }
  /** Reverse Path Direction: run paths the other way without moving a pixel of them.
   *  See core/path-direction.ts. */
  canReversePaths(): boolean { return this.pathDirection.canReverse(); }
  reverseSelectedPaths(): ReverseResult { return this.pathDirection.reverseSelected(); }
  reversePaths(ids: string[]): ReverseResult { return this.pathDirection.reverse(ids); }
  smoothSelectedPaths(): boolean { return this.corners.smoothSelected(); }
  roundSelectedCorners(radius: number): boolean { return this.corners.roundSelected(radius); }
  beginCornerPreview(): boolean { return this.corners.beginPreview(); }
  previewCornerRadius(radius: number): void { this.corners.previewRadius(radius); }
  commitCornerPreview(): boolean { return this.corners.commitPreview(); }
  cancelCornerPreview(): void { this.corners.cancelPreview(); }

  /** True while a live preview has written UNCOMMITTED geometry into the document
   *  (the Round Corners dialog). Autosaves hold off until it ends: a reload with the
   *  dialog open restored the preview as if it had been applied. */
  hasLivePreview(): boolean { return this.corners.previewing(); }

  /** Selected shapes resolved anywhere in the tree, sorted bottom→top (DOM order). */
  private selectedInDomOrder(): ShapeData[] {
    const shapes = this.selectedShapeIds
      .map(id => this.findShapeById(id))
      .filter((s): s is ShapeData => !!s);
    shapes.sort((a, b) =>
      (a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
    return shapes;
  }

  /** The element all shapes share as a direct parent, else the drawing layer. */
  private commonParentOf(shapes: ShapeData[]): SVGElement {
    const first = shapes[0]?.element.parentElement ?? null;
    if (first && shapes.every(s => s.element.parentElement === first)) {
      return first as unknown as SVGElement;
    }
    return this.drawingLayer;
  }


  /**
   * Replace a primitive element (rect, ellipse, polygon/star, line, polyline) with
   * an equivalent `<path>` in place, preserving id, paint, transform, name and any
   * operand tagging — everything but the primitive's geometry attributes. Geometry
   * is exact (its local d). Returns false for types with no single-path equivalent
   * (path itself, group, text, image, use, boolean), which can't be node-edited.
   */
  private convertShapeToPath(shape: ShapeData): boolean {
    const CONVERTIBLE: ReadonlyArray<ShapeData['type']> = ['rect', 'ellipse', 'line', 'polyline', 'polygon'];
    if (!CONVERTIBLE.includes(shape.type)) return false;
    const el = shape.element;
    const d = shapeToPathData(el);
    if (!d.trim()) return false;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    // Carry over everything except the primitive's geometry attributes — the union
    // of every type's GEOM_ATTRS, since e.g. a rect may carry stray rx/ry.
    const geomAttrs = new Set(Object.values(GEOM_ATTRS).flat());
    for (const a of Array.from(el.attributes)) {
      if (!geomAttrs.has(a.name)) path.setAttribute(a.name, a.value);
    }
    // A plain path now: a kept data-rect made the next rebuild call it a rect again,
    // and its next resize regenerated the box over whatever was done to the path.
    dropParametricAttrs(path);
    path.setAttribute('d', d);
    el.replaceWith(path);
    shape.element = path;
    shape.type = 'path';
    return true;
  }


  // ---- Clipping masks ----

  /**
   * Make a clipping mask from the selection (Illustrator's ⌘7): the TOPMOST
   * selected object becomes the mask, and everything below it is wrapped in a
   * group clipped to that shape. The mask geometry lives in an inline `<clipPath>`
   * *inside* the group, so the whole thing round-trips through history markup (no
   * defs needed — defs aren't part of the innerHTML snapshot). Returns false when
   * fewer than two shapes are selected.
   */
  /**
   * The cutter (topmost selected), the shapes it will clip, and their common parent
   * — the plan a Make-Clipping-Mask would execute. Exposed so the Mask hover PREVIEW
   * can build an identical ghost from the exact same members/parent, guaranteeing the
   * preview and the commit can never diverge. Null when fewer than two are selected.
   */
  clipMaskPlan(): { cutter: ShapeData; clipped: ShapeData[]; parent: SVGElement } | null {
    const members = this.selectedInDomOrder(); // anywhere in the tree, bottom→top
    if (members.length < 2) return null;
    return { cutter: members[members.length - 1], clipped: members.slice(0, -1), parent: this.commonParentOf(members) };
  }

  makeClippingMask(): boolean {
    const plan = this.clipMaskPlan();
    if (!plan) return false;
    const clip = plan.cutter; // topmost = the mask
    const clipped = plan.clipped;
    const parent = plan.parent;

    const SVG = 'http://www.w3.org/2000/svg';
    const gEl = document.createElementNS(SVG, 'g');
    const groupId = this.nextId();
    gEl.id = groupId;
    gEl.setAttribute('data-name', `Mask ${groupId.replace('shape-', '#')}`);
    gEl.setAttribute('data-clip-group', '');
    const clipId = `clipmask-${groupId.replace('shape-', '')}`;
    gEl.setAttribute('clip-path', `url(#${clipId})`);

    // Insert the group into the operands' parent first (so moving members in keeps
    // their coordinate space), then assemble.
    parent.insertBefore(gEl, clip.element.nextSibling);
    const clipPathEl = document.createElementNS(SVG, 'clipPath');
    clipPathEl.setAttribute('id', clipId);
    clipPathEl.appendChild(clip.element); // topmost object becomes the mask
    gEl.appendChild(clipPathEl);
    for (const s of clipped) gEl.appendChild(s.element);

    this.rebuildShapesFromDOM();
    this.selectedShapeIds = [groupId];
    this.saveHistory();
    this.notify();
    return true;
  }

  /** Release a clipping mask: restore the mask shape as a normal top child and
   *  drop the clip, leaving a plain group (Illustrator's ⌘⌥7). */
  releaseClippingMask(id: string): void {
    const shape = this.findShapeById(id);
    if (!shape || !shape.element.hasAttribute('data-clip-group')) return;
    const gEl = shape.element;
    const clipPathEl = Array.from(gEl.children).find(c => c.tagName.toLowerCase() === 'clippath');
    const clipShape = clipPathEl?.firstElementChild as SVGElement | null;
    if (clipShape) gEl.appendChild(clipShape); // back on top, as a normal child
    clipPathEl?.remove();
    gEl.removeAttribute('clip-path');
    gEl.removeAttribute('data-clip-group');
    gEl.setAttribute('data-name', `Group ${id.replace('shape-', '#')}`);
    this.rebuildShapesFromDOM();
    this.selectedShapeIds = [id];
    this.saveHistory();
    this.notify();
  }

  // ---- Appearance stack (multiple fills / strokes on one object) ------------
  //
  // Illustrator's Appearance panel: an object can carry several fills and strokes
  // stacked in z-order, each with its own paint / opacity / (stroke) width / blend.
  // SVG paints a single element with one fill + one stroke, so a rich stack is
  // stored as a `<g data-appearance="[layers]">` wrapper. Inside it:
  //   • one hidden `[data-ap-src]` element  → the canonical geometry (the object
  //     the user actually drew: rect / path / text / …), fill+stroke cleared;
  //   • N `[data-ap]` render-clones of that geometry, one per visible layer, each
  //     painted with a single fill or stroke, stacked bottom→top.
  // The render-clones live in the drawing layer, so they round-trip through the
  // history/innerHTML snapshot for free; rebuildShapesFromDOM models the wrapper
  // as a LEAF (type 'appearance') and never walks into it, so the clones never
  // become phantom layers. When a stack collapses to ≤1 fill and ≤1 stroke we
  // UNWRAP back to a plain native element, so ordinary shapes stay fully editable
  // (node tool, path ops) and only genuinely-stacked objects become leaves.

  // Appearance stacks are owned by AppearanceManager; these delegate.
  getAppearance(id: string): AppearanceLayer[] { return this.appearanceMgr.get(id); }
  setAppearance(id: string, layers: AppearanceLayer[], record = true): void {
    this.setAppearanceMulti([{ id, layers }], [id], record);
  }
  setAppearanceMulti(edits: Array<{ id: string; layers: AppearanceLayer[] }>, selectionAfter: string[], record = true): void {
    // The Fills/Appearance panel is the PRIMARY fill editor; reconciling here is what
    // makes "a manual edit detaches from the style" true for it. Mutate without
    // recording, reconcile, THEN record — otherwise the snapshot still carries the
    // link and a redo re-attaches a diverged object to its style.
    this.appearanceMgr.setMulti(edits, selectionAfter, false);
    this.reconcileStyleLinks(edits.map((e) => e.id));
    if (record) this.saveHistory();
  }
  /** Regenerate an appearance wrapper's render-clones from its (edited-in-place)
   *  source geometry — e.g. after restyling the font of a multi-stroke text. Lighter
   *  than setAppearance (no rebuild/selection reset), so it's safe during a live drag. */
  refreshAppearance(id: string): void {
    const shape = this.findShapeById(id);
    if (shape && shape.type === 'appearance') this.appearanceMgr.refresh(shape.element);
  }

  // ---- Reusable text styles (Phase 5) ---------------------------------------
  //
  // The registry owns the model + carrier persistence; AppState orchestrates
  // history recording, propagation to linked text, and change notification. The
  // LINK is a `data-text-style` attr on the object's outer element; applying a
  // style writes its props (via applyTextStyleProps) and stamps that attr, so the
  // link round-trips history/save for free. See core/text-styles.ts.

  /** Fonts embedded in the document (extracted from imported PDFs). Read-only list. */
  get embeddedFonts(): EmbeddedFont[] { return this.embeddedFontReg.list(); }
  /** Register a font in the document so text referencing its id renders in it.
   *  Caller batches the surrounding save/onChange (e.g. one undo step for an import). */
  addEmbeddedFont(font: EmbeddedFont): void { this.embeddedFontReg.add(font); }

  /** The document's text-style library (live model; do not mutate directly). */
  get textStyles(): TextStyle[] { return this.textStyleReg.list(); }
  getTextStyle(id: string): TextStyle | undefined { return this.textStyleReg.get(id); }

  /** True when a style can be created from / applied to this shape (text-backed). */
  canStyleText(shape: ShapeData): boolean { return isTextStyleTarget(shape); }

  /** Snapshot the current text props of a shape (for create/redefine-from-selection). */
  readTextProps(shape: ShapeData): TextStyleProps | null { return readTextStyleProps(shape); }

  /** Every shape currently linked to a style id (by its data-text-style attr). */
  shapesLinkedToStyle(styleId: string): ShapeData[] {
    const out: ShapeData[] = [];
    const visit = (list: ShapeData[]): void => {
      for (const s of list) {
        if (s.element.getAttribute('data-text-style') === styleId) out.push(s);
        if (s.children) visit(s.children);
      }
    };
    visit(this.shapes);
    return out;
  }

  /** The style a shape is linked to, or undefined. */
  linkedStyleOf(shape: ShapeData): TextStyle | undefined {
    const id = shape.element.getAttribute('data-text-style');
    return id ? this.textStyleReg.get(id) : undefined;
  }

  // ---- Library style links (see core/library-styles.ts) ----
  // Thin delegates: the model, the detach-by-reconciliation policy and the link
  // attribute table all live in StyleLinkManager, so call sites stay unchanged.

  /** Drop paint/effect links whose object no longer matches its style. */
  reconcileStyleLinks(ids: Iterable<string>): string[] {
    return this.styleLinks.reconcile(ids);
  }

  /** Stamp a style link on shapes (the apply path). */
  linkShapesToStyle(attr: string, styleId: string, ids: string[]): void {
    this.styleLinks.link(attr, styleId, ids);
  }

  /** Strip a style link from every shape carrying it (used on delete). */
  detachAllFromStyle(attr: string, styleId: string): string[] {
    return this.styleLinks.detachAll(attr, styleId);
  }

  /** Remove links naming an asset this document doesn't have (paste/import). */
  pruneDanglingStyleLinks(): number {
    return this.styleLinks.pruneDangling();
  }

  /** Every shape whose given style-link attribute equals `id`. */
  shapesWithStyleLink(attr: string, id: string): ShapeData[] {
    return this.styleLinks.shapesWith(attr, id);
  }

  /** Dev-only: every style link must resolve to a live asset of that type. */
  devCheckStyleLinksInvariant(): void {
    if (!import.meta.env?.DEV) return;
    this.styleLinks.devCheckInvariant();
  }

  // ---- Selection style ----
  // Paint / stroke / effect writers are owned by SelectionStyleManager (#192); these
  // delegate so call sites across the UI never change.
  applyFillToShapes(ids: string[], paint: string, record = true): void { this.selectionStyle.applyFillToShapes(ids, paint, record); }
  setSelectionFill(value: string): void { this.selectionStyle.setSelectionFill(value); }
  applyStrokeToShapes(ids: string[], value: string, record = true): void { this.selectionStyle.applyStrokeToShapes(ids, value, record); }
  setSelectionStroke(value: string): void { this.selectionStyle.setSelectionStroke(value); }
  applySampledStyle(ids: string[], sample: { fill?: string; stroke?: string; strokeWidth?: number }): void { this.selectionStyle.applySampledStyle(ids, sample); }
  setSelectionStrokeCap(cap: 'butt' | 'round' | 'square'): void { this.selectionStyle.setSelectionStrokeCap(cap); }
  setSelectionStrokeJoin(join: 'miter' | 'round' | 'bevel'): void { this.selectionStyle.setSelectionStrokeJoin(join); }
  setSelectionStrokeAlign(align: 'center' | 'inside' | 'outside'): void { this.selectionStyle.setSelectionStrokeAlign(align); }
  setSelectionRectRadii(radii: Radii, record = true): void { this.selectionStyle.setSelectionRectRadii(radii, record); }
  applyEffectToShapes(ids: string[], blur: number, shadow: ObjectShadow | null, record = true): void { this.selectionStyle.applyEffectToShapes(ids, blur, shadow, record); }
  setSelectionBlur(stdDev: number, record = true): void { this.selectionStyle.setSelectionBlur(stdDev, record); }
  setSelectionShadow(shadow: ObjectShadow | null, record = true): void { this.selectionStyle.setSelectionShadow(shadow, record); }

  /** Create a new style from a prop bundle (usually read off a selected text). */
  createTextStyle(name: string, props: TextStyleProps, extra?: { origin?: string; cloudRev?: number }): TextStyle {
    const style = this.textStyleReg.create(name, props, extra);
    this.saveHistory();
    this.notify();
    return style;
  }

  /** Create a style from the first text-backed shape in `shapeIds` and link ALL of
   *  them to it — one history step (Figma's create-from-selection). Null if none
   *  of the shapes are text-backed. */
  createTextStyleFromShapes(name: string, shapeIds: string[]): TextStyle | null {
    const first = shapeIds.map((id) => this.findShapeById(id)).find((s) => s && isTextStyleTarget(s));
    if (!first) return null;
    const props = readTextStyleProps(first)!;
    const style = this.textStyleReg.create(name, props);
    this.writeStyleToShapes(props, shapeIds, style.id);
    this.saveHistory();
    this.notify();
    return style;
  }

  /** Property keys where a linked shape currently diverges from its style (its
   *  overrides). Empty when the shape is unlinked or matches its style exactly. */
  textStyleOverrides(shape: ShapeData): string[] {
    const style = this.linkedStyleOf(shape);
    const cur = readTextStyleProps(shape);
    if (!style || !cur) return [];
    return overriddenKeys(cur, style.props);
  }

  renameTextStyle(id: string, name: string): void {
    this.textStyleReg.rename(id, name);
    this.saveHistory();
    this.notify();
  }

  /** Delete a style; linked text is DETACHED (keeps its current look), never restyled. */
  removeTextStyle(id: string): void {
    for (const s of this.shapesLinkedToStyle(id)) s.element.removeAttribute('data-text-style');
    this.textStyleReg.remove(id);
    this.saveHistory();
    this.notify();
  }

  /** Write a style's props to `shapeIds` and link them. Returns the ids actually
   *  affected (text-backed only). One history step. */
  applyTextStyle(styleId: string, shapeIds: string[]): string[] {
    const style = this.textStyleReg.get(styleId);
    if (!style) return [];
    const affected = this.writeStyleToShapes(style.props, shapeIds, styleId);
    if (affected.length) { this.saveHistory(); this.notify(); }
    return affected;
  }

  /** Redefine a style from new props and re-apply to every linked text, as ONE
   *  history step. Returns the affected (linked) shape ids so the UI can pulse them. */
  redefineTextStyle(styleId: string, props: TextStyleProps, record = true): string[] {
    this.textStyleReg.redefine(styleId, props);
    const ids = this.shapesLinkedToStyle(styleId).map((s) => s.id);
    const affected = this.writeStyleToShapes(props, ids, styleId);
    if (record) this.saveHistory();
    this.notify();
    return affected;
  }

  /** Tag a document style with its account-library provenance (origin uuid + rev)
   *  after promoting it to "all my files". One history step. */
  retagTextStyle(id: string, extra: { origin?: string; cloudRev?: number }): void {
    this.textStyleReg.retag(id, extra);
    this.saveHistory();
    this.notify();
  }

  /** Pull a newer definition from the account library into a linked document style:
   *  redefine its props, refresh its cloudRev, and re-apply to every linked text —
   *  one history step. Returns the affected shape ids. */
  updateTextStyleFromCloud(id: string, props: TextStyleProps, cloudRev: number): string[] {
    this.textStyleReg.redefine(id, props, { cloudRev });
    const ids = this.shapesLinkedToStyle(id).map((s) => s.id);
    const affected = this.writeStyleToShapes(props, ids, id);
    this.saveHistory();
    this.notify();
    return affected;
  }

  // ---- Asset Library (generic doc store: palettes / effect / paint styles) ----
  //
  // Text styles (above) and components (SymbolRegistry) keep their own stores; the
  // Library panel unions all three through per-type adapters. These delegate to the
  // generic LibraryRegistry, which carries its model in a <metadata class="bq-library">
  // element that round-trips the history snapshot + save file. See core/library.ts.

  listLibraryAssets(type?: AssetType): LibraryAsset[] { return this.libraryReg.list(type); }
  getLibraryAsset(id: string): LibraryAsset | undefined { return this.libraryReg.get(id); }

  createLibraryAsset(type: AssetType, name: string, payload: unknown, extra?: { origin?: string; rev?: number }): LibraryAsset {
    const asset = this.libraryReg.create(type, name, payload, extra);
    this.saveHistory();
    this.notify();
    return asset;
  }

  renameLibraryAsset(id: string, name: string): void {
    this.libraryReg.rename(id, name);
    this.saveHistory();
    this.notify();
  }

  /** `record: false` mutates without pushing a history entry — for live editing
   *  (drag-scrub / typing), where the caller commits ONE entry when done. */
  updateLibraryAsset(id: string, payload: unknown, rev?: number, record = true): void {
    this.libraryReg.update(id, payload, rev);
    if (record) this.saveHistory();
    this.notify();
  }

  retagLibraryAsset(id: string, origin: string, rev: number): void {
    this.libraryReg.retag(id, { origin, rev });
    this.saveHistory();
    this.notify();
  }

  removeLibraryAsset(id: string): void {
    // Detach first, in the SAME history entry: leaving shapes pointing at a dead id
    // meant a later style could inherit them (and made the delete dialog's promise
    // — "objects keep their look but lose the link" — false).
    const type = this.libraryReg.get(id)?.type;
    const attr = type ? LINK_ATTR[type] : undefined;
    if (attr) this.detachAllFromStyle(attr, id);
    this.libraryReg.remove(id);
    this.saveHistory();
    this.notify();
  }

  /** Shared writer: apply props to each text-backed shape and stamp the link.
   *  No history/onChange (callers compose those). */
  private writeStyleToShapes(props: TextStyleProps, shapeIds: string[], styleId: string): string[] {
    const affected: string[] = [];
    for (const id of shapeIds) {
      const shape = this.findShapeById(id);
      if (!shape || !isTextStyleTarget(shape)) continue;
      applyTextStyleProps(shape, props);
      shape.element.setAttribute('data-text-style', styleId);
      if (shape.type === 'appearance') this.refreshAppearance(id);
      affected.push(id);
    }
    return affected;
  }

  // ---- Variable-width strokes (the Width tool) ------------------------------
  //
  // A stroke whose thickness varies along its length. SVG can't paint that, so a
  // width object is a `<g data-width>` wrapper (leaf, type 'width') holding:
  //   • `[data-width-src]`   — the centerline geometry (keeps the object's fill,
  //     stroke cleared) — the editable source, and
  //   • `[data-width-render]`— a generated closed outline `<path>` filled with the
  //     stroke colour, whose shape comes from the centerline + width profile.
  // The outline lives in the drawing layer, so it round-trips through the history/
  // innerHTML snapshot for free; rebuildShapesFromDOM treats the wrapper as a leaf
  // and never walks into it. The profile (data-width-profile) + base width + stroke
  // colour live on the wrapper, so a plain re-render needs nothing but the snapshot;
  // regeneration only runs when the profile changes (preset, or a Width-tool drag).

  // Variable-width strokes are owned by WidthStrokeManager; these delegate.
  getWidthProfile(id: string): { centerline: string; base: number; stroke: string; points: WidthPoint[] } | null { return this.widthMgr.get(id); }
  canApplyWidth(id: string): boolean { return this.widthMgr.canApply(id); }
  clearWidthProfile(id: string): void { this.widthMgr.clear(id); }
  setWidthProfile(id: string, points: WidthPoint[], base: number, record = true): void { this.widthMgr.set(id, points, base, record); }

  // Repeat grids (issue #111) are owned by RepeatManager; these delegate.
  makeRepeatGrid(ids: string | string[], cfg?: Partial<RepeatConfig>): string | null { return this.repeatMgr.create(ids, cfg); }
  getRepeatConfig(id: string): RepeatConfig | null {
    const s = this.findShapeById(id);
    return s && s.type === 'repeat' ? this.repeatMgr.config(s.element) : null;
  }
  setRepeatConfig(id: string, cfg: RepeatConfig, record = true): void { this.repeatMgr.setConfig(id, cfg, record); }
  releaseRepeat(id: string): void { this.repeatMgr.release(id); }
  bakeRepeat(id: string): void { this.repeatMgr.bake(id); }
  /** Re-clone any pattern whose source changed — called once per render frame. */
  syncRepeats(): void { this.repeatMgr.syncAll(); }

  // ---- Type on a path ----

  /** True when the selection is exactly one text + one path (enables the command). */
  canTypeOnPath(): boolean {
    const sel = this.selectedShapeIds.map(id => this.findShapeById(id)).filter((s): s is ShapeData => !!s);
    return sel.length === 2 && sel.some(s => s.type === 'text') && sel.some(s => s.type === 'path');
  }

  /**
   * Flow the selected text along the selected path (Illustrator's Type on a Path).
   * The text's content is wrapped in a `<textPath href="#pathId">`; the path stays
   * a real sibling (so the reference round-trips) but its paint is cleared so it
   * acts as an invisible baseline. Re-editing (text tool) updates the textPath.
   */
  typeTextOnPath(): boolean {
    const sel = this.selectedShapeIds.map(id => this.findShapeById(id)).filter((s): s is ShapeData => !!s);
    const text = sel.find(s => s.type === 'text');
    const path = sel.find(s => s.type === 'path');
    if (!text || !path) return false;
    const pathId = path.element.id;
    const content = text.element.textContent ?? '';

    while (text.element.firstChild) text.element.removeChild(text.element.firstChild);
    const tp = document.createElementNS('http://www.w3.org/2000/svg', 'textPath');
    tp.setAttribute('href', `#${pathId}`);
    tp.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `#${pathId}`); // legacy renderers
    tp.textContent = content;
    text.element.appendChild(tp);
    // textPath positions along the path, so the text's own x/y no longer apply.
    text.element.removeAttribute('x');
    text.element.removeAttribute('y');
    text.element.setAttribute('data-textpath', pathId);
    // The path becomes an invisible baseline (kept for the reference + re-editing).
    path.element.setAttribute('fill', 'none');
    path.element.setAttribute('stroke', 'none');

    this.selectedShapeIds = [text.id];
    this.saveHistory();
    this.notify();
    return true;
  }

  // ---- Effects (blur / drop shadow via SVG filters) ----
  //
  // Effect parameters are the source of truth and live as data-fx-* attributes on
  // the element, so they round-trip through the history/innerHTML snapshot. The
  // SVG <filter> in <defs> is a regenerated CACHE (defs aren't snapshotted), so
  // EffectsManager.ensureFilters() rebuilds it after every rebuildShapesFromDOM/import.

  // Effects (blur / drop shadow) are owned by EffectsManager; these delegate.
  getObjectEffects(id: string): { blur: number; shadow: ObjectShadow | null } {
    return this.effects.getObjectEffects(id);
  }

  /** Re-fit every effect's filter region to current geometry (render cycle). */
  refreshEffectRegions(): void { this.effects.refreshRegions(); }

  /** Elements of the current selection (resolved anywhere in the tree). */
  private selectionElements(): SVGGraphicsElement[] {
    return this.selectedShapeIds
      .map(id => this.findShapeById(id)?.element)
      .filter((el): el is SVGGraphicsElement => !!el);
  }

  /** Restore the FIXED new-shape style (white fill, black 1px stroke, …). This is the
   *  only deliberate way to change what new shapes are born with — panels never do it.
   *  Mutates in place so any held `defaultStyle` reference stays valid. */
  resetDefaultStyle(): void {
    Object.assign(this.defaultStyle, makeDefaultStyle());
    this.fillNone = false;
    this.strokeNone = false;
  }

  /** Set the document's canvas-background colour (null = editor theme default) and
   *  paint the pasteboard. `record` is accepted for call-site symmetry, but the
   *  background isn't in the drawing-layer snapshot, so undo doesn't cover it; the
   *  value persists via the document metadata instead. */
  setCanvasBackground(color: string | null, _record = true): void {
    this.canvasBackground = color && color !== 'none' ? color : null;
    this.applyCanvasBackground();
    this.notify();
  }

  /** Paint the #pasteboard rect from `canvasBackground`. Delegates to
   *  CompositingManager; called externally on load + tab switch too. */
  applyCanvasBackground(): void { this.compositing.applyCanvasBackground(); }

  setObjectBlur(id: string, stdDev: number, record = true): void { this.effects.setObjectBlur(id, stdDev, record); }
  setObjectShadow(id: string, shadow: ObjectShadow | null, record = true): void { this.effects.setObjectShadow(id, shadow, record); }

  // ---- Markers (arrowheads / dots on line & path ends) ----
  //
  // The marker-start/marker-end presentation attributes round-trip through the
  // history snapshot; the shared <marker> library lives in <defs> and is rebuilt
  // by ensureMarkerDefs() (defs aren't snapshotted). fill="context-stroke" makes
  // each arrowhead match its path's stroke colour.

  // Markers (arrowheads) are owned by MarkersManager; these delegate.
  ensureMarkerDefs(): void { this.markers.ensureDefs(); }
  getMarkers(id: string): { start: string; end: string } { return this.markers.get(id); }
  setSelectionMarker(pos: 'start' | 'end', markerId: string | null): void { this.markers.setSelection(pos, markerId); }

  // Object compositing (blend mode + opacity) is owned by CompositingManager.
  getBlendMode(id: string): string { return this.compositing.getBlendMode(id); }
  setBlendMode(id: string, mode: string): void { this.compositing.setBlendMode(id, mode); }
  setSelectionBlendMode(mode: string): void { this.compositing.setSelectionBlendMode(mode); }
  getObjectOpacity(id: string): number { return this.compositing.getObjectOpacity(id); }
  setSelectionOpacity(value: number, record = true): void { this.compositing.setSelectionOpacity(value, record); }

  private ensureDefs(): SVGDefsElement {
    if (this.defsElement) return this.defsElement;
    const svgCanvas = this.drawingLayer.closest('svg');
    if (!svgCanvas) throw new Error('No SVG parent found');
    let defs = svgCanvas.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      svgCanvas.insertBefore(defs, svgCanvas.firstChild);
    }
    this.defsElement = defs as SVGDefsElement;
    return this.defsElement;
  }

  // ---- Symbols ---- (create-from-shape / place / detach / remove live in
  // core/symbol-registry.ts; AppState delegates and supplies the host adapter.)

  createSymbolFromShape(shapeId: string, name?: string): SymbolDef | null {
    return this.symbolRegistry.createSymbolFromShape(shapeId, name);
  }

  placeSymbolInstance(symId: string): void {
    this.symbolRegistry.placeSymbolInstance(symId);
  }

  detachSymbolInstance(shapeId: string): boolean {
    return this.symbolRegistry.detachSymbolInstance(shapeId);
  }

  removeSymbol(id: string): void {
    this.symbolRegistry.removeSymbol(id);
  }

  renameSymbol(id: string, name: string): void {
    this.symbolRegistry.renameSymbol(id, name);
  }

  setSymbolProvenance(id: string, origin: string, rev: number): void {
    this.symbolRegistry.setSymbolProvenance(id, origin, rev);
  }

  /** Adopt a saved component (`<symbol>` markup) into this document's defs under a
   *  fresh id, returning the new symbol id — the cross-document replant behind
   *  component library assets. Null if the markup holds no `<symbol>`. */
  adoptSymbolMarkup(markup: string): string | null {
    const el = this.parseSymbolMarkup(markup);
    return el ? this.symbolRegistry.adoptSymbolElement(el) : null;
  }

  /** Replace a symbol's content from newer markup (the ⤓ "update from library"
   *  path for components), keeping its id + name. */
  updateSymbolMarkup(id: string, markup: string): void {
    const el = this.parseSymbolMarkup(markup);
    if (el) this.symbolRegistry.updateSymbolFromMarkup(id, el);
  }

  private parseSymbolMarkup(markup: string): Element | null {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, 'image/svg+xml');
    return doc.documentElement.querySelector('symbol');
  }

  // ---- Gradient management ----

  createGradient(type: 'linear' | 'radial', stops?: GradientStop[]): GradientDef {
    return this.paint.createGradient(type, stops);
  }

  updateGradient(grad: GradientDef): void {
    this.paint.updateGradient(grad);
  }

  removeGradient(id: string): void {
    this.paint.removeGradient(id);
  }

  getGradientById(id: string): GradientDef | undefined {
    return this.paint.getGradientById(id);
  }

  // ---- Pattern management ----

  createPattern(def: Partial<PatternDef> & { type: PatternDef['type'] }): PatternDef {
    return this.paint.createPattern(def);
  }

  updatePattern(pat: PatternDef): void {
    this.paint.updatePattern(pat);
  }

  removePattern(id: string): void {
    this.paint.removePattern(id);
  }

  getPatternById(id: string): PatternDef | undefined {
    return this.paint.getPatternById(id);
  }

  /**
   * The document's ONE canonical def for a gradient/pattern paint style, as
   * `url(#id)`. Every object using the style points at this def, so editing it
   * updates them all live — SVG references do the propagation for free — and a
   * repeated apply stops minting a new def each time (which leaked defs into the
   * saved file). The def is re-found via styleDefElement() from the `defId` the
   * library asset stores — there is no marker attribute on the def itself (this
   * comment used to claim a `data-style-def` that never existed).
   */
  canonicalPaintDef(styleId: string, kind: 'gradient' | 'pattern', defMarkup: string): string | null {
    const existing = this.styleDefElement(styleId);
    if (existing) return `url(#${existing.id})`;
    const url = this.adoptPaintDef(kind, defMarkup);
    const id = url ? /^url\(#(.+?)\)$/.exec(url)?.[1] : null;
    if (!id) return null;
    // Record the def id on the asset (bookkeeping only, so no history entry).
    const asset = this.libraryReg.get(styleId);
    if (asset) {
      this.libraryReg.update(styleId, { ...(asset.payload as PaintStylePayload), defId: id });
    }
    return url;
  }

  /** The live def element backing a gradient/pattern style in this document. */
  styleDefElement(styleId: string): SVGElement | null {
    const p = this.libraryReg.get(styleId)?.payload as PaintStylePayload | undefined;
    if (!p?.defId) return null;
    const el = this.ensureDefs().querySelector<SVGElement>(`:scope > [id="${p.defId}"]`);
    // Scoped to OUR defs: another document's id may name nothing here, or something
    // outside defs. (Comparing against the cached defsElement field silently failed
    // when it was still null, making every apply adopt a fresh def again.)
    return el;
  }

  /** Drop a style's canonical def so the next apply re-adopts it from fresh markup
   *  (used when a redefine replaces the gradient/pattern wholesale). */
  clearStyleDef(styleId: string): void {
    const el = this.styleDefElement(styleId);
    const asset = this.libraryReg.get(styleId);
    if (asset) {
      const { defId: _drop, ...rest } = asset.payload as PaintStylePayload;
      this.libraryReg.update(styleId, rest);
    }
    if (!el) return;
    if (el.tagName.toLowerCase() === 'pattern') this.removePattern(el.id);
    else this.removeGradient(el.id);
    el.remove();
  }

  // ---- Pattern links ----
  // Patterns made from artwork, and kept in step with it, are owned by
  // PatternLinkManager (#192); these delegate.
  /** Build a tiling pattern from shapes' artwork (Object > Pattern > Make). */
  createPatternFromShapes(ids: string[], opts?: { link?: boolean }): PatternDef | null { return this.patternLinks.createPatternFromShapes(ids, opts); }
  /** Re-capture every linked pattern from its source (runs after each rebuild). */
  refreshLinkedPatterns(): void { this.patternLinks.refreshLinkedPatterns(); }
  /** Put a pattern's tile back on the canvas as a linked, editable group. */
  editPatternArtwork(patternId: string): string | null { return this.patternLinks.editPatternArtwork(patternId); }
  /** Stop a pattern tracking its source; the captured artwork stays. */
  unlinkPattern(patternId: string): void { this.patternLinks.unlinkPattern(patternId); }

  // ---- Linked files (see core/linked-files.ts) ----

  /** Place another document's artwork as a linked file. */
  placeLinkedFile(opts: { src: string; name: string; rev: string; content: string; x?: number; y?: number }): string | null {
    return this.linkedFiles.place(opts);
  }

  /** Pull a newer version of a linked file's source into the document. */
  updateLinkedFile(shapeId: string, content: string, rev: string): boolean {
    return this.linkedFiles.updateFrom(shapeId, content, rev);
  }

  /** Embed a copy: keep the artwork, drop the link. */
  embedLinkedFile(shapeId: string): boolean {
    return this.linkedFiles.embed(shapeId);
  }

  listLinkedFiles(): LinkedFileInfo[] { return this.linkedFiles.list(); }
  linkedFileInfo(shapeId: string): LinkedFileInfo | undefined { return this.linkedFiles.info(shapeId); }

  /** Record the sources' current revisions so the stale/missing badges can derive. */
  noteLinkedSourceRevisions(revs: Map<string, string>, missing?: Iterable<string>): void {
    this.linkedFiles.noteSourceRevisions(revs, missing ?? []);
  }

  /** Adopt a saved gradient/pattern def (a paint style's captured markup) into THIS
   *  document's <defs> under a fresh id, returning `url(#id)` to paint with — the
   *  cross-document replant behind gradient/pattern paint styles. Returns null if
   *  the markup holds no recognizable paint def. */
  adoptPaintDef(kind: 'gradient' | 'pattern', defMarkup: string): string | null {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${defMarkup}</svg>`, 'image/svg+xml');
    const el = doc.documentElement.querySelector('linearGradient, radialGradient, pattern');
    if (!el) return null;
    const id = kind === 'gradient'
      ? this.paint.adoptGradientElement(el)
      : this.paint.adoptPatternElement(el);
    return `url(#${id})`;
  }

  // ---- SVG import / defs export ----
  //
  // Owned by SvgIoManager; thin delegates so call sites (export dialog, project
  // loader, image import) are unchanged.
  getDefsContent(): string { return this.svgIo.getDefsContent(); }
  getDefsBlock(): string { return this.svgIo.getDefsBlock(); }
  getExtraNamespaceDecls(): string { return this.svgIo.getExtraNamespaceDecls(); }
  getDrawingLayerSVG(): string { return this.svgIo.getDrawingLayerSVG(); }
  getDrawingLayerSVGForExport(): string { return this.svgIo.getDrawingLayerSVGForExport(); }
  clearDefs(): void { this.svgIo.clearDefs(); }
  /** Public wrapper: import gradients/patterns/symbols from a parsed SVG element. */
  importDefsFrom(svgEl: Element): void { this.svgIo.importDefsFrom(svgEl); }
  importSVGContent(svgString: string): void { this.svgIo.importSVGContent(svgString); }

  /**
   * APPEND a foreign SVG's artwork to the current document as a single group,
   * scaled down to fit and centred on `at` (world coords) or on the active frame.
   * Unlike importSVGContent — which replaces the drawing layer, as opening a
   * document should — this preserves everything already on the canvas.
   */
  appendSVGContent(svgString: string, name: string, at?: Point): boolean {
    const g = this.svgIo.appendSVGContent(svgString, name);
    if (!g) return false;
    // Measure in the live tree (getBBox needs layout), then position with a
    // transform on the wrapper so the imported geometry is left untouched.
    this.drawingLayer.appendChild(g);
    const bb = g.getBBox();
    if (bb.width > 0 && bb.height > 0) {
      const ab = this.getActiveArtboard();
      const scale = Math.min(1, (ab.width * 0.9) / bb.width, (ab.height * 0.9) / bb.height);
      const cx = at ? at.x : ab.x + ab.width / 2;
      const cy = at ? at.y : ab.y + ab.height / 2;
      // Scale about the artwork's own centre, then move that centre to the target.
      const tx = cx - (bb.x + bb.width / 2) * scale;
      const ty = cy - (bb.y + bb.height / 2) * scale;
      g.setAttribute('transform', `translate(${tx}, ${ty}) scale(${scale})`);
    }
    g.remove(); // addShape re-inserts it (and re-parents it into the frame at `at`)

    const id = this.nextId();
    g.id = id;
    this.addShape({
      id, type: 'group', element: g, name,
      style: { fill: 'none', stroke: 'none', strokeWidth: 0, opacity: 1 },
      visible: true, locked: false,
    }, at);
    this.rebuildShapesFromDOM();
    this.selectedShapeIds = [id];
    this.saveHistory();
    this.notify();
    return true;
  }
  importSVGMarkup(svgMarkup: string): void { this.svgIo.importSVGMarkup(svgMarkup); }
  /** Whether the last importSVGContent source carried SMIL animation (stripped by
   *  the sanitizer) — read by the import UI to warn. Delegates to SvgIoManager. */
  get lastImportHadAnimation(): boolean { return this.svgIo.lastImportHadAnimation; }

  clearAll(): void {
    this.shapeById.clear();
    this.drawingLayer.innerHTML = '';
    this.shapes = [];
    this.selectedShapeIds = [];
    this.clearDefs();
    this.selectedSymbolId = null;
    // A blank document starts with a default frame (like the constructor).
    this.drawingLayer.appendChild(this.createFrameElement(0, 0, 960, 540, 'Frame 1'));
    this.rebuildShapesFromDOM();
    this.activeFrameId = this.artboards[0]?.id ?? null;
    this.selectedFrameId = null;
    this.saveHistory();
    this.notify();
  }
}
