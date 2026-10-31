// ---------------------------------------------------------------------------
// Command registry — the single source of truth for every document/app action.
//
// Menus, keyboard shortcuts, the status bar and panel buttons all dispatch
// through this table instead of re-implementing the same operations. Adding a
// command here automatically gives it a menu hint (rendered from `accel`),
// keyboard binding, and enable/disable state — so the three surfaces can no
// longer drift apart the way hand-wired handlers do.
// ---------------------------------------------------------------------------

import { runImageTrace, canTraceSelection } from './ui/trace-image';
import type { AppState } from './core/state';
import type { CanvasController } from './core/canvas';
import type { ToolName } from './core/types';
import { showExportDialog, exportAllFrames } from './ui/export-dialog';
import { showTrackLayoutDialog } from './ui/track-layout-dialog';
import { showAboutDialog } from './ui/about-dialog';
import { showLegalDialog, ISSUES_URL } from './ui/legal';
import { isDriveConfigured } from './lib/google-config';
import { saveToDrive, saveToDriveAs, connectDrive, disconnectDrive, isDriveConnected, canDisconnectDrive } from './ui/drive';
import { getDocSource } from './core/doc-source';
import { pickAndImportAny, pickAndImportAsFrame } from './ui/import-image';
import { showOffsetDialog } from './ui/offset-dialog';
import { showRoundCornersDialog } from './ui/round-corners-dialog';
import { toggleSplitView, isSplitActive } from './ui/split-view';
import { hintsEnabled, setHintsEnabled } from './ui/hint-prefs';
import {
  saveProject,
  saveProjectAs,
} from './ui/project-file';
import { openAddToLibraryDialog } from './ui/library-panel';
import { distributeObjects } from './ui/align';
import { showToast } from './ui/toast';
import { revealNewAsset } from './ui/library-panel';
import { defaultFrameGrid } from './core/frame-chrome';
import { selectionIsBooleanable } from './core/pathfinder';
import { reverseSelectionWithFlourish } from './ui/direction-overlay';

/** Everything a command needs to run. Built once by main.ts and reused. */
export interface CommandContext {
  state: AppState;
  canvas: CanvasController;
  setTool: (tool: ToolName) => void;
  getArtboardsBounds: () => { x: number; y: number; w: number; h: number };
  /** Open the command palette. Wired up by main.ts after the palette exists. */
  openCommandPalette: () => void;
  /** Pick a document and open it in a (new) tab, leaving the current tab intact. */
  openDocument: () => void;
  /** Pick a Google Drive file and open it in a (new) tab. Only registered when
   *  Drive is configured; a user gesture, since it may open a sign-in popup. */
  openFromDrive: () => void;
  /** Start a new blank document in a NEW tab, leaving open tabs untouched. */
  newDocument: () => void;
  /** Close the active tab (through the same lose-work guard as the × button). */
  closeActiveTab: () => void;
  /** Move to the next (+1) or previous (-1) tab, wrapping at the ends. */
  cycleTab: (dir: 1 | -1) => void;
  /** How many tabs are open — gates the tab commands. */
  tabCount: () => number;
}

export type CommandKind = 'action' | 'toggle' | 'tool';

export interface Command {
  id: string;
  label: string;
  kind: CommandKind;
  /** Accelerator(s) in canonical form, e.g. 'Mod+Shift+S'. First is shown in menus. */
  accel?: string | string[];
  /** When present and false, the command is greyed out and refuses to run. */
  enabled?: (c: CommandContext) => boolean;
  /** For toggles: whether the toggle is currently on (drives the menu checkmark). */
  checked?: (c: CommandContext) => boolean;
  run: (c: CommandContext) => void;
}

// ---- Shared enable predicates ----------------------------------------------

const hasSelection = (c: CommandContext): boolean => c.state.selectedShapeIds.length > 0;
// Flip needs at least one non-frame shape (frames are axis-aligned, never flipped).
const hasFlippable = (c: CommandContext): boolean => c.state.getSelectedShapes().some((s) => s.type !== 'frame');
const primary = (c: CommandContext) => c.state.getSelectedShape();
// Outline Text needs at least one plain text object selected (area/path/multi-line
// text is handled — skipped with a note — inside outlineSelectedText).
const hasTextSelected = (c: CommandContext): boolean => c.state.getSelectedShapes().some((s) => s.type === 'text');
const hasOutlineableStroke = (c: CommandContext): boolean =>
  c.state.selectedShapeIds.some((id) => {
    const el = c.state.findShapeById(id)?.element;
    const stroke = el?.getAttribute('stroke');
    return !!stroke && stroke !== 'none' && parseFloat(el?.getAttribute('stroke-width') ?? '0') > 0;
  });
// Boolean ops need a type-compatible 2+ selection. The docked panel already greys
// out on this predicate; the MENU commands used a bare `length >= 2` and so stayed
// enabled for an un-combinable selection, then no-oped silently (#186).
const canBooleanCombine = (c: CommandContext): boolean => selectionIsBooleanable(c.state.getSelectedShapes());
// Toast a boolean/offset op that resolved false (nothing was produced) so the click
// isn't a silent no-op. Runs after the enabled-guard, so it mainly catches engine
// edge cases (e.g. fully-overlapping cut → empty result).
const toastIfNothing = (p: Promise<boolean>, msg: string): void => {
  void p.then((ok) => { if (!ok) showToast(msg); });
};

// ---- The commands ----------------------------------------------------------

