// ---------------------------------------------------------------------------
// Drag-and-drop file import — two drop zones with two different meanings:
//
//   • the CANVAS   → append the file to the document you're looking at
//   • the TAB BAR  → open the file as its own new document (a new tab)
//
// The zone you're over IS the choice, so each one says out loud what dropping
// there will do before you let go. Dropping a document used to replace whatever
// you had open (after a discard prompt), which made a drop onto artwork you were
// working on a destructive act; now the destination decides, and neither gesture
// can lose work.
//
// Both zones accept the same set: SVG (imported as editable shapes), PDF (asks
// vectors-or-image), and rasters (embedded as <image>).
// ---------------------------------------------------------------------------

import type { AppState } from '../core/state';
import type { DocumentManager } from '../core/document-manager';
import type { CanvasController } from '../core/canvas';
import type { Point } from '../core/types';
import { importAnyFile } from './import-image';
import { openTextWithoutHandle } from './project-file';
import { readSvgFile } from '../core/file-access';
import { showToast } from './toast';

const ACCEPT_EXT = /\.(svg|svgmaker|pdf|png|jpe?g|gif|webp|bmp|avif)$/i;
const ACCEPT_MIME = /^(image\/(svg\+xml|png|jpeg|gif|webp|bmp|avif)|application\/pdf)$/i;
const FORMATS = 'SVG, PDF, PNG, JPG, GIF, WebP';

function isSupportedFile(f: File): boolean {
  return ACCEPT_MIME.test(f.type) || ACCEPT_EXT.test(f.name);
}

/** What the drag looks like, judged from the drag alone. */
type DragVerdict = 'yes' | 'maybe' | 'no';

/**
 * Can we accept what's being dragged, judged from the drag alone?
 *
 * During a drag the browser exposes each item's MIME type but NOT its name — that
 * only arrives on drop. So a typeless item (which is what a `.svgmaker` project,
 * and anything the OS has no mapping for, looks like) can only be a MAYBE: better
 * to invite the drop and report a clear error after, than to refuse a file we would
 * in fact have handled.
 *
 * The maybe is reported as its own verdict rather than folded in with `yes`,
 * because those two are not the same promise. `.blend` has no registered MIME on
 * Windows, so it used to raise the identical "Add to this document" overlay a valid
 * PNG does — and then failed on drop. Meanwhile `.py`, which the OS *does* know, was
 * refused honestly up front. Two equally unsupported files, opposite promises.
 */
function dragVerdict(dt: DataTransfer): DragVerdict {
  const files = [...dt.items].filter(i => i.kind === 'file');
  if (files.length === 0) return 'no';
  if (files.some(i => ACCEPT_MIME.test(i.type))) return 'yes';
  if (files.some(i => !i.type)) return 'maybe';  // unknown to the OS — can't tell yet
  return 'no';
}

function hasFiles(dt: DataTransfer | null): boolean {
  return !!dt && [...dt.types].includes('Files');
}

/** Number of dragged files, or 0 when the browser won't say. */
function fileCount(dt: DataTransfer): number {
  return [...dt.items].filter(i => i.kind === 'file').length;
}

const ICON_APPEND = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M12 8v6M9 11h6"/></svg>';
const ICON_NEWDOC = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const ICON_MAYBE = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 1 1 3.4 2.5c-.6.2-.9.8-.9 1.4v.4"/><path d="M12 16.8h.01"/></svg>';
const ICON_NO = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M6 18 18 6"/></svg>';

interface ZoneSpec {
  el: HTMLElement;
  cls: string;                       // marker class on the zone while a drag is over it
  icon: string;
  title: (n: number) => string;
  hint: string;
  /** World point for the drop, when the zone has a meaningful one. */
  pointAt?: (e: DragEvent) => Point | undefined;
  onDrop: (files: File[], at: Point | undefined) => Promise<void> | void;
}

/** Build (once) the overlay a zone shows while a file is dragged over it. */
function makeOverlay(spec: ZoneSpec): HTMLElement {
  const o = document.createElement('div');
  o.className = `filedrop-overlay ${spec.cls}`;
  o.innerHTML = `<div class="filedrop-card">
      <span class="filedrop-icon"></span>
      <span class="filedrop-title"></span>
      <span class="filedrop-hint"></span>
    </div>`;
  spec.el.appendChild(o);
  return o;
}

