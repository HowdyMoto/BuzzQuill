// ---------------------------------------------------------------------------
// Frame panels — shown when a single Frame is selected: Export (the frame's
// export-target list), Grid (Figma's Layout Grid: add/remove a uniform grid,
// size, subdivisions, colour, visibility, snap) and Rulers (edge-ruler toggle).
// The state owns the model (per-frame data-* attributes); this is just the UI.
// ---------------------------------------------------------------------------

import type { AppState } from '../core/state';
import type { FrameGrid, ExportTarget, Artboard } from '../core/types';
import { defaultFrameGrid } from '../core/frame-chrome';
import { exportRect } from '../core/export-scope';
import { openSolidColorPicker } from './color-picker';
import { exportArtboardToFile, changeExportFolder } from './export-dialog';
import { playExportSequence } from './feedback';
import { rememberedExportDirName, hasRememberedExportDir, forgetExportDir } from '../core/export-store';
import { setToggle } from './components';
import { showContextMenu } from './panel-helpers';

import { mustId as $, bindLiveCommit } from './dom';

const DEFAULT_GRID: FrameGrid = defaultFrameGrid(0, 0);

/** Default grid for a newly-gridded frame: frame-size-aware divisions that keep
 *  cells roughly square with the centre axes on gridlines (see defaultFrameGrid). */
function defaultGridFor(state: AppState, fid: string): FrameGrid {
  const ab = state.getArtboardById(fid);
  return ab ? defaultFrameGrid(ab.width, ab.height) : { ...DEFAULT_GRID };
}

/** The single selected frame's id, or null. */
function selectedFrameId(state: AppState): string | null {
  if (state.selectedShapeIds.length !== 1) return null;
  const s = state.getSelectedShape();
  return s && s.type === 'frame' ? s.id : null;
}