// Google Drive commands exist only in a build with Drive configured (public
// Client ID + API key, see lib/google-config.ts). Spreading the SAME constant into
// COMMANDS and MENU_BAR hides them from menus, shortcuts and the palette at once.
const DRIVE_COMMANDS: Command[] = isDriveConfigured ? [
  { id: 'drive.open', label: 'Open from Google Drive…', kind: 'action', run: (c) => c.openFromDrive() },
  { id: 'drive.save-as', label: 'Save to Google Drive…', kind: 'action', run: (c) => { void saveToDriveAs(c.state); } },
  { id: 'drive.connect', label: 'Connect Google Drive…', kind: 'action', enabled: () => !isDriveConnected(), run: () => { void connectDrive(); } },
  { id: 'drive.disconnect', label: 'Disconnect Google Drive', kind: 'action', enabled: () => canDisconnectDrive(), run: () => { void disconnectDrive(); } },
] : [];
const DRIVE_FILE_ITEMS = isDriveConfigured ? ['drive.open', 'drive.save-as', '---'] : [];
const DRIVE_RECENT_ITEMS = isDriveConfigured ? ['drive-recent'] : [];
const DRIVE_HELP_ITEMS = isDriveConfigured ? ['drive.connect', 'drive.disconnect', '---'] : [];

