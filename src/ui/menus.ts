import type { CommandContext } from '../commands';
import { MENU_BAR, getCommand, runCommand, isEnabled, isChecked, primaryAccelerator } from '../commands';

/**
 * The top menu bar, rendered from the command registry (MENU_BAR structure +
 * COMMANDS labels/accelerators) — so a menu item's text and shortcut can never
 * drift from the command it runs. index.html supplies only the empty
 * `.menu-items` container; every dropdown, button, divider, and the Recent Files
 * section is built here.
 *
 * Keyboard + screen readers (#198): the bar is a real ARIA menubar — the
 * triggers are `<button role="menuitem" aria-haspopup="menu">` sharing ONE tab
 * stop (roving tabindex), the dropdowns are `role="menu"` and the rows
 * `role="menuitem"` / `menuitemcheckbox`. Arrows walk the bar and the open
 * panel, Enter/Space activate, Home/End jump to the ends, Escape closes and
 * hands focus back to the trigger. The mouse behaviour is unchanged: mousedown
 * toggles a menu, hovering slides to the neighbouring one, a click anywhere
 * else dismisses.
 */
export function setupMenus(ctx: CommandContext): void {
  const nav = document.querySelector('.menu-items');
  if (nav) buildMenuBar(nav as HTMLElement);

  const dropdowns = document.querySelectorAll('.menu-dropdown');

  dropdowns.forEach(dd => {
    const trigger = dd.querySelector('.menu-trigger') as HTMLButtonElement;
    trigger.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const isOpen = dd.classList.contains('open');
      closeAllMenus();
      if (!isOpen) openMenu(dd as HTMLElement, ctx, 'none');
      // The mouse path deliberately does NOT take focus (preventDefault above
      // keeps it wherever the user was, exactly as before — a script focus here
      // would paint a focus ring on a plain click). Just move the bar's tab stop
      // so a following Tab lands on the menu the user is actually using.
      rovingTabIndex(trigger);
    });
    trigger.addEventListener('mouseenter', () => {
      const anyOpen = document.querySelector('.menu-dropdown.open');
      if (anyOpen && anyOpen !== dd) {
        closeAllMenus();
        openMenu(dd as HTMLElement, ctx, 'none');
        // Keep the keyboard on the menu the mouse just slid to — but only if the
        // keyboard was in the bar already; hovering must never steal focus.
        if (isInMenuBar(document.activeElement)) focusTrigger(trigger);
      }
    });
    // aria-expanded is a cache over the `.open` class, and not every path that
    // opens/closes a menu goes through this module (ui/recent-files.ts closes
    // the dropdown itself after opening a file). Observe the class so the
    // announced state can't drift from what's on screen.
    new MutationObserver(syncExpanded).observe(dd, { attributes: true, attributeFilter: ['class'] });
  });

  document.addEventListener('mousedown', (e) => {
    if (!(e.target as Element).closest('.menu-dropdown')) {
      closeAllMenus();
      // Don't leave the bar holding the keyboard after a click elsewhere, or the
      // arrow keys would keep steering menus instead of nudging the selection.
      const active = document.activeElement as HTMLElement | null;
      if (isInMenuBar(active)) active!.blur();
    }
  });

  // Escape closes an open menu (#216). Capture phase so it wins over the global
  // command dispatch and tool handlers; consumes the key ONLY when a menu is
  // actually open, so Escape's other meanings are untouched.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('.menu-dropdown.open');
    if (!open) return;
    e.preventDefault();
    e.stopPropagation();
    const trigger = open.querySelector('.menu-trigger') as HTMLButtonElement | null;
    closeAllMenus();
    // Focus goes back where the menu was opened from — never into the void, and
    // never left on a row that just got hidden.
    if (trigger) focusTrigger(trigger);
  }, true);

  // Arrows / Home / End / Enter / Space, also in the capture phase: while the
  // keyboard is in the menu bar these keys belong to the menu, not to the global
  // shortcut table (Space would otherwise spring-load the Hand tool, and the
  // arrows would nudge the selection).
  document.addEventListener('keydown', (e) => onMenuKeydown(e, ctx), true);

  // Wire every menu button to its command. The label + accelerator were stamped
  // from the registry when the button was built (buildMenuBar); this just binds
  // the click.
  document.querySelectorAll<HTMLButtonElement>('.menu-panel button[data-action]').forEach(btn => {
    const id = btn.getAttribute('data-action')!;
    btn.addEventListener('click', () => {
      closeAllMenus();
      runCommand(id, ctx);
    });
  });
}

