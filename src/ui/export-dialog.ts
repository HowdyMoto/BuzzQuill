import type { AppState } from '../core/state';
import type { ExportFormat, Artboard, ExportTarget } from '../core/types';
import { bakeLayerContent } from '../core/bake';
import { pruneUnusedDefs } from '../core/svg-io';
import { SVG_NS_DECLS } from '../core/svg-ns';
import { outlineText, buildEmbeddedFontStyle, embeddedFontFaceStyle } from '../core/text-outline';
import { canvasToRasterBlob, isOpaqueFormat, type RasterMime } from '../core/raster-encoders';
import type { EmbeddedFont } from '../core/embedded-fonts';
import { supportsFileSystemAccess, saveFilePicker, writeHandle } from '../core/file-access';
import { getRememberedExportDir, rememberExportDir } from '../core/export-store';
import { exportRect, type ExportBounds } from '../core/export-scope';
import { showToast } from './toast';
import { openModal } from './modal';
import { createButton, createSelect, createField, createCheckRow, createModalHeader, createModalBody, createModalFooter } from './components';

type TextMode = 'keep' | 'outline' | 'embed';

/** Batch-export size: a scale multiplier, or an exact output width/height in px
 *  (the missing side follows each frame's aspect ratio). */
type ExportSize = { mode: 'scale' | 'width' | 'height'; value: number };

/** Every export format except SVG rasterizes. */
type RasterFormat = Exclude<ExportFormat, 'svg'>;
const MIME: Record<RasterFormat, RasterMime> = {
  png: 'image/png', jpg: 'image/jpeg', bmp: 'image/bmp', gif: 'image/gif', tiff: 'image/tiff',
};

/** Drawing-layer markup, with element transforms baked into geometry if asked. */
function layerContent(state: AppState, bake: boolean): { content: string; warnings: string[] } {
  const dl = document.getElementById('drawing-layer') as unknown as SVGGElement | null;
  if (bake && dl) return bakeLayerContent(dl);
  return { content: state.getDrawingLayerSVGForExport(), warnings: [] };
}

/** Quick-export a frame using ITS export list — every target it defines (a logo
 *  fanned out to favicon, apple-touch, … in one action). Drives the Layers-panel
 *  export button and the Properties-panel Export button. */
export async function exportArtboardToFile(state: AppState, ab: Artboard): Promise<boolean> {
  return exportFrameTargets(state, ab, state.getFrameExportTargets(ab.id));
}

const FILE_TYPES: Record<ExportFormat, { description: string; accept: Record<string, string[]> }> = {
  svg: { description: 'SVG Image', accept: { 'image/svg+xml': ['.svg'] } },
  png: { description: 'PNG Image', accept: { 'image/png': ['.png'] } },
  jpg: { description: 'JPEG Image', accept: { 'image/jpeg': ['.jpg'] } },
  bmp: { description: 'BMP Image', accept: { 'image/bmp': ['.bmp'] } },
  gif: { description: 'GIF Image', accept: { 'image/gif': ['.gif'] } },
  tiff: { description: 'TIFF Image', accept: { 'image/tiff': ['.tiff', '.tif'] } },
};

/** Resolve a target's output pixel size. Explicit width/height win (a missing side
 *  is derived from the frame's aspect ratio); otherwise scale × the frame's size. */
function outputDims(ab: Artboard, t: ExportTarget): { w: number; h: number } {
  const aspect = ab.width / ab.height || 1;
  if (t.width || t.height) {
    const w = t.width ?? Math.round((t.height as number) * aspect);
    const h = t.height ?? Math.round((t.width as number) / aspect);
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }
  const s = t.scale || 1;
  return { w: Math.max(1, Math.round(ab.width * s)), h: Math.max(1, Math.round(ab.height * s)) };
}

/** Set explicit width/height on the root <svg> (viewBox is untouched → content scales). */
function resizeSvg(svg: string, w: number, h: number): string {
  return svg.replace(/width="[^"]*"\s+height="[^"]*"/, `width="${w}" height="${h}"`);
}

/** The effective backdrop for a target: explicit value, else transparent for
 *  SVG/PNG and white for JPG (which has no alpha channel). */
function targetBackground(t: ExportTarget): string {
  return t.background ?? (t.format === 'jpg' ? '#FFFFFF' : 'transparent');
}

/** Build one target's output file (blob + filename), applying that target's own
 *  per-format options (text handling & bake for SVG; background & quality for raster).
 *  `cache` memoizes the drawing markup per (bake, textMode) across a batch so several
 *  targets that share settings don't re-outline. */