export const COMMANDS: Command[] = [
  // ---- App ----
  { id: 'app.command-palette', label: 'Command Palette…', kind: 'action', accel: 'Mod+K', run: (c) => c.openCommandPalette() },
  { id: 'app.about', label: 'About BuzzQuill…', kind: 'action', run: () => showAboutDialog() },
  { id: 'app.privacy', label: 'Privacy Policy', kind: 'action', run: () => showLegalDialog('privacy') },
  { id: 'app.terms', label: 'Terms of Service', kind: 'action', run: () => showLegalDialog('terms') },
  // Bug reports and questions go to the public issue tracker — the app runs no
  // server, so there is nowhere else for a message to land.
  { id: 'app.feedback', label: 'Feedback & Support…', kind: 'action', run: () => { window.open(ISSUES_URL, '_blank', 'noopener'); } },

  // ---- File ----
  // New opens a blank document in a NEW tab (tabbed interface), so the file
  // you're editing stays open — no discard prompt, nothing replaced.
  // Mod+N is RESERVED by the browser (it opens a new window) — the keydown never
  // reaches us, so advertising it in the menu was a promise the app can't keep.
  // Mod+Alt+N does reach us (#197).
  { id: 'file.new', label: 'New', kind: 'action', accel: 'Mod+Alt+N', run: (c) => c.newDocument() },
  { id: 'file.open', label: 'Open…', kind: 'action', accel: 'Mod+O', run: (c) => c.openDocument() },
  // ⌘S writes wherever the document lives (core/doc-source.ts): Drive for a Drive
  // document, otherwise the local file (or Save As when it has none).
  { id: 'file.save', label: 'Save', kind: 'action', accel: 'Mod+S', run: (c) => { if (getDocSource()?.kind === 'drive') void saveToDrive(c.state); else void saveProject(c.state); } },
  { id: 'file.save-as', label: 'Save As…', kind: 'action', accel: 'Mod+Shift+S', run: (c) => saveProjectAs(c.state) },
  // Tab management: closing was mouse-only, and there was no way to move between
  // documents from the keyboard at all (#197). Close routes through the tab bar's
  // own guard so it can't diverge from the × button.
  //
  // Accelerators deliberately avoid the obvious Mod+W / Ctrl+Tab: the browser
  // reserves both (they close/switch BROWSER tabs and never reach the page), which
  // is the same trap that made file.new's advertised Mod+N a lie. Mod+Alt+…
  // combinations do reach us.
  ...DRIVE_COMMANDS,
  { id: 'file.close-tab', label: 'Close Tab', kind: 'action', accel: 'Mod+Alt+W', enabled: (c) => c.tabCount() > 1, run: (c) => c.closeActiveTab() },
  { id: 'file.next-tab', label: 'Next Document', kind: 'action', accel: 'Mod+Alt+ArrowRight', enabled: (c) => c.tabCount() > 1, run: (c) => c.cycleTab(1) },
  { id: 'file.prev-tab', label: 'Previous Document', kind: 'action', accel: 'Mod+Alt+ArrowLeft', enabled: (c) => c.tabCount() > 1, run: (c) => c.cycleTab(-1) },

  { id: 'file.import', label: 'Append…', kind: 'action', run: (c) => pickAndImportAny(c.state) },
  { id: 'file.import-as-frame', label: 'Append as New Frame…', kind: 'action', run: (c) => pickAndImportAsFrame(c.state) },
  { id: 'file.export-artboards', label: 'Export Frames…', kind: 'action', accel: 'Mod+Alt+E', run: (c) => showExportDialog(c.state) },
  {
    // One-click: export EVERY frame using its OWN per-frame export settings (the
    // format/name/size each frame's Export panel is configured with), all at once —
    // vs the dialog above, which applies a single chosen format to the selection.
    id: 'file.export-all-frames', label: 'Export All Frames', kind: 'action', accel: 'Mod+Shift+E',
    enabled: (c) => c.state.artboards.length > 0,
    run: (c) => void exportAllFrames(c.state),
  },
  {
    // One file per race-track layout, in exactly the shape TraceCraft reads (one
    // closed circuit + an optional open pit lane, baked into the frame's own
    // coordinates) — from the selection, or every layout in the document.
    id: 'file.export-track-layouts', label: 'Export Track Layouts (TraceCraft)…', kind: 'action',
    enabled: (c) => c.state.shapes.length > 0,
    run: (c) => showTrackLayoutDialog(c.state),
  },
  {
    id: 'export.bake-transforms', label: 'Bake Transforms on Export', kind: 'toggle',
    checked: (c) => c.state.bakeTransformsOnExport,
    run: (c) => {
      c.state.bakeTransformsOnExport = !c.state.bakeTransformsOnExport;
      try { localStorage.setItem('svgmaker.bakeTransforms', String(c.state.bakeTransformsOnExport)); } catch { /* ignore */ }
    },
  },

  // ---- Edit ----
  // Not during a crop session: it isn't in history yet, so Undo reached PAST it —
  // undoing the previous document action behind the live crop and dropping the
  // crop's own edits. Escape is how a session is backed out of.
  { id: 'edit.undo', label: 'Undo', kind: 'action', accel: 'Mod+Z', enabled: (c) => c.state.canUndo && c.state.currentTool !== 'crop', run: (c) => { c.state.undo(); } },
  { id: 'edit.redo', label: 'Redo', kind: 'action', accel: ['Mod+Shift+Z', 'Mod+Y'], enabled: (c) => c.state.canRedo && c.state.currentTool !== 'crop', run: (c) => { c.state.redo(); } },
  { id: 'edit.cut', label: 'Cut', kind: 'action', accel: 'Mod+X', enabled: hasSelection, run: (c) => c.state.cutSelected() },
  { id: 'edit.copy', label: 'Copy', kind: 'action', accel: 'Mod+C', enabled: hasSelection, run: (c) => c.state.copySelected() },
  {
    id: 'edit.paste', label: 'Paste', kind: 'action', accel: 'Mod+V',
    // Cmd+V is handled by the native `paste` event (ui/paste.ts) so clipboard
    // images work without a permission prompt; this runs for the MENU click,
    // which produces no paste event. Internal clipboard first (keeps the in-app
    // paste offset), else external images/vector via pasteExternal.
    run: (c) => { if (!c.state.pasteClipboard()) c.state.pasteExternal?.(); },
  },
  {
    id: 'edit.paste-in-place', label: 'Paste in Place', kind: 'action', accel: 'Mod+Shift+V',
    // The copy lands exactly where its source was, in the same frame/group. Like
    // Paste, the key goes through the native `paste` event (main.ts arms ui/paste.ts
    // first); this runs for the menu. Foreign content has no source position, so it
    // pastes as an ordinary paste would.
    run: (c) => { if (!c.state.pasteClipboard(true)) c.state.pasteExternal?.(); },
  },
  { id: 'edit.duplicate', label: 'Duplicate', kind: 'action', accel: 'Mod+D', enabled: hasSelection, run: (c) => c.state.duplicateSelected() },
  {
    id: 'edit.delete', label: 'Delete', kind: 'action', accel: ['Delete', 'Backspace'],
    enabled: (c) => {
      const s = c.state;
      if (s.activePanel === 'artboards') return !!s.activeFrameId && s.artboards.length > 1;
      if (s.activePanel === 'symbols') return !!s.selectedSymbolId;
      return hasSelection(c);
    },
    run: (c) => {
      const s = c.state;
      if (s.activePanel === 'artboards') { if (s.activeFrameId) s.removeArtboard(s.activeFrameId); return; }
      if (s.activePanel === 'symbols') { if (s.selectedSymbolId) s.removeSymbol(s.selectedSymbolId); return; }
      s.removeSelected();
    },
  },
  { id: 'edit.select-all', label: 'Select All', kind: 'action', accel: 'Mod+A', enabled: (c) => c.state.shapes.length > 0, run: (c) => c.state.selectMultiple(c.state.shapes.map(s => s.id)) },
  { id: 'edit.deselect', label: 'Deselect', kind: 'action', accel: 'Mod+Shift+A', enabled: hasSelection, run: (c) => c.state.selectShape(null) },

  // ---- Object ----
  { id: 'object.group', label: 'Group', kind: 'action', accel: 'Mod+G', enabled: (c) => c.state.selectedShapeIds.length >= 2, run: (c) => c.state.groupSelectedShapes() },
  { id: 'object.ungroup', label: 'Ungroup', kind: 'action', accel: 'Mod+Shift+G', enabled: (c) => primary(c)?.type === 'group', run: (c) => { const p = primary(c); if (p) c.state.ungroupShape(p.id); } },
  { id: 'object.flip-horizontal', label: 'Flip Horizontal', kind: 'action', enabled: hasFlippable, run: (c) => c.state.flipSelected('horizontal') },
  { id: 'object.flip-vertical', label: 'Flip Vertical', kind: 'action', enabled: hasFlippable, run: (c) => c.state.flipSelected('vertical') },
  // The LINKED variant: the tile mirrors the selected object, so editing it updates
  // every shape filled with the pattern. Single selection only — a link needs one
  // stable source. Falls back to a copy if the source is ever deleted.
  { id: 'object.pattern-make-linked', label: 'Make Linked Pattern from Selection', kind: 'action',
    enabled: (c) => c.state.selectedShapeIds.length === 1
      && c.state.findShapeById(c.state.selectedShapeIds[0])?.type !== 'frame',
    run: (c) => {
      const pat = c.state.createPatternFromShapes([...c.state.selectedShapeIds], { link: true });
      if (!pat) { showToast('Could not make a pattern from that selection.'); return; }
      const el = document.getElementById(pat.id);
      const n = c.state.listLibraryAssets('pattern').length + 1;
      const asset = c.state.createLibraryAsset('pattern', `Pattern ${n}`, {
        kind: 'pattern', value: `url(#${pat.id})`, defMarkup: el?.outerHTML, defId: pat.id,
      });
      revealNewAsset('pattern', asset.id);
    } },

  // Linked files: keep the artwork, drop the live reference. A link's source was a
  // document in the retired cloud backend, so Embed is the only live-link action
  // left; the artwork itself is stored in the file and still renders.
  { id: 'object.link-embed', label: 'Embed Linked File', kind: 'action',
    enabled: (c) => primary(c)?.type === 'linked',
    run: (c) => { const p = primary(c); if (p && c.state.embedLinkedFile(p.id)) showToast('Embedded a copy — the artwork stays, the link is gone.', 8000, undefined, 'success'); } },
  // Turn the selected artwork into a tiling pattern and put it in the Library, so it
  // is immediately nameable, foldered, and usable across files. Copy model: the
  // artwork is snapshotted, and the originals stay ordinary objects.
  { id: 'object.pattern-make', label: 'Make Pattern from Selection', kind: 'action',
    enabled: (c) => c.state.selectedShapeIds.length >= 1
      && c.state.selectedShapeIds.every((id) => c.state.findShapeById(id)?.type !== 'frame'),
    run: (c) => {
      const pat = c.state.createPatternFromShapes([...c.state.selectedShapeIds]);
      if (!pat) { showToast('Could not make a pattern from that selection.'); return; }
      const el = document.getElementById(pat.id);
      const n = c.state.listLibraryAssets('pattern').length + 1;
      const asset = c.state.createLibraryAsset('pattern', `Pattern ${n}`, {
        kind: 'pattern', value: `url(#${pat.id})`, defMarkup: el?.outerHTML, defId: pat.id,
      });
      revealNewAsset('pattern', asset.id);
    } },
  // Multi-selection becomes ONE repeated cell (the wrapper works like a group).
  { id: 'object.repeat-make', label: 'Make Repeat Grid', kind: 'action', enabled: (c) => c.state.selectedShapeIds.length >= 1 && c.state.selectedShapeIds.every((id) => { const s = c.state.findShapeById(id); return !!s && s.type !== 'frame' && s.type !== 'repeat'; }), run: (c) => { c.state.makeRepeatGrid([...c.state.selectedShapeIds]); } },
  { id: 'object.repeat-bake', label: 'Bake Repeat Grid', kind: 'action', enabled: (c) => primary(c)?.type === 'repeat', run: (c) => { const p = primary(c); if (p) c.state.bakeRepeat(p.id); } },
  { id: 'object.repeat-release', label: 'Release Repeat Grid', kind: 'action', enabled: (c) => primary(c)?.type === 'repeat', run: (c) => { const p = primary(c); if (p) c.state.releaseRepeat(p.id); } },
  { id: 'object.clip-make', label: 'Mask with Top Shape', kind: 'action', accel: 'Mod+7', enabled: (c) => c.state.selectedShapeIds.length >= 2, run: (c) => { c.state.makeClippingMask(); } },
  { id: 'object.clip-release', label: 'Release Mask', kind: 'action', accel: 'Mod+Alt+7', enabled: (c) => !!primary(c)?.element.hasAttribute('data-clip-group'), run: (c) => { const p = primary(c); if (p) c.state.releaseClippingMask(p.id); } },
  { id: 'object.clip-edit', label: 'Edit Mask Shape', kind: 'action', enabled: (c) => !!primary(c)?.element.hasAttribute('data-clip-group'), run: (c) => { const p = primary(c); if (p) c.state.enterMaskEdit(p.id); } },
  { id: 'object.bring-to-front', label: 'Bring to Front', kind: 'action', accel: 'Mod+Shift+]', enabled: hasSelection, run: (c) => c.state.bringToFront() },
  { id: 'object.bring-forward', label: 'Bring Forward', kind: 'action', accel: 'Mod+]', enabled: hasSelection, run: (c) => { const p = primary(c); if (p) c.state.moveShapeUp(p.id); } },
  { id: 'object.send-backward', label: 'Send Backward', kind: 'action', accel: 'Mod+[', enabled: hasSelection, run: (c) => { const p = primary(c); if (p) c.state.moveShapeDown(p.id); } },
  { id: 'object.send-to-back', label: 'Send to Back', kind: 'action', accel: 'Mod+Shift+[', enabled: hasSelection, run: (c) => c.state.sendToBack() },
  { id: 'object.toggle-lock', label: 'Lock', kind: 'action', accel: 'Mod+2', enabled: hasSelection, run: (c) => { const p = primary(c); if (p) c.state.toggleLock(p.id); } },
  { id: 'object.unlock-all', label: 'Unlock All', kind: 'action', accel: 'Mod+Alt+2', run: (c) => c.state.unlockAll() },
  { id: 'object.toggle-visibility', label: 'Hide', kind: 'action', accel: 'Mod+3', enabled: hasSelection, run: (c) => { const p = primary(c); if (p) c.state.toggleVisibility(p.id); } },
  { id: 'object.show-all', label: 'Show All', kind: 'action', accel: 'Mod+Alt+3', run: (c) => c.state.showAll() },
  { id: 'object.create-symbol', label: 'Create Symbol', kind: 'action', enabled: hasSelection, run: (c) => { const p = primary(c); if (p) c.state.createSymbolFromShape(p.id); } },
  { id: 'object.detach-symbol', label: 'Detach Instance', kind: 'action', enabled: (c) => primary(c)?.type === 'use', run: (c) => { const p = primary(c); if (p && !c.state.detachSymbolInstance(p.id)) showToast('Could not detach this instance — its component is missing.'); } },
  { id: 'library.add-from-selection', label: 'Add to Library…', kind: 'action', enabled: hasSelection, run: (c) => { void openAddToLibraryDialog(c.state); } },

  // ---- Arrange (align & distribute) ----
  { id: 'arrange.distribute-h', label: 'Distribute Horizontally', kind: 'action', enabled: (c) => c.state.selectedShapeIds.length >= 3, run: (c) => distributeObjects(c.state, 'h') },
  { id: 'arrange.distribute-v', label: 'Distribute Vertically', kind: 'action', enabled: (c) => c.state.selectedShapeIds.length >= 3, run: (c) => distributeObjects(c.state, 'v') },
  { id: 'arrange.distribute-diag-nwse', label: 'Distribute Diagonally (NW→SE)', kind: 'action', enabled: (c) => c.state.selectedShapeIds.length >= 3, run: (c) => distributeObjects(c.state, 'diag-nwse') },
  { id: 'arrange.distribute-diag-nesw', label: 'Distribute Diagonally (NE→SW)', kind: 'action', enabled: (c) => c.state.selectedShapeIds.length >= 3, run: (c) => distributeObjects(c.state, 'diag-nesw') },

  // ---- Path (Pathfinder / boolean) ----
  { id: 'path.unite', label: 'Unite', kind: 'action', accel: 'Mod+Alt+U', enabled: canBooleanCombine, run: (c) => toastIfNothing(c.state.booleanSelection('unite'), 'Nothing to unite — select 2 or more combinable shapes.') },
  { id: 'path.subtract', label: 'Subtract', kind: 'action', accel: 'Mod+Alt+S', enabled: canBooleanCombine, run: (c) => toastIfNothing(c.state.booleanSelection('subtract'), 'Nothing to subtract — select 2 or more combinable shapes.') },
  { id: 'path.intersect', label: 'Intersect', kind: 'action', accel: 'Mod+Alt+I', enabled: canBooleanCombine, run: (c) => toastIfNothing(c.state.booleanSelection('intersect'), 'The selection doesn’t overlap — nothing to intersect.') },
  { id: 'path.exclude', label: 'Exclude', kind: 'action', accel: 'Mod+Alt+X', enabled: canBooleanCombine, run: (c) => toastIfNothing(c.state.booleanSelection('exclude'), 'Nothing to exclude — select 2 or more combinable shapes.') },
  { id: 'path.divide', label: 'Divide', kind: 'action', enabled: canBooleanCombine, run: (c) => toastIfNothing(c.state.booleanSelection('divide'), 'Nothing to divide — select 2 or more overlapping shapes.') },
  { id: 'path.flatten', label: 'Flatten', kind: 'action', accel: 'Mod+E',
    enabled: (c) => { const p = primary(c); return p?.type === 'boolean' || (!!p && c.state.canFlattenMask(p.element)); },
    run: (c) => { const p = primary(c); if (!p) return; if (p.type === 'boolean') c.state.flattenBoolean(p.id); else void c.state.flattenMask(p.id); } },
  { id: 'path.trace-image', label: 'Trace Image…', kind: 'action', enabled: (c) => canTraceSelection(c.state), run: (c) => { void runImageTrace(c.state); } },
  { id: 'path.outline-stroke', label: 'Outline Stroke', kind: 'action', enabled: (c) => hasOutlineableStroke(c), run: (c) => toastIfNothing(c.state.outlineSelectedStroke(), 'Nothing to outline — select a shape with a visible stroke.') },
  { id: 'path.outline-text', label: 'Outline Text', kind: 'action', accel: 'Mod+Shift+O', enabled: hasTextSelected, run: (c) => { void c.state.outlineSelectedText().then((notes) => { if (notes.length) showToast(notes.join('\n')); }); } },
  { id: 'path.offset', label: 'Offset Path…', kind: 'action', enabled: hasSelection, run: (c) => showOffsetDialog(c.state) },
  // Corner work on whole paths: rounding takes a radius (dialog, live preview),
  // smoothing has nothing to tune. Both rewrite EVERY corner in one undo step —
  // the point of them, since node-by-node the path moves under you as you go.
  {
    id: 'path.join', label: 'Join', kind: 'action', accel: 'Mod+J', enabled: (c) => c.state.canJoinPaths(),
    // Ends within ~2 screen pixels merge into one point; further apart, a straight segment joins them.
    run: (c) => { if (!c.state.joinPaths(2 / c.canvas.getZoom())) showToast('Nothing to join — select one or two open paths, or two end points.'); },
  },
  // Which way a path runs is invisible but is all another app has to go on, so this
  // plays the new direction along the path rather than appearing to do nothing.
  { id: 'path.reverse', label: 'Reverse Path Direction', kind: 'action', accel: 'Mod+Alt+R', enabled: (c) => c.state.canReversePaths(), run: (c) => reverseSelectionWithFlourish(c.state) },
  { id: 'path.round-corners', label: 'Round Corners…', kind: 'action', enabled: (c) => c.state.canRoundCorners(), run: (c) => showRoundCornersDialog(c.state) },
  { id: 'path.smooth', label: 'Smooth', kind: 'action', enabled: (c) => c.state.canRoundCorners(),
    run: (c) => { if (!c.state.smoothSelectedPaths()) showToast('Nothing to smooth — the selected paths have no corner points.'); } },
  { id: 'path.type-on-path', label: 'Type on a Path', kind: 'action', enabled: (c) => c.state.canTypeOnPath(), run: (c) => { c.state.typeTextOnPath(); } },

  // ---- View ----
  { id: 'view.zoom-in', label: 'Zoom In', kind: 'action', accel: ['Mod+=', 'Mod+Shift+='], run: (c) => c.canvas.setZoom(c.canvas.getZoom() * 1.25) },
  { id: 'view.zoom-out', label: 'Zoom Out', kind: 'action', accel: 'Mod+-', run: (c) => c.canvas.setZoom(c.canvas.getZoom() / 1.25) },
  { id: 'view.zoom-fit', label: 'Fit Artboard', kind: 'action', accel: 'Mod+0', run: (c) => c.canvas.fitToWindow(c.getArtboardsBounds()) },
  // 'F' is the 3D-viewport frame-selected convention; 'Shift+2' is Figma's.
  { id: 'view.zoom-selection', label: 'Focus Selection', kind: 'action', accel: ['F', 'Shift+2'], enabled: hasSelection, run: (c) => { const b = c.state.selectionWorldBounds(); if (b) c.canvas.fitToWindow(b); } },
  { id: 'view.zoom-100', label: 'Actual Size', kind: 'action', accel: 'Mod+1', run: (c) => c.canvas.setZoom(1) },
  {
    id: 'view.toggle-transparency', label: 'Show Transparency', kind: 'toggle',
    checked: (c) => c.state.showTransparency,
    run: (c) => { c.state.showTransparency = !c.state.showTransparency; c.state.onChange_public(); },
  },
  {
    // Grid / rulers now belong to the ACTIVE FRAME (see the Frame panel). These
    // View items are quick toggles for that frame; disabled with no frame.
    id: 'view.toggle-grid', label: 'Show Grid', kind: 'toggle', accel: "Mod+'",
    enabled: (c) => !!c.state.activeFrameId,
    checked: (c) => { const id = c.state.activeFrameId; return !!id && !!c.state.getFrameGrid(id)?.visible; },
    run: (c) => {
      const id = c.state.activeFrameId; if (!id) return;
      const g = c.state.getFrameGrid(id);
      if (g) c.state.setFrameGrid(id, { ...g, visible: !g.visible });
      else { const ab = c.state.getArtboardById(id); c.state.setFrameGrid(id, { ...defaultFrameGrid(ab?.width ?? 0, ab?.height ?? 0), snap: false }); }
    },
  },
  {
    id: 'view.toggle-grid-snap', label: 'Snap to Grid', kind: 'toggle',
    enabled: (c) => { const id = c.state.activeFrameId; return !!id && !!c.state.getFrameGrid(id); },
    checked: (c) => { const id = c.state.activeFrameId; return !!id && !!c.state.getFrameGrid(id)?.snap; },
    run: (c) => {
      const id = c.state.activeFrameId; if (!id) return;
      const g = c.state.getFrameGrid(id); if (!g) return;
      c.state.setFrameGrid(id, { ...g, snap: !g.snap });
    },
  },
  {
    id: 'view.toggle-snap', label: 'Smart Guides', kind: 'toggle',
    checked: (c) => c.state.snapEnabled,
    run: (c) => { c.state.snapEnabled = !c.state.snapEnabled; },
  },
  {
    id: 'view.toggle-rulers', label: 'Show Frame Rulers', kind: 'toggle',
    enabled: (c) => !!c.state.activeFrameId,
    checked: (c) => { const id = c.state.activeFrameId; return !!id && c.state.getFrameRulers(id); },
    run: (c) => { const id = c.state.activeFrameId; if (id) c.state.setFrameRulers(id, !c.state.getFrameRulers(id)); },
  },
  {
    // See two documents side by side. Enters/leaves split view (a document/layout
    // toggle, so it lives in View next to the other view toggles). Mod+\ mirrors the
    // "split editor" shortcut people know from VS Code.
    id: 'view.toggle-split', label: 'Split View', kind: 'toggle', accel: 'Mod+\\',
    checked: () => isSplitActive(),
    run: () => toggleSplitView(),
  },
  {
    // The strip at the top of the canvas listing what the active tool can do right
    // now (ui/tool-hint.ts). Off for people who know the app; remembered.
    id: 'view.toggle-hints', label: 'Show Tool Hints', kind: 'toggle',
    checked: () => hintsEnabled(),
    run: () => setHintsEnabled(!hintsEnabled()),
  },

  // ---- Color defaults (affect the style applied to NEW shapes) ----
  {
    id: 'color.default-colors', label: 'Default Fill/Stroke', kind: 'action', accel: 'D',
    run: (c) => {
      // Restore the whole fixed new-shape style (fill, stroke, 1px width, dashes, …) —
      // the deliberate reset for the "fixed defaults" model.
      c.state.resetDefaultStyle();
      c.state.onChange_public();
    },
  },
  {
    id: 'color.swap-fill-stroke', label: 'Swap Fill/Stroke', kind: 'action', accel: 'Shift+X',
    run: (c) => {
      const s = c.state;
      [s.defaultStyle.fill, s.defaultStyle.stroke] = [s.defaultStyle.stroke, s.defaultStyle.fill];
      [s.fillNone, s.strokeNone] = [s.strokeNone, s.fillNone];
      s.onChange_public();
    },
  },

  // ---- Tools ----
  { id: 'tool.select', label: 'Selection Tool', kind: 'tool', accel: 'V', run: (c) => c.setTool('select') },
  { id: 'tool.direct-select', label: 'Direct Selection Tool', kind: 'tool', accel: 'A', run: (c) => c.setTool('directSelect') },
  { id: 'tool.shape-builder', label: 'Shape Builder Tool', kind: 'tool', accel: 'Shift+M', run: (c) => c.setTool('shapeBuilder') },
  { id: 'tool.rect', label: 'Rectangle Tool', kind: 'tool', accel: 'M', run: (c) => c.setTool('rect') },
  { id: 'tool.ellipse', label: 'Ellipse Tool', kind: 'tool', accel: 'L', run: (c) => c.setTool('ellipse') },
  { id: 'tool.polygon', label: 'Polygon Tool', kind: 'tool', run: (c) => c.setTool('polygon') },
  { id: 'tool.star', label: 'Star Tool', kind: 'tool', run: (c) => c.setTool('star') },
  { id: 'tool.line', label: 'Line Tool', kind: 'tool', accel: '\\', run: (c) => c.setTool('line') },
  { id: 'tool.arrow', label: 'Arrow Tool', kind: 'tool', run: (c) => c.setTool('arrow') },
  { id: 'tool.polyline', label: 'Polyline Tool', kind: 'tool', run: (c) => c.setTool('pen') },
  { id: 'tool.pen', label: 'Pen Tool', kind: 'tool', accel: 'P', run: (c) => c.setTool('pen') },
  { id: 'tool.text', label: 'Type Tool', kind: 'tool', accel: 'T', run: (c) => c.setTool('text') },
  { id: 'tool.eyedropper', label: 'Eyedropper Tool', kind: 'tool', accel: 'I', run: (c) => c.setTool('eyedropper') },
  { id: 'tool.direction', label: 'Direction Tool', kind: 'tool', accel: 'R', run: (c) => c.setTool('direction') },
  { id: 'tool.frame', label: 'Frame Tool', kind: 'tool', accel: 'Shift+O', run: (c) => c.setTool('frame') },
  { id: 'tool.hand', label: 'Hand Tool', kind: 'tool', accel: 'H', run: (c) => c.setTool('hand') },
  { id: 'tool.zoom', label: 'Zoom Tool', kind: 'tool', accel: 'Z', run: (c) => c.setTool('zoom') },
];

