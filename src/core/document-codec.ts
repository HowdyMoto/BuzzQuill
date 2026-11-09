/** SVG document format and legacy decoding. UI feedback is supplied by callers. */
import type { AppState } from './state';
import type { Artboard, ShapeStyle } from './types';
import { escapeHtml } from './markup-escape';
import { SVG_NS_DECLS, ensureSvgNamespaces } from './svg-ns';
import { buildEmbeddedFontStyle, embeddedFontFaceStyle } from './text-outline';

const FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------
// Editor metadata embedded inside the saved SVG (ignored by other tools).
// ---------------------------------------------------------------------------

export interface SerializedShape {
  id: string;
  type: string;
  name: string;
  style: ShapeStyle;
  visible: boolean;
  locked: boolean;
}

// 'SVGMaker' is the pre-rename identifier — still accepted on read so existing
// files keep opening; new files are written as 'BuzzQuill'.
type AppId = 'BuzzQuill' | 'SVGMaker';
const APP_ID: AppId = 'BuzzQuill';
const isKnownApp = (v: unknown): boolean => v === 'BuzzQuill' || v === 'SVGMaker';

export interface DocMeta {
  app: AppId;
  version: number;
  artboards: Artboard[];
  activeFrameId: string | null;
  shapes: SerializedShape[];
  canvasBg?: string | null;
}

function buildMeta(state: AppState): DocMeta {
  return {
    app: APP_ID,
    version: FORMAT_VERSION,
    artboards: state.artboards.map(ab => ({ ...ab })),
    activeFrameId: state.activeFrameId,
    shapes: state.shapes.map(s => ({
      id: s.id, type: s.type, name: s.name,
      style: { ...s.style }, visible: s.visible, locked: s.locked,
    })),
    // defaultStyle / fillNone / strokeNone are intentionally NOT persisted. New shapes
    // always use the fixed default (makeDefaultStyle); persisting the default was why
    // "everything is 74.5px" survived reloads and new documents.
    canvasBg: state.canvasBackground,
  };
}


