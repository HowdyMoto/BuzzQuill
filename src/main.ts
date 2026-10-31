import { isContainerEl } from './core/shape-props';
import './style.css';
import { AppState } from './core/state';
import { CanvasController } from './core/canvas';
import { DocumentManager } from './core/document-manager';
import { setupTabBar, renderTabBar, requestCloseTab } from './ui/tab-bar';
import { setupSplitView, updateSplitView } from './ui/split-view';
import { showToast } from './ui/toast';
import { SelectTool } from './tools/select';
import { NodeEditTool } from './tools/node-edit';
import { RectTool } from './tools/rect';
import { EllipseTool } from './tools/ellipse';
import { LineTool } from './tools/line';
import { ArrowTool } from './tools/arrow';
import { PathTool } from './tools/path';
import { TextTool } from './tools/text';
import { HandTool } from './tools/hand';
import { ZoomTool } from './tools/zoom-tool';
import { EyedropperTool } from './tools/eyedropper';
import { DirectionTool } from './tools/direction';
import { StarTool } from './tools/star';
import { PolygonShapeTool } from './tools/polygon-tool';
import { FrameTool } from './tools/frame-tool';
import { CropTool } from './tools/crop';
import { ShapeBuilderTool } from './tools/shape-builder';
import { updateSelectionOverlay } from './ui/selection-overlay';
import { renderNodeOverlay } from './ui/node-overlay';
import { renderMaskGhost } from './ui/mask-ghost';
import { updateToolHint, setHintCommandRunner } from './ui/tool-hint';
import { onHintsChange } from './ui/hint-prefs';
import { setupProperties, updatePropertiesPanel, updateTransformReadout, updateRadiusReadout, syncTextPanelVisibility } from './ui/properties';
import { setupTextStyles, updateTextStylesUI } from './ui/text-styles';
import { setupInspector, updateInspector } from './ui/inspector';
import { setupStrokesPanel, updateStrokesPanel } from './ui/appearance-panel';
import { setupEffects, updateEffectsPanel } from './ui/effects';
import { setupPanelResizers } from './ui/panel-resize';
import { setupFramePanel, updateFramePanel } from './ui/frame-panel';
import { setupWidthPanel, updateWidthPanel } from './ui/width-panel';
import { setupRepeatPanel, updateRepeatPanel } from './ui/repeat-panel';
import { setupMarkers, updateMarkersPanel } from './ui/markers';
import { updateLayersPanel, setupLayerButtons, setLinkedSourceOpener, setLinkedSourceUpdater } from './ui/layers';
import { setupLibrary, updateLibrary, revealLibrarySection } from './ui/library-panel';
import { setPatternLibraryOpener } from './ui/paint-editors';
import { updateStylePanel } from './ui/style-panel';
import { setupObjectStylesPanel, updateObjectStylesPanel } from './ui/object-styles-panel';
import { setupMenus } from './ui/menus';
import { showSelectionContextMenu } from './ui/context-menu';
import { renderFrameGuides } from './ui/frame-guides';
import { renderMaskGuides } from './ui/mask-guides';
import { setupColorPicker } from './ui/color-picker';
import { setupAlign } from './ui/align';
import { setupSwatches } from './ui/swatches';
import { setupTooltips } from './ui/tooltip';
import { setupPathfinder, updatePathfinderPanel, updatePathfinderPopover } from './ui/pathfinder';
import { setupPathActions, updatePathActionsPopover } from './ui/path-actions';
import { setupDirectionOverlay, updateDirectionOverlay } from './ui/direction-overlay';
import { setupImageActions, updateImageActions } from './ui/image-actions';
import { setupMeasureOverlay } from './ui/measure-overlay';
import { setupShapePicker } from './ui/shape-picker';
import { setupParametricHandles, updateParametricHandles } from './ui/parametric-handles';
import { renderFrames } from './ui/frame-renderer';
import { updateSymbolsPanel, setupSymbolButtons } from './ui/symbols-panel';
import { openHandle, confirmDiscard, pickDocumentToOpen, pendingFromHandle } from './ui/project-file';
import { setupRecentFilesMenu } from './ui/recent-files';
import { setupDrive, openFromDrive } from './ui/drive';
import { setupPaste, pasteExternalAsync, armPasteInPlace } from './ui/paste';
import { setupFileDrop } from './ui/file-drop';
import { createCommandPalette } from './ui/command-palette';
import { setupNumberScrub } from './ui/number-scrub';
import { commitFieldsOnCanvasPress, mustId } from './ui/dom';
import { setupInteractionFeedback, animateExpand, pulse } from './ui/feedback';
import { loadSession, scheduleSessionSave, flushSessionSave } from './core/session-store';
import type { Tool } from './tools/base';
import type { ToolName } from './core/types';
import type { CommandContext } from './commands';
import { runCommand, findCommandForEvent, isEnabled } from './commands';