// ---- Menu bar structure -----------------------------------------------------
//
// The ordered contents of each top-level menu, as command ids. A menu item's
// LABEL and accelerator come from COMMANDS (single source of truth — no more
// hand-typed "<button>Undo</button>" that can drift). Special non-command rows:
//   '---'            → a divider
//   'recent-files'   → the "Recent Files" section (label + dynamic list),
//                       populated by ui/recent-files.ts.
// ui/menus.ts renders the bar from this table.

export type MenuItem = string; // a command id, '---', or 'recent-files'
export interface MenuDef { title: string; items: MenuItem[] }

export const MENU_BAR: MenuDef[] = [
  // Recent Files sits LAST, as a submenu ('recent-files' renders as a popout in
  // ui/menus.ts): the list is up to 8 rows of filenames, and inline near the top it
  // pushed every real command down and made the longest menu in the app hard to scan.
  { title: 'File', items: [
    'file.new', 'file.open', '---',
    'file.save', 'file.save-as', '---',
    ...DRIVE_FILE_ITEMS,
    'file.close-tab', 'file.next-tab', 'file.prev-tab', '---',
    'file.import', 'file.import-as-frame', 'file.export-artboards', 'file.export-all-frames', 'file.export-track-layouts', '---',
    'export.bake-transforms', '---',
    'recent-files', ...DRIVE_RECENT_ITEMS,
  ] },
  { title: 'Edit', items: [
    'edit.undo', 'edit.redo', '---',
    'edit.cut', 'edit.copy', 'edit.paste', 'edit.paste-in-place', '---',
    'edit.duplicate', 'edit.delete', '---',
    'edit.select-all', 'edit.deselect',
  ] },
  { title: 'Object', items: [
    'object.group', 'object.ungroup', '---',
    'object.flip-horizontal', 'object.flip-vertical', '---',
    'object.clip-make', 'object.clip-release', '---',
    'object.repeat-make', 'object.repeat-bake', 'object.repeat-release', '---',
    'object.create-symbol', 'object.detach-symbol', 'library.add-from-selection', '---',
    'object.bring-to-front', 'object.bring-forward', 'object.send-backward', 'object.send-to-back', '---',
    'object.toggle-lock', 'object.unlock-all', '---',
    'object.toggle-visibility', 'object.show-all',
  ] },
  { title: 'Path', items: [
    'path.unite', 'path.subtract', 'path.intersect', 'path.exclude', 'path.divide', '---',
    'path.join', 'path.reverse', 'path.round-corners', 'path.smooth', '---',
    'path.outline-stroke', 'path.outline-text', 'path.offset', 'path.type-on-path', '---',
    'path.trace-image', '---',
    'path.flatten',
  ] },
  { title: 'View', items: [
    'view.toggle-split', '---',
    'view.zoom-in', 'view.zoom-out', 'view.zoom-fit', 'view.zoom-selection', 'view.zoom-100', '---',
    'view.toggle-transparency', 'view.toggle-grid', 'view.toggle-grid-snap',
    'view.toggle-snap', 'view.toggle-rulers', '---',
    'view.toggle-hints',
  ] },
  { title: 'Help', items: [
    'app.command-palette', '---',
    'app.privacy', 'app.terms', 'app.feedback', '---',
    ...DRIVE_HELP_ITEMS,
    'app.about',
  ] },
];