export function setupFramePanel(state: AppState): void {
  const id = () => selectedFrameId(state);

  // Read the current field values into a FrameGrid. Mode, colour, visible and
  // snap are driven by their own controls, so each branch only reads its fields.
  const count = (fieldId: string, fallback: number) =>
    Math.max(1, Math.round(parseFloat($<HTMLInputElement>(fieldId).value) || fallback));
  const readGrid = (base: FrameGrid): FrameGrid => {
    if (base.mode === 'divisions') {
      return {
        ...base,
        cols: count('fp-grid-cols', base.cols),
        rows: count('fp-grid-rows', base.rows),
        subdivisions: count('fp-grid-subdiv-div', base.subdivisions),
      };
    }
    // px mode is edited as two spacings ("Major: every X px / Minor: every Y px")
    // but stored as minor size + a subdivision count, so the major spacing is
    // snapped to the nearest whole multiple of the minor spacing.
    const minor = Math.max(1, parseFloat($<HTMLInputElement>('fp-grid-minor').value) || base.size);
    const majorRaw = parseFloat($<HTMLInputElement>('fp-grid-major').value);
    const major = Number.isFinite(majorRaw) && majorRaw > 0 ? majorRaw : base.size * base.subdivisions;
    return { ...base, size: minor, subdivisions: Math.max(1, Math.round(major / minor)) };
  };

  const commitGrid = (mut: (g: FrameGrid) => FrameGrid, record: boolean) => {
    const fid = id(); if (!fid) return;
    const cur = state.getFrameGrid(fid) ?? DEFAULT_GRID;
    state.setFrameGrid(fid, mut(cur), record);
    updateFramePanel(state);
  };

  $<HTMLButtonElement>('fp-rulers').addEventListener('click', () => {
    const fid = id(); if (!fid) return;
    state.setFrameRulers(fid, !state.getFrameRulers(fid));
    updateFramePanel(state);
  });

  // Export targets — a per-frame list of files to produce (a logo → favicon,
  // apple-touch, …). The "+" opens a menu (blank target or a preset batch); the
  // Layers-panel quick-export uses the same list.
  const addTargets = (fid: string, add: ExportTarget[]) => {
    const targets = state.getFrameExportTargets(fid).concat(add.map(t => ({ ...t })));
    state.setFrameExportTargets(fid, targets, true);
    buildExportRows(state, fid);
  };
  $<HTMLButtonElement>('fp-export-add').addEventListener('click', (e) => {
    const fid = id(); if (!fid) return;
    const base = (state.getArtboardById(fid)?.name ?? 'frame').replace(/\s+/g, '-');
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showContextMenu(r.right, r.bottom + 4, [
      { label: 'Add target', action: () => addTargets(fid, [{ format: 'png', name: base, scale: 1 }]) },
      { separator: true, label: '', action: () => {} },
      { label: 'Favicon set', action: () => addTargets(fid, EXPORT_PRESETS.favicon) },
      { label: 'Apple touch icon', action: () => addTargets(fid, EXPORT_PRESETS['apple-touch']) },
      { label: 'PWA icons', action: () => addTargets(fid, EXPORT_PRESETS.pwa) },
    ]);
  });
  $<HTMLButtonElement>('fp-export-btn').addEventListener('click', (e) => {
    const fid = id(); if (!fid) return;
    const ab = state.getArtboardById(fid);
    if (!ab) return;
    const btn = e.currentTarget as HTMLButtonElement;
    const count = state.getFrameExportTargets(fid).length;
    void exportArtboardToFile(state, ab).then((ok) => {
      refreshExportDest();
      if (!ok) return;
      // Tick down each target row, then confirm on the button — making a multi-file
      // export read as a satisfying sequence (see feedback.ts, Aaron-Iker-style).
      const rows = Array.from(document.querySelectorAll<HTMLElement>('#fp-export-list .fp-target-wrap'));
      playExportSequence(rows, btn, count);
    });
  });
  // Show (and let the user change) the folder repeat exports write into.
  refreshExportDest();

  $<HTMLButtonElement>('fp-grid-add').addEventListener('click', () => {
    const fid = id(); if (!fid) return;
    commitGrid(() => defaultGridFor(state, fid), true);
  });
  $<HTMLButtonElement>('fp-grid-remove').addEventListener('click', () => {
    const fid = id(); if (!fid) return;
    state.setFrameGrid(fid, null, true);
    updateFramePanel(state);
  });
  $<HTMLButtonElement>('fp-grid-vis').addEventListener('click', () => commitGrid(g => ({ ...g, visible: !g.visible }), true));
  $<HTMLButtonElement>('fp-grid-snap').addEventListener('click', () => commitGrid(g => ({ ...g, snap: !g.snap }), true));

  // Pixels ↔ Divisions mode toggle (one undo step).
  for (const btn of Array.from($<HTMLDivElement>('fp-grid-mode').querySelectorAll<HTMLButtonElement>('button'))) {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode === 'divisions' ? 'divisions' : 'px';
      commitGrid(g => (g.mode === mode ? g : { ...g, mode }), true);
    });
  }

  // Spacing / cols / rows / subdivisions: live on input, one undo step on change.
  for (const f of ['fp-grid-major', 'fp-grid-minor', 'fp-grid-cols', 'fp-grid-rows', 'fp-grid-subdiv-div']) {
    bindLiveCommit($<HTMLInputElement>(f), () => commitGrid(g => readGrid(g), false), () => commitGrid(g => readGrid(g), true));
  }
  // Major/Minor normalise against each other (major → a multiple of minor), but a
  // focused field is never rewritten mid-edit — re-sync it when focus leaves.
  for (const f of ['fp-grid-major', 'fp-grid-minor']) {
    $<HTMLInputElement>(f).addEventListener('blur', () => updateFramePanel(state));
  }

  // Grid colour uses the app's custom picker (consistent with every colour control):
  // apply live while dragging, record one undo step when the picker closes.
  const gridColorBtn = $<HTMLElement>('fp-grid-color-btn');
  gridColorBtn.addEventListener('click', () => {
    const fid = id(); if (!fid) return;
    const cur = state.getFrameGrid(fid) ?? DEFAULT_GRID;
    const start = /^#[0-9a-fA-F]{6}$/.test(cur.color) ? cur.color : '#7f8fa6';
    openSolidColorPicker(
      state, gridColorBtn, start,
      (value) => { if (value) commitGrid(g => ({ ...g, color: value }), false); },
      'Grid', () => commitGrid(g => ({ ...g }), true),
    );
  });

  // Frame background colour (the .frame-bg fill). Live while dragging, one undo step
  // when the picker closes — same pattern as the grid colour. Picking "none" clears
  // it back to transparent.
  const bgSwatch = $<HTMLButtonElement>('fp-bg-swatch');
  bgSwatch.addEventListener('click', () => {
    const fid = id(); if (!fid) return;
    openSolidColorPicker(
      state, bgSwatch, state.getFrameBackground(fid) ?? '#FFFFFF',
      (value) => state.setFrameBackground(fid, value, false),
      'Background', () => state.setFrameBackground(fid, state.getFrameBackground(fid), true),
    );
  });

  updateFramePanel(state);
}

/** Show/hide the frame panels (Export / Grid / Rulers) for the current
 *  selection and sync their controls. */