// DOM elements
const svgCanvas = document.getElementById('svg-canvas') as unknown as SVGSVGElement;
const drawingLayer = document.getElementById('drawing-layer') as unknown as SVGGElement;
const selectionLayer = document.getElementById('selection-layer') as unknown as SVGGElement;
const guidesLayer = document.getElementById('guides-layer') as unknown as SVGGElement;

// State & canvas
const state = new AppState(drawingLayer, onStateChange);
// Let tools request a tool switch (setTool is a hoisted declaration below). Used
// by the draw tools to return to Select after placing one shape (Figma-style).
state.requestTool = (t) => setTool(t);
const canvas = new CanvasController(svgCanvas);
state.revealBounds = (b) => canvas.revealBounds(b);
state.getViewBox = () => canvas.getViewBox();
// Paste from another app: menu ▸ Paste routes external images/vector here
// (Cmd+V is handled by the native paste event, wired via setupPaste below).
state.pasteExternal = () => void pasteExternalAsync(state);
// Multiple open documents (tabs). Tab 0 adopts the boot document. Tab-only changes
// (reorder, rename, split enter/exit, focus swap) don't touch AppState, so they
// don't fire onStateChange — the document manager's own callback must refresh both
// the tab strips and the split-view layout for those.
const docs = new DocumentManager(state, canvas, () => { renderTabBar(); updateSplitView(); updateDirectionOverlay(); });

// Tool registry — one row per tool holds its label + constructor. Typed as
// Record<ToolName, …> so adding a ToolName is a compile error until it has a row
// here (and vice-versa): a single source of truth instead of the old parallel
// label-map + instance-map that had to be kept in sync by hand.
type ToolCtor = new (state: AppState, canvas: CanvasController, svgCanvas: SVGSVGElement) => Tool;
const TOOL_DEFS: Record<ToolName, { label: string; ctor: ToolCtor }> = {
  select: { label: 'Selection Tool', ctor: SelectTool },
  directSelect: { label: 'Direct Selection Tool', ctor: NodeEditTool },
  rect: { label: 'Rectangle Tool', ctor: RectTool },
  ellipse: { label: 'Ellipse Tool', ctor: EllipseTool },
  line: { label: 'Line Tool', ctor: LineTool },
  arrow: { label: 'Arrow Tool', ctor: ArrowTool },
  pen: { label: 'Pen Tool', ctor: PathTool },
  text: { label: 'Type Tool', ctor: TextTool },
  hand: { label: 'Hand Tool', ctor: HandTool },
  zoom: { label: 'Zoom Tool', ctor: ZoomTool },
  eyedropper: { label: 'Eyedropper Tool', ctor: EyedropperTool },
  star: { label: 'Star Tool', ctor: StarTool },
  polygon: { label: 'Polygon Tool', ctor: PolygonShapeTool },
  frame: { label: 'Frame Tool', ctor: FrameTool },
  crop: { label: 'Crop Tool', ctor: CropTool },
  shapeBuilder: { label: 'Shape Builder Tool', ctor: ShapeBuilderTool },
  direction: { label: 'Direction Tool', ctor: DirectionTool },
};

const toolLabels = Object.fromEntries(
  Object.entries(TOOL_DEFS).map(([name, d]) => [name, d.label]),
) as Record<ToolName, string>;

const tools = Object.fromEntries(
  Object.entries(TOOL_DEFS).map(([name, d]) => [name, new d.ctor(state, canvas, svgCanvas)]),
) as Record<ToolName, Tool>;

let activeTool: Tool = tools.select;