/** Build the dropdowns from MENU_BAR, stamping each item's label + accelerator
 *  from COMMANDS. */
function buildMenuBar(nav: HTMLElement): void {
  nav.replaceChildren();
  nav.setAttribute('role', 'menubar');
  nav.setAttribute('aria-label', 'Main menu');
  for (const menu of MENU_BAR) {
    const dropdown = el('div', 'menu-dropdown');
    // The wrapper only positions the panel — `none` keeps it out of the ARIA
    // tree so the trigger reads as a direct child of the menubar.
    dropdown.setAttribute('role', 'none');
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'menu-trigger';
    trigger.setAttribute('role', 'menuitem');
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    // Roving tabindex: the whole bar is ONE tab stop (arrows move within it), so
    // Tab doesn't have to walk six menus to reach the canvas.
    trigger.tabIndex = nav.childElementCount === 0 ? 0 : -1;
    trigger.textContent = menu.title;
    const panel = el('div', 'menu-panel');
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', menu.title);

    for (const item of menu.items) {
      if (item === '---') {
        const divider = el('div', 'menu-divider');
        divider.setAttribute('role', 'separator');
        panel.appendChild(divider);
      } else if (item === 'recent-files') {
        panel.appendChild(buildSubmenu('Open Recent', 'recent-files-trigger', 'recent-files-list', 'Recent Files'));
      } else if (item === 'drive-recent') {
        panel.appendChild(buildSubmenu('Open Recent from Drive', 'drive-recent-trigger', 'drive-recent-list', 'Recent Google Drive Files'));
      } else {
        const cmd = getCommand(item);
        if (!cmd) {
          if (import.meta.env.DEV) console.warn(`[menus] no command registered for "${item}"`);
          continue;
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-action', item);
        // A toggle owns a checked state (the ✓ pseudo-element is invisible to a
        // screen reader), so it gets the role that can carry aria-checked.
        btn.setAttribute('role', cmd.kind === 'toggle' ? 'menuitemcheckbox' : 'menuitem');
        btn.tabIndex = -1; // reachable with the arrow keys, not with Tab
        btn.appendChild(document.createTextNode(cmd.label)); // label as a text node (matches the old markup)
        const accel = primaryAccelerator(cmd);
        if (accel) {
          const span = el('span', 'shortcut');
          span.textContent = accel;
          btn.appendChild(span);
        }
        panel.appendChild(btn);
      }
    }
    dropdown.append(trigger, panel);
    nav.appendChild(dropdown);
  }
}

/**
 * Recent Files as a SUBMENU (popout) rather than an inline list. Up to 8 filename
 * rows inline made the File menu — already the longest in the app — hard to scan,
 * and pushed the commands people actually reach for down the panel.
 *
 * The popout keeps a stable list id (`recent-files-list`, `drive-recent-list`),
 * so ui/recent-files.ts and ui/drive-recent.ts fill it and need to know nothing
 * about the menu's shape. Opening is driven by a class rather than CSS `:hover`
 * alone, so the pointer and the keyboard share one state that `aria-expanded`
 * can mirror honestly.
 */
function buildSubmenu(label: string, triggerId: string, listId: string, ariaLabel: string): HTMLElement {
  const wrap = el('div', 'menu-sub');
  wrap.setAttribute('role', 'none'); // a positioning wrapper, not a menu node

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = triggerId;
  trigger.className = 'menu-sub-trigger';
  trigger.setAttribute('role', 'menuitem');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.tabIndex = -1;
  trigger.appendChild(document.createTextNode(label));
  const arrow = el('span', 'menu-sub-arrow');
  arrow.textContent = '▸'; // ▸
  arrow.setAttribute('aria-hidden', 'true');
  trigger.appendChild(arrow);

  const list = el('div', 'menu-recent');
  list.id = listId;
  list.setAttribute('role', 'menu');
  list.setAttribute('aria-label', ariaLabel);

  // Pointer: open on the row, close when the pointer leaves the wrapper — which
  // spans the row AND the popout, so travelling into the list doesn't dismiss it.
  trigger.addEventListener('mouseenter', () => openSubmenu(wrap));
  wrap.addEventListener('mouseleave', () => closeSubmenu(wrap));
  // Clicking the row is a toggle, and must not run a command or close the menu.
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (wrap.classList.contains('open')) closeSubmenu(wrap); else openSubmenu(wrap);
  });
  // Keyboard: arriving on the row opens the popout, so ArrowDown can walk into it
  // (a hidden row can't take focus). Leaving the wrapper entirely closes it.
  trigger.addEventListener('focus', () => openSubmenu(wrap));
  wrap.addEventListener('focusout', (e) => {
    const to = e.relatedTarget as Node | null;
    if (!to || !wrap.contains(to)) closeSubmenu(wrap);
  });

  wrap.append(trigger, list);
  return wrap;
}

