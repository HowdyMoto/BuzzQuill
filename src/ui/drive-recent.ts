// ---------------------------------------------------------------------------
// Recent Google Drive files — the "Open Recent from Drive" popout in the File menu.
//
// Separate from ui/recent-files.ts on purpose: that list is keyed on
// FileSystemFileHandles in IndexedDB and opens with a read-permission prompt; a
// Drive entry is two strings and opens with a token. Mixing them would mean a
// schema bump in that store and a type switch on every click. This one fits in
// localStorage. Rendered into the `#drive-recent-list` popout that ui/menus.ts
// builds for the 'drive-recent' token, so it needs to know nothing about menus.
// ---------------------------------------------------------------------------

const KEY = 'bq-drive-recent';
const MAX_RECENT = 8;

export interface DriveRecentEntry { id: string; name: string; ts: number }

export function listDriveRecent(): DriveRecentEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v)
      ? v.filter((e): e is DriveRecentEntry => !!e && typeof e.id === 'string' && typeof e.name === 'string')
      : [];
  } catch { return []; }
}

function write(entries: DriveRecentEntry[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_RECENT))); } catch { /* storage blocked — the menu just won't remember */ }
}

/** Move (or add) a file to the top of the list. */
export function rememberDriveFile(file: { id: string; name: string }): void {
  const rest = listDriveRecent().filter((e) => e.id !== file.id);
  write([{ id: file.id, name: file.name, ts: Date.now() }, ...rest]);
  refreshDriveRecentMenu();
}

/** Drop a file that no longer opens (deleted in Drive, access revoked). */
export function forgetDriveFile(id: string): void {
  write(listDriveRecent().filter((e) => e.id !== id));
  refreshDriveRecentMenu();
}

let opener: ((file: { id: string; name: string }) => Promise<void>) | null = null;

/** Wire the popout. `open` is the Drive open path (ui/drive.ts), which handles
 *  the token and a file that is already open in a tab. */
export function setupDriveRecentMenu(open: (file: { id: string; name: string }) => Promise<void>): void {
  opener = open;
  refreshDriveRecentMenu();
}

export function refreshDriveRecentMenu(): void {
  const list = document.getElementById('drive-recent-list');
  if (!list || !opener) return;
  const entries = listDriveRecent();

  list.replaceChildren();
  // Grey the row out when there is nothing behind it (`.disabled` is what the
  // menu's keyboard nav skips on), exactly like Open Recent.
  const trigger = document.getElementById('drive-recent-trigger');
  trigger?.classList.toggle('disabled', entries.length === 0);
  if (entries.length === 0) {
    trigger?.setAttribute('aria-disabled', 'true');
    const empty = document.createElement('button');
    empty.type = 'button';
    empty.disabled = true;
    empty.textContent = 'No recent Drive files';
    list.appendChild(empty);
    return;
  }
  trigger?.removeAttribute('aria-disabled');

  for (const entry of entries) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.tabIndex = -1;
    btn.textContent = entry.name;
    btn.title = entry.name;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.menu-dropdown.open').forEach((d) => d.classList.remove('open'));
      void opener?.({ id: entry.id, name: entry.name });
    });
    list.appendChild(btn);
  }
}