// Shared context handed to every command (menus, keyboard, panel buttons).
// `setTool` and `getArtboardsBounds` are hoisted function declarations;
// `openCommandPalette` is replaced with the real opener once the palette exists.
const commandCtx: CommandContext = {
  state, canvas, setTool, getArtboardsBounds,
  openCommandPalette: () => { /* wired up after palette creation */ },
  openDocument: () => { void openDocumentIntoTab(); },
  openFromDrive: () => { void openFromDrive(docs); },
  newDocument: () => docs.newTab(), // blank doc in a new tab (like the "+" tab button)
  // Tab commands (#197). Close reuses the tab bar's own guard so the keyboard
  // path can't diverge from the × button; cycling wraps at both ends.
  closeActiveTab: () => requestCloseTab(docs.activeId),
  cycleTab: (dir) => {
    const ids = docs.tabs.map(t => t.id);
    if (ids.length < 2) return;
    const i = ids.indexOf(docs.activeId);
    docs.switchTo(ids[(i + dir + ids.length) % ids.length]);
  },
  tabCount: () => docs.tabs.length,
};

setHintCommandRunner((id) => runCommand(id, commandCtx)); // "Ctrl+J · join ends" is a button too
onHintsChange(() => updateContextPopovers()); // the strip's band just appeared or went — re-place the bars

/** Pick a document and open it in a (new) tab — the current tab and its unsaved
 *  work stay put (no discard prompt). Shared by File ▸ Open and Recent Files. */
async function openDocumentIntoTab(): Promise<void> {
  const pending = await pickDocumentToOpen();
  if (pending) await docs.openDocument(pending);
}