async function buildTargetFile(
  state: AppState, frameAb: Artboard, t: ExportTarget,
  cache: Map<string, { drawingSvg: string; defsBlock: string; warnings: string[] }>,
): Promise<{ blob: Blob; filename: string; format: ExportFormat; warnings: string[] }> {
  const base = sanitizeFilename(t.name) || sanitizeFilename(frameAb.name) || 'export';
  // The canvas this target covers: the frame, or the frame narrowed to its paths.
  const fit = exportRect(state, frameAb, t.bounds);
  const ab = fit.rect;
  const { w, h } = outputDims(ab, t);
  const bg = targetBackground(t);
  const bake = t.bake ?? state.bakeTransformsOnExport;
  // SVG honours the user's text mode. Raster is rendered by loading the SVG string as
  // an <img> — an isolated context with NO access to the page's loaded fonts — so text
  // would fall back to a default face unless the fonts travel WITH the SVG. Embed them
  // ('embed' = @font-face data-URLs for every used font) so the pixels match the canvas.
  const textMode: TextMode = t.format === 'svg' ? (t.textMode ?? state.textExportMode) : 'embed';

  const key = `${bake}|${textMode}`;
  let base2 = cache.get(key);
  if (!base2) {
    const drawing = layerContent(state, bake);
    const r = await applyTextMode(drawing.content, state.getDefsBlock(), textMode, state.embeddedFonts);
    base2 = { drawingSvg: r.drawingSvg, defsBlock: r.defsBlock, warnings: [...drawing.warnings, ...r.warnings] };
    cache.set(key, base2);
  }
  const svgStr = buildArtboardSVG(ab, base2.drawingSvg, base2.defsBlock, state.getExtraNamespaceDecls(), bg);

  const warnings = fit.note ? [...base2.warnings, fit.note] : base2.warnings;
  if (t.format === 'svg') {
    return { blob: new Blob([resizeSvg(svgStr, w, h)], { type: 'image/svg+xml' }), filename: `${base}.svg`, format: 'svg', warnings };
  }
  const blob = await rasterizeTo(svgStr, w, h, t.format, bg, t.quality ?? 0.92);
  return { blob, filename: `${base}.${t.format}`, format: t.format, warnings };
}

/** Rasterize an SVG string to an exact pixel size (px). Opaque formats (JPG/BMP/GIF)
 *  are painted onto a background first (default white); PNG/WebP/TIFF keep alpha unless
 *  a solid background was chosen. png/jpeg/webp use the native encoder, bmp/gif/tiff ours. */
function rasterizeTo(svgString: string, w: number, h: number, format: RasterFormat, background = 'transparent', quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml' }));
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w));
      canvas.height = Math.max(1, Math.round(h));
      const ctx = canvas.getContext('2d')!;
      const mime = MIME[format];
      const solid = background && background !== 'transparent' ? background : (isOpaqueFormat(mime) ? '#FFFFFF' : null);
      if (solid) { ctx.fillStyle = solid; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvasToRasterBlob(canvas, mime, format === 'jpg' ? quality : undefined).then(resolve, reject);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load SVG as image')); };
    img.src = url;
  });
}

/** Apply the SVG text-handling mode (outline → paths, or embed the font) to the
 *  drawing markup + defs. 'keep' is a no-op. Shared by the Export dialog and the
 *  one-click frame exports so both honor the same setting. */
async function applyTextMode(
  drawingSvg: string, defsBlock: string, mode: TextMode, embeddedFonts: EmbeddedFont[],
): Promise<{ drawingSvg: string; defsBlock: string; warnings: string[] }> {
  // Embedded (document) fonts have no viewer fallback, so their @font-face must
  // travel with the file in every mode — including 'outline', where any run the
  // outliner still can't handle stays live text and needs the face to render.
  const embedFaces = embeddedFontFaceStyle(embeddedFonts, drawingSvg);
  const withFaces = (defs: string) => (embedFaces ? embedFaces + '\n  ' : '') + defs;
  if (mode === 'outline') {
    const r = await outlineText(drawingSvg, embeddedFonts);
    return { drawingSvg: r.content, defsBlock: withFaces(defsBlock), warnings: r.warnings };
  }
  if (mode === 'embed') {
    const r = await buildEmbeddedFontStyle(drawingSvg);
    return { drawingSvg, defsBlock: withFaces((r.style ? r.style + '\n  ' : '') + defsBlock), warnings: r.warnings };
  }
  return { drawingSvg, defsBlock: withFaces(defsBlock), warnings: [] };
}