// ---- Lookup & dispatch ------------------------------------------------------

const byId = new Map<string, Command>(COMMANDS.map(c => [c.id, c]));

export function getCommand(id: string): Command | undefined {
  return byId.get(id);
}

export function isEnabled(cmd: Command, ctx: CommandContext): boolean {
  return cmd.enabled ? cmd.enabled(ctx) : true;
}

export function isChecked(cmd: Command, ctx: CommandContext): boolean {
  return cmd.checked ? cmd.checked(ctx) : false;
}

/** Run a command by id. No-op (with a dev warning) for unknown or disabled commands. */
export function runCommand(id: string, ctx: CommandContext): void {
  const cmd = byId.get(id);
  if (!cmd) {
    if (import.meta.env.DEV) console.warn(`[commands] unknown command: ${id}`);
    return;
  }
  if (!isEnabled(cmd, ctx)) return;
  cmd.run(ctx);
}

// ---- Accelerator parsing & matching ----------------------------------------

// Case-INSENSITIVE: UA-Client-Hints reports "macOS" (lowercase m), which a
// case-sensitive /Mac/ misses — and because it's truthy the || never falls
// through to navigator.platform ("MacIntel"). That left IS_MAC false in Chromium/
// Electron (incl. the VSCode webview), so Mod bound to Ctrl instead of ⌘ on a Mac.
export const IS_MAC = typeof navigator !== 'undefined' &&
  /mac|iphone|ipad/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent || '');