function openSubmenu(wrap: HTMLElement): void {
  wrap.classList.add('open');
  wrap.querySelector('.menu-sub-trigger')?.setAttribute('aria-expanded', 'true');
}

function closeSubmenu(wrap: HTMLElement): void {
  wrap.classList.remove('open');
  wrap.querySelector('.menu-sub-trigger')?.setAttribute('aria-expanded', 'false');
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

/** Reflect each item's current enabled state and (for toggles) checked state. */
function refreshMenuItems(ctx: CommandContext): void {
  document.querySelectorAll<HTMLButtonElement>('.menu-panel button[data-action]').forEach(btn => {
    const cmd = getCommand(btn.getAttribute('data-action')!);
    if (!cmd) return;
    const enabled = isEnabled(cmd, ctx);
    btn.classList.toggle('disabled', !enabled);
    // The class greys the row out; aria-disabled is what a screen reader
    // announces — without it an unavailable command sounds actionable.
    if (enabled) btn.removeAttribute('aria-disabled');
    else btn.setAttribute('aria-disabled', 'true');
    if (cmd.kind === 'toggle') {
      const checked = isChecked(cmd, ctx);
      btn.classList.toggle('checked', checked);
      btn.setAttribute('aria-checked', checked ? 'true' : 'false');
    }
  });
}

function closeAllMenus(): void {
  document.querySelectorAll('.menu-dropdown').forEach(d => d.classList.remove('open'));
  // Collapse submenus too, or the popout would be showing the next time its
  // parent menu opens — with `aria-expanded` insisting it was already open.
  document.querySelectorAll<HTMLElement>('.menu-sub.open').forEach(closeSubmenu);
  syncExpanded();
}

/** Open one dropdown (refreshing its rows first, as the mouse path always has),
 *  optionally landing the keyboard on its first/last row. */
function openMenu(dd: HTMLElement, ctx: CommandContext, focus: 'none' | 'first' | 'last'): void {
  refreshMenuItems(ctx);
  dd.classList.add('open');
  syncExpanded();
  const panel = dd.querySelector('.menu-panel') as HTMLElement | null;
  if (!panel) return;
  // Rows added from outside this module (the Recent Files list) are plain
  // buttons — give them menu semantics as they appear, so the panel's ARIA
  // children are always complete without ui/recent-files.ts knowing about it.
  panel.querySelectorAll<HTMLButtonElement>('button:not([role])').forEach(b => {
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
  });
  if (focus === 'none') return;
  const items = menuItemsIn(panel);
  (focus === 'first' ? items[0] : items[items.length - 1])?.focus();
}

/** Mirror the `.open` class onto aria-expanded for every trigger. */
function syncExpanded(): void {
  document.querySelectorAll<HTMLElement>('.menu-dropdown').forEach(dd => {
    dd.querySelector('.menu-trigger')
      ?.setAttribute('aria-expanded', dd.classList.contains('open') ? 'true' : 'false');
  });
}

/** The top-level triggers, in bar order. */
function menuTriggers(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.menu-items .menu-trigger'));
}

/** Rows the keyboard can land on in an open panel: visible and enabled. Disabled
 *  ones are skipped (they're inert for the mouse too — `pointer-events: none`). */
function menuItemsIn(panel: HTMLElement): HTMLButtonElement[] {
  return Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).filter(
    b => !b.disabled && !b.classList.contains('disabled') && b.offsetParent !== null,
  );
}

function isInMenuBar(node: Element | null): boolean {
  return !!node?.closest?.('.menu-items');
}

/** Park the bar's single tab stop on `trigger` (no focus change). */
function rovingTabIndex(trigger: HTMLButtonElement): void {
  for (const t of menuTriggers()) t.tabIndex = t === trigger ? 0 : -1;
}