export function updateFramePanel(state: AppState): void {
  const panels = ['panel-frame-bg', 'panel-frame', 'panel-frame-grid', 'panel-frame-rulers']
    .map((pid) => document.getElementById(pid))
    .filter((p): p is HTMLElement => p !== null);
  if (!panels.length) return;
  const fid = selectedFrameId(state);
  for (const p of panels) p.style.display = fid ? '' : 'none';
  if (!fid) return;

  // Frame background swatch: show the colour, or a checkerboard for transparent.
  const bg = state.getFrameBackground(fid);
  const inner = document.querySelector('#fp-bg-swatch .appearance-color-inner') as HTMLElement | null;
  if (inner) {
    inner.classList.toggle('is-transparent', !bg);
    inner.style.background = bg ?? '';
  }

  syncExportTargets(state, fid);

  setToggle($<HTMLButtonElement>('fp-rulers'), state.getFrameRulers(fid));

  const grid = state.getFrameGrid(fid);
  $<HTMLButtonElement>('fp-grid-add').style.display = grid ? 'none' : '';
  $<HTMLDivElement>('fp-grid-fields').style.display = grid ? '' : 'none';
  if (grid) {
    const divisions = grid.mode === 'divisions';
    for (const btn of Array.from($<HTMLDivElement>('fp-grid-mode').querySelectorAll<HTMLButtonElement>('button'))) {
      btn.classList.toggle('active', (btn.dataset.mode === 'divisions') === divisions);
    }
    $<HTMLDivElement>('fp-grid-px-rows').style.display = divisions ? 'none' : '';
    $<HTMLDivElement>('fp-grid-div-rows').style.display = divisions ? '' : 'none';
    // Never rewrite the field being edited: Major/Minor cross-derive (major is
    // normalised to a multiple of minor), so echoing mid-typing would yank the
    // caret. The focused field normalises on blur instead.
    const setVal = (fieldId: string, v: number) => {
      const el = $<HTMLInputElement>(fieldId);
      if (document.activeElement !== el) el.value = String(v);
    };
    setVal('fp-grid-major', grid.size * grid.subdivisions);
    setVal('fp-grid-minor', grid.size);
    setVal('fp-grid-cols', grid.cols);
    setVal('fp-grid-rows', grid.rows);
    setVal('fp-grid-subdiv-div', grid.subdivisions);
    $<HTMLElement>('fp-grid-color-preview').style.background = /^#[0-9a-fA-F]{6}$/.test(grid.color) ? grid.color : '#7f8fa6';
    setToggle($<HTMLButtonElement>('fp-grid-vis'), grid.visible);
    setToggle($<HTMLButtonElement>('fp-grid-snap'), grid.snap);
  }
}

// ---- Export targets ---------------------------------------------------------

/** One-click batches for common platform assets (the whole point of the list). */
const EXPORT_PRESETS: Record<string, ExportTarget[]> = {
  favicon: [
    { format: 'png', name: 'favicon-16x16', scale: 1, width: 16, height: 16 },
    { format: 'png', name: 'favicon-32x32', scale: 1, width: 32, height: 32 },
    { format: 'png', name: 'favicon-48x48', scale: 1, width: 48, height: 48 },
    { format: 'svg', name: 'favicon', scale: 1 },
  ],
  'apple-touch': [
    { format: 'png', name: 'apple-touch-icon', scale: 1, width: 180, height: 180 },
  ],
  pwa: [
    { format: 'png', name: 'icon-192', scale: 1, width: 192, height: 192 },
    { format: 'png', name: 'icon-512', scale: 1, width: 512, height: 512 },
  ],
};

/** Rebuild the target rows only when it's safe — never while a field inside the
 *  list is focused (that would yank the input mid-edit). Undo/redo and selection
 *  changes rebuild normally because nothing in the list is focused then. */
function syncExportTargets(state: AppState, fid: string): void {
  const list = document.getElementById('fp-export-list');
  if (list && list.contains(document.activeElement)) return;
  buildExportRows(state, fid);
}

const FORMATS: ExportTarget['format'][] = ['svg', 'png', 'jpg', 'bmp', 'gif', 'tiff'];

/** Canonical text for a target's size field: "2×" (scale) or "512" / "512×512". */
function formatSize(t: ExportTarget): string {
  if (t.width && t.height) return `${t.width}×${t.height}`;
  if (t.width) return `${t.width}`;
  if (t.height) return `×${t.height}`;
  return `${t.scale}×`;
}

/** Parse a size string into a partial target. Accepts "2x"/"2×" (scale), "512"
 *  (width, height from aspect), "512x512", "512x", "x512". null = unparseable. */