function getArtboardsBounds(): { x: number; y: number; w: number; h: number } {
  if (state.artboards.length === 0) return { x: 0, y: 0, w: 960, h: 540 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ab of state.artboards) {
    minX = Math.min(minX, ab.x);
    minY = Math.min(minY, ab.y);
    maxX = Math.max(maxX, ab.x + ab.width);
    maxY = Math.max(maxY, ab.y + ab.height);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Flips true once the boot-time session restore has been attempted (below), after
// which onStateChange begins persisting the session on every settled change.
let sessionRestored = false;

// During an interactive gesture a 120 Hz pointermove fires onStateChange ~120x/s,
// and each render below forces layout (getScreenCTM/getBBox) — so mid-gesture we
// coalesce to at most one render per animation frame. Discrete edits render
// SYNCHRONOUSLY: the test harness and any caller that inspects the DOM right after
// an edit must see the result immediately, and a settled edit is not hot. Note the
// shape geometry itself is mutated synchronously by the tools; only the overlay /
// panel render is batched here.
let renderRafId = 0;
function onStateChange(): void {
  if (state.interactive) {
    if (!renderRafId) renderRafId = requestAnimationFrame(() => { renderRafId = 0; renderFrame(); });
    return;
  }
  if (renderRafId) { cancelAnimationFrame(renderRafId); renderRafId = 0; }
  renderFrame();
}

function renderFrame(): void {
  // DEV: assert the frames cache mirrors the DOM (catches "forgot to re-sync" bugs
  // — deleted-frame-lingers, pasted-frame-not-selectable — the moment they happen).
  state.devCheckFramesInvariant();
  state.devCheckStyleLinksInvariant();
  // DEV: assert the shape model hasn't drifted from the DOM (a mutation that forgot
  // rebuildShapesFromDOM → stale/unselectable shapes).
  state.devCheckShapesMatchDOM();

  // Keep emulated inside/outside stroke clips aligned to current geometry.
  state.refreshStrokeAlignClips();
  // …and blur/shadow regions, which are absolute and would clip a moved shape.
  state.refreshEffectRegions();

  // Give stroked text a clean, Figma-style outline (fill over stroke, round joins).
  state.polishTextStrokes();
  // Stroked, fill:none text renders via a regenerated glyph-outline path (issue #172).
  state.refreshTextStrokeOutlines();

  // Re-clone repeat-grid patterns whose source shape changed (fast no-op guard).
  state.syncRepeats();

  // Canvas overlays must track the pointer every frame.
  renderFrames(state, svgCanvas, canvas.getZoom());
  renderFrameGuides(state, svgCanvas, canvas.getZoom());
  renderMaskGuides(state, svgCanvas, canvas.getZoom());
  updateSelectionOverlay(state, selectionLayer, canvas.getZoom());
  updateParametricHandles(state);
  renderNodeOverlay(state, guidesLayer, canvas.getZoom());
  renderMaskGhost(state, guidesLayer); // onion-skin the clipped-away part of a selected mask
  updateDirectionOverlay(); // the flow along paths, while anything is showing it
  // The strip first (settled renders only — a hint may read the selection's
  // geometry), then the contextual popovers, which keep clear of the strip's band.
  // Both before the interactive early-return: the popovers hide themselves mid-gesture.
  if (!state.interactive) updateToolHint(state);
  updateContextPopovers();

  // The side panels reflect document *structure*, which doesn't change during a
  // drag/resize/rotate — skip their (full innerHTML) rebuilds mid-gesture and
  // let the mouseup do one final full render. Big win on large documents. But
  // the readouts for values a gesture DOES change stay live: the Transform box
  // (X/Y/W/H/R) and the corner radius (dragging a rect's corner handle).
  if (state.interactive) {
    updateTransformReadout(state);
    updateRadiusReadout(state);
    return;
  }

  updatePropertiesPanel(state);
  updateStrokesPanel(state);
  updateEffectsPanel(state);
  updateFramePanel(state);
  updateWidthPanel(state);
  updateRepeatPanel(state);
  updateMarkersPanel(state);
  updateLayersPanel(state);
  updateLibrary(state); // Library tab (assets) — cheap no-op unless the tab is showing
  updateStylePanel(state); // live editor for the focused library style
  updateObjectStylesPanel(state); // which library styles the selection uses
  updateSymbolsPanel(state);
  updatePathfinderPanel(state);
  updateInspector(state); // header (name/type) + context-sensitive panel visibility
  syncTextPanelVisibility(state); // keep the Text panel for multi-stroke text (runs after inspector)
  updateTextStylesUI(state); // reflect the selection's linked text style + override state
  renderTabBar(); // keep the active tab's title/dirty current
  updateSplitView(); // keep the split-view preview's label in step with tab changes

  // Persist the open documents so they're restored on the next load. Gated until
  // the boot-time restore has run, so an early boot render can't overwrite the
  // stored session with the blank starting document.
  if (sessionRestored) scheduleSessionSave(sessionNow);
}

/** The session to persist, built when the write fires — or null while a live
 *  preview holds uncommitted geometry in the document (a reload with the Round
 *  Corners dialog open restored the preview as if applied). Ending the preview is
 *  itself a change, which schedules the write it skipped. */
function sessionNow() {
  return state.hasLivePreview() ? null : docs.serializeSession();
}

function setTool(toolName: ToolName): void {
  // Switching tools abandons any in-progress gesture (e.g. Space-to-pan or a
  // tool shortcut pressed mid-drag). Clear the interactive-render guard and do
  // one full render so the side panels can't get stuck frozen.
  if (state.interactive) {
    state.setInteractive(false);
    onStateChange();
  }
  if (activeTool.deactivate) activeTool.deactivate();
  state.currentTool = toolName;
  activeTool = tools[toolName];
  if (activeTool.activate) activeTool.activate();

  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    const active = btn.getAttribute('data-tool') === toolName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  svgCanvas.setAttribute('data-tool', toolName);
  document.getElementById('tool-label')!.textContent = toolLabels[toolName] || toolName;

  // Every tool switch — click, keyboard, or programmatic return-to-Select — pops
  // the newly-selected icon's background for satisfying, consistent feedback.
  pulseToolButton(toolName);
  // Tool changes can happen without a document edit (e.g. entering Crop).
  // Remove stale resize/rotation handles before the tool draws its own chrome.
  updateSelectionOverlay(state, selectionLayer, canvas.getZoom());
  // A shape drawn with a tool lands selected in Select: its action bar and the
  // hint strip must be there the moment it does, not after the next click (a tool
  // switch fires no state change of its own).
  updateContextPopovers();
  updateToolHint(state);
}

/** The contextual popovers (Pathfinder / path actions / image actions) all anchor
 *  to the selection, so they always refresh together. */
function updateContextPopovers(): void {
  updatePathfinderPopover(state);
  updatePathActionsPopover(state);
  updateImageActions(state);
}

/** Briefly pop a tool's toolbar icon background — visual feedback on selection. */
function pulseToolButton(toolName: ToolName): void {
  const btn = document.querySelector(`.tool-btn[data-tool="${toolName}"]`) as HTMLElement | null;
  if (!btn) return;
  pulse(btn);
}

// Mouse events on canvas
let isMouseDown = false;

svgCanvas.addEventListener('mousedown', (e: MouseEvent) => {
  if (e.button === 1) {
    e.preventDefault();
    canvas.startPan(e.clientX, e.clientY);
    return;
  }
  if (e.button !== 0) return;
  // Interacting with the canvas makes the Layers list the delete target.
  if (state.currentTool !== 'frame') state.activePanel = 'layers';
  isMouseDown = true;
  const pt = canvas.screenToSVG(e.clientX, e.clientY);
  activeTool.onMouseDown(pt, e);
});

svgCanvas.addEventListener('mousemove', (e: MouseEvent) => {
  const pt = canvas.screenToSVG(e.clientX, e.clientY);
  activeTool.onMouseMove(pt, e);
});

// Right-click on the canvas: select the shape under the cursor (if not already in
// the selection), then show the selection context menu (Flatten, Group, Mask, …).
svgCanvas.addEventListener('contextmenu', (e: MouseEvent) => {
  e.preventDefault();
  state.activePanel = 'layers'; // context-menu commands act on the canvas selection
  const id = shapeIdAt(e.target as Element | null);
  if (id && !state.selectedShapeIds.includes(id)) state.selectShape(id);
  showSelectionContextMenu(e.clientX, e.clientY, commandCtx);
});

/** Resolve the top-most selectable (non-frame) shape id at an event target, mirroring
 *  SelectTool's click resolution, so a right-click selects what a left-click would. */
function shapeIdAt(target: Element | null): string | null {
  const chain: Element[] = [];
  let el: Element | null = target;
  while (el) {
    // Model lookup, not id spelling — imported shapes keep their authored ids.
    if (el.id && state.findShapeById(el.id)) chain.push(el);
    if (el.id === 'drawing-layer') break;
    el = el.parentElement;
  }
  const nonFrame = chain.filter(c => !isContainerEl(c));
  const pick = nonFrame.length ? nonFrame[nonFrame.length - 1] : chain[chain.length - 1];
  return pick?.id ?? null;
}

svgCanvas.addEventListener('dblclick', (e: MouseEvent) => {
  if (e.button !== 0) return;
  const pt = canvas.screenToSVG(e.clientX, e.clientY);
  activeTool.onDoubleClick?.(pt, e);
});

window.addEventListener('mouseup', (e: MouseEvent) => {
  if (canvas.panning) {
    canvas.endPan();
    isMouseDown = false; // pan started via mousedown set this — clear it so it can't wedge
    return;
  }
  if (!isMouseDown) return;
  isMouseDown = false;
  const pt = canvas.screenToSVG(e.clientX, e.clientY);
  activeTool.onMouseUp(pt, e);
});

// Toolbar clicks — most buttons switch tools; a few (e.g. image import) are
// one-shot ACTIONS that run a command and leave the current tool alone.
document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    const toolName = btn.getAttribute('data-tool') as ToolName;
    setTool(toolName);
  });
});
document.querySelectorAll('.tool-btn[data-action]').forEach(btn => {
  btn.addEventListener('click', () => runCommand(btn.getAttribute('data-action')!, commandCtx));
});

