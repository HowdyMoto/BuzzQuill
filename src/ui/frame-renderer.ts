import { tokens } from './tokens';
import type { AppState } from '../core/state';

const NS = 'http://www.w3.org/2000/svg';

/**
 * Inline-rename a frame from its on-canvas label: overlays an <input> on the
 * label (constant screen size, so this is a plain screen-space overlay), commits
 * on Enter/blur through state.renameShape, cancels on Escape.
 */
export function openFrameRename(state: AppState, svgCanvas: SVGSVGElement, frameId: string): void {
  const label = svgCanvas.querySelector(
    `#artboard-labels-layer [data-frame-select="${CSS.escape(frameId)}"]`) as SVGGraphicsElement | null;
  const ab = state.getArtboardById(frameId);
  if (!label || !ab || document.querySelector('.frame-rename-input')) return;
  const r = label.getBoundingClientRect();

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'frame-rename-input';
  input.value = ab.name;
  input.spellcheck = false;
  input.style.left = `${Math.round(r.left - 4)}px`;
  input.style.top = `${Math.round(r.top - 3)}px`;
  input.style.width = `${Math.max(90, Math.round(r.width) + 24)}px`;

  let done = false;
  const close = (commit: boolean): void => {
    if (done) return;
    done = true;
    const name = input.value;
    input.remove();
    if (commit) state.renameShape(frameId, name);
  };
  input.addEventListener('blur', () => close(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); close(true); }
    else if (e.key === 'Escape') { e.preventDefault(); close(false); }
  });
  document.body.appendChild(input);
  input.focus();
  input.select();
}

/**
 * Renders all artboards as white rectangles on the pasteboard.
 * Called on every state change (and on view change, for the constant-size labels).
 * `zoom` keeps the name/dimension labels a fixed on-screen size at any zoom.
 */