function parseSize(str: string): { scale: number; width?: number; height?: number } | null {
  const s = str.trim().toLowerCase().replace(/×/g, 'x').replace(/\s+/g, '').replace(/px$/, '');
  if (!s) return { scale: 1 };
  const clampScale = (n: number) => Math.min(8, Math.max(0.1, n));
  const px = (n: string) => Math.min(8192, Math.max(1, Math.round(parseFloat(n))));
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d*\.?\d+)x$/))) return { scale: clampScale(parseFloat(m[1])) };
  if ((m = s.match(/^(\d+)x(\d+)$/))) return { scale: 1, width: px(m[1]), height: px(m[2]) };
  if ((m = s.match(/^(\d+)x$/))) return { scale: 1, width: px(m[1]) };
  if ((m = s.match(/^x(\d+)$/))) return { scale: 1, height: px(m[1]) };
  if ((m = s.match(/^\d+$/))) return { scale: 1, width: px(s) };
  return null;
}

/** Resolved output px for a target — shown as a tooltip so the field stays terse. */
function resolvedPx(t: ExportTarget, ab: { width: number; height: number } | undefined): string {
  if (!ab) return '';
  const aspect = ab.width / ab.height || 1;
  let w: number, h: number;
  if (t.width || t.height) {
    w = t.width ?? Math.round((t.height as number) * aspect);
    h = t.height ?? Math.round((t.width as number) / aspect);
  } else {
    w = Math.round(ab.width * t.scale); h = Math.round(ab.height * t.scale);
  }
  return `${w}×${h} px`;
}

// Which target rows are expanded, by index — kept across rebuilds so committing a
// value (which re-derives the list) doesn't snap the open card shut. Scoped to one
// frame; reset when a different frame's rows are built.
let expandedTargets = new Set<number>();
let expandedFrame: string | null = null;

// Chrome blocks whole-folder access to the special-folder ROOTS (Documents, Desktop,
// Downloads, drive roots, system dirs) — showDirectoryPicker rejects them with
// "contains system files". A SUB-folder of Documents is fine, and single-file Save As
// reaches Documents directly; the tooltip points users there.
const SET_FOLDER_HINT =
  'Remember a folder to write exports into. Tip: Documents/Desktop themselves are ' +
  'blocked by the browser — pick a sub-folder (e.g. Documents\\Exports). A single ' +
  'file can also Save As straight into Documents when no folder is set.';

const FOLDER_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M1.5 4.5V12a1.5 1.5 0 0 0 1.5 1.5h10A1.5 1.5 0 0 0 14.5 12V6.5A1.5 1.5 0 0 0 13 5H7.7L6.4 3.5H3A1.5 1.5 0 0 0 1.5 5v-.5Z" fill="currentColor"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

/** Render the export-destination line under the Export button. When a folder is
 *  remembered: [📁] a clickable folder-name chip (click = choose a different folder)
 *  + a trash button to clear it. When none is: a "Set folder…" chip. The row is
 *  NEVER a dead-end (clearing used to hide it). Only the folder's own NAME is
 *  available from the browser (not its absolute path); it's shown in full, truncated
 *  with an ellipsis + a title tooltip when it doesn't fit. Content is rebuilt on each
 *  state change and animates in (see .fp-export-dest in style.css). Hidden only when
 *  the browser can't do folder writes at all (Firefox/Safari). */
function refreshExportDest(): void {
  const el = document.getElementById('fp-export-dest');
  if (!el) return;
  if (!('showDirectoryPicker' in window)) { el.hidden = true; return; }

  const pickFolder = () => { void changeExportFolder().then((n) => { if (n !== null) refreshExportDest(); }); };

  // A clickable folder chip: click to CHOOSE / CHANGE the destination folder. The
  // hover state (see CSS) signals it's interactive and discoverable.
  const pathChip = (text: string, title: string, extraClass = ''): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fp-export-dest-path' + (extraClass ? ` ${extraClass}` : '');
    b.title = title;
    const nm = document.createElement('span');
    nm.className = 'fp-export-dest-name';
    nm.textContent = text;
    b.appendChild(nm);
    b.addEventListener('click', pickFolder);
    return b;
  };

  // Presence, not name: a drive root has an EMPTY name but IS a remembered folder —
  // keying visibility off the name hid the row (and its controls) exactly when the
  // user was stuck on the root and needed them most.
  void hasRememberedExportDir().then(async (has) => {
    el.replaceChildren();
    el.hidden = false;

    if (!has) {
      // No folder set: exports Save As (single file, reaches Documents) or ask for a
      // folder (many). The "Set folder…" chip keeps the feature discoverable.
      const note = document.createElement('span');
      note.className = 'fp-export-dest-label';
      note.textContent = 'Exports ask where to save';
      el.append(note, pathChip('Set folder…', SET_FOLDER_HINT, 'fp-export-dest-set'));
      return;
    }

    const name = (await rememberedExportDirName()) || '';
    // Never show a blank destination: a drive root (empty name) is labelled explicitly.
    const displayName = name || 'your drive root';

    const label = document.createElement('span');
    label.className = 'fp-export-dest-label';
    const icon = document.createElement('span');
    icon.className = 'fp-export-dest-icon';
    icon.innerHTML = FOLDER_SVG;
    label.append('Saves to ', icon,
      pathChip(displayName, `${displayName} — click to choose a different folder`));

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'fp-export-dest-clear';
    clear.title = 'Forget this folder — the next export will ask where to save';
    clear.setAttribute('aria-label', 'Clear export folder');
    clear.innerHTML = TRASH_SVG;
    clear.addEventListener('click', () => { void forgetExportDir().then(() => refreshExportDest()); });

    el.append(label, clear);
  });
}