/** Move the tab stop to `trigger` AND put the keyboard on it. */
function focusTrigger(trigger: HTMLButtonElement): void {
  rovingTabIndex(trigger);
  trigger.focus();
}

/** Switch to another top-level menu, carrying the open state with it (that's how
 *  a menu bar behaves once something is open). */
function gotoTrigger(trigger: HTMLButtonElement, ctx: CommandContext): void {
  const wasOpen = !!document.querySelector('.menu-dropdown.open');
  closeAllMenus();
  focusTrigger(trigger);
  if (wasOpen) openMenu(trigger.closest('.menu-dropdown') as HTMLElement, ctx, 'none');
}

function onMenuKeydown(e: KeyboardEvent, ctx: CommandContext): void {
  if (e.altKey || e.ctrlKey || e.metaKey) return; // accelerators stay with the registry
  const target = e.target as HTMLElement | null;
  const trigger = target?.closest?.('.menu-trigger') as HTMLButtonElement | null;
  const panel = target?.closest?.('.menu-panel') as HTMLElement | null;
  if (!trigger && !panel) return; // the keyboard isn't in the menu bar
  const dd = (trigger ?? panel!).closest('.menu-dropdown') as HTMLElement;
  const bar = menuTriggers();
  const here = bar.indexOf(dd.querySelector('.menu-trigger') as HTMLButtonElement);
  // Ours to handle: swallow it before the global shortcut table sees it.
  const take = (): void => { e.preventDefault(); e.stopPropagation(); };

  // A submenu owns the horizontal arrows before the bar does: inside a popout they
  // mean "into / out of it", which is what every desktop menu does — walking to the
  // next top-level menu from in there would be a non-sequitur.
  const subTrigger = target?.closest?.('.menu-sub-trigger') as HTMLElement | null;
  const inSubmenu = !!target?.closest?.('.menu-recent');
  if (e.key === 'ArrowRight' && subTrigger) {
    take();
    const wrap = subTrigger.closest('.menu-sub') as HTMLElement;
    openSubmenu(wrap);
    menuItemsIn(wrap.querySelector('.menu-recent') as HTMLElement)[0]?.focus();
    return;
  }
  if (e.key === 'ArrowLeft' && inSubmenu) {
    take();
    const wrap = target!.closest('.menu-sub') as HTMLElement;
    (wrap.querySelector('.menu-sub-trigger') as HTMLButtonElement | null)?.focus();
    return;
  }

  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowLeft': {
      take();
      const step = e.key === 'ArrowRight' ? 1 : bar.length - 1;
      gotoTrigger(bar[(here + step) % bar.length], ctx);
      break;
    }
    case 'ArrowDown':
    case 'ArrowUp': {
      take();
      const end = e.key === 'ArrowDown' ? 'first' : 'last';
      if (trigger) {
        if (dd.classList.contains('open')) {
          const items = menuItemsIn(dd.querySelector('.menu-panel') as HTMLElement);
          (end === 'first' ? items[0] : items[items.length - 1])?.focus();
        } else {
          closeAllMenus();
          openMenu(dd, ctx, end);
        }
        break;
      }
      const items = menuItemsIn(panel!);
      if (items.length === 0) break;
      const row = target!.closest('button') as HTMLButtonElement | null;
      const at = row ? items.indexOf(row) : -1;
      if (at < 0) { // focus was on the panel itself — start at the near end
        (end === 'first' ? items[0] : items[items.length - 1]).focus();
        break;
      }
      const step = e.key === 'ArrowDown' ? 1 : items.length - 1;
      items[(at + step) % items.length].focus();
      break;
    }
    case 'Home':
    case 'End': {
      take();
      if (panel) {
        const items = menuItemsIn(panel);
        (e.key === 'Home' ? items[0] : items[items.length - 1])?.focus();
      } else {
        gotoTrigger(e.key === 'Home' ? bar[0] : bar[bar.length - 1], ctx);
      }
      break;
    }
    case 'Enter':
    case ' ': {
      take(); // preventDefault also stops the button's own click, so it fires once
      if (trigger) {
        const isOpen = dd.classList.contains('open');
        closeAllMenus();
        if (!isOpen) openMenu(dd, ctx, 'first');
      } else {
        (target!.closest('button') as HTMLButtonElement | null)?.click();
      }
      break;
    }
    case 'Tab':
      // Tab leaves the bar entirely — dismiss, then let focus move natively.
      closeAllMenus();
      break;
  }
}