// Panel collapse (design system): every collapsible panel toggles two ways —
// a single click on the left-hand disclosure chevron, or a double-click anywhere
// on the header bar (except its interactive controls, e.g. the Layers/Symbols +).
const togglePanelCollapse = (header: Element): void => {
  const panel = header.closest('.panel')!;
  const collapsed = panel.classList.toggle('collapsed');
  if (!collapsed) animateExpand(panel); // gentle reveal on expand
};
document.querySelectorAll('.panel-header').forEach(header => {
  header.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.panel-collapse')) togglePanelCollapse(header);
  });
  header.addEventListener('dblclick', (e) => {
    // A double-click on a header button (+, chevron) is its own two clicks — don't
    // also toggle, or the net gesture would be confusing. Only the bare bar toggles.
    if ((e.target as Element).closest('button, input, select, textarea, [contenteditable]')) return;
    togglePanelCollapse(header);
  });
});

// Keyboard shortcuts
let prevToolBeforeSpace: ToolName | null = null;

window.addEventListener('keydown', (e: KeyboardEvent) => {
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
  // A panel that already handled this key (e.g. Delete on a focused Library row)
  // must not also trigger the global editor shortcut for it.
  if (e.defaultPrevented) return;

  // Node editing: Delete/Backspace removes the selected anchor points, not the
  // whole path — so it can't go through the registry's edit.delete command.
  if ((e.key === 'Delete' || e.key === 'Backspace') &&
      state.editingPathId && state.pathEdit && state.pathEdit.selected.size > 0) {
    e.preventDefault();
    if (activeTool.onKeyDown) activeTool.onKeyDown(e);
    return;
  }

  // Spring-loaded pan: holding Space temporarily switches to the Hand tool and
  // restores the previous tool on keyup (handled below). Stateful, so bespoke.
  // Re-assert Hand on EVERY Space keydown (idempotent) rather than gating on a
  // `spaceDown` latch: a missed keyup — a native file dialog, Alt-Tab or DevTools
  // steals focus and the keyup never reaches us — used to leave the latch stuck
  // `true`, after which Space silently stopped switching to Hand and panning
  // "randomly" stopped working. Keying off the current tool can't wedge.
  if (e.key === ' ') {
    e.preventDefault();
    if (state.currentTool !== 'hand') {
      prevToolBeforeSpace = state.currentTool;
      setTool('hand');
    }
    return;
  }

  // Everything else dispatches through the command registry — the single
  // source of truth shared with the menus and panel buttons. Only swallow the
  // browser default when we actually run something (a disabled command lets the
  // native key through, e.g. Backspace stays harmless with nothing selected).
  const cmd = findCommandForEvent(e);
  if (cmd) {
    // Let Cmd/Ctrl+V through to the native `paste` event (ui/paste.ts), which can
    // read clipboard images without a permission prompt — preventing default here
    // would suppress that event. (The menu still routes Paste through the command.)
    // Paste in Place rides the same event, told first that this paste is in place.
    if (cmd.id === 'edit.paste') return;
    if (cmd.id === 'edit.paste-in-place') { armPasteInPlace(); return; }
    if (isEnabled(cmd, commandCtx)) {
      e.preventDefault();
      cmd.run(commandCtx);
    }
    return;
  }

  // Unhandled plain keys fall through to the active tool (e.g. pen Enter/Escape).
  if (!e.ctrlKey && !e.metaKey && activeTool.onKeyDown) activeTool.onKeyDown(e);
});