/** Build (or rebuild) the export-target rows for a frame from its stored list. */
function buildExportRows(state: AppState, fid: string): void {
  const list = document.getElementById('fp-export-list');
  if (!list) return;
  if (fid !== expandedFrame) { expandedFrame = fid; expandedTargets = new Set(); }
  const ab = state.getArtboardById(fid);
  const targets = state.getFrameExportTargets(fid);
  list.replaceChildren();

  const commit = (record: boolean) => state.setFrameExportTargets(fid, targets, record);

  targets.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'fp-target';

    // Filename — the primary field; reads as plain text until hover/focus.
    const name = document.createElement('input');
    name.className = 'fp-target-name';
    name.type = 'text';
    name.value = t.name;
    name.placeholder = 'filename';
    name.spellcheck = false;
    name.title = `${t.name}.${t.format}`;
    name.addEventListener('input', () => { t.name = name.value; name.title = `${name.value}.${t.format}`; commit(false); });
    name.addEventListener('change', () => { t.name = name.value.trim() || (ab?.name ?? 'export'); commit(true); });

    // Per-format options — a card revealed by the caret; content adapts to the
    // format. Built lazily by renderOpts (declared below, once name+size exist).
    const opts = document.createElement('div');
    opts.className = 'fp-target-opts';
    opts.hidden = !expandedTargets.has(i);

    // Format — a readable leading type-chip that opens a small menu.
    const fmt = document.createElement('button');
    fmt.className = 'fp-target-fmt';
    fmt.textContent = t.format.toUpperCase();
    fmt.title = 'Format';
    fmt.addEventListener('click', (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      showContextMenu(r.left, r.bottom + 4, FORMATS.map((f) => ({
        label: f.toUpperCase(),
        action: () => {
          t.format = f; fmt.textContent = f.toUpperCase(); name.title = `${t.name}.${f}`; commit(true);
          if (!opts.hidden) renderOpts(); // options are format-specific
        },
      })));
    });

    // Size — one smart field: "2×", "512", or "512×512".
    const size = document.createElement('input');
    size.className = 'fp-target-size';
    size.type = 'text';
    size.value = formatSize(t);
    size.placeholder = '1×';
    size.title = `Size — type 2×, 512, or 512×512  ·  → ${resolvedPx(t, ab)}`;
    const applySize = (record: boolean) => {
      const parsed = parseSize(size.value);
      if (!parsed) return;
      t.scale = parsed.scale; t.width = parsed.width; t.height = parsed.height;
      size.title = `Size — type 2×, 512, or 512×512  ·  → ${resolvedPx(t, ab)}`;
      commit(record);
    };
    size.addEventListener('input', () => applySize(false));
    size.addEventListener('change', () => { applySize(true); size.value = formatSize(t); }); // normalise on blur
    size.addEventListener('keydown', (e) => { if (e.key === 'Enter') size.blur(); });

    // The expanded card restates name + size as labelled rows; keep the two surfaces
    // in sync so an edit in either place is reflected in the other.
    const syncCollapsed = () => {
      name.value = t.name; name.title = `${t.name}.${t.format}`;
      size.value = formatSize(t); size.title = `Size — type 2×, 512, or 512×512  ·  → ${resolvedPx(t, ab)}`;
    };
    const renderOpts = () => buildTargetOptions(state, t, opts, { ab, commit, syncCollapsed });

    // Options disclosure caret.
    const gear = document.createElement('button');
    gear.className = 'fp-target-gear';
    gear.title = 'Options';
    gear.setAttribute('aria-label', 'Export options');
    gear.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    gear.classList.toggle('open', !opts.hidden);
    if (!opts.hidden) renderOpts(); // rebuilt while open — repopulate the card
    gear.addEventListener('click', () => {
      opts.hidden = !opts.hidden;
      if (opts.hidden) expandedTargets.delete(i); else expandedTargets.add(i);
      gear.classList.toggle('open', !opts.hidden);
      wrap.classList.toggle('open', !opts.hidden);
      if (!opts.hidden) renderOpts();
    });

    // Remove — appears on row hover.
    const rm = document.createElement('button');
    rm.className = 'fp-target-x';
    rm.title = 'Remove target';
    rm.setAttribute('aria-label', 'Remove target');
    rm.innerHTML = '&#x2715;';
    rm.addEventListener('click', () => {
      targets.splice(i, 1);
      // shift the expanded-index set past the removed row
      const shifted = new Set<number>();
      expandedTargets.forEach((idx) => { if (idx < i) shifted.add(idx); else if (idx > i) shifted.add(idx - 1); });
      expandedTargets = shifted;
      commit(true); buildExportRows(state, fid);
    });

    // Caret leads (left), delete trails (right) — kept far apart so the destructive
    // action can't be mis-hit for the expander (mirrors the panel-header pattern).
    row.append(gear, fmt, name, size, rm);
    const wrap = document.createElement('div');
    wrap.className = 'fp-target-wrap';
    wrap.classList.toggle('open', !opts.hidden); // rebuilt while open → unified card
    wrap.append(row, opts);
    list.appendChild(wrap);
  });

  const btn = document.getElementById('fp-export-btn');
  if (btn) btn.textContent = targets.length === 1 ? 'Export 1 file' : `Export ${targets.length} files`;
}