export function renderFrames(state: AppState, svgCanvas: SVGSVGElement, zoom = 1): void {
  // World units per on-screen pixel: multiply label font-sizes/offsets by this so the
  // chrome text stays a constant on-screen size as the viewBox zooms.
  const k = zoom > 0 ? 1 / zoom : 1;
  // Get or create the artboards layer (just after pasteboard)
  let abLayer = svgCanvas.querySelector('#artboards-layer') as SVGGElement | null;
  if (!abLayer) {
    abLayer = document.createElementNS(NS, 'g') as SVGGElement;
    abLayer.id = 'artboards-layer';
    const pasteboard = svgCanvas.querySelector('#pasteboard');
    if (pasteboard && pasteboard.nextSibling) {
      svgCanvas.insertBefore(abLayer, pasteboard.nextSibling);
    } else {
      svgCanvas.appendChild(abLayer);
    }
  }
  abLayer.innerHTML = '';

  // Get or create artboard labels layer (after selection layer)
  let labelsLayer = svgCanvas.querySelector('#artboard-labels-layer') as SVGGElement | null;
  if (!labelsLayer) {
    labelsLayer = document.createElementNS(NS, 'g') as SVGGElement;
    labelsLayer.id = 'artboard-labels-layer';
    svgCanvas.appendChild(labelsLayer);
  }
  // The name labels are REUSED across renders (keyed by frame id), never wiped:
  // the browser only synthesizes `click`/`dblclick` when the mousedown target is
  // still in the document, and the first click of a double-click re-renders this
  // chrome (frame selection) — recreating the label here swallowed the second
  // click, breaking double-click-to-rename. Everything else in the layer (the
  // dimension texts) is non-interactive and regenerated each pass.
  const oldLabels = new Map<string, SVGTextElement>();
  labelsLayer.querySelectorAll('text[data-frame-select]').forEach((el) => {
    oldLabels.set(el.getAttribute('data-frame-select')!, el as unknown as SVGTextElement);
  });
  Array.from(labelsLayer.children).forEach((c) => { if (!c.hasAttribute('data-frame-select')) c.remove(); });
  const liveLabelIds = new Set<string>();

  // Get or create artboard handles layer (for artboard tool)
  let handlesLayer = svgCanvas.querySelector('#artboard-handles-layer') as SVGGElement | null;
  if (!handlesLayer) {
    handlesLayer = document.createElementNS(NS, 'g') as SVGGElement;
    handlesLayer.id = 'artboard-handles-layer';
    svgCanvas.appendChild(handlesLayer);
  }
  handlesLayer.innerHTML = '';

  const isFrameTool = state.currentTool === 'frame';

  for (const ab of state.artboards) {
    const isActive = ab.id === state.activeFrameId;
    const isSelected = ab.id === state.selectedFrameId && isFrameTool;

    // Frames render their own background + clip (the .frame-bg rect inside the
    // frame <g>); this renderer only draws overlay CHROME (border, label, handles).
    // The per-frame grid + rulers are drawn above content by frame-guides.ts.

    // Border — frames are transparent, so this outline is the only cue to where a
    // frame is; it must always read (subtly) on the charcoal pasteboard. A muted
    // blue-grey, a touch brighter for the active frame, the accent while selected
    // with the artboard tool. non-scaling-stroke keeps it a crisp ~1px at any zoom
    // (a world-space 0.5px vanished when zoomed out).
    const border = document.createElementNS(NS, 'rect');
    border.setAttribute('x', String(ab.x));
    border.setAttribute('y', String(ab.y));
    border.setAttribute('width', String(ab.width));
    border.setAttribute('height', String(ab.height));
    border.setAttribute('fill', 'none');
    // Frame = azure container language: bright accent when selected, a hair brighter
    // azure when active, muted azure chrome at rest (was neutral grey).
    border.setAttribute('stroke', isSelected ? tokens.selectionAccent : (isActive ? '#6e8fb8' : tokens.frameChrome));
    border.setAttribute('stroke-width', isSelected ? '2' : '1');
    border.setAttribute('vector-effect', 'non-scaling-stroke');
    border.setAttribute('pointer-events', 'none');
    abLayer.appendChild(border);

    // Frame NAME (above the top-left corner) — name only. Clicking it selects the
    // frame (its contents are what you grab by clicking inside it; the label is the
    // handle for the frame itself). Dimensions are shown separately along the edges.
    // Reused across renders — see the layer setup above for why identity matters.
    let label = oldLabels.get(ab.id);
    if (!label) {
      label = document.createElementNS(NS, 'text') as unknown as SVGTextElement;
      label.setAttribute('data-frame-select', ab.id);
      label.setAttribute('font-family', 'Arial, sans-serif');
      // Whole label rectangle is clickable, not just the glyphs (SVG text otherwise
      // only hit-tests on painted glyphs, so the gaps between characters miss).
      label.setAttribute('pointer-events', 'bounding-box');
      label.setAttribute('style', 'cursor: pointer');
      labelsLayer.appendChild(label);
    }
    liveLabelIds.add(ab.id);
    label.setAttribute('x', String(ab.x));
    label.setAttribute('y', String(ab.y - 6 * k));
    label.setAttribute('font-size', String(11 * k)); // constant ~11px on screen
    label.setAttribute('fill', isActive ? '#ccc' : '#888');
    label.textContent = ab.name;
    // Truncate with an ellipsis if the (constant-size) name would be wider than the
    // frame on screen. Font-size scales with k, so the label's world length and the
    // frame's world width scale together — comparing them in world units is exact.
    try {
      if (label.getComputedTextLength() > ab.width && ab.name.length > 1) {
        let name = ab.name;
        while (name.length > 1) {
          name = name.slice(0, -1);
          label.textContent = name + '…';
          if (label.getComputedTextLength() <= ab.width) break;
        }
      }
    } catch { /* getComputedTextLength can throw if not yet laid out — leave full name */ }
    // Native tooltip — the label is the frame's handle for all three gestures.
    // (Appended AFTER truncation: the textContent writes above would wipe it.)
    const tip = document.createElementNS(NS, 'title');
    tip.textContent = 'Click to select · drag to move · double-click to rename';
    label.appendChild(tip);

    // Dimension labels along the edges (CAD-style): the WIDTH centered on the top and
    // bottom edges (horizontal), the HEIGHT centered on the left and right edges
    // (vertical, reading bottom-to-top). Non-interactive chrome, also constant size.
    // Shown only when this frame's rulers are on — the numbers are measurement chrome
    // that belongs with the rulers, so an idle frame reads as just its outline + name.
    if (state.getFrameRulers(ab.id)) {
      const dimColor = isActive ? '#888' : '#666';
      const w = Math.round(ab.width), h = Math.round(ab.height);
      const cx = ab.x + ab.width / 2, cy = ab.y + ab.height / 2;
      const mkDim = (tx: number, ty: number, text: string, rot = 0) => {
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', String(tx));
        t.setAttribute('y', String(ty));
        t.setAttribute('font-size', String(10 * k));
        t.setAttribute('font-family', 'Arial, sans-serif');
        t.setAttribute('fill', dimColor);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('pointer-events', 'none');
        if (rot) t.setAttribute('transform', `rotate(${rot} ${tx} ${ty})`);
        t.textContent = text;
        labelsLayer.appendChild(t);
      };
      mkDim(cx, ab.y - 6 * k, String(w));                  // top edge — width
      mkDim(cx, ab.y + ab.height + 13 * k, String(w));     // bottom edge — width
      mkDim(ab.x - 8 * k, cy, String(h), -90);             // left edge — height
      mkDim(ab.x + ab.width + 12 * k, cy, String(h), -90); // right edge — height
    }

    // Resize handles if artboard tool is active and this artboard is selected
    if (isSelected) {
      const handleSize = 8;
      const handles = [
        { id: 'nw', cx: ab.x, cy: ab.y },
        { id: 'n', cx: ab.x + ab.width / 2, cy: ab.y },
        { id: 'ne', cx: ab.x + ab.width, cy: ab.y },
        { id: 'e', cx: ab.x + ab.width, cy: ab.y + ab.height / 2 },
        { id: 'se', cx: ab.x + ab.width, cy: ab.y + ab.height },
        { id: 's', cx: ab.x + ab.width / 2, cy: ab.y + ab.height },
        { id: 'sw', cx: ab.x, cy: ab.y + ab.height },
        { id: 'w', cx: ab.x, cy: ab.y + ab.height / 2 },
      ];
      const cursors: Record<string, string> = {
        nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize', e: 'ew-resize',
        se: 'nwse-resize', s: 'ns-resize', sw: 'nesw-resize', w: 'ew-resize',
      };
      for (const h of handles) {
        const rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('x', String(h.cx - handleSize / 2));
        rect.setAttribute('y', String(h.cy - handleSize / 2));
        rect.setAttribute('width', String(handleSize));
        rect.setAttribute('height', String(handleSize));
        rect.setAttribute('fill', 'white');
        rect.setAttribute('stroke', tokens.selectionAccent);
        rect.setAttribute('stroke-width', '1');
        rect.setAttribute('data-ab-handle', h.id);
        rect.setAttribute('data-ab-id', ab.id);
        rect.setAttribute('style', `cursor: ${cursors[h.id]}`);
        handlesLayer.appendChild(rect);
      }
    }
  }

  // Drop labels whose frame is gone (deleted / switched document).
  for (const [id, el] of oldLabels) {
    if (!liveLabelIds.has(id)) el.remove();
  }
}