export type BuiltFile = { blob: Blob; filename: string; format: ExportFormat; warnings: string[] };

/** Write a set of already-built files: into the remembered folder, else a save/folder
 *  picker; de-duplicating filenames so nothing silently overwrites; then a success toast
 *  + any per-file warnings. Shared by single-frame and all-frames export. */
export async function writeExportedFiles(files: BuiltFile[]): Promise<boolean> {
  if (!files.length) return false;
  // Two targets (or two frames) can want the same filename — suffix duplicates so a
  // folder write doesn't clobber one with another.
  const seen = new Map<string, number>();
  for (const f of files) {
    const n = (seen.get(f.filename) ?? 0) + 1;
    seen.set(f.filename, n);
    if (n > 1) {
      const dot = f.filename.lastIndexOf('.');
      f.filename = dot > 0 ? `${f.filename.slice(0, dot)} (${n})${f.filename.slice(dot)}` : `${f.filename} (${n})`;
    }
  }

  // Once a destination folder is remembered, everything (even a single file) writes
  // straight into it — no prompt. A single file with NO remembered folder gets a
  // Save-As dialog; many files with none prompts for a folder (and remembers it).
  const remembered = await getRememberedExportDir();
  const res = remembered
    ? await writeAllToDir(remembered, files)
    : files.length === 1
      ? await saveOrDownload(files[0].filename, files[0].blob, files[0].format)
      : await saveManyFiles(files);
  if (res.ok) {
    const what = files.length === 1 ? files[0].filename : `${files.length} files`;
    const where = res.dest === 'downloads' ? ' to your Downloads' : res.dirName ? ` to ${res.dirName}` : '';
    showToast(`Exported ${what}${where}`, 8000, undefined, 'success');
  }
  const notes = [...new Set(files.flatMap(f => f.warnings))];
  if (notes.length) showToast(notes.join('\n'));
  return res.ok;
}

/** Export every target of a frame. One file → the save picker (name/location); many
 *  → a folder picker (write them all into it), falling back to sequential downloads.
 *  Each target applies its OWN per-format options (text handling, bake, background,
 *  quality); the drawing markup is memoized per (bake, textMode) across the batch. */
export async function exportFrameTargets(state: AppState, ab: Artboard, targets: ExportTarget[]): Promise<boolean> {
  if (!targets.length) return false;
  try {
    const cache = new Map<string, { drawingSvg: string; defsBlock: string; warnings: string[] }>();
    const files: BuiltFile[] = [];
    for (const t of targets) files.push(await buildTargetFile(state, ab, t, cache));
    return await writeExportedFiles(files);
  } catch (err) {
    alert('Export failed: ' + (err instanceof Error ? err.message : String(err)));
    return false;
  }
}

/** Export EVERY frame in one action, each producing its OWN configured export targets
 *  (format/name/size), all written together — the "export the whole document" button,
 *  so you don't click each frame's Export in turn. Markup is memoized across all frames. */
export async function exportAllFrames(state: AppState): Promise<boolean> {
  const frames = state.framesInPageOrder;
  if (!frames.length) { showToast('No frames to export.'); return false; }
  try {
    const cache = new Map<string, { drawingSvg: string; defsBlock: string; warnings: string[] }>();
    const files: BuiltFile[] = [];
    for (const ab of frames) {
      for (const t of state.getFrameExportTargets(ab.id)) files.push(await buildTargetFile(state, ab, t, cache));
    }
    return await writeExportedFiles(files);
  } catch (err) {
    alert('Export failed: ' + (err instanceof Error ? err.message : String(err)));
    return false;
  }
}

/** Open the folder picker and remember the choice as the export destination.
 *  Returns the new folder's name, or null if cancelled / unsupported. */
export async function changeExportFolder(): Promise<string | null> {
  const picker = (window as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<any> }).showDirectoryPicker;
  if (!picker) return null;
  try {
    const dir = await picker({ id: 'buzzquill-export', mode: 'readwrite' });
    await rememberExportDir(dir);
    return dir.name;
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') return null;
    throw err;
  }
}

/** Outcome of a save: whether it happened, and where (folder name, or Downloads). */
interface SaveResult { ok: boolean; dirName?: string; dest?: 'folder' | 'downloads'; }