/** Context the expanded options card needs to reach back into the row + model. */
interface TargetOptCtx {
  ab: Artboard | undefined;
  commit: (record: boolean) => void;
  syncCollapsed: () => void;
}

/** Render a target's expanded settings card into `container` (cleared first). The
 *  card restates the identity fields as clearly-labelled rows — File name, then Size
 *  (Scale, or an explicit Width × Height with the two axes on their own rows) — and
 *  an Output caption showing the exact pixels produced, followed by the format's own
 *  options (SVG text handling + bake + background; PNG background; JPG matte +
 *  quality). Each value falls back to the document default, shown as the active
 *  state, is written onto the target when changed, and mirrors back to the compact
 *  collapsed row via ctx.syncCollapsed. */
function buildTargetOptions(state: AppState, t: ExportTarget, container: HTMLElement, ctx: TargetOptCtx): void {
  container.replaceChildren();
  const commit = (record = true) => ctx.commit(record);
  const rerender = () => buildTargetOptions(state, t, container, ctx);

  const optRow = (label: string, ...controls: HTMLElement[]): HTMLElement => {
    const r = document.createElement('div'); r.className = 'fp-row fp-opt-row';
    const l = document.createElement('span'); l.className = 'appearance-label'; l.textContent = label;
    r.append(l, ...controls); return r;
  };
  const makeSwitch = (on: boolean, onChange: (v: boolean) => void): HTMLButtonElement => {
    const b = document.createElement('button'); b.className = 'ai-switch'; b.setAttribute('role', 'switch');
    setToggle(b, on);
    b.addEventListener('click', () => { const nv = b.getAttribute('aria-checked') !== 'true'; setToggle(b, nv); onChange(nv); });
    return b;
  };
  const segmented = (options: [string, string][], current: string, onPick: (v: string) => void): HTMLElement => {
    const g = document.createElement('div'); g.className = 'btn-group fp-opt-seg';
    for (const [val, lbl] of options) {
      const b = document.createElement('button'); b.textContent = lbl; b.dataset.v = val;
      if (val === current) b.classList.add('active');
      b.addEventListener('click', () => { for (const c of Array.from(g.children)) c.classList.remove('active'); b.classList.add('active'); onPick(val); });
      g.appendChild(b);
    }
    return g;
  };
  const swatch = (color: string, onPick: (v: string) => void): HTMLButtonElement => {
    const btn = document.createElement('button'); btn.className = 'appearance-color-btn';
    const inner = document.createElement('div'); inner.className = 'appearance-color-inner';
    inner.style.background = color === 'transparent' ? 'transparent' : color;
    btn.appendChild(inner);
    btn.addEventListener('click', () => openSolidColorPicker(state, btn, color === 'transparent' ? '#FFFFFF' : color, (v) => {
      const c = v ?? 'transparent'; // picker "none" → transparent
      inner.style.background = c === 'transparent' ? 'transparent' : c; onPick(c);
    }, 'Background'));
    return btn;
  };

  // A control that needs the full row width sits below a small caption instead of
  // beside a label — three segmented buttons don't fit next to a label in this panel.
  const optStack = (label: string, control: HTMLElement, hint?: string): HTMLElement => {
    const r = document.createElement('div'); r.className = 'fp-opt-stack';
    const l = document.createElement('span'); l.className = 'appearance-label'; l.textContent = label;
    if (hint) l.title = hint;
    r.append(l, control); return r;
  };
  // A right-aligned number field with a unit suffix (px, ×) for the Size rows.
  const numField = (
    value: number | undefined, unit: string, placeholder: string,
    onInput: (v: string) => void, onCommit: (v: string, inp: HTMLInputElement) => void,
    bounds?: { min?: number; max?: number; step?: string },
  ): HTMLElement => {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'appearance-weight fp-opt-num';
    if (bounds?.min != null) inp.min = String(bounds.min);
    if (bounds?.max != null) inp.max = String(bounds.max);
    if (bounds?.step) inp.step = bounds.step;
    if (value != null) inp.value = String(value);
    inp.placeholder = placeholder;
    inp.addEventListener('input', () => onInput(inp.value));
    inp.addEventListener('change', () => onCommit(inp.value, inp));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    const u = document.createElement('span'); u.className = 'appearance-unit'; u.textContent = unit;
    const holder = document.createElement('span'); holder.className = 'fp-opt-qty'; holder.append(inp, u);
    return holder;
  };

  // ---- Identity: File name (with a live extension suffix) ----
  {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'fp-opt-name'; inp.spellcheck = false;
    inp.value = t.name; inp.placeholder = 'filename';
    inp.addEventListener('input', () => { t.name = inp.value; ctx.commit(false); ctx.syncCollapsed(); });
    inp.addEventListener('change', () => { t.name = inp.value.trim() || (ctx.ab?.name ?? 'export'); inp.value = t.name; ctx.commit(true); ctx.syncCollapsed(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    const ext = document.createElement('span'); ext.className = 'appearance-unit fp-opt-ext'; ext.textContent = '.' + t.format;
    const holder = document.createElement('span'); holder.className = 'fp-opt-name-holder'; holder.append(inp, ext);
    container.appendChild(optRow('File name', holder));
  }

  // ---- Size: Scale (a multiplier) or explicit Dimensions (Width × Height) ----
  const dimsMode = !!(t.width || t.height);
  const sizeSeg = segmented(
    [['scale', 'Scale'], ['dims', 'Dimensions']], dimsMode ? 'dims' : 'scale',
    (v) => {
      if (v === 'dims') {
        if (!t.width && !t.height) t.width = ctx.ab ? Math.round(ctx.ab.width * (t.scale || 1)) : undefined;
      } else {
        t.width = undefined; t.height = undefined;
        if (!t.scale || t.scale <= 0) t.scale = 1;
      }
      commit(); ctx.syncCollapsed(); rerender();
    },
  );
  sizeSeg.classList.add('fp-opt-seg-full');
  container.appendChild(optStack('Size', sizeSeg));

  if (!dimsMode) {
    container.appendChild(optRow('Scale', numField(
      t.scale ?? 1, '×', '1',
      (v) => { const n = parseFloat(v); if (Number.isFinite(n) && n > 0) { t.scale = Math.min(8, Math.max(0.1, n)); ctx.commit(false); ctx.syncCollapsed(); } },
      (v, inp) => { let n = parseFloat(v); if (!Number.isFinite(n) || n <= 0) n = 1; t.scale = Math.min(8, Math.max(0.1, n)); inp.value = String(t.scale); commit(); ctx.syncCollapsed(); },
      { min: 0.1, max: 8, step: '0.5' },
    )));
  } else {
    const aspect = ctx.ab ? (ctx.ab.width / ctx.ab.height || 1) : 1;
    const clampPx = (n: number) => Math.min(8192, Math.max(1, Math.round(n)));
    // A blank axis is auto-derived from the set one via the frame's aspect; show that
    // derived value as the placeholder so "Auto" is never a mystery.
    const autoW = t.width ?? (t.height ? Math.round(t.height * aspect) : (ctx.ab ? ctx.ab.width : 0));
    const autoH = t.height ?? (t.width ? Math.round(t.width / aspect) : (ctx.ab ? ctx.ab.height : 0));
    container.appendChild(optRow('Width', numField(
      t.width, 'px', String(autoW),
      (v) => { const n = parseInt(v, 10); if (Number.isFinite(n) && n > 0) { t.width = clampPx(n); ctx.commit(false); ctx.syncCollapsed(); } },
      (v, inp) => {
        const n = parseInt(v, 10);
        t.width = (Number.isFinite(n) && n > 0) ? clampPx(n) : undefined;
        if (!t.width && !t.height) t.width = ctx.ab ? clampPx(ctx.ab.width) : 1; // keep Dimensions mode meaningful
        inp.value = t.width ? String(t.width) : '';
        commit(); ctx.syncCollapsed(); rerender(); // refresh Height's auto placeholder
      },
    )));
    container.appendChild(optRow('Height', numField(
      t.height, 'px', String(autoH),
      (v) => { const n = parseInt(v, 10); if (Number.isFinite(n) && n > 0) { t.height = clampPx(n); ctx.commit(false); ctx.syncCollapsed(); } },
      (v, inp) => {
        const n = parseInt(v, 10);
        t.height = (Number.isFinite(n) && n > 0) ? clampPx(n) : undefined;
        if (!t.width && !t.height) t.height = ctx.ab ? clampPx(ctx.ab.height) : 1;
        inp.value = t.height ? String(t.height) : '';
        commit(); ctx.syncCollapsed(); rerender();
      },
    )));
  }
  // ---- Bounds: the frame, or hug the visible paths inside it ----
  const boundsSeg = segmented(
    [['frame', 'Frame'], ['paths', 'Fit to paths']], t.bounds ?? 'frame',
    (v) => { t.bounds = v === 'paths' ? 'paths' : undefined; commit(); ctx.syncCollapsed(); rerender(); },
  );
  boundsSeg.classList.add('fp-opt-seg-full');
  container.appendChild(optStack('Bounds', boundsSeg,
    'Fit to paths: the canvas edges touch the outermost visible path (hidden layers ignored). Coordinates are kept; only the viewBox changes.'));

  if (ctx.ab) {
    // Fit to paths measures the artwork as it is now; the caption says so.
    const fit = exportRect(state, ctx.ab, t.bounds);
    const cap = document.createElement('div'); cap.className = 'fp-opt-caption';
    cap.textContent = `Output ${resolvedPx(t, fit.rect)}${t.bounds === 'paths' && !fit.note ? ' (paths as they are now)' : ''}`;
    container.appendChild(cap);
  }

  // Divider before the format-specific options.
  const divider = document.createElement('div'); divider.className = 'fp-opt-divider';
  container.appendChild(divider);

  if (t.format === 'svg') {
    const seg = segmented(
      [['keep', 'Keep'], ['outline', 'Outlines'], ['embed', 'Embed']],
      t.textMode ?? state.textExportMode,
      (v) => { t.textMode = v as ExportTarget['textMode']; commit(); },
    );
    seg.classList.add('fp-opt-seg-full');
    container.appendChild(optStack('Text', seg, 'Keep: live <text> (needs the font installed). Outlines: convert to vector paths. Embed: inline the font in the file.'));
    container.appendChild(optRow('Bake transforms', makeSwitch(
      t.bake ?? state.bakeTransformsOnExport, (on) => { t.bake = on; commit(); },
    )));
  }

  // Opaque formats (JPG/BMP/GIF) have no alpha — a matte colour instead of a
  // transparency toggle. JPG additionally exposes encode quality.
  const opaque = t.format === 'jpg' || t.format === 'bmp' || t.format === 'gif';
  if (opaque) {
    container.appendChild(optRow('Background', swatch(
      (t.background && t.background !== 'transparent') ? t.background : '#FFFFFF',
      (v) => { t.background = v; commit(); },
    )));
    if (t.format === 'jpg') {
      const q = document.createElement('input');
      q.type = 'number'; q.min = '1'; q.max = '100'; q.className = 'appearance-weight fp-opt-num';
      q.value = String(Math.round((t.quality ?? 0.92) * 100));
      q.addEventListener('change', () => { const v = Math.max(1, Math.min(100, parseInt(q.value, 10) || 92)); q.value = String(v); t.quality = v / 100; commit(); });
      const unit = document.createElement('span'); unit.className = 'appearance-unit'; unit.textContent = '%';
      const qHolder = document.createElement('span'); qHolder.className = 'fp-opt-qty'; qHolder.append(q, unit);
      container.appendChild(optRow('Quality', qHolder));
    }
  } else {
    // SVG / PNG / TIFF can be transparent (default) or a solid colour.
    const transparent = (t.background ?? 'transparent') === 'transparent';
    const holder = document.createElement('span'); holder.className = 'fp-opt-bg';
    const subl = document.createElement('span'); subl.className = 'fp-opt-sub'; subl.textContent = 'Transparent';
    const sw = makeSwitch(transparent, (on) => {
      t.background = on ? 'transparent' : '#FFFFFF'; commit();
      rerender(); // re-render to add/remove the swatch
    });
    holder.append(subl, sw);
    if (!transparent) holder.appendChild(swatch(t.background ?? '#FFFFFF', (v) => { t.background = v; commit(); }));
    container.appendChild(optRow('Background', holder));
  }
}
