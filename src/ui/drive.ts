// ---------------------------------------------------------------------------
// Google Drive — open and save documents in the user's Drive, with no server.
//
// A Drive document is a DocSource of kind 'drive' (core/doc-source.ts): once a
// file is opened from or saved to Drive, ⌘S (commands.ts routes file.save by the
// source's kind) writes it back there. Save As… (local) re-sources it to disk.
//
// Deliberately NO autosave to Drive: a token can't be renewed without a user
// gesture (an autosave an hour in would either fail silently or pop a sign-in
// window unasked), every write is a Drive revision (a debounced autosave would
// bury the file's version history), and Drive v3 has no atomic precondition for
// a background write to lean on. Unsaved work is already safe in the session
// store; the dirty dot and the unload prompt say when to save.
//
// Every entry point here runs from a click or keypress, because obtaining a
// token may open a popup (lib/google-drive.ts). Keep it that way.
// ---------------------------------------------------------------------------

import type { AppState } from '../core/state';
import type { DocumentManager } from '../core/document-manager';
import { getDocSource } from '../core/doc-source';
import { readSvgFile } from '../core/file-access';
import { isDriveConfigured } from '../lib/google-config';
import {
  ensureToken, isDriveConnected, canDisconnectDrive, revokeToken,
  getFileMeta, downloadFile, createFile, updateFile,
  DriveAuthError, DriveConflictError, type DriveFile,
} from '../lib/google-drive';
import { pickDriveFile } from '../lib/google-picker';
import {
  adoptSource, loadDocumentStringWithFeedback, pendingFromPdfFile,
  beginDocumentSave, type PendingOpen,
} from './project-file';
import { rememberDriveFile, forgetDriveFile, setupDriveRecentMenu } from './drive-recent';
import { confirmDialog, promptDialog } from './dialogs';
import { showToast } from './toast';

export { isDriveConnected, canDisconnectDrive };

// ---- Status chip ------------------------------------------------------------

// Save progress and completion live on the owning document tab. This chip
// retains actionable connection and upload errors.
type ChipState = 'hidden' | 'error' | 'reconnect';
const CHIP_TEXT: Record<Exclude<ChipState, 'hidden'>, string> = {
  error: 'Not saved to Drive',
  reconnect: 'Reconnect Google Drive',
};

let chip: HTMLButtonElement | null = null;

function setChip(state: ChipState): void {
  if (!chip) return;
  chip.className = 'drive-status' + (state === 'hidden' ? '' : ` show ${state}`);
  chip.textContent = state === 'hidden' ? '' : CHIP_TEXT[state];
  chip.disabled = state !== 'reconnect';
}

/** Mount the chip and the recents popout. No-op when Drive isn't configured. */
export function setupDrive(docs: DocumentManager): void {
  if (!isDriveConfigured) return;
  const host = document.getElementById('chrome-actions');
  if (!host) return;
  chip = document.createElement('button');
  chip.type = 'button';
  chip.id = 'drive-status';
  chip.className = 'drive-status';
  chip.title = 'Google Drive';
  chip.setAttribute('aria-live', 'polite');
  chip.setAttribute('aria-atomic', 'true');
  chip.addEventListener('click', () => { void connectDrive(); }); // only clickable in 'reconnect'
  host.appendChild(chip); // AFTER #discord-link — that stays the first thing in the cluster
  setupDriveRecentMenu((file) => openDriveFile(docs, file));
}

// ---- Connect / disconnect ---------------------------------------------------

function askToConnect(): void {
  showToast('Connect Google Drive to continue.', 8000, { label: 'Connect', onClick: () => { void connectDrive(); } });
}

/** Explicit sign-in (Help ▸ Connect Google Drive, the chip, the toast action). */
export async function connectDrive(): Promise<boolean> {
  let token: string | null;
  try { token = await ensureToken(true); }
  catch { showToast('Google sign-in could not load. Check your connection and try again.'); return false; }
  if (!token) {
    showToast('Google Drive wasn’t connected — the sign-in window was closed or blocked.');
    return false;
  }
  setChip('hidden');
  showToast('Connected to Google Drive.', 5000, undefined, 'success');
  return true;
}

export async function disconnectDrive(): Promise<void> {
  const revoked = await revokeToken();
  setChip('hidden');
  if (revoked) {
    showToast('Google Drive access revoked. Documents already open stay open.', 6000, undefined, 'success');
  } else {
    showToast('Disconnected on this device. Google did not confirm revocation; remove BuzzQuill access in your Google Account permissions. Open documents stay open.', 12000);
  }
}

// ---- Open -------------------------------------------------------------------

/** File ▸ Open from Google Drive…: sign in if needed, pick, open in a (new) tab. */
export async function openFromDrive(docs: DocumentManager): Promise<void> {
  const token = await ensureToken();
  if (!token) { askToConnect(); return; }
  const picked = await pickDriveFile(token);
  if (!picked) return;
  if (picked.mimeType.startsWith('application/vnd.google-apps.')) {
    showToast(`“${picked.name}” is a Google Docs-type file, not an SVG or PDF.`);
    return;
  }
  await openDriveFile(docs, picked);
}