/** Leave spring-loaded pan and restore the tool that was active before Space. */
function endSpacePan(): void {
  if (prevToolBeforeSpace) {
    setTool(prevToolBeforeSpace);
    prevToolBeforeSpace = null;
  }
}

window.addEventListener('keyup', (e: KeyboardEvent) => {
  if (e.key === ' ') endSpacePan();
});

// Committing a panel edit with Enter RETURNS keyboard focus to the canvas, so
// the next global shortcut (Ctrl+C/V, Delete, …) acts on the selection instead
// of silently dying in the still-focused field — the keydown guard above skips
// INPUT targets, which is what made "copy then paste" a no-op after adjusting
// a panel value (#215). Modals keep their own Enter semantics.
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key !== 'Enter') return;
  const t = e.target as HTMLElement;
  if (t.tagName !== 'INPUT') return;
  if (t.closest('.modal-dialog, dialog, .menu-panel')) return;
  if (!t.closest('.panel, #inspector')) return;
  // After the field's own Enter handling commits the value, drop focus.
  window.setTimeout(() => t.blur(), 0);
});

// Losing window focus (a native file-open/save dialog, Alt-Tab, DevTools) means
// the matching keyup/mouseup may never arrive — which is exactly what left Space
// pan wedged after opening a file. Reset every transient gesture latch on blur so
// pan/drag behave predictably the moment focus returns.
window.addEventListener('blur', () => {
  if (canvas.panning) canvas.endPan();
  isMouseDown = false;
  endSpacePan();
});

// Toolbar fill/stroke swap & default — share the registry commands.
document.getElementById('tb-swap')?.addEventListener('click', () => runCommand('color.swap-fill-stroke', commandCtx));
document.getElementById('tb-default')?.addEventListener('click', () => runCommand('color.default-colors', commandCtx));

// Frame rulers re-render on view change (their tick spacing & labels are sized in
// screen units, so they must refresh when the zoom changes).
canvas.setOnViewChange(() => {
  activeTool.onViewChange?.();
  renderFrames(state, svgCanvas, canvas.getZoom()); // keep frame name/dimension labels a constant on-screen size while zooming
  renderFrameGuides(state, svgCanvas, canvas.getZoom());
  renderMaskGuides(state, svgCanvas, canvas.getZoom());
  updateSelectionOverlay(state, selectionLayer, canvas.getZoom()); // keep handles a constant on-screen size while zooming
  updateParametricHandles(state);
  renderNodeOverlay(state, guidesLayer, canvas.getZoom()); // keep node anchors/handles a constant on-screen size while zooming
  renderMaskGhost(state, guidesLayer); // keep the mask onion-skin glued to the selection while panning/zooming
  updateDirectionOverlay(); // keep the flow's chevrons a constant on-screen size
  updateContextPopovers(); // keep the floating popovers glued to the selection
});