// Punctuation/symbol keys are matched by physical `code`, because Shift mutates
// the produced character (e.g. Shift+] yields '}'), which would break `key` matching.
const PUNCT_CODE: Record<string, string> = {
  '=': 'Equal', '+': 'Equal', '-': 'Minus',
  '[': 'BracketLeft', ']': 'BracketRight',
  "'": 'Quote', '\\': 'Backslash', '/': 'Slash', ',': 'Comma', '.': 'Period',
};

interface ParsedAccel { key: string; mod: boolean; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; }

function parseAccel(accel: string): ParsedAccel {
  const parts = accel.split('+');
  const key = parts.pop() ?? '';
  return {
    key,
    mod: parts.includes('Mod'),
    ctrl: parts.includes('Ctrl'),
    alt: parts.includes('Alt'),
    shift: parts.includes('Shift'),
    meta: parts.includes('Meta'),
  };
}

function matchOne(e: KeyboardEvent, accel: string): boolean {
  const a = parseAccel(accel);
  const wantCtrl = a.ctrl || (a.mod && !IS_MAC);
  const wantMeta = a.meta || (a.mod && IS_MAC);
  if (e.ctrlKey !== wantCtrl) return false;
  if (e.metaKey !== wantMeta) return false;
  if (e.altKey !== a.alt) return false;

  // A bare letter (no modifiers) is a tool-style shortcut and matches whether
  // or not Shift is held — mirroring the original `case 'v': case 'V'` handler,
  // so a held Shift (e.g. left over from shift-click) doesn't kill tool keys.
  // Everything else requires an exact Shift match, which keeps Mod+Z (undo)
  // distinct from Mod+Shift+Z (redo).
  const isLetter = /^[A-Za-z]$/.test(a.key);
  const bareLetter = isLetter && !a.shift && !a.mod && !a.ctrl && !a.alt && !a.meta;
  if (!bareLetter && e.shiftKey !== a.shift) return false;

  // Letters: match the produced character (keyboard-layout aware), ignoring case.
  if (isLetter) return e.key.toLowerCase() === a.key.toLowerCase();
  if (/^[0-9]$/.test(a.key)) return e.code === `Digit${a.key}`;
  const code = PUNCT_CODE[a.key];
  if (code) return e.code === code;
  return e.key === a.key; // named keys: Delete, Backspace, Escape, …
}