/** Save a blob via the file picker (choose location) or a plain download. */
async function saveOrDownload(filename: string, blob: Blob, format: ExportFormat): Promise<SaveResult> {
  if (supportsFileSystemAccess()) {
    try {
      const handle = await saveFilePicker(filename, [FILE_TYPES[format]]);
      if (handle) { await writeHandle(handle, blob); return { ok: true, dest: 'folder' }; }
      return { ok: false }; // cancelled
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return { ok: false };
      // otherwise fall through to a plain download
    }
  }
  downloadBlob(blob, filename);
  return { ok: true, dest: 'downloads' };
}

/** Write every file into an already-resolved folder handle. */
async function writeAllToDir(dir: FileSystemDirectoryHandle, files: { blob: Blob; filename: string }[]): Promise<SaveResult> {
  for (const f of files) {
    const fh = await dir.getFileHandle(f.filename, { create: true });
    const writable = await fh.createWritable();
    await writable.write(f.blob);
    await writable.close();
  }
  return { ok: true, dirName: dir.name, dest: 'folder' };
}

/** Pick a folder (remembering it) and write the files, or download each. Called only
 *  when no folder is remembered yet — the picked one is remembered so the next export
 *  doesn't re-prompt. */
async function saveManyFiles(files: { blob: Blob; filename: string }[]): Promise<SaveResult> {
  const picker = (window as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<any> }).showDirectoryPicker;
  if (picker) {
    try {
      const dir = await picker({ id: 'buzzquill-export', mode: 'readwrite' }) as FileSystemDirectoryHandle;
      await rememberExportDir(dir);
      return await writeAllToDir(dir, files);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return { ok: false }; // cancelled the folder pick
      // otherwise fall through to downloads
    }
  }
  for (const f of files) {
    downloadBlob(f.blob, f.filename);
    await new Promise((r) => setTimeout(r, 250)); // stagger so the browser doesn't block them
  }
  return { ok: true, dest: 'downloads' };
}

/** The dialog's Bounds choice, kept for the next time it opens this session. */
let lastDialogBounds: ExportBounds = 'frame';

/**
 * Shows a modal dialog to export all artboards (or a selection) in SVG/PNG/JPG.
 */