// Zoom-fit button uses artboard bounds
document.getElementById('btn-zoom-fit')?.addEventListener('click', () => {
  canvas.fitToWindow(getArtboardsBounds());
});

// Setup
setupMenus(commandCtx);
setupDirectionOverlay(state, canvas, svgCanvas);
setupProperties(state);
setupTextStyles(state); // Text-panel "Style" row + library flyout (must run after setupProperties)
setupLibrary(state); // Library panel — stacked under Layers in the left dock (collapsible)
// The Fills/pattern editor points at the Library rather than duplicating a picker;
// wired here so paint-editors needn't import the panel (that would be a cycle).
setPatternLibraryOpener((docId) => revealLibrarySection('pattern', docId));
// Linked files pointed at documents in the retired cloud backend, so their source
// can no longer be opened or re-pulled. The artwork is stored in the file and still
// renders; the Layers chip explains and points at Embed, which keeps it for good.
const linkedSourceGone = (name: string) =>
  showToast(`"${name}" was linked to a BuzzQuill Cloud document, which no longer exists. Use Object ▸ Embed Linked File to keep the artwork.`, 10000);
setLinkedSourceOpener((_src, name) => linkedSourceGone(name));
setLinkedSourceUpdater((shapeId) => linkedSourceGone(state.findShapeById(shapeId)?.name ?? 'Linked file'));
setupObjectStylesPanel({ changed: () => { updateLibrary(state); updateStylePanel(state); updateObjectStylesPanel(state); } });
setupInspector(state);
setupStrokesPanel(state);
setupEffects(state);
setupFramePanel(state);
setupWidthPanel(state);
setupRepeatPanel(state);
setupMarkers(state);
setupLayerButtons(commandCtx);
setupColorPicker(state);
setupAlign(state);
setupSwatches(state);
setupPathfinder(state, () => canvas.getZoom());
setupPathActions(state);
setupImageActions(state);
setupMeasureOverlay(state, canvas);
setupShapePicker(state, canvas, svgCanvas);
setupParametricHandles(state);
setupTooltips();
setupTabBar(docs);
setupDrive(docs); // Drive status chip + recents popout; inert unless VITE_GOOGLE_* are set
// Dev-only debug handle (stripped from production builds).
if (import.meta.env.DEV) (window as unknown as { state: AppState; docs: DocumentManager }).state = state;
if (import.meta.env.DEV) (window as unknown as { state: AppState; docs: DocumentManager }).docs = docs;

// Error boundary for fire-and-forget async commands (boolean ops, outline, offset,
// export). A rejection here would otherwise fail silently — worst of all a
// dynamic import() of a code-split chunk (e.g. paper.js for a boolean op) that 404s
// after a redeploy, so the user clicks Unite and nothing happens. Dev-log every
// rejection (like the frames-invariant guard), and in ALL builds surface a reload
// hint when a chunk failed to load (#180).
window.addEventListener('unhandledrejection', (e) => {
  if (import.meta.env.DEV) console.error('[unhandledrejection]', e.reason);
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? '');
  if (/dynamically imported module|module script|Loading chunk|Failed to fetch/i.test(msg)) {
    showToast('Something didn’t load — BuzzQuill may have updated. Reload to continue.', 0, {
      label: 'Reload',
      onClick: () => {
        if (sessionRestored) flushSessionSave(sessionNow);
        location.reload();
      },
    });
  }
});
setupSymbolButtons(commandCtx);
setupRecentFilesMenu(state, async (handle) => {
  const pending = await pendingFromHandle(handle);
  if (pending) await docs.openDocument(pending);
});
setupNumberScrub(); // Unity-style drag-to-scrub on every numeric field's label
commitFieldsOnCanvasPress(mustId('canvas-area')); // a typed value lands on ITS selection, not the next click's
setupInteractionFeedback(); // pulse action/toggle buttons on click (hover/press/focus live in CSS)
setupPaste(state); // Cmd+V of an image / vector from another app lands on the canvas
commandCtx.openCommandPalette = createCommandPalette(commandCtx).open;

// Initial render
const initBounds = getArtboardsBounds();
canvas.initSize(initBounds);
renderFrames(state, svgCanvas);
renderFrameGuides(state, svgCanvas, canvas.getZoom());
renderMaskGuides(state, svgCanvas, canvas.getZoom());

