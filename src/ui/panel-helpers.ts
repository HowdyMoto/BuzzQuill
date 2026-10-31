/** Shared helpers for the side-panel lists: right-click menu + inline rename. */

export interface ContextMenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
  /** Greyed out and non-clickable (mirrors a disabled command). */
  disabled?: boolean;
  /** Right-aligned shortcut hint, e.g. '⌘E'. */
  accel?: string;
  /** A divider row; label/action are ignored. */
  separator?: boolean;
}

let activeMenu: HTMLElement | null = null;

function onDocMouseDown(e: MouseEvent): void {
  if (activeMenu && !activeMenu.contains(e.target as Node)) closeContextMenu();
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeContextMenu();
}

export function closeContextMenu(): void {
  if (!activeMenu) return;
  activeMenu.remove();
  activeMenu = null;
  document.removeEventListener('mousedown', onDocMouseDown, true);
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('blur', closeContextMenu);
}

export function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  let lastWasSep = true; // suppress leading/duplicate separators
  for (const item of items) {
    if (item.separator) {
      if (lastWasSep) continue;
      const sep = document.createElement('div');
      sep.style.cssText = 'height:1px;margin:4px 0;background:var(--ai-border, rgba(255,255,255,0.1));';
      menu.appendChild(sep);
      lastWasSep = true;
      continue;
    }
    lastWasSep = false;
    const btn = document.createElement('button');
    btn.className = 'context-menu-item';
    if (item.danger) btn.classList.add('danger');
    // Label + optional right-aligned shortcut hint.
    btn.style.cssText = 'display:flex;align-items:center;gap:18px;width:100%;';
    const label = document.createElement('span');
    label.textContent = item.label;
    btn.appendChild(label);
    if (item.accel) {
      const sc = document.createElement('span');
      sc.textContent = item.accel;
      sc.style.cssText = 'margin-left:auto;opacity:0.55;font-size:0.9em;';
      btn.appendChild(sc);
    }
    if (item.disabled) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.style.cursor = 'default';
    } else {
      btn.addEventListener('click', () => {
        closeContextMenu();
        item.action();
      });
    }
    menu.appendChild(btn);
  }

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);
  activeMenu = menu;

  // Nudge back into the viewport if it would overflow — and grow the open
  // animation from the corner nearest the cursor, so the menu always pops out
  // of the click point (flipping the origin along any nudged axis). Measured
  // via offsetWidth/Height (the LAYOUT box): getBoundingClientRect would read
  // the open animation's scaled-down first frame and under-nudge.
  const w = menu.offsetWidth, h = menu.offsetHeight;
  const flipX = x + w > window.innerWidth;
  const flipY = y + h > window.innerHeight;
  if (flipX) menu.style.left = `${window.innerWidth - w - 4}px`;
  if (flipY) menu.style.top = `${window.innerHeight - h - 4}px`;
  menu.style.transformOrigin = `${flipX ? 'right' : 'left'} ${flipY ? 'bottom' : 'top'}`;

  // Defer listeners so the opening click/contextmenu doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', closeContextMenu);
  }, 0);
}

/**
 * Replace a name label with a text input for inline renaming. `commit` is
 * called with the final name (the original name if the edit is cancelled).
 *
 * **Committing waits for the click that ended the edit.** Clicking any other
 * control blurs the field, and every caller's `commit` re-renders the panels. If
 * that rebuild runs between the click's mousedown and mouseup — which is exactly
 * when the blur fires — the element under the pointer is replaced, so the browser
 * dispatches no click at all and the user's click is silently swallowed (clicking
 * a fill swatch while a layer was being renamed simply did nothing). The label is
 * restored immediately so the row never looks stuck, and the commit runs once the
 * press has ended — at the latest in the click's CAPTURE phase, before any handler
 * acts on it.
 */
export function beginInlineRename(
  nameEl: HTMLElement,
  current: string,
  commit: (name: string) => void,
): void {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'layer-rename';
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  // Is a pointer button down right now? Then this blur belongs to a click that
  // hasn't finished being delivered.
  let pressing = false;
  const onDown = (): void => { pressing = true; };
  const onUp = (): void => { pressing = false; };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', onUp, true);

  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointerup', onUp, true);

    const name = save ? (input.value.trim() || current) : current;
    nameEl.textContent = name;
    input.replaceWith(nameEl); // label back now; the caller's re-render redraws it

    if (!pressing) { commit(name); return; }
    // Commit in the click's CAPTURE phase: its path is fixed by then, so the
    // re-render can't cancel it, but no handler has run yet. Waiting for the bubble
    // phase let a tab button switch documents first, and the name landed on a
    // same-id shape in the OTHER document. A press that ends without a click (a
    // drag) commits right after its pointerup, once the tool has recorded the move —
    // never from a timer, which fired mid-drag and snapshotted a half-moved shape.
    let committed = false;
    const run = (): void => {
      if (committed) return;
      committed = true;
      window.removeEventListener('click', run, true);
      window.removeEventListener('pointerup', soon, true);
      window.removeEventListener('pointercancel', soon, true);
      window.removeEventListener('blur', run);
      commit(name);
    };
    const soon = (): void => { window.setTimeout(run, 0); };
    window.addEventListener('click', run, true);
    window.addEventListener('pointerup', soon, true);
    window.addEventListener('pointercancel', soon, true);
    window.addEventListener('blur', run); // the app lost focus mid-press
  };

  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // don't trigger global shortcuts while typing
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); input.blur(); }
  });
}
