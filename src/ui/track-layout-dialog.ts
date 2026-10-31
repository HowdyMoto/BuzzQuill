/**
 * Export Track Layouts — one TraceCraft file per circuit layout (see
 * core/track-layout.ts for the format). Lists the layouts found in the selection
 * (or the whole document when nothing is selected), each with its filename, its pit
 * lane and anything TraceCraft would object to, then writes the ticked ones through
 * the shared export writer (remembered folder, de-duplicated names, success toast).
 */

import type { AppState } from '../core/state';
import type { ShapeData } from '../core/types';
import { collectTrackLayouts, trackLayoutFilename } from '../core/track-layout';
import { writeExportedFiles, type BuiltFile } from './export-dialog';
import { getProjectName } from './project-file';
import { openModal } from './modal';
import { showToast } from './toast';
import { createButton, createCheckRow, createField, createModalHeader, createModalBody, createModalFooter } from './components';

/** The circuit name typed last, so a second export this session reuses it. */
let lastCircuitName: string | null = null;

export function showTrackLayoutDialog(state: AppState): void {
  const selection = state.getSelectedShapes();
  const roots = selection.length ? selection : state.shapes;
  const siblingsOf = (s: ShapeData): ShapeData[] =>
    (s.parentId ? state.findShapeById(s.parentId)?.children : state.shapes) ?? [];
  const { layouts, skipped } = collectTrackLayouts(roots, selection.length > 0, siblingsOf);

  if (!layouts.length) {
    const why = skipped.length ? `\n${skipped.join('\n')}` : '';
    showToast(`No track layout found — select a closed path (the circuit), or a group or frame holding one.${why}`);
    return;
  }

  const modal = openModal({ id: 'track-layout-dialog', ariaLabel: 'Export Track Layouts', dialogClass: 'export-dialog track-layout-dialog' });
  if (!modal) return;
  const { dialog, close } = modal;
  dialog.appendChild(createModalHeader('Export Track Layouts'));
  const body = createModalBody();

  const intro = document.createElement('p');
  intro.className = 'track-layout-intro';
  intro.textContent = 'One TraceCraft file per layout: the closed circuit, plus its open “pit-lane” path, '
    + 'in the frame’s own coordinates.';
  body.appendChild(intro);

  const project = getProjectName();
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'track-layout-name';
  nameInput.placeholder = 'e.g. Miami';
  nameInput.value = lastCircuitName ?? (project === 'Untitled' ? '' : project);
  body.appendChild(createField('Circuit', nameInput));

  const list = document.createElement('div');
  list.className = 'field';
  const listLabel = document.createElement('label');
  listLabel.className = 'field-label';
  listLabel.textContent = layouts.length === 1 ? 'Layout' : `Layouts (${layouts.length})`;
  list.appendChild(listLabel);

  const rows = layouts.map((layout) => {
    const { row, input } = createCheckRow('', true);
    row.classList.add('track-layout-row');
    const text = row.querySelector('span')!;
    text.className = 'track-layout-text';
    const file = document.createElement('span');
    file.className = 'track-layout-file';
    const meta = document.createElement('span');
    meta.className = 'track-layout-meta';
    const where = layout.frameName ? ` · in ${layout.frameName}` : '';
    meta.textContent = `${layout.name} · ${layout.pitLane ? `pit lane: ${layout.pitLane.name}` : 'no pit lane'}${where}`;
    text.append(file, meta);
    for (const n of layout.notes) {
      const note = document.createElement('span');
      note.className = 'track-layout-note';
      note.textContent = n;
      text.appendChild(note);
    }
    list.appendChild(row);
    return { layout, input, file };
  });
  body.appendChild(list);

  if (skipped.length) {
    const skip = document.createElement('div');
    skip.className = 'track-layout-skipped';
    skip.textContent = `Not exported: ${skipped.join('; ')}`;
    body.appendChild(skip);
  }
  dialog.appendChild(body);

  const footer = createModalFooter();
  const exportBtn = createButton('Export', { variant: 'primary' });
  footer.append(createButton('Cancel', { onClick: () => close() }), exportBtn);
  dialog.appendChild(footer);

  const refresh = () => {
    for (const r of rows) r.file.textContent = trackLayoutFilename(nameInput.value, r.layout.name);
    const n = rows.filter(r => r.input.checked).length;
    exportBtn.textContent = n === 1 ? 'Export 1 file' : `Export ${n} files`;
    exportBtn.disabled = n === 0;
  };
  nameInput.addEventListener('input', refresh);
  for (const r of rows) r.input.addEventListener('change', refresh);
  refresh();

  exportBtn.addEventListener('click', async () => {
    lastCircuitName = nameInput.value;
    const files: BuiltFile[] = rows.filter(r => r.input.checked).map(r => ({
      blob: new Blob([r.layout.svg], { type: 'image/svg+xml' }),
      filename: r.file.textContent ?? 'layout.layout.svg',
      format: 'svg',
      warnings: [],
    }));
    close();
    await writeExportedFiles(files);
  });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !exportBtn.disabled) exportBtn.click(); });
  nameInput.focus();
  nameInput.select();
}