/** Open a Drive file by id (the Picker's choice or a recent entry). Focuses the
 *  tab if it is already open; otherwise downloads first, then creates the tab, so
 *  a failed download never leaves an empty tab behind. */
export async function openDriveFile(docs: DocumentManager, file: { id: string; name: string }): Promise<void> {
  const open = docs.tabs.find((t) => t.source?.kind === 'drive' && t.source.fileId === file.id);
  if (open) { docs.switchTo(open.id); return; }
  try {
    if (!(await ensureToken())) { askToConnect(); return; }
    const pending = await pendingFromDrive(file.id);
    if (pending) await docs.openDocument(pending);
  } catch (err) {
    if (err instanceof DriveAuthError) { setChip('reconnect'); askToConnect(); return; }
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(msg)) forgetDriveFile(file.id); // deleted in Drive, or access went away
    showToast(`Couldn’t open “${file.name}” from Google Drive: ${msg}`);
  }
}

async function pendingFromDrive(id: string): Promise<PendingOpen | null> {
  const meta = await getFileMeta(id); // current name + the modifiedTime baseline for conflict checks
  const blob = await downloadFile(id);
  if (meta.mimeType === 'application/pdf' || /\.pdf$/i.test(meta.name)) {
    // A PDF imports as pages, like a local one; the result has no source to save to.
    return pendingFromPdfFile(new File([blob], meta.name, { type: 'application/pdf' }));
  }
  const text = await readSvgFile(blob);
  return {
    name: meta.name,
    load: async (state) => {
      await loadDocumentStringWithFeedback(state, text, meta.name);
      adoptSource({ kind: 'drive', fileId: meta.id, name: meta.name, modifiedTime: meta.modifiedTime }, meta.name);
      rememberDriveFile({ id: meta.id, name: meta.name });
    },
  };
}

// ---- Save -------------------------------------------------------------------

/** ⌘S on a Drive document: write it back, guarding against a change made in
 *  Drive since it was opened. Falls through to Save-to-Drive-As for anything else. */
export async function saveToDrive(state: AppState): Promise<void> {
  if (getDocSource()?.kind !== 'drive') { await saveToDriveAs(state); return; }
  const save = beginDocumentSave(state);
  if (!save || save.source?.kind !== 'drive') return;
  const src = save.source;
  try {
    if (!(await ensureToken())) { setChip('reconnect'); askToConnect(); return; }
    const { svg, warnings } = await save.content();
    if (!save.isOpen()) return;
    setChip('hidden');
    let saved: DriveFile;
    try {
      saved = await updateFile(src.fileId, svg, src.modifiedTime);
    } catch (err) {
      if (!(err instanceof DriveConflictError)) throw err;
      setChip('hidden');
      if (!save.isOpen()) return;
      const overwrite = await confirmDialog({
        title: 'Changed in Google Drive',
        message: `“${src.name}” was changed in Drive after it was opened. Overwrite it with this version? Drive keeps the other one in the file’s version history.`,
        confirmText: 'Overwrite', cancelText: 'Keep editing', danger: true,
      });
      if (!overwrite || !save.isOpen()) return;
      saved = await updateFile(src.fileId, svg);
    }
    landed(save, saved, warnings);
  } catch (err) { failed(err, src.name); }
  finally { save.release(); }
}

/** Create a new Drive file from the document that initiated the command. */
export async function saveToDriveAs(state: AppState): Promise<void> {
  const save = beginDocumentSave(state);
  if (!save) return;
  let name = save.name;
  try {
    if (!(await ensureToken())) { askToConnect(); return; }
    if (!save.isOpen()) return;
    const base = save.name.replace(/\.svg$/i, '');
    const typed = await promptDialog({ title: 'Save to Google Drive', label: 'File name', value: `${base}.svg`, confirmText: 'Save' });
    if (!typed || !save.isOpen()) return;
    name = /\.svg$/i.test(typed) ? typed : `${typed}.svg`;
    const { svg, warnings } = await save.content();
    if (!save.isOpen()) return;
    setChip('hidden');
    const saved = await createFile(name, svg);
    landed(save, saved, warnings);
  } catch (err) { failed(err, name); }
  finally { save.release(); }
}

function landed(save: NonNullable<ReturnType<typeof beginDocumentSave>>, saved: DriveFile, warnings: string[]): void {
  save.complete({ kind: 'drive', fileId: saved.id, name: saved.name, modifiedTime: saved.modifiedTime }, saved.name);
  rememberDriveFile({ id: saved.id, name: saved.name });
  setChip('hidden');
  if (warnings.length) showToast(warnings.join('\n'));
}

function failed(err: unknown, name: string): void {
  if (err instanceof DriveAuthError) { setChip('reconnect'); askToConnect(); return; }
  setChip('error');
  showToast(`Couldn’t save “${name}” to Google Drive: ${err instanceof Error ? err.message : String(err)}`);
}