svgCanvas.setAttribute('data-tool', 'select');

// Restore the previous session (open tabs + content) so work comes back on load
// without manually re-opening anything. Async because it reads IndexedDB; the app
// is already usable with the blank boot document while this resolves. Only after
// the attempt do we start persisting, so a restore can't be clobbered by a save.
void (async () => {
  try {
    const session = await loadSession();
    if (session) docs.restoreSession(session); // fires onStateChange + tab render
  } catch { /* corrupt/unavailable session — start with the blank document */ }
  sessionRestored = true;
})();

// Best-effort flush when the page is hidden or closing: the debounced write may
// not have fired yet, and IndexedDB writes on beforeunload aren't guaranteed to
// complete, so 'hidden' (fired while the page is still alive) is the reliable one.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && sessionRestored) {
    flushSessionSave(sessionNow);
  }
});

// Drag-and-drop file import — canvas appends, tab bar opens as a new document.
// Both zones and their on-drag feedback live in ui/file-drop.ts.
setupFileDrop(state, docs, canvas);

window.addEventListener('resize', () => {
  canvas.initSize(getArtboardsBounds());
  renderFrameGuides(state, svgCanvas, canvas.getZoom());
  renderMaskGuides(state, svgCanvas, canvas.getZoom());
});

// Refit the viewBox to the new canvas size while keeping the current zoom + center
// (setZoom at the same zoom recomputes w/h from the element rect without
// re-centering on the artboard, so the view doesn't jump). Used whenever the live
// canvas's width changes — side-panel resize AND entering/leaving split view.
function refitCanvas(): void {
  canvas.setZoom(canvas.getZoom());
  renderFrameGuides(state, svgCanvas, canvas.getZoom());
  renderMaskGuides(state, svgCanvas, canvas.getZoom());
}
setupPanelResizers(refitCanvas);

// Split view — two editor groups side by side (one live editor + one preview pane
// that becomes editable on click). Refits the live canvas after the grid reflows.
setupSplitView({ docs, onLayoutChange: refitCanvas });

// Warn before closing/reloading the tab with unsaved changes.
window.addEventListener('beforeunload', (e) => {
  if (sessionRestored) flushSessionSave(sessionNow); // best-effort persist
  if (docs.anyDirty()) { // any open tab with unsaved edits
    e.preventDefault();
    e.returnValue = '';
  }
});

// Register the service worker for offline/PWA support. Production only, so it
// never caches modules during dev (which would break HMR).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // A deploy ships a new SW (its cache name is bumped per build). When that
      // update finishes installing WHILE a worker already controls the page, a new
      // version is ready — invite a reload. The SW skipWaiting()s + claims clients,
      // so a reload lands entirely on the fresh assets (and updated icons). Guarded
      // by `controller` so this never fires on the very first install.
      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          if (next.state === 'installed' && navigator.serviceWorker.controller) {
            // Persist (best-effort) any dirty tabs first so a reload can't lose
            // in-flight edits, then hand the user a one-click Reload. Keep the
            // toast up (duration 0) so it isn't a dead-end they have to remember.
            showToast('A new version of BuzzQuill is available.', 0, {
              label: 'Reload',
              onClick: () => {
                if (sessionRestored) flushSessionSave(sessionNow);
                location.reload();
              },
            });
          }
        });
      });
    }).catch(() => { /* offline support unavailable */ });
  });
} else if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  // A service worker left over from a prod build / `vite preview` on this same
  // localhost origin will keep serving STALE cached modules in dev — code changes
  // then appear to have no effect even after restarting Vite. Tear any down and
  // drop their caches so dev always runs the live code.
  navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister())).catch(() => {});
  if ('caches' in window) caches.keys().then(keys => keys.forEach(k => caches.delete(k))).catch(() => {});
}

// File Handling API: when the OS opens an .svg/.svgmaker with the installed
// PWA, it hands us file handles here. Route them through the normal open path.
const launchQueue = (window as unknown as {
  launchQueue?: { setConsumer: (cb: (params: { files: FileSystemFileHandle[] }) => void) => void };
}).launchQueue;
if (launchQueue) {
  launchQueue.setConsumer((params) => {
    const handle = params.files?.[0];
    if (handle && confirmDiscard(state)) {
      openHandle(state, handle).catch((err) => {
        alert('Failed to open file: ' + (err instanceof Error ? err.message : String(err)));
      });
    }
  });
}