function accelList(cmd: Command): string[] {
  if (!cmd.accel) return [];
  return Array.isArray(cmd.accel) ? cmd.accel : [cmd.accel];
}

/** First command whose accelerator matches the event, or undefined. */
export function findCommandForEvent(e: KeyboardEvent): Command | undefined {
  for (const cmd of COMMANDS) {
    for (const a of accelList(cmd)) {
      if (matchOne(e, a)) return cmd;
    }
  }
  return undefined;
}

/** Human-readable accelerator for display in menus (platform-aware). */
export function formatAccelerator(accel: string): string {
  const parts = accel.split('+');
  const key = parts.pop() ?? '';
  const mods = parts.map(m => {
    if (m === 'Mod') return IS_MAC ? '⌘' : 'Ctrl';
    if (m === 'Shift') return IS_MAC ? '⇧' : 'Shift';
    if (m === 'Alt') return IS_MAC ? '⌥' : 'Alt';
    if (m === 'Meta') return IS_MAC ? '⌘' : 'Meta';
    return m;
  });
  let keyLabel = key;
  if (key === 'Delete' || key === 'Backspace') keyLabel = 'Del';
  else if (key === 'ArrowRight') keyLabel = '→';
  else if (key === 'ArrowLeft') keyLabel = '←';
  else if (key === 'ArrowUp') keyLabel = '↑';
  else if (key === 'ArrowDown') keyLabel = '↓';
  else if (/^[a-z]$/.test(key)) keyLabel = key.toUpperCase();
  return [...mods, keyLabel].join(IS_MAC ? '' : '+');
}

/** Display string for a command's primary accelerator (empty if it has none). */
export function primaryAccelerator(cmd: Command): string {
  const list = accelList(cmd);
  return list.length ? formatAccelerator(list[0]) : '';
}

// ---- Dev-time integrity checks ---------------------------------------------
// Catches duplicate ids and clashing accelerators the moment they're introduced,
// so the registry can't silently drift the way the old hand-wired tables did.
if (import.meta.env.DEV) {
  const ids = new Set<string>();
  const seenAccel = new Map<string, string>();
  for (const cmd of COMMANDS) {
    if (ids.has(cmd.id)) console.warn(`[commands] duplicate command id: ${cmd.id}`);
    ids.add(cmd.id);
    for (const a of accelList(cmd)) {
      const prev = seenAccel.get(a);
      if (prev) console.warn(`[commands] accelerator "${a}" bound to both ${prev} and ${cmd.id}`);
      else seenAccel.set(a, cmd.id);
    }
  }
}