export function showExportDialog(state: AppState): void {
  // Overlay, Escape/click-outside dismissal, focus handling and the \u2715 button
  // all come from the shared Modal primitive (ui/modal.ts).
  const modal = openModal({
    id: 'export-dialog-overlay',
    ariaLabel: 'Export Frames',
    dialogClass: 'export-dialog',
  });
  if (!modal) return; // already open
  const { dialog, close } = modal;

  dialog.appendChild(createModalHeader('Export Frames'));

  const body = createModalBody();

  // Format
  const formatSelect = createSelect([
    { value: 'svg', label: 'SVG (.svg)', selected: true },
    { value: 'png', label: 'PNG (.png)' },
    { value: 'jpg', label: 'JPG (.jpg)' },
    { value: 'bmp', label: 'BMP (.bmp)' },
    { value: 'gif', label: 'GIF (.gif)' },
    { value: 'tiff', label: 'TIFF (.tiff)' },
  ]);
  body.appendChild(createField('Format', formatSelect));

  // Size (raster only) — a scale multiplier, or an exact output width or
  // height in px (the missing side follows each frame's aspect ratio).
  const sizeMode = createSelect([
    { value: 'scale', label: 'Scale (×)', selected: true },
    { value: 'width', label: 'Width (px)' },
    { value: 'height', label: 'Height (px)' },
  ]);
  const sizeValue = document.createElement('input');
  sizeValue.type = 'number';
  sizeValue.min = '0.1';
  sizeValue.step = '0.5';
  sizeValue.value = '2';
  const sizeRow = document.createElement('div');
  sizeRow.className = 'export-size-row';
  sizeRow.append(sizeMode, sizeValue);
  const sizeField = createField('Size', sizeRow);
  body.appendChild(sizeField);
  // Switching mode seeds a sensible value: ×2, or the first frame's px size.
  sizeMode.addEventListener('change', () => {
    if (sizeMode.value === 'scale') {
      sizeValue.min = '0.1'; sizeValue.step = '0.5'; sizeValue.value = '2';
    } else {
      const ab = state.framesInPageOrder[0]; // the first PAGE, matching the list order below
      sizeValue.min = '1'; sizeValue.step = '1';
      sizeValue.value = String(Math.max(1, Math.round(ab ? (sizeMode.value === 'width' ? ab.width : ab.height) : 512)));
    }
  });
  // Size only applies to raster output — hide it for SVG (incl. the default).
  const syncSizeRow = () => {
    sizeField.style.display = formatSelect.value === 'svg' ? 'none' : '';
  };
  formatSelect.addEventListener('change', syncSizeRow);
  syncSizeRow();

  // Bounds: the frame, or hug the visible paths inside it.
  const boundsSelect = createSelect([
    { value: 'frame', label: 'Frame', selected: lastDialogBounds === 'frame' },
    { value: 'paths', label: 'Fit to paths', selected: lastDialogBounds === 'paths' },
  ]);
  boundsSelect.title = 'Fit to paths: the canvas edges touch the outermost visible path (hidden layers ignored). Coordinates are kept; only the viewBox changes.';
  body.appendChild(createField('Bounds', boundsSelect));

  // Bake transforms toggle
  const { row: bakeRow, input: bakeCb } = createCheckRow(
    'Bake transforms into geometry',
    state.bakeTransformsOnExport,
    { title: 'Bake supported transforms into coordinates. Shapes that retain transforms are reported after export.' },
  );
  body.appendChild(bakeRow);

  // Text handling (SVG only — raster formats bake text to pixels anyway). Seeded from
  // the persisted default; the chosen value is saved back as the new default on export.
  const textSelect = createSelect([
    { value: 'keep', label: 'Keep as live text', selected: state.textExportMode === 'keep' },
    { value: 'outline', label: 'Convert to outlines (paths)', selected: state.textExportMode === 'outline' },
    { value: 'embed', label: 'Embed font data', selected: state.textExportMode === 'embed' },
  ]);
  const textField = createField('Text', textSelect);
  body.appendChild(textField);
  const syncTextRow = () => { textField.style.display = formatSelect.value === 'svg' ? '' : 'none'; };
  formatSelect.addEventListener('change', syncTextRow);
  syncTextRow();

  // Artboard selection
  const abField = document.createElement('div');
  abField.className = 'field';
  const abLabel = document.createElement('label');
  abLabel.className = 'field-label';
  abLabel.textContent = 'Frames to export';
  abField.appendChild(abLabel);

  const actions = document.createElement('div');
  actions.className = 'field-actions';
  const selectAllBtn = createButton('Select All', { small: true });
  const selectNoneBtn = createButton('Select None', { small: true });
  actions.append(selectAllBtn, selectNoneBtn);
  abField.appendChild(actions);

  const checkboxes: HTMLInputElement[] = [];
  for (const ab of state.framesInPageOrder) {
    const { row, input } = createCheckRow(`${ab.name}  (${ab.width}\u00D7${ab.height})`, true, { value: ab.id });
    checkboxes.push(input);
    abField.appendChild(row);
  }

  selectAllBtn.addEventListener('click', () => checkboxes.forEach(cb => cb.checked = true));
  selectNoneBtn.addEventListener('click', () => checkboxes.forEach(cb => cb.checked = false));

  body.appendChild(abField);
  dialog.appendChild(body);

  // Footer
  const footer = createModalFooter();
  const cancelBtn = createButton('Cancel', { onClick: () => close() });
  const exportBtn = createButton('Export', { variant: 'primary' });
  exportBtn.addEventListener('click', async () => {
    const format = formatSelect.value as ExportFormat;
    const sizeVal = parseFloat(sizeValue.value);
    if (format !== 'svg' && (!isFinite(sizeVal) || sizeVal <= 0)) { alert('Enter a valid size.'); return; }
    const size: ExportSize = { mode: sizeMode.value as ExportSize['mode'], value: format === 'svg' ? 1 : sizeVal };
    const bake = bakeCb.checked;
    const bounds = boundsSelect.value as ExportBounds;
    lastDialogBounds = bounds;
    const textMode = textSelect.value as TextMode;
    state.setTextExportMode(textMode); // remember the choice for next time + one-click exports
    const selectedIds = checkboxes.filter(cb => cb.checked).map(cb => cb.value);
    if (selectedIds.length === 0) { alert('Select at least one frame.'); return; }

    exportBtn.textContent = 'Exporting...';
    exportBtn.style.opacity = '0.6';

    const selectedAbs = state.framesInPageOrder.filter(ab => selectedIds.includes(ab.id));
    try {
      await exportArtboards(state, selectedAbs, format, size, bake, textMode, bounds);
    } catch (err) {
      alert('Export failed: ' + (err instanceof Error ? err.message : err));
    }

    close();
  });

  footer.append(cancelBtn, exportBtn);
  dialog.appendChild(footer);
}