function wireZone(spec: ZoneSpec): void {
  const overlay = makeOverlay(spec);
  const iconEl = overlay.querySelector('.filedrop-icon') as HTMLElement;
  const titleEl = overlay.querySelector('.filedrop-title') as HTMLElement;
  const hintEl = overlay.querySelector('.filedrop-hint') as HTMLElement;
  // dragenter/dragleave fire for every child crossed, so a boolean flickers. Count
  // depth and only hide when the pointer has genuinely left the zone.
  let depth = 0;

  const hide = () => { depth = 0; overlay.classList.remove('is-on', 'is-reject'); };

  const show = (dt: DataTransfer) => {
    const verdict = dragVerdict(dt);
    const n = fileCount(dt);
    overlay.classList.toggle('is-reject', verdict === 'no');
    overlay.classList.toggle('is-maybe', verdict === 'maybe');
    if (verdict === 'yes') {
      iconEl.innerHTML = spec.icon;
      titleEl.textContent = spec.title(n);
      hintEl.textContent = spec.hint;
    } else if (verdict === 'maybe') {
      // Honest about the uncertainty: the drop is still accepted (that's how a
      // .svgmaker project gets in), but nothing is promised about the outcome.
      iconEl.innerHTML = ICON_MAYBE;
      titleEl.textContent = n > 1 ? 'Drop to check these files' : 'Drop to check this file';
      hintEl.textContent = `Supported: ${FORMATS}`;
    } else {
      iconEl.innerHTML = ICON_NO;
      titleEl.textContent = 'Can’t use this file';
      hintEl.textContent = `Supported: ${FORMATS}`;
    }
    overlay.classList.add('is-on');
  };

  spec.el.addEventListener('dragenter', (e) => {
    if (!hasFiles(e.dataTransfer)) return;   // a tab being reordered, not a file
    e.preventDefault();
    depth++;
    show(e.dataTransfer!);
  });

  spec.el.addEventListener('dragover', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    // Reflect accept/reject in the cursor as well as the overlay.
    // 'maybe' still accepts the drop — refusing it would lock out .svgmaker.
    e.dataTransfer!.dropEffect = dragVerdict(e.dataTransfer!) === 'no' ? 'none' : 'copy';
    if (depth === 0) { depth = 1; show(e.dataTransfer!); } // entered without a dragenter
  });

  spec.el.addEventListener('dragleave', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    if (--depth <= 0) hide();
  });

  spec.el.addEventListener('drop', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();               // don't let a second zone handle the same drop
    hide();
    const files = [...(e.dataTransfer?.files ?? [])];
    const usable = files.filter(isSupportedFile);
    if (usable.length === 0) {
      showToast(files.length
        ? `Can’t open ${files.length === 1 ? `“${files[0].name}”` : 'those files'}. Supported: ${FORMATS}.`
        : 'Nothing to open.');
      return;
    }
    if (usable.length < files.length) {
      showToast(`Skipped ${files.length - usable.length} unsupported file${files.length - usable.length > 1 ? 's' : ''}. Supported: ${FORMATS}.`);
    }
    void spec.onDrop(usable, spec.pointAt?.(e));
  });

  // A drag that ends anywhere (Esc, dropped elsewhere) must not strand the overlay.
  window.addEventListener('dragend', hide);
  window.addEventListener('drop', hide);
}

/**
 * Wire both drop zones. Call once at boot, after the tab bar exists.
 */
export function setupFileDrop(state: AppState, docs: DocumentManager, canvas: CanvasController): void {
  const canvasArea = document.getElementById('canvas-area');
  const tabBar = document.getElementById('tab-bar');

  if (canvasArea) {
    wireZone({
      el: canvasArea,
      cls: 'filedrop-canvas',
      icon: ICON_APPEND,
      title: (n) => (n > 1 ? `Add ${n} files to this document` : 'Add to this document'),
      hint: 'Drop on the tab bar instead to open it as a new document',
      // Land the artwork where it was dropped. addShape treats this as the origin
      // point, so it also decides which frame the drop lands in — same rule as
      // drawing a shape there.
      pointAt: (e) => canvas.screenToSVG(e.clientX, e.clientY),
      onDrop: async (files, at) => {
        // Sequentially: a PDF opens a modal asking how to import, and several at
        // once would stack dialogs on top of each other. Cascade so a multi-file
        // drop doesn't stack every item on the same pixel.
        let i = 0;
        for (const f of files) {
          const p = at ? { x: at.x + i * 20, y: at.y + i * 20 } : undefined;
          await importAnyFile(state, f, p);
          i++;
        }
      },
    });
  }

  if (tabBar) {
    wireZone({
      el: tabBar,
      cls: 'filedrop-tabbar',
      icon: ICON_NEWDOC,
      title: (n) => (n > 1 ? `Open ${n} files as new documents` : 'Open as a new document'),
      hint: 'Drop on the canvas instead to add it to the current document',
      // No meaningful canvas position for a tab-bar drop — each file centres in its
      // own new document.
      onDrop: async (files) => {
        for (const f of files) await openFileAsNewDocument(state, docs, f);
      },
    });
  }
}

/**
 * One dropped file → one new tab.
 *
 * A document format (SVG / .svgmaker) is LOADED as the new tab's content, so it
 * round-trips with its layers and editor state. Anything else (a PDF, a raster) has
 * no document of its own to become, so the tab starts blank and the file is imported
 * into it — which is what "open this image" means for a drawing app.
 */
async function openFileAsNewDocument(state: AppState, docs: DocumentManager, file: File): Promise<void> {
  const isDoc = /\.(svg|svgmaker)$/i.test(file.name) || file.type === 'image/svg+xml';
  docs.newTab();          // switches to the new tab, so `state` now holds it
  try {
    if (isDoc) {
      const text = await readSvgFile(file);
      await openTextWithoutHandle(state, text, file.name);
    } else {
      await importAnyFile(state, file);
    }
    // Name the TAB, not just the document: openTextWithoutHandle sets the project
    // name, but the tab keeps whatever newTab() minted ("Untitled 2") until told.
    docs.renameTab(docs.activeId, file.name);
  } catch (err) {
    showToast(`Couldn’t open “${file.name}”: ${err instanceof Error ? err.message : String(err)}`);
  }
}
