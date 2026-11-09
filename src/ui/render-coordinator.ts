import { scheduleRasterDetail } from '../core/raster-assets';
import { updateLinkedImages } from './linked-images';
import type { AppState } from '../core/state';
import type { CanvasController } from '../core/canvas';
import { renderTabBar } from './tab-bar';
import { updateSplitView } from './split-view';
import { updateSelectionOverlay } from './selection-overlay';
import { renderNodeOverlay } from './node-overlay';
import { renderMaskGhost } from './mask-ghost';
import { updateToolHint } from './tool-hint';
import { updatePropertiesPanel, updateTransformReadout, updateRadiusReadout, syncTextPanelVisibility } from './properties';
import { updateTextStylesUI } from './text-styles';
import { updateInspector } from './inspector';
import { updateStrokesPanel } from './appearance-panel';
import { updateEffectsPanel } from './effects';
import { updateFramePanel } from './frame-panel';
import { updateWidthPanel } from './width-panel';
import { updateRepeatPanel } from './repeat-panel';
import { updateMarkersPanel } from './markers';
import { updateLayersPanel } from './layers';
import { updateLibrary } from './library-panel';
import { updateStylePanel } from './style-panel';
import { updateObjectStylesPanel } from './object-styles-panel';
import { renderFrameGuides } from './frame-guides';
import { renderMaskGuides } from './mask-guides';
import { updatePathfinderPanel, updatePathfinderPopover } from './pathfinder';
import { updatePathActionsPopover } from './path-actions';
import { updateDirectionOverlay } from './direction-overlay';
import { updateImageActions } from './image-actions';
import { updateParametricHandles } from './parametric-handles';
import { renderFrames } from './frame-renderer';
import { updateSymbolsPanel } from './symbols-panel';

interface RenderLayers {
  svgCanvas: SVGSVGElement;
  selectionLayer: SVGGElement;
  guidesLayer: SVGGElement;
}

/** Preserve the editor's update order: derived caches, overlays, panels, persistence.
 * Interactive changes coalesce; settled changes always render synchronously. */
export function createRenderCoordinator(
  state: AppState, canvas: CanvasController, layers: RenderLayers, onSettled: () => void,
) {
  const { svgCanvas, selectionLayer, guidesLayer } = layers;
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

    scheduleRasterDetail();
    updatePropertiesPanel(state);
    updateStrokesPanel(state);
    updateEffectsPanel(state);
    updateFramePanel(state);
    updateLinkedImages();
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
    onSettled();
  }

  /** The contextual popovers (Pathfinder / path actions / image actions) all anchor
   *  to the selection, so they always refresh together. */
  function updateContextPopovers(): void {
    updatePathfinderPopover(state);
    updatePathActionsPopover(state);
    updateImageActions(state);
  }

  return { onStateChange, updateContextPopovers };
}