async function exportArtboards(
  state: AppState,
  artboards: Artboard[],
  format: ExportFormat,
  size: ExportSize,
  bake: boolean,
  textMode: TextMode = 'keep',
  bounds: ExportBounds = 'frame',
): Promise<void> {
  // Per-frame raster scale: width/height modes fix one output side, so each
  // frame gets its own multiplier; scale mode is uniform.
  const scaleFor = (ab: Artboard): number =>
    size.mode === 'width' ? size.value / (ab.width || 1)
    : size.mode === 'height' ? size.value / (ab.height || 1)
    : size.value;
  const drawing = layerContent(state, bake);
  let drawingSvg = drawing.content;
  // Exports carry only the defs the exported content actually references —
  // editor chrome (frame masks) and orphaned paste-copies stay out (#220).
  let defsBlock = pruneUnusedDefs(state.getDefsBlock(), drawingSvg);

  const warnings: string[] = [...drawing.warnings];
  if (format === 'svg') {
    // SVG honours the user's text mode.
    if (textMode !== 'keep') {
      const r = await applyTextMode(drawingSvg, defsBlock, textMode, state.embeddedFonts);
      drawingSvg = r.drawingSvg; defsBlock = r.defsBlock; warnings.push(...r.warnings);
    } else {
      // 'keep' skips text processing, but embedded document fonts still have no
      // viewer fallback — carry their @font-face so kept text renders correctly.
      const faces = embeddedFontFaceStyle(state.embeddedFonts, drawingSvg);
      if (faces) defsBlock = faces + '\n  ' + defsBlock;
    }
  } else {
    // Raster is drawn by loading the SVG as an <img> — an isolated context with no
    // access to the page's fonts — so embed every used font's @font-face (data-URL)
    // into the SVG, otherwise text rasterizes in a fallback face (not what's on canvas).
    const r = await applyTextMode(drawingSvg, defsBlock, 'embed', state.embeddedFonts);
    drawingSvg = r.drawingSvg; defsBlock = r.defsBlock; warnings.push(...r.warnings);
  }

  for (const frameAb of artboards) {
    const fileName = sanitizeFilename(frameAb.name);
    const fit = exportRect(state, frameAb, bounds);
    const ab = fit.rect;
    if (fit.note) warnings.push(fit.note);

    if (format === 'svg') {
      const svgStr = buildArtboardSVG(ab, drawingSvg, defsBlock, state.getExtraNamespaceDecls());
      downloadBlob(new Blob([svgStr], { type: 'image/svg+xml' }), `${fileName}.svg`);
    } else {
      const svgStr = buildArtboardSVG(ab, drawingSvg, defsBlock, state.getExtraNamespaceDecls());
      const blob = await rasterize(svgStr, ab.width, ab.height, scaleFor(ab), format);
      downloadBlob(blob, `${fileName}.${format}`);
    }

    // Small delay between downloads so browser doesn't block them
    if (artboards.length > 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  if (warnings.length) {
    alert('Export completed with notes:\n\n' + warnings.join('\n'));
  }
}

function buildArtboardSVG(ab: Artboard, drawingSvg: string, defsBlock: string, extraNs = '', background = '#FFFFFF'): string {
  // Backdrop rect at the artboard bounds — omitted for a transparent export.
  const bg = (background && background !== 'transparent')
    ? `<rect x="${ab.x}" y="${ab.y}" width="${ab.width}" height="${ab.height}" fill="${background}"/>\n  `
    : '';
  // Clip drawing content to the artboard bounds via a viewBox
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" ${SVG_NS_DECLS}${extraNs}
     viewBox="${ab.x} ${ab.y} ${ab.width} ${ab.height}"
     width="${ab.width}" height="${ab.height}">
  ${defsBlock}${bg}${drawingSvg}
</svg>`;
}

function rasterize(
  svgString: string,
  w: number,
  h: number,
  scale: number,
  format: ExportFormat,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);

    img.onload = () => {
      const canvas = document.createElement('canvas');
      // Width/height modes produce fractional scales — round to whole pixels.
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d')!;
      ctx.scale(scale, scale);

      const mime = MIME[format as RasterFormat];
      // Opaque formats (JPG/BMP/GIF) need a background painted first.
      if (isOpaqueFormat(mime)) { ctx.fillStyle = 'white'; ctx.fillRect(0, 0, w, h); }

      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);

      canvasToRasterBlob(canvas, mime, format === 'jpg' ? 0.92 : undefined).then(resolve, reject);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load SVG as image'));
    };

    img.src = url;
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
}