/** Bounding box that encloses every artboard, used as the SVG viewport. */
function unionArtboardBounds(state: AppState): { x: number; y: number; w: number; h: number } {
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

/**
 * Serialize the document to a standard SVG. Editor-only state (artboards,
 * lock flags, default styles) is stored in a <metadata> block so the file
 * round-trips losslessly while remaining a valid SVG that renders anywhere.
 */
export function serializeDocumentSVG(state: AppState): string {
  const b = unionArtboardBounds(state);
  const metaJson = escapeHtml(JSON.stringify(buildMeta(state)));

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" ${SVG_NS_DECLS}${state.getExtraNamespaceDecls()} viewBox="${b.x} ${b.y} ${b.w} ${b.h}" width="${b.w}" height="${b.h}">
<metadata class="svgmaker-state">${metaJson}</metadata>
${state.getDefsBlock()}<g class="svgmaker-doc">${state.getDrawingLayerSVG()}</g>
</svg>`;
}

/**
 * Serialize for a FILE SAVE: {@link serializeDocumentSVG} plus the used fonts embedded
 * as `@font-face` (data-URLs). Without this a saved .svg only carries `font-family`
 * NAMES, so a viewer that lacks the font (or the browser rendering it standalone) falls
 * back to a serif — the fonts are only "present" while BuzzQuill has them loaded.
 *
 * The `<style>` is placed directly under `<svg>`, NOT inside `<defs>`: viewers apply it
 * document-wide, but our loader only imports `<defs>` + the drawing group, so it's
 * ignored on reopen (no round-trip accumulation). Re-derived fresh on every save.
 */
export async function serializeDocumentSVGForSave(state: AppState, base = serializeDocumentSVG(state)): Promise<{ svg: string; warnings: string[] }> {
  const markup = state.getDrawingLayerSVG();
  const docFaces = embeddedFontFaceStyle(state.embeddedFonts, markup); // e.g. PDF-import fonts
  const bundled = await buildEmbeddedFontStyle(markup);                 // bundled families in use
  const style = [docFaces, bundled.style].filter(Boolean).join('\n');
  const svg = style ? base.replace('</metadata>', `</metadata>\n${style}`) : base;
  return { svg, warnings: bundled.warnings };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Re-apply names/visibility/lock/style that don't fully live in the markup. */
function applyShapeMeta(state: AppState, shapes: SerializedShape[]): void {
  for (const saved of shapes) {
    const shape = state.findShapeById(saved.id);
    if (!shape) continue;
    shape.name = saved.name;
    shape.style = { ...saved.style };
    shape.visible = saved.visible;
    shape.locked = saved.locked;
    if (!saved.visible) (shape.element as SVGElement).style.display = 'none';
    if (saved.locked) shape.element.setAttribute('data-locked', 'true');
  }
}

/** Load a document from an SVG string (ours, with metadata, or a foreign SVG). */
export function loadDocumentSVG(state: AppState, svgString: string, warn: (message: string) => void = () => {}): void {
  const doc = new DOMParser().parseFromString(ensureSvgNamespaces(svgString), 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  if (!svgEl) throw new Error('File is not a valid SVG.');

  // A point edit left open would point at a shape in the document being replaced.
  state.exitPathEdit();

  // Look for our embedded editor metadata.
  let meta: DocMeta | null = null;
  const metaEl = svgEl.querySelector('metadata.svgmaker-state') ?? svgEl.querySelector('metadata');
  if (metaEl?.textContent) {
    try {
      const parsed = JSON.parse(metaEl.textContent.trim());
      if (parsed && isKnownApp(parsed.app)) meta = parsed as DocMeta;
    } catch { /* not our metadata — treat as a foreign SVG */ }
  }

  if (meta) {
    // ---- Our document: restore everything ----
    if (meta.version > FORMAT_VERSION) {
      throw new Error(`This file was made with a newer BuzzQuill (v${meta.version}). Please update.`);
    }

    state.clearDefs();
    state.importDefsFrom(svgEl);

    // Drawing content lives inside <g class="svgmaker-doc">.
    const body = svgEl.querySelector('g.svgmaker-doc');
    const serializer = new XMLSerializer();
    let markup = '';
    if (body) {
      for (const child of Array.from(body.children)) markup += serializer.serializeToString(child);
    }
    state.importSVGMarkup(markup);

    if (meta.shapes) applyShapeMeta(state, meta.shapes);
    // defaultStyle / fillNone / strokeNone are NOT restored — new shapes always use the
    // fixed default. Old files may still carry them in the metadata; we ignore them.
    state.canvasBackground = meta.canvasBg ?? null;
    state.applyCanvasBackground();

    // Current-format docs already contain frame elements (migrate is a no-op).
    // Legacy docs carry only `meta.artboards`; wrap their content into frames.
    const boards = meta.artboards?.length
      ? meta.artboards.map(a => ({ x: a.x, y: a.y, width: a.width, height: a.height, name: a.name }))
      : [{ x: 0, y: 0, width: 960, height: 540, name: 'Frame 1' }];
    state.migrateContentToFrames(boards);
    state.activeFrameId =
      (meta.activeFrameId && state.getArtboardById(meta.activeFrameId))
        ? meta.activeFrameId
        : (state.artboards[0]?.id ?? null);
  } else {
    // ---- Foreign SVG: import shapes and wrap them in a single frame ----
    state.clearDefs();
    state.importSVGContent(svgString);

    // The imported content lives in the viewBox coordinate system, so the frame
    // must match the viewBox — not width/height, which are the display size and
    // may be in physical units (mm/cm/in) or % that parseFloat would misread.
    const vb = svgEl.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
      .filter(n => Number.isFinite(n));
    const hasVb = vb?.length === 4 && vb[2] > 0 && vb[3] > 0;
    const w = (hasVb ? vb![2] : parseFloat(svgEl.getAttribute('width') ?? '')) || 960;
    const h = (hasVb ? vb![3] : parseFloat(svgEl.getAttribute('height') ?? '')) || 540;
    const x = hasVb ? vb![0] : 0;
    const y = hasVb ? vb![1] : 0;
    state.migrateContentToFrames([{ x, y, width: w, height: h, name: 'Frame 1' }]);
    state.activeFrameId = state.artboards[0]?.id ?? null;
    state.canvasBackground = null; // foreign SVGs carry no BuzzQuill background
    state.applyCanvasBackground();
  }

  state.selectedFrameId = null;
  state.saveHistory();
  state.markClean();
  state.onChange_public();

  if (!meta && state.lastImportHadAnimation) {
    warn('This SVG used SMIL animation, which BuzzQuill doesn’t support yet. The static image was imported — saving won’t include the animation.');
  }
}

/** Dispatch on file contents: legacy .svgmaker JSON vs. SVG. */
export function loadDocumentString(state: AppState, text: string, warn: (message: string) => void = () => {}): void {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    loadProject(state, text); // legacy .svgmaker project
  } else {
    loadDocumentSVG(state, text, warn);
  }
}

// ---------------------------------------------------------------------------
// Legacy .svgmaker (JSON) loading — open-only, for backward compatibility.
// ---------------------------------------------------------------------------

export interface ProjectFile {
  version: number;
  app: AppId;
  artboards: Artboard[];
  activeFrameId: string | null;
  shapes: SerializedShape[];
  svgContent: string;
}

export function loadProject(state: AppState, json: string): void {
  const project = JSON.parse(json) as ProjectFile;
  if (!isKnownApp(project.app)) throw new Error('Not a valid BuzzQuill file.');
  if (!project.version || project.version > FORMAT_VERSION) {
    throw new Error(`File version ${project.version} is newer than this version of BuzzQuill supports.`);
  }

  if (project.artboards?.length) {
    state.artboards.length = 0;
    for (const ab of project.artboards) state.artboards.push({ ...ab });
    state.activeFrameId = project.activeFrameId ?? state.artboards[0].id;
  }

  state.importSVGMarkup(project.svgContent);
  if (project.shapes) applyShapeMeta(state, project.shapes);
  // defaultStyle / fillNone / strokeNone intentionally not restored (fixed defaults).

  state.selectedFrameId = null;
  state.saveHistory();
  state.markClean();
  state.onChange_public();
}
